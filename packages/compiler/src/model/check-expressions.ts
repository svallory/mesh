import { dirname, resolve } from "node:path";
import type {
  Action,
  Attribute,
  Computed,
  Diagnostic,
  Entity,
  ExprNode,
  Expression,
  ModelDocument,
  SourceEdit,
  SourcePosition,
  Step,
  TypeClass,
} from "@meshfw/model";

/**
 * Types every translated expression across the whole model (M4, ADR-0012 option A).
 * Language-neutral: it reads the model only. It reports what no reading of the code can
 * excuse (an unknown atom, `.x` through a value that may be null, null written to a required
 * attribute), warns where translated code flips on null, and demotes to plain code what the
 * registry cannot define (D4, D3): the expression keeps JavaScript's meaning and warns.
 */
export interface CheckOptions {
  /** The edits that turn an authored function into TypeScript, kept by the front end for demotion. */
  editsOf: (expression: Expression) => SourceEdit[];
}

interface Ty {
  c: TypeClass | "input";
  /** For boolean: can be unknown. */
  nullable: boolean;
  /** Nullable only because an upstream `?.` short-circuits the whole chain. */
  viaOptional?: boolean;
  entity?: Entity;
  values?: readonly string[];
  /** A literal, so `a === b` does not warn about null equality. */
  literal?: boolean;
  atom?: string;
}

class Demote extends Error {
  constructor(readonly detail: string, readonly position: SourcePosition) { super(detail); }
}

const CLASS: Record<string, TypeClass> = {
  uuid: "string", string: "string", integer: "number", float: "number", decimal: "number",
  boolean: "boolean", enum: "enum", date: "date", datetime: "date", timestamp: "date", json: "json",
};
const BOOLEAN_OPERATORS = new Set(["eq", "ne", "lt", "lte", "gt", "gte", "and", "or", "not", "coalesce"]);

interface Scope {
  entity: Entity;
  /** Nullability of `before`: false for update and destroy. */
  beforeNullable: boolean;
  inputs: Map<string, Ty> | null;
  locals: Map<string, Ty>;
}

export function checkExpressions(document: ModelDocument, diagnostics: Diagnostic[], options: CheckOptions): void {
  const byFile = new Map(document.entities.map((entity) => [resolve(entity.file), entity]));
  const target = (from: Entity, relation: Entity["relationships"][number]): Entity | undefined =>
    byFile.get(resolve(dirname(from.file), relation.entity.from));
  const report = (severity: "error" | "warning", code: string, message: string, position: SourcePosition, fix: string | null = null) =>
    diagnostics.push({ severity, code, message, position, fix });

  const attributeTy = (a: Attribute): Ty => ({
    c: CLASS[a.type] ?? "any", nullable: a.nullable,
    ...(a.values ? { values: a.values.map((v) => v.value) } : {}),
  });

  function memberTy(scope: Scope, owner: Ty, name: string): Ty {
    if (owner.c === "input") return owner.entity ? { c: "any", nullable: false } : (scopeInput(scope, name));
    if (owner.c === "any") return { c: "any", nullable: false };
    if (owner.c !== "record" || !owner.entity) throw new Demote(`member access on a ${owner.c}`, undefined as never);
    const e = owner.entity;
    const attribute = e.attributes.find((a) => a.name === name);
    if (attribute) return attributeTy(attribute);
    const relation = e.relationships.find((r) => r.name === name);
    if (relation) {
      const t = target(e, relation);
      if (!t) return { c: "any", nullable: false };
      if (relation.kind === "has-many") return { c: "list", nullable: false, entity: t };
      return { c: "record", nullable: relation.kind === "has-one" || relation.nullable, entity: t };
    }
    const computed = e.computed.find((x) => x.name === name);
    if (computed) {
      const nullable = computed.rollup ? computed.nullable : (computed.nullable ?? false);
      return { c: CLASS[computed.type] ?? "any", nullable };
    }
    return { c: "any", nullable: false };
  }
  const scopeInput = (scope: Scope, name: string): Ty => scope.inputs?.get(name) ?? { c: "any", nullable: false };

  function infer(n: ExprNode, scope: Scope): Ty {
    const fail = (detail: string): never => { throw new Demote(detail, n.position); };
    switch (n.kind) {
      case "literal":
        if (n.value === null) return { c: "any", nullable: true, literal: true };
        return { c: typeof n.value === "number" ? "number" : typeof n.value === "boolean" ? "boolean" : "string", nullable: false, literal: true };
      case "atom": return { c: "enum", nullable: false, literal: true, atom: n.value };
      case "var": {
        if (n.name === "self") return { c: "record", nullable: false, entity: scope.entity };
        if (n.name === "before") return { c: "record", nullable: scope.beforeNullable, entity: scope.entity };
        if (n.name === "input") return { c: "input", nullable: false };
        if (n.name === "actor" || n.name === "context") return { c: "any", nullable: false };
        return scope.locals.get(n.name) ?? { c: "any", nullable: false };
      }
      case "member": {
        const owner = infer(n.object, scope);
        if (owner.nullable && !owner.viaOptional && !n.optional && owner.c !== "any") {
          report("error", "MESH_EXPR_NULLABLE_ACCESS",
            `\`.${n.name}\` is read through a value that may be null`, n.position,
            `write \`?.${n.name}\`, which gives null when the value is null`);
        }
        let result: Ty;
        try { result = memberTy(scope, owner, n.name); }
        catch (e) { if (e instanceof Demote) return fail(e.detail); throw e; }
        if (owner.c === "json") return fail("a member of a json value");
        const chain = n.optional || owner.viaOptional;
        return chain && (owner.nullable || n.optional) ? { ...result, nullable: true, viaOptional: true } : result;
      }
      case "helper":
        n.args.forEach((a) => infer(a, scope));
        return { c: "any", nullable: false };
      case "quantify": {
        const source = infer(n.source, scope);
        if (source.c !== "list" && source.c !== "any") return fail(`\`${n.op}\` on something that is not a list`);
        const local: Ty = source.entity ? { c: "record", nullable: false, entity: source.entity } : { c: "any", nullable: false };
        const body = infer(n.body, { ...scope, locals: new Map([...scope.locals, [n.param, local]]) });
        if (body.c !== "boolean" && body.c !== "any") return fail("a predicate that is not a boolean");
        if (n.op === "some" || n.op === "every") return { c: "boolean", nullable: source.nullable };
        if (n.op === "find") return { c: "record", nullable: true, entity: source.entity, viaOptional: false };
        return { c: "list", nullable: source.nullable, ...(source.entity ? { entity: source.entity } : {}) };
      }
      case "call": {
        const a = n.args.map((arg) => infer(arg, scope));
        const any = (t: Ty) => t.c === "any";
        const same = (x: Ty, y: Ty) => any(x) || any(y) || x.c === y.c;
        const bothClass = (x: Ty, ...classes: TypeClass[]) => any(x) || classes.includes(x.c as TypeClass);
        const nullable = a.some((t) => t.nullable);
        switch (n.fn) {
          case "isNull": case "isNotNull": return { c: "boolean", nullable: false };
          case "eq": case "ne": {
            const [x, y] = a as [Ty, Ty];
            if (!same(x, y)) return fail("a comparison of values of different types");
            if (["json", "record", "list", "input"].includes(x.c) || ["json", "record", "list", "input"].includes(y.c)) return fail(`a comparison of ${x.c} values`);
            for (const [lit, other] of [[x, y], [y, x]] as const)
              if (lit.atom !== undefined && other.c === "enum") {
                if (other.values && !other.values.includes(lit.atom))
                  report("error", "MESH_EXPR_UNKNOWN_ATOM", `:${lit.atom} is not one of the values of this enum (${other.values.map((v) => `:${v}`).join(", ")})`, n.position);
              } else if (lit.atom !== undefined && other.c !== "any" && other.c !== "enum") return fail("an atom compared with something that is not an enum");
            if (x.nullable && y.nullable && !x.literal && !y.literal)
              report("warning", "MESH_EXPR_NULL_EQUALITY",
                "both sides can be null, and a comparison with null is unknown, not true (JavaScript says `null === null`)", n.position,
                "write `(a === b) || (a === null && b === null)` if two nulls should match");
            else if (n.fn === "ne" && nullable)
              report("warning", "MESH_EXPR_NEGATED_UNKNOWN",
                "`!==` on a value that can be null is unknown when it is null, so the check fails or the row is left out (JavaScript says true)", n.position,
                "write `x !== null && x !== value`");
            return { c: "boolean", nullable };
          }
          case "lt": case "lte": case "gt": case "gte": {
            const [x, y] = a as [Ty, Ty];
            if (!bothClass(x, "number", "date") || !bothClass(y, "number", "date") || !same(x, y)) return fail("an ordering comparison on values that are not both numbers or both dates");
            return { c: "boolean", nullable };
          }
          case "and": case "or": {
            if (!a.every((t) => bothClass(t, "boolean"))) return fail("a non-boolean operand of `&&`/`||` (truthiness)");
            return { c: "boolean", nullable };
          }
          case "not": {
            if (!bothClass(a[0]!, "boolean")) return fail("a non-boolean operand of `!` (truthiness)");
            if (nullable) report("warning", "MESH_EXPR_NEGATED_UNKNOWN",
              "`!` on a value that can be unknown is unknown, so the check fails or the row is left out (JavaScript says true for null)", n.position,
              "test for null first: `x !== null && !x`");
            return { c: "boolean", nullable };
          }
          case "add": case "sub": case "mul": case "div": case "neg": {
            if (!a.every((t) => bothClass(t, "number"))) return fail("arithmetic on values that are not numbers");
            const divisor = n.args[1];
            const safe = divisor?.kind === "literal" && typeof divisor.value === "number" && divisor.value !== 0;
            return { c: "number", nullable: n.fn === "div" && !safe ? true : nullable };
          }
          case "length": {
            const x = a[0]!;
            if (!bothClass(x, "string", "list")) return fail("`.length` of something that is not a string or a list");
            return { c: "number", nullable: x.c === "string" ? x.nullable : false };
          }
          case "now": case "today": return { c: "date", nullable: false };
          case "coalesce": {
            const [x, y] = a as [Ty, Ty];
            if (!same(x, y) && !(x.literal && x.c === "any")) return fail("`??` between values of different types");
            return { ...(x.c === "any" ? y : x), nullable: y.nullable, literal: false, atom: undefined, viaOptional: false };
          }
          case "cond": {
            const [c, x, y] = a as [Ty, Ty, Ty];
            if (!bothClass(c, "boolean")) return fail("a non-boolean test in `?:` (truthiness)");
            if (!same(x, y)) return fail("`?:` branches of different types");
            return { ...(x.c === "any" ? y : x), nullable: x.nullable || y.nullable, literal: false, atom: undefined };
          }
        }
      }
    }
  }

  function hasOperator(n: ExprNode): boolean {
    if (n.kind === "call") return BOOLEAN_OPERATORS.has(n.fn) || n.args.some(hasOperator);
    if (n.kind === "member") return hasOperator(n.object);
    if (n.kind === "helper") return n.args.some(hasOperator);
    if (n.kind === "quantify") return hasOperator(n.source) || hasOperator(n.body);
    return false;
  }
  const SOURCE_OPERATOR = /[<>]|[!=]==?|&&|\|\||\?\?|(?<![=!<>])!(?!=)/;
  function warnPlain(e: Expression, detail: string, position: SourcePosition): void {
    // A construct the build already rejects does not also deserve a warning.
    if (diagnostics.some((d) => d.severity === "error" && d.position.file === position.file && d.position.offset >= e.position.offset && d.position.offset <= e.position.offset + e.source.length)) return;
    report("warning", "MESH_EXPR_PLAIN",
      `this expression runs as plain TypeScript with JavaScript's rules for null, not Mesh's, because it uses ${detail}`, position,
      "rewrite it with comparisons, `&&`, `||`, `!`, `??`, `?.`, `now()`, `today()` and the list methods some, every, find and filter to have Mesh translate it");
    void e;
  }

  function demote(e: Expression, d: Demote): void {
    const tree = e.tree!;
    delete e.tree;
    e.plain = { why: "unsupported-construct", detail: d.detail, position: d.position, edits: options.editsOf(e), ...(/^\s*\(.*\)\s*\{/s.test(e.source) && !e.source.includes("=>") ? { method: true as const } : {}) };
    if (hasOperator(tree)) warnPlain(e, d.detail, d.position);
  }

  /** Check one expression; `boolean` says the result must be a boolean (a check, a condition, a filter). Returns the result type. */
  function visit(e: Expression, scope: Scope, boolean: boolean): Ty | null {
    if (e.plain) {
      if ((e.plain.why === "unsupported-construct" || e.plain.why === "reads-record-in-helper") && SOURCE_OPERATOR.test(e.source.replaceAll("=>", "")))
        warnPlain(e, e.plain.detail, e.plain.position);
      return null;
    }
    if (!e.tree) return null;
    try {
      const t = infer(e.tree, scope);
      if (boolean && t.c !== "boolean" && t.c !== "any") throw new Demote("a result that is not a boolean (truthiness)", e.tree.position);
      return t;
    } catch (x) {
      if (x instanceof Demote) { demote(e, x); return null; }
      throw x;
    }
  }

  const inputsOf = (entity: Entity, action: Action): Map<string, Ty> => {
    const map = new Map<string, Ty>();
    for (const field of action.input) {
      if (field.kind === "member") {
        const a = entity.attributes.find((x) => x.name === field.ref.name);
        map.set(field.ref.name, a ? attributeTy(a) : { c: "any", nullable: false });
      } else map.set(field.name, { ...attributeTy(field as unknown as Attribute) });
    }
    return map;
  };

  function steps(list: Step[], entity: Entity, scope: Scope): void {
    for (const step of list) {
      if (step.kind === "set") {
        for (const { member, value } of step.assignments) {
          if (typeof value === "object" && value !== null && "source" in value) {
            const t = visit(value as Expression, scope, false);
            const attr = entity.attributes.find((a) => a.name === member.name);
            if (t?.nullable && attr && !attr.nullable && !attr.primaryKey)
              report("error", "MESH_EXPR_NULL_TO_REQUIRED",
                `\`${member.name}\` is required, and this value can be null`, (value as Expression).position,
                "give it a default with `?? value`, or check it first");
          }
        }
      } else if (step.kind === "when") {
        visit(step.condition, scope, true);
        steps(step.steps, entity, scope);
      } else if (step.kind === "run") visit(step.fn, scope, false);
    }
  }
  function blocks(entity: Entity, validate: { that: Expression; when?: Expression }[], list: Step[], scope: Scope): void {
    for (const check of validate) {
      visit(check.that, scope, true);
      if (check.when) visit(check.when, scope, true);
    }
    steps(list, entity, scope);
  }

  for (const entity of document.entities) {
    const base: Scope = { entity, beforeNullable: true, inputs: null, locals: new Map() };
    for (const computed of entity.computed as Computed[]) {
      if (!computed.body) continue;
      const t = visit(computed.body, base, false);
      computed.nullable = t ? t.nullable : false;
    }
    for (const action of entity.actions) {
      const scope: Scope = { ...base, beforeNullable: action.kind === "create", inputs: inputsOf(entity, action) };
      if (action.filter) visit(action.filter, scope, true);
      blocks(entity, action.validate, action.do, scope);
    }
    for (const block of entity.always) {
      const covers = block.types ?? (block.actions ? ["create"] : ["create"]);
      blocks(entity, block.validate, block.do, { ...base, beforeNullable: covers.includes("create"), inputs: null });
    }
    for (const policy of entity.policies) {
      const scope = { ...base, inputs: null };
      for (const e of [...policy.authorizeIf, ...policy.forbidIf]) visit(e, scope, true);
      if (policy.when) visit(policy.when, scope, true);
    }
  }
}

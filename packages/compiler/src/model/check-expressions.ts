import { dirname, resolve } from "node:path";
import type {
  Action,
  Attribute,
  Computed,
  Diagnostic,
  Entity,
  ExprNode,
  Expression,
  InternalNames,
  ModelDocument,
  SourceEdit,
  SourcePosition,
  Step,
  TypeClass,
} from "@meshfw/model";
import { newInstanceComputed, newInstanceGaps, newInstanceMembers } from "./new-instance.ts";
import { policyCovers } from "./policies.ts";

/**
 * Types every translated expression across the whole model (M4, ADR-0012 option A).
 * Language-neutral: it reads the model only. It reports what no reading of the code can
 * excuse (an unknown atom, `.x` through a value that may be null, null written to a required
 * attribute), warns where translated code flips on null, and demotes to plain code what the
 * registry cannot define (D4, D3): the expression keeps JavaScript's meaning and warns.
 */
export interface CheckOptions {
  /** What printing a translated function as plain code needs, kept by the front end for demotion: the edits that turn it into TypeScript, the scope names it reads, the names its edits read (`internal`) and whether it is a method. */
  demotionOf: (expression: Expression) => { edits: SourceEdit[]; roots: string[]; clock?: ("now" | "today")[]; internal?: InternalNames; isSystem?: true; helpers?: string[]; mesh?: string[]; method?: true };
}

interface Ty {
  c: TypeClass | "input";
  /** For boolean: can be unknown. */
  nullable: boolean;
  /** Nullable only because an upstream `?.` short-circuits the whole chain. */
  viaOptional?: boolean;
  entity?: Entity;
  values?: readonly string[];
  /** A whole number: `integer` attribute, integer literal, or arithmetic over integers. */
  int?: boolean;
  /** A literal, so `a === b` does not warn about null equality. */
  literal?: boolean;
  atom?: string;
  /** The stored record (`before`): columns only, nothing is loaded for it. */
  stored?: boolean;
  /** `self` where it may be a create's new instance: the members that hold null there until the input or a step fills them. */
  fresh?: ReadonlySet<string>;
  /** A member of `self` that is nullable only because it may not be filled yet (one of `fresh`). */
  unfilled?: string;
  /** `input.x` where `x` is a member input (`&x`), not a typed argument. */
  input?: string;
  /** `self` in a check that can run on a create: the members a create takes as member inputs, which the checks see before the input is applied. */
  pending?: ReadonlySet<string>;
}

class Demote extends Error {
  /** `always`: the build warns even without an operator (truthiness). */
  constructor(readonly detail: string, readonly position: SourcePosition, readonly always = false) { super(detail); }
}

const CLASS: Record<string, TypeClass> = {
  uuid: "string", string: "string", integer: "number", float: "number", decimal: "number",
  boolean: "boolean", enum: "enum", date: "date", datetime: "date", timestamp: "date", json: "json",
};
/** Functions whose null rule differs from JavaScript's: `??` and `?.` do not (COALESCE and a left join mean the same). */
const DIFFERING = new Set(["eq", "ne", "lt", "lte", "gt", "gte", "and", "or", "not", "add", "sub", "mul", "div", "idiv", "neg", "length"]);

interface Scope {
  entity: Entity;
  /** Nullability of `before`: false for update and destroy. */
  beforeNullable: boolean;
  /** Names of the action's typed arguments: one that shares a member's name is not the member input. */
  args?: Set<string>;
  /** Inside `validate`: `self` is the record before the input is applied, and there is no `before`. */
  validate?: boolean;
  /** In a policy, which sees `self` as `validate` does, before the input: the policy's message name, `policy :owner`. */
  policy?: string;
  /** When the function can run on a create: the members of `self` that may still be null there (see `newInstanceGaps`). */
  fresh?: ReadonlySet<string>;
  /** The members every create the function runs in takes as a member input, so `input.x ?? &x` has a value on a create. */
  acceptedOnCreate?: ReadonlySet<string>;
  /** In a check that can run on a create: the members some such create takes as a member input (and a relationship's key column). */
  pending?: ReadonlySet<string>;
  /** Which part of a check this is: an unknown `that` fails the check, an unknown `when` skips it. */
  checkPart?: "that" | "when" | "details" | "message";
  /** References (`self.x`, `before.x`, `input.x`, `before`) that the left of an enclosing `&&` or `||` has shown are not null here. */
  nonNull?: ReadonlySet<string>;
  /** True where the expression is printed as the author's TypeScript, where tsc narrows less than Mesh does: nothing narrows. */
  noNarrow?: boolean;
  /** True in the second pass over a demoted tree, which is printed as JavaScript: `/` gives 3.5 there, so it is not rewritten to `idiv`. */
  printedAsJavaScript?: boolean;
  inputs: Map<string, Ty> | null;
  locals: Map<string, Ty>;
}

/** The path of `self.x`, `before.x.y`, `input.x` or `before`, or undefined for anything else (a `?.` chain, a local, a call). */
function pathOf(n: ExprNode): string | undefined {
  if (n.kind === "var") return n.name === "self" || n.name === "before" || n.name === "input" ? n.name : undefined;
  if (n.kind !== "member" || n.optional) return undefined;
  const object = pathOf(n.object);
  return object === undefined ? undefined : `${object}.${n.name}`;
}

/**
 * The references a boolean expression proves not null: when it is true (`when: true`, the right of `&&`), those it tests
 * with `!== null` or `!= null`; when it is false (the right of `||`), those it tests with `=== null` or `== null`. An `&&`
 * proves both sides when true, and an `||` both sides when false. Nothing else narrows (no `typeof`, no truthiness).
 */
function provenNotNull(n: ExprNode, when: boolean, into: Set<string> = new Set()): Set<string> {
  if (n.kind !== "call") return into;
  if ((n.fn === "isNotNull" && when) || (n.fn === "isNull" && !when)) {
    const path = n.args[0] ? pathOf(n.args[0]) : undefined;
    if (path !== undefined) into.add(path);
  } else if ((n.fn === "and" && when) || (n.fn === "or" && !when)) n.args.forEach((arg) => provenNotNull(arg, when, into));
  return into;
}

export function checkExpressions(document: ModelDocument, diagnostics: Diagnostic[], options: CheckOptions): void {
  const byFile = new Map(document.entities.map((entity) => [resolve(entity.file), entity]));
  const target = (from: Entity, relation: Entity["relationships"][number]): Entity | undefined =>
    byFile.get(resolve(dirname(from.file), relation.entity.from));
  const report = (severity: "error" | "warning", code: string, message: string, position: SourcePosition, fix: string | null = null) =>
    diagnostics.push({ severity, code, message, position, fix });
  /** The `&x` of an `input.x ?? &x`. */
  const storedFallback = new WeakSet<ExprNode>();

  const attributeTy = (a: Attribute): Ty => ({
    c: CLASS[a.type] ?? "any", nullable: a.nullable, ...(a.type === "integer" ? { int: true } : {}),
    ...(a.values ? { values: a.values.map((v) => v.value) } : {}),
  });

  function memberTy(scope: Scope, owner: Ty, name: string): Ty {
    if (owner.c === "input") return owner.entity ? { c: "any", nullable: false } : { ...scopeInput(scope, name), ...(scope.args?.has(name) ? {} : { input: name }) };
    const result = ownMemberTy(owner, name);
    // On a create, `self` is the new instance: a member with no default holds null until the input or a step fills it.
    // A computed field `newInstanceComputed` lists is null there too, whatever its declared nullability says (it is the same set the generated type uses).
    return owner.fresh?.has(name) && (!result.nullable || owner.entity?.computed.some((c) => c.name === name)) ? { ...result, nullable: true, unfilled: name } : result;
  }
  function ownMemberTy(owner: Ty, name: string): Ty {
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
      return { c: CLASS[computed.type] ?? "any", nullable, ...(computed.type === "integer" ? { int: true } : {}) };
    }
    return { c: "any", nullable: false };
  }
  const scopeInput = (scope: Scope, name: string): Ty => scope.inputs?.get(name) ?? { c: "any", nullable: false };
  /** `policy`: the policy's message name when the function is a policy's (S2 of the M8a review), which sees `self` as `validate` does. */
  const notApplied = (name: string, position: SourcePosition, policy?: string) => {
    const code = policy ? "MESH_POLICY_NOT_APPLIED" : "MESH_VALIDATE_NOT_APPLIED";
    if (diagnostics.some((d) => d.code === code && d.position.file === position.file && d.position.offset === position.offset)) return;
    report("warning", code,
      `on a create, \`&${name}\` here is the new instance's value before the input is applied (its default, or null), not the caller's: ${policy ? `${policy} sees \`self\` as \`validate\` does,` : "\`validate\` sees \`self\`"} before the input`, position,
      `write \`input.${name}\` for the caller's value, or \`input.${name} ?? &${name}\` for the value the action will store; on an update this changes the meaning (\`input.${name} ?? &${name}\` is the value being sent, \`&${name}\` the stored one), so in a check that also runs on updates and means the stored value, keep \`&${name}\``);
  };
  /** The same for a check Mesh runs as plain code: each `&x` the authored text reads, found through its edits. */
  const plainNotApplied = (e: Expression, pending: ReadonlySet<string>, policy?: string) => {
    for (const edit of e.plain?.edits ?? []) {
      const name = edit.member;
      if (name === undefined || edit.fallback || !pending.has(name)) continue;
      const before = e.source.slice(0, edit.from);
      const lines = before.split("\n");
      notApplied(name, {
        file: e.position.file, offset: e.position.offset + edit.from, line: e.position.line + lines.length - 1,
        column: lines.length === 1 ? e.position.column + edit.from : lines.at(-1)!.length,
      }, policy);
    }
  };
  /** What an unknown value does in each part of a check (`runCheck`): `that` fails the check, `when` skips it, `details` is null, in a `message` an unknown condition counts as false and an unknown message fails the call. Elsewhere (a step, a computed field) the outcome depends on the position. */
  const whenUnknown = (part: Scope["checkPart"]) =>
    part === "that" ? "the check fails" : part === "when" ? "the check is skipped" : part === "details" ? "the details value is null" : part === "message" ? "an unknown condition counts as false, and a message that is itself unknown fails the call with a FrameworkError" : "the check fails or the row is left out";
  // No reachability analysis: `&n > 0 || true` is not unknown, so the wording says what happens when the result depends on the read.
  const unfilled = (name: string, position: SourcePosition, part: Scope["checkPart"]) =>
    report("warning", "MESH_VALIDATE_UNFILLED",
      `\`&${name}\` is null on every create here: \`validate\` sees the new instance before the input is applied, so a result that depends on it is unknown and ${whenUnknown(part)}`, position,
      `write \`input.${name} ?? &${name}\` for the value the action will store, or \`input.${name}\` for the caller's`);

  function infer(n: ExprNode, scope: Scope): Ty {
    const ty = inferNode(n, scope);
    const path = scope.nonNull?.size ? pathOf(n) : undefined;
    // A member a create has not filled yet is null on every create: the guard does not make it known.
    if (path === undefined || !scope.nonNull!.has(path) || !ty.nullable || ty.unfilled !== undefined) return ty;
    return { ...ty, nullable: false };
  }

  /** The `div` nodes rewritten to `idiv` so far, so a second pass over a tree can put them back and report them again. */
  const divided: Extract<ExprNode, { kind: "call" }>[] = [];

  function inferNode(n: ExprNode, scope: Scope): Ty {
    const fail = (detail: string): never => { throw new Demote(detail, n.position); };
    switch (n.kind) {
      case "literal":
        if (n.value === null) return { c: "any", nullable: true, literal: true };
        return { c: typeof n.value === "number" ? "number" : typeof n.value === "boolean" ? "boolean" : "string", nullable: false, literal: true, ...(typeof n.value === "number" && Number.isInteger(n.value) && !n.float ? { int: true } : {}) };
      case "atom": return { c: "enum", nullable: false, literal: true, atom: n.value };
      case "var": {
        if (n.name === "self") return { c: "record", nullable: false, entity: scope.entity, ...(scope.fresh?.size ? { fresh: scope.fresh } : {}), ...(scope.pending?.size ? { pending: scope.pending } : {}) };
        if (n.name === "before" && scope.validate) {
          report("error", "MESH_VALIDATE_BEFORE",
            "`before` is gone from `validate`: there `self` is the record before the input is applied (the stored record, or a create's new instance), and the caller's values are `input.x`", n.position,
            "write `&x` for the value before the input, `input.x` for the caller's, and `input.x ?? &x` for the value the action will store");
          return { c: "any", nullable: false };
        }
        if (n.name === "before" && scope.policy) {
          report("error", "MESH_POLICY_BEFORE",
            `${scope.policy} reads \`before\`, which a policy does not have: it sees \`self\` as \`validate\` does, before the input is applied (the stored record, or a create's new instance), and the caller's values as \`input.x\``, n.position,
            "write `&x` for the stored value and `input.x` for the caller's");
          return { c: "any", nullable: false };
        }
        if (n.name === "before") return { c: "record", nullable: scope.beforeNullable, entity: scope.entity, stored: true };
        if (n.name === "input") return { c: "input", nullable: false };
        if (n.name === "actor" || n.name === "context") return { c: "any", nullable: false };
        return scope.locals.get(n.name) ?? { c: "any", nullable: false };
      }
      case "member": {
        const owner = infer(n.object, scope);
        // On a create, `&x` in a check is the new instance's value before the input: its default, or null. Not the caller's.
        if (owner.pending?.has(n.name) && !storedFallback.has(n)) {
          notApplied(n.name, n.position, scope.policy);
          return { c: "any", nullable: false };
        }
        if (owner.nullable && !owner.viaOptional && !n.optional && owner.c !== "any") {
          if (owner.unfilled !== undefined)
            report("error", "MESH_EXPR_NULLABLE_ACCESS",
              `\`.${n.name}\` is read through \`&${owner.unfilled}\`, which is null on a create here: \`validate\` sees the new instance before the input is applied`, n.position,
              `read the caller's value as \`input.${owner.unfilled}\` (a related record through \`Mesh.privileged(${owner.entity?.name ?? "<Entity>"}).read\`), or write \`?.${n.name}\` for null on a create`);
          else
            report("error", "MESH_EXPR_NULLABLE_ACCESS",
              `\`.${n.name}\` is read through a value that may be null`, n.position,
              `write \`?.${n.name}\`, which gives null when the value is null`);
        }
        if (owner.stored && owner.entity && !owner.entity.attributes.some((a) => a.name === n.name)
          && (owner.entity.relationships.some((r) => r.name === n.name) || owner.entity.computed.some((x) => x.name === n.name))) {
          report("error", "MESH_BEFORE_NOT_LOADED",
            `\`before.${n.name}\` is a ${owner.entity.relationships.some((r) => r.name === n.name) ? "relationship" : "computed field"}, and \`before\` holds only the stored columns`, n.position,
            `read \`&${n.name}\` for the proposed record's (Mesh loads it), or compare the stored key (for a relationship, \`before.${n.name}Id\`)`);
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
        if (body.c !== "boolean" && body.c !== "any") throw new Demote("a predicate that is not a boolean (truthiness)", n.position, true);
        if (n.op === "some" || n.op === "every") return { c: "boolean", nullable: source.nullable };
        if (n.op === "find") return { c: "record", nullable: true, entity: source.entity, viaOptional: false };
        return { c: "list", nullable: source.nullable, ...(source.entity ? { entity: source.entity } : {}) };
      }
      case "call": {
        // `input.x ?? &x` reads `&x` only when the caller did not send x: the value the action will store.
        const [left, right] = n.args;
        if (n.fn === "coalesce" && left?.kind === "member" && right?.kind === "member" && left.name === right.name
          && left.object.kind === "var" && left.object.name === "input" && right.object.kind === "var" && right.object.name === "self")
          storedFallback.add(right);
        // The right of `a && b` knows what `a` tested not null; the right of `a || b` knows what `a` tested null; in `c ? a : b`,
        // `a` knows what `c` proved when true and `b` what `c` proved when false.
        const proven = new Set(scope.nonNull);
        const a = n.args.map((arg, i) => {
          const sequential = n.fn === "and" || n.fn === "or";
          const branch = n.fn === "cond" && i > 0;
          const narrows = (sequential || branch) && !scope.noNarrow;
          const known = branch && narrows ? new Set([...proven, ...provenNotNull(n.args[0]!, i === 1)]) : proven;
          const ty = infer(arg, narrows ? { ...scope, nonNull: new Set(known) } : scope);
          if (sequential && narrows) provenNotNull(arg, n.fn === "and", proven);
          return ty;
        });
        // An operator over a member a create has not filled yet is unknown on every create: the check would always fail there.
        if (scope.validate && n.fn !== "isNull" && n.fn !== "isNotNull" && n.fn !== "coalesce")
          a.forEach((t, i) => { if (t.unfilled !== undefined && (n.fn !== "cond" || i === 0)) unfilled(t.unfilled, n.args[i]!.position, scope.checkPart); });
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
                `\`!==\` on a value that can be null is unknown when it is null, so ${whenUnknown(scope.checkPart)} (JavaScript says true)`, n.position,
                "write `x !== null && x !== value`");
            return { c: "boolean", nullable };
          }
          case "lt": case "lte": case "gt": case "gte": {
            const [x, y] = a as [Ty, Ty];
            if (!bothClass(x, "number", "date") || !bothClass(y, "number", "date") || !same(x, y)) return fail("an ordering comparison on values that are not both numbers or both dates");
            return { c: "boolean", nullable };
          }
          case "and": case "or": {
            if (!a.every((t) => bothClass(t, "boolean"))) throw new Demote("a non-boolean operand of `&&`/`||` (truthiness)", n.position, true);
            return { c: "boolean", nullable };
          }
          case "not": {
            if (!bothClass(a[0]!, "boolean")) throw new Demote("a non-boolean operand of `!` (truthiness)", n.position, true);
            if (nullable) report("warning", "MESH_EXPR_NEGATED_UNKNOWN",
              `\`!\` on a value that can be unknown is unknown, so ${whenUnknown(scope.checkPart)} (JavaScript says true for null)`, n.position,
              "test for null first: `x !== null && !x`");
            return { c: "boolean", nullable };
          }
          case "add": case "sub": case "mul": case "div": case "idiv": case "neg": {
            if (!a.every((t) => bothClass(t, "number"))) return fail("arithmetic on values that are not numbers");
            const int = a.every((t) => t.int === true);
            if (n.fn === "div" && int && !scope.printedAsJavaScript) {
              n.fn = "idiv";
              divided.push(n);
              report("warning", "MESH_EXPR_INTEGER_DIVISION",
                "dividing two integers truncates toward zero (7 / 2 is 3, -7 / 2 is -3), as in SQL; JavaScript gives 3.5", n.position,
                "make one operand a float or decimal for exact division");
            }
            const divisor = n.args[1];
            const safe = divisor?.kind === "literal" && typeof divisor.value === "number" && divisor.value !== 0;
            const divides = n.fn === "div" || n.fn === "idiv";
            return { c: "number", nullable: divides && !safe ? true : nullable, ...(int ? { int: true } : {}) };
          }
          case "length": {
            const x = a[0]!;
            if (!bothClass(x, "string", "list")) return fail("`.length` of something that is not a string or a list");
            return { c: "number", nullable: x.c === "string" ? x.nullable : false, int: true };
          }
          case "now": case "today": return { c: "date", nullable: false };
          case "isSystem": return { c: "boolean", nullable: false };
          case "coalesce": {
            const [x, y] = a as [Ty, Ty];
            if (!same(x, y) && !(x.literal && x.c === "any")) return fail("`??` between values of different types");
            // `input.x ?? &x`, the value the action will store: on a create that takes `&x` the input has it, elsewhere the record does.
            if (x.input !== undefined && x.input === y.unfilled && scope.acceptedOnCreate?.has(x.input))
              return { ...(x.c === "any" ? y : x), nullable: false, literal: false, atom: undefined, viaOptional: false, unfilled: undefined, input: undefined };
            return { ...(x.c === "any" ? y : x), nullable: y.nullable, literal: false, atom: undefined, viaOptional: false, unfilled: undefined, input: undefined };
          }
          case "cond": {
            const [c, x, y] = a as [Ty, Ty, Ty];
            if (!bothClass(c, "boolean")) throw new Demote("a non-boolean test in `?:` (truthiness)", n.position, true);
            if (!same(x, y)) return fail("`?:` branches of different types");
            return { ...(x.c === "any" ? y : x), nullable: x.nullable || y.nullable, literal: false, atom: undefined, unfilled: undefined, input: undefined };
          }
        }
      }
    }
  }

  function hasOperator(n: ExprNode): boolean {
    if (n.kind === "call") return DIFFERING.has(n.fn) || n.args.some(hasOperator);
    if (n.kind === "member") return hasOperator(n.object);
    if (n.kind === "helper") return n.args.some(hasOperator);
    if (n.kind === "quantify") return hasOperator(n.source) || hasOperator(n.body);
    return false;
  }
  function warnPlain(e: Expression, detail: string, position: SourcePosition): void {
    // A construct the build already rejects does not also deserve a warning.
    if (diagnostics.some((d) => d.severity === "error" && d.position.file === position.file && d.position.offset >= e.position.offset && d.position.offset <= e.position.offset + e.source.length)) return;
    report("warning", "MESH_EXPR_PLAIN",
      `this expression runs as plain TypeScript with JavaScript's rules for null, not Mesh's, because of ${detail}`, position,
      "rewrite it with comparisons, `&&`, `||`, `!`, `??`, `?.`, `%.now`, `%.today` and the list methods some, every, find and filter to have Mesh translate it");
    void e;
  }

  function demote(e: Expression, d: Demote): void {
    const tree = e.tree!;
    delete e.tree;
    e.plain = { why: "unsupported-construct", detail: d.detail, position: d.position, ...options.demotionOf(e) };
    if ((d.always || hasOperator(tree))) warnPlain(e, d.detail, d.position);
  }

  /** Check one expression; `boolean` says the result must be a boolean (a check, a condition, a filter). Returns the result type. */
  function visit(e: Expression, scope: Scope, boolean: boolean): Ty | null {
    if (e.plain) {
      const parts = e.plain.parts;
      delete e.plain.parts;
      if ((e.plain.why === "unsupported-construct" || e.plain.why === "reads-record-in-helper") && e.plain.operators)
        warnPlain(e, e.plain.detail, e.plain.position);
      else if (parts && !e.plain.operators) {
        // An object literal whose values Mesh can translate: JavaScript's null rule differs only when an operand can be null.
        for (const part of parts) {
          try {
            const t = infer(part, { ...scope, noNarrow: true, printedAsJavaScript: true });
            if (t.nullable && hasOperator(part)) warnPlain(e, "a comparison or operator that can see a null", part.position);
          } catch (x) { if (!(x instanceof Demote)) throw x; if (hasOperator(part)) warnPlain(e, x.detail, x.position); }
        }
      }
      return null;
    }
    if (!e.tree) return null;
    try {
      const pass = (from: Scope): Ty => {
        const t = infer(e.tree!, from);
        if (boolean && t.c !== "boolean" && t.c !== "any") throw new Demote("a result that is not a boolean (truthiness)", e.tree!.position, true);
        return t;
      };
      let t: Ty;
      const reported = diagnostics.length, converted = divided.length;
      try { t = pass(scope); }
      catch (x) {
        if (!(x instanceof Demote)) throw x;
        // A demoted tree is printed as the author's TypeScript, where tsc narrows less than Mesh did: check it again without
        // narrowing, as if the guards were not there, and report what that finds.
        diagnostics.length = reported;
        for (const node of divided.splice(converted)) node.fn = "div";
        t = pass({ ...scope, noNarrow: true, printedAsJavaScript: true });
      }
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
        map.set(field.ref.name, a ? { ...attributeTy(a), nullable: a.nullable || action.kind === "update" } : { c: "any", nullable: false });
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
            const relation = attr ? undefined : entity.relationships.find((r) => r.name === member.name && r.kind === "belongs-to");
            // `set &x=({ input }) => input.x` is "unchanged" when the caller omits x (M5 skips it): not an error.
            const tree = (value as Expression).tree;
            const passthrough = !scope.args?.has(member.name) && tree?.kind === "member" && tree.object.kind === "var" && tree.object.name === "input" && tree.name === member.name;
            const required = attr ? !attr.nullable && !attr.primaryKey : relation ? !relation.nullable : false;
            if (t?.nullable && required && !passthrough)
              report("error", "MESH_EXPR_NULL_TO_REQUIRED",
                `\`${member.name}\` is required, and this value can be null`, (value as Expression).position,
                "give it a default with `?? value`, or check it first");
          }
        }
      } else if (step.kind === "when") {
        visit(step.condition, scope, true);
        steps(step.steps, entity, scope);
        // After the write, `self` is the stored record: on a create the data layer has given it its key.
      } else if (step.kind === "run") visit(step.fn, step.after === "write" ? { ...scope, fresh: undefined } : scope, false);
    }
  }
  /** For each create, the members it takes as member inputs. */
  function acceptedBy(creates: readonly { input: Action["input"] }[]): Set<string>[] {
    return creates.map((action) => new Set(action.input.flatMap((field) => (field.kind === "member" ? [field.ref.name] : []))));
  }
  /** The members some create takes as a member input, with a relationship's key column: on a create, `&x` of one is not the caller's value. */
  function pendingOn(entity: Entity, creates: readonly { input: Action["input"] }[]): Set<string> {
    const keyColumn = (name: string) => entity.relationships.find((relation) => relation.name === name && relation.kind === "belongs-to")?.keyColumn;
    return new Set(acceptedBy(creates).flatMap((set) => [...set].flatMap((name) => [name, ...(keyColumn(name) ? [keyColumn(name)!] : [])])));
  }
  /**
   * The checks see `self` before the input is applied and no `before`: on a create, the new instance, where
   * a member with no default is still null. The steps before the write see the input applied; on a create the key the data
   * layer gives (an `integer` key) is null until the write.
   */
  function blocks(entity: Entity, validate: { that: Expression; when?: Expression; details?: Expression; message: string | Expression }[], list: Step[], scope: Scope, creates: readonly { input: Action["input"] }[]): void {
    const gaps = newInstanceGaps(entity);
    const accepted = acceptedBy(creates);
    const pending = pendingOn(entity, creates);
    const members = newInstanceMembers(gaps, true);
    const checks: Scope = creates.length
      ? { ...scope, validate: true, fresh: new Set([...members, ...newInstanceComputed(entity, new Set(members))]), pending, acceptedOnCreate: new Set([...accepted[0]!].filter((name) => accepted.every((set) => set.has(name)))) }
      : { ...scope, validate: true };
    for (const check of validate) {
      for (const [e, part] of check.when ? [[check.that, "that"], [check.when, "when"]] as const : [[check.that, "that"]] as const) {
        const t = visit(e, { ...checks, checkPart: part }, true);
        if (t?.unfilled !== undefined) unfilled(t.unfilled, e.tree!.position, part);
      }
      if (check.details) visit(check.details, { ...checks, checkPart: "details" }, false);
      if (typeof check.message !== "string") visit(check.message, { ...checks, checkPart: "message" }, false);
      if (checks.pending?.size) for (const e of [check.that, check.when, check.details, check.message]) if (typeof e === "object" && e.plain) plainNotApplied(e, checks.pending);
    }
    steps(list, entity, creates.length && gaps.key ? { ...scope, fresh: new Set([gaps.key]) } : scope);
  }

  for (const entity of document.entities) {
    const base: Scope = { entity, beforeNullable: true, inputs: null, locals: new Map() };
    for (const computed of entity.computed as Computed[]) {
      if (!computed.body) continue;
      const t = visit(computed.body, base, false);
      computed.nullable = t ? t.nullable : false;
    }
    for (const action of entity.actions) {
      const scope: Scope = { ...base, beforeNullable: action.kind === "create", args: new Set(action.input.flatMap((field) => (field.kind === "argument" ? [field.name] : []))), inputs: inputsOf(entity, action) };
      if (action.filter) visit(action.filter, scope, true);
      blocks(entity, action.validate, action.do, scope, action.kind === "create" ? [action] : []);
    }
    // The actions an `always` block can cover: the declared ones and the generated (`auto`) ones, which take no input.
    const every = [...entity.actions, ...entity.auto.map((kind) => ({ kind, name: kind as string, input: [] as Action["input"] }))];
    for (const block of entity.always) {
      const named = block.actions?.map((ref) => entity.actions.find((a) => a.name === ref.name)?.kind);
      const covers: (string | undefined)[] = block.types ?? named ?? ["create"];
      const creates = every.filter((action) => action.kind === "create"
        && ((!block.types && !block.actions) || block.types?.includes(action.kind) || block.actions?.some((ref) => ref.name === action.name)));
      blocks(entity, block.validate, block.do, { ...base, beforeNullable: covers.includes("create") || covers.includes(undefined), inputs: null }, creates);
    }
    for (const policy of entity.policies) {
      // A policy sees `self` as `validate` does: on a create it covers, `&x` of a member the create takes is the new
      // instance's value before the input, not the caller's.
      const pending = pendingOn(entity, every.filter((action) => action.kind === "create" && policyCovers(policy, action)));
      const scope: Scope = { ...base, inputs: null, policy: `policy :${policy.name}`, ...(pending.size ? { pending } : {}) };
      const name = `policy :${policy.name}`;
      for (const e of [...policy.authorizeIf, ...policy.forbidIf, ...(policy.when ? [policy.when] : [])]) {
        visit(e, scope, true);
        if (pending.size && e.plain) plainNotApplied(e, pending, name);
      }
    }
  }
}

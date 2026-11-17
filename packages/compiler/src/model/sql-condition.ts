import type { Action, AttributeType, Computed, Entity, ValueType, Expression, ExprNode, ModelDocument, Relationship, SortKey, SourcePosition } from "@meshfw/model";
import type { Hop, LiteralNode, ValueClass } from "@meshfw/runtime";
import { entitiesByFile, keyHolderOf } from "./key-holder.ts";
import { dirname, resolve } from "node:path";

/**
 * Lowering (M10, ADR-0088): a translated function in a SQL position (a read's filter, a sort key, a read policy) as the
 * plain-data condition the data adapter turns into SQL. Each maximal subtree that reads no row (`input.x`, `actor.id`,
 * `isStaff(actor)`, `%.today`) becomes a numbered parameter the generated code computes in memory with the emitted form,
 * so both evaluators agree on it by construction. A row is the record the condition is about (depth 0) or a related row
 * a hop or a quantifier reaches (depth 1 and deeper). A translated computed field read there is inlined, and a rollup is a
 * `rollup` node over its route (m10-rollups, R22); what has no SQL form is reported, never evaluated over loaded rows
 * (roadmap principle 2).
 */

/** Why a function in a SQL position has no SQL form. */
export type NotSql =
  /** The function itself is plain (a block body, a helper given the record, a construct Mesh does not translate). */
  | { kind: "plain"; position: SourcePosition; detail: string }
  /**
   * It reads a computed field Mesh runs in memory: `field` names it, `through` the translated field that reads it, if any;
   * both are paths as written, from their root (`&customer.label`, `l.invoice.customer.label`).
   */
  | { kind: "plain-computed"; position: SourcePosition; field: string; detail: string; through?: string }
  /** A quantifier whose list is not a relationship of a row (`input.ids.some((i) => i === &id)`). */
  | { kind: "foreign-list"; position: SourcePosition; op: "some" | "every" | "find" | "filter" }
  /** A computed field that reaches itself again when inlined. */
  | { kind: "self-reaching"; position: SourcePosition; field: string }
  /** `concept`: the member is a concept member (its FQN), stored as one JSON value as a `json` one is (ADR-0092). */
  | { kind: "json"; position: SourcePosition; member: string; concept?: string }
  /** Only with `mode: "write"`: a call that, in a write policy, counts as reading the record. */
  | { kind: "write-call"; position: SourcePosition; callee: string }
  /** It inlines a computed body that already holds an error (`LowerOptions.reported`): that error is the one to fix. */
  | { kind: "reported"; position: SourcePosition; field: string };

export interface Lowered {
  tree: LiteralNode;
  /** The record-independent subtrees, in parameter order: the back end prints each with `printTree`. */
  params: { tree: ExprNode; from: string }[];
  /** The helper imports the parameters need from files other than the condition owner's. */
  imports: { name: string; module: string; file: string }[];
  /** Where the condition crosses a relationship (for the joins capability check and `mesh explain`). */
  crossings: { position: SourcePosition; path: string }[];
}

export interface LowerOptions {
  /**
   * What depth 0 is: `self` (default), or the named parameter of a one-parameter function (a rollup's filter), whose reads
   * become columns; a belongs-to's key column (`line.productId`) is one of them.
   */
  root?: { param: string };
  /**
   * `read` (default): helper calls and every other record-independent subtree become parameters. `write`: a call to an
   * imported function is a `write-call` problem instead, since in a write policy it counts as reading the record.
   */
  mode?: "read" | "write";
  /** Does this computed body already hold an error? Inlining one is a `reported` problem, which no diagnostic repeats. */
  reported?: (body: Expression) => boolean;
}

export type LowerResult = { ok: true; lowered: Lowered } | { ok: false; problems: NotSql[] };

/** How deep computed fields are inlined into one another: the loader's `MAX_DEPTH`. */
const MAX_INLINE = 32;

/** A concept member is one JSON value (ADR-0092): never compared, as a `json` one. */
const CLASS: Readonly<Record<ValueType, ValueClass | "json">> = {
  uuid: "string", string: "string", enum: "string", integer: "integer", float: "float", decimal: "float",
  boolean: "boolean", date: "date", datetime: "date", timestamp: "date", json: "json", concept: "json",
};
/** How a stored value of `type` is compared in SQL; `json` is never compared. */
export function valueClassOf(type: ValueType): ValueClass | undefined {
  const cls = CLASS[type];
  return cls === "json" ? undefined : cls;
}

/** The tables a condition's hops reach (their FQNs), sorted. */
export function hopTables(node: LiteralNode, into: Set<string> = new Set()): Set<string> {
  switch (node.kind) {
    case "call": node.args.forEach((arg) => hopTables(arg, into)); break;
    case "one": into.add(node.hop.table); if (node.hop.through) into.add(node.hop.through.table); hopTables(node.value, into); break;
    case "some": case "every": into.add(node.hop.table); if (node.hop.through) into.add(node.hop.through.table); hopTables(node.where, into); break;
    case "count": into.add(node.hop.table); if (node.hop.through) into.add(node.hop.through.table); if (node.where) hopTables(node.where, into); break;
    case "first": into.add(node.hop.table); if (node.hop.through) into.add(node.hop.through.table); hopTables(node.where, into); hopTables(node.value, into); break;
    case "rollup":
      for (const hop of node.hops) { into.add(hop.table); if (hop.through) into.add(hop.through.table); }
      if (node.where) hopTables(node.where, into);
      break;
  }
  return into;
}

const BOOLEAN_FNS = new Set(["eq", "ne", "isNull", "isNotNull", "lt", "lte", "gt", "gte", "and", "or", "not", "isTrue", "isFalse", "isSystem"]);

interface Row { readonly depth: number; readonly entity: Entity }
interface Scope {
  /** The names that stand for a row: `self` (or the root parameter) and each quantifier's element bound inside the condition. */
  readonly rows: ReadonlyMap<string, Row>;
  /** The entity whose file holds the subtree being lowered: its helper calls are that file's imports. */
  readonly from: Entity;
  /** The action whose input `input.x` reads, for a parameter's class. */
  readonly action?: Action | undefined;
  /** Inside an inlined computed body: the read in the function that inlined it, where every problem is reported. */
  readonly outer?: { readonly position: SourcePosition; readonly path: string; readonly field: string } | undefined;
  /** The computed fields being inlined (`billing.Invoice#total`) and the rollups whose filter is being lowered (`billing.Invoice.c`), outermost first. */
  readonly inlining: readonly string[];
  /** The depth of the row whose belongs-to key columns may be read by name (`line.productId`): a rollup filter's parameter. */
  readonly keyed?: number;
}

/** Thrown inside the walk; collected into `problems`. */
class Refused extends Error {
  constructor(readonly problem: NotSql) { super(problem.kind); }
}

function classOfLowered(node: LiteralNode): ValueClass | undefined {
  switch (node.kind) {
    case "column": case "value": case "param": case "rollup": return node.class;
    case "some": case "every": return "boolean";
    case "count": return "integer";
    case "one": case "first": return classOfLowered(node.value);
    case "call": {
      if (BOOLEAN_FNS.has(node.fn)) return "boolean";
      if (node.fn === "div") return "float";
      if (node.fn === "idiv" || node.fn === "length") return "integer";
      if (node.fn === "cond") return classOfLowered(node.args[1]!) ?? classOfLowered(node.args[2]!);
      const classes = node.args.map(classOfLowered);
      if (node.fn === "coalesce") return classes.find((c) => c !== undefined);
      return classes.includes("float") ? "float" : classes.find((c) => c !== undefined);
    }
  }
}

/** Integer meets float: float (a float column or parameter takes an integer value too). */
function joined(a: ValueClass | undefined, b: ValueClass | undefined): ValueClass | undefined {
  if (a === "float" && b === "integer") return "float";
  if (a === "integer" && b === "float") return "float";
  return a ?? b;
}

function pathText(node: ExprNode): string {
  if (node.kind === "var") return node.name === "self" ? "&" : node.name;
  if (node.kind === "member") {
    const object = pathText(node.object);
    return object === "&" ? `&${node.name}` : `${object}.${node.name}`;
  }
  return "";
}

/** The root name of each helper a subtree calls (`h` for `h.isStaff`). */
function helpersOf(node: ExprNode, into: Set<string>): Set<string> {
  switch (node.kind) {
    case "helper": into.add(node.name.split(".")[0]!); node.args.forEach((arg) => helpersOf(arg, into)); break;
    case "call": node.args.forEach((arg) => helpersOf(arg, into)); break;
    case "member": helpersOf(node.object, into); break;
    case "quantify": helpersOf(node.source, into); helpersOf(node.body, into); break;
  }
  return into;
}

function firstHelper(node: ExprNode): Extract<ExprNode, { kind: "helper" }> | undefined {
  switch (node.kind) {
    case "helper": return node;
    case "call": for (const arg of node.args) { const found = firstHelper(arg); if (found) return found; } return undefined;
    case "member": return firstHelper(node.object);
    case "quantify": return firstHelper(node.source) ?? firstHelper(node.body);
    default: return undefined;
  }
}

/** The lowering of one function: a walk over its tree that records parameters, imports and crossings. */
function lowerer(document: ModelDocument, owner: Entity, options: LowerOptions) {
  const byFile = entitiesByFile(document);
  const params: Lowered["params"] = [];
  const imports: Lowered["imports"] = [];
  const crossings: Lowered["crossings"] = [];
  /** The class the build knows for each parameter's subtree (undefined: `actor.x`, a helper's result, guessed from what it meets). */
  const stated = new Map<number, ValueClass | undefined>();
  const problems: NotSql[] = [];
  const mode = options.mode ?? "read";

  const targetOf = (entity: Entity, relation: Relationship) => byFile.get(resolve(dirname(entity.file), relation.entity.from));
  const keyOf = (entity: Entity) => entity.attributes.find((attribute) => attribute.primaryKey);

  const refuse = (problem: NotSql): never => { throw new Refused(problem); };
  /** Where a problem inside an inlined body is reported: at the read that inlined it. */
  const at = (scope: Scope, position: SourcePosition) => scope.outer?.position ?? position;

  const dependent = (node: ExprNode, rows: ReadonlyMap<string, Row>): boolean => {
    switch (node.kind) {
      case "var": return rows.has(node.name);
      case "member": return dependent(node.object, rows);
      case "call": case "helper": return node.args.some((arg) => dependent(arg, rows));
      case "quantify": {
        if (dependent(node.source, rows)) return true;
        // The element is bound by the quantifier: the body depends on a row only through the names outside it.
        const inner = new Map(rows);
        inner.delete(node.param);
        return dependent(node.body, inner);
      }
      default: return false;
    }
  };

  /** The class the build knows for a record-independent subtree, if any: a literal's, `input.x`'s declared type, a call's result. */
  const staticClass = (node: ExprNode, scope: Scope): ValueClass | undefined => {
    switch (node.kind) {
      case "literal":
        if (typeof node.value === "number") return node.float || !Number.isInteger(node.value) ? "float" : "integer";
        if (typeof node.value === "string") return "string";
        if (typeof node.value === "boolean") return "boolean";
        return undefined;
      case "atom": return "string";
      case "member": {
        if (node.object.kind !== "var" || node.object.name !== "input" || !scope.action) return undefined;
        for (const field of scope.action.input) {
          if (field.kind === "argument" && field.name === node.name) { const c = CLASS[field.type]; return c === "json" ? undefined : c; }
          if (field.kind === "member" && field.ref.name === node.name) {
            const attribute = scope.from.attributes.find((a) => a.name === node.name);
            if (attribute) { const c = CLASS[attribute.type]; return c === "json" ? undefined : c; }
            const relation = scope.from.relationships.find((r) => r.name === node.name && r.keyType);
            if (relation?.keyType) { const c = CLASS[relation.keyType]; return c === "json" ? undefined : c; }
          }
        }
        return undefined;
      }
      case "call": {
        if (node.fn === "now" || node.fn === "today") return "date";
        if (BOOLEAN_FNS.has(node.fn)) return "boolean";
        if (node.fn === "length" || node.fn === "idiv") return "integer";
        if (node.fn === "div") return "float";
        if (node.fn === "cond") return staticClass(node.args[1]!, scope) ?? staticClass(node.args[2]!, scope);
        if (node.fn === "coalesce") return staticClass(node.args[0]!, scope) ?? staticClass(node.args[1]!, scope);
        return node.args.map((arg) => staticClass(arg, scope)).reduce<ValueClass | undefined>((a, b) => joined(a, b), undefined);
      }
      case "quantify": return node.op === "some" || node.op === "every" ? "boolean" : undefined;
      default: return undefined;
    }
  };

  /** A record-independent subtree: a literal is a value, anything else a parameter computed in memory before the query. */
  const independent = (node: ExprNode, scope: Scope, expect: ValueClass | undefined): LiteralNode => {
    const known = staticClass(node, scope);
    const cls = (expect === "integer" && known === "float" ? "float" : expect) ?? known ?? "string";
    if (node.kind === "literal" || node.kind === "atom") return { kind: "value", value: node.value, class: cls };
    if (mode === "write") {
      const helper = firstHelper(node);
      if (helper) refuse({ kind: "write-call", position: at(scope, helper.position), callee: helper.name });
    }
    if (scope.from !== owner)
      for (const name of helpersOf(node, new Set())) {
        const imported = scope.from.imports.find((entry) => entry.helper && entry.identifiers.includes(name));
        if (imported && !imports.some((i) => i.name === name && i.file === scope.from.file)) imports.push({ name, module: imported.from, file: scope.from.file });
      }
    params.push({ tree: node, from: scope.from.fqn });
    stated.set(params.length - 1, known);
    return { kind: "param", index: params.length - 1, class: cls };
  };

  /** A hop from a row of `entity` through `relation` to the rows of `target`. */
  const hopOf = (entity: Entity, relation: Relationship, target: Entity, scope: Scope, position: SourcePosition): Hop<string> => {
    const targetKey = keyOf(target);
    const ownKey = keyOf(entity);
    const broken = () => refuse({ kind: "plain", position: at(scope, position), detail: `${relation.kind} :${relation.name} is not resolved` });
    if (!targetKey || !ownKey) return broken();
    if (relation.kind === "belongs-to") {
      if (!relation.keyColumn) return broken();
      return { table: target.fqn, column: targetKey.name, outer: relation.keyColumn, key: targetKey.name };
    }
    const holder = keyHolderOf(byFile, entity, relation);
    const back = holder?.relationships.find((other) => other.name === relation.inverse);
    if (!holder || !back?.keyColumn) return broken();
    if (!relation.through) return { table: target.fqn, column: back.keyColumn, outer: ownKey.name, key: targetKey.name };
    const exit = holder.relationships.find((other) => other.name === relation.through!.exit);
    if (!exit?.keyColumn) return broken();
    return { table: target.fqn, column: targetKey.name, outer: ownKey.name, key: targetKey.name, through: { table: holder.fqn, entry: back.keyColumn, exit: exit.keyColumn } };
  };

  type End =
    | { mode: "value" }
    /** Under `=== null` / `!== null`: a relationship at the end reads as its key, null when there is no related row. */
    | { mode: "null" }
    /** A has-many at the end: `build` makes the node over its hop (`count`, `some`, ...), at the related rows' depth. */
    | { mode: "list"; build: (hop: Hop<string>, depth: number, target: Entity) => LiteralNode };

  /** `names[i..]` read on a row of `entity` at `depth`. */
  const walk = (depth: number, entity: Entity, names: readonly string[], i: number, end: End, scope: Scope, node: ExprNode, path: string): LiteralNode => {
    const name = names[i]!;
    const last = i === names.length - 1;
    const position = at(scope, node.position);
    const plain = (detail: string) => refuse({ kind: "plain", position, detail });
    const cross = () => {
      const crossing = { position, path: scope.outer?.path ?? path };
      if (!crossings.some((c) => c.path === crossing.path && c.position.offset === position.offset && c.position.file === position.file)) crossings.push(crossing);
    };
    const attribute = entity.attributes.find((a) => a.name === name);
    if (attribute) {
      const cls = CLASS[attribute.type];
      if (cls === "json") return refuse({ kind: "json", position: node.position, member: path, ...(attribute.concept !== undefined ? { concept: attribute.concept } : {}) });
      if (!last || end.mode === "list") return plain(`a member of &${name}, which is not a record`);
      return { kind: "column", depth, name, class: cls };
    }
    const relation = entity.relationships.find((r) => r.name === name);
    if (relation) {
      const target = targetOf(entity, relation);
      if (!target) return plain(`${relation.kind} :${relation.name} is not resolved`);
      const targetKey = keyOf(target);
      if (relation.kind === "has-many") {
        if (!last || end.mode !== "list") return plain(`has-many :${name} read as a value`);
        const hop = hopOf(entity, relation, target, scope, node.position);
        cross();
        return end.build(hop, depth, target);
      }
      if (last) {
        if (end.mode !== "null") return plain(`${relation.kind} :${name} read as a value`);
        if (relation.kind === "belongs-to") {
          const keyType = relation.keyType ?? targetKey?.type ?? "string";
          const cls = CLASS[keyType];
          return { kind: "column", depth, name: relation.keyColumn!, class: cls === "json" ? "string" : cls };
        }
        // A has-one is null when it has no row: its key, read on its one row, is null exactly then.
        const hop = hopOf(entity, relation, target, scope, node.position);
        cross();
        const cls = targetKey ? CLASS[targetKey.type] : "string";
        return { kind: "one", hop, value: { kind: "column", depth: depth + 1, name: hop.key, class: cls === "json" ? "string" : cls } };
      }
      // `&customer.id` reads the stored key, with no subquery (R11).
      if (relation.kind === "belongs-to" && targetKey && names[i + 1] === targetKey.name && i + 1 === names.length - 1 && end.mode !== "list") {
        const cls = CLASS[relation.keyType ?? targetKey.type];
        return { kind: "column", depth, name: relation.keyColumn!, class: cls === "json" ? "string" : cls };
      }
      const hop = hopOf(entity, relation, target, scope, node.position);
      cross();
      return { kind: "one", hop, value: walk(depth + 1, target, names, i + 1, end, scope, node, path) };
    }
    const field = entity.computed.find((c) => c.name === name);
    if (field) {
      if (!last || end.mode === "list") return plain(`a member of computed :${name}, which is not a record`);
      if (field.rollup) {
        cross();
        return rollup(depth, entity, field, scope, node);
      }
      return inline(depth, entity, field.name, scope, node, path);
    }
    // A function of one row (`root`, a rollup's filter) may read a belongs-to's stored key by its column (`line.productId`).
    const keyed = scope.keyed === depth ? entity.relationships.find((r) => r.kind === "belongs-to" && r.keyColumn === name) : undefined;
    if (keyed && last && end.mode !== "list") {
      const target = targetOf(entity, keyed);
      const cls = CLASS[keyed.keyType ?? (target && keyOf(target)?.type) ?? "string"];
      return { kind: "column", depth, name, class: cls === "json" ? "string" : cls };
    }
    return plain(`&${name} is not a member of ${entity.fqn}`);
  };

  /**
   * A rollup read on a row of `entity` at `depth`: one hop per relationship of its path, the value column (the last
   * entity's key for a `count`), and its filter lowered as a condition of its own whose depth 0 is a row of the last
   * entity (its parameters join this function's). The filter's own problems are reported at the filter, so here a filter
   * that has one is `reported`.
   */
  const rollup = (depth: number, entity: Entity, field: Computed, scope: Scope, node: ExprNode): LiteralNode => {
    const position = at(scope, node.position);
    const of = field.rollup!;
    const segments = of.of.split(".").map((segment) => segment.trim());
    const hops: Hop<string>[] = [];
    let current = entity;
    for (const [i, segment] of segments.entries()) {
      const relation = current.relationships.find((r) => r.name === segment);
      if (!relation) {
        if (i === segments.length - 1 && i > 0 && of.fn !== "count") break;
        return refuse({ kind: "plain", position, detail: `rollup :${field.name} reads &${of.of}, which is not resolved` });
      }
      const target = targetOf(current, relation);
      if (!target) return refuse({ kind: "plain", position, detail: `${relation.kind} :${relation.name} is not resolved` });
      hops.push(hopOf(current, relation, target, scope, node.position));
      current = target;
    }
    const value = of.fn === "count" ? keyOf(current)?.name : segments.at(-1)!;
    const cls = CLASS[field.type];
    const stored = value !== undefined && current.attributes.some((attribute) => attribute.name === value);
    if (!stored || cls === "json" || hops.length !== segments.length - (of.fn === "count" ? 0 : 1)) return refuse({ kind: "plain", position, detail: `rollup :${field.name} reads &${of.of}, which is not resolved` });
    const rolled = { kind: "rollup", fn: of.fn, depth, hops, value, class: cls } as const;
    const filter = of.filter;
    if (!filter) return rolled;
    const reported = (): never => refuse({ kind: "reported", position, field: field.name });
    // A filter that reads this rollup again, directly or through another entity, breaks R18 and is reported at the filter
    // (MESH_ROLLUP_FILTER); lowering stops here rather than unfold it forever.
    const key = `${entity.fqn}.${field.name}`;
    if (!filter.tree || options.reported?.(filter) || scope.inlining.includes(key)) return reported();
    // Past the inline limit nothing has reported the filter, so the read is refused here, as inline() refuses a body.
    if (scope.inlining.length >= MAX_INLINE) return refuse({ kind: "self-reaching", position, field: field.name });
    try {
      const where = lower(filter.tree, { rows: new Map([[filter.param, { depth: 0, entity: current }]]), from: entity, action: undefined, outer: undefined, inlining: [...scope.inlining, key], keyed: 0 }, "boolean");
      return { ...rolled, where };
    } catch (cause) {
      if (cause instanceof Refused) return reported();
      throw cause;
    }
  };

  /** A translated computed field's body, lowered with its `self` at `depth`: inlined each time it is read. */
  const inline = (depth: number, entity: Entity, name: string, scope: Scope, node: ExprNode, path: string): LiteralNode => {
    const field = entity.computed.find((c) => c.name === name)!;
    const key = `${entity.fqn}#${name}`;
    const outer = scope.outer ?? { position: node.position, path, field: path };
    if (scope.inlining.includes(key) || scope.inlining.length >= MAX_INLINE) refuse({ kind: "self-reaching", position: outer.position, field: name });
    const body = field.body!;
    if (options.reported?.(body)) refuse({ kind: "reported", position: outer.position, field: name });
    if (!body.tree) {
      const plain = body.plain;
      const through = scope.outer ? scope.outer.field : undefined;
      return refuse({ kind: "plain-computed", position: outer.position, field: through ? `${name} of ${entity.fqn}` : outer.field, detail: plain?.detail ?? "not translated", ...(through ? { through } : {}) });
    }
    return lower(body.tree, { rows: new Map([["self", { depth, entity }]]), from: entity, action: undefined, outer, inlining: [...scope.inlining, key] }, undefined);
  };

  /** A member chain (`&a.b.c`, `x.a`, `&l.find(p)?.m`) read with `end` at its end. */
  const member = (node: ExprNode, scope: Scope, end: End): LiteralNode => {
    const names: string[] = [];
    let root = node;
    while (root.kind === "member") { names.unshift(root.name); root = root.object; }
    if (root.kind === "var") {
      const row = scope.rows.get(root.name);
      if (!row) return refuse({ kind: "plain", position: at(scope, node.position), detail: "a member of a value that is not a record" });
      if (names.length === 0) return refuse({ kind: "plain", position: at(scope, node.position), detail: "a whole record read as a value" });
      return walk(row.depth, row.entity, names, 0, end, scope, node, pathText(node));
    }
    // `&l.find(p)?.m`: `m` of the first related row whose `p` is true, null when there is none.
    if (root.kind === "quantify" && root.op === "find" && names.length > 0 && dependent(root.source, scope.rows)) {
      const find = root;
      return list(find.source, scope, (hop, depth, target) => {
        const inner = withRow(scope, find.param, depth + 1, target);
        return { kind: "first", hop, where: lower(find.body, inner, "boolean"), value: walk(depth + 1, target, names, 0, end, inner, node, pathText(node)) };
      });
    }
    return refuse({ kind: "plain", position: at(scope, node.position), detail: "a member of a value that is not a record" });
  };

  const withRow = (scope: Scope, name: string, depth: number, entity: Entity): Scope => ({ ...scope, rows: new Map([...scope.rows, [name, { depth, entity }]]) });

  /** A has-many of a row, as `build` turns its hop into a node; a list that is not one is refused. */
  const list = (source: ExprNode, scope: Scope, build: (hop: Hop<string>, depth: number, target: Entity) => LiteralNode): LiteralNode => {
    if (source.kind === "member") return member(source, scope, { mode: "list", build });
    return refuse({ kind: "plain", position: at(scope, source.position), detail: "a list that is not a relationship" });
  };

  /** A quantifier over a row's has-many, or a `filter` of one, with its predicate at the related rows' depth. */
  const quantifier = (node: Extract<ExprNode, { kind: "quantify" }>, scope: Scope, use: (hop: Hop<string>, depth: number, where: (inner: (s: Scope) => LiteralNode) => LiteralNode[]) => LiteralNode): LiteralNode => {
    if (!dependent(node.source, scope.rows)) return refuse({ kind: "foreign-list", position: at(scope, node.position), op: node.op });
    // `&l.filter(p).some(q)`: the elements of the filter, then the quantifier's own predicate, on one related row.
    const source = node.source;
    if (source.kind === "quantify" && source.op === "filter") {
      if (!dependent(source.source, scope.rows)) return refuse({ kind: "foreign-list", position: at(scope, source.position), op: source.op });
      return list(source.source, scope, (hop, depth, target) => use(hop, depth, (make) => [
        lower(source.body, withRow(scope, source.param, depth + 1, target), "boolean"),
        make(withRow(scope, node.param, depth + 1, target)),
      ]));
    }
    return list(source, scope, (hop, depth, target) => use(hop, depth, (make) => [make(withRow(scope, node.param, depth + 1, target))]));
  };

  const lower = (node: ExprNode, scope: Scope, expect: ValueClass | undefined): LiteralNode => {
    if (!dependent(node, scope.rows)) return independent(node, scope, expect);
    switch (node.kind) {
      case "var": return refuse({ kind: "plain", position: at(scope, node.position), detail: "a whole record read as a value" });
      case "member": return member(node, scope, { mode: "value" });
      case "helper": return refuse({ kind: "plain", position: at(scope, node.position), detail: `a call to ${node.name}, which is given the record` });
      case "quantify": {
        if (node.op === "some" || node.op === "every") {
          const op = node.op;
          return quantifier(node, scope, (hop, _depth, parts) => {
            const lowered = parts((inner) => lower(node.body, inner, "boolean"));
            const [filter, own] = lowered.length === 2 ? [lowered[0]!, lowered[1]!] : [undefined, lowered[0]!];
            if (!filter) return { kind: op, hop, where: own };
            // Over the elements `filter(p)` keeps: `some` needs both; `every` holds where `p` is not true or `q` is.
            return op === "some"
              ? { kind: "some", hop, where: { kind: "call", fn: "and", args: [filter, own] } }
              : { kind: "every", hop, where: { kind: "call", fn: "or", args: [{ kind: "call", fn: "not", args: [{ kind: "call", fn: "isTrue", args: [filter] }] }, own] } };
          });
        }
        return refuse({ kind: "plain", position: at(scope, node.position), detail: `\`${node.op}\` read as a value` });
      }
      case "call": return call(node, scope, expect);
      default: return refuse({ kind: "plain", position: at(scope, node.position), detail: "a construct that has no SQL form" });
    }
  };

  /** A null test: a relationship or `find(p)` at the end reads as a key, null when there is no related row. */
  const nullTest = (node: ExprNode, scope: Scope): LiteralNode => {
    if (!dependent(node, scope.rows)) return independent(node, scope, undefined);
    if (node.kind === "member") return member(node, scope, { mode: "null" });
    if (node.kind === "quantify" && node.op === "find") {
      if (!dependent(node.source, scope.rows)) return refuse({ kind: "foreign-list", position: at(scope, node.position), op: "find" });
      return list(node.source, scope, (hop, depth, target) => ({
        kind: "first", hop, where: lower(node.body, withRow(scope, node.param, depth + 1, target), "boolean"),
        value: { kind: "column", depth: depth + 1, name: hop.key, class: (() => { const key = target.attributes.find((a) => a.primaryKey); const c = key ? CLASS[key.type] : "string"; return c === "json" ? "string" : c; })() },
      }));
    }
    return lower(node, scope, undefined);
  };

  const call = (node: Extract<ExprNode, { kind: "call" }>, scope: Scope, expect: ValueClass | undefined): LiteralNode => {
    const { fn, args } = node;
    const make = (lowered: LiteralNode[]): LiteralNode => ({ kind: "call", fn: fn as Extract<LiteralNode, { kind: "call" }>["fn"], args: lowered });
    switch (fn) {
      case "and": case "or": case "not": return make(args.map((arg) => lower(arg, scope, "boolean")));
      case "isNull": case "isNotNull": return make([nullTest(args[0]!, scope)]);
      case "length": {
        const arg = args[0]!;
        if (arg.kind === "quantify" && arg.op === "filter") {
          if (!dependent(arg.source, scope.rows)) return refuse({ kind: "foreign-list", position: at(scope, arg.position), op: "filter" });
          return list(arg.source, scope, (hop, depth, target) => ({ kind: "count", hop, where: lower(arg.body, withRow(scope, arg.param, depth + 1, target), "boolean") }));
        }
        if (arg.kind === "member" && isListPath(arg, scope)) return list(arg, scope, (hop) => ({ kind: "count", hop }));
        return make([lower(arg, scope, "string")]);
      }
      case "cond": {
        const test = lower(args[0]!, scope, "boolean");
        const branches = siblings(args.slice(1), scope, expect);
        return make([test, ...branches]);
      }
      case "coalesce": case "eq": case "ne": case "lt": case "lte": case "gt": case "gte":
        return make(siblings(args, scope, fn === "coalesce" ? expect : undefined));
      case "add": case "sub": case "mul": case "div": case "idiv": case "neg": {
        const lowered = siblings(args, scope, undefined, fn === "idiv" ? "integer" : fn === "div" ? "float" : "arithmetic");
        return make(lowered);
      }
      default: return refuse({ kind: "plain", position: at(scope, node.position), detail: `${fn} has no SQL form` });
    }
  };

  /** Does a member chain end in a has-many (so `.length` counts rows)? */
  const isListPath = (node: ExprNode, scope: Scope): boolean => {
    const names: string[] = [];
    let root = node;
    while (root.kind === "member") { names.unshift(root.name); root = root.object; }
    if (root.kind !== "var") return false;
    const row = scope.rows.get(root.name);
    if (!row) return false;
    let entity: Entity | undefined = row.entity;
    for (const [i, name] of names.entries()) {
      const relation: Relationship | undefined = entity?.relationships.find((r) => r.name === name);
      if (!relation) return false;
      if (i === names.length - 1) return relation.kind === "has-many";
      if (relation.kind === "has-many") return false;
      entity = targetOf(entity!, relation);
    }
    return false;
  };

  /**
   * Operands that meet one another: the record-dependent ones first, so a parameter or literal among them takes their
   * class. `numeric`: an arithmetic operand, whose class is integer only when every side is known to be one.
   */
  const siblings = (args: readonly ExprNode[], scope: Scope, expect: ValueClass | undefined, numeric?: "integer" | "float" | "arithmetic"): LiteralNode[] => {
    const fixed = numeric === "integer" || numeric === "float" ? numeric : undefined;
    const classOf = (nodes: readonly (LiteralNode | undefined)[]) => nodes.map((node) => (node ? classOfLowered(node) : undefined)).reduce<ValueClass | undefined>((a, b) => joined(a, b), undefined);
    // A `?:` or `??` takes its class from what it meets: it is lowered after the other record-dependent operands, with
    // their class, so a branch that states none (a helper's result, `actor.x`) is not left to guess.
    const borrows = (arg: ExprNode) => arg.kind === "call" && (arg.fn === "cond" || arg.fn === "coalesce");
    const out: (LiteralNode | undefined)[] = args.map((arg) => (dependent(arg, scope.rows) && !borrows(arg) ? lower(arg, scope, fixed ?? expect) : undefined));
    const lent = args.flatMap((arg, i) => (dependent(arg, scope.rows) && borrows(arg) ? [i] : []));
    if (lent.length) {
      const first = fixed ?? classOf(out) ?? expect ?? independentClass(args, scope);
      const mark = { params: params.length, imports: imports.length, crossings: crossings.length };
      const lend = (cls: ValueClass | undefined) => { for (const i of lent) out[i] = lower(args[i]!, scope, cls); };
      lend(first);
      // Two borrowers meet, or a borrower's branches state no class but its literal's: the class is settled over every
      // operand, a column's or a declared type's over a literal's (the `0` of `x ? actor.y : 0` says nothing of `actor.y`).
      // An integer that only literals state, next to a value of unknown class, is float: an integer value binds to it too.
      const strong = [...out.map((node) => (node ? statedClass(node) : undefined)), ...args.filter((arg) => !dependent(arg, scope.rows) && arg.kind !== "literal").map((arg) => staticClass(arg, scope)), expect]
        .reduce<ValueClass | undefined>((a, b) => joined(a, b), undefined);
      const weak = joined(classOf(out), independentClass(args, scope));
      const guessed = lent.some((i) => unstated(out[i]!));
      const settled = fixed ?? strong ?? (weak === "integer" && guessed ? "float" : weak);
      if (settled !== first) {
        params.length = mark.params; imports.length = mark.imports; crossings.length = mark.crossings;
        for (const key of [...stated.keys()]) if (key >= mark.params) stated.delete(key);
        lend(settled);
      }
    }
    // No record-dependent operand states a class: the record-independent ones may (`cutoff(5) : 0` is an integer).
    const known = classOf(out);
    return args.map((arg, i) => {
      if (out[i]) return out[i]!;
      let cls = known ?? expect ?? independentClass(args, scope);
      if (numeric === "integer" || numeric === "float") cls = numeric;
      else if (numeric === "arithmetic") cls = known === "integer" && staticClass(arg, scope) === "integer" ? "integer" : "float";
      return independent(arg, scope, cls);
    });
  };

  /** The class a lowered operand states from a column or a declared type, not from a literal or a guessed parameter. */
  const statedClass = (node: LiteralNode): ValueClass | undefined => {
    switch (node.kind) {
      case "value": return undefined;
      case "param": return stated.get(node.index);
      case "call": {
        if (BOOLEAN_FNS.has(node.fn) || node.fn === "div" || node.fn === "idiv" || node.fn === "length") return classOfLowered(node);
        const args = node.fn === "cond" ? node.args.slice(1) : node.args;
        return args.map(statedClass).reduce<ValueClass | undefined>((a, b) => joined(a, b), undefined);
      }
      default: return classOfLowered(node);
    }
  };

  /** Does a lowered operand hold a parameter whose class the build does not know? */
  const unstated = (node: LiteralNode): boolean => {
    if (node.kind === "param") return stated.get(node.index) === undefined;
    if (node.kind === "call") return node.args.some(unstated);
    return false;
  };

  /** The class the record-independent operands of a call state between them, if any. */
  const independentClass = (args: readonly ExprNode[], scope: Scope): ValueClass | undefined =>
    args.filter((arg) => !dependent(arg, scope.rows)).map((arg) => staticClass(arg, scope)).reduce<ValueClass | undefined>((a, b) => joined(a, b), undefined);

  return {
    run(tree: ExprNode, scope: Scope, expect: ValueClass | undefined): LowerResult {
      let lowered: LiteralNode | undefined;
      try { lowered = lower(tree, scope, expect); }
      catch (cause) { if (cause instanceof Refused) problems.push(cause.problem); else throw cause; }
      if (problems.length || !lowered) return { ok: false, problems };
      return { ok: true, lowered: { tree: lowered, params, imports, crossings } };
    },
    /** Every problem of a tree, not only the first: each maximal dependent part is tried on its own after a refusal. */
    all(tree: ExprNode, scope: Scope, expect: ValueClass | undefined): LowerResult {
      const first = this.run(tree, scope, expect);
      if (first.ok) return first;
      return { ok: false, problems: collectProblems(tree, scope, expect) };
    },
  };

  /** Each problem a tree holds: lowered part by part (the operands of `&&`, `||`, comparisons), so two problems are both reported. */
  function collectProblems(tree: ExprNode, scope: Scope, expect: ValueClass | undefined): NotSql[] {
    const found: NotSql[] = [];
    const tryPart = (node: ExprNode, cls: ValueClass | undefined) => {
      try { lower(node, scope, cls); }
      catch (cause) {
        if (!(cause instanceof Refused)) throw cause;
        // A refusal inside a call with several record-reading operands: try each, to report all of them.
        if (node.kind === "call" && node.args.filter((arg) => dependent(arg, scope.rows)).length > 1) {
          const before = found.length;
          for (const arg of node.args) if (dependent(arg, scope.rows)) tryPart(arg, undefined);
          if (found.length > before) return;
        }
        if (!found.some((p) => p.kind === cause.problem.kind && p.position.offset === cause.problem.position.offset && p.position.file === cause.problem.position.file)) found.push(cause.problem);
      }
    };
    tryPart(tree, expect);
    return found;
  }
}

function rootScope(document: ModelDocument, entity: Entity, expression: Expression | undefined, options: LowerOptions): Scope {
  const action = expression ? entity.actions.find((a) => a.filter === expression) : undefined;
  return { rows: new Map([[options.root?.param ?? "self", { depth: 0, entity }]]), from: entity, action, inlining: [], ...(options.root ? { keyed: 0 } : {}) };
}

/** One function in a SQL position. Never throws for a model the build accepted. */
export function lowerCondition(document: ModelDocument, entity: Entity, expression: Expression, options: LowerOptions = {}): LowerResult {
  if (!expression.tree) {
    const plain = expression.plain;
    return { ok: false, problems: [{ kind: "plain", position: plain?.position ?? expression.position, detail: plain?.detail ?? "not translated" }] };
  }
  return lowerer(document, entity, options).all(expression.tree, rootScope(document, entity, expression, options), "boolean");
}

/** One declared sort key: an attribute (a column) or a computed field (its lowered body). */
export function lowerSortKey(document: ModelDocument, entity: Entity, key: SortKey, options: Pick<LowerOptions, "reported"> = {}): LowerResult {
  const node: ExprNode = { kind: "member", object: { kind: "var", name: "self", position: key.member.position }, name: key.member.name, optional: false, position: key.member.position };
  return lowerer(document, entity, options).all(node, rootScope(document, entity, undefined, {}), undefined);
}

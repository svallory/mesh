import type { CapabilityManifest } from "./capabilities.ts";
import type { Scalar, Sort, TableHandle } from "./data-layer.ts";
import { FrameworkError } from "./errors.ts";
import { asBool, expr } from "./expr.ts";

/**
 * Translated conditions (M10): the plain-data tree a read hands the data layer as `Query.where` and `Query.order`.
 * The build lowers a translated function in a SQL position (a read's filter, a sort key, a read policy) into a
 * `ConditionLiteral`; at run time `bindCondition` computes its parameters in memory with the emitted form, puts them
 * in, resolves entity names to table handles and folds what no longer depends on a row. The adapter turns the result
 * into SQL (`conditionSql` in `@meshfw/data-drizzle`). A caller never builds one: `Filter` is what crosses the wire.
 */

/** How a value is stored, so an adapter encodes a bound value as the column it meets is encoded. */
export type ValueClass = "string" | "integer" | "float" | "boolean" | "date";

/** The functions a condition calls: the registry's less the record-independent ones, plus two tests. */
export type SqlFunction =
  | "eq" | "ne" | "isNull" | "isNotNull" | "lt" | "lte" | "gt" | "gte"
  | "and" | "or" | "not" | "add" | "sub" | "mul" | "div" | "idiv" | "neg" | "length" | "coalesce" | "cond"
  /** `x IS TRUE` and `x IS FALSE`: two-valued, used by the policy fold. */
  | "isTrue" | "isFalse";

/** How many arguments each function takes; `and` and `or` take two or more. */
export const SQL_FUNCTION_ARITY: Readonly<Record<SqlFunction, number>> = Object.freeze({
  eq: 2, ne: 2, isNull: 1, isNotNull: 1, lt: 2, lte: 2, gt: 2, gte: 2, and: 2, or: 2, not: 1,
  add: 2, sub: 2, mul: 2, div: 2, idiv: 2, neg: 1, length: 1, coalesce: 2, cond: 3, isTrue: 1, isFalse: 1,
});

/**
 * One step from a row to related rows. `T` is the related entity: its FQN in a literal, its table handle once bound.
 * The related rows are those whose `column` equals the `outer` column of the row the hop starts from; with `through`,
 * those whose `column` (their key) is among the link rows' non-null `exit` where the link's `entry` equals `outer`.
 */
export interface Hop<T = TableHandle> {
  readonly table: T;
  readonly column: string;
  readonly outer: string;
  /** The related entity's primary key: `first`, and `one` over a has-one, take the first row in its order. */
  readonly key: string;
  readonly through?: { readonly table: T; readonly entry: string; readonly exit: string };
}

/** `T`: table reference. `P`: what may stand for a value (`never` once bound). */
export type ConditionNode<T = TableHandle, P = never> =
  /** A stored column of the row `depth` hops in: 0 is the row the query returns. */
  | { readonly kind: "column"; readonly depth: number; readonly name: string; readonly class: ValueClass }
  | { readonly kind: "value"; readonly value: Scalar; readonly class: ValueClass }
  | { readonly kind: "call"; readonly fn: SqlFunction; readonly args: readonly ConditionNode<T, P>[] }
  /** A member of the one related row of a belongs-to or has-one: `value` is read on it (depth + 1); null with no row. */
  | { readonly kind: "one"; readonly hop: Hop<T>; readonly value: ConditionNode<T, P> }
  /** `some`: a related row whose `where` is true exists. `every`: no related row whose `where` is not true exists. */
  | { readonly kind: "some" | "every"; readonly hop: Hop<T>; readonly where: ConditionNode<T, P> }
  /** How many related rows there are, or how many have `where` true. */
  | { readonly kind: "count"; readonly hop: Hop<T>; readonly where?: ConditionNode<T, P> }
  /** `value` read on the first related row (in key order) whose `where` is true; null when there is none. */
  | { readonly kind: "first"; readonly hop: Hop<T>; readonly where: ConditionNode<T, P>; readonly value: ConditionNode<T, P> }
  | P;

/** A bound condition: what `Query.where` carries. */
export type Condition = ConditionNode<TableHandle, never>;
/** One order key: what `Query.order` carries. */
export interface OrderKey { readonly by: Condition; readonly desc: boolean }

/** A parameter slot of a literal: the value comes from the literal's `params` function at run time. */
export interface ParamNode {
  readonly kind: "param";
  readonly index: number;
  readonly class: ValueClass;
  /** The parameter's source text (`actor.id`), for messages only. */
  readonly source?: string;
}
export type LiteralNode = ConditionNode<string, ParamNode>;

/** What the build emits for one function in a SQL position (`$conditions` in `<entity>.expressions.ts`). */
export interface ConditionLiteral<S = never> {
  /** For messages: "the filter of read :forCustomer of billing.Invoice". */
  readonly what: string;
  /** The entity whose rows depth 0 reads (an FQN). */
  readonly entity: string;
  readonly tree: LiteralNode;
  /** The record-independent parts, evaluated in memory with the emitted in-memory form, in `index` order. */
  readonly params: (scope: S) => readonly unknown[];
}

/** A bound literal: a condition, or the constant it folded to (`null` is unknown). Three-valued on purpose. */
export type Bound = Condition | true | false | null;
/** What a read hands the data layer: `true` no condition, `false` no row (no query), else a condition. */
export type Where = Condition | boolean;
/** Resolves a hop's entity FQN to its table handle. */
export type TableOf = (fqn: string) => TableHandle;
/** Runs a function inside a frame mark. */
export type Mark = <T>(run: () => T) => T;

type Value = Extract<Condition, { kind: "value" }>;

const HOP_KINDS = new Set(["one", "some", "every", "count", "first"]);
const CLASSES = new Set<string>(["string", "integer", "float", "boolean", "date"]);

/** The value as a message names it: "the number 2.5", "a string", "an object". */
function described(value: unknown): string {
  if (typeof value === "number") return `the number ${String(value)}`;
  if (typeof value === "string") return `the string ${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `the boolean ${String(value)}`;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "a Date that is not valid" : "a Date";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "function") return "a function";
  if (typeof value === "bigint") return "a bigint";
  return typeof value === "object" ? "an object" : typeof value;
}

/** Whether `value` may be bound where a `cls` value is stored: `null` always may. */
function fits(value: unknown, cls: ValueClass): boolean {
  if (value === null) return true;
  switch (cls) {
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "float": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "date": return value instanceof Date && !Number.isNaN(value.getTime());
  }
}

function classOf(cls: unknown, what: string): ValueClass {
  if (typeof cls !== "string" || !CLASSES.has(cls)) throw new FrameworkError(`${what} has a node of unknown class ${JSON.stringify(cls)}`);
  return cls as ValueClass;
}

function value(v: Scalar, cls: ValueClass): Value {
  return { kind: "value", value: v, class: cls };
}

function isValue(part: Condition): part is Value {
  return part.kind === "value";
}

/** The class of a folded result: what the value is, else (null) what its operands were. */
function resultClass(fn: SqlFunction, result: unknown, args: readonly Value[]): ValueClass {
  if (["eq", "ne", "isNull", "isNotNull", "lt", "lte", "gt", "gte", "and", "or", "not", "isTrue", "isFalse"].includes(fn)) return "boolean";
  if (fn === "length") return "integer";
  if (fn === "div") return "float";
  if (typeof result === "boolean") return "boolean";
  if (result instanceof Date) return "date";
  if (typeof result === "string") return "string";
  const operands = fn === "cond" ? args.slice(1) : args;
  if (operands.some((a) => a.class === "float")) return "float";
  if (typeof result === "number") return Number.isInteger(result) ? "integer" : "float";
  return operands.find((a) => a.value !== null)?.class ?? operands[0]?.class ?? "integer";
}

/** A call whose operands are all values, answered by the in-memory function (so a folded part answers as memory does). */
function evaluate(fn: SqlFunction, args: readonly Value[]): Value {
  const v = args.map((a) => a.value);
  let result: unknown;
  switch (fn) {
    case "isNull": result = expr.isNull(v[0]); break;
    case "isNotNull": result = expr.isNotNull(v[0]); break;
    case "and": result = v.reduce<unknown>((acc, x) => expr.and(acc, () => x), true); break;
    case "or": result = v.reduce<unknown>((acc, x) => expr.or(acc, () => x), false); break;
    case "not": result = expr.not(v[0]); break;
    case "neg": result = expr.neg(v[0]); break;
    case "length": result = expr.length(v[0]); break;
    case "coalesce": result = expr.coalesce(v[0], () => v[1]); break;
    case "cond": result = expr.cond(v[0], () => v[1], () => v[2]); break;
    case "isTrue": result = asBool(v[0]) === true; break;
    case "isFalse": result = asBool(v[0]) === false; break;
    default: result = (expr[fn] as (a: unknown, b: unknown) => unknown)(v[0], v[1]);
  }
  return value((result ?? null) as Scalar, resultClass(fn, result, args));
}

/**
 * A call after its operands were bound: evaluated when every operand is a value, simplified by the Kleene tables
 * when some are (`false AND x` is false, `true AND x` is x, `null AND x` stays), else kept.
 */
function fold(fn: SqlFunction, args: readonly Condition[]): Condition {
  if (args.every(isValue)) return evaluate(fn, args);
  if (fn === "and" || fn === "or") {
    const absorbing = fn === "and" ? false : true;
    const kept: Condition[] = [];
    for (const arg of args) {
      if (isValue(arg)) {
        const b = asBool(arg.value);
        if (b === absorbing) return value(absorbing, "boolean");
        if (b === !absorbing) continue;
      }
      kept.push(arg);
    }
    if (kept.length === 0) return value(!absorbing, "boolean");
    return kept.length === 1 ? kept[0]! : { kind: "call", fn, args: kept };
  }
  if (fn === "cond" && isValue(args[0]!)) return asBool(args[0].value) === true ? args[1]! : args[2]!;
  if (fn === "coalesce" && isValue(args[0]!)) return args[0].value === null ? args[1]! : args[0];
  return { kind: "call", fn, args };
}

/**
 * Compute the literal's parameters on `scope` (inside `mark` when given: the authorizer passes
 * `(run) => frame.marked("policy :<name> of <entity>", run)`), turn `undefined` into `null`, check each value against
 * its class (a value the database would convert is refused, so SQL never answers differently from memory), put the
 * values in, resolve every hop's FQN through `tableOf`, and fold every foldable subtree with the in-memory functions of
 * `expr`. Foldable: reads no `column` and contains no hop node (`one`, `some`, `every`, `count`, `first`), since those
 * depend on rows even when their `where` or `value` reads no column. Returns the constant when the whole tree folds to
 * a boolean or to unknown (`null`); a tree that folds to another constant (an order key) is a `value` node.
 */
export function bindCondition<S>(tableOf: TableOf, literal: ConditionLiteral<S>, scope: S, mark?: Mark): Bound {
  const what = literal.what;
  const compute = () => literal.params(scope);
  const raw = mark ? mark(compute) : compute();
  if (!Array.isArray(raw)) throw new FrameworkError(`${what}: its parameters must be a list, not ${described(raw)}`);
  const params = raw.map((v) => (v === undefined ? null : v));

  const checked = (v: unknown, cls: ValueClass, source: string, side: Side): Value => {
    if (!fits(v, cls)) {
      const refused = "the database would convert it, so Mesh refuses it";
      if (side?.column) throw new FrameworkError(`${what} compares ${side.column} (${cls}) with ${described(v)} from ${source}: ${refused}`);
      const a = `a${cls === "integer" ? "n" : ""} ${cls}`;
      throw new FrameworkError(`${what} needs ${a}${side ? ` for ${side.position}` : ""} and got ${described(v)} from ${source}: ${refused}`);
    }
    return value(v as Scalar, cls);
  };
  const hop = (h: Hop<string>): Hop<TableHandle> => ({
    table: tableOf(h.table), column: h.column, outer: h.outer, key: h.key,
    ...(h.through ? { through: { table: tableOf(h.through.table), entry: h.through.entry, exit: h.through.exit } } : {}),
  });
  const bind = (part: LiteralNode, depth: number, side?: Side): Condition => {
    if (depth > 256) throw new FrameworkError(`${what} is nested more than 256 levels deep`);
    if (typeof part !== "object" || part === null) throw new FrameworkError(`${what} has a node that is not an object`);
    switch (part.kind) {
      case "column": return { kind: "column", depth: part.depth, name: part.name, class: classOf(part.class, what) };
      case "value": return checked(part.value, classOf(part.class, what), "a literal value", side);
      case "param": {
        if (!Number.isInteger(part.index) || part.index < 0 || part.index >= params.length) {
          throw new FrameworkError(`${what} reads parameter ${String(part.index)}, and its parameters are ${params.length}`);
        }
        return checked(params[part.index], classOf(part.class, what), part.source ?? `parameter ${part.index}`, side);
      }
      case "call": {
        const arity = Object.hasOwn(SQL_FUNCTION_ARITY, part.fn) ? SQL_FUNCTION_ARITY[part.fn] : undefined;
        if (arity === undefined) throw new FrameworkError(`${what} calls ${JSON.stringify(part.fn)}, which is no SQL function`);
        const many = part.fn === "and" || part.fn === "or";
        if (!Array.isArray(part.args) || (many ? part.args.length < 2 : part.args.length !== arity)) {
          throw new FrameworkError(`${what} calls ${part.fn} with ${Array.isArray(part.args) ? part.args.length : "no"} arguments`);
        }
        return fold(part.fn, part.args.map((a, i) => bind(a, depth + 1, sideOf(part.fn, part.args, i))));
      }
      case "one": return { kind: "one", hop: hop(part.hop), value: bind(part.value, depth + 1) };
      case "some":
      case "every": return { kind: part.kind, hop: hop(part.hop), where: bind(part.where, depth + 1) };
      case "count": return part.where === undefined
        ? { kind: "count", hop: hop(part.hop) }
        : { kind: "count", hop: hop(part.hop), where: bind(part.where, depth + 1) };
      case "first": return { kind: "first", hop: hop(part.hop), where: bind(part.where, depth + 1), value: bind(part.value, depth + 1) };
      default: throw new FrameworkError(`${what} has a node of unknown kind ${JSON.stringify((part as { kind?: unknown }).kind)}`);
    }
  };
  const bound = bind(literal.tree, 0);
  if (isValue(bound) && (bound.value === null || typeof bound.value === "boolean")) return bound.value;
  return bound;
}

/** What a value meets, for the class-check message (design 6.3): the column side it is compared with, else its place. */
type Side = { readonly column?: string; readonly position: string } | undefined;

/** The stored side of an expression, as the message names it: `the column s`, `length of the column s`. */
function columnSide(node: LiteralNode): string | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  switch (node.kind) {
    case "column": return `the column ${node.name}`;
    case "call": {
      for (const arg of Array.isArray(node.args) ? node.args : []) {
        const inner = columnSide(arg);
        if (inner !== undefined) return `${node.fn} of ${inner}`;
      }
      return undefined;
    }
    case "one":
    case "first": { const inner = columnSide(node.value); return inner && `${inner} of a related row`; }
    case "count": return "the count of related rows";
    default: return undefined;
  }
}

/** Argument `i` of `fn` meets the other arguments it is compared or combined with: not a logic operand or a `cond` test. */
function sideOf(fn: SqlFunction, args: readonly LiteralNode[], i: number): Side {
  const position = `argument ${i + 1} of ${fn}`;
  if (fn === "and" || fn === "or" || fn === "not" || (fn === "cond" && i === 0)) return { position };
  const others = fn === "cond" ? args.filter((_, j) => j !== 0 && j !== i) : args.filter((_, j) => j !== i);
  for (const other of others) {
    const column = columnSide(other);
    if (column !== undefined) return { column, position };
  }
  return { position };
}

/** `a AND b AND ...` for a WHERE: any `false` or `null` part is `false` (a WHERE keeps only true rows), `true` parts drop out. */
export function allOf(parts: readonly Bound[]): Where {
  const kept: Condition[] = [];
  for (const part of parts) {
    if (part === false || part === null) return false;
    if (part !== true) kept.push(part);
  }
  if (kept.length === 0) return true;
  return kept.length === 1 ? kept[0]! : { kind: "call", fn: "and", args: kept };
}

/** Whether a condition crosses a relationship somewhere. */
export function hasHop(part: Condition): boolean {
  if (HOP_KINDS.has(part.kind)) return true;
  return part.kind === "call" && part.args.some(hasHop);
}

/**
 * What a read passes as `Query.where`: `undefined` for `true`, else the condition. `false` is refused for every layer:
 * it means no row, so the caller returns no row without running the query (design 3.1) and never calls this. A condition
 * goes only to a layer whose capability manifest declares `conditions`, and one that crosses a relationship only to a
 * layer that also declares `joins`: an adapter that does not honour `where` would return rows a policy denies. The
 * build refuses both first; this is the defence behind it.
 */
export function whereFor(layer: object, where: Where): Condition | undefined {
  if (where === true) return undefined;
  if (where === false) {
    throw new FrameworkError("A read whose condition is false returns no row without running the query; whereFor was handed false, so the caller ran it");
  }
  const condition: Condition = where;
  const manifest = (layer as { capabilities?: CapabilityManifest }).capabilities;
  const declared: readonly string[] = Array.isArray(manifest?.capabilities) ? manifest.capabilities : [];
  const adapter = typeof manifest?.adapter === "string" ? `the data adapter "${manifest.adapter}"` : "the data layer, which has no capability manifest,";
  if (!declared.includes("conditions")) {
    throw new FrameworkError(`A read runs a condition as SQL, and ${adapter} does not declare the conditions capability, so it would ignore it: use a data adapter that declares conditions`);
  }
  if (hasHop(condition) && !declared.includes("joins")) {
    throw new FrameworkError(`A read's condition crosses a relationship, which runs as a subquery, and ${adapter} does not declare the joins capability: use a data adapter that declares joins`);
  }
  return condition;
}

/** A declared key: a stored column, or a computed field's literal. */
export type DeclaredKey<S> = { readonly column: string; readonly class: ValueClass; readonly desc: boolean }
  | { readonly literal: ConditionLiteral<S>; readonly desc: boolean };

/**
 * The caller's `sort` and the read's declared keys as one order: the caller's keys first, then the declared keys (the
 * adapter adds the primary key last), or undefined when there is neither. `classes` gives the class of each attribute
 * a caller may sort by; a caller key outside it is refused. A declared column the caller already sorts by is not
 * repeated, and a declared computed key that folds to a constant orders nothing and is left out.
 */
export function orderOf<S>(tableOf: TableOf, callerSort: Sort | undefined, classes: Readonly<Record<string, ValueClass>>, declared: readonly DeclaredKey<S>[], scope: S): readonly OrderKey[] | undefined {
  if (callerSort !== undefined && (!Array.isArray(callerSort) || callerSort.some((field) => typeof field !== "string"))) {
    throw new FrameworkError('sort must be a list of attribute names, "-name" for descending');
  }
  const order: OrderKey[] = [];
  const sorted = new Set<string>();
  for (const field of callerSort ?? []) {
    const desc = field.startsWith("-");
    const name = desc ? field.slice(1) : field;
    if (name === "") throw new FrameworkError('A sort field needs a name: "title" or "-title"');
    if (!Object.hasOwn(classes, name)) throw new FrameworkError(`Cannot sort by "${name}": it is not an attribute a caller may sort by`);
    sorted.add(name);
    order.push({ by: { kind: "column", depth: 0, name, class: classes[name]! }, desc });
  }
  for (const key of declared) {
    if ("column" in key) {
      if (sorted.has(key.column)) continue;
      sorted.add(key.column);
      order.push({ by: { kind: "column", depth: 0, name: key.column, class: key.class }, desc: key.desc });
    } else {
      const by = bindCondition(tableOf, key.literal, scope);
      if (by === true || by === false || by === null || by.kind === "value") continue;
      order.push({ by, desc: key.desc });
    }
  }
  return order.length === 0 ? undefined : order;
}


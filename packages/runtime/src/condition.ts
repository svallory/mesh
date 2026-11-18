import type { CapabilityManifest } from "./capabilities.ts";
import type { RollupFn, Scalar, Sort, TableHandle } from "./data-layer.ts";
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
  /**
   * A rollup read where SQL is required (`&lineCount > 0`, `sort desc &total`): `fn` over the column `value` of the rows
   * of the last hop's table that `hops` reach from the row `depth` hops in (0: the row the query returns), each row once
   * however many paths reach it, and a hop that matches nothing (a null or dangling key) adding nothing. `count` counts
   * `value`, the last table's key, and is 0 over no row; the others are null over no row or only null values. `where` is
   * the rollup's filter: a condition of its own whose depth 0 is a row of the last table. `class` is the rollup's. It
   * gives the value a load through `Mesh.privileged` gives: no read policy of the entities the hops reach runs.
   */
  | { readonly kind: "rollup"; readonly fn: RollupFn; readonly depth: number; readonly hops: readonly Hop<T>[]; readonly value: string; readonly class: ValueClass; readonly where?: ConditionNode<T, P> }
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

const HOP_KINDS = new Set(["one", "some", "every", "count", "first", "rollup"]);
const ROLLUP_FNS = new Set<string>(["count", "sum", "avg", "min", "max"]);
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
 * `bindCondition`'s refusal of a parameter value its column or position cannot hold without a conversion (a number
 * compared with a text column, a list, an object). A `FrameworkError`, so a read that binds a caller's filter or a
 * policy's condition fails as before; a guarded write catches it and takes its read path, where the check runs in memory.
 */
export class UnfitParameterError extends FrameworkError {}

/**
 * Compute the literal's parameters on `scope` (inside `mark` when given: the authorizer passes
 * `(run) => frame.marked("policy :<name> of <entity>", run)`), turn `undefined` into `null`, check each value against
 * its class (a value the database would convert is refused, so SQL never answers differently from memory), put the
 * values in, resolve every hop's FQN through `tableOf`, and fold every foldable subtree with the in-memory functions of
 * `expr`. Foldable: reads no `column` and contains no hop node (`one`, `some`, `every`, `count`, `first`, `rollup`), since those
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
      if (side?.column) throw new UnfitParameterError(`${what} compares ${side.column} (${cls}) with ${described(v)} from ${source}: ${refused}`);
      const a = `a${cls === "integer" ? "n" : ""} ${cls}`;
      throw new UnfitParameterError(`${what} needs ${a}${side ? ` for ${side.position}` : ""} and got ${described(v)} from ${source}: ${refused}`);
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
      case "rollup": {
        if (typeof part.fn !== "string" || !ROLLUP_FNS.has(part.fn)) throw new FrameworkError(`${what} has a rollup of unknown function ${JSON.stringify(part.fn)}`);
        if (!Array.isArray(part.hops) || part.hops.length === 0) throw new FrameworkError(`${what} has a rollup with no hops`);
        const rollup = { kind: "rollup", fn: part.fn, depth: part.depth, hops: part.hops.map(hop), value: part.value, class: classOf(part.class, what) } as const;
        return part.where === undefined ? rollup : { ...rollup, where: bind(part.where, depth + 1) };
      }
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
function columnSide(literal: LiteralNode): string | undefined {
  if (typeof literal !== "object" || literal === null) return undefined;
  switch (literal.kind) {
    case "column": return `the column ${literal.name}`;
    case "call": {
      for (const arg of Array.isArray(literal.args) ? literal.args : []) {
        const inner = columnSide(arg);
        if (inner !== undefined) return `${literal.fn} of ${inner}`;
      }
      return undefined;
    }
    case "one":
    case "first": { const inner = columnSide(literal.value); return inner && `${inner} of a related row`; }
    case "count": return "the count of related rows";
    case "rollup": return `the ${literal.fn} rollup of related rows`;
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
 * a caller may sort by, and `computed` the literal of each computed field a caller may sort by (`callerQuery`); a caller
 * key in neither is refused. A declared column the caller already sorts by is not repeated, and a computed key (the
 * caller's or a declared one) that folds to a constant orders nothing and is left out.
 */
export function orderOf<S>(
  tableOf: TableOf, callerSort: Sort | undefined, classes: Readonly<Record<string, ValueClass>>, declared: readonly DeclaredKey<S>[], scope: S,
  computed: Readonly<Record<string, ConditionLiteral<S>>> = {},
): readonly OrderKey[] | undefined {
  if (callerSort !== undefined && (!Array.isArray(callerSort) || callerSort.some((field) => typeof field !== "string"))) {
    throw new FrameworkError('sort must be a list of attribute names, "-name" for descending');
  }
  const order: OrderKey[] = [];
  const sorted = new Set<string>();
  for (const field of callerSort ?? []) {
    const desc = field.startsWith("-");
    const name = desc ? field.slice(1) : field;
    if (name === "") throw new FrameworkError('A sort field needs a name: "title" or "-title"');
    if (Object.hasOwn(computed, name)) {
      const by = bindCondition(tableOf, computed[name]!, scope);
      if (!(by === true || by === false || by === null || by.kind === "value")) order.push({ by, desc });
      continue;
    }
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


/**
 * What a caller's `filter` and `sort` may do with one computed field of the entity a read returns (the generated
 * `$callerComputed`): a translated field gives its class and its condition literal, read only when a read runs (the
 * actions file and the expressions file import each other); `"plain"` is a field Mesh runs in memory and `"rollup"` a
 * rollup, which a caller cannot name: what a caller loads of a rollup counts only the rows the read policies admit, which
 * a query does not.
 */
export type CallerComputed = "plain" | "rollup" | { readonly class: ValueClass; readonly literal: () => ConditionLiteral<never> };

/** What `callerQuery` needs to translate a computed field: given by a read of an entity with a translated computed field. */
export interface CallerSql<S> {
  readonly tableOf: TableOf;
  /** The read's scope, on which each literal's parameters are computed. */
  readonly scope: S;
  /** The class of each stored column a caller may filter and sort by. */
  readonly classes: Readonly<Record<string, ValueClass>>;
  /** The data layer: a computed field the caller names runs as SQL only on one that declares `conditions` (and `joins`). */
  readonly layer: object;
  /** The read's declared sort keys, which follow the caller's (`orderOf`). */
  readonly declared?: readonly DeclaredKey<S>[];
}

/** A caller's query as the data layer takes it: `filter` and `sort`, or `where` and `order` where a computed field is named. */
export interface CallerQuery<F> {
  /** The filter left to the data layer: the caller's, less every computed field given as `undefined`; none once moved to `where`. */
  readonly filter: F | undefined;
  /** The caller's filter as a condition when it compares a translated computed field, else `true`. */
  readonly where: Bound;
  readonly sort?: Sort | undefined;
  /** With `CallerSql`: the order when the read declares a sort or the caller sorts by a computed field (`sort` is then absent). */
  readonly order?: readonly OrderKey[] | undefined;
}

const FILTER_OPERATORS = ["eq", "ne", "lt", "lte", "gt", "gte", "in", "nil"] as const;

/**
 * A read's caller `filter` and `sort` (M10, ruling D32 O6 (a)). A computed field Mesh translates may be named in both: a
 * filter that compares one becomes, as a whole, a condition (`where`), the field's body inlined in place of its name and
 * the stored columns beside it read as columns, with the comparisons the data layer gives a `Filter` (`eq` or `ne` null
 * is the null test, `in` one of the values, `nil` the null test, an unknown comparison leaves the row out); a sort key
 * that names one is an order key of its body. A computed field Mesh runs in memory, or a rollup, fails with a
 * `FrameworkError` before the database is touched, so a wrong result is never returned.
 *
 * The returned `filter` is the caller's less every computed field whose comparison is `undefined`, at any depth under
 * `and` and `or`: a generated filter type writes one as `toString?: $Comparison<string> | undefined`, and a filter
 * literal leaves out one named like a member of the Object interface (`toString`, `valueOf`) only by giving it as
 * `undefined`. The data layer has no column for it, so it never sees it. A stored column given as `undefined` stays:
 * the data layer leaves it out (`Filter`). A filter with nothing to take out is returned as it is.
 */
export function callerQuery<F, S>(
  entity: string, computed: Readonly<Record<string, CallerComputed>>, query: { readonly filter?: F | undefined; readonly sort?: unknown }, sql?: CallerSql<S>,
): CallerQuery<F> {
  const kind = (name: string): CallerComputed | undefined => (Object.hasOwn(computed, name) ? computed[name] : undefined);
  const refuse = (name: string, what: "filter" | "sort", field: CallerComputed) => {
    if (field === "rollup") {
      throw new FrameworkError(`A ${what} by ${entity}#${name} is not available: ${name} is a rollup, which a caller's filter and sort cannot name; a read's own filter= and sort can`);
    }
    if (field === "plain") throw new FrameworkError(`A ${what} by ${entity}#${name} is not available: ${name} is a computed field Mesh runs in memory`);
    // The build passes the read's SQL options whenever a field translates, so this is a framework fault, not the caller's.
    if (!sql) throw new FrameworkError(`callerQuery needs the read's SQL options to translate ${entity}#${name}`);
  };
  let translated = false;
  const clean = (filter: unknown): unknown => {
    if (filter === null || typeof filter !== "object" || Array.isArray(filter)) return filter;
    const kept: [string, unknown][] = [];
    let changed = false;
    for (const [key, value] of Object.entries(filter)) {
      const field = kind(key);
      if ((key === "and" || key === "or") && Array.isArray(value)) {
        const items = value.map(clean);
        const inner = items.some((item, index) => item !== value[index]);
        changed ||= inner;
        kept.push([key, inner ? items : value]);
      } else if (field !== undefined) {
        if (value === undefined) changed = true;
        else {
          refuse(key, "filter", field);
          translated = true;
          kept.push([key, value]);
        }
      } else kept.push([key, value]);
    }
    return changed ? Object.fromEntries(kept) : filter;
  };
  const filter = clean(query.filter) as F | undefined;
  const sort = query.sort;
  let sortsComputed = false;
  if (Array.isArray(sort))
    for (const key of sort) {
      const name = typeof key === "string" && key.startsWith("-") ? key.slice(1) : key;
      const field = typeof name === "string" ? kind(name) : undefined;
      if (field === undefined) continue;
      refuse(name as string, "sort", field);
      sortsComputed = true;
    }
  if (!sql) return { filter, where: true, sort: sort as Sort | undefined };

  // Each translated field's literal, bound once per call on the read's scope.
  const bound = new Map<string, Condition>();
  const literals: Record<string, ConditionLiteral<S>> = {};
  for (const [name, field] of Object.entries(computed)) if (typeof field === "object") literals[name] = field.literal() as ConditionLiteral<S>;
  const body = (name: string, cls: ValueClass): Condition => {
    let left = bound.get(name);
    if (!left) {
      const result = bindCondition(sql.tableOf, literals[name]!, sql.scope);
      left = result === true || result === false || result === null ? value(result, result === null ? cls : "boolean") : result;
      bound.set(name, left);
    }
    return left;
  };
  const where = translated ? filterWhere(filter, (name) => {
    const field = kind(name);
    if (typeof field === "object") return { left: body(name, field.class), cls: field.class };
    if (Object.hasOwn(sql.classes, name)) return { left: { kind: "column", depth: 0, name, class: sql.classes[name]! }, cls: sql.classes[name]! };
    return undefined;
  }) : true;
  // A condition that folded to false or unknown runs no query (`allOf`); one that did not runs only where the layer can run it.
  if (where !== true && where !== false && where !== null) whereFor(sql.layer, where);
  if (!sortsComputed && !sql.declared?.length) return { filter: translated ? undefined : filter, where, sort: sort as Sort | undefined };
  const order = orderOf(sql.tableOf, sort as Sort | undefined, sql.classes, sql.declared ?? [], sql.scope, literals);
  // An order key that is not a stored column of the row runs as SQL, so the layer must declare what it needs.
  for (const key of order ?? []) if (key.by.kind !== "column") whereFor(sql.layer, key.by);
  return { filter: translated ? undefined : filter, where, order };
}

/**
 * A caller's `Filter` as a condition: `read` gives the condition and class of each name (a translated computed field's body,
 * or a stored column), and undefined for a name the entity has no column for. Checked as the data layer checks a
 * `Filter`, with the same messages.
 */
function filterWhere(filter: unknown, read: (name: string) => { left: Condition; cls: ValueClass } | undefined): Bound {
  const scalarOf = (v: unknown, at: string): Scalar => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
    throw new FrameworkError(`${at} must be a string, finite number, boolean, valid Date or null, not ${v === undefined ? "undefined" : String(v)}`);
  };
  const operand = (v: Exclude<Scalar, null>, cls: ValueClass, name: string, at: string): Value => {
    // A fraction compared with an integer is compared as a number, as SQL compares it.
    const as: ValueClass = cls === "integer" && typeof v === "number" && !Number.isInteger(v) ? "float" : cls;
    if (!fits(v, as)) throw new FrameworkError(`${at} compares ${name} (${cls}) with ${described(v)}: the database would convert it, so Mesh refuses it`);
    return value(v, as);
  };
  const comparison = (left: Condition, cls: ValueClass, name: string, spec: unknown): Condition => {
    if (typeof spec !== "object" || spec === null || Array.isArray(spec) || spec instanceof Date) {
      throw new FrameworkError(`Filter on "${name}" must be an object such as { eq: value }, not a bare value`);
    }
    const given = Object.keys(spec);
    if (given.length === 0) throw new FrameworkError(`Filter on "${name}" has no operator; use one of ${FILTER_OPERATORS.join(", ")}`);
    const parts: Condition[] = [];
    const op = spec as Record<string, unknown>;
    for (const key of given) {
      if (!(FILTER_OPERATORS as readonly string[]).includes(key)) {
        throw new FrameworkError(`Unknown filter operator "${key}" on "${name}"; use one of ${FILTER_OPERATORS.join(", ")}`);
      }
      const v = op[key];
      const at = `Filter ${name}.${key}`;
      if (key === "nil") {
        if (typeof v !== "boolean") throw new FrameworkError(`${at} must be true or false`);
        parts.push(fold(v ? "isNull" : "isNotNull", [left]));
      } else if (key === "in") {
        if (!Array.isArray(v)) throw new FrameworkError(`${at} must be a list`);
        const items = v.map((item) => scalarOf(item, `${at} item`));
        if (items.includes(null)) throw new FrameworkError(`${at} must not contain null; combine it with nil: true under or`);
        const eqs = items.map((item) => fold("eq", [left, operand(item as Exclude<Scalar, null>, cls, name, `${at} item`)]));
        parts.push(eqs.length === 0 ? value(false, "boolean") : eqs.length === 1 ? eqs[0]! : fold("or", eqs));
      } else {
        const given = scalarOf(v, at);
        if (given === null) {
          if (key === "eq") parts.push(fold("isNull", [left]));
          else if (key === "ne") parts.push(fold("isNotNull", [left]));
          else throw new FrameworkError(`${at} cannot compare with null; use nil`);
        } else parts.push(fold(key as SqlFunction, [left, operand(given, cls, name, at)]));
      }
    }
    return parts.length === 1 ? parts[0]! : fold("and", parts);
  };
  const walk = (part: unknown, depth: number): Condition => {
    if (typeof part !== "object" || part === null || Array.isArray(part)) throw new FrameworkError("A filter must be an object such as { title: { eq: 'x' } }");
    if (depth > 64) throw new FrameworkError("Filter is nested more than 64 levels deep");
    const parts: Condition[] = [];
    for (const [key, spec] of Object.entries(part)) {
      if (key === "and" || key === "or") {
        if (!Array.isArray(spec)) throw new FrameworkError(`Filter "${key}" must be a list of filters`);
        const inner = spec.map((item) => walk(item, depth + 1));
        parts.push(inner.length === 0 ? value(key === "and", "boolean") : inner.length === 1 ? inner[0]! : fold(key, inner));
      } else {
        const column = read(key);
        if (!column) throw new FrameworkError(`Unknown column "${key}"; use an attribute in the emitted table`);
        if (spec !== undefined) parts.push(comparison(column.left, column.cls, key, spec));
      }
    }
    return parts.length === 0 ? value(true, "boolean") : parts.length === 1 ? parts[0]! : fold("and", parts);
  };
  const condition = walk(filter, 0);
  if (isValue(condition) && (condition.value === null || typeof condition.value === "boolean")) return condition.value;
  return condition;
}

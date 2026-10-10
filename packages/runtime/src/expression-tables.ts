/**
 * The written definition of every registered function and operator (ADR-0012, option A).
 * One row is one call: `args` in, `result` out, `null` for NULL or unknown. The in-memory
 * form must give each answer; the M10 SQL evaluator, and every SQL adapter, must give the
 * same. Dates are `Date` instants. A function with no row here is not registered.
 */
export interface TableCase {
  args: readonly unknown[];
  result: unknown;
  /** For `now` and `today`: the clock's instant in milliseconds. */
  clock?: number;
  note?: string;
}

const D = (ms: number) => new Date(ms);
const T = true, F = false, N = null;
/** `rows(f, [[a, b, result], ...])` */
const rows = (list: readonly (readonly [unknown, unknown, unknown])[]): TableCase[] =>
  list.map(([a, b, result]) => ({ args: [a, b], result }));

const EQ: (readonly [unknown, unknown, unknown, unknown])[] = [
  [1, 1, T, F], [1, 2, F, T], [0, -0, T, F], [1, N, N, N], [N, 1, N, N], [N, N, N, N],
  ["a", "a", T, F], ["a", "A", F, T], ["", N, N, N], ["a", "a ", F, T],
  [T, T, T, F], [T, F, F, T], [F, N, N, N],
  ["open", "open", T, F], ["open", "done", F, T], ["open", N, N, N],
  [D(5), D(5), T, F], [D(5), D(6), F, T], [D(5), N, N, N],
];
const ORDER: (readonly [unknown, unknown, unknown, unknown, unknown, unknown])[] = [
  [1, 2, T, T, F, F], [2, 2, F, T, F, T], [3, 2, F, F, T, T], [-1, 0, T, T, F, F],
  [1, N, N, N, N, N], [N, 1, N, N, N, N], [N, N, N, N, N, N],
  [D(5), D(6), T, T, F, F], [D(6), D(6), F, T, F, T], [D(6), N, N, N, N, N],
];
const KLEENE: (readonly [unknown, unknown, unknown, unknown])[] = [
  [T, T, T, T], [T, F, F, T], [T, N, N, T], [F, T, F, T], [F, F, F, F], [F, N, F, N], [N, T, N, T], [N, F, F, N], [N, N, N, N],
];

export const EXPRESSION_TABLES: Readonly<Record<string, readonly TableCase[]>> = Object.freeze({
  eq: EQ.map(([a, b, r]) => ({ args: [a, b], result: r })),
  ne: EQ.map(([a, b, , r]) => ({ args: [a, b], result: r })),
  isNull: [[N, T], [0, F], ["", F], [F, F], [D(0), F], ["open", F]].map(([a, r]) => ({ args: [a], result: r })),
  isNotNull: [[N, F], [0, T], ["", T], [F, T], [D(0), T], ["open", T]].map(([a, r]) => ({ args: [a], result: r })),
  lt: ORDER.map(([a, b, r]) => ({ args: [a, b], result: r })),
  lte: ORDER.map(([a, b, , r]) => ({ args: [a, b], result: r })),
  gt: ORDER.map(([a, b, , , r]) => ({ args: [a, b], result: r })),
  gte: ORDER.map(([a, b, , , , r]) => ({ args: [a, b], result: r })),
  and: KLEENE.map(([a, b, r]) => ({ args: [a, b], result: r })),
  or: KLEENE.map(([a, b, , r]) => ({ args: [a, b], result: r })),
  not: [[T, F], [F, T], [N, N]].map(([a, r]) => ({ args: [a], result: r })),
  add: rows([[1, 2, 3], [0.5, 0.25, 0.75], [-1, 1, 0], [1, N, N], [N, N, N]]),
  sub: rows([[5, 3, 2], [3, 5, -2], [N, 3, N]]),
  mul: rows([[4, 2.5, 10], [0, N, N]]),
  div: rows([[7, 2, 3.5], [1, 0, N], [0, 0, N], [N, 2, N], [2, N, N]]),
  neg: [[3, -3], [0, 0], [N, N]].map(([a, r]) => ({ args: [a], result: r })),
  length: [
    ["", 0], ["abc", 3], ["é", 1], ["é", 2], ["\u{1F600}", 1], [N, N], [[], 0], [[{}, {}], 2],
  ].map(([a, r]) => ({ args: [a], result: r })),
  now: [{ args: [], clock: 1_700_000_123_456, result: D(1_700_000_123_456) }],
  today: [{ args: [], clock: 1_700_000_123_456, result: D(1_699_920_000_000) }],
  coalesce: rows([[1, 2, 1], [N, 2, 2], [N, N, N], [0, 5, 0], ["", "x", ""], [F, T, F], [N, F, F], [D(1), D(2), D(1)]]),
  cond: ([[T, 1, 2, 1], [F, 1, 2, 2], [N, 1, 2, 2], [T, N, 2, N], [F, 1, N, N]] as const).map(([c, a, b, r]) => ({ args: [c, a, b], result: r })),
});

/**
 * Quantifier rows. `outcomes` is the predicate's result for each element, in order
 * (`true`, `false`, `null` for unknown); the element list is `[0, 1, 2, ...]`, so
 * `find` returns an index and `filter` a list of indexes.
 */
export interface QuantifierCase { outcomes: readonly (boolean | null)[]; result: unknown }
export const QUANTIFIER_TABLES: Readonly<Record<"some" | "every" | "find" | "filter", readonly QuantifierCase[]>> = Object.freeze({
  some: [
    { outcomes: [], result: F }, { outcomes: [T, F], result: T }, { outcomes: [F, F], result: F },
    { outcomes: [N, F], result: F }, { outcomes: [N, T], result: T },
  ],
  every: [
    { outcomes: [], result: T }, { outcomes: [T, T], result: T }, { outcomes: [T, F], result: F },
    { outcomes: [T, N], result: F }, { outcomes: [N], result: F },
  ],
  find: [
    { outcomes: [], result: N }, { outcomes: [F, T, T], result: 1 }, { outcomes: [N, F], result: N },
  ],
  filter: [
    { outcomes: [T, F, N, T], result: [0, 3] }, { outcomes: [], result: [] },
  ],
});

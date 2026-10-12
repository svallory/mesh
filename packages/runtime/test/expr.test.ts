import { describe, expect, test } from "bun:test";
import { FrameworkError, expr, scope } from "../src/index.ts";
const { holds } = expr;
import { EXPRESSION_TABLES, QUANTIFIER_TABLES } from "../src/testing.ts";

const call = (fn: string, args: readonly unknown[], clock?: number) => {
  const f = (expr as Record<string, (...a: unknown[]) => unknown>)[fn]!;
  if (fn === "now" || fn === "today") return f(scope({}, { clock: () => new Date(clock!) }));
  return f(...args);
};

describe("EXPRESSION_TABLES, run against the in-memory functions", () => {
  for (const [fn, cases] of Object.entries(EXPRESSION_TABLES))
    test(`${fn}: ${cases.length} cases`, () => {
      expect(cases.length).toBeGreaterThan(0);
      for (const c of cases) expect(call(fn, c.args, c.clock)).toEqual(c.result);
    });
  test("every table name is an exported function", () => {
    for (const fn of Object.keys(EXPRESSION_TABLES)) expect(typeof (expr as Record<string, unknown>)[fn]).toBe("function");
  });
});

describe("quantifier tables", () => {
  for (const [op, cases] of Object.entries(QUANTIFIER_TABLES))
    test(op, () => {
      for (const c of cases) {
        const items = c.outcomes.map((_, i) => i);
        const f = (expr as unknown as Record<string, (l: number[], p: (i: number) => unknown) => unknown>)[op]!;
        expect(f(items, (i) => c.outcomes[i])).toEqual(c.result);
      }
    });
  test("an unloaded list throws, a null list is unknown", () => {
    for (const op of ["some", "every", "find", "filter", "length"] as const) {
      expect(() => (expr as any)[op](undefined, () => true)).toThrow(FrameworkError);
    }
    expect(expr.some(null, () => true)).toBeNull();
  });
});

describe("scope and clock", () => {
  test("now() is read once per scope", () => {
    let t = 1000;
    const s = scope({}, { clock: () => new Date(t++) });
    expect(expr.now(s).getTime()).toBe(1000);
    expect(expr.now(s).getTime()).toBe(1000);
    expect(expr.now(scope({}, { clock: () => new Date(t++) })).getTime()).toBe(1001);
  });
  test("undefined reads as null", () => {
    expect(expr.eq(undefined, 1)).toBeNull();
    expect(expr.isNull(undefined)).toBe(true);
    expect(expr.coalesce(undefined, 3)).toBe(3);
  });
});

describe("backstop and holds", () => {
  test("a non-boolean operand of a boolean function throws", () => {
    expect(() => expr.and(1, true)).toThrow(FrameworkError);
    expect(() => expr.not("x")).toThrow(FrameworkError);
    expect(() => expr.or(true, "x")).toThrow(FrameworkError);
    expect(() => expr.cond(1, 1, 2)).toThrow(FrameworkError);
    expect(() => expr.asBool(3)).toThrow(FrameworkError);
  });
  test("only true holds", () => {
    expect([true, false, null, undefined, 1].map(holds)).toEqual([true, false, false, false, false]);
  });
  test("the guard idiom works under eager evaluation", () => {
    for (const [x, want] of [[null, false], [2, true]] as const)
      expect(expr.and(expr.isNotNull(x), expr.gt(x, 1))).toBe(want);
  });
});

describe("pure: an imported helper a translated expression calls must return a value, not a promise (EXP-03)", () => {
  test("a value passes through unchanged, null and functions included", () => {
    const f = () => 1;
    for (const v of [true, 0, "", null, undefined, { then: 1 }, f]) expect(expr.pure(v, "h")).toBe(v);
  });
  test("a promise or a thenable throws a FrameworkError naming the helper and saying to await it in an async arrow", async () => {
    let rejected = false;
    const failing = Promise.reject(new Error("the helper's own failure"));
    const thenable = { then: (_: unknown, onRejected: () => void) => { rejected = true; onRejected(); } };
    for (const [value, name] of [[Promise.resolve(true), "isOwner"], [failing, "vaguely"], [thenable, "custom"]] as const) {
      let thrown: unknown;
      try { expr.pure(value as unknown, name); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(FrameworkError);
      expect((thrown as Error).message).toBe(`expression helper ${name}() returned a promise: a translated expression calls an imported function synchronously. Await it inside an async arrow (\`async (...) => ... await ${name}(...)\`), which makes the function plain code`);
    }
    // The promise's own rejection is handled, so it is not reported as unhandled on top of the FrameworkError.
    expect(rejected).toBe(true);
    await Promise.resolve();
  });
  test("the type checker refuses a promise where the helper's type says it returns one", () => {
    const typed = async (): Promise<boolean> => true;
    // @ts-expect-error a helper typed to return a promise is refused at build time
    expect(() => expr.pure(typed(), "typed")).toThrow(FrameworkError);
    const loose = typed() as unknown;
    expect(() => expr.pure(loose, "loose")).toThrow(FrameworkError);
  });
});

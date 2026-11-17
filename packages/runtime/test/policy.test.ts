import { describe, expect, test } from "bun:test";
import { Answer, answeringLayer } from "../src/answer.ts";
import { and, not, or } from "../src/expr.ts";
import { authorizer, ForbiddenError, FrameworkError, Mesh, type Condition, type ConditionLiteral, type DataLayer, type PolicySpec, type TableOf, type Where } from "@meshfw/runtime";

/** A layer outside any transaction: `before` and `filter` then reject at once. */
const layer = { refuseIfFailed: () => false } as unknown as DataLayer;
type Check = PolicySpec["checks"][number];
const check = (kind: Check["kind"], value: unknown, record = false): Check => ({ kind, check: `${kind} ${String(value)}`, record, run: () => value });
const allow = (value: unknown, record = false) => check("authorize-if", value, record);
const forbid = (value: unknown, record = false) => check("forbid-if", value, record);
const policy = (name: string, checks: Check[], when: PolicySpec["when"] = null): PolicySpec => ({ name, when, checks });
const when = (value: unknown, record = false): PolicySpec["when"] => ({ check: `when ${String(value)}`, record, run: () => value });

/** The decision for a write: the pre-check, then the checks inside the transaction. */
async function decide(policies: PolicySpec[]): Promise<ForbiddenError | "allowed"> {
  const auth = authorizer("Post", "publish", policies);
  try {
    await auth.before(layer, {});
    await auth.inside({});
    return "allowed";
  } catch (error) {
    if (error instanceof ForbiddenError) return error;
    throw error;
  }
}

describe("policies combine without order", () => {
  test("no policy: forbidden, and the error shows an open policy", async () => {
    const error = await decide([]);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).policies).toEqual([]);
    expect((error as ForbiddenError).message).toContain("policy :open actions=[&publish] authorize-if=() => true");
  });

  const cases: [string, Check[], boolean][] = [
    ["one authorize-if that holds", [allow(true)], true],
    ["one authorize-if that fails", [allow(false)], false],
    ["an unknown authorize-if does not authorize", [allow(null)], false],
    ["a non-boolean from plain code is unknown", [allow(1)], false],
    ["any authorize-if that holds is enough", [allow(false), allow(true)], true],
    ["only a forbid-if that does not hold: passes", [forbid(false)], true],
    ["a forbid-if that holds forbids", [forbid(true)], false],
    ["an unknown forbid-if forbids", [forbid(null)], false],
    ["a forbid-if that holds beats an authorize-if that holds", [allow(true), forbid(true)], false],
    ["authorize-if holds and forbid-if does not", [allow(true), forbid(false)], true],
  ];
  for (const [name, checks, allowed] of cases)
    test(name, async () => {
      const result = await decide([policy("p", checks)]);
      expect(result === "allowed").toBe(allowed);
      // Moving a check changes no decision.
      const reversed = await decide([policy("p", [...checks].reverse())]);
      expect(reversed === "allowed").toBe(allowed);
    });

  test("every covering policy must pass, in any order, and the error names each that failed", async () => {
    const policies = [policy("a", [allow(true)]), policy("b", [allow(false)]), policy("c", [forbid(true)])];
    for (const order of [policies, [...policies].reverse(), [policies[1]!, policies[0]!, policies[2]!]]) {
      const error = (await decide(order)) as ForbiddenError;
      expect(error).toBeInstanceOf(ForbiddenError);
      expect([...error.policies].sort()).toEqual(["b", "c"]);
    }
    expect(await decide([policy("a", [allow(true)]), policy("b", [forbid(false)])])).toBe("allowed");
  });

  test("a policy with no check fails, so a policy object the compiler did not build opens nothing", async () => {
    for (const policies of [[policy("p", [])], [policy("p", [], when(true))], [policy("p", []), policy("q", [allow(true)])]]) {
      const error = (await decide(policies)) as ForbiddenError;
      expect(error).toBeInstanceOf(ForbiddenError);
      expect(error.policies).toEqual(["p"]);
      expect(error.reason).toBe("failed");
    }
    expect(await authorizer("Post", "read", [policy("p", [])]).filter(layer, {})).toBe(false);
    expect(await authorizer("Post", "read", [policy("p", [])]).admits({})).toBe(false);
    // Its `when` false, it does not apply, and another policy decides.
    expect(await decide([policy("p", [], when(false)), policy("q", [allow(true)])])).toBe("allowed");
  });

  test("a policy whose when is false does not apply; with none applying, a write is forbidden, naming them, with no open policy to copy", async () => {
    expect(await decide([policy("a", [allow(false)], when(false)), policy("b", [allow(true)])])).toBe("allowed");
    const error = (await decide([policy("a", [allow(true)], when(false)), policy("b", [forbid(false)], when(false))])) as ForbiddenError;
    expect(error).toMatchObject({ policies: ["a", "b"], reason: "not-applied" });
    expect(error.message).toBe("Post#publish is forbidden: policies :a, :b cover it, but the `when` of each was false for this call, so none applies, and a call no policy applies to is denied");
    expect(error.message).not.toContain("policy :open");
    expect(error.breakdown).toEqual([
      { policy: "a", kind: "when", check: "when false", result: false, decisive: true },
      { policy: "b", kind: "when", check: "when false", result: false, decisive: true },
    ]);
    // The answer is the same when it is known only inside the transaction (a `when` that reads the record).
    const inside = (await decide([policy("a", [allow(true)], when(false, true))])) as ForbiddenError;
    expect(inside).toMatchObject({ policies: ["a"], reason: "not-applied" });
  });

  test("no policy covers the action: the reason is not-covered and the message shows an open policy", async () => {
    const error = (await decide([])) as ForbiddenError;
    expect(error.reason).toBe("not-covered");
    expect(new ForbiddenError({ entity: "Post", action: "publish", policies: ["owner"], breakdown: [] }).reason).toBe("failed");
  });

  test("an unknown when fails its policy", async () => {
    const error = (await decide([policy("a", [allow(true)], when(null))])) as ForbiddenError;
    expect(error.policies).toEqual(["a"]);
    expect(error.breakdown).toEqual([
      { policy: "a", kind: "when", check: "when null", result: null, decisive: true },
      { policy: "a", kind: "authorize-if", check: "authorize-if true", result: true, decisive: false },
    ]);
  });
});

describe("where the checks run", () => {
  test("an actor-only denial is decided before the transaction: the record checks never run", async () => {
    const ran: string[] = [];
    const record: Check = { kind: "authorize-if", check: "record", record: true, run: () => { ran.push("record"); return true; } };
    const auth = authorizer("Post", "publish", [policy("a", [forbid(true)]), policy("b", [record])]);
    await expect(auth.before(layer, {})).rejects.toBeInstanceOf(ForbiddenError);
    expect(ran).toEqual([]);
  });

  test("a policy decided by an actor-only authorize-if still waits for its record-reading forbid-if", async () => {
    const auth = authorizer("Post", "publish", [policy("a", [allow(true), forbid(true, true)])]);
    await auth.before(layer, {});
    await expect(auth.inside({})).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("every actor-only authorize-if failed: denied before the transaction, whatever the record checks would say", async () => {
    const auth = authorizer("Post", "publish", [policy("a", [allow(false), forbid(false, true)])]);
    await expect(auth.before(layer, {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("an actor-only check runs once, before the transaction, and not again inside it", async () => {
    let calls = 0;
    const counted: Check = { kind: "authorize-if", check: "counted", record: false, run: () => { calls += 1; return true; } };
    const auth = authorizer("Post", "publish", [policy("a", [counted, forbid(false, true)])]);
    await auth.before(layer, {});
    await auth.inside({});
    expect(calls).toBe(1);
  });

  test("the scope reaches the check, and an async check is awaited", async () => {
    const seen: unknown[] = [];
    const async: Check = { kind: "authorize-if", check: "async", record: true, run: async (scope) => { seen.push(scope); return true; } };
    const auth = authorizer("Post", "publish", [policy("a", [async])]);
    await auth.before(layer, { phase: "before" });
    await auth.inside({ phase: "inside" });
    expect(seen).toEqual([{ phase: "inside" }]);
  });

  test("a check that throws fails the call as a denial does: inside a running transaction it fails that transaction (N4)", async () => {
    const failed: unknown[] = [];
    const joined = {
      refuseIfFailed: () => true,
      transaction: (fn: () => Promise<unknown>) => fn().catch((cause) => { failed.push(cause); throw cause; }),
    } as unknown as DataLayer;
    const boom: Check = { kind: "authorize-if", check: "boom", record: false, run: () => { throw new TypeError("boom"); } };
    await expect(authorizer("Post", "publish", [policy("a", [boom])]).before(joined, {})).rejects.toThrow("boom");
    expect(failed[0]).toBeInstanceOf(TypeError);
    await expect(authorizer("Post", "read", [policy("a", [boom])]).filter(joined, {})).rejects.toThrow("boom");
    expect(failed[1]).toBeInstanceOf(TypeError);
    // Outside a transaction it rejects the call.
    await expect(authorizer("Post", "publish", [policy("a", [boom])]).before(layer, {})).rejects.toThrow("boom");
    expect(failed).toHaveLength(2);
  });

  test("inside a running transaction, a denial before the transaction fails that transaction", async () => {
    const failed: unknown[] = [];
    const joined = {
      refuseIfFailed: () => true,
      transaction: (fn: () => Promise<unknown>) => fn().catch((cause) => { failed.push(cause); throw cause; }),
    } as unknown as DataLayer;
    await expect(authorizer("Post", "publish", [policy("a", [allow(false)])]).before(joined, {})).rejects.toBeInstanceOf(ForbiddenError);
    expect(failed[0]).toBeInstanceOf(ForbiddenError);
  });
});

describe("the breakdown", () => {
  test("is plain data: per policy, per check, the result and whether it decided", async () => {
    const error = (await decide([
      policy("owner", [allow(false), allow(null)]),
      policy("open", [allow(true)]),
      policy("paid", [forbid(true), forbid(false)]),
    ])) as ForbiddenError;
    expect(error.policies).toEqual(["owner", "paid"]);
    expect(error.breakdown).toEqual([
      { policy: "owner", kind: "authorize-if", check: "authorize-if false", result: false, decisive: true },
      { policy: "owner", kind: "authorize-if", check: "authorize-if null", result: null, decisive: true },
      { policy: "open", kind: "authorize-if", check: "authorize-if true", result: true, decisive: false },
      { policy: "paid", kind: "forbid-if", check: "forbid-if true", result: true, decisive: true },
      { policy: "paid", kind: "forbid-if", check: "forbid-if false", result: false, decisive: false },
    ]);
    expect(JSON.parse(JSON.stringify(error.breakdown))).toEqual(error.breakdown);
    expect(error.message).toBe("Post#publish is forbidden by policies :owner, :paid");
  });
});

describe("a read's policies are a filter", () => {
  test("covering policies that pass: true; one that fails: false, never an error", async () => {
    expect(await authorizer("Post", "read", [policy("a", [allow(true)])]).filter(layer, {})).toBe(true);
    expect(await authorizer("Post", "read", [policy("a", [allow(false)])]).filter(layer, {})).toBe(false);
    expect(await authorizer("Post", "read", [policy("a", [forbid(null)])]).filter(layer, {})).toBe(false);
  });

  test("a read no policy covers is forbidden; one whose covering policies all have a false when gives no rows (S1)", async () => {
    await expect(authorizer("Post", "read", []).filter(layer, {})).rejects.toMatchObject({ reason: "not-covered" });
    expect(await authorizer("Post", "read", [policy("a", [allow(true)], when(false))]).filter(layer, {})).toBe(false);
    // The three callers of the review's table: when true and the check false, when unknown, when false: no rows, each.
    for (const w of [when(true), when(null), when(false)])
      expect(await authorizer("Post", "read", [policy("members", [allow(false)], w)]).filter(layer, {})).toBe(false);
  });

  test("a load's policies: admitted or not, never an error; none covering admits no one", async () => {
    expect(await authorizer("Comment", "read", [policy("a", [allow(true)])]).admits({})).toBe(true);
    expect(await authorizer("Comment", "read", [policy("a", [allow(false)])]).admits({})).toBe(false);
    expect(await authorizer("Comment", "read", [policy("a", [allow(true)], when(false))]).admits({})).toBe(false);
    expect(await authorizer("Comment", "read", []).admits({})).toBe(false);
  });

  test("filter and admits decide the whole read: a check that reads the record is rows' and admitsRows', never theirs", async () => {
    const auth = () => authorizer("Post", "read", [policy("public", [allow(true, true)])]);
    await expect(auth().filter(layer, {})).rejects.toThrow(FrameworkError);
    await expect(auth().filter(layer, {})).rejects.toThrow(/policy :public reads the record, so it is a condition on each row of the query and is folded into it by rows/);
    await expect(auth().admits({})).rejects.toThrow(/folded into it by rows \(a load: admitsRows\)/);
  });
});

// ---- M10: a read policy that reads the record is a condition on each row ---------------------------------------------

/** A function's value on each row: a column `c<n>` the row holds, so a condition built from it is evaluated per row. */
const column = (n: number) => ({ kind: "column", depth: 0, name: `c${n}`, class: "boolean" }) as const;
const literal = (tree: ConditionLiteral["tree"], params: (scope: never) => readonly unknown[] = () => []): () => ConditionLiteral<never> =>
  () => ({ what: "a test condition", entity: "Post", tree, params });
const tableOf: TableOf = (fqn) => ({ fqn });

/** A condition evaluated on a row as SQL would (Kleene), for the functions the fold builds. */
function evaluate(node: Condition, row: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case "column": return row[node.name] ?? null;
    case "value": return node.value;
    case "call": {
      const arg = (i: number) => evaluate(node.args[i]!, row);
      switch (node.fn) {
        case "isTrue": return arg(0) === true;
        case "isFalse": return arg(0) === false;
        case "not": return not(arg(0));
        case "and": return node.args.reduce<unknown>((acc, a) => and(acc, () => evaluate(a, row)), true);
        case "or": return node.args.reduce<unknown>((acc, a) => or(acc, () => evaluate(a, row)), false);
        default: throw new Error(`no ${node.fn} here`);
      }
    }
    default: throw new Error(`no ${node.kind} here`);
  }
}
const admitsRow = (where: Where, row: Readonly<Record<string, unknown>>) => (typeof where === "boolean" ? where : evaluate(where, row) === true);

/**
 * One function of a generated case: its value (true, false, unknown) and how it runs. `memory` runs in memory;
 * `constant` reads the record and binds to its value; `row` reads the record and stays a condition, true, false or unknown per row.
 */
type How = "memory" | "constant" | "row";
interface Fn { value: boolean | null; how: How }
interface Shape { when?: Fn; authorize: Fn[]; forbid: Fn[] }

/** The same policies twice: as the read would run them (`rows`), and with every function run in memory (`admits`), plus the row. */
function build(shapes: readonly Shape[]): { folded: PolicySpec[]; memory: PolicySpec[]; row: Record<string, unknown> } {
  let n = 0;
  const row: Record<string, unknown> = {};
  const folded: PolicySpec[] = [];
  const memory: PolicySpec[] = [];
  const spec = (fn: Fn) => {
    const at = n++;
    const run = () => fn.value;
    if (fn.how === "memory") return { folded: { record: false, run, check: `f${at}` }, memory: { record: false, run, check: `f${at}` } };
    row[`c${at}`] = fn.value;
    const tree = fn.how === "constant" ? { kind: "value" as const, value: fn.value, class: "boolean" as const } : column(at);
    return { folded: { record: true, run: () => { throw new Error("folded, never run"); }, check: `f${at}`, sql: literal(tree) }, memory: { record: false, run, check: `f${at}` } };
  };
  shapes.forEach((shape, p) => {
    const w = shape.when ? spec(shape.when) : undefined;
    const checks = [...shape.authorize.map((fn) => ["authorize-if", spec(fn)] as const), ...shape.forbid.map((fn) => ["forbid-if", spec(fn)] as const)];
    folded.push({ name: `p${p}`, when: w ? w.folded : null, checks: checks.map(([kind, s]) => ({ kind, ...s.folded })) });
    memory.push({ name: `p${p}`, when: w ? w.memory : null, checks: checks.map(([kind, s]) => ({ kind, ...s.memory })) });
  });
  return { folded, memory, row };
}

/** A small seeded generator (mulberry32), so a failing case is the same on every run. */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VALUES = [true, false, null] as const;
const HOWS: readonly How[] = ["memory", "constant", "row"];

async function agrees(shapes: readonly Shape[]): Promise<string | undefined> {
  const { folded, memory, row } = build(shapes);
  const expected = await authorizer("Post", "read", memory).admits({});
  const where = await authorizer("Post", "read", folded).rows(layer, {}, tableOf);
  const loaded = await authorizer("Post", "read", folded).admitsRows({}, tableOf);
  if (admitsRow(where, row) !== expected || admitsRow(loaded, row) !== expected) return JSON.stringify(shapes);
  return undefined;
}

describe("rows and admitsRows give, on each row, the decision the checks give in memory", () => {
  test("every two-policy case with an optional when, authorize-if and forbid-if, each true, false or unknown, run every way", async () => {
    const one: (Fn | undefined)[] = [undefined, ...VALUES.flatMap((value) => HOWS.map((how) => ({ value, how })))];
    const random = seeded(7);
    const pick = () => one[1 + Math.floor(random() * (one.length - 1))]!;
    const shapes: Shape[] = [];
    // A policy: its when, one authorize-if, one forbid-if, each absent or present; at least one check (none is a build error).
    for (const w of [false, true]) for (const a of [false, true]) for (const f of [false, true]) {
      if (!a && !f) continue;
      shapes.push({ ...(w ? { when: { value: null, how: "memory" } } : {}), authorize: a ? [{ value: null, how: "memory" }] : [], forbid: f ? [{ value: null, how: "memory" }] : [] });
    }
    const failures: string[] = [];
    let cases = 0;
    // Every value of every function, the way each runs drawn at random: 3,600 value combinations of two policies.
    const valued = (shape: Shape, values: readonly (boolean | null)[]): Shape => {
      let i = 0;
      const fn = (): Fn => ({ value: values[i++]!, how: pick().how });
      return { ...(shape.when ? { when: fn() } : {}), authorize: shape.authorize.map(fn), forbid: shape.forbid.map(fn) };
    };
    const combos = (k: number): (boolean | null)[][] => (k === 0 ? [[]] : combos(k - 1).flatMap((rest) => VALUES.map((v) => [v, ...rest])));
    const all = shapes.flatMap((shape) => combos((shape.when ? 1 : 0) + shape.authorize.length + shape.forbid.length).map((values) => ({ shape, values })));
    for (const first of all)
      for (const second of all) {
        cases++;
        const failed = await agrees([valued(first.shape, first.values), valued(second.shape, second.values)]);
        if (failed) failures.push(failed);
      }
    expect(cases).toBe(3600);
    expect(failures.slice(0, 3)).toEqual([]);
  });

  test("a seeded sample of one to three policies with zero to two authorize-if and forbid-if each", async () => {
    const random = seeded(2026);
    const fn = (): Fn => ({ value: VALUES[Math.floor(random() * 3)]!, how: HOWS[Math.floor(random() * 3)]! });
    const failures: string[] = [];
    for (let i = 0; i < 20000; i++) {
      const shapes: Shape[] = Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
        const authorize = Array.from({ length: Math.floor(random() * 3) }, fn);
        const forbid = Array.from({ length: authorize.length ? Math.floor(random() * 3) : 1 + Math.floor(random() * 2) }, fn);
        return { ...(random() < 0.5 ? { when: fn() } : {}), authorize, forbid };
      });
      const failed = await agrees(shapes);
      if (failed) failures.push(failed);
    }
    expect(failures.slice(0, 3)).toEqual([]);
  });

  test("a forbid-if that folds to unknown forbids, and a when that folds to unknown fails its policy, beside a second policy", async () => {
    const unknownForbid = await authorizer("Post", "read", [
      policy("a", [allow(true), { ...forbid(null, true), sql: literal({ kind: "value", value: null, class: "boolean" }) }]),
      policy("b", [allow(true)]),
    ]).rows(layer, {}, tableOf);
    expect(unknownForbid).toBe(false);
    const unknownWhen = await authorizer("Post", "read", [
      policy("a", [allow(true)], { ...when(null, true)!, sql: literal({ kind: "value", value: null, class: "boolean" }) }),
      policy("b", [allow(true)]),
    ]).rows(layer, {}, tableOf);
    expect(unknownWhen).toBe(false);
  });

  test("the formula over conditions: one authorize-if is `c IS TRUE`; constants drop out", async () => {
    const where = await authorizer("Post", "read", [policy("a", [allow(true), { ...allow(null, true), sql: literal(column(0)) }]), policy("b", [allow(true)])]).rows(layer, {}, tableOf);
    expect(where).toBe(true);
    const only = await authorizer("Post", "read", [policy("a", [{ ...allow(null, true), sql: literal(column(0)) }]), policy("b", [allow(true)])]).rows(layer, {}, tableOf);
    expect(only).toEqual({ kind: "call", fn: "isTrue", args: [column(0)] });
  });

  test("no covering policy: rows is forbidden, admitsRows admits nothing", async () => {
    await expect(authorizer("Post", "read", []).rows(layer, {}, tableOf)).rejects.toMatchObject({ reason: "not-covered" });
    expect(await authorizer("Post", "read", []).admitsRows({}, tableOf)).toBe(false);
  });

  test("a caller the checks in memory already deny gets false, and nothing is bound", async () => {
    let bound = 0;
    const counted = { ...allow(null, true), sql: () => { bound++; return literal(column(0))(); } };
    expect(await authorizer("Post", "read", [policy("a", [counted]), policy("b", [allow(false)])]).rows(layer, {}, tableOf)).toBe(false);
    expect(await authorizer("Post", "read", [policy("a", [counted], when(false))]).rows(layer, {}, tableOf)).toBe(false);
    expect(await authorizer("Post", "read", [policy("a", [counted]), policy("b", [allow(false)])]).admitsRows({}, tableOf)).toBe(false);
    expect(bound).toBe(0);
    // A policy whose when is false is skipped: its checks are not bound, and the other decides.
    expect(await authorizer("Post", "read", [policy("a", [counted], when(false)), policy("b", [allow(true)])]).rows(layer, {}, tableOf)).toBe(true);
    expect(bound).toBe(0);
  });

  test("the parameters are computed with the scope, marked with the frame, and hops resolve through tableOf", async () => {
    const marks: string[] = [];
    const frame = { marked: <T>(what: string, fn: () => T): T => (marks.push(what), fn()) };
    const sql = () => ({
      what: "policy :owner authorize-if of blog.Post", entity: "blog.Post",
      tree: { kind: "call" as const, fn: "eq" as const, args: [
        { kind: "one" as const, hop: { table: "blog.Blog", column: "id", outer: "blogId", key: "id" }, value: { kind: "column" as const, depth: 1, name: "ownerId", class: "string" as const } },
        { kind: "param" as const, index: 0, class: "string" as const }] },
      params: (s: { actor: { id: string } }) => [s.actor.id],
    }) as unknown as ConditionLiteral<never>;
    const where = await authorizer("blog.Post", "read", [policy("owner", [{ ...allow(null, true), sql }])], frame).rows(layer, { actor: { id: "u1" } }, (fqn) => ({ table: fqn }));
    expect(where).toEqual({ kind: "call", fn: "isTrue", args: [{ kind: "call", fn: "eq", args: [
      { kind: "one", hop: { table: { table: "blog.Blog" }, column: "id", outer: "blogId", key: "id" }, value: { kind: "column", depth: 1, name: "ownerId", class: "string" } },
      { kind: "value", value: "u1", class: "string" }] }] });
    expect(marks).toEqual(["policy :owner of blog.Post"]);
  });

  test("a parameter's helper that makes a privileged read throws the error naming the policy, and rows rejects with it", async () => {
    const frame = { marked: <T>(what: string, fn: () => T): T => { void what; return fn(); } };
    const sql = literal(column(0), () => Mesh.privileged({} as never) as never);
    await expect(authorizer("blog.Post", "read", [policy("owner", [{ ...allow(null, true), sql }])], frame).rows(layer, {}, tableOf)).rejects.toThrow(FrameworkError);
    // A value of the wrong class is refused the same way.
    const wrong = literal({ kind: "call", fn: "eq", args: [{ kind: "column", depth: 0, name: "n", class: "integer" }, { kind: "param", index: 0, class: "integer" }] }, () => ["1"]);
    await expect(authorizer("blog.Post", "read", [policy("owner", [{ ...allow(null, true), sql: wrong }])]).rows(layer, {}, tableOf))
      .rejects.toThrow(/the database would convert it, so Mesh refuses it/);
  });

  test("answering for Mesh.checkPolicies: a check that reads the record does not deny the call and is not in the breakdown", async () => {
    const base = { refuseIfFailed: () => false, transaction: (fn: () => Promise<unknown>) => fn() } as unknown as DataLayer;
    const asking = answeringLayer(base);
    const decision = async (policies: PolicySpec[]) => {
      try { await authorizer("Todo", "pending", policies).rows(asking, {}, tableOf); }
      catch (error) { if (error instanceof Answer) return error.decision; throw error; }
      throw new Error("no answer");
    };
    const pending = { ...allow(null, true), check: "() => &list.ownerId === actor.id", sql: literal(column(0)) };
    const allowed = await decision([policy("owner", [pending]), policy("signed", [allow(true)])]);
    expect(allowed.allowed).toBe(true);
    expect(allowed.breakdown.map((check) => check.check)).toEqual(["authorize-if true"]);
    const denied = await decision([policy("owner", [pending]), policy("signed", [allow(false)])]);
    expect(denied.allowed).toBe(false);
    expect(denied.breakdown).toEqual([{ policy: "signed", kind: "authorize-if", check: "authorize-if false", result: false, decisive: true }]);
    // A record check that folds to false decides as one that ran: it is listed, and it denies.
    const folded = await decision([policy("owner", [{ ...allow(null, true), check: "() => false && &x", sql: literal({ kind: "value", value: false, class: "boolean" }) }])]);
    expect(folded).toMatchObject({ allowed: false, breakdown: [{ policy: "owner", kind: "authorize-if", result: false, decisive: true }] });
  });
});

test("a read policy's checks run marked, so a privileged read inside throws; a write's checks do not", async () => {
  const marks: string[] = [];
  const frame = { marked: <T>(what: string, fn: () => T): T => (marks.push(what), fn()) };
  const read = authorizer("blog.Post", "read", [policy("public", [allow(true)], when(true))], frame);
  expect(await read.filter({ refuseIfFailed: () => true, transaction: (fn: () => Promise<unknown>) => fn() } as unknown as DataLayer, {})).toBe(true);
  expect(marks).toEqual(["policy :public of blog.Post", "policy :public of blog.Post"]);
  marks.length = 0;
  expect(await authorizer("blog.Post", "read", [policy("public", [allow(true)])], frame).admits({})).toBe(true);
  expect(marks).toEqual(["policy :public of blog.Post"]);
  marks.length = 0;
  const write = authorizer("blog.Post", "publish", [policy("owner", [allow(true), allow(true, true)])], frame);
  await write.before(layer, {});
  await write.inside({});
  expect(marks).toEqual([]);
});

test("Mesh.isSystem is true only for a context whose system key is true", () => {
  expect(Mesh.isSystem({ system: true })).toBe(true);
  for (const value of [{ system: false }, { system: "true" }, {}, null, undefined, true, "system"]) expect(Mesh.isSystem(value)).toBe(false);
});

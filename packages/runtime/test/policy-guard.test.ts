// The authorizer's half of a one-statement write guarded by its policies (ADR-0046, option B; pol05 design 3.3, 3.4):
// `guard` builds the WriteGuard from what `before` left, `statement` turns an adapter's PolicyGuardDenial into the same
// ForbiddenError the in-memory path (`inside`) gives, and `guardDenialOf` reads the marker out of a driver's error.
import { describe, expect, test } from "bun:test";
import { answeringLayer } from "../src/answer.ts";
import { authorizer, ForbiddenError, FrameworkError, guardDenialOf, PolicyGuardDenial, type ConditionLiteral, type DataLayer, type PolicySpec, type TableOf } from "@meshfw/runtime";

const layer = { refuseIfFailed: () => false } as unknown as DataLayer;
const tableOf: TableOf = (fqn) => ({ fqn });
type Check = PolicySpec["checks"][number];
const column = (name: string) => ({ kind: "column", depth: 0, name, class: "boolean" }) as const;
const literal = (tree: ConditionLiteral["tree"], params: (scope: never) => readonly unknown[] = () => []): () => ConditionLiteral<never> =>
  () => ({ what: "a test condition", entity: "blog.Post", tree, params });
/** A check that does not read the record: it runs in `before`. */
const actor = (kind: Check["kind"], value: unknown, name = `${kind} ${String(value)}`): Check => ({ kind, check: name, record: false, run: () => value });
/**
 * A check that reads the record: in memory (`inside`) it gives `value`; for the guard its literal is the column `name`.
 * `inside` runs `run`, the guard binds `sql`, so the two paths see the same check.
 */
const row = (kind: Check["kind"], name: string, value: unknown): Check =>
  ({ kind, check: name, record: true, run: () => value, sql: literal(column(name)) });
const policy = (name: string, checks: Check[], when: PolicySpec["when"] = null): PolicySpec => ({ name, when, checks });

/** The in-memory decision: `before`, then `inside`. */
async function inMemory(policies: PolicySpec[]): Promise<unknown> {
  const auth = authorizer("blog.Post", "destroy", policies);
  try { await auth.before(layer, {}); await auth.inside({}); return "allowed"; }
  catch (error) { return error; }
}

/** The guarded decision: `before`, `guard`, then a write that reports `results` as the adapter would. */
async function guardedWith(policies: PolicySpec[], results: readonly (boolean | null)[] | "admits"): Promise<unknown> {
  const auth = authorizer("blog.Post", "destroy", policies);
  try {
    await auth.before(layer, {});
    const guard = auth.guard({}, tableOf);
    expect(guard).toBeDefined();
    return await auth.statement(async () => {
      if (results === "admits") return "allowed";
      throw new PolicyGuardDenial(results);
    });
  } catch (error) { return error; }
}

describe("guard: what the statement checks", () => {
  test("nothing left for the statement: undefined (before decided)", async () => {
    const auth = authorizer("blog.Post", "destroy", [policy("open", [actor("authorize-if", true)])]);
    await auth.before(layer, {});
    expect(auth.guard({}, tableOf)).toBeUndefined();
  });

  test("an actor authorize-if that held: authorize is null, the record forbid-if decides, and the record authorize-if is still listed", async () => {
    const auth = authorizer("blog.Post", "destroy", [policy("p", [actor("authorize-if", true), row("authorize-if", "owner", false), row("forbid-if", "locked", false)])]);
    await auth.before(layer, {});
    const guard = auth.guard({}, tableOf)!;
    expect(guard.checks).toEqual([column("owner"), column("locked")]);
    expect(guard.policies).toEqual([{ forbid: [1], authorize: null }]);
  });

  for (const value of [false, null])
    test(`an actor authorize-if that gave ${String(value)}: the record authorize-if checks decide`, async () => {
      const auth = authorizer("blog.Post", "destroy", [policy("p", [actor("authorize-if", value), row("authorize-if", "owner", true), row("authorize-if", "editor", true)])]);
      await auth.before(layer, {});
      expect(auth.guard({}, tableOf)!.policies).toEqual([{ forbid: [], authorize: [0, 1] }]);
    });

  test("a policy with no authorize-if: authorize is null, only its forbid-if checks decide", async () => {
    const auth = authorizer("blog.Post", "destroy", [policy("p", [row("forbid-if", "locked", false)])]);
    await auth.before(layer, {});
    expect(auth.guard({}, tableOf)).toEqual({ checks: [column("locked")], policies: [{ forbid: [0], authorize: null }] });
  });

  test("a policy whose actor-only when was false is left out; one whose when held is in", async () => {
    const off = { check: "when off", record: false, run: () => false };
    const on = { check: "when on", record: false, run: () => true };
    const auth = authorizer("blog.Post", "destroy", [policy("off", [row("authorize-if", "a", true)], off), policy("on", [row("authorize-if", "b", true)], on)]);
    await auth.before(layer, {});
    expect(auth.guard({}, tableOf)).toEqual({ checks: [column("b")], policies: [{ forbid: [], authorize: [0] }] });
  });

  test("two policies keep their declaration order, and indices count across them", async () => {
    const auth = authorizer("blog.Post", "destroy", [
      policy("a", [row("authorize-if", "a1", true), row("forbid-if", "a2", false)]),
      policy("b", [row("forbid-if", "b1", false), row("authorize-if", "b2", true)]),
    ]);
    await auth.before(layer, {});
    const guard = auth.guard({}, tableOf)!;
    expect(guard.checks).toEqual(["a1", "a2", "b1", "b2"].map(column));
    expect(guard.policies).toEqual([{ forbid: [1], authorize: [0] }, { forbid: [2], authorize: [3] }]);
  });

  test("a check bound to a constant is kept as that constant, unknown included", async () => {
    const constant = (value: boolean | null, name: string): Check => ({ ...row("authorize-if", name, value), sql: literal({ kind: "value", value, class: "boolean" }) });
    const auth = authorizer("blog.Post", "destroy", [policy("p", [constant(true, "t"), constant(false, "f"), constant(null, "n")])]);
    await auth.before(layer, {});
    expect(auth.guard({}, tableOf)!.checks).toEqual([true, false, null]);
  });

  test("parameters are computed from the pre-check scope", async () => {
    const owner: Check = {
      ...row("authorize-if", "owner", true),
      sql: literal({ kind: "call", fn: "eq", args: [{ kind: "column", depth: 0, name: "authorId", class: "string" }, { kind: "param", index: 0, class: "string" }] }, (scope: { actor: { id: string } }) => [scope.actor.id]),
    };
    const auth = authorizer("blog.Post", "destroy", [policy("owner", [owner])]);
    const scope = { actor: { id: "u1" } };
    await auth.before(layer, scope);
    expect(auth.guard(scope, tableOf)!.checks).toEqual([{ kind: "call", fn: "eq", args: [{ kind: "column", depth: 0, name: "authorId", class: "string" }, { kind: "value", value: "u1", class: "string" }] }]);
  });

  test("a value its column cannot hold gives no guard (null): the write takes its read path; other bind errors pass through", async () => {
    const owner = (params: (scope: never) => readonly unknown[]): Check => ({
      ...row("authorize-if", "owner", false),
      sql: literal({ kind: "call", fn: "eq", args: [{ kind: "column", depth: 0, name: "authorId", class: "string" }, { kind: "param", index: 0, class: "string" }] }, params),
    });
    for (const id of [5, ["u1"], {}]) {
      const auth = authorizer("blog.Post", "destroy", [policy("owner", [owner((scope: { actor: { id: unknown } }) => [scope.actor.id])])]);
      const scope = { actor: { id } };
      await auth.before(layer, scope);
      expect(auth.guard(scope, tableOf)).toBeNull();
    }
    // Parameters that are not a list are a stale build, not a value the caller gave.
    const broken = authorizer("blog.Post", "destroy", [policy("owner", [owner(() => "u1" as never)])]);
    await broken.before(layer, {});
    expect(() => broken.guard({}, tableOf)).toThrow(FrameworkError);
  });

  test("a record-reading check with no sql, or a when that reads the record, is a stale build", async () => {
    const bare: Check = { kind: "authorize-if", check: "owner", record: true, run: () => true };
    const auth = authorizer("blog.Post", "destroy", [policy("owner", [bare])]);
    await auth.before(layer, {});
    expect(() => auth.guard({}, tableOf)).toThrow("blog.Post#destroy: policy :owner has a check that reads the record and no SQL condition; the generated actions are out of date, rebuild the project");
    const readsWhen = authorizer("blog.Post", "destroy", [policy("w", [row("authorize-if", "a", true)], { check: "when", record: true, run: () => true })]);
    await readsWhen.before(layer, {});
    expect(() => readsWhen.guard({}, tableOf)).toThrow(FrameworkError);
  });
});

describe("statement: a denial is the same ForbiddenError the in-memory path gives", () => {
  const shapes: [string, PolicySpec[]][] = [
    ["one record authorize-if that fails", [policy("owner", [row("authorize-if", "owner", false)])]],
    ["one record authorize-if that is unknown (fails closed)", [policy("owner", [row("authorize-if", "owner", null)])]],
    ["an unknown record forbid-if forbids", [policy("p", [actor("authorize-if", true), row("forbid-if", "locked", null)])]],
    ["mixed: a record authorize-if holds, a record forbid-if holds", [policy("p", [row("authorize-if", "owner", true), row("forbid-if", "locked", true)])]],
    // pol05 design 3.4: an admin deletes a locked post. A is authorized before the transaction; B's record forbid-if denies.
    ["the two-policy shape: A authorized by its actor check, B's record forbid-if denies", [
      policy("a", [actor("authorize-if", true, "({ actor }) => actor.admin"), row("authorize-if", "({ actor }) => &author.id === actor.id", false)]),
      policy("b", [row("forbid-if", "() => &locked", true)]),
    ]],
    ["two policies, one passes and one fails", [policy("a", [row("authorize-if", "a", true)]), policy("b", [row("authorize-if", "b", false), row("authorize-if", "c", null)])]],
  ];
  for (const [name, policies] of shapes)
    test(name, async () => {
      const expected = await inMemory(policies);
      expect(expected).toBeInstanceOf(ForbiddenError);
      // The adapter's results are what the checks give on the row: here, what `run` gives.
      const results = policies.flatMap((p) => p.checks.filter((c) => c.record).map((c) => c.run(undefined as never) as boolean | null));
      const actual = await guardedWith(policies, results);
      expect(actual).toBeInstanceOf(ForbiddenError);
      const shape = (error: ForbiddenError) => ({ entity: error.entity, action: error.action, policies: error.policies, reason: error.reason, breakdown: error.breakdown, message: error.message });
      expect(shape(actual as ForbiddenError)).toEqual(shape(expected as ForbiddenError));
    });

  test("the two-policy shape's breakdown lists A's two checks and B's decisive one", async () => {
    const [, policies] = shapes[4]!;
    const error = (await guardedWith(policies, [false, true])) as ForbiddenError;
    expect(error.policies).toEqual(["b"]);
    expect(error.breakdown).toEqual([
      { policy: "a", kind: "authorize-if", check: "({ actor }) => actor.admin", result: true, decisive: false },
      { policy: "a", kind: "authorize-if", check: "({ actor }) => &author.id === actor.id", result: false, decisive: false },
      { policy: "b", kind: "forbid-if", check: "() => &locked", result: true, decisive: true },
    ]);
  });

  test("an admitted write resolves with what the write gave", async () => {
    expect(await guardedWith([policy("owner", [row("authorize-if", "owner", true)])], "admits")).toBe("allowed");
  });

  test("a denial whose results admit the call is a FrameworkError, never an allow", async () => {
    const error = await guardedWith([policy("owner", [row("authorize-if", "owner", true)])], [true]);
    expect(error).toBeInstanceOf(FrameworkError);
    expect((error as Error).message).toBe("blog.Post#destroy: the data adapter's policy guard reported a denial that its own results admit; nothing was deleted, and the call fails");
    expect((error as Error).cause).toBeInstanceOf(PolicyGuardDenial);
  });

  test("a denial with a result per check other than the guard's is a FrameworkError", async () => {
    const error = await guardedWith([policy("owner", [row("authorize-if", "owner", true)])], [false, false]);
    expect(error).toBeInstanceOf(FrameworkError);
    expect((error as Error).message).toBe("A policy guard reported 2 results for 1 check: the data adapter decoded its own guard wrongly");
  });

  test("a denial with no guard built first is a FrameworkError", async () => {
    const auth = authorizer("blog.Post", "destroy", [policy("owner", [row("authorize-if", "owner", true)])]);
    await auth.before(layer, {});
    const error = await auth.statement(() => Promise.reject(new PolicyGuardDenial([false]))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FrameworkError);
    expect((error as Error).message).toBe("blog.Post#destroy: a guarded write reported a policy denial before guard() built its guard; the generated actions are out of date, rebuild the project");
  });

  test("any other error passes through unchanged", async () => {
    const auth = authorizer("blog.Post", "destroy", [policy("owner", [row("authorize-if", "owner", true)])]);
    await auth.before(layer, {});
    auth.guard({}, tableOf);
    const foreign = new Error("FOREIGN KEY constraint failed");
    await expect(auth.statement(() => Promise.reject(foreign))).rejects.toBe(foreign);
  });

  test("while answering a permission question, the statement is refused and the write never runs", async () => {
    const auth = authorizer("blog.Post", "destroy", [policy("owner", [row("authorize-if", "owner", true)])]);
    expect(auth.answering).toBe(false);
    await auth.before(answeringLayer(layer), {});
    expect(auth.answering).toBe(true);
    let ran = false;
    await expect(auth.statement(async () => { ran = true; })).rejects.toThrow("blog.Post#destroy: a permission question took the guarded delete; the generated actions are out of date, rebuild the project");
    expect(ran).toBe(false);
  });
});

describe("guardDenialOf: the marker in a driver's error", () => {
  const nonce = "0123456789abcdef0123456789abcdef";
  /** A driver error as the dialect's `raised` accepts it: SQLite's code with a JSON-path message, or Postgres 22P02. */
  const sqliteError = (message: string) => Object.assign(new Error(message), { code: "SQLITE_ERROR" });
  const postgresError = (message: string) => Object.assign(new Error(message), { errno: "22P02" });
  const raised = (error: unknown): string | undefined => {
    const e = error as { code?: unknown; errno?: unknown; message?: unknown };
    if (e?.code === "SQLITE_ERROR" && typeof e.message === "string" && /^(bad JSON path|JSON path error)/.test(e.message)) return e.message;
    if (e?.errno === "22P02" && typeof e.message === "string") return e.message;
    return undefined;
  };
  const read = (error: unknown, checks = 2) => guardDenialOf(error, { checks, nonce, raised });

  test("SQLite's bad JSON path, both wordings, and Postgres's integer cast", () => {
    for (const error of [
      sqliteError(`bad JSON path: 'mesh:forbidden:${nonce}:ft:p1'`),
      sqliteError(`JSON path error near 'mesh:forbidden:${nonce}:ft:p1'`),
      postgresError(`invalid input syntax for type integer: "mesh:forbidden:${nonce}:ft:42"`),
    ]) {
      const denial = read(error)!;
      expect(denial).toBeInstanceOf(PolicyGuardDenial);
      expect(denial.results).toEqual([false, true]);
      expect(denial.cause).toBe(error);
      expect(Object.isFrozen(denial.results)).toBe(true);
    }
    expect(read(sqliteError(`bad JSON path: 'mesh:forbidden:${nonce}:n:7'`), 1)!.results).toEqual([null]);
  });

  test("a wrapper's message is never read, even with this statement's nonce in its parameters", () => {
    const fk = sqliteError("FOREIGN KEY constraint failed");
    // Drizzle's DrizzleQueryError echoes the SQL and its parameters, which may hold a caller's input.
    const wrapper = (message: string, cause: unknown) => Object.assign(new Error(message), { cause });
    expect(read(wrapper(`Failed query: delete ...\nparams: mesh:forbidden:ffffffffffffffff:tt:,x`, fk))).toBeUndefined();
    expect(read(wrapper(`Failed query: delete ...\nparams: mesh:forbidden:${nonce}:tt:,x`, fk))).toBeUndefined();
  });

  test("another statement's nonce in an accepted error is not this denial", () => {
    expect(read(sqliteError("bad JSON path: 'mesh:forbidden:ffffffffffffffffffffffffffffffff:ft:p1'"))).toBeUndefined();
  });

  test("the driver's error is found down a cause chain, up to 8 deep", () => {
    const driver = postgresError(`invalid input syntax for type integer: "mesh:forbidden:${nonce}:tf:1"`);
    const chain = (depth: number) => { let error: unknown = driver; for (let i = 0; i < depth; i++) error = new Error(`wrap ${i}`, { cause: error }); return error; };
    expect(read(chain(3))!.results).toEqual([true, false]);
    expect(read(chain(7))!.results).toEqual([true, false]);
    expect(read(chain(8))).toBeUndefined();
  });

  test("a foreign error, or no error at all, is no denial", () => {
    for (const error of [new Error("boom"), sqliteError("no such table: posts"), sqliteError("malformed JSON"), postgresError("invalid input syntax for type integer: \"abc\""), "a string", null, undefined, 42])
      expect(read(error)).toBeUndefined();
  });

  test("a marker with a result per check other than expected is a FrameworkError", () => {
    expect(() => read(sqliteError(`bad JSON path: 'mesh:forbidden:${nonce}:ftt:p1'`))).toThrow("A policy guard reported 3 results for 2 checks: the data adapter decoded its own guard wrongly");
    expect(() => read(sqliteError(`bad JSON path: 'mesh:forbidden:${nonce}::p1'`))).toThrow(FrameworkError);
  });

  test("a nonce that is not letters and digits is refused", () => {
    expect(() => guardDenialOf(new Error("x"), { checks: 1, nonce: ".*", raised })).toThrow(FrameworkError);
  });
});

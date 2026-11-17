import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { bindDomain, FrameworkError, makeQuery, settled, type Binding, type DataLayer, type DataOperations, type RawRow, type RawStatement, type StandardSchemaV1 } from "../src/index.ts";
import { rawSqlConformance } from "../src/testing.ts";
import * as rawDomain from "./entity-domain/raw.ts";
import { Ledger } from "./entity-domain/raw.ts";

/**
 * `query` of `#mesh` (ADR-0087) over a fake layer that joins as the SQLite layer does: per async context, one joined call
 * at a time, a joined call that rejects fails the transaction, a later join is refused before it runs, and the
 * outermost call then rejects with the "rolled back even though caught" error.
 */
const ROLLED_BACK = "A call joined to this transaction failed, so the transaction is rolled back even though its callback caught the error";
const REFUSED = "A call joined a transaction that an earlier joined call failed, so it was refused before it ran: the transaction rolls back";

interface Token { readonly tx: DataOperations; active: boolean; failed?: { cause: unknown }; tail: Promise<void> }

function rawLayer(name: string, options: { query?: boolean; rows?: (statement: RawStatement) => readonly RawRow[] | Promise<readonly RawRow[]> } = {}) {
  const context = new AsyncLocalStorage<Token>();
  const statements: RawStatement[] = [];
  const opened: DataOperations[] = [];
  let running = 0;
  let most = 0;
  const operations = (): DataOperations => ({
    ...({} as DataOperations),
    ...(options.query === false ? {} : {
      async query(statement: RawStatement) {
        statements.push(statement);
        most = Math.max(most, ++running);
        try {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return await (options.rows?.(statement) ?? [{ n: 1 }]);
        } finally { running--; }
      },
    }),
  });
  const joined = () => { const token = context.getStore(); return token?.active ? token : undefined; };
  const layer = {
    name,
    async transaction<T>(run: (tx: DataOperations) => Promise<T>): Promise<T> {
      const token = joined();
      if (token) {
        if (token.failed) throw new FrameworkError(REFUSED, { cause: token.failed.cause });
        const before = token.tail;
        let release!: () => void;
        token.tail = new Promise<void>((resolve) => { release = resolve; });
        await before;
        try {
          const failed = token.failed as Token["failed"];
          if (failed) throw new FrameworkError(REFUSED, { cause: failed.cause });
          return await run(token.tx);
        } catch (cause) {
          token.failed ??= { cause };
          throw cause;
        } finally { release(); }
      }
      const fresh: Token = { tx: operations(), active: true, tail: Promise.resolve() };
      opened.push(fresh.tx);
      try {
        const value = await context.run(fresh, () => run(fresh.tx));
        if (fresh.failed) throw new FrameworkError(ROLLED_BACK, { cause: fresh.failed.cause });
        return value;
      } finally { fresh.active = false; }
    },
    refuseIfFailed(): boolean {
      const token = joined();
      if (!token) return false;
      if (token.failed) throw new FrameworkError(REFUSED, { cause: token.failed.cause });
      return true;
    },
    close: async () => {},
  } as DataLayer & { readonly name: string };
  return { layer, statements, opened, concurrency: () => most };
}

const frame = new AsyncLocalStorage<unknown>();

function project(options: Parameters<typeof rawLayer>[1] = {}) {
  const raw = rawLayer("db", options);
  const binding = bindDomain(rawDomain, raw.layer, {}, frame);
  let connected: Binding | undefined = binding;
  const query = makeQuery(frame, () => connected);
  return { ...raw, binding, query, disconnect: () => { connected = undefined; } };
}

/** What `run` rejects or throws with. */
async function failure(run: () => unknown): Promise<unknown> {
  try { await run(); } catch (error) { return error; }
  throw new Error("expected a failure");
}

const kindMessage = (n: number, kind: string) =>
  `query: the value of \${…} number ${n} is ${kind}, which cannot be bound: pass a string, a finite number, a bigint within 64 bits, a boolean, a valid Date or null`;

describe("the statement query hands the adapter", () => {
  test("a tag call reaches tx.query with the cooked text pieces and the values as written, all frozen", async () => {
    const { query, statements } = project();
    const when = new Date(0);
    await query`select ${"a"} as s, ${2} as n, ${when} as d`;
    const [statement] = statements;
    expect(statement).toEqual({ text: ["select ", " as s, ", " as n, ", " as d"], values: ["a", 2, when] });
    expect(Object.isFrozen(statement)).toBe(true);
    expect(Object.isFrozen(statement!.text)).toBe(true);
    expect(Object.isFrozen(statement!.values)).toBe(true);
    // a statement with no value is one piece
    await query`select 1`;
    expect(statements[1]).toEqual({ text: ["select 1"], values: [] });
  });

  test("the pieces are cooked: a doubled backslash reaches SQL as one, an escaped backtick as a backtick", async () => {
    const { query, statements } = project();
    await query`select 'a\\_b' like '%\\_%' escape '\\', '\`'`;
    expect(statements[0]!.text).toEqual(["select 'a\\_b' like '%\\_%' escape '\\', '`'"]);
  });

  test("an escape JavaScript cannot read is refused, and no statement reaches the adapter", async () => {
    const { query, statements } = project();
    const strings = Object.assign(["select '", "'"].map((piece, index) => index === 0 ? undefined : piece), { raw: ["select '\\x", "'"] });
    const error = await failure(() => query(Object.freeze(strings) as unknown as TemplateStringsArray, "v"));
    expect(error).toEqual(new FrameworkError("query: the SQL text holds an escape JavaScript cannot read (such as \\x): write a backslash as \\\\"));
    expect(statements).toHaveLength(0);
  });

  test.each([
    ["a string", "select 1"],
    ["an array that is not a template's strings", ["select 1"]],
    ["an array that is not a template's strings", Object.assign(["select 1"], { raw: ["select 1"] })],
    ["an array that is not a template's strings", Object.freeze(["select 1"])],
    ["undefined", undefined],
    ["null", null],
    ["an object", { raw: ["x"] }],
  ])("called with %s in place of a template's strings is refused", async (kind, strings) => {
    const { query, statements } = project();
    const error = await failure(() => query(strings as never));
    expect(error).toEqual(new FrameworkError(`query is a template tag: write query\`select … \${value}\`, never query(text); it was given ${kind}`));
    expect(statements).toHaveLength(0);
  });

  test("a template's strings with a value count that does not match is refused", async () => {
    const { query, statements } = project();
    const strings = (((s: TemplateStringsArray) => s) as (s: TemplateStringsArray) => TemplateStringsArray)`select 1`;
    expect(await failure(() => query(strings, 1 as never)))
      .toEqual(new FrameworkError("query is a template tag: write query`select … ${value}`, never query(text); it was given an array that is not a template's strings"));
    expect(statements).toHaveLength(0);
  });

  test.each([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["an invalid Date", new Date(Number.NaN)],
    ["an array", ["secret-value"]],
    ["an object", { secret: "secret-value" }],
    ["an object", new String("secret-value")],
    ["a Uint8Array", new Uint8Array([1])],
    ["a function", () => "secret-value"],
    ["a symbol", Symbol("secret-value")],
    ["a bigint beyond 64 bits", 2n ** 63n],
    ["a bigint beyond 64 bits", -(2n ** 63n) - 1n],
  ])("a value that is %s is refused naming its position and kind, never the value", async (kind, value) => {
    const { query, statements } = project();
    const error = await failure(() => query`select ${1} as a, ${value as never} as b`);
    expect(error).toEqual(new FrameworkError(kindMessage(2, kind)));
    expect((error as Error).message).not.toContain("secret-value");
    expect(statements).toHaveLength(0);
  });

  test("every kind that binds passes: strings, finite numbers, -0, bigints at both ends of 64 bits, booleans, a Date, null", async () => {
    const { query, statements } = project();
    const values = ["", "x'); delete from t; --", 0, -0, 1.5, Number.MAX_VALUE, 0n, 2n ** 63n - 1n, -(2n ** 63n), true, false, new Date(0), null];
    const strings = Object.freeze(Object.assign(Array.from({ length: values.length + 1 }, () => " "), { raw: Array.from({ length: values.length + 1 }, () => " ") }));
    await query(strings as unknown as TemplateStringsArray, ...values);
    expect(statements[0]!.values).toEqual(values);
  });
});

describe("the binding and the transaction query runs on", () => {
  test("with no binding in scope and none connected it rejects as not connected", async () => {
    const { query, disconnect } = project();
    disconnect();
    await expect(query`select 1`).rejects.toThrow(new FrameworkError("query was called while not connected: call connect() first, or call it inside run() of bind(db) with a data layer of your own"));
  });

  test("outside any transaction it opens one of its own on the connected binding's layer", async () => {
    const { query, opened } = project();
    expect(await query`select 1`).toEqual([{ n: 1 }]);
    expect(opened).toHaveLength(1);
  });

  test("inside run() of a second binding it runs on that binding's layer, not the connected one", async () => {
    const { query, opened } = project();
    const second = rawLayer("second");
    await bindDomain(rawDomain, second.layer, {}, frame).run(() => query`select 1`);
    expect(opened).toHaveLength(0);
    expect(second.statements).toHaveLength(1);
  });

  test("inside transaction(fn) it joins: one transaction, and the operations it ran on are the transaction's", async () => {
    const { query, binding, opened, statements } = project();
    await binding.transaction(async () => { await query`select 1`; await query`select 2`; });
    expect(opened).toHaveLength(1);
    expect(statements.map((statement) => statement.text[0])).toEqual(["select 1", "select 2"]);
  });

  test("two queries under Promise.all in one transaction both join and run one at a time, in call order", async () => {
    const { query, binding, opened, statements, concurrency } = project();
    await binding.transaction(() => Promise.all([query`select 1`, query`select 2`]));
    expect(opened).toHaveLength(1);
    expect(statements.map((statement) => statement.text[0])).toEqual(["select 1", "select 2"]);
    expect(concurrency()).toBe(1);
  });

  test("called after its transaction settled, from a detached promise, it is refused as a call in an ended transaction", async () => {
    const { query, binding, statements } = project();
    let later!: Promise<unknown>;
    await binding.transaction(async () => {
      later = new Promise((resolve) => setTimeout(() => resolve(failure(() => query`select 1`)), 5));
    });
    expect(await later).toEqual(new FrameworkError("a call was made inside a transaction that has ended: await every entity call and privileged read before the function or the transaction callback returns"));
    expect(statements).toHaveLength(0);
  });

  test("a layer whose transaction has no query operation rejects naming the raw-sql capability", async () => {
    const { query } = project({ query: false });
    expect(await failure(() => query`select 1`)).toEqual(new FrameworkError("query needs the raw-sql capability, and the data layer's transaction has no query operation: use a data adapter that declares raw-sql"));
  });

  test("disconnect() waits for a query in flight: settled() resolves only once it has", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { query, binding } = project({ rows: async () => { await held; return []; } });
    const pending = query`select 1`;
    let done = false;
    const waiting = settled(binding).then(() => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(done).toBe(false);
    release();
    await pending;
    await waiting;
    expect(done).toBe(true);
  });
});

describe("a failed raw query fails the running transaction", () => {
  test("a database error the callback catches still rolls the transaction back, with the error as the cause", async () => {
    const cause = new FrameworkError("The raw query failed in the database: no such table: x");
    const { query, binding } = project({ rows: () => { throw cause; } });
    const error = await failure(() => binding.transaction(async () => { await query`select * from x`.catch(() => undefined); }));
    expect(error).toEqual(new FrameworkError(ROLLED_BACK, { cause }));
    expect((error as Error).cause).toBe(cause);
  });

  test.each([
    ["a value that cannot be bound", (query: ReturnType<typeof project>["query"]) => query`select ${undefined as never}`, kindMessage(1, "undefined")],
    ["a plain call", (query: ReturnType<typeof project>["query"]) => query(["select 1"] as never), "query is a template tag: write query`select … ${value}`, never query(text); it was given an array that is not a template's strings"],
  ])("so does a misuse the callback catches: %s", async (_name, misuse, message) => {
    const { query, binding, statements } = project();
    const error = await failure(() => binding.transaction(async () => { await misuse(query).catch(() => undefined); }));
    expect(error).toEqual(new FrameworkError(ROLLED_BACK, { cause: new FrameworkError(message) }));
    expect(statements).toHaveLength(0);
  });

  test("a query joined after an earlier joined call failed is refused by the layer before it runs", async () => {
    const { query, binding, statements } = project();
    const error = await failure(() => binding.transaction(async () => {
      await query`select ${Number.NaN}`.catch(() => undefined);
      await query`select 1`;
    }));
    expect((error as Error).message).toBe(REFUSED);
    expect(statements).toHaveLength(0);
  });
});

describe("where query may not run", () => {
  const marked = (mark: string) =>
    new FrameworkError(`query was called while ${mark} is evaluated: a computed field and a read policy read the record and what it loads, and run no raw query. Run it from a step, a check or a write policy, through a helper`);

  test("while a computed field is evaluated it throws synchronously, naming the field", async () => {
    const { query, binding, statements } = project();
    let thrown: unknown;
    const computed = () => { try { return query`select 1`; } catch (error) { thrown = error; throw error; } };
    expect(await failure(() => binding.run(() => Ledger.read({ computed })))).toEqual(marked("computed :balance of bank.Ledger"));
    expect(thrown).toEqual(marked("computed :balance of bank.Ledger"));
    expect(statements).toHaveLength(0);
  });

  test("while a read policy is evaluated it throws, naming the policy", async () => {
    const { query, binding, statements } = project();
    expect(await failure(() => binding.run(() => Ledger.read({ policy: () => query`select 1` })))).toEqual(marked("policy :mine of bank.Ledger"));
    expect(statements).toHaveLength(0);
  });

  test("in a step of an action it runs and joins the action's transaction", async () => {
    const { query, binding, opened, statements } = project();
    const result = await binding.run(() => Ledger.act({ step: () => query`select 1` }));
    expect(result.stepped).toEqual([{ n: 1 }]);
    expect(opened).toHaveLength(1);
    expect(statements).toHaveLength(1);
  });
});

describe("the rows query resolves with", () => {
  test("each row and the array are frozen; a Uint8Array value is handed back untouched", async () => {
    const blob = new Uint8Array([1, 2]);
    const { query } = project({ rows: () => [{ a: 1, b: blob }, { a: 2, b: null }] });
    const rows = await query`select a, b from t`;
    expect(Object.isFrozen(rows)).toBe(true);
    expect(rows.every((row) => Object.isFrozen(row))).toBe(true);
    expect(rows[0]!.b).toBe(blob);
    expect(Object.isFrozen(blob)).toBe(false);
  });

  /** A hand-written Standard Schema of `{ id: string }`, sync or async. */
  const idSchema = (async: boolean): StandardSchemaV1<unknown, { id: string }> => ({
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value) => {
        const id = (value as { id?: unknown }).id;
        const result: StandardSchemaV1.Result<{ id: string }> = typeof id === "string" ? { value: { id } } : { issues: [{ message: "expected a string", path: [{ key: "id" }] }, { message: "is wrong" }] };
        return async ? Promise.resolve(result) : result;
      },
    },
  });

  test.each([false, true])("query.as(schema) validates and types every row (async validate: %p), and the output rows are frozen", async (async) => {
    const { query } = project({ rows: () => [{ id: "a", extra: 1 }, { id: "b" }] });
    const rows = await query.as(idSchema(async))`select id from t`;
    const typed: readonly { id: string }[] = rows;
    expect(typed).toEqual([{ id: "a" }, { id: "b" }]);
    expect(Object.isFrozen(rows) && Object.isFrozen(rows[0])).toBe(true);
  });

  test.each([false, true])("a row that does not match rejects naming its index and the issues' paths and messages (async validate: %p)", async (async) => {
    const { query, binding } = project({ rows: () => [{ id: "a" }, { id: 7, secret: "secret-value" }] });
    const error = await failure(() => query.as(idSchema(async))`select id from t`);
    expect(error).toEqual(new FrameworkError("query.as(schema): row 1 does not match the schema: id: expected a string; is wrong"));
    expect((error as Error).message).not.toContain("secret-value");
    // inside a transaction it runs in the joined call, so it fails the transaction
    const inside = await failure(() => binding.transaction(async () => { await query.as(idSchema(async))`select id from t`.catch(() => undefined); }));
    expect((inside as Error).message).toBe(ROLLED_BACK);
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["an object that is not one", { "~standard": {} }],
    ["an array", []],
    ["string", "schema"],
  ])("query.as() given %s throws when as is called, before any statement", (kind, schema) => {
    const { query, statements } = project();
    expect(() => query.as(schema as never)).toThrow(new FrameworkError(`query.as() takes a Standard Schema, such as a Zod object, and was given ${kind}`));
    expect(statements).toHaveLength(0);
  });

  test("query and query.as are frozen", () => {
    const { query } = project();
    expect(Object.isFrozen(query)).toBe(true);
    expect(Object.isFrozen(query.as(idSchema(false)))).toBe(true);
  });
});

describe("rawSqlConformance without raw-sql", () => {
  test("it is one check, which fails for a layer that hands out a query operation anyway", async () => {
    const fixture = (query: boolean) => async () => ({ layer: rawLayer("db", { query }).layer } as never);
    const manifest = { adapter: "x", capabilities: [] };
    const checks = rawSqlConformance(fixture(false), manifest);
    expect(Object.keys(checks)).toEqual(["an adapter without raw-sql hands out no query operation"]);
    await checks["an adapter without raw-sql hands out no query operation"]!();
    await expect(rawSqlConformance(fixture(true), manifest)["an adapter without raw-sql hands out no query operation"]!()).rejects.toThrow("must have no query operation");
  });
});

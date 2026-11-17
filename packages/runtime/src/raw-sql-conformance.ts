import type { CapabilityManifest } from "./capabilities.ts";
import type { DataLayerFixtureV1 } from "./conformance-v1.ts";
import type { DataOperations, RawRow, RawStatement, RawValue, Row } from "./data-layer.ts";
import { FrameworkError } from "./errors.ts";

/**
 * What the raw-SQL checks need: a v1 fixture, plus the dialect's parts. Every identifier the checks write comes from
 * here, already quoted for the dialect, so the portable checks hold on SQLite and on Postgres alike.
 */
export interface RawSqlFixture extends DataLayerFixtureV1 {
  /** `taskTable`'s stored name, quoted for the dialect: `"tasks"`. (`taskTable` itself is the v1 fixture's handle.) */
  readonly taskTableName: string;
  /** The stored, quoted column names of `taskTable`'s `id` and `createdAt`: `"id"`, `"createdAt"`. */
  readonly columns: { readonly id: string; readonly createdAt: string };
  /** What `select ${v} as v` gives back for a boolean and a `Date`: SQLite `1`/`0` and milliseconds; Postgres `true` and a `Date`. */
  readonly stored: { boolean(value: boolean): unknown; date(value: Date): unknown };
  /** Dialect statements that must be refused besides the portable ones (SQLite: `pragma …`, `attach …`, `vacuum`). */
  readonly refusedStatements: readonly string[];
  /** Parameters written in the text that the dialect would read as placeholders (SQLite: `?`, `?1`, `:a`, `@a`, `$a`). */
  readonly textParameters: readonly string[];
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Raw-SQL conformance: ${message}`);
}

const day = (n: number) => new Date(`2026-01-0${n}T00:00:00.000Z`);
const TASKS: Row[] = [
  { id: "a1", parentId: null, createdAt: day(1), title: "Alpha", rank: 3 },
  { id: "a2", parentId: "p1", createdAt: day(2), title: "Bravo", rank: 1 },
  { id: "a3", parentId: "p1", createdAt: day(2), title: "Charlie", rank: null },
];
const extra = (id: string): Row => ({ id, parentId: null, createdAt: day(5), title: "Extra", rank: null });

/** One statement: text pieces and the values between them, as core hands them over. */
const statement = (text: readonly string[], ...values: RawValue[]): RawStatement => Object.freeze({ text: Object.freeze([...text]), values: Object.freeze(values) });
const plain = (text: string) => statement([text]);

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.constructor.name}: ${value.message}`;
  try { return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? `${item}n` : item) ?? String(value); } catch { return String(value); }
}

/** What `tx.query` rejects with, or `undefined` when it resolves. */
async function refusal(tx: DataOperations, raw: RawStatement): Promise<unknown> {
  try { await tx.query!(raw); } catch (error) { return error; }
  return undefined;
}

/**
 * The checks of the `raw-sql` capability (ADR-0087): the portable core every adapter that declares it passes, with the
 * dialect's parts from the fixture. When the manifest does not declare `raw-sql`, one check: the transaction hands out
 * no `query` operation. Each check owns and closes its layer, including on failure.
 */
export function rawSqlConformance(makeLayer: () => Promise<RawSqlFixture>, manifest: CapabilityManifest): Record<string, () => Promise<void>> {
  const withFixture = (run: (fixture: RawSqlFixture) => Promise<void>) => async () => {
    const fixture = await makeLayer();
    try { await run(fixture); } finally { await fixture.layer.close(); }
  };
  if (!manifest.capabilities.includes("raw-sql")) {
    return {
      "an adapter without raw-sql hands out no query operation": withFixture(async ({ layer }) => {
        await layer.transaction(async (tx) => { assert(tx.query === undefined, "a transaction of an adapter that does not declare raw-sql must have no query operation"); });
      }),
    };
  }
  const withTasks = (run: (fixture: RawSqlFixture) => Promise<void>) => withFixture(async (fixture) => {
    await fixture.layer.transaction(async (tx) => {
      assert(typeof tx.query === "function", "an adapter that declares raw-sql must hand every transaction a query operation");
      for (const task of TASKS) await tx.insert(fixture.taskTable, task);
    });
    await run(fixture);
  });
  /** True when `id` was committed. */
  const committed = async (fixture: RawSqlFixture, id: string) =>
    (await fixture.layer.transaction((tx) => tx.selectByKey(fixture.taskTable, { id }))) !== undefined;
  /** `raw` is refused with a `FrameworkError`, then the same transaction still inserts `id`, and that row commits. */
  const refusedThenWrites = async (fixture: RawSqlFixture, raw: RawStatement, id: string, what: string) => {
    await fixture.layer.transaction(async (tx) => {
      const error = await refusal(tx, raw);
      assert(error instanceof FrameworkError, `${what} must be refused with a FrameworkError, got ${describe(error)}`);
      await tx.insert(fixture.taskTable, extra(id));
    });
    assert(await committed(fixture, id), `after ${what} was refused, the transaction must still write and commit`);
  };
  const count = async (tx: DataOperations, fixture: RawSqlFixture) => {
    const [row] = await tx.query!(plain(`select count(*) as n from ${fixture.taskTableName}`));
    return Number(row?.n);
  };
  const portableRefusals = (table: string) => [
    `delete from ${table}`,
    `insert into ${table} (id) values ('x')`,
    `update ${table} set title = 'x'`,
    "begin",
    "commit",
    "rollback",
    "savepoint s",
    "release s",
    "/* c */ select 1",
    "-- c\nselect 1",
  ];
  return {
    "raw-sql: a value is bound, never spliced into the text": withTasks(async (fixture) => {
      const value = "x'); delete from tasks; --";
      const rows = await fixture.layer.transaction((tx) => tx.query!(statement(["select ", " as v"], value)));
      assert(rows.length === 1 && rows[0]!.v === value, `select \${v} must give the value back unchanged, got ${describe(rows)}`);
      const left = await fixture.layer.transaction((tx) => count(tx, fixture));
      assert(left === TASKS.length, `the table must keep its ${TASKS.length} rows, got ${left}`);
    }),
    "raw-sql: the statement runs inside the running transaction, in call order, and sees its uncommitted rows": withTasks(async (fixture) => {
      await fixture.layer.transaction(async (tx) => {
        await tx.insert(fixture.taskTable, extra("b1"));
        const first = await count(tx, fixture);
        await tx.insert(fixture.taskTable, extra("b2"));
        const second = await count(tx, fixture);
        assert(first === TASKS.length + 1 && second === TASKS.length + 2, `the counts must see each uncommitted insert: got ${first} then ${second}`);
      });
    }),
    "raw-sql: a with … delete is refused by the database, and the transaction still writes": withTasks(async (fixture) => {
      await refusedThenWrites(fixture, plain(`with x as (select 1) delete from ${fixture.taskTableName}`), "c1", "with x as (select 1) delete");
      const left = await fixture.layer.transaction((tx) => count(tx, fixture));
      assert(left === TASKS.length + 1, `the refused delete must have deleted nothing, got ${left} rows`);
    }),
    "raw-sql: a statement that is not a query is refused, and the transaction stays open and read-only for raw queries": withTasks(async (fixture) => {
      const refused = [...portableRefusals(fixture.taskTableName), ...fixture.refusedStatements];
      for (const [index, text] of refused.entries()) await refusedThenWrites(fixture, plain(text), `d${index}`, JSON.stringify(text));
      await refusedThenWrites(fixture, plain(`with x as (select 1) delete from ${fixture.taskTableName}`), "d-last", "a write after the refusals");
    }),
    "raw-sql: text after the first statement is refused; one trailing ; is accepted": withTasks(async (fixture) => {
      for (const text of [`select 1; delete from ${fixture.taskTableName}`, "select 1; select 2"])
        await refusedThenWrites(fixture, plain(text), `e${text.length}`, JSON.stringify(text));
      for (const text of ["select 1 as v;", "select 1 as v ; -- end"]) {
        const rows = await fixture.layer.transaction((tx) => tx.query!(plain(text)));
        assert(rows.length === 1 && Number(rows[0]!.v) === 1, `${JSON.stringify(text)} must run, got ${describe(rows)}`);
      }
    }),
    "raw-sql: a parameter written in the text is refused; a ? inside a string is text": withTasks(async (fixture) => {
      for (const [index, parameter] of fixture.textParameters.entries())
        await refusedThenWrites(fixture, plain(`select ${parameter} as v`), `f${index}`, `the text parameter ${parameter}`);
      const rows = await fixture.layer.transaction((tx) => tx.query!(plain("select 'a?b' as v")));
      assert(rows[0]?.v === "a?b", `select 'a?b' must give the text back, got ${describe(rows)}`);
    }),
    "raw-sql: a value that stands inside quotes or a comment is refused": withTasks(async (fixture) => {
      await refusedThenWrites(fixture, statement(["select '", "' as v"], "x"), "g1", "a value inside a quoted string");
      await refusedThenWrites(fixture, statement(["select 1 /* ", " */ as v"], "x"), "g2", "a value inside a comment");
    }),
    "raw-sql: a boolean and a Date round-trip in the dialect's stored form, and compare with stored values": withTasks(async (fixture) => {
      const [row] = await fixture.layer.transaction((tx) => tx.query!(statement(["select ", " as t, ", " as f"], true, false)));
      assert(describe(row?.t) === describe(fixture.stored.boolean(true)) && describe(row?.f) === describe(fixture.stored.boolean(false)),
        `booleans must come back as ${describe(fixture.stored.boolean(true))} and ${describe(fixture.stored.boolean(false))}, got ${describe(row)}`);
      const { id, createdAt } = fixture.columns;
      const rows = await fixture.layer.transaction((tx) => tx.query!(statement([`select ${id} as id from ${fixture.taskTableName} where ${createdAt} = `, ` order by ${id}`], day(2))));
      assert(describe(rows.map((each) => each.id)) === describe(["a2", "a3"]), `the Date must compare with the stored dates, got ${describe(rows)}`);
    }),
    "raw-sql: results come back as stored": withTasks(async (fixture) => {
      const { id, createdAt } = fixture.columns;
      const [row] = await fixture.layer.transaction((tx) => tx.query!(plain(`select ${createdAt} as c from ${fixture.taskTableName} where ${id} = 'a2'`)));
      assert(describe(row?.c) === describe(fixture.stored.date(day(2))), `a stored date must come back as ${describe(fixture.stored.date(day(2)))}, got ${describe(row)}`);
    }),
    "raw-sql: a value the adapter cannot bind is refused, never bound as NULL": withTasks(async (fixture) => {
      for (const [index, value] of [{ a: 1 }, undefined, Number.NaN, 2n ** 70n].entries())
        await refusedThenWrites(fixture, statement(["select ", " as v"], value as never), `h${index}`, `the value ${describe(value)}`);
    }),
    "raw-sql: a database error rejects with a cause and leaves the transaction usable": withTasks(async (fixture) => {
      await fixture.layer.transaction(async (tx) => {
        const error = await refusal(tx, plain("select * from no_such_table"));
        assert(error instanceof FrameworkError && error.cause !== undefined, `a missing table must reject with a FrameworkError with a cause, got ${describe(error)}`);
        await tx.insert(fixture.taskTable, extra("i1"));
      });
      assert(await committed(fixture, "i1"), "after a database error, the transaction must still write and commit");
    }),
    "raw-sql: a result that names a column twice is refused; integers come back exact": withTasks(async (fixture) => {
      await refusedThenWrites(fixture, plain("select 1 as a, 2 as a"), "j1", "a result naming a column twice");
      const [big] = await fixture.layer.transaction((tx) => tx.query!(plain("select 9007199254740993 as n")));
      assert(big?.n === 9007199254740993n, `an integer beyond 2^53 must come back as an exact bigint, got ${describe(big)}`);
      const [small] = await fixture.layer.transaction((tx) => tx.query!(plain("select 5 as n")));
      assert(small?.n === 5, `a safe integer must come back as a number, got ${describe(small)}`);
    }),
    "raw-sql: the rows resolve as plain objects keyed by the statement's column names": withTasks(async (fixture) => {
      const { id } = fixture.columns;
      const rows: readonly RawRow[] = await fixture.layer.transaction((tx) => tx.query!(plain(`select ${id} as "theId" from ${fixture.taskTableName} order by ${id}`)));
      assert(describe(rows) === describe(TASKS.map((task) => ({ theId: task.id }))), `the rows must be keyed by the alias, got ${describe(rows)}`);
    }),
  };
}

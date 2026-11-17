import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { FrameworkError, type RawStatement } from "@meshfw/runtime";
import { createSchema, sqlite } from "../src/index.ts";
import { rawQuery, sqliteText } from "../src/raw-query.ts";

// What the portable block (`rawSqlConformance`, run by `contract.test.ts`) leaves to the adapter: the lexer's token
// shapes, SQLite's stored forms and that `query_only` is off after every call.

/** A statement as core hands it over: the pieces with one value between each two. */
const pieces = (...text: string[]): RawStatement => ({ text, values: text.slice(1).map(() => "v") });
const one = (text: string) => pieces(text);

const STARTS = (what: string) => `A raw query runs one select, with or values statement, and this one ${what}`;
const SECOND = "A raw query runs one statement, and its text holds a second one after \";\"";
const PARAMETER = (token: string) => `A raw query's text holds the parameter ${token}: every value goes in a \${…}, never in the text`;
const INSIDE = (n: number) => `A raw query's \${…} number ${n} stands inside a quoted string, a quoted name or a comment, where it would not be bound: put it outside the quotes, as in lower(title) like \${pattern}`;

describe("sqliteText, the lexer", () => {
  test.each([
    // each quote kind may hold a ; a ? and -- as text
    ["select ';?--' as v", "select ';?--' as v"],
    ["select 'it''s; ?' as v", "select 'it''s; ?' as v"],
    ["select 1 as \"a;?--\"", "select 1 as \"a;?--\""],
    ["select 1 as \"a\"\";\"", "select 1 as \"a\"\";\""],
    ["select 1 as `a;?`", "select 1 as `a;?`"],
    ["select 1 as [a;?]", "select 1 as [a;?]"],
    ["select x'00' as b", "select x'00' as b"],
    // comments after the first word hide what they hold
    ["select 1 -- ; ? :a\n as v", "select 1 -- ; ? :a\n as v"],
    ["select /* ; ? /* not nested */ 1 as v", "select /* ; ? /* not nested */ 1 as v"],
    // the first word in any case; with and values
    ["SELECT 1", "SELECT 1"],
    ["  \n\tWith x as (select 1) select * from x", "  \n\tWith x as (select 1) select * from x"],
    ["values (1), (2)", "values (1), (2)"],
    // a $ inside a name is no parameter; SQLite reads an unknown double-quoted name as a string
    ["select 1 as a$b", "select 1 as a$b"],
    ["select \"a$b\"", "select \"a$b\""],
    // : @ $ not followed by a name character are plain characters
    ["select '$.a', 1 :: 2", "select '$.a', 1 :: 2"],
    // one trailing ; and what may follow it
    ["select 1;", "select 1;"],
    ["select 1 ; -- end\n /* c */ ;", "select 1 ; -- end\n /* c */ ;"],
  ])("accepts %j", (input, output) => {
    expect(sqliteText(one(input))).toBe(output);
  });

  test("joins the pieces with the adapter's ? placeholders", () => {
    expect(sqliteText(pieces("select ", " as a, ", " as b"))).toBe("select ? as a, ? as b");
    expect(sqliteText(pieces("select * from t where id in (", ",", ")"))).toBe("select * from t where id in (?,?)");
  });

  test.each([
    ["delete from t", STARTS("starts with delete")],
    ["pragma query_only = off", STARTS("starts with pragma")],
    ["attach ':memory:' as x", STARTS("starts with attach")],
    ["begin", STARTS("starts with begin")],
    ["selectx 1", STARTS("starts with selectx")],
    ["(select 1)", STARTS("starts with (")],
    ["x'00'", STARTS("starts with x")],
    ["-- c\nselect 1", STARTS("starts with a comment")],
    ["/* c */ select 1", STARTS("starts with a comment")],
    ["'select'", STARTS("starts with '")],
    ["", STARTS("is empty")],
    ["   ", STARTS("is empty")],
    [";", STARTS("is empty before its \";\"")],
    ["select 1; delete from t", SECOND],
    ["select 1; select 2", SECOND],
    ["select 1;'x'", SECOND],
    ["select 1;;\nvacuum", SECOND],
    ["select ?", PARAMETER("?")],
    ["select ?12", PARAMETER("?12")],
    ["select :name", PARAMETER(":name")],
    ["select @a", PARAMETER("@a")],
    ["select $a", PARAMETER("$a")],
    ["select $1", PARAMETER("$1")],
    ["select #a as v", PARAMETER("#a")],
    // SQLite counts $ as a name character after : @ # and $
    ["select :$ as v", PARAMETER(":$")],
    ["select $$ as v", PARAMETER("$$")],
    ["select 1 where 1 = @$", PARAMETER("@$")],
  ])("refuses %j", (input, message) => {
    expect(() => sqliteText(one(input))).toThrow(new FrameworkError(message));
  });

  test.each([
    [["select '", "' as v"], 1],
    [["select 1 as \"", "\""], 1],
    [["select 1 as `", "`"], 1],
    [["select 1 as [", "]"], 1],
    [["select ", ", '", "'"], 2],
    [["select 1 -- ", "\n"], 1],
    [["select 1 /* ", " */"], 1],
    // an unterminated quote runs to the end of the text, so a value after its opening is inside it
    [["select 'abc ", ""], 1],
  ])("refuses a value inside quotes or a comment: %j", (text, n) => {
    expect(() => sqliteText(pieces(...text))).toThrow(new FrameworkError(INSIDE(n)));
  });

  test("a placed ? that the next piece turns into a numbered parameter is refused", () => {
    expect(() => sqliteText(pieces("select ", "1"))).toThrow(new FrameworkError(PARAMETER("?1")));
  });

  test("an author's ? beside placed ones is refused even when the counts would match", () => {
    expect(() => sqliteText({ text: ["select ", ", ?1, ", ""], values: ["a", "b"] })).toThrow(new FrameworkError(PARAMETER("?1")));
  });

  test("an unterminated quote with no value inside is left for SQLite's syntax error", () => {
    expect(sqliteText(one("select 'abc"))).toBe("select 'abc");
  });
});

describe("rawQuery on a connection", () => {
  const tasks = sqliteTable("tasks", {
    id: text("id").primaryKey().notNull(),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    done: integer("done", { mode: "boolean" }).notNull(),
  });

  test("a datetime column reads back as an integer and a boolean as 0 or 1: the stored forms", async () => {
    const layer = sqlite({ file: ":memory:" });
    try {
      await createSchema(layer, { tasks });
      const at = new Date(Date.UTC(2026, 0, 2));
      const rows = await layer.transaction(async (tx) => {
        await tx.insert(tasks, { id: "a", createdAt: at, done: true });
        return tx.query!({ text: ["select \"createdAt\", done, ", " as d, ", " as b from tasks"], values: [at, false] });
      });
      expect(rows).toEqual([{ createdAt: at.getTime(), done: 1, d: at.getTime(), b: 0 }]);
    } finally { await layer.close(); }
  });

  test("query_only is off after every call, whether it ran, was refused or failed in the database", () => {
    const connection = new Database(":memory:");
    try {
      connection.run("create table t (x)");
      connection.run("begin immediate");
      const queryOnly = () => (connection.query("pragma query_only").get() as { query_only: number }).query_only;
      expect(rawQuery(connection, one("select 1 as v"))).toEqual([{ v: 1 }]);
      expect(queryOnly()).toBe(0);
      for (const text of ["with x as (select 1) delete from t", "select * from nope", "select 1 as a, 2 as a"]) {
        expect(() => rawQuery(connection, one(text))).toThrow(FrameworkError);
        expect(queryOnly()).toBe(0);
      }
      connection.run("insert into t values (1)");
      expect(connection.inTransaction).toBe(true);
    } finally { connection.close(); }
  });

  test("a refused write names no SQL value and keeps the database's error as its cause", () => {
    const connection = new Database(":memory:");
    try {
      connection.run("create table t (x)");
      connection.run("begin immediate");
      let error: unknown;
      try { rawQuery(connection, { text: ["with x as (select ", ") delete from t"], values: ["secret-value"] }); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toBe("A raw query cannot write: the database refused the statement as a write");
      expect(((error as Error).cause as { code?: string }).code).toStartWith("SQLITE_READONLY");
      expect((error as Error).message).not.toContain("secret-value");
    } finally { connection.close(); }
  });

  test("a database error that quotes a value keeps the value out of the message and SQLite's message in the cause", () => {
    const connection = new Database(":memory:");
    try {
      connection.run("begin immediate");
      for (const text of [["select json_extract('{\"a\":1}', ", ") as v"], ["select json_set('{}', ", ", 1) as v"], ["select * from json_each('{}', ", ")"]]) {
        let error: unknown;
        try { rawQuery(connection, { text, values: ["secret-ssn-123"] }); } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(FrameworkError);
        expect((error as Error).message).toBe("The raw query failed in the database, with a message that quotes one of its values: see the cause");
        expect((error as Error).message).not.toContain("secret-ssn-123");
        expect(((error as Error).cause as Error).message).toContain("secret-ssn-123");
      }
      expect(connection.inTransaction).toBe(true);
    } finally { connection.close(); }
  });

  test("a database error that quotes no value keeps SQLite's message", () => {
    const connection = new Database(":memory:");
    try {
      connection.run("begin immediate");
      expect(() => rawQuery(connection, { text: ["select ", " from nope"], values: ["secret-ssn-123"] }))
        .toThrow(new FrameworkError("The raw query failed in the database: no such table: nope"));
    } finally { connection.close(); }
  });

  test("a parameter the lexer let through is refused by the paramsCount guard, never bound as NULL", () => {
    const connection = new Database(":memory:");
    try {
      connection.run("begin immediate");
      expect(() => rawQuery(connection, one("select :a as v"), (statement) => statement.text.join("?")))
        .toThrow(new FrameworkError("A raw query's text holds a parameter the adapter did not place: every value goes in a ${…}, never in the text"));
      expect(connection.inTransaction).toBe(true);
    } finally { connection.close(); }
  });

  test("a statement that would end the transaction cannot reach SQLite, so the open-transaction guard never fires on legal input", () => {
    const connection = new Database(":memory:");
    try {
      connection.run("begin immediate");
      expect(() => rawQuery(connection, one("commit"))).toThrow(new FrameworkError(STARTS("starts with commit")));
      expect(connection.inTransaction).toBe(true);
    } finally { connection.close(); }
  });

  test("outside a transaction the guard refuses the result: the connection is in an unknown state", () => {
    const connection = new Database(":memory:");
    try {
      expect(() => rawQuery(connection, one("select 1"))).toThrow(new FrameworkError("A raw query ended the transaction it ran in: the data layer's connection is in an unknown state"));
    } finally { connection.close(); }
  });

  test("an integer column comes back exact both ways, and a real stays a number", () => {
    const connection = new Database(":memory:");
    try {
      connection.run("begin immediate");
      expect(rawQuery(connection, { text: ["select ", " as big, ", " as small, 1.5 as r, -9007199254740993 as neg"], values: [2n ** 63n - 1n, 7n] }))
        .toEqual([{ big: 2n ** 63n - 1n, small: 7, r: 1.5, neg: -9007199254740993n }]);
    } finally { connection.close(); }
  });

  test("a column named __proto__ is an own key of the row, never its prototype", () => {
    const connection = new Database(":memory:");
    try {
      connection.run("begin immediate");
      const [row] = rawQuery(connection, one("select 5 as \"__proto__\""));
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
      expect(Object.getOwnPropertyDescriptor(row, "__proto__")?.value).toBe(5);
    } finally { connection.close(); }
  });
});

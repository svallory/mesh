import type { Database, SQLQueryBindings, Statement } from "bun:sqlite";
import { FrameworkError, MeshError, type RawRow, type RawStatement } from "@meshfw/runtime";

/**
 * The `query` operation of the `raw-sql` capability (ADR-0087) on SQLite: one read-only statement written by hand, run
 * on the transaction's connection. Four means keep it read-only together: the lexer below (the first word, one
 * statement, no parameter written in the text), `PRAGMA query_only` for the statement's duration (which stops a write
 * the first word lets through, `with x as (…) delete …`), the prepared path, which never runs a second statement, and a
 * check afterwards that the transaction is still open. Not exported from the package index.
 */

const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = 2n ** 63n - 1n;

/** What a value is when this adapter cannot bind it, for a message that never shows the value; `undefined` when it can. */
function unbindable(value: unknown): string | undefined {
  switch (typeof value) {
    case "string": case "boolean": return undefined;
    case "number": return Number.isFinite(value) ? undefined : Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity";
    case "bigint": return value >= MIN_INT64 && value <= MAX_INT64 ? undefined : "a bigint beyond 64 bits";
    case "undefined": return "undefined";
    case "function": return "a function";
    case "symbol": return "a symbol";
  }
  if (value === null) return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "an invalid Date" : undefined;
  if (Array.isArray(value)) return "an array";
  if (value instanceof Uint8Array) return "a Uint8Array";
  return "an object";
}

/** The values as SQLite binds them: a `Date` as its milliseconds, a boolean as 1 or 0; a value it cannot bind is refused (E15). */
export function bindable(values: readonly unknown[]): SQLQueryBindings[] {
  return values.map((value, index) => {
    const kind = unbindable(value);
    if (kind !== undefined) throw new FrameworkError(`A raw query's value number ${index + 1} is ${kind}, which @meshfw/data-sqlite cannot bind`);
    if (value instanceof Date) return value.getTime();
    if (typeof value === "boolean") return value ? 1 : 0;
    return value as SQLQueryBindings;
  });
}

const ALLOWED = new Set(["select", "with", "values"]);
const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;
/** A name character after `:`, `@`, `#` or `$`: SQLite counts `$` among them, so `:$` and `$$` are parameters. */
const PARAMETER_NAME = /[A-Za-z0-9_$\u0080-￿]/;
const DIGIT = /[0-9]/;

const firstWord = (what: string) => new FrameworkError(`A raw query runs one select, with or values statement, and this one ${what}`);
const textParameter = (token: string) => new FrameworkError(`A raw query's text holds the parameter ${token}: every value goes in a \${…}, never in the text`);
const quotedValue = (n: number) =>
  new FrameworkError(`A raw query's \${…} number ${n} stands inside a quoted string, a quoted name or a comment, where it would not be bound: put it outside the quotes, as in lower(title) like \${pattern}`);

/**
 * The statement's text for SQLite: the pieces joined with `?`, lexed as one text. Not a SQL parser: it knows the token
 * shapes that can hide a `;`, a `?` or a word (`'…'` strings, `"…"`, `` `…` `` and `[…]` quoted names, `-- …` and
 * `/* … *\/` comments, words, where SQLite allows `$` after the first character) and decides nothing about meaning. It
 * refuses a first token that is a comment or a word other than `select`, `with` or `values` (E9); a parameter written in
 * the text, `?`, `?1`, `:a`, `@a`, `#a` or `$a`, `$` counting as a name character (`:$`, `$$`) (E11); a placed `?` that falls inside a quoted string, a quoted name or a
 * comment (E12); and anything but whitespace, comments and `;` after the first `;` (E10). An unterminated quote or
 * comment runs to the end of the text, where SQLite reports the syntax error.
 */
export function sqliteText(statement: RawStatement): string {
  let text = statement.text[0] ?? "";
  const placed: number[] = [];
  for (let index = 1; index < statement.text.length; index++) {
    placed.push(text.length);
    text += `?${statement.text[index]}`;
  }
  const placedAt = new Map(placed.map((offset, index) => [offset, index + 1]));
  /** Refuse a placed `?` between `from` and `to`, the inside of a quote or a comment. */
  const noneInside = (from: number, to: number) => {
    for (const [offset, n] of placedAt) if (offset >= from && offset < to) throw quotedValue(n);
  };
  /** The end of a quote opened at `start` and closed by `close`, a doubled `close` standing for itself (no doubling for `]`). */
  const quoteEnd = (start: number, close: string, doubled: boolean) => {
    let at = start + 1;
    for (;;) {
      const found = text.indexOf(close, at);
      if (found < 0) return text.length;
      if (doubled && text[found + 1] === close) { at = found + 2; continue; }
      return found + 1;
    }
  };
  let first = true;
  let ended = false;
  let at = 0;
  while (at < text.length) {
    const char = text[at]!;
    if (/\s/.test(char)) { at++; continue; }
    let end: number;
    let comment = false;
    if (char === "-" && text[at + 1] === "-") {
      const newline = text.indexOf("\n", at);
      end = newline < 0 ? text.length : newline + 1;
      comment = true;
    } else if (char === "/" && text[at + 1] === "*") {
      const close = text.indexOf("*/", at + 2);
      end = close < 0 ? text.length : close + 2;
      comment = true;
    } else if (char === "'" || char === "\"" || char === "`") end = quoteEnd(at, char, true);
    else if (char === "[") end = quoteEnd(at, "]", false);
    else end = -1;
    if (end >= 0) {
      noneInside(at + 1, end);
      if (first) throw firstWord(comment ? "starts with a comment" : `starts with ${char}`);
      if (ended && !comment) throw new FrameworkError("A raw query runs one statement, and its text holds a second one after \";\"");
      at = end;
      continue;
    }
    if (char === ";") {
      if (first) throw firstWord("is empty before its \";\"");
      ended = true;
      at++;
      continue;
    }
    if (ended) throw new FrameworkError("A raw query runs one statement, and its text holds a second one after \";\"");
    if (WORD_START.test(char)) {
      let stop = at + 1;
      while (stop < text.length && WORD_PART.test(text[stop]!)) stop++;
      const word = text.slice(at, stop);
      if (first && !ALLOWED.has(word.toLowerCase())) throw firstWord(`starts with ${word}`);
      first = false;
      at = stop;
      continue;
    }
    if (first) throw firstWord(`starts with ${char}`);
    if (char === "?") {
      let stop = at + 1;
      while (stop < text.length && DIGIT.test(text[stop]!)) stop++;
      if (!placedAt.has(at) || stop > at + 1) throw textParameter(text.slice(at, stop));
      at = stop;
      continue;
    }
    if ((char === ":" || char === "@" || char === "#" || char === "$") && at + 1 < text.length && PARAMETER_NAME.test(text[at + 1]!)) {
      let stop = at + 1;
      while (stop < text.length && WORD_PART.test(text[stop]!)) stop++;
      throw textParameter(text.slice(at, stop));
    }
    at++;
  }
  if (first) throw firstWord("is empty");
  return text;
}

/**
 * E14's message: SQLite's own when the error came before any value was bound (`prepare`: a syntax error, `no such
 * table`), or when the statement has no values; otherwise a fixed text, and SQLite's message stays only in the cause.
 * Matching the values' text in the message is not enough: SQLite renders a value its own way (`0.30000000000000004` as
 * `'0.3'`, `1e21` as `'1.0e+21'`) and the SQL can transform it first (`upper(${v})`), so an error raised while the
 * values are bound may always carry one.
 */
function databaseMessage(message: string, bound: boolean): string {
  return bound
    ? "The raw query failed in the database while its values were bound, and SQLite's message can quote them: see the cause"
    : `The raw query failed in the database: ${message}`;
}

/** True for a SQLite error whose code starts with one of `prefixes`. */
function coded(cause: unknown, ...prefixes: string[]): boolean {
  const code = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" && prefixes.some((prefix) => code.startsWith(prefix));
}

/**
 * Run `statement` on `connection`, which holds the running transaction, synchronously. Resolves to the rows as stored:
 * each integer exact (a `number` when it is a safe integer, a `bigint` beyond), plain objects keyed by the statement's
 * column names. Every refusal is a `FrameworkError` that leaves the transaction open and unchanged; a lock is left as
 * SQLite raised it, for the layer to report as busy. `lex` is `sqliteText`; a test replaces it to reach the
 * `paramsCount` guard, which stands behind the lexer.
 */
export function rawQuery(connection: Database, statement: RawStatement, lex: (statement: RawStatement) => string = sqliteText): RawRow[] {
  const values = bindable(statement.values);
  const text = lex(statement);
  let prepared: Statement | undefined;
  let rows: Record<string, unknown>[];
  let bound = false;
  connection.run("PRAGMA query_only = ON");
  try {
    // `prepare`, not `query`: `query` keeps every distinct text cached for the connection's life.
    prepared = connection.prepare(text);
    if (prepared.paramsCount !== values.length) throw new FrameworkError("A raw query's text holds a parameter the adapter did not place: every value goes in a ${…}, never in the text");
    const seen = new Set<string>();
    for (const name of prepared.columnNames) {
      if (seen.has(name))
        throw new FrameworkError(`A raw query's result names the column ${name} twice, and a row keeps one value per name: give each column its own alias`);
      seen.add(name);
    }
    // Per statement: the connection reads integers as numbers, which rounds one beyond 2^53.
    (prepared as unknown as { safeIntegers(on: boolean): void }).safeIntegers(true);
    bound = values.length > 0;
    rows = prepared.all(...values) as Record<string, unknown>[];
  } catch (cause) {
    if (cause instanceof MeshError || coded(cause, "SQLITE_BUSY", "SQLITE_LOCKED")) throw cause;
    if (coded(cause, "SQLITE_READONLY")) throw new FrameworkError("A raw query cannot write: the database refused the statement as a write", { cause });
    throw new FrameworkError(databaseMessage(cause instanceof Error ? cause.message : String(cause), bound), { cause });
  } finally {
    prepared?.finalize();
    connection.run("PRAGMA query_only = OFF");
  }
  if (!connection.inTransaction) throw new FrameworkError("A raw query ended the transaction it ran in: the data layer's connection is in an unknown state");
  for (const row of rows)
    for (const [name, value] of Object.entries(row))
      if (typeof value === "bigint" && Number.isSafeInteger(Number(value)))
        Object.defineProperty(row, name, { value: Number(value), writable: true, enumerable: true, configurable: true });
  return rows;
}

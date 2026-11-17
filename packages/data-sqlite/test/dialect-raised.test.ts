import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { sqliteDialect } from "../src/dialect.ts";

// `raised` decides which driver errors a policy guard's denial may be read from (ADR-0046, option B): only SQLite's own
// bad-JSON-path failure, in both its wordings, and never a wrapper's message.
describe("sqliteDialect.raised", () => {
  const raised = sqliteDialect.raised!;

  test("the bad JSON path error SQLite raises gives its message", () => {
    const db = new Database(":memory:");
    let error: unknown;
    try { db.query("select json_extract('{}', 'mesh:forbidden:abc:f:1')").get(); } catch (e) { error = e; }
    db.close();
    expect(error).toBeDefined();
    const message = raised(error);
    expect(message).toBeString();
    expect(message).toContain("mesh:forbidden:abc:f:1");
  });

  test("both wordings, with code SQLITE_ERROR, give the message", () => {
    expect(raised({ code: "SQLITE_ERROR", message: "bad JSON path: 'mesh:forbidden:n:f:1'" })).toBe("bad JSON path: 'mesh:forbidden:n:f:1'");
    expect(raised({ code: "SQLITE_ERROR", message: "JSON path error near 'mesh:forbidden:n:f:1'" })).toBe("JSON path error near 'mesh:forbidden:n:f:1'");
  });

  test("another code, another SQLite error, a marker not at the start or a wrapper give undefined", () => {
    expect(raised({ code: "SQLITE_CONSTRAINT_FOREIGNKEY", message: "bad JSON path: 'mesh:forbidden:n:f:1'" })).toBeUndefined();
    expect(raised({ message: "bad JSON path: 'mesh:forbidden:n:f:1'" })).toBeUndefined();
    expect(raised({ code: "SQLITE_ERROR", message: "malformed JSON" })).toBeUndefined();
    expect(raised({ code: "SQLITE_ERROR", message: "near 'x': bad JSON path: 'mesh:forbidden:n:f:1'" })).toBeUndefined();
    expect(raised({ code: "SQLITE_ERROR", message: 42 })).toBeUndefined();
    const wrapper = Object.assign(new Error("Failed query: params: bad JSON path: 'mesh:forbidden:n:f:1'"), {
      cause: { code: "SQLITE_CONSTRAINT_FOREIGNKEY", message: "FOREIGN KEY constraint failed" },
    });
    expect(raised(wrapper)).toBeUndefined();
  });

  test("a value that is not an object gives undefined", () => {
    for (const value of [undefined, null, "bad JSON path: 'x'", 1, true]) expect(raised(value)).toBeUndefined();
  });
});

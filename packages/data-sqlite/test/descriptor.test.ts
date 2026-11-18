import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqlite } from "@meshfw/data-sqlite";
import { FrameworkError, type DataAdapter, type DataLayer } from "@meshfw/runtime";

test("sqlite() is one frozen value: the data adapter descriptor and its data layer", () => {
  const options = { file: ":memory:" };
  const db = sqlite(options);
  const adapter: DataAdapter = db;
  const layer: DataLayer = db;
  expect(adapter).toMatchObject({ kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", options });
  expect(Object.keys(db).sort()).toEqual(["build", "capabilities", "close", "database", "kind", "name", "options", "readOutbox", "refuseIfFailed", "transaction"]);
  // each :memory: layer is a database of its own, so each names it apart: core keeps a claim and a registry per name
  const other = sqlite(options);
  expect(db.database).toMatch(/^:memory: #\d+$/);
  expect(other.database).toMatch(/^:memory: #\d+$/);
  expect(other.database).not.toBe(db.database);
  expect(typeof layer.transaction).toBe("function");
  expect(typeof layer.close).toBe("function");
  expect(Object.isFrozen(db)).toBe(true);
  expect(Object.isFrozen(db.options)).toBe(true);
  options.file = "changed.db";
  expect(db.options.file).toBe(":memory:");
  expect("createSchema" in db).toBe(false);
});

// That making the descriptor opens no file (a build imports mesh.config.ts freely) is `layer.test.ts`, "closing before
// first use never opens a file".
test.each(["", " ", undefined, null, 42])("rejects invalid SQLite file %j with a FrameworkError", (file) => {
  expect(() => sqlite({ file: file as string })).toThrow(FrameworkError);
  expect(() => sqlite({ file: file as string })).toThrow('sqlite requires a non-empty file; pass { file: ":memory:" } or a database path');
});

test("rejects missing options", () => {
  // SAFETY: deliberately crosses the typed boundary, as an untyped config would.
  expect(() => sqlite(undefined as never)).toThrow(FrameworkError);
});

// `DataLayer.database` is the deliverer's identity for a database (`runtime/src/data-layer.ts`): every layer object over
// one file names it alike, however the path is spelled, and another file differently. Nothing is opened to name it.
test("layers over one file share one database name, absolute; another file has its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-descriptor-"));
  try {
    const file = join(dir, "app.db");
    const one = sqlite({ file });
    // Spelled by hand: `join` would normalise it to `file` and prove nothing.
    const same = sqlite({ file: `${dir}/./sub/../app.db` });
    const other = sqlite({ file: join(dir, "other.db") });
    expect(one.database).toBe(file);
    expect(same.database).toBe(one.database);
    expect(other.database).not.toBe(one.database);
    // A relative path names the file it resolves to from the working directory.
    expect(sqlite({ file: "app.db" }).database).toBe(join(process.cwd(), "app.db"));
    expect(sqlite({ file: "./app.db" }).database).toBe(sqlite({ file: "app.db" }).database);
    expect(existsSync(file)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


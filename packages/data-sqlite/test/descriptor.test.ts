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
  expect(Object.keys(db).sort()).toEqual(["build", "capabilities", "close", "kind", "name", "options", "transaction"]);
  expect(typeof layer.transaction).toBe("function");
  expect(typeof layer.close).toBe("function");
  expect(Object.isFrozen(db)).toBe(true);
  expect(Object.isFrozen(db.options)).toBe(true);
  options.file = "changed.db";
  expect(db.options.file).toBe(":memory:");
  expect("createSchema" in db).toBe(false);
});

test("making the descriptor opens no database, so a build can import mesh.config.ts freely", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-descriptor-"));
  try {
    const db = sqlite({ file: join(dir, "app.db") });
    expect(existsSync(db.options.file)).toBe(false);
    await db.close();
    expect(existsSync(db.options.file)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each(["", " ", undefined, null, 42])("rejects invalid SQLite file %j with a FrameworkError", (file) => {
  expect(() => sqlite({ file: file as string })).toThrow(FrameworkError);
  expect(() => sqlite({ file: file as string })).toThrow('sqlite requires a non-empty file; pass { file: ":memory:" } or a database path');
});

test("rejects missing options", () => {
  // SAFETY: deliberately crosses the typed boundary, as an untyped config would.
  expect(() => sqlite(undefined as never)).toThrow(FrameworkError);
});

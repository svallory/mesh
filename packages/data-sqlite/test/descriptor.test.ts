import { expect, test } from "bun:test";
import { sqlite } from "@meshfw/data-sqlite";
import type { DataAdapter } from "@meshfw/runtime";

test("SQLite returns an isolated frozen descriptor, not a connection", () => {
  const options = { file: ":memory:" };
  const descriptor: DataAdapter = sqlite(options);
  expect(descriptor).toEqual({ kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", options });
  expect(Object.isFrozen(descriptor)).toBe(true);
  expect(Object.isFrozen(descriptor.options)).toBe(true);
  options.file = "changed.db";
  expect(descriptor.options.file).toBe(":memory:");
  expect("close" in descriptor).toBe(false);
  expect("createSchema" in descriptor).toBe(false);
});

test.each(["", " ", undefined, null, 42])("rejects invalid SQLite file %j", (file) => {
  expect(() => sqlite({ file: file as string })).toThrow("sqlite requires a non-empty file path");
});

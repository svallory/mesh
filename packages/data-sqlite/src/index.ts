import type { DataAdapter } from "@meshfw/runtime";

/** Select SQLite at build time; no database is opened by this descriptor. */
export function sqlite(options: { file: string }): DataAdapter {
  if (!options || typeof options.file !== "string" || !options.file.trim()) {
    throw new TypeError("sqlite requires a non-empty file path");
  }
  return Object.freeze({
    kind: "data-adapter",
    name: "sqlite",
    build: "@meshfw/data-sqlite/build",
    options: Object.freeze({ file: options.file }),
  });
}

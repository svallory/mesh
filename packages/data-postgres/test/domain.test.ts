// data-sqlite's end-to-end domain suites (packages/data-sqlite/test/domain/) on Postgres: relationships, rollups (the
// per-row count and max, and the batched sum, avg, min and belongs-to rollups),
// has-many through, the action lifecycle, policies, validate-when and integer keys. They reach what the conformance
// suites do not (compiled reads, loads and actions over generated tables) through the commands where this adapter differs
// from SQLite's (`returning`, row locks, `bigint` and `count` mapping, and offset without limit through a compiled read).
// Each layer runs in a schema of its own, cloned from the suite's generated tables.
import { describe } from "bun:test";
import type { DomainAdapter } from "../../data-sqlite/test/domain/harness.ts";
import { keyTypesSuite } from "../../data-sqlite/test/domain/key-types.ts";
import { lifecycleSuite } from "../../data-sqlite/test/domain/lifecycle.ts";
import { loadSuite } from "../../data-sqlite/test/domain/load.ts";
import { policiesSuite } from "../../data-sqlite/test/domain/policies.ts";
import { readsLoadSuite } from "../../data-sqlite/test/domain/reads-load.ts";
import { rollupsSuite } from "../../data-sqlite/test/domain/rollups.ts";
import { throughSuite } from "../../data-sqlite/test/domain/through.ts";
import { validateWhenSuite } from "../../data-sqlite/test/domain/validate-when.ts";
import build from "../src/build.ts";
import { describeServer, lazyDatabases } from "./support.ts";

describeServer("the domain suites on Postgres", () => {
  const databases = lazyDatabases();
  const postgres: DomainAdapter = {
    name: "postgres",
    build,
    data: (capabilities) => ({
      kind: "data-adapter", name: "postgres", build: "@meshfw/data-postgres/build",
      capabilities: { adapter: "postgres", capabilities: [...capabilities] }, options: { url: undefined },
    }),
    // A Postgres integer is 64-bit, read back as a JavaScript number.
    integerColumn: (name) => `bigint("${name}", { mode: "number" })`,
    layer: (tables) => databases.layerFor(tables),
  };
  describe("key types", () => keyTypesSuite(postgres));
  describe("load", () => loadSuite(postgres));
  describe("reads with load", () => readsLoadSuite(postgres));
  describe("rollups", () => rollupsSuite(postgres));
  describe("has-many through", () => throughSuite(postgres));
  describe("lifecycle", () => lifecycleSuite(postgres));
  describe("policies", () => policiesSuite(postgres));
  describe("validate when", () => validateWhenSuite(postgres));
});

import build from "../../src/build.ts";
import { createSchema, sqlite } from "../../src/index.ts";
import type { DomainAdapter } from "./harness.ts";

/** The domain suites over an in-memory SQLite database per layer. */
export const sqliteDomain: DomainAdapter = {
  name: "sqlite",
  build,
  data: (capabilities) => ({
    kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build",
    capabilities: { adapter: "sqlite", capabilities: [...capabilities] }, options: { file: ":memory:" },
  }),
  async layer(tables) {
    const db = sqlite({ file: ":memory:" });
    await createSchema(db, tables);
    return db;
  },
};

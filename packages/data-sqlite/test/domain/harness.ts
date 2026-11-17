import { resolve } from "node:path";
import type { AdapterBuild, ResolvedConfig } from "@meshfw/compiler";
import type { Capability, DataLayer, TableHandle } from "@meshfw/runtime";

/**
 * What a domain suite needs from a SQL adapter: its build half, the descriptor a project's config would give, and a
 * fresh layer with the generated tables prepared. data-sqlite's end-to-end files call each suite with an in-memory
 * SQLite layer; data-postgres's `test/domain.test.ts` calls the same suites with a layer over a schema of its own.
 */
export interface DomainAdapter {
  /** The adapter's name, as the descriptor and the test titles give it. */
  readonly name: string;
  /** The build half that emits `.mesh/schema.ts`. */
  readonly build: AdapterBuild;
  /** The descriptor of `mesh.config.ts`'s `data`, declaring `capabilities` (each suite names the ones its domain needs). */
  data(capabilities: readonly Capability[]): ResolvedConfig["data"];
  /** A new, empty layer with `tables` (the generated `tables` of `.mesh/schema.ts`) prepared; the test closes it. */
  layer(tables: Readonly<Record<string, TableHandle>>): Promise<DataLayer>;
}

/**
 * Where the suites put their generated projects (`.scratch-*`, git-ignored): data-sqlite's test folder for every
 * adapter, so the generated files resolve `@meshfw/runtime`, `drizzle-orm` and `zod` from this package.
 */
export const SCRATCH = resolve(import.meta.dir, "..");

/** The workspace's TypeScript compiler, for the suites that type-check generated files. */
export const TSC = resolve(import.meta.dir, "../../../../node_modules/.bin/tsc");

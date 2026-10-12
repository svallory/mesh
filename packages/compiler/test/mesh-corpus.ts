// Helpers for the corpus tests: `parseEntity` lowers a source as `parseEntitySource` (`src/front-end/build.ts`) does, with the
// frozen contracts of the corpus (see fixtures/mesh-corpus/README.md), and `corpusFiles` lists the corpus.
import { lowerSource, type CustomTag, type Dialect, type LowerSourceResult } from "@mxlang/core";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { deepFreeze } from "../src/front-end/deep-freeze.ts";
import { MESH_DIALECT } from "../src/front-end/dialect.ts";
import contractsModule from "./fixtures/mesh-corpus/contracts.ts";

export const CORPUS = join(import.meta.dir, "fixtures/mesh-corpus");
export const GOLDEN = join(CORPUS, "__golden__/golden.json");
const contracts = contractsModule as Record<string, CustomTag>;

const withContracts = new WeakMap<Dialect, Dialect>();
/** The frozen contracts replace the live ones on the dialect; its strictness and tag rules stay the dialect's own. One object per dialect, deep-frozen, because MX (since alpha.22) checks a dialect once only when every plain object and array in it is frozen, and re-checks any other on every call (46 ms against 3 ms). */
function withCorpusContracts(dialect: Dialect): Dialect {
  let found = withContracts.get(dialect);
  if (!found) withContracts.set(dialect, (found = deepFreeze({ ...dialect, contracts })));
  return found;
}

/** `parseEntitySource` (`src/front-end/build.ts`) with the contracts of the corpus and the dialect as a parameter. */
export function parseEntity(source: string, file: string, dialect: Dialect = MESH_DIALECT): LowerSourceResult {
  return lowerSource(source, file, { dialect: withCorpusContracts(dialect) });
}

/** Every `.mesh.mx` file under the corpus, by its path relative to it, sorted. */
export function corpusFiles(dir = CORPUS): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...corpusFiles(path));
    else if (entry.name.endsWith(".mesh.mx")) files.push(relative(CORPUS, path));
  }
  return files.sort();
}

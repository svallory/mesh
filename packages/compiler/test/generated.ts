import { resolve } from "node:path";
import type { ResolvedConfig } from "../src/config.ts";
import { checkTypesInMemory } from "./type-server.ts";

/** A resolved config rooted at `root`, writing to `<root>/<output>`, with the SQLite descriptor. */
export const configOf = (
  root: string,
  output = "generated",
): ResolvedConfig => ({
  root,
  configFile: resolve(root, "mesh.config.ts"),
  entityFiles: [],
  domainRoot: root,
  data: { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: { file: ":memory:" } },
  output: resolve(root, output),
});

/** Type-check a fixture through the shared TypeScript API server, with its own compiler options and augmentations. */
export async function checkTypes(root: string, files: readonly string[]) {
  return checkTypesInMemory(root, files);
}

/** Reuse one project, replacing its fixture roots each call; reserve this path for independent module fixtures. */
export async function checkBatchedTypes(root: string, files: readonly string[]) {
  return checkTypesInMemory(root, files, true);
}

/** The real `tsc` binary on a fixture, keeping the CLI path covered. */
export function checkTypesBinary(root: string, files: string[]) {
  const child = Bun.spawnSync(
    [
      resolve(import.meta.dir, "../../../node_modules/.bin/tsc"),
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--noUncheckedIndexedAccess",
      "--module",
      "esnext",
      "--moduleResolution",
      "bundler",
      "--target",
      "es2022",
      "--skipLibCheck",
      "--noUnusedLocals",
      "--noUnusedParameters",
      "--exactOptionalPropertyTypes",
      "--verbatimModuleSyntax",
      "--isolatedModules",
      // The generated actions import @meshfw/runtime, whose sources import with `.ts`.
      "--allowImportingTsExtensions",
      ...files,
    ],
    { cwd: root },
  );
  return {
    code: child.exitCode,
    output: child.stdout.toString() + child.stderr.toString(),
  };
}

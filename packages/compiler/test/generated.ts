import { resolve } from "node:path";
import type { ResolvedConfig } from "../src/config.ts";

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

/** Type-check generated files with the strictest flags a consuming project might use. */
export function checkTypes(root: string, files: string[]) {
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

// PRJ-20: the committed generated trees of the two examples read no global by its own name outside `$globals.ts`, as
// the TypeScript checker resolves their names (`free-globals.ts`). The fixture of entities named after globals is held
// to the same check, and to a strict tsc run, in packages/cli/test/generated-names.test.ts.
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { freeGlobals } from "./free-globals.ts";

const repo = resolve(import.meta.dir, "../../..");

describe("generated code reaches globals only through $globals.ts", () => {
  test.each(["blog", "hyper"])("examples/%s/.mesh", async (example) => {
    const root = join(repo, "examples", example);
    const files = readdirSync(join(root, ".mesh"), { recursive: true }).map(String).filter((name) => name.endsWith(".ts"));
    expect(files).toContain("$globals.ts");
    expect(await freeGlobals(join(root, "tsconfig.json"), files.map((name) => join(root, ".mesh", name)))).toEqual([]);
  }, 60_000);
});

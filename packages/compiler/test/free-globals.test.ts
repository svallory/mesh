// the committed generated trees of the two examples read no global by its own name outside `$globals.ts`, as
// the TypeScript checker resolves their names (`free-globals.ts`). The fixture of entities named after globals is held
// to the same check, and to a strict tsc run, in packages/cli/test/generated-names.test.ts.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { closeTypeServer } from "./type-server.ts";
afterAll(closeTypeServer);
import { readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freeGlobals } from "./free-globals.ts";

const repo = resolve(import.meta.dir, "../../..");
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("freeGlobals", () => {
  // The guard's own coverage: a planted file reads globals in every position generated code could, and the check must
  // report each read and nothing else.
  test("reports each read of a global, a shorthand property's included, and no member, key, local or $globals.ts", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh-free-globals-"));
    roots.push(root);
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", lib: ["ES2022"], module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true, types: [] },
      include: ["*.ts"],
    }));
    // `$globals.ts` is where generated code takes globals from, so it may name them.
    await writeFile(join(root, "$globals.ts"), "export const $Promise = Promise;\n");
    await writeFile(join(root, "planted.ts"), [
      'import { $Promise } from "./$globals";',
      "export const shorthand = { Promise, Date };",
      "export const call = Promise.resolve(1);",
      "export type Typed = Record<string, ReadonlyArray<number>>;",
      "export const spread = { ...Object.freeze({}) };",
      "export default Map;",
      // None of these reads a global: members, keys, a local and an import named like one, `undefined`.
      "const Set = 1;",
      "export const local = { Set, $Promise, key: undefined };",
      "export const keys = { Promise: 1, WeakMap: 2 };",
      "export const member = keys.Promise + call.then.length;",
      "export const { Promise: renamed } = keys;",
    ].join("\n") + "\n");
    const found = await freeGlobals(join(root, "tsconfig.json"), [join(root, "$globals.ts"), join(root, "planted.ts")]);
    expect(found.map(({ name, line, declaredIn }) => `${line}:${name} (${declaredIn})`)).toEqual([
      "2:Promise (lib.es5.d.ts)",
      "2:Date (lib.es5.d.ts)",
      "3:Promise (lib.es5.d.ts)",
      "4:Record (lib.es5.d.ts)",
      "4:ReadonlyArray (lib.es5.d.ts)",
      "5:Object (lib.es5.d.ts)",
      "6:Map (lib.es2015.collection.d.ts)",
    ]);
    expect(found.every(({ file }) => file === "planted.ts")).toBe(true);
  }, 60_000);
});

describe("generated code reaches globals only through $globals.ts", () => {
  test.each(["blog", "hyper"])("examples/%s/.mesh", async (example) => {
    const root = join(repo, "examples", example);
    const files = readdirSync(join(root, ".mesh"), { recursive: true }).map(String).filter((name) => name.endsWith(".ts"));
    expect(files).toContain("$globals.ts");
    expect(await freeGlobals(join(root, "tsconfig.json"), files.map((name) => join(root, ".mesh", name)))).toEqual([]);
  }, 60_000);
});

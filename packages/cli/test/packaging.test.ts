// PRJ-22 packaging. Application code imports `Mesh` from meshfw at run time, so a project whose run-time code does needs
// meshfw as a regular dependency, and meshfw must share the project's one copy of @meshfw/runtime: the entity symbol and
// the WeakMaps behind `Mesh.privileged` are private to each copy, so a second copy makes `Mesh.privileged(Task)` throw.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../..");
type Manifest = Partial<Record<"dependencies" | "devDependencies" | "peerDependencies", Record<string, string>>>;
const manifest = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;

test("meshfw takes @meshfw/runtime as a peer dependency, never as its own", () => {
  const cli = manifest(join(repo, "packages/cli"));
  expect(cli.dependencies?.["@meshfw/runtime"]).toBeUndefined();
  expect(cli.peerDependencies?.["@meshfw/runtime"]).toBe("workspace:*");
  expect(cli.devDependencies?.["@meshfw/runtime"]).toBe("workspace:*");
});

/** Whether a TypeScript file under `dir` (tests and generated code aside) imports from "meshfw". */
function runTimeImportsMeshfw(dir: string): boolean {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts") && !path.split(/[\\/]/).some((part) => part === "node_modules" || part === "test" || part === ".mesh"))
    .some((path) => /from\s+["']meshfw["']/.test(readFileSync(join(dir, path), "utf8")));
}

test("an example whose run-time code imports meshfw lists it as a regular dependency", () => {
  const examples = readdirSync(join(repo, "examples"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const moved = examples.filter((name) => runTimeImportsMeshfw(join(repo, "examples", name, "src")));
  expect(moved).toEqual(["hyper"]);
  for (const name of examples) {
    const example = manifest(join(repo, "examples", name));
    if (moved.includes(name)) {
      expect(example.dependencies?.meshfw, name).toBe("workspace:*");
      expect(example.devDependencies?.meshfw, name).toBeUndefined();
    } else expect(example.devDependencies?.meshfw, name).toBe("workspace:*");
  }
});

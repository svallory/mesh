// Packaging (lead, PRJ-22). Application code imports `Mesh` from meshfw at run time, so a project whose run-time code does needs
// meshfw as a regular dependency. Every Mesh package that uses @meshfw/runtime (meshfw, the compiler and the data
// packages, not only meshfw) must share the project's one copy of it: the entity symbol and the WeakMaps behind
// `Mesh.privileged` are private to each copy, so a second copy makes `Mesh.privileged(Task)` throw.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../..");
type Manifest = Partial<Record<"dependencies" | "devDependencies" | "peerDependencies", Record<string, string>>>;
const manifest = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;

test("every Mesh package that uses @meshfw/runtime takes it as a peer dependency, never as its own", () => {
  const using = readdirSync(join(repo, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "runtime")
    .map((entry) => entry.name)
    .filter((name) => {
      const m = manifest(join(repo, "packages", name));
      return [m.dependencies, m.peerDependencies, m.devDependencies].some((fields) => fields?.["@meshfw/runtime"] !== undefined);
    })
    .sort();
  expect(using).toEqual(["cli", "compiler", "data-drizzle", "data-sqlite", "jsonrpc"]);
  for (const name of using) {
    const pkg = manifest(join(repo, "packages", name));
    expect(pkg.dependencies?.["@meshfw/runtime"], name).toBeUndefined();
    expect(pkg.peerDependencies?.["@meshfw/runtime"], name).toBe("workspace:*");
    expect(pkg.devDependencies?.["@meshfw/runtime"], name).toBe("workspace:*");
  }
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

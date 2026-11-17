// `max-limit=` end to end (mesh-limit-cap, ruling D38). The fixture (`fixtures/read-limit-cap/domain/shop`) caps Item's
// reads at 2; Box has many Items and an update whose step reads `Item.read({})`. The project is built by the real `mesh`
// command and run on SQLite in memory with three items: a caller read gets the cap, a larger `limit` is refused before
// the policies, a privileged read and a has-many load are not capped, and domain code that reads through the entity value is.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InvalidInputError } from "@meshfw/runtime";

const repo = resolve(import.meta.dir, "../../..");
const fixture = join(import.meta.dir, "fixtures/read-limit-cap/domain");
const projects: string[] = [];

const CONFIG = `const adapter: string = "@meshfw/data-sqlite";
const { sqlite } = (await import(adapter)) as { sqlite(options: { file: string }): { readonly name: string } };
export default { domain: "domain", output: ".mesh", data: sqlite({ file: ":memory:" }) };
`;
const PACKAGE = {
  name: "read-limit-cap", private: true, type: "module",
  imports: { "#mesh": "./.mesh/index.ts", "#mesh/domain": "./.mesh/domain/index.ts", "#mesh/domain/*": "./.mesh/domain/*/index.ts" },
};

/** A project outside the repo with the fixture's domain, the SQLite adapter and the packages linked in. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "read-limit-cap-"));
  projects.push(root);
  await cp(fixture, join(root, "domain"), { recursive: true });
  await writeFile(join(root, "mesh.config.ts"), CONFIG);
  await writeFile(join(root, "package.json"), `${JSON.stringify(PACKAGE, null, 2)}\n`);
  // Bun's isolated linker keeps workspace dependencies at each package, so the project links what it imports.
  await mkdir(join(root, "node_modules/@meshfw"), { recursive: true });
  await mkdir(join(root, "node_modules/@types"), { recursive: true });
  await symlink(join(repo, "packages/cli"), join(root, "node_modules/meshfw"));
  for (const name of ["compiler", "model", "runtime", "data-sqlite"]) {
    await symlink(join(repo, "packages", name), join(root, "node_modules/@meshfw", name));
  }
  // The adapter's own dependencies (its query library and zod), as a project that installs it has them: the generated
  // schema and validators import them from the project.
  const adapterModules = join(repo, "packages/data-sqlite/node_modules");
  for (const name of await readdir(adapterModules)) {
    if (name.startsWith(".") || name.startsWith("@")) continue;
    await symlink(await realpath(join(adapterModules, name)), join(root, "node_modules", name));
  }
  await symlink(await realpath(join(repo, "node_modules/@types/bun")), join(root, "node_modules/@types/bun"));
  return root;
}

function mesh(root: string, ...args: string[]) {
  const child = Bun.spawnSync([process.execPath, join(repo, "packages/cli/src/bin.ts"), ...args], { cwd: root });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

let root: string;
beforeAll(async () => {
  root = await project();
  expect(mesh(root, "build")).toEqual({ code: 0, stdout: "", stderr: "0 errors, 0 warnings\n" });
}, 30_000);
afterAll(async () => {
  for (const dir of projects.splice(0)) await rm(dir, { recursive: true, force: true });
});

type Row = { id: string };
type Read = (input: Record<string, unknown>, context: object) => Promise<Row[]>;

describe("a capped read on SQLite", () => {
  test("the cap bounds caller reads only", async () => {
    const app = await import(join(root, ".mesh/index.ts"));
    const domain = await import(join(root, ".mesh/domain/index.ts"));
    const { seen } = await import(join(root, "domain/shop/probe.ts")) as { seen: number[] };
    const { Mesh: ProjectMesh } = await import(Bun.resolveSync("meshfw", root)) as { Mesh: { privileged(entity: unknown): { read(input: object): Promise<Row[]> } } };
    const { sqlite, createSchema } = await import(Bun.resolveSync("@meshfw/data-sqlite", root));
    const layer = sqlite({ file: ":memory:" });
    await createSchema(layer, app.tables);
    const binding = app.bind(layer);
    const { Item, Box } = domain.shop as {
      Item: { create: (input: object, context: object) => Promise<Row>; read: Read };
      Box: { create: (input: object, context: object) => Promise<Row>; read: Read; count: (input: object, context: object) => Promise<Row> };
    };
    const refusal = async (run: () => Promise<unknown>) => {
      const error = await run().then(() => undefined, (cause: unknown) => cause);
      expect(error).toBeInstanceOf(InvalidInputError);
      return (error as InvalidInputError).issues;
    };
    try {
      await binding.run(async () => {
        const box = await Box.create({ label: "one" }, {});
        for (const name of ["a", "b", "c"]) await Item.create({ name, box: box.id }, {});
        // No `limit`: the cap. A `limit` at the cap or below is kept; above it is refused.
        expect(await Item.read({}, {})).toHaveLength(2);
        expect(await Item.read({ limit: 1 }, {})).toHaveLength(1);
        expect(await Item.read({ limit: 2, offset: 2 }, {})).toHaveLength(1);
        expect(await refusal(() => Item.read({ limit: 3 }, {}))).toEqual([{
          label: null, code: "too_big", path: ["limit"], message: "must be at most 2", details: null,
          source: { file: "domain/shop/item.mesh.mx", line: 10, column: 24 },
        }]);
        // The policies deny a system caller (`[]`), but the cap runs first: a refused `limit` is the error, not `[]`.
        expect(await Item.read({}, { system: true })).toEqual([]);
        await refusal(() => Item.read({ limit: 3 }, { system: true }));
        // A privileged read is not capped.
        expect(await ProjectMesh.privileged(Item).read({})).toHaveLength(3);
        // A has-many load reads the related rows directly, not through Item's read action: not capped.
        const [loaded] = await Box.read({ load: ["items"] }, {}) as unknown as { items: Row[] }[];
        expect(loaded!.items).toHaveLength(3);
        // Domain code that reads through the entity value is a caller read: capped.
        seen.length = 0;
        await Box.count({ id: box.id }, {});
        expect(seen).toEqual([2]);
      });
    } finally {
      await layer.close();
    }
  }, 30_000);
});

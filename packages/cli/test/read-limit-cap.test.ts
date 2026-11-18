// `max-limit=` end to end (mesh-limit-cap, ruling D38). The fixture (`fixtures/read-limit-cap/domain/shop`) caps Item's
// reads at 2; Box has many Items and an update whose step reads `Item.read({})`. The project is built by the real `mesh`
// command and run on SQLite in memory with three items: a caller read gets the cap, a larger `limit` is refused before
// the policies, a privileged read and a has-many load are not capped, and domain code that reads through the entity value is.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { InvalidInputError } from "@meshfw/runtime";
import { mesh, project as sharedProject, removeProjects } from "./project.ts";

const fixture = join(import.meta.dir, "fixtures/read-limit-cap/domain");

const project = () => sharedProject({ prefix: "read-limit-cap-", name: "read-limit-cap", domain: fixture });

let root: string;
beforeAll(async () => {
  root = await project();
  expect(mesh(root, "build")).toEqual({ code: 0, stdout: "", stderr: "0 errors, 0 warnings\n" });
}, 30_000);
afterAll(removeProjects);

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
        expect(await ProjectMesh.privileged(Item).read({ limit: 10_000 })).toHaveLength(3);
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

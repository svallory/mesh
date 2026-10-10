// A belongs-to key column takes the type of the target's key: integer for an integer-keyed target.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { InvalidInputError } from "@meshfw/runtime";
import build from "../src/build.ts";
import { createSchema, sqlite } from "../src/index.ts";

const order = `entity :Order table="orders"
  attributes
    integer :id primary-key
    string :label
  actions auto=[:read]
    create :place
      input
        &label
`;
const line = `import { Order } from "./order.mesh.mx"
entity :Line table="lines"
  attributes
    uuid :id primary-key
  relationships
    belongs-to :order entity=Order
    belongs-to :replaces entity=Order nullable
  actions auto=[:read]
    create :add
      input
        &order
        &replaces
`;

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dir, ".key-types-"));
  const config: ResolvedConfig = {
    root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"),
    data: { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: ["integer-key-fill"] }, options: { file: ":memory:" } },
  };
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: [
    { file: "src/domain/order.mesh.mx", source: order }, { file: "src/domain/line.mesh.mx", source: line }] });
  expect(built.diagnostics).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

test("the record, the input and the schema column all take the integer key's type", async () => {
  const types = await Bun.file(join(dir, ".mesh/line.types.ts")).text();
  expect(types).toMatch(/orderId: number;/);
  expect(types).toMatch(/replacesId: number \| null;/);
  expect(types).toMatch(/order: Order\["id"\];/);
  expect(await Bun.file(join(dir, ".mesh/line.validators.ts")).text()).toContain("order: z.int(),");
  const schema = await Bun.file(join(dir, ".mesh/schema.ts")).text();
  expect(schema).toMatch(/orderId: integer\("orderId"\)\.notNull\(\)/);
  expect(schema).toMatch(/replacesId: integer\("replacesId"\),/);
  await writeFile(join(dir, "check.ts"), `import type { Line } from "./.mesh/line.types";
import type { LineFilter } from "./.mesh/line.types";
import { lineTable } from "./.mesh/schema";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export const same: Equal<typeof lineTable.$inferSelect, Line> = true;
export const orderIsNumber: Equal<Line["orderId"], number> = true;
export const replacesIsNullable: Equal<Line["replacesId"], number | null> = true;
// The filter on the key column takes numbers, not strings.
export const filterOk: LineFilter = { orderId: { eq: 1 } };
// @ts-expect-error a text value is not an integer key
export const filterBad: LineFilter = { orderId: { eq: "1" } };
`);
  const tsc = join(import.meta.dir, "../../../node_modules/.bin/tsc");
  const result = Bun.spawnSync([tsc, "--ignoreConfig", "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--skipLibCheck",
    "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--allowImportingTsExtensions", "--types", "bun", join(dir, "check.ts")], { cwd: dir });
  expect(result.stdout.toString() + result.stderr.toString()).toBe("");
});

test("a line points at an order by its integer key, and that key reads back as a number", async () => {
  const { bind, tables } = await import(join(dir, ".mesh/index.ts")) as { bind: (layer: ReturnType<typeof sqlite>) => any; tables: Record<string, object> };
  const db = sqlite({ file: ":memory:" });
  try {
    await createSchema(db, tables);
    const app = bind(db);
    const first = await app.placeOrder({ label: "first" });
    const second = await app.placeOrder({ label: "second" });
    expect([first.id, second.id]).toEqual([1, 2]);
    const added = await app.addLine({ order: second.id, replaces: first.id });
    expect(added).toMatchObject({ orderId: 2, replacesId: 1 });
    expect(typeof added.orderId).toBe("number");
    expect(await app.addLine({ order: first.id })).toMatchObject({ orderId: 1, replacesId: null });
    expect(await app.readLine({ filter: { orderId: { eq: 2 } } })).toEqual([added]);
    // A text key is not an integer key.
    await expect(app.addLine({ order: "2" as never })).rejects.toBeInstanceOf(InvalidInputError);
  } finally { await db.close(); }
});

// The emitted schema used as-is: written to disk, type-checked against the records
// the types generator writes, imported, pushed with createSchema and round-tripped.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { ATTRIBUTE_TYPES } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import type { TableHandle } from "@meshfw/runtime";
import build from "../src/build.ts";
import { createSchema, sqlite } from "../src/index.ts";

// One attribute of every registered type, nullable and not, plus a relationship key column.
const sample = `import { Owner } from "./owner.mesh.mx"
entity :Sample table="samples"
  attributes
    uuid :id primary-key
    string :name
    integer :count
    float :ratio
    decimal :amount
    boolean :active
    enum :state values=[:draft, :live]
    date :dueOn
    datetime :seenAt
    timestamp :insertedAt on=:create
    string :note nullable
    integer :maybeCount nullable
    boolean :maybeActive nullable
    enum :maybeState values=[:on, :off] nullable
    timestamp :maybeAt nullable
    json :payload
    json :extra nullable
  relationships
    belongs-to :owner entity=Owner
    belongs-to :reviewer entity=Owner nullable
`;
const owner = `entity :Owner table="owners"
  attributes
    uuid :id primary-key
`;

let dir: string;
beforeAll(async () => {
  // Inside the package, so the emitted file resolves this package's drizzle-orm.
  dir = await mkdtemp(join(import.meta.dir, ".emitted-"));
  const config: ResolvedConfig = {
    root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"),
    data: { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: { file: ":memory:" } },
  };
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: [
    { file: "src/domain/sample.mesh.mx", source: sample }, { file: "src/domain/owner.mesh.mx", source: owner }] });
  expect(built.diagnostics).toEqual([]);
  const document = built.document as ModelDocument;
  // Every registered attribute type is in the sample.
  expect([...new Set(document.entities.flatMap((entity) => entity.attributes.map((attribute) => attribute.type)))].sort())
    .toEqual(ATTRIBUTE_TYPES.map((type) => type.name).sort());
  await writeGeneratedFiles(await generateFiles({ config, document }, build), config);
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

test("each column's inferred TypeScript type equals the record type the types generator writes", async () => {
  await writeFile(join(dir, "check.ts"), `import type { Owner } from "./.mesh/owner.types";
import type { Sample } from "./.mesh/sample.types";
import { ownerTable, sampleTable, tables } from "./.mesh/schema";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export const sampleMatches: Equal<typeof sampleTable.$inferSelect, Sample> = true;
export const ownerMatches: Equal<typeof ownerTable.$inferSelect, Owner> = true;
// The comparison is strict: one changed member makes it false.
export const strict: Equal<typeof sampleTable.$inferSelect, Omit<Sample, "dueOn"> & { dueOn: string }> = false;
export const map: Equal<keyof typeof tables, "owner" | "sample"> = true;
`);
  const tsc = join(import.meta.dir, "../../../node_modules/.bin/tsc");
  const result = Bun.spawnSync([tsc, "--ignoreConfig", "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--skipLibCheck",
    "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--types", "bun", join(dir, "check.ts")], { cwd: dir });
  expect(result.stdout.toString() + result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

test("the emitted schema is usable as-is: createSchema, then every type round-trips through the adapter", async () => {
  const { tables, sampleTable, ownerTable } = await import(join(dir, ".mesh/schema.ts")) as Record<string, TableHandle> & { tables: Record<string, TableHandle> };
  const db = sqlite({ file: ":memory:" });
  try {
    await createSchema(db, tables);
    const row = {
      id: "00000000-0000-4000-8000-000000000001", name: "first", count: 3, ratio: 0.5, amount: 12.25, active: true,
      state: "live", dueOn: new Date("2026-10-09T00:00:00.000Z"), seenAt: new Date("2026-10-09T10:11:12.345Z"),
      insertedAt: new Date("2026-10-09T10:11:12.346Z"), note: null, maybeCount: null, maybeActive: false, maybeState: null,
      maybeAt: null, payload: { list: [1, "two", { three: null }], flag: true }, extra: null, ownerId: "00000000-0000-4000-8000-0000000000aa", reviewerId: null,
    };
    await db.transaction(async (tx) => {
      await tx.insert(ownerTable!, { id: row.ownerId });
      expect(await tx.insert(sampleTable!, row)).toEqual(row);
    });
    await db.transaction(async (tx) => {
      const stored = await tx.selectByKey(sampleTable!, { id: row.id });
      expect(stored).toEqual(row);
      expect(stored!.dueOn).toBeInstanceOf(Date);
      expect(stored!.active).toBe(true);
      expect(stored!.maybeActive).toBe(false);
      // A json column returns the value, not its text: an object here, an array and a scalar below.
      expect(stored!.payload).toEqual({ list: [1, "two", { three: null }], flag: true });
      expect(stored!.extra).toBeNull();
    });
    await db.transaction(async (tx) => {
      const other = { ...row, id: "00000000-0000-4000-8000-000000000002", payload: [1, [2, 3], { a: "b" }], extra: "text" };
      expect(await tx.insert(sampleTable!, other)).toEqual(other);
      const third = { ...row, id: "00000000-0000-4000-8000-000000000003", payload: 0, extra: false };
      expect(await tx.insert(sampleTable!, third)).toEqual(third);
      expect((await tx.selectByKey(sampleTable!, { id: other.id }))!.payload).toEqual([1, [2, 3], { a: "b" }]);
      expect((await tx.selectByKey(sampleTable!, { id: third.id }))!.extra).toBe(false);
    });
  } finally { await db.close(); }
});

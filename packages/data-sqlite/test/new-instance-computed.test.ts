// What a create's check gets for a computed field on the new instance (ACT-27), the run-time half of the `<E>NewScope`
// type: the computed field is loaded onto the new instance and its body runs over the nulls, so a translated body follows
// the null rule (null when it reads a member nothing has filled), a plain body returns what its own code makes of the
// nulls, and a computed field over filled members has its value. On an update the stored record gives the stored values.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { openPolicies } from "./open-policy.ts";
import build from "../src/build.ts";
import { InvalidInputError, type Issue } from "@meshfw/runtime";
import { createSchema, sqlite } from "../src/index.ts";

const box = `entity :Box table="boxes"
  attributes
    uuid :id primary-key
    integer :qty
    enum :state values=[:open, :done] default=:open
  computed
    integer :double() { return &qty * 2 }
    integer :twice() { return &double + 1 }
    integer :plain({ self }) { const q = self.qty; return q === null ? 0 : q + 1 }
    boolean :isOpen() { return &state === :open }
  actions auto=[:read]
    create :make
      input
        &qty
      validate
        check :double that=() => false details=() => ({ v: &double }) code="double" message="m"
        check :twice that=() => false details=() => ({ v: &twice }) code="twice" message="m"
        check :plain that=() => false details=() => ({ v: &plain }) code="plain" message="m"
        check :isOpen that=() => false details=() => ({ v: &isOpen }) code="isOpen" message="m"
        check :usesDouble that=() => &double > 0 code="usesDouble" message="m"
    update :bump
      input
        &qty
      validate
        check :double that=() => false details=() => ({ v: &double }) code="double" message="m"
        check :isOpen that=() => false details=() => ({ v: &isOpen }) code="isOpen" message="m"
`;
const SQLITE: ResolvedConfig["data"] = {
  kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build",
  capabilities: { adapter: "sqlite", capabilities: ["aggregates", "integer-key-fill"] }, options: { file: ":memory:" },
};
let dir: string;
let app: any;
beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dir, ".new-instance-computed-"));
  const config: ResolvedConfig = { root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"), data: SQLITE };
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: openPolicies([{ file: "src/domain/box.mesh.mx", source: box }]) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  await Bun.write(join(dir, "mesh.config.ts"), "export default { data: { name: 'sqlite', transaction: async () => undefined, close: async () => undefined } };\n");
  app = await import(join(dir, ".mesh/index.ts"));
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

/** The failed checks of a call, by code, with the details each gave. */
const issues = (error: unknown): Record<string, unknown> => {
  expect(error).toBeInstanceOf(InvalidInputError);
  return Object.fromEntries((error as InvalidInputError).issues.map((issue: Issue) => [issue.code, issue.details]));
};

describe("a computed field on a create's new instance", () => {
  test("a translated body over a member nothing has filled is null, not undefined and not a throw; one over filled members has its value", async () => {
    const db = sqlite({ file: ":memory:" });
    await createSchema(db, app.tables);
    const mesh = app.bind(db, {});
    const found = issues(await mesh.makeBox({ qty: 4 }, {}).catch((e: unknown) => e));
    // double reads qty (null before the input), twice reads double: both null. isOpen reads the default state.
    expect(found.double).toEqual({ v: null });
    expect(found.twice).toEqual({ v: null });
    expect(found.isOpen).toEqual({ v: true });
    // A plain body returns what its own code makes of the null (here the author's own null test).
    expect(found.plain).toEqual({ v: 0 });
    // The unknown value fails the check, as for any unknown `that`.
    expect(found.usesDouble).toBeNull();
  });
  test("on an update the same computed fields have the stored record's values", async () => {
    const db = sqlite({ file: ":memory:" });
    await createSchema(db, app.tables);
    const mesh = app.bind(db, {});
    // A create whose checks pass cannot be built from this entity (its checks always fail); insert the row directly.
    const id = "018f0000-0000-7000-8000-000000000001";
    await db.transaction(async (tx: any) => { await tx.insert(app.tables.boxes, { id, qty: 4, state: "open" }); });
    const found = issues(await mesh.bumpBox({ id, qty: 9 }, {}).catch((e: unknown) => e));
    expect(found.double).toEqual({ v: 8 });
    expect(found.isOpen).toEqual({ v: true });
  });
});

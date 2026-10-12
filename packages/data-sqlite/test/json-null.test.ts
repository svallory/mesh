// ENT-03: a json attribute or argument accepts any JSON value and null, whether or not it says `nullable`.
// A domain with json attributes is built, generated, pushed to SQLite and called through the generated functions.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel, generateFiles, writeGeneratedFiles, type ResolvedConfig } from "@meshfw/compiler";
import { callsOf } from "./calls.ts";
import { openPolicies } from "./open-policy.ts";
import { FrameworkError, InvalidInputError } from "@meshfw/runtime";
import build from "../src/build.ts";
import { createSchema, sqlite } from "../src/index.ts";

const doc = `entity :Doc table="docs"
  attributes
    uuid :id primary-key
    string :title
    json :payload
    json :extra default={ kept: true }
    json :flag nullable
  actions auto=[:read]
    create :make
      input
        &title
        &payload
        &extra
        &flag
    create :bare
      input
        &title
    create :tagged
      input
        &title
        json :note
        json :loud nullable
    update :change
      input
        &payload
        &extra
`;

let dir: string;
let app: any;
let domain: object;
let diagnostics: { severity: string; code: string; position: { line: number; column: number } }[];
beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dir, ".jsonnull-"));
  const config: ResolvedConfig = {
    root: dir, configFile: join(dir, "mesh.config.ts"), entityFiles: [], domainRoot: join(dir, "src/domain"), output: join(dir, ".mesh"),
    data: { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: { file: ":memory:" } },
  };
  const built = buildModel({ root: dir, domainRoot: join(dir, "src/domain"), files: openPolicies([{ file: "src/domain/doc.mesh.mx", source: doc }]) });
  diagnostics = built.diagnostics as typeof diagnostics;
  expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  await writeGeneratedFiles(await generateFiles({ config, document: built.document as ModelDocument }, build), config);
  app = await import(join(dir, ".mesh/index.ts"));
  domain = await import(join(dir, ".mesh/domain/index.ts"));
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

async function fresh() {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, app.tables);
  return { db, mesh: callsOf(app.bind(db, {}), domain) };
}
async function rejection(call: Promise<unknown>): Promise<unknown> {
  try { await call; } catch (error) { return error; }
  throw new Error("expected the call to reject");
}

describe("the build", () => {
  test("warns once on each `nullable` written on a json, at the word, and on no other json", () => {
    const warnings = diagnostics.filter((d) => d.code === "MESH_JSON_NULLABLE");
    expect(warnings.map((d) => [d.severity, d.position.line, d.position.column])).toEqual([["warning", 7, 15], ["warning", 22, 19]]);
    expect(diagnostics.filter((d) => d.code !== "MESH_JSON_NULLABLE")).toEqual([]);
  });
});

describe("the schema", () => {
  test("no json column is NOT NULL, and a plain column still is", async () => {
    const schema = await Bun.file(join(dir, ".mesh/schema.ts")).text();
    const column = (name: string) => schema.split("\n").find((line) => line.includes(`"${name}"`))!;
    expect(column("title")).toContain(".notNull()");
    for (const name of ["payload", "extra", "flag"]) expect(column(name)).not.toContain(".notNull()");
  });
});

describe("a create", () => {
  test("stores null for a json that is not sent and has no default, and applies a default", async () => {
    const { db, mesh } = await fresh();
    try {
      const row = await mesh.bareDoc({ title: "a" });
      expect(row).toMatchObject({ payload: null, extra: { kept: true }, flag: null });
      expect((await mesh.readDoc({}))[0]).toMatchObject({ payload: null, extra: { kept: true }, flag: null });
      // Sent members: a missing one is null, a default applies only when the field is missing.
      expect(await mesh.makeDoc({ title: "b" })).toMatchObject({ payload: null, extra: { kept: true }, flag: null });
    } finally { await db.close(); }
  });

  test("keeps a sent null, even where a default exists, and every JSON value round-trips", async () => {
    const { db, mesh } = await fresh();
    try {
      expect(await mesh.makeDoc({ title: "n", payload: null, extra: null, flag: null })).toMatchObject({ payload: null, extra: null, flag: null });
      for (const value of [{}, [], "s", "", 0, 1.5, true, false, { a: [1, { b: null }] }, [null, [[]]]]) {
        const row = await mesh.makeDoc({ title: "v", payload: value, extra: value, flag: value });
        expect(row).toMatchObject({ payload: value, extra: value, flag: value });
      }
      const all = await mesh.readDoc({});
      expect(all).toHaveLength(11);
      expect(all[1].payload).toEqual({});
    } finally { await db.close(); }
  });

  test("rejects what JSON cannot hold, and stores nothing", async () => {
    const { db, mesh } = await fresh();
    try {
      const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
      for (const value of [() => 1, new Date(), new Map(), Symbol("s"), 1n, Number.NaN, Number.POSITIVE_INFINITY, { a: undefined }, new (class X {})()])
        expect(await rejection(mesh.makeDoc({ title: "bad", payload: value }))).toBeInstanceOf(InvalidInputError);
      // Pinned, as before ENT-03: the validator lets a cyclic object through; the data layer cannot serialise it, and the write fails.
      expect(await rejection(mesh.makeDoc({ title: "bad", payload: cyclic }))).toBeInstanceOf(FrameworkError);
      expect(await mesh.readDoc({})).toEqual([]);
    } finally { await db.close(); }
  });
});

describe("an update", () => {
  test("sets a json to null, and leaves it alone when it is not sent", async () => {
    const { db, mesh } = await fresh();
    try {
      const row = await mesh.makeDoc({ title: "u", payload: { a: 1 }, extra: [1] });
      expect(await mesh.changeDoc({ id: row.id, payload: null })).toMatchObject({ payload: null, extra: [1] });
      expect(await mesh.changeDoc({ id: row.id, extra: { z: 1 } })).toMatchObject({ payload: null, extra: { z: 1 } });
      expect(await rejection(mesh.changeDoc({ id: row.id, payload: Number.NaN }))).toBeInstanceOf(InvalidInputError);
    } finally { await db.close(); }
  });
});

describe("a json argument", () => {
  test("accepts null and any JSON value, with or without `nullable`, and is never required", async () => {
    const { db, mesh } = await fresh();
    try {
      for (const note of [null, {}, [], "s", 0, false, { a: [null] }])
        expect(await mesh.taggedDoc({ title: "t", note, loud: note })).toMatchObject({ title: "t" });
      expect(await mesh.taggedDoc({ title: "t" })).toMatchObject({ title: "t" });
      for (const note of [Number.NaN, 1n, () => 1, new Date()])
        expect(await rejection(mesh.taggedDoc({ title: "t", note }))).toBeInstanceOf(InvalidInputError);
    } finally { await db.close(); }
  });
});

describe("the read inputs filter and sort", () => {
  test("are not attributes: they still reject null", async () => {
    const { db, mesh } = await fresh();
    try {
      expect(await rejection(mesh.readDoc({ filter: null }))).toBeInstanceOf(InvalidInputError);
      expect(await rejection(mesh.readDoc({ sort: null }))).toBeInstanceOf(InvalidInputError);
      expect(await mesh.readDoc({})).toEqual([]);
      expect(await mesh.readDoc({ filter: undefined, sort: undefined })).toEqual([]);
    } finally { await db.close(); }
  });
});

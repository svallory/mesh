// ENT-03: a json attribute or argument accepts null with or without `nullable`; `nullable` on it warns.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildModel } from "../src/front-end/build.ts";
import { generateFiles, writeGeneratedFiles } from "../src/typescript/emit.ts";
import { actionsView } from "../src/typescript/views/actions.ts";
import { typesView } from "../src/typescript/views/types.ts";
import { configOf } from "./generated.ts";
import { build, keyed } from "./v4.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const warnings = (source: string) => build(source).diagnostics.filter((d) => d.code === "MESH_JSON_NULLABLE");

describe("the warning on `nullable` of a json", () => {
  test("is a warning, not an error: the build still yields a document, with the attribute nullable", () => {
    const result = build(keyed + "    json :data nullable\n");
    expect(result.document).not.toBeNull();
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      severity: "warning", code: "MESH_JSON_NULLABLE", message: "a json attribute already accepts null, so `nullable` on it has no effect", fix: "remove `nullable`",
    })]);
    expect(result.document!.entities[0]!.attributes.find((a) => a.name === "data")!.nullable).toBe(true);
  });

  test("points at the word `nullable`", () => {
    const source = keyed + "    string :title\n    json :data default={} nullable\n";
    const [warning] = warnings(source);
    expect(warning!.position.line).toBe(5);
    expect(source.split("\n")[4]!.slice(warning!.position.column)).toStartWith("nullable");
  });

  test("a json without `nullable` does not warn, and is nullable in the model", () => {
    const result = build(keyed + "    json :data\n    json :other default={ a: 1 }\n");
    expect(result.diagnostics).toEqual([]);
    expect(result.document!.entities[0]!.attributes.filter((a) => a.type === "json").map((a) => a.nullable)).toEqual([true, true]);
  });

  test("`nullable` on any other type does not warn, and a non-nullable one stays non-nullable", () => {
    const result = build(keyed + "    string :a nullable\n    integer :b\n    float :c nullable\n");
    expect(result.diagnostics).toEqual([]);
    expect(result.document!.entities[0]!.attributes.filter((a) => a.type !== "uuid").map((a) => a.nullable)).toEqual([true, false, true]);
  });

  test("warns once per `nullable`, for an attribute and for an argument", () => {
    const source = keyed + "    json :a nullable\n    json :b\n    json :c nullable\n  actions\n    create :make\n      input\n        json :note nullable\n        json :plain\n";
    const found = warnings(source);
    expect(found.map((d) => d.position.line)).toEqual([4, 6, 10]);
    expect(build(source).document).not.toBeNull();
  });

  test("a json argument is nullable in the model, with or without `nullable`", () => {
    const source = keyed + "  actions\n    create :make\n      input\n        json :note nullable\n        json :plain\n";
    const action = build(source).document!.entities[0]!.actions.find((a) => a.name === "make")!;
    expect(action.input.filter((i) => i.kind === "argument").map((i) => (i as { nullable: boolean }).nullable)).toEqual([true, true]);
  });

  test("`default=null` is accepted on a json, nullable or not", () => {
    expect(build(keyed + "    json :data default=null\n").diagnostics).toEqual([]);
    expect(codesOf(keyed + "    json :data nullable default=null\n")).toEqual(["MESH_JSON_NULLABLE"]);
  });
});
const codesOf = (source: string) => build(source).diagnostics.map((d) => d.code);

describe("a create and a json", () => {
  const note = `entity :Note table="notes"
  attributes
    uuid :id primary-key
    string :title
    json :payload
    json :filled default={ a: 1 }
  actions auto=[:read]
    create :create
      input
        &title
        &payload
        &filled
    create :bare
      input
        &title
        json :extra
`;

  async function generated() {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-jsonnull-"));
    roots.push(root);
    const built = buildModel({ root, files: [{ file: "m/note.mesh.mx", source: note }] });
    expect(built.diagnostics).toEqual([]);
    const config = configOf(root);
    const files = await generateFiles({ document: built.document!, config });
    await writeGeneratedFiles(files, config);
    await writeFile(resolve(root, "generated/schema.ts"), "export const tables = { notes: {} };\n");
    return { root, document: built.document!, files };
  }

  test("is not required to send a json; a create without one stores null, and a default still applies", async () => {
    const { document } = await generated();
    const view = actionsView({ document, config: configOf("/p") }, document.entities[0]!);
    const statements = view.methods.find((m) => m.name === "bare")!.statements.join("\n");
    expect(statements).toContain("payload: null");
    expect(statements).toContain('filled: {"a":1}');
    const sent = view.methods.find((m) => m.name === "create")!.statements.join("\n");
    expect(sent).toContain('payload: $Object.hasOwn(parsed, "payload") && parsed.payload !== undefined ? parsed.payload : null');
    expect(sent).toContain('filled: $Object.hasOwn(parsed, "filled") && parsed.filled !== undefined ? parsed.filled : {"a":1}');
  });

  test("the types: the record and the inputs say unknown, and a json input is optional on a create", async () => {
    const { document } = await generated();
    const view = typesView({ document, config: configOf("/p") }, document.entities[0]!);
    expect(view.record.members.map((m) => `${m.key}: ${m.type}`)).toEqual(["id: string", "title: string", "payload: unknown", "filled: unknown"]);
    const create = view.inputs.find((i) => i.name === "CreateNoteInput")!;
    expect(create.members.map((m) => `${m.key}${m.optional ? "?" : ""}: ${m.type}`)).toEqual(["title: string", "payload?: unknown | undefined", "filled?: unknown | undefined"]);
    const bare = view.inputs.find((i) => i.name === "BareNoteInput")!;
    expect(bare.members.map((m) => `${m.key}${m.optional ? "?" : ""}`)).toEqual(["title", "extra?"]);
  });

  test("the validators accept null and every JSON value, reject what JSON cannot hold, and take no json as required", async () => {
    const { root } = await generated();
    const { createNoteInputSchema, bareNoteInputSchema, readNoteInputSchema } = await import(resolve(root, "generated/domain/m/note.validators.ts"));
    const create = (payload: unknown) => createNoteInputSchema.safeParse({ title: "t", payload }).success;
    for (const value of [null, {}, [], "", "s", 0, -1.5, true, false, { a: [1, { b: null }] }, [null, [[]]], undefined]) expect(create(value)).toBe(true);
    for (const value of [() => 1, new Date(), new Map(), Symbol("s"), 1n, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, { a: undefined }, { a: () => 1 }, [undefined], new (class X {})()])
      expect(create(value)).toBe(false);
    expect(createNoteInputSchema.safeParse({ title: "t" }).success).toBe(true);
    expect(createNoteInputSchema.safeParse({ title: "t", filled: null }).success).toBe(true);
    expect(createNoteInputSchema.safeParse({}).success).toBe(false);
    for (const extra of [null, {}, [1], "s", 0, false]) expect(bareNoteInputSchema.safeParse({ title: "t", extra }).success).toBe(true);
    expect(bareNoteInputSchema.safeParse({ title: "t" }).success).toBe(true);
    for (const extra of [Number.NaN, 1n, () => 1, new Date()]) expect(bareNoteInputSchema.safeParse({ title: "t", extra }).success).toBe(false);
    // A cyclic object: pinned as before ENT-03 (the schema is Zod's `z.json()`; it is the data layer that cannot store it).
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    let outcome: boolean | "threw";
    try { outcome = createNoteInputSchema.safeParse({ title: "t", payload: cyclic }).success; } catch { outcome = "threw"; }
    expect(outcome).toBe(true);
    // The internal read inputs are not attributes: they keep rejecting null.
    expect(readNoteInputSchema.safeParse({}).success).toBe(true);
    expect(readNoteInputSchema.safeParse({ filter: null }).success).toBe(false);
    expect(readNoteInputSchema.safeParse({ sort: null }).success).toBe(false);
    expect(readNoteInputSchema.safeParse({ filter: {}, sort: ["id"] }).success).toBe(true);
  });
});

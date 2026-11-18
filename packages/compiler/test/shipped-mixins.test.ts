import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildResult } from "../src/model/project.ts";
import { buildModel, parseEntitySource } from "../src/front-end/build.ts";
import { SHIPPED_MIXIN_NAMES, shippedMixinText } from "../src/front-end/shipped-mixins.ts";
import { generateFiles } from "../src/typescript/emit.ts";
import { configOf } from "./generated.ts";

// Mesh's shipped mixins (`notes/architecture/mixins-design.md` PR 3, ruling D37): `Timestamps` and `Versioned`, imported by
// name from "meshfw/mixins" and included with `use mixin=Name`; their lines are positioned at the `use` line (OD5, R20).
// The run-time behaviour is `packages/cli/test/shipped-mixins.test.ts`.

const build = (files: Record<string, string>, root = "/p"): BuildResult =>
  buildModel({ root, files: Object.entries(files).map(([file, source]) => ({ file, source })) });
/** Each diagnostic as `[code, file:line:column, message]`. */
const found = (result: BuildResult) => result.diagnostics.map((d) => [d.code, `${d.position.file}:${d.position.line}:${d.position.column}`, d.message]);
const entityOf = (result: BuildResult, name: string) => result.document!.entities.find((entity) => entity.name === name)!;

const IMPORT = 'import { Timestamps, Versioned } from "meshfw/mixins"\n';
/** `notes.Note`, using what `uses` writes (line 4 on), with its own attributes and actions after. */
const note = (uses: string, actions = "", imports = IMPORT, attributes = "") =>
  `${imports}\nentity :Note\n${uses}  attributes\n    uuid :id primary-key\n    string :body\n${attributes}  actions auto=[:create, :read, :update]\n${actions}`;
const BOTH = "  use mixin=Timestamps\n  use mixin=Versioned\n";

/** Every source position under a value, at any depth. */
function positionsIn(value: unknown, out: { file: string; line: number; column: number }[] = []) {
  if (Array.isArray(value)) for (const item of value) positionsIn(item, out);
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.file === "string" && typeof record.line === "number") out.push(record as never);
    else for (const item of Object.values(record)) positionsIn(item, out);
  }
  return out;
}

describe("the shipped files", () => {
  test("each parses with no diagnostic as `mixin :Name`", () => {
    expect(SHIPPED_MIXIN_NAMES).toEqual(["Timestamps", "Versioned"]);
    for (const name of SHIPPED_MIXIN_NAMES) {
      const text = shippedMixinText(name)!;
      const parsed = parseEntitySource(text.source, text.file);
      expect([name, parsed.diagnostics]).toEqual([name, []]);
      expect(text.source.startsWith(`mixin :${name}\n`)).toBe(true);
    }
    expect(shippedMixinText("Nope")).toBeUndefined();
  });
  test("built into an entity, they raise nothing, every function translates (no plain) and they hold what OD1 rules", () => {
    const result = build({ "notes/note.mesh.mx": note(BOTH) });
    expect(found(result)).toEqual([]);
    const entity = entityOf(result, "Note");
    expect(entity.attributes.map((a) => [a.name, a.type, a.on ?? null, a.default ?? null])).toEqual([
      ["id", "uuid", null, null], ["body", "string", null, null],
      ["insertedAt", "timestamp", "create", null], ["updatedAt", "timestamp", "update", null], ["version", "integer", null, 1],
    ]);
    expect(entity.always).toHaveLength(1);
    const [block] = entity.always;
    expect(block!.types).toEqual(["update"]);
    expect(block!.actions).toBeUndefined();
    const set = block!.do[0]!;
    expect(set.kind).toBe("set");
    const value = (set as { assignments: { member: { name: string }; value: { tree?: unknown; plain?: unknown } }[] }).assignments[0]!;
    expect(value.member.name).toBe("version");
    expect(value.value.tree).toBeDefined();
    expect(value.value.plain).toBeUndefined();
  });
});

describe("importing from \"meshfw/mixins\" (R10)", () => {
  const result = (imports: string, uses = "") => build({ "notes/note.mesh.mx": note(uses, "", imports) });
  test.each([
    ["a namespace import", 'import * as m from "meshfw/mixins"\n'],
    ["a default import", 'import T from "meshfw/mixins"\n'],
    ["a type import", 'import type { Timestamps } from "meshfw/mixins"\n'],
    ["a type-only binding", 'import { type Timestamps } from "meshfw/mixins"\n'],
    ["a side-effect import", 'import "meshfw/mixins"\n'],
  ])("%s is MESH_IMPORT_FORM at the import", (_, imports) => {
    const built = result(imports);
    expect(found(built)).toEqual([["MESH_IMPORT_FORM", "notes/note.mesh.mx:1:0", 'import a mixin by name: "meshfw/mixins" gives the named exports `Timestamps` and `Versioned`']]);
    expect(built.diagnostics[0]!.fix).toBe('write `import { Timestamps } from "meshfw/mixins"`');
  });
  test("a name it does not give is MESH_UNKNOWN_IMPORT at the name, and a `use` of a refused import reports nothing more", () => {
    expect(found(result('import { Timestamps, Created } from "meshfw/mixins"\n', "  use mixin=Timestamps\n  use mixin=Created\n"))).toEqual([
      ["MESH_UNKNOWN_IMPORT", "notes/note.mesh.mx:1:21", '"meshfw/mixins" gives `Timestamps` and `Versioned`, and `Created` is not one of them'],
    ]);
    // An import of the same names in the wrong form: one error at the import, none at the `use` line.
    expect(found(result('import * as m from "meshfw/mixins"\n', "  use mixin=m.Timestamps\n")).map((d) => d[0])).toEqual(["MESH_IMPORT_FORM"]);
  });
  test("a name bound to no mixin is MESH_UNKNOWN_IMPORT at the `use` line's name, with the nearest imported mixin", () => {
    expect(found(result('import { Timestamps } from "meshfw/mixins"\n', "  use mixin=Timestamp\n"))).toEqual([
      ["MESH_UNKNOWN_IMPORT", "notes/note.mesh.mx:4:12", "Timestamp is not an imported mixin. Did you mean Timestamps?"],
    ]);
    expect(found(result("", "  use mixin=Versioned\n"))).toEqual([["MESH_UNKNOWN_IMPORT", "notes/note.mesh.mx:3:12", "Versioned is not an imported mixin."]]);
  });
  test("the mixin is looked up by its exported name: `Versioned as V` brings in Versioned's lines and no other's", () => {
    const aliased = result('import { Versioned as V } from "meshfw/mixins"\n', "  use mixin=V\n");
    expect(found(aliased)).toEqual([]);
    const entity = entityOf(aliased, "Note");
    expect(entity.attributes.map((a) => a.name)).toEqual(["id", "body", "version"]);
    expect(entity.always.map((block) => block.types)).toEqual([["update"]]);
    expect(entity.imports).toEqual([{ identifiers: ["V"], imported: ["Versioned"], from: "meshfw/mixins", mixin: true, position: { file: "notes/note.mesh.mx", line: 1, column: 0, offset: 0 } }]);
  });
  test("the model marks the import a mixin's, with no `helper`, and an import that no `use` reads is silent (R21)", () => {
    const built = result(IMPORT);
    expect(found(built)).toEqual([]);
    expect(entityOf(built, "Note").imports).toEqual([{ identifiers: ["Timestamps", "Versioned"], from: "meshfw/mixins", mixin: true, position: { file: "notes/note.mesh.mx", line: 1, column: 0, offset: 0 } }]);
    expect(entityOf(built, "Note").attributes.map((a) => a.name)).toEqual(["id", "body"]);
  });
  test("a shipped mixin's name read in a function is a free variable, not a helper call (R22)", () => {
    const built = build({ "notes/note.mesh.mx": note(BOTH).replace("  actions", "  computed\n    string :x() { return String(Timestamps()) }\n  actions") });
    expect(found(built).map((d) => d[0])).toEqual(["MESH_EXPR_FREE_VARIABLE"]);
    expect(built.diagnostics[0]!.message).toStartWith("`Timestamps` is not defined here");
  });
  test("a file that includes no mixin may not import them: an aggregate file", () => {
    const built = build({
      "notes/note.mesh.mx": note(""),
      "notes/notes.mesh.mx": `${IMPORT}import { Note } from "./note.mesh.mx"\n\naggregate :Notes\n  root entity=Note\n`,
    });
    expect(found(built)).toEqual([["MESH_UNKNOWN_IMPORT", "notes/notes.mesh.mx:1:0", "\"meshfw/mixins\" gives an entity file Mesh's mixins, which it includes with `use mixin=Name`, and this file includes none"]]);
  });
  test("in a file that includes no mixin, the path is refused before the form or the names (I4)", () => {
    const aggregate = (imports: string) => build({
      "notes/note.mesh.mx": note(""),
      "notes/notes.mesh.mx": `${imports}import { Note } from "./note.mesh.mx"\n\naggregate :Notes\n  root entity=Note\n`,
    });
    for (const imports of ['import * as m from "meshfw/mixins"\n', 'import { Nope } from "meshfw/mixins"\n'])
      expect(found(aggregate(imports))).toEqual([["MESH_UNKNOWN_IMPORT", "notes/notes.mesh.mx:1:0", "\"meshfw/mixins\" gives an entity file Mesh's mixins, which it includes with `use mixin=Name`, and this file includes none"]]);
  });
});

describe("positions (R20, ruling D37 OD5)", () => {
  test("every position a shipped mixin's lines give is the `use` line that includes it", () => {
    const result = build({ "notes/note.mesh.mx": note(BOTH) });
    const entity = entityOf(result, "Note");
    const at = (line: number) => ({ file: "notes/note.mesh.mx", line, column: 2 });
    const stamps = entity.attributes.filter((a) => a.name === "insertedAt" || a.name === "updatedAt");
    expect(new Set(positionsIn(stamps).map((p) => JSON.stringify({ file: p.file, line: p.line, column: p.column })))).toEqual(new Set([JSON.stringify(at(4))]));
    const versioned = [entity.attributes.find((a) => a.name === "version"), entity.always];
    const positions = positionsIn(versioned);
    expect(positions.length).toBeGreaterThan(5);
    expect(new Set(positions.map((p) => JSON.stringify({ file: p.file, line: p.line, column: p.column })))).toEqual(new Set([JSON.stringify(at(5))]));
  });
  test("a name the entity declares too is MESH_DUPLICATE_MEMBER at the `use` line; the same mixin twice, once", () => {
    expect(found(build({ "notes/note.mesh.mx": note(BOTH, "", IMPORT, "    timestamp :insertedAt on=:create\n") }))).toEqual([
      ["MESH_DUPLICATE_MEMBER", "notes/note.mesh.mx:4:2", "Duplicate member :insertedAt: the mixin Timestamps declares it, and so does Note"],
    ]);
    expect(found(build({ "notes/note.mesh.mx": note("  use mixin=Timestamps\n  use mixin=T\n", "", `${IMPORT}import { Timestamps as T } from "meshfw/mixins"\n`) }))).toEqual([
      ["MESH_DUPLICATE_MEMBER", "notes/note.mesh.mx:6:2", "Duplicate use of the mixin Timestamps: this entity already uses it"],
    ]);
  });
  test("Versioned and the entity's own `set &version` in an update: MESH_DUPLICATE_SET at the entity's member, naming Versioned at its `use` line (R28)", () => {
    const result = build({ "notes/note.mesh.mx": note(BOTH, "    update :edit\n      do\n        set\n          &version=() => &version + 1\n") });
    expect(found(result)).toEqual([
      ["MESH_DUPLICATE_SET", "notes/note.mesh.mx:13:10", "&version is already set in update :edit of notes.Note by the `always` block of the mixin Versioned (line 5), and a member is set once per action"],
    ]);
    expect(result.diagnostics[0]!.fix).toBe("remove this `&version=`: the mixin Versioned sets &version in every action its `always` block covers");
  });
  test("Versioned and the entity's own covering `always` block setting &version: reported at the entity's member, naming Versioned (R28)", () => {
    // Versioned's block sorts after the entity's own, so it is the later write, and its line is the `use` line.
    const declared = build({ "notes/note.mesh.mx": note(BOTH, "    always actions=[&edit]\n      do\n        set\n          &version=() => 10\n    update :edit\n") });
    expect(found(declared)).toEqual([
      ["MESH_DUPLICATE_SET", "notes/note.mesh.mx:13:10", "&version is already set in update :edit of notes.Note by the `always` block of the mixin Versioned (line 5), and a member is set once per action"],
    ]);
    expect(declared.diagnostics[0]!.fix).toBe("remove this `&version=`: the mixin Versioned sets &version in every action its `always` block covers");
    // A block covering the generated update, with its set under a step `when`.
    const auto = build({ "notes/note.mesh.mx": note(BOTH, "    always types=[:update]\n      do\n        when=() => true\n          set\n            &version=() => 5\n") });
    expect(found(auto)).toEqual([
      ["MESH_DUPLICATE_SET", "notes/note.mesh.mx:14:12", "&version is already set in update :update of notes.Note by the `always` block of the mixin Versioned (line 5), and a member is set once per action"],
    ]);
  });
  test("Versioned and `lock &version`: MESH_LOCK_MEMBER at the `use` line, naming Versioned, once (ruling D43 OD6)", () => {
    const result = build({ "notes/note.mesh.mx": note(BOTH, "    update :edit\n      do\n        lock &version\n    update :touch\n      do\n        lock &version optional\n") });
    expect(found(result)).toEqual([
      ["MESH_LOCK_MEMBER", "notes/note.mesh.mx:5:2", "`set &version` of the mixin Versioned, in update :edit of notes.Note, writes the version that `lock &version` (line 12) owns: the lock adds 1 on every write"],
    ]);
    expect(result.diagnostics[0]!.fix).toBe("stop using Versioned and declare `integer :version default=1` in the entity: the lock keeps the version itself");
  });
  test("legal neighbours: Versioned with an expected-version check, a `set &version` in a create the block does not cover, and a lock in a destroy", () => {
    // The block covers updates only: a destroy's lock compares the version the updates bump.
    expect(found(build({ "notes/note.mesh.mx": note(BOTH, "    destroy :drop\n      do\n        lock &version\n") }))).toEqual([]);
    expect(found(build({ "notes/note.mesh.mx": note(BOTH, `    create :make
      input
        &body
      do
        set
          &version=() => 1
    update :edit
      input
        &body
        integer :expectedVersion nullable
      validate
        check :versionMatches that=({ input }) => input.expectedVersion == null || input.expectedVersion === &version code="expected-version" message="stale"
`) }))).toEqual([]);
  });
});

describe("generated code", () => {
  test("an entity using Timestamps and Versioned generates what the same entity with their lines written inline generates, positions aside", async () => {
    const mixed = build({ "notes/note.mesh.mx": note(BOTH, "    update :edit\n      input\n        &body\n").replace("string :body\n", "string :body nullable\n") });
    const inline = build({ "notes/note.mesh.mx": `entity :Note
  attributes
    uuid :id primary-key
    string :body nullable
    timestamp :insertedAt on=:create
    timestamp :updatedAt on=:update
    integer :version default=1
  actions auto=[:create, :read, :update]
    update :edit
      input
        &body
    always types=[:update]
      do
        set
          &version=() => &version + 1
` });
    expect([found(mixed), found(inline)]).toEqual([[], []]);
    const files = async (result: BuildResult) => (await generateFiles({ document: result.document!, config: configOf("/p") }))
      .map((file) => [file.path, file.path.endsWith("model.json")
        // The model without the import line and the positions, which are the two differences.
        ? JSON.stringify(JSON.parse(file.contents, (key, value) => (key === "position" || key === "imports" ? undefined : value)), null, 2)
        : file.contents.replace(/notes\/note\.mesh\.mx:\d+:\d+/g, "notes/note.mesh.mx:L:C")] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    const [a, b] = [await files(mixed), await files(inline)];
    expect(a.map(([path]) => path)).toEqual(b.map(([path]) => path));
    for (const [index, [path, contents]] of a.entries()) expect([path, contents]).toEqual([path, b[index]![1]]);
  });
});

describe("the import paths of an entity file", () => {
  // One row per spec path and form (`notes/spec/imports-and-scope.md`, "Paths"), in an entity file of a project on
  // disk, so a helper path resolves.
  const root = mkdtempSync(join(tmpdir(), "mesh-import-paths-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "x"), { recursive: true });
  writeFileSync(join(root, "x/x.helpers.ts"), "export const h = () => 1;\n");
  const X = "entity :X\n  attributes\n    uuid :id primary-key\n";
  // "meshfw/architecture" is the architecture file's alone: an entity file is told so (`import-paths.test.ts` has the other kinds).
  const ARCHITECTURE = '"meshfw/architecture" gives Mesh\'s presets to the architecture file (architecture.mesh.mx), the one file that imports it';
  const OTHER = 'The import path must be relative (start with ./ or ../), or be "meshfw" for Mesh\'s own functions (`import { Mesh } from "meshfw"`) or "meshfw/mixins" for Mesh\'s mixins (`import { Timestamps } from "meshfw/mixins"`)';
  test.each([
    ['import { X } from "./x.mesh.mx"', []],
    ['import * as x from "./x.mesh.mx"', []],
    ['import { h } from "./x.helpers"', []],
    ['import * as hs from "./x.helpers"', []],
    ['import { Mesh } from "meshfw"', []],
    ['import Mesh from "meshfw"', ["MESH_IMPORT_FORM", 'import `Mesh` by name: "meshfw" gives an entity file the named export `Mesh` alone']],
    ['import * as M from "meshfw"', ["MESH_IMPORT_FORM", 'import `Mesh` by name: "meshfw" gives an entity file the named export `Mesh` alone']],
    ['import { Timestamps, Versioned } from "meshfw/mixins"', []],
    ['import Timestamps from "meshfw/mixins"', ["MESH_IMPORT_FORM", 'import a mixin by name: "meshfw/mixins" gives the named exports `Timestamps` and `Versioned`']],
    ['import { MeshRecommended } from "meshfw/architecture"', ["MESH_UNKNOWN_IMPORT", ARCHITECTURE]],
    ['import * as a from "meshfw/architecture"', ["MESH_UNKNOWN_IMPORT", ARCHITECTURE]],
    ['import a from "meshfw/architecture"', ["MESH_UNKNOWN_IMPORT", ARCHITECTURE]],
    ['import { x } from "meshfw/other"', ["MESH_UNKNOWN_IMPORT", OTHER]],
    ['import { z } from "zod"', ["MESH_UNKNOWN_IMPORT", OTHER]],
    // I4: a package path is refused by its path before its form.
    ['import z from "zod"', ["MESH_UNKNOWN_IMPORT", OTHER]],
    ['import { Mesh } from "@meshfw/runtime"', ["MESH_UNKNOWN_IMPORT", OTHER]],
  ] as [string, string[]][])("%s", (line, expected) => {
    const result = build({ "x/e.mesh.mx": `${line}\n\nentity :E\n  attributes\n    uuid :id primary-key\n`, "x/x.mesh.mx": X }, root);
    expect(result.diagnostics.map((d) => [d.code, d.message])).toEqual(expected.length ? [expected] : []);
  });
  test('"meshfw/architecture" is accepted in the architecture file', () => {
    const result = build({ "architecture.mesh.mx": 'import { MeshRecommended } from "meshfw/architecture"\n\narchitecture :project\n  use preset=MeshRecommended\n', "x/x.mesh.mx": X }, root);
    expect(result.diagnostics).toEqual([]);
  });
});

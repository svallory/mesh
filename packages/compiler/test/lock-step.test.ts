// The `lock` step (ADR-0100, design `notes/architecture/lock-relate-design.md`, PR 1): `lock &version` adds the input
// `expectedVersion`, compares it with the stored member after the record-reading policies and before `validate`, and an
// update writes the member plus 1. Each rule here is one row of the design's section 6, with its legal neighbours.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Diagnostic, ModelDocument } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";
import { derivedInputs } from "../src/model/derived-input.ts";
import { generateFiles, writeGeneratedFiles } from "../src/typescript/emit.ts";
import { explainAction } from "../src/typescript/explain.ts";
import { checkTypes, configOf } from "./generated.ts";
import { closeTypeServer } from "./type-server.ts";

afterAll(closeTypeServer);

/** A Note with a version, a has-many and a computed field, and the actions the case writes. */
const note = (actions: string, extra = "") => `import { Line } from "./line.mesh.mx"
${extra}entity :Note
  attributes
    uuid :id primary-key
    string :body nullable
    integer :version default=1
    integer :maybe nullable
  relationships
    has-many :lines entity=Line
  computed
    integer :twice({ self }) { return self.version * 2 }
  actions auto=[:create, :read]
${actions}`;
const line = 'import { Note } from "./note.mesh.mx"\nentity :Line\n  attributes\n    uuid :id primary-key\n  relationships\n    belongs-to :note entity=Note\n  actions auto=[:read]\n';
const built = (actions: string, extra = "", more: { file: string; source: string }[] = []) =>
  buildModel({ root: "/p", files: [{ file: "note.mesh.mx", source: note(actions, extra) }, { file: "line.mesh.mx", source: line }, ...more] });
const found = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => [d.code, d.position.line, d.position.column, d.message]);
const clean = (actions: string, extra = "", more: { file: string; source: string }[] = []) => {
  const result = built(actions, extra, more);
  expect(found(result.diagnostics)).toEqual([]);
  return result.document!;
};

describe("the lock line's syntax (MX)", () => {
  const codes = (step: string) => built(`    update :edit\n      do\n        ${step}\n`).diagnostics.map((d) => [d.code, d.message]);
  test("`lock &version` and `lock &version optional` build", () => {
    expect(codes("lock &version")).toEqual([]);
    expect(codes("lock &version optional")).toEqual([]);
  });
  test.each([
    ["a value after the member", "lock &version=1", "MESH_SYNTAX"],
    ["two members", "lock &version &body", "MESH_SYNTAX"],
    ["an atom", "lock :version", "MESH_UNKNOWN_OPTION"],
    ["a string, the old spelling", 'lock="version"', "MESH_UNKNOWN_OPTION"],
    ["no member", "lock", "MESH_MISSING_OPTION"],
    ["an unknown member", "lock &nope", "MESH_UNKNOWN_MEMBER"],
  ])("%s is %s", (_, step, code) => {
    expect(codes(step).map(([c]) => c)).toEqual([code]);
  });
  test("under `validate` it is MESH_TAG_NOT_ALLOWED", () => {
    expect(built("    update :edit\n      validate\n        lock &version\n").diagnostics.map((d) => d.code)).toEqual(["MESH_TAG_NOT_ALLOWED"]);
  });
  test("under a `validate` `when` and under a `check` it is MESH_TAG_NOT_ALLOWED", () => {
    expect(built("    update :edit\n      validate\n        when=() => true\n          lock &version\n").diagnostics.map((d) => d.code)).toEqual(["MESH_TAG_NOT_ALLOWED"]);
    expect(built('    update :edit\n      validate\n        check :fresh that=() => true code="f" message="f"\n          lock &version\n').diagnostics.map((d) => d.code)).toEqual(["MESH_TAG_NOT_ALLOWED"]);
  });
  test("`optional` stays a command field's option everywhere else", () => {
    expect(built("    update :edit\n      input\n        integer :n optional\n").diagnostics.map((d) => d.code)).toEqual(["MESH_UNKNOWN_OPTION"]);
  });
});

describe("MESH_LOCK_STEP", () => {
  test("a lock in a create's own `do`", () => {
    expect(found(built("    create :make\n      do\n        lock &version\n").diagnostics)).toEqual([
      ["MESH_LOCK_STEP", 15, 8, "create :make of Note has a `lock` step, and a create has no stored version to compare: a lock guards an update or a destroy"],
    ]);
  });
  test("a lock under a step `when`, which is dropped", () => {
    const result = built("    update :edit\n      do\n        when=() => true\n          lock &version\n");
    expect(found(result.diagnostics)).toEqual([
      ["MESH_LOCK_STEP", 16, 10, "a `lock` step under `when` would guard some calls and not others: it is written directly under `do`"],
    ]);
  });
  test("a lock in an `always` block with no scope, reported once at its line", () => {
    expect(found(built("    always\n      do\n        lock &version\n    update :edit\n    update :other\n").diagnostics)).toEqual([
      ["MESH_LOCK_STEP", 15, 8, "the `always` block at line 13 has no `types=` or `actions=`, so it covers every action, and has a `lock` step, and a lock guards only an update or a destroy"],
    ]);
  });
  test("a lock in an `always` block whose scope covers a create, by type or by name (the auto create too)", () => {
    expect(found(built("    always types=[:create, :update]\n      do\n        lock &version\n    update :edit\n").diagnostics)).toEqual([
      ["MESH_LOCK_STEP", 15, 8, "the `always` block at line 13 covers create :create of Note, and has a `lock` step, and a lock guards only an update or a destroy"],
    ]);
    expect(built("    always actions=[&make, &edit]\n      do\n        lock &version\n    create :make\n    update :edit\n").diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["MESH_LOCK_STEP", "the `always` block at line 13 covers create :make of Note, and has a `lock` step, and a lock guards only an update or a destroy"],
    ]);
  });
  test("two locks reaching one action: at the later line, naming the block", () => {
    expect(found(built("    always types=[:update]\n      do\n        lock &version\n    update :edit\n      do\n        lock &version\n").diagnostics)).toEqual([
      ["MESH_LOCK_STEP", 18, 8, "update :edit of Note has two `lock` steps (line 15 through the `always` block at line 13 and line 18): an action compares one version"],
    ]);
    expect(found(built("    update :edit\n      do\n        lock &version\n        lock &version\n").diagnostics).map(([code, l]) => [code, l])).toEqual([["MESH_LOCK_STEP", 16]]);
  });
});

describe("MESH_LOCK_MEMBER", () => {
  test.each([
    ["a string attribute", "body", "a string attribute"],
    ["a nullable integer", "maybe", "a nullable integer attribute"],
    ["the primary key", "id", "the primary key"],
    ["a relationship", "lines", "a relationship"],
    ["a computed field", "twice", "a computed field"],
  ])("the member is %s", (_, member, what) => {
    expect(found(built(`    update :edit\n      do\n        lock &${member}\n`).diagnostics)).toEqual([
      ["MESH_LOCK_MEMBER", 15, 13, `\`lock &${member}\`: &${member} is ${what} of Note, and a lock counts versions in a required integer attribute`],
    ]);
  });
  test("the member as an input of the locked action", () => {
    expect(found(built("    update :edit\n      input\n        &version\n      do\n        lock &version\n").diagnostics)).toEqual([
      ["MESH_LOCK_MEMBER", 15, 8, "&version is an input of update :edit of Note, and `lock &version` (line 17) owns it: the caller sends `expectedVersion`, and the lock writes &version"],
    ]);
  });
  test("a `set` of the member in the action, under a `when` too, and in a block that reaches it", () => {
    expect(found(built("    update :edit\n      do\n        lock &version\n        when=() => true\n          set\n            &version=2\n").diagnostics)).toEqual([
      ["MESH_LOCK_MEMBER", 18, 12, "`set &version` in update :edit of Note writes the version that `lock &version` (line 15) owns: the lock adds 1 on every write"],
    ]);
    expect(found(built("    always types=[:update]\n      do\n        set\n          &version=() => &version + 1\n    update :edit\n      do\n        lock &version\n").diagnostics).map(([code, l]) => [code, l])).toEqual([["MESH_LOCK_MEMBER", 16]]);
  });
});

describe("MESH_DUPLICATE_INPUT", () => {
  test("an authored input named like the field the lock adds", () => {
    expect(found(built("    update :edit\n      input\n        integer :expectedVersion nullable\n      do\n        lock &version\n").diagnostics)).toEqual([
      ["MESH_DUPLICATE_INPUT", 15, 8, "Input expectedVersion conflicts with the one `lock &version` (line 17) adds"],
    ]);
    expect(built("    update :edit\n      input\n        integer :expectedVersion nullable\n      do\n        lock &version\n").diagnostics.map((d) => d.fix)).toEqual(["rename the argument"]);
  });
  test("a member input named like the field the lock adds: the fix names the member, not an argument", () => {
    const source = note("    update :edit\n      input\n        &expectedVersion\n      do\n        lock &version\n").replace("    integer :maybe nullable\n", "    integer :maybe nullable\n    integer :expectedVersion nullable\n");
    const diagnostics = buildModel({ root: "/p", files: [{ file: "note.mesh.mx", source }, { file: "line.mesh.mx", source: line }] }).diagnostics;
    expect(diagnostics.map((d) => [d.code, d.position.line, d.message, d.fix])).toEqual([
      ["MESH_DUPLICATE_INPUT", 16, "Input expectedVersion conflicts with the one `lock &version` (line 18) adds", "remove `&expectedVersion` from `input`, or rename the attribute"],
    ]);
  });
});

describe("legal neighbours", () => {
  test("a lock in `always types=[:update, :destroy]` reaches a declared update and the auto update and destroy", async () => {
    const source = note("    always types=[:update, :destroy]\n      do\n        lock &version\n    update :edit\n").replace("actions auto=[:create, :read]", "actions auto=[:create, :read, :update, :destroy]");
    const result = buildModel({ root: "/p", files: [{ file: "note.mesh.mx", source }, { file: "line.mesh.mx", source: line }] });
    expect(found(result.diagnostics)).toEqual([]);
    const entity = result.document!.entities[0]!;
    const fields = (action: { kind: "update" | "destroy"; name: string }) => derivedInputs(entity, { ...action, do: [] }).map((f) => [f.name, f.required, f.nullable]);
    expect(fields({ kind: "update", name: "edit" })).toEqual([["expectedVersion", true, false]]);
    expect(fields({ kind: "update", name: "update" })).toEqual([["expectedVersion", true, false]]);
    expect(fields({ kind: "destroy", name: "destroy" })).toEqual([["expectedVersion", true, false]]);
    const files = new Map((await generateFiles({ document: result.document!, config: configOf("/p") })).map((file) => [file.path, file.contents]));
    const actions = files.get("generated/domain/note.actions.ts")!;
    const slice = (name: string, next?: string) => actions.slice(actions.indexOf(`"Note#${name}"`), next ? actions.indexOf(`"Note#${next}"`) : undefined);
    const names = [...actions.matchAll(/"Note#(\w+)"/g)].map((m) => m[1]!).filter((n, i, all) => all.indexOf(n) === i);
    const body = (name: string) => slice(name, names[names.indexOf(name) + 1]);
    for (const name of ["edit", "update", "destroy"]) expect(body(name)).toContain("if (parsed.expectedVersion !== $before.version)");
    expect(body("update")).toContain("$changes.version = $record.version = $before.version + 1;");
    expect(body("edit")).toContain("$changes.version = $record.version = $before.version + 1;");
    expect(body("destroy")).toContain("selectByKeyForUpdate(");
    expect(body("destroy")).not.toContain("$before.version + 1");
    const types = files.get("generated/domain/note.types.ts")!;
    for (const input of ["EditNoteInput", "UpdateNoteInput", "DestroyNoteInput"])
      expect(types).toMatch(new RegExp(`export type ${input} = \\{[^}]*expectedVersion: number;`));
  });
  test("an action with no lock has no derived field", () => {
    const entity = clean("    update :edit\n      input\n        &body\n").entities[0]!;
    expect(derivedInputs(entity, entity.actions[0]!)).toEqual([]);
  });
  test("the recipe written by hand on an action no lock reaches, beside a locked one", () => {
    clean(`    update :edit
      do
        lock &version
    update :manual
      input
        integer :expectedVersion nullable
      validate
        check :versionMatches [
          that=({ input }) => input.expectedVersion == null || input.expectedVersion === &version
          code="expected-version"
          message="stale"
        ]
      do
        set
          &version=() => &version + 1
`);
  });
  test("a check reading input.expectedVersion is typed integer on a locked action", () => {
    clean("    update :edit\n      validate\n        check :positive that=({ input }) => input.expectedVersion > 0 code=\"p\" message=\"p\"\n      do\n        lock &version\n");
  });
  test("a publish written before the lock is no MESH_PUBLISH_BEFORE_WRITE", () => {
    clean("    update :edit\n      do\n        publish=() => new Edited({ id: &id })\n        lock &version\n", 'import { Edited } from "./edited.mesh.mx"\n',
      [{ file: "edited.mesh.mx", source: "event :Edited\n  uuid :id\n" }]);
  });
  test("a named check reading input.expectedVersion: no MESH_CHECK_INPUT for a locked update, the error for an unlocked one", () => {
    const actions = (lockEdit: boolean) => `    update :edit
      validate
        check &fresh
${lockEdit ? "      do\n        lock &version\n" : ""}`;
    const withChecks = (body: string) => buildModel({ root: "/p", files: [
      { file: "note.mesh.mx", source: note(body).replace("  actions auto=", '  checks\n    check :fresh that=({ input }) => input.expectedVersion > 0 code="f" message="f"\n  actions auto=') },
      { file: "line.mesh.mx", source: line },
    ] }).diagnostics.map((d) => d.code);
    expect(withChecks(actions(true))).toEqual([]);
    expect(withChecks(actions(false))).toEqual(["MESH_CHECK_INPUT"]);
  });
});

describe("a command answering a locked action (MESH_COMMAND_INPUT)", () => {
  const answered = (fields: string, optional = false) => {
    const command = { file: "edit-note.mesh.mx", source: `command :EditNote\n  uuid :id\n${fields}` };
    return built(`    update on=EditNote\n      do\n        lock &version${optional ? " optional" : ""}\n`, 'import { EditNote } from "./edit-note.mesh.mx"\n', [command]).diagnostics.map((d) => [d.code, d.message]);
  };
  test("without expectedVersion it is refused, with it it builds, and an optional lock needs none", () => {
    expect(answered("")).toEqual([["MESH_COMMAND_INPUT", expect.stringContaining("`expectedVersion`, which `lock &version` adds")]]);
    expect(answered("  integer :expectedVersion\n")).toEqual([]);
    expect(answered("  integer :expectedVersion nullable\n").map(([code]) => code)).toEqual(["MESH_COMMAND_INPUT"]);
    expect(answered("  integer :expectedVersion optional\n").map(([code]) => code)).toEqual(["MESH_COMMAND_INPUT"]);
    expect(answered("  string :expectedVersion\n").map(([code]) => code)).toEqual(["MESH_COMMAND_INPUT"]);
    expect(answered("", true)).toEqual([]);
  });
});

describe("generated code", () => {
  const source = `    update :edit
      input
        &body
      validate
        check :hasBody that=({ input }) => input.body != null code="body" message="body"
      do
        lock &version
        set
          &body=({ input }) => input.body
    destroy :drop
      do
        lock &version optional
  policies
    policy :open types=[:read, :create]
      authorize-if=() => true
    policy :mine types=[:update, :destroy]
      authorize-if=({ self }) => self.version > 0
`;
  let document: ModelDocument;
  let files: Map<string, string>;
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  const generated = async () => {
    document = clean(source);
    files = new Map((await generateFiles({ document, config: configOf("/p") })).map((file) => [file.path, file.contents]));
    return files.get("generated/domain/note.actions.ts")!;
  };
  test("the update compares after the record-reading policies and before validate, and bumps before the write", async () => {
    const actions = await generated();
    const edit = actions.slice(actions.indexOf('"Note#edit"'), actions.indexOf('"Note#drop"'));
    const order = ["$policies.inside(", "if (parsed.expectedVersion !== $before.version)", "const $issues", '$expressions["edit.step.1.set.body"]', "$changes.version = $record.version = $before.version + 1;", "tx.updateByKey("].map((text) => edit.indexOf(text));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(edit).toContain('label: "lock",');
    expect(edit).toContain('code: "expected-version",');
    expect(edit).toContain("actualVersion: $before.version,");
    // `expectedVersion` is never applied to the record.
    expect(edit).not.toMatch(/\$changes\.expectedVersion|\$record\.expectedVersion/);
  });
  test("an optional lock on a destroy compares only a sent value, reads its row and bumps nothing", async () => {
    const actions = await generated();
    const drop = actions.slice(actions.indexOf('"Note#drop"'));
    expect(drop).toContain("selectByKeyForUpdate(");
    expect(drop).toContain("if (parsed.expectedVersion != null && parsed.expectedVersion !== $before.version)");
    expect(drop).not.toContain("$before.version + 1");
  });
  test("the input types and validators carry the field", async () => {
    await generated();
    const types = files.get("generated/domain/note.types.ts")!;
    expect(types).toMatch(/export type EditNoteInput = \{[^}]*expectedVersion: number;/);
    expect(types).toMatch(/export type DropNoteInput = \{[^}]*expectedVersion\?: number \| null \| undefined;/);
    expect(files.get("generated/domain/note.validators.ts")).toContain("expectedVersion: z.int(),");
  });
  test("explain lists the derived field and the lock with the checks", () => {
    document = clean(source);
    const lines = explainAction(document.entities[0]!, "edit", document)!;
    expect(lines).toContain("               expectedVersion (from lock &version, not stored)");
    expect(lines.find((l) => l.includes("lock &version:"))).toBe("  checks       lock &version: the caller's expectedVersion must be the stored version, compared before the checks and reported alone (expected-version); the write adds 1 to version");
    expect(explainAction(document.entities[0]!, "drop", document)!.join("\n")).toContain("expectedVersion (from lock &version, optional, not stored)");
  });
  test("the generated tree type-checks", async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../.scratch-mesh-lock-"));
    roots.push(root);
    const result = built(source);
    const config = configOf(root);
    await writeGeneratedFiles(await generateFiles({ document: result.document!, config }), config);
    await writeFile(resolve(root, "generated/schema.ts"), "export const tables: any = {};\n");
    expect(await checkTypes(root, ["generated/domain/note.actions.ts"])).toEqual({ code: 0, output: "" });
  });
});

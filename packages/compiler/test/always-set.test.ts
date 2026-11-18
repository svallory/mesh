import { describe, expect, test } from "bun:test";
import type { BuildResult } from "../src/model/project.ts";
import { buildModel } from "../src/front-end/build.ts";

// A member that an `always` block covering an action sets, and that the action's own `set` sets too, is set twice in one
// action: `MESH_DUPLICATE_SET` at the later write (`notes/architecture/mixins-design.md` R28, ruling D37 OD11). A block
// from a mixin is "as if written there", so the rule is about `always` blocks in general.

const build = (files: Record<string, string>): BuildResult =>
  buildModel({ root: "/p", files: Object.entries(files).map(([file, source]) => ({ file, source })) });
/** Each diagnostic as `line:column CODE message`, in the file named. */
const said = (result: BuildResult) => result.diagnostics.map((d) => `${d.position.file}:${d.position.line}:${d.position.column} ${d.code} ${d.message}`);
const fixes = (result: BuildResult) => result.diagnostics.map((d) => d.fix);

const note = (actions: string, attributes = "") => `entity :Note
  attributes
    uuid :id primary-key
    string :body
    integer :version default=1
${attributes}  actions auto=[:read]
${actions}`;
const BUMP = "    always types=[:update]\n      do\n        set\n          &version=() => &version + 1\n";

describe("a member set by a covering `always` block and by the action (R28)", () => {
  test("the action's own `set` of a member the block sets is the error, at the action's member", () => {
    const result = build({ "notes/note.mesh.mx": note(`${BUMP}    update :edit\n      input\n        &body\n      do\n        set\n          &version=() => &version + 1\n`) });
    expect(said(result)).toEqual([
      "notes/note.mesh.mx:16:10 MESH_DUPLICATE_SET &version is already set in update :edit of notes.Note by the `always` block at line 7, and a member is set once per action",
    ]);
    expect(fixes(result)).toEqual(["remove this `&version=`, or scope the `always` block with `types=` or `actions=` so it does not cover update :edit"]);
  });
  test("a set under a step `when` counts; two blocks that both cover the action are reported at the later block", () => {
    const when = build({ "notes/note.mesh.mx": note(`${BUMP}    update :edit\n      do\n        when=() => true\n          set\n            &version=() => 7\n`) });
    expect(said(when).map((line) => line.split(" MESH")[0])).toEqual(["notes/note.mesh.mx:15:12"]);
    const twice = build({ "notes/note.mesh.mx": note(`${BUMP}    always actions=[&edit]\n      do\n        set\n          &version=() => 9\n    update :edit\n`) });
    expect(said(twice)).toEqual([
      "notes/note.mesh.mx:14:10 MESH_DUPLICATE_SET &version is already set in update :edit of notes.Note by the `always` block at line 7, and a member is set once per action",
    ]);
  });
  test("reported once at a write that several actions reach", () => {
    const both = build({ "notes/note.mesh.mx": note(`${BUMP}    always actions=[&a, &b]\n      do\n        set\n          &version=() => 9\n    update :a\n    update :b\n`) });
    expect(said(both)).toEqual([
      "notes/note.mesh.mx:14:10 MESH_DUPLICATE_SET &version is already set in update :a of notes.Note by the `always` block at line 7, and a member is set once per action",
    ]);
  });
  test("a block from a project mixin is named, and cited by its file", () => {
    const result = build({
      "shared/bumped.mesh.mx": "mixin :Bumped\n  actions\n    always types=[:update]\n      do\n        set\n          &version=() => &version + 1\n",
      "notes/note.mesh.mx": `import { Bumped } from "../shared/bumped.mesh.mx"\n${note("    update :edit\n      do\n        set\n          &version=() => 2\n").replace("entity :Note\n", "entity :Note\n  use mixin=Bumped\n")}`,
    });
    expect(said(result)).toEqual([
      "notes/note.mesh.mx:12:10 MESH_DUPLICATE_SET &version is already set in update :edit of notes.Note by the `always` block of the mixin Bumped (shared/bumped.mesh.mx:3), and a member is set once per action",
    ]);
    expect(fixes(result)).toEqual(["remove this `&version=`: the mixin Bumped sets &version in every action its `always` block covers"]);
  });
  test("an entity's own covering block and a project mixin's block: reported at the entity's own member, naming the mixin", () => {
    // The mixin's block sorts after the entity's own (OD2), so it is the later write; the line to edit is the entity's.
    const result = build({
      "shared/bumped.mesh.mx": "mixin :Bumped\n  actions\n    always types=[:update]\n      do\n        set\n          &version=() => &version + 1\n",
      "notes/note.mesh.mx": `import { Bumped } from "../shared/bumped.mesh.mx"\n${note("    always actions=[&edit]\n      do\n        set\n          &version=() => 10\n    update :edit\n").replace("entity :Note\n", "entity :Note\n  use mixin=Bumped\n")}`,
    });
    expect(said(result)).toEqual([
      "notes/note.mesh.mx:12:10 MESH_DUPLICATE_SET &version is already set in update :edit of notes.Note by the `always` block of the mixin Bumped (shared/bumped.mesh.mx:3), and a member is set once per action",
    ]);
    expect(fixes(result)).toEqual(["remove this `&version=`: the mixin Bumped sets &version in every action its `always` block covers"]);
  });
  test("legal neighbours", () => {
    // The action sets it and no block covering the action does; the block sets another member; two blocks that cover the
    // same actions set different members; a create the block does not cover sets it; two sets of one member in two `when`
    // branches of the action are the action's own.
    expect(said(build({ "notes/note.mesh.mx": note(`    always actions=[&a, &b]\n      do\n        set\n          &body=() => "x"\n${BUMP}    update :a\n    update :b\n`) }))).toEqual([]);
    expect(said(build({ "notes/note.mesh.mx": note(`${BUMP}    create :make\n      input\n        &body\n      do\n        set\n          &version=() => 1\n    update :edit\n      input\n        &body\n`) }))).toEqual([]);
    expect(said(build({ "notes/note.mesh.mx": note(`    always types=[:update]\n      do\n        set\n          &body=() => "x"\n    update :edit\n      do\n        set\n          &version=() => 2\n`) }))).toEqual([]);
    expect(said(build({ "notes/note.mesh.mx": note(`    always actions=[&other]\n      do\n        set\n          &version=() => 2\n    update :edit\n      do\n        set\n          &version=() => 3\n    update :other\n`) }))).toEqual([]);
    expect(said(build({ "notes/note.mesh.mx": note("    update :edit\n      do\n        when=() => true\n          set\n            &version=() => 2\n        when=() => false\n          set\n            &version=() => 3\n") }))).toEqual([]);
  });
});

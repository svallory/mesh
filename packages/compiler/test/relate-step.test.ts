// The `relate` step (ADR-0100, "The relate step"; design `notes/architecture/lock-relate-design.md`, PR 2):
// `relate &tracks create=:add update=:rename destroy=:remove` adds the optional list input `tracks` and, after the write,
// makes the has-many's rows follow it through the target's own actions. Each rule here is one row of the design's
// section 6, with its legal neighbours.
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

/** An Album with a has-many of tracks and one through a link, and the actions the case writes (line 13 is the first). */
const album = (actions: string, extra = "") => `import { Track } from "./track.mesh.mx"
import { Credit } from "./credit.mesh.mx"
import { Artist } from "./artist.mesh.mx"
import { Sleeve } from "./sleeve.mesh.mx"
entity :Album
  attributes
    uuid :id primary-key
    string :title
  relationships
    has-many :tracks entity=Track
    has-many :artists entity=Artist through=Credit
    has-one :cover entity=Sleeve
    has-many :bonus entity=Track inverse=:bonusOf
${extra}  actions auto=[:read]
${actions}`;
/** A Track with its own actions; `actions` replaces them. */
const TRACK_ACTIONS = `    create :add
      input
        &name
        &album
    create :loose
      input
        &name
    create :bonus
      input
        &name
        &bonusOf
    update :rename
      input
        &name
    destroy :remove
    destroy :purge
      input
        string :reason
`;
const track = (actions = TRACK_ACTIONS, attributes = "", auto = "[:read, :create]") => `import { Album } from "./album.mesh.mx"
entity :Track
  attributes
    uuid :id primary-key
    string :name min=1
    integer :version default=1
${attributes}  relationships
    belongs-to :album entity=Album
    belongs-to :bonusOf entity=Album nullable
  actions auto=${auto}
${actions}`;
const credit = 'import { Album } from "./album.mesh.mx"\nimport { Artist } from "./artist.mesh.mx"\nentity :Credit\n  attributes\n    uuid :id primary-key\n  relationships\n    belongs-to :album entity=Album\n    belongs-to :artist entity=Artist\n  actions auto=[:read]\n';
const sleeve = 'import { Album } from "./album.mesh.mx"\nentity :Sleeve\n  attributes\n    uuid :id primary-key\n  relationships\n    belongs-to :album entity=Album\n  actions auto=[:read]\n';
const artist = "entity :Artist\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n";
const files = (actions: string, options: { extra?: string; track?: string; trackAttributes?: string; trackAuto?: string } = {}) => [
  { file: "album.mesh.mx", source: album(actions, options.extra) },
  { file: "track.mesh.mx", source: track(options.track, options.trackAttributes, options.trackAuto) },
  { file: "credit.mesh.mx", source: credit },
  { file: "artist.mesh.mx", source: artist },
  { file: "sleeve.mesh.mx", source: sleeve },
];
const built = (actions: string, options: Parameters<typeof files>[1] = {}) => buildModel({ root: "/p", files: files(actions, options) });
const found = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => [d.code, d.position.file, d.position.line, d.position.column, d.message]);
const clean = (actions: string, options: Parameters<typeof files>[1] = {}) => {
  const result = built(actions, options);
  expect(found(result.diagnostics)).toEqual([]);
  return result.document!;
};
const edit = (step: string, input = "        &title\n") => `    update :edit\n      input\n${input}      do\n        ${step}\n`;

describe("the relate line's syntax (MX and the builder)", () => {
  const codes = (step: string) => built(edit(step)).diagnostics.map((d) => d.code);
  test("each option alone and all three build", () => {
    expect(codes("relate &tracks create=:add update=:rename destroy=:remove")).toEqual([]);
    expect(codes("relate &tracks create=:add")).toEqual([]);
    expect(codes("relate &tracks update=:rename")).toEqual([]);
    expect(codes("relate &tracks destroy=:remove")).toEqual([]);
  });
  test.each([
    ["a string option", 'relate &tracks create="add"', "MESH_OPTION_VALUE"],
    ["a value after the member", "relate &tracks=1 create=:add", "MESH_SYNTAX"],
    ["an atom for the member", "relate :tracks create=:add", "MESH_UNKNOWN_OPTION"],
    ["an unknown option", "relate &tracks create=:add append=:add", "MESH_UNKNOWN_OPTION"],
    ["no member", "relate create=:add", "MESH_MISSING_OPTION"],
    ["an unknown member", "relate &nope create=:add", "MESH_UNKNOWN_MEMBER"],
  ])("%s is %s", (_, step, code) => {
    expect(codes(step)).toEqual([code]);
  });
  test("under `validate` it is MESH_TAG_NOT_ALLOWED", () => {
    expect(built("    update :edit\n      validate\n        relate &tracks create=:add\n").diagnostics.map((d) => d.code)).toEqual(["MESH_TAG_NOT_ALLOWED"]);
  });
});

describe("MESH_RELATE_STEP", () => {
  test("a line that names no action", () => {
    expect(found(built(edit("relate &tracks")).diagnostics)).toEqual([
      ["MESH_RELATE_STEP", "album.mesh.mx", 19, 8, "`relate &tracks` names no action: `create=`, `update=` and `destroy=` name the actions of the related entity it calls"],
    ]);
  });
  test("under a step `when`, and in an `always` block (also under its `when`)", () => {
    expect(found(built("    update :edit\n      do\n        when=() => true\n          relate &tracks create=:add\n").diagnostics)).toEqual([
      ["MESH_RELATE_STEP", "album.mesh.mx", 18, 10, "a `relate` step under `when` would take the list on some calls and drop it on others: it is written directly under the action's own `do`"],
    ]);
    expect(found(built("    always types=[:update]\n      do\n        relate &tracks create=:add\n    update :edit\n").diagnostics)).toEqual([
      ["MESH_RELATE_STEP", "album.mesh.mx", 17, 8, "a `relate` step in an `always` block would add a `tracks` input to every action the block covers: it is written directly under the action's own `do`"],
    ]);
    expect(built("    always types=[:update]\n      do\n        when=() => true\n          relate &tracks create=:add\n    update :edit\n").diagnostics.map((d) => d.code)).toEqual(["MESH_RELATE_STEP"]);
  });
  test("in a destroy", () => {
    expect(found(built("    destroy :drop\n      do\n        relate &tracks destroy=:remove\n").diagnostics)).toEqual([
      ["MESH_RELATE_STEP", "album.mesh.mx", 17, 8, "destroy :drop of Album has a `relate` step, and a destroy writes no row its children could point to"],
    ]);
  });
  test("one relationship related twice by one action, at the later line", () => {
    expect(found(built("    update :edit\n      do\n        relate &tracks create=:add\n        relate &tracks destroy=:remove\n").diagnostics)).toEqual([
      ["MESH_RELATE_STEP", "album.mesh.mx", 18, 8, "update :edit of Album relates &tracks twice (line 17 and line 18): one list decides the rows"],
    ]);
  });
  test.each([
    ["an attribute", "title", "an attribute"],
    ["a has-one", "cover", "a has-one"],
  ])("a member that is %s", (_, member, what) => {
    expect(found(built(edit(`relate &${member} create=:add`)).diagnostics)).toEqual([
      ["MESH_RELATE_STEP", "album.mesh.mx", 19, 15, `\`relate &${member}\`: &${member} is ${what} of Album, and \`relate\` manages the rows of a has-many`],
    ]);
  });
  test("a belongs-to and a computed field", () => {
    const back = built("", { track: "    update :edit\n      do\n        relate &album create=:add\n" }).diagnostics;
    expect(found(back)).toEqual([["MESH_RELATE_STEP", "track.mesh.mx", 13, 15, "`relate &album`: &album is a belongs-to of Track, and `relate` manages the rows of a has-many"]]);
    expect(back[0]!.fix).toBe("set a belongs-to with `set &album=...`");
    const computed = built(edit("relate &count create=:add"), { extra: "  computed\n    integer :count({ self }) { return 1 }\n" }).diagnostics;
    expect(found(computed).map(([code, , , , message]) => [code, message])).toEqual([["MESH_RELATE_STEP", "`relate &count`: &count is a computed field of Album, and `relate` manages the rows of a has-many"]]);
  });
  test("a has-many through a link entity", () => {
    expect(found(built(edit("relate &artists create=:add")).diagnostics)).toEqual([
      ["MESH_RELATE_STEP", "album.mesh.mx", 19, 15, "`relate &artists`: &artists goes through a link entity (through=Credit), and `relate` manages the rows of a has-many without one"],
    ]);
  });
  test("a has-many whose inverse did not resolve reports only the relationship's error", () => {
    const result = buildModel({ root: "/p", files: [
      { file: "a.mesh.mx", source: 'import { B } from "./b.mesh.mx"\nentity :A\n  attributes\n    uuid :id primary-key\n  relationships\n    has-many :bs entity=B\n  actions auto=[:read]\n    update :edit\n      do\n        relate &bs create=:nope\n' },
      { file: "b.mesh.mx", source: "entity :B\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n" },
    ] });
    expect(result.diagnostics.map((d) => d.code)).toEqual(["MESH_NO_INVERSE"]);
  });
});

describe("MESH_UNKNOWN_ACTION and MESH_RELATE_ACTION", () => {
  test("an option that names no action of the target", () => {
    expect(found(built(edit("relate &tracks create=:ad")).diagnostics)).toEqual([
      ["MESH_UNKNOWN_ACTION", "album.mesh.mx", 19, 30, ":ad is not an action of Track: `create=` names one of its create actions (:add, :loose, :bonus, :create). Did you mean :add?"],
    ]);
  });
  test("an option that names an action of another kind", () => {
    const result = built(edit("relate &tracks create=:rename destroy=:add"));
    expect(found(result.diagnostics)).toEqual([
      ["MESH_RELATE_ACTION", "album.mesh.mx", 19, 30, "`create=:rename` names update :rename of Track, and `create=` names a create action"],
      ["MESH_RELATE_ACTION", "album.mesh.mx", 19, 46, "`destroy=:add` names create :add of Track, and `destroy=` names a destroy action"],
    ]);
    expect(result.diagnostics.map((d) => d.fix)).toEqual(["name a create action of Track (:add, :loose, :bonus, :create)", "name a destroy action of Track (:remove, :purge)"]);
  });
  test("a create that does not take the inverse, declared and generated", () => {
    const declared = built(edit("relate &tracks create=:loose")).diagnostics;
    expect(found(declared)).toEqual([
      ["MESH_RELATE_ACTION", "album.mesh.mx", 19, 30, "create :loose of Track takes no &album, so `relate &tracks` cannot attach the rows it creates to Album"],
    ]);
    expect(declared[0]!.fix).toBe("add `&album` to the `input` of create :loose");
    const auto = built(edit("relate &tracks create=:create")).diagnostics;
    expect(auto.map((d) => [d.code, d.fix])).toEqual([["MESH_RELATE_ACTION", "declare a create on Track that takes `&album` and name it"]]);
  });
  test("a create or an update that relates a list of its own", () => {
    const own = `    create :add
      input
        &name
        &album
      do
        relate &plays create=:log
    update :rename
      input
        &name
      do
        relate &plays create=:log
    destroy :remove
`;
    const play = 'import { Track } from "./track.mesh.mx"\nentity :Play\n  attributes\n    uuid :id primary-key\n  relationships\n    belongs-to :track entity=Track\n  actions auto=[:read]\n    create :log\n      input\n        &track\n';
    const result = buildModel({ root: "/p", files: [
      ...files(edit("relate &tracks create=:add update=:rename destroy=:remove"), { track: own }).map((file) => file.file === "track.mesh.mx"
        ? { ...file, source: file.source.replace('import { Album } from "./album.mesh.mx"\n', 'import { Album } from "./album.mesh.mx"\nimport { Play } from "./play.mesh.mx"\n').replace("    belongs-to :bonusOf entity=Album nullable\n", "    belongs-to :bonusOf entity=Album nullable\n    has-many :plays entity=Play\n") }
        : file),
      { file: "play.mesh.mx", source: play },
    ] });
    expect(found(result.diagnostics).map(([code, , , , message]) => [code, message])).toEqual([
      ["MESH_RELATE_ACTION", "create :add of Track has its own `relate &plays` (line 18), and an item of `relate &tracks` cannot carry a list of its own"],
      ["MESH_RELATE_ACTION", "update :rename of Track has its own `relate &plays` (line 23), and an item of `relate &tracks` cannot carry a list of its own"],
    ]);
  });
  test("a destroy that takes a required argument, or a required lock field", () => {
    expect(found(built(edit("relate &tracks destroy=:purge")).diagnostics)).toEqual([
      ["MESH_RELATE_ACTION", "album.mesh.mx", 19, 31, "destroy :purge of Track takes `reason`, and `relate &tracks` destroys a child with its key alone"],
    ]);
    const locked = built(edit("relate &tracks destroy=:remove"), { track: TRACK_ACTIONS.replace("    destroy :remove\n", "    destroy :remove\n      do\n        lock &version\n") }).diagnostics;
    expect(locked.map((d) => [d.code, d.message, d.fix])).toEqual([
      ["MESH_RELATE_ACTION", "destroy :remove of Track takes `expectedVersion`, which `lock &version` adds, and `relate &tracks` destroys a child with its key alone", "name a destroy that takes only the key, or make the lock `optional`"],
    ]);
  });
});

describe("MESH_DUPLICATE_INPUT", () => {
  test("an authored argument named like the relationship", () => {
    expect(found(built(edit("relate &tracks create=:add", "        json :tracks\n")).diagnostics)).toEqual([
      ["MESH_DUPLICATE_INPUT", "album.mesh.mx", 17, 8, "Input tracks conflicts with the one `relate &tracks` (line 19) adds"],
    ]);
  });
});

describe("legal neighbours", () => {
  test("relate on a create and an update of one entity, two relationships in one action, with destroy= alone", () => {
    clean(`    create :make
      input
        &title
      do
        relate &tracks create=:add
    update :edit
      do
        relate &tracks destroy=:remove
        relate &bonus create=:bonus update=:rename
`);
  });
  test("each derived field, in written order after the lock's; none without a step", () => {
    const document = clean(`    create :make
      input
        &title
      do
        relate &tracks create=:add
    update :edit
      do
        relate &tracks destroy=:remove
    update :plain
`);
    const entity = document.entities.find((e) => e.name === "Album")!;
    const fields = (name: string) => derivedInputs(entity, entity.actions.find((a) => a.name === name)!).map((f) => [f.name, f.source, f.required, f.nullable]);
    expect(fields("make")).toEqual([["tracks", "relate", false, false]]);
    expect(fields("edit")).toEqual([["tracks", "relate", false, false]]);
    expect(fields("plain")).toEqual([]);
  });
  test("a lock and a relate on one update: the lock's field, then the list", () => {
    const withVersion = buildModel({ root: "/p", files: files("    update :edit\n      do\n        lock &version\n        relate &tracks create=:add\n").map((file) => file.file === "album.mesh.mx" ? { ...file, source: file.source.replace("    string :title\n", "    string :title\n    integer :version default=1\n") } : file) });
    expect(found(withVersion.diagnostics)).toEqual([]);
    const entity = withVersion.document!.entities.find((e) => e.name === "Album")!;
    expect(derivedInputs(entity, entity.actions[0]!).map((f) => f.name)).toEqual(["expectedVersion", "tracks"]);
  });
  test("publish written before a relate is no MESH_PUBLISH_BEFORE_WRITE; a load of the same relationship beside it builds", () => {
    const event = { file: "made.mesh.mx", source: "event :made\n  uuid :album\n" };
    const result = buildModel({ root: "/p", files: [...files(`    update :edit
      do
        load=[&tracks]
        publish=({ self }) => new Made({ album: self.id })
        relate &tracks create=:add
`).map((file) => file.file === "album.mesh.mx" ? { ...file, source: `import { Made } from "./made.mesh.mx"\n${file.source}` } : file), event] });
    expect(found(result.diagnostics).filter(([code]) => code !== "MESH_COMMAND_UNANSWERED")).toEqual([]);
  });
  test("a check that limits the list on the input builds and types", () => {
    clean(edit("relate &tracks create=:add").replace("      do\n", '      validate\n        check :few that=({ input }) => input.tracks == null || input.tracks.length <= 20 code="few" message="few"\n      do\n'));
  });
  test("a target create with required inputs of its own, an update without the inverse, a locked update", () => {
    clean(edit("relate &tracks create=:add update=:rename"), {
      track: TRACK_ACTIONS.replace("    update :rename\n      input\n        &name\n", "    update :rename\n      input\n        &name\n      do\n        lock &version\n"),
    });
  });
  test("a self-referencing has-many whose create relates through another create", () => {
    const task = `entity :Task
  attributes
    uuid :id primary-key
    string :title
  relationships
    belongs-to :parent entity=Task nullable
    has-many :children entity=Task inverse=:parent
  actions auto=[:read]
    create :make
      input
        &title
      do
        relate &children create=:add
    create :add
      input
        &title
        &parent
`;
    const result = buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source: task }] });
    expect(found(result.diagnostics)).toEqual([]);
  });
});

describe("a command answering a relating action", () => {
  test("needs no field for the list, and may not pass one of another type unnoticed", () => {
    const command = { file: "rename-album.mesh.mx", source: "command :RenameAlbum\n  uuid :id\n  string :title\n" };
    const result = buildModel({ root: "/p", files: [...files("    update on=RenameAlbum\n      input\n        &title\n      do\n        relate &tracks create=:add\n").map((file) => file.file === "album.mesh.mx" ? { ...file, source: `import { RenameAlbum } from "./rename-album.mesh.mx"\n${file.source}` } : file), command] });
    expect(found(result.diagnostics)).toEqual([]);
  });
});

describe("generated code", () => {
  const source = `    create :make
      input
        &title
      do
        relate &tracks create=:add
    update :edit
      input
        &title
      do
        run [after=:write] ({ self }) { void self }
        relate &tracks create=:add update=:rename destroy=:remove
    update :keep
      do
        relate &tracks update=:rename
  policies
    policy :open types=[:read, :create, :update]
      authorize-if=() => true
`;
  // Only actions every generator can emit: an auto create, or one that does not take `&album`, cannot fill the key.
  const trackActions = "    create :add\n      input\n        &name\n        &album\n    update :rename\n      input\n        &name\n    destroy :remove\n";
  const trackPolicies = trackActions + "  policies\n    policy :open types=[:read, :create, :update, :destroy]\n      authorize-if=() => true\n";
  let document: ModelDocument;
  let generated: Map<string, string>;
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  const generate = async () => {
    document = clean(source, { track: trackPolicies, trackAuto: "[:read]" });
    generated = new Map((await generateFiles({ document, config: configOf("/p") })).map((file) => [file.path, file.contents]));
    return generated.get("generated/domain/album.actions.ts")!;
  };
  const body = (actions: string, name: string, next?: string) => actions.slice(actions.indexOf(`"Album#${name}"`), next ? actions.indexOf(`"Album#${next}"`) : undefined);
  test("a create whose only step is a relate keeps the one insert and declares no scope", async () => {
    const make = body(await generate(), "make", "edit");
    expect(make).toContain("const $changes: $Record = {");
    expect(make).toContain("title: parsed.title,");
    expect(make).not.toContain("// do:");
    expect(make).not.toContain("$s = ");
    expect(make).not.toContain("$after");
    expect(make).not.toContain("$written");
    const order = ["tx.insert(", "$recordWrite(", "await $relateRows(", "const $result = await tx.selectByKey("].map((text) => make.indexOf(text));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(make.replace(/\s+/g, " ")).toContain('create: (item) => $Track$value.add({ ...item, album: $stored.id as $Record["id"] }, ...[context]), }, parsed.tracks, );');
    expect(make).not.toContain("update: (item)");
    const flat = make.replace(/\s+/g, " ");
    expect(flat).toContain('where: "Album#tracks", field: "tracks", key: "id", uuidKey: true, source: { file: "album.mesh.mx", line: 19, column: 9 },');
    expect(flat).toContain('[$stored], ["tracks"], { ...$load, policies: true, }');
  });
  test("an update runs its after-write steps in written order, each call with the caller's context", async () => {
    const actions = await generate();
    const editBody = body(actions, "edit", "keep");
    expect(editBody).toContain("const $after = ");
    expect(editBody.indexOf('$expressions["edit.step.0.run"]($after)')).toBeLessThan(editBody.indexOf("await $relateRows("));
    expect(editBody).toContain("destroy: (key) => $Track$value.remove(key, ...[context]),");
    expect(editBody).toContain("update: (item) => $Track$value.rename(item, ...[context]),");
    // An update whose only step is a relate opens no `do` block and declares no after scope.
    const keep = body(actions, "keep");
    expect(keep).not.toContain("// do:");
    expect(keep).not.toContain("$after");
    expect(keep).toContain("await $relateRows(");
    // `tracks` is never applied to the record.
    expect(actions).not.toMatch(/\$changes\.tracks|\$record\.tracks/);
    // The target's entity value is imported from its actions file; nothing from its types or validators.
    expect(actions).toContain('import { Track as $Track$value } from "./track.actions";');
    expect(actions).not.toContain("./track.validators");
    expect(actions).not.toContain("./track.types");
  });
  test("the input types and validators print each item inline", async () => {
    await generate();
    const types = generated.get("generated/domain/album.types.ts")!;
    expect(types).toContain("tracks?: readonly ({ id: string } | { name: string; id?: undefined })[] | undefined;");
    expect(types.replace(/\s+/g, " ")).toContain("tracks?: | readonly ({ id: string; name?: string | undefined } | { name: string; id?: undefined })[] | undefined;");
    // without create= no new item is taken
    expect(types).toContain("export type KeepAlbumInput = {\n  id: string;\n  tracks?: readonly { id: string; name?: string | undefined }[] | undefined;\n};");
    const validators = generated.get("generated/domain/album.validators.ts")!.replace(/\s+/g, " ");
    expect(validators).toContain("const $relateItem = ");
    // the item's line rule keeps its code and its line in the target's file
    expect(validators).toContain('tracks: z .array( $relateItem( "id", z.strictObject({ id: z.uuid() }), $ruled( z.strictObject({ name: z.string().min(1, "must be at least 1 character"), id: z.undefined().optional(), }), { name: { too_small: { code: "too_short", source: { file: "track.mesh.mx", line: 5, column: 5 }, }, }, }, ), ), ) .readonly() .optional(), })');
    expect(validators).toContain('keepAlbumInputSchema = z.strictObject({ id: z.uuid(), tracks: z .array( $relateItem( "id", $ruled(');
    expect(validators).toMatch(/keepAlbumInputSchema = .*?\), null, \), \) \.readonly\(\) \.optional\(\), \}\)/);
  });
  test("explain lists the derived field and the relate after the write", () => {
    document = clean(source, { track: trackPolicies, trackAuto: "[:read]" });
    const lines = explainAction(document.entities.find((e) => e.name === "Album")!, "edit", document)!;
    expect(lines).toContain("               tracks (from relate &tracks, optional: the rows it lists, not stored)");
    const relate = lines.find((line) => line.includes("relate &tracks:"))!;
    expect(relate).toContain("relate &tracks: the rows of tracks follow the caller's list, through destroy :remove, update :rename, create :add (the related entity's actions, in that order, with the caller's context)");
    expect(lines.indexOf(relate)).toBeGreaterThan(lines.findIndex((line) => line.includes("run ({ self }) { void self }")));
  });
  test("a self-referencing has-many uses the file's own entity value", async () => {
    const task = `entity :Task
  attributes
    integer :id primary-key
    string :title
  relationships
    belongs-to :parent entity=Task nullable
    has-many :children entity=Task inverse=:parent
  actions auto=[:read]
    create :make
      input
        &title
      do
        relate &children create=:add
    create :add
      input
        &title
        &parent
  policies
    policy :open types=[:read, :create]
      authorize-if=() => true
`;
    const result = buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source: task }] });
    expect(found(result.diagnostics)).toEqual([]);
    const out = new Map((await generateFiles({ document: result.document!, config: configOf("/p") })).map((file) => [file.path, file.contents]));
    const actions = out.get("generated/domain/task.actions.ts")!;
    expect(actions.replace(/\s+/g, " ")).toContain('create: (item) => $entityValue.add({ ...item, parent: $stored.id as $Record["id"] }, ...[context]),');
    expect(actions).not.toMatch(/import \{ Task as/);
    expect(actions).toContain("uuidKey: false");
    expect(out.get("generated/domain/task.types.ts")).toContain("children?: readonly ({ id: number } | { title: string; id?: undefined })[] | undefined;");
  });
  test("the generated tree type-checks", async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../.scratch-mesh-relate-"));
    roots.push(root);
    const result = built(source, { track: trackPolicies.replace("    update :rename\n      input\n        &name\n", "    update :rename\n      input\n        &name\n      do\n        lock &version optional\n"), trackAuto: "[:read]" });
    expect(found(result.diagnostics)).toEqual([]);
    const config = configOf(root);
    await writeGeneratedFiles(await generateFiles({ document: result.document!, config }), config);
    await writeFile(resolve(root, "generated/schema.ts"), "export const tables: any = {};\n");
    expect(await checkTypes(root, ["generated/domain/album.actions.ts", "generated/domain/album.validators.ts", "generated/domain/track.actions.ts"])).toEqual({ code: 0, output: "" });
    const types = await Bun.file(resolve(root, "generated/domain/album.types.ts")).text();
    // a locked update= action: the keyed item carries its lock field
    expect(types.replace(/\s+/g, " ")).toContain("{ id: string; name?: string | undefined; expectedVersion?: number | null | undefined }");
  });
});

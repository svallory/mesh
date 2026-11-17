// The architecture file (`notes/architecture/architecture-file-design.md`, PR 1; rules R1 to R15 and R19, ruling D40):
// `architecture :name` directly in the domain root, its `use preset=`, `severity` and `disable` lines, the presets it
// imports from "meshfw/architecture", the settings it resolves (`readArchitectureFile`), the refusal of an import of it
// (R8) and the list-form domain root that leaves it out. No rule has a check yet, so a project's document is the same
// with the file as without it. The import-layering test of the compiler's own source is `architecture.test.ts`.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { lowerSource } from "@mxlang/core";
import type { Diagnostic } from "@meshfw/model";
import { buildModel, parseEntitySource } from "../src/front-end/build.ts";
import { MESH_DIALECT } from "../src/front-end/dialect.ts";
import { MESH_EXTENSIONS } from "../src/front-end/extensions.ts";
import { architectureFileText, isArchitectureFileName, readArchitectureFile } from "../src/front-end/architecture-file.ts";
import { tags, type Tag } from "../src/front-end/tree.ts";
import { ARCHITECTURE_RULES, DEFAULT_SETTINGS, PRESETS } from "../src/model/architecture-rules.ts";
import { loadConfig, loadProject } from "../src/index.ts";

const FILE = architectureFileText;
const IMPORT = 'import { MeshRecommended } from "meshfw/architecture"\n';
/** The spec's example (`notes/spec/other-file-kinds.md`), plus a `severity` line. */
const SPEC = `${IMPORT}\narchitecture :project\n  use preset=MeshRecommended\n  disable :service-touches-one-entity\n  severity :action-calls-other-aggregate level=:error\n`;
const arch = (lines: string, imports = IMPORT) => `${imports}architecture :project\n${lines}`;
const LIST = "entity :List\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n";
const TASK = 'import { List } from "./list.mesh.mx"\nentity :Task\n  attributes\n    uuid :id primary-key\n  relationships\n    belongs-to :list entity=List\n  actions auto=[:read]\n';
const PROJECT = { "todo/list.mesh.mx": LIST, "todo/task.mesh.mx": TASK };

type Files = Record<string, string>;
const build = (files: Files, domainRoot?: string) =>
  buildModel({ root: "/project", ...(domainRoot ? { domainRoot } : {}), files: Object.entries(files).map(([file, source]) => ({ file, source })) });
const brief = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => [d.position.file, d.position.line, d.position.column, d.code, d.message, d.fix]);
const codes = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => [d.position.file, d.position.line, d.position.column, d.code]);
/** What MX reports for one file, as `[code, line, column]`. */
const mx = (source: string, file = `/project/${FILE}`) => parseEntitySource(source, file).diagnostics.map((d) => [d.code, d.line, d.column]);
/** The settings of one architecture file, read from MX's tree (partial when MX refused a line), and what it reported. */
function settingsOf(source: string) {
  const lowered = lowerSource(source, `/project/${FILE}`, { dialect: MESH_DIALECT, partial: true });
  const root = tags(lowered.ir!.body).find((tag) => tag.name === "architecture") as Tag;
  const diagnostics: Diagnostic[] = [];
  const settings = readArchitectureFile({ root, imports: lowered.ir!.imports, source, file: FILE }, diagnostics);
  return { settings: Object.fromEntries(settings) as Record<string, string>, diagnostics: brief(diagnostics) };
}
const DEFAULTS: Record<string, string> = Object.fromEntries(DEFAULT_SETTINGS);

describe("the contracts (MX, so the editor shows them too)", () => {
  test("the spec's example, a file with no line and none of its own imports parse with no diagnostic", () => {
    expect(mx(SPEC)).toEqual([]);
    expect(mx("architecture :project\n")).toEqual([]);
    // A camelCase or misspelt rule name passes MX: which names are rules is the builder's check, with a suggestion.
    expect(mx("architecture :project\n  disable :serviceTouches\n")).toEqual([]);
  });
  test.each([
    ["no name", "architecture\n", "MESH_MISSING_OPTION", 1, 0],
    ["the atom form of use", arch("  use :mesh-recommended\n"), "MESH_UNKNOWN_OPTION", 3, 6],
    ["use alone (checkUseOptions)", arch("  use\n"), "MESH_MISSING_OPTION", 3, 2],
    ["mixin= in the architecture file", arch("  use mixin=Timestamps\n"), "MESH_UNKNOWN_OPTION", 3, 6],
    ["a string preset", arch('  use preset="MeshRecommended"\n'), "MESH_OPTION_VALUE", 3, 6],
    ["a call as preset (the hook)", arch("  use preset=foo()\n"), "MESH_OPTION_VALUE", 3, 6],
    ["a wrapped preset (the hook)", arch("  use preset=(MeshRecommended)\n"), "MESH_OPTION_VALUE", 3, 13],
    ["a non-null preset (the hook)", arch("  use preset=MeshRecommended!\n"), "MESH_OPTION_VALUE", 3, 13],
    ["a string rule name", arch('  disable "service-touches-one-entity"\n'), "MESH_INVALID_OPTION", 3, 10],
    ["disable with no name", arch("  disable\n"), "MESH_MISSING_OPTION", 3, 2],
    ["a level that is no level", arch("  severity :x level=:info\n"), "MESH_SYNTAX", 3, 20],
    ["severity with no level", arch("  severity :x\n"), "MESH_MISSING_OPTION", 3, 2],
    ["a string level", arch('  severity :x level="error"\n'), "MESH_OPTION_VALUE", 3, 20],
    ["a line under disable", arch("  disable :x\n    disable :y\n"), "MESH_TAG_NOT_ALLOWED", 4, 4],
    ["an entity section under architecture", arch("  attributes\n    uuid :id\n"), "MESH_TAG_NOT_ALLOWED", 3, 2],
    ["disable at the top level", "disable :x\n", "MESH_PARENT_NOT_ALLOWED", 1, 0],
    ["use in an entity, before mixins", "entity :E\n  use preset=X\n  attributes\n    uuid :id primary-key\n", "MESH_TAG_NOT_ALLOWED", 2, 2],
  ])("%s", (_, source, code, line, column) => expect(mx(source)).toEqual([[code, line, column]]));
  test("the messages Mesh writes", () => {
    const messages = (source: string) => parseEntitySource(source, `/project/${FILE}`).diagnostics.map((d) => d.message);
    expect(messages(arch("  use\n"))).toEqual(["`use` names what it includes: `use preset=MeshRecommended`"]);
    expect(messages(arch("  use preset=foo()\n"))).toEqual(["`use`: preset must be an imported preset (`preset=MeshRecommended`)"]);
    expect(messages(arch("  use preset=(MeshRecommended)\n"))).toEqual(["`use`: preset must be the reference alone, with no parentheses, `!`, `as`, `satisfies` or `<T>` around it (`preset=MeshRecommended`)"]);
  });
});

describe("the file builds into nothing", () => {
  test("the spec's example builds, and the document is the one the project builds without it", () => {
    const without = build(PROJECT);
    const result = build({ ...PROJECT, [FILE]: SPEC });
    expect(result.diagnostics).toEqual([]);
    expect(result.document).toEqual(without.document!);
    expect(result.document!.entities.map((e) => e.fqn)).toEqual(["todo.List", "todo.Task"]);
  });
  test("with a domain root below the project root, the file sits there", () => {
    const files = Object.fromEntries(Object.entries(PROJECT).map(([file, source]) => [`src/domain/${file}`, source]));
    const result = build({ ...files, [`src/domain/${FILE}`]: SPEC }, "src/domain");
    expect(result.diagnostics).toEqual([]);
    expect(result.document).toEqual(build(files, "src/domain").document!);
  });
  test("legal neighbours: no line, no import, an aliased preset, a preset then the file's own lines for the same rules", () => {
    for (const source of [
      "architecture :project\n",
      arch("", ""),
      arch("  use preset=Recommended\n", 'import { MeshRecommended as Recommended } from "meshfw/architecture"\n'),
      arch("  use preset=MeshRecommended\n  severity :action-calls-other-aggregate level=:warning\n  disable :service-touches-one-entity\n"),
    ]) expect(brief(build({ ...PROJECT, [FILE]: source }).diagnostics)).toEqual([]);
  });
  test("R3: an entity in a file named as the architecture file stays an entity", () => {
    const result = build({ [FILE]: "entity :Architecture\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n" });
    expect(result.diagnostics).toEqual([]);
    expect(result.document!.entities.map((e) => e.fqn)).toEqual(["Architecture"]);
  });
  test("R4: two roots", () => {
    expect(brief(build({ [FILE]: "architecture :a\narchitecture :b\n" }).diagnostics)).toEqual([
      [FILE, 2, 0, "MESH_DUPLICATE_ENTITY", "An architecture file must contain exactly one architecture", null],
    ]);
  });
  test("the file's name is an extension of MESH_EXTENSIONS after `architecture`", () => {
    for (const extension of MESH_EXTENSIONS) {
      expect(isArchitectureFileName(`/p/architecture${extension}`)).toBe(true);
      expect(isArchitectureFileName(`/p/rules${extension}`)).toBe(false);
      expect(isArchitectureFileName(`/p/my-architecture${extension}`)).toBe(false);
    }
    expect(isArchitectureFileName("/p/architecture.ts")).toBe(false);
  });
});

describe("R2: the file is the one directly in the domain root", () => {
  const misplaced = (file: string, root: string) =>
    [file, 3, 0, "MESH_ARCHITECTURE_FILE", `The architecture file is ${FILE} directly in the domain root (${root}), and this is ${file}`,
      `move it to ${root === "the project root" ? "" : `${root}/`}${FILE}`];
  test.each([
    [`docs/${FILE}`, undefined, "the project root"],
    [`todo/${FILE}`, undefined, "the project root"],
    [`rules${MESH_EXTENSIONS[0]}`, undefined, "the project root"],
    [FILE, "src/domain", "src/domain"],
    [`src/domain/todo/${FILE}`, "src/domain", "src/domain"],
  ])("%s (domain root %s)", (file, domainRoot, label) => {
    const files = domainRoot ? Object.fromEntries(Object.entries(PROJECT).map(([f, s]) => [`src/domain/${f}`, s])) : PROJECT;
    // A misplaced file's lines are not read: its unknown rule reports nothing.
    const result = build({ ...files, [file]: SPEC.replace(":service-touches-one-entity", ":no-such-rule") }, domainRoot);
    expect(brief(result.diagnostics)).toEqual([misplaced(file, label)]);
    expect(result.document).toBeNull();
  });
});

describe("imports (R7, ruling D40 OD6)", () => {
  test.each([
    ["a relative import", 'import { List } from "./todo/list.mesh.mx"\n', "MESH_UNKNOWN_IMPORT", "The architecture file imports presets from \"meshfw/architecture\" alone (`import { MeshRecommended } from \"meshfw/architecture\"`)", "remove the import", 0],
    ["meshfw", 'import { Mesh } from "meshfw"\n', "MESH_UNKNOWN_IMPORT", "The architecture file imports presets from \"meshfw/architecture\" alone (`import { MeshRecommended } from \"meshfw/architecture\"`)", "remove the import", 0],
    ["a package", 'import { z } from "zod"\n', "MESH_UNKNOWN_IMPORT", "The architecture file imports presets from \"meshfw/architecture\" alone (`import { MeshRecommended } from \"meshfw/architecture\"`)", "remove the import", 0],
    ["another name", 'import { MeshStrict } from "meshfw/architecture"\n', "MESH_UNKNOWN_IMPORT", "\"meshfw/architecture\" gives `MeshRecommended`, and `MeshStrict` is not it", null, 9],
    ["a namespace import", 'import * as presets from "meshfw/architecture"\n', "MESH_IMPORT_FORM", "import a preset by name: \"meshfw/architecture\" gives the named export `MeshRecommended`", 'write `import { MeshRecommended } from "meshfw/architecture"`', 0],
    ["a type import", 'import type { MeshRecommended } from "meshfw/architecture"\n', "MESH_IMPORT_FORM", "import a preset by name: \"meshfw/architecture\" gives the named export `MeshRecommended`", 'write `import { MeshRecommended } from "meshfw/architecture"`', 0],
    ["a default import", 'import MeshRecommended from "meshfw/architecture"\n', "MESH_IMPORT_FORM", "import a preset by name: \"meshfw/architecture\" gives the named export `MeshRecommended`", 'write `import { MeshRecommended } from "meshfw/architecture"`', 0],
    ["a side-effect import", 'import "meshfw/architecture"\n', "MESH_IMPORT_FORM", "import a preset by name: \"meshfw/architecture\" gives the named export `MeshRecommended`", 'write `import { MeshRecommended } from "meshfw/architecture"`', 0],
  ])("%s", (_, imports, code, message, fix, column) => {
    expect(brief(build({ ...PROJECT, [FILE]: arch("", imports) }).diagnostics)).toEqual([[FILE, 1, column, code, message, fix]]);
  });
});

describe("use lines", () => {
  test("a preset the file does not import, with the nearest import as advice, or the import to add", () => {
    expect(brief(build({ [FILE]: arch("  use preset=MeshRecomended\n") }).diagnostics)).toEqual([
      [FILE, 3, 13, "MESH_UNKNOWN_IMPORT", "`MeshRecomended` is not an imported preset: the architecture file includes a preset it imports from \"meshfw/architecture\". Did you mean `MeshRecommended`?", null],
    ]);
    expect(brief(build({ [FILE]: arch("  use preset=MeshRecommended\n", "") }).diagnostics)).toEqual([
      [FILE, 2, 13, "MESH_UNKNOWN_IMPORT", "`MeshRecommended` is not an imported preset: the architecture file includes a preset it imports from \"meshfw/architecture\"", 'add `import { MeshRecommended } from "meshfw/architecture"`'],
    ]);
    // A member of a namespace passes MX's reference check; no preset is a namespace member.
    expect(codes(build({ [FILE]: arch("  use preset=presets.MeshRecommended\n") }).diagnostics)).toEqual([[FILE, 3, 13, "MESH_UNKNOWN_IMPORT"]]);
  });
  test("one preset used twice, under its name or an alias, is a duplicate at the later line", () => {
    const twice = arch("  use preset=MeshRecommended\n  use preset=R\n", 'import { MeshRecommended, MeshRecommended as R } from "meshfw/architecture"\n');
    expect(brief(build({ [FILE]: twice }).diagnostics)).toEqual([
      [FILE, 4, 2, "MESH_DUPLICATE_MEMBER", "Duplicate use of the preset MeshRecommended: this file already uses it", "remove this line"],
    ]);
  });
});

describe("settings (R9 to R15, ruling D40 OD3 to OD5)", () => {
  test("no line, or only the recommended preset, is every rule at its default level", () => {
    expect(settingsOf("architecture :project\n")).toEqual({ settings: DEFAULTS, diagnostics: [] });
    expect(settingsOf(arch("  use preset=MeshRecommended\n"))).toEqual({ settings: DEFAULTS, diagnostics: [] });
    expect(Object.keys(DEFAULTS)).toEqual(ARCHITECTURE_RULES.map((rule) => rule.name));
    expect(PRESETS.get("MeshRecommended")).toEqual(DEFAULT_SETTINGS);
  });
  test("the file's own lines win over a preset, in any order", () => {
    const expected = { "action-calls-other-aggregate": "error", "service-touches-one-entity": "off" };
    expect(settingsOf(SPEC)).toEqual({ settings: expected, diagnostics: [] });
    expect(settingsOf(arch("  severity :action-calls-other-aggregate level=:error\n  disable :service-touches-one-entity\n  use preset=MeshRecommended\n"))).toEqual({ settings: expected, diagnostics: [] });
  });
  test("an unknown rule, with and without a suggestion; it sets nothing", () => {
    const fix = "the rules are :action-calls-other-aggregate and :service-touches-one-entity";
    expect(settingsOf(arch("  disable :serviceTouchesOneEntity\n  severity :cross-aggregate level=:error\n"))).toEqual({
      settings: DEFAULTS,
      diagnostics: [
        [FILE, 3, 10, "MESH_UNKNOWN_RULE", "`:serviceTouchesOneEntity` is not an architecture rule", fix],
        [FILE, 4, 11, "MESH_UNKNOWN_RULE", "`:cross-aggregate` is not an architecture rule", fix],
      ],
    });
    expect(settingsOf(arch("  disable :action-calls-other-agregate\n")).diagnostics).toEqual([
      [FILE, 3, 10, "MESH_UNKNOWN_RULE", "`:action-calls-other-agregate` is not an architecture rule. Did you mean `:action-calls-other-aggregate`?", fix],
    ]);
  });
  test("one rule set by two of the file's lines is a duplicate at the later line, which sets nothing", () => {
    for (const second of ["  disable :service-touches-one-entity\n", "  severity :service-touches-one-entity level=:error\n"])
      expect(settingsOf(arch(`  disable :service-touches-one-entity\n${second}`))).toEqual({
        settings: { ...DEFAULTS, "service-touches-one-entity": "off" },
        diagnostics: [[FILE, 4, 2, "MESH_DUPLICATE_MEMBER", "Duplicate setting of `:service-touches-one-entity`: line 3 already sets it", "keep one line for the rule"]],
      });
  });
  test.each([
    ["severity with no level", "  severity :service-touches-one-entity\n"],
    ["a level that is no level", "  severity :service-touches-one-entity level=:info\n"],
    ["disable with no name", "  disable\n"],
    ["a call as preset", "  use preset=foo()\n"],
    ["use alone", "  use\n"],
  ])("a line MX refused adds no diagnostic and no setting: %s", (_, line) => {
    expect(settingsOf(arch(line))).toEqual({ settings: DEFAULTS, diagnostics: [] });
  });
});

describe("R8: no file imports the architecture file", () => {
  const ARCH = { [FILE]: "architecture :project\n" };
  test("by name, at each binding; a binding used as a reference also draws the reference's error", () => {
    const list = 'import { Project } from "../architecture.mesh.mx"\nentity :List\n  attributes\n    uuid :id primary-key\n  relationships\n    belongs-to :project entity=Project\n  actions auto=[:read]\n';
    expect(brief(build({ ...ARCH, "todo/list.mesh.mx": list }).diagnostics)).toEqual([
      ["todo/list.mesh.mx", 1, 9, "MESH_UNKNOWN_IMPORT", "`Project` is not what ../architecture.mesh.mx declares: it is the architecture file, which declares nothing to import", "remove the import"],
      ["todo/list.mesh.mx", 6, 31, "MESH_UNKNOWN_ENTITY", "Project is not an imported entity.", null],
    ]);
  });
  test("as a namespace, once at the import", () => {
    const list = `import * as rules from "../architecture.mesh.mx"\n${LIST}`;
    expect(brief(build({ ...ARCH, "todo/list.mesh.mx": list }).diagnostics)).toEqual([
      ["todo/list.mesh.mx", 1, 0, "MESH_UNKNOWN_IMPORT", "../architecture.mesh.mx is the architecture file, which declares nothing to import", "remove the import"],
    ]);
  });
  test("from an aggregate file too", () => {
    const aggregate = 'import { List } from "./list.mesh.mx"\nimport { Project } from "../architecture.mesh.mx"\naggregate :Lists\n  root entity=List\n';
    expect(codes(build({ ...ARCH, "todo/list.mesh.mx": LIST, "todo/lists.mesh.mx": aggregate }).diagnostics)).toEqual([
      ["todo/lists.mesh.mx", 2, 9, "MESH_UNKNOWN_IMPORT"],
    ]);
  });
});

describe("other files and meshfw/architecture (R19)", () => {
  test("an entity file that imports it is refused; an event file keeps its own message; a package import keeps its message", () => {
    const entity = `import { MeshRecommended } from "meshfw/architecture"\n${LIST}`;
    expect(codes(build({ "todo/list.mesh.mx": entity }).diagnostics)).toEqual([["todo/list.mesh.mx", 1, 0, "MESH_UNKNOWN_IMPORT"]]);
    const event = 'import { MeshRecommended } from "meshfw/architecture"\nevent :Paid\n  uuid :id\n';
    expect(brief(build({ "todo/paid.mesh.mx": event }).diagnostics)).toEqual([
      ["todo/paid.mesh.mx", 1, 0, "MESH_UNKNOWN_IMPORT", "An event file takes no import: its fields are attribute lines, whose kinds are attribute types", "remove the import"],
    ]);
    expect(brief(build({ "todo/list.mesh.mx": `import { z } from "zod"\n${LIST}` }).diagnostics)).toEqual([
      ["todo/list.mesh.mx", 1, 0, "MESH_UNKNOWN_IMPORT", 'The import path must be relative (start with ./ or ../), or be "meshfw" for Mesh\'s own functions (`import { Mesh } from "meshfw"`)', null],
    ]);
  });
});

describe("a project on disk: the domain root never moves for the file", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  const data = { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: { file: "app.db" } };
  async function project(domain: string | string[], files: Files) {
    const root = await mkdtemp(resolve(tmpdir(), "mesh-architecture-"));
    roots.push(root);
    for (const [file, source] of Object.entries(files)) {
      await mkdir(resolve(root, file, ".."), { recursive: true });
      await writeFile(resolve(root, file), source);
    }
    await writeFile(resolve(root, "mesh.config.ts"), `export default ${JSON.stringify({ domain, output: ".mesh", data })}`);
    const loaded = await loadConfig(root);
    expect(loaded.diagnostics).toEqual([]);
    return { root, loaded: loaded.config!, built: await loadProject(loaded.config!) };
  }
  const work = { "src/domain/work/list.mesh.mx": LIST };
  test("a folder and a glob domain read the file at their root", async () => {
    for (const domain of ["src/domain", "src/domain/**/*.mesh.mx"]) {
      const { built } = await project(domain, { ...work, [`src/domain/${FILE}`]: SPEC });
      expect(built.diagnostics).toEqual([]);
      expect(built.document!.entities.map((e) => e.fqn)).toEqual(["work.List"]);
    }
  });
  test("a list: the file is left out of the common parent", async () => {
    const listed = ["src/domain/work/list.mesh.mx"];
    const alone = await project(listed, work);
    const rootOf = (made: Awaited<ReturnType<typeof project>>) => relative(made.root, made.loaded.domainRoot);
    expect(rootOf(alone)).toBe("src/domain/work");
    expect(alone.built.document!.entities.map((e) => e.fqn)).toEqual(["List"]);
    // Listed beside the entity, in its folder: the root and the FQN stay, and the file is in place.
    const beside = await project([...listed, `src/domain/work/${FILE}`], { ...work, [`src/domain/work/${FILE}`]: SPEC });
    expect(rootOf(beside)).toBe("src/domain/work");
    expect(beside.built.diagnostics).toEqual([]);
    expect(beside.built.document!.entities.map((e) => e.fqn)).toEqual(["List"]);
    // Listed above it: the root does not widen to reach it, so the file is out of place.
    const above = await project([...listed, `src/domain/${FILE}`], { ...work, [`src/domain/${FILE}`]: SPEC });
    expect(rootOf(above)).toBe("src/domain/work");
    expect(codes(above.built.diagnostics)).toEqual([[`src/domain/${FILE}`, 3, 0, "MESH_ARCHITECTURE_FILE"]]);
  });
  test("a list that names the file alone takes its folder as the root", async () => {
    const { loaded, built } = await project([`src/domain/${FILE}`], { [`src/domain/${FILE}`]: SPEC });
    expect(loaded.domainRoot).toBe(resolve(loaded.root, "src/domain"));
    expect(built.diagnostics).toEqual([]);
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModel } from "../src/front-end/build.ts";

// The paths an import may take, by the kind of the importing file (`notes/spec/imports-and-scope.md`, "Paths"; bead
// `mesh-imports-any-package`): a relative `.mesh.mx` path, a helper anywhere in the project, and of the packages only
// those the file's kind takes. An entity file takes "meshfw" and "meshfw/mixins", a service file "meshfw", an aggregate
// file none, and "meshfw/architecture" is the architecture file's alone. Any other package path is refused by its path,
// whatever the import's form, with a message that names only what that file may import. The entity-file rows for each
// form are in `shipped-mixins.test.ts`; the architecture file's own imports in `architecture-file.test.ts`.

const root = mkdtempSync(join(tmpdir(), "mesh-import-paths-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, "src/domain/x"), { recursive: true });
mkdirSync(join(root, "src/lib/folder"), { recursive: true });
writeFileSync(join(root, "src/lib/rules.ts"), "export const a = () => 1;\n");
writeFileSync(join(root, "src/lib/view.tsx"), "export const b = () => 1;\n");
writeFileSync(join(root, "src/lib/old.js"), "export const c = () => 1;\n");
writeFileSync(join(root, "src/lib/other.mesh.mx"), "entity :Other\n  attributes\n    uuid :id primary-key\n");

type Files = Record<string, string>;
const build = (files: Files) =>
  buildModel({ root, domainRoot: "src/domain", files: Object.entries(files).map(([file, source]) => ({ file, source })) });
/** Each diagnostic as `[file, line, column, code, message, fix]`. */
const found = (files: Files) => build(files).diagnostics.map((d) => [d.position.file, d.position.line, d.position.column, d.code, d.message, d.fix]);

const entity = (name: string, { imports = "", lines = "" } = {}) =>
  `${imports}entity :${name}\n  attributes\n    uuid :id primary-key\n${lines}  actions auto=[:read]\n  policies\n    policy :anyone\n      authorize-if=() => true\n`;
const A = entity("A");
const B = entity("B", { imports: 'import { A } from "./a.mesh.mx"\n', lines: "  relationships\n    belongs-to :a entity=A\n" });
const DOMAIN: Files = { "src/domain/x/a.mesh.mx": A, "src/domain/x/b.mesh.mx": B };
const E_FILE = "src/domain/x/e.mesh.mx";
const WORK_FILE = "src/domain/x/work.mesh.mx";
const AGG_FILE = "src/domain/x/agg.mesh.mx";
const service = (line: string, run = "return 1") =>
  `${line}\nimport { A } from "./a.mesh.mx"\nimport { B } from "./b.mesh.mx"\nservice :Work\n  operation :go\n    uses entity=A actions=[:read]\n    uses entity=B actions=[:read]\n    run() {\n      ${run}\n    }\n  policies\n    policy :everyone\n      authorize-if=() => true\n`;
const aggregate = (line: string, parts = "    B\n") =>
  `${line}\nimport { A } from "./a.mesh.mx"\nimport { B } from "./b.mesh.mx"\naggregate :Agg\n  root entity=A\n  entities\n${parts}`;

const MESH = '"meshfw" for Mesh\'s own functions (`import { Mesh } from "meshfw"`)';
const MIXINS = '"meshfw/mixins" for Mesh\'s mixins (`import { Timestamps } from "meshfw/mixins"`)';
const ENTITY_PACKAGE = `The import path must be relative (start with ./ or ../), or be ${MESH} or ${MIXINS}`;
const SERVICE_PACKAGE = `The import path must be relative (start with ./ or ../), or be ${MESH}`;
const AGGREGATE_PACKAGE = "An aggregate file imports only .mesh.mx files: its handlers call actions of the entities it imports, not a package";
const AGGREGATE_MESH = "An aggregate file imports only .mesh.mx files: its handlers call actions of the entities it imports, not `Mesh`";
const ARCHITECTURE = '"meshfw/architecture" gives Mesh\'s presets to the architecture file (architecture.mesh.mx), the one file that imports it';
const MIXINS_ELSEWHERE = "\"meshfw/mixins\" gives an entity file Mesh's mixins, which it includes with `use mixin=Name`, and this file includes none";

describe("an entity file", () => {
  test.each([
    ['import { a } from "../../lib/rules"'],
    ['import { a } from "../../lib/rules.ts"'],
    ['import { b } from "../../lib/view"'],
    ['import { c } from "../../lib/old"'],
    ['import * as rules from "../../lib/rules"'],
  ])("takes a helper from anywhere in the project: %s", (line) => {
    expect(found({ ...DOMAIN, [E_FILE]: entity("E", { imports: `${line}\n` }) })).toEqual([]);
  });
  test.each([
    ['import { c } from "../../lib/folder"', "../../lib/folder"],
    ['import { c } from "../../lib/gone"', "../../lib/gone"],
    ['import { c } from "../../../../outside"', "../../../../outside"],
  ])("refuses a relative path no file of the project answers: %s", (line, path) => {
    expect(found({ ...DOMAIN, [E_FILE]: entity("E", { imports: `${line}\n` }) })).toEqual([
      [E_FILE, 1, 0, "MESH_UNKNOWN_IMPORT", `Cannot resolve import ${JSON.stringify(path)} inside the project`, null],
    ]);
  });
  test("refuses a .mesh.mx file of the project outside the domain root", () => {
    expect(found({ ...DOMAIN, [E_FILE]: entity("E", { imports: 'import { Other } from "../../lib/other.mesh.mx"\n' }) })).toEqual([
      [E_FILE, 1, 0, "MESH_UNKNOWN_ENTITY", "../../lib/other.mesh.mx exists but is not under the configured entity directories", null],
    ]);
  });
  test.each([
    'import { MeshRecommended } from "meshfw/architecture"',
    'import * as presets from "meshfw/architecture"',
    'import type { MeshRecommended } from "meshfw/architecture"',
    'import "meshfw/architecture"',
  ])("refuses meshfw/architecture by its path, whatever the form: %s", (line) => {
    expect(found({ ...DOMAIN, [E_FILE]: entity("E", { imports: `${line}\n` }) })).toEqual([
      [E_FILE, 1, 0, "MESH_UNKNOWN_IMPORT", ARCHITECTURE, "remove the import"],
    ]);
  });
  test.each([
    'import { z } from "zod"',
    'import "zod"',
    'import type { Z } from "zod"',
    'import { x } from "@acme/rules"',
    'import { readFileSync } from "node:fs"',
    'import { a } from "/abs/rules"',
    'import { a } from "meshfw/"',
    'import { a } from "meshfw/runtime"',
    'import { a } from "meshfwx"',
    'import { a } from "."',
    'import { a } from ".."',
  ])("refuses any other package path by its path: %s", (line) => {
    expect(found({ ...DOMAIN, [E_FILE]: entity("E", { imports: `${line}\n` }) })).toEqual([[E_FILE, 1, 0, "MESH_UNKNOWN_IMPORT", ENTITY_PACKAGE, null]]);
  });
  test("a name only a refused package import binds draws nothing more where it is used", () => {
    const lines = "  use mixin=Audited\n";
    expect(found({ ...DOMAIN, [E_FILE]: entity("E", { imports: 'import { Audited } from "@acme/mixins"\nimport { Other } from "meshfw/architecture"\n', lines: `${lines}  relationships\n    belongs-to :other entity=Other\n` }) }).map((d) => [d[1], d[3]])).toEqual([
      [1, "MESH_UNKNOWN_IMPORT"],
      [2, "MESH_UNKNOWN_IMPORT"],
    ]);
  });
});

describe("a service file", () => {
  test.each([
    ['import { Mesh } from "meshfw"'],
    ['import { a } from "../../lib/rules"'],
  ])("takes %s", (line) => {
    expect(found({ ...DOMAIN, [WORK_FILE]: service(line) })).toEqual([]);
  });
  test.each([
    'import { z } from "zod"',
    'import z from "zod"',
    'import * as z from "zod"',
    'import "zod"',
    'import type { Z } from "zod"',
    'import { Mesh } from "@meshfw/runtime"',
  ])("refuses another package with a message that names only meshfw: %s", (line) => {
    expect(found({ ...DOMAIN, [WORK_FILE]: service(line) })).toEqual([[WORK_FILE, 1, 0, "MESH_UNKNOWN_IMPORT", SERVICE_PACKAGE, null]]);
  });
  test("refuses meshfw/architecture as the architecture file's", () => {
    expect(found({ ...DOMAIN, [WORK_FILE]: service('import { MeshRecommended } from "meshfw/architecture"') })).toEqual([
      [WORK_FILE, 1, 0, "MESH_UNKNOWN_IMPORT", ARCHITECTURE, "remove the import"],
    ]);
  });
  test("refuses meshfw/mixins: only an entity includes a mixin", () => {
    expect(found({ ...DOMAIN, [WORK_FILE]: service('import { Timestamps } from "meshfw/mixins"') })).toEqual([
      [WORK_FILE, 1, 0, "MESH_UNKNOWN_IMPORT", MIXINS_ELSEWHERE, "remove the import"],
    ]);
  });
  test("a name a refused package import binds, called in a run body, draws nothing more", () => {
    expect(found({ ...DOMAIN, [WORK_FILE]: service('import { z } from "zod"', "return z.string()") }).map((d) => [d[1], d[3]])).toEqual([[1, "MESH_UNKNOWN_IMPORT"]]);
  });
});

describe("an aggregate file", () => {
  test.each([
    ['import { Mesh } from "meshfw"'],
    ['import Mesh from "meshfw"'],
    ['import * as M from "meshfw"'],
    ['import type { Mesh } from "meshfw"'],
  ])("refuses meshfw by its path, before its form: %s", (line) => {
    expect(found({ ...DOMAIN, [AGG_FILE]: aggregate(line) })).toEqual([[AGG_FILE, 1, 0, "MESH_UNKNOWN_IMPORT", AGGREGATE_MESH, "remove the import"]]);
  });
  test.each([
    'import { z } from "zod"',
    'import z from "zod"',
    'import "zod"',
  ])("refuses any other package with its own message: %s", (line) => {
    expect(found({ ...DOMAIN, [AGG_FILE]: aggregate(line) })).toEqual([[AGG_FILE, 1, 0, "MESH_UNKNOWN_IMPORT", AGGREGATE_PACKAGE, "remove the import"]]);
  });
  test("refuses meshfw/architecture as the architecture file's", () => {
    expect(found({ ...DOMAIN, [AGG_FILE]: aggregate('import { MeshRecommended } from "meshfw/architecture"') })).toEqual([
      [AGG_FILE, 1, 0, "MESH_UNKNOWN_IMPORT", ARCHITECTURE, "remove the import"],
    ]);
  });
  test("a part named through a refused package import draws nothing more", () => {
    expect(found({ ...DOMAIN, [AGG_FILE]: aggregate('import { C } from "@acme/domain"', "    B\n    C\n") }).map((d) => [d[1], d[3]])).toEqual([[1, "MESH_UNKNOWN_IMPORT"]]);
  });
});

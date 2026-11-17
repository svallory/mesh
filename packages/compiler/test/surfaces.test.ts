// Surface files in the model (`notes/architecture/surfaces-design.md`, PR 1, sections 2, 5 and 6; ruling D41): the
// files of the configured surfaces folder, built into `ModelDocument.surfaces` by `buildSurface` (`front-end/build.ts`)
// and checked against the built entities by `resolveSurfaces` (`model/surfaces.ts`), the place rules
// (`MESH_SURFACE_PATH`), the import rules (R4, R5, OD5) and a project without surfaces, whose document is unchanged.
import { describe, expect, test } from "bun:test";
import type { Diagnostic, Surface } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";
import { stableJsonStringify } from "../src/index.ts";

type Files = Record<string, string>;
/** The domain: Task with every kind of member `fields=` may or may not name, and every kind of action. */
const TASK = `import { User } from "../people/user.mesh.mx"
import { Step } from "./step.mesh.mx"
import { Brief } from "./brief.mesh.mx"
import { Tag } from "./tag.mesh.mx"
import { TaskTag } from "./task-tag.mesh.mx"
import { CompleteTask } from "./complete-task.mesh.mx"
import { TaskCompleted } from "./task-completed.mesh.mx"

entity :Task
  attributes
    uuid :id primary-key
    string :title min=1
    enum :state values=[:open, :done] default=:open
    string :notes nullable
  relationships
    belongs-to :owner entity=User
    has-many :steps entity=Step
    has-one :brief entity=Brief
    has-many :tags entity=Tag through=TaskTag
  computed
    string :summary() { return &title }
    count :stepCount of=&steps
  actions auto=[:read, :create]
    update :complete
      do
        set
          &state=:done
        publish=() => new TaskCompleted({ taskId: &id })
    read :open
      filter=() => &state === :open
    update on=CompleteTask
  policies
    policy :anyone
      authorize-if=() => true
`;
const owned = (name: string, extra = "") => `import { Task } from "./task.mesh.mx"
entity :${name}
  attributes
    uuid :id primary-key
  relationships
    belongs-to :task entity=Task${extra}
  actions auto=[:read]
  policies
    policy :anyone
      authorize-if=() => true
`;
const plain = (name: string) => `entity :${name}
  attributes
    uuid :id primary-key
  actions auto=[:read]
  policies
    policy :anyone
      authorize-if=() => true
`;
const DOMAIN: Files = {
  "src/domain/work/task.mesh.mx": TASK,
  "src/domain/work/step.mesh.mx": owned("Step"),
  "src/domain/work/brief.mesh.mx": owned("Brief"),
  "src/domain/work/tag.mesh.mx": plain("Tag"),
  "src/domain/work/task-tag.mesh.mx": owned("TaskTag", '\n    belongs-to :tag entity=Tag').replace('import { Task } from "./task.mesh.mx"\n', 'import { Task } from "./task.mesh.mx"\nimport { Tag } from "./tag.mesh.mx"\n'),
  "src/domain/people/user.mesh.mx": plain("User"),
  "src/domain/work/task-completed.mesh.mx": "event :TaskCompleted\n  uuid :taskId\n",
  "src/domain/work/complete-task.mesh.mx": "command :CompleteTask\n  uuid :id\n",
};
const IMPORT = 'import { Task } from "../../domain/work/task.mesh.mx"\n';
const ADMIN = `${IMPORT}
surface :admin
  expose :tasks entity=Task label="Tasks" fields=[:id, :title, :state]
    action :read
    action :complete
`;
const ADMIN_FILE = "src/surfaces/admin/admin.mesh.mx";
const build = (surfaces: Files | undefined, domain: Files = DOMAIN, root = "src/surfaces") =>
  buildModel({
    root: "/project",
    domainRoot: "src/domain",
    files: Object.entries(domain).map(([file, source]) => ({ file, source })),
    ...(surfaces ? { surfaces: { root, files: Object.entries(surfaces).map(([file, source]) => ({ file, source })) } } : {}),
  });
const brief = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => [d.position.file, d.position.line, d.position.column, d.code, d.message, d.fix]);
/** The errors only (the fixture's command answered by `update on=` builds clean). */
const errors = (result: ReturnType<typeof build>) => brief(result.diagnostics.filter((d) => d.severity === "error"));
const admin = (lines: string, imports = IMPORT) => ({ [ADMIN_FILE]: `${imports}surface :admin\n${lines}` });
const surfaceOf = (result: ReturnType<typeof build>): Surface => result.document!.surfaces![0]!;

describe("the model", () => {
  test("the example builds into ModelDocument.surfaces", () => {
    const result = build({ [ADMIN_FILE]: ADMIN });
    expect(brief(result.diagnostics)).toEqual([]);
    expect(result.document!.surfaces).toEqual([{
      name: "admin",
      file: ADMIN_FILE,
      expose: [{
        name: "tasks", entity: "work.Task", identifier: "Task", label: "Tasks", fields: ["id", "title", "state"],
        actions: [
          { name: "read", position: { file: ADMIN_FILE, line: 5, column: 4, offset: expect.any(Number) } },
          { name: "complete", position: { file: ADMIN_FILE, line: 6, column: 4, offset: expect.any(Number) } },
        ],
        position: { file: ADMIN_FILE, line: 4, column: 2, offset: expect.any(Number) },
      }],
      position: { file: ADMIN_FILE, line: 3, column: 0, offset: expect.any(Number) },
    }]);
  });
  test("fields=:all is \"all\"; no fields= is []; no label leaves label absent", () => {
    const all = surfaceOf(build(admin("  expose :tasks entity=Task fields=:all\n"))).expose[0]!;
    expect(all.fields).toBe("all");
    const none = surfaceOf(build(admin("  expose :tasks entity=Task\n"))).expose[0]!;
    expect(none.fields).toEqual([]);
    expect(Object.hasOwn(none, "label")).toBe(false);
    expect(none.actions).toEqual([]);
  });
  test("a namespace member and an alias resolve to the entity", () => {
    const namespace = build(admin("  expose :tasks entity=work.Task\n", 'import * as work from "../../domain/work/task.mesh.mx"\n'));
    expect(brief(namespace.diagnostics)).toEqual([]);
    expect(surfaceOf(namespace).expose[0]).toMatchObject({ entity: "work.Task", identifier: "work.Task" });
    const alias = build(admin("  expose :tasks entity=T\n", 'import { Task as T } from "../../domain/work/task.mesh.mx"\n'));
    expect(brief(alias.diagnostics)).toEqual([]);
    expect(surfaceOf(alias).expose[0]).toMatchObject({ entity: "work.Task", identifier: "T" });
  });
  test("surfaces with no line, and two surfaces, ordered by file in the document", () => {
    const result = build({
      "src/surfaces/public/public.mesh.mx": "surface :public\n",
      [ADMIN_FILE]: ADMIN,
    });
    expect(brief(result.diagnostics)).toEqual([]);
    expect(result.document!.surfaces!.map(({ name, expose }) => [name, expose.length])).toEqual([["public", 0], ["admin", 1]]);
  });
  test("a configured surfaces folder with no file adds no surfaces key", () => {
    expect(Object.hasOwn(build({})!.document!, "surfaces")).toBe(false);
  });
  test("a project without surfaces keeps its document byte for byte", () => {
    const without = build(undefined);
    const empty = build({});
    expect(Object.hasOwn(without.document!, "surfaces")).toBe(false);
    expect(stableJsonStringify(empty.document)).toBe(stableJsonStringify(without.document));
    // With a surface, only the `surfaces` key is added.
    const { surfaces, ...rest } = build({ [ADMIN_FILE]: ADMIN }).document!;
    expect(surfaces).toHaveLength(1);
    expect(stableJsonStringify(rest)).toBe(stableJsonStringify(without.document));
  });
});

describe("fields= and action lines against the entity", () => {
  test.each([
    ["a belongs-to", "[:owner]"],
    ["a function and a rollup computed field", "[:summary, :stepCount]"],
    ["every attribute", "[:id, :title, :state, :notes]"],
  ])("%s may leave", (_, fields) => expect(errors(build(admin(`  expose :tasks entity=Task fields=${fields}\n`)))).toEqual([]));
  test.each([
    ["has-many", ":steps", "has-many", "work.Step"],
    ["has-one", ":brief", "has-one", "work.Brief"],
    ["has-many through", ":tags", "has-many", "work.Tag"],
  ])("a %s is refused at the item (MESH_OPTION_VALUE)", (_, field, kind, target) => {
    expect(errors(build(admin(`  expose :tasks entity=Task fields=[:id, ${field}]\n`)))).toEqual([
      [ADMIN_FILE, 3, 41, "MESH_OPTION_VALUE", `${field} is a ${kind} of work.Task, and a related record does not leave through a surface: expose ${target} on a line of its own`, null],
    ]);
  });
  test("an unknown field suggests the nearest; a key column suggests its belongs-to", () => {
    expect(errors(build(admin("  expose :tasks entity=Task fields=[:titel, :ownerId, :all]\n")))).toEqual([
      [ADMIN_FILE, 3, 36, "MESH_UNKNOWN_MEMBER", ":titel is not a field of work.Task: `fields=` names the entity's attributes, belongs-to relationships and computed fields (:id, :title, :state, :notes, :owner, :summary, :stepCount). Did you mean :title?", null],
      [ADMIN_FILE, 3, 44, "MESH_UNKNOWN_MEMBER", ":ownerId is not a field of work.Task: `fields=` names the entity's attributes, belongs-to relationships and computed fields (:id, :title, :state, :notes, :owner, :summary, :stepCount). Did you mean :owner?", null],
      [ADMIN_FILE, 3, 54, "MESH_UNKNOWN_MEMBER", ":all is not a field of work.Task: `fields=` names the entity's attributes, belongs-to relationships and computed fields (:id, :title, :state, :notes, :owner, :summary, :stepCount).", null],
    ]);
  });
  test("an auto action, a named read and a command-answering action are actions; an action not generated is not", () => {
    expect(errors(build(admin("  expose :tasks entity=Task\n    action :read\n    action :create\n    action :open\n    action :completeTask\n")))).toEqual([]);
    expect(errors(build(admin("  expose :tasks entity=Task\n    action :destroy\n    action :complet\n")))).toEqual([
      [ADMIN_FILE, 4, 4, "MESH_UNKNOWN_ACTION", ":destroy is not an action of work.Task: an `action` line names one of the entity's own actions (:complete, :open, :completeTask, :read, :create).", null],
      [ADMIN_FILE, 5, 4, "MESH_UNKNOWN_ACTION", ":complet is not an action of work.Task: an `action` line names one of the entity's own actions (:complete, :open, :completeTask, :read, :create). Did you mean :complete?", null],
    ]);
  });
  test("duplicates in one surface (OD4)", () => {
    expect(errors(build(admin("  expose :tasks entity=Task\n    action :read\n    action :read\n  expose :tasks entity=work.Task\n  expose :users entity=User\n", `${IMPORT}import * as work from "../../domain/work/task.mesh.mx"\nimport { User } from "../../domain/people/user.mesh.mx"\n`)))).toEqual([
      [ADMIN_FILE, 7, 4, "MESH_DUPLICATE_MEMBER", "Duplicate action :read in expose :tasks", null],
      [ADMIN_FILE, 8, 2, "MESH_DUPLICATE_MEMBER", "Duplicate expose :tasks in surface admin", null],
      [ADMIN_FILE, 8, 2, "MESH_DUPLICATE_MEMBER", "work.Task is already exposed as :tasks at line 5: a surface exposes an entity once", null],
    ]);
  });
  test("two surfaces may expose one entity under one name", () => {
    expect(errors(build({ [ADMIN_FILE]: ADMIN, "src/surfaces/public/public.mesh.mx": ADMIN.replace(":admin", ":public") }))).toEqual([]);
  });
  test("entity= naming an event or a command is no entity", () => {
    const imports = 'import { TaskCompleted } from "../../domain/work/task-completed.mesh.mx"\nimport { CompleteTask } from "../../domain/work/complete-task.mesh.mx"\n';
    expect(errors(build(admin("  expose :a entity=TaskCompleted\n  expose :b entity=CompleteTask\n", imports)))).toEqual([
      [ADMIN_FILE, 4, 19, "MESH_UNKNOWN_ENTITY", "TaskCompleted is not an imported entity.", null],
      [ADMIN_FILE, 5, 19, "MESH_UNKNOWN_ENTITY", "CompleteTask is not an imported entity.", null],
    ]);
  });
  test("an unknown entity name suggests the import; an unresolved import reports once", () => {
    expect(errors(build(admin("  expose :tasks entity=Taks\n")))).toEqual([
      [ADMIN_FILE, 3, 23, "MESH_UNKNOWN_ENTITY", "Taks is not an imported entity. Did you mean Task?", null],
    ]);
    expect(errors(build(admin("  expose :tasks entity=Task fields=[:nope]\n    action :nope\n", 'import { Task } from "../../domain/work/missing.mesh.mx"\n')))).toEqual([
      [ADMIN_FILE, 1, 0, "MESH_UNKNOWN_IMPORT", 'Cannot resolve import "../../domain/work/missing.mesh.mx" inside the project', null],
    ]);
  });
});

describe("names, places and roots", () => {
  test("__proto__ as a surface or an exposed name (MESH_NAME)", () => {
    expect(errors(build({ "src/surfaces/__proto__/admin.mesh.mx": `${IMPORT}surface :__proto__\n  expose :__proto__ entity=Task\n` }))).toEqual([
      ["src/surfaces/__proto__/admin.mesh.mx", 2, 0, "MESH_NAME", ":__proto__ cannot be a surface name: __proto__ sets an object's prototype instead of adding a property. Choose another name.", null],
      ["src/surfaces/__proto__/admin.mesh.mx", 3, 2, "MESH_NAME", ":__proto__ cannot be an exposed name: __proto__ sets an object's prototype instead of adding a property. Choose another name.", null],
    ]);
  });
  test("a surface file in a folder of another name, or directly in the surfaces root (OD2)", () => {
    expect(errors(build({ "src/surfaces/console/admin.mesh.mx": ADMIN, "src/surfaces/loose.mesh.mx": ADMIN.replace(":admin", ":loose") }))).toEqual([
      ["src/surfaces/console/admin.mesh.mx", 3, 0, "MESH_SURFACE_PATH", "Surface :admin is declared in `src/surfaces/console/admin.mesh.mx`; a surface file lives in the folder named after its surface, `src/surfaces/admin/`", "move the file to `src/surfaces/admin/`, or rename the surface `:console`"],
      ["src/surfaces/loose.mesh.mx", 3, 0, "MESH_SURFACE_PATH", "Surface :loose is declared in `src/surfaces/loose.mesh.mx`; a surface file lives in the folder named after its surface, `src/surfaces/loose/`", "move the file to `src/surfaces/loose/`"],
    ]);
    // A nested folder named after the surface is not its folder either.
    expect(errors(build({ "src/surfaces/x/admin/admin.mesh.mx": ADMIN })).map(([, , , code]) => code)).toEqual(["MESH_SURFACE_PATH"]);
  });
  test("a file of the surfaces folder whose root is not a surface", () => {
    expect(errors(build({ "src/surfaces/admin/task.mesh.mx": "entity :Task\n  attributes\n    uuid :id primary-key\n" }))).toEqual([
      ["src/surfaces/admin/task.mesh.mx", 1, 0, "MESH_SURFACE_PATH", "`src/surfaces/admin/task.mesh.mx` declares `entity :Task`; the surfaces folder holds surface files only", "move it under the domain folder (`src/domain`)"],
    ]);
  });
  test("two roots in a surface file: one error at the second, and the first is read alone", () => {
    expect(errors(build({ [ADMIN_FILE]: `${ADMIN}entity :Extra\n` }))).toEqual([
      [ADMIN_FILE, 7, 0, "MESH_DUPLICATE_ENTITY", "A surface file must contain exactly one surface", null],
    ]);
    expect(errors(build({ [ADMIN_FILE]: `entity :Extra\n${ADMIN.replace(IMPORT, "")}` }))).toEqual([
      [ADMIN_FILE, 1, 0, "MESH_SURFACE_PATH", "`src/surfaces/admin/admin.mesh.mx` declares `entity :Extra`; the surfaces folder holds surface files only", "move it under the domain folder (`src/domain`)"],
      [ADMIN_FILE, 3, 0, "MESH_DUPLICATE_ENTITY", "A surface file must contain exactly one surface", null],
    ]);
  });
  test("two surfaces of one name", () => {
    expect(errors(build({ [ADMIN_FILE]: ADMIN, "src/surfaces/admin/second.mesh.mx": "surface :admin\n" }))).toEqual([
      ["src/surfaces/admin/second.mesh.mx", 1, 0, "MESH_DUPLICATE_ENTITY", `Duplicate surface admin; first declared in ${ADMIN_FILE}`, null],
    ]);
  });
  test("a surface root in a domain file, with and without a surfaces folder", () => {
    const domain = { ...DOMAIN, "src/domain/admin.mesh.mx": "surface :admin\n" };
    expect(errors(build(undefined, domain))).toEqual([
      ["src/domain/admin.mesh.mx", 1, 0, "MESH_SURFACE_PATH", "A surface file lives in the surfaces folder, not in the domain: the domain never imports a surface", 'move it to a surfaces folder, `src/surfaces/admin/`, and set `surfaces: "src/surfaces"` in mesh.config.ts'],
    ]);
    expect(errors(build({}, domain))).toEqual([
      ["src/domain/admin.mesh.mx", 1, 0, "MESH_SURFACE_PATH", "A surface file lives in the surfaces folder, not in the domain: the domain never imports a surface", "move it to `src/surfaces/admin/`"],
    ]);
    // A domain file with a second root that is a surface keeps the duplicate alone.
    expect(errors(build(undefined, { ...DOMAIN, "src/domain/work/tag.mesh.mx": `${plain("Tag")}surface :admin\n` })).map(([, , , code, message]) => [code, message])).toEqual([
      ["MESH_DUPLICATE_ENTITY", "An entity file must contain exactly one entity"],
    ]);
  });
});

describe("imports", () => {
  test("the domain never imports a surface (R4), and the old texts are gone", () => {
    const domain = { ...DOMAIN, "src/domain/work/tag.mesh.mx": `import { Admin } from "../../surfaces/admin/admin.mesh.mx"\n${plain("Tag")}` };
    const result = build({ [ADMIN_FILE]: ADMIN }, domain);
    expect(errors(result)).toEqual([
      ["src/domain/work/tag.mesh.mx", 1, 0, "MESH_UNKNOWN_ENTITY", "../../surfaces/admin/admin.mesh.mx is a surface file: the domain never imports a surface", "remove the import"],
    ]);
    expect(result.diagnostics.some((d) => d.message.includes("Cannot resolve import") || d.message.includes("not under the configured entity directories"))).toBe(false);
  });
  test("a reference through the binding of a surface import reports nothing more", () => {
    const domain = { ...DOMAIN, "src/domain/work/tag.mesh.mx": `import { Admin } from "../../surfaces/admin/admin.mesh.mx"\n${plain("Tag").replace("  actions", "  relationships\n    belongs-to :admin entity=Admin\n  actions")}` };
    expect(errors(build({ [ADMIN_FILE]: ADMIN }, domain)).map(([, line, , code]) => [line, code])).toEqual([[1, "MESH_UNKNOWN_ENTITY"]]);
  });
  test("a surface imports no surface (R5)", () => {
    expect(errors(build({ [ADMIN_FILE]: ADMIN, "src/surfaces/public/public.mesh.mx": 'import { X } from "../admin/admin.mesh.mx"\nsurface :public\n' }))).toEqual([
      ["src/surfaces/public/public.mesh.mx", 1, 0, "MESH_UNKNOWN_ENTITY", "../admin/admin.mesh.mx is a surface file: a surface imports only files under the domain folder", "remove the import"],
    ]);
  });
  test("a helper, a package and meshfw are refused (OD5)", () => {
    const text = "A surface file imports only .mesh.mx files of the domain: its lines name entities and events, and it holds no function";
    expect(errors(build(admin("", `import { h } from "./helpers"\nimport { z } from "zod"\nimport { Mesh } from "meshfw"\n`)))).toEqual([
      [ADMIN_FILE, 1, 0, "MESH_UNKNOWN_IMPORT", text, "remove the import"],
      [ADMIN_FILE, 2, 0, "MESH_UNKNOWN_IMPORT", text, "remove the import"],
      [ADMIN_FILE, 3, 0, "MESH_UNKNOWN_IMPORT", text, "remove the import"],
    ]);
  });
  test("a name the file does not declare, a helper-like name, a duplicate binding, a default import", () => {
    expect(errors(build(admin("", 'import { Tsk } from "../../domain/work/task.mesh.mx"\n')))).toEqual([
      [ADMIN_FILE, 1, 9, "MESH_UNKNOWN_IMPORT", "`Tsk` is not what ../../domain/work/task.mesh.mx declares; it declares `Task`", null],
    ]);
    expect(errors(build(admin("  expose :tasks entity=$T\n", 'import { Task as $T } from "../../domain/work/task.mesh.mx"\n')))).toEqual([
      [ADMIN_FILE, 1, 17, "MESH_HELPER_NAME", "The entity import name $T cannot start with $ or l$: generated code uses those prefixes for its own names", null],
    ]);
    expect(errors(build(admin("", `${IMPORT}import { User as Task } from "../../domain/people/user.mesh.mx"\n`))).map(([, , , code]) => code)).toEqual(["MESH_DUPLICATE_IMPORT"]);
    expect(errors(build(admin("", 'import Task from "../../domain/work/task.mesh.mx"\n'))).map(([, , , code]) => code)).toEqual(["MESH_IMPORT_FORM"]);
  });
  test("a file outside both folders, and one `ignore` excludes", () => {
    const outside = buildModel({
      root: "/project", domainRoot: "src/domain",
      files: Object.entries(DOMAIN).map(([file, source]) => ({ file, source })),
      surfaces: { root: "src/surfaces", files: [{ file: ADMIN_FILE, source: admin("", 'import { Task } from "../../domain/work/ignored.mesh.mx"\n')[ADMIN_FILE]! }] },
      ignored: [{ file: "src/domain/work/ignored.mesh.mx", pattern: "**/ignored.mesh.mx" }],
    });
    expect(brief(outside.diagnostics).map(([, , , code]) => code)).toContain("MESH_IGNORED_IMPORT");
  });
});

describe("regressions", () => {
  test("a surface leaves the unanswered-command check as it was", () => {
    const domain = { ...DOMAIN, "src/domain/work/archive-task.mesh.mx": "command :ArchiveTask\n  uuid :id\n" };
    expect(build({ [ADMIN_FILE]: ADMIN }, domain).diagnostics.filter((d) => d.code === "MESH_COMMAND_UNANSWERED")).toHaveLength(1);
    // A domain file that fails to parse may hold the answering action: no warning, whatever the surfaces parse.
    const broken = { ...domain, "src/domain/work/broken.mesh.mx": "entity :Broken\n  attributes\n    bogus :x\n" };
    expect(build({ [ADMIN_FILE]: ADMIN }, broken).diagnostics.filter((d) => d.code === "MESH_COMMAND_UNANSWERED")).toEqual([]);
  });
  test("a surface that fails to parse does not hide an unanswered command", () => {
    const domain = { ...DOMAIN, "src/domain/work/archive-task.mesh.mx": "command :ArchiveTask\n  uuid :id\n" };
    const result = build({ [ADMIN_FILE]: `${ADMIN}  bogus\n` }, domain);
    expect(result.diagnostics.filter((d) => d.code === "MESH_COMMAND_UNANSWERED")).toHaveLength(1);
  });
});

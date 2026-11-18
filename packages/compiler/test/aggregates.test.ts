// Aggregate files (`notes/architecture/aggregates-design.md`, PR 3; rules R17 to R25 and R24a, rulings D35 OD2 to OD8 and
// OD17): `aggregate :Name`, its `root entity=Name` line, the part lines of its `entities` section and its own `events` and
// `commands` sections. The model records the aggregate (`ModelDocument.aggregates`), `prop=` is resolved against the part's
// `belongs-to` links (`model/aggregates.ts`), and the aggregate's root and parts may publish the events it owns. Nothing is
// generated from an aggregate. Owner sections on an entity are `owner-sections.test.ts` and `owner-sections-inline.test.ts`.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Diagnostic } from "@meshfw/model";
import { buildModel, parseEntitySource } from "../src/front-end/build.ts";
import { aggregatesOf } from "../src/model/aggregates.ts";
import { orderedDocument } from "../src/typescript/emitters/order.ts";
import { generateFiles, writeGeneratedFiles } from "../src/typescript/emit.ts";
import { checkTypes, configOf } from "./generated.ts";
import { closeTypeServer } from "./type-server.ts";

afterAll(closeTypeServer);

/** An entity of `work/` with the given imports, relationships and `go` steps. */
const entity = (name: string, { imports = "", relationships = "", steps = "", sections = "" } = {}) => `${imports}entity :${name}
  attributes
    uuid :id primary-key
${relationships ? `  relationships\n${relationships}` : ""}  actions auto=[:read]
    update :go
      do
${steps || "        run=() => undefined\n"}${sections}`;
const REOPENED = 'import { TaskReopened } from "./task-aggregate.mesh.mx"\n';
const PUBLISH = "        publish=() => new TaskReopened({ taskId: &id })\n";
const TASK = entity("Task", { imports: REOPENED, steps: PUBLISH });
const DEPENDENCY = entity("Dependency", {
  imports: 'import { Task } from "./task.mesh.mx"\nimport { Collaborator } from "../identity/collaborator.mesh.mx"\n' + REOPENED,
  relationships: "    belongs-to :dependent entity=Task\n    belongs-to :prerequisite entity=Task\n    belongs-to :createdBy entity=Collaborator\n",
  steps: PUBLISH,
});
const COMMENT = entity("Comment", {
  imports: 'import { Task } from "./task.mesh.mx"\n' + REOPENED,
  relationships: "    belongs-to :task entity=Task nullable\n",
  steps: PUBLISH,
});
const NOTE = entity("Note");
const COLLABORATOR = entity("Collaborator");
/** The aggregate file, with the part lines and the sections the test writes. */
const aggregate = ({ imports = 'import { Task } from "./task.mesh.mx"\nimport { Dependency } from "./dependency.mesh.mx"\nimport * as talk from "./comment.mesh.mx"\n', root = "Task", parts = "    Dependency prop=:dependent\n    talk.Comment\n", sections = "  events\n    event :TaskReopened\n      uuid :taskId\n", name = "TaskAggregate" } = {}) =>
  `${imports}aggregate :${name}\n  root entity=${root}\n${parts === null ? "" : `  entities\n${parts}`}${sections}`;
const files = (extra: Record<string, string | null> = {}) => ({
  root: "/project",
  files: Object.entries({
    "work/task.mesh.mx": TASK,
    "work/dependency.mesh.mx": DEPENDENCY,
    "work/comment.mesh.mx": COMMENT,
    "work/note.mesh.mx": NOTE,
    "identity/collaborator.mesh.mx": COLLABORATOR,
    "work/task-aggregate.mesh.mx": aggregate(),
    ...extra,
  }).flatMap(([file, source]) => (source === null ? [] : [{ file, source }])),
});
const build = (extra: Record<string, string | null> = {}) => buildModel(files(extra));
const brief = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => [d.position.file, d.position.line, d.position.column, d.code, d.message, d.fix]);
const errors = (result: ReturnType<typeof buildModel>) => brief(result.diagnostics.filter((d) => d.severity === "error"));

/** Task, Dependency and Comment publishing nothing, for the tests of a mistake: a failed line costs no `MESH_PUBLISH` elsewhere. */
const QUIET = {
  "work/task.mesh.mx": entity("Task"),
  "work/dependency.mesh.mx": DEPENDENCY.replace(PUBLISH, "        run=() => undefined\n").replace(REOPENED, ""),
  "work/comment.mesh.mx": COMMENT.replace(PUBLISH, "        run=() => undefined\n").replace(REOPENED, ""),
};
const OTHER = entity("Other", { imports: REOPENED, steps: PUBLISH });
const lowered = (source: string) => parseEntitySource(source, "/project/work/task-aggregate.mesh.mx").diagnostics.map((d) => [d.line, d.column, d.severity, d.code, d.message]);
const HEAD = 'import { Task } from "./task.mesh.mx"\naggregate :TaskAggregate\n';
/** The part lines with the imports they need, for the link tests. */
const withParts = (parts: string, imports = "") => aggregate({ imports: `import { Task } from "./task.mesh.mx"\n${imports}`, parts });
const at = (line: number, column: number, code: string, message: string, fix: string | null = null) => ["work/task-aggregate.mesh.mx", line, column, code, message, fix];

describe("the contracts", () => {
  test("an aggregate with a root, dotted and plain part lines and both owner sections lowers with no diagnostic", () => {
    expect(lowered(aggregate({ sections: "  events\n    event :TaskReopened\n      uuid :taskId\n    InvoicePaid\n  commands\n    command :Reopen\n      uuid :id\n" }))).toEqual([]);
  });

  test("a part line lowers to one tag named as its head, carrying `prop`", () => {
    const result = parseEntitySource(aggregate(), "/project/work/task-aggregate.mesh.mx");
    type Node = { kind: string; tag?: { name: string; attrs: { name?: string }[]; children: Node[] } };
    const root = result.ir!.body.find((n) => n.kind === "DelegatedTag") as unknown as Node;
    const entities = root.tag!.children.find((c) => c.tag?.name === "entities")!.tag!;
    expect(entities.children.filter((c) => c.kind === "DelegatedTag").map((c) => [c.tag!.name, c.tag!.attrs.map((a) => a.name)]))
      .toEqual([["Dependency", ["prop"]], ["talk.Comment", []]]);
  });

  test.each([
    ["no root line", "  entities\n    Dep\n", [[2, 0, "error", "MESH_MISSING_CHILD", "`aggregate`: missing required child `root`"]]],
    ["two root lines", "  root entity=Task\n  root entity=Task\n", [[4, 2, "error", "MESH_REPEATED_CHILD", "`aggregate`: `root` may not be repeated"]]],
    ["a string root", '  root entity="Task"\n', [[3, 7, "error", "MESH_OPTION_VALUE", "`root`: option `entity` must be an expression"]]],
    ["a name on the root line", "  root entity=Task :x\n", [[3, 19, "error", "MESH_UNKNOWN_OPTION", "`root`: unknown option `:x` (`name`)"]]],
    ["a function as the root", "  root entity=() => Task\n", [[3, 7, "error", "MESH_ENTITY_REFERENCE", "`root`: entity must be an imported identifier (`List`) or a member of a namespace import (`billing.Invoice`)"]]],
    ["a wrapped root", "  root entity=(Task)\n", [[3, 14, "error", "MESH_ENTITY_REFERENCE", "`root`: entity must be the reference alone, with no parentheses, `!`, `as`, `satisfies` or `<T>` around it (`entity=List`, `entity=billing.Invoice`)"]]],
    ["an entity section", "  root entity=Task\n  attributes\n", [[4, 2, "error", "MESH_TAG_NOT_ALLOWED", "`aggregate`: `attributes` is not allowed here; allowed children: `root`, `entities`, `events`, `commands`, `handlers`"]]],
    ["a string prop", '  root entity=Task\n  entities\n    Dep prop="dependent"\n', [[5, 13, "error", "MESH_OPTION_VALUE", "`Dep` (inline contract): option `prop` must be atom, got string"]]],
    ["a list prop", "  root entity=Task\n  entities\n    Dep prop=[:a]\n", [[5, 13, "error", "MESH_OPTION_VALUE", "`Dep` (inline contract): option `prop` must be atom, got array"]]],
    ["a repeated prop", "  root entity=Task\n  entities\n    Dep prop=:a prop=:b\n", [[5, 8, "warning", "MESH_DUPLICATE_OPTION", "duplicate option `prop`: the later one at 5:17 wins, so this one is dropped"]]],
    ["another option on a part", "  root entity=Task\n  entities\n    Dep link=:a\n", [[5, 8, "error", "MESH_UNKNOWN_OPTION", "`Dep` (inline contract): unknown option `link`"]]],
    ["a child under a part", "  root entity=Task\n  entities\n    Dep\n      uuid :x\n", [[6, 6, "error", "MESH_TAG_NOT_ALLOWED", "`Dep` (inline contract): `uuid` is not allowed here; allowed children: none"]]],
    ["a part line under the root", "  root entity=Task\n    Dep\n", [[4, 4, "error", "MESH_UNKNOWN_TAG", "`Dep` is not a known tag in the `mesh` dialect"]]],
    ["an entities section under an entity", null, [[5, 2, "error", "MESH_TAG_NOT_ALLOWED", "`entity`: `entities` is not allowed here; allowed children: `attributes`, `relationships`, `computed`, `checks`, `actions`, `policies`, `events`, `commands`, `handlers`, `use`"]]],
  ])("MX refuses %s", (_label, body, expected) => {
    const source = body === null ? 'import { Task } from "./task.mesh.mx"\nentity :X\n  attributes\n    uuid :id primary-key\n  entities\n' : HEAD + body;
    expect(lowered(source)).toEqual(expected);
  });

  test("an empty entities section, and an aggregate with a root alone, are legal (OD10)", () => {
    expect(lowered(`${HEAD}  root entity=Task\n  entities\n`)).toEqual([]);
    expect(lowered(`${HEAD}  root entity=Task\n`)).toEqual([]);
  });
});

describe("the aggregate in the model", () => {
  test("the root, the parts (plain and through a namespace import) and the inline event, with each prop resolved, written or inferred", () => {
    const result = build();
    expect(brief(result.diagnostics)).toEqual([]);
    const [built] = result.document!.aggregates!;
    expect(built).toMatchObject({
      name: "TaskAggregate", fqn: "work.TaskAggregate", file: "work/task-aggregate.mesh.mx", module: "work",
      root: { entity: { identifier: "Task", from: "./task.mesh.mx" }, position: { line: 5, column: 2 } },
      parts: [
        { entity: { identifier: "Dependency", from: "./dependency.mesh.mx" }, prop: "dependent", position: { line: 7, column: 4 } },
        // a nullable belongs-to ties a part as a required one does
        { entity: { identifier: "talk.Comment", from: "./comment.mesh.mx" }, prop: "task", position: { line: 8, column: 4 } },
      ],
      events: [{ identifier: "TaskReopened", from: "./task-aggregate.mesh.mx", fqn: "work.TaskReopened", position: { line: 10, column: 4 } }],
    });
    expect(Object.hasOwn(built!, "commands")).toBe(false);
    expect(built!.imports.map((i) => i.from)).toEqual(["./task.mesh.mx", "./dependency.mesh.mx", "./comment.mesh.mx"]);
    // the inline event is an ordinary declaration of the document, declared in the aggregate file
    expect(result.document!.events!.map((e) => [e.fqn, e.file])).toEqual([["work.TaskReopened", "work/task-aggregate.mesh.mx"]]);
  });

  test("a project with no aggregate has no aggregates key, and orderedDocument leaves it absent", () => {
    const result = build({ "work/task-aggregate.mesh.mx": null, "work/task.mesh.mx": entity("Task"), "work/dependency.mesh.mx": entity("Dependency"), "work/comment.mesh.mx": entity("Comment") });
    expect(brief(result.diagnostics)).toEqual([]);
    expect(Object.hasOwn(result.document!, "aggregates")).toBe(false);
    expect(Object.hasOwn(orderedDocument(result.document!), "aggregates")).toBe(false);
  });

  test("orderedDocument sorts aggregates by file", () => {
    const second = 'import { Note } from "./note.mesh.mx"\naggregate :Notes\n  root entity=Note\n';
    const result = buildModel({ ...files({ "work/a-notes.mesh.mx": second }), files: [...files().files].reverse().concat({ file: "work/a-notes.mesh.mx", source: second }) });
    expect(errors(result)).toEqual([]);
    expect(result.document!.aggregates!.map((a) => a.file)).toEqual(["work/task-aggregate.mesh.mx", "work/a-notes.mesh.mx"]);
    expect(orderedDocument(result.document!).aggregates!.map((a) => a.file)).toEqual(["work/a-notes.mesh.mx", "work/task-aggregate.mesh.mx"]);
  });

  test("a commands section, an aggregate at the domain root, a part from another module and an aggregate named as written", () => {
    const result = build({
      "work/task-aggregate.mesh.mx": null,
      "task_aggregate.mesh.mx": aggregate({
        name: "task_aggregate",
        imports: 'import { Task } from "./work/task.mesh.mx"\nimport * as identity from "./identity/collaborator.mesh.mx"\n',
        parts: "",
        sections: "  events\n    event :TaskReopened\n      uuid :taskId\n  commands\n    command :reopen_task\n      uuid :id\n",
      }),
      "work/task.mesh.mx": entity("Task", { imports: 'import { TaskReopened } from "../task_aggregate.mesh.mx"\n', steps: PUBLISH }),
      "identity/collaborator.mesh.mx": entity("Collaborator", { imports: 'import { Task } from "../work/task.mesh.mx"\n', relationships: "    belongs-to :task entity=Task\n" }),
      "work/dependency.mesh.mx": entity("Dependency"), "work/comment.mesh.mx": entity("Comment"),
    });
    expect(errors(result)).toEqual([]);
    const [built] = result.document!.aggregates!;
    expect([built!.name, built!.fqn, built!.module]).toEqual(["task_aggregate", "task_aggregate", ""]);
    expect(built!.commands).toEqual([{ identifier: "ReopenTask", from: "./task_aggregate.mesh.mx", fqn: "ReopenTask", position: expect.objectContaining({ line: 10, column: 4 }) }]);
  });
});

describe("the aggregate's owner sections", () => {
  test("an inline command of the aggregate is answered by an entity's `on=`", () => {
    const result = build({
      "work/task-aggregate.mesh.mx": aggregate({ sections: "  commands\n    command :ReopenTask\n      uuid :id\n" }),
      ...QUIET,
      "work/task.mesh.mx": 'import { ReopenTask } from "./task-aggregate.mesh.mx"\nentity :Task\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n    update on=ReopenTask\n',
    });
    expect(errors(result)).toEqual([]);
    const task = result.document!.entities.find((e) => e.name === "Task")!;
    expect(task.actions.find((a) => a.name === "reopenTask")!.command).toMatchObject({ fqn: "work.ReopenTask" });
  });

  test("a listing repeated through an alias, and an inline name taken twice, name the aggregate (R9b)", () => {
    const result = build({
      "work/task-aggregate.mesh.mx": aggregate({
        imports: 'import { Task } from "./task.mesh.mx"\nimport { Dependency } from "./dependency.mesh.mx"\nimport * as talk from "./comment.mesh.mx"\nimport { TaskReopened as R } from "./reopened.mesh.mx"\nimport * as r from "./reopened.mesh.mx"\n',
        sections: "  events\n    R\n    r.TaskReopened\n    event :Closed\n  commands\n    command :Closed\n",
      }),
      "work/reopened.mesh.mx": "event :TaskReopened\n  uuid :taskId\n",
      ...QUIET,
    });
    expect(errors(result)).toEqual([
      at(13, 4, "MESH_DUPLICATE_MEMBER", "r.TaskReopened is listed twice in the events section of work.TaskAggregate", "remove one"),
      at(16, 4, "MESH_DUPLICATE_ENTITY", "Duplicate name Closed in work/task-aggregate.mesh.mx: the event Closed and the command Closed would be one class name work.Closed", "rename one"),
    ]);
  });
});

describe("what a root or a part line may name", () => {
  test.each([
    ["the root listed as a part (OD4b)", "    Task\n", "", [at(5, 4, "MESH_AGGREGATE_PART", "work.Task is the root of work.TaskAggregate, so it is not one of its parts", "remove the line")]],
    ["a part listed twice, under two names (OD4a)", "    Dependency prop=:dependent\n    dep.Dependency prop=:prerequisite\n", 'import { Dependency } from "./dependency.mesh.mx"\nimport * as dep from "./dependency.mesh.mx"\n',
      [at(8, 4, "MESH_DUPLICATE_MEMBER", "work.Dependency is listed twice in the entities of work.TaskAggregate", "remove one")]],
    ["a head of three parts", "    a.b.c\n", "", [at(5, 4, "MESH_ENTITY_REFERENCE", "a.b.c is not an entity reference: a part is an imported entity's identifier (`Comment`) or a member of a namespace import (`talk.Comment`)")]],
    ["tag parameters on a part", "    Note|x|\n", 'import { Note } from "./note.mesh.mx"\n', [at(6, 4, "MESH_SYNTAX", "`Note`: tag parameters and variable bindings are not entity declarations")]],
    ["a part the file does not import", "    Comment\n", "", [at(5, 4, "MESH_UNKNOWN_ENTITY", "Comment is not an imported entity.")]],
    ["an unknown member of a namespace import", "    talk.Coment\n", 'import * as talk from "./comment.mesh.mx"\n',
      [at(6, 9, "MESH_UNKNOWN_ENTITY", "talk.Coment is not an imported entity: ./comment.mesh.mx declares `Comment`. Did you mean talk.Comment?", "write `talk.Comment`")]],
  ])("%s", (_label, parts, imports, expected) => {
    expect(errors(build({ ...QUIET, "work/task-aggregate.mesh.mx": withParts(parts, imports) }))).toEqual(expected);
  });

  test("a root the file does not import", () => {
    expect(errors(build({ ...QUIET, "work/task-aggregate.mesh.mx": aggregate({ imports: "", root: "Task", parts: "" }) })))
      .toEqual([at(2, 14, "MESH_UNKNOWN_ENTITY", "Task is not an imported entity.")]);
  });

  test("a root or a part that names an entity file's inline event is no entity (R8a), and admits nothing", () => {
    const result = build({
      "work/task.mesh.mx": entity("Task", { sections: "  events\n    event :Inline\n      uuid :x\n" }),
      "work/task-aggregate.mesh.mx": aggregate({ imports: 'import { Task, Inline } from "./task.mesh.mx"\n', root: "Inline", parts: "    Inline\n", sections: "" }),
      "work/dependency.mesh.mx": entity("Dependency"), "work/comment.mesh.mx": entity("Comment"),
    });
    expect(errors(result)).toEqual([
      at(3, 14, "MESH_UNKNOWN_ENTITY", "Inline is not an imported entity: ./task.mesh.mx declares Inline as an event."),
      at(5, 4, "MESH_UNKNOWN_ENTITY", "Inline is not an imported entity: ./task.mesh.mx declares Inline as an event."),
    ]);
  });

  test("an aggregate file takes no helper and no Mesh import (OD7), and names only the import", () => {
    expect(errors(build({ ...QUIET, "work/task-aggregate.mesh.mx": aggregate({ imports: 'import { Task } from "./task.mesh.mx"\nimport { isStaff } from "./helpers"\nimport { Mesh } from "meshfw"\n', parts: "" }) }))).toEqual([
      at(2, 0, "MESH_UNKNOWN_IMPORT", "An aggregate file imports only .mesh.mx files: its handlers call actions of the entities it imports, not a helper", "remove the import"),
      at(3, 0, "MESH_UNKNOWN_IMPORT", "An aggregate file imports only .mesh.mx files: its handlers call actions of the entities it imports, not `Mesh`", "remove the import"),
    ]);
  });

  test("an import that binds an inline declaration's name is MESH_DUPLICATE_IMPORT; the aggregate's own name binds nothing, so an inline event may take it", () => {
    expect(errors(build({ ...QUIET, "work/task-aggregate.mesh.mx": aggregate({ imports: 'import { Task } from "./task.mesh.mx"\nimport { Task as TaskReopened } from "./task.mesh.mx"\n', parts: "" }) })))
      .toEqual([at(2, 17, "MESH_DUPLICATE_IMPORT", "Duplicate import identifier TaskReopened: the file declares the event TaskReopened too")]);
    const named = build({ "work/task-aggregate.mesh.mx": aggregate({ name: "TaskReopened" }) });
    expect(errors(named)).toEqual([]);
    expect(named.document!.aggregates![0]!.name).toBe("TaskReopened");
  });

  test("a file of two aggregates, and two aggregates of one FQN (R17, OD6); an aggregate and an entity of one FQN are not compared", () => {
    expect(errors(build({ "work/task-aggregate.mesh.mx": `${aggregate()}aggregate :Again\n  root entity=Task\n` })))
      .toEqual([at(12, 0, "MESH_DUPLICATE_ENTITY", "An aggregate file must contain exactly one aggregate")]);
    expect(errors(build({ "work/_group/again.mesh.mx": 'import { Task } from "../task.mesh.mx"\naggregate :TaskAggregate\n  root entity=Task\n' })))
      .toEqual([["work/_group/again.mesh.mx", 2, 0, "MESH_DUPLICATE_ENTITY", "Duplicate aggregate work.TaskAggregate; first declared in work/task-aggregate.mesh.mx", null]]);
    expect(errors(build({ "work/task-aggregate.mesh.mx": aggregate({ name: "Task" }) }))).toEqual([]);
  });

  test("a bad group folder is reported once, at the aggregate line", () => {
    expect(errors(build({ "work/_/x.mesh.mx": 'import { Task } from "../task.mesh.mx"\naggregate :X\n  root entity=Task\n  events\n    event :XNoted\n      uuid :id\n' })))
      .toEqual([["work/_/x.mesh.mx", 2, 0, "MESH_GROUP_NAME", 'Group folder "_" has no name; write "_" followed by a name, such as "_services"', null]]);
  });
});

describe("a part's link to the root (OD2, OD3)", () => {
  const DEP = 'import { Dependency } from "./dependency.mesh.mx"\n';
  test.each([
    ["two links and no prop", "    Dependency\n", DEP, [at(6, 4, "MESH_AGGREGATE_PART", "work.Dependency could be tied to work.Task by any of its 2 belongs-to (:dependent, :prerequisite)", "choose one: prop=:dependent")]],
    ["no link", "    Note\n", 'import { Note } from "./note.mesh.mx"\n', [at(6, 4, "MESH_AGGREGATE_PART", "work.Note has no belongs-to to work.Task, the root of work.TaskAggregate", "add `belongs-to :task entity=Task` to work.Note")]],
    ["a prop that names no belongs-to, misspelt", "    Dependency prop=:dependnt\n", DEP, [at(6, 20, "MESH_AGGREGATE_PART", "prop=:dependnt names no belongs-to of work.Dependency. Did you mean prop=:dependent?")]],
    ["a prop that names an attribute", "    Dependency prop=:id\n", DEP, [at(6, 20, "MESH_AGGREGATE_PART", "prop=:id names no belongs-to of work.Dependency. The belongs-to from work.Dependency to work.Task: :dependent, :prerequisite.")]],
    ["a prop to another entity", "    Dependency prop=:createdBy\n", DEP, [at(6, 20, "MESH_AGGREGATE_PART", "prop=:createdBy is a belongs-to of work.Dependency that points at identity.Collaborator, not at work.Task. The belongs-to from work.Dependency to work.Task: :dependent, :prerequisite.")]],
  ])("%s", (_label, parts, imports, expected) => {
    expect(errors(build({ ...QUIET, "work/task-aggregate.mesh.mx": withParts(parts, imports) }))).toEqual(expected);
  });

  test("a written prop is kept as written", () => {
    expect(build({ ...QUIET, "work/task-aggregate.mesh.mx": withParts("    Dependency prop=:prerequisite\n", DEP) }).document!.aggregates![0]!.parts[0]!.prop).toBe("prerequisite");
  });

  test("a part whose belongs-to names an unknown entity gets that error alone", () => {
    const broken = entity("Note", { relationships: "    belongs-to :task entity=Tsk\n" });
    expect(errors(build({ ...QUIET, "work/note.mesh.mx": broken, "work/task-aggregate.mesh.mx": withParts("    Note\n", 'import { Note } from "./note.mesh.mx"\n') })))
      .toEqual([["work/note.mesh.mx", 5, 28, "MESH_UNKNOWN_ENTITY", "Tsk is not an imported entity.", null]]);
  });

  test("a has-many through= link entity is a part by its own belongs-to to the root; the far entity has none (OD3)", () => {
    const task = entity("Task", { imports: 'import { Tag } from "./tag.mesh.mx"\nimport { TaskTag } from "./task-tag.mesh.mx"\n', relationships: "    has-many :tags entity=Tag through=TaskTag\n" });
    const link = entity("TaskTag", { imports: 'import { Task } from "./task.mesh.mx"\nimport { Tag } from "./tag.mesh.mx"\n', relationships: "    belongs-to :task entity=Task\n    belongs-to :tag entity=Tag\n" });
    const result = build({
      "work/task.mesh.mx": task, "work/task-tag.mesh.mx": link, "work/tag.mesh.mx": entity("Tag"),
      "work/dependency.mesh.mx": entity("Dependency"), "work/comment.mesh.mx": entity("Comment"),
      "work/task-aggregate.mesh.mx": withParts("    TaskTag\n    Tag\n", 'import { TaskTag } from "./task-tag.mesh.mx"\nimport { Tag } from "./tag.mesh.mx"\n'),
    });
    expect(errors(result)).toEqual([at(8, 4, "MESH_AGGREGATE_PART", "work.Tag has no belongs-to to work.Task, the root of work.TaskAggregate", "add `belongs-to :task entity=Task` to work.Tag")]);
  });
});

describe("what the aggregate's name binds (R24a, OD17)", () => {
  const importer = (imports: string, relationships = "", sections = "") => ({ "work/note.mesh.mx": entity("Note", { imports, relationships, sections }) });
  test("a named import of it is MESH_UNKNOWN_IMPORT, which lists what the file does declare", () => {
    expect(errors(build(importer('import { TaskAggregate, Nope } from "./task-aggregate.mesh.mx"\n')))).toEqual([
      ["work/note.mesh.mx", 1, 9, "MESH_UNKNOWN_IMPORT", "`TaskAggregate` is the aggregate ./task-aggregate.mesh.mx declares, and an aggregate is no value: import the events or commands it declares (`TaskReopened`)", null],
      ["work/note.mesh.mx", 1, 24, "MESH_UNKNOWN_IMPORT", "`Nope` is not what ./task-aggregate.mesh.mx declares; it declares `TaskReopened`", null],
    ]);
  });

  test("of an aggregate that declares nothing, the message says so", () => {
    const bare = { "work/bare.mesh.mx": 'import { Task } from "./task.mesh.mx"\naggregate :Bare\n  root entity=Task\n' };
    expect(errors(build({ ...bare, ...importer('import { Bare, Nope } from "./bare.mesh.mx"\n') }))).toEqual([
      ["work/note.mesh.mx", 1, 9, "MESH_UNKNOWN_IMPORT", "`Bare` is the aggregate ./bare.mesh.mx declares, and an aggregate is no value: import the events or commands it declares, and it declares none", null],
      ["work/note.mesh.mx", 1, 15, "MESH_UNKNOWN_IMPORT", "`Nope` is not what ./bare.mesh.mx declares; it declares the aggregate `Bare` only, which is no value", null],
    ]);
  });

  test("a namespace member that names it is the position's unknown code", () => {
    const result = build(importer('import * as t from "./task-aggregate.mesh.mx"\n', "    belongs-to :a entity=t.TaskAggregate\n", "  events\n    t.TaskAggregate\n"));
    expect(errors(result)).toEqual([
      ["work/note.mesh.mx", 6, 25, "MESH_UNKNOWN_ENTITY", "t.TaskAggregate is not an imported entity: t is a namespace import of ./task-aggregate.mesh.mx, which is not an entity file", null],
      ["work/note.mesh.mx", 12, 6, "MESH_UNKNOWN_EVENT", "t.TaskAggregate is not an imported event: ./task-aggregate.mesh.mx declares `TaskReopened`. Did you mean t.TaskReopened?", "write `t.TaskReopened`"],
    ]);
  });

  test("a namespace member that names it, or names nothing, in a function is the namespace member's unknown code", () => {
    const steps = "        run=() => { console.log(t.TaskAggregate, t.Nope, t.TaskReopened) }\n";
    const result = build({ "work/note.mesh.mx": entity("Note", { imports: 'import * as t from "./task-aggregate.mesh.mx"\n', steps }) });
    expect(errors(result)).toEqual([
      ["work/note.mesh.mx", 8, 34, "MESH_UNKNOWN_ENTITY", "t.TaskAggregate is not an imported entity, event or command: ./task-aggregate.mesh.mx declares `TaskReopened`. Did you mean t.TaskReopened?", "write `t.TaskReopened`"],
      ["work/note.mesh.mx", 8, 51, "MESH_UNKNOWN_ENTITY", "t.Nope is not an imported entity, event or command: ./task-aggregate.mesh.mx declares `TaskReopened`. Did you mean t.TaskReopened?", "write `t.TaskReopened`"],
    ]);
  });

  test("a named import of it is reported once, at the import: its uses in `entity=`, a `new` and a listing say nothing more", () => {
    const result = build({
      "work/note.mesh.mx": entity("Note", {
        imports: 'import { TaskAggregate } from "./task-aggregate.mesh.mx"\n',
        relationships: "    belongs-to :a entity=TaskAggregate\n",
        steps: "        publish=() => new TaskAggregate({ taskId: &id })\n        run=() => { console.log(TaskAggregate) }\n",
        sections: "  events\n    TaskAggregate\n",
      }),
    });
    expect(errors(result)).toEqual([
      ["work/note.mesh.mx", 1, 9, "MESH_UNKNOWN_IMPORT", "`TaskAggregate` is the aggregate ./task-aggregate.mesh.mx declares, and an aggregate is no value: import the events or commands it declares (`TaskReopened`)", null],
    ]);
  });

  test("its inline events are imported by name and as namespace members, and listed by another owner (R8, R15)", () => {
    const result = build({
      "work/note.mesh.mx": entity("Note", { imports: 'import * as t from "./task-aggregate.mesh.mx"\n', steps: "        publish=() => new t.TaskReopened({ taskId: &id })\n", sections: "  events\n    t.TaskReopened\n" }),
    });
    expect(errors(result)).toEqual([]);
    expect(result.document!.entities.find((e) => e.name === "Note")!.events).toEqual([expect.objectContaining({ fqn: "work.TaskReopened" })]);
  });
});

describe("aggregate owners publish (R13)", () => {
  test("the root and every part publish the aggregate's event; a third entity is MESH_PUBLISH, naming the aggregate with its root and parts", () => {
    expect(errors(build({ "work/other.mesh.mx": OTHER }))).toEqual([
      ["work/other.mesh.mx", 8, 26, "MESH_PUBLISH", "`TaskReopened` is work.TaskReopened, which work.TaskAggregate (root work.Task, parts work.Dependency, work.Comment) lists in its `events` section, and work.Other is not one of its owners: an action publishes only events its owner lists, or events no owner lists",
        "list it in the `events` section of work.Other, or publish it from an action of the root or a part of work.TaskAggregate (root work.Task, parts work.Dependency, work.Comment)"],
    ]);
  });

  test("an entity that also lists the event publishes it, beside the aggregate's members", () => {
    expect(errors(build({ "work/other.mesh.mx": entity("Other", { imports: REOPENED, steps: PUBLISH, sections: "  events\n    TaskReopened\n" }) }))).toEqual([]);
  });

  test("an entity listed in no aggregate that owns the event is refused, also when the entity is a part of another aggregate", () => {
    const notes = 'import { Note } from "./note.mesh.mx"\nimport { Other } from "./other.mesh.mx"\naggregate :Notes\n  root entity=Note\n  entities\n    Other prop=:note\n';
    const other = entity("Other", { imports: REOPENED + 'import { Note } from "./note.mesh.mx"\n', relationships: "    belongs-to :note entity=Note\n", steps: PUBLISH });
    expect(errors(build({ "work/notes.mesh.mx": notes, "work/other.mesh.mx": other })).map((d) => [d[0], d[3]])).toEqual([["work/other.mesh.mx", "MESH_PUBLISH"]]);
  });

  test("a part whose link failed still publishes: one diagnostic, the link's", () => {
    expect(errors(build({ "work/task-aggregate.mesh.mx": aggregate({ parts: "    Dependency\n    talk.Comment\n" }) })))
      .toEqual([at(7, 4, "MESH_AGGREGATE_PART", "work.Dependency could be tied to work.Task by any of its 2 belongs-to (:dependent, :prerequisite)", "choose one: prop=:dependent")]);
  });

  test("an entity in two aggregates, and the root of one that is a part of another, build with no diagnostic (R24)", () => {
    const second = 'import { Dependency } from "./dependency.mesh.mx"\nimport { Task } from "./task.mesh.mx"\naggregate :DependencyAggregate\n  root entity=Dependency\n  entities\n    Task\n';
    const third = 'import { Comment } from "./comment.mesh.mx"\nimport { Dependency } from "./dependency.mesh.mx"\naggregate :Talk\n  root entity=Comment\n  entities\n    Dependency\n';
    const comment = entity("Comment", { imports: 'import { Task } from "./task.mesh.mx"\nimport { Dependency } from "./dependency.mesh.mx"\n' + REOPENED, relationships: "    belongs-to :task entity=Task nullable\n", steps: PUBLISH });
    const dependency = DEPENDENCY.replace("    belongs-to :createdBy", "    belongs-to :comment entity=Comment nullable\n    belongs-to :createdBy").replace("import { Task }", 'import { Comment } from "./comment.mesh.mx"\nimport { Task }');
    const task = TASK.replace("entity :Task\n", 'import { Dependency } from "./dependency.mesh.mx"\nentity :Task\n').replace("  actions", "  relationships\n    belongs-to :owner entity=Dependency nullable\n  actions");
    const result = build({ "work/dependency-aggregate.mesh.mx": second, "work/talk.mesh.mx": third, "work/comment.mesh.mx": comment, "work/dependency.mesh.mx": dependency, "work/task.mesh.mx": task });
    expect(errors(result)).toEqual([]);
    const of = aggregatesOf(result.document!);
    // in the order the document holds the aggregates: the project's files as given
    expect(of("work.Dependency").map((m) => [m.aggregate, m.role, m.position.line])).toEqual([
      ["work.TaskAggregate", "part", 7], ["work.DependencyAggregate", "root", 4], ["work.Talk", "part", 6],
    ]);
    expect(of("work.Task").map((m) => [m.aggregate, m.role])).toEqual([["work.TaskAggregate", "root"], ["work.DependencyAggregate", "part"]]);
  });

  test("an event with a file of its own that the aggregate lists: the root and the parts publish it, a third entity is refused", () => {
    const own = 'import { TaskReopened } from "./task-reopened.mesh.mx"\n';
    const swap = (source: string) => source.replace(REOPENED, own);
    const project = {
      "work/task-reopened.mesh.mx": "event :TaskReopened\n  uuid :taskId\n",
      "work/task-aggregate.mesh.mx": aggregate({ imports: 'import { Task } from "./task.mesh.mx"\nimport { Dependency } from "./dependency.mesh.mx"\nimport * as talk from "./comment.mesh.mx"\n' + own, sections: "  events\n    TaskReopened\n" }),
      "work/task.mesh.mx": swap(TASK), "work/dependency.mesh.mx": swap(DEPENDENCY), "work/comment.mesh.mx": swap(COMMENT),
    };
    const members = build(project);
    expect(errors(members)).toEqual([]);
    expect(members.document!.aggregates![0]!.events).toEqual([expect.objectContaining({ fqn: "work.TaskReopened" })]);
    expect(errors(build({ ...project, "work/other.mesh.mx": swap(OTHER) })).map((d) => [d[0], d[3]])).toEqual([["work/other.mesh.mx", "MESH_PUBLISH"]]);
  });

  test("a root line that names no entity admits nothing for that entity; the parts still publish", () => {
    const result = build({ "work/task-aggregate.mesh.mx": aggregate({ imports: 'import { Dependency } from "./dependency.mesh.mx"\nimport * as talk from "./comment.mesh.mx"\n' }) });
    expect(errors(result).map((d) => [d[0], d[3]])).toEqual([
      ["work/task-aggregate.mesh.mx", "MESH_UNKNOWN_ENTITY"],
      ["work/task.mesh.mx", "MESH_PUBLISH"],
    ]);
  });

  test("not checked when a file did not parse (R16, OD14)", () => {
    expect(errors(build({ "work/other.mesh.mx": OTHER, "work/broken.mesh.mx": "entity :Broken\n  nope\n" })).map((d) => d[3])).toEqual(["MESH_UNKNOWN_TAG"]);
  });
});

describe("aggregatesOf", () => {
  test("each entity's memberships, root and part, with the line that says so; an entity in none gets none; a line that names no entity adds nothing", () => {
    const result = build();
    const of = aggregatesOf(result.document!);
    expect(of("work.Task")).toEqual([{ aggregate: "work.TaskAggregate", role: "root", position: expect.objectContaining({ file: "work/task-aggregate.mesh.mx", line: 5, column: 2 }) }]);
    expect(of("work.Comment")).toEqual([{ aggregate: "work.TaskAggregate", role: "part", position: expect.objectContaining({ line: 8, column: 4 }) }]);
    expect(of("work.Note")).toEqual([]);
    expect(of("nowhere.X")).toEqual([]);
  });
});

describe("what is generated", () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  /** The same project with `TaskReopened` in a file of its own instead of the aggregate's section, and no aggregate. */
  const fileForm = () => build({
    "work/task-aggregate.mesh.mx": null,
    "work/task-reopened.mesh.mx": "event :TaskReopened\n  uuid :taskId\n",
    ...Object.fromEntries(["work/task.mesh.mx", "work/dependency.mesh.mx", "work/comment.mesh.mx"].map((path) => [path, files().files.find((f) => f.file === path)!.source.replace("./task-aggregate.mesh.mx", "./task-reopened.mesh.mx")])),
  });

  test("nothing for the aggregate: every file but model.json is the project's with the event in a file of its own, apart from the source names", async () => {
    const config = configOf("/project", ".mesh");
    const aggregated = await generateFiles({ document: build().document!, config });
    const own = await generateFiles({ document: fileForm().document!, config });
    const normal = (code: string) => code.replace(/work\/task-(aggregate|reopened)\.mesh\.mx(:\d+(:\d+)?)?/g, "FILE");
    const tree = (generated: readonly { path: string; contents: string }[]) =>
      Object.fromEntries(generated.filter((file) => !file.path.endsWith("model.json")).map((file) => [file.path, normal(file.contents)]));
    expect(Object.keys(tree(aggregated))).toContain(".mesh/domain/work/taskReopened.event.ts");
    expect(tree(aggregated)).toEqual(tree(own));
    const model = JSON.parse(aggregated.find((file) => file.path.endsWith("model.json"))!.contents);
    expect(model.aggregates.map((a: { fqn: string }) => a.fqn)).toEqual(["work.TaskAggregate"]);
    expect(Object.hasOwn(JSON.parse(own.find((file) => file.path.endsWith("model.json"))!.contents), "aggregates")).toBe(false);
  });

  test("the generated tree type-checks: the root and the parts publish the event the aggregate file declares", async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../.scratch-aggregate-"));
    roots.push(root);
    const config = configOf(root);
    const result = build({ "work/note.mesh.mx": entity("Note", { imports: 'import * as t from "./task-aggregate.mesh.mx"\n', steps: "        publish=() => new t.TaskReopened({ taskId: &id })\n", sections: "  events\n    t.TaskReopened\n" }) });
    expect(errors(result)).toEqual([]);
    const generated = await generateFiles({ document: result.document!, config });
    await writeGeneratedFiles(generated, config);
    await writeFile(resolve(root, "generated/schema.ts"), "export const tables = { task: {}, dependency: {}, comment: {}, note: {}, collaborator: {} };\n");
    await writeFile(resolve(root, "mesh.config.ts"), "export default { data: { kind: \"data-adapter\", name: \"memory\", build: \"./none\", options: {} } };\n");
    const checked = await checkTypes(root, [...generated.map((file) => resolve(root, file.path)), resolve(root, "mesh.config.ts")]);
    expect(checked).toEqual({ code: 0, output: "" });
  }, 60_000);
});

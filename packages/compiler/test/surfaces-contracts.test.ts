// The surface file's contracts (`notes/architecture/surfaces-design.md`, PR 1, section 3.1; ruling D41): `surface`,
// `expose` and `action`, through `parseEntitySource` only, so the editor shows the same thing. What needs the domain
// (the entity, its actions and fields) is the builder's, in `surfaces.test.ts`.
import { describe, expect, test } from "bun:test";
import { parseEntitySource } from "../src/front-end/build.ts";
import { tags } from "../src/front-end/tree.ts";

const FILE = "/project/src/surfaces/admin/admin.mesh.mx";
const HEAD = 'import { Task } from "../../domain/work/task.mesh.mx"\n\nsurface :admin\n';
/** `[code, line, column, message]` of what MX and Mesh's hooks report for one surface file. */
const mx = (source: string, file = FILE) => parseEntitySource(source, file).diagnostics.map((d) => [d.code, d.line, d.column, d.message]);
const expose = (options: string, children = "") => `${HEAD}  expose :tasks entity=Task${options}\n${children}`;

describe("legal surface files", () => {
  test("the spec's example lowers with no diagnostic; fields are atoms, `:all` a static atom", () => {
    const source = expose(' label="Tasks" fields=[:title, :state]', "    action :complete\n");
    const parsed = parseEntitySource(source, FILE);
    expect(parsed.diagnostics).toEqual([]);
    const all = parseEntitySource(expose(" fields=:all"), FILE);
    expect(all.diagnostics).toEqual([]);
  });
  test.each([
    ["a surface with no line", "surface :admin\n"],
    ["an expose line with no action and no fields", expose("")],
    ["fields=[:all], the list form", expose(" fields=[:all]")],
    ["a namespace member as entity", 'import * as work from "../../domain/work/task.mesh.mx"\nsurface :admin\n  expose :tasks entity=work.Task\n'],
    ["two expose lines", `${expose("", "    action :read\n")}  expose :lists entity=Task\n`],
  ])("%s", (_, source) => expect(mx(source)).toEqual([]));
  test("names like the new tags stay legal as members of an entity", () => {
    expect(mx("entity :Task\n  attributes\n    uuid :id primary-key\n    string :surface\n    string :expose\n    string :action\n    string :publishes\n", "/project/src/domain/task.mesh.mx")).toEqual([]);
  });
});

describe("refused shapes", () => {
  test.each([
    ["fields as a string", expose(' fields="title"'), ["MESH_ATOM_LIST", 4, 28, "`expose`: fields must be a list of atoms (`fields=[:title, :state]`) or `:all`"]],
    ["fields as one atom", expose(" fields=:title"), ["MESH_ATOM_LIST", 4, 28, "`expose`: fields takes a list of atoms (`fields=[:title]`) or `:all` for every field"]],
    ["an empty fields list", expose(" fields=[]"), ["MESH_ATOM_LIST", 4, 28, "`expose`: fields must be non-empty with no repeated values"]],
    ["a repeated field", expose(" fields=[:a, :a]"), ["MESH_ATOM_LIST", 4, 28, "`expose`: fields must be non-empty with no repeated values"]],
    ["an identifier item", expose(" fields=[a]"), ["MESH_OPTION_VALUE", 4, 36, "`expose`: option fields item 1 must be atom, got expression; write it as `:a`"]],
    ["a string item", expose(' fields=[:a, "b"]'), ["MESH_OPTION_VALUE", 4, 40, "`expose`: option fields item 2 must be atom, got string; write it as `:b`"]],
    ["a hole", expose(" fields=[:a, , :b]"), ["MESH_OPTION_VALUE", 4, 28, "`expose`: option fields item 2 must be atom, got nothing"]],
    ["an empty label", expose(' label=""'), ["MESH_TEXT", 4, 28, "`expose`: label cannot be empty"]],
    ["a label that is no literal", expose(" label=x"), ["MESH_OPTION_VALUE", 4, 28, "`expose`: option `label` must be a literal"]],
    ["a wrapped entity", `${HEAD}  expose :tasks entity=(Task)\n`, ["MESH_ENTITY_REFERENCE", 4, 23, "`expose`: entity must be the reference alone, with no parentheses, `!`, `as`, `satisfies` or `<T>` around it (`entity=List`, `entity=billing.Invoice`)"]],
    ["a call as entity", `${HEAD}  expose :tasks entity=getTask()\n`, ["MESH_ENTITY_REFERENCE", 4, 16, "`expose`: entity must be an imported identifier (`List`) or a member of a namespace import (`billing.Invoice`)"]],
    ["a string entity", `${HEAD}  expose :tasks entity="Task"\n`, ["MESH_OPTION_VALUE", 4, 16, "`expose`: option `entity` must be an expression"]],
    ["no entity", `${HEAD}  expose :tasks\n`, ["MESH_MISSING_OPTION", 4, 2, "`expose`: missing required option `entity`"]],
    ["a name that is no atom", `${HEAD}  expose tasks entity=Task\n`, ["MESH_UNKNOWN_OPTION", 4, 9, "`expose`: unknown option `tasks`"]],
    ["an action with no name", expose("", "    action\n"), ["MESH_MISSING_OPTION", 5, 4, "`action`: missing required option `name`"]],
    ["an action as a member", expose("", "    action &complete\n"), ["MESH_UNKNOWN_OPTION", 5, 11, "`action`: unknown option `member`"]],
    ["an option on an action", expose("", '    action :x label="y"\n'), ["MESH_UNKNOWN_OPTION", 5, 14, "`action`: unknown option `label`"]],
    ["a line under an action", expose("", "    action :x\n      action :y\n"), ["MESH_TAG_NOT_ALLOWED", 6, 6, "`action`: `action` is not allowed here; allowed children: none"]],
    ["an option on the surface line", 'surface :admin label="x"\n', ["MESH_UNKNOWN_OPTION", 1, 15, "`surface`: unknown option `label`"]],
    ["a surface with no name", "surface\n", ["MESH_MISSING_OPTION", 1, 0, "`surface`: missing required option `name`"]],
    // A surface declares no behaviour: none of its lines takes a policy, a check or a section of an entity.
    ["policies under surface", `${HEAD}  policies\n`, ["MESH_TAG_NOT_ALLOWED", 4, 2, "`surface`: `policies` is not allowed here; allowed children: `expose`, `publishes`"]],
    ["attributes under surface", `${HEAD}  attributes\n`, ["MESH_TAG_NOT_ALLOWED", 4, 2, "`surface`: `attributes` is not allowed here; allowed children: `expose`, `publishes`"]],
    ["check under expose", expose("", "    check :x\n"), ["MESH_TAG_NOT_ALLOWED", 5, 4, "`expose`: `check` is not allowed here; allowed children: `action`"]],
    ["always under expose", expose("", "    always\n"), ["MESH_TAG_NOT_ALLOWED", 5, 4, "`expose`: `always` is not allowed here; allowed children: `action`"]],
    ["an action at the root of the file", "action :complete\n", ["MESH_PARENT_NOT_ALLOWED", 1, 0, "`action` must be inside `expose`; found at the top level"]],
  ])("%s", (_, source, expected) => expect(mx(source)).toEqual([expected]));
});

// The `publishes` section (design section 3.2, PR 3): listing lines whose head is the reference. Whether a head names an
// event is the builder's (`surfaces.test.ts`).
describe("the publishes section", () => {
  const EVENTS = 'import { TaskCompleted } from "../../domain/work/task-completed.mesh.mx"\nimport * as billing from "../../domain/billing/invoice.mesh.mx"\n';
  const publishes = (lines: string, imports = EVENTS) => `${imports}surface :admin\n  publishes\n${lines}`;
  test.each([
    ["an imported event and a namespace member", publishes("    TaskCompleted\n    billing.InvoicePaid\n")],
    ["an empty section", publishes("")],
    ["a section beside expose lines, written before them", `${EVENTS}surface :admin\n  publishes\n    TaskCompleted\n  expose :tasks entity=billing.Invoice\n`],
    // Three parts reach the builder, which says what a reference is.
    ["a head of three parts", publishes("    a.b.c\n")],
  ])("%s lowers with no diagnostic", (_, source) => expect(mx(source)).toEqual([]));
  test("each line keeps its head as the tag name", () => {
    const parsed = parseEntitySource(publishes("    TaskCompleted\n    billing.InvoicePaid\n"), FILE);
    const section = tags(tags(parsed.ir!.body)[0]!.children)[0]!;
    expect([section.name, ...tags(section.children).map((line) => line.name)]).toEqual(["publishes", "TaskCompleted", "billing.InvoicePaid"]);
  });
  test.each([
    ["an option on a line", publishes("    TaskCompleted foo=1\n"), ["MESH_UNKNOWN_OPTION", 5, 18, "`TaskCompleted` (inline contract): accepts no options"]],
    ["an atom, not a reference", publishes("    :completed\n"), ["MESH_UNSPACED_NAME", 5, 4, "`:completed` is a name with no tag before it; Mesh writes a tag, a space, then the name: `kind :completed`"]],
    // A surface declares no event: `event` is a tag of the vocabulary, which the wildcard does not claim.
    ["an inline declaration", publishes("    event :TaskArchived\n"), ["MESH_TAG_NOT_ALLOWED", 5, 4, "`publishes`: `event` is not allowed here; names must match `[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*` (`event` is a registered tag, so the wildcard does not apply to it)"]],
    ["a line under a listing line", publishes("    TaskCompleted\n      billing.InvoicePaid\n"), ["MESH_UNKNOWN_TAG", 6, 6, "`billing.InvoicePaid` is not a known tag in the `mesh` dialect"]],
    ["an option on the section", `${EVENTS}surface :admin\n  publishes all\n`, ["MESH_UNKNOWN_OPTION", 4, 12, "`publishes`: accepts no options"]],
    ["two sections", `${EVENTS}surface :admin\n  publishes\n    TaskCompleted\n  publishes\n`, ["MESH_REPEATED_CHILD", 6, 2, "`surface`: `publishes` may not be repeated"]],
    ["a section under expose", `${EVENTS}surface :admin\n  expose :tasks entity=billing.Invoice\n    publishes\n`, ["MESH_TAG_NOT_ALLOWED", 5, 4, "`expose`: `publishes` is not allowed here; allowed children: `action`"]],
    ["a section in an entity file", "entity :Task\n  attributes\n    uuid :id primary-key\n  publishes\n", ["MESH_TAG_NOT_ALLOWED", 4, 2, "`entity`: `publishes` is not allowed here; allowed children: `attributes`, `relationships`, `computed`, `checks`, `actions`, `policies`, `events`, `commands`, `handlers`"]],
  ])("%s", (_, source, expected) => expect(mx(source)).toEqual([expected]));
  test("the publish step is another tag, unaffected", () => {
    const task = 'import { TaskCompleted } from "./task-completed.mesh.mx"\nentity :Task\n  attributes\n    uuid :id primary-key\n  actions\n    update :complete\n      do\n        publish=() => new TaskCompleted({ taskId: &id })\n';
    expect(mx(task, "/project/src/domain/work/task.mesh.mx")).toEqual([]);
  });
});

describe("what changes for entity files", () => {
  test("`action :complete` under an entity's actions names the right tags", () => {
    expect(mx("entity :Task\n  attributes\n    uuid :id primary-key\n  actions\n    action :complete\n", "/project/src/domain/task.mesh.mx")).toEqual([
      ["MESH_TAG_NOT_ALLOWED", 5, 4, "`actions`: `action` is not allowed here; allowed children: `create`, `read`, `update`, `destroy`, `always`"],
    ]);
  });
  test("an expose line in an entity is not allowed there", () => {
    expect(mx("entity :Task\n  attributes\n    uuid :id primary-key\n  expose :x entity=Task\n", "/project/src/domain/task.mesh.mx")).toEqual([
      ["MESH_TAG_NOT_ALLOWED", 4, 2, "`entity`: `expose` is not allowed here; allowed children: `attributes`, `relationships`, `computed`, `checks`, `actions`, `policies`, `events`, `commands`, `handlers`"],
    ]);
  });
  test("a `surface` root lowers in any file: where it may sit is the builder's (MESH_SURFACE_PATH)", () => {
    expect(mx("surface :admin\n", "/project/src/domain/admin.mesh.mx")).toEqual([]);
  });
});

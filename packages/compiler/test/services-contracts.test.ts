// The service file's contracts (`notes/architecture/services-design.md`, PR 1, sections 3.2 and 3.3; ruling D42):
// `service`, `operation` and `uses`, and `input`, `run` and `policies` under them, through `parseEntitySource` only, so
// the editor shows the same thing. What needs the domain (the entities, their actions) is the builder's, in
// `services.test.ts`. A contract failure stops MX's pass on its file, so each refused shape is a file of its own.
import { describe, expect, test } from "bun:test";
import { parseEntitySource } from "../src/front-end/build.ts";

const FILE = "/project/src/domain/work/work.mesh.mx";
const HEAD = 'import { Mesh } from "meshfw"\nimport { Task } from "./task.mesh.mx"\nimport { Claim } from "./claim.mesh.mx"\nimport * as work from "./task.mesh.mx"\n\n';
/** `[code, line, column, message]` of what MX and Mesh's hooks report for one service file. */
const mx = (source: string) => parseEntitySource(source, FILE).diagnostics.map((d) => [d.code, d.line, d.column, d.message]);
/** One operation `:a` whose `uses` line is `uses`, with `rest` after it. */
const operation = (uses: string, rest = "    run() {}\n") => `${HEAD}service :Work\n  operation :a\n    ${uses}\n${rest}`;

describe("legal service files", () => {
  test("the design's example lowers with no diagnostic", () => {
    expect(mx(`${HEAD}service :Work
  operation :handOver
    uses entity=Task actions=[:reassign]
    uses entity=Claim actions=[:read, :end]
    input
      uuid :task
      string :reason nullable
    run({ input, context }) {
      return Task.reassign({ id: input.task, outcome: :revoked }, context)
    }
  operation :close
    uses entity=work.Task actions=[:complete]
    uses entity=Claim actions=[:end]
    run() {}
  policies
    policy :members actions=[&handOver] authorize-if=({ actor }) => actor != null
    policy :everyone
      authorize-if=() => true
`)).toEqual([]);
  });
  test.each([
    ["no policies section", operation("uses entity=Task actions=[:read]")],
    ["no input", operation("uses entity=Task actions=[:read]")],
    ["whitespace around the namespace member's dot", operation("uses entity=work. Task actions=[:read]")],
    ["a run with after= (the builder refuses it)", operation("uses entity=Task actions=[:read]", "    run [after=:write] () {}\n")],
  ])("%s", (_, source) => expect(mx(source)).toEqual([]));
  test("names like the new tags stay legal as members of an entity, and an entity keeps its own sections", () => {
    expect(mx("entity :Task\n  attributes\n    uuid :id primary-key\n    string :service\n    string :operation\n    string :uses\n  actions auto=[:read]\n  policies\n    policy :p authorize-if=() => true\n")).toEqual([]);
  });
});

describe("refused shapes", () => {
  test.each([
    ["a service with no operation", `${HEAD}service :Work\n`, ["MESH_MISSING_CHILD", 6, 0, "`service`: missing required child `operation`"]],
    ["attributes under service", `${HEAD}service :Work\n  attributes\n    uuid :id\n`, ["MESH_TAG_NOT_ALLOWED", 7, 2, "`service`: `attributes` is not allowed here; allowed children: `operation`, `policies`"]],
    ["actions under service", `${HEAD}service :Work\n  actions auto=[:read]\n`, ["MESH_TAG_NOT_ALLOWED", 7, 2, "`service`: `actions` is not allowed here; allowed children: `operation`, `policies`"]],
    ["an operation with no uses", `${HEAD}service :Work\n  operation :a\n    run() {}\n`, ["MESH_MISSING_CHILD", 7, 2, "`operation`: missing required child `uses`"]],
    ["an operation with no run", `${HEAD}service :Work\n  operation :a\n    uses entity=Task actions=[:read]\n`, ["MESH_MISSING_CHILD", 7, 2, "`operation`: missing required child `run`"]],
    ["validate under operation", operation("uses entity=Task actions=[:read]", "    run() {}\n    validate\n"), ["MESH_TAG_NOT_ALLOWED", 10, 4, "`operation`: `validate` is not allowed here; allowed children: `uses`, `input`, `run`"]],
    ["on= on an operation", `${HEAD}service :Work\n  operation :a on=X\n    uses entity=Task actions=[:read]\n    run() {}\n`, ["MESH_UNKNOWN_OPTION", 7, 15, "`operation`: unknown option `on`"]],
    ["a run that is no function", operation("uses entity=Task actions=[:read]", "    run=1\n"), ["MESH_OPTION_VALUE", 9, 7, "`run`: option `value` must be function, got number"]],
    ["a call line", operation("call entity=Task actions=[:read]"), ["MESH_UNKNOWN_TAG", 8, 4, "`call` is not a known tag in the `mesh` dialect"]],
    ["a string entity", operation('uses entity="Task" actions=[:read]'), ["MESH_OPTION_VALUE", 8, 9, "`uses`: option `entity` must be an expression"]],
    ["no actions", operation("uses entity=Task"), ["MESH_MISSING_OPTION", 8, 4, "`uses`: missing required option `actions`"]],
    ["no entity", operation("uses actions=[:read]"), ["MESH_MISSING_OPTION", 8, 4, "`uses`: missing required option `entity`"]],
    ["an empty actions list", operation("uses entity=Task actions=[]"), ["MESH_ATOM_LIST", 8, 21, "`uses`: actions must list at least one action of the entity, as atoms (`actions=[:complete]`)"]],
    ["one atom for actions", operation("uses entity=Task actions=:read"), ["MESH_OPTION_VALUE", 8, 29, "`uses`: option `actions` must be array, got atom; write it as a list: `[:read]`"]],
    ["a member in actions", operation("uses entity=Task actions=[&complete]"), ["MESH_OPTION_VALUE", 8, 30, "`uses`: option `actions` item 1 must be atom, got member"]],
    ["a string in actions", operation('uses entity=Task actions=["read"]'), ["MESH_OPTION_VALUE", 8, 30, "`uses`: option `actions` item 1 must be atom, got string"]],
    ["a parenthesised entity", operation("uses entity=(Task) actions=[:read]"), ["MESH_ENTITY_REFERENCE", 8, 16, "`uses`: entity must be the reference alone, with no parentheses, `!`, `as`, `satisfies` or `<T>` around it (`entity=List`, `entity=billing.Invoice`)"]],
    ["a non-null entity", operation("uses entity=Task! actions=[:read]"), ["MESH_ENTITY_REFERENCE", 8, 16, "`uses`: entity must be the reference alone, with no parentheses, `!`, `as`, `satisfies` or `<T>` around it (`entity=List`, `entity=billing.Invoice`)"]],
    ["a call as entity", operation("uses entity=getTask() actions=[:read]"), ["MESH_ENTITY_REFERENCE", 8, 9, "`uses`: entity must be an imported identifier (`List`) or a member of a namespace import (`billing.Invoice`)"]],
    ["an option uses does not take", operation("uses entity=Task actions=[:read] reads=[:x]"), ["MESH_UNKNOWN_OPTION", 8, 37, "`uses`: unknown option `reads`"]],
    ["uses outside an operation", `${HEAD}service :Work\n  uses entity=Task actions=[:read]\n`, ["MESH_TAG_NOT_ALLOWED", 7, 2, "`service`: `uses` is not allowed here; allowed children: `operation`, `policies`"]],
    ["an operation at the root of the file", "operation :a\n", ["MESH_PARENT_NOT_ALLOWED", 1, 0, "`operation` must be inside `service`; found at the top level"]],
    ["an operation in an entity", "entity :T\n  operation :a\n", ["MESH_TAG_NOT_ALLOWED", 2, 2, "`entity`: `operation` is not allowed here; allowed children: `attributes`, `relationships`, `computed`, `checks`, `actions`, `policies`, `events`, `commands`, `handlers`"]],
    ["a service with no name", `${HEAD}service\n  operation :a\n    uses entity=Task actions=[:read]\n    run() {}\n`, ["MESH_MISSING_OPTION", 6, 0, "`service`: missing required option `name`"]],
  ])("%s", (_, source, expected) => expect(mx(source)).toEqual([expected]));
});

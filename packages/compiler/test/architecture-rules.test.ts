// The architecture rules' checks (`notes/architecture/architecture-file-design.md`, PR 2; rules R9 to R11, R16 and R17,
// ruling D40): `checkArchitecture` runs each catalogue rule that has a check at the level the architecture file resolves.
// The settings themselves (the file's lines, presets, unknown rules) are `architecture-file.test.ts`; the one-entity
// service warning's cases are `services.test.ts`.
import { describe, expect, test } from "bun:test";
import type { Diagnostic, ModelDocument, SourcePosition } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";
import { actionExpressions, actionExpressionsByOwner } from "../src/model/action-expressions.ts";
import { aggregateNamesOf, ARCHITECTURE_RULES, checkArchitecture, DEFAULT_SETTINGS, type ArchitectureRule, type RuleInput, type RuleSetting } from "../src/model/architecture-rules.ts";

const AT: SourcePosition = { file: "a.mesh.mx", line: 1, column: 0, offset: 0 };
const EMPTY = { entities: [] } as unknown as ModelDocument;
const INPUT: RuleInput = { document: EMPTY, entityCallsOf: () => [], aggregatesOf: () => [] };

describe("checkArchitecture", () => {
  const found: ArchitectureRule = { name: "stub", code: "MESH_STUB", defaultLevel: "warning", check: (_, report) => report({ message: "found", position: AT, fix: "fix it" }) };
  const silent: ArchitectureRule = { name: "inert", code: "MESH_INERT", defaultLevel: "error" };
  const run = (settings: Record<string, RuleSetting>) => {
    const diagnostics: Diagnostic[] = [];
    checkArchitecture(new Map(Object.entries(settings)), INPUT, diagnostics, [found, silent]);
    return diagnostics.map((d) => [d.severity, d.code, d.message, d.fix]);
  };
  test("a finding is reported under the rule's code at the resolved level; `off` reports nothing", () => {
    expect(run({ stub: "warning" })).toEqual([["warning", "MESH_STUB", "found", "fix it"]]);
    expect(run({ stub: "error" })).toEqual([["error", "MESH_STUB", "found", "fix it"]]);
    expect(run({ stub: "off" })).toEqual([]);
  });
  test("a rule the settings do not name runs at its default level", () => {
    expect(run({})).toEqual([["warning", "MESH_STUB", "found", "fix it"]]);
  });
  test("a rule with no check reports nothing at any level", () => {
    for (const level of ["error", "warning", "off"] as const) expect(run({ stub: "off", inert: level })).toEqual([]);
  });
  test("the catalogue: both rules have a check, at the default level `warning`", () => {
    expect(ARCHITECTURE_RULES.map((rule) => [rule.name, rule.code, rule.defaultLevel])).toEqual([
      ["action-calls-other-aggregate", "MESH_ACTION_CALLS_OTHER_AGGREGATE", "warning"],
      ["service-touches-one-entity", "MESH_SERVICE_ONE_ENTITY", "warning"],
    ]);
    expect(ARCHITECTURE_RULES.find((rule) => rule.name === "service-touches-one-entity")!.check).toBeFunction();
    const diagnostics: Diagnostic[] = [];
    checkArchitecture(DEFAULT_SETTINGS, INPUT, diagnostics);
    expect(diagnostics).toEqual([]);
  });
});

// The cross-aggregate rule (R16; OD7 to OD9 ruled (a) by D40). Fixtures: `work` holds Task and Comment, both in
// TaskAggregate, and Note, in no aggregate; `exec` holds Run, the root of RunAggregate. Each test replaces Run's actions.
const entityFile = (name: string, { imports = "", relationships = "", actions = "", auto = "[:read]", extra = "" } = {}) => `${imports}entity :${name}
  attributes
    uuid :id primary-key
    uuid :otherId nullable
${relationships ? `  relationships\n${relationships}` : ""}${extra}  actions auto=${auto}
${actions}`;
const TASK_ACTIONS = "    update :close\n    read :open\n";
const TASK = entityFile("Task", { actions: TASK_ACTIONS, imports: 'import { Comment } from "./comment.mesh.mx"\n' }).replace("    update :close\n", "    update :close\n      do\n        run=({ self, context }) => Comment.create({ otherId: self.id }, context)\n");
const COMMENT = entityFile("Comment", { imports: 'import { Task } from "./task.mesh.mx"\n', relationships: "    belongs-to :task entity=Task nullable\n", auto: "[:read, :create]" });
const NOTE = entityFile("Note", { imports: 'import { Task } from "./task.mesh.mx"\n', actions: "    update :touch\n      do\n        run=({ self, context }) => Task.close({ id: self.otherId }, context)\n" });
const TASK_AGGREGATE = 'import { Task } from "./task.mesh.mx"\nimport { Comment } from "./comment.mesh.mx"\naggregate :TaskAggregate\n  root entity=Task\n  entities\n    Comment\n';
const RUN_AGGREGATE = 'import { Run } from "./run.mesh.mx"\naggregate :RunAggregate\n  root entity=Run\n';
const RUN_IMPORTS = 'import { Mesh } from "meshfw"\nimport { Task } from "../work/task.mesh.mx"\nimport * as work from "../work/task.mesh.mx"\nimport { Note } from "../work/note.mesh.mx"\nimport { Comment } from "../work/comment.mesh.mx"\n';
const RUN_FILE = "exec/run.mesh.mx";
const run = (actions: string, extra = "") => entityFile("Run", { imports: RUN_IMPORTS, actions: `    update :settle\n${actions}`, extra });
const rulesProject = (runSource: string, extra: Record<string, string | null> = {}) =>
  buildModel({
    root: "/project",
    files: Object.entries({
      "work/task.mesh.mx": TASK,
      "work/comment.mesh.mx": COMMENT,
      "work/note.mesh.mx": NOTE,
      "work/task-aggregate.mesh.mx": TASK_AGGREGATE,
      [RUN_FILE]: runSource,
      "exec/run-aggregate.mesh.mx": RUN_AGGREGATE,
      ...extra,
    }).flatMap(([file, source]) => (source === null ? [] : [{ file, source }])),
  });
const said = (result: ReturnType<typeof buildModel>) =>
  result.diagnostics.map((d) => [d.position.file, d.position.line, d.position.column, d.severity, d.code, d.message]);
const RUN_STEP = (call: string) => `    update :finish\n      do\n        run=({ self, context }) => ${call}\n`;
const ADVICE = "and no aggregate holds both: an effect across aggregates belongs in a service, in plain code over `transaction`, or in a `publish` and a listener";
const FIX = "move the call out of the entity's action, or switch the rule off in the architecture file: `disable :action-calls-other-aggregate`";
/** Run's line 14 is `update :finish`'s step, and `run=({ self, context }) => ` puts the call at column 35 (0-based, as stored). */
const warning = (what: string, owners: string, callee: string, line = 14, column = 35, target = "work.Task") =>
  [RUN_FILE, line, column, "warning", "MESH_ACTION_CALLS_OTHER_AGGREGATE", `${what} of ${owners} of exec.Run calls \`${callee}\`, a write action of ${target}, ${ADVICE}`];

/** Comment as a part of both aggregates: it belongs to Task and to Run. */
const SHARED = {
  "work/comment.mesh.mx": COMMENT.replace("import { Task }", 'import { Run } from "../exec/run.mesh.mx"\nimport { Task }').replace("    belongs-to :task entity=Task nullable\n", "    belongs-to :task entity=Task nullable\n    belongs-to :run entity=Run nullable\n"),
  "exec/run-aggregate.mesh.mx": 'import { Run } from "./run.mesh.mx"\nimport { Comment } from "../work/comment.mesh.mx"\naggregate :RunAggregate\n  root entity=Run\n  entities\n    Comment\n',
};

describe(":action-calls-other-aggregate", () => {
  test("a run step that calls another aggregate's update warns at the callee; the build succeeds and the document is unchanged", () => {
    const result = rulesProject(run(RUN_STEP("Task.close({ id: self.otherId }, context)")));
    expect(said(result)).toEqual([warning("run", "update :finish", "Task.close")]);
    expect(result.diagnostics[0]!.fix).toBe(FIX);
    expect(result.document).not.toBeNull();
    const off = rulesProject(run(RUN_STEP("Task.close({ id: self.otherId }, context)")), { "architecture.mesh.mx": "architecture :project\n  disable :action-calls-other-aggregate\n" });
    expect(said(off)).toEqual([]);
    expect(JSON.stringify(off.document)).toBe(JSON.stringify(result.document));
  });
  test("through a namespace import, an aliased import, a computed string or template member and an awaited call", () => {
    const aliased = run(RUN_STEP("T.close({ id: self.otherId }, context)")).replace("import { Mesh }", 'import { Task as T } from "../work/task.mesh.mx"\nimport { Mesh }');
    expect(said(rulesProject(aliased))).toEqual([warning("run", "update :finish", "T.close", 15)]);
    expect(said(rulesProject(run(RUN_STEP("work.Task.close({ id: self.otherId }, context)"))))).toEqual([warning("run", "update :finish", "work.Task.close")]);
    expect(said(rulesProject(run(RUN_STEP('Task["close"]({ id: self.otherId }, context)'))))).toEqual([warning("run", "update :finish", "Task.close")]);
    expect(said(rulesProject(run(RUN_STEP("Task[`close`]({ id: self.otherId }, context)"))))).toEqual([warning("run", "update :finish", "Task.close")]);
    expect(said(rulesProject(run(RUN_STEP("Task.close.call(null, { id: self.otherId }, context)"))))).toEqual([warning("run", "update :finish", "Task.close")]);
    expect(said(rulesProject(run("    update :finish\n      do\n        run [after=:write] async ({ self, context }) {\n          await Task.close({ id: self.otherId }, context)\n        }\n")))).toEqual([warning("run", "update :finish", "Task.close", 15, 16)]);
  });
  test("an auto create or destroy counts as a write action", () => {
    const withAuto = { "work/task.mesh.mx": TASK.replace("auto=[:read]", "auto=[:read, :create, :destroy]") };
    expect(said(rulesProject(run(RUN_STEP("Task.destroy({ id: self.otherId }, context)")), withAuto))).toEqual([warning("run", "update :finish", "Task.destroy")]);
    expect(said(rulesProject(run(RUN_STEP("Task.create({}, context)")), withAuto))).toEqual([warning("run", "update :finish", "Task.create")]);
  });
  test("in a `set` value, a check's `that`, a step's `when` and an `always` block", () => {
    const set = "    update :finish\n      do\n        set\n          &otherId=async ({ self, context }) => (await Task.close({ id: self.otherId }, context)).id\n";
    expect(said(rulesProject(run(set)))).toEqual([warning("set &otherId", "update :finish", "Task.close", 15, 55)]);
    const check = '    update :finish\n      validate\n        check :ok that=async ({ self, context }) => (await Task.close({ id: self.otherId }, context)) !== null code="ok" message="ok"\n';
    expect(said(rulesProject(run(check)))).toEqual([warning("check :ok (that)", "update :finish", "Task.close", 14, 59)]);
    const when = "    update :finish\n      do\n        when=async ({ self, context }) => (await Task.close({ id: self.otherId }, context)) !== null\n          run=() => undefined\n";
    expect(said(rulesProject(run(when)))).toEqual([warning("when", "update :finish", "Task.close", 14, 49)]);
    const always = "    always types=[:update]\n      do\n        run=({ self, context }) => Task.close({ id: self.otherId }, context)\n";
    expect(said(rulesProject(run(always)))).toEqual([warning("run", "always", "Task.close")]);
  });
  test("a named check two actions use: one warning at the call, naming both owners", () => {
    const checks = '  checks\n    check :ok that=async ({ self, context }) => (await Task.close({ id: self.otherId }, context)) !== null code="ok" message="ok"\n';
    const actions = "    update :a\n      validate\n        check &ok\n    update :b\n      validate\n        check &ok\n    update :c\n      validate\n        check &ok\n";
    expect(said(rulesProject(run(actions, checks)))).toEqual([warning("check :ok (that)", "update :a, update :b and update :c", "Task.close", 11, 55)]);
  });
  test("no warning: the same aggregate, the entity itself, an entity in no aggregate, reads and names that are no write action", () => {
    // Task's own `close` step calls Comment.create: both are in TaskAggregate.
    // The entity itself, through an import of its own file: the binding resolves, to the caller.
    const self = (call: string) => run(RUN_STEP(call)).replace("import { Mesh }", 'import { Run } from "./run.mesh.mx"\nimport * as ex from "./run.mesh.mx"\nimport { Mesh }');
    expect(said(rulesProject(self("Run.settle({ id: self.id }, context)")))).toEqual([]);
    expect(said(rulesProject(self("ex.Run.settle({ id: self.id }, context)")))).toEqual([]);
    // Note is in no aggregate file (OD9 (a)): neither its call to Task nor Run's call to it is reported.
    expect(said(rulesProject(run(RUN_STEP("Note.touch({ id: self.id }, context)"))))).toEqual([]);
    // Reads (OD8 (a)): the auto read, a custom read, and Mesh.privileged.
    expect(said(rulesProject(run(RUN_STEP("Task.read({}, context)"))))).toEqual([]);
    expect(said(rulesProject(run(RUN_STEP("Task.open({}, context)"))))).toEqual([]);
    expect(said(rulesProject(run(RUN_STEP("Mesh.privileged(Task).read({})"))))).toEqual([]);
    // A member that is no action of the target, and a computed member the build cannot read.
    expect(said(rulesProject(run(RUN_STEP("Task.notAnAction({}, context)"))))).toEqual([]);
    expect(said(rulesProject(run(RUN_STEP("Task[self.otherId]({}, context)"))))).toEqual([]);
  });
  test("an entity in both aggregates shares an aggregate with each, so a call to it is not reported", () => {
    expect(said(rulesProject(run(RUN_STEP("Comment.create({}, context)")), SHARED))).toEqual([]);
    expect(said(rulesProject(run(RUN_STEP("Comment.create({}, context)"))))).toEqual([warning("run", "update :finish", "Comment.create", 14, 35, "work.Comment")]);
  });
  test("without the aggregate files, nothing is reported (OD9 (a))", () => {
    expect(said(rulesProject(run(RUN_STEP("Task.close({ id: self.otherId }, context)")), { "work/task-aggregate.mesh.mx": null }))).toEqual([]);
    expect(said(rulesProject(run(RUN_STEP("Task.close({ id: self.otherId }, context)")), { "exec/run-aggregate.mesh.mx": null }))).toEqual([]);
  });
  test("a handler of Run's file that calls Task.close is not an action function: no warning", () => {
    const handlers = "  events\n    event :RunDone\n      uuid :id\n  handlers\n    listen :closeTask [on=RunDone] ({ event, context }) {\n      return Task.close({ id: event.payload.id }, context)\n    }\n";
    const result = rulesProject(run("") + handlers);
    expect(result.diagnostics.filter((d) => d.code !== "MESH_EVENT_NOT_PUBLISHED")).toEqual([]);
    expect(result.document!.entities.find((e) => e.name === "Run")!.handlers).toHaveLength(1);
  });
  test("levels: `severity level=:error` fails the build; the preset alone keeps the warning", () => {
    const graded = rulesProject(run(RUN_STEP("Task.close({ id: self.otherId }, context)")), { "architecture.mesh.mx": "architecture :project\n  severity :action-calls-other-aggregate level=:error\n" });
    expect(said(graded).map((d) => [d[3], d[4]])).toEqual([["error", "MESH_ACTION_CALLS_OTHER_AGGREGATE"]]);
    expect(graded.document).toBeNull();
    const preset = rulesProject(run(RUN_STEP("Task.close({ id: self.otherId }, context)")), { "architecture.mesh.mx": 'import { MeshRecommended } from "meshfw/architecture"\narchitecture :project\n  use preset=MeshRecommended\n  severity :action-calls-other-aggregate level=:warning\n' });
    expect(said(preset).map((d) => [d[3], d[4]])).toEqual([["warning", "MESH_ACTION_CALLS_OTHER_AGGREGATE"]]);
  });
});

describe("actionExpressionsByOwner", () => {
  test("groups an entity's functions by action and `always` block, and never holds a handler body", () => {
    const result = rulesProject(run(RUN_STEP("Run.settle({ id: self.id }, context)") + "    always types=[:update]\n      do\n        run=() => undefined\n") + "  events\n    event :RunDone\n      uuid :id\n  handlers\n    listen :h [on=RunDone] ({ event }) {\n      return event\n    }\n");
    const entity = result.document!.entities.find((e) => e.name === "Run")!;
    const owners = actionExpressionsByOwner(entity);
    expect(owners.map((o) => [o.owner, o.expressions.map((e) => e.what)])).toEqual([["update :settle", []], ["update :finish", ["run"]], ["always", ["run"]]]);
    expect(owners.flatMap((o) => o.expressions)).toEqual(actionExpressions(entity));
    const handler = entity.handlers![0]!.run;
    expect(owners.flatMap((o) => o.expressions).some((e) => e.expression === handler)).toBe(false);
  });
});

describe("the aggregatesOf adapter", () => {
  test("an entity listed in two aggregates belongs to both, the root of one only to it, and an unlisted one to none", () => {
    const result = rulesProject(run(""), SHARED);
    expect(result.diagnostics).toEqual([]);
    const of = aggregateNamesOf(result.document!);
    expect(of("work.Comment")).toEqual(["work.TaskAggregate", "exec.RunAggregate"]);
    expect(of("exec.Run")).toEqual(["exec.RunAggregate"]);
    expect(of("work.Note")).toEqual([]);
  });
});

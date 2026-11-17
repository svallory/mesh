// Service files in the model (`notes/architecture/services-design.md`, PR 1, sections 2, 5.1 and 6; ruling D42): a file
// whose root line is `service :Name`, built into `ModelDocument.services` by `buildService` (`front-end/services.ts`) and
// checked against the built entities by `checkServices` (`model/services.ts`); the import rules (R16, OD-12); the
// one-entity warning (R3); the `MESH_NOT_IMPLEMENTED` stopgap in `generateFiles`; and a project without services, whose
// document is unchanged (R13).
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Diagnostic, Service } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";
import { generateFiles, stableJsonStringify, type ResolvedConfig } from "../src/index.ts";

type Files = Record<string, string>;
const entity = (name: string, { imports = "", body = "", actions = "", auto = "[:read]" } = {}) => `${imports}entity :${name}
  attributes
    uuid :id primary-key
${body}  actions auto=${auto}
${actions}  policies
    policy :anyone
      authorize-if=() => true
`;
/** Task: auto read and create, named updates (`complete` with a transition, an `always` block and a named check), one answering a command. */
const TASK = entity("Task", {
  imports: 'import { ReopenTask } from "./reopen-task.mesh.mx"\n',
  body: "    string :title\n    enum :state values=[:open, :done] default=:open\n    uuid :assignee nullable\n",
  auto: "[:read, :create]",
  actions: `    always types=[:update]
      validate
        check &titled
    update :complete
      do
        set
          &state=:done
    update :reassign
      input
        &assignee
    update on=ReopenTask
`,
}).replace("  actions", `  checks
    check :titled [
      that=() => &title.length > 0
      code="task.title"
      message="a task needs a title"
    ]
  actions`);
const CLAIM = entity("Claim", {
  imports: 'import { Task } from "./task.mesh.mx"\n',
  body: "    string :reason nullable\n  relationships\n    belongs-to :task entity=Task\n",
  actions: "    update :end\n      input\n        &reason\n",
});
const NOTIFICATION = entity("Notification", { actions: "    create :send\n" });
const RUN = entity("Run", { actions: "    update :cancel\n" });
const DOMAIN: Files = {
  "src/domain/work/task.mesh.mx": TASK,
  "src/domain/work/claim.mesh.mx": CLAIM,
  "src/domain/work/notification.mesh.mx": NOTIFICATION,
  "src/domain/work/reopen-task.mesh.mx": "command :ReopenTask\n  uuid :id\n",
  "src/domain/work/task-done.mesh.mx": "event :TaskDone\n  uuid :id\n",
  "src/domain/execution/run.mesh.mx": RUN,
};
const WORK_FILE = "src/domain/work/work.mesh.mx";
const HEAD = `import { Mesh } from "meshfw"
import { Task } from "./task.mesh.mx"
import { Claim } from "./claim.mesh.mx"
import * as w from "./notification.mesh.mx"
import * as execution from "../execution/run.mesh.mx"
`;
/** The fixture service: one operation across two entities, one through a namespace import, one across modules, one that reads `actor`, `input` and `%.now` free. */
const WORK = `${HEAD}
service :Work
  operation :handOver
    uses entity=Task actions=[:reassign]
    uses entity=Claim actions=[:read, :end]
    input
      uuid :task
      uuid :to
      string :reason nullable
    run({ input, context }) {
      for (const claim of await Mesh.privileged(Claim).read({ filter: { taskId: { eq: input.task } } }))
        await Claim.end({ id: claim.id, reason: input.reason ?? "handed over" }, context)
      return Task.reassign({ id: input.task, assignee: input.to }, context)
    }
  operation :notify
    uses entity=Task actions=[:read]
    uses entity=w.Notification actions=[:send]
    run({ context }) {
      return w.Notification.send({}, context)
    }
  operation :cancelRun
    uses entity=execution.Run actions=[:cancel]
    uses entity=Task actions=[:complete]
    input
      uuid :run
    run() {
      return execution.Run.cancel({ id: input.run }, context)
    }
  operation :finish
    uses entity=Task actions=[:complete, :reopenTask, :create]
    uses entity=Claim actions=[:end]
    input
      uuid :task
    run() {
      const at = %.now
      return Task.complete({ id: input.task }, { ...context, actor: actor.id, at })
    }
  policies
    policy :members actions=[&handOver, &notify] authorize-if=({ actor }) => actor != null
    policy :everyone
      authorize-if=() => true
`;
const project = (files: Files) => ({ root: "/project", domainRoot: "src/domain", files: Object.entries(files).map(([file, source]) => ({ file, source })) });
const build = (files: Files, domain: Files = DOMAIN) => buildModel(project({ ...domain, ...files }));
const brief = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => [d.position.file, d.position.line, d.position.column, d.severity, d.code, d.message, d.fix]);
/** A service file of `lines` under `service :Work`, after `imports`. */
const work = (lines: string, imports = HEAD) => ({ [WORK_FILE]: `${imports}service :Work\n${lines}` });
/** An operation of two entities, so no one-entity warning, with `body` as its run and `extra` lines before it. */
const op = (body: string, extra = "", name = "go") =>
  `  operation :${name}\n    uses entity=Task actions=[:read]\n    uses entity=Claim actions=[:read]\n${extra}    run(${body.includes("context") || body.includes("input") ? "{ input, context }" : ""}) {\n      ${body}\n    }\n`;
const OPEN = "  policies\n    policy :everyone\n      authorize-if=() => true\n";
const diags = (result: ReturnType<typeof build>, code?: string) => brief(result.diagnostics.filter((d) => code === undefined || d.code === code));
const serviceOf = (result: ReturnType<typeof build>): Service => result.document!.services![0]!;

describe("the model", () => {
  test("the fixture builds with no diagnostic into ModelDocument.services", () => {
    const result = build({ [WORK_FILE]: WORK });
    expect(diags(result)).toEqual([]);
    const service = serviceOf(result);
    expect(service).toMatchObject({ name: "Work", fqn: "work.Work", file: WORK_FILE, module: "work" });
    expect(service.operations.map((operation) => operation.name)).toEqual(["handOver", "notify", "cancelRun", "finish"]);
    const [handOver, notify, cancelRun] = service.operations;
    expect(handOver!.uses).toEqual([
      { entity: { identifier: "Task", from: "./task.mesh.mx" }, fqn: "work.Task", actions: [{ name: "reassign", position: { file: WORK_FILE, line: 9, column: 30, offset: expect.any(Number) } }], position: { file: WORK_FILE, line: 9, column: 4, offset: expect.any(Number) } },
      { entity: { identifier: "Claim", from: "./claim.mesh.mx" }, fqn: "work.Claim", actions: [{ name: "read", position: expect.objectContaining({ line: 10, column: 31 }) }, { name: "end", position: expect.objectContaining({ line: 10, column: 38 }) }], position: expect.objectContaining({ line: 10, column: 4 }) },
    ]);
    expect(handOver!.input.map((field) => [field.kind, field.name, field.type, field.nullable])).toEqual([["argument", "task", "uuid", false], ["argument", "to", "uuid", false], ["argument", "reason", "string", true]]);
    expect(handOver!.run.plain).toMatchObject({ why: "run-step", privileged: true, entities: ["Claim", "Task"] });
    expect(notify!.uses.map((use) => [use.entity.identifier, use.fqn])).toEqual([["Task", "work.Task"], ["w.Notification", "work.Notification"]]);
    expect(cancelRun!.uses.map((use) => use.fqn)).toEqual(["execution.Run", "work.Task"]);
    expect(service.operations[3]!.run.plain).toMatchObject({ why: "run-step", clock: ["now"] });
    expect([...service.operations[3]!.run.plain!.roots].sort()).toEqual(["actor", "context", "input"]);
    // Every service function is plain, whatever it holds: a policy one is `why: "service"`.
    expect(service.policies.map((policy) => [policy.name, policy.actions?.map((a) => a.name), policy.authorizeIf[0]!.plain?.why])).toEqual([
      ["members", ["handOver", "notify"], "service"],
      ["everyone", undefined, "service"],
    ]);
  });
  test("FQNs: at the domain root, in a `_group` folder, and a service alone in its folder", () => {
    const root = build({ "src/domain/billing.mesh.mx": `import { Task } from "./work/task.mesh.mx"\nimport { Run } from "./execution/run.mesh.mx"\nservice :billing\n${op("return 1", "", "x").replace("entity=Claim", "entity=Run")}` });
    expect(diags(root)).toEqual([]);
    expect(serviceOf(root)).toMatchObject({ name: "Billing", fqn: "Billing", module: "" });
    const grouped = build({ "src/domain/work/_services/work.mesh.mx": `import { Task } from "../task.mesh.mx"\nimport { Claim } from "../claim.mesh.mx"\nservice :Work\n${op("return 1")}` });
    expect(diags(grouped)).toEqual([]);
    expect(serviceOf(grouped).fqn).toBe("work.Work");
    const alone = build({ "src/domain/orchestration/billing.mesh.mx": `import { Task } from "../work/task.mesh.mx"\nimport * as ex from "../execution/run.mesh.mx"\nservice :Billing\n${op("return ex.Run.cancel({ id: input.id }, context)", "", "x").replace("entity=Claim actions=[:read]", "entity=ex.Run actions=[:cancel]")}` });
    expect(diags(alone)).toEqual([]);
    expect(serviceOf(alone).fqn).toBe("orchestration.Billing");
  });
  test("a service with no policies section builds (every call of it is forbidden at run time); an auto action and a command-named action are actions", () => {
    const result = build(work(op("return Task.reopenTask({ id: input.id }, context)").replace("actions=[:read]", "actions=[:read, :create, :reopenTask]")));
    expect(diags(result)).toEqual([]);
    expect(serviceOf(result).policies).toEqual([]);
  });
  test("a project with no service file is unchanged: no `services` key", () => {
    const result = build({});
    expect(diags(result)).toEqual([]);
    expect(Object.hasOwn(result.document!, "services")).toBe(false);
    const withService = build({ [WORK_FILE]: WORK });
    const { services, ...rest } = withService.document!;
    expect(services).toHaveLength(1);
    expect(stableJsonStringify(rest)).toBe(stableJsonStringify(result.document));
  });
});

describe("the one-entity warning (R3)", () => {
  const ONE = "  operation :close\n    uses entity=Task actions=[:complete]\n    run({ input, context }) {\n      return Task.complete({ id: input.id }, context)\n    }\n";
  test("an operation whose uses lines name one entity warns at its line; the build still succeeds", () => {
    const result = build(work(ONE + OPEN));
    expect(diags(result)).toEqual([[WORK_FILE, 7, 2, "warning", "MESH_SERVICE_ONE_ENTITY",
      "operation :close of work.Work uses only work.Task: an operation that touches one entity belongs on that entity, as an action",
      "move it to Task as an action, or add the other entities it reaches"]]);
    expect(result.document).not.toBeNull();
  });
  test("not for two entities, and not for two same-named entities of two modules", () => {
    expect(diags(build(work(op("return 1") + OPEN)))).toEqual([]);
    const other = { "src/domain/execution/task.mesh.mx": entity("Task", { actions: "    update :complete\n" }) };
    const twoTasks = build(work("  operation :close\n    uses entity=Task actions=[:complete]\n    uses entity=ex.Task actions=[:complete]\n    run() {\n      return 1\n    }\n", `import { Task } from "./task.mesh.mx"\nimport * as ex from "../execution/task.mesh.mx"\n`), { ...DOMAIN, ...other });
    expect(diags(twoTasks)).toEqual([]);
  });
  test("the architecture file's setting of :service-touches-one-entity: `disable` raises nothing, `severity level=:error` makes it an error", () => {
    const ARCH = "src/domain/architecture.mesh.mx";
    const off = build({ ...work(ONE + OPEN), [ARCH]: "architecture :project\n  disable :service-touches-one-entity\n" });
    expect(diags(off)).toEqual([]);
    const graded = build({ ...work(ONE + OPEN), [ARCH]: "architecture :project\n  severity :service-touches-one-entity level=:error\n" });
    expect(diags(graded).map((d) => [d[1], d[3], d[4]])).toEqual([[7, "error", "MESH_SERVICE_ONE_ENTITY"]]);
    const other = build({ ...work(ONE + OPEN), [ARCH]: "architecture :project\n  disable :action-calls-other-aggregate\n" });
    expect(diags(other).map((d) => [d[1], d[3], d[4]])).toEqual([[7, "warning", "MESH_SERVICE_ONE_ENTITY"]]);
  });
  test("not when a uses line resolved to nothing (its own error is enough)", () => {
    const result = build(work("  operation :close\n    uses entity=Task actions=[:complete]\n    uses entity=Nope actions=[:read]\n    run() {\n      return 1\n    }\n"));
    expect(diags(result).map((d) => d[4])).toEqual(["MESH_UNKNOWN_ENTITY"]);
  });
});

describe("uses lines", () => {
  test("an action the entity does not have is MESH_UNKNOWN_ACTION at the atom, with the nearest name", () => {
    const result = build(work(op("return 1").replace("entity=Task actions=[:read]", "entity=Task actions=[:read, :compleet]")));
    expect(diags(result)).toEqual([[WORK_FILE, 8, 37, "error", "MESH_UNKNOWN_ACTION",
      ":compleet is not an action of work.Task: a `uses` line names actions of the entity it uses (:complete, :reassign, :reopenTask, :read, :create). Did you mean :complete?", null]]);
  });
  test("a repeated atom is MESH_ATOM_LIST at the second; two lines of one entity MESH_DUPLICATE_MEMBER at the later", () => {
    const twice = build(work(op("return 1").replace("entity=Task actions=[:read]", "entity=Task actions=[:read, :read]")));
    expect(diags(twice)).toEqual([[WORK_FILE, 8, 37, "error", "MESH_ATOM_LIST", "actions lists :read twice", "remove the second :read"]]);
    const lines = build(work(op("return 1", "    uses entity=Task actions=[:create]\n")));
    expect(diags(lines)).toEqual([[WORK_FILE, 10, 4, "error", "MESH_DUPLICATE_MEMBER",
      "Duplicate uses of work.Task: one line per entity; list every action it calls in that line's actions=", "merge the two lines into one"]]);
  });
  test("entity= that is no imported entity: an unknown name with the nearest one, an event's import (the import's error alone), a helper", () => {
    const unknown = build(work(op("return 1").replace("entity=Claim", "entity=Clam")));
    expect(diags(unknown).map((d) => [d[1], d[2], d[4], d[5]])).toEqual([[9, 16, "MESH_UNKNOWN_ENTITY", "Clam is not an imported entity. Did you mean Claim?"]]);
    const event = build(work(op("return 1").replace("entity=Claim", "entity=TaskDone"), `${HEAD}import { TaskDone } from "./task-done.mesh.mx"\n`));
    expect(diags(event).map((d) => [d[1], d[2], d[4], d[5]])).toEqual([[6, 0, "MESH_UNKNOWN_IMPORT",
      'A service file imports entity files, helper modules and `Mesh` from "meshfw": ./task-done.mesh.mx declares the event TaskDone, and a service owns no events yet']]);
  });
});

describe("the uses-vs-body check (MESH_SERVICE_USES)", () => {
  const USES = (name: string, run: string) => [WORK_FILE, run === "" ? 0 : Number(run), 4, "error", "MESH_SERVICE_USES",
    `operation :go of work.Work names ${name}, which no \`uses\` line of the operation lists: an operation reaches only the entities its \`uses\` lines name`,
    `add \`uses entity=${name} actions=[...]\` listing what it calls`];
  test("an imported entity the body names that no line lists, at the run line", () => {
    const body = "  operation :go\n    uses entity=Task actions=[:read]\n    uses entity=w.Notification actions=[:send]\n    run({ input, context }) {\n      return Claim.end({ id: input.id }, context)\n    }\n";
    expect(diags(build(work(body)))).toEqual([USES("Claim", "10")]);
  });
  test("a namespace member no line lists, beside one that is listed (`w.Notification` listed, `execution.Run` not)", () => {
    const body = "  operation :go\n    uses entity=Task actions=[:read]\n    uses entity=w.Notification actions=[:send]\n    run({ context }) {\n      return [w.Notification.send({}, context), execution.Run.cancel({ id: 1 }, context)]\n    }\n";
    expect(diags(build(work(body)))).toEqual([USES("execution.Run", "10")]);
  });
  test("an entity the line names through another spelling is listed (`uses entity=Task`, the body reads it through a second namespace import)", () => {
    const body = "  operation :go\n    uses entity=Task actions=[:read]\n    uses entity=Claim actions=[:read]\n    run({ context }) {\n      return t.Task.read({}, context)\n    }\n";
    expect(diags(build(work(body, `${HEAD}import * as t from "./task.mesh.mx"\n`)))).toEqual([]);
  });
  test("a namespace alias the body reads bare (destructured or passed on) counts as naming the entity its file declares", () => {
    const destructured = "  operation :go\n    uses entity=Task actions=[:read]\n    uses entity=Claim actions=[:read]\n    run({ context }) {\n      const { Notification } = w\n      return Notification.send({}, context)\n    }\n";
    expect(diags(build(work(destructured)))).toEqual([USES("w.Notification", "10")]);
    const listed = destructured.replace("entity=Claim actions=[:read]", "entity=w.Notification actions=[:send]");
    expect(diags(build(work(listed)))).toEqual([]);
  });
  test("not for a helper the body calls, whatever the helper reaches (the run-time check covers it)", () => {
    const helper = { "src/domain/work/work.helpers.ts": "export const audit = (x: unknown) => x;\n" };
    const result = build(work(op("return audit(input)"), `${HEAD}import { audit } from "./work.helpers"\n`), { ...DOMAIN, ...helper });
    expect(diags(result).filter((d) => String(d[0]).endsWith(".mesh.mx"))).toEqual([]);
  });
});

describe("functions of a service have no record", () => {
  const free = (name: string, line: number, column: number, fix = "read `input`, `actor` and `context`") => [WORK_FILE, line, column, "error", "MESH_EXPR_FREE_VARIABLE",
    `\`${name}\` is not defined in a service function: a service has no record; read \`input\`, \`actor\` and \`context\`, and the entities through their values`, fix];
  test("`self` and `before` in the body, read free or destructured, and `&x`", () => {
    expect(diags(build(work(op("return self")) ))).toEqual([free("self", 10, 7)]);
    const destructured = build(work("  operation :go\n    uses entity=Task actions=[:read]\n    uses entity=Claim actions=[:read]\n    run({ before }) {\n      return before\n    }\n"));
    expect(diags(destructured)).toEqual([free("before", 10, 7)]);
    expect(diags(build(work(op("return &title"))))).toEqual([free("&title", 11, 13, "declare the value as an `input` field and read `input`")]);
  });
  test("in a policy, and a policy's legal neighbours (`actor`, `input`, `context`, `Mesh.privileged`, an atom compared with an input) stay legal", () => {
    expect(diags(build(work(`${op("return 1")}  policies\n    policy :p authorize-if=({ self }) => self != null\n`)))).toEqual([free("self", 14, 27)]);
    const beforeAndMember = build(work(`${op("return 1")}  policies\n    policy :p authorize-if=({ before }) => &x != null\n`));
    expect(diags(beforeAndMember).map((d) => [d[1], d[4], d[5]])).toEqual([
      [14, "MESH_EXPR_FREE_VARIABLE", free("before", 0, 0)[5]],
      [14, "MESH_EXPR_FREE_VARIABLE", free("&x", 0, 0)[5]],
    ]);
    const legal = build(work(`${op("return 1")}  policies\n    policy :p authorize-if=async ({ actor, input, context }) => actor != null && input.kind === :big && (await Mesh.privileged(Task).read({}, context)).length > 0\n`));
    expect(diags(legal)).toEqual([]);
    expect(serviceOf(legal).policies[0]!.authorizeIf[0]!.plain).toMatchObject({ why: "service", privileged: true });
  });
});

describe("policies", () => {
  test("types= is MESH_UNKNOWN_OPTION; actions= names operations (MESH_UNKNOWN_ACTION with the nearest); a policy with no check MESH_POLICY_NO_CHECKS", () => {
    const types = build(work(`${op("return 1")}  policies\n    policy :p types=[:update] authorize-if=() => true\n`));
    expect(diags(types)).toEqual([[WORK_FILE, 14, 14, "error", "MESH_UNKNOWN_OPTION",
      "`types` is not an option of a policy of a service: an operation has no action type; scope the policy with `actions=[&operation]`", "write `actions=[&operation]`, or remove `types` to cover every operation"]]);
    const unknown = build(work(`${op("return 1")}  policies\n    policy :p actions=[&og] authorize-if=() => true\n`));
    expect(diags(unknown)).toEqual([[WORK_FILE, 14, 23, "error", "MESH_UNKNOWN_ACTION", "&og is not an operation of work.Work: `actions=` names the service's own operations (&go). Did you mean &go?", null]]);
    const empty = build(work(`${op("return 1")}  policies\n    policy :p\n`));
    expect(diags(empty).map((d) => [d[1], d[4], d[5]])).toEqual([[14, "MESH_POLICY_NO_CHECKS", "policy :p of work.Work has no `authorize-if` and no `forbid-if`, so it would pass every call it covers"]]);
  });
  test("two operations, or an operation and a policy, of one name are MESH_DUPLICATE_MEMBER at the later", () => {
    expect(diags(build(work(op("return 1") + op("return 2"))), "MESH_DUPLICATE_MEMBER").map((d) => [d[1], d[5]])).toEqual([[13, "Duplicate member :go"]]);
    expect(diags(build(work(`${op("return 1")}  policies\n    policy :go authorize-if=() => true\n`)), "MESH_DUPLICATE_MEMBER").map((d) => [d[1], d[5]])).toEqual([[14, "Duplicate member :go"]]);
  });
});

describe("operation lines", () => {
  test("a member line in input is MESH_UNKNOWN_MEMBER; a repeated field MESH_DUPLICATE_INPUT; run after= MESH_UNKNOWN_OPTION", () => {
    expect(diags(build(work(op("return 1", "    input\n      &title\n"))))).toEqual([[WORK_FILE, 11, 6, "error", "MESH_UNKNOWN_MEMBER",
      "&title is not a member of work.Work: a service has no members; declare the field with its type (`string :title`)", "write `string :title`, or the type the field has"]]);
    expect(diags(build(work(op("return 1", "    input\n      string :a\n      integer :a\n")))).map((d) => [d[1], d[4], d[5]])).toEqual([[12, "MESH_DUPLICATE_INPUT", "Duplicate input name a"]]);
    const after = build(work(op("return 1").replace("    run(", "    run [after=:write] (")));
    expect(diags(after).map((d) => [d[1], d[4], d[5]])).toEqual([[10, "MESH_UNKNOWN_OPTION", "`after` is not an option of an operation's `run`: the body is the whole operation, so there is no write to run after"]]);
  });
  test("an operation named like a JavaScript reserved word or `toString` builds; `__proto__` is refused", () => {
    expect(diags(build(work(op("return 1", "", "delete") + op("return 1", "", "toString"))))).toEqual([]);
    expect(diags(build(work(op("return 1", "", "__proto__")))).map((d) => d[4])).toEqual(["MESH_NAME"]);
  });
  test("a service named with no class name is MESH_NAME", () => {
    expect(diags(build({ [WORK_FILE]: `${HEAD}service :_1\n${op("return 1")}` })).map((d) => [d[4], d[5]])).toEqual([["MESH_NAME",
      "Service :_1 makes no class name: Mesh drops each `_` and capitalises the letter after it, so the name needs a letter, such as :Work"]]);
  });
});

describe("files and imports (R6, R7, R16, OD-12)", () => {
  test("a second service in one file is MESH_DUPLICATE_ENTITY; two files of one FQN too; the same name in two modules is fine", () => {
    const two = build({ [WORK_FILE]: `${HEAD}service :Work\n${op("return 1")}service :Other\n${op("return 1")}` });
    expect(diags(two, "MESH_DUPLICATE_ENTITY").map((d) => [d[1], d[5]])).toEqual([[13, "A service file must contain exactly one service"]]);
    const dup = build({ ...work(op("return 1")), "src/domain/work/work2.mesh.mx": `${HEAD}service :Work\n${op("return 1")}` });
    expect(diags(dup, "MESH_DUPLICATE_ENTITY").map((d) => [d[0], d[5]])).toEqual([["src/domain/work/work2.mesh.mx", `Duplicate service work.Work; first declared in ${WORK_FILE}`]]);
    const modules = build({ ...work(op("return 1")), "src/domain/execution/work.mesh.mx": `import { Run } from "./run.mesh.mx"\nimport { Task } from "../work/task.mesh.mx"\nservice :Work\n${op("return 1").replace("entity=Claim", "entity=Run")}` });
    expect(diags(modules)).toEqual([]);
  });
  test("a service file imports no event, command or service; an entity file imports no service", () => {
    const command = build(work(op("return 1"), `${HEAD}import { ReopenTask } from "./reopen-task.mesh.mx"\n`));
    expect(diags(command).map((d) => [d[1], d[4], d[5]])).toEqual([[6, "MESH_UNKNOWN_IMPORT", 'A service file imports entity files, helper modules and `Mesh` from "meshfw": ./reopen-task.mesh.mx declares the command ReopenTask, and a service owns no commands yet']]);
    const namespaceEvent = build(work(op("return 1"), `${HEAD}import * as ev from "./task-done.mesh.mx"\n`));
    expect(diags(namespaceEvent).map((d) => [d[1], d[4]])).toEqual([[6, "MESH_UNKNOWN_IMPORT"]]);
    const other = { "src/domain/work/other.mesh.mx": `import { Task } from "./task.mesh.mx"\nimport { Claim } from "./claim.mesh.mx"\nservice :Other\n${op("return 1")}` };
    const service = build({ ...work(op("return 1"), `${HEAD}import { Other } from "./other.mesh.mx"\n`), ...other });
    expect(diags(service).map((d) => [d[0], d[1], d[4], d[5]])).toEqual([[WORK_FILE, 6, "MESH_UNKNOWN_IMPORT", "./other.mesh.mx declares the service Other, and a service calls entities, not other services"]]);
    const fromEntity = build({ ...other, "src/domain/work/notification.mesh.mx": `import { Other } from "./other.mesh.mx"\n${NOTIFICATION}` });
    expect(diags(fromEntity).map((d) => [d[0], d[1], d[4], d[5]])).toEqual([["src/domain/work/notification.mesh.mx", 1, "MESH_UNKNOWN_IMPORT",
      "./other.mesh.mx declares a service: an entity file cannot import a service; call the service from application code"]]);
  });
  test("an aggregate file and a surface file import no service, each in its own words, at the import line", () => {
    const aggregate = build({ ...work(op("return 1")), "src/domain/work/tasks.mesh.mx": 'import { Task } from "./task.mesh.mx"\nimport { Work } from "./work.mesh.mx"\naggregate :Tasks\n  root entity=Task\n' });
    expect(diags(aggregate).map((d) => [d[0], d[1], d[4], d[5]])).toEqual([["src/domain/work/tasks.mesh.mx", 2, "MESH_UNKNOWN_IMPORT",
      "./work.mesh.mx declares a service: an aggregate file cannot import a service; call the service from application code"]]);
    const ADMIN = "src/surfaces/admin/admin.mesh.mx";
    const surface = buildModel({
      ...project({ ...DOMAIN, ...work(op("return 1")) }),
      surfaces: { root: "src/surfaces", files: [{ file: ADMIN, source: 'import { Task } from "../../domain/work/task.mesh.mx"\nimport { Work } from "../../domain/work/work.mesh.mx"\nsurface :admin\n  expose :tasks entity=Task label="Tasks" fields=[:id]\n    action :read\n' }] },
    });
    expect(diags(surface).map((d) => [d[0], d[1], d[4], d[5]])).toEqual([[ADMIN, 2, "MESH_UNKNOWN_IMPORT",
      "../../domain/work/work.mesh.mx declares the service Work, and a surface's lines name entities"]]);
  });
  test("a namespace import of a service file from a service file is one error, at the import", () => {
    const other = { "src/domain/work/other.mesh.mx": `import { Task } from "./task.mesh.mx"\nimport { Claim } from "./claim.mesh.mx"\nservice :Other\n${op("return 1")}` };
    const result = build({ ...work(op("return 1", "    uses entity=o.Other actions=[:go]\n"), `${HEAD}import * as o from "./other.mesh.mx"\n`), ...other });
    expect(diags(result).map((d) => [d[0], d[1], d[4]])).toEqual([[WORK_FILE, 6, "MESH_UNKNOWN_IMPORT"]]);
  });
  test("an entity the file imports twice, named by a uses line, is MESH_DUPLICATE_IMPORT alone", () => {
    const result = build(work(op("return 1"), `${HEAD}import { Task } from "./task.mesh.mx"\n`));
    expect(diags(result).map((d) => [d[1], d[4]])).toEqual([[6, "MESH_DUPLICATE_IMPORT"]]);
  });
  test("on disk: an import of an ignored file is MESH_IGNORED_IMPORT; a .mesh.mx file outside the domain MESH_UNKNOWN_ENTITY", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mesh-services-"));
    try {
      const files = { ...DOMAIN, ...work(op("return 1"), `${HEAD}import { Gone } from "./_wip/gone.mesh.mx"\nimport { Far } from "../../far/far.mesh.mx"\n`) };
      const onDisk = { ...files, "src/domain/work/_wip/gone.mesh.mx": entity("Gone"), "src/far/far.mesh.mx": entity("Far") };
      for (const [file, source] of Object.entries(onDisk)) {
        await mkdir(dirname(join(dir, file)), { recursive: true });
        await writeFile(join(dir, file), source);
      }
      const result = buildModel({
        root: dir, domainRoot: "src/domain",
        files: Object.entries(files).map(([file, source]) => ({ file, source })),
        ignored: [{ file: "src/domain/work/_wip/gone.mesh.mx", pattern: "**/_wip/**" }],
      });
      expect(diags(result).map((d) => [d[1], d[4], d[5]])).toEqual([
        [6, "MESH_IGNORED_IMPORT", `${WORK_FILE} imports ./_wip/gone.mesh.mx, which \`ignore\` in mesh.config.ts excludes (pattern "**/_wip/**"); import a file that is not ignored, or remove the pattern`],
        [7, "MESH_UNKNOWN_ENTITY", "../../far/far.mesh.mx exists but is not under the configured entity directories"],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("a service file's unresolvable import, and a binding its file does not declare", () => {
    const missing = build(work(op("return 1"), `${HEAD}import { Gone } from "./gone.mesh.mx"\n`));
    expect(diags(missing).map((d) => [d[1], d[4], d[5]])).toEqual([[6, "MESH_UNKNOWN_IMPORT", 'Cannot resolve import "./gone.mesh.mx" inside the project']]);
    const misnamed = build(work(op("return 1"), `${HEAD}import { Tsk } from "./task.mesh.mx"\n`));
    expect(diags(misnamed).map((d) => [d[1], d[4], d[5]])).toEqual([[6, "MESH_UNKNOWN_IMPORT", "`Tsk` is not what ./task.mesh.mx declares; it declares `Task`"]]);
  });
});

describe("generateFiles (PR 1 stopgap)", () => {
  test("a project that declares a service is MESH_NOT_IMPLEMENTED at the service line, before any emitter runs", async () => {
    const result = build({ [WORK_FILE]: WORK });
    const config = { root: "/project", output: "/project/.mesh" } as unknown as ResolvedConfig;
    const thrown = await generateFiles({ document: result.document!, config } as Parameters<typeof generateFiles>[0]).then(() => undefined, (cause: unknown) => cause);
    expect((thrown as { diagnostic?: Diagnostic }).diagnostic).toMatchObject({
      code: "MESH_NOT_IMPLEMENTED",
      message: "service :Work is read and checked, but no code is generated for a service yet; generated services are built with the services unit (bead mesh-services)",
      position: { file: WORK_FILE, line: 7, column: 0 },
    });
  });
});

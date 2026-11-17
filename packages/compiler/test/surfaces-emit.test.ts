// The surfaces generator (`notes/architecture/surfaces-design.md`, PR 2, sections 5 "Emit" and 7; ruling D41): one
// manifest per surface at `<output>/surfaces/<name>/index.ts`, its golden, the properties in declaration order, `:all`,
// and the generated tree type-checked with the uses a caller may and may not make of it. The run-time behaviour is
// `packages/data-sqlite/test/surfaces.test.ts`; a project without surfaces keeps its tree (the examples' guards, and the
// path-list test below).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ActionType } from "@meshfw/model";
import type { SurfaceActionKind } from "@meshfw/runtime";
import { buildModel } from "../src/front-end/build.ts";
import { EmitError, generateFiles, writeGeneratedFiles } from "../src/typescript/emit.ts";
import { exposedProperties } from "../src/typescript/views/surfaces.ts";
import { methodSignature } from "../src/typescript/views/actions.ts";
import { effectiveActions, entityInputs } from "../src/typescript/views/inputs.ts";
import { freeGlobals } from "./free-globals.ts";
import { closeTypeServer } from "./type-server.ts";
import { checkTypes, configOf } from "./generated.ts";

type Files = Record<string, string>;
const TSCONFIG = { noEmit: true, strict: true, module: "esnext", moduleResolution: "bundler", target: "es2022", skipLibCheck: true, allowImportingTsExtensions: true, types: [] };
const open = "  policies\n    policy :anyone\n      authorize-if=() => true\n";
/**
 * Task: every kind of member `fields=` may name or must refuse, a write that loads, a write whose load sits under a
 * `when` (its member may be absent: `$Partial`/`$Pick`), a destroy and the auto read.
 */
const TASK = `import { User } from "../people/user.mesh.mx"
import { Step } from "./step.mesh.mx"

entity :Task table="tasks"
  attributes
    uuid :id primary-key
    string :title min=1
    enum :state values=[:open, :done] default=:open
    string :notes nullable
  relationships
    belongs-to :owner entity=User nullable
    has-many :steps entity=Step
  computed
    string :summary() { return &title + "!" }
    count :stepCount of=&steps
  actions auto=[:read, :destroy]
    update :complete
      do
        set
          &state=:done
        load=[&summary, &steps]
    update :touch
      do
        when=() => true
          load=[&summary]
${open}`;
const STEP = `import { Task } from "./task.mesh.mx"
entity :Step table="steps"
  attributes
    uuid :id primary-key
  relationships
    belongs-to :task entity=Task
  actions auto=[:read]
${open}`;
const USER = `entity :User table="users"
  attributes
    uuid :id primary-key
    string :name
  actions auto=[:read]
${open}`;
/** A second entity named Task, in another module and with no relationship or computed field: its read takes no `load`. */
const OTHER = `entity :Task table="other_tasks"
  attributes
    uuid :id primary-key
    string :label nullable
  actions auto=[:read, :create]
  events
    event :LabelSet
      uuid :taskId
${open}`;
const DOMAIN: Files = {
  "src/domain/work/task.mesh.mx": TASK,
  "src/domain/work/step.mesh.mx": STEP,
  "src/domain/people/user.mesh.mx": USER,
  "src/domain/other/task.mesh.mx": OTHER,
  "src/domain/work/task-completed.mesh.mx": "event :TaskCompleted\n  uuid :taskId\n",
};
const ADMIN_FILE = "src/surfaces/admin/admin.mesh.mx";
const ADMIN = `import { Task } from "../../domain/work/task.mesh.mx"
import { Step } from "../../domain/work/step.mesh.mx"
import * as other from "../../domain/other/task.mesh.mx"
import { TaskCompleted } from "../../domain/work/task-completed.mesh.mx"

surface :admin
  expose :tasks entity=Task label="Tasks" fields=[:summary, :title, :owner, :id]
    action :read
    action :complete
    action :touch
    action :destroy
  expose :others entity=other.Task fields=:all
    action :read
    action :create
  expose :steps entity=Step
  publishes
    TaskCompleted
    other.LabelSet
`;
const documentOf = (surfaces: Files | undefined, domain: Files = DOMAIN) => {
  const built = buildModel({
    root: "/project",
    domainRoot: "src/domain",
    files: Object.entries(domain).map(([file, source]) => ({ file, source })),
    ...(surfaces ? { surfaces: { root: "src/surfaces", files: Object.entries(surfaces).map(([file, source]) => ({ file, source })) } } : {}),
  });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return built.document!;
};
const generate = (surfaces: Files | undefined, domain?: Files) => generateFiles({ document: documentOf(surfaces, domain), config: configOf("/project", ".mesh") });
const disposers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const dispose of disposers) await dispose();
  await closeTypeServer();
});

describe("the surfaces generator", () => {
  const generated = generate({ [ADMIN_FILE]: ADMIN });
  const manifest = async () => (await generated).find((file) => file.path === ".mesh/surfaces/admin/index.ts")!.contents;

  test("the path list gains exactly the manifest; a project without surfaces gets none", async () => {
    const without = (await generate(undefined)).map((file) => file.path);
    const paths = (await generated).map((file) => file.path);
    expect(paths.filter((path) => !without.includes(path))).toEqual([".mesh/surfaces/admin/index.ts"]);
    expect(without.filter((path) => !paths.includes(path))).toEqual([]);
    expect(without.some((path) => path.includes("surfaces"))).toBe(false);
  });

  test("publishes holds the listed events' FQNs in written order (an inline event by its own FQN)", async () => {
    expect(await manifest()).toContain('  publishes: ["work.TaskCompleted", "other.LabelSet"],\n');
  });
  test("the manifest: golden", async () => {
    const path = resolve(import.meta.dir, "fixtures/surfaces-golden/admin.index.ts.golden");
    const actual = await manifest();
    if (process.env.MESH_UPDATE_GOLDEN === "1") await writeFile(path, actual);
    expect(actual).toBe(await readFile(path, "utf8"));
  });
});

describe("the generated manifest type-checks", () => {
  test("a listed field is read, an unlisted one, an unlisted action, an unlisted filter or sort key and a relationship load are type errors", async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../.scratch-mesh-surfaces-"));
    disposers.push(() => rm(root, { recursive: true, force: true }));
    const config = configOf(root);
    const files = await generateFiles({ document: documentOf({ [ADMIN_FILE]: ADMIN }), config });
    await writeGeneratedFiles(files, config);
    await writeFile(resolve(root, "generated/schema.ts"), "export const tables: any = {};\n");
    await writeFile(resolve(root, "mesh.config.ts"), "export default { data: { kind: \"data-adapter\", name: \"memory\", build: \"./none\", options: {} } };\n");
    await writeFile(resolve(root, "use.ts"), [
      'import type { Surface } from "@meshfw/runtime";',
      'import { surface } from "./generated/surfaces/admin/index";',
      "const generic: Surface = surface;",
      "export async function use() {",
      "  const [task] = await surface.expose.tasks.actions.read.run({ filter: { and: [{ title: { eq: \"a\" } }, { ownerId: { nil: true } }] }, sort: [\"-title\"] });",
      "  const title: string | undefined = task?.title;",
      "  // @ts-expect-error `notes` is not listed",
      "  void task?.notes;",
      "  // @ts-expect-error a projected record is read-only",
      "  if (task) task.title = \"x\";",
      "  const [loaded] = await surface.expose.tasks.actions.read.run({ load: [\"summary\"] });",
      "  const summary: string | undefined = loaded?.summary;",
      "  // @ts-expect-error `steps` is a relationship: it cannot be loaded through the surface",
      "  await surface.expose.tasks.actions.read.run({ load: [\"steps\"] });",
      "  // @ts-expect-error `stepCount` is a computed field the line does not list",
      "  await surface.expose.tasks.actions.read.run({ load: [\"stepCount\"] });",
      "  // @ts-expect-error a filter by an unlisted field",
      "  await surface.expose.tasks.actions.read.run({ filter: { notes: { eq: \"x\" } } });",
      "  // @ts-expect-error not inside `or` either",
      "  await surface.expose.tasks.actions.read.run({ filter: { or: [{ state: { eq: \"open\" } }] } });",
      "  // @ts-expect-error a sort by an unlisted field",
      "  await surface.expose.tasks.actions.read.run({ sort: [\"-notes\"] });",
      "  const done = await surface.expose.tasks.actions.complete.run({ id: \"x\" });",
      "  const kept: string = done.summary;",
      "  // @ts-expect-error a loaded relationship does not leave",
      "  void done.steps;",
      "  const touched = await surface.expose.tasks.actions.touch.run({ id: \"x\" });",
      "  const maybe: string | undefined = touched.summary;",
      "  // A member loaded under a `when` stays optional: a projection without it is the action's result.",
      "  const bare: Awaited<ReturnType<typeof surface.expose.tasks.actions.touch.run>> = { id: \"x\", title: \"t\", ownerId: null };",
      "  const nothing: void = await surface.expose.tasks.actions.destroy.run({ id: \"x\" });",
      "  // @ts-expect-error `create` is not listed for tasks",
      "  void surface.expose.tasks.actions.create;",
      "  const made = await surface.expose.others.actions.create.run({});",
      "  const label: string | null = made.label;",
      "  // @ts-expect-error steps lists no action",
      "  void surface.expose.steps.actions.read;",
      "  const names: readonly string[] = surface.publishes;",
      "  // @ts-expect-error the manifest is read-only",
      "  surface.expose.tasks.label = \"x\";",
      "  return [generic, title, summary, kept, maybe, bare, nothing, label, names];",
      "}",
      "",
    ].join("\n"));
    const checked = await checkTypes(root, [...files.map((file) => resolve(root, file.path)), resolve(root, "mesh.config.ts"), resolve(root, "use.ts")]);
    expect(checked).toEqual({ code: 0, output: "" });
    // Design section 8: the manifest, like every generated file, reads no global by its own name (`$Omit`, `$Promise`,
    // `$Partial`, `$Pick` come from `$globals.ts`).
    await writeFile(resolve(root, "tsconfig.json"), JSON.stringify({ compilerOptions: TSCONFIG, include: ["generated/**/*.ts"] }));
    const generatedFiles = files.filter((file) => file.path.endsWith(".ts")).map((file) => resolve(root, file.path));
    expect(generatedFiles).toContain(resolve(root, "generated/surfaces/admin/index.ts"));
    expect(await freeGlobals(resolve(root, "tsconfig.json"), generatedFiles)).toEqual([]);
  }, 30_000);
});

describe("what the manifest lists", () => {
  const document = documentOf({ [ADMIN_FILE]: ADMIN });
  const task = document.entities.find((entity) => entity.fqn === "work.Task")!;

  test("the properties follow the entity's declaration order, whatever order fields= is written in", () => {
    expect(exposedProperties(task, ["summary", "title", "owner", "id"])).toEqual({ properties: ["id", "title", "ownerId", "summary"], computed: ["summary"] });
    expect(exposedProperties(task, ["id", "owner", "title", "summary"])).toEqual(exposedProperties(task, ["summary", "title", "owner", "id"]));
  });
  test(":all is every attribute, then every belongs-to's key column, then every computed field, function and rollup alike", () => {
    expect(exposedProperties(task, "all")).toEqual({ properties: ["id", "title", "state", "notes", "ownerId", "summary", "stepCount"], computed: ["summary", "stepCount"] });
  });
  test("no fields= lets nothing leave", () => {
    expect(exposedProperties(task, [])).toEqual({ properties: [], computed: [] });
  });
  test("methodSignature gives the entity value's own types: the surface wraps them", () => {
    const actions = effectiveActions(task);
    const inputs = entityInputs(task, document);
    const signature = (name: string) => {
      const at = actions.findIndex((action) => action.name === name);
      return methodSignature(task, actions[at]!, inputs[at]!);
    };
    expect(signature("complete")).toEqual({ inputType: "CompleteTaskInput", generics: "", returnType: 'TaskWith<"summary" | "steps">', typeNames: ["CompleteTaskInput", "TaskWith"], globals: [] });
    expect(signature("destroy")).toEqual({ inputType: "DestroyTaskInput", generics: "", returnType: "void", typeNames: ["DestroyTaskInput"], globals: [] });
    expect(signature("read").returnType).toBe("(L extends unknown ? TaskWith<TaskLoadNames<L>>[] : never)");
  });
  test("the runtime's action kinds are the model's", () => {
    type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    const same: Same<ActionType, SurfaceActionKind> = true;
    expect(same).toBe(true);
  });
});

describe("refusals", () => {
  test("two surfaces whose names differ only in letter case are MESH_EMIT_PATH at the later one", async () => {
    const lower = "surface :admin\n";
    const upper = "surface :Admin\n";
    const error = await generate({ [ADMIN_FILE]: lower, "src/surfaces/Admin/admin.mesh.mx": upper }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EmitError);
    expect((error as EmitError).diagnostic).toMatchObject({
      code: "MESH_EMIT_PATH",
      message: "Generated path collision: .mesh/surfaces/Admin/index.ts and .mesh/surfaces/admin/index.ts differ only in letter case",
      position: { file: "src/surfaces/Admin/admin.mesh.mx", line: 1, column: 0 },
      fix: "Rename one of the two surfaces so that they differ in more than letter case",
    });
  });
  test("legal neighbours: a surface with no expose line, and an expose line with no action and no fields=", async () => {
    const files = await generate({ [ADMIN_FILE]: "surface :admin\n", "src/surfaces/quiet/quiet.mesh.mx": 'import { Step } from "../../domain/work/step.mesh.mx"\nsurface :quiet\n  expose :steps entity=Step\n' });
    const empty = files.find((file) => file.path === ".mesh/surfaces/admin/index.ts")!.contents;
    expect(empty).toContain("expose: {},");
    expect(empty).toContain("publishes: [],");
    expect(empty).toContain('import { defineSurface as $defineSurface } from "@meshfw/runtime";');
    expect(empty).not.toContain("$globals");
    const quiet = files.find((file) => file.path === ".mesh/surfaces/quiet/index.ts")!.contents;
    expect(quiet).toContain("const $0$fields = [] as const;");
    expect(quiet).not.toContain("domain/work/step");
  });
});

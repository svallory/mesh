// What is generated from a service (`notes/architecture/services-design.md`, PR 3, sections 5.1 step 5, 7 and 8; ruling
// D42): `<service>.service.ts` (the value, its bodies and policies) and `<service>.inputs.ts` (each operation's input
// type and schema) beside the module's entity files, the module barrel's exports and the name claims, a service-only
// folder's barrel, and the generated tree type-checked with the uses a caller may and may not make of it. How an
// operation runs is `packages/runtime/test/service.test.ts` (hand-written values) and, generated and run against SQLite,
// `packages/data-sqlite/test/services.test.ts`.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Glob } from "bun";
import { buildModel } from "../src/front-end/build.ts";
import { EmitError, generateFiles, writeGeneratedFiles } from "../src/typescript/emit.ts";
import { freeGlobals } from "./free-globals.ts";
import { closeTypeServer } from "./type-server.ts";
import { checkTypes, configOf } from "./generated.ts";

type Files = Record<string, string>;
const FIXTURE = resolve(import.meta.dir, "fixtures/services");
const GOLDEN = resolve(import.meta.dir, "fixtures/services-golden");
/** The fixture's Mesh files, by project-relative path. */
const fixtureFiles = async (): Promise<Files> => {
  const files: Files = {};
  for await (const file of new Glob("src/domain/**/*.mesh.mx").scan({ cwd: FIXTURE })) files[file] = await readFile(join(FIXTURE, file), "utf8");
  return files;
};
const documentOf = (root: string, files: Files) => {
  const built = buildModel({ root, domainRoot: "src/domain", files: Object.entries(files).map(([file, source]) => ({ file, source })) });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return built.document!;
};
const generate = async (files: Files, root = FIXTURE) => generateFiles({ document: documentOf(root, files), config: configOf(root, ".mesh") });
const rejection = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a rejection"); }, (error: unknown) => error);
const disposers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const dispose of disposers) await dispose();
  await closeTypeServer();
});

const OPEN = "  policies\n    policy :everyone\n      authorize-if=() => true\n";
const TASK = `entity :Task table="tasks"\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n    update :close\n${OPEN}`;
const RUN = `entity :Run table="runs"\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n${OPEN}`;
/** A service of two entities, `name` and the operations' lines given. */
const service = (name: string, operations: string) => `import { Task } from "./task.mesh.mx"\nimport { Run } from "./run.mesh.mx"\n\nservice :${name}\n${operations}${OPEN}`;
const operation = (name: string) => `  operation :${name}\n    uses entity=Task actions=[:read]\n    uses entity=Run actions=[:read]\n    run() {\n      return 1\n    }\n`;
const small = (files: Files) => ({ "src/domain/work/task.mesh.mx": TASK, "src/domain/work/run.mesh.mx": RUN, ...files });

describe("the services generator", () => {
  test("each service gets its two files beside its module's entity files, and nothing else changes in the path list", async () => {
    const files = await fixtureFiles();
    const paths = (await generate(files)).map((file) => file.path);
    const without = Object.fromEntries(Object.entries(files).filter(([file]) => !file.endsWith("work/work.mesh.mx") && !file.includes("orchestration")));
    const before = (await generate(without)).map((file) => file.path);
    expect(paths.filter((path) => !before.includes(path))).toEqual([
      ".mesh/domain/orchestration/billing.inputs.ts",
      ".mesh/domain/orchestration/billing.service.ts",
      ".mesh/domain/orchestration/index.ts",
      ".mesh/domain/work/work.inputs.ts",
      ".mesh/domain/work/work.service.ts",
    ]);
    expect(before.filter((path) => !paths.includes(path))).toEqual([]);
  });

  test("the service file and the inputs file: golden", async () => {
    const generated = await generate(await fixtureFiles());
    for (const name of ["work.service.ts", "work.inputs.ts"]) {
      const actual = generated.find((file) => file.path === `.mesh/domain/work/${name}`)!.contents;
      const path = join(GOLDEN, `${name}.golden`);
      if (process.env.MESH_UPDATE_GOLDEN === "1") await writeFile(path, actual);
      expect(actual).toBe(await readFile(path, "utf8"));
    }
  });

  test("the service file declares nothing at module level a helper could be named: the value is exported under its name by `export { ... as }`", async () => {
    const generated = await generate(await fixtureFiles());
    const billing = generated.find((file) => file.path === ".mesh/domain/orchestration/billing.service.ts")!.contents;
    expect(billing).toContain('import { Billing, type CloseBillingInput, z } from "../../../src/domain/orchestration/notes.ts";');
    expect(billing).toContain("export { $orchestration$Billing$service as Billing };");
    expect(billing).not.toMatch(/^(const|let|type|function|class) [^$]/m);
  });

  test("the barrel exports the value from the service file and the input types from the inputs file; a service-only folder gets a barrel and its parent a namespace", async () => {
    const generated = await generate(await fixtureFiles());
    const barrel = (path: string) => generated.find((file) => file.path === path)!.contents;
    expect(barrel(".mesh/domain/work/index.ts")).toContain('export { Work } from "./work.service";\nexport type {\n  HandOverWorkInput,\n  NotifyWorkInput,\n  CancelRunWorkInput,\n  FinishWorkInput,\n} from "./work.inputs";');
    expect(barrel(".mesh/domain/orchestration/index.ts")).toContain('export { Billing } from "./billing.service";\nexport type { CloseBillingInput } from "./billing.inputs";');
    expect(barrel(".mesh/domain/orchestration/index.ts")).toContain('from the entity files of module "orchestration"');
    expect(barrel(".mesh/domain/index.ts")).toContain('export * as orchestration from "./orchestration/index";');
    expect(barrel(".mesh/index.ts")).toContain('//   "#mesh/domain/orchestration"');
  });

  test("a project without a service: no service file, and a barrel with no services comment", async () => {
    const generated = await generate(small({}), "/project");
    expect(generated.some((file) => file.path.endsWith(".service.ts") || file.path.endsWith(".inputs.ts"))).toBe(false);
    expect(generated.find((file) => file.path === ".mesh/domain/work/index.ts")!.contents).not.toContain("services");
  });

  test("an operation that declares no input takes `{}`: an empty strict object", async () => {
    const generated = await generate(small({ "src/domain/work/work.mesh.mx": service("Work", operation("tidy")) }), "/project");
    const inputs = generated.find((file) => file.path === ".mesh/domain/work/work.inputs.ts")!.contents;
    expect(inputs).toContain("export type TidyWorkInput = {\n  [key: string]: never;\n};");
    expect(inputs).toContain("export const tidyWorkInputSchema = z.strictObject({}) satisfies z.ZodType<TidyWorkInput>;");
  });

  test("a policy of one operation reads that operation's input; one of several their shared input; an operation no policy covers gets `policies: []`", async () => {
    const source = service("Work", operation("one") + operation("two")).replace(OPEN, "  policies\n    policy :first actions=[&one]\n      authorize-if=({ input }) => input != null\n");
    const generated = await generate(small({ "src/domain/work/work.mesh.mx": source }), "/project");
    const file = generated.find((f) => f.path === ".mesh/domain/work/work.service.ts")!.contents;
    expect(file).toContain('"policy.first.authorize-if.0": ($s: $work$Work$ServiceScope<$work$Work$OneWorkInput>)');
    expect(file).not.toContain("SharedInput");
    expect(file).toMatch(/two: \{\s+schema: \$work\$Work\$twoWorkInputSchema,\s+policies: \[\],/);
  });
});

describe("names", () => {
  const thrown = async (files: Files) => {
    const error = await rejection(generate(small(files), "/project"));
    expect(error).toBeInstanceOf(EmitError);
    return (error as EmitError).diagnostic;
  };
  test("a service named like an entity of its module is MESH_EMIT_NAME from the barrel, not a path clash", async () => {
    expect(await thrown({ "src/domain/work/task-service.mesh.mx": service("Task", operation("go")).replace('import { Task } from "./task.mesh.mx"', 'import { Task as T } from "./task.mesh.mx"').replace("entity=Task", "entity=T") })).toMatchObject({
      code: "MESH_EMIT_NAME",
      message: "entity work.Task and service work.Task would both be exported as Task from #mesh/domain/work",
      position: { file: "src/domain/work/task-service.mesh.mx", line: 4, column: 0 },
    });
  });
  test("an input type spelled like an entity's input type is MESH_EMIT_NAME naming both", async () => {
    // Task's `closeRun` gives CloseRunTaskInput, and so does `close` of a service named RunTask.
    const task = TASK.replace("update :close", "update :closeRun");
    expect(await thrown({ "src/domain/work/task.mesh.mx": task, "src/domain/work/run-task.mesh.mx": service("RunTask", operation("close")) })).toMatchObject({
      code: "MESH_EMIT_NAME",
      message: "the type CloseRunTaskInput of entity work.Task and the type CloseRunTaskInput of service work.RunTask would both be exported as CloseRunTaskInput from #mesh/domain/work",
      position: { file: "src/domain/work/run-task.mesh.mx", line: 4, column: 0 },
    });
  });
  test("two operations whose input types would be spelled alike are MESH_EMIT_NAME naming both", async () => {
    expect(await thrown({ "src/domain/work/work.mesh.mx": service("Work", operation("fooBar") + operation("foo_bar")) })).toMatchObject({
      code: "MESH_EMIT_NAME",
      message: "Service work.Work would generate the type FooBarWorkInput twice: for :fooBar and for :foo_bar",
      position: { file: "src/domain/work/work.mesh.mx", line: 11, column: 2 },
      fix: "Rename one of the two operations",
    });
  });
  test("legal neighbours: one service name in two modules, and an operation named like an entity's action", async () => {
    const other = { "src/domain/other/task.mesh.mx": TASK, "src/domain/other/run.mesh.mx": RUN, "src/domain/other/work.mesh.mx": service("Work", operation("close")) };
    const generated = await generate(small({ "src/domain/work/work.mesh.mx": service("Work", operation("close")), ...other }), "/project");
    expect(generated.filter((file) => file.path.endsWith("work.service.ts")).map((file) => file.path)).toEqual([".mesh/domain/other/work.service.ts", ".mesh/domain/work/work.service.ts"]);
  });
});

describe("the generated service type-checks", () => {
  const use = [
    'import { Work, type HandOverWorkInput, type FinishWorkInput } from "./.mesh/domain/work/index";',
    'import { Billing } from "./.mesh/domain/orchestration/index";',
    'import type { Task } from "./.mesh/domain/work/index";',
    "export async function use(context: { actor: { id: string } }) {",
    "  const moved: Task = await Work.handOver({ task: \"t\", to: \"u\" }, context);",
    "  const withReason: HandOverWorkInput = { task: \"t\", to: \"u\", reason: null };",
    "  // @ts-expect-error `to` is required",
    "  await Work.handOver({ task: \"t\" }, context);",
    "  // @ts-expect-error no such field",
    "  await Work.handOver({ task: \"t\", to: \"u\", extra: 1 }, context);",
    "  const finished = await Work.finish({ task: \"t\" } satisfies FinishWorkInput, context);",
    "  const title: string = finished.done.title;",
    "  const by: string = finished.by;",
    "  const run = await Billing.close({}, context);",
    "  // @ts-expect-error the value is frozen and read-only",
    "  Work.handOver = Work.handOver;",
    "  return [moved, withReason, title, by, run];",
    "}",
    "",
  ].join("\n");

  /** The fixture written to a scratch project and generated there, with `context.ts` declaring an actor when `actor` is set. */
  const project = async (actor: boolean) => {
    const root = await mkdtemp(resolve(import.meta.dir, "../.scratch-mesh-services-"));
    disposers.push(() => rm(root, { recursive: true, force: true }));
    const sources = await fixtureFiles();
    for (const [file, source] of Object.entries(sources)) await Bun.write(join(root, file), source);
    for (const helper of ["src/domain/work/labels.ts", "src/domain/orchestration/notes.ts"]) await Bun.write(join(root, helper), await readFile(join(FIXTURE, helper), "utf8"));
    const config = configOf(root, ".mesh");
    const files = await generateFiles({ document: documentOf(root, sources), config });
    await writeGeneratedFiles(files, config);
    await writeFile(join(root, ".mesh/schema.ts"), "export const tables: any = {};\n");
    await writeFile(join(root, "mesh.config.ts"), "export default { data: { kind: \"data-adapter\", name: \"memory\", build: \"./none\", options: {} } };\n");
    if (actor) await writeFile(join(root, "context.ts"), 'import "@meshfw/runtime";\ndeclare module "@meshfw/runtime" {\n  interface ActionContext {\n    actor: { id: string };\n  }\n}\n');
    const generated = files.filter((file) => file.path.endsWith(".ts")).map((file) => join(root, file.path));
    return { root, generated, checked: [...generated, join(root, "mesh.config.ts"), ...(actor ? [join(root, "context.ts")] : [])] };
  };

  test("with a declared actor: the method's result is the body's, the input type has the declared fields, a wrong input fails; no free global", async () => {
    const { root, generated, checked } = await project(true);
    await writeFile(join(root, "use.ts"), use);
    expect(await checkTypes(root, [...checked, join(root, "use.ts")])).toEqual({ code: 0, output: "" });
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true, strict: true, module: "esnext", moduleResolution: "bundler", target: "es2022", skipLibCheck: true, allowImportingTsExtensions: true, types: [] }, include: [".mesh/**/*.ts"] }));
    expect(await freeGlobals(join(root, "tsconfig.json"), generated)).toEqual([]);
  }, 60_000);

  test("without a declared actor, a body that reads `actor.id` fails tsc in the service file, as an entity's function does", async () => {
    const { root, checked } = await project(false);
    const result = await checkTypes(root, checked);
    expect(result.code).not.toBe(0);
    expect(result.output.split("\n").filter(Boolean)).toEqual([expect.stringMatching(/^\.mesh\/domain\/work\/work\.service\.ts\(\d+,\d+\): error TS18048: 'actor' is possibly 'undefined'\.$/)]);
  }, 60_000);

  // Design section 8's edge cases: a service in the domain root module, and operations named like a reserved word or an
  // `Object.prototype` member. Such a key once took its contextual type from Object, so the policy kinds widened to string.
  test("a service in the domain root module with operations `toString`, `constructor` and `delete`: the root barrel exports it, and each method has its body's result", async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../.scratch-mesh-services-root-"));
    disposers.push(() => rm(root, { recursive: true, force: true }));
    const body = (name: string, result: string) => `  operation :${name}\n    uses entity=Task actions=[:read]\n    run() {\n      return ${result}\n    }\n`;
    const sources: Files = {
      "src/domain/task.mesh.mx": TASK,
      "src/domain/ops.mesh.mx": `import { Task } from "./task.mesh.mx"\n\nservice :Ops\n${body("toString", "1")}${body("constructor", '"made"')}${body("delete", "true")}${OPEN}`,
    };
    for (const [file, source] of Object.entries(sources)) await Bun.write(join(root, file), source);
    const config = configOf(root, ".mesh");
    const files = await generateFiles({ document: documentOf(root, sources), config });
    await writeGeneratedFiles(files, config);
    await writeFile(join(root, ".mesh/schema.ts"), "export const tables: any = {};\n");
    await writeFile(join(root, "mesh.config.ts"), "export default { data: { kind: \"data-adapter\", name: \"memory\", build: \"./none\", options: {} } };\n");
    expect(files.find((file) => file.path === ".mesh/domain/index.ts")!.contents).toContain('export { Ops } from "./ops.service";');
    await writeFile(join(root, "use.ts"), [
      'import { Ops } from "./.mesh/domain/index";',
      "export async function use() {",
      "  const n: number = await Ops.toString({});",
      "  const s: string = await Ops.constructor({});",
      "  const b: boolean = await Ops.delete({});",
      "  // @ts-expect-error the result is the body's",
      "  const wrong: string = await Ops.toString({});",
      "  return [n, s, b, wrong];",
      "}",
      "",
    ].join("\n"));
    const generated = files.filter((file) => file.path.endsWith(".ts")).map((file) => join(root, file.path));
    expect(await checkTypes(root, [...generated, join(root, "mesh.config.ts"), join(root, "use.ts")])).toEqual({ code: 0, output: "" });
  }, 60_000);
});

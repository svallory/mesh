import { describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelDocument } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";
import type { ResolvedConfig } from "../src/config.ts";
import { EMITTERS, GENERATORS, renderGenerator, type EmitInput, type Generator } from "../src/typescript/emit.ts";
import { EmitError } from "../src/typescript/emit-error.ts";
import { typesGenerator } from "../src/typescript/emitters/types.ts";
import { MESH_TEMPLATES_DIR, loadTemplates, type Templates } from "../src/typescript/templates.ts";
import { project } from "./v4.ts";

const repo = resolve(import.meta.dir, "../../..");
const config: ResolvedConfig = {
  root: "/project",
  configFile: "/project/mesh.config.ts",
  entityFiles: [],
  domainRoot: "/project",
  data: { kind: "data-adapter", name: "sqlite", build: "@meshfw/data-sqlite/build", capabilities: { adapter: "sqlite", capabilities: [] }, options: { file: ":memory:" } },
  output: "/project/generated",
};
function inputOf(): EmitInput {
  const built = buildModel(project());
  expect(built.diagnostics).toEqual([]);
  return { document: built.document as ModelDocument, config };
}
const only = (path: string, contents: string): Templates => new Map([["types.ts.jig", { path, contents }]]);
async function renderError(contents: string): Promise<EmitError> {
  try { await renderGenerator(typesGenerator, inputOf(), only(".mesh-generators/types.ts.jig", contents)); }
  catch (cause) { if (cause instanceof EmitError) return cause; throw cause; }
  throw new Error("expected a render error");
}

describe("generators", () => {
  test("the core build is model.json plus the types, validators, expressions, actions and index generators, each with its template", async () => {
    expect(EMITTERS.map((entry) => entry.name)).toEqual(["model-json", "types", "validators", "expressions", "load", "actions", "index"]);
    expect(GENERATORS.map((generator) => [generator.name, generator.template])).toEqual([
      ["types", "types.ts.jig"],
      ["validators", "validators.ts.jig"],
      ["expressions", "expressions.ts.jig"],
      ["load", "load.ts.jig"],
      ["actions", "actions.ts.jig"],
      ["index", "index.ts.jig"],
    ]);
    expect((await readdir(MESH_TEMPLATES_DIR)).sort()).toEqual(["actions.ts.jig", "expressions.ts.jig", "index.ts.jig", "load.ts.jig", "types.ts.jig", "validators.ts.jig"]);
    expect(MESH_TEMPLATES_DIR).toBe(resolve(import.meta.dir, "../src/typescript/templates"));
    const manifest = JSON.parse(await readFile(resolve(import.meta.dir, "../package.json"), "utf8")) as { files: string[] };
    expect(manifest.files).toContain("src");
  });

  test("a generator renders one formatted file per view, at the view's path", async () => {
    const input = inputOf();
    const files = await renderGenerator(typesGenerator, input, await loadTemplates(GENERATORS, "/project"));
    expect(files.map((file) => file.path)).toEqual(typesGenerator.views(input).map((view) => view.path));
    expect(files[0]!.contents.endsWith(";\n")).toBe(true);
  });

  test("a generator whose template is missing from the set is a Mesh bug, not a silent skip", async () => {
    const generator: Generator = { ...typesGenerator, template: "absent.ts.jig" };
    await expect(renderGenerator(generator, inputOf(), await loadTemplates(GENERATORS, "/project"))).rejects.toThrow(
      'No template "absent.ts.jig" for generator "types"',
    );
  });
});

describe("MESH_TEMPLATE_RENDER", () => {
  test("negative: a valid template renders without a diagnostic", async () => {
    const files = await renderGenerator(typesGenerator, inputOf(), only(".mesh-generators/types.ts.jig", "export type {{ record.name }} = {};\n"));
    expect(files.map((file) => file.contents)).toEqual(["export type List = {};\n", "export type Todo = {};\n"]);
  });

  test("a syntax error is positioned on the template file at Jig's line and column, naming the generator", async () => {
    const error = await renderError("// first line\n  @if(\n");
    expect(error.diagnostic).toEqual({
      severity: "error",
      code: "MESH_TEMPLATE_RENDER",
      message: 'Generator "types" cannot render .mesh-generators/types.ts.jig: Missing token ")"',
      position: { file: ".mesh-generators/types.ts.jig", line: 2, column: 6, offset: 0 },
      fix: "Fix the template; it receives the view documented for this generator",
    });
  });

  test("an unknown view field read at render time is positioned on its line", async () => {
    // Jig reports no column for an error raised while rendering, only the line: the
    // expression is indented so that a real column would not read as 0.
    const error = await renderError("a\nb\n  x {{ record.missing.name }}\n");
    expect(error.diagnostic.code).toBe("MESH_TEMPLATE_RENDER");
    expect(error.diagnostic.position).toEqual({ file: ".mesh-generators/types.ts.jig", line: 3, column: 0, offset: 0 });
    expect(error.diagnostic.message).toStartWith('Generator "types" cannot render .mesh-generators/types.ts.jig: ');
  });
});

test("output the formatter rejects is positioned on the template, naming the generator and the file", async () => {
  const error = await renderError("const = ;\n");
  expect(error.diagnostic.code).toBe("MESH_TEMPLATE_RENDER");
  expect(error.diagnostic.position).toEqual({ file: ".mesh-generators/types.ts.jig", line: 1, column: 0, offset: 0 });
  expect(error.diagnostic.message).toStartWith(
    'Generator "types" cannot render .mesh-generators/types.ts.jig: rendered output for generated/todo/list.types.ts is not valid TypeScript: ',
  );
  expect(error.diagnostic.fix).toBe("Fix the template so that it prints valid TypeScript");
});

describe("templates only render", () => {
  // Acceptance 5 is reviewed; this pins the part that can be checked: a template
  // uses only `@if`, `@else`, `@each` and `@end`, and prints only view fields.
  test("tags are @if/@else/@each/@end on view fields; mustaches print a view field path", async () => {
    for (const name of await readdir(MESH_TEMPLATES_DIR)) {
      const text = await readFile(join(MESH_TEMPLATES_DIR, name), "utf8");
      for (const line of text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("@")))
        expect(line).toMatch(/^@(?:end|else|if\([a-z][A-Za-z.]*\)|each\([a-z]+ in [a-z][A-Za-z.]*\))~?$/);
      for (const [, expression] of text.matchAll(/\{\{(.*?)\}\}/g))
        expect(expression!.trim()).toMatch(/^[a-z][A-Za-z]*(?:\.[a-z][A-Za-z]*)*$/);
    }
  });
});

describe("acceptance 6: Jig stays in the compiler", () => {
  test("runtime, model, the CLI and the generated example never mention @jig-lang", async () => {
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && (await readFile(path, "utf8")).includes("@jig-lang")) offenders.push(path);
      }
    };
    for (const dir of ["packages/runtime", "packages/model", "packages/cli", "examples/blog/.mesh"]) {
      // A missing root would pass vacuously: each must be a directory that is walked.
      expect((await stat(join(repo, dir))).isDirectory()).toBe(true);
      await walk(join(repo, dir));
    }
    expect(offenders).toEqual([]);
  });

  test("the compiler imports Jig in src/typescript/render.ts only", async () => {
    const importers: string[] = [];
    for (const name of await readdir(resolve(import.meta.dir, "../src"), { recursive: true })) {
      const path = resolve(import.meta.dir, "../src", String(name));
      if (path.endsWith(".ts") && (await readFile(path, "utf8")).includes('from "@jig-lang/')) importers.push(String(name));
    }
    expect(importers).toEqual(["typescript/render.ts"]);
  });
});

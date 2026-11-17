// `max-limit=N` on the `actions` line (mesh-limit-cap, ruling D38): the contract, the model, the builder's checks, the read's
// generated pre-check and `mesh explain`. The run-time half (`castInput` with a `ReadCap`) is in `packages/runtime/test/compose.test.ts`.
import { describe, expect, test } from "bun:test";
import type { ModelDocument } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";
import { generateFiles } from "../src/typescript/emit.ts";
import { explainAction } from "../src/typescript/explain.ts";
import { actionsView } from "../src/typescript/views/actions.ts";
import { configOf } from "./generated.ts";

const FILE = "todo/todo.mesh.mx";
const entity = (actions: string, rest = "") =>
  `entity :Todo\n  attributes\n    uuid :id primary-key\n    string :title nullable\n${actions}\n${rest}  policies\n    policy :open\n      authorize-if=() => true\n`;
const build = (source: string) => buildModel({ root: "/project", files: [{ file: FILE, source }] });
const problems = (source: string) => build(source).diagnostics.map((d) => [d.code, d.message, d.position.line, d.position.column]);
const documentOf = (source: string): ModelDocument => {
  const built = build(source);
  expect(built.diagnostics).toEqual([]);
  return built.document!;
};
const todoOf = (source: string) => documentOf(source).entities[0]!;
const readOf = (source: string, name = "read") => {
  const document = documentOf(source);
  const view = actionsView({ document, config: configOf("/project") }, document.entities[0]!);
  return view.methods.find((method) => method.name === name)!;
};

describe("the contract", () => {
  // MX's own messages for a value that is no number literal (probe 10 of the design).
  test.each([
    ['max-limit="100"', "`actions`: option `max-limit` must be number, got string"],
    ["max-limit=10 * 10", "`actions`: option `max-limit` must be a literal"],
  ])("%s is MESH_OPTION_VALUE", (option, message) => {
    expect(problems(entity(`  actions auto=[:read] ${option}`))).toEqual([["MESH_OPTION_VALUE", message, 5, 23]]);
  });
});

describe("the model", () => {
  test("max-limit=N is Entity.maxLimit, at the option's name", () => {
    const source = entity("  actions auto=[:create, :read] max-limit=50");
    expect(todoOf(source).maxLimit).toEqual({ max: 50, position: { file: FILE, line: 5, column: 32, offset: source.indexOf("max-limit") } });
  });

  test("without max-limit= the entity has no maxLimit key", () => {
    expect("maxLimit" in todoOf(entity("  actions auto=[:read]"))).toBe(false);
  });

  // Neighbours that stay legal: a written read with no auto, on:load beside the cap, the smallest cap.
  test.each([
    ["auto=[:read] max-limit=100", "", 100],
    ["max-limit=1", "    read :recent\n", 1],
    ["auto=[:read] on:load=&read max-limit=50", "", 50],
    ["auto=[:create] max-limit=7", "    read :recent\n", 7],
  ])("actions %s builds", (options, reads, max) => {
    expect(todoOf(entity(`  actions ${options}\n${reads}`.trimEnd())).maxLimit?.max).toBe(max);
  });

  test.each(["-1", "0", "1.5"])("max-limit=%s is MESH_OPTION_VALUE at the option's name", (value) => {
    expect(problems(entity(`  actions auto=[:read] max-limit=${value}`))).toEqual([
      ["MESH_OPTION_VALUE", "max-limit must be a whole number of at least 1", 5, 23],
    ]);
  });

  test("an entity with no read is MESH_OPTION_VALUE at the option's name", () => {
    expect(problems(entity("  actions auto=[:create] max-limit=50"))).toEqual([
      ["MESH_OPTION_VALUE", "max-limit caps the limit of this entity's reads, and it has none: add :read to auto= or write a read line, or remove max-limit", 5, 25],
    ]);
  });

  test("a value that is refused reports only the value: no second error for the missing read", () => {
    expect(problems(entity("  actions auto=[:create] max-limit=0")).map(([code, message]) => [code, message])).toEqual([
      ["MESH_OPTION_VALUE", "max-limit must be a whole number of at least 1"],
    ]);
  });
});

describe("the generated read", () => {
  const cast = (validator: string) => `const $parsed = await $castInput(layer, ${validator}, input, { max: 50, source: { file: "${FILE}", line: 5, column: 33 } });`;

  test("a caller read of a capped entity passes the cap to $castInput, its source 1-based", () => {
    expect(readOf(entity("  actions auto=[:create, :read] max-limit=50")).preCheck).toContain(cast("readTodoInputSchema"));
  });

  test("an entity with no cap casts as before", () => {
    expect(readOf(entity("  actions auto=[:read]")).preCheck).toContain("const $parsed = await $castInput(layer, readTodoInputSchema, input);");
  });

  test("every read of the entity is capped, a written one with its own filter included", () => {
    const source = entity("  actions auto=[:create, :read] max-limit=50\n    read :titled filter=() => &title !== null");
    expect(readOf(source).preCheck).toContain(cast("readTodoInputSchema"));
    expect(readOf(source, "titled").preCheck).toContain(cast("titledTodoInputSchema"));
  });

  test("the cap is in the read action only: the privileged body, and every write, cast with no cap", async () => {
    const document = documentOf(entity("  actions auto=[:create, :read] max-limit=50"));
    const files = await generateFiles({ document, config: configOf("/project") });
    const actions = files.find((file) => file.path.endsWith("todo.actions.ts"))!.contents;
    // Prettier breaks the long call over lines: compare with whitespace collapsed.
    const casts = actions.match(/\$castInput\([^)]*\)/g)!.map((call) => call.replace(/\s+/g, " ").replace(/, \}/g, " }"));
    expect(casts.filter((call) => call.includes("max: 50"))).toEqual([`$castInput(layer, readTodoInputSchema, input, { max: 50, source: { file: "${FILE}", line: 5, column: 33 } })`]);
    expect(actions).toContain("cast ?? (await $castInput(layer, readTodoInputSchema, input))");
  });
});

describe("mesh explain", () => {
  test("a capped read says the cap in its strategy", () => {
    const document = documentOf(entity("  actions auto=[:read] max-limit=50\n    read :titled filter=() => &title !== null"));
    expect(explainAction(document.entities[0]!, "read")![1]).toBe("  strategy     one query: the caller's filter, sort, limit (at most 50, 50 when none is given) and offset over the table");
    expect(explainAction(document.entities[0]!, "titled", document)![1]).toBe("  strategy     one query: the read's filter and the caller's, the caller's sort, limit (at most 50, 50 when none is given) and offset over the table");
  });

  test("an uncapped read is unchanged", () => {
    const document = documentOf(entity("  actions auto=[:read]"));
    expect(explainAction(document.entities[0]!, "read")![1]).toBe("  strategy     one query: the caller's filter, sort, limit and offset over the table");
  });
});

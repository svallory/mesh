import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { closeTypeServer } from "./type-server.ts";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { scope } from "@meshfw/runtime";
import { buildModel } from "../src/front-end/build.ts";
import { generateFiles, writeGeneratedFiles } from "../src/typescript/emit.ts";
import { checkTypes, configOf } from "./generated.ts";

afterAll(closeTypeServer);

// A plain function with one parameter, whatever its pattern, is called with the scope (`(s) => s.self.n`).
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const entity = (actions: string, computed = "") => `entity :Task
  attributes
    uuid :id primary-key
    integer :n
    string :title nullable
${computed}  actions auto=[:read]
    update :go
      input
        &n
      validate
${actions}`;

async function generated(source: string) {
  const root = await mkdtemp(resolve(import.meta.dir, "../.scratch-mesh-scope-"));
  roots.push(root);
  const built = buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source }] });
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const config = configOf(root);
  await writeGeneratedFiles(await generateFiles({ document: built.document!, config }), config);
  await writeFile(resolve(root, "generated/schema.ts"), "export const tables = {};\n");
  await mkdir(resolve(root, "node_modules"), { recursive: true });
  const { $expressions: expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
  return { root, built, expressions: expressions as Record<string, (s: unknown) => unknown> };
}
const types = async (root: string) => await checkTypes(root, ["generated/domain/task.expressions.ts", "generated/domain/task.types.ts"]);
const sc = (self: object, input: object = {}) => scope({ self, input } as never);

test.each([
  ["a plain name", "(s) => s.self.n > 1"],
  ["an annotated name", "(s: any) => s.self.n > 1"],
  ["a name beside &members", "(s) => s.self.n > 1 && &n > 1"],
  ["an empty pattern", "({}) => true"],
  ["a rest pattern", "({ ...rest }) => rest.self.n > 1"],
  ["a renamed member", "({ self: s }) => s.n > 1"],
])("a check's that, when and details take the scope: %s", async (_, fn) => {
  const holds = fn.includes("true");
  const { root, built, expressions } = await generated(entity(`        check :c [
          that=${fn}
          when=${fn}
          details=(s) => ({ n: s.self.n })
          code="c"
          message="m"
        ]
`));
  expect(await types(root)).toEqual({ code: 0, output: "" });
  const that = expressions["go.check.c.that"]!, when = expressions["go.check.c.when"]!;
  expect(that(sc({ n: 2 }))).toBe(true);
  expect(that(sc({ n: 0 }))).toBe(holds);
  expect(when(sc({ n: 2 }))).toBe(true);
  expect(expressions["go.check.c.details"]!(sc({ n: 2 }))).toEqual({ n: 2 });
});

test("a computed field and a run body with a plain parameter get the scope", async () => {
  const { root, expressions } = await generated(entity("", "").replace("      validate\n", "      do\n        run(s) { if (s.self.n < 0) throw new Error(\"negative\") }\n")
    .replace("  actions auto", "  computed\n    boolean :big(s) { return s.self.n > 1 }\n  actions auto"));
  expect(await types(root)).toEqual({ code: 0, output: "" });
  expect(expressions["computed.big"]!(sc({ n: 2 }))).toBe(true);
  expect(expressions["computed.big"]!(sc({ n: 0 }))).toBe(false);
  const run = Object.entries(expressions).find(([id]) => id.startsWith("go.") && id.includes("run"))![1];
  await expect(Promise.resolve(run(sc({ n: 1 })))).resolves.toBeUndefined();
  await expect(Promise.resolve().then(() => run(sc({ n: -1 })))).rejects.toThrow("negative");
});

test("the parameter has the scope type: a member the scope lacks fails the type check", async () => {
  const { root } = await generated(entity(`        check :c [
          that=(s) => s.self.nope > 0
          code="c"
          message="m"
        ]
`));
  const result = await types(root);
  expect(result.code).toBe(1);
  expect(result.output).toContain("nope");
});

test("`before` read through a plain parameter, and `Mesh.privileged` or an entity call in a computed field with one, are still refused", () => {
  const built = (src: string) => buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source: src }] }).diagnostics.map((d) => d.code);
  expect(built(entity(`        check :c [\n          that=(s) => s.before.n > 0\n          code="c"\n          message="m"\n        ]\n`))).toContain("MESH_VALIDATE_BEFORE");
  expect(built('import { Mesh } from "meshfw"\n' + entity("", "  computed\n    boolean :x(s) { return s.self !== undefined && Mesh.privileged(Task) !== undefined }\n"))).toContain("MESH_COMPUTED_COMPOSES");
  expect(built(entity("", "  computed\n    boolean :x(s) { return s.self !== undefined && Task.read({}) !== undefined }\n"))).toContain("MESH_COMPUTED_COMPOSES");
  // `tx` is no scope name any more: through a plain parameter it is an unknown member, which TypeScript refuses.
  expect(built(entity("", "  computed\n    boolean :x(s) { return s.tx !== undefined }\n"))).not.toContain("MESH_COMPUTED_COMPOSES");
});

// A computed field is worked out on a loaded record, which has no earlier version: `before` exists only in the steps of an
// action. However the body reaches it, the build says so once, as it does for a check (MESH_VALIDATE_BEFORE) and a policy.
describe("a computed field that reads `before` is MESH_COMPUTED_BEFORE", () => {
  const withComputed = (line: string, attributes = "") => `entity :Task
  attributes
    uuid :id primary-key
    integer :n
    string :title nullable
${attributes}  computed
    ${line}
  actions auto=[:read]
    update :go
      input
        &n
      do
        set
          &title=({ before }) => before?.title ?? null
        run ({ before }) { if (before === null) throw new Error("no stored record") }
`;
  const diagnosticsOf = (source: string) => buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source }] }).diagnostics;
  /** Each diagnostic as `[severity, code, the source text it points at]`. */
  const brief = (source: string, length: number) => diagnosticsOf(source).map((d) => [d.severity, d.code, source.slice(d.position.offset, d.position.offset + length)]);
  const MESSAGE = "computed :grew of Task reads `before`, which a computed field does not have: it is worked out on a loaded record, which has no earlier version";
  const FIX = "compute it from `&x`; a rule about the value before a write belongs in a `do` step or a `run`";

  // A translated body is reported by the type pass at the `before` it reads; a plain one, and one that only names it in its
  // parameter, at the function. `at` is the text the one error points at.
  test.each([
    ["translated, read through ?.", "boolean :grew({ before }) { return &n > (before?.n ?? 0) }", "before?.n"],
    // `before.n` is not also a nullable access: the one error is about `before`.
    ["translated, read through .", "boolean :grew({ before }) { return &n > before.n }", "before.n"],
    ["translated, renamed in the parameter", "boolean :grew({ before: was }) { return was !== null }", "was !== null"],
    ["a `value=` arrow", "boolean :grew value=({ before }) => before !== null", "before !== null"],
    ["a plain block body", "boolean :grew({ before }) { const was = before; return was !== null }", "({ before }) { const was"],
    ["a plain block body that reads the root without destructuring it", "boolean :grew() { const was = before; return was !== null }", "() { const was = before"],
    ["only destructured, never read", "boolean :grew({ before }) { return &n > 0 }", "({ before }) { return &n"],
    ["a rest parameter", "boolean :grew({ ...rest }) { return rest.before !== null }", "({ ...rest }) {"],
    ["a plain parameter", "boolean :grew(s) { return s.before !== null }", "(s) { return s.before"],
    ["a rest parameter, read with a string key", 'boolean :grew({ ...rest }) { return rest["before"] !== null }', "({ ...rest }) {"],
    ["a rest parameter, destructured in the body", "boolean :grew({ ...rest }) { const { before } = rest; return before !== null }", "({ ...rest }) {"],
    ["a rest parameter, handed on whole", "boolean :grew({ ...rest }) { return JSON.stringify(rest) !== \"\" }", "({ ...rest }) {"],
    ["a plain parameter, read with a computed key", "boolean :grew(s) { const k = \"before\"; return s[k] !== null }", "(s) { const k"],
  ])("%s: exactly one error, with the message and the fix", (_, line, at) => {
    const source = withComputed(line);
    const diagnostics = diagnosticsOf(source);
    expect(diagnostics.map((d) => [d.severity, d.code, d.message, d.fix])).toEqual([["error", "MESH_COMPUTED_BEFORE", MESSAGE, FIX]]);
    expect(source.slice(diagnostics[0]!.position.offset)).toStartWith(at);
    expect(diagnostics[0]!.position.line).toBe(source.slice(0, diagnostics[0]!.position.offset).split("\n").length);
  });

  test("each `before` a translated body reads is reported, and a root read without destructuring it keeps its plain-code warning", () => {
    expect(brief(withComputed("boolean :grew({ before }) { return before !== null && before?.n === 1 }"), 10))
      .toEqual([["error", "MESH_COMPUTED_BEFORE", "before !=="], ["error", "MESH_COMPUTED_BEFORE", "before?.n "]]);
    // One expression that names `before` without destructuring it is plain code, as in a check: the warning and the error.
    expect(brief(withComputed("boolean :grew() { return before !== null }"), 10).sort())
      .toEqual([["error", "MESH_COMPUTED_BEFORE", "() { retur"], ["warning", "MESH_EXPR_PLAIN", "before !=="]]);
  });

  test("the neighbours stay legal: a step's `before`, a member or a local named `before`, and a check keeps its own code", () => {
    // The fixture's `set` value and `run` both read `before`: a step has it.
    expect(diagnosticsOf(withComputed("boolean :big() { return &n > 1 }"))).toEqual([]);
    // An attribute named `before` is a member of the record, read as any other.
    for (const line of ["boolean :late() { return &before > 0 }", "boolean :late({ self }) { return self.before > 0 }", "boolean :late value=() => &before > &n"])
      expect(diagnosticsOf(withComputed(line, "    integer :before\n")), line).toEqual([]);
    // A rest or plain parameter reaches `before` only by reading it: the word elsewhere in the body is no read of it.
    for (const line of ["boolean :x({ ...rest }) { return &before !== null }", 'boolean :x({ ...rest }) { const t = rest.self.title; return t !== "before" }', "boolean :x(s) { return s.self.before !== null }"])
      expect(diagnosticsOf(withComputed(line, "    integer :before\n")).map((d) => d.code), line).not.toContain("MESH_COMPUTED_BEFORE");
    // A parameter of a list method named `before` hides the root: plain code with its warning, and no error.
    expect(brief(withComputed("boolean :any() { return [&n].some((before) => before > 0) }"), 6)).toEqual([["warning", "MESH_EXPR_PLAIN", "[&n].s"]]);
    // An object key and a string that spell it read nothing.
    expect(diagnosticsOf(withComputed('json :shape() { return { before: &n, note: "before" } }'))).toEqual([]);
    // In a check the code is the check's, not this one.
    const check = withComputed("boolean :big() { return &n > 1 }").replace("      do\n", "      validate\n        check :c that=({ before }) => before !== null code=\"c\" message=\"m\"\n      do\n");
    expect(diagnosticsOf(check).map((d) => d.code)).toEqual(["MESH_VALIDATE_BEFORE"]);
  });
});

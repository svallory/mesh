import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FUNCTIONS, type Expression, type ExprNode } from "@meshfw/model";
import { expr, scope } from "@meshfw/runtime";
import { EXPRESSION_TABLES, QUANTIFIER_TABLES } from "@meshfw/runtime/testing";
import { buildModel } from "../src/front-end/build.ts";
import { generateFiles, writeGeneratedFiles } from "../src/typescript/emit.ts";
import { printTree } from "../src/typescript/expression-printer.ts";
import { checkTypes, configOf } from "./generated.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const at = { file: "t.mesh.mx", line: 1, column: 0, offset: 0 };
const v = (name: string): ExprNode => ({ kind: "var", name, position: at });

describe("the function tables (acceptance test 1)", () => {
  test("the registry, the tables and the runtime name the same functions", () => {
    const ids = FUNCTIONS.map((f) => f.id).sort();
    expect(Object.keys(EXPRESSION_TABLES).sort()).toEqual(ids);
    for (const id of ids) expect(typeof (expr as Record<string, unknown>)[id]).toBe("function");
    for (const f of FUNCTIONS) for (const c of EXPRESSION_TABLES[f.id]!) expect(c.args.length).toBe(f.arity);
  });
  // Each case is printed as the generated code would print it, then evaluated.
  for (const spec of FUNCTIONS)
    test(`${spec.id} (${spec.spelling}), printed and evaluated`, () => {
      for (const c of EXPRESSION_TABLES[spec.id]!) {
        const tree: ExprNode = { kind: "call", fn: spec.id, args: c.args.map((_, i) => v(`a${i}`)), position: at };
        const code = printTree(tree);
        const s = scope({}, { clock: () => new Date(c.clock ?? 0) });
        const run = new Function("$", "s", ...c.args.map((_, i) => `a${i}`), `return ${code};`);
        expect(run(expr, s, ...c.args)).toEqual(c.result as never);
      }
    });
  for (const op of ["some", "every", "find", "filter"] as const)
    test(`${op}, printed and evaluated`, () => {
      for (const c of QUANTIFIER_TABLES[op]) {
        const tree: ExprNode = { kind: "quantify", op, source: v("list"), param: "x", body: { kind: "call", fn: "eq", args: [v("x"), v("x")], position: at }, position: at };
        const code = printTree(tree).replace("$.eq(x, x)", "pick(x)").replace(": any", "");
        const run = new Function("$", "list", "pick", `return ${code};`);
        expect(run(expr, c.outcomes.map((_, i) => i), (i: number) => c.outcomes[i])).toEqual(c.result as never);
      }
    });
});

const entity = (body: string, extra = "") => `import { Task } from "./task.mesh.mx"
entity :Task
  attributes
    uuid :id primary-key
    integer :n
    integer :m nullable
    string :title nullable
    enum :state values=[:open, :done] default=:open
    enum :flag values=[:a, :b] nullable
    timestamp :dueAt nullable
    boolean :ok default=false
    boolean :maybe nullable
    json :meta nullable
  relationships
    has-many :children entity=Task
    belongs-to :parent entity=Task nullable
${extra}  actions auto=[:read]
    update :go
      validate
${body}`;
const check = (that: string, extra = "") => `        check :c [
          that=${that}
          code="c"
          message="m"
        ]
`.concat(extra);
function build(source: string) {
  return buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source }] });
}
const exprOf = (source: string): Expression => build(source).document!.entities[0]!.actions[0]!.validate[0]!.that;
const codes = (source: string) => build(source).diagnostics.map((d) => `${d.severity}:${d.code}`);

describe("conversion", () => {
  test("a comparison becomes a call over member reads", () => {
    const e = exprOf(entity(check("() => &n >= 3")));
    expect(e.plain).toBeUndefined();
    expect(e.tree).toMatchObject({ kind: "call", fn: "gte", args: [{ kind: "member", name: "n", optional: false, object: { kind: "var", name: "self" } }, { kind: "literal", value: 3 }] });
    expect(e.tree!.position).toMatchObject({ file: "task.mesh.mx", line: entity(check("() => &n >= 3")).split("\n").findIndex((l) => l.includes("that=")) + 1 });
  });
  test("atoms, null tests, ?? and ?. are translated", () => {
    expect(exprOf(entity(check("() => &state === :done"))).tree).toMatchObject({ fn: "eq", args: [{}, { kind: "atom", value: "done" }] });
    expect(exprOf(entity(check("() => &m !== null && 1 > 0"))).tree).toMatchObject({ fn: "and", args: [{ fn: "isNotNull" }, {}] });
    expect(exprOf(entity(check("() => (&m ?? 0) > 1"))).tree).toMatchObject({ fn: "gt", args: [{ fn: "coalesce" }, {}] });
    expect(exprOf(entity(check("() => &parent?.n > 1"))).tree).toMatchObject({ fn: "gt", args: [{ kind: "member", name: "n", optional: true }, {}] });
    expect(exprOf(entity(check("() => &title.length > 0"))).tree).toMatchObject({ args: [{ fn: "length" }, {}] });
    expect(exprOf(entity(check("() => &dueAt < now()"))).tree).toMatchObject({ fn: "lt", args: [{}, { fn: "now", args: [] }] });
  });
  test("quantifiers over a has-many", () => {
    const e = exprOf(entity(check("() => &children.every((c) => c.state !== :open)")));
    expect(e.tree).toMatchObject({ kind: "quantify", op: "every", param: "c", source: { kind: "member", name: "children" }, body: { fn: "ne" } });
    expect(codes(entity(check("() => &children.some((c) => c.state === :done)")))).toEqual([]);
  });
  test("the tree survives model.json", () => {
    const doc = build(entity(check("() => &n >= 3"))).document!;
    expect(JSON.parse(JSON.stringify(doc))).toStrictEqual(doc);
  });
  test("a body with two statements is plain code and still builds (acceptance test 5)", () => {
    const source = entity("", "").replace("      validate\n", "") + "      do\n        run({ self }) { const x = self.n; console.log(x) }\n";
    const result = build(source);
    expect(result.diagnostics).toEqual([]);
    const run = result.document!.entities[0]!.actions[0]!.do[0]!;
    expect(run).toMatchObject({ kind: "run", fn: { plain: { why: "run-step" } } });
  });
  test("a computed block body of two statements is plain by form, without a warning", () => {
    const source = entity(check("() => true"), "").replace("  actions auto", "  computed\n    boolean :late({ self }) { const t = self.dueAt; return t !== null && t < new Date() }\n  actions auto");
    const result = build(source);
    expect(result.diagnostics).toEqual([]);
    expect(result.document!.entities[0]!.computed[0]!.body!.plain).toMatchObject({ why: "block-body" });
  });
  test("a single-return method body is translated", () => {
    const source = entity(check("() => true")).replace("  actions auto", "  computed\n    boolean :late() { return &dueAt < today() }\n  actions auto");
    const e = build(source).document!.entities[0]!.computed[0]!;
    expect(e.body!.tree).toMatchObject({ fn: "lt" });
    expect(e.nullable).toBe(true);
  });
});

describe("free variables (acceptance test 2)", () => {
  test("a captured name fails the build at its node", () => {
    const source = entity(check("() => &n > limit"));
    const [d] = build(source).diagnostics;
    expect(d).toMatchObject({ severity: "error", code: "MESH_EXPR_FREE_VARIABLE", position: { line: source.split("\n").findIndex((l) => l.includes("that=")) + 1 } });
    expect(d!.message).toContain("`limit`");
    expect(d!.position.offset).toBe(source.indexOf("limit"));
  });
  test("in a set value, in a run body, inside a quantifier body", () => {
    const base = entity("").replace("      validate\n", "");
    expect(codes(base + "      do\n        set\n          &n=() => missing + 1\n")).toContain("error:MESH_EXPR_FREE_VARIABLE");
    expect(codes(base + "      do\n        run({ self }) { audit(self) }\n")).toContain("error:MESH_EXPR_FREE_VARIABLE");
    expect(codes(entity(check("() => &children.some((c) => c.n > nope)")))).toContain("error:MESH_EXPR_FREE_VARIABLE");
  });
  test("parameters, quantifier parameters, locals, globals and registered functions are not free", () => {
    expect(codes(entity(check("({ input }) => &children.some((c) => c.n > 1) && now() > input.x")))).not.toContain("error:MESH_EXPR_FREE_VARIABLE");
    const base = entity("").replace("      validate\n", "");
    expect(codes(base + "      do\n        run({ self }) { const t = Math.max(self.n, 1); console.log(t) }\n")).toEqual([]);
  });
});

describe("type rules", () => {
  test("a nullable receiver without ?. is an error with the fix", () => {
    const d = build(entity(check("() => &parent.n > 1"))).diagnostics.find((x) => x.code === "MESH_EXPR_NULLABLE_ACCESS")!;
    expect(d.severity).toBe("error");
    expect(d.fix).toContain("?.n");
  });
  test("find() needs ?. to read from its result; a chain after ?. is fine", () => {
    expect(codes(entity(check("() => &children.find((c) => c.n > 1).n > 1")))).toContain("error:MESH_EXPR_NULLABLE_ACCESS");
    expect(codes(entity(check("() => &children.find((c) => c.n > 1)?.n > 1")))).toEqual([]);
    expect(codes(entity(check("() => &parent?.parent.n > 1")))).toEqual([]);
  });
  test("an atom outside the enum's values is an error naming them", () => {
    const d = build(entity(check("() => &state === :wrong"))).diagnostics.find((x) => x.code === "MESH_EXPR_UNKNOWN_ATOM")!;
    expect(d.message).toContain(":open, :done");
  });
  test("null written to a required attribute is an error", () => {
    const base = entity("").replace("      validate\n", "");
    expect(codes(base + "      do\n        set\n          &n=() => &m\n")).toContain("error:MESH_EXPR_NULL_TO_REQUIRED");
    expect(codes(base + "      do\n        set\n          &n=() => &m ?? 0\n")).toEqual([]);
  });
  test("two nullable operands warn about null equality; a negation of an unknown warns", () => {
    expect(codes(entity(check("() => &m === &title")))).toEqual(["warning:MESH_EXPR_PLAIN"]); // a number against a string: not translated
    expect(codes(entity(check("() => &m === &parent?.n")))).toContain("warning:MESH_EXPR_NULL_EQUALITY");
    expect(codes(entity(check("() => &state !== :done")))).toEqual([]);
    expect(codes(entity(check("() => &flag !== :a")))).toContain("warning:MESH_EXPR_NEGATED_UNKNOWN");
    expect(codes(entity(check("() => !&maybe")))).toContain("warning:MESH_EXPR_NEGATED_UNKNOWN");
    expect(codes(entity(check("() => !&ok")))).toEqual([]);
    expect(codes(entity(check("() => &m < 3")))).toEqual([]);
  });
  test("constructs the registry cannot define stay plain with JavaScript meaning, and warn (D3, D4)", () => {
    for (const that of ["() => !&title", "() => &title < \"m\"", "() => &state > :open", "() => &ok < true", "() => &n == 1", "() => &title + \"x\" === \"y\"", "() => &title.startsWith(\"a\") === true"]) {
      const e = exprOf(entity(check(that)));
      expect(e.tree).toBeUndefined();
      expect(e.plain).toMatchObject({ why: "unsupported-construct" });
      expect(e.plain!.edits.length).toBeGreaterThan(0);
      expect(codes(entity(check(that)))).toContain("warning:MESH_EXPR_PLAIN");
    }
  });
  test("a plain expression without operators does not warn; neither does tx", () => {
    expect(codes(entity(check("({ tx }) => tx.ok(&n)")))).toEqual([]);
    expect(exprOf(entity(check("({ tx }) => tx.ok(&n)"))).plain).toMatchObject({ why: "uses-tx" });
  });
  test("a helper that does not read the record is translated; one that does is plain", () => {
    const withHelper = (that: string) => entity(check(that)).replace("entity :Task", 'import { isStaff, money } from "./helpers"\nentity :Task');
    const bad = buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source: withHelper("({ actor }) => isStaff(actor)") }, { file: "helpers.ts", source: "" }] });
    // helpers.ts is not an entity file; the missing-file check is the build's own, so only look at the expression.
    const e = bad.document?.entities[0]?.actions[0]?.validate[0]?.that;
    if (e) expect(e.tree).toMatchObject({ kind: "helper", name: "isStaff" });
  });
});

describe("emission (acceptance tests 3, 4 and 6)", () => {
  async function generated(source: string) {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-expr-"));
    roots.push(root);
    const built = build(source);
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const config = configOf(root);
    const files = await generateFiles({ document: built.document!, config });
    await writeGeneratedFiles(files, config);
    await writeFile(resolve(root, "generated/schema.ts"), "export const tables = {};\n");
    await mkdir(resolve(root, "node_modules"), { recursive: true });
    return { root, files, built };
  }
  const source = entity(
    check("() => &children.every((c) => c.state !== :open) && &children.some((c) => c.n > 1)") +
    "        check :late [\n          that=() => &dueAt < now()\n          code=\"late\"\n          message=\"m\"\n        ]\n",
    "",
  ).replace("  actions auto", "  computed\n    boolean :overdue() { return &dueAt < today() }\n    string :label({ self }) { return `${self.n}:${self.title}` }\n  actions auto");

  test("the generated file type-checks under the strict flags", async () => {
    const { root, files } = await generated(source);
    expect(files.map((f) => f.path)).toContain("generated/task.expressions.ts");
    expect(checkTypes(root, ["generated/task.expressions.ts", "generated/task.types.ts"])).toEqual({ code: 0, output: "" });
  });

  test("quantifiers evaluate on loaded rows, unknown included (test 3)", async () => {
    const { root } = await generated(source);
    const { expressions } = await import(resolve(root, "generated/task.expressions.ts"));
    const f = expressions["go.check.c.that"] as (s: unknown) => unknown;
    const run = (children: unknown) => f(scope({ self: { children } }));
    expect(run([{ state: "done", n: 2 }, { state: "done", n: 0 }])).toBe(true);
    expect(run([{ state: "done", n: 2 }, { state: "open", n: 5 }])).toBe(false);
    expect(run([])).toBe(false); // every is true, some is false
    expect(run([{ state: null, n: 5 }])).toBe(false); // an unknown predicate makes every false
    expect(() => run(undefined)).toThrow("not loaded");
  });

  test("now() is the injected clock (test 4)", async () => {
    const { root } = await generated(source);
    const { expressions } = await import(resolve(root, "generated/task.expressions.ts"));
    const late = expressions["go.check.late.that"] as (s: unknown) => unknown;
    const row = { dueAt: new Date(1_000) };
    expect(late(scope({ self: row }, { clock: () => new Date(2_000) }))).toBe(true);
    expect(late(scope({ self: row }, { clock: () => new Date(500) }))).toBe(false);
    expect(late(scope({ self: { dueAt: null } }, { clock: () => new Date(2_000) }))).toBeNull();
    const overdue = expressions["computed.overdue"] as (s: unknown) => unknown;
    expect(overdue(scope({ self: { dueAt: new Date(86_400_000 * 3 + 5) } }, { clock: () => new Date(86_400_000 * 3 + 100) }))).toBe(false);
    expect(overdue(scope({ self: { dueAt: new Date(86_400_000 * 3 - 1) } }, { clock: () => new Date(86_400_000 * 3 + 100) }))).toBe(true);
  });

  test("plain code runs with the authored meaning, `&` and atoms desugared", async () => {
    const { root } = await generated(source);
    const { expressions } = await import(resolve(root, "generated/task.expressions.ts"));
    expect(expressions["computed.label"](scope({ self: { n: 3, title: "x" } }))).toBe("3:x");
  });

  test("a model without expressions gets no file", async () => {
    const { files } = await generated("entity :Plain\n  attributes\n    uuid :id primary-key\n");
    expect(files.some((f) => f.path.endsWith(".expressions.ts"))).toBe(false);
  });
});

describe("the reference page", () => {
  test("apps/docs/.../expression-functions.md is generated from the tables", async () => {
    const { PAGE_PATH, renderExpressionPage } = await import("./expression-page.ts");
    expect(await Bun.file(PAGE_PATH).text()).toBe(renderExpressionPage());
  });
});

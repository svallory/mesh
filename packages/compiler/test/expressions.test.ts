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
        const run = new Function("$", "$s", ...c.args.map((_, i) => `l$a${i}`), `return ${code};`);
        expect(run(expr, s, ...c.args)).toEqual(c.result as never);
      }
    });
  for (const op of ["some", "every", "find", "filter"] as const)
    test(`${op}, printed and evaluated`, () => {
      for (const c of QUANTIFIER_TABLES[op]) {
        const tree: ExprNode = { kind: "quantify", op, source: v("list"), param: "x", body: { kind: "call", fn: "eq", args: [v("x"), v("x")], position: at }, position: at };
        const code = printTree(tree).replace("$.eq(l$x, l$x)", "pick(l$x)").replace(": any", "");
        const run = new Function("$", "l$list", "pick", `return ${code};`);
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
  test("every access prints as ?., so a null anywhere in a chain gives null, not a crash", () => {
    const tree = exprOf(entity(check("() => &parent?.parent.n > 1"))).tree!;
    const code = printTree(tree);
    expect(code).toContain("?.parent?.n");
    const run = (self: object) => new Function("$", "$s", `return ${code};`)(expr, scope({ self }));
    expect(run({ parent: null })).toBeNull();
    expect(run({ parent: { parent: null } })).toBeNull();
    expect(run({ parent: { parent: { n: 2 } } })).toBe(true);
  });
  test("quantifier parameters named like the generated internals cannot capture them (R1)", async () => {
    for (const name of ["s", "$", "$s", "scope", "clock", "self", "actor", "_s", "expr"]) {
      if (["self", "actor"].includes(name)) continue; // a scope name as a parameter is a build-time shadow, not an internal clash
      const that = `({ actor }) => &children.some((${name}) => ${name}.dueAt < now() && ${name}.id === actor.id)`;
      const e = exprOf(entity(check(that)));
      expect(e.tree, name).toBeDefined();
      const code = printTree(e.tree!, true).replaceAll(": any", "");
      const run = new Function("$", "$s", `return ${code};`);
      const s = scope({ self: { children: [{ dueAt: new Date(10), id: "a" }, { dueAt: new Date(10), id: "x" }] }, actor: { id: "a" } }, { clock: () => new Date(100) });
      expect(run(expr, s), name).toBe(true);
      const s2 = scope({ self: { children: [{ dueAt: new Date(10), id: "x" }] }, actor: { id: "a" } }, { clock: () => new Date(100) });
      expect(run(expr, s2), name).toBe(false);
    }
  });
  test("a float literal forces exact division (R2); `2` does not", () => {
    const withRatio = (that: string) => entity(check(that));
    expect(exprOf(withRatio("() => &n / 2.0 > 1")).tree).toMatchObject({ fn: "gt", args: [{ fn: "div", args: [{}, { kind: "literal", value: 2, float: true }] }, {}] });
    expect(codes(withRatio("() => &n / 2.0 > 1"))).toEqual([]);
    expect(exprOf(withRatio("() => &n / 1e1 > 1")).tree).toMatchObject({ args: [{ fn: "div" }, {}] });
    expect(exprOf(withRatio("() => &n / 2 > 1")).tree).toMatchObject({ args: [{ fn: "idiv" }, {}] });
  });
  test("truthiness in a ternary inside plain code warns (R3)", () => {
    const source = entity(check("() => true")).replace("  actions auto", "  computed\n    string :w() { return &title ? &title.toUpperCase() : \"\" }\n  actions auto");
    expect(codes(source)).toContain("warning:MESH_EXPR_PLAIN");
  });
  test("input is read with ?. so a scope without one gives null", () => {
    const code = printTree(exprOf(entity(check("({ input }) => input.m !== 5"))).tree!);
    expect(code).toContain("$s.input?.m");
    expect(new Function("$", "$s", `return ${code};`)(expr, scope({ self: {} }))).toBeNull();
  });
  test("integer by integer division truncates and warns; a float or decimal divides exactly (ruling of 14:00)", () => {
    const base = entity("").replace("      validate\n", "").replace("    integer :m nullable\n", "    integer :m nullable\n    float :ratio default=1\n");
    const e = exprOf(entity(check("() => &n / 2 > 1")).replace("    integer :m nullable\n", "    integer :m nullable\n    float :ratio default=1\n"));
    expect(e.tree).toMatchObject({ fn: "gt", args: [{ fn: "idiv" }, {}] });
    expect(codes(entity(check("() => &n / 2 > 1")))).toEqual(["warning:MESH_EXPR_INTEGER_DIVISION"]);
    const float = entity(check("() => &ratio / 2 > 1")).replace("    integer :m nullable\n", "    integer :m nullable\n    float :ratio default=1\n");
    expect(exprOf(float).tree).toMatchObject({ fn: "gt", args: [{ fn: "div" }, {}] });
    expect(codes(float)).toEqual([]);
    void base;
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
  test("truthiness warns even without an operator; so does arithmetic that JavaScript reads differently", () => {
    for (const that of ["() => &title", "() => &m ? true : false", "() => Math.round(&m * 2) === 1", "() => `${&n}` + &title === \"\""])
      expect(codes(entity(check(that))), that).toContain("warning:MESH_EXPR_PLAIN");
  });
  test("?? and operators inside string literals do not warn", () => {
    const base = entity("").replace("      validate\n", "").replace("  computed", "  computed").replace("  actions auto", "  computed\n    string :ex() { return (&title ?? \"\").slice(0, 200) }\n    string :tag() { return `<${&n}>` }\n  actions auto");
    expect(codes(base)).toEqual([]);
  });
  test("a quantifier's parameter used outside its quantifier is a free variable at its node", () => {
    const source = entity(check("() => &children.some((x) => x.n > 1) && x.n > 0"));
    const d = build(source).diagnostics.filter((x) => x.code === "MESH_EXPR_FREE_VARIABLE");
    expect(d).toHaveLength(1);
    expect(d[0]!.position.offset).toBe(source.lastIndexOf("x.n"));
  });
  test("input members on an update are nullable, so the negation warning fires; set &x=input.x is exempt", () => {
    expect(codes(entity(check("({ input }) => input.m !== 5")).replace("      validate", "      input\n        &m\n      validate"))).toContain("warning:MESH_EXPR_NEGATED_UNKNOWN");
    const passthrough = entity("").replace("      validate\n", "      input\n        &n\n") + "      do\n        set\n          &n=({ input }) => input.n\n";
    expect(codes(passthrough)).toEqual([]);
  });
  test("always actions=[...] resolves the named actions' kinds for `before`", () => {
    const withAlways = (target: string) => entity("").replace("      validate\n", "").replace("  actions auto=[:read]\n", `  actions auto=[:read]\n    always actions=[&${target}]\n      validate\n        check :c that=({ before }) => before.n > 0 code="c" message="m"\n`) + "    create :make\n      input\n        &n\n";
    expect(codes(withAlways("go"))).toEqual([]);
    expect(codes(withAlways("make"))).toContain("error:MESH_BEFORE_IN_CREATE");
  });
  test("a plain expression without operators does not warn; tx is plain, and a function that reads it is not available before action composition", () => {
    expect(codes(entity(check("({ tx }) => tx.ok(&n)")))).toEqual(["error:MESH_NOT_IMPLEMENTED"]);
    expect(build(entity(check("({ tx }) => tx.ok(&n)"))).diagnostics[0]!.message).toContain("check :c (that) reads `tx`, which belongs to action composition");
  });
  test("a helper that does not read the record is translated and imported; one given the record is plain", async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-helper-"));
    roots.push(root);
    await writeFile(resolve(root, "helpers.ts"), "export const isStaff = (actor: { staff?: boolean }) => actor.staff === true;\nexport const big = (n: number) => n > 100;\n");
    const withHelper = (that: string) => entity(check(that)).replace("import { Task }", 'import { isStaff, big } from "./helpers"\nimport { Task }');
    const build = (that: string) => buildModel({ root, files: [{ file: "task.mesh.mx", source: withHelper(that) }] });
    const ok = build("({ actor }) => isStaff(actor) && &n > 1");
    expect(ok.diagnostics).toEqual([]);
    const tree = ok.document!.entities[0]!.actions[0]!.validate[0]!.that.tree!;
    expect(tree).toMatchObject({ fn: "and", args: [{ kind: "helper", name: "isStaff", from: "./helpers" }, {}] });
    expect(ok.document!.entities[0]!.imports[0]).toMatchObject({ helper: true, identifiers: ["isStaff", "big"] });
    expect(printTree(tree, true)).toContain("$.asBool(isStaff($s.actor))");
    const plain = build("() => big(&n)");
    expect(plain.document!.entities[0]!.actions[0]!.validate[0]!.that.plain).toMatchObject({ why: "reads-record-in-helper" });
    const config = configOf(root);
    const files = await generateFiles({ document: ok.document!, config });
    expect(files.find((f) => f.path.endsWith("task.expressions.ts"))!.contents).toContain('import { isStaff } from "../helpers"');
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

  test("plain code type-checks strictly: quantifier callbacks, atoms without &, a bare self", async () => {
    const plain = entity(check("() => true")).replace("  actions auto", "  computed\n    boolean :a() { return &children.some((c) => c.title.startsWith(\"a\")) }\n    boolean :b({ self }) { return self.state.toString() === :open }\n    boolean :c() { return self.n.toFixed(0) === \"1\" }\n  actions auto");
    const { root, files } = await generated(plain);
    expect(checkTypes(root, ["generated/task.expressions.ts", "generated/task.types.ts"])).toEqual({ code: 0, output: "" });
    const { expressions } = await import(resolve(root, "generated/task.expressions.ts"));
    expect(expressions["computed.c"](scope({ self: { n: 1 } }))).toBe(true);
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

describe("review fixes (PR #63, round 1)", () => {
  test("before.<relationship> and before.<computed> are build errors at the node; before.<attribute> is fine", () => {
    for (const where of ["that", "when"]) {
      const body = where === "that"
        ? check("({ before }) => before.parent?.n > 1")
        : check("() => true", "").replace("          code=", "          when=({ before }) => before.parent?.n > 1\n          code=");
      const found = build(entity(body)).diagnostics.filter((d) => d.code === "MESH_BEFORE_NOT_LOADED");
      expect(found, where).toHaveLength(1);
      expect(found[0]!.severity).toBe("error");
      expect(found[0]!.message).toContain("before.parent");
      expect(found[0]!.fix).toContain("&parent");
    }
    const computed = entity(check("({ before }) => before.late"), "").replace("  actions auto", "  computed\n    boolean :late() { return &dueAt < today() }\n  actions auto");
    expect(codes(computed)).toContain("error:MESH_BEFORE_NOT_LOADED");
    expect(codes(entity(check("({ before }) => before.n > 1")))).not.toContain("error:MESH_BEFORE_NOT_LOADED");
  });
  test("plain code in details warns when it has an operator, and stays silent without one", () => {
    const withDetails = (details: string) => entity(check("() => &n > 0").replace("          message=", `          details=${details}\n          message=`));
    expect(codes(withDetails("({ before }) => ({ low: &title < \"b\", n: before.n })"))).toContain("warning:MESH_EXPR_PLAIN");
    expect(codes(withDetails("({ before }) => ({ v: before.n })"))).not.toContain("warning:MESH_EXPR_PLAIN");
  });
  test("a destroy with a set or load step is a build error, nested or from an always block; a destroy with a run is fine", () => {
    const base = entity("").replace("    update :go\n      validate\n", "");
    const destroy = (body: string) => base + `    destroy :drop\n      do\n${body}`;
    expect(codes(destroy("        set\n          &n=1\n"))).toContain("error:MESH_DESTROY_STEP");
    expect(codes(destroy("        load=[&parent]\n"))).toContain("error:MESH_DESTROY_STEP");
    expect(codes(destroy("        when=() => true\n          set\n            &n=1\n"))).toContain("error:MESH_DESTROY_STEP");
    expect(codes(destroy("        run({ self }) { console.log(self.n) }\n"))).not.toContain("error:MESH_DESTROY_STEP");
    const always = base.replace("  actions auto=[:read]\n", "  actions auto=[:read]\n    always types=[:destroy]\n      do\n        set\n          &n=1\n") + "    destroy :drop\n";
    expect(codes(always)).toContain("error:MESH_DESTROY_STEP");
  });
  test("an always block that names the auto destroy refuses set and load too", () => {
    const base = entity("").replace("      validate\n", "").replace("auto=[:read]", "auto=[:read, :destroy]");
    for (const step of ["        set\n          &n=1\n", "        load=[&parent]\n"]) {
      const source = base.replace("  actions auto=[:read, :destroy]\n", `  actions auto=[:read, :destroy]\n    always actions=[&destroy]\n      do\n${step}`);
      expect(codes(source)).toContain("error:MESH_DESTROY_STEP");
    }
  });
  test("before in a create is a build error at the node: in that, in details, in a run parameter, and in an always for creates", () => {
    const create = (extra: string) => entity("").replace("      validate\n", "").replace("  actions auto=[:read]\n", `  actions auto=[:read]\n    create :make\n      input\n        &n\n${extra}`);
    expect(codes(create("      validate\n        check :c that=({ before }) => before.n > 0 code=\"c\" message=\"m\"\n"))).toContain("error:MESH_BEFORE_IN_CREATE");
    expect(codes(create("      validate\n        check :c [\n          that=() => &n > 0\n          code=\"c\"\n          message=\"m\"\n          details=({ before }) => ({ v: before.n })\n        ]\n"))).toContain("error:MESH_BEFORE_IN_CREATE");
    expect(codes(create("      do\n        run({ before }) { console.log(before) }\n"))).toContain("error:MESH_BEFORE_IN_CREATE");
    expect(codes(entity(check("({ before }) => before.n > 0")))).not.toContain("error:MESH_BEFORE_IN_CREATE");
  });
  test("before in a plain function of an always block that covers only creates is a build error; one that also covers an update is clean", () => {
    const withAlways = (head: string, body: string) => entity("").replace("      validate\n", "").replace("  actions auto=[:read]\n", `  actions auto=[:read]\n    always ${head}\n      do\n        ${body}\n`) + "    create :make\n      input\n        &n\n    update :go\n";
    const run = "run({ before }) { console.log(before) }";
    expect(codes(withAlways("types=[:create]", run))).toContain("error:MESH_BEFORE_IN_CREATE");
    expect(codes(withAlways("actions=[&make]", run))).toContain("error:MESH_BEFORE_IN_CREATE");
    expect(codes(withAlways("types=[:create]", "set\n          &n=({ before }) => { return before.n }"))).toContain("error:MESH_BEFORE_IN_CREATE");
    expect(codes(withAlways("types=[:create, :update]", run))).not.toContain("error:MESH_BEFORE_IN_CREATE");
    expect(codes(withAlways("actions=[&make, &go]", run))).not.toContain("error:MESH_BEFORE_IN_CREATE");
  });
  test("before reached through a rest parameter in a create is a build error; a rest that never names before is not", () => {
    const create = (fn: string) => entity("").replace("      validate\n", "").replace("  actions auto=[:read]\n", `  actions auto=[:read]\n    create :make\n      input\n        &n\n      do\n        ${fn}\n`);
    expect(codes(create("run({ context, ...rest }) { console.log(rest.before) }"))).toContain("error:MESH_BEFORE_IN_CREATE");
    expect(codes(create("run({ context, ...rest }) { console.log(rest.self) }"))).not.toContain("error:MESH_BEFORE_IN_CREATE");
  });
  test("a details that reads before in a create reports MESH_BEFORE_IN_CREATE once", () => {
    const create = (details: string) => entity("").replace("      validate\n", "").replace("  actions auto=[:read]\n", `  actions auto=[:read]\n    create :make\n      input\n        &n\n      validate\n        check :c [\n          that=() => &n > 0\n          code="c"\n          message="m"\n          details=${details}\n        ]\n`);
    for (const details of ["({ before }) => ({ v: before.n })", "({ before }) => { return { v: before.n } }"])
      expect(build(create(details)).diagnostics.filter((d) => d.code === "MESH_BEFORE_IN_CREATE"), details).toHaveLength(1);
  });
  test("run after=:write is a positioned MESH_NOT_IMPLEMENTED that names action composition and the second half of M5", () => {
    const source = entity("").replace("      validate\n", "").replace("  actions auto=[:read]\n", "  actions auto=[:read]\n    create :make\n      input\n        &n\n      do\n        run [after=:write] ({ self }) { console.log(self) }\n");
    const d = build(source).diagnostics.filter((x) => x.code === "MESH_NOT_IMPLEMENTED");
    expect(d).toHaveLength(1);
    expect(d[0]!.message).toContain("second half of M5");
    expect(d[0]!.position.offset).toBe(source.indexOf("after="));
  });
  test("details: a comparison of non-null operands does not warn; one that can see a null does", () => {
    const withDetails = (details: string) => entity(check("() => &n > 0").replace("          message=", `          details=${details}\n          message=`)).replace("      validate", "      input\n        integer :fence\n      validate");
    expect(codes(withDetails("({ input, before }) => ({ stale: input.fence < before.n })"))).not.toContain("warning:MESH_EXPR_PLAIN");
    expect(codes(withDetails("({ before }) => ({ long: &title?.length > 3, n: before.n })"))).toContain("warning:MESH_EXPR_PLAIN");
  });
  test("a typed argument that shares a member's name is not the member passthrough: a nullable one set onto a required column is a build error", () => {
    const source = entity("").replace("      validate\n", "      input\n        integer :n nullable\n") + "      do\n        set\n          &n=({ input }) => input.n\n";
    expect(codes(source)).toContain("error:MESH_EXPR_NULL_TO_REQUIRED");
  });
});

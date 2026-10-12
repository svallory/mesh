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
    json :meta
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

describe("a name is a scope root only where it refers to the scope (small-fixes-2, items 1 and 2)", () => {
  const make = (steps: string) => entity("").replace("      validate\n", "").replace("  actions auto=[:read]\n", `  actions auto=[:read]\n    create :make\n      input\n        &n\n      do\n${steps}`);
  /** The roots the first run step of `make` reads from the scope. */
  const rootsOf = (body: string) => {
    const result = build(make(`        run (${"{ context }"}) ${body}\n`));
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const step = result.document!.entities[0]!.actions.find((a) => a.name === "make")!.do[0]!;
    return step.kind === "run" ? step.fn.plain!.roots : undefined;
  };
  test("a loop variable, a nested parameter and a catch parameter shadow the root", () => {
    expect(rootsOf("{ for (const input of [1, 2]) { console.log(input) } }")).toEqual([]);
    expect(rootsOf("{ for (const input in { a: 1 }) { console.log(input) } }")).toEqual([]);
    expect(rootsOf("{ [1].forEach((input) => console.log(input)) }")).toEqual([]);
    expect(rootsOf("{ function f(input: number) { return input } console.log(f(1)) }")).toEqual([]);
    expect(rootsOf("{ try { console.log(1) } catch (input) { console.log(input) } }")).toEqual([]);
    expect(rootsOf("{ const input = 1; console.log(input) }")).toEqual([]);
    expect(rootsOf("{ if (context) { var input = 1 } console.log(input) }")).toEqual([]);
  });
  test("the same name read as the root elsewhere is still a root", () => {
    expect(rootsOf("{ for (const input of [1]) { console.log(input) } console.log(input) }")).toEqual(["input"]);
    expect(rootsOf("{ console.log(input); [1].forEach((input) => console.log(input)) }")).toEqual(["input"]);
    expect(rootsOf("{ try { console.log(input) } catch (input) { console.log(input) } }")).toEqual(["input"]);
    expect(rootsOf("{ if (context) { const input = 1; console.log(input) } else { console.log(input) } }")).toEqual(["input"]);
  });
  test("a private class member is never a free variable", () => {
    const body = "{ class C { #x = 1; static #y = 2; get() { return this.#x + C.#y } has(o: object) { return #x in o } } console.log(new C().get()) }";
    expect(rootsOf(body)).toEqual([]);
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
    const withAlways = (target: string) => entity("").replace("      validate\n", "").replace("  actions auto=[:read]\n", `  actions auto=[:read]\n    always actions=[&${target}]\n      do\n        when=({ before }) => before.n > 0\n          set\n            &m=1\n`) + "    create :make\n      input\n        &n\n";
    expect(codes(withAlways("go"))).toEqual([]);
    expect(codes(withAlways("make"))).toContain("error:MESH_BEFORE_IN_CREATE");
  });
  test("a function that calls privileged or an entity's action builds as plain code, and records what it names", () => {
    expect(codes(entity(check("() => privileged(Task) !== null && &n > 0")))).toEqual([]);
    expect(exprOf(entity(check("() => privileged(Task) !== null && &n > 0"))).plain).toMatchObject({ why: "uses-privileged", roots: ["self"], privileged: true, entities: ["Task"] });
    const acting = exprOf(entity(check("({ context }) => Task.go({ id: input.id }, context) !== null")));
    expect(acting.plain).toMatchObject({ why: "calls-entity", roots: ["input"], entities: ["Task"], acts: true });
    expect(acting.plain!.privileged).toBeUndefined();
    // Naming the entity without calling an action is not acting.
    expect(exprOf(entity(check("() => Task !== null"))).plain).toMatchObject({ why: "calls-entity", entities: ["Task"] });
    expect(exprOf(entity(check("() => Task !== null"))).plain!.acts).toBeUndefined();
    // A parameter called like the entity shadows it, and a string or an object key that spells it is not a read.
    expect(exprOf(entity(check("({ self: Task }) => Task.n > 1"))).tree).toBeDefined();
    const spelled = exprOf(entity(check('() => ({ Task: "privileged" }).Task === "x"')));
    expect(spelled.plain?.entities).toBeUndefined();
    expect(spelled.plain?.privileged).toBeUndefined();
  });
  test("privileged takes the file's own entity or an imported one, named, else MESH_PRIVILEGED_ENTITY at the argument", () => {
    for (const that of ["() => privileged(input) !== null", '() => privileged("Task") !== null', "({ self: Task }) => privileged(Task) !== null", "() => privileged(Other) !== null"]) {
      const source = entity(check(that));
      const found = build(source).diagnostics.filter((d) => d.code === "MESH_PRIVILEGED_ENTITY");
      expect(found, that).toHaveLength(1);
      const argument = that.slice(that.indexOf("privileged(") + "privileged(".length);
      expect(found[0]!.position.offset, that).toBe(source.indexOf(that) + that.indexOf(argument));
    }
    expect(build(entity(check("() => privileged(input) !== null"))).diagnostics.find((d) => d.code === "MESH_PRIVILEGED_ENTITY")!.message)
      .toBe("`privileged()` takes an entity this file names, its own or an imported one, and `input` is not one");
    expect(codes(entity(check("() => privileged() !== null")))).toContain("error:MESH_EXPR_ARITY");
    expect(build(entity(check("() => privileged() !== null"))).diagnostics.find((d) => d.code === "MESH_EXPR_ARITY")!.fix).toBe("write `privileged(Task)`");
    // A function that takes `privileged` as its own parameter calls that, not Mesh's.
    expect(codes(entity(check("({ context: privileged }) => privileged(1) !== null")))).not.toContain("error:MESH_PRIVILEGED_ENTITY");
  });
  test("a function that destructures `tx` or `actions` from its scope is MESH_REMOVED_SCOPE_NAME at the name, saying what replaces it (TXN-16)", () => {
    const tx = { message: "`tx` is gone: a function in an entity file is no longer handed a transaction handle, and reads with no policy through `privileged`", fix: "write `privileged(<Entity>).<read>(input)`, naming the entity (import it when it is another file's); it joins the running transaction" };
    const actions = { message: "`actions` is gone: a function in an entity file calls another action as a method of the entity value", fix: "write `<Entity>.<action>(input, context)`, naming the entity (import it when it is another file's), and pass the context explicitly" };
    const step = (fn: string) => check("() => true", `      do\n        ${fn}\n`);
    const computed = (fn: string) => entity(check("() => true"), `  computed\n    integer :c${fn}\n`);
    const cases: [source: string, at: string, expected: typeof tx][] = [
      [entity(check("({ self, tx }) => self.n > 0 && tx !== null")), "tx }", tx], // a check, translated otherwise
      [entity(check('({ "tx": t }) => t !== null')), '"tx"', tx], // a quoted key, renamed
      [entity(check("({ actions: run }) => run !== null")), "actions:", actions],
      [entity(step("run({ self, actions }) { void self; void actions }")), "actions }", actions], // a run step, plain by form
      [entity(step("run({ input, tx }) { void input; void tx }")), "tx }", tx],
      [computed("({ self, tx }) { return self.n + (tx ? 1 : 0) }"), "tx }", tx],
    ];
    for (const [source, at, expected] of cases) {
      const found = build(source).diagnostics.filter((d) => d.code === "MESH_REMOVED_SCOPE_NAME");
      expect(found, at).toHaveLength(1);
      expect(found[0], at).toMatchObject({ severity: "error", ...expected });
      expect(found[0]!.position.offset, at).toBe(source.indexOf(at, source.indexOf("({")));
      expect(build(source).document, at).toBeNull();
    }
    // Both in one function: one error at each.
    expect(codes(entity(step("run({ tx, actions }) { void tx; void actions }"))).filter((c) => c === "error:MESH_REMOVED_SCOPE_NAME")).toHaveLength(2);
    // A nested function's own parameter, a property and a local of that name are the function's own business.
    for (const that of ["() => [1].some(({ tx }) => tx > 0)", "({ context }) => context.tx !== null", "() => { const actions = 1; return actions > 0 }"])
      expect(codes(entity(check(that))), that).not.toContain("error:MESH_REMOVED_SCOPE_NAME");
  });
  test("a computed field that calls privileged or an entity's action is a build error: it is worked out outside any action", () => {
    const computed = (body: string) => entity(check("() => true")).replace("  actions auto", `  computed\n    boolean :c${body}\n  actions auto`);
    for (const [body, reaches] of [["() { return privileged(Task) !== null }", "calls `privileged`"], ["() { return Task.go({}) !== null }", "calls an entity's action"], ["({ self }) { return privileged(Task).read({ filter: { id: self.id } }) }", "calls `privileged`"]] as const) {
      const source = computed(body);
      const d = build(source).diagnostics.filter((x) => x.code === "MESH_COMPUTED_COMPOSES");
      expect(d, body).toHaveLength(1);
      expect(d[0]!.message).toBe(`computed :c of Task ${reaches}, which only a function that runs inside an action may: a computed field is worked out whenever a record is loaded, outside any action`);
      expect(d[0]!.position.offset, body).toBe(source.indexOf(body));
    }
    // A string or a property that spells the name is not a call.
    expect(codes(computed('() { return { privileged: "Task" }.privileged === "x" }'))).not.toContain("error:MESH_COMPUTED_COMPOSES");
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
    // Through `$.pure`, which refuses a promise (EXP-03): by type where the helper's type says so, at run time otherwise.
    expect(printTree(tree, true)).toContain('$.asBool($.pure(isStaff($s.actor), "isStaff"))');
    if (tree.kind !== "call") throw new Error("expected a call");
    expect(printTree(tree.args[0]!, false)).toBe('$.pure(isStaff($s.actor), "isStaff")');
    const plain = build("() => big(&n)");
    expect(plain.document!.entities[0]!.actions[0]!.validate[0]!.that.plain).toMatchObject({ why: "reads-record-in-helper" });
    // An awaited helper (one that reads through `privileged`, say) makes the function plain, with no warning for the await.
    const awaited = build("async ({ input }) => (await big(input.n)) === true");
    expect(awaited.document!.entities[0]!.actions[0]!.validate[0]!.that.plain).toMatchObject({ why: "awaits-helper", helpers: true });
    expect(awaited.diagnostics).toEqual([]);
    // An await of anything else still warns.
    expect(build("async ({ input }) => (await Promise.resolve(input.n)) === 1").diagnostics.map((d) => d.code)).toContain("MESH_EXPR_PLAIN");
    const config = configOf(root);
    const files = await generateFiles({ document: ok.document!, config });
    expect(files.find((f) => f.path.endsWith("task.expressions.ts"))!.contents).toContain('import { isStaff } from "../../helpers"');
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
    expect(files.map((f) => f.path)).toContain("generated/domain/task.expressions.ts");
    expect(checkTypes(root, ["generated/domain/task.expressions.ts", "generated/domain/task.types.ts"])).toEqual({ code: 0, output: "" });
  }, 30_000);

  test("quantifiers evaluate on loaded rows, unknown included (test 3)", async () => {
    const { root } = await generated(source);
    const { expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
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
    const { expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
    const late = expressions["go.check.late.that"] as (s: unknown) => unknown;
    const row = { dueAt: new Date(1_000) };
    expect(late(scope({ self: row }, { clock: () => new Date(2_000) }))).toBe(true);
    expect(late(scope({ self: row }, { clock: () => new Date(500) }))).toBe(false);
    expect(late(scope({ self: { dueAt: null } }, { clock: () => new Date(2_000) }))).toBeNull();
    const overdue = expressions["computed.overdue"] as (s: unknown) => unknown;
    expect(overdue(scope({ self: { dueAt: new Date(86_400_000 * 3 + 5) } }, { clock: () => new Date(86_400_000 * 3 + 100) }))).toBe(false);
    expect(overdue(scope({ self: { dueAt: new Date(86_400_000 * 3 - 1) } }, { clock: () => new Date(86_400_000 * 3 + 100) }))).toBe(true);
  });

  test("plain code type-checks strictly: quantifier callbacks, atoms without &, a bare self, and only the scope names read are declared", async () => {
    // A string or an object key that spells a scope name declares nothing, so --noUnusedLocals finds nothing unused.
    const plain = (entity(check("() => true")) + "      do\n        run ({ context }) { console.log({ actor: \"before the write\" }, context) }\n").replace("  actions auto", "  computed\n    boolean :a() { return &children.some((c) => (c.title ?? \"\").startsWith(\"a\")) }\n    boolean :b({ self }) { return self.state.toString() === :open }\n    boolean :c() { return self.n.toFixed(0) === \"1\" }\n  actions auto");
    const { root, files } = await generated(plain);
    expect(checkTypes(root, ["generated/domain/task.expressions.ts", "generated/domain/task.types.ts"])).toEqual({ code: 0, output: "" });
    const { expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
    expect(expressions["computed.c"](scope({ self: { n: 1 } }))).toBe(true);
  }, 30_000);

  test("now() and today() in plain code read the injected clock, as in a translated expression; a local of that name is the author's", async () => {
    const plain = entity(check("() => true")).replace("  actions auto", "  computed\n    boolean :stamped() { return Math.floor(now().getTime() / 1000) === &n }\n    boolean :daily() { return [today()].some((d) => d.getTime() === &n) }\n    boolean :own() { const now = () => 7; return now() === &n }\n  actions auto");
    const { root, built } = await generated(plain);
    const computed = built.document!.entities[0]!.computed;
    expect(computed.map((c) => c.body?.plain?.clock)).toEqual([["now"], ["today"], undefined]);
    expect(checkTypes(root, ["generated/domain/task.expressions.ts", "generated/domain/task.types.ts"])).toEqual({ code: 0, output: "" });
    const { expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
    const at = { clock: () => new Date(86_400_000 * 2 + 5_000) };
    expect(expressions["computed.stamped"](scope({ self: { n: 86_400 * 2 + 5 } }, at))).toBe(true);
    expect(expressions["computed.stamped"](scope({ self: { n: 1 } }, at))).toBe(false);
    expect(expressions["computed.daily"](scope({ self: { n: 86_400_000 * 2 } }, at))).toBe(true);
    expect(expressions["computed.own"](scope({ self: { n: 7 } }, at))).toBe(true);
  }, 30_000);

  test("each now() and today() resolves against its own enclosing scopes: a parameter of that name shadows only inside its function", async () => {
    const plain = entity(check("() => true")).replace("  actions auto", [
      "  computed",
      // The review's case (PR #65, N7): the callback's parameter shadows `now` inside the callback only.
      "    boolean :outer() { return [1].some((now) => now === 1) && now().getTime() === &n }",
      // Only shadowed uses: no clock.
      "    boolean :inner() { if ([&n].some((now) => now === 7)) { const today = () => 7; return today() === &n } return false }",
      // Uses inside nested functions that bind no such name read the clock; a nested parameter of that name does not.
      "    boolean :nested() { const stamp = () => now().getTime(); function day() { return today().getTime() } return [1].map((now) => now + 1)[0] === 2 && stamp() === &n && day() <= &n }",
      "    boolean :cast() { return (now() as Date).getTime() === &n }",
      "  actions auto",
    ].join("\n"));
    const { root, built } = await generated(plain);
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const computed = built.document!.entities[0]!.computed;
    expect(computed.map((c) => [c.name, c.body?.plain?.clock])).toEqual([["outer", ["now"]], ["inner", undefined], ["nested", ["now", "today"]], ["cast", ["now"]]]);
    expect(checkTypes(root, ["generated/domain/task.expressions.ts", "generated/domain/task.types.ts"])).toEqual({ code: 0, output: "" });
    const { expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
    const at = { clock: () => new Date(86_400_000 * 2 + 5_000) };
    expect(expressions["computed.outer"](scope({ self: { n: 86_400_000 * 2 + 5_000 } }, at))).toBe(true);
    expect(expressions["computed.outer"](scope({ self: { n: 1 } }, at))).toBe(false);
    expect(expressions["computed.inner"](scope({ self: { n: 7 } }, at))).toBe(true);
    expect(expressions["computed.nested"](scope({ self: { n: 86_400_000 * 2 + 5_000 } }, at))).toBe(true);
  }, 30_000);

  test("a parameter default beside a body `var` of the same name binds no clock, so the type check refuses it", () => {
    // PR #65 round 2, N4. JavaScript gives `at = now()` the outer `now`, but Bun 1.3.14 and 1.4.2 throw "now is not defined"
    // whenever that binding is two or more functions up, as a printed function's clock always is. Binding no clock
    // keeps the failure at the type check (TS2304) instead of at run time; see `scopeNames`.
    const source = entity(check("() => true")).replace("  actions auto",
      "  computed\n    boolean :defaultVar() { function f(at = now()) { var now = 0; return [at, now] as const } return f()[0].getTime() > 0 }\n  actions auto");
    const built = build(source);
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(built.document!.entities[0]!.computed[0]!.body?.plain?.clock).toBeUndefined();
  });

  test("an imported now() is the import in plain and translated code alike: no clock is bound over it", async () => {
    // PR #65 round 2, F2: plain code bound the clock over the import while translated code called the import.
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-clock-import-"));
    roots.push(root);
    await writeFile(resolve(root, "clock.ts"), "export const now = (): Date => new Date(0);\n");
    const source = entity(check("() => &dueAt < now()")).replace("import { Task }", 'import { now } from "./clock"\nimport { Task }')
      .replace("  actions auto", "  computed\n    boolean :plainNow() { const at = now(); return at.getTime() === 0 }\n  actions auto");
    const built = buildModel({ root, files: [{ file: "task.mesh.mx", source }] });
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const entityOf = built.document!.entities[0]!;
    expect(entityOf.computed.find((c) => c.name === "plainNow")!.body?.plain?.clock).toBeUndefined();
    expect(entityOf.actions.find((a) => a.name === "go")!.validate[0]!.that.tree).toBeDefined();
    const config = configOf(root);
    await writeGeneratedFiles(await generateFiles({ document: built.document!, config }), config);
    await writeFile(resolve(root, "generated/schema.ts"), "export const tables = {};\n");
    const printed = await Bun.file(resolve(root, "generated/domain/task.expressions.ts")).text();
    expect(printed).toContain('import { now } from "../../clock"');
    expect(printed).not.toContain("const now = () => $.now($s)");
    const { expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
    // The bound clock says two days in; the import says the epoch. Both paths answer as the import does.
    const at = { clock: () => new Date(86_400_000 * 2) };
    expect(expressions["computed.plainNow"](scope({ self: {} }, at))).toBe(true);
    expect(expressions["go.check.c.that"](scope({ self: { dueAt: new Date(5) } }, at))).toBe(false);
    expect(expressions["go.check.c.that"](scope({ self: { dueAt: new Date(-5) } }, at))).toBe(true);
  });

  test("plain code that shadows a scope name declares no unused binding, and a class with a private member runs", async () => {
    const plain = (entity(check("() => true")) + [
      "      do",
      "        run ({ context }) { for (const input of [1, 2]) { console.log(input, context) } try { console.log(1) } catch (input) { console.log(input) } }",
      "        run ({ self }) { class C { #x = self.n; get() { return this.#x } } console.log(new C().get()) }",
      "",
    ].join("\n"));
    const { root, files } = await generated(plain);
    expect(checkTypes(root, ["generated/domain/task.expressions.ts", "generated/domain/task.types.ts"])).toEqual({ code: 0, output: "" });
    const { expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
    const logs: unknown[][] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { logs.push(args); };
    try {
      const keys = Object.keys(expressions).filter((k) => /^go\.step\.\d+\.run$/.test(k));
      expect(keys.length).toBe(2);
      for (const k of keys) await expressions[k](scope({ self: { n: 5 }, context: {} }));
    } finally { console.log = log; }
    expect(logs.at(-1)).toEqual([5]);
  }, 30_000);

  test("plain code runs with the authored meaning, `&` and atoms desugared", async () => {
    const { root } = await generated(source);
    const { expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
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
    // `before` lives in the steps (ACT-01): a `when` and a `set` value of an update.
    const steps = (body: string) => entity("").replace("      validate\n", "      do\n" + body);
    for (const body of ["        when=({ before }) => before.parent?.n > 1\n          set\n            &m=1\n", "        set\n          &m=({ before }) => before.parent?.n\n"]) {
      const found = build(steps(body)).diagnostics.filter((d) => d.code === "MESH_BEFORE_NOT_LOADED");
      expect(found, body).toHaveLength(1);
      expect(found[0]!.severity).toBe("error");
      expect(found[0]!.message).toContain("before.parent");
      expect(found[0]!.fix).toContain("&parent");
    }
    const computed = steps("        when=({ before }) => before.late\n          set\n            &m=1\n").replace("  actions auto", "  computed\n    boolean :late() { return &dueAt < today() }\n  actions auto");
    expect(codes(computed)).toContain("error:MESH_BEFORE_NOT_LOADED");
    expect(codes(steps("        when=({ before }) => before.n > 1\n          set\n            &m=1\n"))).toEqual([]);
  });
  test("plain code in details warns when it has an operator, and stays silent without one", () => {
    const withDetails = (details: string) => entity(check("() => &n > 0").replace("          message=", `          details=${details}\n          message=`));
    expect(codes(withDetails("({ input }) => ({ low: &title < \"b\", n: input.n })"))).toContain("warning:MESH_EXPR_PLAIN");
    expect(codes(withDetails("({ input }) => ({ v: input.n })"))).not.toContain("warning:MESH_EXPR_PLAIN");
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
  test("before in a create's steps is a build error at the node: in a when, in a set value, in a run parameter", () => {
    const create = (extra: string) => entity("").replace("      validate\n", "").replace("  actions auto=[:read]\n", `  actions auto=[:read]\n    create :make\n      input\n        &n\n${extra}`);
    expect(codes(create("      do\n        when=({ before }) => before.n > 0\n          set\n            &m=1\n"))).toContain("error:MESH_BEFORE_IN_CREATE");
    expect(codes(create("      do\n        set\n          &m=({ before }) => before.n\n"))).toContain("error:MESH_BEFORE_IN_CREATE");
    expect(codes(create("      do\n        run({ before }) { console.log(before) }\n"))).toContain("error:MESH_BEFORE_IN_CREATE");
    // In a check, `before` is gone altogether, and that is the error (not the create's).
    const inCheck = codes(create("      validate\n        check :c that=({ before }) => before.n > 0 code=\"c\" message=\"m\"\n"));
    expect(inCheck).toContain("error:MESH_VALIDATE_BEFORE");
    expect(inCheck).not.toContain("error:MESH_BEFORE_IN_CREATE");
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
  test("a details that reads before in a create reports MESH_VALIDATE_BEFORE once, and no MESH_BEFORE_IN_CREATE", () => {
    const create = (details: string) => entity("").replace("      validate\n", "").replace("  actions auto=[:read]\n", `  actions auto=[:read]\n    create :make\n      input\n        &n\n      validate\n        check :c [\n          that=({ input }) => input.n > 0\n          code="c"\n          message="m"\n          details=${details}\n        ]\n`);
    for (const details of ["({ before }) => ({ v: before.n })", "({ before }) => { return { v: before.n } }"]) {
      const found = build(create(details)).diagnostics;
      expect(found.filter((d) => d.code === "MESH_VALIDATE_BEFORE"), details).toHaveLength(1);
      expect(found.filter((d) => d.code === "MESH_BEFORE_IN_CREATE"), details).toHaveLength(0);
    }
  });
  describe("run after=:write (ADR-0068 decision 2)", () => {
    const make = (steps: string) => entity("").replace("      validate\n", "").replace("  actions auto=[:read]\n", `  actions auto=[:read]\n    create :make\n      input\n        &n\n      do\n${steps}`);
    const at = (source: string, offset: number) => {
      const before = source.slice(0, offset).split("\n");
      return { line: before.length, column: before.at(-1)!.length, offset };
    };
    test("builds a run step that runs after the write, and leaves a plain run before it", () => {
      const result = build(make("        run ({ self }) { console.log(self) }\n        run [after=:write] ({ self }) { console.log(self) }\n"));
      expect(result.diagnostics).toEqual([]);
      expect(result.document!.entities[0]!.actions.find((a) => a.name === "make")!.do.map((s) => s.kind === "run" ? s.after ?? "before" : s.kind)).toEqual(["before", "write"]);
    });
    test("inside a when, the step still runs after the write", () => {
      const result = build(make("        when=() => &n > 0\n          run [after=:write] ({ self }) { console.log(self) }\n"));
      expect(result.diagnostics).toEqual([]);
      const when = result.document!.entities[0]!.actions.find((a) => a.name === "make")!.do[0]!;
      expect(when.kind === "when" && when.steps[0]).toMatchObject({ kind: "run", after: "write" });
    });
    test("an atom other than :write is an error at the value that lists the one allowed", () => {
      const source = make("        run [after=:read] ({ self }) { console.log(self) }\n");
      const d = build(source).diagnostics;
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({ severity: "error", message: expect.stringContaining("`:read` is not one of :write") });
      expect(d[0]!.position).toMatchObject(at(source, source.indexOf("after=:read") + "after=".length));
    });
    test("a string is an error at the value: the value is an atom", () => {
      const source = make('        run [after="write"] ({ self }) { console.log(self) }\n');
      const d = build(source).diagnostics;
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({ severity: "error", message: expect.stringContaining("attribute `after` must be atom, got string (one of :write)") });
      expect(d[0]!.position).toMatchObject(at(source, source.indexOf('"write"')));
    });
    test("only a run takes after: on set, load or when it is an error at the attribute", () => {
      for (const [step, message] of [
        ["        set [after=:write]\n          &n=1\n", "`<set>`: accepts no attributes"],
        ["        load [after=:write] &parent\n", "`<load>`: unknown attribute `after`"],
        ["        when [after=:write value=() => true]\n          run () { }\n", "`<when>`: unknown attribute `after`"],
      ] as const) {
        const source = make(step);
        const d = build(source).diagnostics.filter((x) => x.severity === "error");
        expect(d, step).toHaveLength(1);
        expect(d[0]!.message, step).toContain(message);
        expect(d[0]!.position, step).toMatchObject(at(source, source.indexOf("after=")));
      }
      // A check is not a step: it sits in validate, and after is unknown there too.
      const check = entity("        check :c [\n          that=() => true\n          after=:write\n          code=\"c\"\n          message=\"m\"\n        ]\n");
      expect(build(check).diagnostics.map((d) => [d.severity, d.position.offset])).toEqual([["error", check.indexOf("after=")]]);
    });
    test("the method after the attribute group is one value: no duplicate warning, while a duplicate the author wrote still warns", () => {
      expect(build(make("        run [after=:write] ({ self }) { console.log(self) }\n")).diagnostics).toEqual([]);
      const twice = make("        run [after=:write after=:write] ({ self }) { console.log(self) }\n");
      expect(build(twice).diagnostics).toMatchObject([{ severity: "warning", message: expect.stringContaining("duplicate attribute `after`"), position: at(twice, twice.indexOf("after=")) }]);
    });
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

describe("validate sees self before the input (ACT-01, ACT-27, POL-08)", () => {
  // A required attribute with no default (`n`), one with a default (`state`), a nullable one (`m`) and a required belongs-to (`owner`).
  const item = (actions: string, key = "uuid :id primary-key") => `entity :Item
  attributes
    ${key}
    integer :n
    integer :m nullable
    enum :state values=[:open, :done] default=:open
  relationships
    belongs-to :owner entity=Item
  actions auto=[:read]
${actions}`;
  const make = (body: string, input = "        &n\n        &owner\n") => `    create :make\n      input\n${input}${body}`;
  const go = (body: string) => `    update :go\n      input\n        &n\n        &m\n${body}`;
  const checkOf = (that: string, extra = "") => `      validate\n        check :c [\n          that=${that}\n          code="c"\n          message="m"\n${extra}        ]\n`;
  const all = (source: string) => buildModel({ root: "/p", files: [{ file: "item.mesh.mx", source }] }).diagnostics;
  const codesOf = (source: string) => all(source).map((d) => `${d.severity}:${d.code}`);

  describe("before in a check is MESH_VALIDATE_BEFORE", () => {
    test("in that, when and details, on an update, a create, a destroy and an always block, at the node", () => {
      const cases: [string, string][] = [
        ["update that", item(go(checkOf("({ before }) => before.n > 0")))],
        ["update when", item(go(checkOf("() => &n > 0", "          when=({ before }) => before.n > 0\n")))],
        ["update details", item(go(checkOf("() => &n > 0", "          details=({ before }) => ({ was: before.n })\n")))],
        ["create that", item(make(checkOf("({ before }) => before === null")))],
        ["destroy that", item(`    destroy :drop\n${checkOf("({ before }) => before.n > 0")}`)],
        ["always", item(`    always types=[:update]\n${checkOf("({ before }) => before.n > 0")}${go("")}`)],
      ];
      for (const [name, source] of cases) {
        const found = all(source).filter((d) => d.code === "MESH_VALIDATE_BEFORE");
        expect(found, name).toHaveLength(1);
        expect(found[0]!.severity).toBe("error");
        // At the `before` that is read, not at the whole function.
        expect(source.slice(found[0]!.position.offset, found[0]!.position.offset + 6), name).toBe("before");
        expect(source.slice(found[0]!.position.offset - 4, found[0]!.position.offset), name).not.toBe("({ ");
      }
    });
    test("the message says before is gone, what self is, and where the caller's values are", () => {
      const [found] = all(item(go(checkOf("({ before }) => before.n > 0")))).filter((d) => d.code === "MESH_VALIDATE_BEFORE");
      expect(found!.message).toContain("`before` is gone from `validate`");
      expect(found!.message).toContain("`self` is the record before the input is applied");
      expect(found!.message).toContain("`input.x`");
      expect(found!.fix).toContain("`input.x ?? &x`");
    });
    test("a plain check, one that only destructures it, and one that reaches it through a rest are errors too, once each", () => {
      for (const that of ["({ before }) => { return before.n > 0 }", "({ before }) => true", "({ input, ...rest }) => { return rest.before.n > input.n }"]) {
        const found = all(item(go(checkOf(that)))).filter((d) => d.code === "MESH_VALIDATE_BEFORE");
        expect(found, that).toHaveLength(1);
        expect(found[0]!.message, that).toContain("check :c (that) reads `before`");
      }
    });
    test("before in the steps of an update, a destroy or an always block over updates is still fine", () => {
      expect(codesOf(item(go("      do\n        when=({ before }) => before.n > 0\n          set\n            &m=({ before }) => before.n\n        run [after=:write] ({ before }) { console.log(before.n) }\n")))).toEqual([]);
      expect(codesOf(item(`    destroy :drop\n      do\n        run({ before }) { console.log(before.n) }\n`))).toEqual([]);
      expect(codesOf(item(`    always types=[:update]\n      do\n        when=({ before }) => before.n > 0\n          set\n            &m=1\n${go("")}`))).toEqual([]);
    });
  });

  describe("on a create, self in a check is the new instance", () => {
    const only = (code: string) => (source: string) => all(source).filter((d) => d.code === code);
    const notApplied = only("MESH_VALIDATE_NOT_APPLIED");
    const unfilled = only("MESH_VALIDATE_UNFILLED");
    // A create that takes `&n` (required, no default), `&m` (nullable), `&state` (with a default) and `&owner`.
    const takesAll = "        &n\n        &m\n        &state\n        &owner\n";
    // A create that takes only `&owner`, and fills `n` with a step.
    const setsN = (body: string) => make(body + "      do\n        set\n          &n=1\n", "        &owner\n");

    test("&x the create takes is a MESH_VALIDATE_NOT_APPLIED warning at the member, whatever x is: required, nullable, defaulted or a relationship", () => {
      const cases: [string, string][] = [
        ["() => &n > 0", "&n"], ["() => &n !== 5", "&n"], ["() => &m === null", "&m"], ["() => &state === :open", "&state"],
        ["() => &owner.n > 0", "&owner"], ["() => &owner?.n === null", "&owner"], ["({ input }) => (input.m ?? &n) > 0", "&n"],
      ];
      for (const [that, member] of cases) {
        const source = item(make(checkOf(that), takesAll));
        const found = notApplied(source);
        expect(found, that).toHaveLength(1);
        expect(found[0]!.severity, that).toBe("warning");
        expect(source.slice(found[0]!.position.offset, found[0]!.position.offset + member.length), that).toBe(member);
        // One warning for one mistake: not also the null rules that follow from it, and no error.
        expect(codesOf(source), that).toEqual(["warning:MESH_VALIDATE_NOT_APPLIED"]);
      }
      const [found] = notApplied(item(make(checkOf("() => &m === null"), takesAll)));
      expect(found!.message).toBe("on a create, `&m` here is the new instance's value before the input is applied (its default, or null), not the caller's: `validate` sees `self` before the input");
      expect(found!.fix).toBe("write `input.m` for the caller's value, or `input.m ?? &m` for the value the action will store; on an update this changes the meaning (`input.m ?? &m` is the value being sent, `&m` the stored one), so in a check that also runs on updates and means the stored value, keep `&m`");
      // In `when` and in `details` too.
      expect(codesOf(item(make(checkOf("() => true", "          when=() => &n > 0\n"), takesAll)))).toEqual(["warning:MESH_VALIDATE_NOT_APPLIED"]);
      expect(codesOf(item(make(checkOf("() => true", "          details=() => ({ n: &n })\n"), takesAll)))).toEqual(["warning:MESH_VALIDATE_NOT_APPLIED"]);
    });

    test("a check Mesh runs as plain code is held to the same rule, through the `&x` its text reads", () => {
      const cases: [string, string][] = [
        ["({ input }) => { return &n === input.n }", "&n"],
        ["({ input }) => { return (input.m ?? &n) > 0 }", "&n"],
        ["({ input }) => {\n            const n = input.n;\n            return &owner === null || n > 0;\n          }", "&owner"],
      ];
      for (const [that, member] of cases) {
        const source = item(make(checkOf(that), takesAll));
        const found = notApplied(source);
        expect(found, that).toHaveLength(1);
        expect(source.slice(found[0]!.position.offset, found[0]!.position.offset + member.length), that).toBe(member);
        const line = source.slice(0, found[0]!.position.offset).split("\n");
        expect([found[0]!.position.line, found[0]!.position.column], that).toEqual([line.length, line.at(-1)!.length]);
      }
      for (const that of ["({ input }) => { return (input.n ?? &n) > 0 }", "({ input, self }) => { return input.n > 0 && self.id !== \"\" }", "({ input }) => { return &id !== input.state }"])
        expect(notApplied(item(make(checkOf(that), takesAll))), that).toEqual([]);
      expect(notApplied(item(go(checkOf("({ input }) => { return &n === input.n }"))))).toEqual([]);
    });

    test("input.x, input.x ?? &x, a member the create does not take, an update and a step are fine", () => {
      for (const that of ["({ input }) => input.n > 0", "({ input }) => (input.n ?? &n) > 0", "({ input }) => (input.m ?? &m) === null", "({ input }) => (input.state ?? &state) === :open", "() => &id !== \"\""])
        expect(codesOf(item(make(checkOf(that), takesAll))), that).toEqual([]);
      expect(codesOf(item(make(checkOf("() => &state === :open"))))).toEqual([]);
      expect(codesOf(item(go(checkOf("() => &n > 0 && &m === null"))))).toEqual([]);
      expect(codesOf(item(make("      do\n        when=() => &n > 0 && &owner.n > 0\n          set\n            &m=1\n", takesAll)))).toEqual([]);
    });

    test("an operator over a required member no input fills yet is a MESH_VALIDATE_UNFILLED warning at the member: in that the check fails when the result depends on it, in when it is skipped, in details the value is null", () => {
      for (const that of ["() => &n !== 5", "() => &n > 0", "() => &n === 5", "() => &n + 1 > 0", "({ input }) => input.owner !== \"\" && &n > 0", "() => (&n > 0 ? 1 : 2) > 0"]) {
        const source = item(setsN(checkOf(that)));
        const found = unfilled(source);
        expect(found, that).toHaveLength(1);
        expect(found[0]!.severity, that).toBe("warning");
        expect(source.slice(found[0]!.position.offset, found[0]!.position.offset + 2), that).toBe("&n");
        expect(all(source).filter((d) => d.severity === "error"), that).toEqual([]);
      }
      // A bare read of a boolean no input fills is the same.
      expect(codesOf(item(make(checkOf("() => &b"), "        &n\n        &owner\n")).replace("integer :n\n", "integer :n\n    boolean :b\n"))).toEqual(["warning:MESH_VALIDATE_UNFILLED"]);
      const [found] = unfilled(item(setsN(checkOf("() => &n > 0"))));
      expect(found!.message).toBe("`&n` is null on every create here: `validate` sees the new instance before the input is applied, so a result that depends on it is unknown and the check fails");
      expect(found!.fix).toBe("write `input.n ?? &n` for the value the action will store, or `input.n` for the caller's");
      // In `when` the condition is unknown, and an unknown `when` skips the check (`runCheck`): it never runs on a create.
      for (const when of ["() => &n > 0", "() => &b"]) {
        const source = item(setsN(checkOf("() => true", `          when=${when}\n`))).replace("integer :n\n", "integer :n\n    boolean :b\n");
        const [inWhen] = unfilled(source);
        expect(codesOf(source), when).toEqual(["warning:MESH_VALIDATE_UNFILLED"]);
        expect(inWhen!.message, when).toBe(`\`${when.slice(6, 8)}\` is null on every create here: \`validate\` sees the new instance before the input is applied, so a result that depends on it is unknown and the check is skipped`);
      }
      // Not decisive: `&n > 0 || true` is true whatever `&n` is. The wording says "a result that depends on it", true here too.
      expect(unfilled(item(setsN(checkOf("() => &n > 0 || true"))))[0]!.message).toBe(found!.message);
      // In `details` it is only a null value.
      expect(unfilled(item(setsN(checkOf("() => true", "          details=() => ({ more: &n + 1 })\n"))))[0]!.message).toEndWith("so a result that depends on it is unknown and the details value is null");
      // A null test, `??`, `?:` branches, an update and a member with a default are fine.
      for (const that of ["() => &n === null", "() => &n !== null", "() => (&n ?? 0) > 0", "({ input }) => (input.owner === \"\" ? &n : 1) === 1"])
        expect(unfilled(item(setsN(checkOf(that)))), that).toEqual([]);
      expect(codesOf(item(go(checkOf("() => &n > 0"))))).toEqual([]);
      expect(codesOf(item(setsN(checkOf("() => &state === :open"))))).toEqual([]);
    });

    test("a required relationship no input fills is not there yet: reading through it is an error that says so, ?. is fine, and a step can read it", () => {
      const setsOwner = (body: string) => make(body + "      do\n        set\n          &owner=({ actor }) => actor.id\n", "        &n\n");
      const source = item(setsOwner(checkOf("() => &owner.n > 0")));
      const found = all(source).filter((d) => d.code === "MESH_EXPR_NULLABLE_ACCESS");
      expect(found).toHaveLength(1);
      expect(found[0]!.message).toContain("`&owner`, which is null on a create here");
      expect(found[0]!.fix).toContain("`input.owner`");
      expect(found[0]!.fix).toMatch(/a related record through `privileged\(\w+\)\.read`/);
      expect(found[0]!.position.offset).toBe(source.indexOf("&owner.n > 0"));
      expect(codesOf(item(setsOwner(checkOf("() => &owner?.n === null"))))).toEqual([]);
      expect(codesOf(item(setsOwner("") + "      do\n        when=() => &owner.n > 0\n          set\n            &m=1\n").replace("      do\n        when", "        when"))).toEqual([]);
      expect(codesOf(item(go(checkOf("() => &owner.n > 0"))))).toEqual([]);
    });

    test("an always block over creates and updates: &x a create takes is a warning, input.x ?? &x is not when every create takes &x", () => {
      const always = (that: string, makeInput = "        &n\n        &owner\n", makeBody = "") =>
        item(`    always types=[:create, :update]\n${checkOf(that)}${make(makeBody, makeInput)}${go("")}`);
      expect(codesOf(always("() => &n !== 5"))).toEqual(["warning:MESH_VALIDATE_NOT_APPLIED"]);
      expect(codesOf(always("({ input }) => (input.n ?? &n) !== 5"))).toEqual([]);
      // A create that fills n with a step, not from the input: there the check sees null, so the value may be unknown...
      expect(codesOf(always("({ input }) => (input.n ?? &n) !== 5", "        &owner\n", "      do\n        set\n          &n=1\n"))).toEqual(["warning:MESH_EXPR_NEGATED_UNKNOWN"]);
      // ...and reading &n alone fails every create.
      expect(codesOf(always("() => &n > 5", "        &owner\n", "      do\n        set\n          &n=1\n"))).toEqual(["warning:MESH_VALIDATE_UNFILLED"]);
      // An always block over updates only sees stored records.
      expect(codesOf(item(`    always types=[:update]\n${checkOf("() => &n !== 5")}${make("")}${go("")}`))).toEqual([]);
    });

    test("a check over creates and updates that means the stored value builds with the warning and no error: the fix says `??` changes the meaning on an update", () => {
      // On a create `&state` is the default (`:open`), on an update the stored state: refusing an edit of a done item is correct code.
      const source = item(`    always types=[:create, :update]\n${checkOf("() => &state !== :done")}${make("", "        &n\n        &state\n        &owner\n")}    update :go\n      input\n        &state\n`);
      const built = buildModel({ root: "/p", files: [{ file: "item.mesh.mx", source }] });
      expect(built.diagnostics.map((d) => `${d.severity}:${d.code}`)).toEqual(["warning:MESH_VALIDATE_NOT_APPLIED"]);
      expect(built.document).toBeDefined();
      expect(built.diagnostics[0]!.fix).toContain("on an update this changes the meaning (`input.state ?? &state` is the value being sent, `&state` the stored one)");
    });
  });

  describe("an integer key is null on a create until the write", () => {
    const counter = (actions: string) => item(actions, "integer :seq primary-key");
    test("a step before the write sees it null; a step after the write and an update's step see it set", () => {
      expect(codesOf(counter(make("      do\n        set\n          &n=() => &seq\n", "        &owner\n")))).toContain("error:MESH_EXPR_NULL_TO_REQUIRED");
      expect(codesOf(counter(make("      do\n        set\n          &n=() => &seq ?? 0\n", "        &owner\n")))).toEqual([]);
      expect(codesOf(counter(go("      do\n        set\n          &n=() => &seq\n")))).toEqual([]);
      expect(codesOf(counter(make("      do\n        run [after=:write] ({ self }) { console.log(self.seq) }\n")))).toEqual([]);
    });
    test("a uuid key is filled when the instance is built, so it is never null", () => {
      expect(codesOf(item(make(checkOf("() => &id !== \"\""))))).toEqual([]);
    });
  });

  describe("the generated scope types", () => {
    async function generated(source: string) {
      const root = await mkdtemp(resolve(import.meta.dir, "../mesh-act27-"));
      roots.push(root);
      const built = buildModel({ root, files: [{ file: "item.mesh.mx", source }] });
      expect(built.diagnostics).toEqual([]);
      const config = configOf(root);
      const files = await generateFiles({ document: built.document!, config });
      await writeGeneratedFiles(files, config);
      await writeFile(resolve(root, "generated/schema.ts"), "export const tables = { item: {} };\n");
      return { root, files, text: files.find((f) => f.path.endsWith("item.expressions.ts"))!.contents };
    }
    // Prettier lays the types out over several lines; compare them without whitespace or semicolons.
    const squash = (text: string) => text.replace(/[\s;]+/g, "");
    const signature = (text: string, id: string) => new RegExp(`"${id.replaceAll(".", "\\.")}": (?:async )?\\(\\$s: (\\w+)<`).exec(text)?.[1];
    test("checks, steps and runs after the write each get the scope that says what self is there; the files type-check", async () => {
      const source = item(`    always types=[:create, :update]\n${checkOf("({ input }) => (input.n ?? &n) > 0")}`
        + make(checkOf("({ input }) => input.n > 0") + "      do\n        set\n          &m=() => &n\n        run [after=:write] ({ self }) { console.log(self.id) }\n")
        + go(checkOf("() => &n > 0") + "      do\n        set\n          &m=({ before }) => before.n\n"));
      const { root, text, files } = await generated(source);
      expect(signature(text, "always.0.check.c.that")).toBe("ItemNewScope");
      expect(signature(text, "make.check.c.that")).toBe("ItemNewScope");
      expect(signature(text, "go.check.c.that")).toBe("ItemCheckScope");
      expect(signature(text, "make.step.0.set.m")).toBe("ItemScope");
      expect(signature(text, "make.step.1.run")).toBe("ItemScope");
      expect(signature(text, "go.step.0.set.m")).toBe("ItemStoredScope");
      expect(squash(text)).toContain(squash('export type ItemCheckScope<I = unknown> = Omit<ItemScope<I>, "before">;'));
      expect(squash(text)).toContain(squash('export type ItemNewScope<I = unknown> = Omit<ItemCheckScope<I>, "self"> & { self: $DeepReadonly<Omit<ItemLoaded, "n" | "ownerId" | "owner"> & { [K in "n" | "ownerId" | "owner"]: ItemLoaded[K] | null }> };'));
      expect(text).not.toContain("ItemCreateScope");
      await writeFile(resolve(root, "check.ts"), `import type { ItemCheckScope, ItemNewScope } from "./generated/domain/item.expressions";
declare const check: ItemCheckScope<unknown>;
declare const fresh: ItemNewScope<unknown>;
export const stored: number = check.self.n;
// @ts-expect-error a check has no before
export const gone = check.before;
// @ts-expect-error on a create, n is null until the input is applied
export const notYet: number = fresh.self.n;
export const maybe: number | null = fresh.self.n;
export const id: string = fresh.self.id;
export const state: "open" | "done" = fresh.self.state;
`);
      const paths = files.map((f) => f.path).filter((path) => path.endsWith(".ts") && !path.endsWith("index.ts") && !path.endsWith("binding.ts"));
      expect(checkTypes(root, [...paths, "generated/schema.ts", "check.ts"])).toEqual({ code: 0, output: "" });
    }, 30_000);
    test("a computed field that reads a member the new instance has not filled is null there, in the type: directly, through another computed field or through a relationship; the others keep their type", async () => {
      const computed = "  computed\n    integer :double() { return &n * 2 }\n    integer :twice() { return &double + 1 }\n    integer :viaOwner() { return &owner.n }\n    boolean :isUnset() { return &n === null }\n    integer :orZero() { return &n ?? 0 }\n    integer :orSelf() { return &n ?? &double }\n    boolean :isOpen() { return &state === :open }\n    integer :plain({ self }) { const q = self.n; return q + 1 }\n  actions auto=[:read]";
      const source = item(make(checkOf("({ input }) => input.n > 0")) + go("")).replace("  actions auto=[:read]", computed);
      const { root, text, files } = await generated(source);
      expect(squash(text).replace(":|", ":")).toContain(squash('self: $DeepReadonly<Omit<ItemLoaded, "n" | "ownerId" | "owner" | "double" | "twice" | "viaOwner" | "orSelf"> & { [K in "n" | "ownerId" | "owner" | "double" | "twice" | "viaOwner" | "orSelf"]: ItemLoaded[K] | null }>'));
      await writeFile(resolve(root, "check.ts"), `import type { ItemNewScope, ItemScope } from "./generated/domain/item.expressions";
declare const fresh: ItemNewScope<unknown>;
declare const stored: ItemScope<unknown>;
export const nullDouble: number | null = fresh.self.double;
export const nullTwice: number | null = fresh.self.twice;
export const nullViaOwner: number | null = fresh.self.viaOwner;
// @ts-expect-error double reads n, which is null until the input is applied
export const notYet: number = fresh.self.double;
// @ts-expect-error twice reads double
export const notYetTwice: number = fresh.self.twice;
// @ts-expect-error viaOwner reads owner
export const notYetOwner: number = fresh.self.viaOwner;
// isNull is never unknown, and ?? with a literal fallback is never null; ?? of two operands that can both be null is
export const unset: boolean = fresh.self.isUnset;
export const orZero: number = fresh.self.orZero;
// @ts-expect-error orSelf reads n and double, both null on a create
export const notYetOrSelf: number = fresh.self.orSelf;
export const open: boolean = fresh.self.isOpen;
export const plain: number = fresh.self.plain;
export const set: number = stored.self.double;
`);
      const paths = files.map((f) => f.path).filter((path) => path.endsWith(".ts") && !path.endsWith("index.ts") && !path.endsWith("binding.ts"));
      expect(checkTypes(root, [...paths, "generated/schema.ts", "check.ts"])).toEqual({ code: 0, output: "" });
    }, 30_000);
    test("an integer key: a create's steps before the write get ItemCreateScope, where the key may be null", async () => {
      const source = item(make(checkOf("() => &seq === null") + "      do\n        set\n          &m=() => &seq ?? 0\n        run [after=:write] ({ self }) { console.log(self.seq + 1) }\n"), "integer :seq primary-key");
      const { root, text, files } = await generated(source);
      expect(signature(text, "make.check.c.that")).toBe("ItemNewScope");
      expect(signature(text, "make.step.0.set.m")).toBe("ItemCreateScope");
      expect(signature(text, "make.step.1.run")).toBe("ItemScope");
      expect(squash(text)).toContain(squash('export type ItemCreateScope<I = unknown> = Omit<ItemScope<I>, "self"> & { self: $DeepReadonly<Omit<ItemLoaded, "seq"> & { [K in "seq"]: ItemLoaded[K] | null }> };'));
      await writeFile(resolve(root, "check.ts"), `import type { ItemCreateScope, ItemScope } from "./generated/domain/item.expressions";
declare const creating: ItemCreateScope<unknown>;
declare const written: ItemScope<unknown>;
// @ts-expect-error the integer key is null until the data layer writes the row
export const notYet: number = creating.self.seq;
export const after: number = written.self.seq;
`);
      const paths = files.map((f) => f.path).filter((path) => path.endsWith(".ts") && !path.endsWith("index.ts") && !path.endsWith("binding.ts"));
      expect(checkTypes(root, [...paths, "generated/schema.ts", "check.ts"])).toEqual({ code: 0, output: "" });
    }, 30_000);
  });
});

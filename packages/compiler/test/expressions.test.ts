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
import { Mesh } from "meshfw"
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
    expect(exprOf(entity(check("() => &dueAt < %.now"))).tree).toMatchObject({ fn: "lt", args: [{}, { fn: "now", args: [] }] });
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
    const source = entity(check("() => true")).replace("  actions auto", "  computed\n    boolean :late() { return &dueAt < %.today }\n  actions auto");
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
  test("parameters, quantifier parameters, locals, globals, the transaction's %.now and the Mesh import are not free", () => {
    const read = codes(entity(check("({ input, context }) => &children.some((c) => c.n > 1) && %.now > input.x && !Mesh.isSystem(context)")));
    expect(read.filter((code) => code.startsWith("error:"))).toEqual([]);
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
      const that = `({ actor }) => &children.some((${name}) => ${name}.dueAt < %.now && ${name}.id === actor.id)`;
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
    // `before` is null in a create (the docs: "the stored record, null on a create"): it builds, and a member read through it is nullable.
    expect(codes(withAlways("make"))).toEqual(["error:MESH_EXPR_NULLABLE_ACCESS"]);
  });
  test("a function that calls Mesh.privileged or an entity's action builds as plain code, and records what it names", () => {
    expect(codes(entity(check("() => Mesh.privileged(Task) !== null && &n > 0")))).toEqual([]);
    expect(exprOf(entity(check("() => Mesh.privileged(Task) !== null && &n > 0"))).plain).toMatchObject({ why: "uses-privileged", roots: [], internal: { self: "$self" }, privileged: true, entities: ["Task"], mesh: ["Mesh"] });
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
  test("Mesh.privileged takes the file's own entity or an imported one, named, else MESH_PRIVILEGED_ENTITY at the argument", () => {
    for (const that of ["() => Mesh.privileged(input) !== null", '() => Mesh.privileged("Task") !== null', "({ self: Task }) => Mesh.privileged(Task) !== null", "() => Mesh.privileged(Other) !== null"]) {
      const source = entity(check(that));
      const found = build(source).diagnostics.filter((d) => d.code === "MESH_PRIVILEGED_ENTITY");
      expect(found, that).toHaveLength(1);
      const argument = that.slice(that.indexOf("privileged(") + "privileged(".length);
      expect(found[0]!.position.offset, that).toBe(source.indexOf(that) + that.indexOf(argument));
    }
    const wrong = build(entity(check("() => Mesh.privileged(input) !== null"))).diagnostics.find((d) => d.code === "MESH_PRIVILEGED_ENTITY")!;
    expect(wrong.message).toBe("`Mesh.privileged()` takes an entity this file names, its own or an imported one, and `input` is not one");
    expect(wrong.fix).toBe("write `Mesh.privileged(Task)`, naming the entity, and import it when it is another file's");
    expect(codes(entity(check("() => Mesh.privileged() !== null")))).toContain("error:MESH_EXPR_ARITY");
    const arity = build(entity(check("() => Mesh.privileged() !== null"))).diagnostics.find((d) => d.code === "MESH_EXPR_ARITY")!;
    expect(arity.message).toBe("`Mesh.privileged()` takes 1 argument, and this call passes 0");
    expect(arity.fix).toBe("write `Mesh.privileged(Task)`");
    // A function that takes `Mesh` as its own parameter calls that, not Mesh's.
    expect(codes(entity(check("({ context: Mesh }) => Mesh.privileged(1) !== null")))).not.toContain("error:MESH_PRIVILEGED_ENTITY");
  });
  test("a function that destructures `tx` or `actions` from its scope is MESH_REMOVED_SCOPE_NAME at the name, saying what replaces it (TXN-16)", () => {
    const tx = { message: "`tx` is gone: a function in an entity file is no longer handed a transaction handle, and reads with no policy through `Mesh.privileged`", fix: "write `Mesh.privileged(<Entity>).<read>(input)`, naming the entity (import it when it is another file's) and importing `Mesh` from \"meshfw\"; it joins the running transaction" };
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
  test("a computed field that calls Mesh.privileged or an entity's action is a build error: it is worked out outside any action", () => {
    const computed = (body: string) => entity(check("() => true")).replace("  actions auto", `  computed\n    boolean :c${body}\n  actions auto`);
    for (const [body, reaches] of [["() { return Mesh.privileged(Task) !== null }", "calls `Mesh.privileged`"], ["() { return Task.go({}) !== null }", "calls an entity's action"], ["({ self }) { return Mesh.privileged(Task).read({ filter: { id: self.id } }) }", "calls `Mesh.privileged`"]] as const) {
      const source = computed(body);
      const d = build(source).diagnostics.filter((x) => x.code === "MESH_COMPUTED_COMPOSES");
      expect(d, body).toHaveLength(1);
      expect(d[0]!.message).toBe(`computed :c of Task ${reaches}, which only a function that runs inside an action may: a computed field is worked out whenever a record is loaded, outside any action`);
      expect(d[0]!.position.offset, body).toBe(source.indexOf(body));
    }
    // A string or a property that spells the name is not a call.
    expect(codes(computed('() { return { privileged: "Task" }.privileged === "x" }'))).not.toContain("error:MESH_COMPUTED_COMPOSES");
  });
  test("an async computed body, or one that awaits, is a build error at the body: a computed field is synchronous", () => {
    const computed = (body: string) => entity(check("() => true")).replace("  actions auto", `  computed\n    boolean :c${body}\n  actions auto`);
    const message = (how: string) => `computed :c of Task ${how}: a computed field is synchronous, and reads only its record and what it loads`;
    const cases: [body: string, at: string, how: string][] = [
      [" async () { return &n > 0 }", "async ()", "is `async`"], // translated otherwise
      ["=async () => &n > 0", "async ()", "is `async`"],
      ["=async function () { return &n > 0 }", "async function", "is `async`"],
      ["() { return await Promise.resolve(&n > 0) }", "() {", "uses `await`"],
      ["() { for await (const x of []) void x; return true }", "() {", "uses `await`"],
    ];
    for (const [body, at, how] of cases) {
      const source = computed(body);
      const d = build(source).diagnostics.filter((x) => x.code === "MESH_COMPUTED_ASYNC");
      expect(d, body).toHaveLength(1);
      expect(d[0], body).toMatchObject({ severity: "error", message: message(how) });
      expect(d[0]!.fix, body).toBe("Compute it from the record, its relationships and other computed fields; a read through `Mesh.privileged` or anything else that awaits belongs in a step or a check");
      expect(d[0]!.position.offset, body).toBe(source.indexOf(at, source.indexOf("boolean :c")));
      expect(build(source).document, body).toBeNull();
    }
    // An async function nested in the body is the body's own business, and a synchronous body is fine.
    for (const body of ["() { const f = async () => await 1; void f; return true }", "() { return &n > 0 }", "() { return [1].some((x) => x > 0) }"])
      expect(codes(computed(body)), body).not.toContain("error:MESH_COMPUTED_ASYNC");
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
    // An awaited helper (one that reads through `Mesh.privileged`, say) makes the function plain, with no warning for the await.
    const awaited = build("async ({ input }) => (await big(input.n)) === true");
    expect(awaited.document!.entities[0]!.actions[0]!.validate[0]!.that.plain).toMatchObject({ why: "awaits-helper", helpers: ["big"] });
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
    "        check :late [\n          that=() => &dueAt < %.now\n          code=\"late\"\n          message=\"m\"\n        ]\n",
    "",
  ).replace("  actions auto", "  computed\n    boolean :overdue() { return &dueAt < %.today }\n    string :label({ self }) { return `${self.n}:${self.title}` }\n  actions auto");

  test("the generated file type-checks under the strict flags", async () => {
    const { root, files } = await generated(source);
    expect(files.map((f) => f.path)).toContain("generated/domain/task.expressions.ts");
    expect(checkTypes(root, ["generated/domain/task.expressions.ts", "generated/domain/task.types.ts"])).toEqual({ code: 0, output: "" });
  }, 30_000);

  test("quantifiers evaluate on loaded rows, unknown included (test 3)", async () => {
    const { root } = await generated(source);
    const { $expressions: expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
    const f = expressions["go.check.c.that"] as (s: unknown) => unknown;
    const run = (children: unknown) => f(scope({ self: { children } }));
    expect(run([{ state: "done", n: 2 }, { state: "done", n: 0 }])).toBe(true);
    expect(run([{ state: "done", n: 2 }, { state: "open", n: 5 }])).toBe(false);
    expect(run([])).toBe(false); // every is true, some is false
    expect(run([{ state: null, n: 5 }])).toBe(false); // an unknown predicate makes every false
    expect(() => run(undefined)).toThrow("not loaded");
  });

  test("%.now is the injected clock (test 4)", async () => {
    const { root } = await generated(source);
    const { $expressions: expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
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
    const { $expressions: expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
    expect(expressions["computed.c"](scope({ self: { n: 1 } }))).toBe(true);
  }, 30_000);

  test("%.now and %.today in plain code read the injected clock, as in a translated expression, with no Mesh import; a local Mesh's now is the author's", async () => {
    const plain = entity(check("() => true")).replace("  actions auto", "  computed\n    boolean :stamped() { return Math.floor(%.now.getTime() / 1000) === &n }\n    boolean :daily() { return [%.today].some((d) => d.getTime() === &n) }\n    boolean :own() { const Mesh = { now: () => 7 }; return Mesh.now() === &n }\n  actions auto");
    const { root, built, files } = await generated(plain);
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const computed = built.document!.entities[0]!.computed;
    expect(computed.map((c) => c.body?.plain?.clock)).toEqual([["now"], ["today"], undefined]);
    expect(computed.map((c) => c.body?.plain?.mesh)).toEqual([undefined, undefined, undefined]);
    // `%.now` is the scope's instant, the function a translated expression calls, bound under a name the authored text
    // does not spell; the file binds and imports no `Mesh`.
    const printed = files.find((f) => f.path.endsWith("task.expressions.ts"))!.contents;
    expect(printed).toContain("const $now = () => $.now($s);");
    expect(printed).toContain("Math.floor($now().getTime() / 1000) === $self.n");
    expect(printed).toContain("const $today = () => $.today($s);");
    expect(printed).toContain("[$today()].some(");
    expect(printed).not.toMatch(/\bMesh,|Mesh as|meshIn|\$mesh/);
    expect(checkTypes(root, ["generated/domain/task.expressions.ts", "generated/domain/task.types.ts"])).toEqual({ code: 0, output: "" });
    const { $expressions: expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
    const at = { clock: () => new Date(86_400_000 * 2 + 5_000) };
    expect(expressions["computed.stamped"](scope({ self: { n: 86_400 * 2 + 5 } }, at))).toBe(true);
    expect(expressions["computed.stamped"](scope({ self: { n: 1 } }, at))).toBe(false);
    expect(expressions["computed.daily"](scope({ self: { n: 86_400_000 * 2 } }, at))).toBe(true);
    expect(expressions["computed.own"](scope({ self: { n: 7 } }, at))).toBe(true);
  }, 30_000);

  test("&name, %.now and %.today are bound under names the authored text does not spell, so no local hides them (PR #100 review)", async () => {
    const plain = entity(check("() => true")).replace("  actions auto", [
      "  computed",
      // Each name is spelled: in code, in a string, in a comment and through an escape (`$today` is `$today`).
      "    boolean :spelled() { const $now = 1, $self = 2, $\\u0074oday = 3; /* $now1 */ return String(\"$self1\").length > 0 && %.now.getTime() + %.today.getTime() + &n + $now + $self + $today > 0 }",
      // A translated quantifier the type pass demotes (`:open` against a string) keeps its parameter `$`, its authored name.
      "    boolean :demoted() { return &children.some(($) => $.title === :open && $.dueAt !== null && $.dueAt < %.now) }",
      "  actions auto",
    ].join("\n"));
    const { root, built, files } = await generated(plain);
    const [spelled, demoted] = built.document!.entities[0]!.computed;
    expect(spelled!.body!.plain).toMatchObject({ clock: ["now", "today"], internal: { self: "$self2", now: "$now2", today: "$today1" } });
    expect(demoted!.body!.plain).toMatchObject({ internal: { self: "$self", now: "$now" } });
    expect(demoted!.body!.plain!.edits.map((edit) => edit.text)).toEqual(["$self.children", "\"open\"", "$now()"]);
    const printed = files.find((f) => f.path.endsWith("task.expressions.ts"))!.contents;
    expect(printed).toContain("const $self2 = $s.self;");
    expect(printed).toContain("const $now2 = () => $.now($s);");
    expect(printed).toContain("const $today1 = () => $.today($s);");
    expect(printed).toContain("$now2().getTime() + $today1().getTime() + $self2.n + $now + $self + $today > 0");
    expect(printed).toContain("$self.children.some(($) => $.title === \"open\" && $.dueAt !== null && $.dueAt < $now())");
    expect(checkTypes(root, ["generated/domain/task.expressions.ts", "generated/domain/task.types.ts"])).toEqual({ code: 0, output: "" });
    const { $expressions: expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
    const at = { clock: () => new Date(86_400_000 * 2 + 5_000) };
    expect(expressions["computed.spelled"](scope({ self: { n: 1 } }, at))).toBe(true);
    expect(expressions["computed.demoted"](scope({ self: { children: [{ title: "open", dueAt: new Date(86_400_000) }] } }, at))).toBe(true);
    expect(expressions["computed.demoted"](scope({ self: { children: [{ title: "open", dueAt: new Date(86_400_000 * 3) }] } }, at))).toBe(false);
  }, 30_000);

  test("each Mesh.isSystem resolves against its own enclosing scopes: a parameter named Mesh shadows the import only inside its function; %.now has no binding to hide", async () => {
    const plain = entity(check("() => true")).replace("  actions auto", [
      "  computed",
      // The review's case (PR #65, N7): the callback's parameter shadows `Mesh` inside the callback only.
      "    boolean :outer({ context }) { return [1].some((Mesh) => Mesh === 1) && Mesh.isSystem(context) && %.now.getTime() === &n }",
      // Only shadowed uses: no `Mesh` imported.
      "    boolean :inner() { if ([&n].some((Mesh) => Mesh === 7)) { const Mesh = { isSystem: () => 7 }; return Mesh.isSystem() === &n } return false }",
      // Uses inside nested functions that bind no such name read the import; a nested parameter of that name does not.
      // A parameter or local named `Mesh`, `now` or `today` never changes what `%.now` and `%.today` are.
      "    boolean :nested({ context }) { const stamp = (now: number) => %.now.getTime() + now; function day(Mesh: number) { const today = 0; return %.today.getTime() + Mesh + today } return [1].map((Mesh) => Mesh + 1)[0] === 2 && Mesh.isSystem(context) && stamp(0) === &n && day(0) <= &n }",
      "    boolean :cast() { return (%.now as Date).getTime() === &n }",
      "  actions auto",
    ].join("\n"));
    const { root, built } = await generated(plain);
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const computed = built.document!.entities[0]!.computed;
    expect(computed.map((c) => [c.name, c.body?.plain?.clock])).toEqual([["outer", ["now"]], ["inner", undefined], ["nested", ["now", "today"]], ["cast", ["now"]]]);
    expect(computed.map((c) => [c.name, c.body?.plain?.mesh])).toEqual([["outer", ["Mesh"]], ["inner", undefined], ["nested", ["Mesh"]], ["cast", undefined]]);
    expect(computed.map((c) => [c.name, c.body?.plain?.isSystem])).toEqual([["outer", true], ["inner", undefined], ["nested", true], ["cast", undefined]]);
    expect(checkTypes(root, ["generated/domain/task.expressions.ts", "generated/domain/task.types.ts"])).toEqual({ code: 0, output: "" });
    const { $expressions: expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
    const at = { clock: () => new Date(86_400_000 * 2 + 5_000) };
    const system = { system: true };
    expect(expressions["computed.outer"](scope({ self: { n: 86_400_000 * 2 + 5_000 }, context: system }, at))).toBe(true);
    expect(expressions["computed.outer"](scope({ self: { n: 86_400_000 * 2 + 5_000 }, context: {} }, at))).toBe(false);
    expect(expressions["computed.outer"](scope({ self: { n: 1 }, context: system }, at))).toBe(false);
    expect(expressions["computed.inner"](scope({ self: { n: 7 } }, at))).toBe(true);
    expect(expressions["computed.nested"](scope({ self: { n: 86_400_000 * 2 + 5_000 }, context: system }, at))).toBe(true);
    expect(expressions["computed.cast"](scope({ self: { n: 86_400_000 * 2 + 5_000 } }, at))).toBe(true);
  }, 30_000);

  test("a parameter default beside a body `var` of the same name binds no Mesh, so the type check refuses it", () => {
    // PR #65 round 2, N4. JavaScript gives `at = Mesh.isSystem(context)` the outer `Mesh`, but Bun 1.3.14 and 1.4.2 throw
    // "Mesh is not defined" whenever that binding is two or more functions up, as a printed function's `Mesh` always is.
    // Importing none keeps the failure at the type check (TS2304) instead of at run time; see `scopeNames`.
    const source = entity(check("() => true")).replace("  actions auto",
      "  computed\n    boolean :defaultVar({ context }) { function f(at = Mesh.isSystem(context)) { var Mesh = 0; return [at, Mesh] as const } return f()[0] }\n  actions auto");
    const built = build(source);
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(built.document!.entities[0]!.computed[0]!.body?.plain?.isSystem).toBeUndefined();
    expect(built.document!.entities[0]!.computed[0]!.body?.plain?.mesh).toBeUndefined();
  });

  test("a helper imported as now, called bare, is the helper in plain and translated code alike (PRJ-22)", async () => {
    // PR #65 round 2, F2: plain code bound the clock over the import while translated code called the import. Since
    // PRJ-22 a bare `now` is never Mesh's: the clock is the transaction's `%.now` (SYN-29).
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
    expect(printed).not.toMatch(/const now = |\$\.now\(/);
    expect(checkTypes(root, ["generated/domain/task.expressions.ts", "generated/domain/task.types.ts"])).toEqual({ code: 0, output: "" });
    const { $expressions: expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
    // The bound clock says two days in; the import says the epoch. Both paths answer as the import does.
    const at = { clock: () => new Date(86_400_000 * 2) };
    expect(expressions["computed.plainNow"](scope({ self: {} }, at))).toBe(true);
    expect(expressions["go.check.c.that"](scope({ self: { dueAt: new Date(5) } }, at))).toBe(false);
    expect(expressions["go.check.c.that"](scope({ self: { dueAt: new Date(-5) } }, at))).toBe(true);
  });
  test.each(["now", "today", "isSystem", "privileged", "structuredClone"])("an entity imported as %s is the entity: no bare name is Mesh's (PRJ-22), and an import hides a JavaScript global (PRJ-20)", async (alias) => {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-alias-names-"));
    roots.push(root);
    const source = entity(check("() => true") +
      `      do\n        run async () { const found = await ${alias}.read({}); console.log(found.length) }\n`)
      .replace("import { Task }", `import { Task as ${alias} } from "./task.mesh.mx"\nimport { Task }`);
    const built = buildModel({ root, files: [{ file: "task.mesh.mx", source }] });
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const run = built.document!.entities[0]!.actions.find((a) => a.name === "go")!.do[0]!;
    const plain = run.kind === "run" ? run.fn.plain : undefined;
    expect(plain).toMatchObject({ entities: [alias] });
    expect(plain?.clock).toBeUndefined();
    expect(plain?.isSystem).toBeUndefined();
    expect(plain?.privileged).toBeUndefined();
    const config = configOf(root);
    const files = await generateFiles({ document: built.document!, config });
    await writeGeneratedFiles(files, config);
    await writeFile(resolve(root, "generated/schema.ts"), "export const tables = { task: {} };\n");
    const printed = files.find((f) => f.path.endsWith("task.expressions.ts"))!.contents;
    // One binding of the name in the printed function: the entity's.
    expect(printed).toContain(`const ${alias}: $Task$ReadOnly = $Task$value;`);
    expect(printed).not.toMatch(new RegExp(`const ${alias} = `));
    expect(printed).not.toMatch(/\$cloneValue|\bMesh\b/);
    const paths = files.map((f) => f.path).filter((path) => path.endsWith(".ts") && !path.endsWith("index.ts") && !path.endsWith("binding.ts"));
    expect(checkTypes(root, [...paths, "generated/schema.ts"])).toEqual({ code: 0, output: "" });
  }, 30_000);

  test("an entity imported as now is no clock to the arity check, and a name only Object.prototype has is a free variable", () => {
    const aliased = entity(check("() => true") + "      do\n        run () { console.log(now(1)) }\n")
      .replace("import { Task }", 'import { Task as now } from "./task.mesh.mx"\nimport { Task }');
    // `now(1)` calls the entity value, which the type check refuses; it is not the transaction's `%.now` called.
    expect(codes(aliased).filter((code) => code.startsWith("error:"))).toEqual([]);
    // `toString` is no Mesh function, and no member of `Mesh` either: only `Mesh.toString`, which every object has, is.
    expect(codes(entity(check("() => toString() === \"\""))).filter((code) => code.startsWith("error:"))).toEqual(["error:MESH_EXPR_FREE_VARIABLE"]);
  });

  // EXP-12: a scope root (`self`, `input`, `actor`, `context`, `before`) is like a parameter of every function. Inside one
  // it shadows an import of its name, which stays the import everywhere else in the file.
  test.each(["self", "input", "actor", "context", "before"])("an entity imported as %s is that root inside a function, and the entity outside (EXP-12)", async (name) => {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-root-alias-"));
    roots.push(root);
    // Before EXP-12 the function bound both, `const { context } = $s; const context: ... = $Task$value;`, which Bun
    // refuses to load ("context" has already been declared), and a check that read `self` became plain code.
    const source = entity(check("() => self.n > 1") + `      do\n        run () { console.log(${name}) }\n`)
      .replace("import { Task }", `import { Task as ${name} } from "./task.mesh.mx"\nimport { Task }`)
      .replace("    has-many :children entity=Task\n    belongs-to :parent entity=Task nullable\n",
        `    has-many :children entity=Task inverse=:parent\n    belongs-to :parent entity=Task nullable\n    belongs-to :held entity=${name} nullable\n`);
    const built = buildModel({ root, files: [{ file: "task.mesh.mx", source }] });
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const task = built.document!.entities[0]!;
    // Outside the functions the alias is the entity.
    expect(task.relationships.find((r) => r.name === "held")).toMatchObject({ entity: { identifier: name, from: "./task.mesh.mx" }, keyColumn: "heldId" });
    const go = task.actions.find((a) => a.name === "go")!;
    expect(go.validate[0]!.that.tree).toBeDefined();
    const run = go.do[0]!;
    const plain = run.kind === "run" ? run.fn.plain : undefined;
    expect(plain).toMatchObject({ why: "run-step", roots: [name] });
    expect(plain?.entities).toBeUndefined();
    const config = configOf(root);
    const files = await generateFiles({ document: built.document!, config });
    await writeGeneratedFiles(files, config);
    await writeFile(resolve(root, "generated/schema.ts"), "export const tables = { task: {} };\n");
    const printed = files.find((f) => f.path.endsWith("task.expressions.ts"))!.contents;
    expect(printed).toContain(`const { ${name} } = $s;\n    return (async function () {\n      console.log(${name});\n    })();`);
    expect(printed).not.toContain("$Task$value");
    expect(files.find((f) => f.path.endsWith("task.types.ts"))!.contents).toContain("  parent: Task | null;\n  held: Task | null;\n");
    const paths = files.map((f) => f.path).filter((path) => path.endsWith(".ts") && !path.endsWith("index.ts") && !path.endsWith("binding.ts"));
    expect(checkTypes(root, [...paths, "generated/schema.ts"])).toEqual({ code: 0, output: "" });
    const { $expressions: expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
    const logs: unknown[][] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { logs.push(args); };
    try {
      await expressions["go.step.0.run"](scope({ self: { n: 2 }, input: { id: "i" }, actor: { id: "a" }, context: { system: true }, before: { n: 1 } }));
    } finally { console.log = log; }
    expect(logs).toEqual([[{ self: { n: 2 }, input: { id: "i" }, actor: { id: "a" }, context: { system: true }, before: { n: 1 } }[name]]]);
  }, 30_000);

  test("a function binds structuredClone to cloneValue only where it reads the global, as the front end resolves the name (PRJ-20)", async () => {
    // PR #94 round 2: the binding was decided by a text search, so a function that declared its own `structuredClone`
    // got a second, unused one, TS6133 under `--noUnusedLocals`.
    const source = entity(check("() => true") + [
      "      do",
      "        run ({ self }) { const copy: any = structuredClone(self); copy.n = 9; console.log(copy.n, self.n) }",
      "        run () { const structuredClone = (value: number) => value + 1; console.log(structuredClone(1)) }",
      "        run () { console.log(\"structuredClone\", { structuredClone: 1 }.structuredClone) }",
      "",
    ].join("\n"));
    const { root, files, built } = await generated(source);
    const steps = built.document!.entities[0]!.actions.find((a) => a.name === "go")!.do;
    expect(steps.map((step) => (step.kind === "run" ? step.fn.plain?.structuredClone : "?"))).toEqual([true, undefined, undefined]);
    const printed = files.find((f) => f.path.endsWith("task.expressions.ts"))!.contents;
    expect(printed.match(/const structuredClone = \$cloneValue;/g)).toHaveLength(1);
    expect(checkTypes(root, ["generated/domain/task.expressions.ts", "generated/domain/task.types.ts"])).toEqual({ code: 0, output: "" });
    const { $expressions: expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
    const logs: unknown[][] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { logs.push(args); };
    try {
      for (const index of [0, 1, 2]) await expressions[`go.step.${index}.run`](scope({ self: { n: 5 } }));
    } finally { console.log = log; }
    expect(logs).toEqual([[9, 5], [2], ["structuredClone", 1]]);
  }, 30_000);

  test("a helper named like a scope root is hidden by the root in every function, and the file does not import it (EXP-12)", async () => {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-root-helpers-"));
    roots.push(root);
    const names = ["self", "input", "actor", "context", "before"];
    await writeFile(resolve(root, "helpers.ts"), names.map((name) => `export const ${name} = (): string => ${JSON.stringify(name)};`).join("\n") + "\n");
    const source = entity(check("() => self.n > 1") + "      do\n        run () { console.log(input, actor, context, before) }\n")
      .replace("import { Task }", `import { ${names.join(", ")} } from "./helpers"\nimport { Task }`);
    const built = buildModel({ root, files: [{ file: "task.mesh.mx", source }] });
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const go = built.document!.entities[0]!.actions.find((a) => a.name === "go")!;
    expect(go.validate[0]!.that.tree).toMatchObject({ fn: "gt" });
    const run = go.do[0]!;
    const plain = run.kind === "run" ? run.fn.plain : undefined;
    expect(plain).toMatchObject({ roots: ["input", "actor", "context", "before"] });
    expect(plain?.helpers).toBeUndefined();
    const config = configOf(root);
    const files = await generateFiles({ document: built.document!, config });
    await writeGeneratedFiles(files, config);
    await writeFile(resolve(root, "generated/schema.ts"), "export const tables = { task: {} };\n");
    const printed = files.find((f) => f.path.endsWith("task.expressions.ts"))!.contents;
    // No function names a helper, so the file imports none: an unused import is TS6133 under `--noUnusedLocals`.
    expect(printed).not.toContain("helpers");
    const paths = files.map((f) => f.path).filter((path) => path.endsWith(".ts") && !path.endsWith("index.ts") && !path.endsWith("binding.ts"));
    expect(checkTypes(root, [...paths, "generated/schema.ts"])).toEqual({ code: 0, output: "" });
    const { $expressions: expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
    const logs: unknown[][] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { logs.push(args); };
    try {
      await expressions["go.step.0.run"](scope({ self: { n: 2 }, input: { id: "i" }, actor: { id: "a" }, context: { system: true }, before: { n: 1 } }));
    } finally { console.log = log; }
    expect(logs).toEqual([[{ id: "i" }, { id: "a" }, { system: true }, { n: 1 }]]);
  }, 30_000);

  test("a helper a function names only in a type is imported as a type, unless a type or variable of the function hides it", async () => {
    // MX strips the types from the node the front end reads, so `PlainReason.helpers` has only the helpers read as values;
    // the back end finds the rest in the printed function (`typeNames`). Before, `const limit: Money` built with no error
    // and tsc failed with TS2304 (cannot find name), since the file did not import `Money`.
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-type-helpers-"));
    roots.push(root);
    await writeFile(resolve(root, "money.ts"), "export type Money = number;\nexport interface Shape { n: number }\nexport type Cents = number;\n");
    await writeFile(resolve(root, "helpers.ts"), [
      "export const fmt = (n: number): string => `#${n}`;",
      "export const big = (n: number): boolean => n > 100;",
      "export const label = (): string => \"label\";",
      "",
    ].join("\n"));
    const steps = [
      // `typeof fmt` and `Money`: a value read in a type position and a type reference.
      "run () { const f: typeof fmt = (n) => `${n}!`; const m: Money = 2; console.log(f(m)) }",
      // `big` read as a value, and named in a type too: an ordinary import.
      "run () { const b: typeof big = big; console.log(b(101)) }",
      // Each name hidden: a local type, a local variable (for `typeof`), a type parameter, a local interface.
      "run () { type Cents = string; const c: Cents = \"c\"; const label = 1; const l: typeof label = label; const id = <Shape,>(x: Shape): Shape => x; console.log(c, l, id(3)) }",
      "run () { interface Money { a: number } const m: Money = { a: 1 }; console.log(m.a) }",
    ];
    const source = entity(check("() => { const limit: Money = 1; return &n > limit }") + "      do\n" + steps.map((step) => `        ${step}\n`).join(""))
      .replace("import { Task }", 'import { Money, Shape, Cents } from "./money"\nimport { fmt, big, label } from "./helpers"\nimport { Task }');
    const built = buildModel({ root, files: [{ file: "task.mesh.mx", source }] });
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const go = built.document!.entities[0]!.actions.find((a) => a.name === "go")!;
    const helpersOf = (index: number) => { const step = go.do[index]!; return step.kind === "run" ? step.fn.plain?.helpers : undefined; };
    // The front end sees only the value read.
    expect([helpersOf(0), helpersOf(1), helpersOf(2), helpersOf(3)]).toEqual([undefined, ["big"], undefined, undefined]);
    expect(go.validate[0]!.that.plain?.helpers).toBeUndefined();
    const config = configOf(root);
    const files = await generateFiles({ document: built.document!, config });
    await writeGeneratedFiles(files, config);
    await writeFile(resolve(root, "generated/schema.ts"), "export const tables = { task: {} };\n");
    const printed = files.find((f) => f.path.endsWith("task.expressions.ts"))!.contents;
    // `Shape`, `Cents` and `label` are hidden wherever they are named, so neither module imports them.
    expect(printed).toContain('import type { Money } from "../../money";\nimport { big, type fmt } from "../../helpers";\n');
    expect(printed).not.toMatch(/\b(Cents|Shape|label)\b[^\n]*from/);
    const paths = files.map((f) => f.path).filter((path) => path.endsWith(".ts") && !path.endsWith("index.ts") && !path.endsWith("binding.ts"));
    expect(checkTypes(root, [...paths, "generated/schema.ts"])).toEqual({ code: 0, output: "" });
    const { $expressions: expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
    const logs: unknown[][] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { logs.push(args); };
    try {
      for (const index of [0, 1, 2, 3]) await expressions[`go.step.${index}.run`](scope({ self: { n: 2 }, input: {}, actor: null, context: {}, before: { n: 2 } }));
    } finally { console.log = log; }
    expect(logs).toEqual([["2!"], [true], ["c", 1, 3], [1]]);
    expect(await expressions["go.check.c.that"](scope({ self: { n: 2 }, input: {}, actor: null, context: {} }))).toBe(true);
  }, 30_000);

  test("a helper import may have any name the file used to declare: every generated module-level name is a $ local", async () => {
    // PR #92 round 1, item 2: `import { TaskLoaded } from "./helpers"` built, then tsc failed with TS2300 (duplicate
    // identifier), because the file imported the entity's own types, declared its scopes and exported its functions under
    // bare names. A helper named `structuredClone` is the author's own: no function binds `cloneValue` over it.
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-helper-names-"));
    roots.push(root);
    const names = ["Task$Record", "TaskLoaded", "GoTaskInput", "TaskScope", "TaskStoredScope", "TaskCheckScope", "expressions", "structuredClone"];
    await writeFile(resolve(root, "helpers.ts"), [
      "export const Task$Record = (): string => \"record\";",
      "export const TaskLoaded = (n: number): number => n + 1;",
      ...["GoTaskInput", "TaskScope", "TaskStoredScope", "TaskCheckScope", "expressions"].map((name) => `export const ${name} = (): string => ${JSON.stringify(name)};`),
      "export const structuredClone = (value: unknown): string => `mine: ${String(value)}`;",
      "",
    ].join("\n"));
    const source = entity(check("({ self }) => TaskLoaded(self.n) > 0 && TaskCheckScope() !== \"\"") +
      "      do\n        set\n          &title=({ self }) => [Task$Record(), GoTaskInput(), TaskScope(), TaskStoredScope(), expressions(), String(self.n)].join(\",\")\n")
      .replace("import { Task }", `import { ${names.join(", ")} } from "./helpers"\nimport { Task }`)
      .replace("  actions auto", "  computed\n    string :copy() { return structuredClone(&n) }\n  actions auto");
    const built = buildModel({ root, files: [{ file: "task.mesh.mx", source }] });
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const config = configOf(root);
    const files = await generateFiles({ document: built.document!, config });
    await writeGeneratedFiles(files, config);
    await writeFile(resolve(root, "generated/schema.ts"), "export const tables = { task: {} };\n");
    const printed = files.find((f) => f.path.endsWith("task.expressions.ts"))!.contents;
    const helpers = /import \{([^}]*)\} from "\.\.\/\.\.\/helpers"/.exec(printed)![1]!;
    expect(helpers.split(",").map((name) => name.trim()).filter(Boolean)).toEqual([...names].sort());
    expect(printed).not.toContain("cloneValue");
    // What the file itself declares or imports from generated code all starts with `$`: only the helpers do not.
    const declared = [...printed.matchAll(/^export (?:type|const) ([\w$]+)/gm)].map((match) => match[1]!);
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((name) => !name.startsWith("$"))).toEqual([]);
    const fromTypes = /import type \{([^}]*)\} from "\.\/task\.types"/.exec(printed)![1]!;
    expect(fromTypes.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => entry.split(" as ")[1])).toEqual(["$Task$Record", "$Task$Loaded", "$Task$GoTaskInput"]);
    const paths = files.map((f) => f.path).filter((path) => path.endsWith(".ts") && !path.endsWith("index.ts") && !path.endsWith("binding.ts"));
    expect(checkTypes(root, [...paths, "generated/schema.ts"])).toEqual({ code: 0, output: "" });
    const { $expressions: expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
    expect(expressions["computed.copy"](scope({ self: { n: 3 } }))).toBe("mine: 3");
    expect(expressions["go.step.0.set.title"](scope({ self: { n: 3 } }))).toBe("record,GoTaskInput,TaskScope,TaskStoredScope,expressions,3");
  }, 30_000);

  test("plain code that shadows a scope name declares no unused binding, and a class with a private member runs", async () => {
    const plain = (entity(check("() => true")) + [
      "      do",
      "        run ({ context }) { for (const input of [1, 2]) { console.log(input, context) } try { console.log(1) } catch (input) { console.log(input) } }",
      "        run ({ self }) { class C { #x = self.n; get() { return this.#x } } console.log(new C().get()) }",
      "",
    ].join("\n"));
    const { root, files } = await generated(plain);
    expect(checkTypes(root, ["generated/domain/task.expressions.ts", "generated/domain/task.types.ts"])).toEqual({ code: 0, output: "" });
    const { $expressions: expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
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
    const { $expressions: expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
    expect(expressions["computed.label"](scope({ self: { n: 3, title: "x" } }))).toBe("3:x");
  });

  test("a model without expressions gets no file", async () => {
    const { files } = await generated("entity :Plain\n  attributes\n    uuid :id primary-key\n");
    expect(files.some((f) => f.path.endsWith(".expressions.ts"))).toBe(false);
  });
});

describe("what a function names only in a type, and aliased imports (PR #94 review)", () => {
  /**
   * Builds `files` (the entity files and the TypeScript modules they import) in a new project, expects no build error,
   * writes the generated tree and returns the expressions file of `task.mesh.mx`, a strict type check of the tree and a
   * loader for the expressions module.
   */
  async function project(prefix: string, files: Record<string, string>) {
    const root = await mkdtemp(resolve(import.meta.dir, `../mesh-${prefix}-`));
    roots.push(root);
    for (const [path, text] of Object.entries(files)) if (!path.endsWith(".mesh.mx")) await writeFile(resolve(root, path), text);
    const built = buildModel({ root, files: Object.entries(files).filter(([path]) => path.endsWith(".mesh.mx")).map(([file, source]) => ({ file, source })) });
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const config = configOf(root);
    const generated = await generateFiles({ document: built.document!, config });
    await writeGeneratedFiles(generated, config);
    await writeFile(resolve(root, "generated/schema.ts"), `export const tables = { ${built.document!.entities.map((e) => `${e.table}: {}`).join(", ")} };\n`);
    const paths = generated.map((f) => f.path).filter((path) => path.endsWith(".ts") && !path.endsWith("index.ts") && !path.endsWith("binding.ts"));
    return {
      built,
      printed: generated.find((f) => f.path.endsWith("task.expressions.ts"))!.contents,
      typeCheck: () => checkTypes(root, [...paths, "generated/schema.ts"]),
      load: async (): Promise<Record<string, (s: unknown) => unknown>> => (await import(resolve(root, "generated/domain/task.expressions.ts"))).$expressions,
    };
  }
  /** Runs `fn` and returns what it logged. */
  async function logged(fn: () => Promise<unknown>): Promise<unknown[][]> {
    const logs: unknown[][] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { logs.push(args); };
    try { await fn(); } finally { console.log = log; }
    return logs;
  }
  const values = { self: { n: 2, title: "t" }, input: { id: "i" }, actor: { id: "a" }, context: { system: true }, before: { n: 1 } };

  test("item 1: a helper named like a scope root that a function reads only in `typeof` is still hidden by the root (EXP-12)", async () => {
    // Before, `typeNames` found `input` free in `typeof input.id`, the file imported the helper as a type, and no function
    // bound the root: the type was the helper's (here `{ id: number }`, so "x" failed TS2322; a looser helper passed tsc
    // silently with the wrong type). A type reference is still the helper: a root is a value, as a parameter is.
    const { printed, typeCheck, load } = await project("root-typeof", {
      "helpers.ts": "export const input = { id: 0 };\nexport const self = (): number => 1;\nexport type actor = { kind: \"helper type\" };\n",
      "task.mesh.mx": entity(check("() => { const n: typeof self.n = 2; return n > 1 }") + [
        "      do",
        "        run () { const id: typeof input.id = \"x\"; console.log(id) }",
        "        run () { const a: actor = { kind: \"helper type\" }; console.log(a.kind) }",
        "",
      ].join("\n")).replace("import { Task }", 'import { input, self, actor } from "./helpers"\nimport { Task }'),
    });
    expect(printed).toContain('import type { actor } from "../../helpers";');
    expect(printed).not.toMatch(/\b(input|self)\b[^\n]*from "\.\.\/\.\.\/helpers"/);
    expect(printed).toContain("const { input } = $s;");
    expect(printed).toContain("const { self } = $s;");
    expect(typeCheck()).toEqual({ code: 0, output: "" });
    const expressions = await load();
    expect(await logged(async () => {
      await expressions["go.step.0.run"]!(scope(values));
      await expressions["go.step.1.run"]!(scope(values));
    })).toEqual([["x"], ["helper type"]]);
    expect(expressions["go.check.c.that"]!(scope(values))).toBe(true);
  }, 30_000);

  test("item 2: a scope root a function reads only in a type is bound", async () => {
    // Before, `const n: typeof before.n` printed no `const { before } = $s`: tsc failed with TS2304 (cannot find name).
    const { printed, typeCheck, load } = await project("root-type-only", {
      "task.mesh.mx": entity(check("() => { const c: typeof context = {}; return c !== null }") + [
        "      do",
        "        run () { const id: typeof input.id = \"x\"; const n: typeof before.n = 1; console.log(id, n) }",
        "",
      ].join("\n")).replace("  actions auto", "  computed\n    integer :twice() { const n: typeof self.n = 2; return n * 2 }\n  actions auto"),
    });
    expect(printed).toContain("const { input, before } = $s;");
    expect(printed).toContain("const { context } = $s;");
    expect(printed).toContain("const { self } = $s;");
    expect(typeCheck()).toEqual({ code: 0, output: "" });
    const expressions = await load();
    expect(await logged(async () => { await expressions["go.step.0.run"]!(scope(values)); })).toEqual([["x", 1]]);
    expect(expressions["go.check.c.that"]!(scope(values))).toBe(true);
    expect(expressions["computed.twice"]!(scope(values))).toBe(4);
  }, 30_000);

  test("item 3: a parameter of a signature type hides a helper of its name from `typeof` in that signature", async () => {
    // Before, `typeof fmt` in `(fmt: string) => typeof fmt` was taken for the helper: the file imported it as a type and
    // tsc failed under `--noUnusedLocals` (TS6133), since TypeScript resolves the name to the parameter.
    const signatures = [
      "type F = (fmt: string) => typeof fmt",
      "type C = new (fmt: string) => typeof fmt",
      "interface M { m(fmt: string): typeof fmt }",
      "interface K { (fmt: string): typeof fmt }",
      "interface N { new (fmt: string): typeof fmt }",
    ];
    const { printed, typeCheck, load } = await project("signature-params", {
      "helpers.ts": "export const fmt = (n: number): string => `#${n}`;\n",
      "task.mesh.mx": entity(check("() => true") + [
        "      do",
        `        run () { ${signatures.join("; ")}; const f: F = (s) => s; const m: M = { m: (s) => s }; const unused: [C, K, N] | null = null; console.log(f("a"), m.m("b"), unused) }`,
        "",
      ].join("\n")).replace("import { Task }", 'import { fmt } from "./helpers"\nimport { Task }'),
    });
    expect(printed).not.toContain("helpers");
    expect(typeCheck()).toEqual({ code: 0, output: "" });
    const expressions = await load();
    expect(await logged(async () => { await expressions["go.step.0.run"]!(scope(values)); })).toEqual([["a", "b", null]]);
  }, 30_000);

  test("item 4: an aliased helper import keeps its alias, in the model and in the expressions file", async () => {
    // Before, the model kept only the local name and the file imported it as the export: `import { Big, format, type
    // Cash }` failed tsc with TS2305/TS2724 and Bun's load with "Export named 'Big' not found".
    const { built, printed, typeCheck, load } = await project("helper-alias", {
      "more.ts": "export const fmt = (n: number): string => `#${n}`;\nexport const big = (n: number): boolean => n > 100;\nexport type Money = number;\nexport const same = (s: string): string => s;\nexport default (n: number): number => n * 2;\n",
      "types.ts": "export type Money = number;\n",
      "task.mesh.mx": entity(check("() => Big(&n)") + [
        "      do",
        "        run () { const c: Cash = 1; console.log(format(c), same(\"s\")) }",
        "        run () { const t: Amount = 2; console.log(t, twice(t)) }",
        "",
      ].join("\n")).replace("import { Task }", [
        'import { fmt as format, big as Big, Money as Cash, same as same, default as twice } from "./more"',
        'import { Money as Amount } from "./types"',
        "import { Task }",
      ].join("\n")),
    });
    const imports = built.document!.entities[0]!.imports;
    expect(imports[0]).toEqual({ identifiers: ["format", "Big", "Cash", "same", "twice"], imported: ["fmt", "big", "Money", "same", "default"], from: "./more", helper: true, position: expect.anything() });
    expect(imports[1]).toMatchObject({ identifiers: ["Amount"], imported: ["Money"] });
    // An import that renames nothing has no `imported`, so the model of a file without aliases is what it was.
    expect(imports[2]).toEqual({ identifiers: ["Task"], from: "./task.mesh.mx", position: expect.anything() });
    expect(printed).toContain('import { big as Big, type Money as Cash, fmt as format, same, default as twice } from "../../more";');
    expect(printed).toContain('import type { Money as Amount } from "../../types";');
    expect(typeCheck()).toEqual({ code: 0, output: "" });
    const expressions = await load();
    expect(await logged(async () => {
      await expressions["go.step.0.run"]!(scope(values));
      await expressions["go.step.1.run"]!(scope(values));
    })).toEqual([["#1", "s"], [2, 4]]);
    expect(expressions["go.check.c.that"]!(scope({ self: { n: 101 } }))).toBe(true);
  }, 30_000);

  test("item 5: an entity a function names only in a type is bound as its record type, or as its value for `typeof`", async () => {
    // Before, `const t: List | null` printed no binding of `List`: tsc failed with TS2304 (cannot find name). The record
    // type comes from the entity's actions file, which exports it with the value (CMP-17), under its FQN-derived local; the
    // file's own entity's is already imported from its types file.
    const { printed, typeCheck, load } = await project("entity-type", {
      "list.mesh.mx": "entity :List\n  attributes\n    uuid :id primary-key\n    string :name\n  actions auto=[:read]\n",
      "tag.mesh.mx": "entity :Tag\n  attributes\n    uuid :id primary-key\n  actions auto=[:read]\n",
      "task.mesh.mx": entity(check("() => { const own: Task[\"n\"] = &n; return own > 0 }") + [
        "      do",
        "        run () { const t: Task | null = null; const l: List | null = null; const g: Label | null = null; console.log(t, l, g) }",
        "        run () { const r: typeof List | null = null; const n: List[\"name\"] = \"n\"; console.log(r, n) }",
        "",
      ].join("\n")).replace("import { Task }", 'import { List } from "./list.mesh.mx"\nimport { Tag as Label } from "./tag.mesh.mx"\nimport { Task }'),
    });
    expect(printed).toContain('import {\n  List as $List$value,\n  type $ReadOnly as $List$ReadOnly,\n  type List as $List$Record,\n} from "./list.actions";');
    expect(printed).toContain('import type { Tag as $Tag$Record } from "./tag.actions";');
    expect(printed).toContain("type Task = $Task$Record;");
    expect(printed).toContain("type List = $List$Record;");
    expect(printed).toContain("type Label = $Tag$Record;");
    expect(printed).toContain("const List: $List$ReadOnly = $List$value;");
    expect(typeCheck()).toEqual({ code: 0, output: "" });
    const expressions = await load();
    expect(await logged(async () => {
      await expressions["go.step.0.run"]!(scope(values));
      await expressions["go.step.1.run"]!(scope(values));
    })).toEqual([[null, null, null], [null, "n"]]);
    expect(expressions["go.check.c.that"]!(scope(values))).toBe(true);
  }, 30_000);

  test("item 6: a check that reads `before` as a free name is MESH_VALIDATE_BEFORE, as a destructured one is", () => {
    // Before, `() => before !== null` was plain (a free root) and built with no error; tsc then failed with TS2339 on the
    // check's scope, which has no `before`.
    for (const that of ["() => before !== null", "() => { return before !== null }", "() => before.n > 1"]) {
      const diagnostics = build(entity(check(that))).diagnostics.filter((d) => d.severity === "error");
      expect(diagnostics.map((d) => d.code), that).toEqual(["MESH_VALIDATE_BEFORE"]);
    }
  });

  test("item 6 leaves a create alone: its steps read a free `before`, which is null there", async () => {
    // The docs (entities.md, `before` and `do`) give the `do` steps and `run` `before`, `null` on a create. Only a check
    // lost it; a free `before` in a create's `set` or `run` builds, type-checks and reads null, as it did on 8353a02.
    const { built, printed, typeCheck, load } = await project("create-before", {
      "task.mesh.mx": entity(check("() => true")).replace("    update :go\n      validate", [
        "    create :make",
        "      input",
        "        &n",
        "        &title",
        "      do",
        "        set",
        "          &title=() => before?.title ?? input.title",
        "        run () { console.log(\"before is\", before) }",
        "    update :go",
        "      validate",
      ].join("\n")),
    });
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(printed).toContain('"make.step.0.set.title"');
    expect(printed).toContain('"make.step.1.run"');
    expect(typeCheck()).toEqual({ code: 0, output: "" });
    const expressions = await load();
    const create = { ...values, input: { title: "from input" }, before: null };
    expect(await expressions["make.step.0.set.title"]!(scope(create))).toBe("from input");
    expect(await logged(async () => { await expressions["make.step.1.run"]!(scope(create)); })).toEqual([["before is", null]]);
  }, 30_000);

  test("item 6: a check or a policy that reads `before` only in a type is refused when the file is emitted", async () => {
    // The front end cannot see a type (MX strips them), so the back end reports it where `typeNames` finds it, with the
    // code the front end gives a `before` read as a value; binding it would fail tsc with TS2339 on the check's scope.
    const that = "() => { const b: typeof before = null; return b === null }";
    const cases = [
      [entity(check(that)), "MESH_VALIDATE_BEFORE", "check :c that"],
      [entity(check("() => true")).replace("  actions auto", `  policies\n    policy :p types=[:update]\n      authorize-if=${that}\n  actions auto`), "MESH_POLICY_BEFORE", "policy :p authorize-if"],
    ] as const;
    for (const [source, code, what] of cases) {
      const built = build(source);
      expect(built.diagnostics.filter((d) => d.severity === "error"), code).toEqual([]);
      const failure = await generateFiles({ document: built.document!, config: configOf("/p") }).then(() => undefined, (error: unknown) => error);
      expect(failure, code).toMatchObject({ name: "EmitError", diagnostic: { code, message: expect.stringContaining(`${what} reads \`before\` in a type`) } });
    }
  });
});

describe("Mesh's own functions are members of the Mesh import (PRJ-22)", () => {
  /** The `entity()` source without its `import { Mesh } from "meshfw"`. */
  const unimported = (source: string) => source.replace('import { Mesh } from "meshfw"\n', "");
  const problems = (source: string) =>
    build(source).diagnostics.filter((d) => d.severity === "error").map((d) => ({ code: d.code, message: d.message, fix: d.fix, offset: d.position.offset }));
  /** Builds `source` as `task.mesh.mx` in a new project, writes the generated tree and returns what the tests read. */
  async function emitted(source: string) {
    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-namespace-"));
    roots.push(root);
    const built = buildModel({ root, files: [{ file: "task.mesh.mx", source }] });
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const config = configOf(root);
    const files = await generateFiles({ document: built.document!, config });
    await writeGeneratedFiles(files, config);
    await writeFile(resolve(root, "generated/schema.ts"), "export const tables = { task: {} };\n");
    const paths = files.map((f) => f.path).filter((path) => path.endsWith(".ts") && !path.endsWith("index.ts") && !path.endsWith("binding.ts"));
    return {
      built,
      printed: files.find((f) => f.path.endsWith("task.expressions.ts"))!.contents,
      typeCheck: () => checkTypes(root, [...paths, "generated/schema.ts"]),
      load: async (): Promise<Record<string, (s: unknown) => unknown>> => (await import(resolve(root, "generated/domain/task.expressions.ts"))).$expressions,
    };
  }
  /** Runs `fn` and returns what it logged. */
  async function logs(fn: () => unknown): Promise<unknown[][]> {
    const seen: unknown[][] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { seen.push(args); };
    try { await fn(); } finally { console.log = log; }
    return seen;
  }
  const DAY = 86_400_000;
  const clock = { clock: () => new Date(DAY * 3 + 5_000) };

  test("%.now, %.today and Mesh.isSystem(context) translate in a computed field, a check, a set value and a policy; a plain body reads the same instant and imports Mesh", async () => {
    const source = entity(check("({ context }) => Mesh.isSystem(context) || &dueAt === null || &dueAt >= %.today") +
      "      do\n        set\n          &dueAt=() => %.now\n        run ({ context }) { console.log(%.now.getTime(), %.today.getTime(), Mesh.isSystem(context)) }\n")
      .replace("  actions auto", "  computed\n    boolean :overdue() { return &dueAt < %.now }\n  actions auto") +
      "  policies\n    policy :internal types=[:update]\n      authorize-if=({ context }) => Mesh.isSystem(context)\n    policy :readers types=[:read]\n      authorize-if=() => true\n";
    const { built, printed, typeCheck, load } = await emitted(source);
    expect(built.diagnostics).toEqual([]);
    const task = built.document!.entities[0]!;
    expect(task.computed[0]!.body!.tree).toMatchObject({ fn: "lt", args: [{}, { kind: "call", fn: "now", args: [] }] });
    const go = task.actions.find((a) => a.name === "go")!;
    expect(go.validate[0]!.that.tree).toMatchObject({ fn: "or", args: [{ fn: "or", args: [{ kind: "call", fn: "isSystem" }, {}] }, { fn: "gte", args: [{}, { kind: "call", fn: "today" }] }] });
    const [set, run] = go.do;
    expect(set!.kind === "set" ? (set!.assignments[0]!.value as Expression).tree : undefined).toMatchObject({ kind: "call", fn: "now", args: [] });
    expect(run!.kind === "run" ? run!.fn.plain : undefined).toMatchObject({ why: "run-step", clock: ["now", "today"], isSystem: true, mesh: ["Mesh"] });
    expect(task.policies[0]!.authorizeIf[0]!.tree).toMatchObject({ kind: "call", fn: "isSystem" });
    // Translated code calls the run-time functions, and so does `%.now` in plain code; the file imports `Mesh`, as it
    // imports a helper, for the plain body's `Mesh.isSystem`, and binds it nowhere.
    expect(printed).toMatch(/import \{\s+expr as \$,\s+Mesh,[^}]*\} from "@meshfw\/runtime";/);
    expect(printed).toContain("console.log($now().getTime(), $today().getTime(), Mesh.isSystem(context))");
    expect(printed).toContain("$.today($s)");
    expect(printed).not.toMatch(/const Mesh|meshIn|\$mesh/);
    expect(typeCheck()).toEqual({ code: 0, output: "" });
    const expressions = await load();
    expect(await logs(() => expressions["go.step.1.run"]!(scope({ context: { system: true } }, clock)))).toEqual([[DAY * 3 + 5_000, DAY * 3, true]]);
    expect(await logs(() => expressions["go.step.1.run"]!(scope({ context: {} }, clock)))).toEqual([[DAY * 3 + 5_000, DAY * 3, false]]);
    expect(expressions["go.step.0.set.dueAt"]!(scope({}, clock))).toEqual(new Date(DAY * 3 + 5_000));
    expect(expressions["go.check.c.that"]!(scope({ self: { dueAt: new Date(DAY * 3 - 1) }, context: {} }, clock))).toBe(false);
    expect(expressions["go.check.c.that"]!(scope({ self: { dueAt: new Date(DAY * 3 - 1) }, context: { system: true } }, clock))).toBe(true);
  }, 30_000);

  test("Mesh.privileged(Task) in a function body makes it plain code whose file imports Mesh; the tree type-checks", async () => {
    const source = entity(check("() => true") + "      do\n        run async () { const rows = await Mesh.privileged(Task).read({}); console.log(rows.length) }\n");
    const { built, printed, typeCheck } = await emitted(source);
    const run = built.document!.entities[0]!.actions.find((a) => a.name === "go")!.do[0]!;
    expect(run.kind === "run" ? run.fn.plain : undefined).toMatchObject({ privileged: true, mesh: ["Mesh"], entities: ["Task"] });
    expect(printed).toMatch(/import \{[^}]*\bMesh,[^}]*\} from "@meshfw\/runtime";/);
    expect(printed).toContain("await Mesh.privileged(Task).read({})");
    expect(typeCheck()).toEqual({ code: 0, output: "" });
  }, 30_000);

  test("an aliased import works under its alias, and the fixes name the alias", async () => {
    const aliased = (source: string) => source.replace('import { Mesh } from "meshfw"', 'import { Mesh as M } from "meshfw"');
    const source = aliased(entity(check("({ context }) => M.isSystem(context) || &dueAt === null || &dueAt < %.now") +
      "      do\n        run async () { const rows = await M.privileged(Task).read({}); console.log(rows.length, %.today.getTime()) }\n"));
    const { built, printed, typeCheck, load } = await emitted(source);
    const go = built.document!.entities[0]!.actions.find((a) => a.name === "go")!;
    expect(go.validate[0]!.that.tree).toMatchObject({ fn: "or", args: [{ fn: "or", args: [{ kind: "call", fn: "isSystem" }, {}] }, { fn: "lt", args: [{}, { kind: "call", fn: "now" }] }] });
    expect(go.do[0]!.kind === "run" ? go.do[0]!.fn.plain : undefined).toMatchObject({ privileged: true, clock: ["today"], mesh: ["M"] });
    expect(printed).toMatch(/import \{[^}]*\bMesh as M,[^}]*\} from "@meshfw\/runtime";/);
    expect(printed).not.toMatch(/\bMesh,|const M\b|const Mesh/);
    expect(typeCheck()).toEqual({ code: 0, output: "" });
    expect((await load())["go.check.c.that"]!(scope({ self: { dueAt: new Date(DAY) }, context: {} }, clock))).toBe(true);
    // `Mesh` itself is not bound in that file, and a bare Mesh function is not either: each fix names the alias.
    const plainMesh = aliased(entity(check("({ context }) => Mesh.isSystem(context)")));
    expect(problems(plainMesh)).toEqual([{ code: "MESH_EXPR_FREE_VARIABLE", message: expect.stringContaining("`Mesh` is not defined here"), fix: "write `M`, the name this file imports `Mesh` under", offset: plainMesh.indexOf("Mesh.isSystem") }]);
    expect(problems(aliased(entity(check("({ context }) => isSystem(context)"))))).toMatchObject([{ code: "MESH_EXPR_FREE_VARIABLE", fix: "write `M.isSystem(context)`" }]);
  }, 30_000);

  test("without the import, a bare Mesh function or Mesh itself is a free variable whose fix adds the import", () => {
    const IMPORT = '`import { Mesh } from "meshfw"`';
    for (const [that, call] of [["({ context }) => isSystem(context)", "Mesh.isSystem(context)"], ["async () => (await privileged(Task).read({})).length > 0", "Mesh.privileged(Task)"]] as const) {
      const source = unimported(entity(check(that)));
      const name = call.slice(5, call.indexOf("("));
      expect(problems(source)).toEqual([{
        code: "MESH_EXPR_FREE_VARIABLE",
        message: expect.stringContaining(`\`${name}\` is not defined here`),
        fix: `write \`${call}\` and import \`Mesh\` from "meshfw": ${IMPORT}`,
        offset: source.indexOf(`${name}(`),
      }]);
      // With the import, the bare name is still no Mesh function: the fix says how to write it.
      expect(problems(entity(check(that)))).toMatchObject([{ code: "MESH_EXPR_FREE_VARIABLE", fix: `write \`${call}\`` }]);
    }
    const source = unimported(entity(check("({ context }) => Mesh.isSystem(context)")));
    expect(problems(source)).toEqual([{ code: "MESH_EXPR_FREE_VARIABLE", message: expect.stringContaining("`Mesh` is not defined here"), fix: `import it: ${IMPORT}`, offset: source.indexOf("Mesh.isSystem") }]);
    // Plain code is held to the same rule.
    expect(problems(unimported(entity(check("() => true") + "      do\n        run ({ context }) { console.log(Mesh.isSystem(context)) }\n")))).toMatchObject([{ code: "MESH_EXPR_FREE_VARIABLE", fix: `import it: ${IMPORT}` }]);
    // `%.now` and `%.today` need no import: `%` is the current transaction, in every function of every entity file.
    expect(problems(unimported(entity(check("() => &dueAt === null || &dueAt < %.now") + "      do\n        run () { console.log(%.today) }\n")))).toEqual([]);
  });

  test("a member Mesh does not have is MESH_UNKNOWN_MESH_FUNCTION at the member; a member every object has is not", () => {
    const source = entity(check("() => Mesh.tomorrow() !== null"));
    expect(problems(source)).toEqual([{
      code: "MESH_UNKNOWN_MESH_FUNCTION",
      message: "`Mesh.tomorrow` is not one of Mesh's functions: `Mesh` holds `Mesh.isSystem(context)`, `Mesh.privileged(Task)`, `Mesh.checkPolicies(Task.complete, input, context)` and `Mesh.can(Task.complete, input, context)`",
      fix: "call one of them, or import a function of your own from a helper module",
      offset: source.indexOf("tomorrow"),
    }]);
    // In plain code, read without a call, and under an alias.
    expect(problems(entity(check("() => true") + "      do\n        run () { console.log(Mesh.clock) }\n")).map((p) => p.code)).toEqual(["MESH_UNKNOWN_MESH_FUNCTION"]);
    expect(problems(entity(check("() => M.later === null")).replace('import { Mesh } from "meshfw"', 'import { Mesh as M } from "meshfw"')).map((p) => p.message))
      .toEqual(["`M.later` is not one of Mesh's functions: `M` holds `M.isSystem(context)`, `M.privileged(Task)`, `M.checkPolicies(Task.complete, input, context)` and `M.can(Task.complete, input, context)`"]);
    expect(problems(entity(check("() => true") + "      do\n        run () { console.log(Mesh.toString(), Mesh.hasOwnProperty(\"now\")) }\n"))).toEqual([]);
  });

  test("called with the wrong number of arguments, a Mesh function is MESH_EXPR_ARITY, naming it as written", () => {
    expect(problems(entity(check("() => true") + "      do\n        run () { console.log(Mesh.privileged()) }\n"))).toMatchObject([{
      code: "MESH_EXPR_ARITY", message: "`Mesh.privileged()` takes 1 argument, and this call passes 0", fix: "write `Mesh.privileged(Task)`",
    }]);
    expect(problems(entity(check("() => Mesh.isSystem()")))).toMatchObject([{ code: "MESH_EXPR_ARITY", message: "`Mesh.isSystem()` takes 1 argument, and this call passes 0" }]);
  });

  test("an entity file takes Mesh alone from meshfw, under a name no other import, its entity or Mesh's own names take", () => {
    const withImport = (line: string) => entity(check("() => true")).replace('import { Mesh } from "meshfw"', line);
    const at = (source: string, text: string) => source.indexOf(text);
    let source = withImport('import { Mesh, now } from "meshfw"');
    expect(problems(source)).toEqual([{
      code: "MESH_UNKNOWN_IMPORT",
      message: '"meshfw" gives an entity file `Mesh` alone, and `now` is not it: import `Mesh` (`import { Mesh } from "meshfw"`) and call its functions as its members',
      fix: null, offset: at(source, "now }"),
    }]);
    expect(problems(withImport('import { defineConfig } from "meshfw"')).map((p) => p.code)).toEqual(["MESH_UNKNOWN_IMPORT"]);
    // Any other package, Mesh's run-time library included, is refused as before.
    expect(problems(withImport('import { Mesh } from "@meshfw/runtime"')).map((p) => [p.code, p.message])).toEqual([[
      "MESH_UNKNOWN_IMPORT", 'The import path must be relative (start with ./ or ../), or be "meshfw" for Mesh\'s own functions (`import { Mesh } from "meshfw"`)',
    ]]);
    // `Mesh` under the entity's name, or the name another import takes.
    source = withImport('import { Mesh as Task } from "meshfw"');
    expect(problems(source).map((p) => p.code)).toContain("MESH_DUPLICATE_IMPORT");
    expect(problems(withImport('import { Mesh } from "meshfw"\nimport { Task as Mesh } from "./task.mesh.mx"')).map((p) => p.code)).toEqual(["MESH_DUPLICATE_IMPORT"]);
    // A `$` alias is generated code's (CMP-06).
    expect(problems(withImport('import { Mesh as $m } from "meshfw"')).map((p) => p.code)).toEqual(["MESH_HELPER_NAME"]);
  });

  test("an entity named Mesh imports Mesh's functions under another name", () => {
    const named = (line: string) => entity(check("({ context }) => &dueAt === null || M.isSystem(context)")).replace('import { Mesh } from "meshfw"', line).replace("import { Task } from \"./task.mesh.mx\"\n", "").replace("entity :Task", "entity :Mesh").replaceAll("entity=Task", "entity=Mesh");
    expect(problems(named('import { Mesh } from "meshfw"')).map((p) => [p.code, p.message])).toContainEqual(["MESH_DUPLICATE_IMPORT", "Duplicate import identifier Mesh: the entity is named Mesh too"]);
    expect(problems(named('import { Mesh as M } from "meshfw"'))).toEqual([]);
  });

  test("Mesh read only in a type is imported for the type, and a destructured member is Mesh's function", async () => {
    const source = entity(check("() => true") + [
      "      do",
      "        run () { const is: typeof Mesh.isSystem = () => false; console.log(is({})) }",
      "        run ({ context }) { const { isSystem } = Mesh; console.log(isSystem(context)) }",
      "",
    ].join("\n"));
    const { built, printed, typeCheck, load } = await emitted(source);
    const steps = built.document!.entities[0]!.actions.find((a) => a.name === "go")!.do;
    // MX strips the type, so the front end sees no `Mesh` in the first; the back end finds it in the printed function.
    expect(steps.map((step) => (step.kind === "run" ? step.fn.plain?.mesh : "?"))).toEqual([undefined, ["Mesh"]]);
    expect(printed.match(/\bMesh,/g)).toHaveLength(1);
    expect(typeCheck()).toEqual({ code: 0, output: "" });
    const expressions = await load();
    expect(await logs(() => expressions["go.step.0.run"]!(scope({}, clock)))).toEqual([[false]]);
    expect(await logs(() => expressions["go.step.1.run"]!(scope({ context: { system: true } }, clock)))).toEqual([[true]]);
  }, 30_000);

  test("a type-only use of an aliased Mesh imports it as a type under the alias", async () => {
    const source = entity(check("() => true") + "      do\n        run () { const is: typeof M.isSystem = () => false; console.log(is({})) }\n")
      .replace('import { Mesh } from "meshfw"', 'import { Mesh as M } from "meshfw"');
    const { printed, typeCheck } = await emitted(source);
    expect(printed).toMatch(/import \{[^}]*\btype Mesh as M,[^}]*\} from "@meshfw\/runtime";/);
    expect(typeCheck()).toEqual({ code: 0, output: "" });
  }, 30_000);

  test("a member destructured from Mesh counts as a read of it: privileged so read is still MESH_COMPUTED_COMPOSES and MESH_READ_POLICY_PRIVILEGED", () => {
    const computed = (body: string, line = 'import { Mesh } from "meshfw"') =>
      entity(check("() => true")).replace("  actions auto", `  computed\n    boolean :c${body}\n  actions auto`).replace('import { Mesh } from "meshfw"', line);
    for (const [body, line] of [
      ["() { const { privileged } = Mesh; return privileged(Task).read({}) !== null }", undefined],
      ["() { const { privileged: p } = Mesh; return p(Task) !== null }", undefined],
      ['() { const { "privileged": p } = Mesh; return p(Task) !== null }', undefined],
      ["() { let p; ({ privileged: p } = Mesh); return p(Task) !== null }", undefined],
      ["() { function f({ privileged } = Mesh) { return privileged(Task) } return f() !== null }", undefined],
      ["() { const { isSystem, privileged } = M; return privileged(Task) !== null && isSystem({}) }", 'import { Mesh as M } from "meshfw"'],
    ] as const) {
      const source = computed(body, line);
      const d = build(source).diagnostics.filter((x) => x.severity === "error");
      expect(d.map((x) => x.code), body).toEqual(["MESH_COMPUTED_COMPOSES"]);
      expect(d[0]!.message).toBe("computed :c of Task calls `Mesh.privileged`, which only a function that runs inside an action may: a computed field is worked out whenever a record is loaded, outside any action");
    }
    // A read policy, at the destructured key; a write check that destructures it reads the record (POL-21).
    const policy = entity(check("({ self }) => { const { privileged } = Mesh; return privileged(Task) !== null && self.n > 0 }")) +
      "  policies\n    policy :q types=[:read]\n      authorize-if=() => { const { privileged } = Mesh; return privileged(Task) !== null }\n    policy :w types=[:update]\n      authorize-if=() => true\n";
    const built = build(policy);
    expect(built.diagnostics.filter((x) => x.severity === "error").map((x) => [x.code, x.position.offset])).toEqual([
      ["MESH_READ_POLICY_PRIVILEGED", policy.lastIndexOf("{ privileged }") + 2],
    ]);
    const that = buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source: entity(check("({ self }) => { const { privileged } = Mesh; return privileged(Task) !== null && self.n > 0 }")) }] });
    expect(that.document!.entities[0]!.actions.find((a) => a.name === "go")!.validate[0]!.that.plain).toMatchObject({ privileged: true, mesh: ["Mesh"] });
    // A key Mesh does not have is named at the key; a rest element or a computed key names no member, as passing Mesh does not.
    const later = computed("() { const { later } = Mesh; return later !== null }");
    expect(problems(later)).toMatchObject([{ code: "MESH_UNKNOWN_MESH_FUNCTION", offset: later.indexOf("later }") }]);
    for (const body of ["() { const { ...all } = Mesh; return all.isSystem({}) }", '() { const key = "isSystem"; const { [key]: f } = Mesh; return f !== null }']) {
      const source = computed(body);
      expect(problems(source), body).toEqual([]);
      expect(build(source).document!.entities[0]!.computed[0]!.body!.plain).toMatchObject({ mesh: ["Mesh"] });
      expect(build(source).document!.entities[0]!.computed[0]!.body!.plain!.privileged).toBeUndefined();
    }
  });

  test("Mesh?.isSystem() and Mesh[\"isSystem\"]() are Mesh's function, translated and plain", async () => {
    const source = entity(check('({ context }) => &dueAt === null || Mesh["isSystem"](context)') + [
      "      do",
      "        run ({ context }) { console.log(Mesh?.isSystem(context), Mesh[\"isSystem\"](context), Mesh?.[\"isSystem\"](context)) }",
      "",
    ].join("\n"));
    const { built, printed, typeCheck, load } = await emitted(source);
    const task = built.document!.entities[0]!;
    expect(task.actions.find((a) => a.name === "go")!.validate[0]!.that.tree).toMatchObject({ fn: "or", args: [{}, { kind: "call", fn: "isSystem" }] });
    const run = task.actions.find((a) => a.name === "go")!.do[0]!;
    expect(run.kind === "run" ? run.fn.plain : undefined).toMatchObject({ isSystem: true, mesh: ["Mesh"] });
    expect(typeCheck()).toEqual({ code: 0, output: "" });
    expect(printed).toContain("$.isSystem($s.context)");
    const expressions = await load();
    expect(expressions["go.check.c.that"]!(scope({ self: { dueAt: new Date(DAY) }, context: { system: true } }, clock))).toBe(true);
    expect(expressions["go.check.c.that"]!(scope({ self: { dueAt: new Date(DAY) }, context: {} }, clock))).toBe(false);
    expect(await logs(() => expressions["go.step.0.run"]!(scope({ context: { system: true } }, clock)))).toEqual([[true, true, true]]);
  }, 30_000);

  test("the file imports Mesh only for a function that reads it: a string that spells Mesh imports nothing", async () => {
    const source = unimported(entity(check("() => true")).replace("  actions auto", '  computed\n    string :s() { const x = "Mesh.isSystem(%.now)"; return x }\n  actions auto'));
    const { printed, typeCheck } = await emitted(source);
    expect(printed).toContain('"Mesh.isSystem(%.now)"');
    expect(printed).not.toMatch(/\bMesh,|\$\.now\(/);
    expect(typeCheck()).toEqual({ code: 0, output: "" });
  }, 30_000);

  test("Mesh imported under a scope name is refused at the import, and a fix never names an alias that cannot be read", () => {
    const withImport = (line: string, that = "() => true") => entity(check(that)).replace('import { Mesh } from "meshfw"', line);
    const source = withImport('import { Mesh as input } from "meshfw"');
    expect(problems(source)).toEqual([{
      code: "MESH_HELPER_NAME",
      message: "The Mesh import name input is a scope name: in every function of the file `input` is the scope's `input`, so `Mesh` imported as input could never be read",
      fix: "import it as `Mesh`, or under a name other than `self`, `input`, `actor`, `context` and `before`",
      offset: source.indexOf("input }"),
    }]);
    // A bare `isSystem()` there: the fix does not say `input.isSystem()`.
    expect(problems(withImport('import { Mesh as input } from "meshfw"', "({ context }) => isSystem(context)")).map((p) => p.fix)).toEqual([
      "import it as `Mesh`, or under a name other than `self`, `input`, `actor`, `context` and `before`",
      'write `Mesh.isSystem(context)` and import `Mesh` under a name that is not a scope name: `import { Mesh } from "meshfw"`',
    ]);
    // An alias a binding hides where the bare name is read: the fix names it and says to rename the binding.
    expect(problems(withImport('import { Mesh as M } from "meshfw"', "({ context }) => [context].some((M) => M !== null && isSystem(context))")).map((p) => p.fix))
      .toEqual(["write `M.isSystem(context)`, renaming the binding that hides `M` here"]);
    expect(problems(withImport('import { Mesh as M } from "meshfw"', "({ context }) => [1].some((M) => M === 1 && Mesh.isSystem(context))")).map((p) => p.fix))
      .toEqual(["write `M`, the name this file imports `Mesh` under, renaming the binding that hides it here"]);
  });

  test("a default, namespace or type import from meshfw is MESH_IMPORT_FORM whose fix imports Mesh by name", () => {
    const withImport = (line: string) => entity(check("() => true")).replace('import { Mesh } from "meshfw"', line);
    for (const [line, message] of [
      ['import Mesh from "meshfw"', 'import `Mesh` by name: "meshfw" gives an entity file the named export `Mesh` alone'],
      ['import * as M from "meshfw"', 'import `Mesh` by name: "meshfw" gives an entity file the named export `Mesh` alone'],
      ['import type { Mesh } from "meshfw"', "import `Mesh` as a value, not as a type: a function of the entity file calls its members"],
      ['import { type Mesh } from "meshfw"', "import `Mesh` as a value, not as a type: a function of the entity file calls its members"],
    ] as const) {
      const source = withImport(line);
      expect(problems(source), line).toEqual([{ code: "MESH_IMPORT_FORM", message, fix: 'write `import { Mesh } from "meshfw"`', offset: source.indexOf(line) }]);
    }
    // From an entity file the advice is the entity's, as before.
    expect(problems(withImport('import { Mesh } from "meshfw"\nimport type { Task as T } from "./task.mesh.mx"')).map((p) => [p.code, p.message, p.fix]))
      .toEqual([["MESH_IMPORT_FORM", "import the entity by name, not as a type: `import { List } from …`", 'write `import { Task as T } from "./task.mesh.mx"`, the entity that file declares']]);
    // From a helper file the advice is the helper's, not the entity's.
    const helper = (line: string) => problems(withImport(`import { Mesh } from "meshfw"\n${line}`)).map((p) => [p.code, p.message, p.fix]);
    expect(helper('import isStaff from "./task.helpers"')).toEqual([["MESH_IMPORT_FORM", "import a helper by name: `import { isStaff } from …`", 'write `import { isStaff } from "./task.helpers"`, naming the functions that helper file exports and this entity file uses']]);
    // The fix keeps every name the file uses: a default binding becomes a named one.
    expect(helper('import isStaff, { other } from "./task.helpers"').map((p) => p[2]))
      .toEqual(['write `import { isStaff, other } from "./task.helpers"`, naming the functions that helper file exports and this entity file uses']);
    expect(problems(withImport('import { Mesh } from "meshfw"\nimport Task, { Task as T } from "./task.mesh.mx"')).map((p) => p.fix))
      .toEqual(['write `import { Task, Task as T } from "./task.mesh.mx"`, the entity that file declares']);
    // A package other than "meshfw" is refused by its path, not advised on its form.
    expect(helper('import _ from "lodash"').map((p) => p[0])).toEqual(["MESH_UNKNOWN_IMPORT"]);
    expect(helper('import * as h from "./task.helpers"')[0]![1]).toBe("import a helper by name: `import { isStaff } from …`");
    expect(helper('import type { isStaff } from "./task.helpers"')).toEqual([["MESH_IMPORT_FORM", "import a helper by name, not as a type: `import { isStaff } from …`", 'write `import { isStaff } from "./task.helpers"`, naming the functions that helper file exports and this entity file uses']]);
  });

  test("a bare call's fix keeps the call's own arguments", () => {
    const fixes = (that: string) => problems(unimported(entity(check(that)))).map((p) => p.fix);
    expect(fixes("async () => (await privileged(Eone).read({})).length > 0")).toEqual(['write `Mesh.privileged(Eone)` and import `Mesh` from "meshfw": `import { Mesh } from "meshfw"`', expect.anything()]);
    expect(fixes("({ actor }) => isSystem(actor)")).toEqual(['write `Mesh.isSystem(actor)` and import `Mesh` from "meshfw": `import { Mesh } from "meshfw"`']);
    expect(problems(entity(check("({ context }) => isSystem(context.inner)"))).map((p) => p.fix)).toEqual(["write `Mesh.isSystem(context.inner)`"]);
    // With the wrong number of arguments the fix shows the call Mesh's function takes.
    expect(fixes("() => isSystem() || isSystem(1, 2)")).toEqual(Array(2).fill('write `Mesh.isSystem(context)` and import `Mesh` from "meshfw": `import { Mesh } from "meshfw"`'));
  });
});

describe("%.now and %.today are the current transaction's instant and date (SYN-29)", () => {
  const problems = (source: string) =>
    build(source).diagnostics.filter((d) => d.severity === "error").map((d) => ({ code: d.code, message: d.message, fix: d.fix, offset: d.position.offset }));
  const DAY = 86_400_000;
  const clock = { clock: () => new Date(DAY * 3 + 5_000) };
  /** `source` with the Mesh import removed: `%` needs none. */
  const bare = (source: string) => source.replace('import { Mesh } from "meshfw"\n', "");

  test("every expression position reads them with no import: a check, its when=, a computed field, a set value, a when= step, a run body and a policy", async () => {
    const source = bare(entity(
      "        check :c [\n          that=() => &dueAt === null || &dueAt < %.now\n          when=() => %.today !== null\n          code=\"c\"\n          message=\"m\"\n        ]\n" +
      "      do\n        set\n          &dueAt=() => %.now\n        when=() => &dueAt !== null && &dueAt >= %.today\n          set\n            &m=1\n" +
      "        run () { console.log(%.now.getTime(), %.today.getTime()) }\n",
    ).replace("  actions auto", "  computed\n    boolean :late() { return &dueAt !== null && &dueAt < %.today }\n    integer :at() { return %.now.getTime() }\n  actions auto") +
      "  policies\n    policy :w types=[:update]\n      authorize-if=() => %.now !== null\n      forbid-if=() => &dueAt !== null && &dueAt > %.now\n    policy :r types=[:read]\n      authorize-if=() => true\n");
    const built = build(source);
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const task = built.document!.entities[0]!;
    const go = task.actions.find((a) => a.name === "go")!;
    const call = (fn: string) => ({ kind: "call", fn, args: [] });
    expect(go.validate[0]!.that.tree).toMatchObject({ fn: "or", args: [{}, { fn: "lt", args: [{}, call("now")] }] });
    expect(go.validate[0]!.when!.tree).toMatchObject({ fn: "isNotNull", args: [call("today")] });
    expect(task.computed[0]!.body!.tree).toMatchObject({ fn: "and", args: [{}, { fn: "lt", args: [{}, call("today")] }] });
    // `%.now.getTime()`: a method of the instant, which Mesh does not translate; the body is plain and reads the clock.
    expect(task.computed[1]!.body!.plain).toMatchObject({ clock: ["now"] });
    expect(task.computed[1]!.body!.plain!.mesh).toBeUndefined();
    const [set, when, run] = go.do;
    expect(set!.kind === "set" ? (set!.assignments[0]!.value as Expression).tree : undefined).toMatchObject(call("now"));
    expect(when!.kind === "when" ? when!.condition.tree : undefined).toMatchObject({ fn: "and", args: [{}, { fn: "gte", args: [{}, call("today")] }] });
    expect(run!.kind === "run" ? run!.fn.plain : undefined).toMatchObject({ why: "run-step", clock: ["now", "today"] });
    expect(task.policies[0]!.authorizeIf[0]!.tree).toMatchObject({ fn: "isNotNull", args: [call("now")] });
    expect(task.policies[0]!.forbidIf[0]!.tree).toMatchObject({ fn: "and", args: [{}, { fn: "gt", args: [{}, call("now")] }] });
    // Positions are the authored `%.now`.
    expect(go.validate[0]!.that.tree).toMatchObject({ args: [{}, { args: [{}, { position: { offset: source.indexOf("< %.now\n") + 2 } }] }] });

    const root = await mkdtemp(resolve(import.meta.dir, "../mesh-transaction-"));
    roots.push(root);
    const config = configOf(root);
    const files = await generateFiles({ document: built.document!, config });
    await writeGeneratedFiles(files, config);
    await writeFile(resolve(root, "generated/schema.ts"), "export const tables = { task: {} };\n");
    const printed = files.find((f) => f.path.endsWith("task.expressions.ts"))!.contents;
    expect(printed).toContain("console.log($now().getTime(), $today().getTime())");
    expect(printed).toContain("return $now().getTime()");
    expect(printed).not.toMatch(/%\.|\bMesh\b/);
    const paths = files.map((f) => f.path).filter((path) => path.endsWith(".ts") && !path.endsWith("index.ts") && !path.endsWith("binding.ts"));
    expect(checkTypes(root, [...paths, "generated/schema.ts"])).toEqual({ code: 0, output: "" });
    const { $expressions: expressions } = await import(resolve(root, "generated/domain/task.expressions.ts"));
    expect(expressions["computed.at"](scope({ self: {} }, clock))).toBe(DAY * 3 + 5_000);
    expect(expressions["computed.late"](scope({ self: { dueAt: new Date(DAY * 3 - 1) } }, clock))).toBe(true);
    expect(expressions["computed.late"](scope({ self: { dueAt: new Date(DAY * 3) } }, clock))).toBe(false);
    expect(expressions["go.step.0.set.dueAt"](scope({}, clock))).toEqual(new Date(DAY * 3 + 5_000));
    // One scope, one instant: every read of `%.now` in it gives the same instant, and `%.today` is its date.
    let ticks = 0;
    const advancing = scope({}, { clock: () => new Date(DAY * 3 + 1_000 * ++ticks) });
    const seen: unknown[][] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { seen.push(args); };
    try { expressions["go.step.2.run"](advancing); expressions["go.step.2.run"](advancing); } finally { console.log = log; }
    expect(seen).toEqual([[DAY * 3 + 1_000, DAY * 3], [DAY * 3 + 1_000, DAY * 3]]);
    expect(expressions["computed.at"](advancing)).toBe(DAY * 3 + 1_000);
  }, 30_000);

  test("%.now and %.today are no attribute values: a default is a literal, and `x %.now` is no expression", () => {
    const attribute = (line: string) => entity(check("() => true")).replace("    json :meta\n", `    json :meta\n    ${line}\n`);
    expect(build(attribute("timestamp :at default=%.now")).diagnostics.map((d) => d.code)).toEqual(["MX_INVALID_ATTRIBUTE_VALUE"]);
    expect(build(attribute("date :on default=%.today")).diagnostics.map((d) => d.code)).toEqual(["MX_INVALID_ATTRIBUTE_VALUE"]);
    expect(build(attribute("timestamp :at default=x %.now")).diagnostics.map((d) => d.code)).toEqual(["MX_PARSE_EXPRESSION"]);
    // In a function too: `%.now` is an operand, never a modulo, and `%now` or `%` alone is no name.
    for (const that of ["() => 1 %.now", "() => %now !== null", "() => % !== null"])
      expect(build(entity(check(that))).diagnostics.map((d) => d.code), that).toEqual(["MX_PARSE_EXPRESSION"]);
  });

  test("a name the transaction does not hold is MESH_UNKNOWN_TRANSACTION_MEMBER at the `%`, in translated and plain code", () => {
    const source = entity(check("() => &dueAt < %.tomorrow"));
    expect(problems(source)).toEqual([{
      code: "MESH_UNKNOWN_TRANSACTION_MEMBER",
      message: "`%.tomorrow` is not a member of the transaction: `%` is the current transaction, and holds `%.now` and `%.today`",
      fix: "write `%.now` for the current transaction's instant, or `%.today` for the current transaction's date, its instant at 00:00 UTC",
      offset: source.indexOf("%.tomorrow"),
    }]);
    // A name every object has is no member either; plain code is held to the same rule.
    expect(problems(entity(check("() => %.toString !== null"))).map((p) => p.code)).toEqual(["MESH_UNKNOWN_TRANSACTION_MEMBER"]);
    expect(problems(entity(check("() => true") + "      do\n        run () { console.log(%.instant) }\n")).map((p) => p.code)).toEqual(["MESH_UNKNOWN_TRANSACTION_MEMBER"]);
  });

  test("calling one is MESH_TRANSACTION_CALL: it is a value, and the fix drops the ()", () => {
    const source = entity(check("() => &dueAt < %.now()"));
    expect(problems(source)).toEqual([{
      code: "MESH_TRANSACTION_CALL",
      message: "`%.now` is a value, not a function: it is the current transaction's instant",
      fix: "write `%.now`, without `()`",
      offset: source.indexOf("%.now"),
    }]);
    expect(problems(entity(check("() => %.today() !== null")))).toMatchObject([{ code: "MESH_TRANSACTION_CALL", message: "`%.today` is a value, not a function: it is the current transaction's date, its instant at 00:00 UTC", fix: "write `%.today`, without `()`" }]);
    for (const body of ["run () { console.log(%.now?.()) }", "run () { console.log(new %.today()) }", "run () { const f = () => %.now(); console.log(f()) }"])
      expect(problems(entity(check("() => true") + `      do\n        ${body}\n`)).map((p) => p.code), body).toEqual(["MESH_TRANSACTION_CALL"]);
    // A method of the instant is a call on the value, not on `%.now`.
    expect(problems(entity(check("() => %.now.getTime() > 0")))).toEqual([]);
  });

  test("a tagged template and a callee that evaluates to one call it too: MESH_TRANSACTION_CALL at the `%` (PR #100 review)", () => {
    const run = (body: string) => entity(check("() => true") + `      do\n        run () { ${body} }\n`);
    // The review's two cases: each built with no error, then failed tsc (TS2349).
    for (const [body, at, without] of [["console.log(%.now`x`)", "%.now`", "the template after it"], ["console.log((0, %.now)())", "%.now)", "`()`"]] as const) {
      const source = run(body);
      expect(problems(source), body).toEqual([{
        code: "MESH_TRANSACTION_CALL",
        message: "`%.now` is a value, not a function: it is the current transaction's instant",
        fix: `write \`%.now\`, without ${without}`,
        offset: source.indexOf(at),
      }]);
    }
    expect(problems(run("console.log(new %.today())")).map((p) => p.fix)).toEqual(["write `%.today`, without `new`"]);
    // Through parentheses, a longer sequence, a conditional's branch and `||`/`??`; in a translated position too.
    for (const body of ["console.log((%.today)())", "console.log((1, 2, %.today)`x`)", "console.log((Math.random() > 0.5 ? %.now : Date)())", "console.log((null ?? %.now)())", "console.log((%.now || Date)())", "console.log(new (0, %.today)())"])
      expect(problems(run(body)).map((p) => p.code), body).toEqual(["MESH_TRANSACTION_CALL"]);
    expect(problems(entity(check("() => (0, %.now)() !== null"))).map((p) => p.code)).toEqual(["MESH_TRANSACTION_CALL"]);
    // A value that only passes through is not called: a sequence's first expression, `&&`'s left operand, a template's expression.
    for (const body of ["console.log((%.now, Date)())", "console.log((%.now && Date)())", "console.log(String.raw`${%.now}`)"])
      expect(problems(run(body)), body).toEqual([]);
  });

  test("writing to one, or through it, is MESH_TRANSACTION_ASSIGN at the write", () => {
    const write = (body: string) => entity(check("() => true") + `      do\n        run () { ${body} }\n`);
    const source = write("%.now = new Date(0)");
    expect(problems(source)).toEqual([{
      code: "MESH_TRANSACTION_ASSIGN",
      message: "`%.now` cannot be written: `%` is the current transaction, and the current transaction's instant is read only",
      fix: "read it into a local of the function and change that: `let at = %.now`",
      offset: source.indexOf("%.now ="),
    }]);
    for (const body of ["%.today = %.now", "%.now.x = 1", "%.now += 1", "%.now++", "%.today--", "[%.now] = [new Date(0)]", "({ a: %.today } = { a: new Date(0) })", "delete %.now.x", "for (%.now of [new Date(0)]) {}", "for (%.today.x in {}) {}"])
      expect(problems(write(body)).map((p) => p.code), body).toEqual(["MESH_TRANSACTION_ASSIGN"]);
    // Reading it into a local and changing that is fine.
    expect(problems(write("let at = %.now; at = new Date(at.getTime() + 1); console.log(at)"))).toEqual([]);
  });

  test("Mesh.now and Mesh.today are gone: MESH_UNKNOWN_MESH_FUNCTION whose fix is %.now; a bare now() is a free variable whose fix is %.now", () => {
    const source = entity(check("() => &dueAt < Mesh.now()"));
    expect(problems(source)).toEqual([{
      code: "MESH_UNKNOWN_MESH_FUNCTION",
      message: "`Mesh.now` is not one of Mesh's functions: the current transaction's instant is `%.now`, a property of `%`, the current transaction",
      fix: "write `%.now`, with no `()`",
      offset: source.indexOf("now()"),
    }]);
    expect(problems(entity(check("() => Mesh.today() !== null")))).toMatchObject([{ code: "MESH_UNKNOWN_MESH_FUNCTION", fix: "write `%.today`, with no `()`" }]);
    // Under an alias, read without a call, destructured, in plain code.
    const aliased = entity(check("() => M.today !== null")).replace('import { Mesh } from "meshfw"', 'import { Mesh as M } from "meshfw"');
    expect(problems(aliased)).toMatchObject([{ code: "MESH_UNKNOWN_MESH_FUNCTION", message: expect.stringContaining("`M.today` is not one of Mesh's functions"), fix: "write `%.today`, with no `()`" }]);
    const destructured = entity(check("() => true") + "      do\n        run () { const { now } = Mesh; console.log(now()) }\n");
    expect(problems(destructured)).toMatchObject([{ code: "MESH_UNKNOWN_MESH_FUNCTION", fix: "write `%.now`, with no `()`", offset: destructured.indexOf("now }") }]);
    // A bare `now()` or `today()`, imported or not.
    for (const [that, name] of [["() => &dueAt < now()", "now"], ["() => &dueAt < today()", "today"]] as const) {
      for (const text of [entity(check(that)), bare(entity(check(that)))]) {
        expect(problems(text)).toEqual([{
          code: "MESH_EXPR_FREE_VARIABLE",
          message: expect.stringContaining(`\`${name}\` is not defined here`),
          fix: expect.stringMatching(new RegExp(`^write \`%\\.${name}\`, the current transaction's .*, with no \`\\(\\)\`$`)),
          offset: text.indexOf(`${name}()`),
        }]);
      }
    }
    // A local `Mesh` with a `now` of its own is the author's.
    expect(problems(entity(check("() => { const Mesh = { now: () => 1 }; return Mesh.now() === 1 }")))).toEqual([]);
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
    const computed = steps("        when=({ before }) => before.late\n          set\n            &m=1\n").replace("  actions auto", "  computed\n    boolean :late() { return &dueAt < %.today }\n  actions auto");
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
  test("before in a create's steps builds, as null: a member read through it is a nullable access", () => {
    const create = (extra: string) => entity("").replace("      validate\n", "").replace("  actions auto=[:read]\n", `  actions auto=[:read]\n    create :make\n      input\n        &n\n${extra}`);
    expect(codes(create("      do\n        when=({ before }) => before !== null\n          set\n            &m=1\n"))).toEqual([]);
    expect(codes(create("      do\n        set\n          &m=({ before }) => before?.n\n"))).toEqual([]);
    expect(codes(create("      do\n        run({ before }) { console.log(before) }\n"))).toEqual([]);
    expect(codes(create("      do\n        when=({ before }) => before.n > 0\n          set\n            &m=1\n"))).toEqual(["error:MESH_EXPR_NULLABLE_ACCESS"]);
    expect(codes(create("      do\n        set\n          &m=({ before }) => before.n\n"))).toEqual(["error:MESH_EXPR_NULLABLE_ACCESS"]);
    // In a check, `before` is gone altogether, and that is the error.
    expect(codes(create("      validate\n        check :c that=({ before }) => before.n > 0 code=\"c\" message=\"m\"\n"))).toContain("error:MESH_VALIDATE_BEFORE");
  });
  test("before in a plain function of an always block builds, whatever the block covers", () => {
    const withAlways = (head: string, body: string) => entity("").replace("      validate\n", "").replace("  actions auto=[:read]\n", `  actions auto=[:read]\n    always ${head}\n      do\n        ${body}\n`) + "    create :make\n      input\n        &n\n    update :go\n";
    const run = "run({ before }) { console.log(before) }";
    for (const head of ["types=[:create]", "actions=[&make]", "types=[:create, :update]", "actions=[&make, &go]"]) expect(codes(withAlways(head, run)).filter((c) => /BEFORE|NULLABLE/.test(c)), head).toEqual([]);
    expect(codes(withAlways("types=[:create]", "set\n          &n=({ before }) => { return before?.n }")).filter((c) => /BEFORE|NULLABLE/.test(c))).toEqual([]);
  });
  test("before reached through a rest parameter in a create builds", () => {
    const create = (fn: string) => entity("").replace("      validate\n", "").replace("  actions auto=[:read]\n", `  actions auto=[:read]\n    create :make\n      input\n        &n\n      do\n        ${fn}\n`);
    expect(codes(create("run({ context, ...rest }) { console.log(rest.before) }"))).toEqual([]);
    expect(codes(create("run({ context, ...rest }) { console.log(rest.self) }"))).toEqual([]);
  });
  test("a details that reads before in a create reports MESH_VALIDATE_BEFORE once", () => {
    const create = (details: string) => entity("").replace("      validate\n", "").replace("  actions auto=[:read]\n", `  actions auto=[:read]\n    create :make\n      input\n        &n\n      validate\n        check :c [\n          that=({ input }) => input.n > 0\n          code="c"\n          message="m"\n          details=${details}\n        ]\n`);
    for (const details of ["({ before }) => ({ v: before.n })", "({ before }) => { return { v: before.n } }"]) {
      const found = build(create(details)).diagnostics;
      expect(found.filter((d) => d.code === "MESH_VALIDATE_BEFORE"), details).toHaveLength(1);
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
      expect(found[0]!.fix).toMatch(/a related record through `Mesh\.privileged\(\w+\)\.read`/);
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
    const signature = (text: string, id: string) => new RegExp(`"${id.replaceAll(".", "\\.")}": (?:async )?\\(\\s*\\$s: ([\\w$]+)<`).exec(text)?.[1];
    test("checks, steps and runs after the write each get the scope that says what self is there; the files type-check", async () => {
      const source = item(`    always types=[:create, :update]\n${checkOf("({ input }) => (input.n ?? &n) > 0")}`
        + make(checkOf("({ input }) => input.n > 0") + "      do\n        set\n          &m=() => &n\n        run [after=:write] ({ self }) { console.log(self.id) }\n")
        + go(checkOf("() => &n > 0") + "      do\n        set\n          &m=({ before }) => before.n\n"));
      const { root, text, files } = await generated(source);
      expect(signature(text, "always.0.check.c.that")).toBe("$Item$NewScope");
      expect(signature(text, "make.check.c.that")).toBe("$Item$NewScope");
      expect(signature(text, "go.check.c.that")).toBe("$Item$CheckScope");
      expect(signature(text, "make.step.0.set.m")).toBe("$Item$Scope");
      expect(signature(text, "make.step.1.run")).toBe("$Item$Scope");
      expect(signature(text, "go.step.0.set.m")).toBe("$Item$StoredScope");
      expect(squash(text)).toContain(squash('export type $Item$CheckScope<I = unknown> = $Omit<$Item$Scope<I>, "before">;'));
      expect(squash(text)).toContain(squash('export type $Item$NewScope<I = unknown> = $Omit<$Item$CheckScope<I>, "self"> & { self: $DeepReadonly<$Omit<$Item$Loaded, "n" | "ownerId" | "owner"> & { [K in "n" | "ownerId" | "owner"]: $Item$Loaded[K] | null }> };'));
      expect(text).not.toContain("$Item$CreateScope");
      await writeFile(resolve(root, "check.ts"), `import type { $Item$CheckScope, $Item$NewScope } from "./generated/domain/item.expressions";
declare const check: $Item$CheckScope<unknown>;
declare const fresh: $Item$NewScope<unknown>;
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
      expect(squash(text).replace(":|", ":")).toContain(squash('self: $DeepReadonly<$Omit<$Item$Loaded, "n" | "ownerId" | "owner" | "double" | "twice" | "viaOwner" | "orSelf"> & { [K in "n" | "ownerId" | "owner" | "double" | "twice" | "viaOwner" | "orSelf"]: $Item$Loaded[K] | null }>'));
      await writeFile(resolve(root, "check.ts"), `import type { $Item$NewScope, $Item$Scope } from "./generated/domain/item.expressions";
declare const fresh: $Item$NewScope<unknown>;
declare const stored: $Item$Scope<unknown>;
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
    test("an integer key: a create's steps before the write get $Item$CreateScope, where the key may be null", async () => {
      const source = item(make(checkOf("() => &seq === null") + "      do\n        set\n          &m=() => &seq ?? 0\n        run [after=:write] ({ self }) { console.log(self.seq + 1) }\n"), "integer :seq primary-key");
      const { root, text, files } = await generated(source);
      expect(signature(text, "make.check.c.that")).toBe("$Item$NewScope");
      expect(signature(text, "make.step.0.set.m")).toBe("$Item$CreateScope");
      expect(signature(text, "make.step.1.run")).toBe("$Item$Scope");
      expect(squash(text)).toContain(squash('export type $Item$CreateScope<I = unknown> = $Omit<$Item$Scope<I>, "self"> & { self: $DeepReadonly<$Omit<$Item$Loaded, "seq"> & { [K in "seq"]: $Item$Loaded[K] | null }> };'));
      await writeFile(resolve(root, "check.ts"), `import type { $Item$CreateScope, $Item$Scope } from "./generated/domain/item.expressions";
declare const creating: $Item$CreateScope<unknown>;
declare const written: $Item$Scope<unknown>;
// @ts-expect-error the integer key is null until the data layer writes the row
export const notYet: number = creating.self.seq;
export const after: number = written.self.seq;
`);
      const paths = files.map((f) => f.path).filter((path) => path.endsWith(".ts") && !path.endsWith("index.ts") && !path.endsWith("binding.ts"));
      expect(checkTypes(root, [...paths, "generated/schema.ts", "check.ts"])).toEqual({ code: 0, output: "" });
    }, 30_000);
  });
});

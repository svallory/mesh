// A helper module hands values out through functions. A one-expression function of an entity file that reads what it
// imports from one as a value, a constant (`LIMIT`), an object's member (`limits.max`), a namespace import's member
// (`h.LIMIT`) or a function it passes along without calling it, is the build error MESH_EXPR_CAPTURED_VALUE at the name.
// Pure builds over a project on disk, since the build finds a helper module there.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModel } from "../src/front-end/build.ts";
import { checksOf } from "../src/model/action-expressions.ts";

const RULES = `export const LIMIT = 100;
export const limits = { max: 100 };
export const limit = () => 100;
export const big = (n: number) => n > 100;
export const isOpen = (row: { n: number }) => row.n > 0;
`;

interface Places {
  /** `that=` of the check of the update `:go`. */
  check?: string;
  /** `details=` of that check. */
  details?: string;
  /** `message=` of that check, written as the option's value. */
  message?: string;
  /** A line of the `computed` section. */
  computed?: string;
  /** A check line of the policy that covers the writes. */
  policy?: string;
  /** `filter=` of the read `:some`. */
  filter?: string;
  /** The lines of the `do` block of `:go`. */
  step?: string;
}
/** A Task that imports every export of the helper module by name and the module as the namespace `h`. */
const task = (at: Places) => `import { Task } from "./task.mesh.mx"
import { Mesh } from "meshfw"
import { LIMIT, limits, limit, big, isOpen } from "./rules"
import * as h from "./rules"
entity :Task
  attributes
    uuid :id primary-key
    string :title
    integer :n
  relationships
    belongs-to :parent entity=Task nullable
    has-many :children entity=Task
${at.computed ? `  computed\n    ${at.computed}\n` : ""}  policies
    policy :readers types=[:read]
      authorize-if=() => true
    policy :writers types=[:create, :update, :destroy]
      authorize-if=({ actor }) => actor.id !== null
${at.policy ? `      ${at.policy}\n` : ""}  actions auto=[:read, :destroy]
    read :some
      filter=${at.filter ?? "() => &n > 0"}
    update :go
      input
        &title
        integer :count
      validate
        check :c that=${at.check ?? "() => &n > 0"} code="c" message=${at.message ?? '"m"'}${at.details ? ` details=${at.details}` : ""}
      do
        ${at.step ?? "set\n          &n=({ input }) => input.count"}
`;

const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function build(source: string) {
  const root = mkdtempSync(join(tmpdir(), "mesh-captured-"));
  roots.push(root);
  writeFileSync(join(root, "rules.ts"), RULES);
  writeFileSync(join(root, "task.mesh.mx"), source);
  return buildModel({ root, files: [{ file: "task.mesh.mx", source }] });
}
/** Each diagnostic as `[severity, code, message, fix]`. */
const told = (source: string) => build(source).diagnostics.map((d) => [d.severity, d.code, d.message, d.fix]);
const message = (name: string) => `\`${name}\` is read as a value, and an expression only calls what it imports from a helper module: a helper module hands values out through functions`;
const FIX = "export a function from the helper module and call it: `limit()`";
/** The fix where the value is an argument of a call, which is where a function is passed along. */
const passed = (name: string) => `${FIX}; if \`${name}\` is a function, pass an arrow that calls it: \`(x) => ${name}(x)\``;
const thatOf = (result: ReturnType<typeof build>) => checksOf(result.document!.entities[0]!.actions.find((a) => a.name === "go")!.validate)[0]!.that;

describe("a helper module's value read in a one-expression function is MESH_EXPR_CAPTURED_VALUE", () => {
  test("the fixture builds clean", () => {
    const result = build(task({}));
    expect(result.diagnostics).toEqual([]);
    expect(thatOf(result).tree).toBeDefined();
  });

  // One error, at the name, with the fix. The function is plain code, and the error stands in for the plain-code warning.
  test.each<[string, Places, string, string]>([
    ["a constant, as an operand", { check: "() => &n > LIMIT" }, "LIMIT", FIX],
    ["a constant, before a construct Mesh does not translate", { check: "() => LIMIT === String(&n)" }, "LIMIT", FIX],
    ["a constant, after a construct Mesh does not translate", { check: "() => String(&n) === LIMIT" }, "LIMIT", FIX],
    ["a member of an imported object", { check: "() => &n > limits.max" }, "limits", FIX],
    ["a method of an imported object, which is no helper call", { check: "() => limits.toString() === &title" }, "limits", FIX],
    ["a member of a namespace import", { check: "() => &n > h.LIMIT" }, "h.LIMIT", FIX],
    ["a member of a namespace import, read with a string key", { check: '() => &n > h["LIMIT"]' }, "h.LIMIT", FIX],
    ["a member of a member of a namespace import", { check: "() => &n > h.limits.max" }, "h.limits", FIX],
    ["the namespace import itself", { check: "() => h === null" }, "h", FIX],
    ["a constant handed to a helper", { check: "() => big(LIMIT)" }, "LIMIT", passed("LIMIT")],
    ["a namespace member handed to a helper", { check: "() => h.big(h.LIMIT)" }, "h.LIMIT", passed("h.LIMIT")],
    ["a helper passed along without a call", { check: "() => &children.some(isOpen)" }, "isOpen", passed("isOpen")],
    ["inside a list method's arrow", { check: "() => &children.some((c) => c.n > LIMIT)" }, "LIMIT", FIX],
    ["in a `typeof`", { check: '() => typeof LIMIT === "number"' }, "LIMIT", FIX],
    ["a computed field's value", { computed: "integer :cap value=() => LIMIT" }, "LIMIT", FIX],
    ["a computed field written as a method with one return", { computed: "integer :cap() { return LIMIT }" }, "LIMIT", FIX],
    ["a filter", { filter: "() => &n > LIMIT" }, "LIMIT", FIX],
    ["a policy check", { policy: "authorize-if=({ actor }) => actor.level > LIMIT" }, "LIMIT", FIX],
    ["a `set` value", { step: "set\n          &n=() => LIMIT" }, "LIMIT", FIX],
    ["a step's `when=`", { step: "when=() => &n > LIMIT\n          set\n            &n=0" }, "LIMIT", FIX],
    ["a check's `when=`", { message: '"m" when=() => &n > LIMIT' }, "LIMIT", FIX],
    ["a check's message function", { message: "() => `at most ${LIMIT}`" }, "LIMIT", FIX],
    // Plain code for a reason found before the body is read: the read is reported all the same.
    ["a function that takes the scope whole", { check: "(s) => s.self.n > LIMIT" }, "LIMIT", FIX],
    ["a function that names an entity", { check: "() => Task !== null && &n > LIMIT" }, "LIMIT", FIX],
    ["a function that awaits a helper", { check: "async () => await big(LIMIT)" }, "LIMIT", passed("LIMIT")],
    ["a function that reads through `Mesh.privileged`", { check: "async () => (await Mesh.privileged(Task).read({})).length > LIMIT" }, "LIMIT", FIX],
    ["a function that asks another action's policies", { check: "async ({ input, context }) => (await Mesh.can(Task.go, input, context)) && &n > LIMIT" }, "LIMIT", FIX],
  ])("%s", (_, places, name, fix) => {
    const source = task(places);
    const diagnostics = build(source).diagnostics;
    expect(diagnostics.map((d) => [d.severity, d.code, d.message, d.fix])).toEqual([["error", "MESH_EXPR_CAPTURED_VALUE", message(name), fix]]);
    const { offset, line, column } = diagnostics[0]!.position;
    // The error sits at the name as written: `h["LIMIT"]` is named `h.LIMIT`, as the dot form is.
    expect(source.slice(offset)).toStartWith(name.includes(".") && source.includes(`${name.split(".")[0]}["`) ? `${name.split(".")[0]}["` : name);
    expect(line).toBe(source.slice(0, offset).split("\n").length);
    expect(column).toBe(offset - source.lastIndexOf("\n", offset - 1) - 1);
  });

  test("every read is reported, in the order written, and a called helper beside them is not", () => {
    const source = task({ check: "() => &n > LIMIT && &n < limits.max && big(limit()) && LIMIT > h.limit()" });
    const diagnostics = build(source).diagnostics;
    expect(diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["MESH_EXPR_CAPTURED_VALUE", message("LIMIT")],
      ["MESH_EXPR_CAPTURED_VALUE", message("limits")],
      ["MESH_EXPR_CAPTURED_VALUE", message("LIMIT")],
    ]);
    expect(diagnostics.map((d) => d.position.offset)).toEqual([source.indexOf("LIMIT &&"), source.indexOf("limits.max"), source.indexOf("LIMIT > h")]);
  });
});

describe("what stays legal beside MESH_EXPR_CAPTURED_VALUE", () => {
  test.each([
    ["a helper called by name", "() => &n > limit()"],
    ["a helper called with an input field", "({ input }) => big(input.count)"],
    ["a helper called through the namespace import", "({ input }) => h.big(input.count) && &n > h.limit()"],
  ])("%s is translated", (_, that) => {
    const result = build(task({ check: that }));
    expect(result.diagnostics).toEqual([]);
    expect(JSON.stringify(thatOf(result).tree)).toContain('"kind":"helper"');
  });

  test.each<[string, Places]>([
    // Plain code as a whole: its values are the author's TypeScript.
    ["a block body", { check: "() => { return &n > LIMIT }" }],
    ["a block body that keeps the value in a local", { check: "() => { const max = h.LIMIT; return &n > max || big(limits.max) }" }],
    ["a computed field written as a method with statements", { computed: "integer :cap() { const cap = LIMIT; return cap }" }],
    ["an object-literal body, a check's details", { details: "() => ({ limit: LIMIT, max: limits.max, cap: h.LIMIT, open: isOpen })" }],
    ["a run step", { step: "run () { void LIMIT; void h.limits }" }],
    // A name of the function's own hides the import, and a member or a key only spells it.
    ["a list method's parameter named as the import", { check: "() => &children.some((LIMIT) => LIMIT.n > 0)" }],
    ["a member and an object key spelled as the import", { check: "({ actor }) => actor.LIMIT > 0 && actor.h !== null", details: "() => ({ LIMIT: 1, limits: 2 })" }],
  ])("%s draws nothing", (_, places) => {
    expect(told(task(places))).toEqual([]);
  });

  test("a JavaScript global read as a value is plain code with the warning, as before", () => {
    for (const that of ["() => &n > Math.PI", "() => &n < Infinity", "() => &n < Number.MAX_SAFE_INTEGER"])
      expect(told(task({ check: that })).map(([severity, code]) => [severity, code])).toEqual([["warning", "MESH_EXPR_PLAIN"]]);
  });
});

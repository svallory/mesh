import { expect, test } from "bun:test";
import { buildModel } from "../src/front-end/build.ts";

// Narrowing through `&&` and `||` (the right operand knows what the left tested for null) holds only in a tree Mesh translates:
// a tree demoted to plain code, and the object literal of a `details`, are printed as the author's TypeScript, where tsc keeps
// no narrowing into a callback and takes `self.x` and `$self.x` for different values. A member a create has not filled is null
// on every create, so a guard does not make it known.
const source = (checks: string, create = "") => `entity :Task
  attributes
    uuid :id primary-key
    integer :n
    string :title nullable
    string :label
  relationships
    belongs-to :parent entity=Task nullable
    belongs-to :owner entity=Task
    has-many :kids entity=Task inverse=:parent
  actions auto=[:read]
    update :go
      validate
${checks}
${create}`;
const check = (parts: string) => `        check :c [\n          code="c"\n          message="m"\n${parts}\n        ]`;
const found = (checks: string, create = "") =>
  buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source: source(checks, create) }] }).diagnostics.map((d) => `${d.severity}:${d.code}`);
const that = (fn: string) => found(check(`          that=${fn}`));

test("a guard removes MESH_EXPR_NULLABLE_ACCESS from the read it covers, and only from that", () => {
  expect(that("() => &parent !== null && &parent.n > 0")).toEqual([]);
  expect(that("() => &parent === null || &parent.n > 0")).toEqual([]);
  expect(that("() => &parent.n > 0")).toEqual(["error:MESH_EXPR_NULLABLE_ACCESS"]);
  expect(that("() => &parent.n > 0 && &parent !== null")).toEqual(["error:MESH_EXPR_NULLABLE_ACCESS"]);
  expect(that("() => (&parent !== null && &n > 0) || &parent.n > 0")).toContain("error:MESH_EXPR_NULLABLE_ACCESS");
  expect(that("() => &parent === null && &parent.n > 0")).toContain("error:MESH_EXPR_NULLABLE_ACCESS");
});

test("a read inside a callback is narrowed by a guard outside it in a translated tree", () => {
  expect(that("() => &parent !== null && &kids.some((k) => k.n > &parent.n)")).toEqual([]);
  expect(that("() => &kids.some((k) => k.n > &parent.n)")).toEqual(["error:MESH_EXPR_NULLABLE_ACCESS"]);
});

test.each([
  ["a demoted tree (a callback, then a string operand of &&)", check("          that=() => true\n          when=() => &parent !== null && &kids.some((k) => k.n > &parent.n) && &title")],
  ["a details part (a callback)", check("          that=() => true\n          details=() => ({ v: &parent !== null && &kids.some((k) => k.n > &parent.n) })")],
  ["a demoted tree (self and &)", check("          that=() => true\n          when=({ self }) => self.parent !== null && &parent.n > 0 && &title")],
  ["a details part (self and &)", check("          that=() => true\n          details=({ self }) => ({ v: &parent !== null && self.parent.n > 0 })")],
])("narrowing does not reach %s, which tsc would not narrow", (_, checks) => {
  expect(found(checks)).toContain("error:MESH_EXPR_NULLABLE_ACCESS");
});

test("a demoted tree prints JavaScript division, so it has no MESH_EXPR_INTEGER_DIVISION; a translated tree has one", () => {
  const diagnostics = found(check("          that=() => true\n          when=() => &n / 2 > 0 && &title"));
  expect(diagnostics.filter((d) => d === "warning:MESH_EXPR_INTEGER_DIVISION")).toHaveLength(0);
  const translated = found(check("          that=() => &parent !== null && &n / 2 > 0"));
  expect(translated.filter((d) => d === "warning:MESH_EXPR_INTEGER_DIVISION")).toHaveLength(1);
});

test("a guard does not make known a member that a create leaves null", () => {
  const create = "    create :make\n      input\n        &n\n      validate\n";
  // `label` is required and a step fills it, so every create's check sees null.
  const filled = (fn: string) => found("", `${create}${check(`          that=${fn}`)}\n      do\n        set\n          &label="x"\n`);
  expect(filled('() => &label !== null && &label !== "x"')).toEqual(expect.arrayContaining(["warning:MESH_VALIDATE_UNFILLED", "warning:MESH_EXPR_NEGATED_UNKNOWN"]));
  expect(filled("() => &owner !== null && &owner.n > 0").filter((d) => d === "error:MESH_EXPR_NULLABLE_ACCESS")).toHaveLength(1);
});

// The conditional operator narrows as `&&` and `||` do: `c ? a : b` gives `a` what `c` proves when true and `b` what it proves when false.
const ONE = "error:MESH_EXPR_NULLABLE_ACCESS";
const read = (fn: string) => that(fn).filter((d) => d === ONE).length;

test.each([
  ["&parent", "&parent.n"],
  ["self.parent", "self.parent.n"],
])("a ternary on %s narrows the branch the guard covers", (path, member) => {
  const fn = (body: string) => `({ self, input }) => ${body}`;
  const same = path.startsWith("&") ? (body: string) => `() => ${body}` : fn;
  expect(read(same(`${path} !== null ? ${member} > 0 : false`))).toBe(0);
  expect(read(same(`${path} === null ? false : ${member} > 0`))).toBe(0);
  expect(read(same(`${path} != null ? ${member} > 0 : false`))).toBe(0);
  expect(read(same(`${path} == null ? false : ${member} > 0`))).toBe(0);
  expect(read(same(`${path} !== null ? false : ${member} > 0`))).toBe(1);
});

// `input.x` has no member access to report, so the proof is seen through MESH_EXPR_NEGATED_UNKNOWN, which narrowing silences.
const inputWarns = (value: string) =>
  buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source: source("", `    create :make\n      input\n        &title\n      do\n        set\n          &label=${value}\n`) }] })
    .diagnostics.filter((d) => d.code === "MESH_EXPR_NEGATED_UNKNOWN").length;

test("a ternary on input.x narrows the branch the guard covers", () => {
  expect(inputWarns('({ input }) => input.title !== null ? (input.title !== "x" ? "a" : "b") : "c"')).toBe(0);
  expect(inputWarns('({ input }) => input.title === null ? "c" : (input.title !== "x" ? "a" : "b")')).toBe(0);
  expect(inputWarns('({ input }) => input.title != null ? (input.title !== "x" ? "a" : "b") : "c"')).toBe(0);
  expect(inputWarns('({ input }) => input.title !== null ? "c" : (input.title !== "x" ? "a" : "b")')).toBe(1);
  expect(inputWarns('({ input }) => input.title === null ? (input.title !== "x" ? "a" : "b") : "c"')).toBe(1);
});

// `before` is allowed in a step of an action, where on a create it is null: a `set` in a create has it typed `Task | null`.
const inCreate = (value: string) =>
  buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source: source("", `    create :make\n      input\n        &n\n      do\n        set\n          &label=${value}\n`) }] })
    .diagnostics.filter((d) => d.code === "MESH_EXPR_NULLABLE_ACCESS").length;

test("a ternary on before, before.parent and the bare before narrows a read through it", () => {
  expect(inCreate("({ before }) => before !== null ? before.label : \"x\"")).toBe(0);
  expect(inCreate("({ before }) => before === null ? \"x\" : before.label")).toBe(0);
  expect(inCreate("({ before }) => before.label")).toBe(1);
  expect(inCreate("({ before }) => before !== null ? \"x\" : before.label")).toBe(1);
  expect(inCreate("({ before }) => before !== null ? (before.parent !== null ? before.parent.label : \"x\") : \"x\"")).toBe(0);
  expect(inCreate("({ before }) => before === null ? \"x\" : (before.parent === null ? \"x\" : before.parent.label)")).toBe(0);
  expect(inCreate("({ before }) => before !== null ? before.parent.label : \"x\"")).toBe(1);
});

test("a ternary narrows through a chain of guards, and only the guards it has", () => {
  expect(read("() => &parent !== null && &parent.parent !== null ? &parent.n + &parent.parent.n > 0 : false")).toBe(0);
  expect(read("() => &parent === null || &title === null ? false : &parent.n > 0")).toBe(0);
  expect(read("() => &parent !== null && &title !== null ? &parent.n > 0 : false")).toBe(0);
  // `&parent.parent` is not proven by a test of `&parent`.
  expect(read("() => &parent !== null ? &parent.parent.n > 0 : false")).toBe(1);
});

test("the branch a guard does not cover, and a test of something else, still report", () => {
  expect(read("() => &parent !== null ? false : &parent.n > 0")).toBe(1);
  expect(read("() => &parent === null ? &parent.n > 0 : false")).toBe(1);
  expect(read("() => &n > 0 ? &parent.n > 0 : false")).toBe(1);
  expect(read("() => &title !== null ? &parent.n > 0 : false")).toBe(1);
  // The test itself is not narrowed by its own result.
  expect(read("() => (&parent.n > 0) ? true : false")).toBe(1);
});

test("a nested ternary keeps the outer guard and adds its own", () => {
  expect(read("() => &parent !== null ? (&parent.parent !== null ? &parent.n + &parent.parent.n > 0 : false) : false")).toBe(0);
  expect(read("() => &parent === null ? false : (&parent.parent === null ? false : &parent.n + &parent.parent.n > 0)")).toBe(0);
  expect(read("() => &parent !== null ? (&parent.parent !== null ? true : &parent.parent.n > 0) : false")).toBe(1);
  expect(read("() => &parent !== null ? true : (&title !== null ? &parent.n > 0 : false)")).toBe(1);
  // A ternary as the test of another.
  expect(read("() => (&parent !== null ? &parent.n > 0 : false) ? &parent.parent.n > 0 : false")).toBe(2);
});

test("a ternary inside the right of && sees the guard of the left", () => {
  expect(read("() => &parent !== null && (&parent.parent !== null ? &parent.n + &parent.parent.n > 0 : false)")).toBe(0);
  expect(read("() => &parent === null || (&parent.parent !== null ? &parent.n + &parent.parent.n > 0 : false)")).toBe(0);
  expect(read("() => &parent !== null && (&title !== null ? &parent.n > 0 : false)")).toBe(0);
  expect(read("() => &title !== null && (&title !== null ? &parent.n > 0 : false)")).toBe(1);
});

test("a ternary does not narrow in a details part or a demoted tree, where tsc would not", () => {
  expect(found(check("          that=() => true\n          details=() => ({ v: &parent !== null ? &parent.n : 0 })"))).toContain(ONE);
  expect(found(check("          that=() => true\n          when=() => (&parent !== null ? &parent.n : 0) > 0 && &title"))).toContain(ONE);
  expect(found(check("          that=() => true\n          when=() => (&parent !== null ? &kids.some((k) => k.n > &parent.n) : false) && &title"))).toContain(ONE);
});

test("a ternary does not make known a member that a create leaves null", () => {
  const create = "    create :make\n      input\n        &n\n      validate\n";
  const filled = (fn: string) => found("", `${create}${check(`          that=${fn}`)}\n      do\n        set\n          &label="x"\n`);
  expect(filled('() => &label !== null ? &label !== "x" : false')).toEqual(expect.arrayContaining(["warning:MESH_VALIDATE_UNFILLED", "warning:MESH_EXPR_NEGATED_UNKNOWN"]));
  expect(filled("() => &owner !== null ? &owner.n > 0 : false").filter((d) => d === ONE)).toHaveLength(1);
});

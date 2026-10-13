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

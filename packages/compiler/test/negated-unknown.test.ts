import { expect, test } from "bun:test";
import { buildModel } from "../src/front-end/build.ts";

// MESH_EXPR_NEGATED_UNKNOWN says what an unknown value does where the expression sits (`runCheck`, MESH_VALIDATE_UNFILLED's wording):
// `that` fails the check, `when` skips it, `details` is null.
const source = (check: string) => `entity :Task
  attributes
    uuid :id primary-key
    integer :m nullable
    boolean :maybe nullable
  actions auto=[:read]
    update :go
      input
        &m
        &maybe
      validate
        check :c [
${check}
          code="c"
          message="m"
        ]
`;
const messages = (check: string) =>
  buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source: source(check) }] }).diagnostics
    .filter((d) => d.code === "MESH_EXPR_NEGATED_UNKNOWN").map((d) => d.message);

test.each([
  ["!==", "({ input }) => input.m !== 5", "unknown when it is null, so"],
  ["!", "({ self }) => !self.maybe", "unknown, so"],
] as const)("%s: the wording follows the part", (_, fn, lead) => {
  const that = messages(`          that=${fn}`);
  const when = messages(`          that=() => true\n          when=${fn}`);
  const details = messages(`          that=() => true\n          details=({ input, self }) => ({ ok: ${fn.replace(/^\(\{ \w+(, \w+)? \}\) => /, "").replace("self.", "self.").replace("input.m", "input.m")} })`);
  expect(that).toHaveLength(1);
  expect(that[0]).toContain(`${lead} the check fails (`);
  expect(when).toHaveLength(1);
  expect(when[0]).toContain(`${lead} the check is skipped (`);
  expect(when[0]).not.toContain("fails");
  expect(details).toHaveLength(1);
  expect(details[0]).toContain(`${lead} the details value is null (`);
});

test("outside a check the position is not known, so the wording keeps both outcomes", () => {
  const base = source("          that=() => true").replace("      validate\n", "").replace(/        check[\s\S]*$/, "");
  const built = buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source: base + "      do\n        set\n          &m=({ input }) => input.m !== 5 ? 1 : 2\n" }] });
  const found = built.diagnostics.filter((d) => d.code === "MESH_EXPR_NEGATED_UNKNOWN").map((d) => d.message);
  expect(found.length).toBeGreaterThan(0);
  for (const message of found) expect(message).toContain("the check fails or the row is left out");
});

// The warning's own fix, `x !== null && x !== value`, must not warn again: the right of `&&` knows what the left tested not null,
// and the right of `||` what it tested null. The same reference means the same path, and nothing else narrows.
const warned = (fn: string) => {
  const built = buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source: source(`          that=${fn}`) }] });
  return built.diagnostics.filter((d) => d.severity !== "error" || d.code.startsWith("MESH_EXPR")).map((d) => `${d.severity}:${d.code}`);
};

test.each([
  ["&&, self", "({ self }) => self.m !== null && self.m !== 5"],
  ["&&, &x", "() => &m !== null && &m !== 5"],
  ["&&, input", "({ input }) => input.m !== null && input.m !== 5"],
  ["&&, loose != null", "({ input }) => input.m != null && input.m !== 5"],
  ["||", "() => &m === null || &m !== 5"],
  ["|| loose == null", "({ input }) => input.m == null || input.m !== 5"],
  ["a chain of &&", "() => &maybe !== null && &m !== null && &m !== 5"],
  ["&& under ||", "() => &maybe === null || (&m !== null && &m !== 5)"],
  ["null on the left", "() => null !== &m && &m !== 5"],
] as const)("the fix is clean: %s", (_, fn) => {
  expect(warned(fn)).toEqual([]);
});

test.each([
  ["the test is on the wrong side", "() => &m !== 5 && &m !== null"],
  ["&& with a test for null", "() => &m === null && &m !== 5"],
  ["|| with a test for not null", "() => &m !== null || &m !== 5"],
  ["another path", "({ input }) => input.m !== null && &m !== 5"],
  ["another member", "() => &maybe !== null && &m !== 5"],
  ["an optional chain is not the same path", "({ self }) => self?.m !== null && self.m !== 5"],
] as const)("still warns: %s", (_, fn) => {
  expect(warned(fn)).toContain("warning:MESH_EXPR_NEGATED_UNKNOWN");
});

test("the right of && sees a nullable before as not null, and only inside it", () => {
  const base = source("          that=() => true").replace("      validate\n", "").replace(/        check[\s\S]*$/, "");
  const run = (value: string) => buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source: base + `      do\n        set\n          &m=${value}\n` }] })
    .diagnostics.map((d) => `${d.severity}:${d.code}`);
  expect(run("({ before }) => before.m !== null && before.m !== 5 ? 1 : 2")).toEqual([]);
  expect(run("({ before }) => before.m !== 5 && before.m !== null ? 1 : 2")).toContain("warning:MESH_EXPR_NEGATED_UNKNOWN");
});

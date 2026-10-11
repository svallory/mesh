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

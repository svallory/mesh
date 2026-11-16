import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildModel } from "../src/front-end/build.ts";
import { askCallsOf, asynchronyOf, copyExpression, demotionOf, privilegedCallsOf, scopeReachOf } from "../src/front-end/expression.ts";

// Named checks: the `checks` section, `check &name` in a `validate` block, and a check name that counts once per entity.

test("copyExpression gives the copy its own identity and every side-table entry of the original", () => {
  const source = `import { Mesh } from "meshfw"
entity :Task
  attributes
    uuid :id primary-key
    string :title
  actions auto=[:read]
    update :go
      validate
        check :odd that=async (s) => { const t = await Mesh.privileged(Task).read({}); return (await Mesh.can(Task.go, { id: s.self.id }, s.context)) && t.length > 0 } code="odd" message="odd"
        check :short that=() => &title.length < 3 code="short" message="short"
`;
  const result = buildModel({ root: "/p", files: [{ file: "task.mesh.mx", source }] });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const checks = result.document!.entities[0]!.actions[0]!.validate;
  const plain = checks[0]!.that;
  const copy = copyExpression(plain);
  expect(copy).not.toBe(plain);
  expect(copy).toEqual(plain);
  for (const table of [privilegedCallsOf, askCallsOf] as const) {
    expect(table(plain).length).toBeGreaterThan(0);
    expect(table(copy)).toEqual(table(plain));
  }
  expect(asynchronyOf(plain)).toBe("async");
  expect(asynchronyOf(copy)).toBe("async");
  expect(scopeReachOf(plain)).toBeDefined();
  expect(scopeReachOf(copy)).toEqual(scopeReachOf(plain)!);
  // A translated tree keeps what printing it as plain code needs, should the model pass demote it: the copy has its own.
  const translated = checks[1]!.that;
  const twin = copyExpression(translated);
  expect(demotionOf(twin)).toEqual(demotionOf(translated));
  expect(demotionOf(twin)).not.toBe(demotionOf(translated));
});

test("copyExpression copies every table keyed by an expression: a new one must be added to it", () => {
  const text = readFileSync(new URL("../src/front-end/expression.ts", import.meta.url), "utf8");
  expect(text.match(/new WeakMap</g)?.length).toBe(5);
});

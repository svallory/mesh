import { expect, test } from "bun:test";
import { Edge } from "@jig-lang/jig";

// `{{ }}` must print generated TypeScript verbatim: Jig's `escape` is the identity.
test("Jig renders a raw template without escaping `<`, `&`, quotes or backticks", async () => {
  const edge = Edge.create({ cache: false });
  const state = { generic: "Array<string> & Set<number>", quoted: "`${\"x\"}`" };
  const output = await edge.renderRaw("type T = {{ generic }};\nconst q = {{ quoted }};", state, "inline.ts.jig");
  expect(output).toBe('type T = Array<string> & Set<number>;\nconst q = `${"x"}`;');
});

// Recorded because the formatter, not the template, owns the final newline.
test("Jig drops the template's final newline", async () => {
  const edge = Edge.create({ cache: false });
  expect(await edge.renderRaw("a\n", {}, "inline.ts.jig")).toBe("a");
});

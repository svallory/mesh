import { expect, test } from "bun:test";
import { EmitError } from "../src/typescript/emit-error.ts";
import { renderTemplate } from "../src/typescript/render.ts";

// Jig loops over `undefined` as over an empty list, so a template written for an older view built and printed nothing.
// Mesh makes `@each` over `undefined` an error at the loop's line, naming the template and the field.
const template = (contents: string) => ({ path: ".mesh-generators/types.ts.jig", contents });
const view = { record: { name: "Todo", members: [{ key: "id", tags: ["a", "b"] }, { key: "title", tags: [] }] }, none: null, empty: [] };

async function failure(contents: string, state: object = view): Promise<EmitError> {
  const error = await renderTemplate(template(contents), state, "types").then(() => undefined, (cause) => cause);
  expect(error).toBeInstanceOf(EmitError);
  return error;
}

test("a loop over a view field the view lacks is MESH_TEMPLATE_RENDER at the loop, naming the template and the field", async () => {
  const error = await failure("// head\n@each(member in record.fields)\n{{ member.key }}\n@end\n");
  expect(error.diagnostic).toMatchObject({
    severity: "error", code: "MESH_TEMPLATE_RENDER",
    position: { file: ".mesh-generators/types.ts.jig", line: 2 },
  });
  expect(error.diagnostic.message).toBe('Generator "types" cannot render .mesh-generators/types.ts.jig: `@each(member in record.fields)` loops over `record.fields`, which the view does not have: the template is written for another version of this view');
});

test.each([
  ["a top-level field", "@each(x in members)\n{{ x }}\n@end"],
  ["with an index", "@each((x, i) in record.nope)\n{{ x }}\n@end"],
  ["with an @else branch", "@each(x in record.nope)\n{{ x }}\n@else\nnone\n@end"],
  ["inside another loop, over a field of its item", "@each(m in record.members)\n@each(t in m.labels)\n{{ t }}\n@end\n@end"],
  ["inside an @if that holds", "@if(record.name)\n@each(x in record.nope)\n@end\n@end"],
])("the same, %s", async (_, contents) => {
  const error = await failure(contents);
  expect(error.diagnostic.code).toBe("MESH_TEMPLATE_RENDER");
  expect(error.diagnostic.message).toContain("which the view does not have");
});

test("the line is the loop's own line, below other output", async () => {
  const error = await failure("a\nb\nc\n@each(x in nope)\n@end");
  expect(error.diagnostic.position.line).toBe(4);
});

test("loops over what the view has, empty or null, still render; a guarded loop over an absent optional field is skipped", async () => {
  const out = await renderTemplate(template([
    "@each(m in record.members)", "{{ m.key }}:", "@each(t in m.tags)", "{{ t }}", "@end", "@end",
    "@each(x in empty)", "never", "@end", "@each(x in none)", "never", "@end",
    "@if(optional)", "@each(x in optional.items)", "never", "@end", "@end", "@each(x in empty)", "never", "@else", "else", "@end",
  ].join("\n")), view, "types");
  expect(out).toBe("id:\na\nb\ntitle:\nelse");
});

import { expect, test } from "bun:test";
import { buildModel } from "../src/front-end/build.ts";
import { expressionsView } from "../src/typescript/views/expressions.ts";
import { configOf } from "./generated.ts";

// The comment above each function of `<entity>.expressions.ts` says where the function is written. It is read from the
// function's own position, never from the entity's file: an entity's lines can come from another file (a mixin).

const FILE = "billing/invoice.mesh.mx";
const source = `entity :Invoice
  attributes
    uuid :id primary-key
    integer :amount
  computed
    integer :double value=() => &amount * 2
  actions auto=[:read]
`;

const viewOf = (move: (file: string) => string) => {
  const result = buildModel({ root: "/p", files: [{ file: FILE, source }] });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const document = result.document!;
  const entity = document.entities[0]!;
  const body = entity.computed[0]!.body!;
  body.position = { ...body.position, file: move(body.position.file) };
  return expressionsView({ document, config: configOf("/p") }, entity, "generated/domain/billing/invoice.expressions.ts");
};

test("a function's comment names the file the function is written in", () => {
  const [entry] = viewOf(() => "shared/doubled.mesh.mx").entries;
  expect(entry!.comment).toBe("computed double, translated (shared/doubled.mesh.mx:6:27)");
});

test("a function written in the entity's own file is labelled with that file", () => {
  const [entry] = viewOf((file) => file).entries;
  expect(entry!.comment).toBe(`computed double, translated (${FILE}:6:27)`);
});

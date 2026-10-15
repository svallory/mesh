// The bracket form `run [after=:write] ({ self }) { ... }` (ADR-0068) lowers to one `value` attribute, the method, and
// raises no warning (MX alpha.17, #500). Before, MX lowered it to two and warned; Mesh filtered that warning by message
// text. A real duplicate still warns, with the stable code `MESH_DUPLICATE_OPTION`: match the code, never the message.
import { lowerSource } from "@mxlang/core";
import { expect, test } from "bun:test";
import { parseEntitySource } from "../src/front-end/build.ts";
import { SYNTAX_DIALECT } from "./syntax-dialect.ts";
import { tags } from "../src/front-end/tree.ts";

const entity = (step: string) =>
  `entity :Todo\n  attributes\n    uuid :id primary-key\n    string :title\n  actions\n    update :rename\n      do\n        ${step}\n`;

test("run [after=:write] (...) { ... } lowers to one value and no warning", () => {
  const { ir, diagnostics } = parseEntitySource(entity("run [after=:write] ({ self }) { console.log(self.title) }"), "/v/todo.mesh.mx");
  expect(diagnostics).toEqual([]);
  const find = (nodes: ReturnType<typeof tags>): ReturnType<typeof tags>[number] | undefined => {
    for (const tag of nodes) {
      if (tag.name === "run") return tag;
      const inner = find(tags(tag.children as never));
      if (inner) return inner;
    }
    return undefined;
  };
  const run = find(tags(ir!.body))!;
  expect(run.attrs.filter((a) => a.kind !== "spread" && a.name === "value")).toHaveLength(1);
  expect(run.attrs.filter((a) => a.kind !== "spread" && a.name === "after")).toHaveLength(1);
});

test("a real duplicate option warns with the code MESH_DUPLICATE_OPTION", () => {
  const { diagnostics } = lowerSource("<x a=1 a=2/>", "/v/x.mesh.mx", { dialect: SYNTAX_DIALECT });
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ severity: "warning", code: "MESH_DUPLICATE_OPTION" });
});

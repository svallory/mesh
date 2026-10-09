import { expect, test } from "bun:test";
import { build, keyed } from "./v4.ts";
import { positionOf } from "../../model/test/source.ts";
import { parse } from "./helpers.ts";

test("tabs, CRLF, Unicode text and explicit false flags preserve UTF-16 positions", () => {
  const source =
    "entity :Todo table='😀é'\r\n\tattributes\r\n\t\tuuid :id primary-key\r\n\t\tstring :title nullable=false default='hé'\r\n\tactions\r\n\t\tcreate :create\r\n\t\t\tinput\r\n\t\t\t\t&title\r\n";
  const result = build(source);
  expect(result.diagnostics).toEqual([]);
  const entity = result.document!.entities[0]!;
  expect(entity.table).toBe("😀é");
  expect(entity.attributes[1]).toMatchObject({
    nullable: false,
    default: "hé",
    position: positionOf(source, "todo/todo.mesh.mx", "string :title"),
  });
  expect(entity.actions[0]!.input[0]).toEqual({
    kind: "member",
    ref: {
      name: "title",
      position: positionOf(source, "todo/todo.mesh.mx", "&title"),
    },
  });
});
test("nested expression text is kept as authored, never printed or evaluated", () => {
  const source =
    keyed +
    "    integer :n default=(\n      -15\n    )\n  actions\n    update :increment\n      do\n        set\n          &n=({ input, self }) => self.n + input.n\n";
  const result = build(source);
  expect(result.diagnostics).toEqual([]);
  expect(result.document!.entities[0]!.attributes[1]!.default).toBe(-15);
  expect(result.document!.entities[0]!.actions[0]!.do[0]).toMatchObject({
    kind: "set",
    assignments: [
      {
        value: {
          source: "({ input, self }) => self.n + input.n",
          params: ["input", "self"],
        },
      },
    ],
  });
});
test.each(["create", "read", "update", "destroy"])(
  "%s without input has an empty list",
  (kind) => {
    expect(
      build(keyed + `  actions\n    ${kind} :custom\n`).document!.entities[0]!
        .actions[0],
    ).toMatchObject({ kind, input: [], validate: [], do: [] });
  },
);
test("comments under structural rejection are ignored, not stripped", () => {
  const source =
    "// leading\n" + keyed + "    // inside attributes\n  // inside entity\n";
  expect(parse(source).diagnostics).toEqual([]);
  expect(build(source).diagnostics).toEqual([]);
  expect(build("// only comment\n").diagnostics[0]!.code).toBe(
    "MESH_DUPLICATE_ENTITY",
  );
});
test("self.x stays legal and unmodified", () => {
  const source =
    keyed +
    "  actions\n    read :all\n      filter=({ self }) => self.id !== null\n";
  expect(build(source).document!.entities[0]!.actions[0]!.filter?.source).toBe(
    "({ self }) => self.id !== null",
  );
});
test("duplicate options preserve MX warnings and the last value", () => {
  const source = keyed.replace(
    "entity :Todo",
    'entity :Todo table="first" table="last"',
  );
  const result = build(source);
  expect(result.document!.entities[0]!.table).toBe("last");
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]!.severity).toBe("warning");
});

// The `atom-value` row and the `Atom` node type (ported from the Mesh part of MX's `value-position.test.ts` at MX commit
// 750c80ec1, the 14:30 ruling; `::NAME` reserved-form test added by MX in 750c80ec1). A claimed default value ends where a
// spaced `:name` starts, so `belongs-to=:List :list` is the default `:List` and the name `:list`. The tests of the value-position
// mechanism itself (a `~ref` dialect, `mx:String`, node-type registration errors) are core's, not Mesh's, and are not ported.
import type { Dialect, DialectNode, NodeType } from "@mxlang/core";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MESH_DIALECT } from "../src/front-end/dialect.ts";
import { corpusFiles, parseEntity } from "./mesh-corpus.ts";

interface Atom extends DialectNode {
  readonly name: string;
}

/** `MESH_DIALECT` with no value row: what Mesh's alpha.15 dialect was. */
const NO_VALUE_ROW: Dialect = (() => {
  const { valueTriggers: _, ...table } = MESH_DIALECT.table;
  const { nodeTypes: __, ...rest } = MESH_DIALECT;
  return { ...rest, table };
})();

const meshDiagnostics = (source: string, dialect: Dialect) =>
  parseEntity(source, "/x/old-relationship.mesh.mx", dialect).diagnostics.map((each) => [each.message, each.line, each.column]);

describe("the atom value row", () => {
  test("is one row, `atom-value`, naming the `Atom` node under the dialect id `mesh`", () => {
    expect(MESH_DIALECT.id).toBe("mesh");
    const rows = MESH_DIALECT.table.valueTriggers ?? [];
    expect(rows.map((row) => row.id)).toEqual(["atom-value"]);
    expect(rows[0]).toMatchObject({ chars: ":", standIn: "keep", node: { type: "Atom", dialect: "mesh" } });
    expect(Object.keys(MESH_DIALECT.nodeTypes ?? {})).toEqual(["Atom"]);
  });

  test("`Atom` parses `:name`, prints it back and lowers to an atom-marked string literal", () => {
    const type = MESH_DIALECT.nodeTypes?.Atom as NodeType<Atom>;
    const node = type.parse(":rename-all", { sourceStart: 0, sourceEnd: 11 }, {} as never);
    expect(node).toEqual({ name: "rename-all" });
    expect(type.print({ name: "rename-all" } as Atom)).toBe(":rename-all");
  });
});

describe("a claimed default value ends at a terminating attribute row", () => {
  // `fixtures/mesh-corpus/entities/.../negative/old-relationship.mesh.mx`.
  const source = "entity :Todo\n  attributes\n    uuid :id primary-key\n  relationships\n    belongs-to=:List :list\n";

  test("`belongs-to=:List :list` is the default `:List` and the name `:list`", () => {
    expect(meshDiagnostics(source, MESH_DIALECT)).toEqual([["`<belongs-to>`: unknown attribute `value`", 5, 14]]);
  });

  test("with no value row the value runs on, as it did in Mesh's alpha.15 dialect", () => {
    expect(meshDiagnostics(source, NO_VALUE_ROW)).toEqual([["Expected a single expression, but found `:` after it.", 5, 21]]);
  });

  test("over Mesh's whole corpus the value row changes only `old-relationship`", () => {
    const files = corpusFiles();
    expect(files.length).toBeGreaterThan(60);
    const lowered = (file: string, dialect: Dialect) =>
      JSON.stringify(parseEntity(readFileSync(join(import.meta.dir, "fixtures/mesh-corpus", file), "utf8"), `/mesh-corpus/${file}`, dialect));
    const changed = files.filter((file) => lowered(file, MESH_DIALECT) !== lowered(file, NO_VALUE_ROW));
    expect(changed).toEqual(["entities/packages/compiler/test/fixtures/negative/old-relationship.mesh.mx"]);
  });

  test("a value the row declines keeps the expression's end", () => {
    const declining: Dialect = {
      ...MESH_DIALECT,
      nodeTypes: { Atom: { keys: [], parse: () => undefined, print: () => "", lower: () => "" } satisfies NodeType<Atom> },
    };
    expect(meshDiagnostics(source, declining)).toEqual(meshDiagnostics(source, NO_VALUE_ROW));
  });
});

describe("the value row leaves `::NAME` to the atom trigger's reserved-form error", () => {
  // `atom-value` matches `:NAME`, never `::NAME`, so `::Foo` is refused as it is with no value row. A copy of the row that
  // widens its match to `::` would claim the value and pass the reserved form silently.
  const reserved = "`::Foo` is reserved: `::` will be the Symbol.for sugar; write `:Foo` for an atom";

  test("a default value `belongs-to=::Foo` is refused at its `::`", () => {
    expect(meshDiagnostics("entity :Todo\n  belongs-to=::Foo\n", MESH_DIALECT)).toEqual([[reserved, 2, 13]]);
  });

  test("an attribute value `to=::Foo` is refused at its `::`", () => {
    expect(meshDiagnostics("relationships\n  belongs-to to=::Foo\n", MESH_DIALECT)).toEqual([[reserved, 2, 16]]);
  });
});

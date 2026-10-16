// MX 0.1.0-alpha.27: Mesh's dialect renames every MX code but the four MX keeps through `diagnosticCodes`,
// so a Mesh user sees `MESH_*` codes, in the build and in every tool that loads the dialect. The map is `MX_TO_MESH_CODES`
// (`src/front-end/diagnostic-codes.ts`). The catalogue is MX's own list of every code core raises, so a new MX alpha that adds a
// code fails the first test until the map names it.
import { lowerSource, MX_DIAGNOSTIC_CODES, type Dialect } from "@mxlang/core";
import { describe, expect, test } from "bun:test";
import { buildModel } from "../src/front-end/build.ts";
import { deepFreeze } from "../src/front-end/deep-freeze.ts";
import { MX_KEPT_CODES, MX_TO_MESH_CODES } from "../src/front-end/diagnostic-codes.ts";
import { MESH_DIALECT } from "../src/front-end/dialect.ts";

const map: Readonly<Record<string, string>> = MX_TO_MESH_CODES;
const kept = new Set<string>(MX_KEPT_CODES);
const catalogue = new Set<string>(MX_DIAGNOSTIC_CODES.map((entry) => entry.code));

/** Mesh's dialect without its map: what the same source gives with MX's own codes. */
function unmapped(dialect: Dialect): Dialect {
  const { diagnosticCodes: _, ...rest } = dialect;
  return deepFreeze(rest);
}

const codesOf = (diagnostics: readonly { code?: string; line: number; column: number }[]) =>
  diagnostics.map((d) => [d.code, d.line, d.column]);

describe("the map", () => {
  test("names a MESH_* code for every MX code but the four MX keeps", () => {
    const missing: string[] = [];
    let checked = 0;
    for (const { code } of MX_DIAGNOSTIC_CODES) {
      if (kept.has(code)) continue;
      checked++;
      if (!Object.hasOwn(map, code)) {
        missing.push(code);
        continue;
      }
      expect(map[code], code).toMatch(/^MESH_[A-Z0-9_]+$/);
    }
    expect(missing).toEqual([]);
    expect(checked).toBe(MX_DIAGNOSTIC_CODES.length - MX_KEPT_CODES.length);
  });

  test("names no kept code and no code outside MX's catalogue", () => {
    for (const code of kept) expect(catalogue.has(code), code).toBe(true);
    for (const key of Object.keys(map)) {
      expect(kept.has(key), key).toBe(false);
      expect(catalogue.has(key), key).toBe(true);
    }
  });

  test("is the frozen map of MESH_DIALECT", () => {
    expect(MESH_DIALECT.diagnosticCodes).toBe(MX_TO_MESH_CODES);
    expect(Object.isFrozen(MX_TO_MESH_CODES)).toBe(true);
  });
});

describe("a .mesh.mx file with an MX error builds to Mesh's code", () => {
  const source = "entity :Todo\n  mystery :x\n";

  test("an unknown tag is MESH_UNKNOWN_TAG, at MX's position, with MX's message", () => {
    const result = buildModel({ root: "/project", files: [{ file: "todo.mesh.mx", source }] });
    expect(result.document).toBeNull();
    expect(result.diagnostics.map((d) => [d.severity, d.code, d.position.line, d.position.column, d.message])).toEqual([
      ["error", "MESH_UNKNOWN_TAG", 2, 2, "`mystery` is not a known tag in the `mesh` dialect"],
    ]);
    // The control: the same file through the dialect without its map gives MX's own code at the same place.
    expect(codesOf(lowerSource(source, "/v/todo.mesh.mx", { dialect: unmapped(MESH_DIALECT) }).diagnostics)).toEqual([
      ["MX_UNKNOWN_TAG", 2, 2],
    ]);
  });

  test("an unknown option is MESH_UNKNOWN_OPTION and a bad option value MESH_OPTION_VALUE", () => {
    const entity = (line: string) => `entity :Todo\n  attributes\n    uuid :id primary-key\n    ${line}\n`;
    const codes = (line: string) =>
      buildModel({ root: "/project", files: [{ file: "todo.mesh.mx", source: entity(line) }] }).diagnostics.map((d) => d.code);
    expect(codes("boolean :ok min=0")).toEqual(["MESH_UNKNOWN_OPTION"]);
    expect(codes("timestamp :at default=%.now")).toEqual(["MESH_OPTION_VALUE"]);
  });

  // MX raises `MX_DUPLICATE_DECLARATION` for a name two module statements declare, but it checks the module scope only under
  // tag rules other than `none`, and Mesh's dialect has `tagRules: "none"`: MX never checks an entity file's imports, and
  // Mesh's own check gives `MESH_DUPLICATE_IMPORT` at the same place. Mesh's dialect with MX's `html` rules shows the map's
  // rename of MX's code to that same one.
  describe("MX_DUPLICATE_DECLARATION is MESH_DUPLICATE_IMPORT", () => {
    const twice = 'import { List } from "./list.mesh.mx"\nimport { List } from "./list.mesh.mx"\nentity :Todo\n  attributes\n    uuid :id primary-key\n';
    const list = { file: "list.mesh.mx", source: "entity :List\n  attributes\n    uuid :id primary-key\n" };
    const checking = deepFreeze({ ...MESH_DIALECT, tagRules: "html" as const });

    test("where MX checks the imports, the map renames its code", () => {
      expect(map.MX_DUPLICATE_DECLARATION).toBe("MESH_DUPLICATE_IMPORT");
      expect(codesOf(lowerSource(twice, "/v/todo.mesh.mx", { dialect: checking }).diagnostics)).toEqual([["MESH_DUPLICATE_IMPORT", 2, 9]]);
      expect(codesOf(lowerSource(twice, "/v/todo.mesh.mx", { dialect: unmapped(checking) }).diagnostics)).toEqual([
        ["MX_DUPLICATE_DECLARATION", 2, 9],
      ]);
    });

    test("Mesh's build of the file gives the same code at the same place, and no MX code", () => {
      const result = buildModel({ root: "/project", files: [{ file: "todo.mesh.mx", source: twice }, list] });
      expect(result.diagnostics.map((d) => [d.code, d.position.line, d.position.column])).toEqual([["MESH_DUPLICATE_IMPORT", 2, 9]]);
    });
  });
});

describe("what the map does not rename", () => {
  test("a Mesh hook that throws is MX_DIALECT_HOOK_ERROR, a kept code", () => {
    const throwing = deepFreeze({
      ...MESH_DIALECT,
      explainUnknownTag: () => {
        throw new Error("planted");
      },
    });
    const codes = lowerSource("entity :Todo\n  mystery :x\n", "/v/todo.mesh.mx", { dialect: throwing }).diagnostics.map((d) => d.code);
    expect(codes).toContain("MX_DIALECT_HOOK_ERROR");
    expect(codes.filter((code) => code?.startsWith("MX_") && !kept.has(code))).toEqual([]);
  });

  test("a dialect that fails to load renames nothing: its error is MX's", () => {
    const broken = deepFreeze({ ...MESH_DIALECT, contracts: { box: { attributes: { a: { type: "string", bogus: 1 } } } } } as unknown as Dialect);
    expect(lowerSource("<div/>", "/v/x.mesh.mx", { dialect: broken }).diagnostics.map((d) => d.code)).toEqual(["MX_INVALID_DIALECT_CONTRACT"]);
  });
});

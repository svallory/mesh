import { describe, expect, test } from "bun:test";
import { formatDiagnostic, type Diagnostic } from "../src/index.ts";

const base: Diagnostic = {
  severity: "error",
  code: "MESH_DUPLICATE_RESOURCE",
  message: 'resource "post" is already declared in a.mx',
  position: { file: "b.mx", line: 3, column: 0, offset: 25 },
  fix: null,
};

describe("formatDiagnostic", () => {
  test("prints the stored 0-based column 1-based, as MX does", () => {
    expect(formatDiagnostic(base)).toBe(
      'b.mx:3:1: resource "post" is already declared in a.mx',
    );
    expect(
      formatDiagnostic({ ...base, position: { file: "b.mx", line: 12, column: 17, offset: 300 } }),
    ).toBe('b.mx:12:18: resource "post" is already declared in a.mx');
  });

  test("appends the fix hint when there is one", () => {
    expect(formatDiagnostic({ ...base, fix: "rename one of them" })).toBe(
      'b.mx:3:1: resource "post" is already declared in a.mx (fix: rename one of them)',
    );
  });

  test("keeps an empty-string fix visible rather than treating it as absent", () => {
    expect(formatDiagnostic({ ...base, fix: "" })).toEndWith("(fix: )");
  });

  test("survives a JSON round trip", () => {
    const d = { ...base, fix: "x" };
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });
});

import { describe, expect, test } from "bun:test";
import { formatDiagnostic, type Diagnostic } from "../src/index.ts";

const base: Diagnostic = {
  severity: "error",
  code: "MESH_DUPLICATE_ENTITY",
  message: 'entity :Post is already declared in a.mesh.mx',
  position: { file: "b.mesh.mx", line: 3, column: 0, offset: 25 },
  fix: null,
};

describe("formatDiagnostic", () => {
  test("prints the stored 0-based column 1-based, as MX does", () => {
    expect(formatDiagnostic(base)).toBe('b.mesh.mx:3:1 error entity :Post is already declared in a.mesh.mx');
    expect(formatDiagnostic({ ...base, position: { file: "b.mesh.mx", line: 12, column: 17, offset: 300 } }))
      .toBe('b.mesh.mx:12:18 error entity :Post is already declared in a.mesh.mx');
  });
  test("puts the fix hint on a second indented line only when present", () => {
    expect(formatDiagnostic({ ...base, fix: "rename one of them" }))
      .toBe('b.mesh.mx:3:1 error entity :Post is already declared in a.mesh.mx\n  fix: rename one of them');
    expect(formatDiagnostic(base).split("\n")).toHaveLength(1);
  });
  test("keeps an empty-string fix visible rather than treating it as absent", () => {
    expect(formatDiagnostic({ ...base, fix: "" })).toEndWith("\n  fix: ");
  });
  test("prints warnings in the same diagnostic shape", () => {
    expect(formatDiagnostic({ ...base, severity: "warning" })).toBe('b.mesh.mx:3:1 warning entity :Post is already declared in a.mesh.mx');
  });
  test("escapes multiline messages and fixes without injecting extra lines", () => {
    expect(formatDiagnostic({ ...base, message: "bad\nvalue\rhere", fix: "try\u2028again\u2029" }))
      .toBe("b.mesh.mx:3:1 error bad\\nvalue\\rhere\n  fix: try\\u2028again\\u2029");
  });
  test("survives a JSON round trip", () => {
    const d = { ...base, fix: "x" };
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });
});

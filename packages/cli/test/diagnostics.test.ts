import { expect, test } from "bun:test";
import { diagnostic, printDiagnostics, sortDiagnostics } from "../src/diagnostics.ts";

test("diagnostics sort by file, line, column, then message without mutating the input", () => {
  const at = (file: string, line: number, column: number, message: string) => ({
    ...diagnostic(file, message), position: { file, line, column, offset: 0 },
  });
  const input = [at("z.mx", 1, 0, "a"), at("a.mx", 2, 1, "a"), at("a.mx", 1, 2, "a"),
    at("a.mx", 1, 0, "z"), at("a.mx", 1, 0, "a")];
  expect(sortDiagnostics(input)).toEqual([input[4]!, input[3]!, input[2]!, input[1]!, input[0]!]);
  expect(input[0]!.position.file).toBe("z.mx");
  const output: string[] = [];
  printDiagnostics(input, (text) => { output.push(text); });
  expect(output.join("")).toBe("a.mx:1:1 error MESH_CLI a\na.mx:1:1 error MESH_CLI z\na.mx:1:3 error MESH_CLI a\na.mx:2:2 error MESH_CLI a\nz.mx:1:1 error MESH_CLI a\n5 errors, 0 warnings\n");
});

test("summary counts both severities after all diagnostics", () => {
  const output: string[] = [];
  printDiagnostics([diagnostic("a.mx", "bad"), { ...diagnostic("b.mx", "notice"), severity: "warning" }],
    (text) => { output.push(text); });
  expect(output.join("")).toBe("a.mx:1:1 error MESH_CLI bad\nb.mx:1:1 warning MESH_CLI notice\n1 error, 1 warning\n");
});

test("each line prints its own code: a Mesh error, a Mesh warning and an MX code, in the unchanged sort order", () => {
  const at = (file: string, line: number, column: number, code: string, severity: "error" | "warning", message: string) => ({
    severity, code, message, position: { file, line, column, offset: 0 }, fix: null,
  });
  const output: string[] = [];
  printDiagnostics([
    at("b.mesh.mx", 2, 8, "MESH_UNKNOWN_TAG", "error", "`<x>` is not a known tag"),
    at("a.mesh.mx", 22, 8, "MESH_UNKNOWN_MEMBER", "error", "&titel is not a member of todo.Todo. Did you mean &title?"),
    at("a.mesh.mx", 3, 0, "MESH_EXPR_PLAIN", "warning", "this expression runs as plain TypeScript"),
  ], (text) => { output.push(text); });
  expect(output.join("")).toBe([
    "a.mesh.mx:3:1 warning MESH_EXPR_PLAIN this expression runs as plain TypeScript",
    "a.mesh.mx:22:9 error MESH_UNKNOWN_MEMBER &titel is not a member of todo.Todo. Did you mean &title?",
    "b.mesh.mx:2:9 error MESH_UNKNOWN_TAG `<x>` is not a known tag",
    "2 errors, 1 warning", ""].join("\n"));
});

test("a diagnostic that arrives without a code prints without one, and invents none", () => {
  const output: string[] = [];
  const { code: _code, ...noCode } = diagnostic("a.mx", "odd");
  printDiagnostics([noCode as never], (text) => { output.push(text); });
  expect(output.join("")).toBe("a.mx:1:1 error odd\n1 error, 0 warnings\n");
});

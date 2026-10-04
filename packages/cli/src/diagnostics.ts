import { formatDiagnostic, type Diagnostic } from "@mesh/model";

export const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) =>
    compareText(a.position.file, b.position.file) ||
    a.position.line - b.position.line ||
    a.position.column - b.position.column ||
    compareText(a.message, b.message));
}

export function diagnostic(file: string, message: string): Diagnostic {
  return { severity: "error", code: "MESH_CLI", message,
    position: { file, line: 1, column: 0, offset: 0 }, fix: null };
}

export function printDiagnostics(diagnostics: readonly Diagnostic[], write: (text: string) => void): void {
  for (const entry of sortDiagnostics(diagnostics)) write(`${formatDiagnostic(entry)}\n`);
  const errors = diagnostics.filter((entry) => entry.severity === "error").length;
  const warnings = diagnostics.length - errors;
  write(`${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}\n`);
}

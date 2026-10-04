import type { SourcePosition } from "./position.ts";

export type DiagnosticSeverity = "error" | "warning";

/** One build error of Mesh's own (not MX's). Names the file, the line and, when known, the fix. */
export interface Diagnostic {
  severity: DiagnosticSeverity;
  /** Stable identifier, for example `MESH_DUPLICATE_RESOURCE`. Never reworded once shipped. */
  code: string;
  message: string;
  position: SourcePosition;
  /** What the author should do, when there is a single obvious fix. */
  fix: string | null;
}

/**
 * `file:line:column: message`, with the fix hint appended when there is one. The stored
 * column is 0-based; the printed one is 1-based, as MX's own formatters print it and as
 * editors and terminals open `file:line:column`.
 */
export function formatDiagnostic(d: Diagnostic): string {
  const { file, line, column } = d.position;
  const head = `${file}:${line}:${column + 1}: ${d.message}`;
  return d.fix === null ? head : `${head} (fix: ${d.fix})`;
}

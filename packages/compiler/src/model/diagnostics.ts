import type { Diagnostic, SourcePosition } from "@meshfw/model";

/** UTF-16 position conversion only; never interprets entity syntax. */
export function positionAt(
  source: string,
  file: string,
  offset: number,
): SourcePosition {
  const before = source.slice(0, offset);
  return {
    file,
    line: before.split("\n").length,
    column: offset - (before.lastIndexOf("\n") + 1),
    offset,
  };
}
export function error(
  code: string,
  message: string,
  position: SourcePosition,
  fix: string | null = null,
): Diagnostic {
  return { severity: "error", code, message, position, fix };
}

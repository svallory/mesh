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
/**
 * The UTF-16 offset of a 1-based line and a 0-based column, counted as MX counts them (MX's `offsetOf` is not exported):
 * a line starts after a `\n` only, and a line or a column past the end clamps to the text's length. The inverse of
 * `positionAt`, for a diagnostic MX positions in another file, which arrives with `offset: -1`.
 */
export function offsetAt(source: string, line: number, column: number): number {
  if (line < 1) return source.length;
  let start = 0;
  for (let at = 1; at < line; at++) {
    const newline = source.indexOf("\n", start);
    if (newline === -1) return source.length;
    start = newline + 1;
  }
  return Math.min(start + column, source.length);
}
export function error(
  code: string,
  message: string,
  position: SourcePosition,
  fix: string | null = null,
): Diagnostic {
  return { severity: "error", code, message, position, fix };
}

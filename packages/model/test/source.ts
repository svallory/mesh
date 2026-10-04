import type { SourcePosition } from "../src/index.ts";

/** Position of the `nth` (0-based) occurrence of `needle` in `source`. Throws if absent. */
export function positionOf(
  source: string,
  file: string,
  needle: string,
  nth = 0,
): SourcePosition {
  let offset = -1;
  for (let i = 0; i <= nth; i++) {
    offset = source.indexOf(needle, offset + 1);
    if (offset === -1) {
      throw new Error(`${file}: occurrence ${nth} of ${JSON.stringify(needle)} not found`);
    }
  }
  const before = source.slice(0, offset);
  const lastNewline = before.lastIndexOf("\n");
  return {
    file,
    line: before.split("\n").length,
    column: offset - (lastNewline + 1),
    offset,
  };
}

// `offsetAt` turns MX's line and column into an offset in a text (a diagnostic MX positions in another file comes with
// `offset: -1`). It counts as MX does: lines end at `\n` only, columns in UTF-16 code units, and it is `positionAt`'s inverse.
import { describe, expect, test } from "bun:test";
import { offsetAt, positionAt } from "../src/model/diagnostics.ts";

describe("offsetAt", () => {
  test("is the inverse of positionAt on empty lines, a surrogate pair and a last line with no newline", () => {
    const source = "entity :Todo\n\n  attributes\n    string :emoji default=\"😀x\"\n\n  last";
    for (let offset = 0; offset <= source.length; offset++) {
      const { line, column } = positionAt(source, "a.mesh.mx", offset);
      expect(offsetAt(source, line, column)).toBe(offset);
    }
  });
  test("a surrogate pair counts as two columns", () => {
    expect(offsetAt("😀x\nb", 1, 2)).toBe(2);
    expect(offsetAt("😀x\nb", 2, 0)).toBe(4);
  });
  test("with CRLF line ends the `\\r` counts in the offset", () => {
    const source = "a\r\nbc\r\nd";
    expect(offsetAt(source, 2, 0)).toBe(3);
    expect(offsetAt(source, 2, 3)).toBe(6);
    expect(offsetAt(source, 3, 0)).toBe(7);
  });
  test("a line past the end, or a column past the text, clamps to the text's length", () => {
    expect(offsetAt("ab\nc", 9, 0)).toBe(4);
    expect(offsetAt("ab\nc", 2, 9)).toBe(4);
    expect(offsetAt("", 1, 0)).toBe(0);
  });
  test("a column past its line's end runs into the next line, as MX counts it", () => {
    expect(offsetAt("ab\ncd", 1, 4)).toBe(4);
  });
});

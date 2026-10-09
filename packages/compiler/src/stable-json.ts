/**
 * Mesh's own stable JSON serialiser for `model.json`. `JSON.stringify` is not
 * enough: object keys would keep the insertion order of whatever code built the
 * value, so a refactor of the builder would silently rewrite the committed file
 * and the guard would fail on a diff with no meaning. Keys are emitted in
 * lexicographic order, arrays keep their order, the indentation is two spaces
 * and the text ends with one newline.
 *
 * The caller adds the trailing newline; this function returns exactly the
 * document, so two serialisations of equal data are byte-identical.
 */
import { findNonJsonValue } from "@meshfw/model";

const INDENT = "  ";

/** JSON has one way to write a key: quoted, with JSON's own escaping. */

function write(value: unknown, depth: number, path: string, out: string[]): void {
  if (typeof value === "number") {
    // `JSON.stringify(-0)` is "0": JSON can hold a negative zero, and the model
    // keeps the value the author wrote, so it is written out and read back as -0.
    out.push(Object.is(value, -0) ? "-0" : JSON.stringify(value));
    return;
  }
  if (value === null || typeof value === "boolean") {
    out.push(JSON.stringify(value));
    return;
  }
  if (typeof value === "string") {
    out.push(JSON.stringify(value));
    return;
  }
  const pad = INDENT.repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return void out.push("[]");
    out.push("[\n");
    value.forEach((item, index) => {
      out.push(pad);
      write(item, depth + 1, `${path}[${index}]`, out);
      out.push(index === value.length - 1 ? "\n" : ",\n");
    });
    out.push(`${INDENT.repeat(depth)}]`);
    return;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    if (keys.length === 0) return void out.push("{}");
    out.push("{\n");
    keys.forEach((key, index) => {
      out.push(pad, JSON.stringify(key), ": ");
      write((value as Record<string, unknown>)[key], depth + 1, `${path}.${key}`, out);
      out.push(index === keys.length - 1 ? "\n" : ",\n");
    });
    out.push(`${INDENT.repeat(depth)}}`);
    return;
  }
  throw new Error(`Cannot serialise ${path} (${typeof value}); the model must be plain JSON data`);
}

/** The document as text, without a trailing newline. Throws naming the offending path. */
export function stableJsonStringify(value: unknown, path = "$"): string {
  const bad = findNonJsonValue(value, path);
  if (bad !== null) throw new Error(`Cannot serialise ${bad}; the model must be plain JSON data`);
  const out: string[] = [];
  write(value, 0, path, out);
  return out.join("");
}
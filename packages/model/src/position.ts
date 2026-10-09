/**
 * Where something sits in a source file. Matches what MX diagnostics store:
 * `line` is 1-based, `column` is 0-based, `offset` is the UTF-16 code-unit offset
 * from the start of the file.
 *
 * `file` is a path relative to the project root (the directory of the project's
 * config file), with `/` separators, never absolute. Positions are written to the
 * committed `.mesh/model.json`, so an absolute or machine-specific path would
 * make `mesh build --check` fail on every other checkout. The builder must convert
 * before it stores a position; `isProjectRelativePath` is the check.
 */
export interface SourcePosition {
  file: string;
  line: number;
  column: number;
  offset: number;
}

/**
 * A name or value the author wrote, with where it was written. One rule for what
 * `position` points at: the first character of the value as written (for a quoted
 * string, its opening quote), never the attribute name that holds it. For
 * `attribute="title"` the name's position is the `"` before `title`; the tag's own
 * position stays on the element that owns the `Spanned`.
 */
export interface Spanned<T> {
  value: T;
  position: SourcePosition;
}

/**
 * True for a non-empty path that is relative, uses `/` only, has no drive letter and
 * no `.` or `..` segment. Pure string check; it does not touch the file system.
 */
export function isProjectRelativePath(file: string): boolean {
  if (file === "" || file.startsWith("/") || file.includes("\\")) return false;
  if (/^[A-Za-z]:/.test(file)) return false;
  return file.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

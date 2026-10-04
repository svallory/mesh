/**
 * Where something sits in a source file. Matches what MX diagnostics store:
 * `line` is 1-based, `column` is 0-based, `offset` is the UTF-16 code-unit offset
 * from the start of the file.
 *
 * `file` is a path relative to the project root (the directory of the project's
 * config file), with `/` separators, never absolute. Positions are written to the
 * committed `generated/model.json`, so an absolute or machine-specific path would
 * make `mesh build --check` fail on every other checkout. The builder must convert
 * before it stores a position; `isProjectRelativePath` is the check.
 */
export interface SourcePosition {
  file: string;
  line: number;
  column: number;
  offset: number;
}

/** A name or value the author wrote, with where it was written. */
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

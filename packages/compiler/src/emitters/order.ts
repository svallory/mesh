import { relative, resolve } from "node:path";
import { isProjectRelativePath, type ModelDocument, type Entity, type Spanned } from "@meshfw/model";
import type { ResolvedConfig } from "../config.ts";
import { emitError } from "../emit-error.ts";
import { normalizePath } from "../paths.ts";

/** Byte-order comparison, not a locale collation: the emitted order must not depend
 * on the machine. */
export function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Entities in a fixed order, whatever order the loader read the files in. The
 * guard compares bytes, so the file order on disk and in `mesh.config.ts` must not
 * reach the emitted tree (roadmap M1, determinism).
 */
export function orderedEntities(document: ModelDocument): Entity[] {
  return [...document.entities].sort((a, b) => compareText(a.file, b.file));
}

/** The same document with its entities ordered; nothing else is touched. */
export function orderedDocument(document: ModelDocument): ModelDocument {
  return { ...document, entities: orderedEntities(document) };
}

/**
 * The configured output directory as a project-relative path with `/` separators,
 * which is what a generated file path is written against. `loadConfig` proved the
 * directory is inside the project, both lexically and canonically.
 */
export function outputPrefix(config: ResolvedConfig): string {
  const relativeToRoot = normalizePath(relative(resolve(config.root), resolve(config.output)));
  if (!isProjectRelativePath(relativeToRoot)) {
    throw new Error(`Configured output "${config.output}" is not inside the project root "${config.root}"`);
  }
  return relativeToRoot;
}

/**
 * The one rule for an authored name that becomes a generated path segment: exactly
 * one path segment, made of characters that are ordinary on every host. A name is
 * rejected when it is empty, when it is `.` or `..`, when it holds a separator of
 * either style, a NUL or a line terminator.
 *
 * The two separators matter separately. On POSIX a backslash is an ordinary
 * character in a file name, so a name holding one is not a folder: reading it as
 * one would put the generated file somewhere the author never named. A line
 * terminator would end a comment that quotes the name, and a NUL cannot be in a
 * path at all. Rejecting them here, before any path is built, keeps the rule in
 * one place instead of leaving it to each caller.
 */
const SEGMENT_FORBIDDEN = /[:/\\\0\n\r\u2028\u2029]/;

export function isPathSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !SEGMENT_FORBIDDEN.test(value);
}

/** One segment of a generated path, from a name the author wrote. A name that is
 * not one is a build error at the name, never a path that silently moves the file
 * somewhere else. */
export function pathSegment(name: Spanned<string>): string {
  if (!isPathSegment(name.value)) {
    throw emitError(
      "MESH_EMIT_PATH",
      `Name "${name.value}" cannot be used in a generated file path`,
      name.position,
      "Use one name for the generated file: no `/` or `\\`, no NUL, no line break, and not `.` or `..`",
    );
  }
  return name.value;
}
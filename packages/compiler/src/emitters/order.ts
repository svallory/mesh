import { relative, resolve } from "node:path";
import { isProjectRelativePath, type ModelDocument, type Resource, type Spanned } from "@mesh/model";
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
 * Resources in a fixed order, whatever order the loader read the files in. The
 * guard compares bytes, so the file order on disk and in `mesh.config.ts` must not
 * reach the emitted tree (roadmap M1, determinism).
 */
export function orderedResources(document: ModelDocument): Resource[] {
  return [...document.resources].sort((a, b) => compareText(a.name.value, b.name.value));
}

/** The same document with its resources ordered; nothing else is touched. */
export function orderedDocument(document: ModelDocument): ModelDocument {
  return { ...document, resources: orderedResources(document) };
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
 * One segment of a generated path, from a name the author wrote. A name that would
 * escape the output directory or name a hidden or parent folder is a build error at
 * the name, not a path that silently moves the file somewhere else.
 */
export function pathSegment(name: Spanned<string>): string {
  const value = name.value;
  if (value === "" || value === "." || value === ".." || /[/\\]/.test(value) || value.includes("\0")) {
    throw emitError(
      "MESH_EMIT_PATH",
      `Name "${value}" cannot be used in a generated file path`,
      name.position,
      "Use a name without a path separator, `.` or `..`",
    );
  }
  return value;
}
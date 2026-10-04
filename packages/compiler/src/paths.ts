import { isAbsolute, relative, resolve } from "node:path";
import { realpath, lstat } from "node:fs/promises";
import { isProjectRelativePath } from "@mesh/model";

/** Portable inputs: both separator styles, but drive and UNC paths are never
 * interpreted as relative paths on a POSIX host. */
export const normalizePath = (input: string): string => input.replace(/\\/g, "/");
export const foreignAbsolute = (input: string): boolean => /^[a-z]:/i.test(normalizePath(input)) || normalizePath(input).startsWith("//");
export const absolutePath = (input: string): boolean => foreignAbsolute(input) || isAbsolute(normalizePath(input));
export function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel === "" || isProjectRelativePath(normalizePath(rel));
}
export function resolveResource(root: string, input: string): { absolute: string; file: string } | null {
  if (foreignAbsolute(input)) return null;
  const absolute = resolve(root, normalizePath(input));
  const file = normalizePath(relative(root, absolute));
  return isProjectRelativePath(file) ? { absolute, file } : null;
}
/** Diagnostics never use an escaping or absolute filename. Invalid input paths
 * are attributed to the project configuration rather than echoed verbatim. */
export function projectPath(root: string, input: string): string {
  return resolveResource(resolve(root), input)?.file ?? "mesh.config.ts";
}
export function errorCode(cause: unknown): string | null {
  if (cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string") return cause.code;
  return null;
}
/** Canonicalise an output that may not exist yet, following the nearest existing
 * ancestor. Errors other than a missing leaf must not become containment success. */
export async function canonicalFuturePath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (cause) {
    if (errorCode(cause) !== "ENOENT") throw cause;
    // A dangling symlink is not an ordinary future directory.
    try { await lstat(path); }
    catch (missing) {
      if (errorCode(missing) !== "ENOENT") throw missing;
      const parent = resolve(path, "..");
      if (parent === path) throw cause;
      return resolve(await canonicalFuturePath(parent), relative(parent, path));
    }
    throw cause;
  }
}
/** Globs have alternatives, so lexical resolve of the whole string cannot prove
 * confinement. Reject traversal components in any branch before scanning. */
export function confinedGlob(glob: string): boolean {
  return !absolutePath(glob) && !normalizePath(glob).split(/[/{},]/).includes("..");
}

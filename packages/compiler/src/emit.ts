import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isProjectRelativePath, type ModelDocument } from "@mesh/model";
import type { ResolvedConfig } from "./config.ts";
import { errorCode, inside } from "./paths.ts";
import { EmitError } from "./emit-error.ts";
import { modelJsonEmitter } from "./emitters/model-json.ts";
import { resourceTypesEmitter } from "./emitters/resource-types.ts";
import { compareText, outputPrefix } from "./emitters/order.ts";

export { EmitError } from "./emit-error.ts";

/**
 * One generated file: a project-relative path with `/` separators (so it names the
 * same file on every host) and the exact text to write. Nothing else: an emitter
 * does not decide how a file reaches the disk, and it never writes.
 */
export interface GeneratedFile {
  readonly path: string;
  readonly contents: string;
}

/** What an emitter is given: the model document, and the resolved project config. */
export interface EmitInput {
  readonly document: ModelDocument;
  readonly config: ResolvedConfig;
}

/**
 * One source of generated files.
 *
 * UNSTABLE UNTIL M6: from M6 the extension host registers emitters through this
 * interface (the data adapter's schema emitter and extension emitters alike), so the
 * shape may still change. Keep it to the smallest thing that can produce files: an
 * emitter is a pure function of the model and the configuration.
 */
export interface Emitter {
  /** Stable name, used in the error that two emitters wrote the same path. */
  readonly name: string;
  emit(input: EmitInput): Promise<readonly GeneratedFile[]>;
}

/** The emitters of the core build, in a fixed order. The result is sorted by path anyway. */
export const EMITTERS: readonly Emitter[] = Object.freeze([modelJsonEmitter, resourceTypesEmitter]);

/**
 * Run every emitter and return the whole generated tree as text, sorted by path.
 * Nothing is written: this is what `mesh build --check` and `mesh inspect` compare
 * against the committed files. Two emitters writing one path is a build error, not
 * a last-one-wins merge.
 */
export async function generateFiles(input: EmitInput): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = [];
  const owners = new Map<string, string>();
  for (const emitter of EMITTERS) {
    for (const file of await emitter.emit(input)) {
      if (!isProjectRelativePath(file.path)) {
        throw new EmitError({
          severity: "error",
          code: "MESH_EMIT_PATH",
          message: `Emitter "${emitter.name}" produced the path "${file.path}", which is not a project-relative path`,
          position: { file: "mesh.config.ts", line: 1, column: 0, offset: 0 },
          fix: "Report this emitter bug: a generated path must be relative to the project root",
        });
      }
      const owner = owners.get(file.path);
      if (owner !== undefined) {
        throw new Error(`Emitters "${owner}" and "${emitter.name}" both write "${file.path}"`);
      }
      owners.set(file.path, emitter.name);
      files.push(file);
    }
  }
  return files.sort((a, b) => compareText(a.path, b.path));
}

/**
 * Refuse to write through a symlink, at any level under the output directory. Each
 * existing component from the output folder down to the target is inspected with
 * `lstat`, which does not follow links: a directory symlink in the middle of the
 * path is refused as firmly as a symlinked file at the leaf, and whatever it points
 * at is left alone. A component that does not exist yet is where the writer will
 * create it, so it ends the walk.
 *
 * Nothing here rewrites separators. A generated path arrives with `/` from the
 * emitters, and the host path is joined with the host separator; on POSIX a
 * backslash in a file name is a character of that name, not a folder, so treating
 * it as one would compare two different files as if they were one.
 */
async function assertNoSymlink(output: string, target: string, label: string): Promise<void> {
  const segments = relative(output, target).split(sep).filter((segment) => segment.length > 0);
  const walked: string[] = [];
  for (const segment of segments) {
    walked.push(segment);
    let link: boolean;
    try {
      link = (await lstat(join(output, ...walked))).isSymbolicLink();
    } catch (cause) {
      const code = errorCode(cause);
      if (code === "ENOENT") return;
      throw new Error(`Cannot inspect "${label}" in the output directory before writing (${code ?? "UNKNOWN"})`);
    }
    if (link) {
      throw new Error(
        `Cannot write the generated file "${label}": "${walked.join("/")}" in the output directory is a symlink; writing it would follow the link`,
      );
    }
  }
}

/**
 * Write a generated tree under the configured output directory, creating the folders
 * it needs. Returns the absolute paths written, in the order they were given.
 *
 * Containment is checked physically, not by spelling, at the moment of writing:
 * a target outside the output directory is refused, and so is any component inside
 * it that is a symlink, whatever it points at, because writing through one would
 * change a file Mesh does not own. Every target is checked before the first byte is
 * written, so a refused tree leaves the disk as it was. Nothing is deleted: a stale
 * file from an earlier build is the guard's business, not the writer's.
 */
export async function writeGeneratedFiles(files: readonly GeneratedFile[], config: ResolvedConfig): Promise<string[]> {
  const output = resolve(config.output);
  const targets: string[] = [];
  for (const file of files) {
    if (!isProjectRelativePath(file.path)) {
      throw new Error(`Cannot write the generated file "${file.path}": it is not a project-relative path`);
    }
    const absolute = resolve(config.root, file.path);
    if (!inside(output, absolute)) {
      throw new Error(
        `Cannot write the generated file "${file.path}": it resolves outside the output directory "${outputPrefix(config)}"`,
      );
    }
    await assertNoSymlink(output, absolute, file.path);
    targets.push(absolute);
  }
  const written: string[] = [];
  for (const [index, absolute] of targets.entries()) {
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, files[index]!.contents, "utf8");
    written.push(absolute);
  }
  return written;
}
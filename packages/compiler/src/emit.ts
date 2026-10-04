import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { isProjectRelativePath, type ModelDocument } from "@mesh/model";
import type { ResolvedConfig } from "./config.ts";
import { canonicalFuturePath, errorCode, inside, normalizePath } from "./paths.ts";
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
 * Write a generated tree under the configured output directory, creating the folders
 * it needs. Returns the absolute paths written, in the order they were given.
 *
 * Containment is checked physically, not by spelling, at the moment of writing: the
 * output directory is resolved through any symlink on its way, and so is every
 * target. A file or folder inside the output that is itself a symlink is refused,
 * whatever it points at, because writing through it would change a file Mesh does
 * not own. Every target is checked before the first byte is written, so a refused
 * tree leaves the disk as it was. Nothing is deleted: a stale file from an earlier
 * build is the guard's business, not the writer's.
 */
export async function writeGeneratedFiles(files: readonly GeneratedFile[], config: ResolvedConfig): Promise<string[]> {
  const output = resolve(config.output);
  let realOutput: string;
  try {
    realOutput = await canonicalFuturePath(output);
  } catch (cause) {
    throw new Error(`Cannot resolve the output directory "${config.output}" for writing (${errorCode(cause) ?? "UNKNOWN"})`);
  }
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
    const relativeToOutput = normalizePath(relative(output, absolute));
    // The physical location, with every symlink under the output directory followed.
    let physical: string;
    try {
      physical = await canonicalFuturePath(absolute);
    } catch (cause) {
      throw new Error(`Cannot resolve the generated file "${file.path}" for writing (${errorCode(cause) ?? "UNKNOWN"})`);
    }
    const relativeToRealOutput = normalizePath(relative(realOutput, physical));
    if (relativeToRealOutput !== relativeToOutput) {
      throw new Error(
        `Cannot write the generated file "${file.path}": writing it would follow a symlink to "${relativeToRealOutput}" inside the output directory`,
      );
    }
    targets.push(absolute);
  }
  const written: string[] = [];
  for (const [index, absolute] of targets.entries()) {
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, files[index]!.contents, "utf8");
    written.push(normalizePath(absolute));
  }
  return written;
}
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isProjectRelativePath, type Diagnostic, type ModelDocument } from "@mesh/model";
import type { ResolvedConfig } from "./config.ts";
import { errorCode, inside } from "./paths.ts";
import { EmitError } from "./emit-error.ts";
import { modelJsonEmitter } from "./emitters/model-json.ts";
import { entityTypesEmitter } from "./emitters/resource-types.ts";
import { entityValidatorsEmitter } from "./emitters/resource-validators.ts";
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
  /** Bare packages imported by generated code, resolved from the consumer root. */
  readonly requires?: readonly string[];
  emit(input: EmitInput): Promise<readonly GeneratedFile[]>;
}

/** The emitters of the core build, in a fixed order. The result is sorted by path anyway. */
export const EMITTERS: readonly Emitter[] = Object.freeze([modelJsonEmitter, entityTypesEmitter, entityValidatorsEmitter]);

/** Preflight every generated import before writing; check/inspect need no installed runtime dependencies. */
export function generatedImportDiagnostics(projectRoot: string, emitters: readonly Emitter[] = EMITTERS): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const required = new Set(emitters.flatMap((emitter) => [...emitter.requires ?? []]));
  for (const specifier of [...required].sort(compareText)) {
    try { Bun.resolveSync(specifier, projectRoot); }
    catch {
      diagnostics.push({ severity: "error", code: "MESH_GENERATED_IMPORT",
        message: `generated code imports "${specifier}", which is not installed in this project. Run: bun add ${specifier}`,
        position: { file: "mesh.config.ts", line: 1, column: 0, offset: 0 }, fix: null });
    }
  }
  return diagnostics;
}

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
 * Refuse symlinks and wrong entry types at every level of the path being written,
 * starting at the output directory itself. Every existing component from the output
 * folder down to the target is inspected with `lstat`, which does not follow links:
 * an output folder that is a symlink is refused as firmly as a directory symlink in
 * the middle of the path or a symlinked file at the leaf, and whatever any of them
 * points at is left alone. A component that does not exist yet is where the writer
 * will create it, so it ends the walk.
 *
 * Nothing here rewrites separators. A generated path arrives with `/` from the
 * emitters, and the host path is joined with the host separator; on POSIX a
 * backslash in a file name is a character of that name, not a folder, so treating
 * it as one would compare two different files as if they were one.
 */
async function assertWritablePath(output: string, target: string, label: string, outputName: string): Promise<void> {
  const below = relative(output, target).split(sep).filter((segment) => segment.length > 0);
  const walked: string[] = [];
  const refuse = async (path: string, isOutput: boolean): Promise<boolean> => {
    const name = isOutput ? outputName : `${outputName}/${walked.join("/")}`;
    let info: Stats;
    try { info = await lstat(path); }
    catch (cause) {
      const code = errorCode(cause);
      // A component that does not exist yet is where the writer will create it.
      if (code === "ENOENT") return false;
      throw writeError(name, `Cannot inspect "${name}" before writing (${code ?? "UNKNOWN"}); fix its permissions and rebuild`);
    }
    if (info.isSymbolicLink()) throw writeError(name,
      isOutput
        ? `Cannot write the generated tree: the output directory "${outputName}" is a symlink; point \`output\` at a real directory`
        : `Cannot write the generated file "${label}": "${walked.join("/")}" in the output directory is a symlink; writing it would follow the link`,
    );
    const directory = isOutput || path !== target;
    if (directory ? !info.isDirectory() : !info.isFile()) {
      throw writeError(name, `Cannot write generated path "${name}": expected ${directory ? "a directory" : "a regular file"}, found ${entryKind(info)}; delete or move it and rebuild`);
    }
    return true;
  };
  if (await refuse(output, true)) {
    for (const segment of below) {
      walked.push(segment);
      if (!(await refuse(join(output, ...walked), false))) return;
    }
  }
}

function entryKind(info: Stats): string {
  if (info.isDirectory()) return "a directory";
  if (info.isFile()) return "a regular file";
  if (info.isFIFO()) return "a FIFO";
  if (info.isSocket()) return "a socket";
  if (info.isBlockDevice()) return "a block device";
  if (info.isCharacterDevice()) return "a character device";
  return "an unsupported filesystem entry";
}

function writeError(file: string, message: string): EmitError {
  return new EmitError({ severity: "error", code: "MESH_WRITE_PATH", message,
    position: { file, line: 1, column: 0, offset: 0 }, fix: null });
}

/** Replace, never truncate, an existing inode. Exclusive creation means a
 * colliding existing path is not touched or cleaned up as though it were ours.
 * chmod on the new handle restores exactly 0644 even under a restrictive umask.
 */
async function replaceFile(target: string, file: GeneratedFile, targets: ReadonlySet<string>): Promise<void> {
  let temporary: string;
  do { temporary = join(dirname(target), `.mesh-${randomUUID()}.tmp`); }
  while (targets.has(temporary.toLowerCase()));
  let created = false;
  try {
    await mkdir(dirname(target), { recursive: true });
    const handle = await open(temporary, "wx", 0o644);
    created = true;
    try {
      await handle.chmod(0o644);
      await handle.writeFile(file.contents, "utf8");
    } finally { await handle.close(); }
    await rename(temporary, target);
    created = false;
  } catch (cause) {
    if (created) {
      try { await unlink(temporary); }
      catch (cleanup) {
        const tempName = `${file.path.slice(0, file.path.lastIndexOf("/") + 1)}${temporary.slice(temporary.lastIndexOf(sep) + 1)}`;
        throw writeError(file.path, `Cannot replace generated file "${file.path}" (${errorCode(cause) ?? "UNKNOWN"}); cannot remove temporary file "${tempName}" (${errorCode(cleanup) ?? "UNKNOWN"}); remove it and rebuild`);
      }
    }
    throw writeError(file.path, `Cannot replace generated file "${file.path}" (${errorCode(cause) ?? "UNKNOWN"}); fix the output path or permissions and rebuild`);
  }
}

/**
 * Write a generated tree under the configured output directory, creating the folders
 * it needs. Returns the absolute paths written, in the order they were given.
 *
 * Containment is checked physically, not by spelling, at the moment of writing:
 * a target outside the output directory is refused, and so is any component inside
 * it that is a symlink, whatever it points at, because writing through one would
 * change a file Mesh does not own. Every existing target must be a regular file,
 * and every existing ancestor from output down must be a directory. The whole
 * tree is preflighted before any write, without opening special files.
 * Each file is then replaced via an exclusive same-directory temporary file and
 * rename: hard links and unreadable old permissions cannot corrupt the result.
 * Failed writes/renames clean up their temporary file. This is per-file atomicity,
 * not a transaction across the tree; a later I/O failure can follow earlier writes.
 * No existing stray is deleted. Concurrent filesystem mutation is not supported.
 */
export async function writeGeneratedFiles(files: readonly GeneratedFile[], config: ResolvedConfig): Promise<string[]> {
  const output = resolve(config.output);
  const outputName = outputPrefix(config);
  const targets: string[] = [];
  for (const file of files) {
    if (!isProjectRelativePath(file.path)) {
      throw new Error(`Cannot write the generated file "${file.path}": it is not a project-relative path`);
    }
    const absolute = resolve(config.root, file.path);
    if (!inside(output, absolute)) {
      throw new Error(
        `Cannot write the generated file "${file.path}": it resolves outside the output directory "${outputName}"`,
      );
    }
    await assertWritablePath(output, absolute, file.path, outputName);
    targets.push(absolute);
  }
  const written: string[] = [];
  const produced = new Set(targets.map((target) => target.toLowerCase()));
  for (const [index, absolute] of targets.entries()) {
    await replaceFile(absolute, files[index]!, produced);
    written.push(absolute);
  }
  return written;
}
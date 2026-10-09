import type { Diagnostic } from "@mesh/model";

/**
 * A build error raised while emitting, carrying the same positioned `Diagnostic`
 * the loader and the builder return. An emitter returns files or throws; it has no
 * other channel, and this is what the `mesh` command turns into a message naming
 * the file, the line and the fix (roadmap principle 2).
 */
export class EmitError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    const { file, line, column } = diagnostic.position;
    super(`${file}:${line}:${column + 1}: ${diagnostic.message}`);
    this.name = "EmitError";
  }
}

export function emitError(
  code: string,
  message: string,
  position: Diagnostic["position"],
  fix: string | null = null,
): EmitError {
  return new EmitError({ severity: "error", code, message, position, fix });
}
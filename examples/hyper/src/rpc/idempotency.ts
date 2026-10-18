// Idempotency (PROTOCOL.md §4.3): the engine stores each committed command's `commandId`, a canonical hash of
// `{ method, params }` and its full result in the same transaction as the change. A repeat with the same hash returns
// the stored result and changes nothing; a repeat with another hash is `-32006 idempotency_conflict`, check
// `command-id`, phase `shape`. Rejections are never stored, since the transaction that would store them rolls back.
import { createHash } from "node:crypto";
import { Mesh } from "meshfw";
import type { ActionContext } from "@meshfw/runtime";
import { Idempotency } from "#mesh/domain/audit";
import { rejection, specCodes } from "./errors";

/**
 * `value` as canonical JSON (PROTOCOL.md §4.3): object keys sorted, no whitespace. An absent member stays absent and a
 * `null` one is written, so the two hash differently.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((each) => (each === undefined ? "null" : canonicalJson(each))).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The hash a command is stored under: SHA-256 of the canonical JSON of `{ method, params }`, params as sent. */
export function commandHash(method: string, params: unknown): string {
  return createHash("sha256").update(canonicalJson({ method, params })).digest("hex");
}

/** The stored command `commandId`, read with no policy; `undefined` when none committed under it. */
export async function storedCommand(commandId: string) {
  const [stored] = await Mesh.privileged(Idempotency).read({ filter: { commandId: { eq: commandId } }, limit: 1 });
  return stored;
}

/** The `-32006` of a `commandId` sent again with another method or other params. */
export function idempotencyConflict(commandId: string, method: string) {
  return rejection(specCodes.idempotencyConflict, "shape", [{
    check: "command-id",
    reason: `the commandId ${JSON.stringify(commandId)} was already used by a command with another method or other params; send this command with a new commandId`,
    details: { commandId, method },
  }]);
}

/**
 * What a command sent with `commandId` and `hash` gets from the store: `{ replay: result }` when the same command
 * committed before, `undefined` when none did, and the conflict thrown when another one did.
 */
export async function replayOf(commandId: string, method: string, hash: string): Promise<{ readonly replay: object } | undefined> {
  const stored = await storedCommand(commandId);
  if (stored === undefined) return undefined;
  if (stored.hash !== hash) throw idempotencyConflict(commandId, method);
  return { replay: stored.result as object };
}

/** Stores the committed command's result, in the command's own transaction. */
export async function storeCommand(commandId: string, method: string, hash: string, result: object, context: ActionContext): Promise<void> {
  await Idempotency.record({ commandId, method, hash, result: JSON.parse(JSON.stringify(result)) }, { ...context, system: true });
}

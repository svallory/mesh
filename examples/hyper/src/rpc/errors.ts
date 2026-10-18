// How a failed call reaches the client (PROTOCOL.md:198-284): a JSON-RPC error whose `message` is the spec's short name
// and whose `data` names the phase that refused the call and lists that phase's failures. `rpcErrorOf` turns the errors
// the port's actions throw into that shape; `wireError`, the `error` option of `serve`, gives the server's own `-32601`
// and `-32602` the same shape and lets every other `RpcError` through. Whatever is left is an engine bug: it is rethrown,
// so the server logs it and answers `-32603 internal_error` with no data. `explained` adds what one failure needs that
// the action's error does not carry, read once the call's transaction has rolled back.
import { type Call, codes, type ErrorObject, RpcError } from "@meshfw/jsonrpc";
import { CursorAheadError, ForbiddenError, type Issue, InvalidInputError, NotFoundError, type ActionContext } from "@meshfw/runtime";
import { Mesh } from "meshfw";
import { transaction } from "#mesh";
import { Submission } from "#mesh/domain/work";
import { reviewerOfTask } from "../domain/work/work.helpers";
import { isId } from "./resolve";

/** The spec's error codes beyond JSON-RPC's own (PROTOCOL.md:209-215). */
export const specCodes = Object.freeze({
  permissionDenied: -32001,
  versionConflict: -32002,
  ruleViolation: -32003,
  notFound: -32005,
  idempotencyConflict: -32006,
  notImplemented: -32010,
} as const);

/** The text each of JSON-RPC's reserved codes is sent with: the spec's short names (PROTOCOL.md:202-208), for `serve`'s `messages`. */
export const messages = Object.freeze({
  [codes.parseError]: "parse_error",
  [codes.invalidRequest]: "invalid_request",
  [codes.methodNotFound]: "method_not_found",
  [codes.invalidParams]: "invalid_params",
  [codes.internalError]: "internal_error",
} as const);

const names: Readonly<Record<number, string>> = {
  ...messages,
  [specCodes.permissionDenied]: "permission_denied",
  [specCodes.versionConflict]: "version_conflict",
  [specCodes.ruleViolation]: "rule_violation",
  [specCodes.notFound]: "not_found",
  [specCodes.idempotencyConflict]: "idempotency_conflict",
  [specCodes.notImplemented]: "not_implemented",
};

export type Phase = "shape" | "permission" | "content";

/** One entry of `data.failures`: the check that failed, a sentence the caller can act on, and the facts behind it. */
export interface Failure {
  readonly check: string;
  readonly reason: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** The error a client receives: the code, its short name, and the phase with its failures. */
export function rejection(code: number, phase: Phase, failures: readonly Failure[]): RpcError {
  return new RpcError(code, names[code] ?? "internal_error", { phase, failures });
}

/**
 * The spec's content-phase check ids (PROTOCOL.md:255-283). An entity rule whose code is on this list reaches the client
 * as it is; one whose code is not is a rule of the port alone (`claim.stale-fence`, `machine.retired`...), which no v0
 * method should reach, so reaching one is answered `-32603`.
 */
export const contentChecks: ReadonlySet<string> = new Set([
  "expected-version",
  "workspace.exists", "workspace.active",
  "collaborator.active", "collaborator.name-unique", "collaborator.kind-immutable",
  "membership.none-active", "membership.active", "membership.last-owner", "membership.unchanged",
  "concurrent-change",
  "task.unchanged", "task.open", "task.settled", "task.parent-open", "task.no-cycle", "task.no-active-claim",
  "task.children-settled", "task.not-blocked", "task.review-required", "task.no-foreign-submission",
  "assignment.unchanged", "assignment.assignee-role", "assignment.current",
  "dependency.distinct", "dependency.duplicate", "dependency.exists", "dependency.no-cycle",
  "claim.task-ready", "claim.expired", "claim.active", "claim.current-fence", "claim.invalidated",
  "submission.none-pending", "submission.pending",
]);

/**
 * Each policy that answers on the wire, by the spec's permission check it stands for (`PORTING.md`, "Permissions").
 * `required` is set for the two role policies, whose details name the roles that would pass. `internal`,
 * `reviewCompletion` and the execution context's policies are missing on purpose: no v0 method reaches them, so a
 * denial by one is answered `-32603`.
 */
const policyChecks: Readonly<Record<string, { readonly check: string; readonly required?: readonly string[] }>> = {
  membersRead: { check: "membership" },
  isMember: { check: "membership" },
  ownerOrMember: { check: "role", required: ["owner", "member"] },
  ownerOnly: { check: "role", required: ["owner"] },
  claimAssignee: { check: "claim.assignee" },
  claimHolder: { check: "claim.holder" },
  claimRevoker: { check: "claim.revoker" },
  taskManager: { check: "task.manager" },
  taskUnassigner: { check: "task.manager" },
  reviewReviewer: { check: "review.reviewer" },
  submissionSubmitter: { check: "submission.submitter" },
  collaboratorSelfOrOwner: { check: "collaborator.self-or-owner" },
};

/** The sentence each permission check is reported with. */
const permissionReasons: Readonly<Record<string, string>> = {
  membership: "the actor has no active membership in this workspace; an owner can grant one",
  "claim.assignee": "the task is assigned to someone else; only its assignee can claim it",
  "claim.holder": "someone else holds the claim on this task, or the actor never held one",
  "claim.revoker": "only an owner, the task's reviewer or its delegator can revoke its claim",
  "task.manager": "only an owner, the task's assignee or delegator, or the creator of an unassigned task can do this",
  "review.reviewer": "only the reviewer the reviewer rule names can review this submission",
  "submission.submitter": "only the collaborator who submitted it can withdraw a submission",
  "collaborator.self-or-owner": "a collaborator can update only its own profile; an owner can update any",
};

/** `identity.Collaborator` gives `collaborator`, `work.EvidenceReference` gives `evidence-reference` (PROTOCOL.md `RecordType`). */
export function recordTypeOf(entity: string): string {
  const name = entity.slice(entity.lastIndexOf(".") + 1);
  return name.replace(/[A-Z]/g, (letter, at: number) => (at === 0 ? "" : "-") + letter.toLowerCase());
}

/** The `-32010 not_implemented` of a method this engine does not serve, check `method` (PROTOCOL.md:215, 243). */
export function notServed(method: string, why: string): RpcError {
  return rejection(specCodes.notImplemented, "shape", [{ check: "method", reason: `${method} is not implemented by this engine: ${why}` }]);
}

/** The `exists` failure of a record that is missing or that the actor cannot see; the spec answers both alike (PROTOCOL.md:110). */
export function notFound(recordType: string, id: string): RpcError {
  return rejection(specCodes.notFound, "permission", [{ check: "exists", reason: `no ${recordType} with id ${id}`, details: { recordType, id } }]);
}

/** The id a `NotFoundError` names: generated actions give `{ id }`, a helper may give the id itself. */
function idOf(key: unknown): string {
  if (typeof key === "string") return key;
  if (typeof key === "object" && key !== null && "id" in key) return String((key as { id: unknown }).id);
  return JSON.stringify(key) ?? String(key);
}

/** `details` must be an object on the wire (`schemas/protocol.ts`, `Failure`); anything else is left out. */
function asDetails(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function failureOf(issue: Issue): Failure {
  const details = asDetails(issue.details);
  return { check: issue.code!, reason: issue.message, ...(details ? { details } : {}) };
}

function schemaFailure(path: readonly (string | number)[], message: string): Failure {
  const reason = message.length > 0 ? message : "does not match the schema";
  return { check: "schema", reason: path.length > 0 ? `${path.join(".")}: ${reason}` : reason, details: { path } };
}

/**
 * The wire error for an `InvalidInputError`. Shape comes before content (PROTOCOL.md:107), so input that failed its
 * schema is reported alone, as `-32602`. `evidence.exists` is the spec's `exists` on an evidence reference, in the
 * permission phase (PROTOCOL.md:69). Every other coded issue is a content check: `-32002` when the expected version is
 * among them, else `-32003`, with all of them listed (PROTOCOL.md:217 lets the code be any listed failure's).
 */
function invalidInput(error: InvalidInputError): RpcError | undefined {
  const uncoded = error.issues.filter((issue) => issue.code === null);
  if (uncoded.length > 0) return rejection(codes.invalidParams, "shape", uncoded.map((issue) => schemaFailure(issue.path, issue.message)));
  const missing = error.issues.find((issue) => issue.code === "evidence.exists");
  if (missing) {
    const ids = (asDetails(missing.details)?.missing as readonly string[] | undefined) ?? [];
    if (ids.length === 0) return undefined;
    return rejection(specCodes.notFound, "permission", ids.map((id) => ({
      check: "exists", reason: `no evidence-reference with id ${id}; record it with evidence-reference.record first`, details: { recordType: "evidence-reference", id },
    })));
  }
  if (error.issues.some((issue) => !contentChecks.has(issue.code!))) return undefined;
  const failures = error.issues.map(failureOf);
  const code = failures.some((failure) => failure.check === "expected-version") ? specCodes.versionConflict : specCodes.ruleViolation;
  return rejection(code, "content", failures);
}

/** The wire error for a policy denial: one failure per failed policy, under the spec's check id. */
function forbidden(error: ForbiddenError, context: ActionContext | undefined): RpcError | undefined {
  if (error.reason !== "failed") return undefined;
  const failures: Failure[] = [];
  const seen = new Set<string>();
  for (const policy of error.policies) {
    const mapped = policyChecks[policy];
    if (!mapped) return undefined;
    if (seen.has(mapped.check)) continue;
    seen.add(mapped.check);
    if (mapped.required) {
      // The role read when the call came in (`contextFactory`), outside the transaction. The policy reads it again
      // inside the transaction, so if an owner changed it in between, these details name the earlier role.
      const role = context?.actor.role ?? null;
      failures.push({
        check: "role",
        reason: `a${role === "owner" ? "n" : ""} ${role ?? "collaborator without a role"} cannot do this; it needs the role ${mapped.required.join(" or ")}, which an owner can grant`,
        details: { role, required: mapped.required },
      });
    } else {
      failures.push({ check: mapped.check, reason: permissionReasons[mapped.check]! });
    }
  }
  return failures.length > 0 ? rejection(specCodes.permissionDenied, "permission", failures) : undefined;
}

/**
 * The wire error for an error an action or a command function threw, or `undefined` when it has none: a framework
 * error, a denial no v0 method should reach, a rule of the port alone, or anything else that is not a Mesh error.
 * `context` is the call's, for the actor's role in a `role` failure.
 */
export function rpcErrorOf(error: unknown, context?: ActionContext): RpcError | undefined {
  if (error instanceof RpcError) return error;
  if (error instanceof InvalidInputError) return invalidInput(error);
  if (error instanceof ForbiddenError) return forbidden(error, context);
  if (error instanceof NotFoundError) return notFound(recordTypeOf(error.entity), idOf(error.key));
  return undefined;
}

/** The payload's `submissionId`, when the call names a submission. */
function submissionIdOf(payload: unknown): string | undefined {
  const id = typeof payload === "object" && payload !== null ? (payload as { submissionId?: unknown }).submissionId : undefined;
  return typeof id === "string" && isId(id) ? id : undefined;
}

/** One failure with what `explained` adds to it, or as it is. */
async function explainedFailure(failure: Failure, payload: unknown): Promise<Failure> {
  if (failure.check === "review.reviewer") {
    const submissionId = submissionIdOf(payload);
    if (submissionId === undefined) return failure;
    const [submission] = await Mesh.privileged(Submission).read({ filter: { id: { eq: submissionId } }, limit: 1 });
    if (!submission) return failure;
    return { ...failure, details: { reviewerId: (await reviewerOfTask(submission.taskId)).collaboratorId } };
  }
  return failure;
}

/**
 * `error` with what one failure needs that the action's error does not carry, read through `Mesh.privileged` in a
 * transaction of its own, after the call's has rolled back, so a change committed in between shows:
 *
 * - `review.reviewer`: `details` is `{ reviewerId }`, the collaborator the reviewer rule names (PROTOCOL.md:252), for
 *   the submission the call's `payload` names. A policy's denial carries no details (PORTING.md).
 *
 * Any other error is returned as it is, without a read. (The reason of `task.children-settled`, which names the open
 * children, comes from the check's `message=` function in `task.mesh.mx`.) So is `error` when the read fails
 * (the layer closing under a shutdown, a busy database): the rejection is right without the extra facts, so the failure
 * is logged and the client still gets its code and checks, never `-32603`.
 */
export async function explained(error: RpcError, payload: unknown): Promise<RpcError> {
  const data = error.data as { phase: Phase; failures: readonly Failure[] } | undefined;
  const failures = data?.failures ?? [];
  if (!failures.some((failure) => failure.check === "review.reviewer")) return error;
  try {
    return await transaction(async () => {
      const explainedFailures: Failure[] = [];
      for (const failure of failures) explainedFailures.push(await explainedFailure(failure, payload));
      return new RpcError(error.code, error.message, { ...data, failures: explainedFailures });
    });
  } catch (cause) {
    console.error(`could not read what explains a ${error.message} rejection; answering it as it is`, cause);
    return error;
  }
}

/**
 * `events.read` or `events.subscribe` with an `after` above the log's head: the client's cursor names events this log
 * never had, which is a fault of the params, so `-32602` in the shape phase.
 */
function cursorAhead(error: CursorAheadError): RpcError {
  return rejection(codes.invalidParams, "shape", [{
    check: "schema",
    reason: `after: ${error.after} is above the event log's head, ${error.highest}; read from a seq the log has`,
    details: { path: ["after"], head: error.highest },
  }]);
}

/**
 * The `error` option of `serve`. The server's own `-32601` and `-32602` get a phase and failures like every other
 * rejection, and so does a cursor above the log's head (`MESH_CURSOR_AHEAD`); any other `RpcError` is already in the
 * spec's shape; anything else is rethrown, which the server answers `-32603` and logs.
 */
export function wireError(error: unknown, call: Call): ErrorObject {
  if (error instanceof CursorAheadError) return objectOf(cursorAhead(error));
  if (!(error instanceof RpcError)) throw error;
  if (error.code === codes.methodNotFound && error.data === undefined) {
    return objectOf(rejection(codes.methodNotFound, "shape", [{ check: "method", reason: `unknown method ${JSON.stringify(call.method)}; see the protocol's method list` }]));
  }
  const issues = (error.data as { issues?: unknown } | undefined)?.issues;
  if (error.code === codes.invalidParams && Array.isArray(issues)) {
    const failures = (issues as { message: string; path: (string | number)[] }[]).map((issue) => schemaFailure(issue.path, issue.message));
    return objectOf(rejection(codes.invalidParams, "shape", failures.length > 0 ? failures : [schemaFailure([], "params do not match the schema")]));
  }
  return objectOf(error);
}

function objectOf(error: RpcError): ErrorObject {
  return error.data === undefined ? { code: error.code, message: error.message } : { code: error.code, message: error.message, data: error.data };
}

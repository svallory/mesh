/** Applications augment this interface to register their actor type. */
export interface Register {}

/** The application's registered actor, or unknown before registration. */
export type Actor = Register extends { actor: infer A } ? A : unknown;

/** Explicit caller identity and application-owned data for one action call. */
export interface Scope {
  /** Required even when an application permits anonymous callers. */
  actor: Actor;
  /** Extra per-call data; core never interprets it. */
  context?: Record<string, unknown>;
}

export { MeshError, InvalidInputError, NotFoundError, FrameworkError } from "./errors.ts";
export type { Issue, IssueSource } from "./errors.ts";
export { parseInput } from "./input.ts";
export type { StandardSchemaV1 } from "./standard-schema.ts";
export type { Row, Key, TableHandle, DataOperations, DataLayer } from "./data-layer.ts";
export type { DataAdapter } from "./data-adapter.ts";

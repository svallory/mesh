/**
 * The action kind registry: the single source of the action kind names (ADR-0037).
 * `defaults=[...]` and the `action-type` policy attribute take their values from it;
 * the tag contracts are to be built from it (roadmap M1, test 6).
 */
export const ACTION_TYPES = Object.freeze(["create", "read", "update", "destroy"] as const);

export type ActionKind = (typeof ACTION_TYPES)[number];

const KINDS: ReadonlySet<string> = new Set(ACTION_TYPES);

/** True only for an exact, registered action kind (case and whitespace matter). */
export function isActionKind(value: unknown): value is ActionKind {
  return typeof value === "string" && KINDS.has(value);
}

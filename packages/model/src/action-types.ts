/** Fixed action types used by declarations, auto and scoped rules. */
export const ACTION_TYPES = Object.freeze([
  "create",
  "read",
  "update",
  "destroy",
] as const);
export type ActionType = (typeof ACTION_TYPES)[number];
export type ActionKind = ActionType;
const KINDS: ReadonlySet<string> = new Set(ACTION_TYPES);
export function isActionKind(value: unknown): value is ActionType {
  return typeof value === "string" && KINDS.has(value);
}

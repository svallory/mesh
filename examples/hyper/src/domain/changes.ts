// The `changes` payload of the `*.updated` events (`schemas/protocol.ts`, `EventPayloads`): each field the update
// changed, with its value before and after. A `publish` step reads the row before the write (`before`) and after it
// (`self`), so the event lists exactly what the write changed.

/** The fields of `fields` whose value differs between `before` and `after`, each as `{ old, new }`. */
export function changesOf<R extends object, K extends keyof R & string>(before: R, after: R, fields: readonly K[]): Record<string, { old: unknown; new: unknown }> {
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  for (const field of fields) if (before[field] !== after[field]) changes[field] = { old: before[field], new: after[field] };
  return changes;
}

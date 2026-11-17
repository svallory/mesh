import { FrameworkError } from "./errors.ts";

/**
 * The optional capabilities a data adapter can declare (ADR-0013). The set is closed: a
 * name outside it fails type-checking and `validateCapabilityManifest`. Select, insert,
 * update, delete, transactions (re-entrant), read for update, filters, sort and
 * pagination are mandatory, so they are not names here.
 *
 * - `aggregates`: `max`, `count` and `rollup` (a `rollup` over the rows of one table, grouped by their anchor column).
 * - `integer-key-fill`: an insert without an integer primary key gets the next integer.
 * - `conditions`: the adapter honours `Query.where`, `Query.order` and the `where` argument of `max` and `count`,
 *   and runs every core function of a condition (the expression tables through the data layer). A layer without it
 *   never receives a condition, since one that dropped `where` would return rows a read policy denies.
 * - `joins`: a condition may cross a relationship (`one`, `some`, `every`, `count`, `first`: correlated subqueries), and a
 *   `rollup` may have `hops` (a route through several relationships or a link entity).
 * - `upserts`, `atomic-expressions`: declared so a build can refuse an entity that needs them; no adapter has them
 *   before 1.0.
 * - `gapless-positions`: the outbox's positions have no gap after a rollback or a failed insert, and deleting a
 *   prefix of rows leaves none above the deleted-through position (spec, Events and commands, "The outbox"). Only a
 *   client that audits a stream for holes needs it; the never-skip order of the read is mandatory for every adapter.
 * - `raw-sql`: the `query` operation: one read-only statement written by hand, run in the running transaction
 *   (`DataOperations.query`, ADR-0087). `#mesh` exports `query` only for an adapter that declares it.
 */
export const CAPABILITIES = ["aggregates", "integer-key-fill", "joins", "upserts", "atomic-expressions", "gapless-positions", "conditions", "raw-sql"] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Static data an adapter publishes; readable without starting the adapter. */
export interface CapabilityManifest {
  readonly adapter: string;
  readonly capabilities: readonly Capability[];
}

/** Declare a manifest. A capability name outside `CAPABILITIES` is a type error and is
 * checked again at run time, so a build that reads a manifest never trusts the types.
 */
export function defineCapabilities<const C extends readonly Capability[]>(
  adapter: string,
  capabilities: C,
): CapabilityManifest & { readonly adapter: string; readonly capabilities: C } {
  return validateCapabilityManifest({ adapter, capabilities }) as never;
}

/** Check an unknown value (for example a module loaded at build time) and return a frozen
 * manifest, or throw a `FrameworkError` that names every problem.
 */
export function validateCapabilityManifest(value: unknown): CapabilityManifest {
  const problems: string[] = [];
  const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
  if (!record) throw new FrameworkError("A capability manifest must be an object { adapter, capabilities }");
  if (typeof record.adapter !== "string" || record.adapter.trim() === "") problems.push("adapter must be a non-empty string");
  const names = record.capabilities;
  if (!Array.isArray(names)) problems.push("capabilities must be an array");
  else {
    const seen = new Set<unknown>();
    for (const name of names) {
      if (typeof name !== "string" || !(CAPABILITIES as readonly string[]).includes(name)) {
        problems.push(`unknown capability ${JSON.stringify(name)}; the closed set is ${CAPABILITIES.join(", ")}`);
      } else if (seen.has(name)) problems.push(`capability "${name}" is listed twice`);
      seen.add(name);
    }
  }
  if (problems.length > 0) throw new FrameworkError(`Invalid capability manifest: ${problems.join("; ")}`);
  return Object.freeze({ adapter: record.adapter as string, capabilities: Object.freeze([...(names as Capability[])]) });
}

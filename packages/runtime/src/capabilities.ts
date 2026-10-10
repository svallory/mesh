import { FrameworkError } from "./errors.ts";

/**
 * The optional capabilities a data adapter can declare (ADR-0013). The set is closed: a
 * name outside it fails type-checking and `validateCapabilityManifest`. Select, insert,
 * update, delete, transactions (re-entrant), read for update, filters, sort and
 * pagination are mandatory, so they are not names here.
 *
 * - `aggregates`: `max` and `count` (no joins).
 * - `integer-key-fill`: an insert without an integer primary key gets the next integer.
 * - `joins`, `upserts`, `atomic-expressions`: declared so a build can refuse an entity
 *   that needs them; no adapter has them before 1.0.
 */
export const CAPABILITIES = ["aggregates", "integer-key-fill", "joins", "upserts", "atomic-expressions"] as const;

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

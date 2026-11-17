/**
 * Stored event names and the rename map (`events.renamed`; spec, Events and commands, "Names" and "A row whose stored
 * name matches no declared event"): a stored row whose name is a former FQN is read as the declared event the map names.
 * Pure helpers shared by the build (`eventsDiagnostics`) and the run time (`bindDomain`, `rows`, the deliverer).
 */

/** What `resolveEventName` found: one declared FQN, the candidates when the input picks several, or nothing. */
export type EventNameResolution =
  | { readonly kind: "found"; readonly fqn: string }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "unknown" };

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Resolve an event name typed as input (a configuration string) over the declared FQNs: an exact match wins; otherwise
 * the input may be shortened to the fewest trailing segments that pick one declaration (`InvoicePaid` while only one
 * event has that last segment). Two or more matches are ambiguous and none is picked. The algorithm of the compiler's
 * `resolveName`, over event FQNs.
 */
export function resolveEventName(input: string, fqns: readonly string[]): EventNameResolution {
  if (fqns.includes(input)) return { kind: "found", fqn: input };
  if (input === "") return { kind: "unknown" };
  const wanted = input.split(".");
  const matches = fqns.filter((fqn) => {
    const segments = fqn.split(".");
    return wanted.length <= segments.length && wanted.every((segment, index) => segment === segments[segments.length - wanted.length + index]);
  });
  if (matches.length === 1) return { kind: "found", fqn: matches[0]! };
  if (matches.length > 1) return { kind: "ambiguous", candidates: [...new Set(matches)].sort(byCodeUnit) };
  return { kind: "unknown" };
}

/** One problem with `events.renamed`: the sentence, and the fix the build prints with it. */
export interface RenamedProblem {
  readonly message: string;
  readonly fix: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return "an empty string";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/**
 * The checks of `events.renamed` that need no declared event: a plain object whose keys are non-empty and whose values
 * are non-empty strings. Used by `checkEvents` at load and first by `renamedProblems`.
 */
export function renamedShapeProblems(renamed: unknown): RenamedProblem[] {
  if (!isPlainObject(renamed))
    return [{
      message: "`events.renamed` must be an object from a former event FQN to the event it now is, such as { \"billing.InvoicePaid\": \"finance.InvoicePaid\" }",
      fix: "Set renamed: { \"<former FQN>\": \"<declared event>\" }",
    }];
  const problems: RenamedProblem[] = [];
  for (const [key, value] of Object.entries(renamed)) {
    if (key.trim() === "")
      problems.push({ message: "`events.renamed` has an empty key: each key is a former event FQN, written in full", fix: "Write the former FQN as the key" });
    else if (typeof value !== "string" || value.trim() === "")
      problems.push({ message: `\`events.renamed\` maps ${JSON.stringify(key)} to ${kindOf(value)}: each value names a declared event`, fix: "Write the event's FQN as a string" });
  }
  return problems;
}

/**
 * Every problem of `events.renamed` against the declared FQNs (rules RN4 to RN6): the shape first; then each key must not
 * be a declared FQN, and each value must pick one declared event (exactly, or by its trailing segments). Since no key is
 * declared and every value is, a value is never a key: the map has no chains, and applying it twice changes nothing.
 */
export function renamedProblems(renamed: unknown, fqns: readonly string[]): RenamedProblem[] {
  const shape = renamedShapeProblems(renamed);
  if (shape.length > 0) return shape;
  const entries = Object.entries(renamed as Record<string, string>);
  if (entries.length === 0) return [];
  if (fqns.length === 0)
    return [{
      message: `\`events.renamed\` maps ${JSON.stringify(entries[0]![0])}, and the project declares no event: the map renames stored events to declared ones`,
      fix: "Remove events.renamed, or declare the event",
    }];
  const problems: RenamedProblem[] = [];
  const sorted = [...fqns].sort(byCodeUnit);
  for (const [key, value] of entries) {
    if (fqns.includes(key)) {
      problems.push({ message: `\`events.renamed\` maps ${JSON.stringify(key)}, which is a declared event: each key is a former FQN that no event declares now`, fix: "Remove the entry, or correct the key" });
      continue;
    }
    const found = resolveEventName(value, fqns);
    if (found.kind === "ambiguous")
      problems.push({ message: `\`events.renamed\` maps ${JSON.stringify(key)} to ${JSON.stringify(value)}, which is ambiguous: ${found.candidates.join(" or ")}`, fix: "Write more of the name" });
    else if (found.kind === "unknown") {
      const chained = Object.hasOwn(renamed as object, value) ? `; it is itself a key of events.renamed, and a former name maps straight to the event it is now` : "";
      problems.push({ message: `\`events.renamed\` maps ${JSON.stringify(key)} to ${JSON.stringify(value)}, which is no declared event${chained}; the project declares ${sorted.join(", ")}`, fix: "Correct the name" });
    }
  }
  return problems;
}

/** The checked map, keys stored names and values full FQNs; or the first problem as a sentence. */
export function renamedMap(renamed: unknown, fqns: readonly string[]): { readonly map: ReadonlyMap<string, string> } | { readonly problem: string } {
  const problems = renamedProblems(renamed, fqns);
  if (problems.length > 0) return { problem: problems[0]!.message };
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(renamed as Record<string, string>)) {
    const found = resolveEventName(value, fqns);
    if (found.kind === "found") map.set(key, found.fqn);
  }
  return { map };
}

/** The empty rename map: what a binding without `events.renamed` reads stored names through. */
export const NO_RENAMES: ReadonlyMap<string, string> = new Map();

/** `map.get(name) ?? name`: idempotent, since no key is declared and every value is (RN5). */
export function storedToDeclared(map: ReadonlyMap<string, string>, name: string): string {
  return map.get(name) ?? name;
}

/**
 * The stored names a list of declared FQNs stands for in the outbox: each name, and every former name the map reads as
 * it. What a query over stored names (`firstOutboxRow`) is given, so a renamed row counts as its declared event.
 */
export function storedNamesOf(map: ReadonlyMap<string, string>, names: readonly string[]): string[] {
  if (map.size === 0) return [...names];
  const out = new Set(names);
  for (const [stored, declared] of map) if (out.has(declared)) out.add(stored);
  return [...out];
}

import type { Diagnostic } from "@meshfw/model";

/**
 * The attribution of diagnostics found in a project mixin's lines (`notes/architecture/mixins-design.md`, rule R19).
 * A mixin's lines are read once per entity that uses it (an includer), so a stage that finds a mistake there finds it
 * once per includer, at the same position. Each stage that loops entities tags what it reports for one entity at a
 * position outside that entity's file (`includerTagger`); before the build sorts its diagnostics, `mergeIncluders` keeps
 * one per mistake, naming the includers that have it unless all of them do. A stage that loops entities and does not tag
 * reports a mixin's mistake once per includer with no name; the build's final de-duplication then keeps one of them.
 */
const includerOf = new WeakMap<Diagnostic, string>();

/** Tags each diagnostic pushed since `from` whose position is not in `entity.file` as found for `entity`. */
export function tagIncluder(diagnostics: readonly Diagnostic[], from: number, entity: { readonly fqn: string; readonly file: string }): void {
  for (let index = from; index < diagnostics.length; index++) {
    const d = diagnostics[index]!;
    if (d.position.file !== entity.file && !includerOf.has(d)) includerOf.set(d, entity.fqn);
  }
}

/**
 * A tagger for a loop over entities: call it with each entity as its iteration begins, and with none once the loop is
 * done. What was pushed since the previous call is tagged for the previous entity, so a `continue` loses nothing.
 */
export function includerTagger(diagnostics: readonly Diagnostic[]): (entity?: { readonly fqn: string; readonly file: string }) => void {
  let current: { readonly fqn: string; readonly file: string } | undefined;
  let from = diagnostics.length;
  return (entity) => {
    if (current) tagIncluder(diagnostics, Math.min(from, diagnostics.length), current);
    current = entity;
    from = diagnostics.length;
  };
}

/** A code whose message names its entity already: reported per includer, never prefixed. */
const NAMES_ITS_ENTITY: ReadonlySet<string> = new Set(["MESH_UNKNOWN_MEMBER"]);

const listed = (names: readonly string[]) => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * R19: diagnostics at a position inside a mixin file (a key of `includersOf`) that are equal in code, severity, message
 * and position are reported once, with the message unchanged when every includer of that mixin has it, and otherwise
 * prefixed `in billing.Invoice, which uses this mixin, ` (or `in A and B, which use this mixin, `).
 */
export function mergeIncluders(diagnostics: Diagnostic[], includersOf: ReadonlyMap<string, ReadonlySet<string>>): void {
  if (!includersOf.size) return;
  const groups = new Map<string, Diagnostic[]>();
  for (const d of diagnostics) {
    if (!includerOf.has(d) || !includersOf.has(d.position.file)) continue;
    const key = [d.code, d.severity, d.message, d.position.file, d.position.offset].join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  const dropped = new Set<Diagnostic>();
  for (const group of groups.values()) {
    const [kept, ...rest] = group as [Diagnostic, ...Diagnostic[]];
    rest.forEach((d) => dropped.add(d));
    if (NAMES_ITS_ENTITY.has(kept.code)) continue;
    const who = [...new Set(group.map((d) => includerOf.get(d)!))].sort();
    const all = includersOf.get(kept.position.file)!;
    if (all.size && who.length >= all.size) continue;
    kept.message = `in ${listed(who)}, which use${who.length === 1 ? "s" : ""} this mixin, ${kept.message}`;
  }
  if (!dropped.size) return;
  const rest = diagnostics.filter((d) => !dropped.has(d));
  diagnostics.length = 0;
  diagnostics.push(...rest);
}

/** The mixin each model object read from a mixin's lines came from, by its name as written (`markFromMixin`). */
const fromMixins = new WeakMap<object, string>();
/**
 * Records that `line` (an `always` block) was read from the mixin `name`, so a later stage can name the mixin in a message:
 * a shipped mixin's lines are positioned at the `use` line (ruling D37 OD5), where nothing else says where they came from.
 */
export const markFromMixin = (line: object, name: string): void => { fromMixins.set(line, name); };
/** The mixin `line` was read from, or undefined for a line the entity's own file holds. */
export const mixinOfLine = (line: object): string | undefined => fromMixins.get(line);

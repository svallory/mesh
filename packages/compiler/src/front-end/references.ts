import type { Import } from "@meshfw/model";
import { nearestName } from "./nearest-name.ts";
import type { Attr, SyntaxNode, Tag } from "./tree.ts";

/**
 * A reference to a declaration of another file (SYN-21), as the entity file writes it: an imported identifier (`List`), or
 * a member of a namespace import (`billing.Invoice`), whose qualifier is the alias the file gives that file. The alias is
 * the author's choice and never part of an FQN.
 */
export interface WrittenReference {
  /** The namespace alias, `billing` in `billing.Invoice`; absent for `List`. */
  qualifier?: { name: string; offset: number };
  name: string;
  /** Where the name is written: the member's own offset in `billing.Invoice`. */
  offset: number;
}

/** The reference as written, `List` or `billing.Invoice`: what a model's `EntityRef.identifier` holds. */
export const referenceText = (written: WrittenReference): string => (written.qualifier ? `${written.qualifier.name}.${written.name}` : written.name);

type Node = SyntaxNode & { start?: number | null; loc?: { start: { index: number } }; object?: Node; property?: Node; computed?: boolean };
const startOf = (n: Node): number => n.start ?? n.loc?.start.index ?? 0;
/** `an entity`, `a command`. */
const an = (noun: string) => `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;

/**
 * The reference a node writes: an identifier, or one plain member access on one. Anything else is no reference, which the
 * contract of the option that holds it has refused (`MESH_ENTITY_REFERENCE`).
 */
export function writtenReference(node: SyntaxNode | null | undefined): WrittenReference | undefined {
  const n = node as Node | null | undefined;
  if (n?.type === "Identifier" && n.name) return { name: n.name, offset: startOf(n) };
  if (n?.type === "MemberExpression" && !n.computed && n.object?.type === "Identifier" && n.object.name
    && n.property?.type === "Identifier" && n.property.name)
    return { qualifier: { name: n.object.name, offset: startOf(n.object) }, name: n.property.name, offset: startOf(n.property) };
  return undefined;
}

/**
 * Whether the option writes the reference alone: `entity=List` or `entity=billing.Invoice`, with only whitespace and
 * comments around its words and the comma that may end an option. MX lowers `(List)`, `List!`, `List as T`,
 * `List satisfies T` and `<T>List` to `List`, and keeps no mark of `!`, `as` or `satisfies` in the node or its spans, so
 * only the source tells a wrapper apart. It is read here to refuse one, never to give a reference its meaning. The option
 * runs from its name to the next option, or to the end of the tag's line.
 */
export function writtenAlone(source: string, tag: Tag, option: Extract<Attr, { kind: "dynamic" }>, written: WrittenReference): boolean {
  const from = option.nameSpan.sourceEnd;
  const next = Math.min(...tag.attrs.map((a) => a.span.sourceStart).filter((start) => start >= from), tag.span.sourceEnd);
  const text = source.slice(from, next).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ").split("\n")[0]!.replace(/\s+/g, "");
  const alone = `=${referenceText(written)}`;
  return text === alone || text === `${alone},`;
}

/** What a reference is resolved against: the file's imports and own declaration, and what each imported file declares. */
export interface ReferenceScope {
  /** Each name the file's imports bind, to its import: a named import's local, or a namespace import's alias. */
  imports: ReadonlyMap<string, Import>;
  /**
   * The names two imports bind. `MESH_DUPLICATE_IMPORT` reports the second binding, so a reference through such a name
   * resolves to nothing and reports nothing more.
   */
  duplicates: ReadonlySet<string>;
  /** The file's own declaration, which the file names without an import (an entity relates to itself), and its path. */
  own: { name: string; from: string };
  /**
   * The names the file at `from` (as an import of this file writes the path) declares, or undefined when the project has
   * no such file: the import itself is reported then, so a reference through it is not.
   */
  declared: (from: string) => readonly string[] | undefined;
}

/** What a position references: `entity=` takes an entity, and `on=` will take a command or an event (DOM-17). */
export interface ReferenceKind {
  /** What the position takes, for messages: `entity`. */
  noun: string;
  /** Whether a file at `from` declares what the position takes (an entity file, `hasMeshExtension`). */
  declares: (from: string) => boolean;
  /** The code of an unknown reference: `MESH_UNKNOWN_ENTITY`. */
  code: string;
}

export type Resolution =
  | { ok: true; identifier: string; from: string }
  | { ok: false; code: string; message: string; offset: number; fix?: string }
  /** A reference through a name two imports bind: `MESH_DUPLICATE_IMPORT` already reports it. */
  | { ok: false; reported: true };

/**
 * Resolves a reference (SYN-21): `List` to the file whose import binds it (or to the file itself, by its own name), and
 * `billing.Invoice` to the file the namespace import `billing` names, when that file declares `Invoice`. The one function
 * every reference position calls, so each says the same thing about the same mistake. `identifier` is the reference as
 * written (`billing.Invoice`); the target is what `from` declares.
 */
export function resolveReference(written: WrittenReference, scope: ReferenceScope, kind: ReferenceKind): Resolution {
  const { qualifier, name } = written;
  if (scope.duplicates.has(qualifier?.name ?? name)) return { ok: false, reported: true };
  const identifier = referenceText(written);
  const fail = (message: string, offset: number, fix?: string): Resolution => ({ ok: false, code: kind.code, message, offset, ...(fix ? { fix } : {}) });
  const unknown = (detail = "") => {
    const all = candidates(scope, kind);
    // `Invoice` where the file imports its file as a namespace: the member, qualified (`billing.Invoice`).
    const members = new Map<string, string | undefined>();
    for (const candidate of all.filter((c) => c.includes("."))) {
      const member = candidate.slice(candidate.indexOf(".") + 1);
      members.set(member, members.has(member) ? undefined : candidate);
    }
    const member = qualifier ? undefined : nearestName(name, [...members.keys()]);
    const suggestion = nearestName(identifier, all) ?? (member === undefined ? undefined : members.get(member));
    return fail(`${identifier} is not an imported ${kind.noun}${detail}.${suggestion ? ` Did you mean ${suggestion}?` : ""}`, qualifier?.offset ?? written.offset);
  };
  if (!qualifier) {
    const imported = scope.imports.get(name);
    if (!imported) return name === scope.own.name ? { ok: true, identifier, from: scope.own.from } : unknown();
    if (!imported.namespace) return kind.declares(imported.from) ? { ok: true, identifier, from: imported.from } : unknown();
    // `entity=billing`: the file, not what it declares.
    const members = kind.declares(imported.from) ? scope.declared(imported.from) : undefined;
    const member = members?.length === 1 ? members[0] : undefined;
    return fail(
      `${name} is a namespace import of ${imported.from}, not ${an(kind.noun)}: name ${kind.declares(imported.from) ? `the ${kind.noun} it declares, \`${name}.${member ?? "Name"}\`` : `${an(kind.noun)} that ${an(kind.noun)} file declares`}`,
      written.offset,
      member ? `write \`${name}.${member}\`` : undefined,
    );
  }
  const imported = scope.imports.get(qualifier.name);
  if (!imported) return unknown(`: no import of this file is named ${qualifier.name}`);
  if (!imported.namespace)
    return kind.declares(imported.from)
      ? fail(
        `${identifier} is not an imported ${kind.noun}: ${qualifier.name} is imported by name, as the ${kind.noun} itself; a member access reads a namespace import (\`import * as ${qualifier.name.charAt(0).toLowerCase()}${qualifier.name.slice(1)} from "${imported.from}"\`)`,
        qualifier.offset,
        `write \`${qualifier.name}\``,
      )
      : unknown();
  if (!kind.declares(imported.from))
    return fail(`${identifier} is not an imported ${kind.noun}: ${qualifier.name} is a namespace import of ${imported.from}, which is not ${an(kind.noun)} file`, qualifier.offset);
  const members = scope.declared(imported.from);
  if (!members || members.includes(name)) return { ok: true, identifier, from: imported.from };
  const nearest = nearestName(name, members) ?? (members.length === 1 ? members[0] : undefined);
  return fail(
    `${identifier} is not an imported ${kind.noun}: ${imported.from} declares ${members.map((member) => `\`${member}\``).join(", ") || "nothing"}.${nearest ? ` Did you mean ${qualifier.name}.${nearest}?` : ""}`,
    written.offset,
    nearest ? `write \`${qualifier.name}.${nearest}\`` : undefined,
  );
}

/** Every reference the scope resolves, for advice: the own name, each named import of a declaring file and each namespace member. */
function candidates(scope: ReferenceScope, kind: ReferenceKind): string[] {
  const names = [scope.own.name];
  for (const [local, imported] of scope.imports) {
    if (!kind.declares(imported.from)) continue;
    if (!imported.namespace) names.push(local);
    else for (const member of scope.declared(imported.from) ?? []) names.push(`${local}.${member}`);
  }
  return names;
}

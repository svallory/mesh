import {
  attributeTypeInfo,
  type Action,
  type ActionKind,
  type Attribute,
  type Resource,
  type SourcePosition,
  type Spanned,
} from "@mesh/model";
import { formatTypescript } from "../format.ts";
import { EmitError, emitError } from "../emit-error.ts";
import type { Emitter, EmitInput, GeneratedFile } from "../emit.ts";
import { orderedResources, outputPrefix, pathSegment } from "./order.ts";

/** A valid TypeScript identifier. Reserved words are allowed as a property name,
 * not as a declared type name, so the two checks are separate. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set([
  "any", "bigint", "boolean", "break", "case", "catch", "class", "const", "constructor", "continue",
  "debugger", "declare", "default", "delete", "do", "else", "enum", "export", "extends", "false",
  "finally", "for", "function", "if", "implements", "import", "in", "instanceof", "interface",
  "let", "new", "null", "number", "object", "package", "private", "protected", "public", "return",
  "static", "string", "super", "switch", "symbol", "this", "throw", "true", "try", "type", "typeof",
  "var", "void", "while", "with", "yield",
]);

/** The names a type expression refers to from the global scope, read out of the
 * rendered text rather than from a fixed list, because a name only matters where
 * the file uses it: a resource named `date` is fine in a file with no `datetime`
 * attribute, and a build error in a file with one, which is the only place where
 * declaring `Date` would capture the type of `when`. */
const TYPE_IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** The body of an input that accepts nothing: no property may be assigned to it,
 * not even one with a `never` value, and it is not a primitive. `{}` would accept
 * both. Only an input can be empty: a record always holds the primary key, which
 * the loader requires. */
const NEVER_MEMBER = "[key: string]: never;";

/** Line terminators spelled out, so a source filename with one in it cannot end
 * the comment that carries it. */
const TERMINATORS: Readonly<Record<string, string>> = {
  "\r\n": "\\r\\n",
  "\n": "\\n",
  "\r": "\\r",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};
const commentSafe = (text: string): string =>
  text.replace(/\r\n|[\n\r\u2028\u2029]/g, (match) => TERMINATORS[match] ?? match);

/**
 * `blog-post` and `blog_post` both read as `BlogPost`, `café` reads as `Caf`:
 * only ASCII letters and digits survive, a leading underscore is kept and every
 * other run of characters separates two words. A name Mesh cannot turn into an
 * identifier, or two names that read as one, is a build error at the name rather
 * than a generated file with two meanings behind one name.
 */
export function pascalCase(name: string): string {
  const leading = /^_*/.exec(name)?.[0] ?? "";
  const words = name
    .slice(leading.length)
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return leading + words.join("");
}

function typeName(source: Spanned<string>, what: "Resource" | "Action"): string {
  const name = pascalCase(source.value);
  if (!IDENTIFIER.test(name) || RESERVED.has(name)) {
    throw emitError(
      "MESH_EMIT_NAME",
      `${what} "${source.value}" does not become a valid TypeScript type name ("${name}")`,
      source.position,
      `Rename the ${what.toLowerCase()} so it reads as an identifier, for example \`post\` or \`_post\``,
    );
  }
  return name;
}

/** `true` for a name that is a valid identifier and so needs no quotes. */
const isIdentifier = (name: string): boolean => IDENTIFIER.test(name);

/** A property name that is not an identifier is quoted; nothing is renamed, so the
 * attribute the author wrote is the property the program reads. A reserved word is
 * a legal property name and stays unquoted. */
export const propertyName = (name: string): string => (isIdentifier(name) ? name : JSON.stringify(name));

/**
 * The TypeScript type of one attribute value, from the registry entry
 * (`ATTRIBUTE_TYPES[].tsType`). An `atom` with `one_of` is the union of its allowed
 * values, not `string`: the constraint is the type. An attribute that allows nil is
 * `T | null`, never `T | undefined`.
 */
function valueType(attribute: Attribute): string {
  const oneOf = attribute.type === "atom" && attribute.constraints ? attribute.constraints.oneOf : [];
  const base =
    oneOf.length > 0
      ? oneOf.map((item) => JSON.stringify(item.value)).join(" | ")
      : attributeTypeInfo(attribute.type).tsType;
  return attribute.allowNil ? `${base} | null` : base;
}

/** `name: type` or `name?: type`. */
function member(attribute: Attribute, optional: boolean): string {
  return `${propertyName(attribute.name.value)}${optional ? "?" : ""}: ${valueType(attribute)};`;
}

/** The row selector every update and destroy takes: the primary key, with its own
 * type, required. The loader proved the resource has one; a document without it is
 * reported here rather than emitted without a selector. */
function selectorOf(resource: Resource): Attribute {
  const key = resource.attributes.find((attribute) => attribute.primaryKey);
  if (!key) {
    throw emitError(
      "MESH_EMIT_KEY",
      `Resource "${resource.name.value}" has no primary key to select a row with`,
      resource.name.position,
      "Declare uuid-primary-key in attributes",
    );
  }
  return key;
}

/** The attributes an action's input may carry, in the order `accept` lists them:
 * never one the system sets itself. A selector is not an accepted attribute; it is
 * added by the input shape, so accepting the key changes nothing. */
function acceptedAttributes(resource: Resource, action: EffectiveAction): Attribute[] {
  const byName = new Map(resource.attributes.map((attribute) => [attribute.name.value, attribute]));
  const seen = new Set<string>();
  const accepted: Attribute[] = [];
  for (const item of action.accept) {
    const attribute = byName.get(item.value);
    if (attribute === undefined || !attribute.writable || seen.has(item.value)) continue;
    seen.add(item.value);
    accepted.push(attribute);
  }
  return accepted;
}

/** One action the resource really has: what it was declared as, or a built-in asked
 * for through `defaults`, which is named after its kind and accepts nothing. A
 * declared action of a kind replaces the default action of that kind. */
interface EffectiveAction {
  kind: ActionKind;
  name: Spanned<string>;
  accept: readonly Spanned<string>[];
  position: SourcePosition;
}

const effectiveAction = (action: Action): EffectiveAction =>
  action.kind === "read"
    ? { kind: action.kind, name: action.name, accept: [], position: action.position }
    : {
        kind: action.kind,
        name: action.name,
        accept: action.accept,
        position: action.position,
      };

/** Declared actions, then the default actions for the kinds nothing declared. */
export function effectiveActions(resource: Resource): EffectiveAction[] {
  const declared = resource.actions.map(effectiveAction);
  const kinds = new Set(declared.map((action) => action.kind));
  const defaults = (resource.defaults?.kinds ?? [])
    .filter((kind) => !kinds.has(kind.value))
    .map<EffectiveAction>((kind) => ({
      kind: kind.value,
      name: { value: kind.value, position: kind.position },
      accept: [],
      position: kind.position,
    }));
  return [...declared, ...defaults];
}

/** One type the file declares: its name, the authored name it came from, and its
 * members as rendered text, before formatting. */
interface DeclaredType {
  name: string;
  source: Spanned<string>;
  members: string[];
}

/** The record type's members: every attribute, in the order the resource file
 * declares them, read-only ones (the primary key and the timestamps) included.
 * `public` is recorded in the model and reads nothing in v1 (ADR-0035). */
const recordMembers = (resource: Resource): string[] =>
  resource.attributes.map((attribute) => member(attribute, false));

/**
 * One input type per action, in the shape the live action spec gives
 * (`calling-actions.md`, "Signatures" and "Inputs"):
 * - `create`: exactly the accepted attributes, required unless the attribute allows
 *   nil or carries a default, because the runtime can supply either.
 * - `update`: `{ id, ...accepted }`; the selector is required, every accepted
 *   attribute optional.
 * - `destroy`: `{ id }`, or `{ id, ...accepted }` when it accepts attributes, which
 *   Ash's destroy does for a soft destroy and Mesh keeps (mapping deviation D14).
 *   The accepted part is built exactly as an update's is.
 * - `read`: no input type in M1.
 *
 * In M2 the generated validator checks the same list.
 */
export interface InputField {
  attribute: Attribute;
  optional: boolean;
}

/** The shared input plan: types and validators must consume this same shape. */
export function resourceInputs(resource: Resource): { name: string; source: Spanned<string>; fields: InputField[] }[] {
  const recordName = typeName(resource.name, "Resource");
  return effectiveActions(resource).filter((action) => action.kind !== "read").map((action) => {
    const accepted = acceptedAttributes(resource, action);
    const fields = action.kind === "create"
      ? accepted.map((attribute) => ({ attribute, optional: attribute.allowNil || attribute.default !== null }))
      : [{ attribute: selectorOf(resource), optional: false }, ...accepted.map((attribute) => ({ attribute, optional: true }))];
    return { name: `${typeName(action.name, "Action")}${recordName}Input`, source: action.name, fields };
  });
}

/** Every type the file declares, with the members it renders. */
function declaredTypes(resource: Resource): DeclaredType[] {
  const recordName = typeName(resource.name, "Resource");
  return [
    { name: recordName, source: resource.name, members: recordMembers(resource) },
    ...resourceInputs(resource).map((input) => ({
      name: input.name,
      source: input.source,
      members: input.fields.map(({ attribute, optional }) => member(attribute, optional)),
    })),
  ];
}

/** The global type names the attribute types of one resource's file refer to, taken
 * from the registry as data, while the file's types are rendered. Today that is
 * `Date`, from `datetime`. A property name, a string literal in a `one_of` union
 * and anything in a comment are values, not references to a global type, so they
 * can never trigger the check. The templates' own words (`string`, `never`) are
 * keywords no generated name can be, since a generated name is PascalCase. */
function referencedGlobals(resource: Resource): ReadonlySet<string> {
  const referenced = new Set<string>();
  for (const attribute of resource.attributes) {
    for (const name of attributeTypeInfo(attribute.type).tsType.match(TYPE_IDENTIFIER) ?? []) referenced.add(name);
  }
  return referenced;
}

/** `export type Name = { ... };`, before the formatter sees the file. */
function typeSource(declared: DeclaredType): string {
  const body =
    declared.members.length === 0
      ? NEVER_MEMBER
      : `\n${declared.members.map((line) => `  ${line}`).join("\n")}\n`;
  return `export type ${declared.name} = {${body}};\n`;
}

/** The do-not-edit header. It names the resource file, never a machine or a run,
 * with any line terminator in that name spelled out so the comment cannot end early. */
export function header(resource: Resource): string {
  return `// Do not edit this file by hand.\n// It is generated by \`mesh build\` from ${commentSafe(resource.position.file)}; change that file and rebuild.\n`;
}

async function typesFor(resource: Resource): Promise<string> {
  const parts = [header(resource), ...declaredTypes(resource).map(typeSource)];
  return formatTypescript(parts.join("\n"));
}

/**
 * One `<resource>.types.ts` per resource: `<output>/<domain>/<resource>.types.ts`
 * when the resource has a domain, and `<output>/<resource>.types.ts` when it has
 * none (the project structure page, "The generated tree"). Nothing here imports
 * `@mesh/model`, `@mesh/compiler` or `model.json` (ADR-0033): the types file is what
 * the program reads, and it must stand on its own.
 *
 * Names and paths are checked for the whole project before anything is formatted,
 * because a collision between two resources' type names, or two paths that differ
 * only in letter case, is only visible across files.
 */
export const resourceTypesEmitter: Emitter = {
  name: "resource-types",
  async emit({ document, config }: EmitInput): Promise<readonly GeneratedFile[]> {
    const resources = orderedResources(document);
    const prefix = outputPrefix(config);
    const records = new Map<string, Spanned<string>>();
    const paths = new Map<string, Spanned<string>>();
    const plan: { resource: Resource; path: string }[] = [];
    for (const resource of resources) {
      // The path first: a name that cannot be a path segment is not a usable name
      // at all, whatever it would have read as.
      const domain = resource.domain ? `${pathSegment(resource.domain)}/` : "";
      const nameSegment = pathSegment(resource.name);
      const declared = declaredTypes(resource);
      const globals = referencedGlobals(resource);
      const inFile = new Map<string, Spanned<string>>();
      for (const type of declared) {
        if (globals.has(type.name)) {
          throw emitError(
            "MESH_EMIT_NAME",
            `${type.source === resource.name ? "Resource" : "Action"} "${type.source.value}" generates the type name "${type.name}", which would capture the \`${type.name}\` this file uses`,
            type.source.position,
            `Rename it so the generated type name does not shadow \`${type.name}\``,
          );
        }
        const twin = inFile.get(type.name);
        if (twin !== undefined) {
          throw emitError(
            "MESH_EMIT_NAME",
            `Resource "${resource.name.value}" generates the type name "${type.name}" twice, from "${twin.value}" and "${type.source.value}"`,
            type.source.position,
            "Rename one of them so the generated type names in this file differ",
          );
        }
        inFile.set(type.name, type.source);
      }
      const recordName = declared[0]!.name;
      const previousRecord = records.get(recordName);
      if (previousRecord !== undefined) {
        throw emitError(
          "MESH_EMIT_NAME",
          `Resources "${previousRecord.value}" and "${resource.name.value}" both generate the type name "${recordName}"`,
          resource.name.position,
          "Rename one resource so their generated type names differ",
        );
      }
      records.set(recordName, resource.name);
      const path = `${prefix}/${domain}${nameSegment}.types.ts`;
      const alias = paths.get(path.toLowerCase());
      if (alias !== undefined) {
        throw emitError(
          "MESH_EMIT_PATH",
          `Resources "${alias.value}" and "${resource.name.value}" write "${path}", which differs from another generated path only in letter case`,
          resource.name.position,
          "Rename one resource so the two generated file names differ by more than case",
        );
      }
      paths.set(path.toLowerCase(), resource.name);
      plan.push({ resource, path });
    }
    return Promise.all(
      plan.map(async ({ resource, path }): Promise<GeneratedFile> => {
        try {
          return { path, contents: await typesFor(resource) };
        } catch (cause) {
          // A formatter failure is a bug in this emitter, reported at the resource
          // that triggered it rather than swallowed.
          if (cause instanceof EmitError) throw cause;
          throw emitError(
            "MESH_EMIT_TYPES",
            `Cannot generate types for resource "${resource.name.value}": ${cause instanceof Error ? cause.message : String(cause)}`,
            resource.name.position,
            "Report this emitter bug",
          );
        }
      }),
    );
  },
};
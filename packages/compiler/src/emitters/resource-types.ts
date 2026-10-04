import {
  ATTRIBUTE_TYPES,
  attributeTypeInfo,
  type AcceptingAction,
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

/**
 * The names a generated file uses from the global scope, read from the attribute
 * type registry rather than written out here, so a new registry type brings its
 * own name with it. A generated declaration that captured one of them would
 * change the meaning of the file silently: a resource named `date` emits
 * `export type Date = { when: Date }`, and every `datetime` attribute in it
 * would refer to the record.
 */
const TEMPLATE_GLOBALS: ReadonlySet<string> = new Set(
  ATTRIBUTE_TYPES.flatMap((type) => type.tsType.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []),
);

/** The body of an input that accepts nothing: no property may be assigned to it,
 * not even one with a `never` value, and it is not a primitive. `{}` would accept
 * both. */
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
const propertyName = (name: string): string => (isIdentifier(name) ? name : JSON.stringify(name));

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

/** The record type: every attribute, in the order the resource file declares them,
 * read-only ones (the primary key and the timestamps) included. `public` is recorded
 * in the model and reads nothing in v1 (ADR-0035). */
function recordType(resource: Resource, name: string): string {
  const body = resource.attributes.map((attribute) => `  ${member(attribute, false)}`);
  return `export type ${name} = {\n${body.join("\n")}\n};\n`;
}

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
function inputType(resource: Resource, action: EffectiveAction, recordName: string): string {
  const accepted = acceptedAttributes(resource, action);
  const members =
    action.kind === "create"
      ? accepted.map((attribute) =>
          member(attribute, !(!attribute.allowNil && attribute.default === null)),
        )
      : [member(selectorOf(resource), false), ...accepted.map((attribute) => member(attribute, true))];
  const body = members.length === 0 ? NEVER_MEMBER : `\n${members.map((line) => `  ${line}`).join("\n")}\n`;
  return `export type ${typeName(action.name, "Action")}${recordName}Input = {${body}};\n`;
}

/** The do-not-edit header. It names the resource file, never a machine or a run,
 * with any line terminator in that name spelled out so the comment cannot end early. */
function header(resource: Resource): string {
  return `// Do not edit this file by hand.\n// It is generated by \`mesh build\` from ${commentSafe(resource.position.file)}; change that file and rebuild.\n`;
}

/** One action the resource really has: what it was declared as, or a built-in asked
 * for through `defaults`, which is named after its kind and accepts nothing. A
 * declared action of a kind replaces the default action of that kind. */
interface EffectiveAction {
  kind: ActionKind;
  name: Spanned<string>;
  accept: readonly Spanned<string>[];
  position: SourcePosition;
  declared: boolean;
}

const effectiveAction = (action: Action): EffectiveAction =>
  action.kind === "read"
    ? { kind: action.kind, name: action.name, accept: [], position: action.position, declared: true }
    : {
        kind: action.kind,
        name: action.name,
        accept: (action as AcceptingAction).accept,
        position: action.position,
        declared: true,
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
      declared: false,
    }));
  return [...declared, ...defaults];
}

/** Every type name one file declares, with the authored name it came from. */
function declaredTypeNames(resource: Resource, recordName: string): { name: string; source: Spanned<string> }[] {
  const inputs = effectiveActions(resource)
    .filter((action) => action.kind !== "read")
    .map((action) => ({
      name: `${typeName(action.name, "Action")}${recordName}Input`,
      source: action.name,
    }));
  return [{ name: recordName, source: resource.name }, ...inputs];
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
      const recordName = typeName(resource.name, "Resource");
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
      const inFile = new Map<string, Spanned<string>>();
      for (const declared of declaredTypeNames(resource, recordName)) {
        if (TEMPLATE_GLOBALS.has(declared.name)) {
          throw emitError(
            "MESH_EMIT_NAME",
            `${declared.source === resource.name ? "Resource" : "Action"} "${declared.source.value}" generates the type name "${declared.name}", which would capture the \`${declared.name}\` the attribute types use`,
            declared.source.position,
            `Rename it so the generated type name does not shadow \`${declared.name}\``,
          );
        }
        const twin = inFile.get(declared.name);
        if (twin !== undefined) {
          throw emitError(
            "MESH_EMIT_NAME",
            `Resource "${resource.name.value}" generates the type name "${declared.name}" twice, from "${twin.value}" and "${declared.source.value}"`,
            declared.source.position,
            "Rename one of them so the generated type names in this file differ",
          );
        }
        inFile.set(declared.name, declared.source);
      }
      const path = `${prefix}/${resource.domain ? `${pathSegment(resource.domain)}/` : ""}${pathSegment(resource.name)}.types.ts`;
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
          const recordName = typeName(resource.name, "Resource");
          const parts = [
            header(resource),
            recordType(resource, recordName),
            ...effectiveActions(resource)
              .filter((action) => action.kind !== "read")
              .map((action) => inputType(resource, action, recordName)),
          ];
          return { path, contents: await formatTypescript(parts.join("\n")) };
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
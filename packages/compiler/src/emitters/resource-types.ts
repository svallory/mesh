import { attributeTypeInfo, type AcceptingAction, type Action, type Attribute, type Resource, type Spanned } from "@mesh/model";
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
 * `blog-post` and `blog_post` both read as `BlogPost`; a name Mesh cannot turn into
 * an identifier, or two names that read as one, is a build error at the name rather
 * than a generated file with two different meanings behind one name.
 */
export function pascalCase(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function typeName(source: Spanned<string>, what: string): string {
  const name = pascalCase(source.value);
  if (!IDENTIFIER.test(name) || RESERVED.has(name)) {
    throw emitError(
      "MESH_EMIT_NAME",
      `${what} "${source.value}" does not become a valid TypeScript type name ("${name}")`,
      source.position,
      `Rename ${what === "Resource" ? "the resource" : "the action"} so it starts with a letter or an underscore`,
    );
  }
  return name;
}

/** `true` for a name that is a valid identifier and so needs no quotes. */
const isIdentifier = (name: string): boolean => IDENTIFIER.test(name);

/** A property name that is not an identifier is quoted; nothing is renamed, so the
 * attribute the author wrote is the property the program reads. */
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

/** The record type: every attribute, in the order the resource file declares them,
 * read-only ones (the primary key and the timestamps) included. `public` is recorded
 * in the model and reads nothing in v1 (ADR-0035). */
function recordType(resource: Resource, name: string): string {
  const body = resource.attributes.map((attribute) => member(attribute, false));
  return `export type ${name} = {\n${body.map((line) => `  ${line}`).join("\n")}\n};\n`;
}

/**
 * One input type per action, built from its `accept` list (mapping page, D14):
 * - `create`: the accepted attributes, required unless the attribute allows nil or
 *   carries a default, because the runtime can supply either.
 * - `update`: the accepted attributes, all optional; a caller sends only what changes.
 * - `destroy`: its `accept` list, all optional, as an update.
 * - `read`: no input type in M1.
 *
 * An attribute that is not writable is never in an input, whatever `accept` says:
 * the primary key and the timestamps are set by the system. In M2 the generated
 * validator checks the same list.
 */
function inputType(resource: Resource, action: AcceptingAction, recordName: string): string {
  const byName = new Map(resource.attributes.map((attribute) => [attribute.name.value, attribute]));
  const accepted = action.accept
    .map((item) => byName.get(item.value))
    .filter((attribute): attribute is Attribute => attribute !== undefined && attribute.writable);
  const required = (attribute: Attribute) =>
    action.kind === "create" && !attribute.allowNil && attribute.default === null;
  const body = accepted.map((attribute) => member(attribute, !required(attribute)));
  const name = `${typeName(action.name, "Action")}${recordName}Input`;
  return `export type ${name} = {${body.length === 0 ? "" : `\n${body.map((line) => `  ${line}`).join("\n")}\n`}};\n`;
}

/** The do-not-edit header. It names the resource file, never a machine or a run. */
function header(resource: Resource): string {
  return `// Do not edit this file by hand.\n// It is generated by \`mesh build\` from ${resource.position.file}; change that file and rebuild.\n`;
}

async function typesFor(resource: Resource): Promise<string> {
  const recordName = typeName(resource.name, "Resource");
  const parts = [
    header(resource),
    recordType(resource, recordName),
    ...resource.actions
      .filter((action): action is AcceptingAction => action.kind !== "read")
      .map((action) => inputType(resource, action, recordName)),
  ];
  return formatTypescript(parts.join("\n"));
}

/**
 * One `<resource>.types.ts` per resource: `<output>/<domain>/<resource>.types.ts`
 * when the resource has a domain, and `<output>/<resource>.types.ts` when it has
 * none (the project structure page, "The generated tree"). Nothing here imports
 * `@mesh/model`, `@mesh/compiler` or `model.json` (ADR-0033): the types file is what
 * the program reads, and it must stand on its own.
 *
 * Names are checked for the whole project before anything is written, because a
 * collision between two resources' type names is only visible across files.
 */
export const resourceTypesEmitter: Emitter = {
  name: "resource-types",
  async emit({ document, config }: EmitInput): Promise<readonly GeneratedFile[]> {
    const resources = orderedResources(document);
    const taken = new Map<string, Spanned<string>>();
    for (const resource of resources) {
      const name = typeName(resource.name, "Resource");
      const previous = taken.get(name);
      if (previous !== undefined) {
        throw emitError(
          "MESH_EMIT_NAME",
          `Resources "${previous.value}" and "${resource.name.value}" both generate the type name "${name}"`,
          resource.name.position,
          "Rename one resource so their generated type names differ",
        );
      }
      taken.set(name, resource.name);
      const actions = new Map<string, Spanned<string>>();
      for (const action of resource.actions as readonly Action[]) {
        if (action.kind === "read") continue;
        const inputName = `${typeName(action.name, "Action")}${name}Input`;
        const other = actions.get(inputName);
        if (other !== undefined) {
          throw emitError(
            "MESH_EMIT_NAME",
            `Actions "${other.value}" and "${action.name.value}" of resource "${resource.name.value}" both generate the input type "${inputName}"`,
            action.name.position,
            "Rename one action so their generated input type names differ",
          );
        }
        actions.set(inputName, action.name);
      }
    }
    const prefix = outputPrefix(config);
    return Promise.all(
      resources.map(async (resource): Promise<GeneratedFile> => {
        const domain = resource.domain ? `${pathSegment(resource.domain)}/` : "";
        try {
          return {
            path: `${prefix}/${domain}${pathSegment(resource.name)}.types.ts`,
            contents: await typesFor(resource),
          };
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
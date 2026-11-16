import { lowerSource } from "@mxlang/core";
import { basename, dirname, relative, resolve } from "node:path";
import { realpathSync, statSync } from "node:fs";
import {
  foreignAbsolute,
  inside,
  normalizePath,
  resolveEntityFile,
} from "../paths.ts";
export { projectPath } from "../paths.ts";
import {
  attributeTypeInfo,
  findNonJsonValue,
  isActionKind,
  type ActionType,
  type Always,
  type Argument,
  type Attribute,
  type AttributeType,
  type Action,
  type Check,
  type ValidateItem,
  type CommandDeclaration,
  type Computed,
  type Diagnostic,
  type Entity,
  type EventDeclaration,
  type Expression,
  type Field,
  type Import,
  type InputField,
  type MemberRef,
  type ModelDocument,
  type Policy,
  type Relationship,
  type Rollup,
  type SourcePosition,
  type Step,
} from "@meshfw/model";
import { MESH_DIALECT } from "./dialect.ts";
import { hasMeshExtension } from "./extensions.ts";
import { askCallsOf, asynchronyOf, copyExpression, demotionOf, privilegedCallsOf, scopeReachOf } from "./expression.ts";
import { checkExpressions } from "../model/index.ts";
import { error, positionAt, type BuildResult, type ProjectDescription } from "../model/index.ts";
import { referenceText, resolveReference, writtenReference, type ReferenceKind, type ReferenceScope } from "./references.ts";
import { literalFits } from "./literal-types.ts";
import {
  resolveRollups,
  unknownMember,
  type PendingRollup,
} from "./rollups.ts";
import { resolveRelationships } from "./relationships.ts";
import { checkLifecycleLimits } from "../model/lifecycle-limits.ts";
import { checkCommands } from "../model/commands.ts";
import { checkPublishSteps } from "../model/publish-steps.ts";
import { classNameOf, isClassName } from "../model/class-name.ts";
import { computeNeeds } from "../model/needs.ts";
import {
  atomList,
  atomOf,
  attr,
  attrOffset,
  readMemberPath,
  containsAtom,
  declaredName,
  expression,
  isMemberLine,
  nodeOf,
  readAt,
  readMember,
  readMemberLine,
  readMembers,
  tags,
  textOf,
  valueOf,
  type Attr,
  type IrImport,
  type Tag,
} from "./tree.ts";

/**
 * The one name no member (attribute, relationship, computed field, action, policy) may take: in an object
 * literal, `__proto__: value` sets the object's prototype instead of adding a property, so the generated records,
 * schemas, row mappings and entity values could not hold it. Every other name, `constructor` and `toString` included,
 * is accepted and generated code works with it.
 */
export const PROTOTYPE_SETTING_NAME = "__proto__";
/** An entity import as MX parsed it (`Import.from`/`names`); never re-parsed. */
interface ParsedImport {
  names: string[];
  /** `offset`: the imported name as written; `localOffset`: the local binding (the alias when written). */
  bindings: { local: string; imported: string; offset: number; localOffset: number }[];
  from: string;
  offset: number;
  /** `import * as billing from …`: `names` is its one alias, and `imported` is `*`. */
  namespace: boolean;
}
interface ImportProblem {
  code: "MESH_UNKNOWN_IMPORT" | "MESH_IMPORT_FORM";
  message: string;
  offset: number;
  fix?: string;
}
/** What a file of the project declares: the kind of its root line (`entity`, `event` or `command`) and the name it gives it. */
interface DeclaredFile {
  kind: "entity" | "event" | "command";
  names: string[];
}
const DECLARING_ROOTS: ReadonlySet<string> = new Set(["entity", "event", "command"]);
/** Where the file's own declaration is named without an import: only an entity file's own entity is (an entity relates to itself). */
/**
 * What a reference position takes, for the files of `kind`: `entity=` an entity, a `publish` function's `new` an event, `on=` a command. A
 * path that no file of the project answers (the import itself is reported) matches every kind, so that a reference through
 * it reports nothing more.
 */
const referenceKind = (kind: DeclaredFile["kind"], declared: (from: string) => DeclaredFile | undefined): ReferenceKind => ({
  noun: kind,
  declares: (from) => hasMeshExtension(from) && (declared(from)?.kind ?? kind) === kind,
  // An event's unknown name is a failed `publish` check (`notes/spec/events-and-commands.md`, "Errors").
  code: kind === "entity" ? "MESH_UNKNOWN_ENTITY" : kind === "command" ? "MESH_UNKNOWN_COMMAND" : "MESH_PUBLISH",
});
/** The package an entity file imports `Mesh` from. */
const MESHFW = "meshfw";
/**
 * Entity files import another file of the project by a relative path, in one of two forms: by name
 * (`import { List } from "./list…"`, `import { isStaff } from "./task.helpers"`), or as a namespace
 * (`import * as billing from "../billing/invoice…"`), whose alias the file picks and reads members of
 * (`billing.Invoice`). A default, side-effect or type-only import is neither. The one package they import from is
 * "meshfw", for `Mesh` alone, by name.
 */
function readImports(imports: readonly IrImport[]): {
  imports: ParsedImport[];
  problems: ImportProblem[];
} {
  const result: ParsedImport[] = [];
  const problems: ImportProblem[] = [];
  for (const entry of imports) {
    const offset = entry.span.sourceStart;
    // `from` and `names` are optional in MX's types and present on every authored import; a missing one is the same import-form error.
    const names = entry.names ?? [];
    const from = entry.from ?? "";
    // A package other than "meshfw" is refused by its path below, whatever its form: the form advice is for a relative import.
    const formed = from === MESHFW || from.startsWith("./") || from.startsWith("../");
    const typeOnly = entry.typeOnly || names.some((name) => name.typeOnly);
    // `import * as billing from …`: one namespace binding and nothing else, from a file of the project.
    const namespace = from !== MESHFW && names.length === 1 && names[0]!.kind === "namespace";
    if (
      formed && (
        !names.length ||
        typeOnly ||
        (!namespace && names.some((name) => name.kind !== "named")))
    ) {
      // The imports the fix writes: every binding the file uses, a default one as a named one (`Task as T`) and a
      // namespace one in its own statement, or the example when the import gives none.
      const named = names.filter((name) => name.kind !== "namespace")
        .map((name) => (name.kind !== "named" || name.imported === name.local ? name.local : `${name.imported} as ${name.local}`));
      const written = (example: string) => {
        const statements = [
          ...(named.length ? [`import { ${named.join(", ")} } from "${from}"`] : []),
          ...names.filter((name) => name.kind === "namespace").map((name) => `import * as ${name.local} from "${from}"`),
        ];
        return (statements.length ? statements : [`import { ${example} } from "${from}"`]).map((statement) => `\`${statement}\``).join(" and ");
      };
      // From "meshfw" the one form is a named value import of `Mesh`: a default, namespace or type import gets
      // that advice, not the entity's.
      problems.push(from === MESHFW
        ? {
          code: "MESH_IMPORT_FORM",
          message: typeOnly
            ? "import `Mesh` as a value, not as a type: a function of the entity file calls its members"
            : "import `Mesh` by name: \"meshfw\" gives an entity file the named export `Mesh` alone",
          offset,
          fix: 'write `import { Mesh } from "meshfw"`',
        }
        : hasMeshExtension(from)
          ? {
            code: "MESH_IMPORT_FORM",
            message: typeOnly
              ? "import the entity by name or as a namespace, not as a type: `import { List } from …` or `import * as billing from …`"
              : "import the entity by name or as a namespace: `import { List } from …` or `import * as billing from …`",
            offset,
            fix: `write ${written("List")}, the entity that file declares`,
          }
          : {
            code: "MESH_IMPORT_FORM",
            message: typeOnly
              ? "import a helper by name or as a namespace, not as a type: `import { isStaff } from …` or `import * as h from …`"
              : "import a helper by name or as a namespace: `import { isStaff } from …` or `import * as h from …`",
            offset,
            fix: `write ${written("isStaff")}, naming the functions that helper file exports and this entity file uses`,
          });
      continue;
    }
    // `import { Mesh } from "meshfw"`: Mesh's own functions, the one import an entity file takes from a package.
    if (from === MESHFW) {
      const other = names.find((name) => name.imported !== "Mesh");
      if (other) {
        problems.push({
          code: "MESH_UNKNOWN_IMPORT",
          message: `"meshfw" gives an entity file \`Mesh\` alone, and \`${other.imported}\` is not it: import \`Mesh\` (\`import { Mesh } from "meshfw"\`) and call its functions as its members`,
          offset: other.span.sourceStart,
        });
        continue;
      }
    } else if (!from.startsWith("./") && !from.startsWith("../")) {
      problems.push({
        code: "MESH_UNKNOWN_IMPORT",
        message: `The import path must be relative (start with ./ or ../), or be "meshfw" for Mesh's own functions (\`import { Mesh } from "meshfw"\`)`,
        offset,
      });
      continue;
    }
    result.push({
      names: names.map((name) => name.local),
      bindings: names.map((name) => ({
        local: name.local,
        imported: name.imported,
        offset: name.span.sourceStart,
        localOffset: (name.localSpan ?? name.span).sourceStart,
      })),
      from,
      offset,
      namespace,
    });
  }
  return { imports: result, problems };
}
const snakeCase = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();

/**
 * A file's module is its folder path, relative to the domain root, with every
 * group segment (`_name`) removed. A bare `_` is not a group; it is reported.
 * An empty result is the domain root.
 */
export function moduleOfFolder(folder: string): { module: string; bareUnderscore: boolean } {
  const segments = folder.split("/").filter((segment) => segment !== "" && segment !== ".");
  return {
    module: segments.filter((segment) => !segment.startsWith("_")).join("/"),
    bareUnderscore: segments.includes("_"),
  };
}

/**
 * What reading an attribute line takes, shared by an entity's attributes and arguments and by the fields of an event and a
 * command: where a tag and an offset are in the file, how an error is reported, the options an attribute line takes
 * (`shape`) and the checks on them (`checkShape`).
 */
function attributeReaders(source: string, file: string, diagnostics: Diagnostic[]) {
  const at = (offset: number) => positionAt(source, file, offset);
  const pos = (tag: Tag) => at(tag.nameSpan.sourceStart);
  const fail = (code: string, message: string, tag: Tag | SourcePosition, fix?: string) =>
    diagnostics.push(error(code, message, "nameSpan" in tag ? pos(tag) : tag, fix ?? null));
  const opt = (tag: Tag, key: string) => {
    const a = attr(tag, key);
    return a ? valueOf(a) : undefined;
  };
  const applyOptions = (tag: Tag) => {
    const result: Pick<
      Attribute,
      "nullable" | "default" | "values" | "min" | "max" | "match"
    > = { nullable: opt(tag, "nullable") === true };
    // A json validates only that the value is JSON, and null is JSON (ADR-0069): it always accepts null,
    // so the model says nullable for it, and a `nullable` the author wrote is redundant.
    if (tag.name === "json") {
      const written = attr(tag, "nullable");
      if (written)
        diagnostics.push({
          severity: "warning",
          code: "MESH_JSON_NULLABLE",
          message: "a json attribute already accepts null, so `nullable` on it has no effect",
          position: at(attrOffset(written)),
          fix: "remove `nullable`",
        });
      result.nullable = true;
    }
    const def = attr(tag, "default");
    if (def) {
      result.default = valueOf(def);
      if (tag.name === "json" && containsAtom(def))
        fail("MESH_DEFAULT", "A json default is a JSON literal, and an atom is not JSON: write a string", tag);
    }
    const values = attr(tag, "values");
    if (values) result.values = atomList(values).map((value) => ({ value }));
    for (const key of ["min", "max"] as const) {
      const value = opt(tag, key);
      if (value !== undefined) result[key] = value as number;
    }
    const match = nodeOf(attr(tag, "match"));
    if (match)
      result.match = { pattern: match.pattern!, flags: match.flags ?? "" };
    return result;
  };
  const shape = (tag: Tag) => ({
    name: declaredName(tag),
    type: tag.name as AttributeType,
    ...applyOptions(tag),
    position: pos(tag),
  });
  const checkShape = (
    field: Pick<
      Attribute,
      | "type"
      | "nullable"
      | "default"
      | "values"
      | "min"
      | "max"
      | "match"
      | "position"
    >,
  ) => {
    const values = field.values?.map((a) => a.value);
    if (
      field.type === "enum" &&
      (!values?.length ||
        new Set(values).size !== values.length ||
        values.some((v) => !v.trim()))
    )
      fail(
        "MESH_ENUM_VALUES",
        "An enum requires non-empty, distinct values",
        field.position,
      );
    if (
      field.min !== undefined &&
      field.max !== undefined &&
      field.min > field.max
    )
      fail("MESH_ATTRIBUTE_RULE", "min cannot exceed max", field.position);
    if (
      field.type === "string" &&
      [field.min, field.max].some(
        (v) => v !== undefined && (!Number.isInteger(v) || v < 0),
      )
    )
      fail(
        "MESH_ATTRIBUTE_RULE",
        "String bounds must be non-negative integers",
        field.position,
      );
    if (field.match) {
      try {
        new RegExp(field.match.pattern, field.match.flags);
      } catch {
        fail(
          "MESH_ATTRIBUTE_RULE",
          "Invalid regular expression",
          field.position,
        );
      }
    }
    const def = field.default;
    if (def !== undefined) {
      let valid = literalFits(def, field);
      if (
        valid &&
        (typeof def === "number" ||
          (typeof def === "string" && field.type === "string"))
      ) {
        const amount = typeof def === "string" ? def.length : def;
        valid =
          (field.min === undefined || amount >= field.min) &&
          (field.max === undefined || amount <= field.max);
      }
      if (!valid)
        fail(
          "MESH_DEFAULT",
          "default must fit the declared type and rules",
          field.position,
        );
    }
  };
  return { at, pos, fail, opt, shape, checkShape };
}

function buildEntity(
  root: Tag,
  irImports: readonly IrImport[],
  source: string,
  file: string,
  diagnostics: Diagnostic[],
  rollups: PendingRollup[],
  importDetails: Map<Import, ParsedImport>,
  inversePositions: Map<Relationship, SourcePosition>,
  throughPositions: Map<Relationship, SourcePosition>,
  folder: string,
  declaredFile: (from: string) => DeclaredFile | undefined,
): Entity {
  const { at, pos, fail, opt, shape, checkShape } = attributeReaders(source, file, diagnostics);
  const sections = tags(root.children);
  const section = (name: string) => sections.find((t) => t.name === name);
  // The name is written in any casing and converted as an event's or a command's is (`notes/spec/names.md`): `entity :todo`
  // is `Todo` and `entity :invoice_line` is `InvoiceLine`. The converted name is the entity's name from here on: its FQN, its
  // default table, what another file imports and what this file names its own entity by. The written name is kept nowhere.
  const written = declaredName(root);
  const converted = classNameOf(written);
  const entity: Entity = {
    name: converted,
    fqn: converted,
    table: String(opt(root, "table") ?? snakeCase(converted)),
    file,
    module: "",
    imports: [],
    attributes: [],
    relationships: [],
    computed: [],
    actions: [],
    auto: [],
    always: [],
    policies: [],
    position: pos(root),
  };
  // Casing is never an error: only a name that converts to no identifier is (`_1` is `1`, `__` is nothing).
  if (!isClassName(converted))
    fail("MESH_ENTITY_NAME", `Entity :${written} converts to ${converted ? `\`${converted}\`` : "nothing"}, which is no class name: Mesh drops each \`_\` and capitalises the letter after it, so the name needs a letter${converted ? " before any digit" : ""}, such as :Todo`, root);
  const { module, bareUnderscore } = moduleOfFolder(folder);
  entity.module = module;
  entity.fqn = [...module.split("/").filter(Boolean), entity.name].join(".");
  if (bareUnderscore)
    fail("MESH_GROUP_NAME", `Group folder "_" has no name; write "_" followed by a name, such as "_services"`, root);
  for (const segment of module ? module.split("/") : []) {
    if (!/^[A-Za-z0-9_-]+$/.test(segment))
      fail("MESH_MODULE_NAME", `Module segment ${JSON.stringify(segment)} must contain only letters, digits, - or _`, root);
  }
  const imports = readImports(irImports);
  for (const problem of imports.problems)
    fail(problem.code, problem.message, at(problem.offset), problem.fix);
  entity.imports = imports.imports.map(
    (i): Import => {
      const renames = !i.namespace && i.bindings.some((binding) => binding.imported !== binding.local);
      const value: Import = {
        identifiers: i.names,
        ...(renames ? { imported: i.bindings.map((binding) => binding.imported) } : {}),
        from: i.from,
        ...(i.from === MESHFW ? { mesh: true as const } : hasMeshExtension(i.from) ? {} : { helper: true as const }),
        ...(i.namespace ? { namespace: true as const } : {}),
        position: at(i.offset),
      };
      importDetails.set(value, i);
      return value;
    },
  );
  // Each name to the import that binds it. A name bound twice is `MESH_DUPLICATE_IMPORT` at the second binding, which binds
  // nothing: no name set below holds it, and a reference through the name reports nothing more (`duplicates`).
  const importNames = new Map<string, Import>();
  const duplicates = new Set<string>();
  const bindings: { entry: Import; index: number; name: string }[] = [];
  for (const entry of entity.imports)
    for (const [index, name] of entry.identifiers.entries()) {
      if (importNames.has(name)) {
        const localOffset = importDetails.get(entry)?.bindings[index]?.localOffset;
        fail(
          "MESH_DUPLICATE_IMPORT",
          `Duplicate import identifier ${name}`,
          localOffset === undefined ? entry.position : at(localOffset),
        );
        duplicates.add(name);
        continue;
      }
      importNames.set(name, entry);
      bindings.push({ entry, index, name });
    }
  const pending: {
    ref: MemberRef;
    scope: "input" | "sort" | "load" | "set" | "actions" | "expression" | "filter" | "check";
  }[] = [];
  const checkRef = (
    ref: MemberRef,
    scope: (typeof pending)[number]["scope"],
  ) => {
    pending.push({ ref, scope });
    return ref;
  };
  const helperImports = new Map<string, string>();
  const meshImports = new Set<string>();
  for (const { entry, index, name } of bindings) {
    const helper = entry.helper === true;
    if (helper) helperImports.set(name, entry.from);
    if (entry.mesh) meshImports.add(name);
    // An import named like a scope root (`input`) is not refused, `Mesh`'s included: inside a function the name is the
    // root, as a parameter shadows an import in JavaScript, so there the import is simply not reachable under it.
    // Generated code names its own internals `$...` (an entity's locals `$work$Task$value`) and prints every authored
    // local as `l$...`: no name an import binds, a helper's or an entity's alias, may start with either.
    if (/^(\$|l\$)/.test(name)) {
      const localOffset = importDetails.get(entry)?.bindings[index]?.localOffset;
      fail(
        "MESH_HELPER_NAME",
        `The ${helper ? "helper" : entry.mesh ? "Mesh import" : "entity import"} name ${name} cannot start with $ or l$: generated code uses those prefixes for its own names`,
        localOffset === undefined ? entry.position : at(localOffset),
      );
    }
  }
  // What a reference to another file's declaration resolves against: `entity=List`, `entity=billing.Invoice`.
  const declared = (from: string) => declaredFile(from)?.names;
  const references: ReferenceScope = { imports: importNames, duplicates, own: { name: entity.name, from: `./${basename(file)}` }, declared };
  const entityKind = referenceKind("entity", declaredFile);
  // An event is never the file's own declaration (the file declares an entity), so only an import names one.
  const eventReferences: ReferenceScope = { imports: importNames, duplicates, declared };
  const eventKind = referenceKind("event", declaredFile);
  // `on=PayInvoice` or `on=billing.PayInvoice`: a command is never the file's own declaration either.
  const commandKind = referenceKind("command", declaredFile);
  // The kind of file each import binds: an entity's, an event's or a command's (an import no file of the project answers is an entity's, and reported).
  const importedKind = (entry: Import): DeclaredFile["kind"] | undefined => (entry.helper || entry.mesh ? undefined : declaredFile(entry.from)?.kind ?? "entity");
  const boundTo = (kind: DeclaredFile["kind"]) => bindings.filter(({ entry }) => importedKind(entry) === kind).map(({ name }) => name);
  // The entities a function in this file can name: its own and each one it imports, by the name the file gives it.
  const entities = new Set([entity.name, ...boundTo("entity")]);
  // The events and commands it can name: each one it imports (an event file's name is never an entity's), by the name the file gives it.
  const events = new Set(boundTo("event"));
  const commands = new Set(boundTo("command"));
  // Each namespace import's alias: a function reads `billing.Invoice` as it reads an imported `Invoice`, and calls
  // `h.isStaff(...)` as it calls an imported `isStaff(...)`.
  const namespaces = new Set(bindings.filter(({ entry }) => entry.namespace).map(({ name }) => name));
  // `Mesh` under the entity's own name would give one name two meanings in a function of the file.
  for (const entry of entity.imports)
    if (entry.mesh && entry.identifiers.includes(entity.name))
      fail("MESH_DUPLICATE_IMPORT", `Duplicate import identifier ${entity.name}: the entity is named ${entity.name} too`, entry.position);
  const expr = (a: Attr | undefined, scope: "expression" | "filter" = "expression", step?: "run" | "publish"): Expression =>
    expression(
      a,
      source,
      at,
      (ref) => checkRef(ref, scope),
      ({ ref, position }) =>
        fail(
          "MESH_MEMBER_ASSIGN",
          `\`&${ref.name}\` cannot be assigned inside an expression; use a \`set\` line`,
          position,
        ),
      {
        helpers: helperImports,
        imported: new Set(importNames.keys()),
        entities,
        namespaces,
        reference: (written) => resolveReference(written, references, entityKind),
        events,
        commands,
        eventReference: (written) => resolveReference(written, eventReferences, eventKind),
        duplicates,
        mesh: meshImports,
        report: (d) => {
          if (!diagnostics.some((x) => x.code === d.code && x.position.file === d.position.file && x.position.offset === d.position.offset)) diagnostics.push(d);
        },
        ...(step === "run" ? { runStep: true } : step === "publish" ? { publishStep: true } : {}),
      },
    );
  const authoredMember = (line: Tag) =>
    fail(
      "MESH_SYNTAX",
      "`<member>` is not a known tag: write a member line as `&name`",
      line,
    );
  for (const tag of tags(section("attributes")?.children ?? [])) {
    const on = attr(tag, "on");
    const field: Attribute = {
      ...shape(tag),
      primaryKey: opt(tag, "primary-key") === true,
      unique: opt(tag, "unique") === true,
      ...(atomOf(on) ? { on: atomOf(on)!.name as "create" | "update" } : {}),
    };
    if (attr(tag, "value"))
      fail(
        "MESH_ATTRIBUTE_RULE",
        "A stored attribute cannot have a function body",
        tag,
      );
    if (field.primaryKey && field.nullable)
      fail("MESH_PRIMARY_KEY", "A primary key cannot be nullable", tag);
    checkShape(field);
    entity.attributes.push(field);
  }
  for (const tag of tags(section("relationships")?.children ?? [])) {
    // `entity=List` or `entity=billing.Invoice`; an entity relates to its own type by its own name, with no import.
    const written = writtenReference(nodeOf(attr(tag, "entity")));
    const target = written ? resolveReference(written, references, entityKind) : undefined;
    if (target && !target.ok && "code" in target) fail(target.code, target.message, at(target.offset), target.fix);
    const name = declaredName(tag);
    const kind = tag.name as Relationship["kind"];
    const inverse = atomOf(attr(tag, "inverse"))?.name;
    // `through=Link` (has-many only): the link entity, resolved as `entity=` is and reported the same way.
    const throughAttr = kind === "has-many" ? attr(tag, "through") : undefined;
    const writtenLink = throughAttr ? writtenReference(nodeOf(throughAttr)) : undefined;
    const link = writtenLink ? resolveReference(writtenLink, references, entityKind) : undefined;
    if (link && !link.ok && "code" in link) fail(link.code, link.message, at(link.offset), link.fix);
    const relation: Relationship = {
      kind,
      name,
      entity: { identifier: written ? referenceText(written) : "", from: target?.ok ? target.from : "" },
      nullable: opt(tag, "nullable") === true,
      ...(kind === "belongs-to" ? { keyColumn: `${name}Id` } : {}),
      ...(inverse !== undefined ? { inverse } : {}),
      ...(writtenLink ? { through: { entity: { identifier: referenceText(writtenLink), from: link?.ok ? link.from : "" } } } : {}),
      position: pos(tag),
    };
    entity.relationships.push(relation);
    if (inverse !== undefined) inversePositions.set(relation, at(attrOffset(attr(tag, "inverse")!)));
    if (writtenLink) throughPositions.set(relation, at(attrOffset(throughAttr!)));
  }
  for (const tag of tags(section("computed")?.children ?? [])) {
    const base = { name: declaredName(tag), position: pos(tag) };
    if (["count", "sum", "avg", "min", "max"].includes(tag.name)) {
      const segments = readMemberPath(attr(tag, "of"), at);
      const of = segments.map((s) => s.name).join(".");
      const computed: Computed = {
        ...base,
        type: "integer",
        nullable: false,
        rollup: { fn: tag.name as Rollup["fn"], of },
      };
      entity.computed.push(computed);
      rollups.push({ entity, computed, segments });
    } else {
      const allowed = tag.name === "enum" ? ["name", "value", "values"] : ["name", "value"];
      if (tag.attrs.some((a) => a.kind !== "spread" && !allowed.includes(a.name)))
        fail(
          "MESH_COMPUTED_OPTIONS",
          tag.name === "enum"
            ? "A computed enum takes only its name, its values and its body"
            : "A computed function takes only its name and body",
          tag,
        );
      const body = readAt(tag, at, () => expr(attr(tag, "value")));
      if (body.diagnostic) diagnostics.push(body.diagnostic);
      else {
        const field: Computed = { ...base, type: tag.name as AttributeType, body: body.value };
        const values = attr(tag, "values");
        if (tag.name === "enum") {
          // The values are optional on a computed enum: without them its TypeScript type is `string`.
          if (values) {
            field.values = atomList(values).map((value) => ({ value }));
            checkShape({ type: "enum", nullable: false, values: field.values, position: base.position });
          }
        }
        entity.computed.push(field);
      }
    }
  }
  /** A check's `message=`: fixed text, or a function of the arguments `that` gets. Anything else is refused. */
  const message = (tag: Tag): string | Expression => {
    const a = attr(tag, "message");
    const text = textOf(a);
    if (text !== undefined) return text;
    if (nodeOf(a)?.type === "ArrowFunctionExpression" || nodeOf(a)?.type === "FunctionExpression") return expr(a);
    throw new Error("A check's `message=` is text (`message=\"the order is empty\"`) or a function (`message=({ self }) => ...`)");
  };
  /**
   * `publish` is no `validate` line and no part of a `check`: it raises an event after the row is written, and a check only
   * decides (`MESH_PUBLISH`). The contract admits it there so that the build can say so; it builds nothing.
   */
  const refusePublish = (tag: Tag, where: string) =>
    fail("MESH_PUBLISH", `a \`publish\` step is not allowed ${where}: it raises an event after the action's row is written, in the action's \`do\``, tag, "move it under `do`");
  /** Where an option is written: its name (`when` of `when=...`). */
  const optionAt = (a: Attr) => at("nameSpan" in a && a.nameSpan ? a.nameSpan.sourceStart : attrOffset(a));
  /**
   * One declared check, inline in a `validate` or under `checks`: its functions are built here, once. The contract
   * requires nothing of a `check` line, since a reference (`check &name`) takes none of a declaration's options, so the
   * form rules are here, reported line by line: a line that declares and refers, and a declaration missing an option
   * (the first missing, with MX's text for a required option). Such a line declares no check.
   */
  const declaredCheck = (tag: Tag): Check | undefined => {
    const reference = attr(tag, "member");
    if (reference) {
      fail("MESH_MEMBER_REFERENCE", "`check`: a line declares a check (`check :name` with its options) or uses one (`check &name` alone), not both", optionAt(reference));
      return undefined;
    }
    const missing = ["name", "that", "code", "message"].find((key) => !attr(tag, key));
    if (missing) {
      fail("MESH_MISSING_OPTION", `\`check\`: missing required option \`${missing}\``, tag);
      return undefined;
    }
    for (const inner of tags(tag.children)) if (inner.name === "publish") refusePublish(inner, "in a `check`");
    return { label: declaredName(tag), that: expr(attr(tag, "that")), code: String(opt(tag, "code")), message: message(tag), ...(attr(tag, "when") ? { when: expr(attr(tag, "when")) } : {}), ...(attr(tag, "details") ? { details: expr(attr(tag, "details")) } : {}), position: pos(tag) };
  };
  // The checks the `checks` section declares, by name (the first of a name; a second is a duplicate member, below), and
  // every check name that counts as a member of the entity, named or inline, with where it is written.
  const namedChecks = new Map<string, Check>();
  const checkMembers: { name: string; position: SourcePosition }[] = [];
  /** The names of declarations under `checks` that a form rule refused: a reference to one is no second error. */
  const brokenChecks = new Set<string>();
  /** The members of `checkMembers` declared under `checks`, not inline in a `validate`. */
  const sectionChecks = new Set<unknown>();
  for (const tag of tags(section("checks")?.children ?? [])) {
    const reference = attr(tag, "member");
    if (reference) {
      fail("MESH_MEMBER_REFERENCE", "`checks` declares checks: a line under it is `check :name` with its options, and `check &name` is how a `validate` block uses one", optionAt(reference));
      continue;
    }
    const check = declaredCheck(tag);
    if (!check) {
      if (attr(tag, "name")) brokenChecks.add(declaredName(tag));
      continue;
    }
    const member = { name: check.label, position: check.position };
    checkMembers.push(member);
    sectionChecks.add(member);
    if (!namedChecks.has(check.label)) namedChecks.set(check.label, check);
  }
  /** The named checks some `validate` refers to, a refused reference included: one no block uses never runs. */
  const usedChecks = new Set<string>();
  /** A named check as one `validate` block uses it: its own expression objects, so the model pass types it in that block's scope. */
  const usedCheck = (declared: Check, reference: SourcePosition): Check => ({
    ...declared,
    that: copyExpression(declared.that),
    message: typeof declared.message === "string" ? declared.message : copyExpression(declared.message),
    ...(declared.when ? { when: copyExpression(declared.when) } : {}),
    ...(declared.details ? { details: copyExpression(declared.details) } : {}),
    reference,
  });
  /**
   * One `check` line of a `validate` block, at its top or under a `when` in it: an inline declaration, or a named check the
   * block uses by reference. `listed` is the block's, one map for the whole nesting, so a reference listed twice anywhere
   * in one `validate` is a duplicate (ruling D27, point 5).
   */
  const checkOf = (tag: Tag, listed: Map<string, "inline" | "reference">): Check[] => {
    const reference = attr(tag, "member");
    if (reference && !attr(tag, "name")) {
      const ref = readMember(reference, at);
      usedChecks.add(ref.name);
      const option = tag.attrs.find((a) => a.kind === "spread" || a.name !== "member");
      if (option) {
        fail("MESH_UNKNOWN_OPTION", `\`check\`: a reference to a check takes no option: remove \`${option.kind === "spread" ? "..." : option.name}\`, or change the check where \`checks\` declares it`, optionAt(option));
        return [];
      }
      const child = tags(tag.children)[0];
      if (child) {
        fail("MESH_TAG_NOT_ALLOWED", `\`check\`: a reference to a check takes no line under it: remove \`${child.name}\``, child);
        return [];
      }
      checkRef(ref, "check");
      const declared = namedChecks.get(ref.name);
      if (!declared) return [];
      const before = listed.get(ref.name);
      if (before === "reference") {
        fail("MESH_DUPLICATE_MEMBER", `Duplicate check &${ref.name}: this \`validate\` already lists it, and a check runs once`, ref.position);
        return [];
      }
      // An inline check of the block took the name: the member list reports the pair once, at the later line.
      if (before === "inline") return [];
      listed.set(ref.name, "reference");
      return [usedCheck(declared, ref.position)];
    }
    // An inline check's name is a member of the entity, counted once however many blocks write it (SYN-08): the member
    // list reports a repeat, here or in another block, and a name another member has.
    const check = declaredCheck(tag);
    if (!check) return [];
    checkMembers.push({ name: check.label, position: check.position });
    listed.set(check.label, "inline");
    return [check];
  };
  /** The lines under a `validate`, or under a `when` inside one, in order: checks, and `when` lines with theirs. */
  const validateLines = (holder: Tag, listed: Map<string, "inline" | "reference">): ValidateItem[] =>
    tags(holder.children).flatMap((tag): ValidateItem[] => {
      if (tag.name === "publish") { refusePublish(tag, "in `validate`"); return []; }
      if (tag.name === "when")
        return [{ kind: "when", condition: expr(attr(tag, "value")), lines: validateLines(tag, listed), position: pos(tag) }];
      if (tag.name === "check") return checkOf(tag, listed);
      // The `when` contract serves a step and a `when` in `validate` alike, so MX admits a step here; directly under
      // `validate` it admits only `check`, `when` and `publish`.
      fail("MESH_TAG_NOT_ALLOWED", `\`when\` in \`validate\`: \`${tag.name}\` is not allowed here; allowed children: \`check\`, \`when\``, tag);
      return [];
    });
  /** The lines of an action's or an `always` block's `validate`. */
  const checks = (holder: Tag): ValidateItem[] => {
    const block = tags(holder.children).find((t) => t.name === "validate");
    return block ? validateLines(block, new Map()) : [];
  };
  /** The steps under a `do` or a `when`. */
  const steps = (holder: Tag): Step[] => tags(holder.children).flatMap((tag) => buildStep(tag) ?? []);
  const buildStep = (tag: Tag): Step | undefined => {
      const position = pos(tag);
      const assigned = new Set<string>();
      if (tag.name === "set")
        return {
          kind: "set",
          assignments: tags(tag.children).flatMap((line) => {
            if (!isMemberLine(line)) { authoredMember(line); return []; }
            const read = readAt(line, at, () => readMemberLine(line, at));
            if (read.diagnostic) { diagnostics.push(read.diagnostic); return []; }
            const member = read.value;
            checkRef(member.ref, "set");
            if (assigned.has(member.ref.name))
              fail("MESH_DUPLICATE_SET", `\`&${member.ref.name}\` is set twice in this action`, line);
            assigned.add(member.ref.name);
            if (!member.value) {
              fail("MESH_MEMBER_LINE_OPTIONS", `\`&${member.ref.name}\` under \`set\` needs a value: \`&${member.ref.name}=…\``, line);
              return [];
            }
            const value = readAt(line, at, () => {
              const n = nodeOf(member.value);
              if (n && ["ArrowFunctionExpression", "FunctionExpression"].includes(n.type)) return expr(member.value);
              let literal: ReturnType<typeof valueOf>;
              try { literal = valueOf(member.value); }
              catch { throw new Error(`\`&${member.ref.name}=\` needs a literal value here`); }
              const field = entity.attributes.find((attribute) => attribute.name === member.ref.name);
              if (field?.type === "json" && containsAtom(member.value))
                fail("MESH_SET_VALUE", `\`&${member.ref.name}=\` is json, and an atom is not JSON: write a string`, member.ref.position);
              if (field && (!literalFits(literal, field) || (n?.type === "ObjectExpression" && field.type !== "json")))
                fail("MESH_SET_VALUE", `\`&${member.ref.name}=\` needs a literal that fits ${field.type}${field.type === "enum" ? ` (${field.values?.map((atom) => `:${atom.value}`).join(", ")})` : ""}`, member.ref.position);
              // A belongs-to stores its target's key: a literal is that key (or null on a nullable one). Its type is checked at the call, by the key column.
              const relation = field ? undefined : entity.relationships.find((r) => r.name === member.ref.name);
              if (relation && (literal === null ? !relation.nullable : typeof literal !== "string" && typeof literal !== "number"))
                fail("MESH_SET_VALUE", `\`&${member.ref.name}=\` stores the key of :${relation.entity.identifier}: write its id${relation.nullable ? ", null" : ""} or a function`, member.ref.position);
              return literal;
            });
            if (value.diagnostic) { diagnostics.push(value.diagnostic); return []; }
            return [{ member: member.ref, value: value.value }];
          }),
          position,
        };
      if (tag.name === "when")
        return {
          kind: "when",
          condition: expr(attr(tag, "value")),
          steps: steps(tag),
          position,
        };
      if (tag.name === "load")
        return {
          kind: "load",
          members: readMembers(attr(tag, "value"), at).map((ref) =>
            checkRef(ref, "load"),
          ),
          position,
        };
      if (tag.name === "run") {
        // The contract admits `:write` only (ADR-0068 decision 2); MX reports any other value at the attribute.
        const after = atomOf(attr(tag, "after"))?.name === "write";
        return { kind: "run", fn: expr(attr(tag, "value"), "expression", "run"), ...(after ? { after: "write" as const } : {}), position };
      }
      // A read has no `do` (its contract leaves it out), so no publish is written in one. The fourth case of `MESH_PUBLISH`,
      // an event that owners list and the action's owner does not, is vacuous until owner sections exist (aggregates).
      if (tag.name === "publish")
        return { kind: "publish", fn: expr(attr(tag, "value"), "expression", "publish"), position };
      // The `when` contract serves a step and a `when` in `validate` alike, so MX admits a `check` under a step `when`
      // (`do` itself does not take one).
      if (tag.name === "check") {
        fail("MESH_TAG_NOT_ALLOWED", "`when` in `do`: `check` is not allowed here; allowed children: `set`, `when`, `load`, `run`, `publish`", tag);
        return undefined;
      }
      throw new Error(`Unexpected step ${tag.name}`);
  };
  const body = (holder: Tag) => {
    const block = tags(holder.children).find((t) => t.name === "do");
    return { validate: checks(holder), do: block ? steps(block) : [] };
  };
  const types = (a: Attr) =>
    atomList(a).map((value): ActionType => {
      if (!isActionKind(value)) throw new Error(`Unknown action type ${value}`);
      return value;
    });
  const scope = (tag: Tag) => ({
    ...(attr(tag, "types") ? { types: types(attr(tag, "types")!) } : {}),
    ...(attr(tag, "actions")
      ? {
          actions: readMembers(attr(tag, "actions"), at).map((ref) =>
            checkRef(ref, "actions"),
          ),
        }
      : {}),
  });
  const actionSection = section("actions");
  // The actions whose name the author wrote, as against one named after its command.
  const authorNamed = new Set<Action>();
  if (actionSection) {
    const auto = attr(actionSection, "auto");
    if (auto) entity.auto = types(auto);
    if (new Set(entity.auto).size !== entity.auto.length)
      fail(
        "MESH_DUPLICATE_MEMBER",
        "auto contains a duplicate action type",
        actionSection,
      );
    const onLoad = attr(actionSection, "on:load");
    if (onLoad) entity.onLoad = checkRef(readMember(onLoad, at), "actions");
    for (const tag of tags(actionSection.children)) {
      if (tag.name === "always") {
        entity.always.push({
          ...scope(tag),
          ...body(tag),
          position: pos(tag),
        } satisfies Always);
        continue;
      }
      const kind = tag.name as ActionType;
      // `on=` answers a command and, with no name written, names the action: the command's class name with its first letter
      // in lower case, whatever name this file binds (`notes/spec/events-and-commands.md`, "Answering a command").
      const onAttr = attr(tag, "on");
      const written = onAttr ? writtenReference(nodeOf(onAttr)) : undefined;
      const answered = written ? resolveReference(written, eventReferences, commandKind) : undefined;
      if (answered && !answered.ok && "code" in answered) fail(answered.code, answered.message, at(answered.offset), answered.fix);
      const commandFile = answered?.ok ? declaredFile(answered.from) : undefined;
      const commandClass = commandFile?.names[0];
      const writtenName = attr(tag, "name") ? declaredName(tag) : undefined;
      // A name and no `on=` is the one case a contract leaves nothing to say about; with neither, `MESH_NAME` has been reported.
      const actionName = writtenName ?? (commandClass ? commandClass.charAt(0).toLowerCase() + commandClass.slice(1) : written ? written.name.charAt(0).toLowerCase() + written.name.slice(1) : undefined);
      if (actionName === undefined) continue;
      const command: Action["command"] = written && onAttr
        ? { identifier: referenceText(written), from: answered?.ok ? answered.from : "", fqn: "", position: at(attrOffset(onAttr)) }
        : undefined;
      const input: InputField[] = [];
      const names = new Set<string>();
      for (const line of tags(
        tags(tag.children).find((t) => t.name === "input")?.children ?? [],
      )) {
        let field: InputField;
        if (line.name === "member") {
          if (!isMemberLine(line)) { authoredMember(line); continue; }
          const read = readAt(line, at, () => readMemberLine(line, at));
          if (read.diagnostic) { diagnostics.push(read.diagnostic); continue; }
          const member = read.value;
          if (kind === "read")
            fail(
              "MESH_READ_INPUT_MEMBER",
              "A read input may declare arguments only",
              line,
            );
          field = { kind: "member", ref: checkRef(member.ref, "input") };
        } else {
          if (
            ["primary-key", "unique", "on", "value"].some((key) =>
              attr(line, key),
            )
          )
            fail(
              "MESH_ARGUMENT_OPTIONS",
              "An argument cannot declare primary-key, unique, on, or a body",
              line,
            );
          field = { kind: "argument", ...shape(line) } satisfies Argument;
          checkShape(field);
        }
        const name = field.kind === "member" ? field.ref.name : field.name;
        if (names.has(name))
          fail("MESH_DUPLICATE_INPUT", `Duplicate input name ${name}`, line);
        names.add(name);
        input.push(field);
      }
      const filterTag = tags(tag.children).find((t) => t.name === "filter");
      const filter =
        attr(tag, "filter") ?? (filterTag && attr(filterTag, "value"));
      if (attr(tag, "filter") && filterTag)
        fail("MESH_DUPLICATE_MEMBER", "A read has only one filter", filterTag);
      const sort = tags(tag.children).find((t) => t.name === "sort");
      const action: Action = {
        kind,
        name: actionName,
        ...(command ? { command } : {}),
        input,
        ...body(tag),
        ...(filter ? { filter: expr(filter, "filter") } : {}),
        ...(sort
          ? {
              sort: tags(sort.children).map((t) => ({
                direction: t.name as "asc" | "desc",
                member: checkRef(readMember(attr(t, "member"), at), "sort"),
              })),
            }
          : {}),
        position: pos(tag),
      };
      entity.actions.push(action);
      if (writtenName !== undefined) authorNamed.add(action);
    }
  }
  for (const tag of tags(section("policies")?.children ?? [])) {
    const expressions = (key: string) => [
      ...(attr(tag, key) ? [expr(attr(tag, key))] : []),
      ...tags(tag.children)
        .filter((t) => t.name === key)
        .map((t) => expr(attr(t, "value"))),
    ];
    entity.policies.push({
      name: declaredName(tag),
      ...scope(tag),
      authorizeIf: expressions("authorize-if"),
      forbidIf: expressions("forbid-if"),
      ...(attr(tag, "when") ? { when: expr(attr(tag, "when")) } : {}),
      position: pos(tag),
    } satisfies Policy);
  }
  const members = [
    ...entity.attributes,
    ...entity.relationships,
    ...entity.computed,
    ...entity.actions,
    ...entity.auto.map((name) => ({
      name,
      position: actionSection ? pos(actionSection) : entity.position,
    })),
    ...entity.policies,
    ...checkMembers.sort((a, b) => a.position.offset - b.position.offset),
  ];
  for (const [name, check] of namedChecks)
    if (!usedChecks.has(name))
      diagnostics.push({ severity: "warning", code: "MESH_CHECK_UNUSED", message: `check :${name} is declared and no \`validate\` uses it, so it never runs`, position: check.position, fix: `list it in the \`validate\` of each action it is a rule of: \`check &${name}\`` });
  const names = new Set<string>();
  // The action each name belongs to, for a name taken from a command: the message names the command (`notes/spec/events-and-commands.md`, "Answering a command").
  const holders = new Map<string, (typeof members)[number]>();
  const fromCommand = (member: unknown): Action | undefined => {
    const action = entity.actions.find((candidate) => candidate === member);
    return action?.command && !authorNamed.has(action) ? action : undefined;
  };
  const isCheck = (member: unknown) => checkMembers.includes(member as (typeof checkMembers)[number]);
  for (const member of members) {
    if (names.has(member.name)) {
      const taken = fromCommand(member) ?? fromCommand(holders.get(member.name));
      // Checks come last in the list, so a repeat that involves a check is reported at the check (the later one of two).
      const fix = !isCheck(member) ? undefined
        : sectionChecks.has(member) && sectionChecks.has(holders.get(member.name)) ? "give each rule its own name, or remove one"
        : isCheck(holders.get(member.name)) ? `declare the check once under \`checks\` and use it with \`check &${member.name}\` in each \`validate\`, or give each rule its own name`
        : "rename the check";
      fail(
        "MESH_DUPLICATE_MEMBER",
        taken === undefined
          ? `Duplicate member :${member.name}`
          : `Duplicate member :${member.name}: the ${taken.kind} that answers ${taken.command!.identifier} takes its name from the command; write a name for it (\`${taken.kind} :name on=${taken.command!.identifier}\`) or rename the other member`,
        member.position,
        fix,
      );
    }
    if (!holders.has(member.name)) holders.set(member.name, member);
    if (member.name === PROTOTYPE_SETTING_NAME)
      fail(
        "MESH_ATTRIBUTE_NAME",
        `:${member.name} cannot be a member name: __proto__ sets an object's prototype instead of adding a property. Choose another name.`,
        member.position,
      );
    names.add(member.name);
  }
  if (entity.attributes.filter((a) => a.primaryKey).length !== 1)
    fail(
      "MESH_PRIMARY_KEY",
      "An entity must declare exactly one primary key",
      root,
    );
  for (const { ref, scope } of pending) {
    const inputAttribute = scope === "input" ? entity.attributes.find((field) => field.name === ref.name) : undefined;
    if (inputAttribute && (inputAttribute.primaryKey || inputAttribute.on))
      fail("MESH_INPUT_MANAGED", `&${ref.name} is set by Mesh and cannot be an input`, ref.position);
    if (scope === "check") {
      // `check &name` uses a check of the entity's `checks` section, and nothing else: not an inline check, not another member.
      if (!namedChecks.has(ref.name) && !brokenChecks.has(ref.name)) {
        const candidates = new Set(namedChecks.keys());
        const member = unknownMember(entity, ref, candidates);
        const names = [...candidates].map((name) => `&${name}`).join(", ");
        diagnostics.push({ ...member,
          message: `&${ref.name} is not a check of ${entity.fqn}: \`check &name\` uses a check the entity's \`checks\` section declares${names ? ` (${names})` : ", and it declares none"}.${member.message.includes("Did you mean") ? member.message.slice(member.message.indexOf(" Did you mean")) : ""}` });
      }
      continue;
    }
    const allowed =
      scope === "actions"
        ? [...entity.actions, ...entity.auto.map((name) => ({ name }))]
        : scope === "input"
          ? [
              ...entity.attributes,
              ...entity.relationships.filter((r) => r.kind === "belongs-to"),
            ]
          : scope === "set"
            ? [...entity.attributes, ...entity.relationships.filter((r) => r.kind === "belongs-to")]
            : scope === "load"
              ? [...entity.relationships, ...entity.computed]
              : scope === "sort"
                ? [...entity.attributes, ...entity.computed]
                : [
                    ...entity.attributes,
                    ...entity.relationships,
                    ...entity.computed,
                  ];
    const candidates = new Set(allowed.map((m) => m.name));
    if (!candidates.has(ref.name) && scope === "actions") {
      // `actions=[...]` on a policy or an `always` block names actions (roadmap M8, acceptance test 8).
      const member = unknownMember(entity, ref, candidates);
      const names = [...candidates].map((name) => `&${name}`).join(", ");
      diagnostics.push({ ...member, code: "MESH_UNKNOWN_ACTION",
        message: `&${ref.name} is not an action of ${entity.fqn}: \`actions=\` names the entity's own actions${names ? ` (${names})` : ", and it has none"}.${member.message.includes("Did you mean") ? member.message.slice(member.message.indexOf(" Did you mean")) : ""}` });
    } else if (!candidates.has(ref.name))
      diagnostics.push(unknownMember(entity, ref, candidates));
    else if (scope === "sort" || scope === "filter") {
      const used = [...entity.attributes, ...entity.computed].find((m) => m.name === ref.name);
      if (used && !attributeTypeInfo(used.type).queryable)
        fail(scope === "sort" ? "MESH_SORT_TYPE" : "MESH_FILTER_TYPE",
          `&${ref.name} is :${used.type}, which a ${scope} cannot use: the database does not look inside it`, ref.position);
    }
  }
  if (
    entity.onLoad &&
    entity.actions.find((a) => a.name === entity.onLoad!.name)?.kind !==
      "read" &&
    !(entity.onLoad.name === "read" && entity.auto.includes("read"))
  )
    fail(
      "MESH_ON_LOAD",
      "on:load must name a read action",
      entity.onLoad.position,
    );
  for (const relation of entity.relationships)
    if (relation.keyColumn && names.has(relation.keyColumn)) {
      // A check named like the key column is the check's mistake: it is reported there.
      const holder = holders.get(relation.keyColumn);
      fail(
        "MESH_DUPLICATE_MEMBER",
        `Generated key column ${relation.keyColumn} conflicts with a declared member`,
        isCheck(holder) ? holder!.position : relation.position,
        isCheck(holder) ? "rename the check" : undefined,
      );
    }
  return entity;
}

/**
 * An event or a command: a file of its own whose root line declares it and whose children are field lines
 * (`notes/spec/events-and-commands.md`, "Events" and "Commands"). A field line is an attribute line with the options that
 * constrain a value only: `nullable`, `values`, `min`, `max` and `match`, plus `optional` for commands. What concerns storage or creation, `default`,
 * `unique`, `primary-key` and `on`, is `MESH_UNKNOWN_OPTION`, since the declaration is a message that carries what its
 * sender put in it, with no row behind it (and `value`, a computed field's body, is no option of one either). A contract
 * is per tag and the field kinds are the attribute types, so the contract cannot tell a field from an attribute, and the
 * builder reports it. An event file takes no import: its field kinds are attribute types.
 */
const FIELD_OPTIONS_REFUSED = ["default", "unique", "primary-key", "on", "value"] as const;
function buildDeclaration(
  root: Tag,
  irImports: readonly IrImport[],
  source: string,
  file: string,
  diagnostics: Diagnostic[],
  folder: string,
): EventDeclaration | CommandDeclaration {
  const { at, pos, fail, opt, shape, checkShape } = attributeReaders(source, file, diagnostics);
  const name = declaredName(root);
  const { module, bareUnderscore } = moduleOfFolder(folder);
  // The name is PascalCase or is made so (`event :invoicePaid` is the class `InvoicePaid`): no warning about the spelling.
  // `invoice_paid` is the class `InvoicePaid` (`notes/spec/names.md`); a name that makes no identifier (`_1`) is an error.
  if (!isClassName(classNameOf(name)))
    fail("MESH_NAME", `${root.name === "event" ? "Event" : "Command"} :${name} makes no class name: Mesh drops each \`_\` and capitalises the letter after it, so the name needs a letter, such as :${root.name === "event" ? "InvoicePaid" : "PayInvoice"}`, root);
  if (bareUnderscore)
    fail("MESH_GROUP_NAME", `Group folder "_" has no name; write "_" followed by a name, such as "_services"`, root);
  for (const segment of module ? module.split("/") : []) {
    if (!/^[A-Za-z0-9_-]+$/.test(segment))
      fail("MESH_MODULE_NAME", `Module segment ${JSON.stringify(segment)} must contain only letters, digits, - or _`, root);
  }
  for (const entry of irImports)
    fail("MESH_UNKNOWN_IMPORT", `${root.name === "event" ? "An event" : "A command"} file takes no import: its fields are attribute lines, whose kinds are attribute types`, at(entry.span.sourceStart), "remove the import");
  const fields: Field[] = [];
  const names = new Set<string>();
  for (const tag of tags(root.children)) {
    for (const key of FIELD_OPTIONS_REFUSED) {
      const refused = attr(tag, key);
      if (refused)
        fail("MESH_UNKNOWN_OPTION", `\`${key}\` is not an option of a field of ${root.name === "event" ? "an event" : "a command"}: a field has no row behind it, so it takes the options that constrain a value (\`nullable\`, \`values\`, \`min\`, \`max\`, \`match\`) and none that concern storage or creation`, at(attrOffset(refused)), `remove \`${key}\``);
    }
    const field = shape(tag);
    // `default` is refused above; what it holds is not checked against the type as well.
    checkShape({ ...field, default: undefined });
    if (names.has(field.name)) fail("MESH_DUPLICATE_MEMBER", `Duplicate member :${field.name}`, tag);
    // The generated class has a property per field: `__proto__` would set the prototype, and a class cannot have a field named `constructor`.
    if (field.name === PROTOTYPE_SETTING_NAME || field.name === "constructor")
      fail("MESH_ATTRIBUTE_NAME", `:${field.name} cannot be a field name: ${field.name === "constructor" ? "the generated class has its constructor under that name" : "__proto__ sets an object's prototype instead of adding a property"}. Choose another name.`, tag);
    names.add(field.name);
    // `default`, which `shape` reads, is no part of a field.
    const { name: fieldName, type, nullable, values, min, max, match, position } = field;
    fields.push({ name: fieldName, type, nullable, ...(root.name === "command" && !nullable && opt(tag, "optional") === true ? { optional: true as const } : {}), ...(values ? { values } : {}), ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(match ? { match } : {}), position });
  }
  return {
    name,
    // The FQN carries the generated class's name (`billing.InvoicePaid`), so it is the path and the export one imports.
    fqn: [...module.split("/").filter(Boolean), classNameOf(name)].join("."),
    file,
    module,
    fields,
    position: pos(root),
  };
}

/**
 * The compiler's one MX call (`lowerSource`) with Mesh's dialect, which carries the closed
 * contracts, the tag rules and the strictness (rejection on). It never throws; every problem is a positioned diagnostic.
 * `file` is absolute in a build: MX compares the dialect's marks with those of every dialect the project installs only
 * when the file name is absolute and its nearest `package.json` is found (MX 0.1.0-alpha.34), so a build fails on a
 * clash exactly where the editor reports it. A diagnostic of the parsed file carries no file name, so the caller
 * positions it in the project-relative file.
 */
export function parseEntitySource(source: string, file: string) {
  return lowerSource(source, file, {
    dialect: MESH_DIALECT,
  });
}

/** One diagnostic MX's `lowerSource` reports (`IrDiagnostic`), as Mesh's own. */
export type MxDiagnostic = ReturnType<typeof parseEntitySource>["diagnostics"][number];

/**
 * Every code passes through as MX gives it. MX has already renamed its own codes to Mesh's through the dialect's
 * `diagnosticCodes` (`diagnostic-codes.ts`), so the build shows the code the editor shows; the four codes MX keeps
 * (`MX_KEPT_CODES`, a bug in MX or in a Mesh hook) arrive as `MX_*`, and Mesh's hook codes
 * (`ctx.fail(message, { code: "MESH_X" })`) as they were given. Only a diagnostic that arrives with no code is a syntax
 * error to Mesh; MX gives every error a code, so that is a fallback and not a path any entity source is known to reach.
 */
export function meshDiagnostic(d: MxDiagnostic, file: string): Diagnostic {
  return {
    severity: d.severity,
    code: d.code ?? "MESH_SYNTAX",
    message: d.message,
    position: { file, line: d.line, column: d.column, offset: d.offset },
    fix: staticFileFix(d),
  };
}

/**
 * MX's message for a `for` or an `if` in an entity file says the file is static and stops there. Mesh adds what to write
 * instead (the entity file page of the docs: no loops or conditions that add or remove declarations). MX owns the
 * message, so this is a `fix:` line beside it and not a rewording.
 */
// Matches MX's wording since alpha.30: "Mesh files are static, so they do not evaluate `if`".
const STATIC_CONSTRUCT = /\bevaluate `(for|if)`$/;
export function staticFileFix(d: Pick<MxDiagnostic, "code" | "message">): string | null {
  if (d.code !== "MESH_STRUCTURAL_CONSTRUCT") return null;
  const construct = STATIC_CONSTRUCT.exec(d.message)?.[1];
  if (construct === "for")
    return "a Mesh file has no loops; write each declaration out, or write a rule over a list as an expression such as `&lines.every((line) => ...)`";
  if (construct === "if")
    return "a Mesh file has no conditionals; put the condition on the line it conditions, as `when=` on a policy or a check, or inside its expression";
  return null;
}

/** Parse with closed MX contracts, then project the static tree without executing it. */
export function buildModel(project: ProjectDescription): BuildResult {
  const diagnostics: Diagnostic[] = [];
  const document: ModelDocument = { entities: [] };
  const rollups: PendingRollup[] = [];
  const importDetails = new Map<Import, ParsedImport>();
  const inversePositions = new Map<Relationship, SourcePosition>();
  const throughPositions = new Map<Relationship, SourcePosition>();
  if (foreignAbsolute(project.root))
    return {
      document: null,
      diagnostics: [
        error(
          "MESH_PROJECT_PATH",
          "Project root must be a host-compatible path",
          positionAt("", "mesh.config.ts", 0),
        ),
      ],
    };
  const rootPath = resolve(normalizePath(project.root));
  const domainRoot = resolve(rootPath, normalizePath(project.domainRoot ?? "."));
  if (!inside(rootPath, domainRoot)) return {
    document: null,
    diagnostics: [error("MESH_PROJECT_PATH", "Domain root must stay inside the project", positionAt("", "mesh.config.ts", 0))],
  };
  const ignoredByPath = new Map(
    (project.ignored ?? []).map((i) => [resolve(rootPath, i.file), i] as const),
  );
  const virtualFiles = new Set(
    project.files.map((f) => resolveEntityFile(rootPath, f.file)?.absolute),
  );
  // Every file is parsed before any is built: a reference through a namespace import (`billing.Invoice`) is
  // checked against what the imported file declares.
  const parsedFiles: { input: (typeof project.files)[number]; path: NonNullable<ReturnType<typeof resolveEntityFile>>; ir: NonNullable<ReturnType<typeof parseEntitySource>["ir"]> }[] = [];
  const declaredByPath = new Map<string, DeclaredFile>();
  const events: EventDeclaration[] = [];
  const commands: CommandDeclaration[] = [];
  for (const input of project.files) {
    const path = resolveEntityFile(rootPath, input.file);
    if (!path) {
      diagnostics.push(
        error(
          "MESH_ENTITY_PATH",
          "Entity file path must resolve inside the project",
          positionAt("", "mesh.config.ts", 0),
        ),
      );
      continue;
    }
    const parsed = parseEntitySource(input.source, path.absolute);
    diagnostics.push(
      ...parsed.diagnostics.map((d) => meshDiagnostic(d, path.file)),
    );
    if (!parsed.ir) continue;
    parsedFiles.push({ input, path, ir: parsed.ir });
    // The root line decides what the file declares (`notes/spec/file-kinds.md`): its kind, and the names of the roots of that kind,
    // each as Mesh converts it (`entity :todo` declares `Todo`): the name an import of the file takes.
    const roots = tags(parsed.ir.body);
    const kind = DECLARING_ROOTS.has(roots[0]?.name ?? "") ? roots[0]!.name as DeclaredFile["kind"] : "entity";
    declaredByPath.set(resolve(rootPath, path.file), { kind, names: roots.filter((root) => root.name === kind).flatMap((root) => atomOf(attr(root, "name"))?.name ?? []).map((name) => classNameOf(name)) });
  }
  for (const { input, path, ir } of parsedFiles) {
    const file = path.file;
    const declared = (from: string) => declaredByPath.get(resolve(rootPath, dirname(file), from));
    const roots = tags(ir.body);
    if (roots.length !== 1)
      diagnostics.push(
        error(
          "MESH_DUPLICATE_ENTITY",
          `${roots[0]?.name === "event" ? "An event" : roots[0]?.name === "command" ? "A command" : "An entity"} file must contain exactly one ${roots[0]?.name ?? "entity"}`,
          positionAt(input.source, file, roots[1]?.nameSpan.sourceStart ?? 0),
        ),
      );
    for (const root of roots) {
      try {
        if (root.name === "event" || root.name === "command") {
          const declaration = buildDeclaration(root, ir.imports, input.source, file, diagnostics, normalizePath(relative(domainRoot, dirname(path.absolute))));
          (root.name === "event" ? events : commands).push(declaration);
          continue;
        }
        document.entities.push(
          buildEntity(
            root,
            ir.imports,
            input.source,
            file,
            diagnostics,
            rollups,
            importDetails,
            inversePositions,
            throughPositions,
            normalizePath(relative(domainRoot, dirname(path.absolute))),
            declared,
          ),
        );
      } catch (cause) {
        diagnostics.push(
          error(
            "MESH_MODEL_SHAPE",
            cause instanceof Error ? cause.message : String(cause),
            positionAt(input.source, file, root.nameSpan.sourceStart),
          ),
        );
      }
    }
  }
  // An event and a command are identified by their FQN as an entity is: two files of one module declaring one name are one error.
  for (const [kind, list] of [["event", events], ["command", commands]] as const) {
    const first = new Map<string, string>();
    for (const declaration of list) {
      if (first.has(declaration.fqn))
        diagnostics.push(error("MESH_DUPLICATE_ENTITY", `Duplicate ${kind} ${declaration.fqn}; first declared in ${first.get(declaration.fqn)}`, declaration.position));
      else first.set(declaration.fqn, declaration.file);
    }
  }
  if (events.length) document.events = events;
  if (commands.length) document.commands = commands;
  // The FQN of the command each `on=` resolved to, now that every command is built: `from` is the import's path from the entity's file.
  for (const entity of document.entities)
    for (const action of entity.actions) {
      if (!action.command?.from) continue;
      const target = resolve(rootPath, dirname(entity.file), action.command.from);
      const answered = commands.find((command) => resolve(rootPath, command.file) === target);
      if (answered) action.command.fqn = answered.fqn;
    }
  // What each file of the project declares, for an import to check its name against.
  const declarations: { name: string; file: string }[] = [...document.entities, ...[...events, ...commands].map(({ name, file }) => ({ name: classNameOf(name), file }))];
  const identities = new Map<string, string>();
  for (const entity of document.entities) {
    if (identities.has(entity.fqn))
      diagnostics.push(
        error(
          "MESH_DUPLICATE_ENTITY",
          `Duplicate entity ${entity.fqn}; first declared in ${identities.get(entity.fqn)}`,
          entity.position,
        ),
      );
    else identities.set(entity.fqn, entity.file);
    for (const imported of entity.imports) {
      if (imported.mesh) continue; // "meshfw" is a package, not a file of the project
      const target = resolve(rootPath, dirname(entity.file), imported.from);
      const targetEntity = declarations.find((candidate) => resolve(rootPath, candidate.file) === target);
      if (hasMeshExtension(imported.from) && targetEntity) {
        // A namespace import names the file, not what it declares: its references are checked where they are written.
        for (const binding of imported.namespace ? [] : importDetails.get(imported)?.bindings ?? []) {
          if (binding.imported !== targetEntity.name) {
            const source = project.files.find((input) => resolveEntityFile(rootPath, input.file)?.file === entity.file)!.source;
            diagnostics.push(error("MESH_UNKNOWN_IMPORT", `\`${binding.imported}\` is not what ${imported.from} declares; it declares \`${targetEntity.name}\``, positionAt(source, entity.file, binding.offset)));
          }
        }
      }
      const candidates = hasMeshExtension(imported.from)
        ? [target]
        : [target, `${target}.ts`, `${target}.tsx`, `${target}.js`];
      const found = candidates.some((candidate) => {
        if (!inside(rootPath, candidate)) return false;
        if (virtualFiles.has(candidate)) return true;
        try {
          return (
            inside(realpathSync(rootPath), realpathSync(candidate)) &&
            statSync(candidate).isFile()
          );
        } catch {
          return false;
        }
      });
      const ignoredHit = ignoredByPath.get(target);
      if (ignoredHit)
        diagnostics.push(error("MESH_IGNORED_IMPORT", `${entity.file} imports ${imported.from}, which \`ignore\` in mesh.config.ts excludes (pattern ${JSON.stringify(ignoredHit.pattern)}); import a file that is not ignored, or remove the pattern`, imported.position));
      else if (found && hasMeshExtension(imported.from) && !virtualFiles.has(target))
        diagnostics.push(error("MESH_UNKNOWN_ENTITY", `${imported.from} exists but is not under the configured entity directories`, imported.position));
      if (!found)
        diagnostics.push(
          error(
            "MESH_UNKNOWN_IMPORT",
            `Cannot resolve import ${JSON.stringify(imported.from)} inside the project`,
            imported.position,
          ),
        );
    }
  }
  resolveRelationships(document, inversePositions, throughPositions, diagnostics);
  resolveRollups(document, rollups, diagnostics);
  checkExpressions(document, diagnostics, { demotionOf, copyOf: copyExpression });
  computeNeeds(document, diagnostics);
  checkLifecycleLimits(document, diagnostics, {
    privilegedCallsOf, askCallsOf, asynchronyOf, scopeReachOf, throughPositionOf: (relation) => throughPositions.get(relation),
  });
  checkPublishSteps(document, diagnostics);
  // A file that did not parse may hold the action that answers a command: with one missing, "unanswered" is not known.
  checkCommands(document, diagnostics, parsedFiles.length === project.files.length);
  const invalid = findNonJsonValue(document);
  if (invalid)
    diagnostics.push(
      error(
        "MESH_NON_JSON",
        `Model is not JSON-compatible: ${invalid}`,
        document.entities[0]?.position ?? positionAt("", "mesh.config.ts", 0),
      ),
    );
  diagnostics.sort((a, b) =>
    a.position.file.localeCompare(b.position.file) ||
    a.position.line - b.position.line ||
    a.position.column - b.position.column ||
    a.position.offset - b.position.offset,
  );
  return {
    document: diagnostics.some((d) => d.severity === "error") ? null : document,
    diagnostics,
  };
}

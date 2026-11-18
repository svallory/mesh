import { lowerSource, scanCached, type CustomTag, type TargetLookup } from "@mxlang/core";
import { basename, dirname, relative, resolve } from "node:path";
import { realpathSync, statSync } from "node:fs";
import {
  absolutePath,
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
  type Aggregate,
  type AggregatePart,
  type CommandRef,
  type DeclarationRef,
  type ValidateItem,
  type CommandDeclaration,
  type Computed,
  type ConceptDeclaration,
  type Diagnostic,
  type Atom,
  type Entity,
  type Literal,
  type EventDeclaration,
  type Expression,
  type Field,
  type HandlerDeclaration,
  type Import,
  type InputField,
  type MemberRef,
  type ModelDocument,
  type Policy,
  type Relationship,
  type Rollup,
  type Service,
  type SourcePosition,
  type Step,
  isExpression,
  type PublishedEvent,
  type Surface,
  type Exposure,
} from "@meshfw/model";
import { RELATIONSHIP_KINDS, SYNTAX_MESSAGES } from "./contracts.ts";
import { PASCAL_CASE, conceptFileLabel, conceptFileProblems } from "./concept-file.ts";
import { MX_TO_MESH_CODES } from "./diagnostic-codes.ts";
import { MESH_EXTENSIONS } from "./extensions.ts";
import { MESH_DIALECT } from "./dialect.ts";
import { architectureFileText, isArchitectureFileName, readArchitectureFile } from "./architecture-file.ts";
import { hasMeshExtension, meshExtensionsText } from "./extensions.ts";
import { askCallsOf, asynchronyOf, copyExpression, demotionOf, entityCallsOf, privilegedCallsOf, publishTargetsOf, scopeReachOf } from "./expression.ts";
import { checkExpressions } from "../model/index.ts";
import { error, offsetAt, positionAt, type BuildResult, type ProjectDescription } from "../model/index.ts";
import { lineHeadReference, referenceText, resolveReference, writtenReference, type ReferenceKind, type ReferenceScope, type WrittenReference } from "./references.ts";
import { holdsAtom, literalFits } from "./literal-types.ts";
import { nearestName } from "./nearest-name.ts";
import {
  resolveRollups,
  unknownMember,
  type PendingRollup,
} from "./rollups.ts";
import { resolveRelationships } from "./relationships.ts";
import { checkLifecycleLimits } from "../model/lifecycle-limits.ts";
import { checkSqlRequired } from "../model/sql-required.ts";
import { checkCommands } from "../model/commands.ts";
import { checkLockRelate } from "../model/lock-relate.ts";
import { checkPublishSteps } from "../model/publish-steps.ts";
import { aggregatesOf, resolveAggregates } from "../model/aggregates.ts";
import { classNameOf, isClassName } from "../model/class-name.ts";
import { computeNeeds } from "../model/needs.ts";
import { resolveSurfaces, type PendingExposure, type PendingSurface } from "../model/surfaces.ts";
import { checkServices } from "../model/services.ts";
import { aggregateNamesOf, checkArchitecture, DEFAULT_SETTINGS, type ArchitectureSettings } from "../model/architecture-rules.ts";
import { mergeIncluders, tagIncluder } from "../model/includers.ts";
import { buildService } from "./services.ts";
import {
  atomForwards,
  atomList,
  atomOf,
  attr,
  attrOffset,
  readMemberPath,
  containsAtom,
  declaredName,
  expression,
  isAtomLiteral,
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
  type SyntaxNode,
  type Tag,
} from "./tree.ts";

/**
 * The one name no member (attribute, relationship, computed field, action, policy) may take: in an object
 * literal, `__proto__: value` sets the object's prototype instead of adding a property, so the generated records,
 * schemas, row mappings and entity values could not hold it. Every other name, `constructor` and `toString` included,
 * is accepted and generated code works with it.
 */
export const PROTOTYPE_SETTING_NAME = "__proto__";
/** The top-level nodes of a lowered file. */
type IrBody = NonNullable<ReturnType<typeof lowerSource>["ir"]>["body"];
/** An entity import as MX parsed it (`Import.from`/`names`); never re-parsed. */
export interface ParsedImport {
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
export type DeclarationKind = "entity" | "event" | "command" | "aggregate" | "concept" | "architecture" | "surface" | "service" | "mixin";
/**
 * What a file of the project declares: its root line's kind, and every declaration by the name an import of it binds (the
 * root's, as Mesh converts it: `entity :todo` declares `Todo`), the root's first, then each inline event and command of
 * its owner sections. An aggregate file's entry for the aggregate itself is `{ kind: "aggregate", name }`, its name as
 * written: recorded so a message can name it, never a name an import may bind (an aggregate is no value). The architecture
 * file declares nothing: its entry is `{ kind: "architecture", declares: [] }`, and an import of it is refused. A file
 * whose root is `surface`, and every file of the surfaces folder, declares nothing either: `{ kind: "surface", declares: [] }`.
 * A service file declares its service, `{ kind: "service", declares: [{ kind: "service", name: "Work" }] }`: recorded so the
 * import check can name it, never a name an import binds (a service file is imported by no file of the domain, OD-12).
 * A mixin file declares its mixin under the name as written (`mixin :Audited` declares `Audited`; no class-name conversion,
 * since nothing is generated from a mixin): an import binds it, and only a `use mixin=` line reads it.
 */
export interface DeclaredFile {
  kind: DeclarationKind;
  declares: { kind: DeclarationKind; name: string }[];
}
const DECLARING_ROOTS: ReadonlySet<string> = new Set(["entity", "event", "command", "aggregate", "concept", "architecture", "surface", "service", "mixin"]);
/** The subject of "<noun> file must contain exactly one <kind>", by the file's root kind. */
const ROOT_NOUN: Readonly<Record<string, string>> = { entity: "An entity", event: "An event", command: "A command", aggregate: "An aggregate", architecture: "An architecture", surface: "A surface", service: "A service", mixin: "A mixin" };
/** The declarations an import of the file may bind: all but an aggregate's own name, a concept and a service, which are never imported. */
export const importable = (file: DeclaredFile | undefined) => file?.declares.filter((declaration) => declaration.kind !== "aggregate" && declaration.kind !== "concept" && declaration.kind !== "service");
/**
 * What a reference position takes, for the declarations of `kind`: `entity=` an entity, a `publish` function's `new` an
 * event, `on=` a command, a listing line of an owner's `events` section an event. A path that no file of the project
 * answers (the import itself is reported) matches every kind, so that a reference through it reports nothing more. `code`
 * is the position's: an event's unknown name in a `publish` is a failed `publish` check (`notes/spec/events-and-commands.md`,
 * "Errors"), and in a listing `MESH_UNKNOWN_EVENT`.
 */
export const referenceKind = (
  kind: Exclude<DeclarationKind, "aggregate" | "concept" | "architecture" | "surface" | "service" | "mixin">,
  declared: (from: string) => DeclaredFile | undefined,
  code = kind === "entity" ? "MESH_UNKNOWN_ENTITY" : kind === "command" ? "MESH_UNKNOWN_COMMAND" : "MESH_PUBLISH",
): ReferenceKind => ({
  noun: kind,
  declares: (from) => hasMeshExtension(from) && (declared(from)?.declares.some((d) => d.kind === kind) ?? true),
  names: (from) => declared(from)?.declares.filter((d) => d.kind === kind).map((d) => d.name),
  kindOf: (from, name) => importable(declared(from))?.find((d) => d.name === name)?.kind,
  code,
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
  /** The local names of the imports refused above: each binds nothing, and a reference through it reports nothing more. */
  refused: string[];
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
  const kept = new Set(result.map((entry) => entry.offset));
  const refused = imports.filter((entry) => !kept.has(entry.span.sourceStart)).flatMap((entry) => (entry.names ?? []).map((name) => name.local));
  return { imports: result, problems, refused };
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
export function attributeReaders(
  source: string,
  file: string,
  diagnostics: Diagnostic[],
  at: (offset: number) => SourcePosition = (offset) => positionAt(source, file, offset),
) {
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
      "nullable" | "default" | "values" | "min" | "max" | "match" | "ruleMessage" | "ruleCode"
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
    // Text only: MX refuses any other value, and the contract a blank one (`MESH_TEXT`).
    const message = opt(tag, "message");
    if (typeof message === "string") result.ruleMessage = message;
    const code = opt(tag, "code");
    if (typeof code === "string") result.ruleCode = code;
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
  /**
   * `message=` and `code=` change what a line rule reports, so a line with none of `min`, `max` and `match` cannot carry
   * them: `MESH_ATTRIBUTE_RULE` at the option's name, once per option.
   */
  const checkRuleText = (tag: Tag, field: Pick<Attribute, "min" | "max" | "match">) => {
    if (field.min !== undefined || field.max !== undefined || field.match) return;
    for (const key of ["message", "code"] as const) {
      const option = attr(tag, key);
      if (option)
        fail(
          "MESH_ATTRIBUTE_RULE",
          `${key} sets what min, max and match report, and this line has none of them`,
          at("nameSpan" in option && option.nameSpan ? option.nameSpan.sourceStart : attrOffset(option)),
          `add the rule, or remove ${key}`,
        );
    }
  };
  /**
   * A concept use (`Money :total`) that `conceptUses` resolved: the member's name, `type: "concept"`, the concept's FQN and
   * `nullable`, the one option of a use besides a command field's `optional`. `undefined` for any other line, and for a use
   * `conceptUses` refused (its error is reported there).
   */
  const conceptUse = (tag: Tag): { name: string; type: "concept"; concept: string; nullable: boolean; position: SourcePosition } | undefined => {
    const concept = CONCEPT_OF_USE.get(tag);
    return concept === undefined ? undefined : { name: declaredName(tag), type: "concept", concept, nullable: opt(tag, "nullable") === true, position: pos(tag) };
  };
  return { at, pos, fail, opt, shape, conceptUse, checkShape, checkRuleText };
}

/**
 * The lines of a holder's `input` block, in written order. An argument line (`string :title`) is read as an attribute line
 * is, and refused the options only a stored attribute takes; a member line (`&title`) goes to `memberLine`, which gives the
 * field or `undefined` when the line is refused, since what a member line may name depends on what holds the block. Two
 * fields of one name are `MESH_DUPLICATE_INPUT`, whichever kind each is.
 */
export function readInputLines(
  holder: Tag,
  { readers, memberLine }: { readers: ReturnType<typeof attributeReaders>; memberLine: (line: Tag) => InputField | undefined },
): InputField[] {
  const { fail, shape, checkShape, checkRuleText } = readers;
  const input: InputField[] = [];
  const names = new Set<string>();
  for (const line of tags(tags(holder.children).find((t) => t.name === "input")?.children ?? [])) {
    let field: InputField;
    if (line.name === "member") {
      const member = memberLine(line);
      if (!member) continue;
      field = member;
    } else {
      if (["primary-key", "unique", "on", "value"].some((key) => attr(line, key)))
        fail("MESH_ARGUMENT_OPTIONS", "An argument cannot declare primary-key, unique, on, or a body", line);
      field = { kind: "argument", ...shape(line) } satisfies Argument;
      checkShape(field);
      checkRuleText(line, field);
    }
    const name = field.kind === "member" ? field.ref.name : field.name;
    if (names.has(name)) fail("MESH_DUPLICATE_INPUT", `Duplicate input name ${name}`, line);
    names.add(name);
    input.push(field);
  }
  return input;
}

/**
 * A `policy` line: its name, its scope (`types=`, `actions=`), its `authorize-if` and `forbid-if` functions (written as an
 * option or as child lines, in that order) and its `when`. `scope` reads the scope options, so the `actions=` references
 * it returns are still unresolved: what holds the policy resolves them against its own actions.
 */
export function readPolicyLine(
  tag: Tag,
  { expr, scope, pos }: {
    expr: (a: Attr | undefined) => Expression;
    scope: (tag: Tag) => Pick<Policy, "types" | "actions">;
    pos: (tag: Tag) => SourcePosition;
  },
): Policy {
  const expressions = (key: string) => [
    ...(attr(tag, key) ? [expr(attr(tag, key))] : []),
    ...tags(tag.children)
      .filter((t) => t.name === key)
      .map((t) => expr(attr(t, "value"))),
  ];
  return {
    name: declaredName(tag),
    ...scope(tag),
    authorizeIf: expressions("authorize-if"),
    forbidIf: expressions("forbid-if"),
    ...(attr(tag, "when") ? { when: expr(attr(tag, "when")) } : {}),
    position: pos(tag),
  } satisfies Policy;
}

/** The section kinds an entity's line sources are read by, in reading order. */
const SECTION_KINDS = ["attributes", "relationships", "computed", "checks", "actions", "policies", "handlers"] as const;
type SectionReaders = Record<(typeof SECTION_KINDS)[number], (section: Tag) => void>;

/** What a function written in one line source sees besides `&members` and the scope roots. */
interface ExpressionScope {
  helpers: ReadonlyMap<string, string>;
  imported: ReadonlySet<string>;
  entities: ReadonlySet<string>;
  namespaces: ReadonlySet<string>;
  events: ReadonlySet<string>;
  commands: ReadonlySet<string>;
  duplicates: ReadonlySet<string>;
  mesh: ReadonlySet<string>;
  /** What a reference to another file's declaration resolves against, by the kind it names. */
  references: { entity: ReferenceScope; event: ReferenceScope; command: ReferenceScope };
}

/**
 * A project mixin's lines, ready to be read into each entity that uses it (`notes/spec/other-file-kinds.md`, "Mixin
 * files"). The file is lowered once, with its own folder's concepts; its lines are read once per includer.
 */
export interface MixinSource {
  /** The name as written (`mixin :Audited`): what an import binds and what messages call it. */
  name: string;
  /** The `mixin` line. */
  root: Tag;
  /** Its file's text, for slicing function text and positions. */
  source: string;
  /** Its file, project-relative. */
  file: string;
}

/**
 * One place an entity's lines are read from: the entity's own file, or a mixin one of its `use` lines includes. `at`
 * turns an offset of `source` into a position, so a source whose text is not the entity's file reports where its own
 * lines are.
 */
interface LineSource {
  /** The root line's section children. */
  sections: Tag[];
  source: string;
  at: (offset: number) => SourcePosition;
  scope: ExpressionScope;
  /** Set for a mixin's lines: its name, the `use` line that includes it (where a clash involving it is reported) and the mixin. */
  use?: { name: string; position: SourcePosition; mixin: MixinSource };
}

/** The scope of a mixin's lines: a mixin file takes no import, so its functions see only `&members`, the roots and globals. */
const NO_REFERENCES: ReferenceScope = { imports: new Map<string, Import>(), duplicates: new Set<string>() };
const MIXIN_SCOPE: ExpressionScope = {
  helpers: new Map<string, string>(),
  imported: new Set<string>(),
  entities: new Set<string>(),
  namespaces: new Set<string>(),
  events: new Set<string>(),
  commands: new Set<string>(),
  duplicates: new Set<string>(),
  mesh: new Set<string>(),
  references: { entity: NO_REFERENCES, event: NO_REFERENCES, command: NO_REFERENCES },
};

/**
 * What `use mixin=` takes: a name an import binds to a mixin. A path no file of the project answers matches, as in
 * `referenceKind`: the import itself is reported, so the `use` line reports nothing more (R9). A name bound to anything else
 * is `MESH_UNKNOWN_IMPORT` (ruling D37, OD7).
 */
const mixinKind = (declared: (from: string) => DeclaredFile | undefined): ReferenceKind => ({
  noun: "mixin",
  declares: (from) => hasMeshExtension(from) && (declared(from)?.kind ?? "mixin") === "mixin",
  names: (from) => declared(from)?.declares.filter((d) => d.kind === "mixin").map((d) => d.name),
  kindOf: (from, name) => importable(declared(from))?.find((d) => d.name === name)?.kind,
  code: "MESH_UNKNOWN_IMPORT",
});

/**
 * The lines of an owner's `handlers` section (`notes/architecture/handlers-design.md`, rules H5 to H11): each a `process`
 * or `listen` handler keyed `<owner FQN>.<name>`, with the events its `on=` names, resolved as a listing line of the
 * owner's `events` section is (an imported event, or one the file declares inline), and its body, built by `body`. The
 * contract has checked the name, the shape of `on=` and that the body is a function. A section is a scope of names:
 * two lines of one name, whatever their kinds, are `MESH_DUPLICATE_MEMBER` at the second, and a handler may share a name
 * with any member of its owner (ruling D44, Q10). Returns the handlers in written order.
 */
function readHandlers(
  section: Tag,
  { file, owner, at, pos, fail, events, declaredNames, body }: {
    file: string;
    owner: string;
    at: (offset: number) => SourcePosition;
    pos: (tag: Tag) => SourcePosition;
    fail: (code: string, message: string, at: Tag | SourcePosition, fix?: string) => void;
    events: { scope: ReferenceScope; kind: ReferenceKind };
    declaredNames: Map<CommandRef | DeclarationRef, string>;
    body: (a: Attr | undefined) => Expression;
  },
): HandlerDeclaration[] {
  const handlers: HandlerDeclaration[] = [];
  const names = new Set<string>();
  const lines = tags(section.children).filter((line) => line.name === "process" || line.name === "listen");
  for (const line of lines) {
    const name = atomOf(attr(line, "name"))?.name;
    const onAttr = attr(line, "on");
    const value = attr(line, "value");
    // MX or the contract reported a missing or malformed name, `on=` or body.
    if (name === undefined || !onAttr || value?.kind !== "dynamic") continue;
    if (names.has(name)) {
      fail("MESH_DUPLICATE_MEMBER", `Duplicate handler :${name} in the handlers section of ${owner}: a handler's name is unique across process and listen`, line, "rename one");
      continue;
    }
    names.add(name);
    const n = nodeOf(onAttr) as (SyntaxNode & { elements?: (SyntaxNode | null)[] }) | undefined;
    const items = n?.type === "ArrayExpression" ? n.elements ?? [] : [n];
    const refs: DeclarationRef[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const written = writtenReference(item);
      // The contract refused an item that is no reference.
      if (!written) continue;
      const resolved = resolveReference(written, events.scope, events.kind);
      if (!resolved.ok) {
        if ("code" in resolved) fail(resolved.code, resolved.message, at(resolved.offset), resolved.fix);
        continue;
      }
      const position = at(written.qualifier?.offset ?? written.offset);
      // One event named twice, under one name or two (an alias, a namespace member), is a mistake the build can name.
      const key = `${resolve("/", dirname(file), resolved.from)}#${resolved.declared}`;
      if (seen.has(key)) {
        fail("MESH_OPTION_VALUE", `on lists ${referenceText(written)} twice; remove one`, position);
        continue;
      }
      seen.add(key);
      const ref: DeclarationRef = { identifier: referenceText(written), from: resolved.from, fqn: "", position };
      declaredNames.set(ref, resolved.declared);
      refs.push(ref);
    }
    const renamed = attr(line, "renamed-from");
    const former = renamed ? atomOf(renamed)?.name : undefined;
    handlers.push({
      kind: line.name as "process" | "listen",
      name,
      key: `${owner}.${name}`,
      events: refs,
      run: body(value),
      ...(former !== undefined ? { renamedFrom: `${owner}.${former}` } : {}),
      position: pos(line),
    });
  }
  // `renamed-from` moves a former handler's progress row (H11): never one this section still declares, and never to two names.
  const formerOf = new Map<string, string>();
  for (const handler of handlers) {
    if (handler.renamedFrom === undefined) continue;
    const former = handler.renamedFrom.slice(owner.length + 1);
    const line = lines.find((candidate) => pos(candidate).offset === handler.position.offset)!;
    const option = attr(line, "renamed-from")!;
    const where = at(attrOffset(option));
    if (handlers.some((other) => other.name === former))
      fail("MESH_OPTION_VALUE", `renamed-from=:${former} names a handler this section still declares: a running handler's progress is never taken over`, where, `remove renamed-from, or rename :${former}`);
    else if (formerOf.has(former))
      fail("MESH_OPTION_VALUE", `:${formerOf.get(former)} and :${handler.name} both have renamed-from=:${former}: one progress row cannot move to two names`, where, "keep renamed-from on one of them");
    else formerOf.set(former, handler.name);
  }
  return handlers;
}

/**
 * An owner's `events` and `commands` sections, an entity's or an aggregate's (`notes/spec/events-and-commands.md`, "Where a
 * declaration lives"): each line declares an event or a command inline (`event :InvoiceVoided` with its fields), or lists
 * one an import of the file names, `InvoicePaid` or `notices.InvoiceOverdue`, resolved as `entity=` is. An inline
 * declaration means what the same declaration in a file of its own means (the same fields, class and FQN); the file names
 * it without an import, and it joins `inline`. `ownNames` holds the names an inline class name may not take (an entity's own
 * name; an aggregate's name binds nothing, so it takes none). Returns the sections' refs, each only when it has a line.
 */
function ownerSections(
  section: (name: string) => Tag | undefined,
  { file, self, owner, ownNames, source, diagnostics, module, events, commands, inline, declaredNames }: {
    file: string;
    self: string;
    owner: string;
    ownNames: readonly (readonly [string, string])[];
    source: string;
    diagnostics: Diagnostic[];
    module: string;
    events: { scope: ReferenceScope; kind: ReferenceKind };
    commands: { scope: ReferenceScope; kind: ReferenceKind };
    inline: { events: EventDeclaration[]; commands: CommandDeclaration[] };
    declaredNames: Map<CommandRef | DeclarationRef, string>;
  },
): { events?: DeclarationRef[]; commands?: DeclarationRef[] } {
  const { at, pos, fail } = attributeReaders(source, file, diagnostics);
  const result: { events?: DeclarationRef[]; commands?: DeclarationRef[] } = {};
  // Each inline class name, to what first took it: a second declaration of one name in the file gives it two meanings.
  // The inline lines of both sections are built in written order, whichever section the file writes first, so a clash
  // is reported at the later line and the earlier declaration is the one kept (R9b).
  const classNames = new Map<string, string>(ownNames);
  const inlineLines = (["events", "commands"] as const)
    .flatMap((name) => tags(section(name)?.children ?? []).filter((line) => line.name === (name === "events" ? "event" : "command")))
    .sort((a, b) => pos(a).offset - pos(b).offset);
  const built = new Map<(typeof inlineLines)[number], ReturnType<typeof buildDeclarationBody> | undefined>();
  for (const line of inlineLines) {
    const noun = line.name as "event" | "command";
    const declaration = buildDeclarationBody(line, source, file, diagnostics, module);
    const className = classNameOf(declaration.name);
    const taken = classNames.get(className);
    if (taken !== undefined) {
      fail("MESH_DUPLICATE_ENTITY", `Duplicate name ${className} in ${file}: the ${taken} ${className} and the ${noun} ${className} would be one class name ${declaration.fqn}`, line, "rename one");
      built.set(line, undefined);
      continue;
    }
    classNames.set(className, noun);
    built.set(line, declaration);
  }
  for (const name of ["events", "commands"] as const) {
    const noun = name === "events" ? "event" : "command";
    const { kind, scope } = name === "events" ? events : commands;
    const listed: DeclarationRef[] = [];
    const seen = new Set<string>();
    for (const line of tags(section(name)?.children ?? [])) {
      if (line.name === noun) {
        const declaration = built.get(line);
        if (!declaration) continue;
        const className = classNameOf(declaration.name);
        const key = `${resolve("/", file)}#${className}`;
        if (seen.has(key)) {
          fail("MESH_DUPLICATE_MEMBER", `${className} is listed twice in the ${name} section of ${owner}`, line, "remove one");
          continue;
        }
        seen.add(key);
        (noun === "event" ? inline.events : inline.commands).push(declaration);
        const ref: DeclarationRef = { identifier: className, from: self, fqn: "", position: pos(line) };
        declaredNames.set(ref, className);
        listed.push(ref);
        continue;
      }
      // MX lowers a parameter on a wildcard line, and a wildcard entry takes no `analyze` hook: the contracts' wrapper is not reached.
      if (line.params.length || line.var) {
        fail("MESH_SYNTAX", `\`${line.name}\`: tag parameters and variable bindings are not entity declarations`, line);
        continue;
      }
      const written = lineHeadReference(line);
      if (!written) {
        fail(kind.code, `${line.name} is not an imported ${noun}: a listing is an imported identifier (\`${noun === "event" ? "InvoicePaid" : "PayInvoice"}\`) or a member of a namespace import (\`${noun === "event" ? "notices.InvoiceOverdue" : "billing.PayInvoice"}\`)`, line);
        continue;
      }
      const resolved = resolveReference(written, scope, kind);
      if (!resolved.ok) {
        if ("code" in resolved) fail(resolved.code, resolved.message, at(resolved.offset), resolved.fix);
        continue;
      }
      // One declaration listed twice, under one name or two (an alias, a namespace member), or listed where the section
      // declares it: the later line says nothing.
      const key = `${resolve("/", dirname(file), resolved.from)}#${resolved.declared}`;
      if (seen.has(key)) {
        fail("MESH_DUPLICATE_MEMBER", `${referenceText(written)} is listed twice in the ${name} section of ${owner}`, line, "remove one");
        continue;
      }
      seen.add(key);
      const ref: DeclarationRef = { identifier: referenceText(written), from: resolved.from, fqn: "", position: pos(line) };
      declaredNames.set(ref, resolved.declared);
      listed.push(ref);
    }
    if (listed.length) result[name] = listed;
  }
  return result;
}

/** The events and commands a file declares inline, in its owner sections: what it declares besides its root. */
const inlineDeclarationsOf = (declaredFile: (from: string) => DeclaredFile | undefined, self: string) =>
  (declaredFile(self)?.declares ?? []).filter((declaration) => declaration.kind === "event" || declaration.kind === "command");

/**
 * The imports of an entity or an aggregate file (`readImports`), as the model records them, and the names they bind. Each
 * name goes to the import that binds it. A name bound twice is `MESH_DUPLICATE_IMPORT` at the second binding, which binds
 * nothing: no name set holds it, and a reference through the name reports nothing more (`duplicates`). A name the file's
 * own declaration takes (`ownKind`: its entity, its inline events and commands) bound again by an import is the same error.
 * A named import of an aggregate's name binds nothing either and goes to `duplicates`: the import check reports it.
 */
export function fileImports(
  irImports: readonly IrImport[],
  file: string,
  ownKind: ReadonlyMap<string, DeclarationKind>,
  importDetails: Map<Import, ParsedImport>,
  declaredFile: (from: string) => DeclaredFile | undefined,
  at: (offset: number) => SourcePosition,
  fail: (code: string, message: string, at: SourcePosition, fix?: string) => void,
) {
  const parsed = readImports(irImports);
  for (const problem of parsed.problems) {
    // An import of the architecture file in a form readImports refuses (type-only, default, side-effect) is the R8 error
    // too: the form advice would point to a named import, which R8 refuses as well, of a file that declares nothing.
    const from = problem.code === "MESH_IMPORT_FORM" ? irImports.find((entry) => entry.span.sourceStart === problem.offset)?.from : undefined;
    if (from !== undefined && hasMeshExtension(from) && declaredFile(from)?.kind === "architecture")
      fail("MESH_UNKNOWN_IMPORT", `${from} is the architecture file, which declares nothing to import`, at(problem.offset), "remove the import");
    else fail(problem.code, problem.message, at(problem.offset), problem.fix);
  }
  const imports = parsed.imports.map(
    (i): Import => {
      const renames = !i.namespace && i.bindings.some((binding) => binding.imported !== binding.local);
      const value: Import = {
        identifiers: i.names,
        ...(renames ? { imported: i.bindings.map((binding) => binding.imported) } : {}),
        from: i.from,
        // A project mixin file binds a mixin: no value and no helper, read only by a `use mixin=` line (`Import.mixin`).
        ...(i.from === MESHFW ? { mesh: true as const } : hasMeshExtension(i.from) ? (declaredFile(i.from)?.kind === "mixin" ? { mixin: true as const } : {}) : { helper: true as const }),
        ...(i.namespace ? { namespace: true as const } : {}),
        position: at(i.offset),
      };
      importDetails.set(value, i);
      return value;
    },
  );
  const importNames = new Map<string, Import>();
  const duplicates = new Set<string>();
  const bindings: { entry: Import; index: number; name: string }[] = [];
  for (const entry of imports)
    for (const [index, name] of entry.identifiers.entries()) {
      // A name the file's own declaration takes, bound again by an import, is an error at the import's binding, which binds
      // nothing: the name stays the declaration's (`notes/spec/imports-and-scope.md`). `Mesh` under the entity's name is
      // reported by the entity's builder, as it always was. An import of the file itself under the declared name binds that
      // very declaration.
      const own = ownKind.get(name);
      const itself = !entry.namespace && resolve("/", dirname(file), entry.from) === resolve("/", file) && (entry.imported?.[index] ?? name) === name;
      if (own && !itself && !(entry.mesh && own === "entity")) {
        const localOffset = importDetails.get(entry)?.bindings[index]?.localOffset;
        fail(
          "MESH_DUPLICATE_IMPORT",
          `Duplicate import identifier ${name}: the file declares the ${own} ${name} too`,
          localOffset === undefined ? entry.position : at(localOffset),
        );
        continue;
      }
      // A named import of the aggregate its file declares binds nothing too: the import check reports it
      // (`MESH_UNKNOWN_IMPORT`, R24a), and a use of the name reports nothing more, as for any name its file does not declare.
      const target = entry.namespace || entry.helper || entry.mesh ? undefined : declaredFile(entry.from);
      // A concept file binds nothing either: a concept is never imported (the import check reports it). Nor does a surface
      // file or a service file, which no file imports (the import check reports it, OD-12 for a service).
      if (target?.kind === "concept" || target?.kind === "surface" || target?.kind === "service" || target?.declares.some((declaration) => declaration.kind === "aggregate" && declaration.name === (entry.imported?.[index] ?? name))) {
        duplicates.add(name);
        continue;
      }
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
  // A name only a refused import binds (a package path, a form readImports refuses) binds nothing: the import is reported,
  // and a use of the name (`use mixin=Timestamps` after `import { Timestamps } from "meshfw/mixins"`) reports nothing more (R9).
  for (const name of parsed.refused) if (!importNames.has(name)) duplicates.add(name);
  return { imports, importNames, duplicates, bindings };
}

/**
 * The names a file's import bindings give each kind of declaration. A named import stands for the declaration its
 * imported name names (one kind); a namespace alias for every kind its file declares, so the alias of a file that
 * declares an entity and inline events is in both sets. An import no file of the project answers is an entity's (it is
 * reported), and a named import of a name its file does not declare keeps the file's kind (the import check reports it).
 */
const boundToOf = (bindings: readonly { entry: Import; index: number; name: string }[], declaredFile: (from: string) => DeclaredFile | undefined) => {
  const boundKinds = (entry: Import, index: number): readonly DeclarationKind[] => {
    if (entry.helper || entry.mesh) return [];
    if (entry.mixin) return ["mixin"];
    const target = declaredFile(entry.from);
    if (!target) return ["entity"];
    if (entry.namespace) return [...new Set(target.declares.map(({ kind }) => kind))];
    const imported = entry.imported?.[index] ?? entry.identifiers[index]!;
    return [target.declares.find(({ name }) => name === imported)?.kind ?? target.kind];
  };
  return (kind: DeclarationKind) => bindings.filter(({ entry, index }) => boundKinds(entry, index).includes(kind)).map(({ name }) => name);
};
/** `billing.Nope` through the alias of a file that declares an entity and events or commands: a member of any kind it declares. */
const memberKindOf = (declaredFile: (from: string) => DeclaredFile | undefined): ReferenceKind => ({
  noun: "entity, event or command",
  declares: (from) => hasMeshExtension(from) && declaredFile(from) !== undefined,
  names: (from) => importable(declaredFile(from))?.map(({ name }) => name),
  kindOf: (from, name) => importable(declaredFile(from))?.find((declaration) => declaration.name === name)?.kind,
  code: "MESH_UNKNOWN_ENTITY",
});

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
  declaredNames: Map<CommandRef | DeclarationRef, string>,
  inline: { events: EventDeclaration[]; commands: CommandDeclaration[] },
  mixinOf: (from: string, exported: string) => MixinSource | undefined = () => undefined,
  includersOf: Map<string, Set<string>> = new Map(),
): Entity {
  /** Where this entity's diagnostics start: a check for one already reported looks no further back (another includer's are its own). */
  const entityFrom = diagnostics.length;
  const { at, pos, fail, opt } = attributeReaders(source, file, diagnostics);
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
  // The file's own declarations, which it names without an import: its entity, and each event and command declared inline
  // in its owner sections (`notes/spec/events-and-commands.md`, "Names"), read from what the file declares so that a
  // function written above the section sees them.
  const self = `./${basename(file)}`;
  const inlineDeclared = inlineDeclarationsOf(declaredFile, self);
  const ownEvents = inlineDeclared.filter((declaration) => declaration.kind === "event").map(({ name }) => ({ name, from: self }));
  const ownCommands = inlineDeclared.filter((declaration) => declaration.kind === "command").map(({ name }) => ({ name, from: self }));
  const ownKind = new Map<string, DeclarationKind>([...inlineDeclared.map(({ kind, name }) => [name, kind] as const).reverse(), [entity.name, "entity"]]);
  const { imports, importNames, duplicates, bindings } = fileImports(irImports, file, ownKind, importDetails, declaredFile, at, fail);
  entity.imports = imports;
  const pending: {
    ref: MemberRef;
    scope: "input" | "sort" | "load" | "set" | "actions" | "expression" | "filter" | "check" | "lock" | "relate";
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
  const references: ReferenceScope = { imports: importNames, duplicates, own: [{ name: entity.name, from: self }], self };
  const entityKind = referenceKind("entity", declaredFile);
  // An event is the file's own when an owner section of the file declares it inline; any other is named by an import.
  const eventReferences: ReferenceScope = { imports: importNames, duplicates, own: ownEvents, self };
  const eventKind = referenceKind("event", declaredFile);
  // `on=PayInvoice` or `on=billing.PayInvoice`: an import's command, or one the file's `commands` section declares.
  const commandReferences: ReferenceScope = { imports: importNames, duplicates, own: ownCommands, self };
  const commandKind = referenceKind("command", declaredFile);
  // A listing line of the `events` section names an event as a `publish` does, and an unknown one is no failed publish.
  const listedEventKind = referenceKind("event", declaredFile, "MESH_UNKNOWN_EVENT");
  // The kinds of declaration each binding stands for (`boundToOf`).
  const boundTo = boundToOf(bindings, declaredFile);
  // The entities a function in this file can name: its own and each one it imports, by the name the file gives it.
  const entities = new Set([entity.name, ...boundTo("entity")]);
  // The events and commands it can name: each one it imports and each one its owner sections declare, by its name here.
  const events = new Set([...boundTo("event"), ...ownEvents.map(({ name }) => name)]);
  const commands = new Set([...boundTo("command"), ...ownCommands.map(({ name }) => name)]);
  const memberKind = memberKindOf(declaredFile);
  // Each namespace import's alias: a function reads `billing.Invoice` as it reads an imported `Invoice`, and calls
  // `h.isStaff(...)` as it calls an imported `isStaff(...)`.
  const namespaces = new Set(bindings.filter(({ entry }) => entry.namespace && !entry.mixin).map(({ name }) => name));
  // A mixin is no value: a function that reads its name reads a free variable (R22).
  const mixinNames = new Set(bindings.filter(({ entry }) => entry.mixin).map(({ name }) => name));
  // `Mesh` under the entity's own name would give one name two meanings in a function of the file.
  for (const entry of entity.imports)
    if (entry.mesh && entry.identifiers.includes(entity.name))
      fail("MESH_DUPLICATE_IMPORT", `Duplicate import identifier ${entity.name}: the entity is named ${entity.name} too`, entry.position);
  // The entity's own lines. A line source is read with what its file sees: here, the file's imports and its own declarations.
  const own: LineSource = {
    sections,
    source,
    at,
    scope: {
      helpers: helperImports,
      imported: new Set([...[...importNames.keys()].filter((name) => !mixinNames.has(name)), ...duplicates, ...ownEvents.map(({ name }) => name), ...ownCommands.map(({ name }) => name)]),
      entities,
      namespaces,
      events,
      commands,
      duplicates,
      mesh: meshImports,
      references: { entity: references, event: eventReferences, command: commandReferences },
    },
  };
  /** Every line source of the entity, in reading order: the entity's own first, then each mixin in the order of its `use` line. */
  const sources: LineSource[] = [own];
  // `use mixin=Audited` (`notes/spec/entity.md`, "`use`: including a mixin"): each line names a mixin an import binds, whose
  // lines are read below as if they were written in this file, after the entity's own lines of each kind (R16, ruling
  // D37 OD2). A name no import binds to a mixin is `MESH_UNKNOWN_IMPORT` (R9); a path no file answers, or a mixin file
  // that did not parse, reports nothing more. The same mixin twice is one error at the later line (R15).
  const mixinReferences: ReferenceScope = { imports: importNames, duplicates, own: [], self };
  const usesKind = mixinKind(declaredFile);
  for (const tag of sections) {
    if (tag.name !== "use") continue;
    const written = writtenReference(nodeOf(attr(tag, "mixin")));
    if (!written) continue; // no `mixin=` (`checkUseOptions`), or no reference (the contract's hook)
    const resolved = resolveReference(written, mixinReferences, usesKind);
    if (!resolved.ok) {
      if ("code" in resolved) fail(resolved.code, resolved.message, at(resolved.offset), resolved.fix);
      continue;
    }
    const mixin = mixinOf(resolved.from, resolved.declared);
    if (!mixin) continue;
    if (sources.some((src) => src.use?.mixin === mixin)) {
      fail("MESH_DUPLICATE_MEMBER", `Duplicate use of the mixin ${mixin.name}: this entity already uses it`, tag, "remove this line");
      continue;
    }
    sources.push({
      sections: tags(mixin.root.children),
      source: mixin.source,
      at: (offset) => positionAt(mixin.source, mixin.file, offset),
      scope: MIXIN_SCOPE,
      use: { name: mixin.name, position: pos(tag), mixin },
    });
    if (!includersOf.has(mixin.file)) includersOf.set(mixin.file, new Set());
    includersOf.get(mixin.file)!.add(entity.fqn);
  }
  // The checks the `checks` section declares, by name (the first of a name; a second is a duplicate member, below), and
  // every check name that counts as a member of the entity, named or inline, with where it is written.
  const namedChecks = new Map<string, Check>();
  // `sourceIndex` is the place of the check's line source in `sources`: offsets of two files do not compare.
  const checkMembers: { name: string; position: SourcePosition; sourceIndex: number }[] = [];
  /** The names of declarations under `checks` that a form rule refused: a reference to one is no second error. */
  const brokenChecks = new Set<string>();
  /** The members of `checkMembers` declared under `checks`, not inline in a `validate`. */
  const sectionChecks = new Set<unknown>();
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
  // The actions whose name the author wrote, as against one named after its command.
  const authorNamed = new Set<Action>();
  /** Where each `auto` member is, in the order of `entity.auto`, and the line source whose `auto=` lists it. */
  const autoPositions: SourcePosition[] = [];
  const autoSources: LineSource[] = [];
  /**
   * The readers of one line source, by section kind: each reads one section line of `src` into the entity, with positions,
   * function text and references taken from `src`, and writes into the state above, which every source shares.
   */
  const readersFor = (src: LineSource): SectionReaders => {
    const sourceIndex = sources.indexOf(src);
    const readers = attributeReaders(src.source, file, diagnostics, src.at);
    const { at, pos, fail, opt, shape, conceptUse, checkShape, checkRuleText } = readers;
    const { entity: references, event: eventReferences, command: commandReferences } = src.scope.references;
    // A handler body reads no member: each `&name` in it is `MESH_HANDLER_SCOPE` from the expression layer, written or read.
    // A rollup's filter (`"rollup-filter"`) reads only the record its parameter names: an `&x` there is refused with the
    // filter's own error once the record's entity is known (`rollupFilterProblems`), not checked against this entity.
    const expr = (a: Attr | undefined, scope: "expression" | "filter" = "expression", step?: "run" | "publish" | "handler" | "rollup-filter"): Expression =>
      expression(
        a,
        src.source,
        at,
        (ref) => { if (step !== "handler" && step !== "rollup-filter") checkRef(ref, scope); },
        ({ ref, position }) => {
          if (step !== "handler")
            fail(
              "MESH_MEMBER_ASSIGN",
              `\`&${ref.name}\` cannot be assigned inside an expression; use a \`set\` line`,
              position,
            );
        },
        {
          helpers: src.scope.helpers,
          imported: src.scope.imported,
          entities: src.scope.entities,
          namespaces: src.scope.namespaces,
          reference: (written) => resolveReference(written, references, entityKind),
          memberReference: (written) => resolveReference(written, references, memberKind),
          events: src.scope.events,
          commands: src.scope.commands,
          eventReference: (written) => resolveReference(written, eventReferences, eventKind),
          commandReference: (written) => resolveReference(written, commandReferences, commandKind),
          duplicates: src.scope.duplicates,
          mesh: src.scope.mesh,
          report: (d) => {
            if (!diagnostics.slice(entityFrom).some((x) => x.code === d.code && x.position.file === d.position.file && x.position.offset === d.position.offset)) diagnostics.push(d);
          },
          ...(step === "run" ? { runStep: true } : step === "publish" ? { publishStep: true } : step === "handler" ? { handlerBody: true } : step === "rollup-filter" ? { rowParameter: true } : {}),
          ...(src.use ? { mixin: true } : {}),
        },
      );
    const authoredMember = (line: Tag) =>
      fail(
        "MESH_SYNTAX",
        "`<member>` is not a known tag: write a member line as `&name`",
        line,
      );
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
      checkMembers.push({ name: check.label, position: check.position, sourceIndex });
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
    /** The steps under an action's `do`, under a step `when` (`nested`), or under an `always` block's `do` (`always`). */
    const steps = (holder: Tag, nested = false, always = false): Step[] => tags(holder.children).flatMap((tag) => buildStep(tag, nested, always) ?? []);
    const buildStep = (tag: Tag, nested: boolean, always: boolean): Step | undefined => {
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
              let shapedLikeFunction = false;
              const value = readAt(line, at, () => {
                const n = nodeOf(member.value);
                if (n && ["ArrowFunctionExpression", "FunctionExpression"].includes(n.type)) return expr(member.value);
                let literal: ReturnType<typeof valueOf>;
                try { literal = valueOf(member.value); }
                catch { throw new Error(`\`&${member.ref.name}=\` needs a literal value here`); }
                const field = entity.attributes.find((attribute) => attribute.name === member.ref.name);
                if (field?.type === "json" && containsAtom(member.value))
                  fail("MESH_SET_VALUE", `\`&${member.ref.name}=\` is json, and an atom is not JSON: write a string`, member.ref.position);
                // A concept literal is checked once every concept is built (`checkConceptLiterals`): its concept may be in a later file.
                if (field && field.type !== "concept" && (!literalFits(literal, field) || (n?.type === "ObjectExpression" && field.type !== "json")))
                  fail("MESH_SET_VALUE", `\`&${member.ref.name}=\` needs a literal that fits ${field.type}${field.type === "enum" ? ` (${field.values?.map((atom) => `:${atom.value}`).join(", ")})` : ""}`, member.ref.position);
                // `isExpression` tells a set line's function from its literal by shape; a literal of that shape (a concept or
                // json value with `source`, `params` and `position` keys) would be read as a function, so it is refused and
                // the assignment is dropped from the model.
                if (isExpression(literal)) {
                  shapedLikeFunction = true;
                  fail("MESH_SET_VALUE", `\`&${member.ref.name}=\` is a literal with the keys of a function (\`source\`, \`params\`, \`position\`): write it as a function`, member.ref.position);
                }
                // A belongs-to stores its target's key: a literal is that key (or null on a nullable one). Its type is checked at the call, by the key column.
                const relation = field ? undefined : entity.relationships.find((r) => r.name === member.ref.name);
                if (relation && (literal === null ? !relation.nullable : typeof literal !== "string" && typeof literal !== "number"))
                  fail("MESH_SET_VALUE", `\`&${member.ref.name}=\` stores the key of :${relation.entity.identifier}: write its id${relation.nullable ? ", null" : ""} or a function`, member.ref.position);
                return literal;
              });
              if (value.diagnostic) { diagnostics.push(value.diagnostic); return []; }
              if (shapedLikeFunction) return [];
              return [{ member: member.ref, value: value.value }];
            }),
            position,
          };
        if (tag.name === "when")
          return {
            kind: "when",
            condition: expr(attr(tag, "value")),
            steps: steps(tag, true, always),
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
        // an event that owners list and the action's owner does not, needs every entity built (`checkPublishSteps`).
        if (tag.name === "publish")
          return { kind: "publish", fn: expr(attr(tag, "value"), "expression", "publish"), position };
        // `lock &version` (ADR-0100). The `when` contract takes the steps `do` takes, so MX admits one under a step `when`;
        // a lock that guards some calls and not others is no lock, so it is refused there and dropped. The member's kind
        // and every rule that needs the actions it reaches are `checkLockRelate`'s (`model/lock-relate.ts`).
        if (tag.name === "lock") {
          const member = checkRef(readMember(attr(tag, "member"), at), "lock");
          if (nested) {
            fail("MESH_LOCK_STEP", "a `lock` step under `when` would guard some calls and not others: it is written directly under `do`", tag, `move \`lock &${member.name}\` out of the \`when\``);
            return undefined;
          }
          return { kind: "lock", member, ...(opt(tag, "optional") === true ? { optional: true as const } : {}), position };
        }
        // `relate &tracks create=:add ...` (ADR-0100, "The relate step"). Written only at the top level of an action's own
        // `do`: under a step `when` the list would be taken on some calls and dropped on others, and in an `always` block it
        // would add a list input to every action the block covers. The relationship's kind, the actions the options name
        // and every rule that needs another entity are `checkLockRelate`'s (`model/lock-relate.ts`).
        if (tag.name === "relate") {
          const relationship = checkRef(readMember(attr(tag, "member"), at), "relate");
          if (nested || always) {
            fail("MESH_RELATE_STEP", nested
              ? "a `relate` step under `when` would take the list on some calls and drop it on others: it is written directly under the action's own `do`"
              : `a \`relate\` step in an \`always\` block would add a \`${relationship.name}\` input to every action the block covers: it is written directly under the action's own \`do\``,
              tag, nested ? `move \`relate &${relationship.name}\` out of the \`when\`` : `move \`relate &${relationship.name}\` to the \`do\` of the action it belongs to`);
            return undefined;
          }
          const named: { create?: MemberRef; update?: MemberRef; destroy?: MemberRef } = {};
          for (const option of ["create", "update", "destroy"] as const) {
            const value = attr(tag, option);
            const atom = value ? atomOf(value) : undefined;
            if (value && atom) named[option] = { name: atom.name, position: at(attrOffset(value)) };
          }
          if (!named.create && !named.update && !named.destroy) {
            fail("MESH_RELATE_STEP", `\`relate &${relationship.name}\` names no action: \`create=\`, \`update=\` and \`destroy=\` name the actions of the related entity it calls`, tag,
              "add `create=:<a create action of the related entity>`");
            return undefined;
          }
          return { kind: "relate", relationship, ...named, position };
        }
        // The `when` contract serves a step and a `when` in `validate` alike, so MX admits a `check` under a step `when`
        // (`do` itself does not take one).
        if (tag.name === "check") {
          // A reference is still a use of its check: refused here, it is not also reported unused.
          const reference = attr(tag, "member");
          if (reference && !attr(tag, "name")) usedChecks.add(readMember(reference, at).name);
          fail("MESH_TAG_NOT_ALLOWED", "`when` in `do`: `check` is not allowed here; allowed children: `set`, `when`, `load`, `run`, `publish`", tag);
          return undefined;
        }
        throw new Error(`Unexpected step ${tag.name}`);
    };
    const body = (holder: Tag, always = false) => {
      const block = tags(holder.children).find((t) => t.name === "do");
      return { validate: checks(holder), do: block ? steps(block, false, always) : [] };
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
    const attributes = (section: Tag) => {
      for (const tag of tags(section.children)) {
        // A concept use (`Money :total`): one JSON value, never a key, with no option to check (ADR-0092).
        if (tag.definedIn !== undefined) {
          const use = conceptUse(tag);
          if (use) entity.attributes.push({ ...use, primaryKey: false, unique: false });
          continue;
        }
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
        checkRuleText(tag, field);
        entity.attributes.push(field);
      }
    };
    const relationships = (section: Tag) => {
      for (const tag of tags(section.children)) {
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
    };
    /**
     * `filter=(line) => ...` on a rollup line, converted with its one parameter as the record (`rowParameter`); the contract
     * refused every other parameter form. Kept as the same object, so its side tables stay, with the parameter's name and
     * without `rest`/`takesScope`, which say what a function of the scope can reach and do not apply to it.
     */
    const rollupFilter = (a: Attr | undefined): { filter?: Rollup["filter"] } => {
      const n = nodeOf(a);
      const param = (n?.params?.[0] as { name?: string } | undefined)?.name;
      if (!a || param === undefined) return {};
      const filter = expr(a, "expression", "rollup-filter") as Rollup["filter"] & { rest?: true; takesScope?: true };
      delete filter.rest;
      delete filter.takesScope;
      filter.param = param;
      return { filter };
    };
    const computed = (section: Tag) => {
      for (const tag of tags(section.children)) {
        const base = { name: declaredName(tag), position: pos(tag) };
        if (["count", "sum", "avg", "min", "max"].includes(tag.name)) {
          const segments = readMemberPath(attr(tag, "of"), at);
          const of = segments.map((s) => s.name).join(".");
          const computed: Computed = {
            ...base,
            type: "integer",
            nullable: false,
            rollup: { fn: tag.name as Rollup["fn"], of, ...rollupFilter(attr(tag, "filter")) },
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
    };
    const checksSection = (section: Tag) => {
      for (const tag of tags(section.children)) {
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
        const member = { name: check.label, position: check.position, sourceIndex };
        checkMembers.push(member);
        sectionChecks.add(member);
        if (!namedChecks.has(check.label)) namedChecks.set(check.label, check);
      }
    };
    const actions = (actionSection: Tag) => {
      const auto = attr(actionSection, "auto");
      const listed = auto ? types(auto) : [];
      if (new Set(listed).size !== listed.length)
        fail(
          "MESH_DUPLICATE_MEMBER",
          "auto contains a duplicate action type",
          actionSection,
        );
      // An `auto` member is at the `actions` line of the source that lists it.
      for (const type of listed) {
        entity.auto.push(type);
        autoPositions.push(pos(actionSection));
        autoSources.push(src);
      }
      // The entity that uses a mixin chooses the read that loads it and the cap of its reads (R18, ruling D37 OD8): a
      // mixin's `actions` line takes `auto=` alone.
      for (const option of src.use ? ["on:load", "max-limit"] : []) {
        const written = attr(actionSection, option);
        if (written)
          fail("MESH_UNKNOWN_OPTION", option === "on:load"
            ? "`on:load` is not an option of a mixin's `actions`: the entity that uses the mixin chooses the read that loads it"
            : "`max-limit` is not an option of a mixin's `actions`: the entity that uses the mixin caps its own reads",
          optionAt(written), `move \`${option}=\` to the entity's \`actions\` line`);
      }
      const onLoad = src.use ? undefined : attr(actionSection, "on:load");
      if (onLoad) entity.onLoad = checkRef(readMember(onLoad, at), "actions");
      const cap = src.use ? undefined : attr(actionSection, "max-limit");
      if (cap) {
        const max = valueOf(cap);
        const where = optionAt(cap);
        if (typeof max !== "number" || !Number.isInteger(max) || max < 1)
          fail("MESH_OPTION_VALUE", "max-limit must be a whole number of at least 1", where);
        else entity.maxLimit = { max, position: where };
      }
      for (const tag of tags(actionSection.children)) {
        if (tag.name === "always") {
          entity.always.push({
            ...scope(tag),
            ...body(tag, true),
            position: pos(tag),
          } satisfies Always);
          continue;
        }
        const kind = tag.name as ActionType;
        // `on=` answers a command and, with no name written, names the action: the command's class name with its first letter
        // in lower case, whatever name this file binds (`notes/spec/events-and-commands.md`, "Answering a command").
        const onAttr = attr(tag, "on");
        const written = onAttr ? writtenReference(nodeOf(onAttr)) : undefined;
        const answered = written ? resolveReference(written, commandReferences, commandKind) : undefined;
        if (answered && !answered.ok && "code" in answered) fail(answered.code, answered.message, at(answered.offset), answered.fix);
        // The command's class name, whatever name this file binds; none for a file the project lacks (the import is reported).
        const commandClass = answered?.ok && declaredFile(answered.from) ? answered.declared : undefined;
        const writtenName = attr(tag, "name") ? declaredName(tag) : undefined;
        // A name and no `on=` is the one case a contract leaves nothing to say about; with neither, `MESH_NAME` has been reported.
        const actionName = writtenName ?? (commandClass ? commandClass.charAt(0).toLowerCase() + commandClass.slice(1) : written ? written.name.charAt(0).toLowerCase() + written.name.slice(1) : undefined);
        if (actionName === undefined) continue;
        const command: Action["command"] = written && onAttr
          ? { identifier: referenceText(written), from: answered?.ok ? answered.from : "", fqn: "", position: at(attrOffset(onAttr)) }
          : undefined;
        if (command && answered?.ok) declaredNames.set(command, answered.declared);
        const input = readInputLines(tag, {
          readers,
          memberLine: (line) => {
            if (!isMemberLine(line)) { authoredMember(line); return undefined; }
            const read = readAt(line, at, () => readMemberLine(line, at));
            if (read.diagnostic) { diagnostics.push(read.diagnostic); return undefined; }
            if (kind === "read")
              fail(
                "MESH_READ_INPUT_MEMBER",
                "A read input may declare arguments only",
                line,
              );
            return { kind: "member", ref: checkRef(read.value.ref, "input") };
          },
        });
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
    };
    const policies = (section: Tag) => {
      for (const tag of tags(section.children))
        entity.policies.push(readPolicyLine(tag, { expr: (a) => expr(a), scope, pos }));
    };
    const handlers = (section: Tag) => {
      const read = readHandlers(section, {
        file, owner: entity.fqn, at, pos, fail, declaredNames,
        events: { scope: eventReferences, kind: listedEventKind },
        body: (a) => expr(a, "expression", "handler"),
      });
      if (read.length) (entity.handlers ??= []).push(...read);
    };
    return { attributes, relationships, computed, checks: checksSection, actions, policies, handlers };
  };
  // Read by kind, in `SECTION_KINDS` order, and within a kind source by source: every source's checks are read before any
  // `validate` looks one up.
  const sourceReaders = new Map(sources.map((src) => [src, readersFor(src)] as const));
  /** The mixin line source each member came from; a member of the entity's own lines is not in it. */
  const originOf = new Map<object, LineSource>();
  const memberLists = () => [entity.attributes, entity.relationships, entity.computed, entity.actions, entity.policies, checkMembers] as readonly object[][];
  for (const kind of SECTION_KINDS)
    for (const src of sources) {
      const line = src.sections.find((t) => t.name === kind);
      if (!line) continue;
      const before = memberLists().map((list) => list.length);
      sourceReaders.get(src)![kind](line);
      if (src.use) memberLists().forEach((list, index) => list.slice(before[index]).forEach((member) => originOf.set(member, src)));
    }
  Object.assign(entity, ownerSections(section, {
    file, self, owner: entity.fqn, ownNames: [[entity.name, "entity"]], source, diagnostics, module,
    events: { scope: eventReferences, kind: listedEventKind }, commands: { scope: commandReferences, kind: commandKind },
    inline, declaredNames,
  }));
  const members = [
    ...entity.attributes,
    ...entity.relationships,
    ...entity.computed,
    ...entity.actions,
    ...entity.auto.map((name, index) => {
      const member = { name, position: autoPositions[index]!, auto: true as const };
      if (autoSources[index]?.use) originOf.set(member, autoSources[index]!);
      return member;
    }),
    ...entity.policies,
    ...checkMembers.sort((a, b) => a.sourceIndex - b.sourceIndex || a.position.offset - b.position.offset),
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
  /** Of two members' line sources, the one read later: a mixin's `use` line is where a clash involving it is reported (R14). */
  const later = (a: LineSource | undefined, b: LineSource | undefined) => (sources.indexOf(a ?? own) > sources.indexOf(b ?? own) ? a : b) ?? own;
  /**
   * A name a mixin brings in that the entity, or another mixin it uses, also takes (R14, R26; ruling D37 OD6): one error at
   * the (later) `use` line, the one place in the entity's file that can fix it, whether or not a check is involved.
   */
  const mixinClash = (member: (typeof members)[number], holder: (typeof members)[number], mine: LineSource | undefined, theirs: LineSource | undefined) => {
    const name = member.name;
    if (mine?.use && theirs?.use) {
      const [first, second] = sources.indexOf(theirs) < sources.indexOf(mine) ? [theirs, mine] : [mine, theirs];
      fail("MESH_DUPLICATE_MEMBER", `Duplicate member :${name}: the mixins ${first.use!.name} and ${second.use!.name} both declare it`,
        second.use!.position, "rename it in one of the mixins, or use only one of them");
      return;
    }
    const [mixinSide, ownSide] = mine?.use ? [member, holder] : [holder, member];
    const mixin = (mine?.use ? mine : theirs)!.use!;
    if ("auto" in mixinSide)
      fail("MESH_DUPLICATE_MEMBER", `Duplicate member :${name}: the mixin ${mixin.name} generates it with auto=, and ${entity.name} generates or declares it too`,
        mixin.position, "auto" in ownSide ? `remove :${name} from one of the two \`auto=\` lists` : `rename the entity's own :${name}, or stop using ${mixin.name}`);
    else if ("auto" in ownSide)
      fail("MESH_DUPLICATE_MEMBER", `Duplicate member :${name}: the mixin ${mixin.name} declares it, and ${entity.name} generates it with auto=`,
        mixin.position, `remove :${name} from the entity's \`auto=\` list, or stop using ${mixin.name}`);
    else
      fail("MESH_DUPLICATE_MEMBER", `Duplicate member :${name}: the mixin ${mixin.name} declares it, and so does ${entity.name}`,
        mixin.position, `remove or rename the entity's own :${name}, or stop using ${mixin.name}`);
  };
  for (const member of members) {
    if (names.has(member.name)) {
      const holder = holders.get(member.name)!;
      const mine = originOf.get(member);
      const theirs = originOf.get(holder);
      // Two members of one name from one mixin are the mixin's own mistake, reported in its file (R25), as below.
      if ((mine || theirs) && mine !== theirs) {
        mixinClash(member, holder, mine, theirs);
        names.add(member.name);
        continue;
      }
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
      // A concept member is one JSON value (ADR-0092), which a query does not look inside.
      if (used?.type === "concept")
        fail(scope === "sort" ? "MESH_SORT_TYPE" : "MESH_FILTER_TYPE",
          `&${ref.name} is the concept ${(used as Attribute).concept}, which a ${scope} cannot use: it is stored as one JSON value`, ref.position);
      else if (used && !attributeTypeInfo(used.type).queryable)
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
  // Auto or written: an entity whose actions include no read has no caller read to cap. The check is local, since
  // `hasRead` lives in `typescript/views/inputs.ts`, which the front end may not import (ADR-0076).
  if (entity.maxLimit && !entity.auto.includes("read") && !entity.actions.some((action) => action.kind === "read"))
    fail(
      "MESH_OPTION_VALUE",
      "max-limit caps the limit of this entity's reads, and it has none: add :read to auto= or write a read line, or remove max-limit",
      entity.maxLimit.position,
    );
  for (const relation of entity.relationships)
    if (relation.keyColumn && names.has(relation.keyColumn)) {
      // A check named like the key column is the check's mistake: it is reported there. When either side came from a
      // mixin, the clash is reported at the (later) `use` line, as every clash involving a mixin is (R14).
      const holder = holders.get(relation.keyColumn);
      const mixin = originOf.get(relation) !== originOf.get(holder!) ? later(originOf.get(relation), originOf.get(holder!)).use : undefined;
      fail(
        "MESH_DUPLICATE_MEMBER",
        `Generated key column ${relation.keyColumn} conflicts with a declared member`,
        mixin ? mixin.position : isCheck(holder) ? holder!.position : relation.position,
        mixin ? undefined : isCheck(holder) ? "rename the check" : undefined,
      );
    }
  return entity;
}

/**
 * An aggregate file (`notes/spec/other-file-kinds.md`, "Aggregate files"; ADR-0080): `aggregate :Name`, its `root
 * entity=Name` line, the part lines of its `entities` section (`Dependency prop=:dependent`) and its own `events` and
 * `commands` sections, read as an entity's are (`ownerSections`). The root and each part are references to an entity,
 * resolved as `entity=` is; which `belongs-to` ties a part to the root is the model's to find, once every entity is built
 * (`model/aggregates.ts`). The name is kept as written, since nothing is generated from an aggregate, and it binds
 * nothing: an inline declaration may share it, and another file cannot import it.
 */
function buildAggregate(
  root: Tag,
  irImports: readonly IrImport[],
  source: string,
  file: string,
  diagnostics: Diagnostic[],
  importDetails: Map<Import, ParsedImport>,
  folder: string,
  declaredFile: (from: string) => DeclaredFile | undefined,
  declaredNames: Map<CommandRef | DeclarationRef, string>,
  inline: { events: EventDeclaration[]; commands: CommandDeclaration[] },
  propPositions: Map<AggregatePart, SourcePosition>,
): Aggregate {
  const { at, pos, fail } = attributeReaders(source, file, diagnostics);
  const sections = tags(root.children);
  const section = (name: string) => sections.find((t) => t.name === name);
  const name = declaredName(root);
  const { module, bareUnderscore } = moduleOfFolder(folder);
  if (bareUnderscore)
    fail("MESH_GROUP_NAME", `Group folder "_" has no name; write "_" followed by a name, such as "_services"`, root);
  for (const segment of module ? module.split("/") : []) {
    if (!/^[A-Za-z0-9_-]+$/.test(segment))
      fail("MESH_MODULE_NAME", `Module segment ${JSON.stringify(segment)} must contain only letters, digits, - or _`, root);
  }
  const fqn = [...module.split("/").filter(Boolean), name].join(".");
  const self = `./${basename(file)}`;
  const inlineDeclared = inlineDeclarationsOf(declaredFile, self);
  const ownEvents = inlineDeclared.filter((declaration) => declaration.kind === "event").map(({ name }) => ({ name, from: self }));
  const ownCommands = inlineDeclared.filter((declaration) => declaration.kind === "command").map(({ name }) => ({ name, from: self }));
  const ownKind = new Map<string, DeclarationKind>(inlineDeclared.map(({ kind, name }) => [name, kind] as const).reverse());
  const { imports, importNames, duplicates, bindings } = fileImports(irImports, file, ownKind, importDetails, declaredFile, at, fail);
  // An aggregate file imports Mesh files only: its handler bodies, its only functions, call actions of the entities it
  // imports, and a helper or `Mesh` stays out until a ruling admits one (handlers PR 1, deviation 7).
  const refused = imports.filter((entry) => entry.helper || entry.mesh);
  for (const entry of refused)
    fail("MESH_UNKNOWN_IMPORT", `An aggregate file imports only ${meshExtensionsText} files: its handlers call actions of the entities it imports, not ${entry.mesh ? "`Mesh`" : "a helper"}`, entry.position, "remove the import");
  const aggregate: Aggregate = {
    name,
    fqn,
    file,
    module,
    imports: imports.filter((entry) => !refused.includes(entry)),
    root: { entity: { identifier: "", from: "" }, position: pos(root) },
    parts: [],
    position: pos(root),
  };
  // The root and the parts are entities of other files: the aggregate declares none of its own.
  const references: ReferenceScope = { imports: importNames, duplicates, own: [], self };
  const entityKind = referenceKind("entity", declaredFile);
  const entityRef = (written: WrittenReference | undefined) => {
    const target = written ? resolveReference(written, references, entityKind) : undefined;
    if (target && !target.ok && "code" in target) fail(target.code, target.message, at(target.offset), target.fix);
    return { identifier: written ? referenceText(written) : "", from: target?.ok ? target.from : "" };
  };
  // MX requires the line and refuses a second one, and the `root` contract refuses a value that is no bare reference.
  const rootTag = section("root");
  if (rootTag) aggregate.root = { entity: entityRef(writtenReference(nodeOf(attr(rootTag, "entity")))), position: pos(rootTag) };
  for (const line of tags(section("entities")?.children ?? [])) {
    // MX lowers a parameter on a wildcard line, and a wildcard entry takes no `analyze` hook: the contracts' wrapper is not reached.
    if (line.params.length || line.var) {
      fail("MESH_SYNTAX", `\`${line.name}\`: tag parameters and variable bindings are not entity declarations`, line);
      continue;
    }
    const written = lineHeadReference(line);
    if (!written) {
      fail("MESH_ENTITY_REFERENCE", `${line.name} is not an entity reference: a part is an imported entity's identifier (\`Comment\`) or a member of a namespace import (\`talk.Comment\`)`, line);
      continue;
    }
    const propAttr = attr(line, "prop");
    const prop = atomOf(propAttr)?.name;
    const part: AggregatePart = { entity: entityRef(written), ...(prop !== undefined ? { prop } : {}), position: pos(line) };
    if (prop !== undefined && propAttr) propPositions.set(part, at(attrOffset(propAttr)));
    aggregate.parts.push(part);
  }
  Object.assign(aggregate, ownerSections(section, {
    file, self, owner: fqn, ownNames: [], source, diagnostics, module,
    events: { scope: { imports: importNames, duplicates, own: ownEvents, self }, kind: referenceKind("event", declaredFile, "MESH_UNKNOWN_EVENT") },
    commands: { scope: { imports: importNames, duplicates, own: ownCommands, self }, kind: referenceKind("command", declaredFile) },
    inline, declaredNames,
  }));
  // A handler of the aggregate is keyed by its FQN, and its body sees what a function of an entity file sees but the
  // entity: the entities, events and commands the file imports, and the events and commands it declares inline.
  const handlersSection = section("handlers");
  if (handlersSection) {
    const eventReferences: ReferenceScope = { imports: importNames, duplicates, own: ownEvents, self };
    const commandReferences: ReferenceScope = { imports: importNames, duplicates, own: ownCommands, self };
    const boundTo = boundToOf(bindings, declaredFile);
    const ownNames = [...ownEvents, ...ownCommands].map(({ name }) => name);
    const memberKind = memberKindOf(declaredFile);
    const read = readHandlers(handlersSection, {
      file, owner: fqn, at, pos, fail, declaredNames,
      events: { scope: eventReferences, kind: referenceKind("event", declaredFile, "MESH_UNKNOWN_EVENT") },
      body: (a) => expression(a, source, at, () => {}, () => {}, {
        helpers: new Map(),
        imported: new Set([...importNames.keys(), ...duplicates, ...ownNames]),
        entities: new Set(boundTo("entity")),
        namespaces: new Set(bindings.filter(({ entry }) => entry.namespace).map(({ name }) => name)),
        reference: (written) => resolveReference(written, references, entityKind),
        memberReference: (written) => resolveReference(written, references, memberKind),
        events: new Set([...boundTo("event"), ...ownEvents.map(({ name }) => name)]),
        commands: new Set([...boundTo("command"), ...ownCommands.map(({ name }) => name)]),
        eventReference: (written) => resolveReference(written, eventReferences, referenceKind("event", declaredFile)),
        commandReference: (written) => resolveReference(written, commandReferences, referenceKind("command", declaredFile)),
        duplicates,
        mesh: new Set(),
        report: (d) => {
          if (!diagnostics.some((x) => x.code === d.code && x.position.file === d.position.file && x.position.offset === d.position.offset)) diagnostics.push(d);
        },
        handlerBody: true,
        noHelpers: true,
      }),
    });
    if (read.length) aggregate.handlers = read;
  }
  return aggregate;
}

/**
 * A surface file (`notes/spec/other-file-kinds.md`, "Surface files"; ADR-0077, ADR-0095): `surface :name`, then one
 * `expose` line per entity the audience may reach, each with its `action` lines. The file imports Mesh files only:
 * it holds no function, so a helper, a package or `meshfw` is `MESH_UNKNOWN_IMPORT` (OD5); where an import of it may
 * point is the import check's (`buildModel`). `entity=` resolves as a relationship's does, with no own declaration;
 * what needs the built entities (the entity's FQN, its actions and fields) is `resolveSurfaces`' (`model/surfaces.ts`).
 */
function buildSurface(
  root: Tag,
  irImports: readonly IrImport[],
  source: string,
  file: string,
  absolute: string,
  diagnostics: Diagnostic[],
  importDetails: Map<Import, ParsedImport>,
  declaredFile: (from: string) => DeclaredFile | undefined,
): { surface: Surface; imports: Import[]; pending: PendingSurface } {
  const { at, pos, fail } = attributeReaders(source, file, diagnostics);
  const meshImports = irImports.filter((entry) => {
    const from = entry.from ?? "";
    if ((from.startsWith("./") || from.startsWith("../")) && hasMeshExtension(from)) return true;
    fail("MESH_UNKNOWN_IMPORT", `A surface file imports only ${meshExtensionsText} files of the domain: its lines name entities and events, and it holds no function`, at(entry.span.sourceStart), "remove the import");
    return false;
  });
  const { imports, importNames, duplicates, bindings } = fileImports(meshImports, file, new Map(), importDetails, declaredFile, at, fail);
  for (const { entry, index, name } of bindings)
    if (/^(\$|l\$)/.test(name)) {
      const localOffset = importDetails.get(entry)?.bindings[index]?.localOffset;
      fail("MESH_HELPER_NAME", `The entity import name ${name} cannot start with $ or l$: generated code uses those prefixes for its own names`, localOffset === undefined ? entry.position : at(localOffset));
    }
  const prototypeName = (name: string, what: string, tag: Tag) => {
    if (name === PROTOTYPE_SETTING_NAME)
      fail("MESH_NAME", `:${name} cannot be ${what}: __proto__ sets an object's prototype instead of adding a property. Choose another name.`, tag);
  };
  const surface: Surface = { name: atomOf(attr(root, "name"))?.name ?? "", file, expose: [], position: pos(root) };
  prototypeName(surface.name, "a surface name", root);
  const references: ReferenceScope = { imports: importNames, duplicates, own: [], self: `./${basename(file)}` };
  const entityKind = referenceKind("entity", declaredFile);
  const pending: PendingSurface = { surface, exposures: [], publishes: [] };
  for (const line of tags(root.children)) {
    if (line.name !== "expose") continue;
    const written = writtenReference(nodeOf(attr(line, "entity")));
    const target = written ? resolveReference(written, references, entityKind) : undefined;
    if (target && !target.ok && "code" in target) fail(target.code, target.message, at(target.offset), target.fix);
    const fieldsAttr = attr(line, "fields");
    const fieldSpans = [...atomForwards(fieldsAttr)].map(([forward, span]) => ({ name: String((forward as { value?: unknown }).value), position: at(span.sourceStart) }));
    const listed = atomOf(fieldsAttr)?.name === "all" ? "all" : fieldSpans.map(({ name }) => name);
    const label = textOf(attr(line, "label"));
    const exposure: Exposure = {
      name: atomOf(attr(line, "name"))?.name ?? "",
      entity: "",
      identifier: written ? referenceText(written) : "",
      ...(label !== undefined ? { label } : {}),
      fields: listed,
      actions: tags(line.children).filter((action) => action.name === "action")
        .map((action) => ({ name: atomOf(attr(action, "name"))?.name ?? "", position: pos(action) })),
      position: pos(line),
    };
    prototypeName(exposure.name, "an exposed name", line);
    surface.expose.push(exposure);
    const entry: PendingExposure = { exposure, fields: listed === "all" ? [] : fieldSpans };
    if (target?.ok) entry.target = resolve(dirname(absolute), target.from);
    pending.exposures.push(entry);
  }
  // The `publishes` section (R20, R21): one listing line per event, resolved as an owner's `events` listing is. One file may
  // declare several events (inline in an owner's sections), so a line is kept by the file its head points to and the name
  // that file gives the event; `resolveSurfaces` finds the event by both. One event listed twice, under one name or two, is
  // a duplicate at the later line, which is not kept.
  const section = tags(root.children).find((line) => line.name === "publishes");
  if (section) {
    surface.publishes = [];
    const listedEventKind = referenceKind("event", declaredFile, "MESH_UNKNOWN_EVENT");
    const seen = new Set<string>();
    for (const line of tags(section.children)) {
      // MX lowers a parameter on a wildcard line, and a wildcard entry takes no `analyze` hook: the contracts' wrapper is not reached.
      if (line.params.length || line.var) {
        fail("MESH_SYNTAX", `\`${line.name}\`: tag parameters and variable bindings are not entity declarations`, line);
        continue;
      }
      const written = lineHeadReference(line);
      if (!written) {
        fail(listedEventKind.code, `${line.name} is not an imported event: a listing is an imported identifier (\`InvoicePaid\`) or a member of a namespace import (\`notices.InvoiceOverdue\`)`, line);
        continue;
      }
      const resolved = resolveReference(written, references, listedEventKind);
      if (!resolved.ok) {
        if ("code" in resolved) fail(resolved.code, resolved.message, at(resolved.offset), resolved.fix);
        continue;
      }
      const target = resolve(dirname(absolute), resolved.from);
      const key = `${target}#${resolved.declared}`;
      if (seen.has(key)) {
        fail("MESH_DUPLICATE_MEMBER", `${referenceText(written)} is listed twice in the publishes section of surface ${surface.name}`, line, "remove one");
        continue;
      }
      seen.add(key);
      const event: PublishedEvent = { identifier: referenceText(written), fqn: "", position: pos(line) };
      surface.publishes.push(event);
      pending.publishes.push({ event, target, declared: resolved.declared });
    }
  }
  return { surface, imports, pending };
}

/**
 * An event or a command: a file of its own whose root line declares it and whose children are field lines
 * (`notes/spec/events-and-commands.md`, "Events" and "Commands"). A field line is an attribute line with the options that
 * constrain a value only: `nullable`, `values`, `min`, `max` and `match`, `message` and `code` beside a rule (ADR-0092),
 * plus `optional` for commands. What concerns storage or creation, `default`,
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
  const { at, fail } = attributeReaders(source, file, diagnostics);
  const { module, bareUnderscore } = moduleOfFolder(folder);
  if (bareUnderscore)
    fail("MESH_GROUP_NAME", `Group folder "_" has no name; write "_" followed by a name, such as "_services"`, root);
  for (const segment of module ? module.split("/") : []) {
    if (!/^[A-Za-z0-9_-]+$/.test(segment))
      fail("MESH_MODULE_NAME", `Module segment ${JSON.stringify(segment)} must contain only letters, digits, - or _`, root);
  }
  for (const entry of irImports)
    fail("MESH_UNKNOWN_IMPORT", `${root.name === "event" ? "An event" : "A command"} file takes no import: its fields are attribute lines, whose kinds are attribute types`, at(entry.span.sourceStart), "remove the import");
  return buildDeclarationBody(root, source, file, diagnostics, module);
}

/**
 * An event's or a command's name and field lines, wherever the line is: the root of a file of its own (`buildDeclaration`,
 * which checks the file's folder and imports first), or an inline declaration of an owner's section, whose file the owner
 * already checked and whose imports are the owner file's.
 */
function buildDeclarationBody(
  root: Tag,
  source: string,
  file: string,
  diagnostics: Diagnostic[],
  module: string,
): EventDeclaration | CommandDeclaration {
  const { at, pos, fail, opt, shape, conceptUse, checkShape, checkRuleText } = attributeReaders(source, file, diagnostics);
  const name = declaredName(root);
  // The name is PascalCase or is made so (`event :invoicePaid` is the class `InvoicePaid`): no warning about the spelling.
  // `invoice_paid` is the class `InvoicePaid` (`notes/spec/names.md`); a name that makes no identifier (`_1`) is an error.
  if (!isClassName(classNameOf(name)))
    fail("MESH_NAME", `${root.name === "event" ? "Event" : "Command"} :${name} makes no class name: Mesh drops each \`_\` and capitalises the letter after it, so the name needs a letter, such as :${root.name === "event" ? "InvoicePaid" : "PayInvoice"}`, root);
  const fields: Field[] = [];
  const names = new Set<string>();
  for (const tag of tags(root.children)) {
    // A concept use (`Money :total`) takes no option but `nullable` and a command's `optional`, so nothing is checked.
    const use = tag.definedIn !== undefined ? conceptUse(tag) : undefined;
    if (tag.definedIn !== undefined && !use) continue;
    const optional = root.name === "command" && opt(tag, "optional") === true;
    let field: Field;
    if (use) {
      field = { ...use, ...(optional && !use.nullable ? { optional: true as const } : {}) };
    } else {
      for (const key of FIELD_OPTIONS_REFUSED) {
        const refused = attr(tag, key);
        if (refused)
          fail("MESH_UNKNOWN_OPTION", `\`${key}\` is not an option of a field of ${root.name === "event" ? "an event" : "a command"}: a field has no row behind it, so it takes the options that constrain a value (\`nullable\`, \`values\`, \`min\`, \`max\`, \`match\`) and none that concern storage or creation`, at(attrOffset(refused)), `remove \`${key}\``);
      }
      const shaped = shape(tag);
      // `default` is refused above; what it holds is not checked against the type as well.
      checkShape({ ...shaped, default: undefined });
      checkRuleText(tag, shaped);
      // `default`, which `shape` reads, is no part of a field.
      const { name: fieldName, type, nullable, values, min, max, match, ruleMessage, ruleCode, position } = shaped;
      field = { name: fieldName, type, nullable, ...(optional && !nullable ? { optional: true as const } : {}), ...(values ? { values } : {}), ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(match ? { match } : {}), ...(ruleMessage !== undefined ? { ruleMessage } : {}), ...(ruleCode !== undefined ? { ruleCode } : {}), position };
    }
    if (names.has(field.name)) fail("MESH_DUPLICATE_MEMBER", `Duplicate member :${field.name}`, tag);
    // The generated class has a property per field: `__proto__` would set the prototype, and a class cannot have a field named `constructor`.
    if (field.name === PROTOTYPE_SETTING_NAME || field.name === "constructor")
      fail("MESH_ATTRIBUTE_NAME", `:${field.name} cannot be a field name: ${field.name === "constructor" ? "the generated class has its constructor under that name" : "__proto__ sets an object's prototype instead of adding a property"}. Choose another name.`, tag);
    names.add(field.name);
    fields.push(field);
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

/** The name MX gives the tag of a file: its file name less the longest Mesh extension (the file `Money` of `concepts/` names the tag `Money`). */
export function tagNameOfFile(path: string): string {
  const name = basename(path);
  const extension = [...MESH_EXTENSIONS].sort((a, b) => b.length - a.length).find((each) => name.endsWith(each));
  return extension ? name.slice(0, -extension.length) : name;
}
/** Whether a file sits directly in a folder named `concepts`, where MX finds concept files (R10). */
export const inConceptsFolder = (path: string): boolean => basename(dirname(path)) === "concepts";

/**
 * A concept file (`concept :Money` and its field lines; `notes/spec/other-file-kinds.md`, "Concept files"; ruling D36).
 * What its IR alone shows is checked by `conceptFileProblems`, the concept hook's own check, so a problem MX also reports
 * through a use is reported once. Then what only the build sees: where the file sits (`MESH_CONCEPT_PLACE`, case a), its
 * imports (none), its module, and the field lines, read as an event's are, with the options that concern storage or
 * creation refused. `folder` is the file's folder below the domain root; the module is the folder above `concepts`.
 */
function buildConcept(
  root: Tag,
  body: IrBody,
  irImports: readonly IrImport[],
  source: string,
  file: string,
  absolute: string,
  diagnostics: Diagnostic[],
  folder: string,
): ConceptDeclaration {
  const { at, pos, fail, shape, conceptUse, checkShape } = attributeReaders(source, file, diagnostics);
  for (const problem of conceptFileProblems(body, tagNameOfFile(absolute), absolute))
    fail(problem.code, problem.message, at(problem.offset));
  if (!inConceptsFolder(absolute)) {
    // Into the `concepts` folder above it when there is one (a file in `concepts/finance/`: MX's scan is not recursive,
    // R10), else into a new one beside it.
    const written = folder === "" ? basename(file) : `${folder}/${basename(file)}`;
    const segments = folder === "" ? [] : folder.split("/");
    const above = segments.lastIndexOf("concepts");
    // Under the declared name when that is a legal concept name, so the moved file does not fail R5 or R6.
    const declared = atomOf(attr(root, "name"))?.name;
    const target = declared !== undefined && PASCAL_CASE.test(declared) ? `${declared}${MESH_EXTENSIONS[0]}` : basename(file);
    const moved = above >= 0 ? [...segments.slice(0, above + 1), target].join("/") : [...segments, "concepts", target].join("/");
    fail("MESH_CONCEPT_PLACE", `A concept file sits directly in a folder named \`concepts\`, where Mesh finds it: move ${written} to ${moved}`, root);
  }
  for (const entry of irImports)
    fail("MESH_UNKNOWN_IMPORT", "A concept file takes no import: its fields are attribute types and concepts", at(entry.span.sourceStart), "remove the import");
  const { module, bareUnderscore } = moduleOfFolder(inConceptsFolder(absolute) ? normalizePath(dirname(folder)) : folder);
  if (bareUnderscore)
    fail("MESH_GROUP_NAME", `Group folder "_" has no name; write "_" followed by a name, such as "_services"`, root);
  for (const segment of module ? module.split("/") : []) {
    if (!/^[A-Za-z0-9_-]+$/.test(segment))
      fail("MESH_MODULE_NAME", `Module segment ${JSON.stringify(segment)} must contain only letters, digits, - or _`, root);
  }
  const name = atomOf(attr(root, "name"))?.name ?? tagNameOfFile(absolute);
  const fields: Field[] = [];
  for (const tag of tags(root.children)) {
    // A concept use inside a concept (`Money :net`), resolved from the concept file's own folder (R13).
    if (tag.definedIn !== undefined) {
      const use = conceptUse(tag);
      if (use) fields.push(use);
      continue;
    }
    for (const key of FIELD_OPTIONS_REFUSED) {
      const refused = attr(tag, key);
      if (refused)
        fail("MESH_UNKNOWN_OPTION", `\`${key}\` is not an option of a field of a concept: a field has no row behind it, so it takes the options that constrain a value (\`nullable\`, \`values\`, \`min\`, \`max\`, \`match\`) and none that concern storage or creation`, at(attrOffset(refused)), `remove \`${key}\``);
    }
    const field = shape(tag);
    checkShape({ ...field, default: undefined });
    // Two fields of one name and a `__proto__` field are `conceptFileProblems`'; `optional` is `checkFieldOptions`'.
    const { name: fieldName, type, nullable, values, min, max, match, position } = field;
    fields.push({ name: fieldName, type, nullable, ...(values ? { values } : {}), ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(match ? { match } : {}), position });
  }
  return {
    name,
    fqn: [...module.split("/").filter(Boolean), name].join("."),
    file,
    module,
    fields,
    position: pos(root),
  };
}

/**
 * `set &total=<literal>` on a concept member, in a `do` and in an `always` block (ruling D36): the literal is an object
 * with exactly the concept's fields, each fitting its field, or `null` on a nullable member, else `MESH_SET_VALUE`. Run once
 * every concept is built, since the entity's file may come before the concept's. A function value is not checked here.
 */
function checkConceptLiterals(entities: readonly Entity[], concepts: readonly ConceptDeclaration[], diagnostics: Diagnostic[]): void {
  if (!concepts.length) return;
  const byFqn = new Map<string, ConceptDeclaration>();
  for (const concept of concepts) if (!byFqn.has(concept.fqn)) byFqn.set(concept.fqn, concept);
  const resolveConcept = (fqn: string) => byFqn.get(fqn);
  for (const entity of entities) {
    const visit = (steps: readonly Step[]) => {
      for (const step of steps) {
        if (step.kind === "when") visit(step.steps);
        if (step.kind !== "set") continue;
        for (const { member, value } of step.assignments) {
          const field = entity.attributes.find((attribute) => attribute.name === member.name);
          if (field?.type !== "concept" || isExpression(value)) continue;
          const json = jsonAtomPath(value, field, resolveConcept);
          if (json !== undefined) {
            diagnostics.push(error("MESH_SET_VALUE", `\`&${member.name}=\` is json at \`${json}\`, and an atom is not JSON: write a string`, member.position));
            continue;
          }
          if (literalFits(value, field, resolveConcept, isAtomLiteral)) continue;
          const concept = resolveConcept(field.concept!);
          diagnostics.push(error("MESH_SET_VALUE",
            `\`&${member.name}=\` needs an object literal with exactly the fields of ${field.concept}${concept ? ` (${concept.fields.map((each) => each.name).join(", ")})` : ""}${field.nullable ? ", null" : ""}, or a function`,
            member.position));
        }
      }
    };
    for (const action of entity.actions) visit(action.do);
    for (const block of entity.always) visit(block.do);
  }
}

/**
 * The dotted path of the first `json` field of a concept literal (nested concepts included) that holds an atom the author
 * wrote, as `set &meta=:x` on a `json` member is refused; `undefined` when there is none, or the literal is not an object.
 */
function jsonAtomPath(value: Literal | Atom, field: Pick<Attribute, "type" | "concept">, resolve: (fqn: string) => ConceptDeclaration | undefined, prefix = ""): string | undefined {
  const concept = field.concept === undefined ? undefined : resolve(field.concept);
  if (!concept || typeof value !== "object" || value === null || Array.isArray(value) || isAtomLiteral(value)) return undefined;
  for (const each of concept.fields) {
    if (!Object.hasOwn(value, each.name)) continue;
    const inner = (value as Record<string, Literal | Atom>)[each.name]!;
    const path = `${prefix}${each.name}`;
    if (each.type === "json" && holdsAtom(inner, isAtomLiteral)) return path;
    if (each.type === "concept") {
      const found = jsonAtomPath(inner, each, resolve, `${path}.`);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * The FQN of the concept each concept use resolved to, keyed by the use's IR node (set by `conceptUses`, read by
 * `conceptUse`). A use that is refused (tag parameters, a concept file the build does not read) has no entry and builds no
 * member. Keyed weakly by node, so a build's entries go with its IR.
 */
const CONCEPT_OF_USE = new WeakMap<Tag, string>();
/** The concept a use's head names, by the absolute path MX's scan gave it (`DelegatedTag.definedIn`). */
interface ConceptEntry {
  readonly name: string;
  readonly fqn: string;
  readonly file: string;
}
/**
 * Every concept use of a file (`Money :total`: a tag MX resolved from a concept file, `definedIn` set), at any depth. A
 * contract a tag file gives carries no `analyze` hook and `afterLower` sees no tag parameters, so the one universal check
 * of `contracts.ts` that MX does not make itself on such a call, tag parameters (`Money|x| :total`), is made here, in its
 * words (R22); MX refuses a tag variable, a bound option and a name that is no atom from the use's contract. A use of a concept file the build does not read (outside the domain
 * root, or excluded by \`ignore\`) is `MESH_CONCEPT_PLACE`. Any other use resolves to its concept's FQN, which
 * `CONCEPT_OF_USE` keeps for the builders (`conceptUse`): the member or field it declares holds that concept.
 */
function conceptUses(
  body: IrBody,
  source: string,
  file: string,
  diagnostics: Diagnostic[],
  conceptAt: (path: string) => ConceptEntry | undefined,
  outside: (path: string) => string,
  domainLabel: string,
): void {
  const at = (offset: number) => positionAt(source, file, offset);
  const visit = (tag: Tag) => {
    if (tag.definedIn !== undefined) {
      const head = at(tag.nameSpan?.sourceStart ?? 0);
      const before = diagnostics.length;
      if (tag.params.length || tag.var) diagnostics.push(error("MESH_SYNTAX", SYNTAX_MESSAGES.params, head));
      if (diagnostics.length === before) {
        const entry = conceptAt(tag.definedIn);
        if (!entry)
          diagnostics.push(error("MESH_CONCEPT_PLACE", `${tag.name} is declared in ${outside(tag.definedIn)}, which the build does not read (outside the domain root ${domainLabel}, or excluded by \`ignore\`): move it into a \`concepts\` folder under the domain root`, head));
        else CONCEPT_OF_USE.set(tag, entry.fqn);
      }
    }
    for (const child of tags(tag.children ?? [])) visit(child);
  };
  for (const tag of tags(body)) visit(tag);
}

/**
 * The compiler's one MX call (`lowerSource`) with Mesh's dialect, which carries the closed
 * contracts, the tag rules and the strictness (rejection on). It never throws; every problem is a positioned diagnostic.
 * `file` is absolute in a build: MX compares the dialect's marks with those of every dialect the project installs only
 * when the file name is absolute and its nearest `package.json` is found (MX 0.1.0-alpha.34), so a build fails on a
 * clash exactly where the editor reports it. A diagnostic of the parsed file carries no file name, so the caller
 * positions it in the project-relative file.
 *
 * The concepts in scope come from MX's scan (`scanCached`): the tag files of the `concepts` folders up the file's folders,
 * nearest first, which the manifest's `tagDirs` names. `lowerSource` does not scan by itself, so the compiler passes the
 * scan's map as `customTags` (a deviation from ADR-0085's chosen option, recorded in ADR-0092; this is the one place to
 * remove it once MX scans for a dialect's `tagDirs`). A file not on disk scans to an empty map. `extraTags`, merged over
 * the scan, serves a caller that lowers text under a path with no `concepts` folder (the docs fence checks).
 */
/**
 * The targets the scan runs under: none. `ScanOptions.targets` tells a host's module file from a tag template; a Mesh
 * file is data, compiled under no host, and a concept file is no template, so every question gets the empty answer.
 */
const NO_TARGETS: TargetLookup = Object.freeze({
  hasTarget: () => false,
  targetNames: () => [],
  target: () => undefined,
  defaultTarget: () => "data",
  fromPackage: () => undefined,
  attrTagSources: () => [],
  hostValues: () => [],
  hostTarget: () => undefined,
  hostOf: () => undefined,
  hostFilterKey: () => undefined,
  moduleSegments: () => [],
});
export function parseEntitySource(source: string, file: string, extraTags?: Readonly<Record<string, CustomTag>>) {
  const scan = scanCached(file, { targets: NO_TARGETS });
  const customTags = extraTags ? { ...scan.customTags, ...extraTags } : scan.customTags;
  const lowered = lowerSource(source, file, {
    dialect: MESH_DIALECT,
    ...(Object.keys(customTags).length > 0 ? { customTags } : {}),
  });
  return { ...lowered, scanDiagnostics: scan.diagnostics ?? [] };
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
/**
 * A diagnostic MX positions in another file (`IrDiagnostic.file`, a tag template's, a sidecar's, a concept's) is reported
 * in that file when it is one of the project's entity files, with its offset counted in that file's text (MX gives
 * `offset: -1` there). Any other file is named at the end of the message, and the diagnostic sits at 1:0 of the file
 * being lowered: its position cannot be given in a file the build has not read (`otherFileResolver`).
 */
export function meshDiagnostic(
  d: MxDiagnostic,
  file: string,
  otherFile: (path: string) => OtherFile = (path) => ({ kind: "unread", name: path }),
): Diagnostic {
  const base = { severity: d.severity, code: d.code ?? "MESH_SYNTAX", fix: staticFileFix(d) ?? relationshipValueFix(d) };
  if (d.file === undefined)
    return { ...base, message: d.message, position: { file, line: d.line, column: d.column, offset: d.offset } };
  const other = otherFile(d.file);
  if (other.kind === "project")
    return {
      ...base,
      message: d.message,
      position: { file: other.file, line: d.line, column: d.column, offset: offsetAt(other.source, d.line, d.column) },
    };
  return { ...base, message: `${d.message} (in \`${other.name}\`)`, position: { file, line: 1, column: 0, offset: 0 } };
}

/**
 * A diagnostic of MX's scan (`ScanDiagnostic`) as one `lowerSource` reports, for `meshDiagnostic`: its file and its line
 * and column there. Its code is MX's and not yet renamed (the dialect renames only `lowerSource`'s), so it goes through
 * `MX_TO_MESH_CODES` here. A concept file named like a Mesh tag (`MX_RESERVED_TAG`, R14) is `MESH_RESERVED_TAG` in Mesh's
 * words; the reserved tag keeps its meaning.
 */
export function scanDiagnostic(d: ReturnType<typeof scanCached>["diagnostics"][number]): MxDiagnostic {
  const code = d.code === undefined ? undefined : (MX_TO_MESH_CODES as Record<string, string>)[d.code] ?? d.code;
  const name = tagNameOfFile(d.file);
  const message = d.code === "MX_RESERVED_TAG" && hasMeshExtension(d.file)
    ? `${name} is a Mesh tag, so a concept file cannot take its name: rename ${conceptFileLabel(d.file)} and its \`concept :${name}\` line`
    : d.message;
  return { severity: d.severity ?? "warning", code, message, line: d.line, column: d.column, offset: -1, file: d.file } as MxDiagnostic;
}

/** Where an MX diagnostic's `file` lands: a project entity file (its project-relative path and text), or a name for the message. */
export type OtherFile =
  | { readonly kind: "project"; readonly file: string; readonly source: string }
  | { readonly kind: "unread"; readonly name: string };

/**
 * Looks up a path MX gives in `IrDiagnostic.file` among the project's entity files (`sources`, keyed by absolute path
 * under `rootPath` as given). MX gives absolute paths with the directories realpathed, so a path under the root's
 * realpath is rebased onto the root as given (on macOS `/tmp` is `/private/tmp`). A path inside the root that is not a
 * project file is named project-relative. The root itself (it has no project-relative name), a path outside the root,
 * a relative one (no known producer: MX would resolve it against a cwd the build cannot know) and a foreign absolute
 * one are named as given.
 */
export function otherFileResolver(
  rootPath: string,
  sources: ReadonlyMap<string, { readonly file: string; readonly source: string }>,
): (path: string) => OtherFile {
  let realRoot = rootPath;
  try {
    realRoot = realpathSync(rootPath);
  } catch {
    // A virtual project: the root is not a directory on disk.
  }
  return (path) => {
    const given = normalizePath(path);
    if (!absolutePath(given) || foreignAbsolute(given)) return { kind: "unread", name: given };
    const absolute = inside(rootPath, given) ? resolve(given)
      : inside(realRoot, given) ? resolve(rootPath, relative(realRoot, given))
      : null;
    if (absolute === null) return { kind: "unread", name: given };
    const hit = sources.get(absolute);
    if (hit) return { kind: "project", ...hit };
    // The root itself has no project-relative name (`relative` gives ""), so it is named as given.
    const name = normalizePath(relative(rootPath, absolute));
    return { kind: "unread", name: name === "" ? given : name };
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

/**
 * MX reports a relationship line with a default value (`belongs-to=:List :list`, the syntax-v3 form, or the unspaced name
 * `belongs-to=:list`) as the unknown option `value`. Since the operator's ruling of 2026-10-08 a relationship is
 * `kind :name entity=Identifier`. MX owns the message, so this is a `fix:` line beside it, as `staticFileFix` is. The fix
 * keeps `<name>` and `<Entity>` as placeholders: the atom after `=` may be either (`belongs-to=:list entity=List`).
 */
// Matches MX's wording since alpha.31; the corpus golden pins it (`test/mesh-corpus.test.ts`, the old-relationship fixture).
const RELATIONSHIP_VALUE = new RegExp(`^\`(${RELATIONSHIP_KINDS.join("|")})\`: unknown option \`value\``);
export function relationshipValueFix(d: Pick<MxDiagnostic, "code" | "message">): string | null {
  if (d.code !== "MESH_UNKNOWN_OPTION") return null;
  const kind = RELATIONSHIP_VALUE.exec(d.message)?.[1];
  return kind === undefined
    ? null
    : `a relationship takes no value after \`=\`: write its name after a space and its entity as an option, \`${kind} :<name> entity=<Entity>\``;
}

/** Parse with closed MX contracts, then project the static tree without executing it. */
export function buildModel(project: ProjectDescription): BuildResult {
  const diagnostics: Diagnostic[] = [];
  const document: ModelDocument = { entities: [] };
  const rollups: PendingRollup[] = [];
  const importDetails = new Map<Import, ParsedImport>();
  const inversePositions = new Map<Relationship, SourcePosition>();
  const throughPositions = new Map<Relationship, SourcePosition>();
  // The name in its declaring file each `on=` and each listing line resolved to: an alias or a namespace member names it
  // otherwise, so the FQN pass reads it here, never from the reference as written.
  const declaredNames = new Map<CommandRef | DeclarationRef, string>();
  // Where each part line's `prop=` is written, for the link errors `resolveAggregates` reports.
  const propPositions = new Map<AggregatePart, SourcePosition>();
  const aggregates: Aggregate[] = [];
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
  // Each file is resolved once, and every file's text is known before the first is lowered: a diagnostic MX positions in
  // another project file (a concept's tag file) is reported there, whichever file is lowered first.
  const resolved = project.files.map((input) => resolveEntityFile(rootPath, input.file));
  const sources = new Map<string, { file: string; source: string }>();
  project.files.forEach((input, i) => {
    const path = resolved[i];
    if (path) sources.set(path.absolute, { file: path.file, source: input.source });
  });
  const virtualFiles = new Set(sources.keys());
  // The surface files (OD1): read from their own folder, kept apart from the domain's files, so `virtualFiles` and every
  // "each domain file parsed" count stay the domain's. Their texts join `sources` only so that a diagnostic MX positions in
  // one of them is reported there.
  const surfacesRoot = project.surfaces && resolve(rootPath, normalizePath(project.surfaces.root));
  const surfacesLabel = surfacesRoot === undefined ? undefined : normalizePath(relative(rootPath, surfacesRoot)) || ".";
  const surfaceInputs = (project.surfaces?.files ?? []).map((input) => ({ input, path: resolveEntityFile(rootPath, input.file) }));
  const surfacePaths = new Set<string>();
  for (const { input, path } of surfaceInputs)
    if (path) {
      surfacePaths.add(path.absolute);
      sources.set(path.absolute, { file: path.file, source: input.source });
    }
  const otherFile = otherFileResolver(rootPath, sources);
  // Every file is parsed before any is built: a reference through a namespace import (`billing.Invoice`) is
  // checked against what the imported file declares.
  const parsedFiles: { input: (typeof project.files)[number]; path: NonNullable<ReturnType<typeof resolveEntityFile>>; ir: NonNullable<ReturnType<typeof parseEntitySource>["ir"]> }[] = [];
  const declaredByPath = new Map<string, DeclaredFile>();
  const events: EventDeclaration[] = [];
  const commands: CommandDeclaration[] = [];
  const services: Service[] = [];
  // The concept files, by the absolute path MX's scan names them by (`DelegatedTag.definedIn`, realpathed), filled before
  // any declaration is built, so a use resolves whatever the file order. A concept whose body has errors is entered too: a
  // use of it is MX's `MESH_TAG_FILE_ERROR`, never a "not read" `MESH_CONCEPT_PLACE`.
  const conceptIndex = new Map<string, ConceptEntry>();
  // The project's mixin files that parsed, by absolute path (R1, R9), and the entities that use each, by its file (R19).
  const mixinsByPath = new Map<string, MixinSource>();
  const includersOf = new Map<string, Set<string>>();
  const realPath = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  // A scan diagnostic (a concept file named like a Mesh tag) comes with every file the scan covers: reported once a build,
  // and only about a file the build reads (OD4: a concept file outside the domain root, or excluded by `ignore`, is not
  // the build's, and a use of one is case c of `MESH_CONCEPT_PLACE`).
  const scanReported = new Set<string>();
  for (const [i, input] of project.files.entries()) {
    const path = resolved[i];
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
      ...parsed.diagnostics.map((d) => meshDiagnostic(d, path.file, otherFile)),
    );
    for (const d of parsed.scanDiagnostics) {
      if (otherFile(d.file).kind !== "project") continue;
      const key = `${d.file}\0${d.message}`;
      if (scanReported.has(key)) continue;
      scanReported.add(key);
      diagnostics.push(meshDiagnostic(scanDiagnostic(d), path.file, otherFile));
    }
    if (!parsed.ir) continue;
    parsedFiles.push({ input, path, ir: parsed.ir });
    // The root line decides what the file declares (`notes/spec/file-kinds.md`): its kind, and the names of the roots of that kind,
    // each as Mesh converts it (`entity :todo` declares `Todo`): the name an import of the file takes. An aggregate's name is
    // kept as written and binds nothing. Then each event and command an entity's or an aggregate's owner sections declare
    // inline, in written order, by class name: an import takes those too.
    const roots = tags(parsed.ir.body);
    const kind = DECLARING_ROOTS.has(roots[0]?.name ?? "") ? roots[0]!.name as DeclarationKind : "entity";
    // A mixin file (R1): its lines are read into each entity that uses it, unless the file did not parse, in which case a
    // `use` of it reports nothing more than the parse error (R9).
    const mixinName = kind === "mixin" ? atomOf(attr(roots[0]!, "name"))?.name : undefined;
    if (mixinName !== undefined && !parsed.diagnostics.some((d) => d.severity === "error"))
      mixinsByPath.set(resolve(rootPath, path.file), { name: mixinName, root: roots[0]!, source: input.source, file: path.file });
    const named = (tag: Tag) => atomOf(attr(tag, "name"))?.name ?? [];
    if (kind === "concept") {
      const name = atomOf(attr(roots[0]!, "name"))?.name ?? tagNameOfFile(path.absolute);
      const folder = normalizePath(relative(domainRoot, dirname(path.absolute)));
      const module = moduleOfFolder(inConceptsFolder(path.absolute) ? normalizePath(dirname(folder)) : folder).module;
      conceptIndex.set(realPath(path.absolute), { name, fqn: [...module.split("/").filter(Boolean), name].join("."), file: path.file });
    }
    // The architecture file declares nothing an import may bind (R8), and neither does a surface file.
    const ofKind = kind === "architecture" || kind === "surface" ? [] : roots.filter((root) => root.name === kind);
    declaredByPath.set(resolve(rootPath, path.file), {
      kind,
      declares: [
        ...ofKind.flatMap(named).map((name) => ({ kind, name: kind === "aggregate" || kind === "concept" || kind === "mixin" ? name : classNameOf(name) })),
        ...(kind === "entity" || kind === "aggregate" ? ofKind : []).flatMap((root) =>
          tags(root.children).filter((section) => section.name === "events" || section.name === "commands").flatMap((section) =>
            tags(section.children).filter((line) => line.name === (section.name === "events" ? "event" : "command"))
              .flatMap((line) => [named(line)].flat().map((name) => ({ kind: line.name as DeclarationKind, name: classNameOf(name) }))))),
      ],
    });
  }
  // The surface files, parsed as entity files are, into their own list. Each declares nothing an import may bind, whatever
  // its root: the surfaces folder holds surface files only, and the domain never imports one (R4).
  const parsedSurfaces: { source: string; path: NonNullable<ReturnType<typeof resolveEntityFile>>; ir: NonNullable<ReturnType<typeof parseEntitySource>["ir"]> }[] = [];
  for (const { input, path } of surfaceInputs) {
    if (!path) {
      diagnostics.push(error("MESH_ENTITY_PATH", "Surface file path must resolve inside the project", positionAt("", "mesh.config.ts", 0)));
      continue;
    }
    declaredByPath.set(path.absolute, { kind: "surface", declares: [] });
    const parsed = parseEntitySource(input.source, path.absolute);
    diagnostics.push(...parsed.diagnostics.map((d) => meshDiagnostic(d, path.file, otherFile)));
    for (const d of parsed.scanDiagnostics) {
      if (otherFile(d.file).kind !== "project") continue;
      const key = `${d.file}\0${d.message}`;
      if (scanReported.has(key)) continue;
      scanReported.add(key);
      diagnostics.push(meshDiagnostic(scanDiagnostic(d), path.file, otherFile));
    }
    if (parsed.ir) parsedSurfaces.push({ source: input.source, path, ir: parsed.ir });
  }
  const concepts: ConceptDeclaration[] = [];
  const architectureFiles: { root: Tag; imports: readonly IrImport[]; source: string; file: string; absolute: string }[] = [];
  const domainLabel = normalizePath(relative(rootPath, domainRoot)) || ".";
  const outside = (path: string) => {
    const other = otherFile(path);
    return other.kind === "project" ? other.file : other.name;
  };
  // A mixin's concept uses resolve before any entity is built, since each includer reads the mixin's lines (R29: against the
  // `concepts` folder nearest the mixin's file, the same for every includer).
  const isMixinFile = (ir: (typeof parsedFiles)[number]["ir"]) => tags(ir.body)[0]?.name === "mixin";
  for (const { input, path, ir } of parsedFiles)
    if (isMixinFile(ir)) conceptUses(ir.body, input.source, path.file, diagnostics, (definedIn) => conceptIndex.get(realPath(definedIn)), outside, domainLabel);
  for (const { input, path, ir } of parsedFiles) {
    const file = path.file;
    const declared = (from: string) => declaredByPath.get(resolve(rootPath, dirname(file), from));
    const roots = tags(ir.body);
    if (!isMixinFile(ir)) conceptUses(ir.body, input.source, file, diagnostics, (definedIn) => conceptIndex.get(realPath(definedIn)), outside, domainLabel);
    if (roots[0]?.name === "concept") {
      try {
        concepts.push(buildConcept(roots[0], ir.body, ir.imports, input.source, file, path.absolute, diagnostics, normalizePath(relative(domainRoot, dirname(path.absolute)))));
      } catch (cause) {
        diagnostics.push(error("MESH_MODEL_SHAPE", cause instanceof Error ? cause.message : String(cause), positionAt(input.source, file, roots[0].nameSpan.sourceStart)));
      }
      continue;
    }
    // A file directly in a `concepts` folder is a concept file to MX, whatever it declares: one that declares something
    // else, or nothing at all, is `MESH_CONCEPT_PLACE` (case b, the hook's own message) and is not built.
    if (inConceptsFolder(path.absolute)) {
      for (const problem of conceptFileProblems(ir.body, tagNameOfFile(path.absolute), path.absolute))
        diagnostics.push(error(problem.code, problem.message, positionAt(input.source, file, problem.offset)));
      continue;
    }
    // A surface lives in the surfaces folder, never in the domain (R3, OD2): not built.
    if (roots.length === 1 && roots[0]!.name === "surface") {
      const name = atomOf(attr(roots[0]!, "name"))?.name ?? "name";
      diagnostics.push(error("MESH_SURFACE_PATH", "A surface file lives in the surfaces folder, not in the domain: the domain never imports a surface",
        positionAt(input.source, file, roots[0]!.nameSpan.sourceStart),
        surfacesLabel === undefined
          ? `move it to a surfaces folder, \`src/surfaces/${name}/\`, and set \`surfaces: "src/surfaces"\` in mesh.config.ts`
          : `move it to \`${surfacesLabel === "." ? "" : `${surfacesLabel}/`}${name}/\``));
      continue;
    }
    if (roots.length !== 1)
      diagnostics.push(
        error(
          "MESH_DUPLICATE_ENTITY",
          `${ROOT_NOUN[roots[0]?.name ?? ""] ?? ROOT_NOUN.entity} file must contain exactly one ${roots[0]?.name ?? "entity"}`,
          positionAt(input.source, file, roots[1]?.nameSpan.sourceStart ?? 0),
        ),
      );
    for (const root of roots) {
      // The architecture file is read once every file is built, against the domain root; a second root in it is the
      // duplicate reported above, and is not read.
      if (root.name === "architecture") {
        if (root === roots[0]) architectureFiles.push({ root, imports: ir.imports, source: input.source, file, absolute: path.absolute });
        continue;
      }
      // A second root that is a surface is the duplicate reported above, and is not read.
      if (root.name === "surface") continue;
      // A mixin is read in each entity that uses it, never on its own (R21, ruling D37 OD10). Its file takes no import
      // (R12, OD3): what its lines name must be the includer's own members. A second root is the duplicate above.
      if (root.name === "mixin") {
        if (root === roots[0])
          for (const entry of ir.imports)
            diagnostics.push(error("MESH_UNKNOWN_IMPORT",
              "A mixin file takes no import: its lines are read in each entity that uses it, and what they name must be the entity's own members",
              positionAt(input.source, file, entry.span.sourceStart), "remove the import"));
        continue;
      }
      try {
        if (root.name === "event" || root.name === "command") {
          const declaration = buildDeclaration(root, ir.imports, input.source, file, diagnostics, normalizePath(relative(domainRoot, dirname(path.absolute))));
          (root.name === "event" ? events : commands).push(declaration);
          continue;
        }
        // A service file (R4 to R6): built into `document.services`, never into an entity.
        if (root.name === "service") {
          services.push(buildService(root, ir.imports, input.source, file, diagnostics, normalizePath(relative(domainRoot, dirname(path.absolute))), importDetails, declared));
          continue;
        }
        if (root.name === "aggregate") {
          aggregates.push(buildAggregate(root, ir.imports, input.source, file, diagnostics, importDetails,
            normalizePath(relative(domainRoot, dirname(path.absolute))), declared, declaredNames, { events, commands }, propPositions));
          continue;
        }
        const before = diagnostics.length;
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
            declaredNames,
            { events, commands },
            (from, exported) => {
              const mixin = mixinsByPath.get(resolve(rootPath, dirname(file), from));
              // A name the file does not declare is the import check's `MESH_UNKNOWN_IMPORT` (R11): nothing is read.
              return mixin?.name === exported ? mixin : undefined;
            },
            includersOf,
          ),
        );
        tagIncluder(diagnostics, before, document.entities.at(-1)!);
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
  // The surface files (R1 to R3, OD2): one `surface` root, in the folder named after the surface, directly under the
  // surfaces root. A file with more than one root is one error at the second, and only its first root is read.
  const surfaces: Surface[] = [];
  const pendingSurfaces: PendingSurface[] = [];
  const surfaceImports: { file: string; source: string; imports: Import[] }[] = [];
  for (const { source, path, ir } of parsedSurfaces) {
    const file = path.file;
    const roots = tags(ir.body);
    const first = roots[0];
    if (!first) continue;
    if (roots.length > 1)
      diagnostics.push(error("MESH_DUPLICATE_ENTITY", "A surface file must contain exactly one surface", positionAt(source, file, roots[1]!.nameSpan.sourceStart)));
    const position = positionAt(source, file, first.nameSpan.sourceStart);
    const name = atomOf(attr(first, "name"))?.name;
    if (first.name !== "surface") {
      diagnostics.push(error("MESH_SURFACE_PATH", `\`${file}\` declares \`${first.name}${name === undefined ? "" : ` :${name}`}\`; the surfaces folder holds surface files only`, position, `move it under the domain folder (\`${domainLabel}\`)`));
      continue;
    }
    if (name === undefined) continue; // MX reports the missing name
    const folder = normalizePath(relative(surfacesRoot!, dirname(path.absolute)));
    if (folder !== name) {
      const target = `${surfacesLabel === "." ? "" : `${surfacesLabel}/`}${name}/`;
      const renamed = /^[A-Za-z_][A-Za-z0-9_]*$/.test(folder) ? `, or rename the surface \`:${folder}\`` : "";
      diagnostics.push(error("MESH_SURFACE_PATH", `Surface :${name} is declared in \`${file}\`; a surface file lives in the folder named after its surface, \`${target}\``, position, `move the file to \`${target}\`${renamed}`));
      continue;
    }
    try {
      const declared = (from: string) => declaredByPath.get(resolve(rootPath, dirname(file), from));
      const built = buildSurface(first, ir.imports, source, file, path.absolute, diagnostics, importDetails, declared);
      surfaces.push(built.surface);
      pendingSurfaces.push(built.pending);
      surfaceImports.push({ file, source, imports: built.imports });
    } catch (cause) {
      diagnostics.push(error("MESH_MODEL_SHAPE", cause instanceof Error ? cause.message : String(cause), position));
    }
  }
  {
    const firstSurface = new Map<string, string>();
    for (const surface of surfaces) {
      if (firstSurface.has(surface.name))
        diagnostics.push(error("MESH_DUPLICATE_ENTITY", `Duplicate surface ${surface.name}; first declared in ${firstSurface.get(surface.name)}`, surface.position));
      else firstSurface.set(surface.name, surface.file);
    }
  }
  if (surfaces.length) document.surfaces = surfaces;
  // The architecture file is the file named so directly in the domain root (R2): any other `architecture` root is refused
  // and not read, and a project with none runs every rule at its default level. The rules run last (`checkArchitecture`).
  let architectureFile: string | undefined;
  let architectureSettings: ArchitectureSettings = DEFAULT_SETTINGS;
  for (const candidate of architectureFiles) {
    const position = positionAt(candidate.source, candidate.file, candidate.root.nameSpan.sourceStart);
    if (dirname(candidate.absolute) !== domainRoot || !isArchitectureFileName(candidate.absolute)) {
      const target = domainLabel === "." ? architectureFileText : `${domainLabel}/${architectureFileText}`;
      diagnostics.push(error("MESH_ARCHITECTURE_FILE", `The architecture file is ${architectureFileText} directly in the domain root (${domainLabel === "." ? "the project root" : domainLabel}), and this is ${candidate.file}`, position, `move it to ${target}`));
    } else if (architectureFile !== undefined)
      diagnostics.push(error("MESH_ARCHITECTURE_FILE", `A project has one architecture file, and ${architectureFile} is it`, position, "remove this file"));
    else {
      architectureFile = candidate.file;
      architectureSettings = readArchitectureFile(candidate, diagnostics);
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
  // Two aggregates of one FQN would be one name wherever Mesh prints one (ruling D35, OD6). An aggregate and an entity are
  // not compared: nothing is generated from an aggregate.
  const firstAggregate = new Map<string, string>();
  for (const aggregate of aggregates) {
    if (firstAggregate.has(aggregate.fqn))
      diagnostics.push(error("MESH_DUPLICATE_ENTITY", `Duplicate aggregate ${aggregate.fqn}; first declared in ${firstAggregate.get(aggregate.fqn)}`, aggregate.position));
    else firstAggregate.set(aggregate.fqn, aggregate.file);
  }
  if (events.length) document.events = events;
  // Two services of one FQN (R7): one error at the later file. A service and an entity, event or command whose class names
  // collide in one module meet at `MESH_EMIT_NAME` when code is generated, as an entity and an event do.
  {
    const firstService = new Map<string, string>();
    for (const service of services) {
      if (firstService.has(service.fqn))
        diagnostics.push(error("MESH_DUPLICATE_ENTITY", `Duplicate service ${service.fqn}; first declared in ${firstService.get(service.fqn)}`, service.position));
      else firstService.set(service.fqn, service.file);
    }
  }
  if (services.length) document.services = services;
  // Concepts are written to one generated file each and exported from their module's barrel by name, so two concepts of
  // one FQN (a group folder's `concepts` beside its module's, R21) and a concept that shares its FQN with an entity, event
  // or command (`billing.Money`) are one error at the later file. Shadowing across modules stays silent (R12).
  concepts.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  {
    const claimed = new Map<string, { kind: string; file: string }>();
    const later: { kind: string; fqn: string; file: string; position: SourcePosition }[] = [
      ...concepts.map((concept) => ({ kind: "concept", ...concept })),
      ...(concepts.length ? [...events.map((e) => ({ kind: "event", ...e })), ...commands.map((c) => ({ kind: "command", ...c }))] : []),
    ];
    if (concepts.length) for (const entity of document.entities) later.push({ kind: "entity", fqn: entity.fqn, file: entity.file, position: entity.position });
    later.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || (a.kind === "concept" ? -1 : 0));
    for (const declaration of later) {
      const first = claimed.get(declaration.fqn);
      if (first && (first.kind === "concept" || declaration.kind === "concept"))
        diagnostics.push(error("MESH_DUPLICATE_ENTITY", `Duplicate name ${declaration.fqn}: ${first.kind} in ${first.file} and ${declaration.kind} in ${declaration.file}`, declaration.position));
      else if (!first) claimed.set(declaration.fqn, declaration);
    }
  }
  if (concepts.length) document.concepts = concepts;
  checkConceptLiterals(document.entities, concepts, diagnostics);
  if (commands.length) document.commands = commands;
  if (aggregates.length) document.aggregates = aggregates;
  // The declaration a reference resolved to, now that every event and command is built: `from` is the import's path from the
  // entity's file, and the name is the one the declaring file gives it.
  const declarationAt = (owner: { file: string }, ref: CommandRef | DeclarationRef, list: readonly EventDeclaration[]) => {
    const declared = declaredNames.get(ref);
    if (!ref.from || declared === undefined) return undefined;
    const target = resolve(rootPath, dirname(owner.file), ref.from);
    return list.find((candidate) => resolve(rootPath, candidate.file) === target && classNameOf(candidate.name) === declared);
  };
  // The FQN of the command each `on=` resolved to, of each event and command an owner section lists, and of each event a
  // handler's `on=` names.
  for (const entity of document.entities)
    for (const action of entity.actions) {
      const answered = action.command && declarationAt(entity, action.command, commands);
      if (answered) action.command!.fqn = answered.fqn;
    }
  for (const owner of [...document.entities, ...aggregates])
    for (const [refs, list] of [[owner.events, events], [owner.commands, commands], [owner.handlers?.flatMap((handler) => handler.events), events]] as const)
      for (const ref of refs ?? []) ref.fqn = declarationAt(owner, ref, list)?.fqn ?? "";
  // The files whose root was built: a file that failed to build says nothing about what an import of it may name.
  const builtFiles = new Set([...[...document.entities, ...events, ...commands, ...aggregates].map(({ file }) => resolve(rootPath, file)), ...mixinsByPath.keys()]);
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
  }
  // The imports of every file that takes them: an entity file's, an aggregate file's, a surface file's and a service file's.
  const sourceOf = (file: string) =>
    surfaceImports.find((owner) => owner.file === file)?.source ?? project.files.find((input) => resolveEntityFile(rootPath, input.file)?.file === file)!.source;
  const surfaceOwners = new Set(surfaceImports.map(({ file }) => file));
  const serviceOwners = new Set(services.map(({ file }) => file));
  const aggregateOwners = new Set(aggregates.map(({ file }) => file));
  for (const entity of [...document.entities, ...aggregates, ...surfaceImports, ...services]) {
    for (const imported of entity.imports) {
      if (imported.mesh) continue; // "meshfw" is a package, not a file of the project
      const target = resolve(rootPath, dirname(entity.file), imported.from);
      // Nothing imports a surface file (R4, R5): neither the domain nor another surface.
      if (hasMeshExtension(imported.from) && (surfacePaths.has(target) || declaredByPath.get(target)?.kind === "surface")) {
        diagnostics.push(error("MESH_UNKNOWN_ENTITY", `${imported.from} is a surface file: ${surfaceOwners.has(entity.file) ? "a surface imports only files under the domain folder" : "the domain never imports a surface"}`, imported.position, "remove the import"));
        continue;
      }
      // No file imports a service file (OD-12): a service calls entities, and the domain calls no service; application code does.
      if (hasMeshExtension(imported.from) && declaredByPath.get(target)?.kind === "service") {
        const name = declaredByPath.get(target)!.declares[0]?.name ?? "";
        diagnostics.push(error("MESH_UNKNOWN_IMPORT",
          serviceOwners.has(entity.file) ? `${imported.from} declares the service ${name}, and a service calls entities, not other services`
          : surfaceOwners.has(entity.file) ? `${imported.from} declares the service ${name}, and a surface's lines name entities`
          : `${imported.from} declares a service: ${aggregateOwners.has(entity.file) ? "an aggregate file" : "an entity file"} cannot import a service; call the service from application code`,
          imported.position, "remove the import"));
        continue;
      }
      // What the imported file declares, for a named import to check its name against: an entity, event or command file's
      // root, and each event and command an entity file's owner sections declare inline.
      const declared = builtFiles.has(target) ? declaredByPath.get(target) : undefined;
      // A concept is never imported: its use is a line head, found in the nearest `concepts` folder (R9).
      if (hasMeshExtension(imported.from) && declaredByPath.get(target)?.kind === "concept") {
        const concept = declaredByPath.get(target)!.declares[0]?.name ?? tagNameOfFile(target);
        diagnostics.push(error("MESH_UNKNOWN_IMPORT", `${concept} is a concept, and a concept is never imported: write \`${concept} :price\` and Mesh finds it in the nearest \`concepts\` folder`, imported.position, "remove the import"));
        continue;
      }
      // The architecture file declares nothing to import (R8): each binding of a named import, or the namespace import once.
      if (hasMeshExtension(imported.from) && declaredByPath.get(target)?.kind === "architecture") {
        const bindings = imported.namespace ? [] : importDetails.get(imported)?.bindings ?? [];
        const source = sourceOf(entity.file);
        if (!bindings.length)
          diagnostics.push(error("MESH_UNKNOWN_IMPORT", `${imported.from} is the architecture file, which declares nothing to import`, imported.position, "remove the import"));
        for (const binding of bindings)
          diagnostics.push(error("MESH_UNKNOWN_IMPORT", `\`${binding.imported}\` is not what ${imported.from} declares: it is the architecture file, which declares nothing to import`, positionAt(source, entity.file, binding.offset), "remove the import"));
      }
      if (hasMeshExtension(imported.from) && declared?.declares.length) {
        // An aggregate's own name is no value and binds nothing: only what the file declares besides it is importable.
        const importableNames = [...new Set(importable(declared)!.map(({ name }) => `\`${name}\``))];
        const aggregate = declared.declares.find(({ kind }) => kind === "aggregate");
        // A namespace import names the file, not what it declares: its references are checked where they are written.
        for (const binding of imported.namespace ? [] : importDetails.get(imported)?.bindings ?? []) {
          if (!importable(declared)!.some(({ name }) => name === binding.imported)) {
            const source = sourceOf(entity.file);
            diagnostics.push(error("MESH_UNKNOWN_IMPORT", aggregate?.name === binding.imported
              ? `\`${binding.imported}\` is the aggregate ${imported.from} declares, and an aggregate is no value: import the events or commands it declares${importableNames.length ? ` (${importableNames.join(", ")})` : ", and it declares none"}`
              : `\`${binding.imported}\` is not what ${imported.from} declares; it declares ${importableNames.length ? importableNames.join(", ") : `the aggregate \`${aggregate?.name}\` only, which is no value`}`,
              positionAt(source, entity.file, binding.offset)));
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
  resolveSurfaces(document, rootPath, pendingSurfaces, diagnostics, nearestName);
  checkServices(document, diagnostics, nearestName);
  resolveAggregates(document, propPositions, diagnostics, nearestName);
  resolveRollups(document, rollups, diagnostics);
  checkLockRelate(document, diagnostics, nearestName);
  checkExpressions(document, diagnostics, { demotionOf, copyOf: copyExpression });
  computeNeeds(document, diagnostics);
  checkLifecycleLimits(document, diagnostics, {
    privilegedCallsOf, askCallsOf, asynchronyOf, scopeReachOf, throughPositionOf: (relation) => throughPositions.get(relation),
  });
  checkSqlRequired(document, diagnostics);
  // A file that did not parse may list an event's owner: with one missing, who owns an event is not known.
  checkPublishSteps(document, diagnostics, {
    targetsOf: publishTargetsOf,
    fqnOf: (entity, target) => {
      const file = resolve(rootPath, dirname(entity.file), target.from);
      return events.find((event) => resolve(rootPath, event.file) === file && classNameOf(event.name) === target.declared)?.fqn;
    },
    membership: aggregatesOf(document),
    complete: parsedFiles.length === project.files.length,
  });
  // A file that did not parse may hold the action that answers a command: with one missing, "unanswered" is not known.
  checkCommands(document, diagnostics, parsedFiles.length === project.files.length);
  // The architecture rules read the whole built model, so they run after every other check; an `error` setting fails the build.
  checkArchitecture(architectureSettings, { document, entityCallsOf, aggregatesOf: aggregateNamesOf(document) }, diagnostics);
  const invalid = findNonJsonValue(document);
  if (invalid)
    diagnostics.push(
      error(
        "MESH_NON_JSON",
        `Model is not JSON-compatible: ${invalid}`,
        document.entities[0]?.position ?? positionAt("", "mesh.config.ts", 0),
      ),
    );
  // A mistake in a project mixin's lines is found once per entity that uses it: one report, naming the includers that
  // have it unless all of them do (R19).
  mergeIncluders(diagnostics, includersOf);
  // One problem reached more than one way is reported once: a concept file's own error comes with its parse, with each
  // use MX lowers (the hook's copy, positioned in the concept file) and from `buildConcept`.
  const seenDiagnostics = new Set<string>();
  const unique = diagnostics.filter((d) => {
    const key = `${d.position.file}\0${d.position.offset}\0${d.code}\0${d.message}`;
    if (seenDiagnostics.has(key)) return false;
    seenDiagnostics.add(key);
    return true;
  });
  diagnostics.length = 0;
  diagnostics.push(...unique);
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

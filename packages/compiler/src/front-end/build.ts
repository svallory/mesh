import { basename, dirname, relative, resolve } from "node:path";
import { realpathSync, statSync } from "node:fs";
import {
  foreignAbsolute,
  inside,
  normalizePath,
  resolveEntityFile,
} from "../paths.ts";
export { projectPath } from "../paths.ts";
import { lowerSource, type IrDiagnostic } from "@mxlang/core";
import {
  attributeTypeInfo,
  findNonJsonValue,
  isActionKind,
  type ActionType,
  type Always,
  type Argument,
  type Attribute,
  type AttributeType,
  type Check,
  type Computed,
  type Diagnostic,
  type Entity,
  type Expression,
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
import contracts from "./contracts.ts";
import { MESH_DIALECT } from "./dialect.ts";
import { hasMeshExtension } from "./extensions.ts";
import { demotionOf } from "./expression.ts";
import { checkExpressions } from "../model/index.ts";
import { error, positionAt, type BuildResult, type ProjectDescription } from "../model/index.ts";
import { nearestName } from "./nearest-name.ts";
import { literalFits } from "./literal-types.ts";
import {
  resolveRollups,
  unknownMember,
  type PendingRollup,
} from "./rollups.ts";
import { resolveRelationships } from "./relationships.ts";
import { checkLifecycleLimits } from "../model/lifecycle-limits.ts";
import { computeNeeds } from "../model/needs.ts";
import {
  atomList,
  atomOf,
  attr,
  attrOffset,
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
  valueOf,
  type Attr,
  type IrImport,
  type Tag,
} from "./tree.ts";

export const BUILTIN_OBJECT_PROPERTY_NAMES = Object.freeze([
  "__proto__",
  "constructor",
  "prototype",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
] as const);
/** An entity import as MX parsed it (`Import.from`/`names`); never re-parsed. */
interface ParsedImport {
  names: string[];
  /** `offset`: the imported name as written; `localOffset`: the local binding (the alias when written). */
  bindings: { local: string; imported: string; offset: number; localOffset: number }[];
  from: string;
  offset: number;
}
interface ImportProblem {
  code: "MESH_UNKNOWN_IMPORT" | "MESH_IMPORT_FORM";
  message: string;
  offset: number;
}
/** Entity files import other entities by name only: `import { List } from "./list…"`, a relative path to an entity file. */
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
    if (
      !names.length ||
      entry.typeOnly ||
      names.some((name) => name.kind !== "named" || name.typeOnly)
    ) {
      problems.push({
        code: "MESH_IMPORT_FORM",
        message: entry.typeOnly || names.some((name) => name.typeOnly)
          ? "import the entity by name, not as a type: `import { List } from …`"
          : "import the entity by name: `import { List } from …`",
        offset,
      });
      continue;
    }
    if (!from.startsWith("./") && !from.startsWith("../")) {
      problems.push({
        code: "MESH_UNKNOWN_IMPORT",
        message: "The import path must be relative (start with ./ or ../)",
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

function buildEntity(
  root: Tag,
  irImports: readonly IrImport[],
  source: string,
  file: string,
  diagnostics: Diagnostic[],
  rollups: PendingRollup[],
  importDetails: Map<Import, ParsedImport>,
  viaPositions: Map<Relationship, SourcePosition>,
  folder: string,
): Entity {
  const at = (offset: number) => positionAt(source, file, offset);
  const pos = (tag: Tag) => at(tag.nameSpan.sourceStart);
  const fail = (code: string, message: string, tag: Tag | SourcePosition) =>
    diagnostics.push(error(code, message, "nameSpan" in tag ? pos(tag) : tag));
  const opt = (tag: Tag, key: string) => {
    const a = attr(tag, key);
    return a ? valueOf(a) : undefined;
  };
  const sections = tags(root.children);
  const section = (name: string) => sections.find((t) => t.name === name);
  const entity: Entity = {
    name: declaredName(root),
    table: String(opt(root, "table") ?? snakeCase(declaredName(root))),
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
  if (!/^[A-Z][A-Za-z0-9]*$/.test(entity.name))
    fail("MESH_ENTITY_NAME", `Entity :${entity.name} must have a PascalCase name, such as :Todo`, root);
  const { module, bareUnderscore } = moduleOfFolder(folder);
  entity.module = module;
  if (bareUnderscore)
    fail("MESH_GROUP_NAME", `Group folder "_" has no name; write "_" followed by a name, such as "_services"`, root);
  for (const segment of module ? module.split("/") : []) {
    if (!/^[A-Za-z0-9_-]+$/.test(segment))
      fail("MESH_MODULE_NAME", `Module segment ${JSON.stringify(segment)} must contain only letters, digits, - or _`, root);
  }
  const imports = readImports(irImports);
  for (const problem of imports.problems)
    fail(problem.code, problem.message, at(problem.offset));
  entity.imports = imports.imports.map(
    (i): Import => {
      const value: Import = { identifiers: i.names, from: i.from, ...(hasMeshExtension(i.from) ? {} : { helper: true as const }), position: at(i.offset) };
      importDetails.set(value, i);
      return value;
    },
  );
  const importNames = new Map<string, Import>();
  for (const entry of entity.imports)
    for (const [index, name] of entry.identifiers.entries()) {
      if (importNames.has(name)) {
        const localOffset = importDetails.get(entry)?.bindings[index]?.localOffset;
        fail(
          "MESH_DUPLICATE_IMPORT",
          `Duplicate import identifier ${name}`,
          localOffset === undefined ? entry.position : at(localOffset),
        );
      }
      importNames.set(name, entry);
    }
  const pending: {
    ref: MemberRef;
    scope: "input" | "sort" | "load" | "set" | "actions" | "expression" | "filter";
  }[] = [];
  const checkRef = (
    ref: MemberRef,
    scope: (typeof pending)[number]["scope"],
  ) => {
    pending.push({ ref, scope });
    return ref;
  };
  const helperImports = new Map<string, string>();
  for (const entry of entity.imports)
    if (!hasMeshExtension(entry.from))
      for (const [index, name] of entry.identifiers.entries()) {
        helperImports.set(name, entry.from);
        // Generated code names its own internals `$...` and prints every authored local as `l$...`.
        if (/^(\$|l\$)/.test(name)) {
          const localOffset = importDetails.get(entry)?.bindings[index]?.localOffset;
          fail(
            "MESH_HELPER_NAME",
            `The helper name ${name} cannot start with $ or l$: generated code uses those prefixes for its own names`,
            localOffset === undefined ? entry.position : at(localOffset),
          );
        }
      }
  const expr = (a: Attr | undefined, scope: "expression" | "filter" = "expression", runStep = false): Expression =>
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
        report: (d) => {
          if (!diagnostics.some((x) => x.code === d.code && x.position.file === d.position.file && x.position.offset === d.position.offset)) diagnostics.push(d);
        },
        ...(runStep ? { runStep } : {}),
      },
    );
  const authoredMember = (line: Tag) =>
    fail(
      "MESH_SYNTAX",
      "`<member>` is not a known tag: write a member line as `&name`",
      line,
    );
  const applyOptions = (tag: Tag) => {
    const result: Pick<
      Attribute,
      "nullable" | "default" | "values" | "min" | "max" | "match"
    > = { nullable: opt(tag, "nullable") === true };
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
    const identifier = nodeOf(attr(tag, "entity"))?.name ?? "";
    const imported = importNames.get(identifier);
    // An entity relates to its own type by its own name, with no import.
    const itself = !imported && identifier === entity.name;
    if (!itself && (!imported || !hasMeshExtension(imported.from))) {
      const names = [...importNames.keys()].filter((n) =>
        hasMeshExtension(importNames.get(n)!.from),
      );
      const suggestion = nearestName(identifier, new Set([...names, entity.name]));
      fail(
        "MESH_UNKNOWN_ENTITY",
        `${identifier} is not an imported entity.${suggestion ? ` Did you mean ${suggestion}?` : ""}`,
        at(attrOffset(attr(tag, "entity")!)),
      );
    }
    const name = declaredName(tag);
    const kind = tag.name as Relationship["kind"];
    const via = atomOf(attr(tag, "via"))?.name;
    const relation: Relationship = {
      kind,
      name,
      entity: { identifier, from: itself ? `./${basename(file)}` : imported?.from ?? "" },
      nullable: opt(tag, "nullable") === true,
      ...(kind === "belongs-to" ? { keyColumn: `${name}Id` } : {}),
      ...(via !== undefined ? { via } : {}),
      position: pos(tag),
    };
    entity.relationships.push(relation);
    if (via !== undefined) viaPositions.set(relation, at(attrOffset(attr(tag, "via")!)));
  }
  for (const tag of tags(section("computed")?.children ?? [])) {
    const base = { name: declaredName(tag), position: pos(tag) };
    if (["count", "sum", "avg", "min", "max"].includes(tag.name)) {
      const of = String(opt(tag, "of"));
      const computed: Computed = {
        ...base,
        type: "integer",
        nullable: false,
        rollup: { fn: tag.name as Rollup["fn"], of },
      };
      entity.computed.push(computed);
      const a = attr(tag, "of")!;
      let offset = attrOffset(a);
      if (source[offset] === '"' || source[offset] === "'") offset++;
      const segments = of.split(".").map((name) => {
        const ref = { name, position: at(offset) };
        offset += name.length + 1;
        return ref;
      });
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
  const checks = (holder: Tag): Check[] => {
    const names = new Set<string>();
    return tags(tags(holder.children).find((t) => t.name === "validate")?.children ?? []).map((tag) => {
      const label = declaredName(tag);
      if (names.has(label)) fail("MESH_DUPLICATE_MEMBER", `Duplicate member :${label}`, tag);
      names.add(label);
      return { label, that: expr(attr(tag, "that")), code: String(opt(tag, "code")), message: String(opt(tag, "message")), ...(attr(tag, "when") ? { when: expr(attr(tag, "when")) } : {}), ...(attr(tag, "details") ? { details: expr(attr(tag, "details")) } : {}), position: pos(tag) };
    });
  };
  const steps = (holder: Tag): Step[] =>
    tags(holder.children).map((tag): Step => {
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
        return { kind: "run", fn: expr(attr(tag, "value"), "expression", true), ...(after ? { after: "write" as const } : {}), position };
      }
      throw new Error(`Unexpected step ${tag.name}`);
    });
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
      entity.actions.push({
        kind,
        name: declaredName(tag),
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
      });
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
  ];
  const names = new Set<string>();
  for (const member of members) {
    if (names.has(member.name))
      fail(
        "MESH_DUPLICATE_MEMBER",
        `Duplicate member :${member.name}`,
        member.position,
      );
    if (
      (BUILTIN_OBJECT_PROPERTY_NAMES as readonly string[]).includes(member.name)
    )
      fail(
        "MESH_ATTRIBUTE_NAME",
        `${member.name} is the name of a built-in object property. Choose another name.`,
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
    if (!candidates.has(ref.name))
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
    if (relation.keyColumn && names.has(relation.keyColumn))
      fail(
        "MESH_DUPLICATE_MEMBER",
        `Generated key column ${relation.keyColumn} conflicts with a declared member`,
        relation.position,
      );
  return entity;
}

/**
 * The compiler's one MX call: `lowerSource` with closed contracts, Mesh's dialect (which carries
 * its tag rules) and rejection on. It never throws; every problem is a positioned diagnostic.
 */
export function parseEntitySource(source: string, file: string) {
  const lowered = lowerSource(source, file, {
    dialect: MESH_DIALECT,
    customTags: contracts,
    structural: "reject",
    unknownTags: "reject",
    imports: "pass",
  });
  return { ...lowered, diagnostics: lowered.diagnostics.filter((d) => !selfDuplicate(d)) };
}

/**
 * MX 0.1.0-alpha.16 reads a method after an attribute group (`run [after=:write] ({ self }) { ... }`, the form
 * ADR-0068 documents) as two `value` attributes at one position, and warns that the first is dropped. Both are the one
 * function the author wrote, so that warning is dropped. A duplicate the author wrote sits at another position and is
 * still reported. The match is on MX's message text, like the unknown-tag match in `buildModel`, and stands until MX
 * stops producing the second attribute.
 */
function selfDuplicate(d: IrDiagnostic): boolean {
  const duplicate = /^duplicate attribute `[^`]+`: the later one at (\d+):(\d+) wins/.exec(d.message);
  return !!duplicate && Number(duplicate[1]) === d.line && Number(duplicate[2]) - 1 === d.column;
}

/** Parse with closed MX contracts, then project the static tree without executing it. */
export function buildModel(project: ProjectDescription): BuildResult {
  const diagnostics: Diagnostic[] = [];
  const document: ModelDocument = { entities: [] };
  const rollups: PendingRollup[] = [];
  const importDetails = new Map<Import, ParsedImport>();
  const viaPositions = new Map<Relationship, SourcePosition>();
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
    const file = path.file;
    const parsed = parseEntitySource(input.source, file);
    diagnostics.push(
      ...parsed.diagnostics.filter((d, _, all) => {
        // MX reports both parent rejection and unknown-tag rejection for the
        // same unknown child. Keep the specific unknown-tag error only.
        // The match is on MX's message text because MX 0.1.0-alpha.16's
        // IrDiagnostic carries a `code` only from a dialect's `ctx.fail`. It stands
        // until MX fills diagnostic codes; do not replace it with an offset-only
        // rule, which would depend on MX's diagnostic order instead.
        const denied = /`<([^>]+)>` is not allowed here;/.exec(d.message)?.[1];
        return !denied || !all.some((other) => other.offset === d.offset &&
          other.message.startsWith(`\`<${denied}>\` is not a known tag:`));
      }).map((d): Diagnostic => {
        // Mesh's contracts report their own code as a `MESH_X: ` message
        // prefix, because a contract's `ctx.fail(message, at?)` takes no code. This
        // stands until MX fills diagnostic codes for contracts and returns them
        // on the diagnostic.
        const coded = /\b(MESH_[A-Z_]+): (.*)/s.exec(d.message);
        return {
          severity: d.severity,
          code: coded?.[1] ?? "MESH_SYNTAX",
          message: coded?.[2] ?? d.message,
          position: { file, line: d.line, column: d.column, offset: d.offset },
          fix: null,
        };
      }),
    );
    if (!parsed.ir) continue;
    const roots = tags(parsed.ir.body);
    if (roots.length !== 1)
      diagnostics.push(
        error(
          "MESH_DUPLICATE_ENTITY",
          "An entity file must contain exactly one entity",
          positionAt(input.source, file, roots[1]?.nameSpan.sourceStart ?? 0),
        ),
      );
    for (const root of roots) {
      try {
        document.entities.push(
          buildEntity(
            root,
            parsed.ir.imports,
            input.source,
            file,
            diagnostics,
            rollups,
            importDetails,
            viaPositions,
            normalizePath(relative(domainRoot, dirname(path.absolute))),
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
  const identities = new Map<string, string>();
  for (const entity of document.entities) {
    const identity = `${entity.module}/${entity.name}`;
    if (identities.has(identity))
      diagnostics.push(
        error(
          "MESH_DUPLICATE_ENTITY",
          `Duplicate entity :${entity.name} ${entity.module ? `in module ${JSON.stringify(entity.module)}` : "at the domain root"}; first declared in ${identities.get(identity)}`,
          entity.position,
        ),
      );
    else identities.set(identity, entity.file);
    for (const imported of entity.imports) {
      const target = resolve(rootPath, dirname(entity.file), imported.from);
      const targetEntity = document.entities.find((candidate) => resolve(rootPath, candidate.file) === target);
      if (hasMeshExtension(imported.from) && targetEntity) {
        for (const binding of importDetails.get(imported)?.bindings ?? []) {
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
  resolveRelationships(document, viaPositions, diagnostics);
  resolveRollups(document, rollups, diagnostics);
  checkExpressions(document, diagnostics, { demotionOf });
  computeNeeds(document, diagnostics);
  checkLifecycleLimits(document, diagnostics);
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

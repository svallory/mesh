import { dirname, relative, resolve } from "node:path";
import { realpathSync, statSync } from "node:fs";
import {
  foreignAbsolute,
  inside,
  normalizePath,
  resolveEntityFile,
} from "./paths.ts";
export { projectPath } from "./paths.ts";
import { parseData } from "@mxlang/data";
import type { DataAttr, DataDocument, DataTag } from "@mxlang/data/tree";
import {
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
import { nearestName } from "./nearest-name.ts";
import { literalFits } from "./literal-types.ts";
import { readImports, type ParsedImport } from "./imports.ts";
import {
  resolveRollups,
  unknownMember,
  type PendingRollup,
} from "./rollups.ts";
import {
  atomList,
  attr,
  attrOffset,
  declaredName,
  expression,
  nodeOf,
  readAt,
  readMember,
  readMemberLine,
  readMembers,
  tags,
  valueOf,
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
export interface EntityFile {
  file: string;
  source: string;
}
export interface ProjectDescription {
  root: string;
  /** Defaults to the project root for callers building virtual files. */
  domainRoot?: string;
  files: readonly EntityFile[];
}
export interface BuildResult {
  document: ModelDocument | null;
  diagnostics: Diagnostic[];
}
/** UTF-16 position conversion only; never interprets entity syntax. */
export function positionAt(
  source: string,
  file: string,
  offset: number,
): SourcePosition {
  const before = source.slice(0, offset);
  return {
    file,
    line: before.split("\n").length,
    column: offset - (before.lastIndexOf("\n") + 1),
    offset,
  };
}
export function error(
  code: string,
  message: string,
  position: SourcePosition,
  fix: string | null = null,
): Diagnostic {
  return { severity: "error", code, message, position, fix };
}
const snakeCase = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();

function buildEntity(
  root: DataTag,
  tree: DataDocument,
  source: string,
  file: string,
  diagnostics: Diagnostic[],
  rollups: PendingRollup[],
  importDetails: Map<Import, ParsedImport>,
  module: string,
): Entity {
  const at = (offset: number) => positionAt(source, file, offset);
  const pos = (tag: DataTag) => at(tag.nameSpan.sourceStart);
  const fail = (code: string, message: string, tag: DataTag | SourcePosition) =>
    diagnostics.push(error(code, message, "nameSpan" in tag ? pos(tag) : tag));
  const opt = (tag: DataTag, key: string) => {
    const a = attr(tag, key);
    return a ? valueOf(a) : undefined;
  };
  const sections = tags(root.children);
  const section = (name: string) => sections.find((t) => t.name === name);
  const entity: Entity = {
    name: declaredName(root),
    table: String(opt(root, "table") ?? snakeCase(declaredName(root))),
    file,
    module,
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
  for (const segment of module ? module.split("/") : []) {
    if (!/^[A-Za-z0-9_-]+$/.test(segment))
      fail("MESH_MODULE_NAME", `Module segment ${JSON.stringify(segment)} must contain only letters, digits, - or _`, root);
  }
  const imports = readImports(tree.imports ?? []);
  for (const problem of imports.problems)
    fail(problem.code, problem.message, at(problem.span.sourceStart));
  entity.imports = imports.imports.map(
    (i): Import => {
      const value = { identifiers: i.names, from: i.from, position: at(i.span.sourceStart) };
      importDetails.set(value, i);
      return value;
    },
  );
  const importNames = new Map<string, Import>();
  for (const entry of entity.imports)
    for (const name of entry.identifiers) {
      if (importNames.has(name))
        fail(
          "MESH_DUPLICATE_IMPORT",
          `Duplicate import identifier ${name}`,
          entry.position,
        );
      importNames.set(name, entry);
    }
  const pending: {
    ref: MemberRef;
    scope: "input" | "sort" | "load" | "set" | "actions" | "expression";
  }[] = [];
  const checkRef = (
    ref: MemberRef,
    scope: (typeof pending)[number]["scope"],
  ) => {
    pending.push({ ref, scope });
    return ref;
  };
  const expr = (a: DataAttr | undefined): Expression =>
    expression(a, source, at, (ref) => checkRef(ref, "expression"));
  const applyOptions = (tag: DataTag) => {
    const result: Pick<
      Attribute,
      "nullable" | "default" | "values" | "min" | "max" | "match"
    > = { nullable: opt(tag, "nullable") === true };
    const def = attr(tag, "default");
    if (def) result.default = valueOf(def);
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
  const shape = (tag: DataTag) => ({
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
      ...(on?.kind === "atom" ? { on: on.value as "create" | "update" } : {}),
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
    if (!imported || !imported.from.endsWith(".mesh.mx")) {
      const names = [...importNames.keys()].filter((n) =>
        importNames.get(n)!.from.endsWith(".mesh.mx"),
      );
      const suggestion = nearestName(identifier, new Set(names));
      fail(
        "MESH_UNKNOWN_ENTITY",
        `${identifier} is not an imported entity.${suggestion ? ` Did you mean ${suggestion}?` : ""}`,
        at(attrOffset(attr(tag, "entity")!)),
      );
    }
    const name = declaredName(tag);
    const kind = tag.name as Relationship["kind"];
    entity.relationships.push({
      kind,
      name,
      entity: { identifier, from: imported?.from ?? "" },
      nullable: opt(tag, "nullable") === true,
      ...(kind === "belongs-to" ? { keyColumn: `${name}Id` } : {}),
      position: pos(tag),
    });
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
      if (
        tag.attrs.some(
          (a) => a.kind !== "spread" && a.name !== "name" && a.name !== "value",
        )
      )
        fail(
          "MESH_COMPUTED_OPTIONS",
          "A computed function takes only its name and body",
          tag,
        );
      const body = readAt(tag, at, () => expr(attr(tag, "value")));
      if (body.diagnostic) diagnostics.push(body.diagnostic);
      else entity.computed.push({ ...base, type: tag.name as AttributeType, body: body.value });
    }
  }
  const checks = (holder: DataTag): Check[] => {
    const names = new Set<string>();
    return tags(tags(holder.children).find((t) => t.name === "validate")?.children ?? []).map((tag) => {
      const label = declaredName(tag);
      if (names.has(label)) fail("MESH_DUPLICATE_MEMBER", `Duplicate member :${label}`, tag);
      names.add(label);
      return { label, that: expr(attr(tag, "that")), code: String(opt(tag, "code")), message: String(opt(tag, "message")), ...(attr(tag, "when") ? { when: expr(attr(tag, "when")) } : {}), position: pos(tag) };
    });
  };
  const steps = (holder: DataTag): Step[] =>
    tags(holder.children).map((tag): Step => {
      const position = pos(tag);
      if (tag.name === "set")
        return {
          kind: "set",
          assignments: tags(tag.children).flatMap((line) => {
            const read = readAt(line, at, () => readMemberLine(line, at));
            if (read.diagnostic) { diagnostics.push(read.diagnostic); return []; }
            const member = read.value;
            checkRef(member.ref, "set");
            const value = readAt(line, at, () => {
              const n = nodeOf(member.value);
              if (n && ["ArrowFunctionExpression", "FunctionExpression"].includes(n.type)) return expr(member.value);
              let literal: ReturnType<typeof valueOf>;
              try { literal = valueOf(member.value); }
              catch { throw new Error(`\`&${member.ref.name}=\` needs a literal value here`); }
              const field = entity.attributes.find((attribute) => attribute.name === member.ref.name);
              if (field && (!literalFits(literal, field) || n?.type === "ObjectExpression"))
                fail("MESH_SET_VALUE", `\`&${member.ref.name}=\` needs a literal that fits ${field.type}${field.type === "enum" ? ` (${field.values?.map((atom) => `:${atom.value}`).join(", ")})` : ""}`, member.ref.position);
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
      if (tag.name === "run")
        return { kind: "run", fn: expr(attr(tag, "value")), position };
      throw new Error(`Unexpected step ${tag.name}`);
    });
  const body = (holder: DataTag) => {
    const block = tags(holder.children).find((t) => t.name === "do");
    return { validate: checks(holder), do: block ? steps(block) : [] };
  };
  const types = (a: DataAttr) =>
    atomList(a).map((value): ActionType => {
      if (!isActionKind(value)) throw new Error(`Unknown action type ${value}`);
      return value;
    });
  const scope = (tag: DataTag) => ({
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
        if (line.name.startsWith("&")) {
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
        ...(filter ? { filter: expr(filter) } : {}),
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
            ? entity.attributes
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

/** Parse with closed MX contracts, then project the static tree without executing it. */
export function buildModel(project: ProjectDescription): BuildResult {
  const diagnostics: Diagnostic[] = [];
  const document: ModelDocument = { entities: [] };
  const rollups: PendingRollup[] = [];
  const importDetails = new Map<Import, ParsedImport>();
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
    const parsed = parseData(input.source, file, {
      customTags: contracts,
      structural: "reject",
      unknownTags: "reject",
      imports: "pass",
    });
    diagnostics.push(
      ...parsed.diagnostics.filter((d, _, all) => {
        // MX reports both parent rejection and unknown-tag rejection for the
        // same unknown child. Keep the specific unknown-tag error only.
        const denied = /`<([^>]+)>` is not allowed here;/.exec(d.message)?.[1];
        return !denied || !all.some((other) => other.offset === d.offset &&
          other.message.startsWith(`\`<${denied}>\` is not a known tag:`));
      }).map((d): Diagnostic => {
        const coded = /\b(MESH_[A-Z_]+): (.*)/s.exec(d.message);
        const memberOptions =
          /`<&[A-Za-z_][A-Za-z0-9_]*>`.*(?:unknown attribute|missing required attribute)/.test(d.message);
        return {
          severity: d.severity,
          code:
            coded?.[1] ??
            (memberOptions ? "MESH_MEMBER_LINE_OPTIONS" : "MESH_SYNTAX"),
          message: coded?.[2] ?? d.message,
          position: { file, line: d.line, column: d.column, offset: d.offset },
          fix: null,
        };
      }),
    );
    if (!parsed.tree) continue;
    const roots = tags(parsed.tree.children);
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
            parsed.tree,
            input.source,
            file,
            diagnostics,
            rollups,
            importDetails,
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
      if (imported.from.endsWith(".mesh.mx") && targetEntity) {
        for (const binding of importDetails.get(imported)?.bindings ?? []) {
          if (binding.imported !== targetEntity.name) {
            const source = project.files.find((input) => resolveEntityFile(rootPath, input.file)?.file === entity.file)!.source;
            diagnostics.push(error("MESH_UNKNOWN_IMPORT", `\`${binding.imported}\` is not what ${imported.from} declares; it declares \`${targetEntity.name}\``, positionAt(source, entity.file, binding.span.sourceStart)));
          }
        }
      }
      const candidates = imported.from.endsWith(".mesh.mx")
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
      if (found && imported.from.endsWith(".mesh.mx") && !virtualFiles.has(target))
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
  resolveRollups(document, rollups, diagnostics);
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

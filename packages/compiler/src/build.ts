import { relative, resolve } from "node:path";
import { parseData } from "@mxlang/data";
import type { DataAttr, DataNode, DataTag } from "@mxlang/data/tree";
import { findNonJsonValue, type Action, type ActionKind, type Attribute, type AttributeSource, type AttributeTypeName, type Diagnostic, type JsonPrimitive, type ModelDocument, type Resource, type SourcePosition, type Spanned } from "@mesh/model";
import contracts from "./contracts.ts";
import { unsupportedMilestone } from "./support.ts";

export interface ResourceFile { file: string; source: string }
export interface ProjectDescription { root: string; files: readonly ResourceFile[] }
export interface BuildResult { document: ModelDocument | null; diagnostics: Diagnostic[] }

/** Position conversion uses UTF-16 offsets, without interpreting resource syntax. */
export function positionAt(source: string, file: string, offset: number): SourcePosition {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  return { file, line, column: offset - (before.lastIndexOf("\n") + 1), offset };
}
export function projectPath(root: string, file: string): string {
  return relative(resolve(root), resolve(root, file)).split("\\").join("/");
}
export function error(code: string, message: string, position: SourcePosition, fix: string | null = null): Diagnostic {
  return { severity: "error", code, message, position, fix };
}

// MX supplies parsed Babel nodes. Only literal node shapes allowed by the contracts
// are read here; source text is never reparsed or evaluated.
interface LiteralNode {
  type: string; value?: unknown; operator?: string; argument?: LiteralNode;
  elements?: LiteralNode[]; properties?: { key: { name?: string; value?: unknown }; value: LiteralNode }[];
  loc?: { start: { index: number } };
}
const attr = (tag: DataTag, name: string) => tag.attrs.find((a) => a.kind !== "spread" && a.name === name);
const nodeOf = (a: DataAttr): LiteralNode => {
  if (a.kind !== "expression") throw new Error("Expected MX literal expression");
  // SAFETY: MX's closed, literalOnly contracts and analyze hooks validate these
  // Babel shapes before a tree reaches the builder; this interface is a read-only projection.
  return a.value.node as unknown as LiteralNode;
};
function literal(node: LiteralNode): JsonPrimitive {
  if (node.type === "UnaryExpression" && node.operator === "-") return -Number(literal(node.argument!));
  if (["StringLiteral", "NumericLiteral", "BooleanLiteral", "NullLiteral"].includes(node.type)) return node.type === "NullLiteral" ? null : node.value as JsonPrimitive;
  throw new Error(`Unexpected MX literal node ${node.type}`);
}
const tags = (nodes: readonly DataNode[]): DataTag[] => nodes.filter((n): n is DataTag => n.kind === "tag");

function buildResource(root: DataTag, source: string, file: string): Resource {
  const at = (offset: number) => positionAt(source, file, offset);
  const spNode = <T>(node: LiteralNode): Spanned<T> => ({ value: literal(node) as T, position: at(node.loc!.start.index) });
  const sp = <T>(a: DataAttr): Spanned<T> => {
    if (a.kind === "string") return { value: a.value as T, position: at(a.valueSpan.sourceStart) };
    if (a.kind === "boolean") return { value: true as T, position: at(a.nameSpan.sourceStart) };
    if (a.kind === "expression") return { value: literal(nodeOf(a)) as T, position: at(a.value.span.sourceStart) };
    throw new Error("Spread escaped the closed Mesh contracts");
  };
  const list = <T>(a: DataAttr | undefined): Spanned<T>[] => a ? (nodeOf(a).elements ?? []).map((n) => spNode<T>(n)) : [];
  const optional = <T>(tag: DataTag, name: string): Spanned<T> | null => {
    const a = attr(tag, name); return a ? sp<T>(a) : null;
  };
  const sections = tags(root.children);
  const attributes = tags(sections.find((t) => t.name === "attributes")!.children).map((tag): Attribute => {
    const declared = tag.name === "attribute";
    const key = tag.name === "uuid-primary-key";
    const type = declared ? sp<AttributeTypeName>(attr(tag, "type")!).value : key ? "uuid" : "datetime";
    const base = {
      name: sp<string>(attr(tag, "value")!), source: tag.name as AttributeSource,
      allowNil: declared ? (optional<boolean>(tag, "allow-nil")?.value ?? true) : false,
      public: declared ? (optional<boolean>(tag, "public")?.value ?? false) : key,
      writable: declared, primaryKey: key, default: optional<JsonPrimitive>(tag, "default"),
      position: at(tag.nameSpan.sourceStart),
    };
    if (type === "atom") {
      const constraints = nodeOf(attr(tag, "constraints")!);
      const oneOf = constraints.properties!.find((p) => (p.key.name ?? p.key.value) === "one_of")!.value;
      return { ...base, type, constraints: { oneOf: (oneOf.elements ?? []).map((n) => spNode<string>(n)) } };
    }
    return { ...base, type, constraints: null };
  });
  const actionSection = sections.find((t) => t.name === "actions");
  const actions = tags(actionSection?.children ?? []).map((tag): Action => {
    const kind = tag.name as ActionKind;
    const base = { name: sp<string>(attr(tag, "value")!), position: at(tag.nameSpan.sourceStart) };
    return kind === "read" ? { ...base, kind } : { ...base, kind, accept: list<string>(attr(tag, "accept")) };
  });
  const defaults = actionSection && attr(actionSection, "defaults");
  return {
    name: sp<string>(attr(root, "value")!), table: optional<string>(root, "table"), domain: optional<string>(root, "domain"),
    attributes, actions,
    defaults: defaults ? { kinds: list<ActionKind>(defaults), position: at(defaults.kind === "spread" ? defaults.value.span.sourceStart : defaults.nameSpan!.sourceStart) } : null,
    position: at(root.nameSpan.sourceStart),
  };
}

function checkSupport(tag: DataTag, source: string, file: string, diagnostics: Diagnostic[]): void {
  const milestone = unsupportedMilestone(tag.name);
  if (milestone) {
    diagnostics.push(error("MESH_NOT_IMPLEMENTED", `Tag \`${tag.name}\` is not implemented; it will be implemented in ${milestone}`, positionAt(source, file, tag.nameSpan.sourceStart), `Remove this tag until ${milestone}`));
    return;
  }
  for (const a of tag.attrs) {
    if (a.kind === "spread") continue;
    const pending = unsupportedMilestone(tag.name, a.name);
    if (pending) diagnostics.push(error("MESH_NOT_IMPLEMENTED", `Attribute \`${tag.name}.${a.name}\` is not implemented; it will be implemented in ${pending}`, positionAt(source, file, a.nameSpan!.sourceStart)));
  }
  for (const child of tags(tag.children)) checkSupport(child, source, file, diagnostics);
}

/** M1 load, structure, model and checks. Collect errors across all files. */
export function buildModel(project: ProjectDescription): BuildResult {
  const diagnostics: Diagnostic[] = [];
  const document: ModelDocument = { resources: [] };
  for (const input of project.files) {
    const file = projectPath(project.root, input.file);
    const parsed = parseData(input.source, file, { customTags: contracts, structural: "reject", unknownTags: "reject" });
    diagnostics.push(...parsed.diagnostics.map((d): Diagnostic => ({
      severity: d.severity, code: "MX", message: d.message,
      position: { file, line: d.line, column: d.column, offset: d.offset }, fix: null,
    })));
    if (!parsed.tree) continue;
    const roots = tags(parsed.tree.children);
    if (roots.length !== 1) {
      diagnostics.push(error("MESH_ROOT_COUNT", "A resource file must contain exactly one `resource`", positionAt(input.source, file, roots[1]?.nameSpan.sourceStart ?? 0), "Declare exactly one resource in this file"));
      continue;
    }
    const before = diagnostics.length;
    checkSupport(roots[0]!, input.source, file, diagnostics);
    if (diagnostics.length !== before) continue;
    document.resources.push(buildResource(roots[0]!, input.source, file));
  }
  const resourceNames = new Set<string>();
  for (const resource of document.resources) {
    if (resourceNames.has(resource.name.value)) diagnostics.push(error("MESH_DUPLICATE_RESOURCE", `Duplicate resource name \"${resource.name.value}\"`, resource.name.position, "Give each resource a unique name"));
    resourceNames.add(resource.name.value);
    if (!resource.attributes.some((attribute) => attribute.primaryKey)) diagnostics.push(error("MESH_PRIMARY_KEY", "Resource must declare a primary key; declare `uuid-primary-key`", resource.name.position, "Declare uuid-primary-key in attributes"));
    const names = new Set<string>();
    for (const attribute of resource.attributes) {
      if (names.has(attribute.name.value)) diagnostics.push(error("MESH_DUPLICATE_ATTRIBUTE", `Duplicate attribute name \"${attribute.name.value}\"`, attribute.name.position));
      names.add(attribute.name.value);
    }
    const actionNames = new Set<string>();
    for (const action of resource.actions) {
      if (actionNames.has(action.name.value)) diagnostics.push(error("MESH_DUPLICATE_ACTION", `Duplicate action name \"${action.name.value}\"`, action.name.position));
      actionNames.add(action.name.value);
      if (action.kind !== "read") for (const item of action.accept) {
        if (!names.has(item.value)) diagnostics.push(error("MESH_UNKNOWN_ACCEPT", `Unknown attribute \"${item.value}\" in \`accept\``, item.position, "Name an attribute declared in this resource"));
      }
    }
  }
  const invalid = findNonJsonValue(document);
  if (invalid) diagnostics.push(error("MESH_NON_JSON", `Model is not JSON-compatible: ${invalid}`, document.resources[0]?.position ?? { file: "mesh.config.ts", line: 1, column: 0, offset: 0 }));
  return { document: diagnostics.some((d) => d.severity === "error") ? null : document, diagnostics };
}

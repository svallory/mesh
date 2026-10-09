import type {
  Attribute,
  Action,
  Computed,
  Entity,
  Expression,
  InputField,
  ModelDocument,
  SourcePosition,
} from "../src/index.ts";
const position: SourcePosition = {
  file: "todo/todo.mesh.mx",
  line: 1,
  column: 0,
  offset: 0,
};
const attribute: Attribute = {
  name: "title",
  type: "string",
  nullable: false,
  primaryKey: false,
  unique: false,
  position,
};
const expression: Expression = { source: "() => true", params: [], position };
// @ts-expect-error functions cannot enter the JSON model as defaults
const fn: Attribute = { ...attribute, default: () => 1 };
// @ts-expect-error optional fields are omitted, never explicit undefined
const missing: Attribute = { ...attribute, default: undefined };
// @ts-expect-error atom is not an attribute type
const atom: Attribute = { ...attribute, type: "atom" };
// @ts-expect-error computed needs exactly one definition
const neither: Computed = { name: "label", type: "string", position };
const bothDefinitions = {
  name: "label",
  type: "string" as const,
  position,
  body: expression,
  rollup: { fn: "count" as const, of: "lines" },
  nullable: false,
};
// @ts-expect-error computed cannot carry two definitions
const both: Computed = bothDefinitions;
const options: InputField = {
  kind: "member",
  ref: { name: "title", position },
  // @ts-expect-error member input has no options
  nullable: true,
};
// @ts-expect-error member references must carry their source position
const unpositioned: InputField = { kind: "member", ref: { name: "title" } };
const key: InputField = {
  kind: "argument",
  name: "id",
  type: "uuid",
  nullable: false,
  position,
  // @ts-expect-error arguments cannot be primary keys
  primaryKey: true,
};
const oldAction: Action = {
  kind: "create",
  name: "create",
  input: [],
  validate: [],
  do: [],
  // @ts-expect-error accept is gone
  accept: [],
  position,
};
// @ts-expect-error root key is entities
const oldDocument: ModelDocument = { resources: [] };
// @ts-expect-error an entity table is resolved, not nullable
const nullTable: Pick<Entity, "table"> = { table: null };
export type Assertions = [
  typeof fn,
  typeof missing,
  typeof atom,
  typeof neither,
  typeof both,
  typeof options,
  typeof unpositioned,
  typeof key,
  typeof oldAction,
  typeof oldDocument,
  typeof nullTable,
];

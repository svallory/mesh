// Compile-time test: checked by `tsc --noEmit` (`bun run typecheck`), not run by `bun test`.
// Each `@ts-expect-error` fails the type check if the line below it ever compiles.
import type {
  Action,
  ActionKind,
  Attribute,
  Diagnostic,
  ModelDocument,
  Resource,
  SourcePosition,
} from "../src/index.ts";

const position: SourcePosition = { file: "a.mx", line: 1, column: 0, offset: 0 };

const attribute: Attribute = {
  name: { value: "title", position },
  source: "attribute",
  type: "string",
  allowNil: false,
  public: true,
  writable: true,
  primaryKey: false,
  default: null,
  constraints: null,
  position,
};

// a function is not a default value
// @ts-expect-error
const fnDefault: Attribute = { ...attribute, default: { value: () => 1, position } };

// undefined is not "absent"; absent is null
// @ts-expect-error
const undefinedDefault: Attribute = { ...attribute, default: undefined };

// @ts-expect-error
const undefinedValue: Attribute = { ...attribute, default: { value: undefined, position } };

// an unregistered type name
// @ts-expect-error
const oldType: Attribute = { ...attribute, type: "number" };

// only atom admits constraints
// @ts-expect-error
const constrainedString: Attribute = { ...attribute, constraints: { oneOf: [] } };

// "no constraints" has one spelling: null
// @ts-expect-error
const innerNull: Attribute = { ...attribute, type: "atom", constraints: { oneOf: null } };

// a name the author wrote carries its position
// @ts-expect-error
const bareAccept: Action = { kind: "create", name: { value: "c", position }, accept: ["title"], position };

// a name the author wrote carries its position too
// @ts-expect-error
const bareName: Attribute = { ...attribute, name: "title" };

// read has no accept
// @ts-expect-error
const readAccept: Action = { kind: "read", name: { value: "r", position }, accept: [], position };

// a required field cannot be omitted
// @ts-expect-error
const noPosition: Attribute = { ...attribute, position: undefined };

// @ts-expect-error
const undefinedTable: Pick<Resource, "table"> = { table: undefined };

// @ts-expect-error
const bareTable: Pick<Resource, "table"> = { table: "posts" };

// @ts-expect-error
const badKind: ActionKind = "upsert";

// @ts-expect-error
const fnPosition: SourcePosition = { ...position, line: () => 1 };

// @ts-expect-error
const badSeverity: Diagnostic = { severity: "info", code: "X", message: "m", position, fix: null };

// @ts-expect-error
const missingResources: ModelDocument = {};

export type Unused = [
  typeof fnDefault,
  typeof undefinedDefault,
  typeof undefinedValue,
  typeof oldType,
  typeof constrainedString,
  typeof innerNull,
  typeof bareAccept,
  typeof bareName,
  typeof readAccept,
  typeof noPosition,
  typeof undefinedTable,
  typeof bareTable,
  typeof badKind,
  typeof fnPosition,
  typeof badSeverity,
  typeof missingResources,
];

// Compile-time test: checked by `tsc --noEmit` (`bun run typecheck`), not run by `bun test`.
// Each `@ts-expect-error` fails the type check if the line below it ever compiles.
import type {
  Action,
  Attribute,
  Diagnostic,
  ModelDocument,
  Resource,
  SourcePosition,
} from "../src/index.ts";

const position: SourcePosition = { file: "a.mx", line: 1, column: 0, offset: 0 };

const attribute: Attribute = {
  name: "title",
  type: "string",
  allowNil: false,
  public: true,
  default: null,
  constraints: null,
  position,
};

// a function is not a default value
// @ts-expect-error
const fnDefault: Attribute = { ...attribute, default: () => 1 };

// undefined is not "absent"; absent is null
// @ts-expect-error
const undefinedDefault: Attribute = { ...attribute, default: undefined };

// an unregistered type name
// @ts-expect-error
const oldType: Attribute = { ...attribute, type: "number" };

// a required field cannot be omitted
// @ts-expect-error
const noPosition: Attribute = { name: "x", type: "string", allowNil: true, public: false, default: null, constraints: null };

// @ts-expect-error
const undefinedTable: Pick<Resource, "table"> = { table: undefined };

// @ts-expect-error
const badKind: Action = { kind: "upsert", name: "x", accept: [], position };

// @ts-expect-error
const fnPosition: SourcePosition = { ...position, line: () => 1 };

// @ts-expect-error
const badSeverity: Diagnostic = { severity: "info", code: "X", message: "m", position, fix: null };

// @ts-expect-error
const missingResources: ModelDocument = {};

export type Unused = [typeof fnDefault, typeof undefinedDefault, typeof oldType, typeof noPosition, typeof undefinedTable, typeof badKind, typeof fnPosition, typeof badSeverity, typeof missingResources];

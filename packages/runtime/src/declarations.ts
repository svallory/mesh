import { FrameworkError, InvalidInputError } from "./errors.ts";
import type { StandardSchemaV1 } from "./standard-schema.ts";

/**
 * The key under which a generated event or command class carries what the runtime asks of it: its kind, its FQN and a
 * test for its instances (`static readonly [DECLARATION]`). The symbol is the runtime's own, so no name a project chooses
 * can be one, and a class from another copy of the runtime is not recognised (as with an entity value).
 */
export const DECLARATION: unique symbol = Symbol("mesh.declaration");

/** What a generated event or command class tells the runtime about itself. */
export interface Declaration<Instance extends object = object> {
  readonly kind: "event" | "command";
  /** `<module>.<Name>`, the stored and wire name (`billing.InvoicePaid`). */
  readonly fqn: string;
  /** True for an instance of this class and nothing else: the check of its private field, which no object literal passes. */
  readonly is: (value: unknown) => value is Instance;
}

/** The class of an event or a command, as `mesh build` generates it. */
export interface Declared<Instance extends object = object> {
  readonly [DECLARATION]: Declaration<Instance>;
}

/**
 * `Mesh.fqnOf(InvoicePaid)`: the fully qualified name of the event or command a generated class declares,
 * `billing.InvoicePaid`. Any other value is a `FrameworkError`.
 */
export function fqnOf(declared: Declared): string {
  const declaration = (declared as { [DECLARATION]?: Declaration } | null | undefined)?.[DECLARATION];
  if (declaration === undefined || typeof declaration.fqn !== "string")
    throw new FrameworkError("Mesh.fqnOf takes the class of an event or a command that `mesh build` generated, and this is not one");
  return declaration.fqn;
}

/**
 * What a generated class's constructor calls to check its fields against the declaration: runs the schema (Zod, built
 * from the field lines) and returns the checked value, or throws `InvalidInputError` with one issue per failed field, each
 * naming the declaration. The check is synchronous, since a constructor is: a schema that answers with a promise is a
 * `FrameworkError`.
 */
export function checkFields<Output>(schema: StandardSchemaV1<unknown, Output>, fields: unknown, kind: Declaration["kind"], fqn: string): Output {
  const result = schema["~standard"].validate(fields);
  if (result instanceof Promise)
    throw new FrameworkError(`The fields of ${kind} ${fqn} were checked by a schema that answers asynchronously, and a constructor cannot wait`);
  if (typeof result !== "object" || result === null || !("value" in result || "issues" in result))
    throw new FrameworkError("Malformed Standard Schema result: expected an object containing value or issues");
  if (result.issues !== undefined) {
    throw new InvalidInputError(result.issues.map((issue: StandardSchemaV1.Issue) => ({
      message: `${issue.message} (${kind} ${fqn})`,
      path: issue.path?.map((segment) => {
        const key = typeof segment === "object" ? segment.key : segment;
        return typeof key === "number" ? key : String(key);
      }) ?? [],
      label: null,
      code: null,
      source: null,
      details: null,
    })));
  }
  return result.value;
}

import { OPERATIONS, SERVICE, runOperation } from "./entity.ts";
import type { ActionContext } from "./index.ts";
import type { PolicySpec } from "./policy.ts";
import type { Scope } from "./expr.ts";
import type { StandardSchemaV1 } from "./standard-schema.ts";

/**
 * Service values (services design, section 5.2). A domain service's operations are called on its value,
 * `Work.handOver(input, context)`: the service's generated file defines the value with `service(...)` and the module
 * barrel exports it beside the entity values. `bindDomain` records it, and each call runs `runOperation` (`entity.ts`)
 * on the binding in scope, else on the connected one: cast, the service's policies, one transaction, the body. While the
 * body runs, an entity call, a `Mesh.privileged` read or a policy question that the operation's `uses` lines do not
 * list is refused, and so is a call of another operation.
 */

export { OPERATIONS, SERVICE, isServiceValue } from "./entity.ts";

/** What an operation's body and every function of its service's policies read: the cast input, the actor, the context and the operation's instant. */
export type OperationScope<I = unknown> = Scope<{ readonly input: I; readonly actor: unknown; readonly context: ActionContext }>;

/** One operation as the generated service file passes it. */
export interface OperationSpec {
  /** The input validator. */
  readonly schema: StandardSchemaV1;
  /** The service policies that cover the operation, chosen at build time: none is a call that is forbidden. */
  readonly policies: readonly PolicySpec[];
  /** The operation's `uses` lines: each entity's FQN, and the actions of it the body may call, read or ask about. */
  readonly uses: Readonly<Record<string, readonly string[]>>;
  /** The body: the authored `run` function, printed over the scope. What it resolves with is what the call resolves with. */
  readonly body: (scope: OperationScope<never>) => Promise<unknown> | unknown;
}

/**
 * How a method of a service value runs an operation: by name, with the input and the context arguments it was given.
 * `never`, so the method's declared result type stands.
 */
export type OperationCall = (operation: string, input: unknown, context: readonly unknown[]) => Promise<never>;

/** A service value: one method per operation, and Mesh's internals under symbols, so no operation name is reserved. */
export type ServiceValue<M extends object> = Readonly<M> & {
  readonly [SERVICE]: string;
  readonly [OPERATIONS]: Readonly<Record<string, OperationSpec>>;
};

/**
 * Define a service value. `operations` holds each operation's spec by name; `members` receives the call each method
 * makes and returns the methods, one per operation, each with its typed signature. The value has a null prototype and is
 * frozen, as an entity value is, so an operation named `toString` or `constructor` is just a member.
 */
export function service<M extends object>(fqn: string, operations: Readonly<Record<string, OperationSpec>>, members: (call: OperationCall) => M): ServiceValue<M> {
  const value = Object.create(null) as object;
  const specs = Object.freeze(Object.assign(Object.create(null) as Record<string, OperationSpec>, operations));
  const call: OperationCall = (operation, input, context) => runOperation(value, fqn, operation, input, context) as Promise<never>;
  Object.defineProperties(value, Object.getOwnPropertyDescriptors(members(call)));
  Object.defineProperties(value, {
    [SERVICE]: { value: fqn },
    [OPERATIONS]: { value: specs },
  });
  return Object.freeze(value) as ServiceValue<M>;
}

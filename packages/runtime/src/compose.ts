import type { DataLayer, DataOperations, Row } from "./data-layer.ts";
import { FrameworkError } from "./errors.ts";
import { readOnlyRecord, type DeepReadonly } from "./load.ts";

/**
 * Action composition (M5, ADR-0068). The functions of an entity file receive `actions`, every generated action
 * function, and `tx`, one function per read action, both bound to the running transaction; an application gets the
 * same two from `transaction(fn, context)` in `#mesh`. The generated index makes one composer per `bind(layer)` and
 * hands it the bound functions once every entity is bound, so an entity's actions file never imports another one:
 * it receives the composer as an argument and asks it for `{ actions, tx }` when a function needs them.
 */

/**
 * An action function as the composer holds it: the input, then the context it passes on. Both parameters are `never`
 * so that every generated function fits, whether the project's context is optional or has a required key.
 */
type ActionFunction = (input: never, context: never) => Promise<unknown>;
/** A read as the composer holds it: the input only. It is the read's body without the authorizer slot. */
type ReadFunction = (input: never) => Promise<unknown>;

/** What a function of an entity file, and an application's `transaction` callback, receive: the actions and the reads, bound to one transaction. */
export interface Composition<A extends object = object, R extends object = object> {
  readonly actions: A;
  readonly tx: R;
}

/** `T`'s functions with deep read-only results: what `actions` and `tx` are inside an entity file, where a record is never changed in place. */
export type ReadOnlyResults<T> = {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => Promise<DeepReadonly<R>> : T[K];
};

/** Made by the generated `bind(layer)`, once per binding. */
export interface Composer {
  /** Hand over every action function (by its top-level name) and every read body (by its read's top-level name); once, after every entity is bound. */
  provide(actions: Readonly<Record<string, ActionFunction>>, reads: Readonly<Record<string, ReadFunction>>): void;
  /**
   * `{ actions, tx }` for the transaction whose operations are `operations`. A call without a context of its own carries
   * `context`. With `where`, the results are read-only views (`readOnlyRecord`), as everything a function of an entity
   * file is handed; an application's `transaction` callback gets plain results.
   */
  bound(operations: DataOperations, context: unknown, where?: string): Composition;
  /** Open a transaction, or join the running one, and call `fn({ actions, tx })`; resolves with what `fn` resolves with. */
  transaction<T>(fn: (composition: Composition) => Promise<T>, context?: unknown): Promise<T>;
}

const ENDED = "`actions` and `tx` are bound to the transaction that handed them out, and it has ended: await every call before the function or the transaction callback returns";

/**
 * The composer of one binding. Every call goes through the layer's `transaction`, so it joins the running one; a joined
 * call that fails marks that transaction, and the outermost call then rejects with a `FrameworkError` whose `cause` is
 * the failure, even when the caller caught it (the data layer's rollback-only rule). The call joins before the called
 * action casts its input, so a cast failure fails the transaction too. A call made after its transaction ended would
 * open a new one; it is refused instead.
 */
export function composer(layer: DataLayer): Composer {
  let functions: Readonly<Record<string, ActionFunction>> | undefined;
  let reads: Readonly<Record<string, ReadFunction>> | undefined;
  const bound = (operations: DataOperations, context: unknown, where?: string): Composition => {
    if (!functions || !reads) throw new FrameworkError("This binding's actions are not all bound yet: `actions` and `tx` exist once bind() has returned");
    const view = (value: unknown): unknown =>
      where === undefined || value === null || typeof value !== "object" ? value : readOnlyRecord(value as Row, where);
    const join = async (call: () => Promise<unknown>): Promise<unknown> => view(await layer.transaction(async (current) => {
      if (current !== operations) throw new FrameworkError(ENDED);
      return call();
    }));
    const actions = Object.freeze(Object.fromEntries(Object.entries(functions).map(([name, fn]) =>
      [name, (input: unknown, own?: unknown) => join(() => (fn as (input: unknown, context: unknown) => Promise<unknown>)(input, own === undefined ? context : own))])));
    const tx = Object.freeze(Object.fromEntries(Object.entries(reads).map(([name, fn]) =>
      [name, (input: unknown) => join(() => (fn as (input: unknown) => Promise<unknown>)(input))])));
    return Object.freeze({ actions, tx });
  };
  return Object.freeze({
    provide(actions: Readonly<Record<string, ActionFunction>>, given: Readonly<Record<string, ReadFunction>>) {
      if (functions) throw new FrameworkError("A composer's actions are provided once, by the bind() that made it");
      functions = actions;
      reads = given;
    },
    bound,
    transaction<T>(fn: (composition: Composition) => Promise<T>, context?: unknown): Promise<T> {
      return layer.transaction((operations) => fn(bound(operations, context)));
    },
  });
}

/**
 * `{ actions, tx }` for an action function, from the composer its entity was bound with. An entity bound alone, by its
 * own `bind<Entity>` instead of the project's `bind`, has none: its functions get stand-ins that throw a
 * `FrameworkError` when a function reads a member of them, so the actions that never use `actions` or `tx` still run.
 */
export function composed(composer: Composer | undefined, operations: DataOperations, context: unknown, where: string): Composition {
  if (composer) return composer.bound(operations, context, where);
  const missing = (root: string): object => new Proxy(Object.freeze({}), {
    get(_target, member) {
      if (typeof member === "symbol") return undefined;
      throw new FrameworkError(`${where} reads \`${root}.${member}\`, which only a binding of the whole project has: bind with bind(layer) from #mesh, not with one entity's bind function`);
    },
  });
  return Object.freeze({ actions: missing("actions"), tx: missing("tx") });
}

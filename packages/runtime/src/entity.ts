// Async context is the one API this library takes from outside the web platform (ARC-10: web-standard APIs "where it
// can"): it keeps the binding in scope across awaits, and the web has none yet (TC39's AsyncContext is a proposal).
// The reference gives the import its type in a program that does not load the host's types itself.
/// <reference types="bun" />
import { AsyncLocalStorage } from "node:async_hooks";
import { composer as makeComposer, type Composer, type Composition } from "./compose.ts";
import type { DataLayer } from "./data-layer.ts";
import { FrameworkError } from "./errors.ts";
import type { ContextArgument } from "./index.ts";
import type { BindOptions } from "./lifecycle.ts";

/**
 * Entity values and bindings (CMP-16, PRJ-13, PRJ-19). An action is called on its entity, `Task.complete(input,
 * context)`: each entity's actions file defines its entity value with `entity(...)`, and the domain barrels export it.
 * The generated `bind(layer, options)` hands every barrel to `bindDomain`, which walks them, binds each entity value it
 * finds and returns a `Binding`. A method of an entity value runs on the binding in scope (the innermost `run` or
 * `transaction` of a binding the call is made inside, kept in async context), else on the binding `connect()` opened,
 * else it rejects with a `FrameworkError`.
 */

/** On an entity value, its FQN (`work.Task`): the mark by which `bindDomain` tells an entity value from any other export. */
export const ENTITY: unique symbol = Symbol("mesh.entity");
/** On an entity value, its actions file's `bind<Entity>(layer, options, composer)`. */
export const BIND: unique symbol = Symbol("mesh.bind");
/** On an entity value, its actions file's `bind<Entity>Reads(layer, options)`, or null when the entity has no read action. */
export const BIND_READS: unique symbol = Symbol("mesh.bindReads");

/** An action function as a binding holds it: the input, then the context, both `never` so every generated method fits. */
type BoundAction = (input: never, ...context: never[]) => Promise<unknown>;
/** What `bind<Entity>` returns: one bound action per method name. */
type BoundActions = Readonly<Record<string, BoundAction>>;

/** An entity's bind function, generated in its actions file. */
export type EntityBind = (layer: DataLayer, options: BindOptions, composer: Composer) => object;
/** An entity's read binder, generated in its actions file. */
export type EntityReadsBind = (layer: DataLayer, options: BindOptions) => object;
/**
 * How a method of an entity value runs an action: by name, with the input and the context arguments it was given. It
 * resolves with what the bound action resolves with; `never`, so the method's own declared result type stands.
 */
export type EntityCall = (action: string, input: unknown, context: readonly unknown[]) => Promise<never>;

/** An entity value: one method per action, and Mesh's internals under symbols, so no action name is reserved. */
export type EntityValue<M extends object> = Readonly<M> & {
  readonly [ENTITY]: string;
  readonly [BIND]: EntityBind;
  readonly [BIND_READS]: EntityReadsBind | null;
};

/**
 * What `bind(layer, options)` returns: the whole domain bound to one data layer, one clock and one seam set. It holds
 * nothing else; the caller owns the layer and closes it (PRJ-13).
 */
export interface Binding<A extends object = object, R extends object = object> {
  /**
   * Run `fn` with this binding in scope (PRJ-19): every entity call made in it, and in everything it awaits, runs on this
   * binding, and each opens its own transaction or joins a running one, as at the top level. Resolves with what `fn`
   * resolves with. A nested `run` puts its own binding in scope.
   */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Open a transaction on this binding's layer, or join the running one, with this binding in scope, and call `fn` with
   * every action function and every read bound to it, carrying `context` unless a call passes its own. Resolves with what
   * `fn` resolves with. A call that fails fails the transaction, even when `fn` catches it.
   */
  transaction<T>(fn: (composition: Composition<A, R>) => Promise<T>, ...context: ContextArgument): Promise<T>;
}

/** What a binding holds behind its two methods. */
interface BindingState {
  readonly binding: Binding;
  /** Each entity's value and bound actions, by FQN. */
  readonly entities: ReadonlyMap<string, { readonly value: object; readonly bound: BoundActions }>;
  /** Calls on this binding that have not settled; `settled` waits for them. */
  inFlight: number;
  readonly idle: (() => void)[];
}

/** The binding in scope: set by `run` and `transaction`, read by every entity call. */
const frame = new AsyncLocalStorage<BindingState>();
/** Each binding's state, by the binding object. */
const states = new WeakMap<object, BindingState>();
/** The binding `connect()` opened, by each entity value it bound: what a call outside `run` and `transaction` uses. */
const connected = new WeakMap<object, BindingState>();

/**
 * Define an entity value. `members` receives the call each method makes and returns the methods, one per action, each
 * with its typed signature. The value has a null prototype and is frozen, so an action named `toString` or
 * `constructor` is just a member.
 */
export function entity<M extends object>(fqn: string, bind: EntityBind, bindReads: EntityReadsBind | null, members: (call: EntityCall) => M): EntityValue<M> {
  const value = Object.create(null) as object;
  const call: EntityCall = (action, input, context) => dispatch(value, fqn, action, input, context) as Promise<never>;
  Object.defineProperties(value, Object.getOwnPropertyDescriptors(members(call)));
  Object.defineProperties(value, {
    [ENTITY]: { value: fqn },
    [BIND]: { value: bind },
    [BIND_READS]: { value: bindReads },
  });
  return Object.freeze(value) as EntityValue<M>;
}

/** True for an entity value made by `entity`. */
export function isEntityValue(value: unknown): value is EntityValue<object> {
  return typeof value === "object" && value !== null && typeof (value as { [ENTITY]?: unknown })[ENTITY] === "string";
}

/** True for a module namespace object (`import * as x`), which is what a barrel's `export * as <name>` holds. */
function isNamespace(value: unknown): value is object {
  return typeof value === "object" && value !== null && Object.prototype.toString.call(value) === "[object Module]";
}

async function counted<T>(state: BindingState, call: () => Promise<T>): Promise<T> {
  state.inFlight++;
  try {
    return await call();
  } finally {
    state.inFlight--;
    if (state.inFlight === 0) for (const resolve of state.idle.splice(0)) resolve();
  }
}

/** One call of an entity value's method: on the binding in scope, else the connected one, counted in flight. */
async function dispatch(value: object, fqn: string, action: string, input: unknown, context: readonly unknown[]): Promise<unknown> {
  const state = frame.getStore() ?? connected.get(value);
  const label = `${fqn}.${action}`;
  if (!state)
    throw new FrameworkError(`${label} was called while not connected: call connect() first, or call it inside run() of bind(db) with a data layer of your own`);
  const entry = state.entities.get(fqn);
  if (entry?.value !== value)
    throw new FrameworkError(`${label} was called inside run() or transaction() of a binding that does not bind it: that binding was made by another project's bind()`);
  return counted(state, () => (entry.bound[action] as (input: unknown, ...context: unknown[]) => Promise<unknown>)(input, ...context));
}

/**
 * Bind every entity value reachable from `domain`, the root barrel (`import * as domain from "./domain/index"`): an export
 * that carries `ENTITY` is bound, a module namespace (a subfolder's barrel) is walked, anything else (types, load
 * functions) is skipped. Called inside the generated `bind`, never at module top level, so every barrel has finished
 * evaluating. The binding's composer gets every action and read body under the names the `actions` and `tx` handles
 * use, the action followed by the entity's export name (`completeTask`), until those handles go.
 */
export function bindDomain<A extends object = object, R extends object = object>(domain: object, layer: DataLayer, options: BindOptions = {}): Binding<A, R> {
  const composer = makeComposer(layer, options.seams);
  const entities = new Map<string, { readonly value: object; readonly bound: BoundActions }>();
  const actions: Record<string, BoundAction> = {};
  const reads: Record<string, BoundAction> = {};
  const walk = (namespace: object) => {
    for (const [name, value] of Object.entries(namespace)) {
      if (isEntityValue(value)) {
        const fqn = value[ENTITY];
        const seen = entities.get(fqn);
        if (seen?.value === value) continue;
        if (seen) throw new FrameworkError(`Two entity values in the domain have the FQN ${fqn}`);
        const bound = value[BIND](layer, options, composer) as BoundActions;
        entities.set(fqn, { value, bound });
        for (const [method, fn] of Object.entries(bound)) actions[`${method}${name}`] = fn;
        const bodies = value[BIND_READS]?.(layer, options) as BoundActions | undefined;
        if (bodies) for (const [method, fn] of Object.entries(bodies)) reads[`${method}${name}`] = fn;
      } else if (isNamespace(value)) walk(value);
    }
  };
  walk(domain);
  composer.provide(Object.freeze(actions), Object.freeze(reads) as Parameters<Composer["provide"]>[1]);
  const binding: Binding<A, R> = Object.freeze({
    async run<T>(fn: () => Promise<T>): Promise<T> {
      return frame.run(state, fn);
    },
    transaction<T>(fn: (composition: Composition<A, R>) => Promise<T>, ...[context]: ContextArgument): Promise<T> {
      return counted(state, () => frame.run(state, () => composer.transaction((composition) => fn(composition as Composition<A, R>), context)));
    },
  });
  const state: BindingState = { binding, entities, inFlight: 0, idle: [] };
  states.set(binding, state);
  return binding;
}

function stateOf(binding: Binding): BindingState {
  const state = states.get(binding);
  if (!state) throw new FrameworkError("Not a binding made by bind()");
  return state;
}

/** The binding in scope: the innermost `run` or `transaction` of a binding this call is made inside, if any. */
export function bindingInScope(): Binding | undefined {
  return frame.getStore()?.binding;
}

/** Make `binding` the one its entity values run on outside `run` and `transaction`: what `connect()` does with its binding. */
export function connectBinding(binding: Binding): void {
  const state = stateOf(binding);
  for (const { value } of state.entities.values()) connected.set(value, state);
}

/** Undo `connectBinding`: a call made outside `run` and `transaction` from now on is not connected. Calls in flight go on. */
export function releaseBinding(binding: Binding): void {
  const state = stateOf(binding);
  for (const { value } of state.entities.values()) if (connected.get(value) === state) connected.delete(value);
}

/** Resolves once every call made on `binding` (entity calls and `transaction`) has settled, however long they take. */
export async function settled(binding: Binding): Promise<void> {
  const state = stateOf(binding);
  while (state.inFlight > 0) await new Promise<void>((resolve) => state.idle.push(resolve));
}

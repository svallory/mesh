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

/**
 * The async context a project's bindings keep themselves in scope with, across awaits: an `AsyncLocalStorage`, which the
 * generated `binding.ts` makes, one per project, and hands to `bindDomain`. The library takes it rather than importing
 * it, so it keeps to web-standard APIs (ADR-0025) while the web has no async context of its own (TC39's AsyncContext is
 * a proposal).
 */
export interface AsyncFrame {
  /** Call `fn` with `store` in scope, and in everything `fn` awaits. */
  run<R>(store: unknown, fn: () => R): R;
  /** What the innermost `run` this call is made inside put in scope, or undefined outside any. */
  getStore(): unknown;
}

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
  /** True once `releaseBinding` let go of it (`disconnect()`), until `connectBinding` takes it again. */
  released: boolean;
}

/** Each binding's state, by the binding object. */
const states = new WeakMap<object, BindingState>();
/** The async frame each entity value's bindings keep themselves in scope with: the project's, set by `bindDomain`. */
const frames = new WeakMap<object, AsyncFrame>();
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

/**
 * The binding a frame holds in scope, unless `disconnect()` released it and nothing runs on it any more: an async
 * continuation that outlives its calls (a timer, a promise chained inside a `transaction`) must not reach a closed layer.
 * A call made while another is still in flight on it (a call inside a `transaction` that `disconnect()` waits for) runs.
 */
function inScope(frame: AsyncFrame | undefined): BindingState | undefined {
  const state = frame?.getStore() as BindingState | undefined;
  return state && !(state.released && state.inFlight === 0) ? state : undefined;
}

/** One call of an entity value's method: on the binding in scope, else the connected one, counted in flight. */
async function dispatch(value: object, fqn: string, action: string, input: unknown, context: readonly unknown[]): Promise<unknown> {
  const state = inScope(frames.get(value)) ?? connected.get(value);
  const label = `${fqn}#${action}`;
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
 * evaluating. `frame` is the project's async frame: every binding of one project shares it, so a nested `run` of another
 * binding is the innermost. The binding's composer gets every action and read body under the names the `actions` and
 * `tx` handles use, the action followed by the entity's export name (`completeTask`), until those handles go; two calls
 * with one such name are a `FrameworkError`.
 */
export function bindDomain<A extends object = object, R extends object = object>(domain: object, layer: DataLayer, options: BindOptions, frame: AsyncFrame): Binding<A, R> {
  const composer = makeComposer(layer, options.seams);
  const entities = new Map<string, { readonly value: object; readonly bound: BoundActions }>();
  const handles = { actions: {} as Record<string, BoundAction>, tx: {} as Record<string, BoundAction> };
  const origins = new Map<string, string>();
  const add = (handle: keyof typeof handles, key: string, fn: BoundAction, origin: string) => {
    const other = origins.get(`${handle}.${key}`);
    if (other !== undefined)
      throw new FrameworkError(`${other} and ${origin} would both be ${handle}.${key}: rename one of the two`);
    origins.set(`${handle}.${key}`, origin);
    handles[handle][key] = fn;
  };
  const walk = (namespace: object) => {
    for (const [name, value] of Object.entries(namespace)) {
      if (isEntityValue(value)) {
        const fqn = value[ENTITY];
        const seen = entities.get(fqn);
        if (seen?.value === value) continue;
        if (seen) throw new FrameworkError(`Two entity values in the domain have the FQN ${fqn}`);
        const before = frames.get(value);
        if (before !== undefined && before !== frame)
          throw new FrameworkError(`${fqn} was bound before with another async frame: a project's entity values are bound only through its own bind()`);
        const bound = value[BIND](layer, options, composer) as BoundActions;
        entities.set(fqn, { value, bound });
        for (const [method, fn] of Object.entries(bound)) add("actions", `${method}${name}`, fn, `${fqn}#${method}`);
        const bodies = value[BIND_READS]?.(layer, options) as BoundActions | undefined;
        if (bodies) for (const [method, fn] of Object.entries(bodies)) add("tx", `${method}${name}`, fn, `${fqn}#${method}`);
      } else if (isNamespace(value)) walk(value);
    }
  };
  walk(domain);
  for (const { value } of entities.values()) frames.set(value, frame);
  const { actions, tx: reads } = handles;
  composer.provide(Object.freeze(actions), Object.freeze(reads) as Parameters<Composer["provide"]>[1]);
  const binding: Binding<A, R> = Object.freeze({
    async run<T>(fn: () => Promise<T>): Promise<T> {
      return frame.run(state, fn);
    },
    transaction<T>(fn: (composition: Composition<A, R>) => Promise<T>, ...[context]: ContextArgument): Promise<T> {
      return counted(state, () => frame.run(state, () => composer.transaction((composition) => fn(composition as Composition<A, R>), context)));
    },
  });
  const state: BindingState = { binding, entities, inFlight: 0, idle: [], released: false };
  states.set(binding, state);
  return binding;
}

function stateOf(binding: Binding): BindingState {
  const state = states.get(binding);
  if (!state) throw new FrameworkError("Not a binding made by bind()");
  return state;
}

/**
 * The binding in scope in `frame`, the project's async frame: the innermost `run` or `transaction` of a binding this call
 * is made inside, if any, and not one `disconnect()` released once nothing runs on it.
 */
export function bindingInScope(frame: AsyncFrame): Binding | undefined {
  return inScope(frame)?.binding;
}

/** Make `binding` the one its entity values run on outside `run` and `transaction`: what `connect()` does with its binding. */
export function connectBinding(binding: Binding): void {
  const state = stateOf(binding);
  state.released = false;
  for (const { value } of state.entities.values()) connected.set(value, state);
}

/**
 * Undo `connectBinding`: a call made outside `run` and `transaction` from now on is not connected, and so is one made in
 * a scope of this binding once nothing runs on it. Calls in flight go on, and so do the calls they make.
 */
export function releaseBinding(binding: Binding): void {
  const state = stateOf(binding);
  state.released = true;
  for (const { value } of state.entities.values()) if (connected.get(value) === state) connected.delete(value);
}

/** Resolves once every call made on `binding` (entity calls and `transaction`) has settled, however long they take. */
export async function settled(binding: Binding): Promise<void> {
  const state = stateOf(binding);
  while (state.inFlight > 0) await new Promise<void>((resolve) => state.idle.push(resolve));
}

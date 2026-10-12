import type { DataLayer, DataOperations, Row } from "./data-layer.ts";
import { FrameworkError } from "./errors.ts";
import type { Clock } from "./expr.ts";
import type { BindOptions } from "./lifecycle.ts";
import { evaluatingNow, readOnlyRecord } from "./load.ts";
import { outermost } from "./seams.ts";

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
/** On an entity value, its actions file's `bind<Entity>(layer, options, frame)`. */
export const BIND: unique symbol = Symbol("mesh.bind");
/** On an entity value, its actions file's `bind<Entity>Reads(layer, options, frame)`, or null when the entity has no read action. */
export const BIND_READS: unique symbol = Symbol("mesh.bindReads");

/** An action function as a binding holds it: the input, then the context, both `never` so every generated method fits. */
type BoundAction = (input: never, ...context: never[]) => Promise<unknown>;
/** What `bind<Entity>` returns: one bound action per method name. */
type BoundActions = Readonly<Record<string, BoundAction>>;
/**
 * A read body as `bind<Entity>Reads` returns it: the input, the context of the call it runs for, the instant its loads
 * read, and whether a load runs the read policies of what it reaches. `privileged` passes no policies.
 */
type ReadBody = (input: unknown, context?: unknown, clock?: Clock, policies?: boolean) => Promise<unknown>;

/**
 * How the generated actions of a binding tell it what runs (TXN-16, TXN-18, ACT-09): `bindDomain` makes one per binding
 * and hands it to every `bind<Entity>` and `bind<Entity>Reads`. An entity bound alone, by its own `bind<Entity>`, gets
 * `NO_FRAME`.
 */
export interface ActionFrame {
  /**
   * Run `fn`, the work of the action `label` (`work.Claim#acquire`: its policies, checks, steps and `set` values) inside
   * `tx`, the action's transaction, at `clock`, the action's instant. An entity call made in it joins `tx`, a
   * `privileged` read joins it and reads `clock`, and both hand back read-only views; one made after `tx` ended is refused.
   */
  within<T>(tx: DataOperations, clock: Clock, label: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Run `fn`, application code an action runs inside its transaction (the `afterWrite` seam), in the action's transaction
   * and at its instant but without its label: an entity call or a `privileged` read made in it resolves with plain
   * values, as in the application's `transaction` (ACT-09).
   */
  plain<T>(fn: () => Promise<T>): Promise<T>;
  /** Run `fn` while `what` (`computed :lapsed of work.Claim`, `policy :member of work.Task`) is evaluated: `privileged` throws in it (TXN-18). */
  marked<T>(what: string, fn: () => T): T;
}

/** The frame of an entity bound alone: its functions run as they are, and a call they make goes to the binding in scope or the connected one. */
export const NO_FRAME: ActionFrame = Object.freeze({
  within: <T>(_tx: DataOperations, _clock: Clock, _label: string, fn: () => Promise<T>): Promise<T> => fn(),
  plain: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  marked: <T>(_what: string, fn: () => T): T => fn(),
});

/** An entity's bind function, generated in its actions file. */
export type EntityBind = (layer: DataLayer, options: BindOptions, frame?: ActionFrame) => object;
/** An entity's read binder, generated in its actions file; `P` is what `privileged` of the entity returns. */
export type EntityReadsBind<P extends object = object> = (layer: DataLayer, options: BindOptions, frame?: ActionFrame) => P;
/**
 * How a method of an entity value runs an action: by name, with the input and the context arguments it was given. It
 * resolves with what the bound action resolves with; `never`, so the method's own declared result type stands.
 */
export type EntityCall = (action: string, input: unknown, context: readonly unknown[]) => Promise<never>;

/**
 * An entity value: one method per action, and Mesh's internals under symbols, so no action name is reserved. `P` is what
 * `privileged` of it returns: one function per read action.
 */
export type EntityValue<M extends object, P extends object = {}> = Readonly<M> & {
  readonly [ENTITY]: string;
  readonly [BIND]: EntityBind;
  readonly [BIND_READS]: EntityReadsBind<P> | null;
};

/**
 * What `privileged(Entity)` returns (TXN-16, TXN-17): one function per read action of the entity, named as on the entity,
 * each `(input, context?)`, resolving with what the read gives with no policy run (a `belongs-to` it loads is never null,
 * POL-17).
 */
export type Privileged<E> = E extends { readonly [BIND_READS]: EntityReadsBind<infer P> | null } ? Readonly<P> : never;

/**
 * What `bind(layer, options)` returns: the whole domain bound to one data layer, one clock and one seam set. It holds
 * nothing else; the caller owns the layer and closes it (PRJ-13).
 */
export interface Binding {
  /**
   * Run `fn` with this binding in scope (PRJ-19): every entity call made in it, and in everything it awaits, runs on this
   * binding, and each opens its own transaction or joins a running one, as at the top level. Resolves with what `fn`
   * resolves with. A nested `run` puts its own binding in scope.
   */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Open a transaction on this binding's layer, or join the running one, and call `fn` inside it with this binding in
   * scope (TXN-20): every entity call and `privileged` read made in it joins the transaction, and hands back plain results
   * (ACT-09). `fn` is handed nothing. Resolves with what `fn` resolves with. A call that fails fails the transaction, even
   * when `fn` catches it.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

/** What a binding holds behind its two methods. */
interface BindingState {
  binding: Binding;
  readonly layer: DataLayer;
  /** Each entity's value, bound actions and `privileged` reads, by FQN. */
  readonly entities: Map<string, { readonly value: object; readonly bound: BoundActions; readonly reads: object }>;
  /** Calls on this binding that have not settled; `settled` waits for them. */
  inFlight: number;
  readonly idle: (() => void)[];
  /** True once `releaseBinding` let go of it (`disconnect()`), until `connectBinding` takes it again. */
  released: boolean;
}

/**
 * What a binding keeps in the project's async frame: the binding, and the `run`, `transaction` or entity call this
 * belongs to (`scope`, live until it settles); inside an action's transaction, that transaction, the action's instant and
 * its label; inside an application's `transaction`, the transaction; while a computed field or a read policy is
 * evaluated, which one (`mark`).
 */
interface FrameStore {
  readonly state: BindingState;
  readonly scope: { live: boolean };
  readonly tx?: DataOperations;
  readonly clock?: Clock;
  readonly label?: string;
  readonly mark?: string;
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
export function entity<M extends object, P extends object = {}>(fqn: string, bind: EntityBind, bindReads: EntityReadsBind<P> | null, members: (call: EntityCall) => M): EntityValue<M, P> {
  const value = Object.create(null) as object;
  const call: EntityCall = (action, input, context) => dispatch(value, fqn, action, input, context) as Promise<never>;
  Object.defineProperties(value, Object.getOwnPropertyDescriptors(members(call)));
  Object.defineProperties(value, {
    [ENTITY]: { value: fqn },
    [BIND]: { value: bind },
    [BIND_READS]: { value: bindReads },
  });
  return Object.freeze(value) as EntityValue<M, P>;
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

/** Run `fn` with `store` in scope, and mark its scope ended once `fn` settles. */
async function scoped<T>(frame: AsyncFrame, store: FrameStore, fn: () => Promise<T>): Promise<T> {
  try {
    return await frame.run(store, fn);
  } finally {
    store.scope.live = false;
  }
}

/**
 * What a frame holds in scope, unless `disconnect()` released its binding and the `run`, `transaction` or call it belongs
 * to has settled: an async continuation that outlives them (a timer, a promise chained inside a `transaction`) must not
 * reach a closed layer. A call made inside a `run` or `transaction` that has not settled runs, even once `disconnect()`
 * released the binding: `disconnect()` waits for it.
 */
function inScope(frame: AsyncFrame | undefined): FrameStore | undefined {
  const store = frame?.getStore() as FrameStore | undefined;
  return store && !(store.state.released && !store.scope.live) ? store : undefined;
}

/**
 * A new `run` or `transaction` scope of `state`'s: live until it settles. Once `disconnect()` released the binding, only
 * one opened inside a live scope of the same binding is live: work in flight goes on, and so does what it calls.
 */
const live = (state: BindingState, frame: AsyncFrame) => ({ live: !state.released || inScope(frame)?.state === state });

const ENDED = "a call was made inside a transaction that has ended: await every entity call and privileged read before the function or the transaction callback returns";

/**
 * Run `call` for a caller whose frame is `caller` on the binding `state`. Inside a transaction of that binding (an
 * action's or an application's), the call joins it and is refused once it has ended, since it would open a new one;
 * inside an action's function, what it resolves with is a read-only view (ACT-09).
 */
async function forCaller(state: BindingState, caller: FrameStore | undefined, call: () => Promise<unknown>): Promise<unknown> {
  const own = caller?.state === state ? caller : undefined;
  const tx = own?.tx;
  const result = tx
    ? await state.layer.transaction(async (current) => {
      if (current !== tx) throw new FrameworkError(ENDED);
      return call();
    })
    : await call();
  return own?.label === undefined || result === null || typeof result !== "object" ? result : readOnlyRecord(result as Row, own.label);
}

/** The binding a call runs on: the one in scope, else the connected one; a `FrameworkError` when there is none, or when it does not bind `value`. */
function bindingFor(value: object, label: string, caller: FrameStore | undefined) {
  const state = caller?.state ?? connected.get(value);
  if (!state)
    throw new FrameworkError(`${label} was called while not connected: call connect() first, or call it inside run() of bind(db) with a data layer of your own`);
  const entry = state.entities.get((value as EntityValue<object>)[ENTITY]);
  if (entry?.value !== value)
    throw new FrameworkError(`${label} was called inside run() or transaction() of a binding that does not bind it: that binding was made by another project's bind()`);
  return { state, entry };
}

/**
 * One call of an entity value's method: on the binding in scope, else the connected one, counted in flight. While a
 * computed field or a read policy is evaluated it is refused, as `privileged` is.
 */
async function dispatch(value: object, fqn: string, action: string, input: unknown, context: readonly unknown[]): Promise<unknown> {
  const frame = frames.get(value);
  const caller = inScope(frame);
  const mark = caller?.mark ?? evaluatingNow();
  if (mark !== undefined) throw marked(`${fqn}#${action}`, mark);
  const { state, entry } = bindingFor(value, `${fqn}#${action}`, caller);
  const fn = entry.bound[action] as (input: unknown, ...context: unknown[]) => Promise<unknown>;
  // The action runs in a frame of its own: what it calls is its own work, not its caller's. Its scope is live: past
  // `bindingFor`, the caller is in a live scope of the binding, or the binding is connected.
  return counted(state, () => forCaller(state, caller, () => scoped(frame!, { state, scope: { live: true } }, () => fn(input, ...context))));
}

/**
 * The reads of `value` with no policy run (TXN-16, TXN-17): `privileged(Task).read(input, context?)` runs the read action's
 * body, on the binding in scope, else the connected one. Inside an action it joins the action's transaction and reads the
 * action's instant (`now()` in what it loads), and hands back read-only views; it never takes the action's context: what
 * it loads reads only the context the call passes. While a computed field or a read policy is evaluated it throws (TXN-18):
 * those read only the record and what it loads. A value that is not an entity value is a `FrameworkError`.
 */
export function privileged<E extends EntityValue<object, object>>(entity: E): Privileged<E> {
  if (!isEntityValue(entity))
    throw new FrameworkError(`privileged() takes an entity value, such as privileged(Task), and was given ${entity === null ? "null" : typeof entity === "object" ? "an object that is not one" : typeof entity}`);
  const fqn = entity[ENTITY];
  const caller = inScope(frames.get(entity));
  const mark = caller?.mark ?? evaluatingNow();
  if (mark !== undefined) throw marked(`privileged(${fqn})`, mark);
  return bindingFor(entity, `privileged(${fqn})`, caller).entry.reads as Privileged<E>;
}

function marked(what: string, mark: string): FrameworkError {
  return new FrameworkError(`${what} was called while ${mark} is evaluated: a computed field and a read policy read the record and what it loads, and call no action and no privileged read. Load what it needs instead, or do it in a step or a check`);
}

/** The `privileged` reads of one entity on one binding, made once by `bindDomain`. */
function privilegedReads(state: BindingState, frame: AsyncFrame, fqn: string, bodies: Readonly<Record<string, ReadBody>> | undefined): object {
  const reads: Record<string, (input: unknown, context?: unknown) => Promise<unknown>> = Object.create(null);
  for (const [name, body] of Object.entries(bodies ?? {}))
    reads[name] = async (input: unknown, context?: unknown) => {
      const caller = inScope(frame);
      const mark = caller?.mark ?? evaluatingNow();
      if (mark !== undefined) throw marked(`privileged(${fqn}).${name}`, mark);
      // The action's instant, never its context (TXN-16): what the read loads reads the context this call passes.
      const clock = caller?.state === state ? caller.clock : undefined;
      return counted(state, () => forCaller(state, caller, () => body(input, context, clock, false)));
    };
  return Object.freeze(reads);
}

/** The frame a binding hands its entities' bind functions. */
function actionFrame(frame: AsyncFrame, state: BindingState): ActionFrame {
  const here = (): FrameStore => inScope(frame) ?? { state, scope: live(state, frame) };
  return Object.freeze({
    within<T>(tx: DataOperations, clock: Clock, label: string, fn: () => Promise<T>): Promise<T> {
      return frame.run({ state, scope: here().scope, tx, clock, label } satisfies FrameStore, fn);
    },
    plain<T>(fn: () => Promise<T>): Promise<T> {
      const store = inScope(frame);
      if (store?.label === undefined) return fn();
      const { label: _label, ...plain } = store;
      return frame.run(plain satisfies FrameStore, fn);
    },
    marked<T>(what: string, fn: () => T): T {
      return frame.run({ ...here(), mark: what } satisfies FrameStore, fn);
    },
  });
}

/**
 * Bind every entity value reachable from `domain`, the root barrel (`import * as domain from "./domain/index"`): an export
 * that carries `ENTITY` is bound, a module namespace (a subfolder's barrel) is walked, anything else (types, load
 * functions) is skipped. Called inside the generated `bind`, never at module top level, so every barrel has finished
 * evaluating. `frame` is the project's async frame: every binding of one project shares it, so a nested `run` of another
 * binding is the innermost.
 */
export function bindDomain(domain: object, layer: DataLayer, options: BindOptions, frame: AsyncFrame): Binding {
  const entities: BindingState["entities"] = new Map();
  const state: BindingState = { binding: undefined as unknown as Binding, layer, entities, inFlight: 0, idle: [], released: false };
  const handle = actionFrame(frame, state);
  const walk = (namespace: object) => {
    for (const value of Object.values(namespace)) {
      if (isEntityValue(value)) {
        const fqn = value[ENTITY];
        const seen = entities.get(fqn);
        if (seen?.value === value) continue;
        if (seen) throw new FrameworkError(`Two entity values in the domain have the FQN ${fqn}`);
        const before = frames.get(value);
        if (before !== undefined && before !== frame)
          throw new FrameworkError(`${fqn} was bound before with another async frame: a project's entity values are bound only through its own bind()`);
        const bound = value[BIND](layer, options, handle) as BoundActions;
        const bodies = value[BIND_READS]?.(layer, options, handle) as Readonly<Record<string, ReadBody>> | undefined;
        entities.set(fqn, { value, bound, reads: privilegedReads(state, frame, fqn, bodies) });
      } else if (isNamespace(value)) walk(value);
    }
  };
  walk(domain);
  for (const { value } of entities.values()) frames.set(value, frame);
  const binding: Binding = Object.freeze({
    run<T>(fn: () => Promise<T>): Promise<T> {
      return scoped(frame, { state, scope: live(state, frame) }, fn);
    },
    transaction<T>(fn: () => Promise<T>): Promise<T> {
      // The application's `transaction` is an outermost transaction like any action's (TXN-14): `afterCommit` runs once
      // when it commits, with every change made inside it. One that joins a running transaction leaves that to the outer one.
      const scope = live(state, frame);
      const body = (tx: DataOperations) => frame.run({ state, scope, tx } satisfies FrameStore, () => fn());
      return counted(state, async () => {
        try {
          return await (layer.refuseIfFailed() ? layer.transaction(body) : outermost(layer, options.seams, body));
        } finally {
          scope.live = false;
        }
      });
    },
  });
  state.binding = binding;
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
 * is made inside, if any, and not one `disconnect()` released once that `run` or `transaction` has settled.
 */
export function bindingInScope(frame: AsyncFrame): Binding | undefined {
  return inScope(frame)?.state.binding;
}

/** Make `binding` the one its entity values run on outside `run` and `transaction`: what `connect()` does with its binding. */
export function connectBinding(binding: Binding): void {
  const state = stateOf(binding);
  state.released = false;
  for (const { value } of state.entities.values()) connected.set(value, state);
}

/**
 * Undo `connectBinding`: a call made outside `run` and `transaction` from now on is not connected, and so is one made in
 * a scope of this binding once that scope has settled. Calls in flight go on, and so do the calls they make.
 */
export function releaseBinding(binding: Binding): void {
  const state = stateOf(binding);
  state.released = true;
  for (const { value } of state.entities.values()) if (connected.get(value) === state) connected.delete(value);
}

/** Resolves once every call made on `binding` (entity calls, `privileged` reads and `transaction`) has settled, however long they take. */
export async function settled(binding: Binding): Promise<void> {
  const state = stateOf(binding);
  while (state.inFlight > 0) await new Promise<void>((resolve) => state.idle.push(resolve));
}

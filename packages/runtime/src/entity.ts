import { Answer, answeringLayer, type Decision } from "./answer.ts";
import type { DataLayer, DataOperations, Row } from "./data-layer.ts";
import { FrameworkError } from "./errors.ts";
import { pinClock, type Clock } from "./expr.ts";
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
   * The instant an action call or a read reads (ACT-29: one transaction, one time): when the call joins a transaction of
   * this binding (an action calls it from a step, or the application calls it inside its `transaction(fn)`), the clock of
   * that transaction, pinned once by the call or the `transaction` that opened it; else `clock`, the binding's, pinned on
   * its first read (`pinClock`), so a call that opens its own transaction reads its own instant.
   */
  clock(clock: Clock | undefined): Clock;
  /**
   * Run `fn`, the work of the action `label` (`work.Claim#acquire`: its policies, checks, steps and `set` values) inside
   * `tx`, the action's transaction, at `clock`, the transaction's instant. An entity call made in it joins `tx` and reads
   * `clock`, a `privileged` read joins it and reads `clock`, and both hand back read-only views; one made after `tx` ended
   * is refused.
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
  clock: (clock: Clock | undefined): Clock => pinClock(clock),
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
 * What `Mesh.privileged(Entity)` returns (TXN-16, TXN-17): one function per read action of the entity, named as on the entity,
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
  /** What `bind(layer, options)` was given: `Mesh.checkPolicies` binds the entity it asks about with the same clock. */
  readonly options: BindOptions;
  /** Each entity's value, bound actions and read bodies (what its `privileged` reads run on this binding), by FQN. */
  readonly entities: Map<string, { readonly value: object; readonly bound: BoundActions; readonly reads: Readonly<Record<string, ReadBody>> }>;
  /** Calls on this binding that have not settled; `settled` waits for them. */
  inFlight: number;
  readonly idle: (() => void)[];
  /** True once `releaseBinding` let go of it (`disconnect()`), until `connectBinding` takes it again. */
  released: boolean;
}

/**
 * What a binding keeps in the project's async frame: the binding, and the `run`, `transaction` or entity call this
 * belongs to (`scope`, live until it settles); inside an action's transaction, that transaction, its instant (`clock`,
 * ACT-29: the one the outermost call or `transaction` pinned) and the action's label; inside an application's
 * `transaction`, the transaction and its instant; in an entity call that joins a transaction, before the call runs its
 * own work, that transaction's instant; while a computed field or a read policy is evaluated, which one (`mark`).
 */
interface FrameStore {
  readonly state: BindingState;
  readonly scope: { live: boolean };
  readonly tx?: DataOperations;
  readonly clock?: Clock;
  readonly label?: string;
  readonly mark?: string;
  /** Where the action call this belongs to stands in its chain of nested calls (TXN-21): carried by every store made inside it. */
  readonly calls?: CallChain;
}

/**
 * A chain of nested action calls (TXN-21): the calls an action, or its policies, steps, `set` and `validate` functions or
 * helpers, start while it runs, and the calls those start. The async context carries it, so it follows the chain through a
 * pre-check, which runs before the action's transaction opens, and through an application's `transaction(fn)`.
 */
interface CallChain {
  /** This call's place in the chain: 1 for the call that began it. */
  readonly depth: number;
  readonly root: CallRoot;
}

/** What the calls of one chain share: the action at its root, and the error once the chain went too deep. */
interface CallRoot {
  readonly label: string;
  /**
   * Set when a call is made more than `MAX_CALL_DEPTH` deep. The error sticks to the root call: every call made under it
   * throws it at entry, and the root call rejects with it once it settles, whatever a helper or a step caught on the way,
   * so a helper that catches cannot keep a cycle going.
   */
  tooDeep?: FrameworkError;
}

/**
 * How many action calls may be nested one inside another (TXN-21). A legitimate recursion over data (a comment thread, an
 * org chart, a category tree) can run deeper than the 32 of `MAX_QUESTION_DEPTH`, but not near this: a cycle in the data or
 * in the code would otherwise recurse until memory runs out.
 */
const MAX_CALL_DEPTH = 1_000;

/** Each binding's state, by the binding object. */
const states = new WeakMap<object, BindingState>();
/** The async frame each entity value's bindings keep themselves in scope with: the project's, set by `bindDomain`. */
const frames = new WeakMap<object, AsyncFrame>();
/** The binding `connect()` opened, by each entity value it bound: what a call outside `run` and `transaction` uses. */
const connected = new WeakMap<object, BindingState>();
/** What `Mesh.privileged(value)` returns, by entity value: made when a binding first binds it, and tied to no binding. */
const handles = new WeakMap<object, object>();
/**
 * Each method of each entity value, by the function itself: its entity value, FQN and action name. `entity` fills it, so
 * `Mesh.checkPolicies(Todo.complete, ...)` knows the action from the function alone, and nothing is added to the function
 * (CMP-21). No other function is in it: a copy made with `.bind`, a `privileged` read or a plain function.
 */
const actions = new WeakMap<object, { readonly value: object; readonly fqn: string; readonly name: string }>();

/**
 * Define an entity value. `members` receives the call each method makes and returns the methods, one per action, each
 * with its typed signature. The value has a null prototype and is frozen, so an action named `toString` or
 * `constructor` is just a member.
 */
export function entity<M extends object, P extends object = {}>(fqn: string, bind: EntityBind, bindReads: EntityReadsBind<P> | null, members: (call: EntityCall) => M): EntityValue<M, P> {
  const value = Object.create(null) as object;
  const call: EntityCall = (action, input, context) => dispatch(value, fqn, action, input, context) as Promise<never>;
  const methods = Object.getOwnPropertyDescriptors(members(call));
  Object.defineProperties(value, methods);
  for (const [name, { value: method }] of Object.entries(methods))
    if (typeof method === "function") actions.set(method, { value, fqn, name });
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
 * inside an action's function, what it resolves with is a read-only view (ACT-09). `layer` is the one the call joins
 * through: the binding's, or inside a `Mesh.checkPolicies` the binding's probe's.
 */
async function forCaller(state: BindingState, caller: FrameStore | undefined, call: () => Promise<unknown>, layer = state.layer): Promise<unknown> {
  const own = caller?.state === state ? caller : undefined;
  const tx = own?.tx;
  const result = tx
    ? await layer.transaction(async (current) => {
      if (current !== tx) throw new FrameworkError(ENDED);
      return call();
    })
    : await call();
  return own?.label === undefined || result === null || typeof result !== "object" ? result : readOnlyRecord(result as Row, own.label);
}

const notConnected = (label: string) =>
  new FrameworkError(`${label} was called while not connected: call connect() first, or call it inside run() of bind(db) with a data layer of your own`);

/** The binding a call runs on: the one in scope, else the connected one; a `FrameworkError` when there is none, or when it does not bind `value`. */
function bindingFor(value: object, label: string, caller: FrameStore | undefined) {
  const state = caller?.state ?? connected.get(value);
  if (!state) throw notConnected(label);
  const entry = state.entities.get((value as EntityValue<object>)[ENTITY]);
  if (entry?.value !== value)
    throw new FrameworkError(`${label} was called inside run() or transaction() of a binding that does not bind it: that binding was made by another project's bind()`);
  return { state, entry };
}

/**
 * One call of an entity value's method: on the binding in scope, else the connected one, counted in flight. While a
 * computed field or a read policy is evaluated it is refused, as `privileged` is.
 */
function dispatch(value: object, fqn: string, action: string, input: unknown, context: readonly unknown[]): Promise<unknown> {
  // Refused by throwing, not by rejecting, as `Mesh.privileged` and `Mesh.checkPolicies` are: a computed field whose helper
  // returns the promise of a refused call would otherwise report "returned a promise" and lose the reason.
  const mark = inScope(frames.get(value))?.mark ?? evaluatingNow();
  if (mark !== undefined) throw marked(`${fqn}#${action}`, mark);
  return dispatchCall(value, fqn, action, input, context);
}
async function dispatchCall(value: object, fqn: string, action: string, input: unknown, context: readonly unknown[]): Promise<unknown> {
  const frame = frames.get(value);
  const caller = inScope(frame);
  const { state, entry } = bindingFor(value, `${fqn}#${action}`, caller);
  // In a store a question made (`Mesh.checkPolicies`, CMP-21), no write action starts, on any binding of the project: it
  // is refused here, before it casts its input or runs anything of its own. A read runs on the binding's probe, on the
  // question's layer over the binding's own, so it reads what it would read and what it rejects with fails no running
  // transaction. What stays out of reach is listed at `Question`.
  const question = questionOf(caller);
  if (question && !Object.hasOwn(entry.reads, action)) throw refusedWrite(question, `${fqn}#${action}`);
  const probe = question && probeFor(question, state);
  const fn = (probe ? probeEntry(probe, value) : entry).bound[action] as (input: unknown, ...context: unknown[]) => Promise<unknown>;
  // The action runs in a frame of its own: what it calls is its own work, not its caller's. Its scope is live: past
  // `bindingFor`, the caller is in a live scope of the binding, or the binding is connected. A call that joins its
  // caller's transaction carries that transaction's instant, which the action reads (`ActionFrame.clock`, ACT-29).
  const joined = caller?.state === state && caller.tx !== undefined ? caller.clock : undefined;
  // The chain it is nested in, if any (TXN-21): a call made past the cap throws at entry, before it runs anything.
  const calls = nested(caller?.calls, `${fqn}#${action}`);
  const store = kept({ state, scope: { live: true }, calls, ...(joined ? { clock: joined } : {}) }, question);
  const outcome = await settle(() => counted(state, () => forCaller(state, caller, () => scoped(frame!, store, () => fn(input, ...context)), probe?.layer)));
  // The root call rejects with the cap's error whatever a step or a helper caught on its way.
  if (calls.depth === 1 && calls.root.tooDeep) throw calls.root.tooDeep;
  return unwrap(outcome);
}

/** The place in its chain of a call to `label` made inside `parent`, or the start of a chain; throws once the chain is too deep. */
function nested(parent: CallChain | undefined, label: string): CallChain {
  const root = parent?.root ?? { label };
  if (root.tooDeep) throw root.tooDeep;
  const depth = (parent?.depth ?? 0) + 1;
  if (depth > MAX_CALL_DEPTH)
    throw root.tooDeep = new FrameworkError(`${label} was called more than ${MAX_CALL_DEPTH} nested calls deep, in a chain that began with ${root.label}: the calls probably form a cycle (an action that calls itself, or actions that call each other, from a step, a policy's helper or a function)`);
  return { depth, root };
}

/**
 * The reads of `value` with no policy run (TXN-16, TXN-17): `Mesh.privileged(Task).read(input, context?)` runs the read
 * action's body. `Mesh.privileged(Task)` only names the entity: each read finds its binding when it is called, the one in scope, else the
 * connected one, else it rejects as not connected, so a handle kept past `disconnect()` or carried into another binding's
 * `run` reads only through the binding where it is used. Inside an action, or an application's `transaction`, it joins
 * the transaction and reads its instant (`%.now` in what it loads, ACT-29), and inside an action it hands back read-only
 * views; it never takes the action's context: what it loads reads only the context the call passes. While a computed
 * field or a read policy is evaluated it throws (TXN-18):
 * those read only the record and what it loads. A value that is not an entity value is a `FrameworkError`, and so is
 * one no binding has bound: nothing could run its reads.
 */
export function privileged<E extends EntityValue<object, object>>(entity: E): Privileged<E> {
  if (!isEntityValue(entity))
    throw new FrameworkError(`Mesh.privileged() takes an entity value, such as Mesh.privileged(Task), and was given ${entity === null ? "null" : typeof entity === "object" ? "an object that is not one" : typeof entity}`);
  const fqn = entity[ENTITY];
  const caller = inScope(frames.get(entity));
  const mark = caller?.mark ?? evaluatingNow();
  if (mark !== undefined) throw marked(`Mesh.privileged(${fqn})`, mark);
  const handle = handles.get(entity);
  if (!handle) throw notConnected(`Mesh.privileged(${fqn})`);
  return handle as Privileged<E>;
}

function marked(what: string, mark: string): FrameworkError {
  return new FrameworkError(`${what} was called while ${mark} is evaluated: a computed field and a read policy read the record and what it loads, and call no action, make no privileged read and ask no action's policies. Load what it needs instead, or do it in a step or a check`);
}

/**
 * The `privileged` reads of one entity value, one per read action (`names`), made once, by the first binding that binds
 * it. Each call looks up the caller's frame and the binding as an entity call does, and runs that binding's read body.
 */
function privilegedHandle(value: object, fqn: string, names: readonly string[]): object {
  const reads: Record<string, (input: unknown, context?: unknown) => Promise<unknown>> = Object.create(null);
  for (const name of names)
    reads[name] = (input: unknown, context?: unknown) => {
      const label = `Mesh.privileged(${fqn}).${name}`;
      const caller = inScope(frames.get(value));
      // Refused by throwing, as `Mesh.privileged` itself is, not by rejecting: one way for every refusal.
      const mark = caller?.mark ?? evaluatingNow();
      if (mark !== undefined) throw marked(label, mark);
      return (async () => {
        const { state, entry } = bindingFor(value, label, caller);
        const probe = probeOf(caller, state);
        const body = (probe ? probeEntry(probe, value) : entry).reads[name];
        if (!body) throw new FrameworkError(`${label} is not a read of ${fqn} on the binding in scope`);
        // The transaction's instant (ACT-29), never the caller's context (TXN-16): what the read loads reads the context this
        // call passes.
        const clock = caller?.state === state ? caller.clock : undefined;
        return counted(state, () => forCaller(state, caller, () => body(input, context, clock, false), probe?.layer));
      })();
    };
  return Object.freeze(reads);
}

/**
 * The frame a binding hands its entities' bind functions. `question` is set for the frame of a binding's probe inside
 * one `Mesh.checkPolicies` (CMP-21): every store it puts in scope belongs to that question, so what runs there runs on
 * the question's probes. Any other frame's store belongs to the question in scope, if any, so a question's mark is
 * never lost (`questionOf`).
 */
function actionFrame(frame: AsyncFrame, state: BindingState, question?: Question): ActionFrame {
  const asking = (store: FrameStore | undefined) => question ?? questionOf(store);
  const here = (): FrameStore => inScope(frame) ?? kept({ state, scope: live(state, frame) }, question);
  return Object.freeze({
    clock(clock: Clock | undefined): Clock {
      const store = inScope(frame);
      return store?.state === state && store.clock !== undefined ? store.clock : pinClock(clock);
    },
    within<T>(tx: DataOperations, clock: Clock, label: string, fn: () => Promise<T>): Promise<T> {
      const store = here();
      return frame.run(kept({ state, scope: store.scope, tx, clock, label, ...(store.calls ? { calls: store.calls } : {}) }, asking(store)), fn);
    },
    plain<T>(fn: () => Promise<T>): Promise<T> {
      const store = inScope(frame);
      if (store?.label === undefined) return fn();
      const { label: _label, ...plain } = store;
      return frame.run(kept(plain, asking(store)), fn);
    },
    marked<T>(what: string, fn: () => T): T {
      const store = here();
      return frame.run(kept({ ...store, mark: what }, asking(store)), fn);
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
  const state: BindingState = { binding: undefined as unknown as Binding, layer, options, entities, inFlight: 0, idle: [], released: false };
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
        const reads = (value[BIND_READS]?.(layer, options, handle) ?? {}) as Readonly<Record<string, ReadBody>>;
        entities.set(fqn, { value, bound, reads });
        if (!handles.has(value)) handles.set(value, privilegedHandle(value, fqn, Object.keys(reads)));
      } else if (isNamespace(value)) walk(value);
    }
  };
  walk(domain);
  for (const { value } of entities.values()) frames.set(value, frame);
  const binding: Binding = Object.freeze({
    run<T>(fn: () => Promise<T>): Promise<T> {
      // Inside a question (a policy's helper calls it), the scope belongs to the question: a write is refused, and a read
      // runs on the binding's probe, so it reads what the call would read (CMP-21).
      const outer = inScope(frame);
      return scoped(frame, kept({ state, scope: live(state, frame), ...(outer?.calls ? { calls: outer.calls } : {}) }, questionOf(outer)), fn);
    },
    transaction<T>(fn: () => Promise<T>): Promise<T> {
      // The application's `transaction` is an outermost transaction like any action's (TXN-14): `afterCommit` runs once
      // when it commits, with every change made inside it. One that joins a running transaction leaves that to the outer one.
      // It has one instant (ACT-29): the binding's clock, read once, which every action and read made inside it reads; one
      // that joins a running transaction of this binding reads that transaction's.
      const scope = live(state, frame);
      const outer = inScope(frame);
      const clock = outer?.state === state && outer.tx !== undefined && outer.clock !== undefined ? outer.clock : pinClock(options.clock);
      // Inside a question (`Mesh.checkPolicies`: a policy's helper calls it), no seam runs and no write action starts, and
      // it runs on the binding's probe: where it joins a running transaction, what `fn` rejects with (a refused write the
      // helper catches) does not fail it (CMP-21).
      const question = questionOf(outer);
      const on = question ? probeFor(question, state).layer : layer;
      const body = (tx: DataOperations) => frame.run(kept({ state, scope, tx, clock, ...(outer?.calls ? { calls: outer.calls } : {}) }, question), () => fn());
      return counted(state, async () => {
        try {
          if (!on.refuseIfFailed()) return await outermost(on, question ? undefined : options.seams, body);
          return await on.transaction(body);
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

// ---- Mesh.checkPolicies (CMP-21) -------------------------------------------------------------------------------------

/**
 * One `Mesh.checkPolicies`, a question: the call it asks about runs as itself, on the binding the call would use, with
 * the same input, context and instant, on a layer of the question's (`probeLayer`) through which it reads what the call
 * would read and can write nothing. The authorizer of that call answers instead of deciding (`answer.ts`), so the call
 * stops where its policies decide, before any `validate`, step, write or seam. A call its policies make (a helper that
 * reads through an entity) runs the same way, on whichever binding of the project it is made: on that binding's probe
 * (`probeFor`), whose layer is the question's over the binding's own, so it reads what it would read, and what it
 * rejects with inside a running transaction is kept by the question's layer and never fails that transaction.
 *
 * Every frame store made in the question's async context belongs to the question (`kept`, `questionOf`): the call's
 * own, the stores of what it calls, and those of a `run` or `transaction` a helper opens there, on this binding or
 * another one sharing the project's async frame. In such a store no write action starts (`dispatch` refuses one before
 * it runs anything, `refusedWrite`), no seam runs (`Binding.transaction`) and every call runs on its binding's probe.
 * The mark outlives the answer: work a helper leaves running (a timer, a promise it does not await) keeps it after the
 * question has settled (`ended`), and its writes are refused still. A call made beside the question (another call of a
 * `Promise.all`, a request served meanwhile) is in a store the question did not make: it is not marked, and runs as it
 * would.
 *
 * Three routes stay out of the question's reach, and write what they write, with their seams, checks and steps: a
 * helper that writes through a data layer it holds itself, never through an entity; a binding of another project,
 * whose stores live in another async frame; and work handed to code whose async context was made outside the question
 * (the consumer of a queue, or a promise, started before the question, which a helper feeds or resolves), which runs in
 * that context, unmarked.
 */
interface Question {
  /** The call asked about, `blog.Post#publish`. */
  readonly label: string;
  /** The function that asked, which the errors name. */
  readonly member: "checkPolicies" | "can";
  /** The question this one is asked inside (a policy's helper asks), if any: this one reads through its layers. */
  readonly outer: Question | undefined;
  /** The project's async frame. */
  readonly frame: AsyncFrame;
  /**
   * The question's layer over each data layer it reached, by that layer object (`layerFor`): the bindings of one layer
   * object share it, and with it the failed state it emulates. Two layer objects over one database (a wrapper and the
   * layer it wraps), joined in one transaction, keep separate failed states: after a call joined through one fails, a
   * call joined through the other runs inside the question, so the question can answer where the call itself would be
   * refused ("an earlier joined call failed"). The question never fails the running transaction either way. The key stays
   * the layer object: the data-layer contract does not promise that two layer objects hand out one operations object.
   */
  readonly layers: Map<DataLayer, DataLayer>;
  /** Each binding the question reached, by its state: made when the question first reaches the binding. */
  readonly probes: Map<BindingState, Probe>;
  /**
   * The read-only view of each transaction's operations (`readOnlyOperations`), by those operations: shared by the
   * question's layers, and kept when they are dropped, so a layer made again after the end hands a call the view its
   * store already holds, and the call joins the transaction it was made in while that transaction runs.
   */
  readonly views: WeakMap<DataOperations, DataOperations>;
  /** The error of the first write tried while the question is answered: `Mesh.checkPolicies` throws it, whatever was decided. */
  wrote?: FrameworkError;
  /**
   * Set on the outermost question of a chain when a question is asked too deep (`MAX_QUESTION_DEPTH`). The error sticks to
   * the root: every question asked under it throws it at entry, and the root throws it once it settles, whatever was
   * decided and whatever a helper caught on the way, so a helper that catches cannot keep a cycle going.
   */
  tooDeep?: FrameworkError;
  /**
   * True once `Mesh.checkPolicies` has settled: a write still refused in one of its stores was started by work left
   * running. `probes` and `layers` are emptied then, so that work keeps alive only what it touches again.
   */
  ended: boolean;
}

/** What one binding's calls run on inside a question. */
interface Probe {
  /** The binding. */
  readonly state: BindingState;
  /** The question's layer over the binding's (`layerFor`): reads pass through, writes throw. */
  readonly layer: DataLayer;
  /** The frame the binding's entities get inside the question: every store it puts in scope belongs to the question. */
  readonly frame: ActionFrame;
  /** Each entity's actions and read bodies bound to `layer`, by FQN: bound when the question first reaches the entity. */
  readonly entities: Map<string, { readonly bound: BoundActions; readonly reads: Readonly<Record<string, ReadBody>> }>;
}

/**
 * The question each frame store belongs to: only stores made in the async context of a `Mesh.checkPolicies` are in it.
 * Module-private, as `Answer` is: no code outside this file can mark a store or read the mark, so nothing can leave a
 * question's scope by forging one (CMP-21).
 */
const questions = new WeakMap<FrameStore, Question>();

/** `store`, recorded as `question`'s when there is one. */
function kept(store: FrameStore, question: Question | undefined): FrameStore {
  if (question) questions.set(store, question);
  return store;
}

/** The question a caller's store belongs to, whatever binding put it in scope. */
function questionOf(caller: FrameStore | undefined): Question | undefined {
  return caller === undefined ? undefined : questions.get(caller);
}

/** The probe a call of the binding `state` runs on: the binding's, in the question the caller belongs to, if any. */
function probeOf(caller: FrameStore | undefined, state: BindingState): Probe | undefined {
  const question = questionOf(caller);
  return question && probeFor(question, state);
}

/** What the binding `state` runs on inside `question`, made the first time the question reaches the binding. */
function probeFor(question: Question, state: BindingState): Probe {
  let probe = question.probes.get(state);
  if (!probe) {
    probe = { state, layer: layerFor(question, state.layer), frame: actionFrame(question.frame, state, question), entities: new Map() };
    question.probes.set(state, probe);
  }
  return probe;
}

/**
 * The layer a call over `layer` runs on inside `question`, made the first time the question reaches `layer`: over
 * `layer` itself, or, for a question asked inside another one, over that one's layer. Kept by layer object, so two
 * layer objects over one database keep separate failed states (see `Question.layers`).
 */
function layerFor(question: Question, layer: DataLayer): DataLayer {
  let probe = question.layers.get(layer);
  if (!probe) question.layers.set(layer, probe = probeLayer(question.outer ? layerFor(question.outer, layer) : layer, question));
  return probe;
}

/**
 * The error of a write tried in a store of `question`: `writer`, the write action refused, or the label of the action
 * that tried to write through the question's layer. While the question is answered, `Mesh.checkPolicies` (or `Mesh.can`) throws the
 * first, whatever was decided, even when a helper caught it; once it has settled, the write was started by work left
 * running, and is refused all the same.
 */
function refusedWrite(question: Question, writer: string | undefined): FrameworkError {
  if (question.ended)
    return new FrameworkError(`${writer ?? "A call"} cannot write: it was started while Mesh.${question.member}(${question.label}) was answered, `
      + "by work its policies left running (a timer, a promise not awaited), and nothing started while a question is answered writes a row, "
      + "even once the question has answered. Make the policy read only");
  return question.wrote ??= new FrameworkError(`Mesh.${question.member}(${question.label}) cannot answer without writing: `
    + `${writer === undefined ? "a call made while its policies were checked" : `${writer}, called while its policies were checked,`} writes a row. `
    + "Checking a policy runs what the policy calls, so a policy that writes, through a helper or an action it calls, cannot be checked: make it read only");
}

/**
 * What `value`'s actions and reads are on `probe`'s layer, bound the first time with the options of the probe's binding:
 * its clock, and no seam, since none runs in a question.
 */
function probeEntry(probe: Probe, value: object) {
  const fqn = (value as EntityValue<object>)[ENTITY];
  let entry = probe.entities.get(fqn);
  if (!entry) {
    const options: BindOptions = { clock: probe.state.options.clock };
    const bound = (value as EntityValue<object>)[BIND](probe.layer, options, probe.frame) as BoundActions;
    const reads = ((value as EntityValue<object>)[BIND_READS]?.(probe.layer, options, probe.frame) ?? {}) as Readonly<Record<string, ReadBody>>;
    probe.entities.set(fqn, entry = { bound, reads });
  }
  return entry;
}

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** What `work` resolves or rejects with, as a value: a callback that returns it never rejects. */
async function settle<T>(work: () => Promise<T>): Promise<Settled<T>> {
  try { return { ok: true, value: await work() }; } catch (error) { return { ok: false, error }; }
}

function unwrap<T>(outcome: Settled<T>): T {
  if (outcome.ok) return outcome.value;
  throw outcome.error;
}

/**
 * Run `work` in a transaction of `layer` (joining the running one, or opening one) and hand back, outside it, what it
 * resolved or rejected with. The layer's callback resolves with nothing, so the layer, and any wrapper of it, never sees
 * what `work` gave (an `Answer`, a probe's outcome), and a rejection never fails the running transaction.
 */
async function apart<T>(layer: DataLayer, work: (tx: DataOperations) => Promise<T>): Promise<Settled<T>> {
  let outcome: Settled<T> | undefined;
  await layer.transaction(async (tx) => { outcome = await settle(() => work(tx)); });
  return outcome!;
}

/** What a probe's own transaction is rolled back with; never seen outside `probeLayer`. */
const ROLLBACK: unique symbol = Symbol("mesh.checkPolicies.rollback");

/**
 * The layer of one `Mesh.checkPolicies` over `base` (a binding's layer, or the layer of the question this one is asked
 * inside, over it). Inside a running transaction a call joins it, as on `base`, but what the call rejects with is taken
 * inside the join and thrown outside it, so the running transaction is never failed by the question; the layer keeps
 * the first such failure and refuses a call joined after it, as `base` would (rollback-only). Anywhere else a call opens
 * a transaction of its own on `base`, which is always rolled back. Either way its operations read as `base`'s do and
 * refuse every write (`readOnlyOperations`).
 */
function probeLayer(base: DataLayer, question: Question): DataLayer {
  const view = (tx: DataOperations): DataOperations => {
    let readOnly = question.views.get(tx);
    if (!readOnly) question.views.set(tx, readOnly = readOnlyOperations(tx, question));
    return readOnly;
  };
  let failed: { readonly error: unknown } | undefined;
  const refusal = () => new FrameworkError("A call joined a transaction that an earlier joined call failed, so it was refused before it ran: the transaction rolls back", { cause: failed?.error });
  return Object.freeze({
    refuseIfFailed(): boolean {
      const joined = base.refuseIfFailed();
      if (joined && failed) throw refusal();
      return joined;
    },
    async transaction<T>(run: (tx: DataOperations) => Promise<T>): Promise<T> {
      if (base.refuseIfFailed()) {
        if (failed) throw refusal();
        const outcome = await apart(base, (tx) => run(view(tx)));
        if (!outcome.ok && !(outcome.error instanceof Answer)) failed ??= { error: outcome.error };
        return unwrap(outcome);
      }
      let outcome: Settled<T> | undefined;
      try {
        await base.transaction(async (tx) => {
          outcome = await settle(() => run(view(tx)));
          throw ROLLBACK;
        });
      } catch (error) {
        // Only the rollback the probe asked for is swallowed: a layer that fails to roll back, or fails otherwise, is heard.
        if (outcome === undefined || error !== ROLLBACK) throw error;
      }
      return unwrap(outcome!);
    },
    close(): Promise<void> {
      return Promise.reject(new FrameworkError("The layer of Mesh.checkPolicies is not closed: close the binding's own layer"));
    },
  });
}

/**
 * `tx`'s reads; each write throws a `FrameworkError` naming the action asked about and the action that tried to write.
 * No write action reaches it (`dispatch` refuses one first): it holds should generated code write anyway.
 */
function readOnlyOperations(tx: DataOperations, question: Question): DataOperations {
  const refuse = async (): Promise<never> => {
    throw refusedWrite(question, inScope(question.frame)?.label);
  };
  return Object.freeze({
    insert: refuse,
    updateByKey: refuse,
    deleteByKey: refuse,
    selectByKey: (table, key) => tx.selectByKey(table, key),
    selectByKeyForUpdate: (table, key) => tx.selectByKeyForUpdate(table, key),
    select: (table, query) => tx.select(table, query),
    max: (table, attribute, filter) => tx.max(table, attribute, filter),
    count: (table, attribute, filter) => tx.count(table, attribute, filter),
  } satisfies DataOperations);
}

/** What a value passed as the action is, for the message. */
function described(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "function")
    return "a function that is not one (a plain function, a Mesh.privileged read, a copy made with .bind, or an action of an entity value made by a "
      + "second copy of @meshfw/runtime in the install, which meshfw avoids by taking @meshfw/runtime as a peer dependency)";
  return typeof value === "object" ? "an object" : typeof value;
}

/**
 * `Mesh.checkPolicies(Todo.complete, input, context)` (CMP-21, ADR-0022): the decision the call
 * `Todo.complete(input, context)` would reach, made the same way: on the binding the call would use, joining the
 * transaction it would join (and reading its instant, ACT-29) or in a transaction of its own that is rolled back, with
 * the same checks in the same order, so a denial's `breakdown` is the one its `ForbiddenError` would carry. It changes
 * nothing: it runs no `validate`, no step and no seam, and a write action a policy starts, through any binding of the
 * project, is refused before it runs, and the question throws a `FrameworkError` (see `Question`). Where the call throws before its policies decide (`InvalidInputError` from the cast, `NotFoundError`
 * for a missing row a check would read, a read that cannot run in this version), it throws the same error, and inside
 * a running transaction that error does not fail the transaction. A denial resolves with `allowed: false`; it never
 * throws `ForbiddenError`. A read answers whether it is allowed at all: no policy covering it, or none admitting the
 * caller, is `allowed: false`. A question asked more than 32 deep, each inside a policy of the one before, throws a
 * `FrameworkError`.
 */
export function checkPolicies(action: unknown, input: unknown, context: unknown): Promise<Decision> {
  return askPolicies("checkPolicies", action, input, context);
}

/**
 * How many questions may be open one inside another, each asked by a policy of the one before (as `MAX_DEPTH` in `load.ts`
 * bounds a path of computed fields): a policy that asks about its own action, or two that ask each other, stop here.
 */
const MAX_QUESTION_DEPTH = 32;

/** `Mesh.checkPolicies` and `Mesh.can` (`member` names which, in the messages): refused by throwing while marked, as `Mesh.privileged` is. */
function askPolicies(member: "checkPolicies" | "can", action: unknown, input: unknown, context: unknown): Promise<Decision> {
  const target = typeof action === "function" ? actions.get(action) : undefined;
  if (!target)
    return Promise.reject(new FrameworkError(`Mesh.${member}() takes an action function of an entity value, such as Mesh.${member}(Todo.complete, input, context), and was given ${described(action)}`));
  const { value, fqn, name } = target;
  const where = `Mesh.${member}(${fqn}#${name})`;
  // While a computed field or a read policy is evaluated, as for `Mesh.privileged` and an entity's action (TXN-18): an entity
  // file's computed field and read policy cannot call it, the build refuses them (`MESH_COMPUTED_COMPOSES`,
  // `MESH_POLICY_ASKS`), and this refuses one a helper hides. A write policy is not marked, so a call hidden there runs, as a
  // hidden `Mesh.privileged` read does: the build refuses a direct one in any policy, read or write (`MESH_POLICY_ASKS`).
  const mark = inScope(frames.get(value))?.mark ?? evaluatingNow();
  if (mark !== undefined) throw marked(where, mark);
  return answer(target, member, where, input, context);
}

async function answer({ value, fqn, name }: { value: object; fqn: string; name: string }, member: "checkPolicies" | "can", where: string, input: unknown, context: unknown): Promise<Decision> {
  const label = `${fqn}#${name}`;
  const frame = frames.get(value);
  const caller = inScope(frame);
  const { state } = bindingFor(value, where, caller);
  // Asked inside another question (a policy's helper asks), it reads through that question's layers.
  const outer = questionOf(caller);
  let depth = 0;
  let root: Question | undefined;
  for (let open = outer; open; open = open.outer) { depth++; root = open; }
  if (root?.tooDeep) throw root.tooDeep;
  if (root && depth >= MAX_QUESTION_DEPTH)
    throw root.tooDeep = new FrameworkError(`${where} was asked ${MAX_QUESTION_DEPTH} questions deep: the policies of ${label} ask other actions' policies too deeply, probably in a cycle (a policy that asks about its own action, or policies that ask each other)`);
  const question: Question = { label, member, outer, frame: frame!, layers: new Map(), probes: new Map(), views: new WeakMap(), ended: false };
  const probe = probeFor(question, state);
  const bound = (value as EntityValue<object>)[BIND](answeringLayer(probe.layer), { clock: state.options.clock }, probe.frame) as BoundActions;
  const fn = bound[name] as (input: unknown, context: unknown) => Promise<unknown>;
  // As `dispatch` does: a frame of its own, carrying the instant of the transaction it joins.
  const joined = caller?.state === state && caller.tx !== undefined ? caller : undefined;
  const store = kept({ state, scope: { live: true }, ...(caller?.calls ? { calls: caller.calls } : {}), ...(joined?.clock ? { clock: joined.clock } : {}) }, question);
  const ask = () => scoped(frame!, store, () => fn(input, context));
  // Inside a transaction of the binding the question joins it as the call would, and is refused once it has ended; what
  // the call rejects with is taken inside the join, so the running transaction is not failed by it.
  const base = outer ? layerFor(outer, state.layer) : state.layer;
  const run = joined
    ? () => apart(base, (current) => current === joined.tx ? ask() : Promise.reject(new FrameworkError(ENDED))).then(unwrap)
    : ask;
  const outcome = await counted(state, () => settle(run));
  // Work its policies left running is still marked (`Question`): what it writes from now on is refused as started here.
  // It no longer keeps every binding the question reached alive: a call it makes later makes again what it touches.
  question.ended = true;
  question.probes.clear();
  question.layers.clear();
  if (question.tooDeep) throw question.tooDeep;
  if (question.wrote) throw question.wrote;
  if (!outcome.ok) {
    if (outcome.error instanceof Answer) return outcome.error.decision;
    throw outcome.error;
  }
  throw new FrameworkError(`${where} ran the call without reaching its policies: rebuild the project with mesh build`);
}

/** `Mesh.can(Todo.complete, input, context)`: true exactly when `checkPolicies` with the same arguments resolves with `allowed` true. */
export function can(action: unknown, input: unknown, context: unknown): Promise<boolean> {
  return askPolicies("can", action, input, context).then((decision) => decision.allowed === true);
}

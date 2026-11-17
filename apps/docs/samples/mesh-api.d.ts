// Declarations of the API the Docs pages describe, used only by
// `test/docs-samples.test.ts`, which type-checks every TypeScript sample on those
// pages against this file.
//
// This is not Mesh. Mesh does not exist as an installable runtime yet, so the file
// states the shape the pages promise: the generated entry points (`#mesh` and the
// `#mesh/domain/<module>` specifiers) for the entities of the pages, the run-time error
// classes, `Mesh` (the functions that are the same in every project), the SQLite adapter, the local event bus, the event-sourcing extension, the JSON-RPC transport and the configuration helper. If a page and this file
// disagree, the page is a bug or this file is; both are cheap to fix and the sample
// check is what notices.
//
// The per-entity filter types are spelled out here because the real generator emits
// them per entity. `anyField` is the union a reader would expect from the entity file.

declare module "@meshfw/runtime" {
  import type { PostgresDataLayer } from "@meshfw/data-postgres";
  import type { SqliteDataLayer } from "@meshfw/data-sqlite";

  /** What `mesh.config.ts` default-exports. In the runtime, because `connect()` loads the config at run time. */
  export type MeshConfig = {
    domain: string;
    /** The folder of the project's surface files, conventionally `src/surfaces`; absent, the project has none. */
    surfaces?: string;
    output: string;
    data: SqliteDataLayer | PostgresDataLayer;
    extensions?: unknown[];
    seams?: Seams;
    events?: EventsConfig;
  };

  /** The `events` key of `mesh.config.ts`, and the `events` option of `bind`. */
  export interface EventsConfig {
    /** The event bus (`localBus()`); a project that declares an event must set it, and there is no default. */
    bus?: EventBus;
    /** Loads the events module at run time; the build never imports it. */
    load?: () => Promise<EventsModule>;
    /** How long the outbox keeps a row: until every reader has passed it (the default), or always. */
    keep?: "until-delivered" | "all";
    /** Capabilities the project needs from the bus and the data adapter: the build fails when one is missing. */
    requires?: readonly (BusCapability | Capability)[];
    /** Former event FQN to the declared event it now is: a row stored under the former name is read as that event. */
    renamed?: Readonly<Record<string, string>>;
  }

  /** What the events module (`src/events.ts`) exports: the handlers, the metadata function and the handlers' context. */
  export interface EventsModule {
    /** The handlers, by kind, each under its name: the name is unique across every kind and keys its progress row. */
    handlers?: {
      process?: Record<string, Handler>;
      listen?: Record<string, Handler>;
      /** A kind an extension contributes, under its name: every handler there carries that kind. */
      readonly [kind: string]: Record<string, Handler> | undefined;
    };
    metadata?: MetadataFunction<never>;
    /** The context handlers run with; default `{ system: true }`. */
    context?: (event: EventRecord) => ActionContext;
  }

  /** A data adapter's capabilities, a closed list. */
  export type Capability = "aggregates" | "integer-key-fill" | "joins" | "upserts" | "atomic-expressions" | "gapless-positions" | "conditions" | "raw-sql";

  /** The promises a bus can make, a closed list: `ordered-delivery` (every handler needs it), `replay`, `subscribe`, `dead-letters`, `multi-process`. */
  export type BusCapability = "ordered-delivery" | "replay" | "subscribe" | "dead-letters" | "multi-process";

  /** The configured bus's capabilities, one `true` member each, merged in by `mesh build` so that an option the bus cannot honour is a type error. */
  export interface EventBusCapabilities {}

  /** What a bus declares, as static data the build reads without starting it. */
  export interface BusManifest {
    readonly adapter: string;
    readonly capabilities: readonly BusCapability[];
  }

  /** A bus descriptor, what `events.bus` holds (`localBus()`): it holds no state and starts nothing. Core calls `create` once per binding that delivers. */
  export interface EventBus {
    readonly manifest: BusManifest;
    create(core: BusCore, options: BusOptions): EventBusInstance;
  }

  /** What core passes to `create` beside the core. */
  export interface BusOptions {
    readonly keep: "until-delivered" | "all";
  }

  /** One bus instance, made by core for one binding that delivers. */
  export interface EventBusInstance {
    /** Run on its own until `stop()`. */
    start(): Promise<void>;
    /** End subscriptions, wait for the running round, clear every timer. */
    stop(): Promise<void>;
    /** One round, then resolve; rejects with `HandlerStoppedError` naming every handler that stopped, or with the error that ended the round. */
    deliver(): Promise<void>;
    /** Optional: resume a handler this instance stopped after `start()`, from its progress row, in the next round; what `resumeHandler(name)` of `#mesh` calls. */
    resumeHandler?(handler: RegisteredHandler): void;
  }

  /** A handler as core registered it for this claim: what a bus feeds. */
  export interface RegisteredHandler {
    readonly name: string;
    /** `"process"`, `"listen"`, or the name of a kind an extension contributes. */
    readonly kind: string;
    /** The sorted FQNs it lists. */
    readonly events: readonly string[];
    readonly onFailure: "stop" | "skip";
  }

  /** One committed outbox row, as core's `rows` returns it. */
  export interface OutboxRow {
    readonly position: number;
    readonly id: string;
    readonly name: string;
    readonly entity: string;
    readonly action: string;
    readonly key: Readonly<Record<string, unknown>>;
    readonly causedBy: string | null;
    readonly metadata: unknown;
    readonly occurredAt: Date;
    readonly payload: unknown;
  }

  /** One read of the outbox: its rows and both positions, taken from one state of the database. */
  export interface OutboxPage {
    readonly rows: readonly OutboxRow[];
    readonly deletedThrough: number;
    readonly highest: number;
    /** Every position at or below it is final (committed, or never to commit); a reader past a short page moves no further. SQLite: `highest`. */
    readonly settled: number;
  }

  /** What a subscription filters on, stored with its row. */
  export interface SubscriptionFilter {
    readonly names?: readonly string[];
    readonly entity?: string;
    readonly key?: Readonly<Record<string, unknown>>;
  }

  /** A live subscription, a core object: a bus reads `rows(cursor)` for it and feeds what came back. */
  export interface LiveSubscription {
    readonly name: string;
    /** The read head: the position of the last row read for it. */
    readonly cursor: number;
    readonly filter: SubscriptionFilter;
    /** True once it was closed or its stream ended. */
    readonly ended: boolean;
    /** Queue the page's rows above the cursor for the callback and move the cursor; past `maxQueue` (10 000) it ends with `MESH_SUBSCRIPTION_OVERFLOW`. */
    feed(page: OutboxPage, options?: { readonly maxQueue?: number }): Promise<void>;
    /** End the stream with `error`, as a failed read does. */
    end(error: unknown): void;
  }

  /** What core hands a bus instance: the only way it reaches the outbox and the handlers. */
  export interface BusCore {
    /** The one read of the outbox: the committed rows above `after`, at most `limit`, checked against both positions. */
    rows(after: number, limit: number): Promise<OutboxPage>;
    readonly handlers: readonly RegisteredHandler[];
    /** The handler's cursor, read now. */
    position(handler: RegisteredHandler): Promise<number>;
    /** True when the handler is to be handed `row`. */
    lists(handler: RegisteredHandler, row: OutboxRow): boolean;
    /** Deliver `row` to `handler` in its own transaction, with the generation and progress checks. */
    runHandler(handler: RegisteredHandler, row: OutboxRow): Promise<void>;
    /** `runHandler`, retried after each of `delays` while the error is retryable; resolves with null once handled, or with the stop to report. */
    retry(handler: RegisteredHandler, row: OutboxRow, delays: readonly number[]): Promise<StoppedHandler | null>;
    isRetryable(error: unknown): boolean;
    /** For a handler with `onFailure: "skip"` whose retries are used up: copy the event into `mesh_outbox_failures` and move its progress to it, in one transaction. */
    setAside(handler: RegisteredHandler, row: OutboxRow, error: unknown): Promise<void>;
    subscriptions(): readonly LiveSubscription[];
    /** Core's deletion pass, by `keep`; a bus calls it after each round. */
    deletionPass(): Promise<void>;
    /** After each commit that published in this process, and in other processes when the data layer reports them; best effort, so a bus keeps its poll. */
    onPublished(listener: () => void): () => void;
    onClaimLost(listener: (error: Error) => void): () => void;
  }

  /** The context a handler runs with. */
  export interface HandlerTools {
    readonly context: ActionContext;
  }

  /** What `onFailure` may be: `"skip"` only when the bus declares `dead-letters`. */
  export type OnFailure = "stop" | ("dead-letters" extends keyof EventBusCapabilities ? "skip" : never);

  /** An event class as a handler lists it. */
  export type ListedEvent<E extends object = object> = abstract new (fields: never) => E;

  /** A handler: the events it lists, and `run`, which gets each as a record whose `payload` is an instance of its class. */
  export interface Handler<E extends object = object> {
    readonly events: readonly ListedEvent<E>[];
    run(event: EventRecord<E>, tools: HandlerTools): void | Promise<void>;
    /** Default `"stop"`: retry, report and stop at the event. */
    readonly onFailure?: OnFailure;
    /** The handler's former name, whose progress row it takes over at registration. */
    readonly renamedFrom?: string;
  }

  /** The key under which a handler made by an extension carries its kind (`handler[HANDLER_KIND]`), set by that extension's helper, never by hand. */
  export const HANDLER_KIND: unique symbol;

  /** A handler kind an extension contributes: its handlers run in the handler transaction and may neither publish nor dispatch. */
  export interface HandlerKind {
    /** The key it is listed under in `handlers`: one lowercase word, never `process` or `listen`. */
    readonly name: string;
    /** The package that contributes it, for messages. */
    readonly owner: string;
    /** At start, before core's option checks and before anything is claimed. */
    check(handler: KindHandler, bus: BusManifest): void;
    /** In the registration transaction, for a handler with no progress row: the position it starts after. */
    start(handler: KindHandler, registration: Registration): Promise<number>;
    /** In the registration transaction, for a handler whose row exists; throws to fail the start. */
    adopt(handler: KindHandler, row: HandlerProgressRow, added: readonly string[], registration: Registration): Promise<void>;
    /** The progress row's stored kind: `name`, or `name:` and one lowercase word. */
    stored(handler: KindHandler, row: HandlerProgressRow | undefined, added: readonly string[]): string;
  }

  /** A handler of a contributed kind, as core hands it to its kind. */
  export interface KindHandler {
    readonly name: string;
    /** The sorted FQNs it lists. */
    readonly events: readonly string[];
    readonly handler: Handler;
  }

  /** What a kind reads in the registration transaction. */
  export interface Registration {
    readonly deletedThrough: number;
    /** True once any outbox row has been deleted on this database. */
    readonly deletedAny: boolean;
    readonly highest: number;
    readonly keep: "until-delivered" | "all";
    /** The first kept row in (after, before) whose name is in `names` or matches no declared event, or null. */
    firstRow(after: number, before: number, names: readonly string[]): Promise<number | null>;
  }

  /** One row of `mesh_handler_progress`: a handler's low-water position, as last registered. */
  export interface HandlerProgressRow {
    readonly name: string;
    /** `"process"`, `"listen"`, or what a contributed kind's `stored` returned. */
    readonly kind: string;
    readonly position: number;
    readonly events: readonly string[];
    readonly generation: number;
  }

  /** What `startDelivery()` resolves with. */
  export interface Delivery {
    /** Stop the bus, wait for the running round and release the claim. */
    stop(): Promise<void>;
  }

  /** The query of `subscribe`. */
  export interface SubscribeQuery {
    /** The subscription's identity: a reopen under it resumes from the acknowledged position. */
    readonly name: string;
    /** Where a first open starts (default: the highest position now); ignored on a reopen. */
    readonly after?: number;
    readonly names?: readonly string[];
    readonly entity?: string;
    readonly key?: Readonly<Record<string, unknown>>;
  }

  /** What `subscribe` resolves with. */
  export interface Subscription {
    readonly name: string;
    /** Acknowledge every delivered row at or below `position`. */
    ack(position: number): Promise<void>;
    /** End the stream and keep the row. */
    close(): Promise<void>;
    /** Resolves when the stream ends: with null after `close()` or the deliverer's stop, else with the error that ended it. */
    readonly done: Promise<unknown>;
  }

  /** A persisted subscription, open or closed, as `listSubscriptions()` returns it. */
  export interface SubscriptionProgress {
    readonly name: string;
    /** The stored acknowledged position, including rows its filter passed; not its in-memory read cursor. */
    readonly position: number;
  }

  /** What `adoptHandler` (and `mesh events adopt`) did to a handler's registered union, in delivery from several processes. */
  export interface Adopted {
    readonly handler: string;
    /** The registered union after the call, sorted. */
    readonly union: readonly string[];
    /** The events dropped from it. */
    readonly dropped: readonly string[];
    /** Every event kept, with the live process that lists it (`pid 4242 on host api-1`), or null when none does. */
    readonly kept: readonly { readonly event: string; readonly listedBy: string | null }[];
    /** False when the union is unchanged. */
    readonly changed: boolean;
  }

  /** What `retryFailed(name)` resolves with. */
  export interface RetryFailedResult {
    /** How many set-aside events were handled and removed. */
    readonly handled: number;
    /** The first one that failed again, which stays with every later one; null when none failed. */
    readonly failed: StoppedHandler | null;
  }

  /** What the project's `metadata` function returns for each event; a project declares its fields by augmenting this interface. */
  export interface EventMetadata {}

  /** A published event as a reader gets it: the envelope, the project's metadata and the event itself (`payload`). */
  export interface EventRecord<E extends object = object> {
    readonly id: string;
    readonly position: number;
    /** The event's FQN, `billing.InvoicePaid`. */
    readonly name: string;
    /** The publishing entity's FQN. */
    readonly entity: string;
    readonly action: string;
    readonly key: Readonly<Record<string, unknown>>;
    readonly causedBy: string | null;
    readonly metadata: EventMetadata;
    readonly occurredAt: Date;
    readonly payload: E;
  }

  /** The events module's `metadata` function: once per publish, in the transaction; returns plain JSON. */
  export interface MetadataFunction<E extends object = object> {
    (args: {
      readonly event: Omit<EventRecord<E>, "position" | "metadata" | "causedBy">;
      readonly context: Readonly<ActionContext>;
    }): EventMetadata | Promise<EventMetadata>;
  }

  /** The query of `readEvents`: every field optional. */
  export interface ReadEventsQuery {
    /** The cursor: the position of the last row read before; `0`, the default, reads from the start. */
    after?: number;
    /** How many outbox rows to read, filtered ones included; default 100. */
    limit?: number;
    /** Only events with these FQNs. */
    names?: readonly string[];
    /** Only events published by this entity (its FQN). */
    entity?: string;
    /** Only events published for the record with this key. */
    key?: Readonly<Record<string, unknown>>;
  }

  /** A page of `readEvents`: its events, the next cursor and the outbox's high-water position. */
  export interface ReadEventsPage<E extends object = object> {
    readonly events: readonly EventRecord<E>[];
    readonly cursor: number;
    /**
     * The highest position ever assigned, from the same snapshot as the rows; 0 before the first append, retained after
     * deletion. SQLite includes only committed assignments. Read outside any transaction, it can be ahead of what the
     * caller's earlier transaction saw, and of a page whose limit stops it before the head.
     */
    readonly highest: number;
  }

  /** The storage operations a seam gets, by table handle (`tables` from `#mesh`): the four by key. Writes through it run no seams. */
  export type SeamDb = {
    insert(table: object, row: Record<string, unknown>): Promise<Record<string, unknown>>;
    selectByKey(table: object, key: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
    updateByKey(table: object, key: Record<string, unknown>, changes: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
    deleteByKey(table: object, key: Record<string, unknown>): Promise<boolean>;
  };

  /** One row written by a call: the row as it was (`null` on a create) and as written (`null` on a destroy). */
  export type Change = {
    /** The entity's fully qualified name, `todo.Todo` (module folders as written, then the name). */
    entity: string;
    action: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  };

  /** Code the application runs at three points of every generated action. Payloads are plain data. */
  export type Seams = {
    /** Before the transaction opens, for the call that opens it; throw to refuse the call. */
    beforeTransaction?(call: { entity: string /* FQN */; action: string; input: unknown; context: Readonly<ActionContext> }): void | Promise<void>;
    /** Inside the transaction, right after each row is written; a throw rolls back the whole call. */
    afterWrite?(db: SeamDb, write: Change & { input: unknown; context: Readonly<ActionContext> }): void | Promise<void>;
    /** Once, after the outermost transaction commits; not called on rollback; a throw is reported and does not fail the call. */
    afterCommit?(commit: { changes: Change[] }): void | Promise<void>;
  };

  export function defineConfig(config: MeshConfig): MeshConfig;

  const reads: unique symbol;

  /**
   * What a module exports for an entity (`Todo` in `import { Todo } from "#mesh/domain/todo"`): an object whose
   * methods are the entity's actions. `R` is the type of its policy-free reads, which `Mesh.privileged` returns.
   */
  export type EntityValue<R = unknown> = {
    readonly [reads]?: R;
  };

  /** The read actions of an entity, generated and custom, with no policy: what `Mesh.privileged(Entity)` returns. */
  export type Privileged<E extends EntityValue> = E extends EntityValue<infer R> ? R : never;

  /** The answer of `Mesh.checkPolicies`: whether the call would be allowed, and one entry per check that ran (ADR-0022). */
  export type Decision = {
    readonly allowed: boolean;
    readonly breakdown: readonly PolicyCheck[];
  };

  const declaration: unique symbol;

  /**
   * What a generated event or command class tells the runtime about itself, under a symbol the runtime owns: its kind, its
   * FQN, and a test that is true for its instances and nothing else (the check of the class's private field).
   */
  export type Declaration<Instance extends object = object> = {
    readonly kind: "event" | "command";
    /** `<module>.<Name>`, the stored and wire name: `billing.InvoicePaid`. */
    readonly fqn: string;
    readonly is: (value: unknown) => value is Instance;
  };

  /** The class of an event or a command, as `mesh build` generates it into its module's barrel (`#mesh/domain/billing`). */
  export type Declared<Instance extends object = object> = {
    readonly [declaration]: Declaration<Instance>;
  };

  /** An action function as the entity value exposes it: the input, then the context. `ActionFunction` alone is any of them. */
  export type ActionFunction<I = never> = (input: I, context: ActionContext) => Promise<unknown>;

  /**
   * The functions that are the same in every project are members of this one namespace; none is a bare name. The
   * functions generated for one project (`bind`, `connect`, `disconnect`, `transaction`) stay exports of its `#mesh`,
   * and error classes and types (`ForbiddenError`, `ActionContext`) stay named exports. The current transaction's
   * instant is not a member: an entity file reads it as `%.now` (and its date as `%.today`), and application code that
   * needs it takes it as a parameter, which the entity file passes (`dueIn(%.today, 30)`).
   */
  export const Mesh: {
    /**
     * Resolves to `{ allowed, breakdown }` for a call to `action` with `input` and `context`, and changes nothing. The
     * action function comes first, then the call's own arguments; the runtime recognises the function through a
     * module-private `WeakMap`, so nothing is added to it. The input is typed as the action's own (`Parameters<A>[0]`),
     * so a generic read takes any `load` its call takes.
     */
    checkPolicies<A extends ActionFunction>(action: A, input: Parameters<A>[0], context: ActionContext): Promise<Decision>;
    /** Resolves to `true` exactly when `Mesh.checkPolicies` for the same arguments resolves with `allowed` `true`. */
    can<A extends ActionFunction>(action: A, input: Parameters<A>[0], context: ActionContext): Promise<boolean>;
    /**
     * Returns the read actions of `entity` without read policies. It joins the running transaction and reads its
     * instant, the `%.now` of the call that opened it. It throws `FrameworkError` while a computed field or a read
     * policy is being evaluated. Each read takes an optional `context`: it reaches only the computed fields the read
     * loads and is never inherited from the running action.
     */
    privileged<E extends EntityValue>(entity: E): Privileged<E>;
    /** True only when `context.system` is the boolean `true`. */
    isSystem(context: Readonly<ActionContext>): boolean;
    /**
     * The fully qualified name of the event or command a generated class declares: `Mesh.fqnOf(InvoicePaid)` is
     * `"billing.InvoicePaid"`, the module's folders as written, then the class's name. Any other value throws `FrameworkError`.
     */
    fqnOf(declared: Declared): string;
    /**
     * Returns `options` as it is, so that TypeScript infers the type of `run`'s event from `events`:
     * `Mesh.handler({ events: [InvoicePaid], run: async (event) => { event.payload.amount } })`.
     */
    handler<const C extends readonly ListedEvent[]>(options: {
      readonly events: C;
      run(event: EventRecord<InstanceType<C[number]>>, tools: HandlerTools): void | Promise<void>;
      readonly onFailure?: OnFailure;
      readonly renamedFrom?: string;
    }): Handler<InstanceType<C[number]>>;
  };

  /** What `bind` returns: the whole domain on one data layer, one seam set and one clock. */
  export type Binding = {
    /** Runs `fn` with this binding in scope: every entity call and `privileged` read inside it uses this binding's data layer. */
    run<T>(fn: () => Promise<T>): Promise<T>;
    /** Opens a transaction on this binding's data layer, or joins the running one, with this binding in scope. `fn` gets nothing and the call takes no context. */
    transaction<T>(fn: () => Promise<T>): Promise<T>;
    /** One round of delivery, for tests: claims, registers, feeds every handler and subscription, retries inline, deletes by `keep`, releases. */
    deliver(): Promise<void>;
    /** Claim, register the handlers and start the bus, as `connect()` does, for a process that binds a layer of its own. */
    startDelivery(): Promise<Delivery>;
  };

  /**
   * The project adds its keys, `actor` included, by declaration merging in
   * `src/context.ts`. Declaring `actor` here would make the project's own
   * declaration a duplicate-property error.
   */
  export interface ActionContext {
    /** Reserved: the application marks a call it makes on its own behalf. Mesh skips no policy for it; a policy admits it with `Mesh.isSystem(context)`. */
    system?: boolean;
  }

  /**
   * One failure. A failure a declared rule produced carries the label and the code
   * of the `check` that produced it and the position of its line; a failure with no
   * rule behind it (a `min=1` on an attribute line, say) carries no label or code.
   */
  export interface Issue {
    label: string | null;
    code: string | null;
    path: (string | number)[];
    message: string;
    source: { file: string; line: number; column: number } | null;
    /** What the failing `check` returned from `details=`, or `null`. */
    details: unknown;
  }

  /**
   * One check from a policy's breakdown, as `ForbiddenError` (and `Mesh.checkPolicies`) carry it: plain data. `result` is `null` when
   * the check was unknown; `kind` is `"when"` only for a policy whose `when=` was unknown, or was false when no covering
   * policy applied. Only the checks that ran are listed.
   */
  export interface PolicyCheck {
    policy: string;
    kind: "authorize-if" | "forbid-if" | "when";
    check: string;
    result: boolean | null;
    decisive: boolean;
  }

  export class MeshError extends Error {
    code: string;
    /**
     * Whether the same call may succeed if repeated unchanged. Set on each error when it is made (the constructor's
     * options take `retryable`); the class gives the default: `true` for `DatabaseBusyError`, `false` for the others.
     */
    readonly retryable: boolean;
  }

  export class InvalidInputError extends MeshError {
    /** Always `invalid_input`: each failing `check` declares its own code on its issue. */
    override code: "invalid_input";
    issues: Issue[];
  }

  export class NotFoundError extends MeshError {
    override code: "not_found";
  }

  export class ForbiddenError extends MeshError {
    override code: "forbidden";
    /** The entity's fully qualified name, `todo.Todo`. */
    entity: string;
    action: string;
    /** The covering policies that failed, or with `reason` `not-applied` those whose `when` was false; empty when none covers. */
    policies: readonly string[];
    /** Why: a covering policy failed, no policy covers the action, or none of the covering policies applies to the call. */
    reason: "failed" | "not-covered" | "not-applied";
    breakdown: readonly PolicyCheck[];
  }

  export class FrameworkError extends MeshError {
    override code: "framework";
  }

  /** Why a database call was given up. */
  export type DatabaseBusyReason = "locked" | "lock-timeout" | "serialization" | "deadlock" | "connection";

  /**
   * A database call given up for a reason that may be gone on the next try: on SQLite a transaction still blocked after
   * 5 s of retries, or a statement that met a lock and is not retried (`reason: "locked"`); on a server dialect also a
   * lock wait that timed out, a serialization failure, a deadlock or a lost connection. Its code is `MESH_DATABASE_BUSY`.
   */
  export class DatabaseBusyError extends MeshError {
    override code: "MESH_DATABASE_BUSY";
    /** The database the layer names: a SQLite file's path, or a server URL without credentials. */
    readonly file: string;
    /** How long the call waited, in milliseconds; 0 for a statement that is not retried. */
    readonly waitedMs: number;
    /** Why the call was given up; `"locked"` for every case data-sqlite raises. */
    readonly reason: DatabaseBusyReason;
    /** The server's SQLSTATE, or null (SQLite). */
    readonly sqlstate: string | null;
  }

  /** A `readEvents` cursor behind the deleted rows: reading on would skip them. Its code is `MESH_EVENTS_DELETED`. */
  export class EventsDeletedError extends MeshError {
    override code: "MESH_EVENTS_DELETED";
    /** The cursor the read was given. */
    readonly after: number;
    /** The oldest position the outbox still keeps. */
    readonly oldestKept: number;
  }

  /** A `readEvents` cursor above the highest position the outbox ever assigned (a restored backup). Its code is `MESH_CURSOR_AHEAD`. */
  export class CursorAheadError extends MeshError {
    override code: "MESH_CURSOR_AHEAD";
    readonly after: number;
    /** The highest position the outbox ever assigned. */
    readonly highest: number;
  }

  /** An outbox row whose stored name matches no declared event; the read stops at it. Its code is `MESH_EVENT_UNDECLARED`. */
  export class EventUndeclaredError extends MeshError {
    override code: "MESH_EVENT_UNDECLARED";
    /** The stored FQN. */
    readonly eventName: string;
    readonly position: number;
  }

  /** `events` in `mesh.config.ts` (or `bind`'s) is not valid, or a project declares handlers and no bus. Its code is `MESH_EVENTS_CONFIG`. */
  export class EventsConfigError extends MeshError {
    override code: "MESH_EVENTS_CONFIG";
  }

  /** A handler's option is not valid: an unknown event, `onFailure: "skip"` without `dead-letters`, two handlers of one name. Its code is `MESH_HANDLER_OPTION`. */
  export class HandlerOptionError extends MeshError {
    override code: "MESH_HANDLER_OPTION";
  }

  /** Who holds the deliverer claim, as `DelivererTakenError` reports it. */
  export interface ClaimHolder {
    /** The database the claim is on, as the data layer names it. */
    readonly database: string;
    readonly pid: number | null;
    readonly host: string | null;
    readonly startedAt: Date | null;
    /** How long ago the holder last renewed the claim, in milliseconds, by the database's clock. */
    readonly renewedAgoMs: number;
    readonly lapsesAt: Date;
    /** True when the holder is another binding, or another round, of this process. */
    readonly thisProcess: boolean;
    /** True when the database is delivered from several processes (a bus that declares `multi-process`): no single process holds it. */
    readonly multiProcess: boolean;
  }

  /** Another process or binding holds the deliverer claim, or a `deliver()` overlapped a round. Retryable. Its code is `MESH_DELIVERER_TAKEN`. */
  export class DelivererTakenError extends MeshError {
    override code: "MESH_DELIVERER_TAKEN";
    readonly lapsesAt: Date;
    readonly holder: ClaimHolder;
  }

  /** This process lost the deliverer claim (it was taken over after a lapse); delivery stopped. Its code is `MESH_DELIVERER_LOST`. */
  export class DelivererLostError extends MeshError {
    override code: "MESH_DELIVERER_LOST";
  }

  /** In delivery from several processes, this process no longer holds the handler: another process took it over, or a build that lists a pending event will. A bus ends the handler here without reporting it. Its code is `MESH_HANDLER_LOST`. */
  export class HandlerLostError extends MeshError {
    override code: "MESH_HANDLER_LOST";
    readonly handler: string;
    readonly reason: "taken" | "pending";
    readonly position: number;
  }

  /** A subscription's queue passed its limit (10 000 events) because its callback is slower than publishing. Retryable: reopen it. Its code is `MESH_SUBSCRIPTION_OVERFLOW`. */
  export class SubscriptionOverflowError extends MeshError {
    override code: "MESH_SUBSCRIPTION_OVERFLOW";
  }

  /** One handler that stopped in a round: where, at which event, and why. */
  export interface StoppedHandler {
    readonly handler: string;
    readonly position: number;
    /** The event's FQN as stored. */
    readonly event: string;
    readonly cause: unknown;
  }

  /** `deliver()` when handlers stopped in the round. Its code is `MESH_HANDLER_STOPPED`. */
  export class HandlerStoppedError extends MeshError {
    override code: "MESH_HANDLER_STOPPED";
    readonly stopped: readonly StoppedHandler[];
  }

  // Surfaces: what a surface's generated manifest (`#mesh/surfaces/<name>`) is made of, and what it calls.
  /** The properties of `T` named in `F`, through arrays, each keeping its `?`; `void`, `undefined` and `null` stay as they are: what leaves through a surface. */
  export type Projected<T, F extends string> =
    [T] extends [void] ? T
    : T extends null | undefined ? T
    : T extends readonly (infer E)[] ? Projected<E, F>[]
    : Readonly<Pick<T, Extract<keyof T, F>>>;
  /** A read's input with its `filter` and `sort` narrowed to the properties `F` an expose line lets leave. */
  export type SurfaceReadInput<I extends { filter?: unknown; sort?: unknown }, F extends string> = Omit<I, "filter" | "sort"> & {
    filter?: unknown;
    sort?: readonly (F | `-${F}`)[] | undefined;
  };
  /** One action a surface lets its audience call: it runs the entity's own action with the caller's context and returns the result projected. */
  export interface SurfaceAction<I = never, O = unknown> {
    readonly kind: "create" | "read" | "update" | "destroy";
    run(input: I, context: ActionContext): Promise<O>;
  }
  /** One expose line of a manifest. */
  export interface SurfaceExposure {
    /** The exposed entity's FQN, `blog.Post`. */
    readonly entity: string;
    /** `label=`, or the exposed name. */
    readonly label: string;
    /** The record properties that leave, in declaration order (a belongs-to as its key column, `authorId`). */
    readonly fields: readonly string[];
    readonly actions: { readonly [name: string]: SurfaceAction<any, unknown> };
  }
  /** A surface's manifest, which a reader (an adapter) reads at run time. */
  export interface Surface {
    readonly name: string;
    readonly expose: { readonly [name: string]: SurfaceExposure };
    /** The FQNs of the events the surface sends out. */
    readonly publishes: readonly string[];
  }
  /** Copies the properties named in `fields` from a record or each record of an array, frozen. */
  export function project<T, const F extends string>(value: T, fields: readonly F[]): Projected<T, F>;
  /** Refuses (`InvalidInputError`, issue code `not_exposed`) a read input that filters or sorts by a field outside `fields`, or loads a name outside `loadable`. */
  export function checkRead(input: unknown, fields: readonly string[], loadable: readonly string[]): void;
  /** Freezes a manifest deeply. */
  export function defineSurface<const S extends Surface>(surface: S): S;
}

declare module "@meshfw/data-sqlite" {
  import type {} from "@meshfw/runtime";

  /** A live connection to a SQLite database, owned by whoever opened it. */
  export interface SqliteDataLayer {
    close(): Promise<void>;
  }

  export function sqlite(options: { file: string }): SqliteDataLayer;

  /** Creates the tables of the emitted schema (`tables` from `#mesh`) on this connection. Tests and development only. */
  export function createSchema(dataLayer: SqliteDataLayer, tables: Readonly<Record<string, object>>): Promise<void>;
}

declare module "@meshfw/data-postgres" {
  import type {} from "@meshfw/runtime";

  export interface PostgresDataLayer {
    close(): Promise<void>;
  }

  export function postgres(options: { url: string | undefined }): PostgresDataLayer;
}

declare module "@meshfw/bus-local" {
  import type { EventBus, HandlerStoppedError } from "@meshfw/runtime";

  /** What `localBus` takes. */
  export interface LocalBusOptions {
    /** After `start()`, a round also runs this often, in milliseconds, for the commits of processes that only publish; default 1000. */
    readonly pollInterval?: number;
    /** The delays before each retry of a failing handler, in milliseconds; default `[100, 1000, 10000]` after `start()` and `[0, 0, 0]` in `deliver()` rounds; a value given here applies to both. */
    readonly retryDelays?: readonly number[];
    /** The rows a live subscription may have waiting for its callback before it ends with `MESH_SUBSCRIPTION_OVERFLOW`; default 10 000. */
    readonly maxQueue?: number;
    /** After `start()`, called with the `HandlerStoppedError` each time a handler stops, in place of the line the bus writes to stderr by default; a `deliver()` round rejects with that error and does not call it. */
    readonly onStopped?: (error: HandlerStoppedError) => void;
    /** How many processes may deliver the database: `"one"` (the default) or `"many"`, which declares `multi-process`: each handler is then held by one process at a time and moves to another when its holder stops. */
    readonly processes?: "one" | "many";
  }

  /** The first event bus: delivers in the deliverer's process, on any data adapter. Declares `ordered-delivery`, `replay`, `subscribe` and `dead-letters`, and `multi-process` with `processes: "many"`. */
  export function localBus(options?: LocalBusOptions): EventBus;
}

declare module "@meshfw/jsonrpc" {
  import type { ActionContext, Surface } from "@meshfw/runtime";

  /** Any Standard Schema validator (zod, valibot, ArkType...); `run` receives its output. */
  export interface ParamsSchema<P> {
    readonly "~standard": {
      readonly version: 1;
      readonly vendor: string;
      readonly validate: (value: unknown) => unknown;
      readonly types?: { readonly input: unknown; readonly output: P } | undefined;
    };
  }

  /** What `run` receives: the schema's output, or, for a method with no schema, the object as sent. */
  type Params<P> = unknown extends P ? Readonly<Record<string, unknown>> : P;

  /** One method: an optional schema for `params`, and `run`, whose result (or a promise of it) is the answer. */
  export interface Method<C, P = unknown> {
    readonly params?: ParamsSchema<P>;
    run(params: Params<P>, context: C, call: Call): unknown;
  }

  /** Method name to entry, for a table built apart from `serve`: every `run` receives the object as sent. */
  export type MethodTable<C> = { readonly [name: string]: Method<C, any> };

  export interface Call {
    readonly method: string;
    /** `null` for a notification. */
    readonly id: string | number | null;
    readonly params: Readonly<Record<string, unknown>>;
    readonly connection: Connection;
  }

  export interface Connection {
    /** Writes a notification (a line with no `id`) to this client; does nothing once it is closed. */
    notify(method: string, params: Record<string, unknown>): void;
    /** Runs once on close (immediately if already closed); failures go to `log`. Returns an unsubscribe function. */
    onClose(listener: () => void | Promise<void>): () => void;
    /**
     * Marks closed immediately. Calls still validating never reach context; calls building context never reach `run`.
     * Work already in `run` keeps running without an answer. Queued bytes drain with no deadline; a client that never
     * reads can keep its socket and queued bytes open indefinitely. Idempotent; does not wait for running calls.
     */
    close(): void;
    readonly closed: boolean;
  }

  /** One failure of a method's schema, in `data.issues` of the `-32602` answer. */
  export interface ParamsIssue {
    readonly message: string;
    readonly path: readonly (string | number)[];
  }

  export interface ServeOptions<C, T extends Record<string, unknown> = Record<string, unknown>> {
    socket: string;
    /** The socket file's permission bits; `0o600` unless set. */
    mode?: number;
    /** Written inline, each entry's `run` receives the type its `params` schema outputs. */
    methods: { readonly [K in keyof T]: Method<C, T[K]> };
    context: (call: Call, params: unknown) => C | Promise<C>;
    binding?: { run<R>(fn: () => Promise<R>): Promise<R> };
    error?: (error: unknown, call: Call) => ErrorObject;
    /** The message of each code the package answers with itself, in place of JSON-RPC's. */
    messages?: Partial<Record<-32700 | -32600 | -32601 | -32602 | -32603, string>>;
    log?: (message: string, error?: unknown) => void;
    maxLineBytes?: number;
  }

  export interface Server {
    readonly socket: string;
    /**
     * Stops accepting connections and requests, answers the calls still running, then ends every connection and
     * resolves, with no deadline of its own. Calling it again returns the same promise.
     */
    close(): Promise<void>;
  }

  /** Resolves once the socket accepts connections; rejects with `FrameworkError` on a bad option or an unusable path. */
  export function serve<C, T extends Record<string, unknown>>(options: ServeOptions<C, T>): Promise<Server>;

  export interface SurfaceMethodsOptions {
    /** The method name of one action line; `<exposed>.<action>` unless set. */
    name?: (exposed: string, action: string) => string;
  }

  /**
   * A method table from a surface's manifest: one method per action line, `<exposed name>.<action>` unless `name` says
   * otherwise, passing `params` as the action's input and the call's context as its context. No `params` schema: the
   * action validates. Throws `FrameworkError` when two actions get one name or a name starts with `rpc.`.
   */
  export function surfaceMethods<C extends ActionContext = ActionContext>(surface: Surface, options?: SurfaceMethodsOptions): MethodTable<C>;

  export interface ErrorObject {
    code: number;
    message: string;
    data?: unknown;
  }

  export class RpcError extends Error {
    constructor(code: number, message: string, data?: unknown);
    readonly code: number;
    readonly data?: unknown;
  }

  export const codes: {
    readonly parseError: -32700;
    readonly invalidRequest: -32600;
    readonly methodNotFound: -32601;
    readonly invalidParams: -32602;
    readonly internalError: -32603;
  };
}

declare module "meshfw" {
  /** The namespace of the functions that are the same in every project, imported the same way in a `.mesh.mx` file and a TypeScript file. */
  export { Mesh } from "@meshfw/runtime";
  /** Re-exported for compatibility; a config imports `defineConfig` from `@meshfw/runtime`. */
  export { defineConfig, type MeshConfig } from "@meshfw/runtime";
}

declare module "@meshfw/event-sourcing" {
  import { MeshError } from "@meshfw/runtime";
  import type { EventBusCapabilities, EventRecord, Handler, HandlerKind, HandlerTools, ListedEvent } from "@meshfw/runtime";

  /** `from`, as `project()` takes it: optional ("beginning" by default) on a bus that declares `replay`; required, and only "now", on one that does not. */
  export type FromOption = "replay" extends keyof EventBusCapabilities
    ? { readonly from?: "beginning" | "now" }
    : { readonly from: "now" };

  /** A handler `project()` made: a `Handler` that carries the `project` kind and its `from`. */
  export interface ProjectHandler<E extends object = object> extends Handler<E> {
    readonly from: "beginning" | "now";
  }

  /** Why a project handler failed to start: rows were deleted, a kept row of an added event lies below its position, or its progress row was registered under another kind or started from now. */
  export type HistoryReason = "deleted" | "kept-below" | "kind" | "from";

  /** `MESH_HANDLER_HISTORY`: a project handler would build its read model from part of the history, so delivery does not start. Never retryable. */
  export class HandlerHistoryError extends MeshError {
    readonly code: "MESH_HANDLER_HISTORY";
    readonly retryable: false;
    /** The handler that failed to start. */
    readonly handler: string;
    /** The events whose history it would miss. */
    readonly events: readonly string[];
    readonly reason: HistoryReason;
  }

  /** The `project` kind, as core receives it. */
  export const PROJECT: HandlerKind;

  /** A project handler: builds a read model from every event it lists, from the beginning of history unless `from: "now"`. Its body runs in the handler transaction, may neither publish nor dispatch, and never skips an event. */
  export function project<const C extends readonly ListedEvent[]>(options: {
    readonly events: C;
    run(event: EventRecord<InstanceType<C[number]>>, tools: HandlerTools): void | Promise<void>;
    readonly renamedFrom?: string;
  } & FromOption): ProjectHandler<InstanceType<C[number]>>;
}

// The generated entry points, as ADR-0086 lays them out: `#mesh` holds the framework's names only, and each
// module of the domain gets its own specifier, `#mesh/domain/<module>`, which exports each of its entities as a value
// (`Todo`, whose methods are the entity's actions) and the record type under the same name. The pages'
// entities live in two modules: `Todo` and `List` in `src/domain/todo/`, `Invoice` and `PaidInvoice` in `src/domain/billing/`.
// The types below that no single module owns (`Condition`, `Filter`, `Decision`) are this file's shorthand for the
// per-entity types the generator writes into each module.

declare module "#mesh/domain/todo" {
  import type { ActionContext, EntityValue } from "@meshfw/runtime";

  export type Condition = {
    eq?: string | number | boolean | Date | null;
    ne?: string | number | boolean | Date | null;
    lt?: string | number | boolean | Date | null;
    lte?: string | number | boolean | Date | null;
    gt?: string | number | boolean | Date | null;
    gte?: string | number | boolean | Date | null;
    in?: (string | number | boolean | Date | null)[];
    isNil?: boolean;
  };

  /** The filter form for one entity: its own fields, plus `and` and `or`. */
  export type Filter<F extends string> = { and?: Filter<F>[]; or?: Filter<F>[] } & {
    [K in F]?: Condition;
  };

  export interface Todo {
    id: string;
    title: string;
    done: boolean;
    listId: string;
    insertedAt: Date;
    updatedAt: Date;
  }

  export interface List {
    id: string;
    name: string;
    ownerId: string;
    insertedAt: Date;
    updatedAt: Date;
  }

  export type TodoField = "id" | "title" | "done" | "listId" | "insertedAt" | "updatedAt";

  /** What `load` attaches to a Todo; the record has none of it. */
  export type TodoLoadable = { label: string };
  /** The names a `load` tuple lists; none for a list that does not say which (a widened array). */
  export type TodoLoadNames<L extends readonly (keyof TodoLoadable)[]> = number extends L["length"] ? never : L[number];
  /** The `load` member of a read called with the tuple `L`: required when `L` lists a name. */
  export type TodoLoadArg<L extends readonly (keyof TodoLoadable)[]> = [TodoLoadNames<L>] extends [never] ? { load?: L | undefined } : { load: L };

  export interface ReadTodoInput<N extends keyof TodoLoadable = never> {
    filter?: Filter<TodoField>;
    sort?: string[];
    limit?: number;
    offset?: number;
    load?: readonly N[];
  }

  /** The record with the loaded names attached; with none, the plain record. */
  export type TodoWith<N extends keyof TodoLoadable> = Todo & Pick<TodoLoadable, N>;

  /** A computed field is a property only when the read asked for it: the `const` parameter takes the names as written. */
  export type PendingTodo = <const L extends readonly (keyof TodoLoadable)[] = readonly []>(
    input: Omit<ReadTodoInput, "load"> & TodoLoadArg<L>,
    context: ActionContext,
  ) => Promise<TodoWith<TodoLoadNames<L>>[]>;

  export type ListLoadable = { todoCount: number };
  export type ListLoadNames<L extends readonly (keyof ListLoadable)[]> = number extends L["length"] ? never : L[number];
  export type ListLoadArg<L extends readonly (keyof ListLoadable)[]> = [ListLoadNames<L>] extends [never] ? { load?: L | undefined } : { load: L };
  export type ListWith<N extends keyof ListLoadable> = List & Pick<ListLoadable, N>;
  export type ReadListInput<N extends keyof ListLoadable = never> = Omit<ReadTodoInput, "load"> & { load?: readonly N[] };

  /** The entity value of `List`: one method per action. */
  export const List: {
    create(input: { name: string }, context: ActionContext): Promise<List>;
    read<const L extends readonly (keyof ListLoadable)[] = readonly []>(input: Omit<ReadListInput, "load"> & ListLoadArg<L>, context: ActionContext): Promise<ListWith<ListLoadNames<L>>[]>;
    destroy(input: { id: string }, context: ActionContext): Promise<void>;
  } & EntityValue<{
      read<const L extends readonly (keyof ListLoadable)[] = readonly []>(input: Omit<ReadListInput, "load"> & ListLoadArg<L>, context?: ActionContext): Promise<ListWith<ListLoadNames<L>>[]>;
  }>;

  /** The entity value of `Todo`: one method per action. `&list` in input takes the related id; the returned record still has listId. */
  export const Todo: {
    create(input: { title: string; list: List["id"] }, context: ActionContext): Promise<Todo>;
    read<const L extends readonly (keyof TodoLoadable)[] = readonly []>(input: Omit<ReadTodoInput, "load"> & TodoLoadArg<L>, context: ActionContext): Promise<TodoWith<TodoLoadNames<L>>[]>;
    pending: PendingTodo;
    complete(input: { id: string }, context: ActionContext): Promise<Todo>;
    rename(input: { id: string; title: string }, context: ActionContext): Promise<Todo>;
    destroy(input: { id: string }, context: ActionContext): Promise<void>;
  } & EntityValue<{
      read<const L extends readonly (keyof TodoLoadable)[] = readonly []>(input: Omit<ReadTodoInput, "load"> & TodoLoadArg<L>, context?: ActionContext): Promise<TodoWith<TodoLoadNames<L>>[]>;
      pending<const L extends readonly (keyof TodoLoadable)[] = readonly []>(input: Omit<ReadTodoInput, "load"> & TodoLoadArg<L>, context?: ActionContext): Promise<TodoWith<TodoLoadNames<L>>[]>;
  }>;
}

declare module "#mesh/domain/billing" {
  import type { ActionContext, EntityValue } from "@meshfw/runtime";
  import type { Filter } from "#mesh/domain/todo";

  /** Enough of the Invoice entity for the read-with-an-argument sample on the pages. */
  export interface Invoice {
    id: string;
    number: string;
    customerId: string;
    amount: number;
    status: "draft" | "sent" | "paid" | "cancelled";
    issuedOn: Date;
    dueOn: Date;
    insertedAt: Date;
    updatedAt: Date;
  }

  export type InvoiceField =
    | "id"
    | "number"
    | "customerId"
    | "amount"
    | "status"
    | "issuedOn"
    | "dueOn"
    | "insertedAt"
    | "updatedAt";

  /** A read's typed `input` lines sit beside `filter`, `sort` and the rest. */
  export interface ReadInvoiceInput {
    customerId: string;
    filter?: Filter<InvoiceField>;
    sort?: string[];
    limit?: number;
    offset?: number;
    load?: readonly string[];
  }

  /** The event `billing.InvoicePaid`, declared in `src/domain/billing/invoice-paid.mesh.mx`. */
  export class InvoicePaid {
    constructor(fields: { invoiceId: string; amount: number; paidAt: Date });
    readonly invoiceId: string;
    readonly amount: number;
    readonly paidAt: Date;
  }

  /** The command `billing.PayInvoice`, declared in `src/domain/billing/pay-invoice.mesh.mx`; `update on=PayInvoice` answers it. */
  export class PayInvoice {
    constructor(fields: { id: string; paidAt: Date });
    readonly id: string;
    readonly paidAt: Date;
  }

  /** The read model of the event-sourcing page: one row per paid invoice, written by a project handler. */
  export interface PaidInvoice {
    id: string;
    invoiceId: string;
  }

  /** The entity value of `PaidInvoice`. */
  export const PaidInvoice: {
    record(input: { invoiceId: string }, context: ActionContext): Promise<PaidInvoice>;
    read(input: object, context: ActionContext): Promise<PaidInvoice[]>;
  } & EntityValue<{
      record(input: { invoiceId: string }, context?: ActionContext): Promise<PaidInvoice>;
      read(input: object, context?: ActionContext): Promise<PaidInvoice[]>;
  }>;

  /** The entity value of `Invoice`. */
  export const Invoice: {
    pay(input: { id: string }, context: ActionContext): Promise<Invoice>;
    /** The action `update on=PayInvoice` declares, named after the command. */
    payInvoice(input: { id: string; paidAt?: Date }, context: ActionContext): Promise<Invoice>;
    forCustomer(input: ReadInvoiceInput, context: ActionContext): Promise<Invoice[]>;
  } & EntityValue<{
      forCustomer(input: ReadInvoiceInput, context?: ActionContext): Promise<Invoice[]>;
      pay(input: { id: string }, context?: ActionContext): Promise<Invoice>;
      payInvoice(input: { id: string; paidAt?: Date }, context?: ActionContext): Promise<Invoice>;
  }>;
}

// The manifest of the Surfaces page's example, `src/surfaces/public/public.mesh.mx`: `surface :public` exposing the
// Todo module's `Todo` as `todos` with `fields=[:id, :title, :done]` and the actions `read` and `complete`.
declare module "#mesh/surfaces/public" {
  import type { Projected, Surface, SurfaceAction } from "@meshfw/runtime";
  import type { Todo } from "#mesh/domain/todo";

  type Fields = "id" | "title" | "done";
  type Compare<T> = { eq?: T; ne?: T; in?: T[] };
  type TodosFilter = { and: readonly TodosFilter[] } | { or: readonly TodosFilter[] } | { id?: Compare<string>; title?: Compare<string>; done?: Compare<boolean> };
  export const surface: Surface & {
    readonly name: "public";
    readonly expose: {
      readonly todos: {
        readonly entity: "todo.Todo";
        readonly label: string;
        readonly fields: readonly Fields[];
        readonly actions: {
          readonly read: SurfaceAction<{ filter?: TodosFilter; sort?: readonly (Fields | `-${Fields}`)[]; limit?: number; offset?: number }, Projected<Todo, Fields>[]>;
          readonly complete: SurfaceAction<{ id: string }, Projected<Todo, Fields>>;
        };
      };
    };
  };
}

// What the generated `.mesh/index.ts` merges into the runtime for the pages' bus, `localBus()`: one `true` member per
// capability it declares, so an option the bus cannot honour is a type error.
declare module "@meshfw/runtime" {
  interface EventBusCapabilities {
    "ordered-delivery": true;
    replay: true;
    subscribe: true;
    "dead-letters": true;
  }
}

declare module "#mesh" {
  import type { ActionContext, Adopted, RetryFailedResult, EventRecord as $EventRecord, EventsConfig, MetadataFunction as $MetadataFunction, ReadEventsPage, ReadEventsQuery, Seams, SubscribeQuery, Subscription, SubscriptionProgress } from "@meshfw/runtime";
  import type { Invoice, InvoicePaid, PayInvoice } from "#mesh/domain/billing";
  import type { PostgresDataLayer } from "@meshfw/data-postgres";
  import type { SqliteDataLayer } from "@meshfw/data-sqlite";

  export type { Binding, Privileged } from "@meshfw/runtime";
  import type { Binding } from "@meshfw/runtime";

  export type DataLayer = SqliteDataLayer | PostgresDataLayer;

  /** Opens a transaction on the binding in scope (else the one `connect()` opened), or joins the running one. `fn` gets nothing and the call takes no context: each call inside passes its own. */
  export function transaction<T>(fn: () => Promise<T>): Promise<T>;

  /** What `connect` takes in a project that declares an event. */
  export interface ConnectOptions {
    /** Default true: claim the database, register the handlers and start the bus. False writes the outbox and delivers nothing (scripts, the CLI, a web tier beside a worker). */
    readonly deliver?: boolean;
  }

  export function connect(options?: ConnectOptions): Promise<void>;
  /** Stops delivery first (the running round finishes, the claim is released), then waits for the calls in flight and closes the layer. */
  export function disconnect(): Promise<void>;
  export function bind(dataLayer: DataLayer, options?: { seams?: Seams; clock?: () => Date; events?: EventsConfig }): Binding;

  /** Every event class's instance type: what a publish returns and what a reader gets as `payload`. */
  export type DomainEvent = InvoicePaid;
  export type EventRecord<E extends DomainEvent = DomainEvent> = $EventRecord<E>;
  export type MetadataFunction = $MetadataFunction<DomainEvent>;
  export type { Delivery, EventMetadata, ReadEventsPage, ReadEventsQuery, RetryFailedResult, SubscribeQuery, Subscription, SubscriptionProgress } from "@meshfw/runtime";
  /** The events the running transaction has published so far, in order; outside a transaction it throws. */
  export function published(): readonly EventRecord[];
  /** Every command class an action answers with `on=`: what `dispatch` takes. A command no action answers is not in it. */
  export type DomainCommand = PayInvoice;
  /** What `dispatch` resolves with: what the action that answers the command returns (here `Invoice.payInvoice`). */
  export type DispatchResult<C extends DomainCommand> = C extends PayInvoice ? Invoice : never;
  /**
   * Runs the action whose `on=` names the command's class, with the command's fields as its input and the `context` given.
   * Joins the running transaction (an action's, a `process` handler's, `transaction()`'s) or opens its own. A value that is
   * no instance of a generated command class, and a command no action answers (a stale build), reject with `FrameworkError`.
   */
  export function dispatch<C extends DomainCommand>(command: C, context: ActionContext): Promise<DispatchResult<C>>;
  /**
   * A page of the events the outbox keeps, after `query.after`; inside a transaction it throws. Exported only when the
   * configured bus declares `replay`.
   */
  export function readEvents(query?: ReadEventsQuery): Promise<ReadEventsPage<DomainEvent>>;
  /**
   * Open (or reopen) the live subscription `query.name` in the delivering process; `callback` gets each matching event
   * once, in order. Exported only when the configured bus declares `subscribe`.
   */
  export function subscribe(query: SubscribeQuery, callback: (event: EventRecord) => unknown): Promise<Subscription>;
  /** Drop the progress row of a handler that was removed or renamed without `renamedFrom`; one the running deliverer registered is refused. */
  export function forgetHandler(name: string): Promise<void>;
  /**
   * Shrink the registered union of a handler delivered from several processes: every event a live process lists is kept,
   * and of the others only those named in `drop`. Exported only when the configured bus declares `multi-process`.
   */
  export function adoptHandler(name: string, options?: { readonly drop?: readonly string[] }): Promise<Adopted>;
  /**
   * Every persisted subscription, open or closed, with its acknowledged position, ordered by name; needs no running deliverer.
   * Reads through the layer's transaction (a write lock on SQLite); inside an application transaction it joins it.
   */
  export function listSubscriptions(): Promise<readonly SubscriptionProgress[]>;
  /** Drop the row of a subscription whose client is not coming back; an open one is refused. */
  export function forgetSubscription(name: string): Promise<void>;
  /** Resume a handler the running bus stopped at a failing event, from its progress row; where delivery is started, else a `FrameworkError`. */
  export function resumeHandler(name: string): Promise<void>;
  /**
   * Replay the events the handler `name` set aside (`onFailure: "skip"`), in position order, removing each it handles; stops
   * at the first that fails again and resolves with it as `failed`. Where delivery runs, else a `FrameworkError`. Exported
   * only when the configured bus declares `dead-letters`.
   */
  export function retryFailed(name: string): Promise<RetryFailedResult>;

  /** The emitted schema's tables, for `createSchema(db, tables)`, keyed by table name as stored (`table=` included). */
  export const tables: { readonly lists: object; readonly todos: object };

  // `query` and its types are exported only when the data adapter declares the `raw-sql` capability (ADR-0087).

  /** A value a raw query binds; anything else is refused, never bound as NULL. A `bigint` must fit in signed 64 bits. */
  export type RawValue = string | number | bigint | boolean | Date | null;
  /** A row of a raw query: the column names the statement gives, the values as stored. Frozen. */
  export type RawRow = Readonly<Record<string, unknown>>;
  /** A Standard Schema (a Zod object, for example), as `query.as` takes it. */
  type RawRowSchema = {
    readonly "~standard": {
      readonly version: 1;
      readonly vendor: string;
      readonly validate: (value: unknown) => unknown;
      readonly types?: { readonly input: unknown; readonly output: unknown } | undefined;
    };
  };
  type RawRowOutput<S extends RawRowSchema> = NonNullable<S["~standard"]["types"]>["output"];
  /** What `query` is: a template tag, plus `as(schema)`, the same tag validating and typing each row. */
  export type RawQuery = {
    (strings: TemplateStringsArray, ...values: readonly RawValue[]): Promise<readonly RawRow[]>;
    as<S extends RawRowSchema>(schema: S): (strings: TemplateStringsArray, ...values: readonly RawValue[]) => Promise<readonly RawRowOutput<S>[]>;
  };
  /**
   * Runs one read-only SQL statement written by hand (`select`, `with` or `values`), inside the running transaction of the
   * binding in scope, else of the connected one, else in a transaction of its own. Every `${…}` is bound as a parameter.
   * Rows come back as stored, frozen. Read policies do not apply. Throws while a computed field or a read policy is evaluated.
   */
  export const query: RawQuery;
}

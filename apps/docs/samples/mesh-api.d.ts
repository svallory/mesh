// Declarations of the API the Docs pages describe, used only by
// `test/docs-samples.test.ts`, which type-checks every TypeScript sample on those
// pages against this file.
//
// This is not Mesh. Mesh does not exist as an installable runtime yet, so the file
// states the shape the pages promise: the generated entry points (`#mesh` and the
// `#mesh/domain/<module>` specifiers) for the entities of the pages, the run-time error
// classes, `Mesh` (the functions that are the same in every project), the SQLite adapter, the JSON-RPC transport and the configuration helper. If a page and this file
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
    output: string;
    data: SqliteDataLayer | PostgresDataLayer;
    extensions?: unknown[];
    seams?: Seams;
  };

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
  };

  /** What `bind` returns: the whole domain on one data layer, one seam set and one clock. */
  export type Binding = {
    /** Runs `fn` with this binding in scope: every entity call and `privileged` read inside it uses this binding's data layer. */
    run<T>(fn: () => Promise<T>): Promise<T>;
    /** Opens a transaction on this binding's data layer, or joins the running one, with this binding in scope. `fn` gets nothing and the call takes no context. */
    transaction<T>(fn: () => Promise<T>): Promise<T>;
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

declare module "@meshfw/jsonrpc" {
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

// The generated entry points, as CMP-17 and CMP-18 lay them out: `#mesh` holds the framework's names only, and each
// module of the domain gets its own specifier, `#mesh/domain/<module>`, which exports each of its entities as a value
// (`Todo`, whose methods are the entity's actions, CMP-16) and the record type under the same name. The pages'
// entities live in two modules: `Todo` and `List` in `src/domain/todo/`, `Invoice` in `src/domain/billing/`.
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

  /** The entity value of `Invoice`. */
  export const Invoice: {
    forCustomer(input: ReadInvoiceInput, context: ActionContext): Promise<Invoice[]>;
  } & EntityValue<{
      forCustomer(input: ReadInvoiceInput, context?: ActionContext): Promise<Invoice[]>;
  }>;
}

declare module "#mesh" {
  import type { Seams } from "@meshfw/runtime";
  import type { PostgresDataLayer } from "@meshfw/data-postgres";
  import type { SqliteDataLayer } from "@meshfw/data-sqlite";

  export type { Binding, Privileged } from "@meshfw/runtime";
  import type { Binding } from "@meshfw/runtime";

  export type DataLayer = SqliteDataLayer | PostgresDataLayer;

  /** Opens a transaction on the binding in scope (else the one `connect()` opened), or joins the running one. `fn` gets nothing and the call takes no context: each call inside passes its own. */
  export function transaction<T>(fn: () => Promise<T>): Promise<T>;

  export function connect(): Promise<void>;
  export function disconnect(): Promise<void>;
  export function bind(dataLayer: DataLayer, options?: { seams?: Seams; clock?: () => Date }): Binding;

  /** The emitted schema's tables, for `createSchema(db, tables)`, keyed by table name as stored (`table=` included). */
  export const tables: { readonly lists: object; readonly todos: object };
}

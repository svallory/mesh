// Declarations of the API the Docs pages describe, used only by
// `test/docs-samples.test.ts`, which type-checks every TypeScript sample on those
// pages against this file.
//
// This is not Mesh. Mesh does not exist as an installable runtime yet, so the file
// states the shape the pages promise: the generated entry points (`#mesh` and the
// `#mesh/domain/<module>` specifiers) for the entities of the pages, the run-time error
// classes, the SQLite adapter and the configuration helper. If a page and this file
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

  /** Storage operations of one open transaction, by table handle (`tables` from `#mesh`). Writes through it run no seams. */
  export type DataOperations = {
    insert(table: object, row: Record<string, unknown>): Promise<Record<string, unknown>>;
    selectByKey(table: object, key: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
    updateByKey(table: object, key: Record<string, unknown>, changes: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
    deleteByKey(table: object, key: Record<string, unknown>): Promise<boolean>;
  };

  /** One row written by a call: the row as it was (`null` on a create) and as written (`null` on a destroy). */
  export type WriteChange = {
    entity: string;
    action: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    input: unknown;
    context: ActionContext;
  };

  /** Code the application runs at three points of every generated action. Payloads are plain data. */
  export type Seams = {
    /** Before the transaction opens; throw to refuse the call. */
    beforeTransaction?(call: { entity: string; action: string; input: unknown; context: ActionContext }): void | Promise<void>;
    /** Inside the transaction, right after each row is written; a throw rolls back the whole call. */
    afterWrite?(db: DataOperations, change: WriteChange): void | Promise<void>;
    /** Once, after the outermost transaction commits; not called on rollback. */
    afterCommit?(commit: { changes: WriteChange[] }): void | Promise<void>;
  };

  export function defineConfig(config: MeshConfig): MeshConfig;

  /**
   * The project adds its keys, `actor` included, by declaration merging in
   * `src/context.ts`. Declaring `actor` here would make the project's own
   * declaration a duplicate-property error. The reserved `system` key is
   * declared in the augmentation at the end of this file, outside the part of
   * the file that the runtime-reference test compares with the real runtime.
   */
  export interface ActionContext {}

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

  /** One check from a policy's breakdown, as `can` returns it. */
  export interface PolicyCheck {
    policy: string;
    check: string;
    result: boolean;
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
    breakdown: PolicyCheck[];
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

// Declared apart from the runtime section above, which `packages/compiler/test/runtime-reference.test.ts`
// compares member for member with the real runtime: the runtime does not have these yet.
declare module "@meshfw/runtime" {
  interface ActionContext {
    /** Reserved: the application marks a call it makes on its own behalf. Mesh skips no policy for it. */
    system?: boolean;
  }
}

declare module "meshfw" {
  /** Re-exported for compatibility; a config imports `defineConfig` from `@meshfw/runtime`. */
  export { defineConfig, type MeshConfig } from "@meshfw/runtime";
}

// The generated entry points, as CMP-17 lays them out: `#mesh` holds the framework's names only, and each module
// of the domain gets its own specifier, `#mesh/domain/<module>`, with its entities' action functions and types. The
// pages' entities live in two modules: `Todo` and `List` in `src/domain/todo/`, `Invoice` in `src/domain/billing/`.
// The types below that no single module owns (`Condition`, `Filter`, `Decision`) are this file's shorthand for the
// per-entity types the generator writes into each module.

declare module "#mesh/domain/todo" {
  import type { ActionContext, PolicyCheck } from "@meshfw/runtime";

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

  export interface Decision {
    allowed: boolean;
    breakdown: PolicyCheck[];
  }

  export type TodoField = "id" | "title" | "done" | "listId" | "insertedAt" | "updatedAt";

  export interface ReadTodoInput {
    filter?: Filter<TodoField>;
    sort?: string[];
    limit?: number;
    offset?: number;
    load?: readonly string[];
  }

  export type TodoOrLabelled = Todo & { label: string };

  /** A computed field is a property only when the read asked for it: two signatures say so. */
  export interface PendingTodo {
    (input: { load: readonly ["label"] }, context: ActionContext): Promise<TodoOrLabelled[]>;
    (input: { filter?: Filter<TodoField>; load?: readonly string[] }, context: ActionContext): Promise<Todo[]>;
  }

  export function createList(input: { name: string }, context: ActionContext): Promise<List>;
  export function readList(input: ReadTodoInput, context: ActionContext): Promise<List[]>;
  export function destroyList(input: { id: string }, context: ActionContext): Promise<void>;
  /** `&list` in input takes the related id; the returned record still has listId. */
  export function createTodo(input: { title: string; list: List["id"] }, context: ActionContext): Promise<Todo>;
  export function readTodo(input: ReadTodoInput, context: ActionContext): Promise<Todo[]>;
  export const pendingTodo: PendingTodo;
  export function completeTodo(input: { id: string }, context: ActionContext): Promise<Todo>;
  export function renameTodo(input: { id: string; title: string }, context: ActionContext): Promise<Todo>;
  export function destroyTodo(input: { id: string }, context: ActionContext): Promise<void>;
  export function canCreateTodo(input: { title: string; list: List["id"] }, context: ActionContext): Promise<Decision>;
  export function canPendingTodo(input: { load?: readonly string[] }, context: ActionContext): Promise<Decision>;
  export function canCompleteTodo(input: { id: string }, context: ActionContext): Promise<Decision>;
}

declare module "#mesh/domain/billing" {
  import type { ActionContext } from "@meshfw/runtime";
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

  export function forCustomerInvoice(input: ReadInvoiceInput, context: ActionContext): Promise<Invoice[]>;
}

declare module "#mesh" {
  import type { ActionContext, Seams } from "@meshfw/runtime";
  import type { PostgresDataLayer } from "@meshfw/data-postgres";
  import type { SqliteDataLayer } from "@meshfw/data-sqlite";
  import type * as todo from "#mesh/domain/todo";
  import type * as billing from "#mesh/domain/billing";

  /** What `bind` returns: every action function of the project, by name, on one data layer. */
  export type Bound = {
    createList: typeof todo.createList;
    readList: typeof todo.readList;
    destroyList: typeof todo.destroyList;
    createTodo: typeof todo.createTodo;
    readTodo: typeof todo.readTodo;
    pendingTodo: todo.PendingTodo;
    completeTodo: typeof todo.completeTodo;
    renameTodo: typeof todo.renameTodo;
    destroyTodo: typeof todo.destroyTodo;
    forCustomerInvoice: typeof billing.forCustomerInvoice;
    canCreateTodo: typeof todo.canCreateTodo;
    canPendingTodo: typeof todo.canPendingTodo;
    canCompleteTodo: typeof todo.canCompleteTodo;
  };

  export type DataLayer = SqliteDataLayer | PostgresDataLayer;

  /** The action functions as `actions` hands them to a step, a check or `transaction`: bound to the running transaction, context optional. */
  export type Actions = {
    createList(input: { name: string }, context?: ActionContext): Promise<todo.List>;
    createTodo(input: { title: string; list: todo.List["id"] }, context?: ActionContext): Promise<todo.Todo>;
    completeTodo(input: { id: string }, context?: ActionContext): Promise<todo.Todo>;
    renameTodo(input: { id: string; title: string }, context?: ActionContext): Promise<todo.Todo>;
    destroyTodo(input: { id: string }, context?: ActionContext): Promise<void>;
  };

  /** The reads of the running transaction; no read policies run. */
  export type Reads = {
    readList(input: todo.ReadTodoInput): Promise<todo.List[]>;
    readTodo(input: todo.ReadTodoInput): Promise<todo.Todo[]>;
  };

  /** Opens a transaction, or joins the running one, and hands `run` the bound `actions` and `tx`. */
  export function transaction<T>(
    run: (handle: { actions: Actions; tx: Reads }) => Promise<T>,
    context: ActionContext,
  ): Promise<T>;

  export function connect(): Promise<void>;
  export function disconnect(): Promise<void>;
  export function bind(dataLayer: DataLayer, options?: { seams?: Seams; clock?: () => Date }): Bound;

  /** The emitted schema's tables, for `createSchema(db, tables)`. */
  export const tables: { readonly list: object; readonly todo: object };
}

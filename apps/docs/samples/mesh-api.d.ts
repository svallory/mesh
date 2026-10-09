// Declarations of the API the Docs pages describe, used only by
// `test/docs-samples.test.ts`, which type-checks every TypeScript sample on those
// pages against this file.
//
// This is not Mesh. Mesh does not exist as an installable runtime yet, so the file
// states the shape the pages promise: the generated `#mesh` entry point for the two
// entities of the tutorial, the run-time error classes, the SQLite adapter and the
// configuration helper. If a page and this file disagree, the page is a bug or this
// file is; both are cheap to fix and the sample check is what notices.
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
  };

  export function defineConfig(config: MeshConfig): MeshConfig;

  /**
   * Empty in the runtime, as ruled: the project adds its keys, `actor` included,
   * by declaration merging in `src/context.ts`. Declaring `actor` here would make
   * the project's own declaration a duplicate-property error.
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

declare module "meshfw" {
  /** Re-exported for compatibility; a config imports `defineConfig` from `@meshfw/runtime`. */
  export { defineConfig, type MeshConfig } from "@meshfw/runtime";
}

declare module "#mesh" {
  import type { ActionContext } from "@meshfw/runtime";
  import type { PostgresDataLayer } from "@meshfw/data-postgres";
  import type { SqliteDataLayer } from "@meshfw/data-sqlite";

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

  /** A read's typed `input` lines sit beside `filter`, `sort` and the rest. */
  export interface ReadInvoiceInput {
    customerId: string;
    filter?: Filter<InvoiceField>;
    sort?: string[];
    limit?: number;
    offset?: number;
    load?: readonly string[];
  }

  export type Bound = {
    createList(input: { name: string }, context: ActionContext): Promise<List>;
    readList(input: ReadTodoInput, context: ActionContext): Promise<List[]>;
    destroyList(input: { id: string }, context: ActionContext): Promise<void>;
    /** `&list` in input takes the related id; the returned record still has listId. */
    createTodo(input: { title: string; list: List["id"] }, context: ActionContext): Promise<Todo>;
    readTodo(input: ReadTodoInput, context: ActionContext): Promise<Todo[]>;
    pendingTodo: PendingTodo;
    completeTodo(input: { id: string }, context: ActionContext): Promise<Todo>;
    renameTodo(input: { id: string; title: string }, context: ActionContext): Promise<Todo>;
    destroyTodo(input: { id: string }, context: ActionContext): Promise<void>;
    forCustomerInvoice(input: ReadInvoiceInput, context: ActionContext): Promise<Invoice[]>;
    canCreateTodo(input: { title: string; list: List["id"] }, context: ActionContext): Promise<Decision>;
    canPendingTodo(input: { load?: readonly string[] }, context: ActionContext): Promise<Decision>;
    canCompleteTodo(input: { id: string }, context: ActionContext): Promise<Decision>;
  };

  export type DataLayer = SqliteDataLayer | PostgresDataLayer;

  export function connect(): Promise<void>;
  export function disconnect(): Promise<void>;
  export function bind(dataLayer: DataLayer): Bound;

  /** The emitted schema's tables, for `createSchema(db, tables)`. */
  export const tables: { readonly list: object; readonly todo: object };

  export const createList: Bound["createList"];
  export const readList: Bound["readList"];
  export const destroyList: Bound["destroyList"];
  export const createTodo: Bound["createTodo"];
  export const readTodo: Bound["readTodo"];
  export const pendingTodo: PendingTodo;
  export const completeTodo: Bound["completeTodo"];
  export const renameTodo: Bound["renameTodo"];
  export const destroyTodo: Bound["destroyTodo"];
  export const forCustomerInvoice: Bound["forCustomerInvoice"];
  export const canCreateTodo: Bound["canCreateTodo"];
  export const canPendingTodo: Bound["canPendingTodo"];
  export const canCompleteTodo: Bound["canCompleteTodo"];
}
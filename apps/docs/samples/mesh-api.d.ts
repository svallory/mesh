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

declare module "@mesh/runtime" {
  /** Declared by the user's own `src/context.ts`; nothing is declared by default. */
  export interface ActionContext {
    [key: string]: unknown;
  }

  export interface Issue {
    path: (string | number)[];
    message: string;
    source?: { file: string; line: number; column: number };
  }

  export class MeshError extends Error {
    code: string;
  }

  export class InvalidInputError extends MeshError {
    override code: "invalid_input";
    issues: Issue[];
  }

  export class NotFoundError extends MeshError {
    override code: "not_found";
  }

  export class ForbiddenError extends MeshError {
    override code: "forbidden";
    breakdown: string[];
  }

  export class FrameworkError extends MeshError {
    override code: "framework";
  }
}

declare module "@mesh/data-sqlite" {
  import type {} from "@mesh/runtime";

  /** A live connection to a SQLite database, owned by whoever opened it. */
  export interface SqliteDataLayer {
    close(): Promise<void>;
  }

  export function sqlite(options: { file: string }): SqliteDataLayer;

  /** Creates the tables of the emitted schema on this connection. Tests and development only. */
  export function pushSQLiteSchema(dataLayer: SqliteDataLayer): Promise<void>;
}

declare module "@mesh/data-postgres" {
  import type {} from "@mesh/runtime";

  export interface PostgresDataLayer {
    close(): Promise<void>;
  }

  export function postgres(options: { url: string | undefined }): PostgresDataLayer;
}

declare module "@mesh/cli" {
  import type { PostgresDataLayer } from "@mesh/data-postgres";
  import type { SqliteDataLayer } from "@mesh/data-sqlite";

  export interface MeshConfig {
    domain: string;
    output: string;
    data: SqliteDataLayer | PostgresDataLayer;
    extensions?: unknown[];
  }

  export function defineConfig(config: MeshConfig): MeshConfig;
}

declare module "@mesh/ext-policies" {
  export function policies(): unknown;
}

declare module "#mesh" {
  import type { ActionContext } from "@mesh/runtime";
  import type { PostgresDataLayer } from "@mesh/data-postgres";
  import type { SqliteDataLayer } from "@mesh/data-sqlite";

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
    listId?: string;
    insertedAt: Date;
    updatedAt: Date;
  }

  export interface List {
    id: string;
    name: string;
    ownerId: string;
    insertedAt: Date;
  }

  export interface Decision {
    allowed: boolean;
    breakdown: string[];
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

  /** A calculation is a property only when the read asked for it: two signatures say so. */
  export interface PendingTodo {
    (input: { load: readonly ["label"] }, context: ActionContext): Promise<TodoOrLabelled[]>;
    (input: { load?: readonly string[] }, context: ActionContext): Promise<Todo[]>;
  }

  export type Bound = {
    createList(input: { name: string }, context: ActionContext): Promise<List>;
    readList(input: ReadTodoInput, context: ActionContext): Promise<List[]>;
    destroyList(input: { id: string }, context: ActionContext): Promise<void>;
    /** `listId` is optional here: the quick start's todo has no `belongs-to` to add it. */
    createTodo(input: { title: string; listId?: string }, context: ActionContext): Promise<Todo>;
    readTodo(input: ReadTodoInput, context: ActionContext): Promise<Todo[]>;
    pendingTodo: PendingTodo;
    completeTodo(input: { id: string }, context: ActionContext): Promise<Todo>;
    renameTodo(input: { id: string; title: string }, context: ActionContext): Promise<Todo>;
    destroyTodo(input: { id: string }, context: ActionContext): Promise<void>;
    canCreateTodo(input: { title: string; listId?: string }, context: ActionContext): Promise<Decision>;
    canPendingTodo(input: { load?: readonly string[] }, context: ActionContext): Promise<Decision>;
    canCompleteTodo(input: { id: string }, context: ActionContext): Promise<Decision>;
  };

  export type DataLayer = SqliteDataLayer | PostgresDataLayer;

  export function connect(): Promise<void>;
  export function disconnect(): Promise<void>;
  export function bind(dataLayer: DataLayer): Bound;

  export const createList: Bound["createList"];
  export const readList: Bound["readList"];
  export const destroyList: Bound["destroyList"];
  export const createTodo: Bound["createTodo"];
  export const readTodo: Bound["readTodo"];
  export const pendingTodo: PendingTodo;
  export const completeTodo: Bound["completeTodo"];
  export const renameTodo: Bound["renameTodo"];
  export const destroyTodo: Bound["destroyTodo"];
  export const canCreateTodo: Bound["canCreateTodo"];
  export const canPendingTodo: Bound["canPendingTodo"];
  export const canCompleteTodo: Bound["canCompleteTodo"];
}
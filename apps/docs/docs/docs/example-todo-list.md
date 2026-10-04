---
title: "Example: a todo list"
description: "A complete walk-through: two resources, a relationship, a validation, a policy, a calculation, and a script that calls them."
---

# Example: a todo list

::: callout warning "Live spec, not released"
This page describes how Mesh **will** work, not how it works today. It is a live spec of the developer experience, written before the code. Mesh is not released: nothing here can be installed or run yet, and any detail may change.
:::

This is a complete walk-through of a small project: two resources, one relationship, a validation, a policy, a calculation and an aggregate, and a plain TypeScript script that calls the actions. There is no HTTP server. Mesh serves a command line, a daemon, a worker or a web app equally; the example is a script because that is the shortest path through every idea.

The project is `todo-app`, the one from [Installation](./installation.md). It is called a todo list because a list of lists is the smallest thing that needs a relationship, an ownership rule and a derived value.

## What the two resources are

- **`list`** — a named list with an owner. It has many todos, and it carries a count of them.
- **`todo`** — one item in a list. It belongs to a list, has a title, a done flag and two timestamps.

The vocabulary follows Ash's DSL in kebab-case with the trailing `?` dropped ([ADR-0034](../architecture/decisions/0034-vocabulary-copies-ash-dsl.md)), and every example is in MX concise syntax, the indentation-based form ([ADR-0041](../architecture/decisions/0041-mx-concise-syntax.md)). The tags are listed in the [Resource file reference](./resource-file-reference.md).

## `resources/list.mx`

```mx "resources/list.mx"
resource="list" table="lists" domain="todos"
  attributes
    uuid-primary-key="id"
    attribute="name" type="string" allow-nil=false
    attribute="ownerId" type="uuid" allow-nil=false
    create-timestamp="insertedAt"

  relationships
    has-many="todos" destination="todo"

  actions defaults=["read", "destroy"]
    create="create" accept=["name"]
      change=({ list, actor }) => { list.ownerId = actor.id }

  policies
    policy=action_type("create")
      authorize-if=() => true
    policy=action_type(["read", "destroy"])
      authorize-if=({ list, actor }) => list.ownerId === actor.id

  aggregates
    count="todoCount" relationship-path="todos"
```

Reading it top to bottom:

- `resource="list"` names the resource. `table="lists"` names the database table. `domain="todos"` groups the generated files into `generated/todos/`.
- `uuid-primary-key="id"` declares the primary key: a UUID Mesh generates, which the caller never sends and never accepts.
- `allow-nil=false` says the column is not nullable. Attribute types are `string`, `integer`, `float`, `boolean`, `atom`, `uuid` and `datetime`; a uuid arrives in TypeScript as a `string` and a datetime as a `Date`.
- `create-timestamp="insertedAt"` declares an attribute the database fills on insert and the caller never sets.
- `actions defaults=["read", "destroy"]` asks for a `read` action and a `destroy` action, each named after its type, without declaring them.
- `create="create" accept=["name"]` declares a create action named `create`, which accepts only `name`. `ownerId` is filled by the change, not by the caller: `change` receives one object argument, destructured here as `{ list, actor }`, and sets `list.ownerId` from the actor. The meaning of the record on a create is still open, as noted below.
- The policies block declares a check for each action. `action_type` accepts one name or a list of names, and a list means any of them, so `action_type(["read", "destroy"])` gives one policy for both actions. That is different from a list of checks, `policy=[a, b]`, where [all conditions in that list must hold](../architecture/research/ash-features.md). With the policies extension enabled, an action with no matching policy is forbidden. `authorize-if` returns a boolean; the expression is the record and the actor, and nothing else.
- `count="todoCount" relationship-path="todos"` declares an aggregate: the number of related todos.

`table` stays an attribute of `resource` for now. It moves to a data-layer section, as in Ash, when the extension host exists at M6 or at the post-v1 vocabulary review. [The vocabulary mapping](../architecture/roadmap/vocabulary-mapping.md), exception X1, is closed for now.

::: callout info "Not decided yet"
Ash's `belongs_to` creates its foreign-key attribute as `<name>_id`. The roadmap uses `listId`, matching the fixture. Which name Mesh generates is settled when relationships are built. [The vocabulary mapping](../architecture/roadmap/vocabulary-mapping.md), row D12.
:::

## `resources/todo.mx`

```mx "resources/todo.mx"
resource="todo" table="todos" domain="todos"
  attributes
    uuid-primary-key="id"
    attribute="title" type="string" allow-nil=false
    attribute="done" type="boolean" allow-nil=false default=false
    create-timestamp="insertedAt"
    update-timestamp="updatedAt"

  relationships
    belongs-to="list" destination="list"

  actions defaults=["read", "destroy"]
    create="create" accept=["title", "listId"]
      validate=({ todo }) => todo.title.length > 0 message="title must not be empty"

    update="complete"
      change=({ todo }) => { todo.done = true }

    update="rename" accept=["title"]

    read="pending"
      filter=({ todo }) => todo.done === false
      sort=["insertedAt"]

  policies
    policy=action_type(["create", "read", "update", "destroy"])
      authorize-if=({ todo, actor }) => todo.list.ownerId === actor.id

  calculations
    calculate="label" type="string"
      value({ todo }) {
        return (todo.done ? "[x] " : "[ ] ") + todo.title
      }
```

::: callout info "Not decided yet"
The `sort` child tag is the current contract form, not a settled v1 design. Ash sorts a read through a `prepare build(sort: ...)` call; [the vocabulary mapping](../architecture/roadmap/vocabulary-mapping.md), D17/G1, leaves Mesh's form to M3/M5.
:::

Reading it:

- `belongs-to="list" destination="list"` declares the relationship, and `listId` is the foreign-key attribute it adds. The `todoCount` aggregate on `list` and this relationship are the two sides.
- `create` accepts `title` and `listId`. Its validation rejects an empty title and carries the `message` the caller sees.
- `update="complete"` has no `accept`, so it changes nothing the caller sends; its change sets `done = true`. Because that change reads no stored value, it folds into the `UPDATE` statement and the action stays **atomic**: one statement, no read first, so two concurrent callers cannot both act on a stale row.
- `update="rename" accept=["title"]` accepts `title`.
- `read="pending"` filters to undone todos and sorts them oldest first. A `filter` must be translatable to SQL, so only the registered functions may appear in it.
- The policy reads `todo.list.ownerId`. On an atomic update it becomes part of the statement's filter; it does not require loading the relationship into the returned record. On create, the Proposed amendment below queries the related record inside the transaction before insert.
- `calculate="label"` is a derived value.

::: callout info "Proposed amendment: validation sees the changed record"
The proposed amendment to [ADR-0017](../architecture/decisions/0017-atomic-by-default-and-classification.md) gives `validate` the proposed record after the action's changes and the input as a second parameter. The create validation above therefore sees the incoming title. On update it sees the resulting title, not only the old stored value.
:::

::: callout info "Proposed amendment: create policies run before insert"
The proposed amendment to [ADR-0022](../architecture/decisions/0022-policies-simple-tier-as-extension.md) gives a create policy the proposed record. Reading `todo.list.ownerId` queries the related record inside the transaction, before the insert. See [the action lifecycle](../architecture/in-depth/action-lifecycle.md).
:::

::: callout info "Not decided yet"
The exact semantics of a Mesh expression are still to be ruled, and they decide what `todo.done === false` means where SQL and JavaScript disagree (nulls, string ordering, division). Mesh's plan is one expression tree evaluated both ways. [ADR-0012](../architecture/decisions/0012-expression-semantics.md) records it.
:::

### The `label` calculation

`label` is **opaque**: it is not translatable to SQL. The registry of functions that can be converted holds attribute and parameter references, literals, comparison and boolean operators, numeric `+` and `-`, string length, and assignment to an attribute. A conditional operator on a string and a string concatenation are not in it.

An opaque calculation runs in memory, after the rows are loaded. Two things follow, and both are worth knowing before you write one:

- It cannot appear in a `filter`, a `sort` or a caller's filter. The build fails there.
- You have to ask for it. A calculation is computed only when the read names it in `load`, and reading one that was not loaded is a type error.

## `src/actor.ts`

The actor is your application's idea of a caller. Mesh does not decide what one is; you register the type once, and every `scope.actor` is typed from it.

```ts "src/actor.ts"
import "@mesh/runtime";

declare module "@mesh/runtime" {
  interface Register {
    actor: { id: string };
  }
}

export const alice = { id: "00000000-0000-4000-8000-000000000001" };
export const bob = { id: "00000000-0000-4000-8000-000000000002" };
```

The import and exports make this file a module, so the declaration augments Mesh's existing `Register` interface. The example actors use UUIDs because `list.ownerId` has type `uuid`.

An application with anonymous callers registers `User | null`. A tenant is not part of the actor: where multitenancy lives is [open](../architecture/decisions/0009-tenancy-placement.md), and until it is decided a tenant travels in `scope.context`.

## `src/main.ts`

The whole program. It connects, creates a list as one actor, adds todos, completes one, prints the pending todos, then shows what happens when somebody else tries.

```ts "src/main.ts"
import { InvalidInputError, NotFoundError } from "@mesh/runtime";
import {
  connect,
  disconnect,
  createList,
  createTodo,
  completeTodo,
  pendingTodo,
} from "../generated";
import { alice, bob } from "./actor";

await connect({ file: "todo.db" });

const list = await createList({ name: "Groceries" }, { actor: alice });

const milk = await createTodo(
  { title: "Buy milk", listId: list.id },
  { actor: alice },
);
await createTodo({ title: "Buy bread", listId: list.id }, { actor: alice });
await createTodo({ title: "Buy coffee", listId: list.id }, { actor: alice });

await completeTodo({ id: milk.id }, { actor: alice });

for (const todo of await pendingTodo({ load: ["label"] }, { actor: alice })) {
  console.log(todo.label);
}

try {
  await completeTodo({ id: milk.id }, { actor: bob });
} catch (error) {
  if (!(error instanceof NotFoundError)) throw error;
  console.log(error.code); // "not_found"
}

try {
  await createTodo({ title: "", listId: list.id }, { actor: alice });
} catch (error) {
  if (!(error instanceof InvalidInputError)) throw error;
  console.log(error.issues.map((issue) => issue.message).join("; "));
}

await disconnect();
```

Output:

```text
[ ] Buy bread
[ ] Buy coffee
not_found
title must not be empty
```

What to notice:

- **`createList` takes only `name`.** `ownerId` is not accepted, so a caller cannot become the owner of somebody else's list by sending it.
- **`completeTodo({ id })` takes an id and nothing else.** The change sets `done`; the caller does not send `done`.
- **`load: ["label"]`** is what makes `todo.label` typed on the returned array. Without it the property is a type error.
- **Bob gets `NotFoundError`, not `ForbiddenError`.** The policy reads the stored record, so on an atomic update it folds into the statement as a filter, and a row the caller may not change is reported as not found. That is Mesh's choice: Ash compiles the same check into the statement but as an expression that raises, and reports forbidden. The asymmetry is the working assumption for v1.

::: callout info "Not decided yet"
What a denied write reports on an atomic action. The rule used above is that a record-reading policy folds into the statement and a row the caller may not change reports **not found**. Ash reports forbidden. [ADR-0046](../architecture/decisions/0046-denied-atomic-write-outcome.md) records the choice and the alternative; `canCompleteTodo` is the way to ask why either way.
:::

- **The empty title is an `InvalidInputError`** carrying the `message` from the `validate` tag.

::: callout info "Not decided yet"
How a run-time error carries the position of the `.mx` tag that failed. Mesh's working assumption is that the generated code carries the file, line and column as data, which is what `InvalidInputError.issues[].source` holds above. [ADR-0039](../architecture/decisions/0039-run-time-error-positions.md) records that choice against using source maps.
:::

## The generated functions

One exported function per action, named after the action and the resource in PascalCase. The table shows action functions, not their authorization helpers; every action also has a `can` function, such as `canCompleteTodo(input, scope)`, returning `{ allowed: boolean; breakdown }`.

The return types below are the values the promises resolve to:

| Resource file | Action | Function | Returns |
|---|---|---|---|
| `list.mx` | `read` (default) | `readList(input, scope)` | `List[]` |
| `list.mx` | `create` | `createList(input, scope)` | `List` |
| `list.mx` | `destroy` (default) | `destroyList(input, scope)` | `void` |
| `todo.mx` | `read` (default) | `readTodo(input, scope)` | `Todo[]` |
| `todo.mx` | `read="pending"` | `pendingTodo(input, scope)` | `Todo[]` |
| `todo.mx` | `create` | `createTodo(input, scope)` | `Todo` |
| `todo.mx` | `update="complete"` | `completeTodo(input, scope)` | `Todo` |
| `todo.mx` | `update="rename"` | `renameTodo(input, scope)` | `Todo` |
| `todo.mx` | `destroy` (default) | `destroyTodo(input, scope)` | `void` |

The `Todo` type is derived from the resource file:

```ts
export type Todo = {
  id: string;
  title: string;
  done: boolean;
  listId: string;
  insertedAt: Date;
  updatedAt: Date;
};
```

[Calling actions](./calling-actions.md) has every signature, the filter form and the error classes.

## Building and running it

```bash
bunx mesh build        # writes generated/
bunx mesh db push      # creates the SQLite file and the two tables
bun run src/main.ts
```

## Next

- [Calling actions](./calling-actions.md) — signatures, the scope, filters, `load`, errors and `can`.
- [Usage](./usage.md) — the loop once the first resource exists.
- [Configuration](./configuration.md) — the file that points Mesh at all of this.
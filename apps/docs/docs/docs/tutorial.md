---
title: "Tutorial: a todo list"
description: "Two entities, a relationship, a validation, a policy, a computed field and a rollup, then a script and a test that use them."
---

# Tutorial: a todo list

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

You will build a small program: lists of todos, where a list belongs to somebody and only that person may read or change its todos. Along the way you will use the main ideas Mesh has: relationships, validations, steps, policies and computed fields. Then you will run it, and write a test for it.

Start from the project in the [quick start](./quick-start.md), or from a new one:

```bash
bun create meshfw todo-app
cd todo-app
```

## What the program does

- Someone creates a list. The list records who owns it.
- Someone adds a todo to a list they own.
- Someone completes a todo, and asks which todos are still pending.
- Somebody else's todos come back as nothing at all, and the errors say why.

Two entities, because a todo needs a list and a list needs todos. A relationship lets you write `&list.ownerId` in a rule and have Mesh fetch the list for you.

## The list

`src/domain/todo/list.mesh.mx`:

```mx "src/domain/todo/list.mesh.mx"
import { Todo } from "./todo.mesh.mx"

entity :List table="lists"
  attributes
    uuid :id primary-key
    string :name
    uuid :ownerId
    timestamp :insertedAt on=:create
    timestamp :updatedAt on=:update

  relationships
    has-many :todos entity=Todo

  computed
    count :todoCount of="todos"

  actions auto=[:read, :destroy]
    create :create
      input
        &name
      do
        set
          &ownerId=({ actor }) => actor.id

  policies
    policy :anyoneCreates types=[:create]
      authorize-if=() => true
    policy :ownerOnly types=[:read, :destroy]
      authorize-if=({ actor }) => &ownerId === actor.id
```

Four things worth noticing:

- **Only `&name` in `input`.** `ownerId` is not in the input, so no caller can create a list owned by somebody else; a step fills it from the caller's `actor`.
- **The two policies are separate.** `types=[:read, :destroy]` means "read or destroy", which is one policy for two actions. Two policies are "and": every policy covering an action must pass.
- **`types=[:create]` on its own policy allows everyone**, because `authorize-if=() => true` always holds. `read` and `destroy` need ownership. An action that no policy covers is forbidden, so a new action needs one before it works.
- **`count :todoCount`** is a rollup: how many todos the list has. Callers ask for it with `load: ["todoCount"]`.

## The todo

`src/domain/todo/todo.mesh.mx`, the same file the [quick start](./quick-start.md) wrote:

```mx "src/domain/todo/todo.mesh.mx"
import { List } from "./list.mesh.mx"

entity :Todo table="todos"
  attributes
    uuid :id primary-key
    string :title min=1
    boolean :done default=false
    timestamp :insertedAt on=:create
    timestamp :updatedAt on=:update

  relationships
    belongs-to :list entity=List

  computed
    string :label() {
      return (&done ? "[x] " : "[ ] ") + &title
    }

  actions auto=[:read, :destroy]
    create :create
      input
        &title
        &list

    update :complete
      validate
        check :notDoneYet [
          that=() => !&done
          code="already_done"
          message="this todo is already complete"
        ]
      do
        set
          &done=true

    update :rename
      input
        &title

    read :pending
      filter=() => &done === false
      sort
        asc &insertedAt

  policies
    policy :owner types=[:create, :read, :update, :destroy]
      authorize-if=({ actor }) => &list.ownerId === actor.id
```

What this gives you:

- **`&list` takes the related list's id.** The imported `List` is the destination of `belongs-to :list entity=List`. The relationship reads that list, and `todo.list` is there when you ask for it.
- **`min=1` is the whole of "a todo needs a title"**, and it is checked twice: the input validator refuses it before the call, and the column refuses it.
- **`check :notDoneYet` is about state, not about one field**, which is what a `check` is for. It runs on the record with the caller's input applied, so it fails with the message you wrote before anything is written.
- **`complete` accepts nothing.** It takes an id and a context, and its check reads the todo it was given, so Mesh reads that row, locked, and writes it in the same transaction rather than running one blind `UPDATE`. Two callers completing the same todo cannot both win on a stale copy. `rename`, which has no check, is the one that runs as a single `UPDATE`.
- **`pending` is a query, not a filter you remember to apply.** The filter runs in SQL, combined with whatever the caller passed.
- **`label` is computed, not stored.** It concatenates a string, so Mesh cannot run it in SQL and computes it after the rows load. Ask for it by name, or the property does not exist on the result.

## The action context

`src/context.ts`. Every action takes the caller's context as its second argument. Mesh does not decide what a caller is; you declare the type once, and every generated function is typed from it.

```ts "src/context.ts"
import "@meshfw/runtime";

declare module "@meshfw/runtime" {
  interface ActionContext {
    actor: { id: string };
  }
}

export const alice = { id: "00000000-0000-4000-8000-000000000001" };
export const bob = { id: "00000000-0000-4000-8000-000000000002" };
```

The two ids are UUIDs because `ownerId` has type `uuid`. An application with signed-in users would declare its own user type here, plus whatever else its calls need, and nothing else in the project changes.

## The program

`src/main.ts`:

```ts "src/main.ts"
import { InvalidInputError, NotFoundError } from "@meshfw/runtime";
import {
  connect,
  disconnect,
  createList,
  createTodo,
  completeTodo,
  pendingTodo,
} from "#mesh";
import { alice, bob } from "./context";

await connect();

const list = await createList({ name: "Groceries" }, { actor: alice });

const milk = await createTodo({ title: "Buy milk", list: list.id }, { actor: alice });
await createTodo({ title: "Buy bread", list: list.id }, { actor: alice });
await createTodo({ title: "Buy coffee", list: list.id }, { actor: alice });

await completeTodo({ id: milk.id }, { actor: alice });

for (const todo of await pendingTodo({ load: ["label"] }, { actor: alice })) {
  console.log(todo.label);
}

try {
  await completeTodo({ id: milk.id }, { actor: bob });
} catch (error) {
  if (!(error instanceof NotFoundError)) throw error;
  console.log(error.code);
}

try {
  await createTodo({ title: "", list: list.id }, { actor: alice });
} catch (error) {
  if (!(error instanceof InvalidInputError)) throw error;
  console.log(error.code, error.issues[0]?.code, error.issues[0]?.message);
}

await disconnect();
```

```text
[ ] Buy bread
[ ] Buy coffee
not_found
invalid_input too_short must be at least 1 character
```

An empty title is refused at run time by `string :title min=1`, with Mesh's own code and message — a line rule has nowhere to write a custom one — and the issue points at that line in the `.mesh.mx` file. A `check` of your own fails the same way and carries the label and code you gave it.

Four things to notice:

- **`createList` takes only `name`.** `ownerId` is not in the input type, so a call that sends it does not compile.
- **`load: ["label"]` is what types `todo.label`.** Without it, reading the property is a type error rather than `undefined`.
- **Bob gets `NotFoundError`, not `ForbiddenError`.** The policy reads the stored row, so it becomes a filter on the statement, and a row he may not change does not exist as far as he is concerned. Ask first and you get the reason instead: `canCompleteTodo({ id }, { actor: bob })` returns `{ allowed: false, breakdown }`.
- **The empty title is refused before anything is written**, with Mesh's standard code and message and the position of the line that carries the rule.

## Build and run

```bash
bunx mesh build
bunx mesh db push
bun run src/main.ts
```

Run it twice and the second run reuses `todo.db`, the SQLite file from `mesh.config.ts`. Delete it to start over, or keep the schema through migrations instead of pushing it ([the command line](./configuration.md#migrations)).

## A test

A test binds its own database. Nothing global is connected, no file is touched, and the database lives in memory and disappears with the test.

`test/todo.test.ts`:

```ts "test/todo.test.ts"
import { expect, test } from "bun:test";
import { createSchema, sqlite } from "@meshfw/data-sqlite";
import { InvalidInputError } from "@meshfw/runtime";
import { bind } from "#mesh";
import { alice, bob } from "../src/context";

test("only the owner sees a todo", async () => {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db);
  const todo = bind(db);

  const list = await todo.createList({ name: "Groceries" }, { actor: alice });
  await todo.createTodo({ title: "Buy milk", list: list.id }, { actor: alice });

  const mine = await todo.pendingTodo({ load: ["label"] }, { actor: alice });
  expect(mine.map((row) => row.label)).toEqual(["[ ] Buy milk"]);

  // Bob's read is allowed; the policy is part of the query, so it simply
  // returns the rows he owns, which here are none.
  expect(await todo.pendingTodo({}, { actor: bob })).toEqual([]);

  await db.close();
});

test("a title cannot be empty", async () => {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db);
  const todo = bind(db);

  const list = await todo.createList({ name: "Groceries" }, { actor: alice });

  await expect(
    todo.createTodo({ title: "", list: list.id }, { actor: alice }),
  ).rejects.toBeInstanceOf(InvalidInputError);

  await db.close();
});
```

`bind(dataLayer)` returns every action function with the same names and the same `(input, context)` signatures as the top-level ones, bound to that data layer. Two tests above bind two databases in one process and neither sees the other's rows. `bun test` runs them:

```bash
bun test
```

[Testing](./testing.md) has the rules in full, and the next three are the ones you will meet first:

- **Bind, do not connect.** A test that calls a top-level function without `bind` throws `FrameworkError`, because there is no default binding.
- **The schema must exist on that connection.** `createSchema(db)` creates the emitted tables on the connection you just opened. `mesh db push` runs in another process and cannot reach a private in-memory database.
- **Close what you opened.** `db.close()` is yours to call; `disconnect()` never touches a data layer you passed to `bind`.

## What to build next

- Add a `title` filter to the pending read and sort it by title. [Calling actions](./calling-actions.md) has the filter form.
- Load `todo.list` and `list.todoCount` in one call. [Loading](./calling-actions.md#loading-relationships-and-computed-fields) has the rules.
- Add a `dueOn` date to the todo, and a `sum` of what the list's todos cost. [Computed fields](./entities.md#computed) has both.

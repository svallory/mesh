---
title: "Tutorial: a todo list"
description: "Two entities, a relationship, a validation, a policy, a computed field and a rollup, then a script and a test that use them."
---

# Tutorial: a todo list

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

You will build a small program: lists of todos, where a list belongs to somebody and only that person may read or change its todos. Along the way you will use every idea Mesh has: relationships, validations, steps, policies and computed fields. Then you will run it, and write a test for it.

Start from the project in the [quick start](./quick-start.md), or from a new one:

```bash
bun create meshfw todo-app
cd todo-app
```

## What the program does

- Someone creates a list. The list records who owns it.
- Someone adds a todo to a list they own.
- Someone completes a todo, and asks which todos are still pending.
- Somebody else's todos are invisible to them, and every one of the errors says so.

Two entities, because a todo needs a list and a list needs todos. A single file with a `listId` field would also work; a relationship is what lets you write `self.list.ownerId` in a rule and have Mesh fetch it for you.

## The list

`src/domain/todo/list.mesh.mx`:

```mx "src/domain/todo/list.mesh.mx"
entity #List table="lists"
  attributes
    uuid #id primary-key
    string #name
    uuid #ownerId
    timestamp #insertedAt on="create"
    timestamp #updatedAt on="update"

  relationships
    has-many=Todo #todos

  computed
    count #todoCount of="todos"

  actions auto=["read", "destroy"]
    always types=["create"]
      do
        set
          #ownerId=({ actor }) => actor.id

    create #create accept=["name"]

  policies
    policy #anyoneCreates types=["create"]
      authorize-if=() => true
    policy #owner types=["read", "destroy"]
      authorize-if=({ self, actor }) => self.ownerId === actor.id
```

Four things worth noticing:

- **`accept=["name"]` only.** `ownerId` is not accepted, so no caller can create a list owned by somebody else. The `always` block sets it from the caller's `actor` on every create.
- **The two policies are separate.** `types=["read", "destroy"]` means "read or destroy", which is one policy for two actions. Two policies are "and": every policy covering an action must pass.
- **Nobody without a policy is allowed.** `create` has a policy that allows everyone; `read` and `destroy` have a policy that requires ownership.
- **`count #todoCount`** is a rollup: how many todos the list has. You ask for it with `load: ["todoCount"]`.

## The todo

`src/domain/todo/todo.mesh.mx`:

```mx "src/domain/todo/todo.mesh.mx"
entity #Todo table="todos"
  attributes
    uuid #id primary-key
    string #title
    boolean #done default=false
    timestamp #insertedAt on="create"
    timestamp #updatedAt on="update"

  relationships
    belongs-to=List #list

  computed
    string #label({ self }) {
      return (self.done ? "[x] " : "[ ] ") + self.title
    }

  actions auto=["read", "destroy"]
    create #create accept=["title", "listId"]
      validate
        check :titleNotEmpty [
          that=({ self }) => self.title.length > 0
          code="empty_title"
          message="title must not be empty"
        ]

    update #complete
      do
        set
          #done=true

    update #rename accept=["title"]

    read #pending
      filter=({ self }) => self.done === false
      sort=["insertedAt"]

  policies
    policy #owner types=["create", "read", "update", "destroy"]
      authorize-if=({ self, actor }) => self.list.ownerId === actor.id
```

What this gives you:

- **`listId` was not declared.** `belongs-to="list"` adds the foreign-key attribute and the relationship that reads it. `todo.list` is there when you ask for it.
- **The input is validated before anything is written**, and the failure carries the message and the code you wrote.
- **A filter is part of the read, not a filter you remember to apply.** It runs in SQL, combined with whatever the caller passed.
- **`label` is computed, not stored.** It is opaque: it concatenates a string, so it cannot run in SQL. Ask for it by name, or the property does not exist on the result.

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

const milk = await createTodo({ title: "Buy milk", listId: list.id }, { actor: alice });
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
  console.log(error.code);
}

try {
  await createTodo({ title: "", listId: list.id }, { actor: alice });
} catch (error) {
  if (!(error instanceof InvalidInputError)) throw error;
  console.log(error.issues.map((issue) => issue.message).join("; "));
}

await disconnect();
```

```
[ ] Buy bread
[ ] Buy coffee
not_found
title must not be empty
```

Four things to notice:

- **`createList` takes only `name`.** `ownerId` is not in the input type, so a call that sends it does not compile.
- **`load: ["label"]` is what types `todo.label`.** Without it, reading the property is a type error rather than `undefined`.
- **Bob gets `NotFoundError`, not `ForbiddenError`.** The policy reads the stored row, so it becomes a filter on the statement, and a row he may not change does not exist as far as he is concerned. Ask first and you get the reason instead: `canCompleteTodo({ id }, { actor: bob })` returns `{ allowed: false, breakdown }`.
- **The empty title is caught before anything is written.** The error's code is `invalid_input`; each of its issues carries the name you gave the check (`titleNotEmpty`), the code you declared (`empty_title`), your message, and the line of the `check` in the `.mesh.mx` file.

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
  await todo.createTodo({ title: "Buy milk", listId: list.id }, { actor: alice });

  const mine = await todo.pendingTodo({ load: ["label"] }, { actor: alice });
  expect(mine.map((row) => row.label)).toEqual(["[ ] Buy milk"]);

  const his = await todo.canPendingTodo({}, { actor: bob });
  expect(his.allowed).toBe(false);

  await db.close();
});

test("a title cannot be empty", async () => {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db);
  const todo = bind(db);

  const list = await todo.createList({ name: "Groceries" }, { actor: alice });

  expect(
    todo.createTodo({ title: "", listId: list.id }, { actor: alice }),
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
- Read the entity's declarations one by one. [Entities](./entities.md) is the reference.
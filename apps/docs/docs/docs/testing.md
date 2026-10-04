---
title: "Testing"
description: "Bind a real database in memory, call actions, and assert on what came back."
---

# Testing

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

A Mesh test calls the same functions your program calls, against a real SQL database that lives in memory for the length of the test. There is no fake repository, no stubbed adapter and no interface to reimplement, so a test can pass while the database would have refused the query.

This page assumes the tutorial's `todo.mx` and `list.mx`.

## Bind, do not connect

Your application calls `connect()` once at start-up. A test does not: it binds its own data layer, and `bind()` returns every action function with the same names and the same `(input, context)` signatures, bound to that data layer.

```ts "test/todo.test.ts"
import { expect, test } from "bun:test";
import { pushSQLiteSchema, sqlite } from "@mesh/data-sqlite";
import { bind } from "#mesh";
import { alice } from "../src/context";

test("a new todo starts pending", async () => {
  const db = sqlite({ file: ":memory:" });
  await pushSQLiteSchema(db);
  const todo = bind(db);

  const list = await todo.createList({ name: "Groceries" }, { actor: alice });
  const milk = await todo.createTodo({ title: "Buy milk", listId: list.id }, { actor: alice });

  expect(milk.done).toBe(false);
  expect(milk.insertedAt).toBeInstanceOf(Date);

  await db.close();
});
```

Three lines of setup, and they are always the same three:

| Line | Why |
|:--|:--|
| `sqlite({ file: ":memory:" })` | A private database. Two tests in the same file, and two test files, never see each other's rows |
| `await pushSQLiteSchema(db)` | Creates the tables on **this** connection. `mesh db push` runs in another process and cannot reach a private in-memory database |
| `bind(db)` | The action functions bound to it. `connect()` is not used, so nothing global changes and tests can run in parallel |

You own the data layer you pass to `bind`, so you close it. `disconnect()` never touches one.

## What to assert

Actions return the record, or an array of records, typed from the entity file. A test reads the same type your program does.

```ts "test/todo.test.ts"
import { expect, test } from "bun:test";
import { pushSQLiteSchema, sqlite } from "@mesh/data-sqlite";
import { bind } from "#mesh";
import { alice } from "../src/context";

test("completing a todo takes it out of the pending list", async () => {
  const db = sqlite({ file: ":memory:" });
  await pushSQLiteSchema(db);
  const todo = bind(db);

  const list = await todo.createList({ name: "Groceries" }, { actor: alice });
  const milk = await todo.createTodo({ title: "Buy milk", listId: list.id }, { actor: alice });
  await todo.createTodo({ title: "Buy bread", listId: list.id }, { actor: alice });

  await todo.completeTodo({ id: milk.id }, { actor: alice });

  const pending = await todo.pendingTodo({ load: ["label"] }, { actor: alice });
  expect(pending.map((row) => row.title)).toEqual(["Buy bread"]);
  expect(pending[0]?.label).toBe("[ ] Buy bread");

  await db.close();
});
```

`load: ["label"]` is what puts `label` on the type. Without it, reading it does not compile — which is the point: the test cannot read a value the query did not ask for.

## Asserting a rejection

Actions throw. Narrow the caught error before reading it, then assert on the class and on the message you wrote in the entity file.

```ts "test/todo.test.ts"
import { expect, test } from "bun:test";
import { pushSQLiteSchema, sqlite } from "@mesh/data-sqlite";
import { InvalidInputError } from "@mesh/runtime";
import { bind } from "#mesh";
import { alice } from "../src/context";

test("an empty title is rejected", async () => {
  const db = sqlite({ file: ":memory:" });
  await pushSQLiteSchema(db);
  const todo = bind(db);

  const list = await todo.createList({ name: "Groceries" }, { actor: alice });

  const call = todo.createTodo({ title: "", listId: list.id }, { actor: alice });
  await expect(call).rejects.toBeInstanceOf(InvalidInputError);

  await db.close();
});
```

If you care which rule failed, catch the error and read `issues`, which carries the message and the `.mx` position of the `validate` tag that declared it. See [Errors](./calling-actions.md#errors).

## Asserting a denial

An action with no matching policy is forbidden, and a record-reading policy folds into the statement, so a row the caller may not change is reported as not found. Assert on `can`, which is data, rather than on which of the two error classes a call produced.

```ts "test/todo.test.ts"
import { expect, test } from "bun:test";
import { pushSQLiteSchema, sqlite } from "@mesh/data-sqlite";
import { bind } from "#mesh";
import { alice, bob } from "../src/context";

test("another actor may not complete a todo", async () => {
  const db = sqlite({ file: ":memory:" });
  await pushSQLiteSchema(db);
  const todo = bind(db);

  const list = await todo.createList({ name: "Groceries" }, { actor: alice });
  const milk = await todo.createTodo({ title: "Buy milk", listId: list.id }, { actor: alice });

  const answer = await todo.canCompleteTodo({ id: milk.id }, { actor: bob });
  expect(answer.allowed).toBe(false);
  expect(answer.breakdown.length).toBeGreaterThan(0);

  await db.close();
});
```

## Keeping the generated code honest

Generated code is ordinary TypeScript, so `tsc --noEmit` reads it, and a change to an entity file that you did not rebuild is a type error somewhere else. Add the guard to the same script as the tests, so a stale `.mesh/` fails before a single test runs:

```json
"scripts": { "test": "bunx mesh build --check && bun test" }
```

Then `bun run test` is the whole check: the generated tree is what the entity files say it should be, and every test runs against a real database.

## Next

- [Calling actions](./calling-actions.md) — `can`, `load` and the error classes in full.
- [Configuration and the command line](./configuration.md) — the guard and the commands.
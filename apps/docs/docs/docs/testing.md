---
title: "Testing"
description: "Bind a real database in memory, call actions, and assert on what came back."
---

# Testing

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

A Mesh test calls the same entities your program calls, against a real SQL database that lives in memory for the length of the test. There is no fake repository, no stubbed adapter and no interface to reimplement, so a test can pass while the database would have refused the query.

This page assumes the tutorial's `todo.mesh.mx` and `list.mesh.mx`.

## Bind, do not connect

Your application calls `connect()` once at start-up. A test does not: it binds its own data layer, and `bind()` returns a binding of your whole domain to that data layer. The binding has two methods, `run` and `transaction`. Inside `run(fn)`, every call to an entity you imported (`Todo.create(input, context)`) and every `Mesh.privileged` read goes to that binding's data layer, so the test calls exactly what the program calls.

```ts "test/todo.test.ts"
import { expect, test } from "bun:test";
import { createSchema, sqlite } from "@meshfw/data-sqlite";
import { bind, tables } from "#mesh";
import { List, Todo } from "#mesh/domain/todo";
import { alice } from "../src/context";

test("a new todo starts pending", async () => {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, tables);
  const app = bind(db);

  await app.run(async () => {
    const list = await List.create({ name: "Groceries" }, { actor: alice });
    const milk = await Todo.create({ title: "Buy milk", list: list.id }, { actor: alice });

    expect(milk.done).toBe(false);
    expect(milk.insertedAt).toBeInstanceOf(Date);
  });

  await db.close();
});
```

Three lines of setup, and they are always the same three:

| Line | Why |
|:--|:--|
| `sqlite({ file: ":memory:" })` | A private database. Two tests in the same file, and two test files, never see each other's rows |
| `await createSchema(db, tables)` | Creates the tables of the generated schema on **this** connection. `mesh db push` runs in another process and cannot reach a private in-memory database |
| `bind(db)` | The binding of the domain to it. `connect()` is not used, so nothing global changes and tests can run in parallel: each `run` has its own scope, so two tests in one process never see each other's data layer |

You own the data layer you pass to `bind`, so you close it. `disconnect()` never touches one. `bind` also takes a clock (`%.now` in your entity files reads it, once per transaction) and the `seams` a test wants to watch: `bind(db, { clock, seams })`.

A call made outside `run` and `transaction` goes to the data layer `connect()` opened. A test never connects, so a call it makes outside `run` throws the `FrameworkError` an unconnected program gets, instead of writing to some other database.

`app.transaction(fn)` is `run` with one transaction around everything inside: the calls join it, `afterCommit` runs once when it commits, and a throw rolls all of them back. Like `transaction`, it hands `fn` nothing and takes no context.

## What to assert

Actions return the record, or an array of records, typed from the entity file. A test reads the same type your program does.

```ts "test/todo.test.ts"
import { expect, test } from "bun:test";
import { createSchema, sqlite } from "@meshfw/data-sqlite";
import { bind, tables } from "#mesh";
import { List, Todo } from "#mesh/domain/todo";
import { alice } from "../src/context";

test("completing a todo takes it out of the pending list", async () => {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, tables);
  const app = bind(db);

  await app.run(async () => {
    const list = await List.create({ name: "Groceries" }, { actor: alice });
    const milk = await Todo.create({ title: "Buy milk", list: list.id }, { actor: alice });
    await Todo.create({ title: "Buy bread", list: list.id }, { actor: alice });

    await Todo.complete({ id: milk.id }, { actor: alice });

    const pending = await Todo.pending({ load: ["label"] }, { actor: alice });
    expect(pending.map((row) => row.title)).toEqual(["Buy bread"]);
    expect(pending[0]?.label).toBe("[ ] Buy bread");
  });

  await db.close();
});
```

`load: ["label"]` is what puts `label` on the type. Without it, reading it does not compile — which is the point: the test cannot read a value the query did not ask for.

## Asserting a rejection

Actions throw. Narrow the caught error before reading it, then assert on the class and on the message you wrote in the entity file.

```ts "test/todo.test.ts"
import { expect, test } from "bun:test";
import { createSchema, sqlite } from "@meshfw/data-sqlite";
import { InvalidInputError } from "@meshfw/runtime";
import { bind, tables } from "#mesh";
import { List, Todo } from "#mesh/domain/todo";
import { alice } from "../src/context";

test("a todo must have a title, and must not be completed twice", async () => {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, tables);
  const app = bind(db);

  await app.run(async () => {
    const list = await List.create({ name: "Groceries" }, { actor: alice });
    const milk = await Todo.create({ title: "Buy milk", list: list.id }, { actor: alice });

    await expect(Todo.create({ title: "", list: list.id }, { actor: alice }))
      .rejects.toBeInstanceOf(InvalidInputError);
    await expect(Todo.complete({ id: milk.id }, { actor: alice })).resolves.toBeTruthy();
    await expect(Todo.complete({ id: milk.id }, { actor: alice }))
      .rejects.toBeInstanceOf(InvalidInputError);
  });

  await db.close();
});
```

Await the assertion. A promise you do not await can settle after the test is over, and the database can be closed while the call is still running.

If you care which rule failed, catch the error and read `issues`. Each entry names the `check` that declared it, the code that check declared, its message, and the line of the `.mesh.mx` file it is on. See [Errors](./using-your-domain.md#errors).

A rule written on an attribute line, such as `string :title min=1`, fails the same way: the error's code is `invalid_input` and the issue points at that line. There is no label for it, because only a `check` carries a label; the issue's `path` names the field..

## Asserting on what another actor may see

An action that no policy covers is forbidden, and a policy that reads the stored row becomes part of the query, so a row the caller may not change is reported as not found. For a read, the same policy simply narrows the result: the call succeeds and returns fewer rows.

```ts "test/todo.test.ts"
import { expect, test } from "bun:test";
import { createSchema, sqlite } from "@meshfw/data-sqlite";
import { NotFoundError } from "@meshfw/runtime";
import { bind, tables } from "#mesh";
import { List, Todo } from "#mesh/domain/todo";
import { alice, bob } from "../src/context";

test("another actor sees no todos and may not complete one", async () => {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, tables);
  const app = bind(db);

  await app.run(async () => {
    const list = await List.create({ name: "Groceries" }, { actor: alice });
    const milk = await Todo.create({ title: "Buy milk", list: list.id }, { actor: alice });

    expect(await Todo.pending({}, { actor: bob })).toEqual([]);
    await expect(Todo.complete({ id: milk.id }, { actor: bob }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  await db.close();
});
```

For a write, `Mesh.checkPolicies` is the better thing to assert on, because it is data rather than an error class:

```ts "test/todo.test.ts"
import { expect, test } from "bun:test";
import { createSchema, sqlite } from "@meshfw/data-sqlite";
import { Mesh } from "meshfw";
import { bind, tables } from "#mesh";
import { List, Todo } from "#mesh/domain/todo";
import { alice, bob } from "../src/context";

test("another actor may not complete a todo", async () => {
  const db = sqlite({ file: ":memory:" });
  await createSchema(db, tables);
  const app = bind(db);

  await app.run(async () => {
    const list = await List.create({ name: "Groceries" }, { actor: alice });
    const milk = await Todo.create({ title: "Buy milk", list: list.id }, { actor: alice });

    const answer = await Mesh.checkPolicies(Todo.complete, { id: milk.id }, { actor: bob });
    expect(answer.allowed).toBe(false);
    expect(answer.breakdown[0]?.decisive).toBe(true);
    expect(await Mesh.can(Todo.complete, { id: milk.id }, { actor: bob })).toBe(false);
  });

  await db.close();
});
```

## Keeping the generated code honest

Generated code is ordinary TypeScript, so `tsc --noEmit` reads it, and a change to an entity file that you did not rebuild is a type error somewhere else. Add the guard to the same script as the tests, so a stale `.mesh/` fails before a single test runs:

```json
"scripts": { "test": "mesh build --check && bun test" }
```

Then `bun run test` is the whole check: the generated tree is what the entity files say it should be, and every test runs against a real database.

## Next

- [Using your domain](./using-your-domain.md) — `Mesh.can`, `load` and the error classes in full.
- [Command line](./command-line.md) — the guard and the commands.
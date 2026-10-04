---
title: "Calling actions"
description: "The generated function signatures, the scope argument, filters and load, the error classes and can."
---

# Calling actions

::: callout warning "Live spec, not released"
This page describes how Mesh **will** work, not how it works today. It is a live spec of the developer experience, written before the code. Mesh is not released: nothing here can be installed or run yet, and any detail may change.
:::

An action is one named operation on a resource. In v1 an action is a generated TypeScript function, and calling that function is the whole interface: there is no server, no route, no request object ([ADR-0005](../architecture/decisions/0005-core-interface-is-a-function-call.md)). A CLI, a daemon, a queue worker and a web handler call the same functions.

## Connect first

These examples use the resources and `src/actor.ts` from [the todo example](./example-todo-list.md), after `mesh build` and `mesh db push`. Each program block is a separate replacement for `src/main.ts`, not code to concatenate.

`generated/index.ts` exports `bind(dataLayer)`, `connect(options)` and `disconnect()`. `bind` returns every action function of every resource, bound to the supplied data layer, with the same names and `(input, scope)` signatures as the top-level exports. `connect` builds the data layer from the adapter configured in `mesh.config.ts` and stores `bind(thatDataLayer)` as the module's default binding. Top-level actions delegate to that default binding ([ADR-0047](../architecture/decisions/0047-actions-are-bound-to-a-data-layer.md)).

An application connects once at start-up. With the SQLite adapter:

```ts "src/main.ts"
import { connect, disconnect } from "../generated";

await connect({ file: "todo.db" });
await disconnect();
```

With the Postgres adapter instead:

```ts "src/main.ts"
import { connect, disconnect } from "../generated";

await connect({ url: process.env.DATABASE_URL });
await disconnect();
```

For Postgres, `DATABASE_URL` has no default: if it is undefined, `connect` throws. The SQLite form is what the [todo example](./example-todo-list.md) uses, because it needs no server. Call `disconnect()` when the program ends.

Calling an action before `connect` throws `FrameworkError`. It is a programming mistake, not a caller mistake, so it is a framework error rather than a validation failure.

### Bind a database in a test

A test does not need the default binding. This fragment shows the binding and call; `input` and `scope` are supplied by the test:

```ts
import { sqlite } from "@mesh/data-sqlite";
import { bind } from "../generated";

const t = bind(sqlite({ file: ":memory:" }));
// Prepare the emitted schema on this connection before calling an action.
await t.createTodo(input, scope);
```

Two bindings to two databases can live in one process. `bind` does not create tables: prepare the emitted schema on the same connection with the adapter's test/development function ([ADR-0048](../architecture/decisions/0048-schema-inside-the-process-for-tests.md)). Its public spelling is defined by the adapter implementation. A CLI in another process cannot prepare this private in-memory database.

**Lifecycle and argument boundary** (roadmap author, 2026-10-04; the lead may overrule): `bind` takes a ready object implementing the run-time `DataLayer` contract of `@mesh/runtime` (`transaction` and `close`), not a configuration descriptor. `sqlite(options)` returns that object and opens its connection on first use; `bind` itself opens nothing and creates no table. Calling `connect` while a default binding exists throws `FrameworkError`, never silently replacing or reusing the connection. `disconnect()` closes the default data layer and clears the binding, so a top-level action afterwards throws the same `FrameworkError` as before `connect`. You may connect again after disconnecting; disconnecting without a default binding does nothing. You own a data layer you pass to `bind` and close it with its `close()` method; `disconnect()` never touches it ([ADR-0047](../architecture/decisions/0047-actions-are-bound-to-a-data-layer.md)).

The data layer never goes in the scope; `{ actor, context }` stays a required plain argument on every call.

## Signatures

Every action has the same shape: `(input, scope)`, and both arguments are required. A call with one argument is a type error.

| Action type | Function | `input` | Returns |
|---|---|---|---|
| create | `createTodo(input, scope)` | the accepted attributes | `Todo` |
| read | `readTodo(input, scope)` | `{ filter?, sort?, limit?, offset?, load? }` | `Todo[]` |
| read, named `pending` | `pendingTodo(input, scope)` | the same | `Todo[]` |
| update | `completeTodo(input, scope)` | `{ id, ...accepted }` | `Todo` |
| destroy | `destroyTodo(input, scope)` | `{ id, ...accepted }`, where `accepted` is empty unless the action accepts attributes | `void` |

**The name** is the action's name followed by the resource's name in PascalCase: `createTodo`, `completeTodo`, `pendingTodo`, `readTodo`. An action asked for by `defaults` is named after its type, so the default read is `readTodo` and the default destroy is `destroyTodo`.

A read returns an array even when a filter can match one row. There is no `get` and no "read one" variant in v1; a read with `limit: 1` returns an array of zero or one.

::: callout info "Not decided yet"
Reading `<action><Resource>` aloud is awkward for a named read (`pendingTodo`), and `readTodo` returning an array reads like the singular. The roadmap fixes only that the function is one per action and takes `(input, scope)`; the naming rule used here is a proposal. [The roadmap](../architecture/roadmap/roadmap.md), M2.
:::

## The scope

The second argument says who is calling. `@mesh/runtime` declares `Scope` with the shape `{ actor: Register["actor"]; context?: Record<string, unknown> }`; import it rather than declaring your own:

```ts
import type { Scope } from "@mesh/runtime";
import { alice } from "./actor";

export const scope: Scope = { actor: alice };
```

`actor` is your application's type. You register it once, in your own code, by module augmentation:

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

Every `scope.actor` is then typed as `{ id: string }`. An application with anonymous callers registers `User | null`.

`context` carries anything else the call needs. It is never read by Mesh core; it is there so your own changes, validations and policy checks can reach per-call data.

The scope is always explicit and never ambient. That is deliberate: Ash removed its ambient actor in 3.0 because of subtle bugs it could not explain, and Mesh does not repeat it ([ADR-0007](../architecture/decisions/0007-scope-is-a-plain-argument.md)). In a test, this is what makes "log in as somebody else" one argument:

```ts "src/main.ts"
import { connect, disconnect, createList, createTodo } from "../generated";
import { alice, bob } from "./actor";

await connect({ file: "todo.db" });
const aliceList = await createList({ name: "Alice's errands" }, { actor: alice });
const bobList = await createList({ name: "Bob's errands" }, { actor: bob });
await createTodo({ title: "Buy milk", listId: aliceList.id }, { actor: alice });
await createTodo({ title: "Buy milk", listId: bobList.id }, { actor: bob });
await disconnect();
```

A call without a scope is a type error, checked when you type-check the project.

::: callout info "Not decided yet"
Where a tenant lives. It is not in the actor and not in the scope as a Mesh concept. [ADR-0009](../architecture/decisions/0009-tenancy-placement.md) is Proposed: core or an extension. Until it is decided, put a tenant in `scope.context` and read it from there.
:::

## Inputs

**Create** takes exactly the attributes in `accept`. `ownerId` on the list is not accepted, because the change fills it. An attribute that is not accepted and not filled by a change is a build error, not a run-time surprise.

**Update** takes `{ id, ...accepted }`. The id is separate from the accepted attributes, so `completeTodo({ id: todo.id })` reads well even though the action accepts nothing.

**Destroy** takes `{ id }` and returns `void`. A destroy that accepts attributes takes them too, after the id and all optional, which is how a soft destroy carries the reason. If you need the row back, read it first.

An unknown field is an error, never dropped. A value of the wrong type is an error too: generated validators are Zod schemas, seen by the rest of Mesh only through Standard Schema ([ADR-0028](../architecture/decisions/0028-validation-zod-behind-standard-schema.md)). An attribute whose type has constraints, such as an `atom` with `one_of`, is checked against them.

## Filters, sort and paging on a read

A caller's filter is plain data: an attribute name, an operator and a literal.

```ts "src/main.ts"
import { connect, disconnect, createList, readTodo } from "../generated";
import { alice } from "./actor";

await connect({ file: "todo.db" });
const list = await createList({ name: "Groceries" }, { actor: alice });
const mine = await readTodo({ filter: { listId: { eq: list.id } } }, { actor: alice });
console.log(mine);
await disconnect();
```

Operators: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `isNil`. Fields combine with `and` and `or`. A filter is a value, not a string, so a typo in an attribute name is a type error.

```ts "src/main.ts"
import { connect, disconnect, readTodo } from "../generated";
import { alice } from "./actor";

await connect({ file: "todo.db" });
const page = await readTodo(
  { filter: { done: { eq: false } }, sort: ["-insertedAt"], limit: 20, offset: 0 },
  { actor: alice },
);
console.log(page);
await disconnect();
```

`sort` uses the same strings as the `sort` tag in a resource file: no prefix is ascending, `-` is descending.

::: callout info "Not decided yet"
The resource-side `sort` tag stays only until M3/M5 decides between it and Ash's `prepare build(sort: ...)` form ([vocabulary mapping](../architecture/roadmap/vocabulary-mapping.md), D17/G1). The caller's `sort` array above is this spec's proposal, not a settled query API.
:::

## Loading relationships, calculations and aggregates

Anything derived is computed only when you name it in `load`:

```ts "src/main.ts"
import { connect, disconnect, readTodo } from "../generated";
import { alice } from "./actor";

await connect({ file: "todo.db" });
const todos = await readTodo({ load: ["label"] }, { actor: alice });
for (const todo of todos) console.log(todo.label); // typed, even if the array is empty
await disconnect();
```

`load` also takes relationships (`load: ["list"]`) and aggregates (`load: ["todoCount"]` on a list).

Reading one that was not loaded is a **type error**, not `undefined`. A `load` that cannot be done at run time is an error, never silently skipped.

An **opaque** calculation, such as the `label` in the example, runs in memory after the rows are loaded, so it costs one extra pass and cannot be used in a filter. A translatable one runs in the query. Which is which is fixed at build time by [the expressions page](../architecture/in-depth/expressions.md).

## Errors

Every action throws on failure. All of Mesh's errors extend `MeshError` and carry a `code`:

| Class | `code` | Thrown when |
|---|---|---|
| `InvalidInputError` | `invalid_input` | The input does not fit, or a `validate` tag failed |
| `NotFoundError` | `not_found` | The row the call names does not exist, or is not visible to this actor |
| `ForbiddenError` | `forbidden` | A policy denied the call, with a `breakdown` of every check |
| `FrameworkError` | `framework` | A Mesh or configuration mistake: calling before `connect`, a load that cannot be done |

They all come from `@mesh/runtime`.

`InvalidInputError.issues` holds the collected validation failures. Narrow a caught error before reading its properties; a catch variable has type `unknown` in strict TypeScript.

```ts "src/main.ts"
import { InvalidInputError } from "@mesh/runtime";
import { connect, disconnect, createList, createTodo } from "../generated";
import { alice } from "./actor";

await connect({ file: "todo.db" });
try {
  const list = await createList({ name: "Groceries" }, { actor: alice });
  await createTodo({ title: "", listId: list.id }, { actor: alice });
} catch (error) {
  if (!(error instanceof InvalidInputError)) throw error;
  for (const issue of error.issues) {
    console.log(issue.path, issue.message, issue.source);
  }
} finally {
  await disconnect();
}
```

For this declared validation, an issue has `path: ["title"]`, `message: "title must not be empty"` and a proposed `source` of `{ file: "resources/todo.mx", line: 14, column: 7 }`. A structural input failure, such as a value that is not a UUID, need not have a declared-rule source.

Each issue names the path in the input, a message, and, when the failure came from a rule you declared, the `.mx` position that declared it. Line and column are 1-based, the same as the build's diagnostics.

`ForbiddenError` carries a `breakdown`: every policy that applied, every check inside it, and which one was decisive. It is data, so a test can assert on it.

::: callout info "Not decided yet"
How a run-time error carries a `.mx` position. Mesh's working assumption is that the generated code carries file, line and column as data, not through source maps; Bun's `findSourceMap` returns `undefined`, which is the argument recorded against source maps. [ADR-0039](../architecture/decisions/0039-run-time-error-positions.md) is Proposed.
:::

::: callout info "Not decided yet"
What a denied write reports on an atomic action. Mesh's working assumption folds a record-reading policy into the statement, so a row the caller may not change reports **not found**; Ash compiles the same check and reports forbidden. On a non-atomic action (`require-atomic=false`) the check runs in memory and a denial is reported as forbidden with the breakdown. [ADR-0046](../architecture/decisions/0046-denied-atomic-write-outcome.md) records the asymmetry, and the operator may overrule it.
:::

## Asking instead of calling: `can`

Every action has a `can` function that answers the question without changing anything:

```ts "src/main.ts"
import { connect, disconnect, createList, createTodo, canCompleteTodo } from "../generated";
import { alice, bob } from "./actor";

await connect({ file: "todo.db" });
const list = await createList({ name: "Groceries" }, { actor: alice });
const todo = await createTodo({ title: "Buy milk", listId: list.id }, { actor: alice });
const answer = await canCompleteTodo({ id: todo.id }, { actor: bob });
console.log(answer.allowed); // false
console.log(answer.breakdown); // every check, and which one decided
await disconnect();
```

`can` returns `{ allowed: boolean; breakdown }`. It is the supported way to explain a denial: the decision is compared, not the error class, so a change in the policy engine does not break your test.

::: callout info "Not decided yet"
Grouping several action calls in one transaction. Each call is its own transaction in v1, and there is no designed way to say "these three calls commit together or not at all".
:::

## Next

- [Command-line tool](./command-line.md) — `explain`, which prints the plan a call will follow.
- [Usage](./usage.md) — the build-and-call loop.
- [Example: a todo list](./example-todo-list.md) — these signatures in a complete program.
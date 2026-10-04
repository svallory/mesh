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

Generated handlers reach the database through module state, so a program connects once at start-up:

```ts
import { connect, disconnect } from "./generated";

await connect({ file: "todo.db" });              // SQLite
await connect({ url: process.env.DATABASE_URL }); // Postgres
```

For Postgres, `DATABASE_URL` has no default: if it is undefined, `connect` throws. The SQLite form is what the [todo example](./example-todo-list.md) uses, because it needs no server. Call `disconnect()` when the program ends.

Calling an action before `connect` throws `FrameworkError`. It is a programming mistake, not a caller mistake, so it is a framework error rather than a validation failure.

::: callout info "Not decided yet"
How a generated handler gets its connection is not designed. `connect()` is the only arrangement that fits `createPost(input, scope)`, but it puts the connection in module state while the scope is an explicit argument ([ADR-0007](../architecture/decisions/0007-scope-is-a-plain-argument.md)), and it makes running the same test against two databases awkward. See *DX findings* in the task report for the options a design has to choose between.
:::

## Signatures

Every action has the same shape: `(input, scope)`, and both arguments are required. A call with one argument is a type error.

| Action type | Function | `input` | Returns |
|---|---|---|---|
| create | `createTodo(input, scope)` | the accepted attributes | `Todo` |
| read | `readTodo(input, scope)` | `{ filter?, sort?, limit?, offset?, load? }` | `Todo[]` |
| read, named `pending` | `pendingTodo(input, scope)` | the same | `Todo[]` |
| update | `completeTodo(input, scope)` | `{ id, ...accepted }` | `Todo` |
| destroy | `destroyTodo(input, scope)` | `{ id }` | `void` |

**The name** is the action's name followed by the resource's name in PascalCase: `createTodo`, `completeTodo`, `pendingTodo`, `readTodo`. An action asked for by `defaults` is named after its type, so the default read is `readTodo` and the default destroy is `destroyTodo`.

A read returns an array even when a filter can match one row. There is no `get` and no "read one" variant in v1; a read with `limit: 1` returns an array of zero or one.

::: callout info "Not decided yet"
Reading `<action><Resource>` aloud is awkward for a named read (`pendingTodo`), and `readTodo` returning an array reads like the singular. The roadmap fixes only that the function is one per action and takes `(input, scope)`; the naming rule used here is a proposal. [The roadmap](../architecture/roadmap/roadmap.md), M2.
:::

## The scope

The second argument says who is calling:

```ts
type Scope = {
  actor: Actor;
  context?: Record<string, unknown>;
};
```

`actor` is your application's type. You register it once, in your own code, by module augmentation:

```ts
declare module "@mesh/runtime" {
  interface Register {
    actor: { id: string };
  }
}
```

Every `scope.actor` is then typed as `{ id: string }`. An application with anonymous callers registers `User | null`.

`context` carries anything else the call needs. It is never read by Mesh core; it is there so your own changes, validations and policy checks can reach request-scoped data.

The scope is always explicit and never ambient. That is deliberate: Ash removed its ambient actor in 3.0 because of subtle bugs it could not explain, and Mesh does not repeat it ([ADR-0007](../architecture/decisions/0007-scope-is-a-plain-argument.md)). In a test, this is what makes "log in as somebody else" one argument:

```ts
const todo = await createTodo({ title: "Buy milk", listId: list.id }, { actor: alice });
const same = await createTodo({ title: "Buy milk", listId: list.id }, { actor: bob });
```

A call without a scope is a type error, checked when you type-check the project.

::: callout info "Not decided yet"
Where a tenant lives. It is not in the actor and not in the scope as a Mesh concept. [ADR-0009](../architecture/decisions/0009-tenancy-placement.md) is Proposed: core or an extension. Until it is decided, put a tenant in `scope.context` and read it from there.
:::

## Inputs

**Create** takes exactly the attributes in `accept`. `ownerId` on the list is not accepted, because the change fills it. An attribute that is not accepted and not filled by a change is a build error, not a run-time surprise.

**Update** takes `{ id, ...accepted }`. The id is separate from the accepted attributes, so `completeTodo({ id: todo.id })` reads well even though the action accepts nothing.

**Destroy** takes `{ id }` and returns `void`. If you need the row back, read it first.

An unknown field is an error, never dropped. A value of the wrong type is an error too: generated validators are Zod schemas, seen by the rest of Mesh only through Standard Schema ([ADR-0028](../architecture/decisions/0028-validation-zod-behind-standard-schema.md)). An attribute whose type has constraints, such as an `atom` with `one_of`, is checked against them.

## Filters, sort and paging on a read

A caller's filter is plain data: an attribute name, an operator and a literal.

```ts
const mine = await readTodo({ filter: { listId: { eq: list.id } } }, { actor: alice });
```

Operators: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `isNil`. Fields combine with `and` and `or`. A filter is a value, not a string, so a typo in an attribute name is a type error.

```ts
const page = await readTodo(
  { filter: { done: { eq: false } }, sort: ["-insertedAt"], limit: 20, offset: 0 },
  { actor: alice },
);
```

`sort` uses the same strings as the `sort` tag in a resource file: no prefix is ascending, `-` is descending.

## Loading relationships, calculations and aggregates

Anything derived is computed only when you name it in `load`:

```ts
const todos = await readTodo({ load: ["label"] }, { actor: alice });
todos[0].label; // typed
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

`InvalidInputError` collects **every** problem, not the first, so one call tells you everything that is wrong:

```ts
try {
  await createTodo({ title: "", listId: "not-a-uuid" }, { actor: alice });
} catch (error) {
  if (error instanceof InvalidInputError) {
    error.issues;
    // [
    //   { path: ["title"], message: "title must not be empty",
    //     source: { file: "resources/todo.mx", line: 12, column: 5 } },
    //   { path: ["listId"], message: "not a uuid" },
    // ]
  }
}
```

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

```ts
const answer = await canCompleteTodo({ id: todo.id }, { actor: bob });
answer.allowed; // false
answer.breakdown; // every check, and which one decided
```

`can` returns `{ allowed: boolean; breakdown }`. It is the supported way to explain a denial: the decision is compared, not the error class, so a change in the policy engine does not break your test.

::: callout info "Not decided yet"
Grouping several action calls in one transaction. Each call is its own transaction in v1, and there is no designed way to say "these three calls commit together or not at all".
:::

## Next

- [Command-line tool](./command-line.md) — `explain`, which prints the plan a call will follow.
- [Usage](./usage.md) — the build-and-call loop.
- [Example: a todo list](./example-todo-list.md) — these signatures in a complete program.
---
title: "Calling actions"
description: "The generated functions, the action context, filters, sort, paging, load, the error classes and can."
---

# Calling actions

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

An action is one named operation on an entity, and in Mesh it is an ordinary TypeScript function. A command line, a worker, a cron job and an HTTP handler all call the same function with the same two arguments. There is no server, no route and no request object.

Every function has the same shape:

```ts "src/main.ts (excerpt)"
const todo = await createTodo({ title: "Buy milk", listId: list.id }, { actor });
```

**The input, and the action context.** The input is always required. The context is a plain object too, and it is required as soon as your project has declared a required key on it: `@meshfw/runtime` exports an empty `ActionContext` interface, your project adds its keys, and while every key you declare is optional the parameter is optional too. A call with no context at all compiles exactly when a call with one does.

## Connect once

`#mesh` exports `connect()` and `disconnect()`. `connect()` opens the data layer your `mesh.config.ts` configures; there is nothing to pass, and the same configuration drives the build, so the connection and the schema cannot disagree.

```ts "src/main.ts"
import { connect, disconnect } from "#mesh";

await connect();
// ... the program
await disconnect();
```

An application connects once at start-up. Calling an action before `connect`, or after `disconnect`, throws `FrameworkError`: that is a mistake in the program, not a caller's mistake, so it is not reported as a rejected input.

In a test you do not connect at all. You bind a data layer, and every action function comes back bound to it. See [Testing](./testing.md).

## The action context

The second argument says who is calling, and carries whatever else the call needs. It is one flat object, and it is a plain argument on every call rather than a global, which is what makes "run this as somebody else" one line:

```ts "src/main.ts"
import { connect, disconnect, createList, createTodo } from "#mesh";
import { alice, bob } from "./context";

await connect();

const aliceList = await createList({ name: "Alice's errands" }, { actor: alice });
const bobList = await createList({ name: "Bob's errands" }, { actor: bob });

await createTodo({ title: "Buy milk", listId: aliceList.id }, { actor: alice });
await createTodo({ title: "Buy bread", listId: bobList.id }, { actor: bob });

await disconnect();
```

You decide what goes in it. Declare the type once, by adding to Mesh's `ActionContext` interface, and every generated function is typed from that declaration:

```ts "src/context.ts"
import "@meshfw/runtime";

declare module "@meshfw/runtime" {
  interface ActionContext {
    actor: { id: string; role: "admin" | "member" };
    tenantId: string;
    locale?: string;
  }
}

export const alice = { id: "00000000-0000-4000-8000-000000000001", role: "member" as const };
```

There is one key Mesh itself reads: **`actor`**, which is what the `authorize-if` checks in your policies are given. Every other key is yours. A tenant, a locale, a request id: name them, and both your TypeScript and your entity files can use them:

```ts "src/main.ts"
import { connect, disconnect, createList } from "#mesh";
import { alice } from "./context";

await connect();
await createList({ name: "Groceries" }, { actor: alice, tenantId: "t1", locale: "en-GB" });
await disconnect();
```

An extension that needs a key of its own states which one it reads, and two extensions claiming the same key is a build error. Optionality is yours as well: declare `actor: User | null` and anonymous callers type-check. Declare nothing at all and the context is an empty object, and in your rules `actor` is `unknown` — which is Mesh saying it has nothing for you to compare it against.

Inside an entity file, the functions receive four parameters: the record as `self`, the caller's own object as `input`, the caller as `actor`, and everything else the call carries as `context`. `context` is what you declared above, and it does not carry `actor` again — the caller is `actor`, and only `actor`. Here a tenant-scoped policy reads the record's own tenant and the call's:

```mx "src/domain/todo/todo.mesh.mx"
entity :Todo table="todos"
  attributes
    uuid :id primary-key
    string :title
    uuid :tenantId

  policies
    policy :sameTenant types=[:create]
      authorize-if=({ self, context }) => self.tenantId === context.tenantId
```

## Signatures

| Action | Function | Input | Returns |
|:--|:--|:--|:--|
| create | `createTodo(input, context)` | the accepted fields | `Todo` |
| read, from `auto` | `readTodo(input, context)` | `{ filter?, sort?, limit?, offset?, load? }` | `Todo[]` |
| read named `pending` | `pendingTodo(input, context)` | the same | `Todo[]` |
| update | `completeTodo(input, context)` | `{ id, ...accepted }` | `Todo` |
| destroy | `destroyTodo(input, context)` | `{ id }` | `void` |

The name is the action's name followed by the entity's name in PascalCase. An action generated by `auto` is named after its type, so the auto read is `readTodo` and the auto destroy is `destroyTodo`.

**Arguments sit in the same input object as accepted fields.** An action's `arguments` are the values it needs that are not stored as sent, and a caller sends them beside `filter`, `sort` and the rest:

```ts "src/main.ts"
import { connect, disconnect, forCustomerInvoice } from "#mesh";
import { alice } from "./context";

await connect();

for (const invoice of await forCustomerInvoice({ customerId: "…", sort: ["-dueOn"] }, { actor: alice })) {
  console.log(invoice.number);
}

await disconnect();
```

A name that is both an accepted field and an argument is a build error, so there is never a question of which one a key in the input is.

A read returns an array even when the filter can match one row. There is no separate "read one" function: `limit: 1` returns an array of zero or one.

### Create

The input has exactly the fields in `accept`. With the tutorial's `todo.mesh.mx`, `createTodo` takes `title` and `listId`:

```ts "src/main.ts"
import { connect, createList, createTodo, disconnect } from "#mesh";
import { alice } from "./context";

await connect();

const list = await createList({ name: "Groceries" }, { actor: alice });
const todo = await createTodo({ title: "Buy milk", listId: list.id }, { actor: alice });

console.log(todo.id, todo.insertedAt);

await disconnect();
```

Two calls that do not compile, against that `todo.mesh.mx`:

| Call | Why |
|:--|:--|
| `createTodo({ title, listId, done: true }, …)` | `done` is not an accepted field, so it is not on the input type |
| `createTodo({ title: "Buy milk" }, …)` | `listId` is missing, and a create must be sent every accepted field that is required and has no default |

An unknown field is an error at run time, not a field dropped. If a call gets past the type checker anyway, the generated validator rejects it.

### Update

`{ id, ...accepted }`. The id is separate, so an action that accepts nothing still reads well:

```ts "src/main.ts"
import { connect, disconnect, completeTodo } from "#mesh";
import { alice } from "./context";

await connect();

await completeTodo({ id: "00000000-0000-4000-8000-0000000000aa" }, { actor: alice });

await disconnect();
```

**One statement or two.** A create is always one `INSERT`. An update or a destroy is one statement when its checks and `when` conditions read only `input`, `actor` and `context`, and its `set` values translate. A check or a `when` that reads `self` makes the action read the row first, locked, in the same transaction, and then write it. `completeTodo` is in the second case, because `check :notDoneYet` reads `self.done`; `renameTodo`, which has no check, is in the first. `mesh explain` prints which one an action is, so you never get a read-then-write where you expected one statement, or the other way round.

### Destroy

`{ id }`, returning `void`. A destroy that accepts fields takes them after the id. If you need the row back, read it first.

Omitting an optional input field and passing it as `undefined` both mean "not provided". `null` is accepted only for an attribute or an argument declared `nullable`.

## Filters, sort and paging

A read's input is plain data: a field name, an operator and a value.

```ts "src/main.ts"
import { connect, createList, disconnect, readTodo } from "#mesh";
import { alice } from "./context";

await connect();

const list = await createList({ name: "Groceries" }, { actor: alice });
const mine = await readTodo({ filter: { listId: { eq: list.id } } }, { actor: alice });
console.log(mine.map((todo) => todo.title));

await disconnect();
```

| Operator | Matches |
|:--|:--|
| `eq`, `ne` | Equal, not equal |
| `lt`, `lte`, `gt`, `gte` | Ordered comparisons |
| `in` | One of a list of values |
| `nil` | Null, or `nil: false` for not null. Every operator is lowercase |

Filters combine with `and` and `or`:

```ts "src/main.ts"
import { connect, createList, disconnect, readTodo } from "#mesh";
import { alice } from "./context";

await connect();

const list = await createList({ name: "Groceries" }, { actor: alice });
const page = await readTodo(
  {
    filter: { and: [{ listId: { eq: list.id } }, { done: { eq: false } }] },
    sort: ["-insertedAt"],
    limit: 20,
    offset: 0,
  },
  { actor: alice },
);

console.log(page.map((todo) => todo.title));

await disconnect();
```

`sort` in a call is a list of strings, and the entity file's `sort` section names the same fields with the same words: `asc :dueOn` there is `"dueOn"` here, `desc :insertedAt` is `"-insertedAt"`. The **only** difference is that an atom becomes a string at run time, and it holds everywhere — `values=[:draft, :sent]` is a `"draft" | "sent"` in TypeScript, and `self.status === :sent` inside the file is `todo.status === "sent"` in yours. `limit` and `offset` page the result.

A filter is a value, not a string, so a field that does not exist is a type error rather than a query that quietly returns nothing. The entity's own filter, the caller's filter and the policies are all combined before the query leaves the process.

## Loading relationships and computed fields

Anything derived is computed only when you name it in `load`:

```ts "src/main.ts"
import { connect, disconnect, pendingTodo } from "#mesh";
import { alice } from "./context";

await connect();

const todos = await pendingTodo({ load: ["label"] }, { actor: alice });
for (const todo of todos) console.log(todo.label);

await disconnect();
```

`load` takes relationship names (`load: ["list"]`) and computed names (`load: ["label"]` on a todo, `load: ["todoCount"]` on a list). Reading one that was not loaded is a **type error**, not `undefined`, and a load that cannot be served at run time is an error, never silently skipped.
Three things meet in `load`, and they are not one thing:

- A **relationship** runs in the query, as a join or a second query.
- A **rollup** (`count`, `sum`) always runs in SQL, so it can also be filtered on and sorted by.
- A **computed field with a body** runs in SQL when its expression can be translated, and in memory when it cannot. `label` concatenates a string, so it is computed after the rows load, one extra pass. `mesh explain` says which one a field is.

## Errors

Every action throws on failure. All four classes come from `@meshfw/runtime`, extend `MeshError` and carry a `code`, so a program can switch on the code without importing the class.

| Class | `code` | Thrown when |
|:--|:--|:--|
| `InvalidInputError` | `invalid_input` | The input does not fit the action, or a `check` failed |
| `NotFoundError` | `not_found` | The row the call names does not exist, or is not visible to this actor |
| `ForbiddenError` | `forbidden` | A policy denied the call. Carries a `breakdown` of every check |
| `FrameworkError` | `framework` | A mistake in the program: an action called before `connect`, a load that cannot be served |

`InvalidInputError.issues` holds every failure it collected, one entry each. An entry has a `label` (the label you gave the `check`), the `code` and `message` you wrote, a `path` into the input, and, when the failure came from a rule you declared, the file, line and column of the declaration that carried it. The code you declared is on the issue rather than on the error because several checks can fail in one call, and one code on the error could only name one of them.

```ts "src/main.ts"
import { InvalidInputError } from "@meshfw/runtime";
import { connect, disconnect, createList, createTodo, completeTodo } from "#mesh";
import { alice } from "./context";

await connect();

try {
  const list = await createList({ name: "Groceries" }, { actor: alice });
  const todo = await createTodo({ title: "Buy milk", listId: list.id }, { actor: alice });
  await completeTodo({ id: todo.id }, { actor: alice });
  await completeTodo({ id: todo.id }, { actor: alice });
} catch (error) {
  if (!(error instanceof InvalidInputError)) throw error;
  for (const issue of error.issues) {
    console.log(issue.label, issue.code, issue.message);
    if (issue.source) console.log(issue.source.file, issue.source.line, issue.source.column);
  }
} finally {
  await disconnect();
}
```

```text
notDoneYet already_done this todo is already complete
src/domain/todo/todo.mesh.mx 22 9
```

That first line is one entry of `error.issues`: the check's label, the code the check declared, and its message. The second is the position of the `check` that produced it, in the file you wrote. `error.code` is `invalid_input`.

A caught error has type `unknown` in strict TypeScript, so narrow it before reading `issues`.

## Asking instead of calling: `can`

Every action has a `can` function with the same arguments, returning `{ allowed, breakdown }` and changing nothing.

```ts "src/main.ts"
import { canCompleteTodo, connect, createList, createTodo, disconnect } from "#mesh";
import { alice, bob } from "./context";

await connect();

const list = await createList({ name: "Groceries" }, { actor: alice });
const todo = await createTodo({ title: "Buy milk", listId: list.id }, { actor: alice });

const answer = await canCompleteTodo({ id: todo.id }, { actor: bob });
console.log(answer.allowed);
console.log(answer.breakdown);

await disconnect();
```

```text
false
[
  {
    policy: "owner",
    check: "self.list.ownerId === actor.id",
    result: false,
    decisive: true,
  },
]
```

`breakdown` is a list, one entry per check: `{ policy, check, result, decisive }`. `policy` is the name of the policy that carried the check, `check` is the check as written, `result` is whether it held, and `decisive` marks the one that decided the answer. It is data, so a test can assert on it. Prefer it to asserting on an error class: when a call is denied on an action that runs as one statement, the row is reported as not found, and `can` is where the reason is.

**What `can` means for a read.** A read's policies usually read the stored row, and that makes them part of the query rather than a per-row decision, so there is no row for `can` to rule on: `canPendingTodo({}, { actor: bob })` answers whether the read is allowed at all, which for the tutorial's todo it is. What Bob does not get is Alice's rows — `pendingTodo({}, { actor: bob })` returns an empty array, not an error. The denials worth asking about are the ones on an action that writes, or a read policy that cannot be folded into the query; use `can` there, and assert on the empty result for a read.

## Next

- [Testing](./testing.md) — binding a database in memory.
- [Entities](./entities.md) — the declarations behind these functions, and [what `self` holds](./entities.md#what-self-holds).
- [Configuration and the command line](./configuration.md) — `mesh explain Todo complete`, which prints the plan a call follows.
---
title: "Using your domain"
description: "The generated functions, the action context, filters, sort, paging, load, the error classes and can."
---

# Using your domain

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

An action is one named operation on an entity, and in Mesh it is an ordinary TypeScript function. A command line, a worker, a cron job and an HTTP handler all call the same function with the same two arguments. There is no server, no route and no request object.

Every function has the same shape:

```ts "src/main.ts (excerpt)"
const todo = await createTodo({ title: "Buy milk", list: list.id }, { actor });
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

await createTodo({ title: "Buy milk", list: aliceList.id }, { actor: alice });
await createTodo({ title: "Buy bread", list: bobList.id }, { actor: bob });

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

Two keys are reserved. **`actor`** is what the `authorize-if` checks in your policies are given. **`system`** marks a call the application makes on its own behalf, and is covered under [internal writes](#internal-writes). Every other key is yours. A tenant, a locale, a request id: name them, and both your TypeScript and your entity files can use them:

```ts "src/main.ts"
import { connect, disconnect, createList } from "#mesh";
import { alice } from "./context";

await connect();
await createList({ name: "Groceries" }, { actor: alice, tenantId: "t1", locale: "en-GB" });
await disconnect();
```

An extension that needs a key of its own states which one it reads, and two extensions claiming the same key is a build error. Optionality is yours as well: declare `actor: User | null` and anonymous callers type-check. Declare nothing at all and the context is an empty object, and in your rules `actor` is `unknown` — which is Mesh saying it has nothing for you to compare it against.

Inside an entity file, `&name` reads a member of the record; `self.x` is also legal and means the same as `&x`. Functions receive the whole record as `self`, the caller's object as `input`, the caller as `actor`, and everything else as `context`. `context` is what you declared above, and it does not carry `actor` again — the caller is `actor`, and only `actor`. Here a tenant-scoped policy reads the record's own tenant and the call's:

```mx "src/domain/todo/todo.mesh.mx"
entity :Todo table="todos"
  attributes
    uuid :id primary-key
    string :title
    uuid :tenantId

  policies
    policy :sameTenant types=[:create]
      authorize-if=({ context }) => &tenantId === context.tenantId
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

**One `input` section describes the whole input.** A member line such as `&title` takes a declared field; a typed line such as `uuid :customerId` declares an argument that is not stored as sent. A read's caller sends these beside `filter`, `sort` and the rest:

```ts "src/main.ts"
import { connect, disconnect, forCustomerInvoice } from "#mesh";
import { alice } from "./context";

await connect();

for (const invoice of await forCustomerInvoice({ customerId: "…", sort: ["-dueOn"] }, { actor: alice })) {
  console.log(invoice.number);
}

await disconnect();
```

The same name twice in an `input` section is a build error, including a member reference and a typed argument with that name.

A read returns an array even when the filter can match one row. There is no separate "read one" function: `limit: 1` returns an array of zero or one.

### Create

The input has exactly the fields in the action's `input` section. With the tutorial's `todo.mesh.mx`, `createTodo` takes `title` and `list`:

```ts "src/main.ts"
import { connect, createList, createTodo, disconnect } from "#mesh";
import { alice } from "./context";

await connect();

const list = await createList({ name: "Groceries" }, { actor: alice });
const todo = await createTodo({ title: "Buy milk", list: list.id }, { actor: alice });

console.log(todo.id, todo.insertedAt);

await disconnect();
```

Two calls that do not compile, against that `todo.mesh.mx`:

| Call | Why |
|:--|:--|
| `createTodo({ title, list, done: true }, …)` | `done` is not in `input`, so it is not on the input type |
| `createTodo({ title: "Buy milk" }, …)` | `list` is missing; a create needs every input member that is required and has no default |

An unknown field is an error at run time, not a field dropped. If a call gets past the type checker anyway, the generated validator rejects it.

### Relationship input and record fields

`belongs-to :list entity=List` generates the `listId` column and its foreign key. The record type keeps `listId: string`, and loading the relationship gives you `list: List`. The input type is different: `&list` takes `list: List["id"]`, so the caller sends the related record's id, not the record itself.

The same rule makes `customerId` on an Invoice record. These key-column names are generated TypeScript surface: the entity file names `&list` or `&customer`, never the generated column. To compare a related id inside a file, write `&customer.id`; Mesh compares the key without a join. A typed input argument named `customerId`, as in `forCustomer` above, is separate from that column.

### Update

`{ id, ...accepted }`. The id is separate, so an action that accepts nothing still reads well:

```ts "src/main.ts"
import { connect, disconnect, completeTodo } from "#mesh";
import { alice } from "./context";

await connect();

await completeTodo({ id: "00000000-0000-4000-8000-0000000000aa" }, { actor: alice });

await disconnect();
```

**Every update reads first.** A create is one `INSERT`. An update or a destroy reads the row first, locked, in the same transaction, runs its `validate` and `do` on that row, and then writes it. Two concurrent calls on one row therefore run one after the other, and the second sees the first's write; a `check` on `self` such as `notDoneYet` in `completeTodo` always sees the row as it is now. `mesh explain` prints the plan an action follows.

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

`sort` in a call is a list of strings. The entity file uses member references: `asc &dueOn` there is `"dueOn"` here, and `desc &insertedAt` is `"-insertedAt"`. Enum values are atoms in the file and strings at run time: `values=[:draft, :sent]` gives TypeScript `"draft" | "sent"`, and `&status === :sent` compares the record's status with `"sent"`. `limit` and `offset` page the result.

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

- A **relationship** is loaded with a second query for the related rows.
- A **rollup** (`count`, `sum`) is computed from the related rows when you load it. It is a value on the loaded record; a filter or a sort cannot use it.
- A **computed field with a body** is computed in memory after the rows load, one extra pass. `label` concatenates a string. `mesh explain` lists which fields are computed.

## Errors

Every action throws on failure. All four classes come from `@meshfw/runtime`, extend `MeshError` and carry a `code`, so a program can switch on the code without importing the class.

| Class | `code` | Thrown when |
|:--|:--|:--|
| `InvalidInputError` | `invalid_input` | The input does not fit the action, or a `check` failed |
| `NotFoundError` | `not_found` | The row the call names does not exist, or is not visible to this actor |
| `ForbiddenError` | `forbidden` | A policy denied the call. Carries a `breakdown` of every check |
| `FrameworkError` | `framework` | A mistake in the program: an action called before `connect`, a load that cannot be served |

`InvalidInputError.issues` holds every failure it collected, one entry each. An entry has a `label` (the label you gave the `check`), the `code` and `message` you wrote, the `details` the check returned (or `null`), a `path` into the input, and, when the failure came from a rule you declared, the file, line and column of the declaration that carried it. The code you declared is on the issue rather than on the error because several checks can fail in one call, and one code on the error could only name one of them.

```ts "src/main.ts"
import { InvalidInputError } from "@meshfw/runtime";
import { connect, disconnect, createList, createTodo, completeTodo } from "#mesh";
import { alice } from "./context";

await connect();

try {
  const list = await createList({ name: "Groceries" }, { actor: alice });
  const todo = await createTodo({ title: "Buy milk", list: list.id }, { actor: alice });
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
src/domain/todo/todo.mesh.mx 27 9
```

That first line is one entry of `error.issues`: the check's label, the code the check declared, and its message. The second is the position of the `check` that produced it, in the file you wrote. `error.code` is `invalid_input`.

A caught error has type `unknown` in strict TypeScript, so narrow it before reading `issues`.

## Several actions in one transaction

Actions that call other actions do it inside the entity file, through `actions` ([Entities: calling other actions](./entities.md#calling-other-actions)). Your application can do the same when a method must answer with more than a record. `transaction` opens a transaction, or joins the one that is running, and hands you the same `actions` and `tx`:

```ts "src/main.ts"
import { connect, createList, disconnect, transaction } from "#mesh";
import { alice } from "./context";

await connect();

const list = await createList({ name: "Groceries" }, { actor: alice });

const todo = await transaction(async ({ actions, tx }) => {
  const open = await tx.readTodo({ filter: { and: [{ listId: { eq: list.id } }, { done: { eq: false } }] } });
  if (open.length >= 20) throw new Error("this list already has 20 open todos");
  return actions.createTodo({ title: "Buy milk", list: list.id });
}, { actor: alice });

console.log(todo.id);

await disconnect();
```

`actions` are the functions you import from `#mesh`, bound to this transaction and carrying the context you passed; each still validates its input and runs its own policies. `tx` reads inside the transaction and does not run read policies. A throw rolls back every call. An action that calls `transaction` while another is running joins it rather than opening a second one.

## Internal writes

Some writes are not a person's: a timer that expires leases, the bootstrap that creates the first user, an action another action calls. The context has a reserved key for them, **`system`**. Your application sets it, never a caller's input:

```ts "src/sweeper.ts"
import { connect, disconnect, readTodo, renameTodo } from "#mesh";
import { alice } from "./context";

await connect();

// A timer acts for the system. The actor is still the person whose record this is.
const open = await readTodo({ filter: { done: { eq: false } } }, { actor: alice, system: true });
for (const todo of open) {
  await renameTodo({ id: todo.id, title: `${todo.title} (stale)` }, { actor: alice, system: true });
}

await disconnect();
```

Mesh does nothing with `system` by itself: no policy is skipped. A policy admits an internal write by testing the key, in a helper you write:

```text "src/domain/work/work.helpers.ts (excerpt)"
export function isSystem(context: { system?: boolean }): boolean {
  return context.system === true;
}
```

```text "src/domain/work/completion.mesh.mx (excerpt)"
policy :recordedByCascade types=[:create]
  authorize-if=({ actor, context }) => hasRole(actor, ["owner"]) || isSystem(context)
```

An action that only another action should call carries a policy like this one. A call made through `actions` keeps the caller's context, `system` included, and keeps the person as the `actor`, so a record written by a cascade still names who caused it. Treat `system` as you treat any flag in your own context: it is as trustworthy as the code that builds the context.

## Seams

A **seam** is a place in every generated action where your application may run code. There are three, and each takes plain data:

| Seam | Runs | Receives | May |
|:--|:--|:--|:--|
| `beforeTransaction` | Before the transaction opens | `{ entity, action, input, context }` | Throw to refuse the call |
| `afterWrite` | Inside the transaction, right after each row is written | `tx` and `{ entity, action, before, after, input, context }` | Write through `tx`; a throw rolls back the whole call |
| `afterCommit` | Once, after the outermost transaction commits | `{ changes }`, every row written, in order | Publish; it is not called when the call rolls back |

Register them under `seams` in `mesh.config.ts`, and pass the same object to `bind` in a test:

```ts "mesh.config.ts"
import { defineConfig } from "@meshfw/runtime";
import { sqlite } from "@meshfw/data-sqlite";

export default defineConfig({
  domain: "src/domain",
  output: ".mesh",
  data: sqlite({ file: "todo.db" }),
  seams: {
    beforeTransaction({ entity, action }) {
      console.log("about to run", entity, action);
    },
    afterWrite(_tx, { entity, action, before, after }) {
      console.log("wrote", entity, action, before, after);
    },
    afterCommit({ changes }) {
      for (const change of changes) console.log("committed", change.entity, change.action);
    },
  },
});
```

In `afterWrite`, `tx` is the transaction's data operations (`insert`, `selectByKey`, `updateByKey`, `deleteByKey`, with the tables exported as `tables` from `#mesh`), so a seam can write a row of its own, such as an event, without calling an action. A write through it does not run seams. `before` is the row as it was, or `null` for a create; `after` is the row as written, or `null` for a destroy.

```ts "src/events.ts (excerpt)"
async afterWrite(tx, { entity, action, after }) {
  await tx.insert(tables.event, { type: `${entity}.${action}`, payload: after });
},
```

A call that another action makes through `actions` runs the seams for its own writes, with the caller's `context`, so a `commandId` or `caller` you put in the context reaches every event.

## Asking instead of calling: `can`

Every action has a `can` function with the same arguments, returning `{ allowed, breakdown }` and changing nothing.

```ts "src/main.ts"
import { canCompleteTodo, connect, createList, createTodo, disconnect } from "#mesh";
import { alice, bob } from "./context";

await connect();

const list = await createList({ name: "Groceries" }, { actor: alice });
const todo = await createTodo({ title: "Buy milk", list: list.id }, { actor: alice });

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
    check: "&list.ownerId === actor.id",
    result: false,
    decisive: true,
  },
]
```

`breakdown` is a list, one entry per check: `{ policy, check, result, decisive }`. `policy` is the name of the policy that carried the check, `check` is the check as written, `result` is whether it held, and `decisive` marks the one that decided the answer. It is data, so a test can assert on it. Prefer it to asserting on an error class: when a call is denied on an action that runs as one statement, the row is reported as not found, and `can` is where the reason is.

**What `can` means for a read.** A read's policies usually read the stored row, and that makes them part of the query rather than a per-row decision, so there is no row for `can` to rule on: `canPendingTodo({}, { actor: bob })` answers whether the read is allowed at all, which for the tutorial's todo it is. What Bob does not get is Alice's rows — `pendingTodo({}, { actor: bob })` returns an empty array, not an error. The denials worth asking about are the ones on an action that writes, or a read policy that cannot be folded into the query; use `can` there, and assert on the empty result for a read.

## From a command line

An [oclif command](https://oclif.io/docs/args) can call the same action. This excerpt assumes the tutorial's domain and demo Alice; in a real tool, obtain the actor from your trusted sign-in flow, not a user-supplied id. oclif owns argument parsing and command registration, not Mesh.

```ts "src/commands/list/create.ts (excerpt)"
import { Args, Command } from "@oclif/core";
import { connect, createList, disconnect } from "#mesh";
import { alice } from "../../context";

export default class CreateList extends Command {
  static args = { name: Args.string({ required: true }) };

  async run() {
    const { args } = await this.parse(CreateList);
    await connect();
    try {
      this.log(JSON.stringify(await createList({ name: args.name }, { actor: alice })));
    } finally {
      await disconnect();
    }
  }
}
```

## Over HTTP

An [Elysia handler](https://elysiajs.com/essential/handler) calls an action and maps its errors to HTTP responses. This excerpt uses your own `requireActor(request)` helper to authenticate the request; it must not trust an actor sent in the body. Connect once when the server starts and disconnect when it shuts down, not after each request.

```ts "src/http.ts (excerpt)"
import { Elysia, t } from "elysia";
import { InvalidInputError, ForbiddenError } from "@meshfw/runtime";
import { connect, createList } from "#mesh";
import { requireActor } from "./auth";

await connect();
const app = new Elysia().post("/lists", async ({ body, request, status }) => {
  const actor = await requireActor(request);
  try {
    return await createList(body, { actor });
  } catch (error) {
    if (error instanceof InvalidInputError) return status(400, { code: error.code });
    if (error instanceof ForbiddenError) return status(403, { code: error.code });
    throw error;
  }
}, { body: t.Object({ name: t.String() }) });
// Your server entry point starts app and closes the connection on shutdown.
```

The [error classes](#errors) stay the same: `invalid_input` is a bad request, `forbidden` is a denied call. A route that names an existing row should map `NotFoundError` to 404, whether the row is missing or invisible. Keep policy breakdowns and source positions in server-side diagnostics rather than exposing them to strangers; unexpected errors belong in your server's error handler.

## In a web app

[SolidStart server functions](https://docs.solidjs.com/solid-start/reference/server/use-server) make the server boundary explicit, which is why this example uses SolidStart; any framework works, because your domain is a module of functions.

```ts "src/domain-actions.ts (excerpt)"
export async function addList(name: string) {
  "use server";
  const { createList } = await import("#mesh");
  const { InvalidInputError, ForbiddenError } = await import("@meshfw/runtime");
  const { requireActor } = await import("./auth");
  const actor = await requireActor();
  try {
    return { data: await createList({ name }, { actor }) };
  } catch (error) {
    if (error instanceof InvalidInputError) return { error: { code: error.code } };
    if (error instanceof ForbiddenError) return { error: { code: error.code } };
    throw error;
  }
}
```

The function returns only an error code for invalid input or a denied call, keeping policy breakdowns and source positions out of the browser response; unexpected errors belong in your server's error handler.

Your server start-up connects once, and your `requireActor()` helper reads the authenticated server session. Keep both the database access and actor lookup on the server: the browser sends input, never a trusted context. These excerpts show calls, not ready-made Mesh integrations; framework setup, authentication and response handling belong to your application.

## Next

- [Testing](./testing.md) — binding a database in memory.
- [Entities](./entities.md) — the declarations behind these functions, and [what `self` holds](./entities.md#what-self-holds).
- [Command line](./command-line.md) — `mesh explain Todo complete`, which prints the plan a call follows.
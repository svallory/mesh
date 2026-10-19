---
title: "Events"
description: "Declaring domain events, raising them with publish, the outbox that stores them, the event bus that delivers them to handlers and subscriptions, and how long rows are kept."
---

# Events

::: callout warning "Not released"
Mesh is not released yet. These pages describe what Mesh will be.
:::

A **domain event** records a fact your domain decided: an invoice was paid, a task was completed. You declare it in a file of its own, an action raises it with a `publish` step, and Mesh writes it to the **outbox**, a table in your database, in the same transaction as the action's rows. An event is therefore stored if and only if the action commits: there is no window in which the row changed and the event was lost, or the event exists and the row did not change.

After the commit an **event bus** delivers each event: to your **handlers**, functions in your application that run a command or make an effect outside the database, and to **live subscriptions**, a stream a client reads and acknowledges. One process per database delivers, and Mesh deletes a row once every reader has passed it, unless you keep every row. This page covers each part in that order: declaring an event, `publish`, the outbox, the bus, handlers, running the deliverer, subscriptions, how long rows are kept, the events module, `published()` and `readEvents`.

## Declaring an event

An event is a file of its own under your domain folder, next to the entities that raise it. Its root line is `event :Name`, and each line under it is a field, written as an attribute line is:

```mx "src/domain/billing/invoice-paid.mesh.mx"
event :InvoicePaid
  uuid :invoiceId
  decimal :amount min=0
  enum :method values=[:card, :wire]
  datetime :paidAt
  string :reference nullable
```

A field takes the options that constrain a value: `nullable`, `values` on an `enum`, `min` and `max`, and `match` on a `string`. It takes none that concern storage (`default=`, `unique`, `primary-key`), because an event is a message with no row behind it. A field that refers to a record holds its key (`uuid :invoiceId`), since an event outlives the row it is about.

`mesh build` generates a class for each event in its module's barrel, here `#mesh/domain/billing`. Its constructor checks every field against the declaration, with every problem in one `InvalidInputError`, and freezes the instance; a `nullable` field left out is `null`. The class is nominal: an object literal shaped like an `InvoicePaid` is not one. `#mesh` exports `DomainEvent`, the union of every event class's instance type, and `eventClasses`, a table from each event's fully qualified name (FQN) to its class. The FQN is the module's folders, a dot, and the class name, `billing.InvoicePaid`; `Mesh.fqnOf(InvoicePaid)` returns it.

A **command** is declared the same way, with `command :Name`, and is a request's fields: what a caller asks an action to do. It generates a class too, which is not a `DomainEvent`. An action answers a command with `on=` ([Answering a command](#answering-a-command)), and application code runs one with `dispatch` ([Running a command](#running-a-command)).

## Raising an event

An action raises an event with a `publish` step in its `do`. The step's function returns the event, a `new` of an event class the file imports:

```mx "src/domain/billing/invoice.mesh.mx"
import { InvoicePaid } from "./invoice-paid.mesh.mx"

entity :Invoice
  attributes
    uuid :id primary-key
    boolean :paid default=false
    decimal :total min=0
  actions auto=[:read]
    update :pay
      do
        set
          &paid=true
        publish=() => new InvoicePaid({ invoiceId: &id, amount: &total, method: "card", paidAt: %.now })
  policies
    policy :anyone types=[:read, :update]
      authorize-if=() => true
```

A `publish` runs after the action's row is written, inside the transaction, in written order among the `run [after=:write]` steps, and reads `self` as the stored record: a create's new key, a destroy's deleted row. Inside a `when=`, it runs only if the condition held before the write, so a `publish` that should sometimes raise nothing is written inside a `when=`.

The function must return an instance of a declared event. Anything else fails the action with a `FrameworkError` naming the entity, the action and the step's line, and rolls it back: `null`, `undefined`, a plain object shaped like the event, a command, or any other value. A constructor that rejects its fields throws its `InvalidInputError`, which rolls the action back the same way. The build catches what it can see first: a `publish` that constructs something other than an imported event is the build error `MESH_PUBLISH`, and a `new InvoicePaid(...)` outside a `publish` step, which raises nothing, is a warning.

## Answering a command

An event says what happened; a command asks for something to happen. A command is the fields of a request, declared in a file of its own as an event is:

```mx "src/domain/billing/pay-invoice.mesh.mx"
command :PayInvoice
  uuid :id
  datetime :paidAt
```

An action answers it with `on=`, whose value is the command's imported identifier. The action is a `create`, an `update` or a `destroy`; a `read` has no `on=`.

```mx "src/domain/billing/invoice.mesh.mx"
import { PayInvoice } from "./pay-invoice.mesh.mx"

entity :Invoice
  attributes
    uuid :id primary-key
    enum :status values=[:draft, :sent, :paid] default=:draft
    datetime :paidAt nullable
  actions auto=[:read]
    update on=PayInvoice
      input
        &paidAt
      do
        set
          &status=:paid
  policies
    policy :anyone types=[:read, :update]
      authorize-if=() => true
```

An action with `on=` and no name is named after the command: the command's class name with its first letter in lower case, whatever name the file binds. `update on=PayInvoice` is the action `payInvoice`, so `Invoice.payInvoice({ id, paidAt }, context)` works as for any action; so does `on=Pay` after `import { PayInvoice as Pay }`. Write a name to choose another: `update :pay on=PayInvoice` is `Invoice.pay`. A file that imports the command's file as a namespace writes `on=billing.PayInvoice`, as `entity=billing.Invoice` names an entity.

The command and the action describe one request, so they must agree:

- An action answers at most one command, and a command is answered by at most one action in the whole project.
- Every field of the command is an input of the action, and every required input of the action is a field of the command. The key that selects the row of an update or a destroy counts as an input, which is why `PayInvoice` above has the field `id`. The `input` section decides which inputs are required: on an update every member input is optional, so the command carries only the ones it changes, and a create's required inputs must all be fields. A command's constructor sets a `nullable` field you leave out to `null`, and `dispatch` sends that `null` to the action, so on an update it overwrites the attribute with `null`. A command that answers an update should therefore carry only non-nullable fields, or ones the action is meant to set.

A command that no action answers builds with a warning, since nothing runs when it is dispatched. These are the build errors of `on=`:

| Code | When |
|:--|:--|
| `MESH_NAME` | an action with neither a name nor `on=` |
| `MESH_UNKNOWN_COMMAND` | `on=` names anything but an imported command: an event, an entity, a name nothing imports, or a value that is not an identifier or a member of a namespace import. The message suggests the nearest imported command |
| `MESH_DUPLICATE_MEMBER` | the name taken from the command clashes with another member of the entity; the message names the command. Name the action to avoid it |
| `MESH_COMMAND_INPUT` | a field of the command is no input of the action, or a required input of the action is no field of the command |
| `MESH_COMMAND_ANSWERED_TWICE` | two actions answer one command, in one entity or in two |
| `MESH_COMMAND_UNANSWERED` | a warning: no action answers the command |
| `MESH_UNKNOWN_OPTION` | `on=` on a `read` |

## Running a command

`dispatch` runs the action that answers a command, so that code that holds a command needs to know neither the entity nor the action's name:

```ts "src/pay.ts"
import { dispatch } from "#mesh";
import { PayInvoice } from "#mesh/domain/billing";
import { alice } from "./context";

export function pay(invoiceId: string) {
  return dispatch(new PayInvoice({ id: invoiceId, paidAt: new Date() }), { actor: alice });
}
```

The command's constructor checks its fields first, as an event's does. `dispatch` hands the action an input object built from the fields, `{ id: command.id, paidAt: command.paidAt }`, in code the project's type check covers: a command field whose type differs from the action's input (a `string` field for a `datetime` input) is a type error in `.mesh/index.ts`, not a failure at the first dispatch. `dispatch(command, context)` then calls the action with the command's fields as its input and the `context` you give it, so the action validates the input and runs its policies exactly as `Invoice.payInvoice(...)` does, and resolves with what the action returns (here the updated `Invoice`). It runs on the binding in scope and joins the running transaction when there is one, so a `dispatch` inside `transaction(...)` or inside a `process` handler commits or rolls back with it, and the event the action publishes appears in `published()` before the commit. Outside a transaction it opens its own, as a plain call does.

A `process` handler runs a command with the `context` it is given:

```ts "src/events.ts (excerpt)"
import { Mesh } from "meshfw";
import { dispatch } from "#mesh";
import { InvoiceOpened, PayInvoice } from "#mesh/domain/billing";

export const handlers = {
  process: {
    payOnOpen: Mesh.handler({
      events: [InvoiceOpened],
      run: async (event, { context }) => {
        await dispatch(new PayInvoice({ id: event.payload.invoiceId, paidAt: new Date() }), context);
      },
    }),
  },
};
```

The action runs in the handler's transaction, together with the record that the handler handled the event, and an event it publishes carries the handled event in `causedBy`. A `listen` handler's `dispatch` runs in a transaction of its own.

`#mesh` also exports the type `DomainCommand`, the union of the command classes an action answers, and `DispatchResult<C>`, what the action that answers `C` returns. A command no action answers is not in `DomainCommand`, so dispatching it is a type error. A value that is not an instance of a generated command class (an event, an object shaped like a command) is a `FrameworkError`, and so is a command whose action is missing from the generated code, which only a `.mesh/` folder older than the declaration can cause: run `mesh build`.

## The outbox

Each `publish` appends one row to the outbox, `mesh_outbox`, in the action's transaction. When the project declares an event, the data adapter adds the table, with its companion `mesh_outbox_state`, to your entities' tables: both are in `tables` from `#mesh`, so `createSchema(db, tables)` creates them. A row holds:

| Field | What it is |
|:--|:--|
| `position` | The event's place in the outbox's order: 1, 2, 3 and on, never reused. On SQLite the positions have no gaps, even after transactions that rolled back |
| `id` | A time-ordered UUID, the event's identity |
| `name` | The event's FQN, `billing.InvoicePaid` |
| `entity`, `action`, `key` | The publishing entity's FQN, the action's name and the record's key |
| `causedBy` | The `id` of the event whose handler published this one, or `null` for an event a caller's action published. Each event names only the event whose handler was running when it was published: in a chain of handlers, every hop points to the one before it, so you follow `causedBy` back to the event that started the chain |
| `metadata` | What your events module's `metadata` function returned, or `{}` |
| `occurredAt` | The transaction's instant, `%.now` |
| `payload` | The event's fields, as JSON |

How long the outbox keeps a row is your setting, `events.keep` in `mesh.config.ts`: `"until-delivered"`, the default, deletes a row once every reader has passed it, and `"all"` keeps every row, for an application that reads its history. Only the deliverer deletes rows; see [How long rows are kept](#how-long-rows-are-kept).

## Delivering events

A project that declares an event names its event bus in `mesh.config.ts`. There is no default: a project that declares an event and sets no `events.bus` fails the build with `MESH_EVENTS_CONFIG`.

```ts "mesh.config.ts"
import { localBus } from "@meshfw/bus-local";
import { sqlite } from "@meshfw/data-sqlite";
import { defineConfig } from "@meshfw/runtime";

export default defineConfig({
  domain: "src/domain",
  output: ".mesh",
  data: sqlite({ file: "app.db" }),
  events: {
    bus: localBus(),
    load: () => import("./src/events.ts"),
    requires: ["replay", "subscribe"],
  },
});
```

`events.load` names the module that holds your handlers; see [The events module and metadata](#the-events-module-and-metadata).

`localBus()`, from the package `@meshfw/bus-local`, delivers inside the deliverer's process, on any data adapter: for development, tests and an application that runs in one process. [`localBus`](#localbus) below lists its options. A bus declares what it can promise, its **capabilities**, from a closed list:

| Capability | What it promises | Needed by |
|:--|:--|:--|
| `ordered-delivery` | Each handler gets its events in position order, one at a time | every handler |
| `replay` | `readEvents` from any kept position | calling `readEvents` |
| `subscribe` | Live subscriptions, each read from its own cursor, never skipping a row | calling `subscribe` |
| `dead-letters` | A handler may set an event aside and go on (`onFailure: "skip"`) | `onFailure: "skip"` |
| `multi-process` | Handlers and subscriptions in every process on the database | running more than one deliverer |

`#mesh` exports `readEvents` only when the bus declares `replay`, and `subscribe` only when it declares `subscribe`, so calling one the bus cannot serve is a type error. List what your application needs in `requires` to make its absence a build error instead: `requires` takes a bus's capabilities and a data adapter's, and one the configured adapters lack is `MESH_CAPABILITY`.

## Handlers

A handler is a function of your application that gets every event it lists, after the event's transaction commits. The events module exports them under `handlers`, by kind, each under its name:

```ts "src/events.ts"
import { Mesh } from "meshfw";
import { Invoice, InvoicePaid } from "#mesh/domain/billing";

declare function sendReceipt(options: { idempotencyKey: string; invoiceId: string }): Promise<void>;

export const handlers = {
  process: {
    // Runs inside a transaction: what it writes and the record that it handled the event commit together.
    markPaid: Mesh.handler({
      events: [InvoicePaid],
      run: async (event, { context }) => {
        await Invoice.pay({ id: event.payload.invoiceId }, context);
      },
    }),
  },
  listen: {
    // Runs outside any transaction: an email or a call out never holds the database's write lock.
    receipt: Mesh.handler({
      events: [InvoicePaid],
      run: async (event) => {
        await sendReceipt({ idempotencyKey: event.id, invoiceId: event.payload.invoiceId });
      },
    }),
  },
};
```

`Mesh.handler(options)` returns its options as they are. It exists so that TypeScript infers the type of `event` in `run` from `events`, which it cannot do through a plain object literal: here `event.payload` is an `InvoicePaid`. `event` is an `EventRecord`, the row as [The outbox](#the-outbox) lists it.

There are two kinds, one per answer to "what may the body do, and when does the event count as handled":

| Kind | Runs | May | Must not |
|:--|:--|:--|:--|
| `process` | inside the handler's transaction, which also records that it handled the event | call entity values, which join the transaction and may publish | hold the transaction open on a call out of the process |
| `listen` | outside any transaction; Mesh records that it handled the event after the body returns | call anything outside the database; call entity values, each call its own transaction | rely on exactly once: a crash between the body and the record runs it again |

A `process` handler is exactly once for the database: if the body or the commit fails, its writes roll back with the record, and the event is handled again. On SQLite a write transaction holds the whole database's write lock, so an email or an HTTP call inside a `process` body would make every other write wait for it; that is what `listen` is for. A `listen` body is at least once, so pass `event.id` to the service as its idempotency key where the service takes one. An event a `process` handler's action publishes carries the handled event in `causedBy`.

Both kinds start from now: a handler handles the events published after it is first registered, never history. A new receipt handler must not send a receipt for every past payment; a handler that needs past data reads it from current rows.

### The context a handler runs with

A handler passes its `context` to the actions it calls. By default the context is `{ system: true }`, the mark of a call the application makes on its own behalf, which a policy admits with `Mesh.isSystem(context)`: policies deny by default, so a handler that writes through an action needs one. The events module can export `context(event)` to choose it, for instance to act as the person whose call published the event, read from the metadata your `metadata` function stored:

```ts "src/events.ts (excerpt)"
import type { EventRecord } from "#mesh";

export const context = (event: EventRecord) => ({ system: true, onBehalfOf: event.metadata.commandId });
```

### Names and options

The key under a kind is the handler's name. Names are unique across both kinds, and each keys a row in `mesh_handler_progress`, the table that records how far the handler has got. Two options change what a handler does:

| Option | What it does |
|:--|:--|
| `onFailure` | `"stop"`, the default: a handler that keeps failing stops at its event (see [Failures and retries](#failures-and-retries)). `"skip"` sets the event aside and goes on; it needs the bus's `dead-letters`, and the type of `onFailure` accepts it only when the bus declares it |
| `renamedFrom` | The handler's former name. Mesh cannot tell a rename from a removal and an addition, so a renamed handler says so: when the former name has a progress row and the new name has none, the row moves to the new name at registration, and the handler goes on from where it was |

Without `renamedFrom`, a renamed handler is a new handler that starts from now, and the old name's row stays behind as an orphan (see [Orphan rows](#orphan-rows)).

The build cannot see `src/events.ts`, so the options are checked by the type checker and when delivery starts, before anything is claimed: a handler that lists something other than an event class of this project, `onFailure: "skip"` on a bus without `dead-letters`, a `renamedFrom` that names a handler the module still registers or that two handlers name, all fail with `HandlerOptionError` (`MESH_HANDLER_OPTION`). An events module that exports handlers while the configuration sets no bus fails with `EventsConfigError` (`MESH_EVENTS_CONFIG`).

### Registration

Delivery registers the handlers each time it starts. With P the position a handler's row holds:

| Case | What happens |
|:--|:--|
| A new handler | Its row starts at the highest position the outbox has assigned: it handles what is published from then on |
| A renamed handler with `renamedFrom` | The former name's row becomes the new name's, at P; the start logs the move |
| The same events as last time | It resumes at P |
| Events removed from its list | Their rows are passed from then on |
| Events added to its list | The added events are handled from P on, so no row it had not passed is lost; the start logs them |

## Running the deliverer

One process per database delivers: it holds the database's **claim**, a row in `mesh_outbox_state`. A second process that tries to deliver fails with `DelivererTakenError` (`MESH_DELIVERER_TAKEN`), which names the holder (its host, pid and start time, and how long ago it renewed the claim) and `lapsesAt`, when a crashed holder's claim may be taken over. How a process delivers depends on how it connects:

| Call | What it does |
|:--|:--|
| `connect()` | Opens the configured data layer, loads the events module, checks the handlers' options, claims, registers the handlers and starts the bus. `disconnect()` stops delivery first (the running round finishes and the claim is released), then closes the layer |
| `connect({ deliver: false })` | The same without claiming, registering or starting: for scripts, the command line and a web tier beside a worker. Its actions write the outbox, which the deliverer picks up; `readEvents` works; `subscribe` throws a `FrameworkError`, since nothing would feed it |
| `bind(layer, { events })` | Attaches a layer you opened; it opens, claims and starts nothing |
| `await binding.deliver()` | One round, for tests: claims, registers, feeds every handler and subscription as far as the committed rows go, retries inline, deletes what every reader has passed, and releases the claim |
| `const delivery = await binding.startDelivery()` | Claims, registers and starts as `connect()` does, for a process that binds a layer of its own, such as a daemon. `await delivery.stop()` stops and releases. Stop it before you close the layer |

```ts "test/receipts.test.ts (excerpt)"
import { bind, tables } from "#mesh";
import { Invoice } from "#mesh/domain/billing";
import { createSchema, sqlite } from "@meshfw/data-sqlite";
import { testBus } from "@meshfw/runtime/testing";
import * as events from "../src/events.ts";

const layer = sqlite({ file: ":memory:" });
await createSchema(layer, tables);
const binding = bind(layer, { events: { bus: testBus(), load: async () => events } });

await binding.deliver(); // the first round registers the handlers, which start from now
await binding.run(() => Invoice.pay({ id: "0190a000-0000-7000-8000-000000000001" }, { system: true }));
await binding.deliver(); // every handler gets the InvoicePaid
```

`deliver()` resolves once the round is done. It rejects with `HandlerStoppedError` when a handler stopped in the round, or with `DatabaseBusyError`. A round hands each handler the rows there were when it reached that handler, so an event a `process` handler publishes reaches the handlers after it in the next round. It does not queue: one `deliver()` that overlaps another round is `MESH_DELIVERER_TAKEN`. `deliver()` on a binding whose delivery is started, and either call on a binding with no bus, is a `FrameworkError`.

The running deliverer renews its claim every 5 seconds, whatever the bus; a claim not renewed for 15 seconds has lapsed, and another process may take it over. The deliverer that lost the claim notices at its next transaction and stops with `DelivererLostError` (`MESH_DELIVERER_LOST`): its handlers stop, its subscriptions end with that error, and no event is handled twice or deleted by it. Both numbers are fixed for now. Mind one consequence: a transaction longer than 15 seconds in the deliverer's process (an action, or a `process` handler awaiting a slow call) holds the database long enough for a waiting process to take over a healthy deliverer, which then stops loudly and loses nothing.

## `localBus`

`localBus(options?)`, from `@meshfw/bus-local`, is the first event bus. It runs in the deliverer's process on any data adapter, for development, tests and an application that runs in one process, and declares `ordered-delivery`, `replay` and `subscribe`; it does not declare `dead-letters`, so `onFailure: "skip"` is refused. Its options are all optional:

| Option | Default | What it does |
|:--|:--|:--|
| `pollInterval` | `1000` | After start, how often in milliseconds a round also runs, to pick up what processes connected with `{ deliver: false }` committed |
| `retryDelays` | `[100, 1000, 10000]` after start; `[0, 0, 0]` in `deliver()` rounds | The wait in milliseconds before each retry of a failing handler; when they are used up, the handler stops. A value you set applies to both |
| `maxQueue` | `10000` | How many events a live subscription may have waiting for its callback before it ends with `SubscriptionOverflowError` |

```ts "mesh.config.ts"
import { localBus } from "@meshfw/bus-local";
import { sqlite } from "@meshfw/data-sqlite";
import { defineConfig } from "@meshfw/runtime";

export default defineConfig({
  domain: "src/domain",
  output: ".mesh",
  data: sqlite({ file: "app.db" }),
  events: {
    bus: localBus({ pollInterval: 250, retryDelays: [500, 5000, 30000], maxQueue: 50_000 }),
  },
});
```

`pollInterval` and each delay are whole milliseconds, at most 2147483647 (about 24.8 days, the longest wait a timer keeps); `pollInterval` is at least 1. A wrong option, such as a `pollInterval` of 0 or a negative delay, is a `FrameworkError` when `localBus()` is called, which is when `mesh.config.ts` loads.

**Rounds.** Each round feeds every handler from its own progress row, in position order, one event at a time, then every live subscription from its own position, then deletes what every reader has passed. Once delivery is started (`connect()` or `startDelivery()`), a round runs at once, after each transaction in this process that published commits, and every `pollInterval`. Creating the bus starts nothing, and `disconnect()` or `delivery.stop()` waits for the running round and leaves no timer behind.

**Retries.** After start, a handler that throws waits out its delay on its own timer, outside the rounds, so a handler that backs off delays no other handler or subscription; the next try is the same event. An error with `retryable: false`, such as a `ForbiddenError`, stops the handler at once, without the delays. A try that `DatabaseBusyError` ends is not counted: the round ends, and the next one tries again. In a `deliver()` round the retries run inline with no wait, because the started defaults add up to 11.1 seconds, past `bun test`'s 5-second timeout, which would turn a handler's error into a timeout.

**A stopped handler.** A started `localBus` reports a handler that stops with `console.error`, as a `HandlerStoppedError` that names the handler, the position and the event. The other handlers go on; the stopped one is fed nothing until it resumes, and the outbox keeps every row from its position on. It resumes at the next start, in the next `deliver()` round, or when you call `resumeHandler(name)`, from `#mesh`, in the process that delivers, once its cause is fixed:

```ts "src/resume.ts"
import { connect, resumeHandler } from "#mesh";

await connect();
// later, once the mail service that made the receipt handler stop is back
await resumeHandler("receipt");
```

`resumeHandler` feeds the handler again from its progress row in the next round, with a fresh retry schedule. It does nothing to a handler that is not stopped, and it is a `FrameworkError` for a name the deliverer did not register, or in a process where delivery is not started.

**Subscriptions** are fed from the rounds, each from its own position, so a commit in another process reaches them within `pollInterval`. Acknowledgements are core's and go through `ack`, never through the bus.

## Live subscriptions

`subscribe(query, callback)`, from `#mesh` when the bus declares `subscribe`, opens a stream of the events that match the query, in position order, in the deliverer's process. It resolves with a `Subscription`:

```ts "src/live.ts"
import { connect, disconnect, subscribe } from "#mesh";

await connect();
let processed = 0;
const subscription = await subscribe({ name: "dashboard", names: ["billing.InvoicePaid"] }, (event) => {
  console.log(event.position, event.name);
  processed = event.position;
});
// ... later, once the events are processed
if (processed > 0) await subscription.ack(processed);
await subscription.close();
console.log(await subscription.done);
await disconnect();
```

| Member | What it does |
|:--|:--|
| `name` | The subscription's identity, which you choose: a reopen under the same name resumes from what it acknowledged |
| `ack(position)` | Acknowledges every delivered row at or below the position. It is cumulative, so acknowledge the highest position you have processed, as often as you like |
| `close()` | Ends the stream and keeps the subscription's row, so a later reopen resumes |
| `done` | Resolves when the stream ends: with `null` after `close()` or when delivery stops, else with the error that ended it |

The query takes `name`, `after` (where a first open starts; by default the highest position now) and the filters `names`, `entity` and `key`, as `readEvents` does. A subscription without a name, or with a name already open in the process, is a `FrameworkError`: two readers acknowledging under one row would pass each other's rows.

Each subscription has a row in `mesh_subscription_progress` that stores its acknowledged position and its filter. A reopen under the same name ignores `after` and starts from the acknowledged position, so every row the client did not acknowledge comes again: a subscription is at least once, as a `listen` handler is. A reopen with a different filter is a `FrameworkError`, since an acknowledged position means something only under the filter it was reached with; forget the name first, then open it with the new filter.

The callback never runs inside a transaction, and an error ends only its own subscription. A subscription whose queue passes the bus's `maxQueue` (10 000 events by default), because its callback is slower than publishing, ends with `SubscriptionOverflowError` (`MESH_SUBSCRIPTION_OVERFLOW`), never with a skip; reopen it to resume from what it acknowledged.

## How long rows are kept

Under `keep: "until-delivered"`, the deliverer deletes the outbox rows that every reader has passed:

- every handler's row in `mesh_handler_progress`, whether the handler is registered, stopped, or an orphan not yet forgotten;
- every subscription's acknowledged position, whether the subscription is open, closed or abandoned, until it is forgotten;
- and the deliverer's own read head.

A row handed to a subscription's callback but not yet acknowledged is not passed, so a row is never deleted while a client may still be processing it. Rows a handler or a subscription does not list do not hold it back. Deleting always removes the oldest rows, so the rows kept stay contiguous and a cursor keeps its meaning. Under `keep: "all"` nothing is deleted.

Only the deliverer deletes, by the `keep` its own configuration sets, from the next time it claims. A deploy whose configuration drops `keep: "all"` therefore deletes the delivered history at its first deletion pass.

### Orphan rows

A handler that is removed, or renamed without `renamedFrom`, leaves a progress row that holds outbox rows for ever. So does a subscription whose client never comes back. The deliverer logs each the first time it finds it, then at most once an hour, naming it, its position and how many rows it holds; it also logs an open subscription that has been handed rows and has not acknowledged for more than an hour. Nothing is dropped automatically. Drop a row with:

- `forgetHandler(name)` or `forgetSubscription(name)`, from `#mesh`, in the deliverer's process. `forgetHandler` refuses a handler the running deliverer registered, so a typo cannot drop a running handler's progress, and `forgetSubscription` refuses an open subscription;
- or `mesh events forget <name>`, from any process (see [Command line](./command-line.md#events-forget)).

`listSubscriptions()`, from `#mesh` in every project that declares events, lists every persisted subscription on the binding's database, open, closed or abandoned, until forgotten. It resolves with a frozen array of `SubscriptionProgress` entries, `{ name, position }`, ordered by name. `position` is the stored acknowledged position (including rows its filter passed), not the stream's in-memory read cursor. It needs no running deliverer and runs on the binding in scope or the connected one.

```ts "src/subscriptions.ts"
import { connect, disconnect, listSubscriptions } from "#mesh";

await connect({ deliver: false });
for (const { name, position } of await listSubscriptions()) {
  console.log(name, position);
}
await disconnect();
```

An application whose subscriptions end for good closes each, then forgets it.

## The events module and metadata

The events module is a file of your application, `src/events.ts` by convention, that `mesh.config.ts` names with `events.load`. Its `metadata` function runs once per `publish`, in the transaction, with the event so far and the publishing call's context, and returns plain JSON, stored as the event's `metadata`. Mesh never stores the context itself, which can hold secrets: only what this function picks from it.

```ts "src/events.ts"
import type { MetadataFunction } from "#mesh";

declare module "@meshfw/runtime" {
  // The context key this module reads; a project usually declares its keys in src/context.ts.
  interface ActionContext {
    commandId?: string;
  }
  // What every event's metadata holds.
  interface EventMetadata {
    commandId: string | null;
  }
}

export const metadata: MetadataFunction = ({ event, context }) => ({
  commandId: context.commandId ?? event.id,
});
```

```ts "mesh.config.ts (excerpt)"
events: { load: () => import("./src/events.ts") },
```

A nested call publishes with its own context, so a key such as `commandId` reaches its events when the calling code passes it on. `connect()` loads the module before it binds, so a module that fails to load fails there; under `bind(layer, { events })` in a test, the first `publish` or delivery loads it. The build never loads it, so it may import `#mesh` at its top. A `metadata` function that returns anything but an object fails the action.

The module exports three things, each optional: `handlers` (see [Handlers](#handlers)), `metadata`, and `context(event)`, the context handlers run with.

## A transaction's own events

`published()`, from `#mesh`, returns the events the running transaction has published so far, in order, with their positions: to return them from an endpoint, to store them beside an idempotency record, or to assert them in a test. Each is an `EventRecord`: the fields of the table above, with `payload` the event's instance. A nested call's events take their place in written order. Outside a transaction it throws a `FrameworkError`.

```ts "src/pay.ts"
import { connect, disconnect, published, transaction } from "#mesh";
import { Invoice } from "#mesh/domain/billing";
import { alice } from "./context";

await connect();
const events = await transaction(async () => {
  await Invoice.pay({ id: "0190a000-0000-7000-8000-000000000001" }, { actor: alice });
  return published();
});
console.log(events.map((record) => `${record.position} ${record.name}`));
await disconnect();
```

## Reading the outbox

`readEvents(query)`, from `#mesh` when the configured bus declares `replay`, reads a page of the events the outbox keeps, committed ones only, on the binding in scope or the connected one, in any process. Under the default `keep` little is kept beyond what is not yet delivered, so an application that reads its history, or whose clients resume from cursors of their own, sets `keep: "all"`. It resolves with `{ events, cursor, highest }`: each event an `EventRecord` whose `payload` is an instance of its class (dates are `Date` again), `cursor`, the position to pass as `after` next, and `highest`, the highest position the outbox ever assigned, as the data adapter reports it in the same snapshot as the rows. `highest` is 0 before the first append and stays after deletion; it is not bounded by the page's `limit` or filters. On SQLite it includes only committed assignments, never a writer's uncommitted ones. The read runs outside any transaction, so `highest` can be ahead of what the caller's earlier transaction saw. Compare `cursor < highest` to tell whether this snapshot has more positions to read; it does not promise that another event matches the filters.

| Field of `query` | Default | What it does |
|:--|:--|:--|
| `after` | `0` | Reads the rows after this position |
| `limit` | `100` | How many rows to read, filtered ones included, so a page may hold fewer events |
| `names` | every event | Only events with these FQNs; each must be a declared event |
| `entity`, `key` | any | Only events published by this entity, or for the record with this key |

```ts "src/history.ts"
import { connect, disconnect, readEvents } from "#mesh";
import { InvoicePaid } from "#mesh/domain/billing";

await connect();
let after = 0;
for (;;) {
  const { events, cursor } = await readEvents({ after, names: ["billing.InvoicePaid"] });
  for (const record of events) {
    if (record.payload instanceof InvoicePaid) console.log(record.position, record.payload.amount);
  }
  if (cursor === after) break;
  after = cursor;
}
await disconnect();
```

Inside a transaction `readEvents` throws a `FrameworkError`: a transaction's own events come from `published()`. A read that cannot continue safely stops with an error rather than skip a row:

| Class | `code` | Thrown when |
|:--|:--|:--|
| `EventsDeletedError` | `MESH_EVENTS_DELETED` | `after` is behind the rows already deleted, so reading on would skip them. Names `after` and `oldestKept`. Reload current state and read from the newest position, or keep every row with `events.keep: "all"` |
| `CursorAheadError` | `MESH_CURSOR_AHEAD` | `after` is above the highest position the outbox ever assigned: the cursor was kept outside a database that has since gone back, such as a restored backup. Names `after` and `highest` |
| `EventUndeclaredError` | `MESH_EVENT_UNDECLARED` | A kept row names an event the project no longer declares, because its file moved or was renamed. Names `eventName` and `position`. Move the declaration back until its rows are delivered |

## Failures and retries

A handler that throws is retried by the bus, then stopped at its event: `binding.deliver()` rejects with `HandlerStoppedError`, whose `stopped` lists `{ handler, position, event, cause }` for each handler that stopped in the round, `cause` being its last error, and a started bus reports it. A stopped handler holds deletion at its position, so the outbox keeps every row from there on. It resumes in the next `deliver()` round, at the next start of delivery, or on `resumeHandler(name)` (see [`localBus`](#localbus)). No failure is dropped without a record.

Whether a retry makes sense is on the error. Every Mesh error carries `retryable`, which says whether the same call may succeed if repeated unchanged: `DatabaseBusyError` is retryable, since another connection held the database's write lock, while a validation, policy, not-found or framework error is not. An error of your own counts as retryable unless it sets `retryable: false`. A handler whose error is not retryable is stopped at once, without the retry schedule: retrying a `ForbiddenError` three times changes nothing and only delays the report. `DatabaseBusyError` in a handler's transaction is never a handler failure: the round ends, and the next one tries again.

| Class | `code` | `retryable` | Thrown when |
|:--|:--|:--|:--|
| `EventsConfigError` | `MESH_EVENTS_CONFIG` | `false` | The `events` configuration is not valid, or the events module exports handlers while no bus is set |
| `HandlerOptionError` | `MESH_HANDLER_OPTION` | `false` | A handler lists something other than an event class of the project, asks for `onFailure: "skip"` without `dead-letters`, or has a `renamedFrom` that names a registered handler or that two handlers name |
| `DelivererTakenError` | `MESH_DELIVERER_TAKEN` | `true` | Another process or binding holds the claim, or a `deliver()` overlapped a round. Names the `holder` and `lapsesAt`. Stop the other process, or connect this one with `{ deliver: false }` |
| `DelivererLostError` | `MESH_DELIVERER_LOST` | `false` | This process no longer holds the claim: another process took it over after it lapsed, or a renewal updated no row or stayed blocked past the lapse. This process's delivery stopped |
| `HandlerStoppedError` | `MESH_HANDLER_STOPPED` | `false` | `deliver()` when handlers stopped in the round; names them in `stopped` |
| `SubscriptionOverflowError` | `MESH_SUBSCRIPTION_OVERFLOW` | `true` | A subscription's queue passed the bus's `maxQueue` (10 000 events by default); reopen it |
| `EventsDeletedError` | `MESH_EVENTS_DELETED` | `false` | A read or a first subscription from behind the deleted rows |
| `CursorAheadError` | `MESH_CURSOR_AHEAD` | `false` | A read or a first subscription from above the highest position ever assigned |
| `EventUndeclaredError` | `MESH_EVENT_UNDECLARED` | `false` | A kept row names an event the project no longer declares: every handler stops at it, and a subscription or a read that reaches it ends |

The full list of Mesh's errors is under [Errors](./using-your-domain.md#errors).

## Writing an event bus

A bus is a descriptor, `{ manifest, create(core, options) }`: `manifest` declares the adapter's name and its capabilities as static data the build reads, and `create` makes one instance per binding that delivers, with `start()`, `stop()` and `deliver()`, and, optionally, `resumeHandler(handler)`, which `resumeHandler(name)` of `#mesh` calls; without it, that call is a `FrameworkError` while the bus runs. A descriptor holds no state and starts nothing, so the build may construct one each time it reads the configuration.

Core hands each instance a `BusCore`, its only way to the outbox and the handlers: `rows(after, limit)`, the one read; the registered `handlers`; `position(handler)`, `lists(handler, row)`, `runHandler(handler, row)` and `retry(handler, row, delays)`; the live `subscriptions()`, each with a cursor and a `feed(page)`; `deletionPass()`; and `onPublished` and `onClaimLost`, two wake-ups. Core owns everything that must be right whatever the bus: the claim and its renewal, the handler's transaction and its progress row, and every deletion. A bus delivers to a handler only through `runHandler`, never names a position to delete and never writes core's tables, so a bug in a bus can delay delivery and deletion but never lose an event or delete one early.

`@meshfw/runtime/testing` holds the suite every bus must pass, `busConformance`, and `testBus()`, a small bus for tests that declares `ordered-delivery`, `replay` and `subscribe`.

## Next

- [Entities](./entities.md#do) — the `do` steps, `publish` among them, and [the options of an action line](./entities.md#options-on-an-action-line), `on=` among them.
- [Configuration](./configuration.md#events) — `events.bus`, `events.load`, `events.keep` and `events.requires`.
- [Command line](./command-line.md#events-forget) — `mesh events forget`.
- [Using your domain](./using-your-domain.md#seams) — the seams, and why events do not go through them.

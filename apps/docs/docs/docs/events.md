---
title: "Events"
description: "Declaring domain events, raising them with publish, the outbox that stores them, published() and readEvents."
---

# Events

::: callout warning "Not released"
Mesh is not released yet. These pages describe what Mesh will be.
:::

A **domain event** records a fact your domain decided: an invoice was paid, a task was completed. You declare it in a file of its own, an action raises it with a `publish` step, and Mesh writes it to the **outbox**, a table in your database, in the same transaction as the action's rows. An event is therefore stored if and only if the action commits: there is no window in which the row changed and the event was lost, or the event exists and the row did not change.

This page covers what exists today: declaring an event, `publish`, the outbox, the events module that adds your metadata, `published()` and `readEvents`. Delivering events to handlers and live subscribers, through an event bus, is the next step of the [roadmap](../architecture/roadmap/roadmap.md) (M6), and this page grows with it.

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

A **command** is declared the same way, with `command :Name`, and is a request's fields: what a caller asks an action to do. It generates a class too, which is not a `DomainEvent`.

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

## The outbox

Each `publish` appends one row to the outbox, `mesh_outbox`, in the action's transaction. When the project declares an event, the data adapter adds the table, with its companion `mesh_outbox_state`, to your entities' tables: both are in `tables` from `#mesh`, so `createSchema(db, tables)` creates them. A row holds:

| Field | What it is |
|:--|:--|
| `position` | The event's place in the outbox's order: 1, 2, 3 and on, never reused. On SQLite the positions have no gaps, even after transactions that rolled back |
| `id` | A time-ordered UUID, the event's identity |
| `name` | The event's FQN, `billing.InvoicePaid` |
| `entity`, `action`, `key` | The publishing entity's FQN, the action's name and the record's key |
| `causedBy` | The event whose handler published this one, or `null`; handlers come with the event bus |
| `metadata` | What your events module's `metadata` function returned, or `{}` |
| `occurredAt` | The transaction's instant, `%.now` |
| `payload` | The event's fields, as JSON |

How long the outbox keeps a row is your setting, `events.keep` in `mesh.config.ts`: `"until-delivered"`, the default, deletes a row once every reader has passed it, and `"all"` keeps every row, for an application that reads its history. Only the event bus deletes rows, so until it exists every row stays. See [Configuration](./configuration.md#events).

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

A nested call publishes with its own context, so a key such as `commandId` reaches its events when the calling code passes it on. `connect()` loads the module before it binds, so a module that fails to load fails there; under `bind(layer, { events })` in a test, the first `publish` loads it. The build never loads it, so it may import `#mesh` at its top. A `metadata` function that returns anything but an object fails the action.

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

`readEvents(query)`, from `#mesh`, reads a page of the events the outbox keeps, committed ones only, on the binding in scope or the connected one. It resolves with `{ events, cursor }`: each event an `EventRecord` whose `payload` is an instance of its class (dates are `Date` again), and `cursor`, the position to pass as `after` next.

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

## Retrying

Every Mesh error carries `retryable`, which says whether the same call may succeed if repeated unchanged. The three errors above are not retryable: repeating the read with the same cursor fails the same way. `DatabaseBusyError` is, since another connection held the database's write lock. The full list is under [Errors](./using-your-domain.md#errors).

## Next

- [Entities](./entities.md#do) — the `do` steps, `publish` among them.
- [Configuration](./configuration.md#events) — `events.load` and `events.keep`.
- [Using your domain](./using-your-domain.md#seams) — the seams, and why events do not go through them.

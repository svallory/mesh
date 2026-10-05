---
title: "Entities"
description: "Every declaration an entity file may use: attributes, relationships, computed fields, actions, validations, steps and policies."
---

# Entities

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

An entity file is one `.mesh.mx` file in your project's domain folder. It holds one entity: its data, the operations on it, and the rules around those operations. This page is the reference for the whole file, in the order you would write it.

Everything here is [Marko](https://markojs.org)'s concise syntax: indentation, no angle brackets. A block starts with its tag and continues until the indentation changes.

## The shape of a file

This is a complete entity file, small enough to read in one go. It is the same file the [Introduction](./index.md) shows and the [tutorial](./tutorial.md) builds.

```mx "src/domain/todo/todo.mesh.mx"
entity #Todo table="todos"
  attributes
    uuid #id primary-key
    string #title min=1
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

    update #complete
      validate
        check :notDoneYet [
          that=({ self }) => !self.done
          code="already_done"
          message="this todo is already complete"
        ]
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

Five things about that file are worth saying outright.

**Every line is `kind #name options`.** The tag says what the line is, `#name` says which one, and the options follow: `uuid #id primary-key` is one line, and so is `policy #owner types=["create", "read"]`. Names are unique within their section, and one entity per file.

**Sections group the lines.** `attributes`, `relationships`, `computed`, `actions` and `policies`, in any order, and each may be empty or left out. Inside an action there are three more: `arguments`, `validate` and `do`. The order of the sections does not matter; the order of the lines inside one does. To *call* anything, an entity needs at least one action and a policy: an action no policy covers is forbidden, so a file with no `policies` section can be built but nothing in it can be called.

**Indentation nests.** A line indented under another belongs to it and runs as part of it.

**Values Mesh reads are literals**: a string, a number, a regular expression, `true`, `false`, a list or an object written out in full. The exceptions are the places whose value is code — `filter`, `when`, `authorize-if`, `forbid-if`, the `that` of a `check`, the right-hand side of a `set` line, and a computed field's body. Those take one of two things, and the difference matters: a function whose body is **one expression** — an arrow `(…) => …`, or a method body with a single `return` — is translated, so it also runs inside the database query. Anything else is plain code and runs in memory. Where the database is required (a `filter`, a `sort`, a policy check), an expression that cannot be translated is a build error naming the line.

**Functions receive four things.** `self` is the record, `input` is what the caller sent, `actor` is who is calling and `context` is the rest of the call. [What `self` holds](#what-self-holds) is one table, and it depends on where the function runs.

**Hand-written code is imported.** A `.mesh.mx` file opens with ordinary `import` lines, and the imported functions are usable inside its expressions. The helper sits beside the entity and is a normal TypeScript module:

```ts "src/domain/invoice/invoice.helpers.ts"
export function isStaff(actor: { role: string }): boolean {
  return actor.role === "staff";
}
```

```mx "src/domain/invoice/invoice.mesh.mx"
import { isStaff } from "./invoice.helpers"

entity #Invoice
  attributes
    uuid #id primary-key
    string #number unique match=/^INV-\d+$/

  relationships
    belongs-to=Customer #customer

  policies
    policy #staffWrites types=["create", "update", "destroy"]
      authorize-if=({ actor }) => isStaff(actor)
```

Three rules, and nothing more: only relative imports, only of files inside `src/domain/`, only named imports; and an imported function must be pure — it may not read the clock, the network or anything Mesh did not hand it. A helper that does not read `self`, such as `isStaff(actor)`, is called once before the query and enters the SQL as a bound value, which is why `isStaff(actor)` works in a policy.

**What a translated arrow may use.** Comparisons, `&&`, `||`, `!`, `+ - * /`, `.length`, `today()`, the fields of `self`, and imported helpers that do not read `self`. Anything else runs in memory, and the build tells you so if it appears somewhere the database is required.

## The entity line

| Option | Required | Meaning |
|:--|:--|:--|
| `#Todo` | yes | The entity's name, in PascalCase. Every generated function is named after it, and it must be unique across the domain |
| `table` | no | The database table. Defaults to the entity's name in snake_case |

A relationship names another entity by that same name, so `belongs-to=User #author` points at the entity declared as `entity #User`.

The folder that holds the file is the module: entities in `src/domain/todo/` belong together, and no line in the file repeats the folder's name.

## attributes

The data fields. One line each: the type is the tag, `#name` is the field.

```mx "src/domain/post/post.mesh.mx"
entity #Post
  attributes
    uuid #id primary-key
    string #title
    enum #status values=["draft", "published"] default="draft"
    string #notes nullable max=2000
    integer #views default=0
    float #rating default=0
    decimal #price
    datetime #publishedAt nullable
    timestamp #insertedAt on="create"
    timestamp #updatedAt on="update"
```

### The types

| Tag | TypeScript | What it holds |
|:--|:--|:--|
| `uuid` | `string` | A UUID. `primary-key` is how you get one, and Mesh generates its value on create |
| `string` | `string` | Text |
| `integer` | `number` | A whole number: a count, a position, a number of views |
| `float` | `number` | A number with a fraction, where the exact value does not matter |
| `decimal` | `number` | An exact number with a fraction: money, a tax rate, anything you add up |
| `boolean` | `true` or `false` | |
| `enum` | the union of `values` | One of a fixed set: `enum #status values=["draft", "published"]` |
| `date` | `Date` | A calendar date, with no time of day: an invoice's issue date |
| `datetime` | `Date` | A date and a time of day, with no time zone: when a payment happened, in the server's local time |
| `timestamp` | `Date` | A moment, always with its time zone: a row's `insertedAt` |

`integer`, `float` and `decimal` are all `number` in TypeScript, and they are three types because they are three things to store: a whole number is not a money amount, and money is not a measurement.

`status` above is typed `"draft" | "published"` in TypeScript, so a caller that sends `"archvied"` does not compile, and would be rejected at run time if it slipped past.

### Options on an attribute line

| Option | Meaning |
|:--|:--|
| `primary-key` | This is the primary key. An entity has one, a database row needs one, and Mesh fills it on create |
| `nullable` | The field may be absent or null. Every other attribute is required |
| `default=` | A literal that fits the type: a number, one of an `enum`'s `values`, `true` or `false` |
| `values=` | On an `enum` only: the allowed values, in full. An empty list, a blank or a repeat is a build error |
| `unique` | The database refuses a second row with the same value |
| `min=`, `max=` | For a `string`, the shortest and longest it may be; for a number, the smallest and largest value it may take |
| `match=` | A regular expression a `string` must match |
| `on="create"`, `on="update"` | On a `timestamp`: who fills it. `on="create"` fills it on insert, `on="update"` on insert and on every later write, and no caller may set either |

`uuid #id primary-key` and the two `timestamp` lines are the three fields almost every entity has, so they are in every example on these pages. `on="create"` and `on="update"` are unrelated to `on:load` on the `actions` line, which chooses an action; see [actions](#actions).

A field name may not be one of JavaScript's built-in object property names: `__proto__`, `constructor`, `prototype`, `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`, `toString`, `valueOf`, `__defineGetter__`, `__defineSetter__`, `__lookupGetter__` or `__lookupSetter__`. Mesh cannot validate a value safely against those.

## relationships

Each relationship is one line: the destination entity as the tag's value, and `#name` for the relationship.

```mx "src/domain/todo/todo.mesh.mx"
entity #Todo
  attributes
    uuid #id primary-key

  relationships
    belongs-to=List #list
    has-many=Comment #comments
    has-one=Attachment #attachment
```

| Line | What it gives you |
|:--|:--|
| `belongs-to=List #list` | Many todos belong to one list. It adds the `listId` attribute and the foreign key, and `todo.list` when you ask for it |
| `has-many=Comment #comments` | One todo has many comments. It adds no attribute, and gives `todo.comments` when you ask for it |
| `has-one=Attachment #attachment` | One row at most: it reads one attachment through that entity's own `belongs-to`, and makes that foreign key unique, so two attachments cannot share a todo |

**A `belongs-to` creates its foreign-key attribute from its own name.** `belongs-to=List #list` gives you `listId`; rename the relationship to `#parent` and the attribute is `parentId`. Add `nullable` and the foreign key is optional, which is what you want when the row does not exist yet at the moment it is written.

The other side is not automatic. If `todo` declares `belongs-to=List #list`, the list knows nothing about it until `list.mesh.mx` declares `has-many=Todo #todos`. Both sides are useful: `todo.list` reads one row, `list.todos` reads many.

## computed

Values Mesh derives rather than stores. Two kinds of line, one section.

```mx "src/domain/invoice/invoice.mesh.mx"
entity #Invoice
  attributes
    uuid #id primary-key
    string #status
    decimal #amount
    date #dueOn nullable

  relationships
    has-many=InvoiceLine #lines

  computed
    boolean #isOverdue({ self }) {
      return self.status === "sent" && self.dueOn < today()
    }
    string #label({ self }) {
      return self.number + " · " + formatMoney(self.total)
    }
    count #lineCount of="lines"
```

**A field with a body.** A type, a `#name`, the parameters in brackets, and a body. The parameters are `({ self })` in almost every case; add `actor` when the value depends on who is asking.

**A rollup.** A rollup kind, a `#name` and `of=`, a path: a relationship name, or a relationship name and a field (`of="lines.amount"`). The path is checked at build time against the generated types, so a wrong path is a build error and not a query that returns nothing.

| Rollup | Result |
|:--|:--|
| `count #lineCount of="lines"` | How many rows the path reaches |
| `sum #total of="lines.amount"` | The total of a numeric field over them |
| `avg #averageAmount of="lines.amount"` | The average of the same |
| `min #firstDueOn of="lines.dueOn"` | The smallest value of the field |
| `max #lastDueOn of="lines.dueOn"` | The largest |

Inside the entity file, every computed field is available: a check, a step, a filter and a policy may all read `#lineCount` without asking. A **caller** sees one only when they name it in `load`; reading a field the caller did not load is a type error.

Mesh decides at build time whether an expression can be translated, and one that cannot is not a mistake: it runs in memory, after the rows are loaded, and costs one extra pass. `#label` above calls a helper on `self`, so it is one of those, and nothing about it is an error — nobody writes a second statement to make it fail on purpose. The build complains in exactly one place: where the database is required, which is a `filter`, a `sort`, a policy check and a rollup's `of` path. String concatenation, a conditional on a string and a helper that reads `self` are not translatable; comparison, boolean operators, numeric arithmetic and `.length` are. `mesh explain` says which computed fields are translated.

## actions

The operations. `auto` lists the plain actions Mesh generates for you, and every action you write yourself is `type #name`.

```mx "src/domain/invoice/invoice.mesh.mx"
entity #Invoice
  attributes
    uuid #id primary-key
    string #number unique match=/^INV-\d+$/
    string #status

  actions auto=["read", "destroy"] on:load="visible"
    create #create accept=["number"]
    read #visible
      filter=({ self }) => self.status !== "cancelled"
```

**`auto`.** Any of `create`, `read`, `update`, `destroy`, no repeats. An action listed there is named after its type, which is why the auto read is `readInvoice` and the auto destroy is `destroyInvoice`.

**`on:load`.** It says which read Mesh uses when **this** entity is loaded through a relationship: with `on:load="visible"` above, `invoiceLine.invoice` runs the read named `visible`, and that read's `filter` applies. Without it, Mesh uses the auto read. Naming a read that does not exist is a build error, and so is loading an entity through a relationship when it has neither `on:load` nor an auto read.

**`accept`.** A list of field names, with no blanks and no repeats; `accept=[]` is valid and means the action takes only an id. On a **create**, every accepted field that is required and has no default must be sent. On an **update**, accepted fields are optional: the caller sends only what changes. A `validate` block says what a particular action insists on; see [`require`](#validate). On a create, a required attribute that is not accepted, has no default, is not filled by Mesh and is not set by a step is a build error, not a field silently left empty.

### arguments

An `arguments` line is for a value the action needs that is not one of the entity's stored fields, written with the same shape as an attribute:

```mx "src/domain/todo/todo.mesh.mx"
entity #Todo
  attributes
    uuid #id primary-key
    boolean #done default=false
    datetime #completedAt nullable

  actions
    update #complete
      arguments
        string #reason max=200
      do
        set
          #done=true
          #completedAt=({ input }) => input.completedAt
```

`completeTodo` is then called as `completeTodo({ id, reason }, context)`. An argument is required unless it is `nullable`, exactly like an attribute, and it reaches your code as `input.reason` — it is not a field, so a step that stores it names a field and takes its value from `input`. Use `accept` when the caller sends a value that belongs on the record as sent; use `arguments` when it does not.

### validate

The checks that run before anything is written, on the record with the accepted input applied — see [What `self` holds](#what-self-holds).

```mx "src/domain/invoice/invoice.mesh.mx"
entity #Invoice
  attributes
    uuid #id primary-key
    string #number unique match=/^INV-\d+$/
    decimal #amount min=0
    date #issuedOn
    date #dueOn
    string #status

  actions
    create #create accept=["number", "amount", "issuedOn", "dueOn"]
      validate
        check :dueAfterIssue [
          that=({ self }) => self.dueOn >= self.issuedOn
          code="invalid_dates"
          message="the due date cannot be before the issue date"
        ]

    update #send accept=["notes"]
      validate
        require=["notes"]
        check :notSentYet [
          that=({ self }) => self.status !== "sent"
          code="already_sent"
          message="this invoice has already been sent"
        ]
      do
        set
          #status="sent"
```

**A rule about one field goes on that field's line**, with `min`, `max` or `match`: `decimal #amount min=0` is the whole of "the amount cannot be negative". A `check` is for a rule across fields, like `#dueAfterIssue`, or about the state the row is in, like `#notSentYet`.

**`require=[...]`** lists accepted fields this action insists on, which is how an update says what a caller must send.

**`check :label [ … ]`** is one rule. The word after `check` is its **label**, written with `:` because it labels a failure for the caller rather than naming anything in the entity; the brackets are what let its options run on separate lines. Inside them:

| Option | Meaning |
|:--|:--|
| `that=` | An arrow function returning a boolean. It sees the four parameters |
| `code=` | The caller-facing code for this rule, a string or a number. It is on the issue the caller receives, so a program can switch on it |
| `message=` | The sentence the caller sees |

A check that fails throws `InvalidInputError`, whose own `code` is always `invalid_input`. Each failure is one entry of `error.issues`, carrying the label, the `code` and `message` you wrote, and the file, line and column of the `check` that declared it. Several checks can fail at once, and each one is its own issue, which is why the declared `code` lives there and not on the error. `when=` nests inside `validate` as it does inside `do`, so a rule may apply only under a condition.

### do

The steps, run top to bottom after the checks pass. Each step sees the record as the earlier steps left it.

```mx "src/domain/invoice/invoice.mesh.mx"
entity #Invoice
  attributes
    uuid #id primary-key
    string #status
    decimal #amount
    datetime #paidAt nullable
    boolean #needsReview default=false

  relationships
    belongs-to=Customer #customer

  actions
    update #pay
      arguments
        datetime #paidAt
      do
        set
          #status="paid"
          #paidAt=({ input }) => input.paidAt
        when=({ self }) => self.amount > 10000
          set
            #needsReview=true
        load=["customer"]
        run({ self, input, actor }) {
          audit.record("invoice.paid", { id: self.id, by: actor.id });
        }
```

| Step | What it does |
|:--|:--|
| `set` | Assigns fields. Each child line is `#field=value`, and the value is a literal or a one-expression arrow that sees the four parameters |
| `when=cond` | Runs the steps nested under it only when the condition holds. Steps at the same level run in the order written |
| `load=[...]` | Loads relationships and computed fields onto the record this action returns. It writes nothing |
| `run(…) { }` | Plain code inside the transaction, for the one thing a `set` cannot say. It cannot be translated, so the action reads the record first and writes second |

Reach for `run` only when the work is not a field assignment: calling something outside the database, recording an event, formatting a value another system will read. If the work is a value on a field, it is a `set` line, and the action stays a single statement. An expression Mesh cannot translate in a `check`, a `when` or a `set` value is not an error either — it runs in memory and makes the action read first, then write; `mesh explain` says which expression caused it.

### Reads: filter and sort

A read has two options of its own, and nothing else:

```mx "src/domain/invoice/invoice.mesh.mx"
entity #Invoice
  attributes
    uuid #id primary-key
    string #status
    date #dueOn

  actions
    read #overdue
      filter=({ self }) => self.status === "sent"
      sort=["dueOn"]
```

**`filter=`** is a function returning a boolean, and it must be translatable, because it runs as the query's `WHERE`. The caller's own filter and the policies are combined with it before the query is sent, so a read can only ever return fewer rows, never more.

**`sort=`** is a list of field or computed names, ascending, with `-` in front for descending. The caller's `sort` uses the same strings. Paging is the caller's: `limit` and `offset` in the input. See [Calling actions](./calling-actions.md#filters-sort-and-paging).

### always

`always` takes the body of an action and applies it to every action in its scope. It is how a rule that applies to everything is written once. Its checks run before the action's own checks, and its steps before the action's own steps.

```mx "src/domain/invoice/invoice.mesh.mx"
entity #Invoice
  attributes
    uuid #id primary-key
    decimal #amount min=0
    date #issuedOn
    date #dueOn

  actions
    always types=["create", "update"]
      validate
        check :dueAfterIssue [
          that=({ self }) => self.dueOn >= self.issuedOn
          code="invalid_dates"
          message="the due date cannot be before the issue date"
        ]

    create #create accept=["amount", "issuedOn", "dueOn"]
```

`always` takes the same `types=` and `actions=` a policy takes, and may hold `validate`, `do` or both. `types=["create", "update"]` means every create and every update; `actions=["send", "pay"]` means those two by name; neither means every action in the entity.

## policies

One policy per line, with a name, a scope and checks.

```mx "src/domain/invoice/invoice.mesh.mx"
import { isStaff } from "./invoice.helpers"

entity #Invoice
  attributes
    uuid #id primary-key
    string #status

  relationships
    belongs-to=Customer #customer

  policies
    policy #staffOrOwnerReads types=["read"]
      authorize-if=({ self, actor }) => isStaff(actor) || self.customer.userId === actor.id
    policy #staffWrites types=["create", "update", "destroy"]
      authorize-if=({ actor }) => isStaff(actor)
    policy #neverDestroyPaid types=["destroy"]
      forbid-if=({ self }) => self.status === "paid"
```

**How a policy decides.** The checks inside one policy combine without order: it passes when none of its `forbid-if` holds and, if it has any `authorize-if`, at least one of them holds, so a policy with only `forbid-if` checks passes until one of them is true. Every policy covering an action must pass, and an action that no policy covers is **forbidden** — as is every action of an entity with no `policies` section at all. Forgetting a rule must not open an action.

| Option | Meaning |
|:--|:--|
| `types=[...]` | Any action whose type is **any** of those. `types=["read"]` is every read |
| `actions=[...]` | Those actions by name. `actions=["send", "pay"]` |
| neither | Every action of the entity |

The list inside `types=` is "or". Two policies are "and": every policy that covers an action must pass.

| Check | Meaning |
|:--|:--|
| `authorize-if=` | The call is allowed when at least one of them holds |
| `forbid-if=` | The call is refused when any of them holds |

An exemption is written in the condition rather than as an escape hatch: `forbid-if=({ self, actor }) => self.status === "paid" && !isStaff(actor)` forbids the destroy of a paid invoice to everyone but staff.

When a check reads the stored row, Mesh folds it into the statement's filter, so a row the caller may not see is reported as not found rather than forbidden. `can<Action>` is how you ask for the reason instead. A `create` policy sees the record the create would write, and reading a related row there is a query inside the transaction before the insert.

## Building one

```bash
bunx mesh build
```

The build rejects a declaration, an option or a value outside this reference, an `accept` naming a field the entity does not have, a `do` step that sets a field the entity does not have, two entities with the same name, two entities in one file, a `check` with no `that`, an `on:load` naming a read that does not exist, an expression the database cannot run where it must, and a data-layer capability the configured adapter does not declare. Every diagnostic names the file, the line and the column:

```text
src/domain/todo/todo.mesh.mx:18:20 error `accept` names "titel", which is not an attribute of Todo. Did you mean "title"?
```

To see what Mesh read, including the source position of every declaration, run `mesh inspect Todo`. To see the plan an action's handler follows, run `mesh explain Todo complete`. Both are in [the command line](./configuration.md).

## What `self` holds

One table, because it depends on where the function runs. `input` is always the caller's own object, `actor` is always the caller and `context` is always the rest of the action context.

| Where the function runs | `self` is |
|:--|:--|
| a `check` in `validate` | The record with the accepted input applied: the caller's value for each accepted field, the stored value for every field the caller did not send, and the declared defaults on a create. Nothing from `do` has run |
| a step in `do` | The record as the earlier steps left it |
| a `filter` on a read | Each row the query considers |
| a policy on a read | The row |
| a policy on an update or a destroy | The stored record |
| a policy on a create | The proposed record: the accepted input and the defaults |
| a computed field | The loaded record |

## In short

If you want one table and nothing else, this is the whole file.

| Section | A line looks like | An example |
|:--|:--|:--|
| `attributes` | `type #name options`, required unless `nullable` | `string #title min=1` |
| `relationships` | `kind=Destination #name`, and `nullable` makes it optional | `belongs-to=List #list` |
| `computed` | `type #name({ self }) { … }`, or a rollup with `of=` a path | `count #todoCount of="todos"` |
| `actions` | `type #name options`, with `arguments`, `validate` and `do` inside | `update #send` |
| `policies` | `policy #name`, a scope (`types=`, `actions=`) and `authorize-if` / `forbid-if` | `policy #owner types=["read"]` |

## A larger example

One file that puts most of the above together: `src/domain/invoice/invoice.mesh.mx`. It is not a file to copy; it is here because a reader who has followed the sections can check their understanding against it.

```mx "src/domain/invoice/invoice.mesh.mx"
import { formatMoney, isStaff } from "./invoice.helpers"

entity #Invoice table="invoices"
  attributes
    uuid #id primary-key
    string #number unique match=/^INV-\d+$/
    enum #status values=["draft", "sent", "paid", "cancelled"] default="draft"
    decimal #amount min=0
    date #issuedOn
    date #dueOn
    datetime #paidAt nullable
    string #notes nullable max=2000
    boolean #needsReview default=false
    uuid #paidById nullable
    timestamp #insertedAt on="create"
    timestamp #updatedAt on="update"

  relationships
    belongs-to=Customer #customer
    has-many=InvoiceLine #lines
    has-one=Payment #payment

  computed
    boolean #isOverdue({ self }) {
      return self.status === "sent" && self.dueOn < today()
    }
    string #label({ self }) {
      return self.number + " · " + formatMoney(self.total)
    }
    count #lineCount of="lines"
    sum #total of="lines.amount"

  actions auto=["read", "destroy"] on:load="visible"
    always types=["create", "update"]
      validate
        check :dueAfterIssue [
          that=({ self }) => self.dueOn >= self.issuedOn
          code="invalid_dates"
          message="the due date cannot be before the issue date"
        ]

    create #create accept=["number", "customerId", "amount", "issuedOn", "dueOn", "notes"]

    update #send
      validate
        check :invoiceHasNoLines [
          that=({ self }) => self.lineCount > 0
          code="invalid_state"
          message="an invoice needs at least one line"
        ]
      do
        set
          #status="sent"

    update #pay
      arguments
        datetime #paidAt
      validate
        check :invoiceNotSent [
          that=({ self }) => self.status === "sent"
          code="invalid_state"
          message="only a sent invoice can be paid"
        ]
      do
        set
          #status="paid"
          #paidAt=({ input }) => input.paidAt
          #paidById=({ actor }) => actor.id
        when=({ self }) => self.amount > 10000
          set
            #needsReview=true
        load=["customer"]

    read #visible
      filter=({ self }) => self.status !== "cancelled"

    read #overdue
      filter=({ self }) => self.isOverdue
      sort=["dueOn"]

    read #forCustomer
      arguments
        uuid #customerId
      filter=({ self, input }) => self.customerId === input.customerId

  policies
    policy #staffOrOwnerReads types=["read"]
      authorize-if=({ self, actor }) => isStaff(actor) || self.customer.userId === actor.id
    policy #staffWrites types=["create", "update", "destroy"]
      authorize-if=({ actor }) => isStaff(actor)
    policy #neverDestroyPaid types=["destroy"]
      forbid-if=({ self }) => self.status === "paid"
```

Six things to notice in it:

- **`customerId` is not declared.** `belongs-to=Customer #customer` created it, and `create` accepts it by that name.
- **`decimal #amount min=0` is the whole of "not negative"**, and the `always` block holds the one rule that needs two fields, `dueAfterIssue`, instead of restating it.
- **`#pay` sets three fields and then, under `when`, a fourth.** Steps at the same level run in order, and the nested ones only when the condition holds.
- **`read #forCustomer` takes an argument**, and the filter compares it against `input.customerId`. A read may be as parameterised as a write.
- **`#label` calls a helper on `self`**, so it runs in memory. That is not a mistake, and nobody writes a second statement to avoid it; `read #overdue` filters on `#isOverdue`, which is one translatable expression, so it runs in SQL.
- **`neverDestroyPaid` is a `forbid-if`, and nothing else.** It forbids while the invoice is paid, and passes otherwise, which is what lets every other destroy through.

## Next

- [Calling actions](./calling-actions.md) — what the generated functions take and return.
- [Configuration and the command line](./configuration.md) — the file that points Mesh at this one, and every command.

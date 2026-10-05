---
title: "Entities"
description: "Every declaration an entity file may use: attributes, relationships, computed fields, actions, validations, steps and policies."
---

# Entities

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

An entity file is one `.mesh.mx` file in your project's domain folder. It holds one entity: its data, the operations on it, and the rules around those operations. This page is the reference for the whole file, in the order you would write it.

Everything here is MX syntax, and two facts are enough to read it: **indentation nests**, and **a line is `kind :name options`**. A block starts with its tag and continues until the indentation changes.

## Names are atoms

`:name` is an **atom**: a name that stands for itself. It is not a string. An entity file uses an atom for every name and for anything chosen out of a fixed set, and uses a string only for text a person reads.

| It is | Written | Examples |
|:--|:--|:--|
| The name of a declaration | `kind :name` | `entity :Invoice`, `uuid :id`, `update :pay`, `policy :staffWrites`, `check :invoiceIsSent` |
| A reference to something declared | an atom, or a list of atoms | `accept=[:number, :amount]`, `require=[:dueOn]`, `sort=[:dueOn]`, `load=[:customer]`, `actions=[:pay]`, `on:load=:visible`, `belongs-to=:Customer` |
| One of a fixed set | an atom | `auto=[:read, :destroy]`, `types=[:create, :update]`, `on=:create` |
| An enum value | an atom | `values=[:draft, :sent]`, `default=:draft`, `self.status === :sent`, `:status=:paid` |
| Text | a string | `table="invoices"`, `message="…"`, `code="invalid_state"` |
| A path through relationships | a string | `of="lines.amount"`, `of="lines"` |
| A pattern, a number, a boolean | as in TypeScript | `match=/^INV-\d+$/`, `min=0`, `default=false` |

Four things follow from that one idea, and the rest of this page is full of them.

**There is one way to name a thing.** `entity :Invoice`. The older `#name` spelling is gone, so there is nothing to learn twice.

**A string where a name belongs is an error.** `accept=["title"]` is refused, and so is an atom where text belongs: `message=:oops`. Mesh knows which is which, because the vocabulary says what each option holds.

**Names are checked.** `accept=[:titel]` is a build error at that position, with a suggestion, in the editor and in `mesh build`.

**Names are written out.** A variable or an expression in one of these positions is an error, because Mesh reads the file without running it: `accept=[acceptedFields]` is refused. Functions — a `filter`, a `that`, a `set` value — are ordinary TypeScript and may use anything.

## The shape of a file

This is a complete entity file, small enough to read in one go. It is the same file the [Introduction](./index.md) shows and the [tutorial](./tutorial.md) builds.

```mx "src/domain/todo/todo.mesh.mx"
entity :Todo table="todos"
  attributes
    uuid :id primary-key
    string :title min=1
    boolean :done default=false
    timestamp :insertedAt on=:create
    timestamp :updatedAt on=:update

  relationships
    belongs-to=:List :list

  computed
    string :label({ self }) {
      return (self.done ? "[x] " : "[ ] ") + self.title
    }

  actions auto=[:read, :destroy]
    create :create accept=[:title, :listId]

    update :complete
      validate
        check :notDoneYet [
          that=({ self }) => !self.done
          code="already_done"
          message="this todo is already complete"
        ]
      do
        set
          :done=true

    update :rename accept=[:title]

    read :pending
      filter=({ self }) => self.done === false
      sort=[:insertedAt]

  policies
    policy :owner types=[:create, :read, :update, :destroy]
      authorize-if=({ self, actor }) => self.list.ownerId === actor.id
```

Five things about that file are worth saying outright.

**Every line is `kind :name options`.** The tag says what the line is, `:name` says which one, and the options follow: `uuid :id primary-key` is one line, and so is `policy :owner types=[:create, :read]`. Names are unique within their section, and one entity per file.

**Sections group the lines.** `attributes`, `relationships`, `computed`, `actions` and `policies`, in any order, and each may be empty or left out. Inside an action there are three more: `arguments`, `validate` and `do`. The order of the sections does not matter; the order of the lines inside one does. To *call* anything, an entity needs at least one action and a policy: an action no policy covers is forbidden, so a file with no `policies` section can be built but nothing in it can be called.

**Indentation nests.** A line indented under another belongs to it and runs as part of it. A line at the left margin ends what came before it, so a comment inside an entity is a `//` line indented with the block it belongs to: a comment at the left margin under `entity :Todo` ends the entity there, and everything below it belongs to nothing.

**Values Mesh reads are literals**: an atom, a string, a number, a regular expression, `true`, `false`, a list or an object written out in full. Which one belongs where is [Names are atoms](#names-are-atoms), and it is checked. The exceptions are the places whose value is code — `filter`, `when`, `authorize-if`, `forbid-if`, the `that` of a `check`, the right-hand side of a `set` line, and a computed field's body. Those take one of two things, and the difference matters: a function whose body is **one expression** — an arrow `(…) => …`, or a method body with a single `return` — is translated, so it also runs inside the database query. Anything else is plain code and runs in memory. Where the database is required (a `filter`, a `sort`, a policy check), an expression that cannot be translated is a build error naming the line.

**Functions receive four things.** `self` is the record, `input` is what the caller sent, `actor` is who is calling and `context` is the rest of the call. [What `self` holds](#what-self-holds) is one table, and it depends on where the function runs.

**Hand-written code is imported.** A `.mesh.mx` file opens with ordinary `import` lines, and the imported functions are usable inside its expressions. The helper sits beside the entity and is a normal TypeScript module:

```ts "src/domain/billing/invoice.helpers.ts"
export function isStaff(actor: { role: string }): boolean {
  return actor.role === "staff";
}
```

```mx "src/domain/billing/invoice.mesh.mx"
import { isStaff } from "./invoice.helpers"

entity :Invoice
  attributes
    uuid :id primary-key
    string :number unique match=/^INV-\d+$/

  relationships
    belongs-to=:Customer :customer

  policies
    policy :staffWrites types=[:create, :update, :destroy]
      authorize-if=({ actor }) => isStaff(actor)
```

Three rules, and nothing more: only relative imports, only of files inside `src/domain/`, only named imports; and an imported function must be pure — it may not read the clock, the network or anything Mesh did not hand it. A helper that does not read `self`, such as `isStaff(actor)`, is called once before the query and enters the SQL as a bound value, which is why `isStaff(actor)` works in a policy.

**What a translated arrow may use.** Comparisons, `&&`, `||`, `!`, `+ - * /`, `.length`, `today()`, the fields of `self`, and imported helpers that do not read `self`. Anything else runs in memory, and the build tells you so if it appears somewhere the database is required.

## The entity line

| Option | Required | Meaning |
|:--|:--|:--|
| `:Todo` | yes | The entity's name, in PascalCase. Every generated function is named after it, and it must be unique across the domain |
| `table` | no | The database table. Defaults to the entity's name in snake_case |

A relationship points at another entity by that same name, written as an atom, so `belongs-to=:User :author` points at the entity declared as `entity :User`. The destination is an atom rather than a bare word because a bare `User` would read as a TypeScript variable that needs an import.

The folder that holds the file is the module: entities in `src/domain/todo/` belong together, and no line in the file repeats the folder's name.

## attributes

The data fields. One line each: the type is the tag, `:name` is the field.

```mx "src/domain/post/post.mesh.mx"
entity :Post
  attributes
    uuid :id primary-key
    string :title
    enum :status values=[:draft, :published] default=:draft
    string :notes nullable max=2000
    integer :views default=0
    float :rating default=0
    decimal :price
    datetime :publishedAt nullable
    timestamp :insertedAt on=:create
    timestamp :updatedAt on=:update
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
| `enum` | the union of `values` | One of a fixed set: `enum :status values=[:draft, :published]` |
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
| `on=:create`, `on=:update` | On a `timestamp`: who fills it. `on=:create` fills it on insert, `on=:update` on insert and on every later write, and no caller may set either |

`uuid :id primary-key` and the two `timestamp` lines are the three fields almost every entity has, so they are in every example on these pages. `on=:create` and `on=:update` are unrelated to `on:load` on the `actions` line, which chooses an action; see [actions](#actions).

A field name may not be one of JavaScript's built-in object property names: `__proto__`, `constructor`, `prototype`, `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`, `toString`, `valueOf`, `__defineGetter__`, `__defineSetter__`, `__lookupGetter__` or `__lookupSetter__`. Mesh cannot validate a value safely against those.

## relationships

Each relationship is one line: the destination entity as the tag's value, and `:name` for the relationship.

```mx "src/domain/todo/todo.mesh.mx"
entity :Todo
  attributes
    uuid :id primary-key

  relationships
    belongs-to=:List :list
    has-many=:Comment :comments
    has-one=:Attachment :attachment
```

| Line | What it gives you |
|:--|:--|
| `belongs-to=:List :list` | Many todos belong to one list. It adds the `listId` attribute and the foreign key, and `todo.list` when you ask for it |
| `has-many=:Comment :comments` | One todo has many comments. It adds no attribute, and gives `todo.comments` when you ask for it |
| `has-one=:Attachment :attachment` | One row at most: it reads one attachment through that entity's own `belongs-to`, and makes that foreign key unique, so two attachments cannot share a todo |

**A `belongs-to` creates its foreign-key attribute from its own name.** `belongs-to=:List :list` gives you `listId`; rename the relationship to `:parent` and the attribute is `parentId`. Add `nullable` and the foreign key is optional, which is what you want when the row does not exist yet at the moment it is written.

The other side is not automatic. If `todo` declares `belongs-to=:List :list`, the list knows nothing about it until `list.mesh.mx` declares `has-many=:Todo :todos`. Both sides are useful: `todo.list` reads one row, `list.todos` reads many.

## computed

Values Mesh derives rather than stores. Two kinds of line, one section.

```mx "src/domain/billing/invoice.mesh.mx"
import { formatMoney } from "./invoice.helpers"

entity :Invoice
  attributes
    uuid :id primary-key
    string :number
    string :status
    decimal :amount
    date :dueOn nullable

  relationships
    has-many=:InvoiceLine :lines

  computed
    boolean :isOverdue({ self }) {
      return self.status === :sent && self.dueOn < today()
    }
    string :label({ self }) {
      return self.number + " · " + formatMoney(self.amount)
    }
    count :lineCount of="lines"
```

**A field with a body.** A type, a `:name`, the parameters in brackets, and a body. The parameters are `({ self })` in almost every case; add `actor` when the value depends on who is asking.

**A rollup.** A rollup kind, a `:name` and `of=`, a path: a relationship name, or a relationship name and a field (`of="lines.amount"`). The path is checked at build time against the generated types, so a wrong path is a build error and not a query that returns nothing.

| Rollup | Result |
|:--|:--|
| `count :lineCount of="lines"` | How many rows the path reaches |
| `sum :total of="lines.amount"` | The total of a numeric field over them |
| `avg :averageAmount of="lines.amount"` | The average of the same |
| `min :firstDueOn of="lines.dueOn"` | The smallest value of the field |
| `max :lastDueOn of="lines.dueOn"` | The largest |

Inside the entity file, every computed field is available: a check, a step, a filter and a policy may all read `:lineCount` without asking. A **caller** sees one only when they name it in `load`; reading a field the caller did not load is a type error.

Mesh decides at build time whether an expression can be translated, and one that cannot is not a mistake: it runs in memory, after the rows are loaded, and costs one extra pass. `:label` above calls a helper on `self`, so it is one of those, and nothing about it is an error — nobody writes a second statement to make it fail on purpose. The build complains in exactly one place: where the database is required, which is a `filter`, a `sort`, a policy check and a rollup's `of` path. String concatenation, a conditional on a string and a helper that reads `self` are not translatable; comparison, boolean operators, numeric arithmetic and `.length` are. `mesh explain` says which computed fields are translated.

## actions

The operations. `auto` lists the plain actions Mesh generates for you, and every action you write yourself is `type :name`.

```mx "src/domain/billing/invoice.mesh.mx"
entity :Invoice
  attributes
    uuid :id primary-key
    string :number unique match=/^INV-\d+$/
    string :status

  actions auto=[:read, :destroy] on:load=:visible
    create :create accept=[:number]
    read :visible
      filter=({ self }) => self.status !== :cancelled
```

**`auto`.** Any of `create`, `read`, `update`, `destroy`, no repeats. An action listed there is named after its type, which is why the auto read is `readInvoice` and the auto destroy is `destroyInvoice`.

**`on:load`.** It says which read Mesh uses when **this** entity is loaded through a relationship: with `on:load=:visible` above, `invoiceLine.invoice` runs the read named `visible`, and that read's `filter` applies. Without it, Mesh uses the auto read. Naming a read that does not exist is a build error, and so is loading an entity through a relationship when it has neither `on:load` nor an auto read.

**`accept`.** A list of field names written as atoms, with no blanks and no repeats; `accept=[]` is valid and means the action takes only an id. On a **create**, every accepted field that is required and has no default must be sent. On an **update**, accepted fields are optional: the caller sends only what changes. A `validate` block says what a particular action insists on; see [`require`](#validate). On a create, a required attribute that is not accepted, has no default, is not filled by Mesh and is not set by a step is a build error, not a field silently left empty. A name that is not a field of the entity is a build error too: `accept=[:titel]` says so, at that line, and suggests `:title`.

**Every option goes on the declaration line.** `accept=`, `auto=`, `on:load=`, `types=` and `actions=` are written next to the name they belong to, as in `create :create accept=[:title, :listId]` and `policy :owner types=[:read]`. The only two options that live on their own lines are a read's `filter=` and `sort=`, because they have bodies: what the query must select, and in what order.

### arguments

An `arguments` line is for a value the action needs that is **not stored as it was sent**, written with the same shape as an attribute:

```mx "src/domain/billing/invoice.mesh.mx"
entity :Invoice
  attributes
    uuid :id primary-key
    decimal :amount min=0
    decimal :percent default=0

  actions
    update :applyDiscount
      arguments
        decimal :percent min=0 max=100
      do
        set
          :amount=({ self, input }) => self.amount * (1 - input.percent / 100)
```

`applyDiscountInvoice` is then called as `applyDiscountInvoice({ id, percent: 10 }, context)`. An argument is required unless it is `nullable`, exactly like an attribute, and it reaches your code as `input.percent`. Use `accept` for a value that belongs on the record as the caller sent it — `update :pay accept=[:paidAt]` stores what was sent — and `arguments` when it is not: here the percentage is a number the action needs to compute with, and no field holds "10% off".

### validate

The checks that run before anything is written, on the record with the accepted input applied — see [What `self` holds](#what-self-holds).

```mx "src/domain/billing/invoice.mesh.mx"
entity :Invoice
  attributes
    uuid :id primary-key
    string :number unique match=/^INV-\d+$/
    decimal :amount min=0
    date :issuedOn
    date :dueOn
    string :status
    string :notes nullable

  actions
    create :create accept=[:number, :amount, :issuedOn, :dueOn]
      validate
        check :dueAfterIssue [
          that=({ self }) => self.dueOn >= self.issuedOn
          code="invalid_dates"
          message="the due date cannot be before the issue date"
        ]

    update :send accept=[:notes]
      validate
        require=[:notes]
        check :notSentYet [
          that=({ self }) => self.status !== :sent
          code="already_sent"
          message="this invoice has already been sent"
        ]
      do
        set
          :status=:sent
```

**A rule about one field goes on that field's line**, with `min`, `max` or `match`: `decimal :amount min=0` is the whole of "the amount cannot be negative". A `check` is for a rule across fields, like `:dueAfterIssue`, or about the state the row is in, like `:notSentYet`.

A line rule carries Mesh's own message, because there is nowhere in `min=0` to write your own: `string :title min=1` reports `too_short` and "must be at least 1 character", and the error's code is `invalid_input` like any other. The code and message are Mesh's in v1; a line rule of your own is where you choose them.

**`require=[...]`** lists accepted fields this action insists on, which is how an update says what a caller must send. Its entries are atoms, like every other name.

**`check :label [ … ]`** is one rule. The atom after `check` is the rule's **label**: it names the rule, so name it for the rule that must hold (`invoiceIsSent`, `dueAfterIssue`), and it is the name the caller sees on the failure. The brackets are what let the options run on separate lines. Inside them:

| Option | Meaning |
|:--|:--|
| `that=` | An arrow function returning a boolean. It sees the four parameters |
| `code=` | The caller-facing code for this rule, a string or a number. It is text your program switches on, so it stays a string, not an atom. It is on the issue the caller receives |
| `message=` | The sentence the caller sees |

A check that fails throws `InvalidInputError`, whose own `code` is always `invalid_input`. Each failure is one entry of `error.issues`, carrying the label, the `code` and `message` you wrote, and the file, line and column of the `check` that declared it. Several checks can fail at once, and each one is its own issue, which is why the declared `code` lives there and not on the error. `when=` nests inside `validate` as it does inside `do`, so a rule may apply only under a condition.

### do

The steps, run top to bottom after the checks pass. Each step sees the record as the earlier steps left it.

```mx "src/domain/billing/invoice.mesh.mx"
import { recordAuditEvent } from "./invoice.helpers"

entity :Invoice
  attributes
    uuid :id primary-key
    string :status
    decimal :amount
    datetime :paidAt nullable
    uuid :paidById nullable
    boolean :needsReview default=false

  relationships
    belongs-to=:Customer :customer

  actions
    update :pay accept=[:paidAt]
      do
        set
          :status=:paid
          :paidById=({ actor }) => actor.id
        when=({ self }) => self.amount > 10000
          set
            :needsReview=true
        load=[:customer]
        run({ self, input, actor }) {
          recordAuditEvent("invoice.paid", { id: self.id, by: actor.id });
        }
```

| Step | What it does |
|:--|:--|
| `set` | Assigns fields. Each child line is `:field=value`, and the value is a literal or a one-expression arrow that sees the four parameters |
| `when=cond` | Runs the steps nested under it only when the condition holds. Steps at the same level run in the order written |
| `load=[...]` | Loads relationships and computed fields onto the record this action returns. It writes nothing |
| `run(…) { }` | Plain code inside the transaction, for the one thing a `set` cannot say. It cannot be translated, so the action reads the record first and writes second |

A `run` body is your own code and may call anything, including a function that writes to a log or sends a message: the rule that imported helpers must be pure applies to **translated expressions**, because Mesh may run those inside the database query. `run` is never translated, so the purity rule does not apply to it.

Reach for `run` only when the work is not a field assignment: calling something outside the database, recording an event, formatting a value another system will read. If the work is a value on a field, it is a `set` line. A `run` step always makes the action read first and write second, and so does an expression Mesh cannot translate in a `check`, a `when` or a `set` value — that is not an error either; `mesh explain` names the expression that caused it. The rule for whether an update is one statement or two is in [Calling actions](./calling-actions.md#update).

### Reads: filter and sort

A read has two options of its own, and nothing else:

```mx "src/domain/billing/invoice.mesh.mx"
entity :Invoice
  attributes
    uuid :id primary-key
    string :status
    date :dueOn

  actions
    read :overdue
      filter=({ self }) => self.status === :sent
      sort=[:dueOn]
```

**`filter=`** is a function returning a boolean, and it must be translatable, because it runs as the query's `WHERE`. The caller's own filter and the policies are combined with it before the query is sent, so a read can only ever return fewer rows, never more.

**`sort=`** is a list of field or computed names as atoms, ascending, with `-` in front for descending. In your TypeScript the caller's `sort` uses the same names as strings, because that is what an atom is at run time. Paging is the caller's: `limit` and `offset` in the input. See [Calling actions](./calling-actions.md#filters-sort-and-paging).

### always

`always` takes the body of an action and applies it to every action in its scope. It is how a rule that applies to everything is written once. Its checks run before the action's own checks, and its steps before the action's own steps.

```mx "src/domain/billing/invoice.mesh.mx"
entity :Invoice
  attributes
    uuid :id primary-key
    decimal :amount min=0
    date :issuedOn
    date :dueOn

  actions
    always types=[:create, :update]
      validate
        check :dueAfterIssue [
          that=({ self }) => self.dueOn >= self.issuedOn
          code="invalid_dates"
          message="the due date cannot be before the issue date"
        ]

    create :create accept=[:amount, :issuedOn, :dueOn]
```

`always` takes the same `types=` and `actions=` a policy takes, and may hold `validate`, `do` or both. `types=[:create, :update]` means every create and every update; `actions=[:send, :pay]` means those two by name; neither means every action in the entity.

## policies

One policy per line, with a name, a scope and checks.

```mx "src/domain/billing/invoice.mesh.mx"
import { isStaff } from "./invoice.helpers"

entity :Invoice
  attributes
    uuid :id primary-key
    string :status

  relationships
    belongs-to=:Customer :customer

  policies
    policy :staffOrOwnerReads types=[:read]
      authorize-if=({ self, actor }) => isStaff(actor) || self.customer.userId === actor.id
    policy :staffWrites types=[:create, :update, :destroy]
      authorize-if=({ actor }) => isStaff(actor)
    policy :neverDestroyPaid types=[:destroy]
      forbid-if=({ self }) => self.status === :paid
```

**How a policy decides.** The checks inside one policy combine without order: it passes when none of its `forbid-if` holds and, if it has any `authorize-if`, at least one of them holds, so a policy with only `forbid-if` checks passes until one of them is true. Every policy covering an action must pass, and an action that no policy covers is **forbidden** — as is every action of an entity with no `policies` section at all. Forgetting a rule must not open an action.

| Option | Meaning |
|:--|:--|
| `types=[...]` | Any action whose type is **any** of those. `types=[:read]` is every read |
| `actions=[...]` | Those actions by name. `actions=[:send, :pay]` |
| neither | Every action of the entity |

The list inside `types=` is "or". Two policies are "and": every policy that covers an action must pass.

| Check | Meaning |
|:--|:--|
| `authorize-if=` | The call is allowed when at least one of them holds |
| `forbid-if=` | The call is refused when any of them holds |

An exemption is written in the condition rather than as an escape hatch: `forbid-if=({ self, actor }) => self.status === :paid && !isStaff(actor)` forbids the destroy of a paid invoice to everyone but staff.

When a check reads the stored row, Mesh folds it into the statement's filter, so a row the caller may not see is reported as not found rather than forbidden. `can<Action>` is how you ask for the reason instead. A `create` policy sees the record the create would write, and reading a related row there is a query inside the transaction before the insert.

## Building one

```bash
bunx mesh build
```

The build rejects a declaration, an option or a value outside this reference, an `accept` naming a field the entity does not have, a `do` step that sets a field the entity does not have, two entities with the same name, two entities in one file, a `check` with no `that`, an `on:load` naming a read that does not exist, an expression the database cannot run where it must, and a data-layer capability the configured adapter does not declare. Every diagnostic names the file, the line and the column:

```text
src/domain/todo/todo.mesh.mx:18:20 error `accept` names :titel, which is not an attribute of :Todo. Did you mean :title?
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
| `attributes` | `type :name options`, required unless `nullable` | `string :title min=1` |
| `relationships` | `kind=:Destination :name`, and `nullable` makes it optional | `belongs-to=:List :list` |
| `computed` | `type :name({ self }) { … }`, or a rollup with `of=` a path | `count :todoCount of="todos"` |
| `actions` | `type :name options`, with `arguments`, `validate` and `do` inside | `update :send` |
| `policies` | `policy :name`, a scope (`types=`, `actions=`) and `authorize-if` / `forbid-if` | `policy :owner types=[:read]` |

## A larger example

One file that puts most of the above together: `src/domain/billing/invoice.mesh.mx`. It is not a file to copy; it is here because a reader who has followed the sections can check their understanding against it.

```mx "src/domain/billing/invoice.mesh.mx"
// src/domain/billing/invoice.mesh.mx
import { formatMoney, isStaff } from "./invoice.helpers"

entity :Invoice table="invoices"
  attributes
    uuid :id primary-key
    string :number unique match=/^INV-\d+$/
    enum :status values=[:draft, :sent, :paid, :cancelled] default=:draft
    decimal :amount min=0
    date :issuedOn
    date :dueOn
    datetime :paidAt nullable
    string :notes nullable max=2000
    boolean :needsReview default=false
    uuid :paidById nullable
    timestamp :insertedAt on=:create
    timestamp :updatedAt on=:update

  relationships
    belongs-to=:Customer :customer
    has-many=:InvoiceLine :lines
    has-one=:Payment :payment

  computed
    boolean :isOverdue({ self }) {
      return self.status === :sent && self.dueOn < today()
    }
    string :label({ self }) {
      return self.number + " · " + formatMoney(self.total)
    }
    count :lineCount of="lines"
    sum :total of="lines.amount"

  actions auto=[:read, :destroy] on:load=:visible
    always types=[:create, :update]
      validate
        check :dueAfterIssue [
          that=({ self }) => self.dueOn >= self.issuedOn
          code="invalid_dates"
          message="the due date cannot be before the issue date"
        ]

    create :create accept=[:number, :customerId, :amount, :issuedOn, :dueOn, :notes]

    update :send
      validate
        check :invoiceHasLines [
          that=({ self }) => self.lineCount > 0
          code="invalid_state"
          message="an invoice needs at least one line"
        ]
      do
        set
          :status=:sent

    update :pay accept=[:paidAt]
      validate
        check :invoiceIsSent [
          that=({ self }) => self.status === :sent
          code="invalid_state"
          message="only a sent invoice can be paid"
        ]
        check :invoiceHasLines [
          that=({ self }) => self.lineCount > 0
          code="invalid_state"
          message="an invoice needs at least one line"
        ]
      do
        set
          :status=:paid
          :paidById=({ actor }) => actor.id
        when=({ self }) => self.amount > 10000
          set
            :needsReview=true
        load=[:customer]

    update :applyDiscount
      arguments
        decimal :percent min=0 max=100
      do
        set
          :amount=({ self, input }) => self.amount * (1 - input.percent / 100)

    read :visible
      filter=({ self }) => self.status !== :cancelled

    read :overdue
      filter=({ self }) => self.isOverdue
      sort=[:dueOn]

    read :forCustomer
      arguments
        uuid :customerId
      filter=({ self, input }) => self.customerId === input.customerId

  policies
    policy :staffOrOwnerReads types=[:read]
      authorize-if=({ self, actor }) => isStaff(actor) || self.customer.userId === actor.id
    policy :staffWrites types=[:create, :update, :destroy]
      authorize-if=({ actor }) => isStaff(actor)
    policy :neverDestroyPaid types=[:destroy]
      forbid-if=({ self }) => self.status === :paid
```

Six things to notice in it:

- **`customerId` is not declared.** `belongs-to=:Customer :customer` created it, and `create` accepts it by that name.
- **`decimal :amount min=0` is the whole of "not negative"**, and the `always` block holds the one rule that needs two fields, `dueAfterIssue`, instead of restating it.
- **`:pay` sets three fields and then, under `when`, a fourth.** Steps at the same level run in order, and the nested ones only when the condition holds.
- **`read :forCustomer` takes an argument**, and the filter compares it against `input.customerId`. A read may be as parameterised as a write.
- **`:label` calls a helper on `self`**, so it runs in memory. That is not a mistake, and nobody writes a second statement to avoid it; `read :overdue` filters on `:isOverdue`, which is one translatable expression, so it runs in SQL.
- **`neverDestroyPaid` is a `forbid-if`, and nothing else.** It forbids while the invoice is paid, and passes otherwise, which is what lets every other destroy through.

## Next

- [Calling actions](./calling-actions.md) — what the generated functions take and return.
- [Configuration and the command line](./configuration.md) — the file that points Mesh at this one, and every command.

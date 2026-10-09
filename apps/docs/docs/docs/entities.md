---
title: "Entities"
description: "Every declaration an entity file may use: attributes, relationships, computed fields, actions, validations, steps and policies."
---

# Entities

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

An entity file is one `.mesh.mx` file in your project's domain folder. It holds one entity: its data, the operations on it, and the rules around those operations. This page is the reference for the whole file, in the order you would write it.

Everything here is MX syntax. **Indentation nests**, and **a declaration is `kind :name options`**. A block starts with its tag and continues until the indentation changes.

## Names and references

Three spellings tell you what a name means: **`:name` declares**, **`&name` refers to a member of this entity**, and **an imported `Name` is another entity**.

| It is | Written | Examples |
|:--|:--|:--|
| A declaration | `kind :name` | `entity :Invoice`, `uuid :id`, `update :pay`, `check :invoiceIsSent` |
| A member of this entity | `&name` | `&title` in `input`, `asc &dueOn`, `load=[&customer]`, `actions=[&pay]`, `on:load=&visible` |
| Another entity | an imported identifier | `import { Customer } from "./customer.mesh.mx"`, then `belongs-to :customer entity=Customer` |
| One of a fixed set | an atom | `auto=[:read, :destroy]`, `types=[:create, :update]`, `on=:create` |
| An enum value | an atom | `values=[:draft, :sent]`, `default=:draft`, `&status === :sent`, `&status=:paid` |
| Text | a string | `table="invoices"`, `message="…"`, `code="invalid_state"` |
| A path through relationships | a string | `of="lines.amount"`, `of="lines"` |
| A pattern, a number, a boolean | as in TypeScript | `match=/^INV-\d+$/`, `min=0`, `default=false` |

An **atom** is a name that stands for itself, not a string. It names a declaration or a value from a fixed set. At run time it is its name as a string: `values=[:draft, :sent]` gives TypeScript the union `"draft" | "sent"`, and your program compares with `invoice.status === "sent"`.

A **member reference** points at something declared in this entity: an attribute, relationship, computed field, action, check or policy. Inside a function, `&status` reads the record's status. A name that is not a member is a build error at that position, with a suggestion: `&titel` suggests `&title`. Strings cannot stand in for member references, and an atom cannot stand in for text: `message=:oops` is an error.

A `.mesh.mx` file exports its entity under its declared name. Import that name by relative path, then use it in `entity=Customer`. There is no project-wide name lookup and no qualified-name spelling.

### One input section

An action's `input` is the whole of what the caller may send. Each line is one of two things:

- **`&title`** takes the declared attribute as it is: its type and rules come from the attribute line. No options are allowed on an `&` line. **`&list`** takes a declared `belongs-to`; the caller sends the related record's id.
- **`decimal :percent min=0 max=100`** declares an argument with the same shape as an attribute. It is not stored as sent, and reaches code as `input.percent`.

The same name twice in one `input` is a build error, including a member reference and an argument with that name. A read can take an `input` too. The [actions section](#actions) shows both forms in use.

### Static files

An entity file is static: it has no conditionals or loops that add or remove declarations. A condition belongs on the line it conditions, as `when=` on a policy or a check, or inside its expression. A rule over a has-many is an expression such as `&lines.every(...)`, not a loop that creates checks. Expressions still obey the [translation rules](#what-a-translated-arrow-may-use) where SQL is required.

Names and lists are written out, not computed from variables. Imported entity identifiers and function-valued options are the explicit exceptions; Mesh does not run the file to discover its declarations.

## The shape of a file

This is the same file the [Introduction](./index.md) shows and the [tutorial](./tutorial.md) builds.

```mx "src/domain/todo/todo.mesh.mx"
import { List } from "./list.mesh.mx"

entity :Todo table="todos"
  attributes
    uuid :id primary-key
    string :title min=1
    boolean :done default=false
    timestamp :insertedAt on=:create
    timestamp :updatedAt on=:update

  relationships
    belongs-to :list entity=List

  computed
    string :label() {
      return (&done ? "[x] " : "[ ] ") + &title
    }

  actions auto=[:read, :destroy]
    create :create
      input
        &title
        &list

    update :complete
      validate
        check :notDoneYet [
          that=() => !&done
          code="already_done"
          message="this todo is already complete"
        ]
      do
        set
          &done=true

    update :rename
      input
        &title

    read :pending
      filter=() => &done === false
      sort
        asc &insertedAt

  policies
    policy :owner types=[:create, :read, :update, :destroy]
      authorize-if=({ actor }) => &list.ownerId === actor.id
```

**Sections group declarations.** `attributes`, `relationships`, `computed`, `actions` and `policies` may be in any order, empty or left out. Inside an action are `input`, `validate` and `do`: validation happens before the steps, however you order those sections. Steps inside `do` run in order. An action no policy covers is forbidden, so a file with no `policies` can be built but nothing in it can be called.

**Indentation nests.** A line at the left margin ends the block before it, including a comment. A comment inside an entity is a `//` line indented with the block it belongs to.

**Values are written out.** An atom, string, number, regular expression, boolean, list or object is a literal. A member reference and an imported entity have the meanings above. The places whose value is code — `filter`, `when`, `authorize-if`, `forbid-if`, a check's `that`, a `set` value and a computed field's body — take functions.

**One expression can be translated.** An arrow `(…) => …`, or a method body with a single `return`, can run inside a database query. A body that cannot be translated runs in memory. Where SQL is required — a filter, sort key or policy check — an expression that cannot be translated is a build error naming the line.

**Functions receive four things.** `self` is the whole record, `input` is what the caller sent, `actor` is who is calling and `context` is the rest of the call. Use `&name` to read a member; a function that reads only members takes no parameters. Destructure `input`, `actor` or `context` when you use them. Destructure `self` when you pass the whole record to a helper, such as `isOwner(self, actor)`. [What `self` holds](#what-self-holds) depends on where the function runs.

**Hand-written code is imported.** A helper sits beside the entity and is an ordinary TypeScript module:

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

  policies
    policy :staffWrites types=[:create, :update, :destroy]
      authorize-if=({ actor }) => isStaff(actor)
```

Only relative, named imports of files inside `src/domain/` are allowed. An imported helper in a translated expression must be pure: it may not read the clock, the network or anything Mesh did not hand it. A helper that does not read the record, such as `isStaff(actor)`, runs once before the query and enters SQL as a bound value. A `run` step is different: it is plain code and may call anything.

### What a translated arrow may use

Comparisons, `&&`, `||`, `!`, numeric `+ - * /`, `.length`, `today()`, member reads such as `&amount`, the function's parameters, and imported pure helpers that do not read the record. String concatenation, a conditional on a string and helpers that read the record run in memory. The build tells you if one appears where the database is required. Do not add a second statement to opt out of translation: Mesh already makes that decision.

## The entity line

| Option | Required | Meaning |
|:--|:--|:--|
| `:Todo` | yes | The entity's declared name, in PascalCase; also its named export |
| `table` | no | The database table; defaults to the entity's name in snake_case |

The folder that holds the file is the module. Entities in `src/domain/todo/` belong together; no line repeats the folder's name. Another entity is imported by relative path. Two folders may each declare an `entity :List` without conflict: their paths distinguish them. Those declarations do not conflict, but how the generated `#mesh` entry point exposes their same-named action exports is still open ([finding 21](../architecture/open-questions.md#dx-findings)). See [Project structure](./project-structure.md#the-domain).

## attributes

One line per stored field: the type is the tag, `:name` is the field.

```mx "src/domain/post/post.mesh.mx"
entity :Post
  attributes
    uuid :id primary-key
    string :title min=1
    enum :status values=[:draft, :published] default=:draft
    string :notes nullable max=2000
    integer :views default=0
    float :rating default=0
    decimal :price min=0
    datetime :publishedAt nullable
    timestamp :insertedAt on=:create
    timestamp :updatedAt on=:update
```

### The types

| Tag | TypeScript | What it holds |
|:--|:--|:--|
| `uuid` | `string` | A UUID; Mesh generates a `primary-key` value on create |
| `string` | `string` | Text |
| `integer` | `number` | A whole number: a count or position |
| `float` | `number` | A fraction where the exact value does not matter |
| `decimal` | `number` | An exact fraction: money or a tax rate |
| `boolean` | `boolean` | True or false |
| `enum` | the union of `values` | One of a fixed set |
| `date` | `Date` | A calendar date, with no time of day |
| `datetime` | `Date` | A date and time with no time zone, in the server's local time |
| `timestamp` | `Date` | A moment, always with its time zone |

`integer`, `float` and `decimal` are all `number` in TypeScript, but a whole number, a money amount and a measurement are different things to store. An atom may be compared with, or assigned to, an `enum` field only: `&status === :sent` is an error if `status` is a `string`.

### Options on an attribute line

| Option | Meaning |
|:--|:--|
| `primary-key` | The entity's one primary key, filled by Mesh on create |
| `nullable` | The field may be absent or null; every other attribute is required |
| `default=` | A literal that fits the type |
| `values=` | An enum's allowed atoms; an empty list, blank or repeat is a build error |
| `unique` | The database refuses a second row with that value |
| `min=`, `max=` | A string's length bounds or a number's value bounds |
| `match=` | A regular expression a string must match |
| `on=:create`, `on=:update` | On a timestamp: fill on insert, or on insert and every later write; callers cannot set it |

`on=:create` and `on=:update` are unrelated to `on:load` on `actions`, which chooses a read.

A field name may not be one of JavaScript's built-in object property names: `__proto__`, `constructor`, `prototype`, `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`, `toString`, `valueOf`, `__defineGetter__`, `__defineSetter__`, `__lookupGetter__` or `__lookupSetter__`. Mesh cannot validate a value safely against those.

## relationships

Each relationship is `kind :name entity=ImportedName`:

```mx "src/domain/todo/todo.mesh.mx"
import { List } from "./list.mesh.mx"
import { Comment } from "./comment.mesh.mx"
import { Attachment } from "./attachment.mesh.mx"

entity :Todo
  attributes
    uuid :id primary-key

  relationships
    belongs-to :list entity=List
    has-many :comments entity=Comment
    has-one :attachment entity=Attachment
```

| Kind | What it gives you |
|:--|:--|
| `belongs-to` | Many todos belong to one list; the key column is on this entity, and `todo.list` arrives when you load it |
| `has-many` | One todo has many comments; the key is on the other entity, and `todo.comments` arrives when loaded |
| `has-one` | At most one attachment, through that entity's own `belongs-to`; its foreign key is unique |

Add `nullable` to a `belongs-to` when a related row is optional. A caller sets the relationship through `&list` in `input`, sending the list's id. The entity file names the relationship, never its generated key column; [Using your domain](./using-your-domain.md#relationship-input-and-record-fields) explains the TypeScript surface.

Two entity files may import each other: `todo.mesh.mx` imports `List` while `list.mesh.mx` imports `Todo`. The other side is not automatic. The list knows nothing about its todos until `list.mesh.mx` imports `Todo` and declares `has-many :todos entity=Todo`.

## computed

Values Mesh derives rather than stores. Two kinds of line, one section:

```mx "src/domain/billing/invoice.mesh.mx"
import { InvoiceLine } from "./invoice-line.mesh.mx"
import { formatMoney } from "./invoice.helpers"

entity :Invoice
  attributes
    uuid :id primary-key
    string :number
    enum :status values=[:draft, :sent]
    decimal :amount
    date :dueOn

  relationships
    has-many :lines entity=InvoiceLine

  computed
    boolean :isOverdue() {
      return &status === :sent && &dueOn < today()
    }
    string :label() {
      return &number + " · " + formatMoney(&amount)
    }
    count :lineCount of="lines"
```

**A field with a body.** A type, a `:name`, parameters and a body. Leave the parameters empty when it reads only members; add `actor` when it depends on who is asking.

**A rollup.** A kind, a `:name` and `of=`, a path through relationships. The path is a string even with one step. `load=[&lines]` is a member reference instead, not a path.

| Rollup | Result |
|:--|:--|
| `count :lineCount of="lines"` | How many rows the path reaches |
| `sum :total of="lines.amount"` | The total of a numeric field |
| `avg :averageAmount of="lines.amount"` | Its average |
| `min :firstDueOn of="lines.dueOn"` | The smallest value |
| `max :lastDueOn of="lines.dueOn"` | The largest value |

Paths are checked at build time. Inside the entity, checks, steps, filters and policies can read `&lineCount` without asking. A caller sees a computed field only when they name it in `load`; otherwise reading it is a type error.

A computed body that cannot be translated runs in memory after the rows load, at the cost of an extra pass. `label` above is one of those, and that is not a mistake. An error arises only where SQL is required: a filter, a sort key, a policy, a rollup's path or another translated expression. `mesh explain` says which computed fields translate.

## actions

`actions auto=[:read, :destroy]` generates the plain actions of those types, named after the type. You may list `:create`, `:read`, `:update` or `:destroy`, with no repeats. Every action you write yourself is `type :name`.

**`on:load=&visible`** chooses the read used when this entity is loaded through a relationship. That read's filter applies. Without it, Mesh uses the auto read. Naming a missing read is a build error, as is loading an entity that has neither choice.

### input

An `input` section lists member references and declares arguments. A create must receive every input member that is required and has no default. On an update, member inputs are optional: the caller sends what changes. A typed argument is required unless `nullable`. A create's required attribute must be supplied through input, have a default, be filled by Mesh or be set by a step; otherwise the build fails.

```mx "src/domain/billing/invoice.mesh.mx"
entity :Invoice
  attributes
    uuid :id primary-key
    decimal :amount min=0

  actions
    create :create
      input
        &amount

    update :applyDiscount
      input
        decimal :percent min=0 max=100
      do
        set
          &amount=({ input }) => &amount * (1 - input.percent / 100)
```

Call `applyDiscountInvoice({ id, percent: 10 }, context)`. The percentage reaches the expression as `input.percent`; no field stores "10% off". A member line takes the declaration unchanged, while a typed line is a new argument. An action without `input` takes no declared fields; an update or destroy still takes its id.

Options such as `auto=`, `on:load=`, `types=` and `actions=` sit on the declaration line. Sections such as `input`, `validate`, `do` and `sort` have their own lines.

### validate

Checks run before anything is written, on the record with the member inputs applied. A rule about one field goes on its declaration: `decimal :amount min=0` says the whole of "the amount cannot be negative". A `check` is for a cross-field or stored-state rule:

```mx "src/domain/billing/invoice.mesh.mx"
entity :Invoice
  attributes
    uuid :id primary-key
    date :issuedOn
    date :dueOn

  actions
    create :create
      input
        &issuedOn
        &dueOn
      validate
        check :dueAfterIssue [
          that=() => &dueOn >= &issuedOn
          code="invalid_dates"
          message="the due date cannot be before the issue date"
        ]
```

A line rule carries Mesh's standard message: `string :title min=1` reports `too_short` and "must be at least 1 character". A check is where you write your own message.

The atom after `check` names the rule and is the label the caller sees. Name what must hold: `check :invoiceIsSent`, not the failure you are trying to avoid. Brackets let the options span several lines.

| Option | Meaning |
|:--|:--|
| `that=` | A function returning a boolean |
| `code=` | The caller-facing code, a string or number, on the issue rather than the error |
| `message=` | The sentence the caller sees |
| `when=` | Apply this check only when the condition holds |

A failed check throws `InvalidInputError`, whose own code is always `invalid_input`. Each failure has its own entry in `error.issues`, with the label, code, message and source position of the check. Several checks may fail in one call.

#### A check that reads a related record

A check may read through a `belongs-to`, including a rollup on the related entity. This one limits a free-plan owner to 20 todos:

```mx "src/domain/todo/todo.mesh.mx"
import { User } from "./user.mesh.mx"

entity :Todo
  attributes
    uuid :id primary-key
    string :title min=1

  relationships
    belongs-to :owner entity=User

  actions
    create :create
      input
        &title
        &owner
      validate
        check :underQuota [
          that=() => &owner.todoCount < 20
          when=() => &owner.plan === :free
          code="quota_exceeded"
          message="free plan allows 20 todos"
        ]
```

`&owner.todoCount` is a related read. It runs inside the transaction, as a policy's related-row read does. The rollup lives on `User`, which also holds the `plan` that `when` compares with an atom. That comparison works because `plan` is an [`enum`](#the-types).

```mx "src/domain/todo/user.mesh.mx"
import { Todo } from "./todo.mesh.mx"

entity :User
  attributes
    uuid :id primary-key
    string :name min=1
    enum :plan values=[:free, :paid] default=:free

  relationships
    has-many :todos entity=Todo

  computed
    count :todoCount of="todos"

  actions
    create :create
      input
        &name

  policies
    policy :self types=[:read, :update]
      authorize-if=({ actor }) => &id === actor.id
```

**Check or policy.** A rule about the data, such as a quota, a date or a total, is a check: it reports a code and a message. A rule about who is calling, such as a plan tier or a role, is a policy. The owner is usually the caller, so `authorize-if=({ actor }) => actor.plan === "paid"` reads the actor and costs no query. `actor` is your program's object, not a member, so the comparison uses a string: an atom is only compared with an `enum` field.

### do

Steps run top to bottom after validation. Each sees the record as earlier steps left it.

| Step | What it does |
|:--|:--|
| `set` | Assigns fields with `&field=value` lines; a value is a literal or a one-expression arrow |
| `when=cond` | Runs the nested steps only when the condition holds |
| `load=[&customer]` | Loads relationships or computed fields onto the returned record; writes nothing |
| `run(…) { }` | Plain code inside the transaction; forces a read before the write |

The larger example below shows `set`, `when` and `load`. For the work a field assignment cannot express, use `run`:

```mx "src/domain/billing/invoice.mesh.mx"
import { recordAuditEvent } from "./invoice.helpers"

entity :Invoice
  attributes
    uuid :id primary-key

  actions
    update :audit
      do
        run({ self, actor }) {
          recordAuditEvent(self, actor);
        }
```

A `run` body may call anything, including logging or messaging code. The pure-helper rule applies to translated expressions, not `run`. Reach for it only when the work is not a field assignment. A `run`, or an untranslatable check, `when` or `set` expression, makes the action read first and write second. [Using your domain](./using-your-domain.md#update) explains one statement versus two.

### Reads: filter and sort

A read may take `input` arguments as well as a filter and sort:

```mx "src/domain/billing/invoice.mesh.mx"
import { Customer } from "./customer.mesh.mx"

entity :Invoice
  attributes
    uuid :id primary-key
    date :dueOn
    timestamp :insertedAt on=:create

  relationships
    belongs-to :customer entity=Customer

  actions
    read :forCustomer
      input
        uuid :customerId
      filter=({ input }) => &customer.id === input.customerId
      sort
        asc &dueOn
        desc &insertedAt
```

`filter=` returns a boolean and must translate to SQL. The caller's filter and the policies narrow it further. `&customer.id` compares the related record's id without a join.

`sort` has one line per field, in order: `asc &dueOn` for oldest first, `desc &insertedAt` for newest first. A sort key may be a translatable computed field. The caller uses strings instead: `sort: ["dueOn", "-insertedAt"]`. Paging belongs to the caller's `limit` and `offset`. See [Using your domain](./using-your-domain.md#filters-sort-and-paging).

### always

`always` takes an action body and applies it across a scope. Its checks run before the action's checks, and its steps before the action's steps. It may hold `validate`, `do` or both.

The larger example uses `always types=[:create, :update]` for a date rule on every create and update. `actions=[&send, &pay]` instead names particular actions. Neither option means every action in the entity.

## policies

One policy per line, with a name, a scope and checks. The larger example below shows all three common patterns: owners or staff may read; staff may write; nobody may destroy a paid invoice.

| Option | Scope |
|:--|:--|
| `types=[:read]` | Every action of any listed type |
| `actions=[&send, &pay]` | Those actions by name |
| neither | Every action in the entity |
| `when=` | Apply the policy only when the condition holds |

A policy passes when none of its `forbid-if` checks holds and, if it has any `authorize-if`, at least one holds. The checks combine without order. A policy with only `forbid-if` passes until one is true. Every policy covering the action must pass; an action no policy covers is forbidden, including every action in an entity with no policies.

An exemption belongs in the condition: `forbid-if=({ actor }) => &status === :paid && !isStaff(actor)` forbids destroying a paid invoice except for staff.

When a check reads the stored row, Mesh folds it into the statement's filter. A row the caller cannot see is reported as not found rather than forbidden; `can<Action>` asks for the reason instead. A create policy sees the proposed record, and a related-row read there is a query inside the transaction before the insert.

## Building one

```bash
mesh build
```

The build rejects unknown declarations, options and members, a member input with options, duplicate input names, two entities in one file, a check without `that`, an `on:load` that does not name a read, an expression that cannot run in SQL where it must, and a capability the adapter does not declare. Each diagnostic names the file, line and column:

```text
src/domain/todo/todo.mesh.mx:22:9 error &titel is not a member of :Todo. Did you mean &title?
```

Run `mesh inspect Todo` to see the declarations with source positions, and `mesh explain Todo complete` to see the action's plan. Both are in [Command line](./command-line.md).

## What `self` holds

`&name` reads a member of this record. `input` is always the caller's object, `actor` the caller and `context` the rest of the action context.

| Where | The record is |
|:--|:--|
| a check in `validate` | The record with member inputs applied: caller values for supplied fields, stored values for omitted ones, defaults on create; nothing from `do` yet. Related records (`&owner.todoCount`) are read on demand |
| a step in `do` | The record as earlier steps left it |
| a filter on a read | Each row the query considers |
| a policy on a read | The row |
| a policy on an update or destroy | The stored record |
| a policy on a create | The proposed record: member inputs and defaults |
| a computed field | The loaded record |

## In short

| Section | A line looks like | Example |
|:--|:--|:--|
| `attributes` | `type :name options` | `string :title min=1` |
| `relationships` | `kind :name entity=ImportedName` | `belongs-to :list entity=List` |
| `computed` | `type :name() { … }` or a rollup | `count :todoCount of="todos"` |
| `actions` | `type :name`, with `input`, `validate`, `do` | `update :send` |
| `policies` | `policy :name`, scope and checks | `policy :owner types=[:read]` |

## A larger example

One file that puts most of the above together. It is here to check your understanding of the sections, rather than to copy into the todo program.

```mx "src/domain/billing/invoice.mesh.mx"
// src/domain/billing/invoice.mesh.mx
import { Customer } from "./customer.mesh.mx"
import { InvoiceLine } from "./invoice-line.mesh.mx"
import { Payment } from "./payment.mesh.mx"
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
    belongs-to :customer entity=Customer
    has-many :lines entity=InvoiceLine
    has-one :payment entity=Payment

  computed
    boolean :isOverdue() {
      return &status === :sent && &dueOn < today()
    }
    string :label() {
      return &number + " · " + formatMoney(&total)
    }
    count :lineCount of="lines"
    sum :total of="lines.amount"

  actions auto=[:read, :destroy] on:load=&visible
    always types=[:create, :update]
      validate
        check :dueAfterIssue [
          that=() => &dueOn >= &issuedOn
          code="invalid_dates"
          message="the due date cannot be before the issue date"
        ]

    create :create
      input
        &number
        &customer
        &amount
        &issuedOn
        &dueOn
        &notes

    update :send
      validate
        check :invoiceHasLines [
          that=() => &lineCount > 0
          code="invalid_state"
          message="an invoice needs at least one line"
        ]
      do
        set
          &status=:sent

    update :pay
      input
        &paidAt
      validate
        check :invoiceIsSent [
          that=() => &status === :sent
          code="invalid_state"
          message="only a sent invoice can be paid"
        ]
        check :invoiceHasLines [
          that=() => &lineCount > 0
          code="invalid_state"
          message="an invoice needs at least one line"
        ]
      do
        set
          &status=:paid
          &paidById=({ actor }) => actor.id
        when=() => &amount > 10000
          set
            &needsReview=true
        load=[&customer]

    update :applyDiscount
      input
        decimal :percent min=0 max=100
      do
        set
          &amount=({ input }) => &amount * (1 - input.percent / 100)

    read :visible
      filter=() => &status !== :cancelled

    read :overdue
      filter=() => &isOverdue
      sort
        asc &dueOn

    read :forCustomer
      input
        uuid :customerId
      filter=({ input }) => &customer.id === input.customerId

  policies
    policy :staffOrOwnerReads types=[:read]
      authorize-if=({ actor }) => isStaff(actor) || &customer.userId === actor.id
    policy :staffWrites types=[:create, :update, :destroy]
      authorize-if=({ actor }) => isStaff(actor)
    policy :neverDestroyPaid types=[:destroy]
      forbid-if=() => &status === :paid
```

Six things to notice:

- **`&customer` takes the customer's id.** The relationship points at the imported `Customer`, and the create takes it through `input`.
- **`decimal :amount min=0` says "not negative".** The `always` block holds the rule that needs two fields, `check :dueAfterIssue`.
- **`pay` stores its input and makes changes in order.** It takes `&paidAt`, sets the status and payer, and marks a large invoice for review under `when`.
- **`read :forCustomer` declares an argument.** `input.customerId` is compared with `&customer.id`, without a join. It is an input name, not a stored field declared in the file.
- **`label` calls a helper on `&total`.** It runs in memory; `isOverdue` is one translatable expression and may be used in a SQL filter.
- **`policy :neverDestroyPaid` has only `forbid-if`.** It forbids while paid and passes otherwise.

## Next

- [Using your domain](./using-your-domain.md) — what the generated functions take and return.
- [Configuration](./configuration.md) — the project, adapters and extensions.
- [Command line](./command-line.md) — every `mesh` command.

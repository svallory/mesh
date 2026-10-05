---
title: "Entities"
description: "Every declaration an entity file may use: attributes, relationships, computed fields, actions, validations, steps, policies, with the eleven rules to remember."
---

# Entities

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

An entity file is one `.mesh.mx` file in your project's domain folder. It holds one entity: its data, the operations on it, and the rules around those operations. This page is the reference for the whole file, in the order you would write it.

Everything here is [Marko](https://markojs.org)'s concise syntax: indentation, no angle brackets. A block starts with its tag and continues until the indentation changes.

## The eleven rules

These are all the rules there are. Read them once; every section below is an example of one of them.

1. A declaration is `kind #name options`: the tag says what it is, `#name` names it. Names are unique within their scope.
2. Sections group declarations: `attributes`, `relationships`, `computed`, `actions`, `policies`; inside an action: `arguments`, `validate`, `do`.
3. An attribute's type is its tag. Attributes are required unless marked `nullable`. Shape rules for one field (`min`, `max`, `match`) go on its line.
4. A relationship names its destination entity as the tag's value: `has-many=InvoiceLine #lines`.
5. A computed field is either a typed field with a body, or a rollup (`count`, `sum`, …) with `of=` a path.
6. Functions receive `{ self, input, actor, context }`. A one-expression arrow is translated (it also runs in SQL); a block body is plain code.
7. `actions auto=[...]` generates the plain actions of those types, named after the type. Every written action is `type #name`. `on:load="name"` says which read Mesh uses when it loads this entity through a relationship; without it, the auto read.
8. `validate` runs first, on the stored record plus `input`: `require=[...]` and `check :label [ that code message ]`. `do` runs next, top to bottom: `set` with `#field=value` lines, `when=cond` with nested steps, `load=[...]`, `run(…) { }` for one-off code.
9. `always` under `actions` takes an action body and applies it to every action in its scope.
10. A policy has a scope (`types=`, `actions=`, or neither, for all) and checks. Every policy covering an action must pass; an action no policy covers is forbidden.
11. Files end in `.mesh.mx`; one entity per file; the folder under `src/domain/` is the module.

## The shape of a file

```mx "src/domain/todo/todo.mesh.mx"
entity #Todo table="todos"
  attributes
    uuid #id primary-key
    string #title

  relationships
    belongs-to=List #list nullable

  actions auto=["read", "destroy"]
    create #create accept=["title", "listId"]
      validate
        check :titleNotEmpty [
          that=({ self }) => self.title.length > 0
          code="empty_title"
          message="title must not be empty"
        ]

  policies
    policy #owner types=["create", "read"]
      authorize-if=({ self, actor }) => self.list.ownerId === actor.id
```

`attributes` is the only section a file needs. Every other section is optional, and every section may be empty. The order of the sections does not matter; the order of the lines inside a section does.

**Values Mesh reads are literals.** A string, a number, `true`, `false`, a list or an object written out in full. The exceptions are the places whose value is code: `filter`, `when`, `authorize-if`, `forbid-if`, the `that` of a `check`, the right-hand side of a `set` line, and a computed field's body. Those take an arrow function or a block.

**Hand-written code is imported.** A `.mesh.mx` file opens with ordinary `import` lines, and the imported functions are usable inside its expressions. The helper sits beside the entity and is a normal TypeScript module:

```ts "src/domain/todo/todo.helpers.ts"
export function titleIsLongEnough(title: string): boolean {
  return title.trim().length > 0;
}
```

```mx "src/domain/todo/todo.mesh.mx"
import { titleIsLongEnough } from "./todo.helpers"

entity #Todo table="todos"
  attributes
    uuid #id primary-key
    string #title

  actions
    create #create accept=["title"]
      validate
        check :titleNotEmpty [
          that=({ self }) => titleIsLongEnough(self.title)
          code="empty_title"
          message="title must not be empty"
        ]
```

Three rules, and nothing more: only relative imports, only of files inside `src/domain/`, only named imports; and an imported function must be pure — it may not read the clock, the network or anything Mesh did not hand it, because Mesh runs it in its own checks and again at run time.

**What else a function body may use.** `self`, `actor`, `context`, the action's `input`, and Mesh's registered functions, which are the operations a rule may use without writing them: comparisons, boolean operators, arithmetic, string `length`, assignment to a field, and `today()`. Anything outside that set is what makes the build tell you a rule cannot run in the database and needs a read first.

## The entity line

| Option | Required | Meaning |
|:--|:--|:--|
| `#Todo` | yes | The entity's name, in PascalCase. Every generated function is named after it, and it must be unique across the domain |
| `table` | no | The database table. Defaults to the entity's name in snake_case |

A relationship names another entity by that same name, so `belongs-to=Todo #author` points at the entity declared as `entity #Todo`.

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
    decimal #views default=0
    datetime #publishedAt nullable
    timestamp #insertedAt on="create"
    timestamp #updatedAt on="update"
```

### The types

| Tag | TypeScript | What it holds |
|:--|:--|:--|
| `uuid` | `string` | A UUID. `primary-key` is how you get one |
| `string` | `string` | Text |
| `enum` | the union of `values` | One of a fixed set: `enum #status values=["draft", "published"]` |
| `decimal` | `number` | A number, whole or not |
| `boolean` | `true` or `false` | |
| `date` | `Date` | A calendar date |
| `datetime` | `Date` | A date and a time of day |
| `timestamp` | `Date` | A moment, written with the time zone |

`status` above is typed `"draft" | "published"` in TypeScript, so a caller that sends `"archvied"` does not compile, and would be rejected at run time if it slipped past.

### Options on an attribute line

| Option | Meaning |
|:--|:--|
| `primary-key` | This is the primary key. An entity has one, and a database row needs one |
| `nullable` | The field may be absent or null. Every other attribute is required |
| `default=` | A literal that fits the type: a number, one of an `enum`'s `values`, `true` or `false` |
| `values=` | On an `enum` only: the allowed values, in full. An empty list, a blank or a repeat is a build error |
| `unique` | The database refuses a second row with the same value |
| `min=`, `max=` | The shortest and longest a `string` may be |
| `match=` | A regular expression a `string` must match |
| `on="create"`, `on="update"` | On a `timestamp`: who fills it. Mesh fills it, and no caller may set it |

`uuid #id primary-key` and the two `timestamp` lines are the three fields almost every entity has, so they are in every example on these pages.

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
| `has-one=Attachment #attachment` | One row at most. It adds a unique foreign key, so two attachments cannot share a todo |

**A `belongs-to` creates its foreign-key attribute from its own name.** `belongs-to=List #list` gives you `listId`; rename the relationship to `#parent` and the attribute is `parentId`. Add `nullable` and the foreign key is optional, which is what you want when the row does not exist yet at the moment it is written.

The other side is not automatic. If `todo` declares `belongs-to=List #list`, the list knows nothing about it until `list.mesh.mx` declares `has-many=Todo #todos`. Both sides are useful: `todo.list` reads one row, `list.todos` reads many.

## computed

Values Mesh derives rather than stores. There are two kinds of line, and one section.

```mx "src/domain/todo/todo.mesh.mx"
entity #Todo
  attributes
    uuid #id primary-key
    string #title
    boolean #done default=false
    date #dueOn nullable

  relationships
    has-many=Comment #comments

  computed
    string #label({ self }) {
      return (self.done ? "[x] " : "[ ] ") + self.title
    }
    boolean #isLate({ self }) {
      return !self.done && self.dueOn < today()
    }
    count #commentCount of="comments"
```

**A field with a body.** A type, a `#name`, the parameters in brackets, and a block. The parameters are `({ self })` in almost every case; add `input` on an action's field, or `actor` when the value depends on who is asking.

**A rollup.** `count` and `sum` take `of=`, a path: a relationship name, or a relationship name and a field (`of="lines.amount"`). `count` gives a number of rows, `sum` the total of a numeric field over them. The path is checked at build time against the generated types, so a wrong path is a build error and not a query that returns nothing.

A computed field exists on a result only when you ask for it by name in `load`. Reading one that was not loaded is a type error.

Mesh decides at build time whether an expression can be translated to SQL. One that can runs inside the query. One that cannot is **opaque**: it runs in memory after the rows are loaded, it cannot appear in a `filter` or a `sort` (the build fails), and it costs one extra pass. String concatenation and a conditional on a string are not translatable; comparison, boolean operators, numeric `+` and `-` and string length are. A rollup always runs in SQL, so it can be filtered on and sorted by. `mesh explain` says which one a field is.

## actions

The operations. `auto` lists the plain actions Mesh generates for you, and every action you write yourself is `type #name`.

```mx "src/domain/todo/todo.mesh.mx"
entity #Todo
  attributes
    uuid #id primary-key
    string #title

  actions auto=["read", "destroy"] on:load="visible"
    create #create accept=["title"]
    update #complete
    read #pending
      filter=({ self }) => self.done === false
```

**`auto`.** Any of `create`, `read`, `update`, `destroy`, no repeats. An action listed there is named after its type, which is why the auto read is `readTodo` and the auto destroy is `destroyTodo`. `auto=["read"]` gives you a read and nothing else; the tutorial's todo also writes its own `create #create`, so it does not list `create` there.

**`on:load`.** `on:load="visible"` says which read Mesh uses when it loads this entity through a relationship — `todo.list` runs the read named `visible`, and that read's `filter` applies. Leave it out and Mesh uses the auto read. When neither is there, and the entity is loaded through a relationship, the build says so.

**`accept`.** A list of field names, with no blanks and no repeats; `accept=[]` is valid and means the action takes only an id. A field that is not accepted and not filled by a step is a build error, not a field silently left empty.

### arguments

An action that takes something of its own declares it, with the same line shape as an attribute:

```mx "src/domain/todo/todo.mesh.mx"
entity #Todo
  attributes
    uuid #id primary-key
    boolean #done default=false

  actions
    update #complete
      arguments
        datetime #completedAt
      do
        set
          #done=true
```

`completeTodo` is then called as `completeTodo({ id, completedAt }, context)`. An argument is required unless it is `nullable`, exactly like an attribute.

### validate

The checks that run before anything is written, in this order: the stored record, plus the caller's `input`, plus whatever earlier steps have set.

```mx "src/domain/todo/todo.mesh.mx"
entity #Todo
  attributes
    uuid #id primary-key
    string #title
    decimal #estimate default=0

  actions
    create #create accept=["title", "estimate"]
      validate
        require=["title"]
        check :titleNotEmpty [
          that=({ self }) => self.title.trim().length > 0
          code="empty_title"
          message="a todo needs a title"
        ]
        check :estimateNotNegative [
          that=({ self, input }) => self.estimate >= 0
          code="invalid_estimate"
          message="the estimate cannot be negative"
        ]
```

**`require=[...]`** lists fields that must be present in the caller's input.

**`check :label [ … ]`** is one rule. The label is the name you give it, and it is what the error carries as the failing check. Inside the brackets:

| Option | Meaning |
|:--|:--|
| `that=` | An arrow function returning a boolean. It sees `self` and `input` |
| `code=` | The caller-facing code, a string or a number. It becomes the error's `code`, so your program can switch on it |
| `message=` | The sentence the caller sees |

A check that fails throws `InvalidInputError` with that `code`, that `message`, and the name of the check, and the issue points at the line of the `check` that declared it. `when=` nests inside `validate` as it does inside `do`, so a rule may apply only under a condition.

### do

The steps, run top to bottom after the checks pass.

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
```

| Step | What it does |
|:--|:--|
| `set` | Assigns fields. Each child line is `#field=value`, and the value is a literal or a one-expression arrow that sees `self`, `input` and `actor` |
| `when=cond` | Runs the steps nested under it only when the condition holds. Steps at the same level run in the order written |
| `load=[...]` | Loads relationships and computed fields for this action's own use, the way a caller would |
| `run(…) { }` | One-off plain code, inside the transaction. It cannot be translated, so it makes the action run read-then-write |

Steps that can be translated are folded into the single statement the adapter sends, so there is no read before the write. `run` is the step that always costs an extra query. `mesh explain` prints which of the two a given action is.

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
      filter=({ self }) => self.status !== "cancelled"
      sort=["dueOn"]
```

**`filter=`** is a function returning a boolean, and it must be translatable to SQL. The caller's own filter and the policies are combined with it before the query is sent, so a read can only ever return fewer rows, never more.

**`sort=`** is a list of field or computed names, ascending, with `-` in front for descending. The caller's `sort` uses the same strings. Paging is the caller's: `limit` and `offset` in the input. See [Calling actions](./calling-actions.md#filters-sort-and-paging).

### always

`always` takes the body of an action and applies it to every action in its scope. It is how a rule that applies to everything is written once.

```mx "src/domain/todo/list.mesh.mx"
entity #List
  attributes
    uuid #id primary-key
    string #name
    uuid #ownerId

  actions auto=["read", "destroy"]
    always types=["create"]
      do
        set
          #ownerId=({ actor }) => actor.id

    create #create accept=["name"]
```

`always` takes the same `types=` and `actions=` a policy takes, and may hold `validate`, `do` or both. `types=["create", "update"]` means every create and every update; `actions=["send", "pay"]` means those two by name; neither means every action in the entity.

## policies

One policy per line, with a name, a scope and checks. An action that no policy covers is **forbidden**: forgetting a rule must not open an action. An entity with no `policies` section at all forbids every action it has.

```mx "src/domain/invoice/invoice.mesh.mx"
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

| Option | Meaning |
|:--|:--|
| `types=[...]` | Any action whose type is **any** of those. `types=["read"]` is every read |
| `actions=[...]` | Those actions by name. `actions=["send", "pay"]` |
| neither | Every action of the entity |

The list inside `types=` is "or". Two policies are "and": every policy that covers an action must pass.

| Check | Meaning |
|:--|:--|
| `authorize-if=` | The call is allowed when this returns true |
| `forbid-if=` | The call is refused when this returns true |

A policy may carry both. `authorize-if` and `forbid-if` on the same line is "allowed, unless".

When a check reads the stored row, Mesh folds it into the statement's filter, so a row the caller may not see is reported as not found rather than forbidden. `can<Action>` is how you ask for the reason instead. A `create` policy sees the record the create would write, and reading a related row there is a query inside the transaction.

## Building one

```bash
bunx mesh build
```

The build rejects a declaration, an option or a value outside this reference, one it does not implement, an `accept` naming a field the entity does not have, a `do` step that sets a field the entity does not have, two entities with the same name, two entities in one file, a `check` with no `that`, an expression that uses something no rule may use, and a data-layer capability the configured adapter does not declare. Every diagnostic names the file, the line and the column:

```text
src/domain/todo/todo.mesh.mx:11:21 error `accept` names "titel", which is not an attribute of Todo. Did you mean "title"?
```

To see what Mesh read, including the source position of every declaration, run `mesh inspect Todo`. To see the plan an action's handler follows, run `mesh explain Todo complete`. Both are in [the command line](./configuration.md).

## A larger example

Everything on one page, in one file: `src/domain/invoice/invoice.mesh.mx`. It is not a file to copy; it is here because it uses every declaration above, and a reader who has followed the sections can check their understanding against it.

```mx "src/domain/invoice/invoice.mesh.mx"
import { formatMoney, isStaff } from "./invoice.helpers"

entity #Invoice table="invoices"
  attributes
    uuid #id primary-key
    string #number unique match=/^INV-\d+$/
    enum #status values=["draft", "sent", "paid", "cancelled"] default="draft"
    decimal #amount
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
        check :amountNotNegative [
          that=({ self }) => self.amount >= 0
          code="invalid_amount"
          message="the amount cannot be negative"
        ]

    create #create accept=["number", "customerId", "amount", "dueOn", "notes"]

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

Five things to notice in it:

- **`customerId` is not declared.** `belongs-to=Customer #customer` created it, and `create` accepts it by that name.
- **`always` holds the one rule every create and update obeys**, written once instead of four times.
- **`#pay` sets three fields and then, under `when`, a fourth.** Steps at the same level run in order, and the nested ones only when the condition holds.
- **`read #forCustomer` takes an argument**, and the filter compares it against `input.customerId`. A read may be as parameterised as a write.
- **`neverDestroyPaid` is a `forbid-if`**, which is not the same shape as the other two. A policy that forbids wins: a paid invoice cannot be destroyed, whoever is asking.

## Next

- [Calling actions](./calling-actions.md) — what the generated functions take and return.
- [Configuration and the command line](./configuration.md) — the file that points Mesh at this one, and every command.

---
title: "Entities"
description: "Every declaration an entity file may use: attributes, relationships, computed fields, actions, validations, steps and policies."
---

# Entities

::: callout warning "Not released"
Mesh is not released yet. These pages describe what Mesh will be.
:::

An entity file is one `.mesh.mx` file in your project's domain folder. It holds one entity: its data, the operations on it, and the rules around those operations. This page is the reference for the whole file, in the order you would write it.

Everything here is MX syntax. **Indentation nests**, and **a declaration is `kind :name options`**. A block starts with its tag and continues until the indentation changes.

## Names and references

Three spellings tell you what a name means: **`:name` declares**, **`&name` refers to a member of this entity**, and **an imported `Name` is another entity**.

| It is | Written | Examples |
|:--|:--|:--|
| A declaration | `kind :name` | `entity :Invoice`, `uuid :id`, `update :pay`, `check :invoiceIsSent` |
| A member of this entity | `&name` | `&title` in `input`, `asc &dueOn`, `load=[&customer]`, `actions=[&pay]`, `on:load=&visible`, `check &invoiceHasLines` in `validate` |
| A value of the current transaction | `%.name`, in a function | `&dueOn < %.today`, `stamp(%.now)` |
| Another file's entity, event or command | an imported identifier, or a member of a namespace import | `import { Customer } from "./customer.mesh.mx"`, then `belongs-to :customer entity=Customer`; `import { InvoicePaid } from "./invoice-paid.mesh.mx"`, then `publish=() => new InvoicePaid({ invoiceId: &id })`; `import * as billing from "../billing/invoice.mesh.mx"`, then `belongs-to :invoice entity=billing.Invoice` |
| One of a fixed set | an atom | `auto=[:read, :destroy]`, `types=[:create, :update]`, `on=:create` |
| An enum value | an atom | `values=[:draft, :sent]`, `default=:draft`, `&status === :sent`, `&status=:paid` |
| Text | a string | `table="invoices"`, `message="…"`, `code="invalid_state"` |
| A path through relationships | a member reference | `of=&lines.amount`, `of=&lines` |
| A pattern, a number, a boolean | as in TypeScript | `match=/^INV-\d+$/`, `min=0`, `default=false` |

An **atom** is a name that stands for itself, not a string. It names a declaration or a value from a fixed set. The name of an entity, attribute, relationship, action, check or policy is an atom made of letters, digits and underscores, because it becomes a TypeScript identifier. An enum value may also contain hyphens: `values=[:review-accepted, :review-waived]` gives the union `"review-accepted" | "review-waived"`, and `default=:review-accepted` and `&rule=:review-waived` refer to them. At run time an atom is its name as a string: `values=[:draft, :sent]` gives TypeScript the union `"draft" | "sent"`, and your program compares with `invoice.status === "sent"`.

A **member reference** points at something declared in this entity: an attribute, relationship, computed field, action, check or policy. Inside a function, `&status` reads the record's status. A name that is not a member is a build error at that position, with a suggestion: `&titel` suggests `&title`. Strings cannot stand in for member references, and an atom cannot stand in for text: `message=:oops` is an error.

A `.mesh.mx` file exports its entity under its declared name. Import that name by relative path, then use it in `entity=Customer`. Or import the file as a namespace and name its entity as a member of it: `import * as billing from "../billing/invoice.mesh.mx"`, then `entity=billing.Invoice`. Both are JavaScript's own import forms, so pick the one that reads better; a file may use both, even for the same file. The namespace name is your alias for that file, not a module name: Mesh checks that the file declares the member you name (`billing.Invoce` is a build error that suggests `billing.Invoice`), never that the alias matches a folder, and the alias never appears in a generated name or an FQN. There is no project-wide name lookup.

```mx "src/domain/ledger/payment.mesh.mx"
import * as billing from "../billing/invoice.mesh.mx"
import { Account } from "./account.mesh.mx"

entity :Payment
  attributes
    uuid :id primary-key
    integer :amount min=1

  relationships
    belongs-to :invoice entity=billing.Invoice
    belongs-to :account entity=Account
```

### One input section

An action's `input` is the whole of what the caller may send. Each line is one of two things:

- **`&title`** takes the declared attribute as it is: its type and rules come from the attribute line. No options are allowed on an `&` line. **`&list`** takes a declared `belongs-to`; the caller sends the related record's id.
- **`decimal :percent min=0 max=100`** declares an argument with the same shape as an attribute. It is not stored as sent, and reaches code as `input.percent`.

The same name twice in one `input` is a build error, including a member reference and an argument with that name. A read can take an `input` too. The [actions section](#actions) shows both forms in use.

### Static files

An entity file is static: it has no conditionals or loops that add or remove declarations. A condition belongs on the line it conditions, as `when=` on a policy or a check, or inside its expression, or on a `when` line that conditions the checks or steps under it. A rule over a has-many is an expression such as `&lines.every(...)`, not a loop that creates checks. Expressions still obey the [translation rules](#what-a-translated-arrow-may-use) where SQL is required.

Names and lists are written out, not computed from variables. Imported entity identifiers and function-valued options are the explicit exceptions; Mesh does not run the file to discover its declarations.

## The shape of a file

This is the same file the [Introduction](./index.md) shows and the [tutorial](./tutorial.md) builds.

```mx "src/domain/todo/todo.mesh.mx"
import { List } from "./list.mesh.mx"
import { Mesh } from "meshfw"

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
    policy :owner types=[:read, :update, :destroy]
      authorize-if=({ actor }) => &list.ownerId === actor.id
    policy :ownerCreates types=[:create]
      authorize-if=async ({ input, actor }) => {
        const [list] = await Mesh.privileged(List).read({ filter: { id: { eq: input.list } } })
        return list?.ownerId === actor.id
      }
```

**Sections group declarations.** `attributes`, `relationships`, `computed`, `checks`, `actions` and `policies` may be in any order, empty or left out. Inside an action are `input`, `validate` and `do`: validation happens before the steps, however you order those sections. Steps inside `do` run in order. An action no policy covers is forbidden, so a file with no `policies` can be built but nothing in it can be called.

**Indentation nests.** A line at the left margin ends the block before it, including a comment. A comment inside an entity is a `//` line indented with the block it belongs to.

**Values are written out.** An atom, string, number, regular expression, boolean, list or object is a literal. A member reference and an imported entity have the meanings above. The places whose value is code — `filter`, `when`, `authorize-if`, `forbid-if`, a check's `that`, a `set` value and a computed field's body — take functions.

**One expression can be translated.** An arrow `(…) => …`, or a method body with a single `return`, can run inside a database query. A body that cannot be translated runs in memory. A construct the expression language does not define stays plain code with JavaScript semantics, and the build warns (`MESH_EXPR_PLAIN`). Where SQL is required (a filter, sort key or policy check), such a construct is a build error naming the line.

**Functions receive four things.** `self` is the whole record, `input` is what the caller sent, `actor` is who is calling and `context` is the rest of the call. Use `&name` to read a member; a function that reads only members takes no parameters. Destructure `input`, `actor` or `context` when you use them. Destructure `self` when you pass the whole record to a helper, such as `isOwner(self, actor)`. [What `self` holds](#what-self-holds) depends on where the function runs.

**`%` is the current transaction.** In a function, `%.now` is its instant (a `Date`) and `%.today` its date (a `Date` at 00:00 UTC). They are properties, not calls, and they hold one value for the whole transaction: every action call joined to it, and every read made inside it, sees the `%.now` of the call that opened it. Only these values are exposed, never the transaction itself, so `%` alone, `%now` and `%.now()` are errors.

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

Imports are relative, and either named (`import { isStaff } from "./invoice.helpers"`) or a namespace (`import * as rules from "./invoice.helpers"`, then `rules.isStaff(actor)`, which translates as `isStaff(actor)` does). A default import and an `import type` are build errors (`MESH_IMPORT_FORM`). A helper may come from any file inside the project, not only from `src/domain/`; an import of another entity stays inside `src/domain/`, where entity files live. An import name, whether a helper or an alias for another entity, may not start with `$` or `l$`: Mesh uses those prefixes for the names it generates, and the build refuses the binding (`MESH_HELPER_NAME`). An imported helper in a translated expression must be pure: it may not read the clock, the network or anything Mesh did not hand it. A helper module hands values out through functions, so a one-expression function only calls what it imports from one: a constant read as a value (`&amount > LIMIT`), a member of an imported object (`limits.max`) or of a namespace import (`rules.LIMIT`), or a helper passed along without a call (`&lines.some(isOpen)`) is the build error `MESH_EXPR_CAPTURED_VALUE`. Export a function and call it (`limit()`), or pass an arrow that calls the helper (`(line) => isOpen(line)`). A body with statements, an object-literal body such as a check's `details` and a `run` step are plain code and may read them. A helper that does not read the record, such as `isStaff(actor)`, runs once before the query and enters SQL as a bound value. In memory, a helper behind a guard runs only when the guard lets it: in `input.m !== null && isBig(input.m)`, `isBig` is not called when `input.m` is `null`, and the same holds for the right side of `||` and `??` and the branch of `?:` not taken. An unknown guard still runs it, as SQL would: in `input.m > 1 && isBig(input.m)` with `input.m` null, `isBig(null)` is called, so a helper must still accept `null` wherever the guard can be unknown. A `run` step is different: it is plain code and may call anything.

### What a translated arrow may use

Comparisons, `&&`, `||`, `!`, numeric `+ - * /`, `.length`, `%.now` and `%.today`, member reads such as `&amount`, the function's parameters, and imported pure helpers that do not read the record. String concatenation, a conditional on a string and helpers that read the record run in memory. The build tells you if one appears where the database is required. Do not add a second statement to opt out of translation: Mesh already makes that decision.

Names in an expression resolve as JavaScript resolves them. Mesh's own functions are members of `Mesh` (`Mesh.isSystem(context)`, `Mesh.privileged(User)`, imported with `import { Mesh } from "meshfw"`), and the current transaction's values are `%.` names: `%` is the current transaction, `%.now` its instant and `%.today` its date (a `Date` at 00:00 UTC). They are properties, not calls (`%.now`, never `%.now()`), they need no import, and they are the same everywhere in one transaction. So no bare name in an expression is Mesh's and an import never shadows one. Code outside an entity file that needs the instant takes it as a parameter: `dueIn(%.today, 30)`. The roots `self`, `input`, `actor`, `context` and `before` are like the expression's parameters: inside an expression they shadow an import of the same name, which stays usable everywhere else in the file. No name is refused.

## The entity line

| Option | Required | Meaning |
|:--|:--|:--|
| `:Todo` | yes | The entity's declared name, in any casing; Mesh converts it to PascalCase (`entity :todo` generates `Todo`), which is also its named export |
| `table` | no | The database table; defaults to the entity's name in snake_case |

The folder that holds the file is the module. Entities in `src/domain/todo/` belong together; no line repeats the folder's name. A plain nested folder is a submodule (`todo/reminders`), while a folder starting with `_` only organises files and is left out of the module (`todo/_scheduling/` is module `todo`); the `ignore` option in `mesh.config.ts` excludes files from Mesh. Another entity is imported by relative path. Two folders may each declare an `entity :List` without conflict: their paths distinguish them, each module's import specifier (`#mesh/domain/<module>`) exports its own entity value `List`, and Mesh names them by their fully qualified names, `school.List` and `work.List`, wherever it writes an entity's name (errors, seams, `mesh inspect`). When both would be stored in the table `list`, the build fails naming both by those names, and a `table=` on one of them resolves it. No name Mesh generates is unique across the project: two modules may declare entities of one name, and the generated files tell them apart internally. See [Project structure](./project-structure.md#the-domain).

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
| `json` | `unknown` | Any JSON value: an object, an array, a string, a number or a boolean |

`json` holds data whose shape you do not model, such as a list of ids or a map of results. Mesh validates that the value is JSON and stores it as JSON, and does not look inside; the caller narrows `unknown` to the shape they expect. A `json` always accepts `null`, as if it were `nullable`: it is stored as a NULL column, a create that does not send it stores `null`, and the validator takes `null` as it takes any other JSON value. Writing `nullable` on a `json` is legal but redundant, and the build warns about it. It takes `default=` (a JSON literal) but not `unique`, `min`, `max` or `match`, and it cannot be a rollup operand or appear in a `filter`. To query by a part of the value, declare that part as its own attribute.

### Concepts

A concept is a value with no identity and one or more fields, such as an amount of money in a currency. It is declared in a file of its own directly inside a folder named `concepts`, named after the concept, and its field lines are written as an event's are:

```mx "src/domain/concepts/Money.mesh.mx"
concept :Money
  string :currency match=/^[A-Z]{3}$/
  integer :amount min=0
```

A line whose head is the concept's name declares a member that holds one, with no import: Mesh finds the concept in the nearest `concepts` folder up from the entity file.

```mx "src/domain/billing/invoice.mesh.mx"
entity :Invoice
  attributes
    uuid :id primary-key
    Money :total
    Money :refund nullable
  actions auto=[:read]
    create :open
      input
        &total
        &refund
    update :refundAll
      do
        set
          &refund={ currency: "EUR", amount: 0 }
```

The member's TypeScript type is the concept's generated type (`{ readonly currency: string; readonly amount: number }`), and its value is checked with the concept's generated schema on the way in, so `{ currency: "eur", amount: 1 }` is an `InvalidInputError` whose issue's path is `total.currency`. A concept member takes `nullable` and, on a command field, `optional`; it takes no `default=`, `unique`, `primary-key` or rule of its own, since its fields carry the rules. A field of a concept may be any attribute type but a date (`date`, `datetime`, `timestamp`, which JSON does not keep), or another concept.

A concept member is stored as one JSON value, so the database does not look inside it: it cannot be sorted by, appear in a `filter` or a read policy (`MESH_SORT_TYPE`, `MESH_FILTER_TYPE`), or be a rollup operand (`MESH_ROLLUP_TYPE`); a read policy that reads inside one (`&total.amount > 0`) is `MESH_EXPR_NOT_SQL`, since that read runs as plain code; and the caller's filter and sort types leave it out. A value is replaced whole, never changed in place: `set &total={ ... }` takes an object literal with exactly the concept's fields (an `enum` field as an atom, and no atom in a `json` field, as for a `json` member), or a function, and anything else is `MESH_SET_VALUE`. A function that reads inside one, `check :positive that=() => &total.amount > 0`, runs as plain TypeScript with the `MESH_EXPR_PLAIN` warning, as one that reads inside a `json` value does; through a `nullable` concept member, write `&refund?.amount`. A concept is also the type of an event or command field, and a command field answers an action input only of the same concept.

`integer`, `float` and `decimal` are all `number` in TypeScript, but a whole number, a money amount and a measurement are different things to store. An atom may be compared with, or assigned to, an `enum` field only: `&status === :sent` is a build error (`MESH_EXPR_ATOM`) if `status` is a `string`, and so is an atom compared with a number, with another atom, or with a field of `actor` or `context`, which are plain TypeScript values. The error's fix writes the string: `actor.role === "admin"`. A field of `input` is an enum where its action declares it as one, an `enum` argument or the member input of an enum attribute, so `input.status === :sent` is legal in that action's checks and steps; a policy or an `always` block covers several actions and its `input` is not typed, so there the string is written.

### Options on an attribute line

| Option | Meaning |
|:--|:--|
| `primary-key` | The entity's one primary key, filled by Mesh on create. A `uuid` or `string` key gets a time-ordered UUID when Mesh builds the new record, so a policy, a check and a step already read it. An `integer` key gets the next whole number, counting from 1 with no gaps, when the row is written: it is `null` before that, in the generated types too, and a `run [after=:write]` step reads it. A caller cannot send it, and an `integer` key needs a data adapter that fills it |
| `nullable` | The field may be absent or null; every other attribute is required |
| `default=` | A literal that fits the type |
| `values=` | An enum's allowed atoms; an empty list, blank or repeat is a build error |
| `unique` | The database refuses a second row with that value |
| `min=`, `max=` | A string's length bounds or a number's value bounds |
| `match=` | A regular expression a string must match |
| `message="..."`, `code="..."` | What a broken `min=`, `max=` or `match=` of the line reports instead of Mesh's standard message and code; only on a line that has one of them |
| `on=:create`, `on=:update` | On a timestamp: fill on insert, or on insert and every later write; callers cannot set it |

`on=:create` and `on=:update` are unrelated to `on:load` on `actions`, which chooses a read.

A member (an attribute, relationship, computed field, action or policy) may take any name except `__proto__`, which sets an object's prototype instead of adding a property and is the build error `MESH_ATTRIBUTE_NAME`. `constructor`, `toString` and `valueOf` work, with two costs on an entity that uses such a name: a typed caller passes `toString: undefined` instead of leaving the field out, and `String(record)` misbehaves on a record with a string attribute named `toString`. An action keeps the name you wrote as the method of its entity value: `publish_post` stays `publish_post`.

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
| `has-many ... through=` | Many-to-many: the records a link entity joins this one to, such as a student's courses through enrollments ([below](#many-to-many-a-has-many-through-a-link-entity)) |

A `belongs-to` stands alone: it declares the key column, and nothing requires a `has-many` back. The other direction is not free: a `has-many` or `has-one` needs a `belongs-to` back on the other entity, because that line is what declares the key column. Without one the build fails at the `has-many` line and names the line to add, for example ``add `belongs-to :list entity=List` to todo.Todo``.

Add `nullable` to a `belongs-to` when a related row is optional. A caller sets the relationship through `&list` in `input`, sending the list's id. The entity file names the relationship, never its generated key column; [Using your domain](./using-your-domain.md#relationship-input-and-record-fields) explains the TypeScript surface.

### Choosing the key a has-many follows

A `has-many` (or `has-one`) follows the key the other entity holds back to this one: one of the other entity's `belongs-to` that points at this entity. Mesh finds it without help in two cases. With one `belongs-to` back, that one is followed. With several, the one named after this entity in lower camel case is followed: a `Collaborator` with `has-many :memberships entity=Membership` follows `belongs-to :collaborator` of `Membership`, even when `Membership` also has `belongs-to :grantedBy entity=Collaborator`.

When Mesh cannot guess, say which one with `inverse=`, an atom naming the other entity's `belongs-to`:

```text "src/domain/work/task.mesh.mx (excerpt)"
has-many :dependencies entity=Dependency inverse=:dependent
has-many :dependents entity=Dependency inverse=:prerequisite
```

Here `dependency.mesh.mx` declares `belongs-to :dependent entity=Task` and `belongs-to :prerequisite entity=Task`. Neither is named `task`, so each `has-many` says which key it follows. `inverse=` also wins when you want a key other than the one Mesh would pick: `has-many :grants entity=Membership inverse=:grantedBy` follows `grantedBy`, and one that names the key Mesh would pick anyway is legal. `inverse` is an atom and not `&dependent`, because `&name` refers to a member of this entity and `dependent` is a member of `Dependency`.

With several `belongs-to` back and none named after this entity, and no `inverse=`, the build lists the candidates. An `inverse=` that names no `belongs-to` from that entity to this one is a build error with a suggestion. A `has-one` takes no `inverse=`: when its target has several `belongs-to` back and none is named after the entity, the build says so. A `has-one` and a `has-many` cannot follow the same key, because a `has-one` is at most one row for it: the build fails at the `has-one` line (`MESH_HAS_ONE_SHARED_KEY`). Keep the `has-many` and take the one row from its list, or give the `has-many` a `belongs-to` of its own and name it with `inverse=`. An entity relates to its own type by its own name, with no import: `belongs-to :parent entity=Task nullable` and `has-many :children entity=Task`. With a second `belongs-to` to the same type, say which one the `has-many` follows: `has-many :children entity=Task inverse=:parent`.

### Many-to-many: a has-many through a link entity

A student takes many courses and a course has many students. Neither entity holds the other's key: a third entity, the **link**, holds one row per enrollment, with a `belongs-to` to each side. `through=` names it:

```mx "src/domain/school/student.mesh.mx"
import { Course } from "./course.mesh.mx"
import { Enrollment } from "./enrollment.mesh.mx"

entity :Student
  attributes
    uuid :id primary-key
    string :name

  relationships
    has-many :courses entity=Course through=Enrollment
    has-many :enrollments entity=Enrollment

  actions auto=[:read]
```

```mx "src/domain/school/enrollment.mesh.mx"
import { Student } from "./student.mesh.mx"
import { Course } from "./course.mesh.mx"

entity :Enrollment
  attributes
    uuid :id primary-key
    date :enrolledOn

  relationships
    belongs-to :student entity=Student
    belongs-to :course entity=Course

  actions auto=[:read, :create, :destroy]
```

```mx "src/domain/school/course.mesh.mx"
entity :Course
  attributes
    uuid :id primary-key
    string :title

  actions auto=[:read]
```

`entity=` names what the list holds, `Course`; `through=` names the link, `Enrollment`, an ordinary entity of its own. A through relationship only reads: you add and remove a student's courses by creating and destroying `Enrollment` rows with the link's own actions. Like any entity that a relationship loads, the link needs a read (`actions auto=[:read]`, or `on:load=`), and so does `Course`.

The relationship enters the link by the link's `belongs-to` back to this entity, chosen exactly as for any `has-many`: the only one, else the one named after this entity, else the one `inverse=` names. With `through=`, `inverse=` names a `belongs-to` of the link. It leaves the link by the link's only other `belongs-to` to the listed entity. A link may hold further `belongs-to` to other entities (an `approvedBy`), but it must have exactly one, besides the entry, to the listed entity: with none or several the build fails at `through=`, and no option chooses among several yet. The link is a third entity, never this entity or the one listed. An entity may list its own type through a link:

```text "src/domain/work/task.mesh.mx (excerpt)"
has-many :prerequisites entity=Task through=Dependency inverse=:dependent
has-many :blocking entity=Task through=Dependency inverse=:prerequisite
```

`Dependency` holds `belongs-to :dependent entity=Task` and `belongs-to :prerequisite entity=Task`. Both point at `Task`, so `inverse=` says which one the relationship enters by, and the other is the one it leaves by.

Loaded, `student.courses` is a list of `Course` records: each course once, however many enrollments join the two, in the courses' primary-key order. An enrollment whose `course` is null (on a `nullable` key) adds nothing; one whose key points at a course that does not exist is an error. To read the link's own fields, a grade or `enrolledOn`, load the plain `has-many :enrollments` beside it. A rollup over a through relationship counts the same way: `count :courseCount of=&courses` counts each course once, however many enrollments join the two, and an enrollment with no course, or whose course does not exist, adds nothing. A `has-one` to the link that follows the same `belongs-to` the through relationship enters by is refused, as a `has-one` and a `has-many` that share a key are. `through=` belongs to `has-many` only.

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
      return &status === :sent && &dueOn < %.today
    }
    string :label() {
      return &number + " · " + formatMoney(&amount)
    }
    count :lineCount of=&lines
```

**A field with a body.** A type, a `:name`, parameters and a body. Leave the parameters empty when it reads only members; add `actor` when it depends on who is asking. A `Mesh.privileged` read may be called with no context, and the fields it loads are computed with none, so in a body `actor` may be `undefined` and every key of `context` is optional: check them before you read them (`actor === undefined ? … : actor.id`). This is the lead's ruling D9, pending the operator's review.

**A rollup.** A kind, a `:name` and `of=`, a path through relationships. The path is a member reference: `&lines` for a `count`, `&lines.amount` for the others, with one step or more. Each name is checked at that position. The string form `of="lines.amount"` is a build error (`MESH_ROLLUP_PATH_STRING`) that says to write `of=&lines.amount`.

| Rollup | Result |
|:--|:--|
| `count :lineCount of=&lines` | How many rows the path reaches |
| `sum :total of=&lines.amount` | The total of a numeric field |
| `avg :averageAmount of=&lines.amount` | Its average |
| `min :firstDueOn of=&lines.dueOn` | The smallest value |
| `max :lastDueOn of=&lines.dueOn` | The largest value |

`sum` and `avg` take an `integer` or `decimal` field, and `min` and `max` also a `date` or `datetime`; `count` ends at the relationship. A `sum`, `avg`, `min` or `max` over no row, or over rows whose field is null, is `null`, and a `count` is `0`.

The path may start at any relationship. Over a `belongs-to` it reads the one related record: `max :customerRating of=&customer.rating` is the customer's rating, and when the `belongs-to` and the field are both required it is never null, except where no customer is known yet (on a create's new instance, before the input names one, it is `null`) or the caller may not read the customer. A required `belongs-to` whose key names a row that does not exist is an error when the rollup loads, as it is when the relationship loads. The path may also cross several relationships: `sum :catalogValue of=&lines.product.price` adds up the prices of the products the invoice's lines reach. Each record the path reaches counts once, however many ways lead to it, so two lines of one product add its price once; to add a value per line, put it on the line. Along the way a key that points at nothing adds nothing, except on a path made only of required `belongs-to` (`max :rating of=&invoice.customer.rating`), which is never null and where such a key is an error when the rollup loads. Each `has-many` or `has-one` on the path must say which `belongs-to` back it follows (`inverse=`) when its target has several. A rollup over several relationships, or over a `has-many ... through=`, runs as a join, so the data adapter must declare `joins` (`MESH_CAPABILITY` otherwise); one over a single relationship needs no join. A caller's load gives the rollup `0` (a `count`) or `null` (the others) unless every entity the path reaches, a link entity included, admits the caller by its read policies. Where one admits the caller only for some records (a read policy that reads the record), the rollup aggregates only those: `sum :catalogValue` adds up the prices of the products the caller may read, reached through the lines the caller may read.

**A rollup with a filter.** `filter=(line) => condition` aggregates only the records the path reaches last for which the condition is true: `count :openLines of=&lines filter=(line) => line.state === :open` counts the open lines, and `count :activeProducts of=&lines.product filter=(p) => p.active === true` the active products the lines reach. The function takes exactly one parameter, the record; an unknown result leaves the record out, as in a read's `filter`. A function with a second parameter is `MESH_EXPRESSION`; no parameter, a pattern (`({ self })`), a rest or a default value, or a parameter named like a scope root (`self`, `input`), is `MESH_ROLLUP_FILTER`. The condition reads only that record's stored columns (its attributes, and a `belongs-to`'s key column such as `line.productId`), literals, atoms, `%.now` and `%.today`: a member of this entity (`&limit`), `self`, `input`, `actor`, `context`, `before`, a helper call, or a relationship or computed field of the record is `MESH_ROLLUP_FILTER`. It always runs as SQL, in the rollup's query: a filter Mesh does not translate is `MESH_EXPR_NOT_SQL`, a `json` column in it is `MESH_FILTER_TYPE`, and the data adapter must declare `conditions` (`MESH_CAPABILITY` otherwise). On a caller's load it applies together with the read policies of the records it aggregates. A filtered `sum`, `avg`, `min` or `max` can be null whatever its path, even over required `belongs-to` only (`max :openAmount of=&line.amount filter=(l) => l.state === :open` is null when the line is closed), while a filtered `count` is `0` when the filter keeps nothing. A computed body that filters the loaded list (`&lines.filter((l) => l.state === :open).length`) stays legal; unlike a rollup, it runs in memory over every loaded line, including lines the caller's read policies would exclude.

**A rollup where SQL is required.** A read's `filter`, a key of its `sort` (a `desc &total` line under `sort`) and a read policy may read a rollup: `read :withLines filter=() => &lineCount > 0`, or `authorize-if=() => &biggest === null || &biggest < 200` (a `max` over no record is null, and a comparison with null is unknown, which denies). It runs as a subquery of the read's query and gives the value a load through `Mesh.privileged` gives, its filter applied and each record once: no read policy of the entities its path reaches runs there, since the condition is the entity's own rule, as a computed body is. So `read :busy filter=() => &openLines >= 2` counts lines a caller may not read, while that caller's `load: ["openLines"]` does not. A subquery needs the data adapter's `joins`, even for a rollup over one relationship (`MESH_CAPABILITY` otherwise). In a sort a `sum`, `avg`, `min` or `max` over no record is null, which sorts as the smallest value.

Paths are checked at build time. Inside the entity, checks, steps, filters and policies can read `&lineCount` without asking. A caller sees a computed field only when they name it in `load`; otherwise reading it is a type error.

A computed body that cannot be translated runs in memory after the rows load, at the cost of an extra pass. `label` above is one of those, and that is not a mistake. An error arises only where SQL is required: a filter, a sort key, a policy, a rollup's path or another translated expression. `mesh explain` says which computed fields translate.

A body that runs in memory reads a record in which only what it names is loaded. Reading a relationship or computed field it did not load throws an error that names the field, and so does asking whether one is there (`"lines" in self`). Spreading a record or calling `Object.keys` on it lists the stored fields and whatever was loaded, never the rest, so write the names you need as `&name` and Mesh loads them.

## actions

`actions auto=[:read, :destroy]` generates the plain actions of those types, named after the type. You may list `:create`, `:read`, `:update` or `:destroy`, with no repeats. Every action you write yourself is `type :name`.

**`on:load=&visible`** chooses the read used when this entity is loaded through a relationship. That read's filter applies. Without it, Mesh uses the auto read. Naming a missing read is a build error, as is loading an entity that has neither choice.

**`max-limit=100`** caps how many rows a caller's read returns. A read whose `limit` is above it fails with `InvalidInputError`, one issue at `limit` with the code `too_big`, the message "must be at most 100" and the position of `max-limit`; a read with no `limit` returns at most 100 rows. A `Mesh.privileged` read and a relationship load are not capped. The value is a whole number of at least 1, and an entity with no read cannot take it: both are build errors (`MESH_OPTION_VALUE`).

### input

An `input` section lists member references and declares arguments. A create must receive every input member that is required and has no default. On an update, member inputs are optional: the caller sends what changes. A typed argument is required unless `nullable`. A create's required attribute must be supplied through input, have a default, be filled by Mesh or be set by a step. Otherwise generating the create fails with `MESH_EMIT_UNFILLABLE`; checking the file without generating code does not report it.

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

Call it on its entity: `Invoice.applyDiscount({ id, percent: 10 }, context)`. The percentage reaches the expression as `input.percent`; no field stores "10% off". A member line takes the declaration unchanged, while a typed line is a new argument. An action without `input` takes no declared fields; an update or destroy still takes its id.

Options such as `auto=`, `on:load=`, `types=` and `actions=` sit on the declaration line. Sections such as `input`, `validate`, `do` and `sort` have their own lines.

### Options on an action line

| Option | On | Required | Meaning |
|:--|:--|:--|:--|
| `:name` | every action | for a read; for the others unless `on=` is given | The action's name, and the method of the entity value |
| `on=` | `create`, `update`, `destroy` | no | The command the action answers: an imported identifier (`on=PayInvoice`) or a member of a namespace import (`on=billing.PayInvoice`). With no name, the action is named after the command (`payInvoice`); with one, the name wins. A `read` takes no `on=` |
| `filter=` | `read` | no | The condition every row must meet; see [Reads: filter and sort](#reads-filter-and-sort) |

A command is a request's fields, declared in a file of its own or in an entity's `commands` section; see [Events: Answering a command](./events.md#answering-a-command) for how the action and the command must agree, and `dispatch` for running one.

### validate

Checks run before anything is written, and before the input is applied: `&name` is the record as it is stored (on a create, the new record with its defaults), and the caller's values are in `input`. A rule about one field goes on its declaration: `decimal :amount min=0` says the whole of "the amount cannot be negative". A `check` is for a cross-field or stored-state rule:

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
          that=({ input }) => input.dueOn >= input.issuedOn
          code="invalid_dates"
          message="the due date cannot be before the issue date"
        ]
```

A line rule carries Mesh's standard code and message, and the issue points at the line that holds the rule: `string :title min=1` reports `too_short` and "must be at least 1 character". `message="..."` and `code="..."` on the same line replace them for every rule of that line; one you leave out keeps the standard value of whichever rule failed. `string :slug match=/^[a-z-]+$/ message="use lower-case letters and hyphens" code="bad_slug"` reports `bad_slug` and that message, and `integer :quantity min=1 max=99 code="quantity"` reports `quantity` with "must be at least 1" or "must be at most 99". Both are fixed text, never blank (`MESH_TEXT`), and a line with none of `min=`, `max=` and `match=` cannot carry them (`MESH_ATTRIBUTE_RULE`): a check is where a rule of your own, with its own message, goes.

| Rule | Type | Code | Message |
|:--|:--|:--|:--|
| `min=N` | `string` | `too_short` | must be at least N characters ("1 character" when N is 1) |
| `max=N` | `string` | `too_long` | must be at most N characters ("1 character" when N is 1) |
| `min=N` | `integer`, `float`, `decimal` | `too_small` | must be at least N |
| `max=N` | `integer`, `float`, `decimal` | `too_big` | must be at most N |
| `match=/p/f` | `string` | `no_match` | must match /p/f |

A string's length counts Unicode code points: "😀" is one, but an emoji built from several code points, such as a flag or a skin-tone variant, counts as several. A value of the wrong type or a missing field has no code: its issue carries the validator's message.

The atom after `check` names the rule and is the label the caller sees. Name what must hold: `check :invoiceIsSent`, not the failure you are trying to avoid. Brackets let the options span several lines. A check's name is a member of the entity, like an attribute's or an action's: it is unique in the entity, so two checks, or a check and another member, cannot share it (`MESH_DUPLICATE_MEMBER`). Two rules with the same name in two actions are either one rule, declared once as below, or two rules that need two names.

| Option | Meaning |
|:--|:--|
| `that=` | A function returning a boolean |
| `code=` | The caller-facing code, as text, on the issue rather than the error; write a number as a string (`code="42"`) |
| `message=` | The sentence the caller sees: fixed text, or a function of the same arguments as `that=` that returns it |
| `when=` | Apply this check only when the condition holds |
| `details=` | A function returning data the caller receives on the issue, such as the reasons a task is not ready |

A failed check throws `InvalidInputError`, whose own code is always `invalid_input`. Each failure has its own entry in `error.issues`, with the label, code, message, `details` (when the check declares them) and source position of the check. Several checks may fail in one call.

**An unknown result.** A comparison with a null is neither true nor false but unknown ([ADR-0012](../architecture/decisions/0012-expression-semantics.md)). An unknown `that` fails the check, so a rule never passes because a value was missing; an unknown `when` skips the check, so a condition that cannot be decided does not apply the rule, and an unknown `when` line skips every check under it. Write `?? value` or an explicit null test when you want the other outcome.

```text "src/domain/work/claim.mesh.mx (excerpt)"
check :taskReady [
  that=({ input }) => taskIsReady(input.task)
  code="claim.task-ready"
  message="the task is not ready"
  details=({ input }) => taskReasons(input.task)
]
```

**A message that names the record.** `message=` is either fixed text or a function taking the same arguments as `that=` and `details=`. Use the function when the sentence depends on the call: it can read `self`, `input`, `actor`, `context`, and what the check loads through a relationship.

```text "src/domain/work/task.mesh.mx (excerpt)"
check :noOpenChildren [
  that=() => &childrenSettled
  code="task.children-settled"
  message=() => childrenSettledReason(&children)
  details=() => ({ openChildren: openChildren(&children) })
]
```

The function runs only when the check fails, so a check that passes, or that `when=` skips, never computes it; it may be `async`. It must return text that is not blank, as `message=""` is refused at build time. One that throws, or returns anything else (`null`, `undefined` and blank text included), is a bug in your rule, so the call fails with a `FrameworkError` that names the entity, the check and the line of the check in the entity file, never with some other text in its place.

#### Checks under a condition

A `when=condition` line in `validate` guards the lines written under it: `check` lines (inline or `check &name`) and further `when` lines, to any depth. The condition is a function that sees what a check sees (`self` before the input, `input`, `actor`, `context`, and no `before`). It runs once per call, at its place in the list, and when it is false or unknown none of the lines under it runs. Several checks that share a condition say it once this way instead of repeating `when=` on each:

```mx "src/domain/billing/invoice.mesh.mx"
entity :Invoice
  attributes
    uuid :id primary-key
    integer :version default=0
    decimal :amount
    enum :status values=[:draft, :sent] default=:draft

  actions
    update :send
      input
        integer :expectedVersion
      validate
        when=() => &version > 0
          check :versionIsCurrent that=({ input }) => input.expectedVersion === &version code="stale_update" message="the invoice changed since you read it"
          check :isDraft that=() => &status === :draft code="not_draft" message="only a draft can be sent"
        check :positive that=() => &amount > 0 code="no_amount" message="the invoice has no amount"
```

A check under a `when` line may carry its own `when=`; it runs when both hold. A `when` line in `validate` holds checks only: a `set`, `load` or `run` under it, and a `check` under a `when` in `do`, are build errors (`MESH_TAG_NOT_ALLOWED`). A `when` line with nothing under it builds and does nothing.

#### A rule several actions share

A rule that more than one action enforces is declared once, in the entity's `checks` section, and each action lists it in its `validate` with `check &name`:

```mx "src/domain/billing/invoice.mesh.mx"
entity :Invoice
  attributes
    uuid :id primary-key
    date :issuedOn
    date :dueOn

  checks
    check :dueAfterIssue [
      that=({ input }) => (input.dueOn ?? &dueOn) >= (input.issuedOn ?? &issuedOn)
      code="invalid_dates"
      message="the due date cannot be before the issue date"
    ]

  actions
    create :issue
      input
        &issuedOn
        &dueOn
      validate
        check &dueAfterIssue
    update :reschedule
      input
        &issuedOn
        &dueOn
      validate
        check &dueAfterIssue
```

A line under `checks` takes the options of a check written in `validate`. `check &dueAfterIssue` runs the check at that place in the action's list, and a failure reports the check as if it were written there, with the label, code and message of the declaration and the declaration's line. The reference line is the whole of it: options (`check &dueAfterIssue when=...`) and lines under it are build errors, since they belong where the check is declared. One action lists a check once, and `check &name` naming no check of the section is a build error (`MESH_UNKNOWN_MEMBER`).

The check runs in each action with that action's `input` and `self`, and the build checks it once for each of them. Reading `input.x` in a translated arrow where one of those actions takes no `x` is an error at the read, naming the action (`MESH_CHECK_INPUT`); an update and a destroy always take the key. In plain code (a body with statements, an object-literal `details`, an arrow the build runs as plain code) the same read is left to the TypeScript check of the generated code, which types each action's copy with that action's input. A warning that holds in only some of them says which: `input.dueOn !== input.issuedOn`, used by `create :issue` and `update :reschedule`, can compare two left-out inputs in the update and not in the create, so its warning names `update :reschedule`. A check that no `validate` uses never runs, and the build warns (`MESH_CHECK_UNUSED`).

#### A check that compares with the stored record

In `validate`, `self` is the record before the input is applied: the stored record on an update or destroy, and on a create the new record Mesh builds, with its defaults and a `uuid` or `string` key. The caller's values are in `input`, and a member input the caller did not send is `undefined` there. So a check that compares the new value with the old one reads each where it is: `input.role` is the role the caller sends and `&role` the stored one.

```mx "src/domain/team/membership.mesh.mx"
entity :Membership
  attributes
    uuid :id primary-key
    enum :role values=[:owner, :member, :guest]

  actions
    update :changeRole
      input
        &role
      validate
        check :roleChanged [
          that=({ input }) => (input.role ?? &role) !== &role
          code="membership.unchanged"
          message="the role is already set"
        ]
```

**The value the action will store** is `input.x ?? &x`: what the caller sent, or the stored value when they sent nothing. A check that holds whatever the caller sends, such as `dueAfterIssue` in an `always` over creates and updates, is written with it: `(input.dueOn ?? &dueOn) >= (input.issuedOn ?? &issuedOn)`. On a create `&x` is the default, or `null` when there is none, so a check there reads `input.x`. Reading `&x` in a create's check for a member the create takes as input draws a warning (`MESH_VALIDATE_NOT_APPLIED`), because it is never the caller's value. It stays a warning because the stored value can be what a rule means: in an `always` over creates and updates, `&status !== :archived` refuses an edit of an archived row and sees the default on a create, and `input.status ?? &status` would change its meaning on an update. An operator over a required member that nothing has filled yet draws one too (`MESH_VALIDATE_UNFILLED`), because the member is `null` on every create, so a result that depends on it is unknown: in `that` the check fails, in `when` the check is skipped, in a `when` line the checks under it are skipped, and in `details` the value is `null`. Both warnings apply to the condition of a `when` line in `validate` as to a check.

**A value sent as `null` is not a value left out**, but a translated expression reads both as `null`, so `input.x ?? &x` gives the stored value for either. When a `nullable` field can be cleared and the rule must tell the two apart, write the check as plain code, where a field left out is `undefined` and a cleared one is `null`: `that=({ input }) => { return input.intent === undefined || isAllowed(input.intent) }`.

**`before` is not in `validate`**: `self` already is the record before the input, and reading `before` in a check is a build error (`MESH_VALIDATE_BEFORE`). The member inputs are applied once every check has passed, so the `do` steps and `run` see `self` with them, and keep `before`: the stored record, `null` on a create. `before` holds the stored columns only: reading a relationship or a computed field on it (`before.owner`) is a build error, because nothing loads it. Read `&owner` for the related record, or compare the stored key (`before.ownerId`).

#### A version number that refuses a stale update

Mesh has no version construct. A `version` attribute, one `check` and one `set` give an update that refuses to overwrite what the caller has not seen:

```mx "src/domain/notes/note.mesh.mx"
entity :Note
  attributes
    uuid :id primary-key
    string :body
    integer :version default=1

  actions
    update :edit
      input
        &body
        integer :expectedVersion nullable
      validate
        check :versionMatches [
          that=({ input }) => input.expectedVersion == null || input.expectedVersion === &version
          code="expected-version"
          message="the note changed since you read it"
          details=() => ({ currentVersion: &version })
        ]
      do
        set
          &version=() => &version + 1
```

`expectedVersion` is an argument, so it is checked and never stored. A caller that sends it and has fallen behind gets an `InvalidInputError` whose issue has the code `expected-version` and `details.currentVersion`, and nothing is written; a caller that leaves it out always wins. `&version` in the check is the stored version, because a check sees the record before the input. The step runs after every check has passed, so a refused update does not bump the version. Every update reads the row under the write lock before it writes it, so two callers that send the same `expectedVersion` cannot both succeed.

#### A check that reads a related record

A check may read a related record, including a rollup on it. This one limits a free-plan owner to 20 todos:

```mx "src/domain/todo/todo.mesh.mx"
import { Mesh } from "meshfw"
import { User } from "./user.mesh.mx"

entity :Todo
  attributes
    uuid :id primary-key
    string :title min=1

  relationships
    belongs-to :owner entity=User

  actions auto=[:read]
    create :create
      input
        &title
        &owner
      validate
        check :underQuota [
          that=async ({ input }) => {
            const [owner] = await Mesh.privileged(User).read({ filter: { id: { eq: input.owner } }, load: ["todoCount"] });
            return owner.plan !== :free || owner.todoCount < 20;
          }
          code="quota_exceeded"
          message="free plan allows 20 todos"
        ]
```

A check sees the record before the input, and on a create that record has no owner yet: the caller names the owner in `input.owner`, and Mesh stores it once the checks pass. So the check reads that user through `Mesh.privileged(User)`, the reads without policies, inside the transaction, as a policy's related-row read does, and asks `load` for the rollup. `Mesh.privileged` is a function of `Mesh`, imported with `import { Mesh } from "meshfw"` like any import in an entity file, and its argument is an entity the file declares or imports. On an update or destroy the stored record has its owner, and a check reads it through the relationship: `&owner.todoCount < 20`, with `when=() => &owner.plan === :free`. That is the stored owner, so an update that changes the owner (one that takes `&owner`) must read the new one as the create does, from `input.owner` through `Mesh.privileged`. Reading `&owner` in a create's check draws a warning (`MESH_VALIDATE_NOT_APPLIED`), because it is never the owner the caller sent. The rollup lives on `User`, which also holds the `plan` the check compares with an atom. That comparison works because `plan` is an [`enum`](#the-types).

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
    count :todoCount of=&todos

  actions auto=[:read]
    create :create
      input
        &name

  policies
    policy :self types=[:read, :update]
      authorize-if=({ actor }) => &id === actor.id
```

**Check or policy.** A rule about the data, such as a quota, a date or a total, is a check: it reports a code and a message. A rule about who is calling, such as a plan tier or a role, is a policy. The owner is usually the caller, so `authorize-if=({ actor }) => actor.plan === "paid"` reads the actor and costs no query. `actor` is your program's object, not a member, so the comparison uses a string: an atom is only compared with an `enum` field.

### do

Steps run top to bottom after validation, on the record with the member inputs applied: the caller's value for each member input it sent, the stored value (on a create, the default) for one it left out. Each step sees the record as earlier steps left it, and `before` is the stored record, `null` on a create.

| Step | What it does |
|:--|:--|
| `set` | Assigns fields with `&field=value` lines; a value is a literal or a one-expression arrow. A line may name a relationship, `&creator=({ actor }) => actor.id`, and stores its key |
| `publish=() => new X({ ... })` | Raises the event the function returns, after the action's row is written, in written order; it is written to the outbox in the action's transaction (see [Events](./events.md)) |
| `when=cond` | Runs the nested steps only when the condition holds |
| `load=[&customer]` | Loads relationships or computed fields onto the returned record; writes nothing |
| `run(…) { }` | Plain code inside the transaction; `self`, `before`, `input` and the records reached through them are read-only in it (a change throws, so use `set`); it can call other entities' actions |

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

A `run` body may call anything, including logging or messaging code. The pure-helper rule applies to translated expressions, not `run`. Reach for it only when the work is not a field assignment. A change made inside a `run` is never stored. `self`, `before`, `input`, related records and the objects and arrays inside a `json` field are read-only (in a `check`, `when` or `set` function too, not only a `run`), so assigning, deleting or defining a property on any of them throws an error that points at `set`; the types are deep `readonly`, so most such changes are type errors before they run. A `Date` is handed out as a copy: calling a setter such as `setFullYear` throws, and changing it in place would have no effect either way, so build the new value and assign it with `set`. A `destroy` refuses `set` and `load` steps (build error `MESH_DESTROY_STEP`): it returns nothing and writes nothing, so use `check` and `run` there. Every update reads the row first and writes second, whether or not it has a `run`; [Using your domain](./using-your-domain.md#update) explains the one statement versus two.

### Calling other actions

An action is called on its entity, `Receipt.record(...)`, in an entity file as everywhere else, and the entity is in scope the way every name in an entity file is: it is the file's own entity or one the file imports. Through a namespace import the entity is a member of the alias, as in `entity=`: `billing.Receipt.record(...)`, `Mesh.privileged(billing.Receipt)`, and `billing.Receipt` as a type. A `run` step, and a function-valued `check`, `when` or `set` value, call the entities they import:

| Call | What it is |
|:--|:--|
| `Receipt.record({ invoice: self.id }, { ...context, system: true })` | The action of an imported entity, as an application calls it: its input, then its context |
| `Mesh.privileged(Claim).read({ filter: { taskId: { eq: self.id } } })` | The reads of an entity without read policies, with the same `filter`, `sort`, `limit` and `load` as a caller's |

```mx "src/domain/billing/invoice.mesh.mx"
import { Receipt } from "./receipt.mesh.mx"

entity :Invoice
  attributes
    uuid :id primary-key
    enum :status values=[:sent, :paid] default=:sent
    decimal :amount min=0

  actions
    update :pay
      do
        set
          &status=:paid
        run({ self, context }) {
          await Receipt.record({ invoiceId: self.id, amount: self.amount }, { ...context, system: true });
        }
```

Use another entity's value for the root writing its own parts (an [aggregate file](./project-structure.md#aggregates) names the root and its parts). An effect across aggregates goes in a [service](./services.md), whose operation lists the entities it reaches and calls each one's actions, or in plain code over `transaction` from `#mesh` when it only shapes a result for one caller ([Using your domain](./using-your-domain.md#several-actions-in-one-transaction)); an effect that may happen later is a `publish` and a listener. Mesh checks it: the architecture rule `:action-calls-other-aggregate` (`MESH_ACTION_CALLS_OTHER_AGGREGATE`, a warning by default) reports a call from a function of an entity's action or `always` block to a create, update or destroy action of an entity in another aggregate. Only entities that aggregate files list are checked; the [architecture file](./project-structure.md#the-architecture-file) re-grades or switches off the rule.

A call to another entity's action is an ordinary call with three differences. It joins the running transaction, so a throw anywhere rolls back the payment and the receipt together. That includes a call that fails inside a `try`: the whole action fails even if your code catches the error, so decide before you call, with a `Mesh.privileged` read or `Mesh.can(Receipt.record, input, context)`. Its results are read-only, like `self`. And it carries only the context you pass it: nothing is inherited from the calling action, so write `{ ...context, system: true }` to act for the system, with the human `actor` still on it, and `context` alone to act as the caller. Where your project declares a required context key, a call without a context does not compile. The call is checked like any other: the action it names runs its own validation, policies and steps, so a cascade can never do what its target forbids. A reason to keep `Receipt.record` for internal use is a policy that says so; see [internal writes](./using-your-domain.md#internal-writes). A chain of calls more than 1,000 deep, each made while the one before runs (a cascade over rows that form a loop, or a policy whose helper calls its own action), throws a `FrameworkError` naming the action and the one at the root of the chain; inside a transaction it fails the transaction like any failed call, even when your code catches it, so a cycle fails instead of running until memory is gone. A call started after the one before has finished, such as one a timer starts, begins a new chain.

`Mesh.privileged` reads the stored rows as they are inside the transaction, at the transaction's instant, so `%.now` means the same in the rule and in what it reads. A nested call reads that instant too: every action call joined to one transaction, and every read inside it, sees the `%.now` of the call that opened the transaction. It does not run read policies: it is the rule's own view of the data. Its results are read-only too. A computed field may not call it: that is the build error `MESH_COMPUTED_COMPOSES`, because a computed field is the entity's own rule over the record. A computed body may not be `async` or use `await` either (`MESH_COMPUTED_ASYNC`); one that returns a promise anyway is refused at run time, naming the field. A read policy that calls `Mesh.privileged` directly is the build error `MESH_READ_POLICY_PRIVILEGED`, at the call. A helper hides the call from the build, so `Mesh.privileged`, and an entity's action too, also throw a `FrameworkError` naming the field or policy when they run while a computed field or a read policy is being evaluated. A leftover `tx` or `actions` parameter in an entity file is the build error `MESH_REMOVED_SCOPE_NAME`, which names what replaces it: `Mesh.privileged` and a call on the entity value.

Steps run in written order, before the action's own row is written. A `run` step with `after=:write` runs after that row is written, still inside the transaction, and sees the stored record as `self`. Use it when what you call must see the result, or when the records it writes must follow the action's own:

```text "src/domain/billing/invoice.mesh.mx (excerpt)"
run [after=:write] ({ self, context }) {
  await Receipt.record({ invoiceId: self.id, amount: self.amount }, { ...context, system: true });
}
```

An application may open the same kind of transaction itself; see [several actions in one transaction](./using-your-domain.md#several-actions-in-one-transaction).

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

`always` takes an action body and applies it across a scope. Its checks run before the action's checks, and its steps before the action's steps. It may hold `validate`, `do` or both. Its `validate` may use a named check with `check &name`, which the build then checks for each action the block covers, and an action that lists the same named check itself, or through a second block, is a build error, since it would run the check twice.

The larger example uses `always types=[:create, :update]` for a date rule on every create and update. `actions=[&send, &pay]` instead names particular actions. Neither option means every action in the entity.

## policies

One policy per line, with a name, a scope and checks. The larger example below shows all three common patterns: owners or staff may read; staff may write; nobody may destroy a paid invoice.

| Option | Scope |
|:--|:--|
| `types=[:read]` | Every action of any listed type |
| `actions=[&send, &pay]` | Those actions by name |
| neither | Every action in the entity |
| `when=` | Apply the policy only when the condition holds |

A policy passes when none of its `forbid-if` checks holds and, if it has any `authorize-if`, at least one holds. The checks combine without order. A policy with only `forbid-if` passes until one is true. Every policy covering the action must pass; an action no policy covers is forbidden, including every action in an entity with no policies. A check whose answer is unknown, because a value it reads is null, fails closed: an unknown `forbid-if` forbids, an unknown `authorize-if` does not authorize, and an unknown `when=` fails its policy. Which policies cover an action is decided by `types=` and `actions=` alone; `when=` decides whether a covering policy applies to the call, and a call that none of the covering policies applies to is denied. A policy needs at least one `authorize-if` or `forbid-if`: one with neither would let every caller through, so it is a build error, and a policy meant to admit everyone says so with `authorize-if=() => true`. `actions=` names the entity's own actions, auto ones included; any other name, and an empty list, is a build error. A policy decides and does not act: it neither reads `before` nor calls another entity's action, and either is a build error. It may not ask another action's policies either, with `Mesh.can` or `Mesh.checkPolicies` (`MESH_POLICY_ASKS`), because the policy it asks could ask back, and the build cannot see where that ends. The build error covers a call written as `Mesh.can(...)` or `Mesh.checkPolicies(...)` in the policy itself; one a helper of a write policy hides runs, and a question asked more than 32 deep, each inside a policy of the one before, throws a `FrameworkError`.

An exemption belongs in the condition: `forbid-if=({ actor }) => &status === :paid && !isStaff(actor)` forbids destroying a paid invoice except for staff.

A policy on a write may also read other entities through `Mesh.privileged`, the reads without policies, usually inside a helper. A write action's check that calls `Mesh.privileged`, or any function the file imports (the build cannot see what an imported function reads), counts as reading the record: it runs inside the transaction, on the locked row, so a value it reads, such as the actor's current role, cannot go stale between the check and the write. The cost is that a check calling a pure imported helper also waits for the lock:

```mx "src/domain/work/task.mesh.mx"
import { isActiveOwner } from "./task.helpers"

entity :Task
  attributes
    uuid :id primary-key
    string :title min=1

  actions auto=[:read, :update]

  policies
    policy :ownersWrite types=[:update]
      authorize-if=async ({ actor }) => await isActiveOwner(actor)
```

The helper reads the membership itself:

```ts "src/domain/work/task.helpers.ts (excerpt)"
import { Mesh } from "meshfw";

export async function isActiveOwner(actor: { id: string }) {
  const [membership] = await Mesh.privileged(Membership).read({ filter: { userId: { eq: actor.id } }, limit: 1 });
  return membership?.role === "owner";
}
```

A helper that reads data is `async`, so the check awaits it inside an `async` arrow, as above. That check is plain code: it runs in memory inside the transaction, after the locked read. Calling an `async` helper without `await` is a mistake: the check would get a promise instead of a boolean. Type-check the project including `.mesh/` (`tsc --noEmit`) and the compiler refuses it for a typed helper (TS2345, in the generated expressions file); an untyped helper throws a `FrameworkError` that names the helper at run time.

A read policy reads no other entity: it is a filter on the query. An imported function there is a pure call, evaluated once and bound as a parameter, with no lock to wait for, and a helper there that calls `Mesh.privileged` throws at run time (`Mesh.privileged` called directly in the policy is a build error). It also decides what a caller loads from another entity: a relationship or a rollup that reaches this entity runs its read policies, and a caller they do not admit gets `[]`, `null` or `0` there, never an error.

On a load, a read policy's `input` is empty (`{}`): a load has no read input, so a policy that decides loads too reads `actor` and `context`. A computed field's body runs no policy on what it reads: it is the entity's own rule, worked out the same for every caller, as `Mesh.privileged` is, and its value is shown to whoever may read the record. So on a post, `count :n of=&comments` counts the comments the caller may read, while `integer :n() { return &comments.length }` counts every comment. A relationship to an entity whose policies cover other actions but not its `read` (only `actions=[&list]`, say) loads nothing for any caller, and the build warns at the relationship (`MESH_LOAD_NO_POLICY`).

When a check reads the stored row, a denied caller is told forbidden, on every write. On a write that runs as one statement, the policy check compiles into the statement as an expression that raises, each data adapter supplying it (not built; [ADR-0046](../architecture/decisions/0046-denied-atomic-write-outcome.md), option B). `Mesh.checkPolicies(Task.update, input, context)` gives the reason, as a breakdown. A policy sees `self` as a check does, before the input is applied: on an update or destroy the stored record, on a create the new record with its defaults and a `uuid` or `string` key, and the caller's values in `input`. So a create policy on a list's todos reads `input.list`, not `&list`, and a related-row read there is a query inside the transaction before the insert; reading `&list` in a create policy draws a warning (`MESH_POLICY_NOT_APPLIED`), as it does in a check. The todo file at the top of this page is written that way: `policy :owner` leaves out `create`, because no list is stored yet to read `&list.ownerId` from, and `policy :ownerCreates` finds the list from `input.list` through `Mesh.privileged(List)` and lets only its owner add a todo. A policy may not share a name with an action (`policy :create` beside `create :create` is a duplicate member), so the policy has its own name. An update or destroy of a row that does not exist is reported as not found before any policy that reads the record runs. A policy check that reads the record runs inside the transaction, after the row is read under the lock and before `validate`, so a caller who may not run the action is told forbidden, never that their input is invalid.

## Building one

```bash
mesh build
```

The build rejects unknown declarations, options and members, a member input with options, duplicate input names, two entities in one file, a check without `that`, an `on:load` that does not name a read, a relationship to an entity that has neither `on:load` nor an auto read, a read policy that calls `Mesh.privileged`, and a capability the adapter does not declare. Code Mesh cannot translate where SQL is required (a read's `filter`, a sort key, a read policy's condition) is an error (`MESH_EXPR_NOT_SQL`): a function that is not one expression, a helper given the record, or a computed field Mesh runs in memory, read there directly or through another one. Each diagnostic names the file, line, column and code:

```text
src/domain/todo/todo.mesh.mx:22:9 error MESH_UNKNOWN_MEMBER &titel is not a member of todo.Todo. Did you mean &title?
```

Run `mesh inspect Todo` to see the declarations with source positions, and `mesh explain Todo complete` to see the action's plan. Both are in [Command line](./command-line.md).

## What `self` holds

`&name` reads a member of this record. `input` is always the caller's object, `actor` the caller and `context` the rest of the action context.

| Where | The record is |
|:--|:--|
| a check in `validate` | The record before the input is applied: on an update or destroy the stored record, read under the lock; on a create the new record Mesh builds, with its defaults and a `uuid` or `string` key, and `null` in a member nothing has filled yet. The caller's values are in `input`; `before` is not available. Related records (`&owner.todoCount`) are read on demand |
| a step in `do` | The record with the member inputs applied, as earlier steps left it. `before` is the stored record (`null` on a create) |
| a `run [after=:write]` step | The record as written, with an `integer` key filled |
| a filter on a read | Each row the query considers |
| a policy on a read | The row |
| a policy on an update or destroy | The stored record, before the input; the caller's values are in `input` |
| a policy on a create | The new record before the input: defaults and a `uuid` or `string` key; the caller's values are in `input` |
| a computed field | The loaded record. `before` is not available: a loaded record has no earlier version, and reading it is a build error (`MESH_COMPUTED_BEFORE`) |

## In short

| Section | A line looks like | Example |
|:--|:--|:--|
| `attributes` | `type :name options` | `string :title min=1` |
| `relationships` | `kind :name entity=ImportedName` | `belongs-to :list entity=List` |
| `computed` | `type :name() { … }` or a rollup | `count :todoCount of=&todos` |
| `checks` | `check :name` with the options of a check, used as `check &name` in `validate` | `check :invoiceHasLines that=() => &lineCount > 0 code="invalid_state" message="…"` |
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
      return &status === :sent && &dueOn < %.today
    }
    string :label() {
      return &number + " · " + formatMoney(&total)
    }
    count :lineCount of=&lines
    sum :total of=&lines.amount

  checks
    check :invoiceHasLines [
      that=() => &lineCount > 0
      code="invalid_state"
      message="an invoice needs at least one line"
    ]

  actions auto=[:read, :destroy] on:load=&visible
    always types=[:create, :update]
      validate
        check :dueAfterIssue [
          that=({ input }) => (input.dueOn ?? &dueOn) >= (input.issuedOn ?? &issuedOn)
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
        check &invoiceHasLines
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
        check &invoiceHasLines
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

Seven things to notice:

- **`&customer` takes the customer's id.** The relationship points at the imported `Customer`, and the create takes it through `input`.
- **`decimal :amount min=0` says "not negative".** The `always` block holds the rule that needs two fields, `check :dueAfterIssue`.
- **`invoiceHasLines` is written once.** `send` and `pay` enforce the same rule, so `checks` declares it and both list it with `check &invoiceHasLines`.
- **`pay` stores its input and makes changes in order.** It takes `&paidAt`, sets the status and payer, and marks a large invoice for review under `when`.
- **`read :forCustomer` declares an argument.** `input.customerId` is compared with `&customer.id`, without a join. It is an input name, not a stored field declared in the file.
- **`label` calls a helper on `&total`.** It runs in memory; `isOverdue` is one translatable expression and may be used in a SQL filter.
- **`policy :neverDestroyPaid` has only `forbid-if`.** It forbids while paid and passes otherwise.

## Next

- [Using your domain](./using-your-domain.md) — what the generated functions take and return.
- [Configuration](./configuration.md) — the project, adapters and extensions.
- [Command line](./command-line.md) — every `mesh` command.

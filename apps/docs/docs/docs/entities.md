---
title: "Entities"
description: "Every tag an entity file may use: attributes, relationships, actions, validations, changes, policies, calculations and aggregates."
---

# Entities

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

An entity file is one `.mx` file in your project's domain folder. It holds one entity: its data, the operations on it, and the rules around those operations. This page is the reference for every tag such a file may use, organised by the block it belongs to.

Everything here is in Marko's concise syntax: indentation, no angle brackets. A block is introduced by its tag and continues until the indentation changes. Tag and attribute names are [Ash](https://ash-hq.org)'s, in kebab-case with the trailing `?` dropped, so `belongs_to` is `belongs-to` and `allow_nil?` is `allow-nil`. Names you choose, such as an attribute called `authorId`, and everything inside an expression are yours and stay as written.

## The shape of a file

```mx
entity="todo" table="todos"
  attributes
    uuid-primary-key="id"
    attribute="title" type="string" allow-nil=false

  relationships
    belongs-to="list" destination="list"

  actions defaults=["read", "destroy"]
    create="create" accept=["title", "listId"]
      validate=({ todo }) => todo.title.length > 0 message="title must not be empty"

  policies
    policy=action_type(["create", "read"])
      authorize-if=({ todo, actor }) => todo.list.ownerId === actor.id
```

`attributes` is the only required block. Every block is optional after that, and every block may be empty.

**Values Mesh reads are literals.** A string, a number, `true`, `false`, a list or an object literal written out in full. A bare identifier is a build error, not an import: an entity file declares data, it does not run code. The exceptions are the five tags whose value is a function — `change`, `validate`, `filter`, `authorize-if` and `value` — and those take an arrow function or a method.

**Hand-written code lives next to the file.** `src/domain/todo/todo.helpers.ts` is a normal TypeScript module beside the entity, and a `change` or a `validate` reaches it by relative path from the `.mx` file:

```ts "src/domain/todo/todo.helpers.ts"
export function titleIsLongEnough(title: string): boolean {
  return title.trim().length > 0;
}
```

```mx
    validate=({ todo }) => titleIsLongEnough(todo.title) message="title must not be empty"
```

**What a function body may use.** The record, `actor`, `context`, the action's `input`, and Mesh's registered functions: comparisons and boolean operators, arithmetic, string `length`, and assignment to a field. Nothing else, so the build can say when a rule cannot run in the database and needs a read first.

## The entity line

| Attribute | Required | Meaning |
|:--|:--|:--|
| default, as in `entity="todo"` | yes | The entity's name. Every generated function is named after it, and it must be unique across the domain |
| `table` | no | The database table. Defaults to the entity's name |

The folder that holds the file is the group: entities in `src/domain/todo/` belong together, and no attribute in the file repeats the folder's name.

## attributes

The data fields. Children: `uuid-primary-key`, `attribute`, `create-timestamp`, `update-timestamp`, each at most once except `attribute`, which repeats.

### The key and the timestamps

| Tag | Meaning |
|:--|:--|
| `uuid-primary-key="id"` | A UUID primary key. Mesh generates the value, so it is never accepted from a caller |
| `create-timestamp="insertedAt"` | A field set by the database on insert and never accepted |
| `update-timestamp="updatedAt"` | A field set by the database on every write and never accepted |

These three take the field name as their value and nothing else. An entity has one primary key; a database row needs one.

### attribute

| Attribute | Required | Meaning |
|:--|:--|:--|
| default | yes | The field name |
| `type` | yes | One of `string`, `integer`, `float`, `boolean`, `uuid`, `datetime`, `atom` |
| `allow-nil` | no | `false` makes the column not nullable. Nullable unless you say otherwise |
| `constraints` | when `type="atom"` | The allowed values, as `constraints={ one_of: ["draft", "published"] }`. This one key is `one_of`, not `one-of`: it is a fixed spelling, not a tag or an attribute name. An empty list, a blank or a repeat is a build error |
| `default` | no | A literal that fits the type: an integer, a number, one of the `one_of` values, `true` or `false` |

The TypeScript type follows: `string` and `uuid` are `string`, `integer` and `float` are `number`, `boolean` is `boolean`, `datetime` is `Date`, and `atom` is the union of its `one_of` values.

```mx
entity="post"
  attributes
    uuid-primary-key="id"
    attribute="title" type="string" allow-nil=false
    attribute="status" type="atom" constraints={ one_of: ["draft", "published"] } default="draft"
    attribute="views" type="integer" default=0
    attribute="publishedAt" type="datetime" allow-nil=true
    create-timestamp="insertedAt"
    update-timestamp="updatedAt"
```

`status` is typed `"draft" | "published"` in TypeScript, so a caller that sends `"archvied"` does not compile and would be rejected at run time if it slipped past.

A field name may not be one of JavaScript's built-in object property names: `__proto__`, `constructor`, `prototype`, `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`, `toString`, `valueOf`, `__defineGetter__`, `__defineSetter__`, `__lookupGetter__` or `__lookupSetter__`. Mesh cannot validate a value safely against those.

## relationships

Children: `belongs-to` and `has-many`, both repeatable. Each takes the relationship's name as its value and the other entity's name in `destination`.

| Tag | Meaning |
|:--|:--|
| `belongs-to="list" destination="list"` | Many todos belong to one list. Adds the `listId` attribute, the foreign key and `todo.list` |
| `has-many="todos" destination="todo"` | One list has many todos. Adds no attribute, and gives `list.todos` when you ask for it |

`belongs-to` creates its foreign-key attribute from the relationship's name: `belongs-to="list"` gives you `listId`. Change the name to `parent` and the attribute is `parentId`.

The other side is not automatic. If `todo` declares `belongs-to="list"`, the list knows nothing about it until `list.mx` declares `has-many="todos"`. Both sides are useful: `todo.list` reads one row, `list.todos` reads many.

```mx
entity="todo" table="todos"
  attributes
    uuid-primary-key="id"

  relationships
    belongs-to="list" destination="list"
```

## actions

The operations. `defaults` is a list of built-in actions to generate without declaring them: any of `create`, `read`, `update`, `destroy`, no repeats. Children: `create`, `update`, `read`, `destroy`, each repeatable.

```mx
  actions defaults=["read", "destroy"]
    create="create" accept=["title"]
    update="complete"
    read="pending"
      filter=({ todo }) => todo.done === false
```

An action asked for by `defaults` is named after its type, which is why the default read is `readTodo` and the default destroy is `destroyTodo`. A declared action is named by its value, which is why `update="complete"` becomes `completeTodo`.

| Tag | Extra attributes | Children |
|:--|:--|:--|
| `create` | `accept` | `change`, `validate` |
| `update` | `accept`, `require-atomic` | `change`, `validate` |
| `destroy` | `accept` | `change`, `validate` |
| `read` | none | `filter`, `sort`, `validate` |

`accept` is a list of field names, with no blanks and no repeats; `accept=[]` is valid and means the action takes only an id. A field that is not accepted and not filled by a change is a build error, not a field silently left empty.

### change

One per action. A function that edits the record before it is written. On an update, if it reads a stored value the action cannot run as one statement, and it must say `require-atomic=false`; the build fails otherwise rather than making the choice for you.

```mx
    update="complete"
      change=({ todo }) => { todo.done = true }
```

The body receives one object, destructured in the tag. It holds the record under the entity's name (`todo` here), the caller under `actor`, the rest of the caller's context under `context`, and the caller's input under `input`. The same four parameters are what `validate` gets, and a validation sees the record as it will be after the action's changes. See [the action context](./calling-actions.md#the-action-context).

### validate

Repeatable, with an optional `message`. If it returns false the call fails with an `InvalidInputError` carrying that message, and the issue names the file, line and column of the `validate` tag. A validation sees the record as it will be after the action's changes.

```mx
    create="create" accept=["title"]
      validate=({ todo }) => todo.title.length > 0 message="title must not be empty"
```

### filter

One per read. A function returning a boolean, and it must be translatable to SQL, so it may use the record's fields, comparison and boolean operators, and the registered functions, and nothing else. The caller's own filter and the policies are combined with it before the query is sent.

```mx
    read="pending"
      filter=({ todo }) => todo.done === false
```

### sort

One per read. A list of field names, ascending, with `-` in front for descending. The caller's `sort` uses the same strings.

```mx
    read="recent"
      sort=["-insertedAt"]
```

## policies

Children: `policy`, repeatable. Each policy is a condition, and an action with no matching policy is **forbidden**. That is deliberate: forgetting a rule must not open an action.

```mx
  policies
    policy=action_type("create")
      authorize-if=() => true
    policy=action_type(["read", "destroy"])
      authorize-if=({ list, actor }) => list.ownerId === actor.id
```

A policy's value is a check, or a list of checks. **A list of checks means all of them must hold**: `policy=[action_type("update"), action("publish")]` applies to an update action named `publish`.

| Check | Meaning |
|:--|:--|
| `action_type("read")` | Any action whose type is `read` |
| `action_type(["read", "destroy"])` | Any action whose type is **either** |
| `action("publish")` | The action with that name |
| `action(["publish", "archive"])` | Either named action |

The distinction matters: the list inside `action_type` is "or", the list of policies is "and".

### authorize-if

One per policy, required. A function returning a boolean. It receives the record under the entity's name, `actor`, and `context`. When the check reads the stored row, Mesh folds it into the statement's filter, so a row the caller may not see is reported as not found rather than forbidden. `can<Action>` is how you ask for the reason instead.

## calculations

Children: `calculate`, repeatable. A derived value, not a stored column. Each takes a name and a `type`, and needs one `value` child.

```mx
  calculations
    calculate="label" type="string"
      value({ todo }) {
        return (todo.done ? "[x] " : "[ ] ") + todo.title
      }
```

A calculation you ask for by name in `load`, and nowhere else. Reading one that was not loaded is a type error.

Mesh decides at build time whether the expression can be translated to SQL. One that can runs inside the query. One that cannot is **opaque**: it runs in memory after the rows are loaded, it cannot appear in a `filter` or a `sort` (the build fails), and it costs one extra pass. String concatenation and a conditional on a string are not translatable; comparison, boolean operators, numeric `+` and `-` and string length are.

## aggregates

Children: `count`, repeatable. A number Mesh computes from stored rows, asked for by name in `load`.

```mx
  aggregates
    count="todoCount" relationship-path="todos"
```

`relationship-path` is the name of a relationship declared on this entity. Unlike a calculation, an aggregate always runs in SQL, so it can be filtered on and sorted by.

## Building one

```bash
bunx mesh build
```

The build rejects a tag, an attribute or a value outside this reference, a tag it does not implement, an `accept` naming a field the entity does not have, two entities with the same name, two entities in one file, a free variable in an expression, and a data-layer capability the configured adapter does not declare. Every diagnostic names the file, the line and the column:

```text
src/domain/todo/todo.mx:11:21 error `accept` names "titel", which is not an attribute of todo. Did you mean "title"?
```

To see what Mesh read, including the source position of every tag, run `mesh inspect todo`. To see the plan an action's handler follows, run `mesh explain todo complete`. Both are in [the command line](./configuration.md).

## Next

- [Calling actions](./calling-actions.md) — what the generated functions take and return.
- [Configuration and the command line](./configuration.md) — the file that points Mesh at this one, and every command.
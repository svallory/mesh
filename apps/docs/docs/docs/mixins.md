---
title: "Mixins"
description: "Mixin files: a block of entity sections written once and included by any entity with a use mixin= line, whose declarations become the entity's own members as if written there, after the entity's own; what a mixin cannot hold, and the errors."
---

# Mixins

::: callout warning "Not released"
Mesh is not released yet. These pages describe what Mesh will be.
:::

A **mixin** is a block of declarations written once and included by any entity that needs it: the same audit columns on every entity of a module, the same rule in every entity that has an amount. A mixin is a file of its own whose root line is `mixin :Name`; an entity includes it with one `use mixin=Name` line ([ADR-0082](../architecture/decisions/0082-named-checks-and-mixins.md)).

## A mixin file

A mixin file may sit anywhere under the domain root, and it belongs to no module: nothing is generated from it. Its root line takes only its name, kept as written (`mixin :Audited` is `Audited`; there is no class-name conversion, since Mesh generates no type from a mixin). Under it go any of the sections an entity holds, each at most once: `attributes`, `relationships`, `computed`, `checks`, `actions`, `policies` and `handlers`.

```mx "src/domain/shared/audited.mesh.mx"
mixin :Audited
  attributes
    uuid :createdBy
    uuid :updatedBy nullable
```

## Including a mixin

An entity imports the mixin by relative path, by the name the mixin file declares, and includes it with `use mixin=Name`, one line per mixin. The name may be an alias (`import { Audited as A }`, `use mixin=A`) or a member of a namespace import (`import * as shared from "../shared/audited.mesh.mx"`, `use mixin=shared.Audited`).

```mx "src/domain/billing/invoice.mesh.mx"
import { Audited } from "../shared/audited.mesh.mx"

entity :Invoice
  use mixin=Audited
  attributes
    uuid :id primary-key
    decimal :amount min=0
  actions auto=[:read]
    read :byAuthor
      sort
        desc &createdBy
```

What the mixin declares joins the entity as if it were written there: `Invoice` has the attributes `id`, `amount`, `createdBy` and `updatedBy`, and its generated record type, validators, table and actions are those of the same entity with the two lines written in its own `attributes`.

**Order.** Within each kind of member, the entity's own come first, in written order, then each mixin's, in the order of the `use` lines, wherever the `use` lines are written. Write them first, as above: the entity's primary key stays its first column.

**As if written there.** A mixin's lines are read with the entity that uses it:

- a `&name` in a mixin is a member of that entity, so a mixin may read a member only its includers declare (a mixin's `check :positive that=() => &amount > 0` reads each includer's `amount`), and an includer that lacks it gets `MESH_UNKNOWN_MEMBER` naming the entity;
- a mixin's `actions auto=[...]` generates actions of each includer, and its `always` block covers the includer's actions (an `actions=` list may name an action only the includer declares);
- a computed field or rollup of a mixin reads the includer's relationships;
- a named check of a mixin's `checks` section is used by the includer's `validate` with `check &name`;
- a mixin's policy covers the includer's actions as one written in the entity does. Policies are fail-closed, so a mixin's policy can authorize actions of every entity that uses it: read a mixin's policies before you use it.

A mistake in a mixin's lines is reported in the mixin's file, once for all the entities that use it. When only some of them have it (one includer's `amount` is a string, say), most messages start by naming them: `in billing.Quote, which uses this mixin, ...`. A message that names the entity itself comes once for each entity it applies to: `MESH_UNKNOWN_MEMBER` (`&amount is not a member of billing.Quote.`), `MESH_POLICY_NO_CHECKS` for a mixin's policy with no `authorize-if` or `forbid-if`, and an `always` block's `actions=` that names a read (`MESH_OPTION_VALUE`).

## Mesh's mixins

Mesh ships two mixins, imported by name from `"meshfw/mixins"` and included like a project's:

```mx "src/domain/notes/note.mesh.mx"
import { Timestamps, Versioned } from "meshfw/mixins"

entity :Note
  use mixin=Timestamps
  use mixin=Versioned
  attributes
    uuid :id primary-key
    string :body
  actions auto=[:create, :read, :update]
    read :recent
      sort
        desc &insertedAt
```

`Timestamps` holds the two stamps, set by Mesh from the transaction's instant:

```mx "meshfw/mixins/timestamps.mesh.mx"
mixin :Timestamps
  attributes
    timestamp :insertedAt on=:create
    timestamp :updatedAt on=:update
```

`Versioned` holds a version number that every update adds 1 to, generated or declared, whatever the update does:

```mx "meshfw/mixins/versioned.mesh.mx"
mixin :Versioned
  attributes
    integer :version default=1
  actions
    always types=[:update]
      do
        set
          &version=() => &version + 1
```

A create stores 1. The block's steps run before the update's own and after all its checks, so a check that compares the caller's version with `&version` reads the stored one and a refused update leaves it ([A version number that refuses a stale update](./entities.md#a-version-number-that-refuses-a-stale-update)). An entity that uses `Versioned` does not set `&version` itself: a `set &version` in an update is `MESH_DUPLICATE_SET`, since a member is set once per action. `Versioned` does not combine with `lock &version` in an update, since the lock writes the version itself: the block's `set` is then `MESH_LOCK_MEMBER`, at the `use` line. Use one or the other in updates. A `lock &version` in a destroy alone still builds: the updates bump the version and the destroy compares it.

The import binds the names as written in the files (`import { Versioned as V }` and `use mixin=V` is `Versioned`); a namespace, default or type import of `"meshfw/mixins"` is `MESH_IMPORT_FORM`, and another name `MESH_UNKNOWN_IMPORT`. Their lines are in no file of your project, so whatever they declare is placed at the `use` line: `mesh inspect`, `model.json` and every message about `insertedAt` or the bump point there. Only an entity file imports them.

## What a mixin cannot hold or do

- **No import.** A mixin file takes no import (`MESH_UNKNOWN_IMPORT` at the import). So its relationships cannot name another entity (`MESH_UNKNOWN_ENTITY`), its functions cannot call `Mesh` or a helper (`MESH_EXPR_FREE_VARIABLE`), an action cannot answer a command (`on=`, `MESH_UNKNOWN_COMMAND`) or publish an event (`MESH_PUBLISH`), and a handler cannot name the event it handles (`MESH_UNKNOWN_EVENT`).
- **No `events` or `commands` section** (`MESH_TAG_NOT_ALLOWED`): an event or a command is owned by an entity or an aggregate.
- **No `use`** (`MESH_TAG_NOT_ALLOWED`): a mixin includes no mixin.
- **No `on:load=` or `max-limit=`** on its `actions` line (`MESH_UNKNOWN_OPTION`): the entity that uses the mixin chooses the read that loads it and caps its own reads.
- **No value.** A mixin's name read in a function is `MESH_EXPR_FREE_VARIABLE`.

A mixin that no entity uses is checked by its line contracts only; its other mistakes are reported once an entity uses it.

## Errors

| Code | When |
|:--|:--|
| `MESH_DUPLICATE_MEMBER` | A name the mixin brings in is the entity's own too, or another mixin's the entity uses (a check on either side included), at the `use` line: `Duplicate member :createdBy: the mixin Audited declares it, and so does Invoice`. An `auto=` type both list: `Duplicate member :read: the mixin Audited generates it with auto=, and Invoice generates or declares it too`. The same mixin used twice: `Duplicate use of the mixin Audited: this entity already uses it`, at the second line. Two members of one name inside one mixin are reported in the mixin's file. |
| `MESH_UNKNOWN_IMPORT` | `use mixin=X` where no import binds `X` to a mixin (`X is not an imported mixin`), a named import of a name the mixin file does not declare, any import in a mixin file, a name `"meshfw/mixins"` does not give, an import of `"meshfw/mixins"` in a file other than an entity file. |
| `MESH_IMPORT_FORM` | A namespace, default, type or side-effect import of `"meshfw/mixins"`. |
| `MESH_DUPLICATE_SET` | A member a mixin's `always` block sets that an action it covers sets too (`&version is already set in update :edit of notes.Note by the \`always\` block of the mixin Versioned (line 5), ...`). |
| `MESH_OPTION_VALUE` | `mixin=` is not a reference written bare (`mixin=foo()`, `mixin=(Audited)`, `mixin="Audited"`). |
| `MESH_MISSING_OPTION` | `use` with no `mixin=`; `mixin` with no name. |
| `MESH_UNKNOWN_OPTION` | `use :timestamps` (there is no atom form), `use preset=` in an entity file, an option on the `mixin` line, `on:load=` or `max-limit=` on a mixin's `actions`. |
| `MESH_TAG_NOT_ALLOWED` | `events`, `commands` or `use` under `mixin`; a line under `use`. |
| `MESH_DUPLICATE_ENTITY` | A mixin file with a second root line: `A mixin file must contain exactly one mixin`. |

## Next

- [Entities](./entities.md): the sections a mixin holds.
- [Project structure](./project-structure.md#the-domain): where files go.

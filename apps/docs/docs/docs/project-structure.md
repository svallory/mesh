---
title: "Project structure"
description: "Where entity files, generated code, configuration, extensions and migrations live, and which files you commit."
---

# Project structure

::: callout warning "Not released"
Mesh is not released yet. These pages describe what Mesh will be.
:::

Mesh does not own your project. It reads the entity files you write and writes the code you call; everything else is yours. This page shows how a project grows beyond the starter, what each part is for, and what belongs in version control. The starter has one List entity, `src/context.ts` and `src/demo.ts`; the [tutorial](./tutorial.md) adds Todo, `src/main.ts` and a test.

```text
todo-app/
  .mesh/                  generated; never edited; imported as "#mesh" and "#mesh/domain/…"
  migrations/             SQL from `mesh migrate generate`
  mesh.config.ts          what Mesh reads
  package.json            "imports" maps "#mesh" and "#mesh/domain/…" into .mesh/
  src/
    domain/               your domain
      accounts/
        user.mesh.mx
      todo/
        list.mesh.mx
        todo.mesh.mx
        todo.helpers.ts    hand-written code that todo.mesh.mx calls
    surfaces/             surface files, one folder per audience, when mesh.config.ts sets `surfaces`
      admin/
        admin.mesh.mx
    extensions/           project-local extensions, if any
    context.ts            declares the action context type
    main.ts               the program (Mesh does not prescribe this)
  test/
    todo.test.ts          tests, which bind their own database
```

Mesh prescribes nothing under `src/`. `context.ts`, the starter's `demo.ts` and the tutorial's `main.ts` are only convention; what matters is that the domain folder is where the `.mesh.mx` files are, and that surface files sit in the folder `surfaces` names, outside the domain ([Configuration](./configuration.md#surfaces)).

## The domain

`src/domain/` is the domain: everything your program stores. Inside it, each folder is a group of entities that belong together. `src/domain/todo/` holds `list.mesh.mx` and `todo.mesh.mx`; `src/domain/accounts/` holds `user.mesh.mx`.

The folder is the module, so nothing in the file repeats it. `todo.mesh.mx` does not carry a `module=` option, and the generated code for a folder lands in one place.

Two folder rules decide a file's module:

- **A nested folder is a submodule.** `src/domain/todo/reminders/reminder.mesh.mx` belongs to module `todo/reminders`, its generated code goes to `.mesh/domain/todo/reminders/`, and your code imports it as `#mesh/domain/todo/reminders`.
- **A folder whose name starts with `_` only organises files.** A file's module is its folder path with every segment that starts with `_` removed (a segment that is only `_` is an error). `src/domain/todo/_scheduling/schedule.mesh.mx` belongs to module `todo`, and its generated code goes to `.mesh/domain/todo/`. A group directly under `src/domain/`, such as `src/domain/_misc/`, belongs to the domain root. A group inside a submodule stays in that submodule: `todo/reminders/_x/` is module `todo/reminders`.

`_name/` is the only folder marker; a folder named only `_` is a build error. A group changes the module, not the file: imports still use the real path (`import { List } from "../list.mesh.mx"`), and a name stays in one place, so `entity :Task` in `tasks/` and again in `tasks/_x/` is a duplicate entity, `MESH_DUPLICATE_ENTITY`. A folder name uses letters, digits, `-` and `_`; any other character is `MESH_MODULE_NAME`. An entity is made private to its module by an option in its file, never by its folder.

To keep files out of Mesh altogether, list them under `ignore` in `mesh.config.ts`. It takes globs relative to the project root, and ignored files are not read, so errors in them are not reported. See [Configuration](./configuration.md#ignoring-files).

An entity file holds exactly one entity and ends in `.mesh.mx`. Two entities in one file is a build error. Another entity is imported by relative path: `import { List } from "./list.mesh.mx"`, then `belongs-to :list entity=List`, or the file as a namespace, `import * as lists from "./list.mesh.mx"`, then `belongs-to :list entity=lists.List`. Each file exports its declared entity name. Two folders may each declare an `entity :List` without conflict: the import path distinguishes them, each module's specifier exports its own `List`, and Mesh writes the two as `school.List` and `work.List` wherever it names an entity. The one thing they cannot share is a table: both would be stored in `list`, so give one of them `table=` (that is a build error, naming both, until you do).

Besides entity files, the domain folder holds event and command files ([Events](./events.md)), aggregate files and the architecture file, below. Each has one root line, which declares one thing of its kind; an aggregate file may also declare events and commands in its sections, as an entity file may.

### Aggregates

An aggregate is a root entity and the entities it writes together with it, one consistency boundary. Its file names them; it declares no data of its own:

```mx "src/domain/work/task-aggregate.mesh.mx"
import { Task } from "./task.mesh.mx"
import { Dependency } from "./dependency.mesh.mx"
import * as talk from "../talk/comment.mesh.mx"

aggregate :TaskAggregate
  root entity=Task
  entities
    Dependency prop=:dependent
    talk.Comment
  events
    event :TaskReopened
      uuid :taskId
```

`root entity=` names the root, once. Each line of `entities` is a part: an entity the file imports, or a member of a namespace import, alone on its line or with `prop=`. A part is tied to the root by one of its `belongs-to` links to the root: its only one, or, when it has several (Dependency has a `:dependent` and a `:prerequisite`), the one `prop=` names. A part with no `belongs-to` to the root, several and no `prop=`, or a `prop=` that names no `belongs-to` to the root is `MESH_AGGREGATE_PART`; so is the root listed as a part, and a part listed twice is `MESH_DUPLICATE_MEMBER`. A root or a part the file does not import is `MESH_UNKNOWN_ENTITY`.

An aggregate's `events` and `commands` sections work as an entity's do ([Events](./events.md#declaring-events-where-they-belong)): the events it lists or declares there may be published by the actions of its root and of every part, and by no other entity unless that entity owns them too. Another file imports an event the aggregate file declares from it by its class name (`import { TaskReopened } from "./task-aggregate.mesh.mx"`). The aggregate's own name is no value: nothing is generated from an aggregate, so it has no class, type or table, an import of `TaskAggregate` is `MESH_UNKNOWN_IMPORT`, and its name is kept as written. The aggregate is recorded in `model.json`. An entity may be a part of two aggregates; Mesh does not prevent it. An aggregate file imports `.mesh.mx` files only: it has no function to call a helper in.

### The architecture file

The architecture rules are checks Mesh runs over the whole domain, after every file is read. Each has a name and a default level, `warning` or `error`; a project with no architecture file runs every rule at its default level. The file `architecture.mesh.mx`, directly in the domain root and one per project, re-grades or switches off a rule:

```mx "src/domain/architecture.mesh.mx"
import { MeshRecommended } from "meshfw/architecture"

architecture :project
  use preset=MeshRecommended
  disable :service-touches-one-entity
  severity :action-calls-other-aggregate level=:error
```

Its root line is `architecture :name`, and it takes three kinds of line, each any number of times and none with a child:

- **`use preset=Name`** includes a preset, a named set of levels: an identifier the file imports from `meshfw/architecture`, written bare (an alias works, `import { MeshRecommended as Recommended }`). Mesh ships one, `MeshRecommended`, which sets every rule to its default level.
- **`severity :rule level=:error`** (or `level=:warning`) sets a rule's level. An `error` fails the build.
- **`disable :rule`** switches a rule off: it is not checked.

Presets apply first, in the order the file writes them, then the file's own `severity` and `disable` lines, whose order does not matter: one rule set by two of them is `MESH_DUPLICATE_MEMBER`, as is one preset used twice. A name that is no rule is `MESH_UNKNOWN_RULE`, with the nearest rule's name when one is close. The rules are:

| Rule | Default | What it reports |
|---|---|---|
| `:action-calls-other-aggregate` | `warning` | an entity action that calls a write action of an entity of another [aggregate](#aggregates) (`MESH_ACTION_CALLS_OTHER_AGGREGATE`); not checked yet |
| `:service-touches-one-entity` | `warning` | a service operation that touches one entity only (`MESH_SERVICE_ONE_ENTITY`); not checked until services exist |

Mesh's own invariants, such as an import that reaches outside the domain root, are ordinary build errors: no line of the file names, re-grades or disables one.

The file declares nothing, so no other file imports it (`MESH_UNKNOWN_IMPORT`), and it imports from `meshfw/architecture` alone, by name (another path is `MESH_UNKNOWN_IMPORT`, a namespace, default or type import `MESH_IMPORT_FORM`). An `architecture` line in a file anywhere else, a subfolder or another file name, is `MESH_ARCHITECTURE_FILE`, and that file is not read. With a list of files as `domain`, list the file too; the domain root is the common folder of the other files, so the file sits there and never moves the root. An `ignore` pattern that matches the file leaves it unread, and every rule runs at its default level. Nothing is generated from the file, and adding it changes no generated file.

A hand-written helper next to the entity that uses it is the ordinary way to keep an entity file small. `todo.helpers.ts` is a normal TypeScript module; a `check` or a `do` step in `todo.mesh.mx` calls into it.

## Generated code

`.mesh/` is written by `mesh build` and committed. You import it, and you never edit it: the guard in [the command line](./command-line.md#the-guard) fails the build if a file in it differs from what the build would write.

The entry points, in `package.json`:

```json
"imports": {
  "#mesh": "./.mesh/index.ts",
  "#mesh/domain": "./.mesh/domain/index.ts",
  "#mesh/domain/*": "./.mesh/domain/*/index.ts"
}
```

Your code imports a module's entities from that module's specifier, and what belongs to the whole project from `#mesh`:

```ts "src/main.ts (excerpt)"
import { connect, disconnect } from "#mesh";
import { List, Todo } from "#mesh/domain/todo";
```

- **`#mesh`** exports `connect`, `disconnect`, `bind`, `transaction`, `tables` and the `Binding` and `Privileged` types. It exports no entity.
- **`#mesh/domain/<module>`** exports the entities in that module, each as its entity value (`Todo`, whose methods are its actions) and its record type under the same name: `#mesh/domain/todo` for `src/domain/todo/`, `#mesh/domain/todo/reminders` for the submodule. It also exports one namespace for each submodule folder below it, so `import * as domain from "#mesh/domain"` reaches `domain.todo.reminders.Reminder`.
- **`#mesh/domain`** is the same for the entities directly in `src/domain/`, the domain root, and one namespace for each folder under it.

Every folder of `src/domain/` that is a module, or that holds one below it, has a generated `index.ts`: its entities and one namespace per module folder in it. A folder of submodules alone (`src/domain/sales/` holding only `billing/`) has an index with namespaces only, so `#mesh/domain/sales` works. The modules live under `.mesh/domain/`, apart from Mesh's own files, so a module may be called `schema` or `load` and still be `#mesh/domain/schema`. Never import a path into `.mesh` any other way: the paths behind the specifiers are an implementation detail and the specifiers are what stays stable.

**Folder names.** Your folder names are yours: Mesh imposes no case or style on them. A folder's name is written as it is in an import path (`#mesh/domain/order-management`) and in an entity's fully qualified name (`order-management.Invoice`). Only the namespace in a barrel needs a name that is a valid JavaScript identifier, so each character that is not valid in one becomes `_`, and a name that starts with a digit gets `_` in front: `order-management` is `domain.order_management` and `2024-reports` is `domain._2024_reports`. A folder named like a reserved word needs nothing: `domain.class` and `domain.default` work. Two sibling folders that come out the same (`order-management` and `order_management`) are a build error naming both, as is an entity and a folder of the same folder that would export one name (`entity :Billing` in `sales/billing.mesh.mx` beside a folder `sales/Billing/`). Two sibling folders whose names differ only in letter case are `MESH_EMIT_PATH`.

What is inside, for the tutorial's two entities:

| File | What it is |
|:--|:--|
| `.mesh/index.ts` | `#mesh`: `connect`, `disconnect`, `bind`, `transaction`, `tables`, `Binding` and `Privileged`, re-exported |
| `.mesh/binding.ts` | `bind`, which binds every entity to one data layer by walking the barrels, and the binding `connect()` opens, which an entity call outside `run` and `transaction` uses |
| `.mesh/domain/todo/index.ts` | `#mesh/domain/todo`, the module's barrel: its entities' values and types, and a namespace for each folder in it |
| `.mesh/domain/todo/list.types.ts` | `List` and the input types of its actions |
| `.mesh/domain/todo/list.actions.ts` | The entity value `List` and one function per action, with the whole lifecycle written out |
| `.mesh/domain/todo/list.validators.ts` | The schema each input is checked against |
| `.mesh/domain/todo/todo.types.ts` | `Todo`, `TodoInput`, and the same for each action |
| `.mesh/domain/todo/todo.actions.ts` | The entity value `Todo`: `create`, `complete`, `pending`, and the rest |
| `.mesh/domain/todo/todo.validators.ts` | The input schemas for those actions |
| `.mesh/schema.ts` | The database tables, written by the data adapter |
| `.mesh/model.json` | One document per entity, with the source position of every declaration |
| `.mesh/rules.md` | A short description of your entities and of Mesh's vocabulary, for a coding agent to read |

That is the whole of it. You should not have to think about any of it day to day, and you never have to edit it. Two reasons it is committed rather than hidden:

- **A reviewer reads what runs.** An entity file is a small declarative change. The TypeScript beside it is what the program actually executes, and reading the two diffs together is how you review a change to a rule.
- **`git diff` is the record of behaviour.** Adding an attribute shows up as a new column, a new type field and a new input key in one diff, in the file you changed.

Nothing is global in an entity file. A `.mesh.mx` file sees only its own declarations and what it imports; concepts are the one exception, shared across the project by nature. A folder named `concepts` is one Mesh reads by itself: every file directly in it is a concept file (`concepts/Money.mesh.mx` declares `concept :Money`), never imported, and used by its name as a line head (`Money :total`, [Entities](./entities.md#concepts)) in every file under the folder that holds it. A concept's module is that folder, so `src/domain/billing/concepts/Money.mesh.mx` is `billing.Money`, generated as `.mesh/domain/billing/money.concept.ts` and exported from `#mesh/domain/billing` as the type `Money` and the schema `moneySchema`. A project's concept never takes the name of a concept Mesh ships (such a file is `MESH_RESERVED_TAG`), and a nearer `concepts/` folder may declare a concept with the name of one in a farther folder: the nearer one wins for the files under it, with no message. No name has to be unique across the project, every reference to a declaration in another file is an import plus its identifier, and `use` is the one form that copies declarations. This is about scope in your entity files; the generated code and the runtime may still keep registries that reach every entity. Entity references are scoped to the importing file, not a project-wide index of names. A folder stays the module, and no top-level application name is needed: an entity's fully qualified name is its module's folders as written, a dot, and its name (`todo.List`, `sales.billing.Invoice`), and it is what Mesh prints in errors and seams.

## Configuration

`mesh.config.ts` at the project root names the data adapter, the folder holding your entity files, the output folder and the enabled extensions. [Configuration](./configuration.md) has it in full.

## Migrations

`migrations/` holds plain SQL files that `mesh migrate generate` writes and you commit. They are the record of how the database reached its current shape, and they are how another machine or another environment reaches the same shape. Nothing is ever applied automatically; `mesh migrate apply` is explicit.

## Extensions

`src/extensions/` holds a project-local extension, if you write one. An extension has two entries: a build-time half that contributes tags, transforms, verifiers, emitters and `mesh` subcommands, and a run-time half that supplies the behaviour. The run-time half imports only `@meshfw/runtime`, never the compiler, so a deployed program does not carry the build pipeline.

First-party extensions are installed from npm and enabled by name in `mesh.config.ts`. Authorization is not one of them: `policies` is a section of the entity file, so who may do what is core.

## Your own code

Everything else under `src/` is yours, and Mesh never reads it. In the tutorial:

- `src/context.ts` declares the action context's type, so every action's second argument is typed as whatever your application says it is. See [Using your domain](./using-your-domain.md#the-action-context).
- `src/main.ts` is the program: connect, call actions, disconnect.

## What to commit

| Path | Commit? |
|:--|:--|
| `src/**/*.mesh.mx` | yes |
| `.mesh/` | yes |
| `migrations/*.sql` | yes |
| `mesh.config.ts`, `package.json`, `bun.lock` | yes |
| `src/**` (your TypeScript) | yes |
| `test/**` | yes |
| `*.db`, `*.db-wal`, `*.db-shm`, `*.db-journal` | no |
| `node_modules/` | no |
| `.env` | no |

`.mesh/` is marked `linguist-generated` in `.gitattributes`, so GitHub and other viewers collapse it in a diff instead of showing a thousand lines of generated code.

## Next

- [Configuration](./configuration.md) — `mesh.config.ts`, the context and adapters.
- [Command line](./command-line.md) — every `mesh` command.
- [Testing](./testing.md) — where a test's files go.
- [Customising generated code](./customising-generated-code.md) — a proposal for changing what the generators emit.
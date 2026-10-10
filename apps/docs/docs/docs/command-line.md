---
title: "Command line"
description: "The mesh commands, their arguments and flags, exit codes, the build guard and migrations."
---

# Command line

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

`mesh` builds and inspects your project. It does not run your application's actions. Run it from the project root containing `mesh.config.ts`, after [installation](./quick-start.md#install):

```bash
mesh <command> [options]
```

## Commands and exit codes

| Command | What it does |
|:--|:--|
| `mesh init` | Writes `mesh.config.ts` and the folders, asking where your entity files are and where generated code goes |
| `mesh build` | Reads the entity files and writes `.mesh/` |
| `mesh build --check` | The guard: rebuilds in memory, writes nothing, fails on any difference with what is committed |
| `mesh inspect [entity]` | Prints the model as JSON, with the source position of every declaration |
| `mesh explain <entity> <action>` | Prints the plan that action's handler follows |
| `mesh db push` | Pushes the schema straight to the database. Development only |
| `mesh migrate generate [--allow <change>]` | Writes a SQL migration into `migrations/` |
| `mesh migrate apply` | Applies the migrations that have not been applied |
| `mesh export generators` | Copies the built-in templates into the project; see [Customising generated code](./customising-generated-code.md) |
| `mesh --help` | Lists the available commands, including those added by enabled adapters and extensions |

Square brackets mark an optional argument; angle brackets mark one you must supply. `--check` changes a build into a read-only comparison. `--allow <change>` permits a named destructive or ambiguous migration change; it never applies the migration.

The `db` and `migrate` commands come from the data adapter, which is why `meshfw` never imports a query library. Enabled extensions can add commands too; `mesh --help` lists the commands for your project.

Exit codes: `0` success, `1` errors were found, `2` usage error.

## init

```bash
mesh init
```

Writes the project configuration and folders, asking the same questions as the starter. See [Configuration](./configuration.md) for the file it writes; the [Quick start](./quick-start.md) creates a complete runnable app instead.

## build

```bash
mesh build
```

Reads your entity files, checks them and writes the types, action functions, input validators and schema to the configured output folder. Rebuild after changing an entity file, then commit the source and generated changes together.

### What a build error looks like

Every diagnostic names the file, the line and the column, both 1-based, and says what to do:

```text
src/domain/todo/todo.mesh.mx:22:9 error &titel is not a member of :Todo. Did you mean &title?
```

The same shape is used for an unknown declaration, one the build does not implement, a duplicate input name, a free variable in an expression and a capability the adapter does not declare. Nothing is silently dropped.

## The guard

```bash
mesh build --check
```

It runs the whole build, regenerates in memory, writes nothing, and fails if the result differs from what is committed. It catches two mistakes: a hand edit to a file in `.mesh/`, and an entity file you changed without rebuilding.

It is exact because the build is deterministic. The same entity files produce the same bytes, so a difference means something really changed.

Put it in the same script as your tests:

```json "package.json (excerpt)"
"scripts": { "test": "mesh build --check && bun test" }
```

## inspect

```bash
mesh inspect Todo
```

Prints the model as JSON: every attribute with its type and constraints, every action with what it accepts, every relationship, computed field and policy, each with the source position of the declaration it came from. Omit `Todo` to inspect the whole domain. It is the first thing to look at when a build error mentions a rule you did not expect, and it is what to paste into a [bug report](https://github.com/svallory/mesh/issues).

## explain

```bash
mesh explain Todo complete
```

Prints the plan the generated handler follows. The plan is chosen at build time; the handler then performs it without deciding anything at run time.

```text
Todo.complete (update)
  strategy     read-then-write: check notDoneYet reads &done
  steps        &done = true
  policy       &list.ownerId === actor.id   folded into the statement as a filter
  checks       notDoneYet
```

Two lines are worth learning:

- **`strategy`** is one statement (`atomic`) or `read-then-write`, and `explain` says why: a `check` or `when` that reads `self`, a `run` step, or an expression Mesh cannot translate. `Todo.complete` reads then writes because `check :notDoneYet` reads `&done`; `Todo.rename` is one statement because it has no check.
- **`folded into the statement`** means the rule costs no extra query. A rule that cannot fold runs in memory on the row read inside the transaction instead.

`explain` prints a plan, not SQL. Queries are assembled at run time from the entity's filter, the caller's filter and the policies, because which of those apply is only known when the call arrives.

## Migrations

During development, pushing the schema is quicker:

```bash
mesh db push
```

It creates the tables and columns and records no history. It is a development tool: never run it against a database whose contents you care about.

For anything you keep, generate a migration:

```bash
mesh migrate generate
mesh migrate apply
```

`mesh migrate generate` compares the committed schema with the model, and refuses a destructive or ambiguous change unless you name it: dropping a column, changing its type, renaming it, making an optional column required.

```bash
mesh migrate generate --allow drop:Todo.title
```

The name after the colon is the entity and the column, without the colon the entity file writes them with.

The migration is a plain SQL file in `migrations/`, and you commit it. Generating never applies anything; applying is a separate, explicit command. So a new machine, and your production environment, reach the same shape with `mesh migrate apply`.

## Next

- [Configuration](./configuration.md) — what the commands read and which adapter adds database commands.
- [Project structure](./project-structure.md) — what each command reads and writes.
- [Working with AI agents](./ai-agents.md) — `inspect` and `explain` are the tools an agent uses.

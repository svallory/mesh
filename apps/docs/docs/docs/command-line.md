---
title: "Command-line tool"
description: "Every mesh command: init, build, build --check, inspect, explain, and the database adapter's commands."
---

# Command-line tool

::: callout warning "Live spec, not released"
This page describes how Mesh **will** work, not how it works today. It is a live spec of the developer experience, written before the code. Mesh is not released: nothing here can be installed or run yet, and any detail may change.
:::

`mesh` is the developer command. It builds a project; it does not run your application's actions. Everything here is run from the project root, with `bunx mesh`, after [Installation](./installation.md).

```bash
bunx mesh <command> [options]
```

## The commands

| Command | What it does |
|---|---|
| `mesh init` | Writes `mesh.config.ts` and the folders, asking where resource files and generated files go |
| `mesh build` | Reads the resource files and writes the generated tree |
| `mesh build --check` | The guard: rebuilds in memory and fails on any difference with what is committed |
| `mesh inspect [resource]` | Prints the resource model as JSON; with no name, every resource |
| `mesh explain <resource> <action>` | Prints the plan that action's generated handler follows |

The data adapter contributes three more, so that `@mesh/cli` never imports a query library:

| Command | Contributed by | What it does |
|---|---|---|
| `mesh db push` | the SQL adapter | Pushes the schema straight to the database. Development only: no history |
| `mesh migrate generate [--allow <change>]` | the SQL adapter | Writes a SQL migration into `migrations/` |
| `mesh migrate apply` | the SQL adapter | Applies the migrations that have not been applied |

An enabled extension may contribute further subcommands. Extensions load only from `mesh.config.ts`, so `mesh --help` tells you which ones are active.

::: callout info "Not decided yet"
There is no `mesh watch` and no watch mode of any kind; the roadmap lists it as not planned. Editor diagnostics for `.mx` files arrive when MX ships editor support. Until then, run `bunx mesh build` after every change to a resource file.
:::

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Errors were found: build errors, or the guard found a difference |
| `2` | Usage error: an unknown command, a missing argument |

## What a build error looks like

Every diagnostic names the file, the line and the column, both 1-based, and says what to do:

```text
resources/todo.mx:13:21 error `accept` names "titel", which is not an attribute of todo. Did you mean "title"?
```

The same shape is used for a tag the vocabulary does not allow, a tag the compiler does not implement yet (which names the milestone that will), a duplicate resource name, a free variable in an expression, and a capability the configured adapter does not declare. Nothing is silently ignored.

## The guard

```bash
bunx mesh build --check
```

It runs the whole build, regenerates in memory, writes nothing, and fails if the result differs from what is committed. It catches two mistakes: a hand edit to a generated file, and a resource file changed without rebuilding.

It is exact because the build is deterministic: templates through a pinned formatter, same input, same bytes. In your project, run it in the same script as your tests.

## `inspect`

```bash
bunx mesh inspect todo
```

Prints the model as JSON: every attribute with its type and constraints, every action with what it accepts, every relationship, calculation, aggregate and policy, each with the source position of the tag it came from. It is the first thing to look at when a build error mentions a rule you did not expect, and it is what a bug report should include.

## `explain`

```bash
bunx mesh explain todo complete
```

Prints the plan that action's generated handler follows. The plan is chosen once, at build time, and the handler then performs it without deciding anything:

```text
todo.complete (update)
  strategy     atomic: one UPDATE, no read first
  changes      done = true                 folded into the statement
  policy       list.ownerId = actor.id     folded into the statement as a filter
  validations  none
```

`explain` prints a **plan, not SQL**. Nothing produces SQL at build time: queries are assembled at run time from the action's own filter, the caller's filter and the policies, because which of those apply is only known when the call arrives.

Two lines are worth learning to read:

- **`strategy`** is either `atomic` (one statement, no read first) or read-then-write. An update whose change or validation is opaque, or reads the stored record, is read-then-write and must say `require-atomic=false`, or the build fails ([ADR-0017](../architecture/decisions/0017-atomic-by-default-and-classification.md)).
- **`folded into the statement`** means the rule costs no extra query. A rule that cannot fold runs in memory on the locked row instead.

## Migrations

```bash
bunx mesh migrate generate
```

`mesh migrate generate` compares the old model with the new one before it asks drizzle-kit for a migration, and refuses a destructive or ambiguous change unless you name it: dropping a column, changing its type, renaming it, making an optional column required.

```bash
bunx mesh migrate generate --allow drop:todo.dueOn
```

It never applies anything. Applying is explicit and separate:

```bash
bunx mesh migrate apply
```

The migrations are plain SQL files in `migrations/`, and you commit them. drizzle-kit owns the snapshot and the diff; Mesh owns the refusal and the flag.

::: callout info "Not decided yet"
Whether committed migrations are covered by `mesh build --check` is not stated. The guard is described as covering the generated tree, so a hand-edited migration and a stale `generated/schema.ts` can disagree. [Generated code and the guard](../architecture/in-depth/generated-code-and-guard.md) names the gap.
:::

## Next

- [Usage](./usage.md) — the build-and-check loop in context.
- [Configuration](./configuration.md) — the file every command reads.
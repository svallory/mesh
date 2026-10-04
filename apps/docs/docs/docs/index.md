---
title: "Introduction"
description: "What Mesh is, what one entity file gives you, and who it is for."
layout: "full"
---

# Introduction

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

Mesh is a TypeScript framework: you describe each thing your program stores once, in one `.mx` file, and Mesh writes the TypeScript you call, the checks on what callers send, the rules about who may do it, and the database tables and migrations. The whole interface is one function call, and Mesh runs on [Bun](https://bun.sh).

## One file, and what each part gives you

This is a complete `todo.mx`, top to bottom, with the policies extension enabled (`@meshfw/ext-policies`, which the quick start's project has). Read the code beside the notes: every part of the file is something you would otherwise write by hand, and the note says what it buys you. The lines beginning `//` are the figure's own notes, not part of the file.

```mx-figure
// @name: Name and table — `todo` lives in the `todos` table. The type, the functions and the migration come from this one line.
entity="todo" table="todos"
  attributes
// @fields: Fields you send — `title` is a required string, `done` a boolean that starts false.
    uuid-primary-key="id"
    attribute="title" type="string" allow-nil=false
    attribute="done" type="boolean" allow-nil=false default=false
    create-timestamp="insertedAt"
// @times: Fields the database fills — `insertedAt` on create, `updatedAt` on every write. No caller sets either.
    update-timestamp="updatedAt"
  relationships
// @belongs: Linked to a list — `listId` becomes a field, the foreign key is created, and `todo.list` arrives when you ask.
    belongs-to="list" destination="list"
  actions defaults=["read", "destroy"]
// @create: Calling createTodo — you call `createTodo(input, context)`. A field it does not accept never reaches your code.
    create="create" accept=["title", "listId"]
// @checked: Input, checked — an empty title is refused with your own message, before anything is written.
      validate=({ todo }) => todo.title.length > 0 message="title must not be empty"
// @complete: One more action — `completeTodo({ id }, context)` finishes a todo in a single `UPDATE`.
    update="complete"
      change=({ todo }) => { todo.done = true }
// @pending: A query — `pendingTodo(input, context)` filters in SQL, and adds your own filter to it.
    read="pending"
      filter=({ todo }) => todo.done === false
  policies
// @who: Who may do it — an action with no policy is forbidden, and the check rides along with the query.
    policy=action_type(["create", "read", "update", "destroy"])
      authorize-if=({ todo, actor, context }) => todo.list.ownerId === actor.id
  calculations
// @derived: A computed value — ask for `label` and it is on the result; leave it out and it does not exist.
    calculate="label" type="string"
      value({ todo }) {
        return (todo.done ? "[x] " : "[ ] ") + todo.title
      }
```

## What you call

An action becomes an ordinary TypeScript function with an ordinary signature:

```ts "src/main.ts (excerpt)"
const todo = await createTodo({ title: "Buy milk", listId: list.id }, { actor });
```

There is no server, no route and no client to generate. Mesh serves a command line, a worker, a daemon or an HTTP endpoint equally, because the function is the whole interface.

The same file is built in the [tutorial](./tutorial.md), and every tag in it is in the [entity reference](./entities.md).

You write one file per thing and edit that file. Adding a field adds a column, a type field and an input key, and one more column to push or migrate. Removing an accepted field makes every caller that still passes it a type error.

## Who it is for

You are writing TypeScript on Bun and some of your program's data has rules attached to it: who may read it, what counts as valid, what a completed order means. Those rules usually live in a framework's models, or in hand-written handlers with hand-written tests.

- **Backend services and APIs.** One declaration replaces a table definition, four DTOs, a validation layer and a controller. The HTTP layer stays yours.
- **Command-line tools and workers.** The action is a function. Calling it from a task is the same code a request handler runs.
- **Applications with an AI agent in them.** An agent editing one small declarative file, then running one command, is a much smaller job than an agent editing a model, a schema and a service layer together.

## Where to go next

- [Quick start](./quick-start.md) — a working project in five minutes.
- [Tutorial: a todo list](./tutorial.md) — two entities and everything you can do with them.
- [Entities](./entities.md) — every tag an entity file may use.
- [Calling actions](./calling-actions.md) — the functions Mesh generates.
- [Project structure](./project-structure.md) — where files live and which ones you commit.
- [Configuration and the command line](./configuration.md) — `mesh.config.ts` and every `mesh` command.
- [Testing](./testing.md) — a test that runs against a real database in memory.
- [Working with AI agents](./ai-agents.md) — what an agent gets from Mesh.

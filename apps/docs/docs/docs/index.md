---
title: "Introduction"
description: "What Mesh is, what one entity file gives you, and who it is for."
layout: "full"
---

# Introduction

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

Mesh is a TypeScript framework: you describe each thing your program stores once, in one `.mesh.mx` file, and Mesh writes the TypeScript you call, the checks on what callers send, the rules about who may do it, and the database tables and migrations. The whole interface is one function call, and Mesh runs on [Bun](https://bun.sh).

## One file, and what each part gives you

This is a complete `src/domain/todo/todo.mesh.mx`, top to bottom, as your editor shows it. Point at a numbered marker, or at the lines it sits on, to read what that part gives you; every part is something you would otherwise write by hand.

```mx-figure
// @name: Name and table — Todo lives in the `todos` table. The type, the functions and the migration come from this one line.
entity #Todo table="todos"
// @fields: Fields you send — `title` is a string of at least one character, `done` a boolean that starts false.
  attributes
    uuid #id primary-key
    string #title min=1
    boolean #done default=false
// @times: Fields the database fills — `insertedAt` on create, `updatedAt` on every write. No caller sets either.
    timestamp #insertedAt on="create"
    timestamp #updatedAt on="update"
// @belongs: Linked to a list — `listId` becomes a field and the foreign key is created, and `todo.list` arrives when you ask.
  relationships
    belongs-to=List #list
// @derived: A computed value — ask for `label` and it is on the result; leave it out and it does not exist.
  computed
    string #label({ self }) {
      return (self.done ? "[x] " : "[ ] ") + self.title
    }
// @create: Calling createTodo — you call `createTodo(input, context)`. A field it does not accept never reaches your code, and a rule about one field is one word on that field's line.
  actions auto=["read", "destroy"]
    create #create accept=["title", "listId"]
// @complete: Rule and change — `completeTodo({ id }, context)` refuses a todo that is already done, then writes it in one turn.
    update #complete
      validate
        check :notDoneYet [
          that=({ self }) => !self.done
          code="already_done"
          message="this todo is already complete"
        ]
      do
        set
          #done=true
// @rename: One more action — `renameTodo({ id, title }, context)` accepts a field and changes nothing else.
    update #rename accept=["title"]
// @pending: A query — `pendingTodo(input, context)` filters in SQL, and your call can narrow it with its own `filter`.
    read #pending
      filter=({ self }) => self.done === false
      sort=["insertedAt"]
// @who: Who may do it — an action no policy covers is forbidden, and a todo in someone else's list is simply not found.
  policies
    policy #owner types=["create", "read", "update", "destroy"]
      authorize-if=({ self, actor }) => self.list.ownerId === actor.id
```

## What you call

An action becomes an ordinary TypeScript function with an ordinary signature:

```ts "src/main.ts (excerpt)"
const todo = await createTodo({ title: "Buy milk", listId: list.id }, { actor });
```

There is no server, no route and no client to generate. Mesh serves a command line, a worker, a daemon or an HTTP endpoint equally, because the function is the whole interface.

The same file is built in the [tutorial](./tutorial.md), and every declaration in it is in the [entity reference](./entities.md).

You write one file per thing and edit that file. Adding a field adds a column, a type field and an input key, and one more thing to push or migrate. Removing an accepted field makes every caller that still passes it a type error.

## Who it is for

You are writing TypeScript on Bun and some of your program's data has rules attached to it: who may read it, what counts as valid, what a completed order means. Those rules usually live in a framework's models, or in hand-written handlers with hand-written tests.

- **Backend services and APIs.** One declaration replaces a table definition, four DTOs, a validation layer and a controller. The HTTP layer stays yours.
- **Command-line tools and workers.** The action is a function. Calling it from a task is the same code a request handler runs.
- **Applications with an AI agent in them.** An agent editing one small declarative file, then running one command, is a much smaller job than an agent editing a model, a schema and a service layer together.

## Where to go next

- [Quick start](./quick-start.md) — a working project from nothing: install Bun, four small files, one build.
- [Tutorial: a todo list](./tutorial.md) — two entities and everything you can do with them.
- [Entities](./entities.md) — every declaration an entity file may use.
- [Calling actions](./calling-actions.md) — the functions Mesh generates.
- [Project structure](./project-structure.md) — where files live and which ones you commit.
- [Configuration and the command line](./configuration.md) — `mesh.config.ts` and every `mesh` command.
- [Testing](./testing.md) — a test that runs against a real database in memory.
- [Working with AI agents](./ai-agents.md) — what an agent gets from Mesh.

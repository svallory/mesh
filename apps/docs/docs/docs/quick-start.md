---
title: "Quick start"
description: "Install Bun, create a project, declare one entity, build it, and call an action."
---

# Quick start

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

Five minutes: one command to create a project, one file to edit, one command to build, one file to run. This page assumes nothing. If you already know what an entity file is, read [the tutorial](./tutorial.md) instead.

## Install Bun

Mesh runs on [Bun](https://bun.sh) and on nothing else.

```bash
curl -fsSL https://bun.sh/install | bash
```

Check it:

```bash
bun --version
```

Use `bun` for every package command in a Mesh project. `npm` and `yarn` are not supported.

## Create the project

```bash
bun create mesh todo-app
cd todo-app
```

The starter asks which database you want and whether to enable authorization, then installs the packages and writes a project that already builds. It comes with a configuration file, one entity file, one script that calls an action, and a `package.json` with this entry:

```json
"imports": { "#mesh": "./.mesh/index.ts" }
```

That entry is how your code reaches generated code. You always import `#mesh`, never a path into `.mesh`.

## Replace the entity file

Open `src/domain/todo/todo.mx` and make it exactly this:

```mx "src/domain/todo/todo.mx"
entity="todo" table="todos"
  attributes
    uuid-primary-key="id"
    attribute="title" type="string" allow-nil=false
    attribute="done" type="boolean" allow-nil=false default=false
    create-timestamp="insertedAt"
    update-timestamp="updatedAt"

  actions defaults=["read"]
    create="create" accept=["title"]
      validate=({ todo }) => todo.title.length > 0 message="title must not be empty"

  policies
    policy=action_type(["create", "read"])
      authorize-if=() => true
```

Four things to note, because every page here depends on them:

- The file is `.mx`, written in Marko's concise syntax: indentation, no angle brackets.
- `entity="todo"` names the entity and `table="todos"` names the table.
- `accept=["title"]` is the whole input of the create action. `done` is not accepted, so a caller cannot create a todo that is already done.
- The policy block is what allows anything. An action nobody has a policy for is forbidden, so a new action needs a policy before it works.

## Build it

```bash
bunx mesh build
bunx mesh db push
```

`mesh build` reads the entity file, checks it, and writes the TypeScript you call: types, handlers, input validators, the database schema, and the file your `imports` entry points at. It reports any problem with the file, the line and the column.

`mesh db push` creates the table. In development it is the quick path; for anything you keep, use migrations ([the command line](./configuration.md#migrations)).

## Call an action

Save this as `src/main.ts`:

```ts "src/main.ts"
import { connect, disconnect, createTodo, readTodo } from "#mesh";
import { alice } from "./context";

await connect();

const todo = await createTodo({ title: "Buy milk" }, { actor: alice });
console.log(todo.id, todo.title, todo.done, todo.insertedAt);

for (const row of await readTodo({}, { actor: alice })) {
  console.log(row.title);
}

await disconnect();
```

And this as `src/context.ts`, if the starter did not write it for you. It declares the type of every action's second argument, once, for the whole program:

```ts "src/context.ts"
import "@mesh/runtime";

declare module "@mesh/runtime" {
  interface ActionContext {
    actor: { id: string };
  }
}

export const alice = { id: "00000000-0000-4000-8000-000000000001" };
```

Run it:

```bash
bun run src/main.ts
```

```
clx3n8k2p0000q0f1r9v2x4t6a clx3n8k2p0001q0f1r9v2x4t6b Buy milk false 2026-03-04 09:12:31.004
Buy milk
```

Two arguments, always: the input, and the action context. The context says who is calling. It is a plain argument on every call, never something hidden in a global, which is what makes "run this as somebody else" one line in a test.

## What you just avoided

The todo you just created has a table with a primary key, a boolean with a default and two timestamps; a TypeScript type; an input validator that rejects an unknown field; a rule that an empty title is an error, carrying the message you wrote; an authorization check on every call; and a `git diff` you can review. None of that was hand-written.

## Next

- [Tutorial: a todo list](./tutorial.md) — a second entity, a relationship, a policy, a test.
- [Entities](./entities.md) — every tag in the file above, and the ones you will add.
- [Calling actions](./calling-actions.md) — filters, paging, `load` and the error classes.
- [Project structure](./project-structure.md) — what the starter wrote and what you commit.
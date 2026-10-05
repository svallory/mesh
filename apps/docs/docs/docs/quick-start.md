---
title: "Quick start"
description: "Install Bun, create a project, write four small files, build them, and call an action."
---

# Quick start

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

One command to create a project, four small files to write, one command to build, one to run. This page assumes nothing. If you already know what an entity file is, read [the tutorial](./tutorial.md) instead.

## Install Bun

Mesh runs on [Bun](https://bun.sh) and on nothing else. `bun`, `bunx`, `bun run` and `bun test` below are Bun's own commands: `bunx` runs a command from a package you depend on, so `bunx mesh build` is this project's `mesh build`.

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
bun create meshfw todo-app
cd todo-app
```

**Choose SQLite when the starter asks which database you want.** Every sample here, the whole tutorial and every test are SQLite; the adapter is one line of configuration ([Configuration](./configuration.md)), and nothing else about the project changes if you pick Postgres later.

The starter installs the packages and writes a project that already builds. It comes with a configuration file, one entity file, one script that calls an action, and a `package.json` with this entry:

```json
"imports": { "#mesh": "./.mesh/index.ts" }
```

That entry is how your code reaches generated code. You always import `#mesh`, never a path into `.mesh`.

## Replace the entity files

Write these two files in `src/domain/todo/`, and delete anything else in that folder. `list.mesh.mx` is the list a todo belongs to; `todo.mesh.mx` is the same file the [tutorial](./tutorial.md) and the [Introduction](./index.md) use.

```mx "src/domain/todo/list.mesh.mx"
entity #List table="lists"
  attributes
    uuid #id primary-key
    string #name
    uuid #ownerId
    timestamp #insertedAt on="create"

  actions auto=["read", "destroy"]
    create #create accept=["name"]
      do
        set
          #ownerId=({ actor }) => actor.id

  policies
    policy #anyoneCreates types=["create"]
      authorize-if=() => true
    policy #ownerOnly types=["read", "destroy"]
      authorize-if=({ self, actor }) => self.ownerId === actor.id
```

```mx "src/domain/todo/todo.mesh.mx"
entity #Todo table="todos"
  attributes
    uuid #id primary-key
    string #title min=1
    boolean #done default=false
    timestamp #insertedAt on="create"
    timestamp #updatedAt on="update"

  relationships
    belongs-to=List #list

  computed
    string #label({ self }) {
      return (self.done ? "[x] " : "[ ] ") + self.title
    }

  actions auto=["read", "destroy"]
    create #create accept=["title", "listId"]

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

    update #rename accept=["title"]

    read #pending
      filter=({ self }) => self.done === false
      sort=["insertedAt"]

  policies
    policy #owner types=["create", "read", "update", "destroy"]
      authorize-if=({ self, actor }) => self.list.ownerId === actor.id
```

Five things to note, because every page here depends on them:

- The files end in `.mesh.mx`, and they are written in Marko's concise syntax: indentation, no angle brackets.
- `entity #Todo` names the entity and `table="todos"` names the table. The `#` before a name is how you name a declaration.
- `min=1` on `title` is the whole rule "a todo needs a title". A rule about one field goes on that field's line; `check :notDoneYet` is there because it is about the state the row is in.
- `accept=["title", "listId"]` is the whole input of the create action. `done` is not accepted, so a caller cannot create a todo that is already done, and `listId` arrived from `belongs-to=List #list`.
- The `policies` section is what allows anything. An action nobody has a policy for is forbidden, so a new action needs a policy before it works.

## Build it

```bash
bunx mesh build
bunx mesh db push
```

`mesh build` reads the entity files, checks them, and writes the TypeScript you call: types, handlers, input validators, the database schema, and the file your `imports` entry points at. It reports any problem with the file, the line and the column.

`mesh db push` creates the two tables and the SQLite file `todo.db` beside it, which is where the data goes from then on. The file comes from `mesh.config.ts`, which the starter wrote for you:

```ts "mesh.config.ts"
import { defineConfig } from "@meshfw/cli";
import { sqlite } from "@meshfw/data-sqlite";

export default defineConfig({
  domain: "src/domain",
  output: ".mesh",
  data: sqlite({ file: "todo.db" }),
});
```

In development pushing is the quick path; for anything you keep, use migrations ([the command line](./configuration.md#migrations)).

## Call an action

Replace `src/context.ts` with this. It declares the type of every action's second argument, once, for the whole program, and exports one actor to call as:

```ts "src/context.ts"
import "@meshfw/runtime";

declare module "@meshfw/runtime" {
  interface ActionContext {
    actor: { id: string };
  }
}

export const alice = { id: "00000000-0000-4000-8000-000000000001" };
```

Then save this as `src/main.ts`:

```ts "src/main.ts"
import { connect, disconnect, createList, createTodo, pendingTodo } from "#mesh";
import { alice } from "./context";

await connect();

const list = await createList({ name: "Groceries" }, { actor: alice });
const todo = await createTodo({ title: "Buy milk", listId: list.id }, { actor: alice });
console.log(todo.id, todo.title, todo.done, todo.insertedAt);

for (const row of await pendingTodo({}, { actor: alice })) {
  console.log(row.title);
}

await disconnect();
```

Run it:

```bash
bun run src/main.ts
```

```
8a3f5c10-0000-4000-8000-000000000001 Buy milk false 2026-10-04T09:12:31.004Z
Buy milk
```

Two arguments, always: the input, and the action context. The context says who is calling. It is a plain argument on every call, never something hidden in a global, which is what makes "run this as somebody else" one line in a test.

## What you just avoided

The todo you just created has a table with a primary key, a boolean with a default and two timestamps; a TypeScript type; an input validator that rejects an unknown field and a title of no length; a rule about the state of the row, carrying the message you wrote; an authorization check on every call; and a `git diff` you can review. None of that was hand-written.

## Next

- [Tutorial: a todo list](./tutorial.md) — the same two entities with everything switched on.
- [Entities](./entities.md) — every declaration in the files above, and the ones you will add.
- [Calling actions](./calling-actions.md) — filters, paging, `load` and the error classes.
- [Project structure](./project-structure.md) — what the starter wrote and what you commit.

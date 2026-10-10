---
title: "Working with AI agents"
description: "Why one declarative file per entity is good for an agent, and the three tools Mesh gives it."
---

# Working with AI agents

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

Most of the code a framework asks you to write is code an agent has to read before it can change anything. Mesh tries to keep that code small and fixed in shape. This page says what an agent gets, and what it still has to be told.

## One file, and one command

An entity file is short, declarative and in one place. To add a field, an action or a rule, an agent edits that file and nothing else: no schema object, no migration by hand, no DTO, no controller, no service layer to keep in step. The types, the input checks, the table and the migration all follow from the edit.

The tutorial's two entity files are the whole surface an agent has to understand before it can add an action to a program with a list, a todo, ownership rules and derived values.

## The rules file

`mesh build` writes `.mesh/rules.md`: a short description of your entities — which actions exist and what they accept — and of Mesh's vocabulary: the field types, the action types and the declarations an extension adds. It is generated, so it cannot drift from the code. An excerpt for the tutorial's todo looks like this:

```text
import { List } from "./list.mesh.mx"

entity :Todo table="todos"
  attributes
    uuid :id primary-key
    string :title min=1
    boolean :done default=false
  relationships
    belongs-to :list entity=List
  actions auto=[:read, :destroy]
    create :create
      input
        &title
        &list
  policies
    policy :owner types=[:create, :read, :update, :destroy]
      authorize-if=({ actor }) => &list.ownerId === actor.id
```

(That is the shape of the content, not the file's exact text: the real file is longer and lists every entity.) It writes names and lists of names the way an entity file does, because that is what it is teaching: an agent that copies a line from it into a `.mesh.mx` file has written a valid one.

Point your agent at it. If your agent reads a project file such as `AGENTS.md`, have it read `.mesh/rules.md` too.

The file is an addition to whatever guidance you already give your agent, not a replacement. It knows Mesh; it does not know your domain. A short project note saying what a list is for is still yours to write.

## Three commands an agent can run

**`mesh inspect`** prints the model as JSON, with the source position of every declaration. An agent that is unsure whether a `filter` or a `check` landed on the right action, or what a policy actually says, gets an answer instead of a guess:

```bash
mesh inspect Todo
```

**`mesh explain`** prints the plan a call will follow: its checks, its steps and whether it reads before it writes:

```bash
mesh explain Todo complete
```

```text
Todo.complete (update)
  strategy     read-then-write: every update reads the row under the write lock, checks it, changes it, then writes it
  input        none
  checks       notDoneYet (todo.done)
  steps        set &done = true
  policy       none
```

That turns "what does this call do, and in what order" into a build-time answer rather than an investigation.

**`bun test`** runs the suite against a real database in memory, which is the check that catches a change that builds and does the wrong thing. See [Testing](./testing.md).

## What this does not solve

Mesh gives an agent a smaller surface and three tools. It does not give the agent your domain knowledge, and it does not decide what a change should mean. An agent still has to know why a completed order is different from a deleted one.

The honest version of the claim is this: an agent's edit is one declarative file, the build refuses anything the vocabulary does not allow, the guard refuses a stale `.mesh/`, and the type checker points at every caller a renamed field just broke. Those are four checks that need no understanding of your project to work. Everything else an agent does still needs a human to review.

## Next

- [Entities](./entities.md) — the vocabulary the rules file describes.
- [Command line](./command-line.md) — `inspect` and `explain` in full.
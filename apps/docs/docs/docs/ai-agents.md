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

The tutorial's two entity files are 22 and 33 lines. That is the whole surface an agent has to understand before it can add an action to a program with a list, a todo, ownership rules and derived values.

## The rules file

`mesh build` writes `.mesh/rules.md`: a short description of your entities — which actions exist and what they accept — and of Mesh's vocabulary: the field types, the action types and the tags an extension adds. It is generated, so it cannot drift from the code.

Point your agent at it, the way Ash's `usage_rules` assembles a package's rules into `AGENTS.md`. If your agent reads `AGENTS.md`, have it read `.mesh/rules.md` too.

The file is an addition to whatever guidance you already give your agent, not a replacement. It knows Mesh; it does not know your domain. A short project note saying what a list is for is still yours to write.

## Three commands an agent can run

**`mesh inspect`** prints the model as JSON, with the source position of every tag. An agent that is unsure whether `filter` or `validate` landed on the right action, or what a policy actually says, gets an answer instead of a guess:

```bash
bunx mesh inspect todo
```

**`mesh explain`** prints the plan a call will follow, and which rules fold into the statement:

```bash
bunx mesh explain todo complete
```

```text
todo.complete (update)
  strategy     atomic: one UPDATE, no read first
  changes      done = true                 folded into the statement
  policy       list.ownerId = actor.id     folded into the statement as a filter
  validations  none
```

That turns "why did this update do two queries" into a build-time answer rather than an investigation.

**`bun test`** runs the suite against a real database in memory, which is the check that catches a change that builds and does the wrong thing. See [Testing](./testing.md).

## What this does not solve

Mesh gives an agent a smaller surface and three tools. It does not give the agent your domain knowledge, and it does not decide what a change should mean. An agent still has to know why a completed order is different from a deleted one.

The honest version of the claim is this: an agent's edit is one declarative file, the build refuses anything the vocabulary does not allow, the guard refuses a stale `.mesh/`, and the type checker points at every caller a renamed field just broke. Those are four checks that need no understanding of your project to work. Everything else an agent does still needs a human to review.

## Next

- [Entities](./entities.md) — the vocabulary the rules file describes.
- [Configuration and the command line](./configuration.md) — `inspect` and `explain` in full.
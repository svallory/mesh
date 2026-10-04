---
title: "Customising generated code"
description: "A proposal: export Mesh's generator templates into your project and edit them. Draft, for review."
---

# Customising generated code

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

::: callout warning "This page is a proposal"
Nothing on this page is decided. It is written as a proposal so it can be judged as a developer experience rather than as a design note: what the command does, what it costs, when it is worth it and what it breaks. Read it, then rule on it.
:::

Mesh's generators are templates. Out of the box they emit ordinary TypeScript: one handler per action, with the lifecycle written out, so the code you run is code you can read and a bug in your application is a stack trace in your own generated file.

Sometimes that is not enough. You may want a different function signature, a house convention for error handling, a trace attribute, a comment at the top of every file. Rewriting generated files by hand does not work — the next `mesh build` overwrites them, and `mesh build --check` fails on your edit.

This page proposes an escape hatch for that case.

## The command

```bash
bunx mesh export generators
```

It copies the generator templates into your project:

```text
.mesh-generators/
  action.ts.jig
  types.ts.jig
  validators.ts.jig
  schema.ts.jig
```

From then on `mesh build` runs your templates instead of Mesh's. You edit them, rebuild, and the guard compares the result against what is committed as usual, so a hand edit to the *output* is still an error, while a change to the *template* is a change to your project.

If the templates are [Jig](https://jig.saulo.engineer/docs/introduction) templates, the syntax is Jig's: data in, text out, with helpers for indentation, casing and composition. A template receives the entity's model — the same plain data `mesh inspect` prints — so anything you can read there you can branch on.

## What it would cost

The cost is the one thing worth deciding on honestly.

**You own the output from then on.** When you upgrade Mesh, your generators do not improve. A fix to the action lifecycle — a bug in how a denied write is reported, a missing tracing span, a change in how validations fold into a statement — reaches every project except yours. The template you copied is a fork with no merge path.

**The files are large.** A handler template is one of the bigger pieces of the build. Reading a diff of it is work you would not otherwise have.

**The escape hatch becomes the path of least resistance.** A team that edits one template to add a log line, and then another to change a signature, has moved from "declare your rules, call the framework" to "maintain a framework". Mesh's value was that the generated code was not yours to keep.

## When it would be worth it

- You need generated code that matches a house standard your organisation enforces on every file, including generated ones.
- You are extending Mesh itself and need a template shape the core does not have.
- You need to see a rule that is opaque in the emitted handler — a policy that reads a related row, an action that is not atomic — in a form you can instrument.

If none of those is your situation, the generated code is better left alone. The interesting cases are the ones Mesh should fix rather than escape: a house convention belongs in an extension, which contributes behaviour through a declared point without forking the generators.

## What the alternatives are

| Option | What it gives you | What it costs |
|:--|:--|:--|
| Nothing | Nothing to maintain, upgrades apply to you | No customisation |
| An extension point | Contribute behaviour through a declared extension point, upgrades still apply | Only what the extension system can express |
| Export the generators | Anything | You own the output; upgrades stop applying |
| Mixins in the templates | A hook without a full fork, so upgrades keep working up to the seam | A new API surface in the build, and a seam to design and keep stable |

The fourth is the one this page would recommend if the third is wanted at all: a named hook in each template that an extension or a project file can fill, rather than a copy of the whole template. It keeps the escape hatch small enough that a copy is not tempting.

## The question to decide

Should advanced users be able to export and edit generator templates?

If yes, the templates need a stable syntax and a documented data contract, and the answer to "what happens on upgrade" has to be written down before anyone exports one. If no, the alternative to publish is the mixin seam, which is a smaller promise to keep.

## Next

- [Project structure](./project-structure.md) — what `.mesh/` contains and why it is committed.
- [Entities](./entities.md) — the model a template would receive, which `mesh inspect` prints.
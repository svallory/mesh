---
title: "Customising generated code"
description: "Exporting Mesh's generator templates into your project, what it costs, and the smaller alternative."
---

# Customising generated code

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

::: callout warning "This page is a proposal"
Nothing here is decided yet. It describes what `mesh export generators` would do if it were built, what it would cost you, and the smaller alternative. Judge it as a developer experience, not as a design note.
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

## What it costs you

This is the honest price of the copy, and it is the whole argument against it.

**You own the output from then on.** When you upgrade Mesh, your generators do not improve. A fix to the action lifecycle — a bug in how a denied write is reported, a missing tracing span, a change in how validations fold into a statement — reaches every project except yours. The template you copied is a fork with no merge path.

**The files are large.** A handler template is one of the bigger pieces of the build. Reading a diff of it is work you would not otherwise have.

**The escape hatch becomes the path of least resistance.** A team that edits one template to add a log line, and then another to change a signature, has moved from "declare your rules, call the framework" to "maintain a framework". Mesh's value was that the generated code was not yours to keep.

## When it would be worth it

- You need generated code that matches a house standard your organisation enforces on every file, including generated ones.
- You are extending Mesh itself and need a template shape the core does not have.
- You need to see a rule that is opaque in the emitted handler — a policy that reads a related row, an action that is not atomic — in a form you can instrument.

If none of those is your situation, the generated code is better left alone. The interesting cases are the ones Mesh should fix rather than escape: a house convention belongs in an extension, which contributes behaviour through a declared point without forking the generators.

## The alternative: a hook in each template

The command above hands you the whole template. The smaller form is a **named hook** in each one: Mesh keeps the template, and an extension or a project file fills the seam.

A hook is not a fork, so the cost above disappears: a later fix to how a denied write is reported, or a missing trace span, still reaches your project, because your contribution is a piece of the template rather than a copy of it. What you give up is reach: you can only change what the seam allows, and Mesh has to design and keep that seam stable, which is a promise to maintain forever.

Both are escape hatches, and neither is the path of least resistance if a team leans on it. The difference is who pays later:

| | `mesh export generators` | A hook per template |
|:--|:--|:--|
| You can change | the whole template | only what the seam allows |
| Mesh upgrades | do not reach your project | reach you |
| Mesh owes you | a stable template syntax and a documented data contract | a stable seam, designed with you |
| When a rule grows awkward | it is a one-line diff in your copy | it needs a new seam in Mesh |
| Best when | you are extending Mesh, or a house standard must reach every generated file | the change is a handful of lines at a known place |

## The question to decide

Should advanced users be able to export the generator templates and edit them?

If yes, the templates need a stable syntax and a documented data contract, and the answer to "what happens on upgrade" has to be written down before anyone exports one. If a hook is offered too, it should be offered first: it keeps the escape hatch small enough that copying a template is a choice rather than a habit.

If no, the hook is the whole answer, and it is a much smaller promise to keep.

## Next

- [Project structure](./project-structure.md) — what `.mesh/` contains and why it is committed.
- [Entities](./entities.md) — the model a template would receive, which `mesh inspect` prints.
---
title: "Customising generated code"
description: "Exporting Mesh's generator templates into your project, overriding one template, and what that costs you."
---

# Customising generated code

::: callout warning "Not released"
Mesh is not released yet. These pages describe what Mesh will be.
:::

Mesh's generators are [Jig](https://jig.saulo.engineer/docs/introduction) templates, the template engine for code generation. Out of the box they emit ordinary TypeScript: one handler per action, with the lifecycle written out, so the code you run is code you can read and a bug in your application is a stack trace in your own generated file.

Sometimes that is not enough. You may want a different function signature, a house convention for error handling, a trace attribute, a comment at the top of every file. Rewriting generated files by hand does not work — the next `mesh build` overwrites them, and `mesh build --check` fails on your edit.

This page is about the way out short of forking Mesh.

## The command

```bash
mesh export generators
```

It copies the generator templates into your project:

```text
.mesh-generators/
  actions.ts.jig
  binding.ts.jig
  expressions.ts.jig
  index.ts.jig
  load.ts.jig
  module.ts.jig
  types.ts.jig
  validators.ts.jig
  schema.ts.jig
```

From then on `mesh build` uses your copy of a template when you have one and Mesh's own when you do not, per template. You edit yours, rebuild, and the guard compares the result against what is committed as usual: a hand edit to the *output* is still an error, while a change to the *template* is a change to your project.

A template receives the entity's model — the same plain data `mesh inspect` prints — so anything you can read there you can branch on. It receives it already prepared: names cased, imports resolved, input plans computed. The template renders; it does not decide.

## What it costs you

This is the honest price of the copy, and it is the whole argument against it.

**You own the output from then on.** When you upgrade Mesh, your generators do not improve. A fix to the action lifecycle — a bug in how a denied write is reported, a missing tracing span, a change in how validations fold into a statement — reaches every project except yours. Your copy is a fork with no merge path.

**An upgrade can break your copy.** A template is written against the view of the Mesh version it came from: the fields its generator hands it. A release can rename, move or drop those fields, or move what one template printed into another, and your copy does not follow. It then fails in one of two ways. The loud one: it reads a property of a field that is gone, and `mesh build` stops with `Generator "<name>" cannot render .mesh-generators/<template>` at the line. The quiet one: it loops over a field that is gone, the loop prints nothing, and the build reports `0 errors, 0 warnings` while it writes an almost empty file. The guard passes as well, because it renders the same template, so the first sign is your own type check failing at an import. After every upgrade, compare each of your templates with the one Mesh now ships, and carry your edits over:

```bash
mv .mesh-generators .mesh-generators.mine
mesh export generators
diff -ru .mesh-generators .mesh-generators.mine
```

Then put your edits into the fresh copies, delete the ones you do not change, and remove `.mesh-generators.mine`.

**The files are large.** An action template is one of the bigger pieces of the build. Reading a diff of it is work you would not otherwise do.

**The escape hatch becomes the path of least resistance.** A team that edits one template to add a log line, and then another to change a signature, has moved from "declare your rules, call the framework" to "maintain a framework".

## When it is worth it

- You need generated code that matches a house standard your organisation enforces on every file, including generated ones.
- You are extending Mesh itself and need a template shape the core does not have.
- You need to see a rule that is opaque in the emitted handler — a policy that reads a related row, an action that runs read-then-write — in a form you can instrument.

If none of those is your situation, the generated code is better left alone. The interesting cases are the ones Mesh should fix rather than escape: a house convention belongs in an extension, which contributes behaviour through a declared point without forking the generators.

## Overriding one template

You do not have to keep them all. Delete the ones you are not changing and keep one:

```bash
rm .mesh-generators/{binding,expressions,index,load,module,types,validators,schema}.ts.jig
```

The build now uses your `actions.ts.jig` and Mesh's own for the rest, and a Mesh release that improves the others reaches you as usual. Start there: copy one template when one template is what does not fit, and only copy the rest when you have a reason for each.

## Printing imports in `expressions.ts.jig`

`expressions.ts.jig` imports the helpers your entity files use, and each import it prints comes with a `keyword`, `import` or `import type`. Mesh's own template prints a helper import as `{{ helper.keyword }} {{ helper.bindings }} from {{ helper.fromLiteral }};`, and the imports of entity values and of the globals carry a `keyword` the same way. An override must print every import with the view's `keyword`, never a literal `import`.

The keyword is `import type` when the functions take only types from a module (a `Money` type that a function names in an annotation and never calls). A project that sets `verbatimModuleSyntax` keeps a plain `import` of such a module as written, and `tsc` refuses it with TS1484. An override written before the view had a `keyword` field prints `import` every time, so a project with that setting fails type checking at the line, and the fix is to replace the literal `import` in each import line with the `keyword` field.

## Next

- [Project structure](./project-structure.md) — what `.mesh/` contains and why it is committed.
- [Entities](./entities.md) — the model a template receives, which `mesh inspect` prints.

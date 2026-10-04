---
title: "Usage"
description: "The working loop: write a resource, build, call an action, change the resource, rebuild."
---

# Usage

::: callout warning "Live spec, not released"
This page describes how Mesh **will** work, not how it works today. It is a live spec of the developer experience, written before the code. Mesh is not released: nothing here can be installed or run yet, and any detail may change.
:::

This page is the loop you will work in every day: change a resource file, build, let the type checker tell you what broke, run the program. It assumes the `todo-app` project from [Installation](./installation.md) and the resources from [Example: a todo list](./example-todo-list.md).

::: callout warning "Nothing checks who is calling, yet"
Until the policies extension arrives, **every action is open to every caller**. Six milestones of v1 produce runnable actions with no access control; a project built before then must not be exposed. [ADR-0036](../architecture/decisions/0036-deny-by-default-arrives-with-policies.md) records when deny-by-default starts, and the roadmap's risk 7 says this must be stated in the user docs. It is why the example declares a policy for every action.
:::

## 1. Write a resource file

Copy the complete `resources/list.mx`, `resources/todo.mx` and `src/actor.ts` files from [Example: a todo list](./example-todo-list.md). Keep the actions, relationships and policies, not just the attributes: step 3 calls the `create` actions on both resources and the `pending` read on `todo`.

A resource is one `.mx` file: Marko syntax, read by MX. Mesh chooses the tag names; the syntax is MX's. The file is indentation-based, with no angle brackets.

MX does not run any of this. It reads the file as a static tree of tags and attributes, so every value Mesh needs without executing code must be a literal. A bare identifier is a build error, not an import.

## 2. Build

```bash
bunx mesh build
```

The build reads every `.mx` file under the configured resources folder, checks the structure, builds a model, transforms it, verifies it, compiles the expressions and writes the generated tree. It also writes the database schema file, from the build half of the data adapter.

**What the build writes for you to commit** (using this spec's proposed layout; see [Project structure](./project-structure.md)):

| File | What it is |
|---|---|
| `generated/model.json` | One document per resource, with the source position of every tag |
| `generated/todos/todo.types.ts` | The `Todo` type and the input types of its actions |
| `generated/todos/todo.actions.ts` | One exported function per action, with the whole action lifecycle written out |
| `generated/todos/todo.validators.ts` | The Zod schema each action's input is checked against |
| `generated/schema.ts` | The Drizzle table definitions, written by the data adapter |
| `generated/index.ts` | `connect`, `disconnect`, and a re-export of every action function and every type |

**What the build checks** and refuses:

- a tag, attribute or value the vocabulary does not allow, at the file, line and column;
- a tag the contracts accept but the compiler does not implement yet, naming the milestone that will;
- `accept` naming an attribute the resource does not have;
- two resources with the same name, or two resources in one file;
- a free variable in an expression: a translatable expression may use only its declared parameters and the registered functions;
- a capability the configured adapter does not declare.

Nothing is silently dropped and nothing silently downgraded. The [roadmap](../architecture/roadmap/roadmap.md) calls this its second principle: no silent fallback.

## 3. Call an action from TypeScript

An action is a generated function. The signature is always `(input, scope)`, and both arguments are required. There is no server and no route: calling the function is the whole interface ([ADR-0005](../architecture/decisions/0005-core-interface-is-a-function-call.md)).

Create the development database first with `bunx mesh db push`, then save this as `src/main.ts` and run `bun run src/main.ts`:

```ts "src/main.ts"
import { connect, disconnect, createList, createTodo, pendingTodo } from "../generated";
import { alice } from "./actor";

await connect({ file: "todo.db" });

const list = await createList({ name: "Groceries" }, { actor: alice });
await createTodo(
  { title: "Buy milk", listId: list.id },
  { actor: alice },
);

console.log(await pendingTodo({}, { actor: alice }));

await disconnect();
```

`{ actor, context }` is the **scope**: who is calling, plus anything else the call needs. It is a plain argument on every call, never ambient, so a test can pass a different actor in one line ([ADR-0007](../architecture/decisions/0007-scope-is-a-plain-argument.md)). [Calling actions](./calling-actions.md) has the full signatures.

## 4. Change the resource, rebuild

Add this line inside the `attributes` block of `resources/todo.mx`. This is an insertion, not a complete resource file:

```diff "resources/todo.mx"
+    attribute="dueOn" type="datetime"
```

```bash
bunx mesh build
```

The build rewrites the generated tree. Look at what changed:

```bash
git diff generated/
```

The diff is the reviewable record of what your resource change means: a new column in `schema.ts`, a new field in the `Todo` type, a new optional key in every action input that accepts it. Commit the generated tree with the resource file. It is committed, not ignored, so a reviewer reads the same code you run and a `git diff` shows behaviour changes.

## 5. Let the type checker tell you what broke

Generated code is ordinary TypeScript, so `tsc --noEmit` (or your editor) reads it. This is the point of writing the behaviour into the generated handlers instead of into a shared engine: the error you get names your own generated function.

If you renamed an attribute, every call that passed the old name is a type error. If you removed one from `accept`, every call that still passes it is a type error, and a call that slips past the type checker is rejected at run time with `InvalidInputError`: an unknown field is an error, never dropped.

::: callout info "No watch mode yet"
There is no `mesh watch` and no editor diagnostics for `.mx` files. The roadmap lists watch mode as not planned, and editor support arrives when MX ships it. Until then, every change to a resource file means running `bunx mesh build` yourself. [How Mesh uses MX](../architecture/in-depth/mx-integration.md) records the dependency.
:::

## 6. Update the database

During development, push the schema straight to the database:

```bash
bunx mesh db push
```

For anything you keep, generate a migration instead:

```bash
bunx mesh migrate generate
bunx mesh migrate apply
```

`mesh migrate generate` compares the old model with the new one and refuses a destructive or ambiguous change (dropping a column, changing its type, renaming it, making an optional column required) unless you name it:

```bash
bunx mesh migrate generate --allow drop:todo.dueOn
```

Migrations are plain SQL files in `migrations/`, and they are committed. Nothing is ever applied automatically. See [Command-line tool](./command-line.md).

::: callout info "Not decided yet"
Whether committed migration files are covered by `mesh build --check` is not stated. The guard is described as covering the generated tree, so migrations and `generated/schema.ts` can drift apart unless the guard is extended. [Generated code and the guard](../architecture/in-depth/generated-code-and-guard.md) names the gap.
:::

## 7. Check before you commit

```bash
bunx mesh build --check
```

This runs the whole build again, regenerates in memory, writes nothing, and fails if the result differs from what is committed. It catches a hand edit to a generated file, and it catches a resource file you changed without rebuilding.

Two builds of the same input give the same bytes: the output comes from templates through a pinned formatter. That is what makes the check meaningful.

In your own project, add `"test": "bunx mesh build --check && bun test"` to `package.json`'s `scripts` object, then run `bun run test`. That checks the generated tree before running your tests. Mesh's own repository has no continuous integration until the MX packages are published ([ADR-0031](../architecture/decisions/0031-no-ci-until-mx-is-published.md)), so a skipped run is invisible.

## Next

- [Calling actions](./calling-actions.md) — signatures, the scope, filters, `load`, and the errors an action throws.
- [Configuration](./configuration.md) — what is in `mesh.config.ts`.
- [Command-line tool](./command-line.md) — every `mesh` command.
---
title: "Surfaces"
description: "Surface files: one entry point per audience, which lists the entities it may reach, the actions it may call and the fields that may leave; the manifest mesh build generates for each, #mesh/surfaces/<name>; and the rule that keeps a read from filtering, sorting or loading by a field the surface does not let out."
---

# Surfaces

::: callout warning "Not released"
Mesh is not released yet. These pages describe what Mesh will be.
:::

A **surface** is an entry point for one audience: a public API, an admin console, an agent's tools. Your entity files say what the domain can do and who may do it; a surface says which part of that one audience reaches, under which names, and which fields of a record it may see. It declares no behaviour of its own: no checks, steps or policies. It narrows what an audience can reach and never widens what a policy allows ([ADR-0077](../architecture/decisions/0077-surfaces-and-file-kinds.md)).

## A surface file

A surface file is a `.mesh.mx` file whose root line is `surface :name`. It lives in the folder the `surfaces` key of `mesh.config.ts` names, in a folder named after the surface ([Configuration](./configuration.md#surfaces)):

```mx "src/surfaces/public/public.mesh.mx"
import { Todo } from "../../domain/todo/todo.mesh.mx"

surface :public
  expose :todos entity=Todo label="Todos" fields=[:id, :title, :done]
    action :read
    action :complete
```

Each `expose` line names one entity the audience may reach, under the name it sees (`todos`); `label=` is what a reader shows, the exposed name when there is none. Each `action` line under it names one of the entity's actions the audience may call, its `auto=` actions included. An entity is exposed once per surface.

## What leaves: `fields=`

Fields fail closed. Only the members `fields=` lists leave through the surface: an attribute, a `belongs-to` (its key column leaves, `listId`, never the related record) or a computed field. `fields=:all` lets every one of those leave. With no `fields=`, nothing does: not even the primary key. A `has-many` or a `has-one` cannot be listed, since a related record does not leave through a surface; expose that entity on a line of its own.

The same rule holds for what a read takes. A read listed on a surface refuses a `filter` key (at any depth of `and` and `or`), a `sort` key or a `load` name outside the line before the action runs, so no policy runs and no row is read: it throws `InvalidInputError` with one issue per name, each with the code `not_exposed` and the path of the name (`["filter", "notes"]`, `["sort", 0]`). Without that, a caller who may see only `id` and `title` could recover any other field one comparison at a time. The generated input type is narrowed the same way, so such a call is also a type error.

A computed field that `fields=` lists leaves only when it is loaded: a read loads it when the caller's `load` names it, and `load` through a surface takes only the listed computed fields. A write action's result has what its own `load=` step loads, and the surface keeps the listed part of it.

## Actions

A call through a surface runs the entity's own action with the caller's context. Every policy, check, `always` block and step applies exactly as it does when you call the entity value, and an error the action throws (`ForbiddenError`, an `InvalidInputError` from a check) leaves as it was thrown. An action the line does not list cannot be called through the surface: the manifest has no entry for it.

## The generated manifest

`mesh build` writes one file per surface, `.mesh/surfaces/<name>/index.ts`. Map it once in your `package.json`, beside the other specifiers:

```json "package.json (excerpt)"
{
  "imports": {
    "#mesh": "./.mesh/index.ts",
    "#mesh/domain": "./.mesh/domain/index.ts",
    "#mesh/domain/*": "./.mesh/domain/*/index.ts",
    "#mesh/surfaces/*": "./.mesh/surfaces/*/index.ts"
  }
}
```

The file exports `surface`, the manifest: the surface's `name`, and under `expose` one entry per expose line with the entity's fully qualified name, its `label`, the `fields` that leave (in the entity's declaration order, a `belongs-to` as its key column) and one `run` per listed action. It is plain data and functions, frozen, and an adapter reads it at run time to serve the surface over a transport; it imports the generated code and `@meshfw/runtime`, never the model.

```ts "src/main.ts"
import { connect, disconnect } from "#mesh";
import { surface } from "#mesh/surfaces/public";
import { alice } from "./context";

await connect();

const todos = surface.expose.todos.actions;
// Only id, title and done leave; a filter or sort by another field is refused.
const open = await todos.read.run({ filter: { done: { eq: false } }, sort: ["title"] }, { actor: alice });
for (const todo of open) console.log(todo.id, todo.title);

const first = open[0];
if (first) console.log((await todos.complete.run({ id: first.id }, { actor: alice })).done);

await disconnect();
```

Each `run` returns the action's result with only the listed fields, frozen; its type says the same, so reading another field of the result is a type error.

`mesh build` never deletes generated files: after removing a surface, delete `.mesh/surfaces/<name>/`; `mesh build --check` reports it until you do.

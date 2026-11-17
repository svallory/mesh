---
title: "Surfaces"
description: "Surface files: one entry point per audience, which lists the entities it may reach, the actions it may call, the fields that may leave and the events it sends out; the manifest mesh build generates for each, #mesh/surfaces/<name>; the rule that keeps a read from filtering, sorting or loading by a field the surface does not let out; and serving a surface over JSON-RPC with surfaceMethods."
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

The same rule holds for what a read takes. A read listed on a surface refuses a `filter` key (at any depth of `and` and `or`), a `sort` key or a `load` name outside the line before the action runs, so no policy runs and no row is read: it throws `InvalidInputError` with one issue per name, each with the code `not_exposed` and the path of the name (`["filter", "listId"]`, `["sort", 0]`). Without that, a caller who may see only `id` and `title` could recover any other field one comparison at a time. The generated input type is narrowed the same way, so such a call is also a type error.

A computed field that `fields=` lists leaves only when it is loaded: a read loads it when the caller's `load` names it, and `load` through a surface takes only the listed computed fields. A write action's result has what its own `load=` step loads, and the surface keeps the listed part of it.

## Actions

A call through a surface runs the entity's own action with the caller's context. Every policy, check, `always` block and step applies exactly as it does when you call the entity value, and an error the action throws (`ForbiddenError`, an `InvalidInputError` from a check) leaves as it was thrown. An action the line does not list cannot be called through the surface: the manifest has no entry for it.

## What it sends out: `publishes`

A surface lists the events its audience may follow in a `publishes` section, one event per line, written as an [`events` listing](./events.md) is: an imported event, or a member of a namespace import (`billing.InvoicePaid`), never an atom. An event declared inline in an entity's `events` section is imported from that entity's file by its name. The example assumes the Todo entity of [Entities](./entities.md) also declares the event its `complete` action raises: an `events` section holding `event :TodoCompleted` with a `uuid :todoId` field, and `publish=() => new TodoCompleted({ todoId: &id })` in the action ([Declaring events where they belong](./events.md#declaring-events-where-they-belong)). The surface then lists it:

```mx "src/surfaces/public/public.mesh.mx"
import { Todo, TodoCompleted } from "../../domain/todo/todo.mesh.mx"

surface :public
  expose :todos entity=Todo label="Todos" fields=[:id, :title, :done]
    action :read
    action :complete
  publishes
    TodoCompleted
```

`publishes` raises nothing: an action's `publish` step does that, and an event no surface lists is still published and delivered to your handlers. A line that names no imported event is `MESH_UNKNOWN_EVENT`, which suggests the nearest imported name when there is one; an import of a name its file does not declare is reported at the import (`MESH_UNKNOWN_IMPORT`). One event listed twice, under one name or two, is `MESH_DUPLICATE_MEMBER`. A surface holds at most one `publishes` section. The section names whole events: it does not narrow an event's fields.

The manifest's `publishes` is the list of their fully qualified names, in the order the section writes them (`[]` without a section). Pass it as `names` to `subscribe` from `#mesh` to follow what the surface sends out ([Live subscriptions](./events.md#live-subscriptions)):

```ts "src/feed.ts"
import { connect, subscribe } from "#mesh";
import { surface } from "#mesh/surfaces/public";

await connect();
const feed = await subscribe({ name: "public-feed", names: surface.publishes }, (event) => {
  console.log(event.position, event.name);
});
// ... later
await feed.close();
```

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

The file exports `surface`, the manifest: the surface's `name`, and under `expose` one entry per expose line with the entity's fully qualified name, its `label`, the `fields` that leave (in the entity's declaration order, a `belongs-to` as its key column) and one `run` per listed action, and `publishes`. It is plain data and functions, frozen, and an adapter reads it at run time to serve the surface over a transport; it imports the generated code and `@meshfw/runtime`, never the model.

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

## Serving a surface

An adapter reads the manifest at run time. `@meshfw/jsonrpc` turns it into a method table for `serve` with `surfaceMethods(surface)`: one method per action line, named `<exposed name>.<action>` (`todos.read`, `todos.complete`), each passing the request's `params` to the action as its input and the context your factory builds as its context ([Over a Unix socket](./using-your-domain.md#over-a-unix-socket)).

```ts "src/rpc.ts"
import { codes, RpcError, serve, surfaceMethods } from "@meshfw/jsonrpc";
import { ForbiddenError, InvalidInputError } from "@meshfw/runtime";
import { connect } from "#mesh";
import { surface } from "#mesh/surfaces/public";
import { alice } from "./context";

await connect();
await serve({
  socket: "/run/todo/public.sock",
  methods: surfaceMethods(surface),
  context: () => ({ actor: alice }),
  error(error) {
    if (error instanceof RpcError) return { code: error.code, message: error.message, data: error.data };
    if (error instanceof InvalidInputError) return { code: codes.invalidParams, message: error.code, data: { issues: error.issues } };
    if (error instanceof ForbiddenError) return { code: -32001, message: error.code };
    throw error;
  },
});
```

```text
{"jsonrpc":"2.0","id":1,"method":"todos.read","params":{"filter":{"listId":{"eq":"x"}}}}
{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"invalid_input","data":{"issues":[{"code":"not_exposed","path":["filter","listId"],…}]}}}
```

No method has a `params` schema: the action casts its own input, so a bad input, or a filter by a field the line does not list, is the action's `InvalidInputError`, which your `error` function maps like any other. An action the line does not list has no method and is answered `-32601`. To match an existing protocol, pass `name`: `` surfaceMethods(surface, { name: (exposed, action) => `${action}_${exposed}` }) ``. Two actions that get one name, or a name that starts with `rpc.` (which JSON-RPC 2.0 reserves, so `expose :rpc` needs a `name`), make `surfaceMethods` throw `FrameworkError` when the table is built. The table is plain data, so you can add methods of your own beside it: `methods: { ...surfaceMethods(surface), ping: { run: () => "pong" } }`.

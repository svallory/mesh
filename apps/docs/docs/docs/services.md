---
title: "Services"
description: "Service files: domain logic that spans entities, as operations that declare the entities they reach with uses lines, take a typed input, run one body in one transaction and are covered by the service's own fail-closed policies; the value mesh build generates for each, and what a uses line does and does not stop."
---

# Services

::: callout warning "Not released"
Mesh is not released yet. These pages describe what Mesh will be.
:::

A **service** holds domain logic that spans entities: work that belongs to no single entity, such as handing a task over (ending its claims and reassigning it) or retiring a list with its todos. An effect inside one entity, or inside one aggregate, stays an action of that entity's file ([Entities: calling other actions](./entities.md#calling-other-actions)); a service is for the effect across them. A service is stateless: it declares no data, only operations ([ADR-0097](../architecture/decisions/0097-the-service-construct.md), proposed and awaiting the operator's review).

## A service file

A service file sits in the module folder of the entities it works on, beside them, and its root line is `service :Name`. It declares one or more **operations**. Each operation lists the entities it reaches with one `uses` line per entity, naming the actions of that entity it may call; takes an optional `input` of typed fields, as an action's arguments are written; and has one `run` body, plain TypeScript, as an action's `run` step is.

```mx "src/domain/todo/lists.mesh.mx"
import { List } from "./list.mesh.mx"
import { Todo } from "./todo.mesh.mx"

service :Lists
  operation :retire
    uses entity=List actions=[:destroy]
    uses entity=Todo actions=[:read, :destroy]
    input
      uuid :list
    run({ input, context }) {
      const todos = await Todo.read({ filter: { listId: { eq: input.list } } }, context)
      for (const todo of todos)
        await Todo.destroy({ id: todo.id }, context)
      await List.destroy({ id: input.list }, context)
      return { removed: todos.length }
    }
  policies
    policy :signedIn actions=[&retire]
      authorize-if=({ actor }) => actor != null
```

The body reads `input` (the cast input), `actor` and `context`, free or destructured, and `%.now` and `%.today`, the transaction's instant. A service has no record, so there is no `self`, no `before` and no `&name` in any of its functions (`MESH_EXPR_FREE_VARIABLE`). It may import entity files, helper modules and `Mesh` from `"meshfw"`; it may not import an event, a command or another service file (`MESH_UNKNOWN_IMPORT`), and an entity file may not import a service. An operation declares no output: what it returns is its result, typed by what the body returns.

A `service` line takes no `attributes`, `relationships`, `computed`, `checks` or `actions` (`MESH_TAG_NOT_ALLOWED`), an operation at least one `uses` line and one `run` (`MESH_MISSING_CHILD`), and a `uses` line an imported entity and a non-empty list of atoms naming its actions, `auto=` ones included (`MESH_UNKNOWN_ACTION` for one the entity does not have).

## What `uses` does

An operation reaches only what its `uses` lines list. The build checks the names the body writes: an entity the body names, or a member of a namespace import, that no `uses` line of the operation lists is the error `MESH_SERVICE_USES` at the `run` line. At run time every call the body makes, directly or through a helper it calls, is checked against the lines: an entity action, a `Mesh.privileged` read and a `Mesh.can` or `Mesh.checkPolicies` question about an action the lines do not list throw a `FrameworkError` naming the operation and the call, and the whole operation rolls back, even when the body catches the error.

What a listed call does inside its own action is not the operation's call: a step of `Todo.destroy` that calls another entity is `Todo`'s work, checked by `Todo`'s rules. A read of a listed entity loads its relationships, rollups and computed fields as part of the read, with no `uses` line for them. What the check cannot see is a helper that writes through `tables` from `#mesh` or a database client it holds: the check covers entity values and `Mesh`'s functions only.

An operation whose `uses` lines name one entity draws the warning `MESH_SERVICE_ONE_ENTITY`: work on one entity belongs on that entity, as an action. The architecture file can raise it to an error or switch it off with `:service-touches-one-entity` ([Project structure](./project-structure.md#the-architecture-file)).

## Policies

A service's `policies` section is written as an entity's, scoped with `actions=[&operation]` instead of `types=` (which an operation has none of, `MESH_UNKNOWN_OPTION`); a policy with no `actions=` covers every operation. It fails closed: an operation no policy covers is forbidden, and a service with no `policies` section builds and forbids every call. Every covering policy must pass. A check that reads only `actor`, `input` and `context` runs before the transaction opens, so a denial writes nothing; one that calls a helper or `Mesh.privileged` runs inside the transaction, before the body. The `ForbiddenError` names the service in `entity` (`todo.Lists`) and the operation in `action`.

The policies of the service are not the only ones: every entity call in the body runs that action's own validation and policies with the context the body passes it. A service policy says who may start the operation; each call inside still says who may do that part of it.

## Calling an operation

`mesh build` writes two files per service beside its module's entity files, `.mesh/domain/todo/lists.service.ts` (the value `Lists`, with one method per operation) and `.mesh/domain/todo/lists.inputs.ts` (each operation's input type, `RetireListsInput`, and the schema that casts it), and the module's barrel exports both:

```ts "src/main.ts"
import { connect, disconnect } from "#mesh";
import { List, Lists, type RetireListsInput } from "#mesh/domain/todo";
import { alice } from "./context";

await connect();

const list = await List.create({ name: "Groceries" }, { actor: alice });
const input: RetireListsInput = { list: list.id };
const { removed } = await Lists.retire(input, { actor: alice });
console.log(`removed ${removed} todos`);

await disconnect();
```

A call casts the input (`InvalidInputError` on a bad value), runs the service's policies, opens one transaction (or joins the one running in your `transaction(fn)`), runs the body, and resolves with what the body returned. Every call inside joins that transaction, so a throw anywhere rolls back everything the operation wrote. What the calls inside resolve with are plain values, as in an application `transaction`, so the body may return them. No `beforeTransaction` seam runs for an operation or for the calls inside it, and `afterCommit` runs once, with every change, when the operation opened the transaction.

An operation is called from application code, a seam that runs outside a transaction (`beforeTransaction`, `afterCommit`) or an event handler, and two operations may run one after the other inside one `transaction(fn)`. It is not called from inside another operation's body or from inside an action's transaction (a step, a check, a policy, the `afterWrite` seam, or a helper of them): that is a `FrameworkError` that fails the running transaction, because an inner operation would carry `uses` lines of its own and widen the outer one's.

Two services of one name may live in two modules, as entities may. In one module a service named like an entity, an event, a command or a subfolder of that module, or an input type spelled like another export of the barrel, is the build error `MESH_EMIT_NAME` naming both.

## Not yet

A service does not own events or commands, cannot publish an event (call an entity action that publishes it), has no `handlers` section, and an operation cannot answer a command (`on=` is `MESH_UNKNOWN_OPTION`). An operation has no `output`, `validate` or `do` section, cannot be asked about with `Mesh.can`, and is not exposed by a surface. A service does not call another service. Each of these can be added later without breaking a service file you write now.

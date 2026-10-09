---
title: "0047. Actions are bound to a data layer"
description: "Decision record 0047: Actions are bound to a data layer. Status: Amended by ADR-0059."
---

# 0047. Actions are bound to a data layer

> **Amended** by [ADR-0059](./0059-action-context.md) on 2026-10-04: read the successor for what changed. The body below is kept as history.

## Status

Accepted, amended by [ADR-0059](./0059-action-context.md)

## Date

2026-10-04

## Deciders

operator

## Context

Generated actions take `(input, scope)`. That signature does not say how they get a database connection. Module state alone makes tests against two databases awkward; adding the connection to the scope confuses caller identity with infrastructure. The [rulings before M2](./rulings-2026-10-04.md) settle this before generated handlers are built.

## Decision

`generated/index.ts` exports `bind(dataLayer)`. It returns an object holding every action function of every resource, bound to that data layer. These functions have the same names and the same `(input, scope)` signature as the top-level exports.

It also exports `connect(options)` and `disconnect()`. `connect` builds the data layer from the adapter configured in `mesh.config.ts` and stores `bind(thatDataLayer)` as the module's default binding. Top-level exports such as `createTodo` delegate to that binding. Calling one before `connect` throws `FrameworkError`. `disconnect()` closes the default connection; explicitly created bindings do not depend on it.

An application keeps its short calls:

```ts
import { connect, disconnect, createTodo } from "../generated";

await connect({ file: "todo.db" });
await createTodo(input, scope);
await disconnect();
```

A test uses its own data layer:

```ts
import { sqlite } from "@mesh/data-sqlite";
import { bind } from "../generated";

const t = bind(sqlite({ file: ":memory:" }));
// Prepare the emitted schema on this connection before calling an action.
await t.createTodo(input, scope);
```

These fragments illustrate binding; `input` and `scope` are supplied by the caller. Schema preparation is [ADR-0048](./0048-schema-inside-the-process-for-tests.md). Two bindings to two databases can live in one process without replacing one another. Binding does not create tables.

[ADR-0007](./0007-scope-is-a-plain-argument.md) remains in force: the scope stays `{ actor, context }`, explicit on every call. The data layer is not in the scope and is not a third action argument.

### Lifecycle and argument boundary (roadmap author, 2026-10-04; the lead may overrule)

These details supplement the operator's binding ruling; they are attributed to the roadmap author, not to the operator's original decision.

1. `bind` takes a ready object implementing the run-time `DataLayer` contract of `@mesh/runtime` (`transaction` and `close`), not an adapter/configuration descriptor for `bind` to initialise. `sqlite(options)` returns such an object, opening its connection on first use. `bind` itself opens nothing and creates no table.
2. Calling `connect` while a default binding exists throws `FrameworkError`. It never silently replaces or reuses a connection.
3. `disconnect` closes the default data layer and clears the default binding. A top-level action called afterwards throws the same `FrameworkError` as before `connect`. `connect` may be called again after `disconnect`; `disconnect` without a default binding does nothing.
4. A data layer passed to `bind` is owned by the caller, who closes it with its `close()` method. `disconnect` never touches it.

## Options considered

### Option A: Module state only

| Dimension | Assessment |
|-----------|------------|
| Complexity | Lowest: one connection per generated module |
| Cost | Tests must reset shared state or isolate modules |
| Isolation | Cannot independently bind the same actions to two databases |
| Reversibility | Medium: callers depend on global initialisation |

**Pros:** short application calls. **Cons:** one test's connection can replace another's; explicit scope does not solve database isolation.

### Option B: Pass the data layer on every call

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: a third argument or a field in scope |
| Cost | Every caller forwards infrastructure |
| Isolation | Explicit per call |
| Reversibility | Low: changes every action signature or scope type |

**Pros:** no shared connection state. **Cons:** a third argument breaks `(input, scope)`; putting the data layer in scope changes the meaning of ADR-0007.

### Option C: A binding factory with a default binding (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Moderate: bound functions plus default delegates |
| Cost | Generate the factory and connection helpers |
| Isolation | Each binding owns its choice of data layer |
| Reversibility | Good: the two-argument action interface stays unchanged |

**Pros:** short calls for applications, isolated bindings for tests and multi-database programs. **Cons:** default calls still require initialisation; callers must manage explicitly supplied data layers' lifetimes.

## Trade-off analysis

The factory separates the database choice from the caller's scope. Default module state is a convenience over the same factory, not the only execution path. The extra generated wrapper buys isolation without changing action signatures.

## Consequences

Applications connect once and use top-level functions. Tests can bind independent databases in the same process. A forgotten default connection is a framework error rather than an implicit connection or fallback. Preparing an in-memory schema is a separate adapter responsibility, not part of binding.

## Action items

- [ ] M2: emit `bind`, `connect`, `disconnect` and default action delegates.
- [ ] M2: test a top-level call before `connect` and two independent bindings.
- [ ] M2: test duplicate `connect` rejection, action calls after `disconnect`, reconnect, a no-op `disconnect`, lazy connection opening, and caller-owned cleanup of explicit bindings.
- [ ] M2: prepare test schemas on the binding's own connection, following ADR-0048. (`createSchema(db, tables)` works on the value `sqlite()` returns, which is the data layer `bind` takes; PR #53. The binding itself comes with the action functions.)

---
title: "Mesh"
description: "Mesh is a TypeScript framework for declaring your data once. Describe an entity in one .mesh.mx file and call typed functions."
---

# Mesh

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

Describe each thing your program stores once, in one `.mesh.mx` file: its data, the operations on it, and the rules around those operations. Mesh writes the TypeScript you call — types, handlers, input validators, authorization checks, database tables and migrations. Then you call a function.

```ts
const todo = await createTodo({ title: "Buy milk", listId: list.id }, { actor });
```

Mesh is TypeScript, on [Bun](https://bun.sh). It is modelled on [Ash](https://ash-hq.org), the declarative resource framework for Elixir. An action is an ordinary function, so Mesh serves a command line, a worker, a daemon or an HTTP endpoint equally. It is open source under the MIT licence.

::: hero
**Declare your data once.** Call typed functions. Get validation, authorization, schema and migrations without writing them.

::: button "Introduction" /docs/
::: button "Quick start" /docs/quick-start/
:::

::: grids
    ::: grid
        ::: card "Docs" icon:book
            For people who use Mesh. Start with the [Introduction](./docs/index.md).
        :::
    :::
    ::: grid
        ::: card "Architecture" icon:layers
            For contributors. Decisions, research and design that no single code file explains. Start with [Architecture](./architecture/index.md).
        :::
    :::
:::
---
title: "Introduction"
description: "What Mesh is, what one entity file gives you, and who it is for."
layout: "full"
---

# Introduction

::: callout warning "Not released"
Mesh is not released yet. These pages describe Mesh 1.0.
:::

Mesh is a TypeScript framework. You describe each thing your program stores — a todo, a user, an invoice — once, in one `.mx` file, and Mesh writes the rest: the TypeScript types, the functions that do the work, the checks on what callers send, the rules about who may do it, the database tables and the migrations.

An action becomes an ordinary TypeScript function with an ordinary signature:

```ts "src/main.ts (excerpt)"
const todo = await createTodo({ title: "Buy milk", listId: list.id }, { actor });
```

There is no server, no route and no client to generate. Mesh serves a command line, a worker, a daemon or an HTTP endpoint equally, because the function is the whole interface. Mesh runs on [Bun](https://bun.sh).

## One file, and what each part gives you

Here is a complete `todo.mx`. Every part of it is something you would otherwise write by hand: a type, a validator, a query filter, a table and its migration. Read it, then read what each part buys you.

<style>
.mx-figure-wrap{container-type:inline-size}
.mx-figure{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:0 2rem;margin:2rem 0;padding:1rem 1.25rem;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:10px;font-size:.95rem}
.mx-figure .mx-code{border-left:2px solid color-mix(in srgb,currentColor 35%,transparent);padding:.35rem 0 .35rem .9rem}
.mx-figure pre,.mx-figure pre[class]{margin:0;padding:0;border:0;border-radius:0;background:none;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.8rem;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
.mx-figure code{font:inherit;background:none;border:0;padding:0;color:inherit}
.mx-figure .mx-note{display:flex;gap:.6rem;align-items:baseline;padding:.35rem 0}
.mx-figure .mx-note p{margin:0}
.mx-figure .mx-badge{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;min-width:1.5rem;height:1.5rem;border:1px solid color-mix(in srgb,currentColor 45%,transparent);border-radius:999px;font-size:.75rem;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.mx-figure figcaption{grid-column:1 / -1;margin-top:.9rem;font-size:.85rem;opacity:.75}
@container (max-width:760px){.mx-figure{grid-template-columns:1fr;gap:.2rem}}
</style>

<div class="mx-figure-wrap">
<figure class="mx-figure">

<div class="mx-row mx-code"><pre><code>entity="todo" table="todos"</code></pre></div>
<div class="mx-row mx-note"><span class="mx-badge">1</span><p><strong>A name and a table.</strong> The entity is called <code>todo</code> and lives in the <code>todos</code> table. From this line Mesh builds the <code>Todo</code> type, every input type, the functions and the migration.</p></div>

<div class="mx-row mx-code"><pre><code>  attributes
    uuid-primary-key="id"
    attribute="title" type="string" allow-nil=false
    attribute="done" type="boolean" allow-nil=false default=false</code></pre></div>
<div class="mx-row mx-note"><span class="mx-badge">2</span><p><strong>Typed data.</strong> <code>title</code> is a required string, <code>done</code> is a boolean that starts false. A string is a TypeScript <code>string</code>, a uuid is a <code>string</code>, a datetime is a <code>Date</code>. The columns are created for you.</p></div>

<div class="mx-row mx-code"><pre><code>    create-timestamp="insertedAt"
    update-timestamp="updatedAt"</code></pre></div>
<div class="mx-row mx-note"><span class="mx-badge">3</span><p><strong>Fields the database fills.</strong> Mesh writes <code>insertedAt</code> on create and <code>updatedAt</code> on every write. A caller cannot set either.</p></div>

<div class="mx-row mx-code"><pre><code>  relationships
    belongs-to="list" destination="list"</code></pre></div>
<div class="mx-row mx-note"><span class="mx-badge">4</span><p><strong>A relationship.</strong> This adds the <code>listId</code> attribute and the foreign key, and gives <code>todo.list</code> when you ask for it with <code>load</code>.</p></div>

<div class="mx-row mx-code"><pre><code>    create="create" accept=["title", "listId"]
      validate=({ todo }) =&gt; todo.title.length &gt; 0 message="title must not be empty"</code></pre></div>
<div class="mx-row mx-note"><span class="mx-badge">5</span><p><strong>An action, and a rule for its input.</strong> <code>createTodo(input, context)</code> accepts exactly <code>title</code> and <code>listId</code>, and rejects an empty title before anything is written.</p></div>

<div class="mx-row mx-code"><pre><code>    update="complete"
      change=({ todo }) =&gt; { todo.done = true }
    update="rename" accept=["title"]</code></pre></div>
<div class="mx-row mx-note"><span class="mx-badge">6</span><p><strong>Two more actions.</strong> <code>completeTodo({ id }, context)</code> sets <code>done</code>; <code>renameTodo({ id, title }, context)</code> accepts a new title. Neither reads a stored row, so each runs as one <code>UPDATE</code> and two callers cannot both act on a stale row.</p></div>

<div class="mx-row mx-code"><pre><code>    read="pending"
      filter=({ todo }) =&gt; todo.done === false
      sort=["insertedAt"]</code></pre></div>
<div class="mx-row mx-note"><span class="mx-badge">7</span><p><strong>A query.</strong> <code>pendingTodo(input, context)</code> runs the filter in SQL, not in memory. The filter and the caller's own filter are combined before the query leaves.</p></div>

<div class="mx-row mx-code"><pre><code>  policies
    policy=action_type(["create", "read", "update", "destroy"])
      authorize-if=({ todo, actor }) =&gt; todo.list.ownerId === actor.id</code></pre></div>
<div class="mx-row mx-note"><span class="mx-badge">8</span><p><strong>Who may do it.</strong> An action nobody has a policy for is forbidden. The check reads the stored row, so it becomes part of the statement's filter rather than a second round trip.</p></div>

<div class="mx-row mx-code"><pre><code>  calculations
    calculate="label" type="string"
      value({ todo }) {
        return (todo.done ? "[x] " : "[ ] ") + todo.title
      }</code></pre></div>
<div class="mx-row mx-note"><span class="mx-badge">9</span><p><strong>A derived value.</strong> Ask for it with <code>load: ["label"]</code> and <code>todo.label</code> is typed on the result. Leave it out and the property does not exist.</p></div>

<figcaption>The same file, with what each block of it gives you. The file itself is on the <a href="./tutorial/">tutorial</a>, and every tag is on the <a href="./entities/">entity reference</a>.</figcaption>

</figure>
</div>

## What Mesh gives you

Nine blocks of markup replace nine separate places in your code:

| You write | Mesh gives you |
|---|---|
| `entity="todo"` | a `Todo` type, with the right fields and the right TypeScript types |
| `attribute="title" type="string"` | a validated input: an unknown field or a wrong type is an error, not a silent drop |
| `create-timestamp="insertedAt"` | the field, set on insert, absent from every input |
| `belongs-to="list"` | the `listId` attribute, the foreign key, and `todo.list` on demand |
| `create="create" accept=[…]` | `createTodo(input, context)`, typed from the accepted attributes |
| `validate=… message=…` | the same message at run time, from the tag that declared it, with its file and line |
| `read="pending" filter=… sort=…` | `pendingTodo(input, context)`, with the filter in SQL and paging and sorting from the caller |
| `policy=… authorize-if=…` | a check on every call, deny by default, and a `can` function that explains a denial |
| `calculate="label"` | a derived value, typed only where you ask for it |

You write one file per thing and edit that file. Adding an attribute adds a column, a type field, an input key and a migration step. Removing an accepted attribute makes every caller that still passes it a type error.

## Who it is for

You are writing TypeScript on Bun and some of your program's data has rules attached to it: who may read it, what counts as valid, what a completed order means. Today that rules live in a framework's models, or in hand-written handlers with hand-written tests.

- **Backend services and APIs.** One declaration replaces a table definition, four DTOs, a validation layer and a controller. The HTTP layer stays yours.
- **Command-line tools and workers.** The action is a function. Calling it from a task is the same code a request handler runs.
- **Applications with an AI agent in them.** An agent editing one small declarative file, then running one command, is a much smaller job than an agent editing a model, a schema and a service layer together.

## Where to go next

- [Quick start](./quick-start.md) — a working project in five minutes.
- [Tutorial: a todo list](./tutorial.md) — two entities and everything you can do with them.
- [Entities](./entities.md) — every tag an entity file may use.
- [Calling actions](./calling-actions.md) — the functions Mesh generates.
- [Project structure](./project-structure.md) — where files live and which ones you commit.
- [Configuration and the command line](./configuration.md) — `mesh.config.ts` and every `mesh` command.
- [Testing](./testing.md) — a test that runs against a real database in memory.
- [Working with AI agents](./ai-agents.md) — what an agent gets from Mesh.
- [Customising generated code](./customising-generated-code.md) — a proposal for advanced users.
---
title: "Mesh"
description: "Mesh is a TypeScript framework for Bun. Describe each thing your program stores once, in one .mesh.mx file, and call the typed functions Mesh writes from it."
toc: false
---

<section class="mh-hero" aria-labelledby="mh-title">
<h1 id="mh-title" class="mh-title">Describe it once.<br>Call a function.</h1>
<p class="mh-lede">Mesh is a TypeScript framework for Bun. You describe each thing your program stores in one <code>.mesh.mx</code> file: its data, its operations and its rules. Mesh writes the typed functions, the input validation, the authorization, the tables and the migrations.</p>
<p class="mh-actions"><a class="mh-btn mh-btn-main" href="/docs/">Read the introduction</a><a class="mh-btn" href="/docs/quick-start/">Quick start</a></p>
<p class="mh-status">Mesh is not released yet. These pages describe Mesh 1.0.</p>
</section>

::: grids
::: grid
```mx "src/domain/todo/todo.mesh.mx"
entity :Todo table="todos"
  attributes
    uuid :id primary-key
    string :title min=1
    boolean :done default=false

  relationships
    belongs-to=:List :list

  actions auto=[:read, :destroy]
    create :create accept=[:title, :listId]

  policies
    policy :owner types=[:create, :read, :destroy]
      authorize-if=({ self, actor }) => self.list.ownerId === actor.id
```
:::
::: grid
<div class="mh-seam" aria-hidden="true"><span class="mh-build"><code>mesh build</code><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M5 12h13m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span></div>

```ts "src/main.ts"
import { createTodo } from "#mesh";

// todo is a Todo: id, title, done, listId
const todo = await createTodo(
  { title: "Buy milk", listId: list.id },
  { actor },
);

// An empty title never reaches the database:
// this call throws InvalidInputError.
await createTodo(
  { title: "", listId: list.id },
  { actor },
);
```
:::
:::

<section class="mh-section" aria-labelledby="mh-gets">
<h2 id="mh-gets">What one file gives you</h2>
<p class="mh-intro">Every line of the file above stands for code you would otherwise write by hand, and keep in step by hand.</p>
<dl class="mh-gets">
<div><dt>Types</dt><dd><code class="mh-src">string :title min=1</code><span><code>Todo</code> has <code>title: string</code>, and so does the input of every action that accepts it.</span></dd></div>
<div><dt>Functions</dt><dd><code class="mh-src">create :create accept=[:title, :listId]</code><span><code>createTodo(input, { actor })</code> is an ordinary async function. The input takes the fields the action accepts, and nothing else.</span></dd></div>
<div><dt>Validation</dt><dd><code class="mh-src">min=1</code><span>An input that breaks a rule is refused with <code>InvalidInputError</code>, which lists every failure at once.</span></dd></div>
<div><dt>Authorization</dt><dd><code class="mh-src">policy :owner</code><span>An action no policy covers is forbidden. A todo in someone else's list is simply not found.</span></dd></div>
<div><dt>Schema and migrations</dt><dd><code class="mh-src">entity :Todo table="todos"</code><span>The <code>todos</code> table, and a plain SQL migration from <code>mesh migrate generate</code> each time the file changes.</span></dd></div>
</dl>
</section>

<section class="mh-section" aria-labelledby="mh-who">
<h2 id="mh-who">Who it is for</h2>
<p class="mh-intro">You write TypeScript on Bun, and some of your program's data has rules attached: who may read it, what counts as valid, what it means for an order to be complete.</p>
<ul class="mh-who">
<li><strong>Backend services and APIs.</strong> One declaration replaces a table definition, the input types, a validation layer and a controller. The HTTP layer stays yours.</li>
<li><strong>Command-line tools and workers.</strong> An action is a function. A task calls the same code a request handler runs.</li>
<li><strong>Applications with an AI agent in them.</strong> Editing one small declarative file, then running one command, is a smaller job for an agent than editing a model, a schema and a service layer together.</li>
</ul>
</section>

<nav class="mh-doors" aria-label="Sections of this site">
<a class="mh-door" href="/docs/"><strong>Docs</strong><span>For people who build with Mesh: the introduction, a quick start, a tutorial and the reference for every declaration.</span></a>
<a class="mh-door" href="/architecture/"><strong>Architecture</strong><span>For contributors: the decisions, the research and the design that no single code file explains.</span></a>
</nav>

<p class="mh-colophon">Mesh is open source under the MIT licence. It is modelled on <a href="https://ash-hq.org">Ash</a>, the declarative resource framework for Elixir, and runs on <a href="https://bun.sh">Bun</a>.</p>

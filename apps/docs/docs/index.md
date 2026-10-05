---
title: "Mesh"
description: "Mesh is a TypeScript framework for Bun. Describe your domain once, one small .mesh.mx file per entity, and Mesh builds your domain logic as a module of typed functions you connect to anything."
toc: false
---

<nav class="mh-nav" aria-label="Site"><a href="/docs/">Docs</a><a href="/docs/quick-start/">Quick start</a><a href="/architecture/">Architecture</a></nav>

<section class="mh-hero" aria-labelledby="mh-title">
<h1 id="mh-title" class="mh-title"><span>Describe your domain once.</span> <span>Mesh builds the rest.</span></h1>
<p class="mh-lede">Your domain is what your program keeps, what can be done to it, and who may do it. In Mesh you write it down as one small <code>.mesh.mx</code> file per entity.</p>
<p class="mh-lede">From those files Mesh builds your core domain and business logic as a module of typed TypeScript functions, with the input validation, the authorization, the database tables and the migrations. Connect that module to anything: an HTTP API, a command line, a worker, a user interface, an agent. Change a file and the module is rebuilt from it, so nothing drifts.</p>
<p class="mh-actions"><a class="mh-btn mh-btn-main" href="/docs/">Read the introduction</a><a class="mh-btn" href="/docs/quick-start/">Quick start</a></p>
<p class="mh-status">Mesh is not released yet. These pages describe Mesh 1.0.</p>
</section>

::: grids
::: grid
```mx-flow "src/domain/todo/todo.mesh.mx"
entity :Todo table="todos"
  attributes
    uuid :id primary-key
    string :title min=1
    boolean :done default=false

  relationships
    belongs-to=:List :list

  actions auto=[:read, :destroy]
    create :create accept=[:title, :listId]
    update :rename accept=[:title]
    read :pending
      filter=({ self }) => !self.done
      sort
        asc :title

  policies
    policy :owner types=[:create, :read, :update, :destroy]
      authorize-if=({ self, actor }) => self.list.ownerId === actor.id
```
:::
::: grid
<div class="mh-out">
<div class="mh-seam"><span class="mh-build">mesh build</span></div>
<p class="mh-group" data-group="Your app">Your app</p>
<div class="mh-box" data-box="types" data-from="attributes relationships" data-group="Your app"><h3>Types <code>todo.types.ts</code></h3><p class="mh-from">from <code>attributes</code>, <code>relationships</code></p><div class="mh-snip"><code>interface Todo {
  id: string; title: string;
  done: boolean; listId: string }</code></div></div>
<div class="mh-box" data-box="functions" data-from="actions" data-group="Your app"><h3>Functions <code>todo.actions.ts</code></h3><p class="mh-from">one per action, from <code>actions</code>, imported from <code>#mesh</code></p><div class="mh-snip"><code>createTodo(input, context)
pendingTodo(input, context)
renameTodo, readTodo, destroyTodo</code></div></div>
<div class="mh-box" data-box="validation" data-from="attributes actions" data-group="Your app"><h3>Input validation <code>todo.validators.ts</code></h3><p>Every input is checked before your code runs: no empty title, and no field the action does not accept.</p><p class="mh-from">from <code>attributes</code>, <code>actions</code></p></div>
<div class="mh-box" data-box="authorization" data-from="policies" data-group="Your app"><h3>Authorization <span>in every function</span></h3><p>A write is checked before it runs; a read gets the policy in its query. <code>canCreateTodo</code> asks first.</p><p class="mh-from">from <code>policies</code></p></div>
<p class="mh-group" data-group="The database">The database</p>
<div class="mh-box" data-box="table" data-from="entity attributes relationships" data-group="The database"><h3>The table <code>schema.ts</code></h3><p>The <code>todos</code> table, its columns and the foreign key to <code>List</code>, written by the data adapter.</p><p class="mh-from">from the entity line, <code>attributes</code>, <code>relationships</code></p></div>
<div class="mh-box" data-box="migrations" data-from="entity attributes relationships" data-via="mesh migrate generate" data-group="The database"><h3>Migrations <code>migrations/*.sql</code></h3><p>Plain SQL from <code>mesh migrate generate</code> when the table changes; applied by <code>mesh migrate apply</code>.</p><p class="mh-from">from the table</p></div>
<p class="mh-group" data-group="For your tools">For your tools</p>
<div class="mh-box" data-box="rules" data-from="entity attributes relationships actions policies" data-group="For your tools"><h3>Rules for agents <code>rules.md</code></h3><p class="mh-from">from the whole file</p><div class="mh-snip"><code>entity :Todo table="todos"
  actions: auto read destroy;
    create :create accept=[:title, :listId]</code></div></div>
<div class="mh-box" data-box="model" data-from="entity attributes relationships actions policies" data-group="For your tools"><h3>The model <code>model.json</code></h3><p>Every declaration with its source position: what <code>mesh inspect</code> prints.</p><p class="mh-from">from the whole file</p></div>
</div>
<script type="module">
// The diagram is whole without this. On a phone, where the cards pass one at a
// time under the pinned file (CSS only), it marks the card on top so the file
// tints the lines that card comes from. docmd re-runs this script when it swaps
// the page in; the scroll handler is replaced, not added again.
const deck = matchMedia('screen and (max-width: 900px) and (min-height: 660px)');
let frame = 0;
const mark = () => {
  frame = 0;
  const boxes = [...document.querySelectorAll('.mh-hero + .grids .mh-box')];
  if (!boxes.length) return;
  let top = null;
  if (deck.matches) for (const box of boxes) if (box.getBoundingClientRect().top <= parseFloat(getComputedStyle(box).top) + 2) top = box;
  for (const box of boxes) box.classList.toggle('is-hot', box === top);
};
window.removeEventListener('scroll', window.__mhDeck);
window.__mhDeck = () => { if (!frame) frame = requestAnimationFrame(mark); };
window.addEventListener('scroll', window.__mhDeck, { passive: true });
mark();
</script>
:::
:::

<section class="mh-section" aria-labelledby="mh-connect">
<h2 id="mh-connect">Connect it to anything</h2>
<p class="mh-intro">Mesh is not a server and does not assume one. The module is your domain, and whatever you build around it calls the same functions, with the same checks.</p>
<ul class="mh-connect">
<li><strong>An HTTP API.</strong> A route handler turns the request into an input and an actor, and calls the function. The HTTP layer stays yours.</li>
<li><strong>A command line or a worker.</strong> A task calls the same function a request handler would, with the same validation and the same policies.</li>
<li><strong>A user interface.</strong> The server side of your UI calls the functions directly; there is no client to generate and keep in step.</li>
<li><strong>An agent.</strong> Give an agent's tool a function to call. The policies still decide what the agent's actor may do.</li>
</ul>
</section>

<section class="mh-section mh-agent" aria-labelledby="mh-agent">
<h2 id="mh-agent">Ready for your agent</h2>
<p class="mh-lead">The less your agent writes, the less it can get wrong. With Mesh it writes one small declarative file per entity; everything else is built from that file by Mesh's own generators.</p>
<ul class="mh-why">
<li><strong>Fewer places to make a mistake.</strong> The types, functions, validators and checks are generated, the same for every project and the same on every build, instead of written fresh by the agent each time.</li>
<li><strong>A smaller diff to review.</strong> You read the change to the entity file, the part that carries the intent. The generated code is committed beside it, but it follows from the file.</li>
<li><strong>Less to write, less to read.</strong> One file is the whole truth about an entity, so an agent changing a rule reads and writes that file, not a model, a schema and a service layer.</li>
<li><strong>Mistakes stop at build time, with a fix.</strong> A misspelled field in <code>accept</code> is an error at that name, with the line, the column and a suggestion, which an agent can act on in one step.</li>
<li><strong>Tools that answer instead of guessing.</strong> <code>mesh build</code> writes a rules file for the agent to read; <code>mesh inspect</code> prints the model with the source position of every declaration; <code>mesh explain</code> prints the plan a call will follow.</li>
</ul>
<div class="mh-tally">
<h3>What the agent writes, and what it does not</h3>
<p>It writes the 20 lines of <code>todo.mesh.mx</code> above. It does not write the types, the action functions, the input validators, the authorization checks, the table schema, the migration SQL, the rules file or the model: the diagram above shows where each comes from.</p>
<pre><code>src/domain/todo/todo.mesh.mx:11:28 error `accept` names :titel,
which is not an attribute of :Todo. Did you mean :title?</code></pre>
</div>
<p class="mh-more">More in <a href="/docs/ai-agents/">Working with AI agents</a>: the rules file, <code>mesh inspect</code>, <code>mesh explain</code>, and what Mesh does not solve for an agent.</p>
</section>

<nav class="mh-doors" aria-label="Sections of this site">
<a class="mh-door" href="/docs/"><strong>Docs</strong><span>For people who build with Mesh: the introduction, a quick start, a tutorial and the reference for every declaration.</span></a>
<a class="mh-door" href="/architecture/"><strong>Architecture</strong><span>For contributors: the decisions, the research and the design that no single code file explains.</span></a>
</nav>

<p class="mh-colophon">Mesh is open source under the MIT licence. It is modelled on <a href="https://ash-hq.org">Ash</a>, the declarative resource framework for Elixir, and runs on <a href="https://bun.sh">Bun</a>.</p>

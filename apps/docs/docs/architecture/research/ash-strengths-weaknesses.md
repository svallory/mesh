---
title: "Ash strengths and weaknesses"
description: "Ash's greatest advantages and shortcomings, from verified evidence."
---

# Ash: greatest advantages and shortcomings, from evidence

> Independent fact-check: [review of this document](./reviews/ash-strengths-weaknesses-review.md).

Ref: `ash-critique`. Round 1 written 2026-10-01; rewritten after independent review (round 2) and corrected
again (round 3) on 2026-10-01 (see `## Revision log` at the end).

**Versions examined.** `scratch/ash-src/ash` = **v3.33.11** (`mix.exs:13`). `scratch/ash-src/usage_rules` =
**v1.2.8** (`mix.exs:8`). `scratch/ash-src/ash_ai` = **v1.1.1** (`mix.exs:12`). Community sources run 2021-06 to
2026-08. All quoted sources were fetched and read on 2026-10-01; no quote was repaired from memory. Per-post
dates inside thread 70980 come from the page capture (all 2025-05-22), not the per-post JSON.

**Scope note.** Feature inventory belongs to `ash-features`; DSL/extension internals to `ash-dsl-ext`;
run-time internals to `ash-runtime`; the package catalogue to `ash-ecosystem`.

**Attribution rule.** Each quote carries the author's forum/HN handle, the date, and the URL of the page where
the words appear. I do not attach real-world identities to handles. Two authors' sentences are never spliced
into one quote.

**Glossary (first use).** *DSL*: a domain-specific language, here a configuration vocabulary embedded in
Elixir source. *Macro*: Elixir's compile-time code generator; what it generates runs as ordinary functions.
*Changeset*: Ash's pending-create/update structure, roughly Ecto's. *Introspection*: reading a declared
resource's metadata at run time. *Beacon*: a resource modelling something other than a database table.

---

## Summary

1. **The strongest benefit is that derived functions arrive with filtering, sorting, authorisation and
   calculation support attached** — sodapopcan's pipeline, "params → authz → changeset → manipulate changes →
   populate virtual fields (on *every* public function) → etc → return → side effect", generated.
   (sodapopcan, 69829 post 11, 2025-03-08; mike1o1, 70080 post 4, 2025-03-22.)
2. **The most common pro argument is not speed but replacing a bespoke in-house framework**: "if you don't use
   Ash, you are going to be faced with learning some well-meaning (hopefully) soul's bespoke framework"
   (sodapopcan, 69829 post 29, 2025-03-19).
3. **Escape hatches are real, layered and used**: actions → manual actions → generic actions → plain Elixir →
   Ecto. (zachdaniel, HN 2023-10-07; dewetblomerus, 69829 post 23, 2025-03-13.)
4. **The most-cited weakness is the learning curve, and the maintainers say so first**: "The learning curve is
   definitely the biggest one, IMO… we still have a long way to go." (sevenseacat, 69829 post 3, 2025-03-07.)
5. **The strongest published criticism is a team postmortem**: ten developers, ~200k LoC, two years, a paid
   support contract — removed Ash. "it should not be the default choice for any team" (egeersoz, 74717 post 7,
   2026-03-17).
6. **Compile cost is real and measured**: a resource compiling in 11,260 ms with a `code_interface` and 2,270 ms
   without. "the code interface logic is not really the greatest macro code anyone ever wrote" (zachdaniel,
   73196 post 2, 2025-11-05).
7. **Bus factor is quantified**: over 300 contributors and 6,719 human commits, `zachdaniel` has 5,315 —
   **79%** (GitHub contributors API, paginated, 2026-10-01).
8. **On LLM agents the evidence splits and is almost entirely anecdotal. The only controlled study (10 Python
   agent frameworks, one task, Claude-backed assistants) finds that declarativeness alone does not predict
   AI-assistability; convention alignment does — and the best-scoring framework is declarative but
   convention-aligned** (arXiv 2602.11198, 2026-02-03). Ash has no benchmark of its own.
9. **The sharpest 2026 field report is that frontier models struggle with Ash and overcomplicate it**: "even
   Opus 4.6 and Codex 5.3 struggle with Ash… 'pull the entire dataset from db and sort in memory' are anti
   patterns they constantly fall for with Ash. With Ecto they don't." (egeersoz, 74717 post 2, 2026-03-15.)
10. **Documentation and messaging are a self-admitted repeated failure**, from "the docs aren't clear, but check
    the Ash book instead" to zachdaniel's "It makes it difficult to message :(".

---

## 1. Top strengths, ranked

Each needs two independent sources. Items that could not reach two are marked and placed last.

### S1. The Phoenix-context boilerplate is generated, with filtering/auth/sorting attached
- **sodapopcan**, 69829 post 11, 2025-03-08, https://elixirforum.com/t/my-thoughts-on-ash/11 — code interfaces
  "abstracting away the extremely boring and repetitive patterns of params → authz → changeset → manipulate
  changes → populate virtual fields (on *every* public function) → etc → return → side effect."
- **mike1o1**, 70080 post 4, 2025-03-22, https://elixirforum.com/t/what-is-the-benefit-of-using-the-ash-framework/4
  — "It's extremely powerful, because those read functions, for example, automatically provide support for
  filtering, authentication, sorting, etc. All things you'd need to build up manually by hand in your Phoenix
  context."

**Who benefits.** CRUD-heavy SaaS and internal tools; anyone whose API and admin must stay in sync.

### S2. Batteries-included consistency: auth, policies, admin, JSON:API, GraphQL, forms
- **mudspot**, 69829 post 22, 2025-03-09 — "Ash's implementation of Policies is gold!"; and "Our productivity
  were further increased by another factor of 2 with the adoption of Ash."
- **caslu**, 69829 post 1 (OP), 2025-03-07, https://elixirforum.com/t/my-thoughts-on-ash/1 — "You get an
  amazing and fully featured authorization system (which is something that Phoenix doesn't give you out of the
  box), you've got authentication, email, soft delete, an admin panel—sometimes it feels like Ash is a perfect
  SaaS template."
- Vendor corroboration (a testimonial, not independent): Scott Woodall, Principal Software Engineer,
  **Microsoft**, `what-is-ash.md:29-34`, maps Ash to "Ash Admin (Django admin), Ash Resource & Domain (Django
  models & ORM), AshJsonApi (Django REST Framework), Ash Authentication (Django Allauth), Ash Phoenix (Django
  Forms), Ash Policies (Django Permissions)".

**Who benefits.** Small teams that would otherwise staff an API team, an admin team and a web team.

### S3. Escape hatches are real, layered, and used
- **zachdaniel**, HN item 37801585, 2023-10-07, https://news.ycombinator.com/item?id=37801585 — "1. As sane
  config as possible. 2. ability to hook into functional processes and see what's going on 3. Layered escape
  hatches… or you can write a 'generic action' which gives you even more control… 4. Ash isn't its own
  language/environment. It's just an Elixir library… each Ash resource is also an Ecto schema."
- **troupo**, HN item 37632243, 2023-09-24, https://news.ycombinator.com/item?id=37632243 — "As a very new guy
  using Ash: yes, there are escape hatches everywhere, and a lot of magic is quite thin. I find that often if I
  don't understand the magic, I just drop directly into Elixir and/or Ecto (Ash resources are Ecto schemas)."
  The same post reports Zach's ElixirConf talk: "the goal for the next version of Ash is improved DX: error
  messages, debuggability, tools etc." — troupo's summary of the talk, not a transcript.
- **dewetblomerus**, 69829 post 23, 2025-03-13 — hit the learning-curve wall on CRUD and auth, but for the
  complex part: "I chose one of the many options for supplying a custom Module to the Ash resource. And then I
  wrote a normal Elixir module with good old tests."
- **Matt**, 2025-07-11, https://blog.1-800-rad-dude.com/posts/2025/07-11-Migrating-my-Existing-Elixir-App-to-Ash-Framework.html
  — a query fitting no CRUD action became a generic action:
  `action :count, :integer do run fn _input, _context -> Ash.count(__MODULE__) end end`.

**Who benefits.** Experienced engineers and unusual domains.

### S4. Introspection and Spark as an extension platform
- **julienmarie**, 70080 post 5, 2025-03-22 — "My favourite thing in Ash ( and especially in Spark ) are the
  possibilities of Introspection. Building extensions in Ash is great and I'm basically creating a suite of
  extension to integrate Commanded and generate our backoffice directly from my resources… I think Spark is
  the jewel of the whole thing."
- **binarypaladin**, 69829 post 32, 2025-11-05, https://elixirforum.com/t/my-thoughts-on-ash/32 — "I've even
  had to build my own API layer to conform with my company's 'standards' and while it wasn't nothing, Ash's
  introspection and reflection did exactly what I needed them to do."

**Who benefits.** Package authors; teams replacing an internal framework.

### S5. Expressive domain actions instead of CRUD verbs — *single source (vendor)*
- `what-is-ash.md:110` — "The intent behind Ash is _not_ to have you building simple CRUD-style applications…
  The real power comes from defining rich, domain-specific actions with meaningful names like `:publish_post`,
  `:approve_order`, or `:calculate_shipping`."
- **mudspot**, 69829 post 22, 2025-03-09 — his stated reason for adopting Ash everywhere is the ethos: "Ash
  made me feel home by allowing me to get back into my familiar mode of approaching solutions from the data
  engineering angle."
- **clsource**, 69829 post 25, 2025-03-14 — "using Ash would have been a huge blessing if those projects use
  it, not only for defining the models but for calling external apis as well."

**Single source.** Only the vendor doc supports the claim as stated; the two user quotes praise adjacent
properties (a data-engineering mindset, calling external APIs), not named domain actions.

**Who benefits.** Domain-heavy products; teams that later want GraphQL, JSON:API or an admin on top.

### S6. Replaces a bespoke in-house framework — the most common pro argument
- **sodapopcan**, 69829 post 29, 2025-03-19 — "if you don't use Ash, you are going to be faced with learning
  some well-meaning (hopefully) soul's bespoke framework that was maybe documented, but the docs are probably
  out of date, and the code's been mangled by other folks who didn't understand it, and all those people
  probably don't even work there anymore. I've hit this is in every company I have worked for, even the smaller
  ones." And: "I think it's irresponsible not to use Ash on any serious project that's going to one day have
  people coming off of and onto it."
- **binarypaladin**, 69829 post 32, 2025-11-05 — "the reason I decided to use it was because I was dealing
  with a bespoke framework that I made and knew in and out. Even though I'm something of a documentation
  fascist, it wasn't enough to train my small team well enough… Ash does so much more."
- **ken-kost**, 69829 post 31, 2025-03-19, https://elixirforum.com/t/my-thoughts-on-ash/31 — "I'd much rather
  put some time up front learning a common language than ever have to deal with a homegrown framework again."

**Who benefits.** Teams that would otherwise maintain an internal framework indefinitely.

### S7. Generators and installers remove the blank-page problem
- **Matt**, 2025-07-11 — "Ash makes this as easy as possible with their Igniter tool. Igniter combines code
  generation, code modification, and scripting so that you can run one command to add a package to your
  dependencies, patch your config, and generate any other necessary files."
- **mike1o1**, 69829 post 8, 2025-03-07 — "I've tried Ash a few times in the past and wasn't able to get over
  the curve. With the Ash book comes a more guided story/experience, and along with the generators it was
  finally able to click for me."
- **zachdaniel**, 69829 post 21, 2025-03-09 — the newer installers "generate the actions directly into your
  app which makes it much easier to understand what Ash is doing, and also to see what kinds of things you
  might want to test."

**Who benefits.** Newcomers; teams migrating incrementally.

### S8. Small-team leverage
- **mindok**, 69829 post 10, 2025-03-08, https://elixirforum.com/t/my-thoughts-on-ash/10 — "You can go a very
  long way with a very small team once you get a handle on Ash & how it works… these days I'd say we spend the
  vast majority of our time on UI design & polish as the engine room (business rules, policies, migrations etc)
  pretty much look after itself."
- **mudspot**, 69829 post 22, 2025-03-09 — "The switch [to Phoenix] made our productivity 3x. Our productivity
  were further increased by another factor of 2 with the adoption of Ash."

**Who benefits.** Solo developers and small teams shipping CRUD products.

### S9. A complement to Phoenix, not a replacement — *single source*
- **spiderice**, HN item 37800063, 2023-10-07, https://news.ycombinator.com/item?id=37800063 — "Ash isn't an
  alternative to Phoenix. It's an alternative to Ecto. It's a data layer that uses Ecto under the hood… You can
  use Ash with Phoenix and Liveview." (A commenter's formulation, not the maintainer's.)
- The maintainer's own wording, `what-is-ash.md:104`: "It is not an **alternative** to frameworks like Phoenix,
  rather a **complement** to them."

**Single source.** spiderice's comment is the only non-vendor source; the docs line is a vendor page.

**Who benefits.** Teams already on Phoenix adopting incrementally.

### S10. Test data generation — *single source*
- **sevenseacat**, 69829 post 3, 2025-03-07 — "Ash provides some tools for things like data generation and
  property testing… (the generators in particular got a lot of polish when it came to writing the testing
  chapter in the Ash Framework book.)" **I found no second independent source** on generators as a *testing*
  aid. **Single source.**

---

## 2. Top weaknesses, ranked

Cause legend: **[IR]** inherent to the declarative resource model · **[EM]** caused by Elixir macros /
compile-time implementation · **[EC]** caused by ecosystem size · **[DO]** documentation / onboarding.
Classifications marked **inference** are mine, with the reasoning given.

### W1. The learning curve — the top complaint; concept overload is the mechanism
**Cause: [IR] + [DO].**

- **sevenseacat**, 69829 post 3, 2025-03-07, https://elixirforum.com/t/my-thoughts-on-ash/3 — "The learning
  curve is definitely the biggest one, IMO… we still have a long way to go." And: "It is a really big mental
  shift to think about things in 'the Ash way'."
- **egeersoz**, 74717 post 7, 2026-03-17, https://elixirforum.com/t/ash-with-ai-split-thread/7 — "Having to
  constantly remember the differences between calculations, aggregations, preparations, policies and other
  Ash-specific concepts, along with all the gotchas and limitations and subtleties of each one in order to
  maintain a clear mental model. Lots of ways to shoot yourself in the foot with them because the underlying
  concepts are abstracted away from you, there are overlaps and the docs don't make clear distinctions where
  relevant."
- **egeersoz**, 69829 post 18, 2025-03-08, https://elixirforum.com/t/my-thoughts-on-ash/18 — "It's also unclear
  when and how you're supposed to deviate from 'the Ash way,' which isn't well documented."
- **mike1o1**, 69829 post 8, 2025-03-07 — the value only appears at scale: "if you're starting out building a
  simple Task management system, using Ash might seem like total overkill. It's much easier to keep things in a
  context file… The Ash learning curve doesn't seem worth it at this point."
- **caslu**, 69829 post 5, 2025-03-07 — "I don't know how easy to have a team working with ash."

**Classification.** The overlapping-concept complaint is a property of the model: several distinct concepts all
shape queries, which supports [IR]. egeersoz names four query-shaping paths (policies, filter checks,
preparations, expression calculations); his list of concepts to keep apart is calculations, aggregations,
preparations, policies "and other Ash-specific concepts". The which-page-to-read part is [DO]. The split is
**inference**; both quotes are sourced.

### W2. Error messages, stack traces and debugging
**Cause: [EM] (inference) + [DO].**

- **egeersoz**, 74717 post 7, 2026-03-17, https://elixirforum.com/t/ash-with-ai-split-thread/7 — "Cryptic
  errors and missing/broken stack traces. A lot of errors don't even show where exactly your code calls the Ash
  code that is blowing up, so good luck trying to guess. For developer-friendly error messages, please see how
  Ecto does it: 'X was expected, Y happened instead, this is probably due to one of four reasons…'". Same post:
  "you end up spending a lot of time trying something that seems like it should work, get bizarre errors or
  confusing performance problems, then ask in Slack, Discord, or GitHub and learn that you should actually be
  doing it this other way, or that it is not supported and that an escape hatch is actually the way to go."
- **egeersoz**, 69829 post 18, 2025-03-08 — "Often, it feels like a straitjacket: you don't fully realize how
  it limits you until you attempt something ordinary and run into cryptic errors."
- **anibal**, 70980 post 12, 2025-05-22, https://elixirforum.com/t/ash-framework-official-llm-development-tooling-and-guidance/12
  — "Ash has been particularly frustrating, the book helped a lot by the way, but the docs are not there yet and
  the number of options for anything you want to achieve are almost infinite."
- GitHub: **ash#2274**, "Using `exists()` in policy with syntax error produces very obtuse stack trace"
  (olivermt, 2025-08-15, https://github.com/ash-project/ash/issues/2274); **ash#2392**, "Static defaults for
  array embedded resource attributes cause a cryptic compile error." (jimsynz, 2025-10-16,
  https://github.com/ash-project/ash/issues/2392).

**Classification (inference).** A missing stack trace is a build-level property: the call is inside a runtime
library reached through generated functions, so your own stack does not name it. Hence [EM] rather than [IR].
The sources do not say this; it is my reading.

### W3. Lock-in and bus factor
**Cause: [IR] (structural) + [EC].**

- **caslu**, 69829 post 1 (OP), 2025-03-07 — "unlike Ecto, Ash is not a library; Ash is your application. Your
  entire app will literally derive from it. You cannot decouple Ash, and it would be a silly thing to do. So
  you basically need to agree to do things the 'Ash way.'… I feel like if Zach wakes up and is no longer in the
  mood to maintain Ash or to answer my doubts, my application would be doomed."
- The number, corrected: over the paginated contributors API (300 contributors, 2026-10-01), `zachdaniel` has
  **5,315 of 6,719 human commits = 79.1%**
  (https://api.github.com/repos/ash-project/ash/contributors?per_page=100, pages 1-3). Next: barnabasJ 112,
  jimsynz 92, vonagam 82, sevenseacat 75.
- **arcanemachiner**, HN item 37629719, 2023-09-24, https://news.ycombinator.com/item?id=37629719 — "It's
  written mostly by one guy and it's definitely a high-level abstraction… I wonder if it tries to do too much."

**Classification.** The dependence follows from the resource being *the application* rather than a swappable
component — the declarative-model choice itself, so [IR]. The distribution of maintainership is [EC].

### W4. Macro/DSL opacity — "There is often no reasoning about config files"
**Cause: [EM] (inference), with contrary evidence stated.**

- **skybrian**, HN item 37801485, 2023-10-07, https://news.ycombinator.com/item?id=37801485 — "the result
  looks superficially like Gradle or Nix, with configuration being done using obscure scripting languages…
  'declarative syntax' is just a way to say that it acts as a config file. There is often no reasoning about
  config files. You just need to read what all the config parameters do, and if the documentation is
  inadequate, you need to read the source code of the program that ingests the config file… It's how you get
  systems that are notoriously difficult to understand."
- **egeersoz**, 69829 post 18, 2025-03-08 — the same complaint with a count: "coding with Ash doesn't really
  feel like writing Elixir at all, given that the DSL seems to be heavily macro-driven. For a rough (and
  admittedly unscientific) comparison, the Phoenix repo has only 19 defmacro statements, whereas Ash—around
  the same size—has 62." (his comparison, explicitly labelled unscientific; I did not count them)
- **caslu**, 69829 post 1 — the Devise comparison: "It reminded me of when I first encountered the `devise` gem
  in the Rails world… I felt this a bit with AshAuthentication."

**Contrary evidence.** Ash's own design doc says the resource is *data*: `design-principles.md:19` — "A
resource, for example, is really just a configuration file. On its own it does nothing. It is provided to code
that reads that configuration and acts accordingly." And **ken-kost**, 69829 post 4, 2025-03-07 — "I can _see_
how Ash _is_ Elixir. Don't let the declarations fool you, it's functions all the way down." The opacity is
therefore contested: the runtime interprets data, but the DSL surface is macros.

### W5. Documentation and onboarding messaging — a self-admitted failure
**Cause: [DO].** Both sides agree.

- **egeersoz**, 69829 post 18, 2025-03-08 — "Ash's documentation could stand significant improvement. It often
  feels auto-generated, with crucial details added as an afterthought… it's not encouraging when my teammates
  say, 'The docs aren't clear, but check the Ash book instead.'"
- **egeersoz**, 74717 post 7, 2026-03-17 — the navigational complaint: "It says 'See Ash Reactor Guide for more
  info', so I clicked through. Except that one then says 'See Getting started with Reactor to understand the
  core Reactor concepts first'. Hmm, shouldn't a guide be explaining the core concepts?… The guide's Example
  section says 'An example is worth 1000 words of prose'. No, it's not."
- **zachdaniel**, 69829 post 19, 2025-03-08 — "would hardly call docs an 'afterthought' but there is room for
  significant improvement 100%." **sevenseacat**, post 20 — "It's a work in progress."
- **DylanSp**, HN item 37811686, 2023-10-08, https://news.ycombinator.com/item?id=37811686 — "I really wish the
  Ash website made this more immediately clear; the initial description makes it sound like Ash has a broader
  scope than it actually does."
- **zachdaniel**, replying to DylanSp, HN item 37824132, 2023-10-09,
  https://news.ycombinator.com/item?id=37824132 — "But you aren't the first person to say this. It's complex
  because we do build your APIs for you, and it's not a requirement to use Phoenix to make this work. But Ash
  also can (and usually does) act as something you use alongside Phoenix. It makes it difficult to message :("
- **zachdaniel**, HN item 37629719, 2023-09-24 — "We used to have tons of information and I spent a bunch of
  time removing it all trying to simplify. I very clearly removed too much."
- In the 2023 HN launch thread, three readers reported they could not tell what language Ash is for.
  **kkarpkkarp**, HN item 37630792, 2023-09-24 — "I tried figure out what I can build with this framework (web
  apps? native apps?) and what programming language I have to know to use it and after few clicks, also into
  doc, I gave up." **bradrn**, HN item 37630837, 2023-09-24 — "From the code samples it looks like it might be
  Ruby, but the documentation doesn't seem to confirm or deny it either way." **avarun**, HN item 37637169,
  2023-09-24 — "I still don't see it anywhere other than the small caption mentioning ElixirConf (still not
  obvious that it's meant for Elixir) and the mention of Phoenix + Elixir ecosystem under the 'Compatibility'
  section (way too far down the page)."

### W6. Upgrade churn and breaking-change surface
**Cause: cause category not established (inference).** The cited evidence is point-release regressions (a
decode failure, a compile deadlock) — implementation churn, not shown to be macro-caused and not a consequence
of the declarative model. The 3.0 guide
enumerates ~40 breaking categories (§4). Independent evidence that upgrades land
hard *within* the 3.x line:

- **ash#2397**, 2025-10-17, https://github.com/ash-project/ash/issues/2397 — "After upgrading from 3.5.42 to
  3.7.1, I can't read any table that has an UUIDv7 field in it, they will all fail to decode the binary."
- **ash#2670**, 2026-04-09, https://github.com/ash-project/ash/issues/2670 — "Upgrading from Ash 3.23.0 to
  3.23.1 causes a compilation deadlock when custom policy check modules are referenced in resource policies"
  (a 3.23.1 regression).
- **binarypaladin**, 69829 post 32, 2025-11-05, on the other side of the same coin — "I update the framework
  weekly at this point because the few breaks it has caused get fixed sometimes in under an hour after I pop
  over to the Discord."
- `design-principles.md` — "any breaking changes (a rare occurrence) have a clean and simple upgrade path."

### W7. Policy and expression complexity
**Cause: [IR].**

- **egeersoz**, 74717 post 7, 2026-03-17 — "fundamentally, policies, filter checks, preparations, and
  expression calculations all ultimately add conditions to a query, but through four different abstraction
  paths with different DSLs, different mental models, and different documentation pages. When debugging
  anything remotely complex, you'll have a lot of difficulty reasoning about it, unless you're superhuman."
- **egeersoz**, 74717 post 7 — a correctness trap, not just complexity: "Ash expressions look like Elixir but
  don't behave like Elixir. They use SQL-style NULL semantics, where nil values 'poison' expressions. For
  example, x + nil always evaluates to nil, and not nil returns nil… you may get silent wrong results with no
  error to point you in the right direction."
- **mindok**, 69829 post 10, 2025-03-08 — "There are always tricky bits - e.g. our initial RBAC & workflow
  implementations."
- The 3.0 guide documents the same surface: `Ash.Policy.FilterCheck` and `FilterCheckWithContext` merged;
  "Custom checks and notifiers will not have access to the original data by default";
  "`Domain.authorization.authorize` now defaults to `:by_default`".

### W8. Compile-time cost — measured
**Cause: [EM].** The evidence points at macro expansion in `code_interface`.

- **sezaru**, 73196 post 1, 2025-11-05, https://elixirforum.com/t/using-code-interface-makes-resource-slow-to-compile/1
  — "When compiling the resource with the code_interface, it would take around 11 seconds: `[profile] 11260ms
  compiling…`". Post 3 gives the public repro (github.com/sezaru/test_slow_code_interface): resource 4148 ms
  with vs 533 ms without; domain 3719 ms with vs 368 ms without.
- **zachdaniel**, 73196 post 2, 2025-11-05 — "Wow, that is pretty damn hefty!… One such example is that the
  code interface logic is not really the greatest macro code anyone ever wrote, I wrote it pretty early on and
  I know a lot more than I did back then." Post 6, 2025-11-15: "@sezaru should be some pretty significant
  improvements in main of ash."
- **sezaru**, 72265 post 1, 2025-08-28, https://elixirforum.com/t/strategies-to-make-resources-compile-faster/1
  — "some of them take more than 30 seconds". **zachdaniel**, post 4: "The biggest thing you can do here is to
  remove as many anonymous functions from your resources as possible and extract them into module
  changes/preparations etc."
- **ash#2267**, 2025-08-09, open, https://github.com/ash-project/ash/issues/2267 — "Ash currently has 187
  compilation cycles, which causes slower compilation time and most of the project to recompile for even small
  code changes."
- **ash#2798**, 2026-07-23, https://github.com/ash-project/ash/issues/2798 — "running `mix compile` takes
  several minutes for just 1 file" (3.30.1). Closed as fixed in Elixir `main`, i.e. an Elixir compiler bug.

### W9. Run-time overhead — measured, by one team — *single source*
**Cause: [EM] (inference).** A per-span `:telemetry.list_handlers` scan in `Ash.Tracer` is an implementation
choice, not an ecosystem-size effect.

- **ash#2921**, 2026-09-09, https://github.com/ash-project/ash/issues/2921 — "Our suite makes 3,853,289 Ash
  telemetry spans per full run. Stripping this out shaved off ~14s per run, making it about 3% faster." On a
  bare ETS resource, removing instrumentation "saves 15–23% of `Ash.Changeset.for_create/4` and 10–21% of
  `Ash.create!/1`". In a comment of 2026-09-09 **lardcanoe** adds: "Across our entire dependency tree,
  :telemetry.list_handlers is called in exactly one place: ash/lib/ash/tracer/tracer.ex:103". **zachdaniel**
  replied "Open to it 👍". The issue records that the numbers were produced with Claude's help — one team's
  measurement, so this item stays **single source**.
- I found **no** benchmark of Ash query execution against raw Ecto (Open questions 3).

### W10. Hiring pool, and editor support that depends on one language server
**Cause: [EC] and [EM].** The hiring-pool half has two independent sources; the editor half is single-source.

- Hiring pool: `what-is-ash.md:90` concedes it — "Ash is still niche, so developers may not know it right out of
  the gate". **caslu**, 69829 post 5 — "I don't know how easy to have a team working with ash". **egeersoz**,
  74717 post 7 — "New and more junior hires will have difficulty with it… our more junior engineers have a hard
  time becoming productive with it."
- Editor support: `scratch/ash-src/spark/documentation/how_to/setup-autocomplete.md:11` — "Autocomplete is
  enhanced by a plugin to ElixirSense, and therefore it only works for those who are using
  [ElixirLS](https://github.com/elixir-lsp/elixir-ls). We may consider adding the same extension to other
  language servers in the future." **This is the only source I found**, and it is a project document, not a user
  complaint. I could find no user reporting the problem.

---

## 3. What users wish Ash had

**User**-filed asks, not maintainer to-dos. All from `My thoughts on Ash` (69829) and `Ash with AI` (74717).

| Wish | Source |
|---|---|
| Internals documentation: Ash, Spark, "the Ash magic", to enable contributions | **caslu**, 69829 post 9, 2025-03-07 — "please include some sections focusing on Ash internals, like a deep dive into Ash, Spark, and other related components. I think this would be very helpful for us to understand the 'Ash magic' and even encourage more contributions"; **swrenn**, post 14 — "I would love to see an internals section in the documentation" |
| Better error messages and working stack traces | **egeersoz**, 74717 post 7, 2026-03-17 |
| Framework-level support for database triggers | **egeersoz**, 74717 post 7 — "No framework-level support for database triggers, in the way Ash looks at custom_indexes and automatically includes them in migrations" |
| Expression semantics matching their syntax, and a better Expressions page | **egeersoz**, 74717 post 7 — "Ash expressions look like Elixir but don't behave like Elixir"; "the Hexdoc page for Expressions is another example of 'all of this needs a ton of work'" |
| Docs that motivate a feature, not merely show one | **egeersoz**, 74717 post 7 — "neither the 'guide' nor the 'tutorial' explain why exactly one might want/need to use a Reactor. What is a motivation for using it?" |

Maintainer-side items, kept separate because they are to-dos rather than user wishes: `ash#1792` (open,
sevenseacat, 2025-02-14), whose actual content is a **data leak** — default pubsub notifications put the "full
actor resource" into the broadcast payload; `ash#1187` (2024-05-21); `ash#1747` (2025-01-31); `ash#2331`
(2025-09-19, open); `ash#2267` (2025-08-09, open); PR #2241 (2025-07-31, adds deadlock notes to the **usage
rules**).

**Pattern (fact):** the asks cluster on internals documentation, error messages, and clearer semantics. Every
ask in the table is from 2025-2026, after Ash 3.0 shipped; no ask in the table concerns safety defaults.

---

## 4. Ash 2 → 3 migration: what changed and why

From `scratch/ash-src/ash/documentation/topics/development/upgrading-to-3.0.md`. **The maintainers' stated
reasons are quoted verbatim.** Where the guide gives no reason, the cell says so rather than inventing one.

| Change | The guide's stated reason | Line |
|---|---|---|
| `Ash.Flow` split into its own `ash_flow` package | *(none given)* — "If you use `Ash.Flow`, include `{:ash_flow, "~> 0.1.0"}`" | :23-25 |
| `picosat_elixir` demoted from hard dependency to optional | "to help folks handle certain compatibility issues" | :29 |
| `Ash.Api` → `Ash.Domain`; config `ash_apis` → `ash_domains` | "The previous name was often confusing as this is an overloaded term for many… `Ash.Api` has been renamed to `Ash.Domain`, which better fits our usage and concepts" | :33 |
| `domain.execution.timeout` default 30 s → `:infinity` | "a timeout requires copying memory across process boundaries, and is an unnecessary expense a _vast_ majority of the time" | :47 |
| `actions.{create,update,destroy}.reject` removed | "Blacklisting inputs makes it too easy to make mistakes. Instead, specify an explicit `accept` list." | :49 |
| `Ash.Registry` removed; resources live in the domain | "no longer needed. Place each resource in the domain instead" | :59 |
| `Ash.Policy.FilterCheck` + `FilterCheckWithContext` merged | *(none given)* — "Compiler warnings will show you what callbacks mismatch." | :84 |
| `Ash.Filter.TemplateHelpers` → `Ash.Expr` | "This often led to confusion because it was a hard to remember module name, and didn't really make sense to be separate from the rest of our utilities." | :94 |
| `Ash.Query.Error.NoSuchField` replaces `NoSuchAttribute` | "This was wrong as sometimes the field reference was not an attribute." | :182 |
| `Ash.set_*` (actor/tenant/context in the process dictionary) removed | "There were fundamental issues with this pattern that manifested in subtle bugs. We suggest making this change _before_ you upgrade" | :197 |
| A resource's `domain` must be known when building a changeset/query | "In order to honor rules on the `Domain` module about authorization and timeouts, we have to know the `Domain` when building the changeset." | :220 |
| `default_accept` default: all public+writable → `[]` | "This encourages a pattern of explicitly listing inputs to actions, and is safer and less error prone." | :284 |
| Context in changes/preparations/validations is a struct, not a map | "To help make it clear what keys are available in the context provided to callbacks on these modules… This helps avoid potential ambiguity, and acts as documentation." | :385 |
| **`private?: true` → `public?: true` (inversion)** | "Instead of attributes defaulting to `private?: false`, they now default to `public?: false`. **It was too easy to add an attribute and not realize that you had exposed it over your api.**" | :424 |
| `require_atomic?` defaults to `true` on `:update`/`:destroy` | "Updates and destroys that can be made fully atomic are always safe to do concurrently, and as such we now require that actions meet this criteria, or that it is explicitly stated that they do not have to." | :592-601 |
| Anonymous-function changes can never be atomic | "Anonymous function changes can never be made atomic, because we don't know what they contain." | :617 |

Further breaking sections with no stated reason, listed in the guide: default read actions now paginatable;
before-action/before-transaction hook order reversed; calculation arguments moved to `context.arguments`;
anonymous calculations operate on a list; calculation loads no longer select all related fields; calculations
lose `select/3`; embedded resources lose `autogenerated_id`; PubSub notifier no longer publishes previous values;
`Domain.authorization.authorize` defaults to `:by_default`; `Ash.Error.Invalid.NoSuchInput` errors on unknown
inputs; `%Ash.NotLoaded{}` for attributes; calculations do not reuse values by default; resources are not
interchangeable with `Ash.Type`; plus module renames (`Ash.Calculation` → `Ash.Resource.Calculation`,
`Ash.Query.expr` and `Ash.Query.to_query` removed, `Ash.Changeset.new/2` removed) and exception key remaps
(`name` → `attribute`/`relationship`/`function`/`operator`).

---

## 5. The maintainers' own account of the trade-offs

- **Not for everyone, said plainly.** **zachdaniel**, 69829 post 2, 2025-03-07,
  https://elixirforum.com/t/my-thoughts-on-ash/2 — "I won't personally 'argue' with your takes really insofar
  as 'convincing' people to use Ash coming from me has a pretty clear bias, but ultimately Ash isn't a fit for
  every person or every project and that's All Good™ If you do end up switching your app off of Ash, please do
  come back with a retrospective."
- **The integrated-stack argument.** **zachdaniel**, 69802 post 4, 2025-03-06,
  https://elixirforum.com/t/reasons-not-to-use-ash-split-thread/4, replying to **acrolink** (post 1, "I will
  never Ash. I like to do things my way."; post 3, "I prefer to avoid adding another layers of tools over
  existing working ones") — "the pros ultimately outweigh the cons when you can use a truly integrated stack
  instead of slapping a bunch of libraries together, or hand-writing everything yourself." Earlier, post 2:
  "AshJsonApi is just one extension of many that we provide, and that extension has a bunch of opinions about
  building a particular type of API."
- **Not model-first.** **zachdaniel**, HN item 37629719, 2023-09-24 — "I don't believe in modeling as a sort of
  'pure' thing that you can do in advance of coding. Our tools are aimed at essentially doing both at the same
  time, finding the middle ground between your domain model and reality."
- **Sharp-edges era.** **zachdaniel**, HN item 27591079, 2021-06-23,
  https://news.ycombinator.com/item?id=27591079 — "it is definitely at the 'sharp edges' phase, where its great
  if you're okay with hanging out in our discord and troubleshooting, and even better if you're the kind of
  person who can dive in and PR whatever change is needed."
- **Docs and support, in his words.** **zachdaniel**, 69829 post 19, 2025-03-08 — "we provide free support
  pretty much everywhere including in the elixir slack and here… We are gradually improving our docs (would
  hardly call docs an 'afterthought' but there is room for significant improvement 100%)."
- **A decade of staying power.** **sevenseacat**, 69829 post 3, 2025-03-07 — "It is a really big mental
  shift… But honestly, I've been using it for long enough that I don't think I would want to go back to
  building apps without it (despite all the pain it still sometimes causes)."
- **The slogan**, `what-is-ash.md:112` — "Model your domain, derive the rest" (also the ash-hq.org headline,
  fetched 2026-10-01). **caslu**, 69829 post 1, 2025-03-07, uses the same phrase — "model your domain, derive
  the rest" — for describing what Ash is.
- **The tenets**, `design-principles.md`: "Anything, not Everything"; "Declarative, Introspectable,
  Derivable"; "Configuration over Convention"; "Pragmatism First"; and an explicit **not** DDD — "Domain Driven
  Design comes with a considerable amount of baggage and unnecessary complexity… much of what DDD teaches are
  actually _implementation_ details."
- **Progression, self-described.** **zachdaniel**, 73196 post 2, 2025-11-05 — "I wrote it pretty early on and
  I know a lot more than I did back then."

---

## 6. Ash and LLM coding agents

What the sources say, and where. No conclusion here; conclusions are in the final section.

### 6a. What Ash's own docs say
`scratch/ash-src/ash/documentation/topics/development/working-with-llms.md` (v3.33.11):
- `:9` — "It is also _quite_ debatable whether it is a good idea to use them at all. Nothing in Ash will ever be
  predicated on the usage of these tools."
- `:13-15`, in a block titled "Getting Support with LLM generated code" — "Please note that LLMs often
  hallucinate despite our best intentions. If you need help with something, and you come to our support
  channels, you _must_ make it clear when the code you are asking for help with was generated by an LLM… the
  discord and forums are not a place for others to debug LLM hallucinations." **This is a rule about support
  etiquette, not a claim that the DSL attracts hallucinations.**
- `:30` — Tidewave "can significantly improve the quality of the code generated by LLMs".
- "Guide it on tools/design" — "The majority of Elixir code LLMs are trained on will be using Phoenix contexts
  and direct Ecto calls."

`scratch/ash-src/ash_ai/README.md:72` (v1.1.1) — "We are still experimenting to see what tools (if any) are useful
while developing with agents."

### 6b. The maintainer's blog claims
**zachdaniel**, "Usage Rules: Leveling the Playing Field for AI-Assisted Development", 2025-07-18,
https://www.zachdaniel.dev/p/usage-rules-leveling-the-playing — "The amount of hallucinations I've been asked
questions about, and 'AI slop' I've had to deal with is astronomical." This concerns OSS users generally; the
post does not single out Ash, and it does not use the word declarative. It also says: "All reports show
effectively a night and day difference in folks' experience with agents. The more off-the-beaten-path, or the
more recently released what you're working with is, the more effective thse tools are." [sic: "thse" in the
source]

**zachdaniel**, "LLMs & Elixir: Windfall or Deathblow?", 2025-06-01,
https://www.zachdaniel.dev/p/llms-and-elixir-windfall-or-deathblow — the strongest claim: "We've done this
[usage-rules.md] for the main Ash packages, and the transformation is remarkable. We went from LLM agents being
practically useless for Ash development to being able to generate idiomatic, production-ready code. The
dichotomy of 'meet my standards' versus 'let the LLM do it' simply disappeared." The same post lists, among
items in a list that opens "Over the last few months I've observed:": "a huge increase in fully off the wall and weird questions driven
by LLM hallucinations". It also asks for Elixir evaluation datasets, noting: "I see plenty of python stuff
there, but not no Elixir."

### 6c. The maintainers' compile-time-guardrail claim
**Alembic**, 2025-05-15, https://alembic.com.au/blog/ash-ai-comprehensive-llm-toolbox-for-ash-framework — "while
foundation LLM models need further prompting to be proficient with Ash, it still provides a ton of guardrails
for agents to help you develop. So much of Ash is verified at compile time, and provides explanatory errors when
things are configured incorrectly. Ash is a perfect middle-ground structure for your developers and their LLM
tools to collaborate on."

**zachdaniel**, 70980 post 3, 2025-05-22 — replying to **ghannam80** (post 2, "I think this could be an
opportunity for Ash to shine as its declarative model makes it perfect to generate high quality code using
LLM…") with: "I concur." So the maintainer side argues **both** levers: fresh context **and** declarative,
compile-checked structure.

**zachdaniel**, 70980 post 5, 2025-05-22, on his own evidence: "My personal and subjective experimation shows
a night and day difference with: good rules files, providing reference for whatever you're making" (sic). Post
13: "Early experimentation with a combined rules file leads to massive improvements in output of LLMs, and that
is just with the ash ones not one for elixir, LiveView, etc."

### 6d. The only controlled study I found
**Ahmed & Deshpande**, "Declarative by Design, Assistable Only by Convention: Benchmarking Multi-Agent
Frameworks for AI-Assistability", arXiv 2602.11198, submitted 2026-02-03, https://arxiv.org/abs/2602.11198. It
introduces "AI-assistability", combining an LLM-as-judge "structural alignment" score with "functional
correctness (pass@1)". Three AI coding assistants — GitHub Copilot, Claude Code and Cursor, each "configured
with Claude models via Anthropic's API" and run in agent mode — re-implemented one fixed agent (the
DDL2PropBank task, Agent-as-a-Tool pattern) in each of ten **Python** multi-agent frameworks. Verbatim from the
abstract: "Our results challenge the intuition that declarative framework design guarantees AI-assistability:
Agno, with a single canonical pattern and convention-aligned API, achieves the highest AI score (0.55), while
DSPy -- the most declarative framework by design -- scores lowest (0.07), as its novel abstractions are
insufficiently represented in AI training data. We find that convention alignment, not declarative design
alone, is the primary driver of AI-assistability (r = 0.576 between σ̄ and pass@1)." Its discussion section
adds (§5, verbatim): "Agno's API is itself declarative, yet convention-aligned, and benefits from that
combination; the difficulty DSPy exhibits stems instead from declarative novelty —abstractions
under-represented in training data". And it bounds its own scope: "These conclusions hold within a deliberately
controlled scope" (one task; unconstrained evaluation is left to future work). It does not cover Ash.

**What this study is and is not evidence about.** It is controlled evidence that *novel* declarative
abstractions are off-distribution for coding assistants, and that convention alignment with training data
predicts AI-assistability. It is not evidence against declarativeness as such — its top scorer is itself
declarative — and it says nothing about Ash.

**There is no Ash benchmark** — zachdaniel says so himself in 6b.

### 6e. Evidence for (all anecdotal)
- **ken-kost**, 74717 post 1, 2026-03-09 — "Agreed; I just want to add that IMO Ash amplifies this even further.
  Especially since the dawn of usage rules." He replies to the split-off thread whose title egeersoz quotes in
  post 7 — "Elixir is the productivity language of the Agentic era" — so the "this" that Ash amplifies is most
  likely that productivity claim. **Inference**: the parent post was not retrieved.
- **egze**, 74717 post 11, 2026-03-21, https://elixirforum.com/t/ash-with-ai-split-thread/11 — "My experience
  with Ash and AI (Claude Code) has been great. usage_rules is nice to guide AI how to do things, also paired
  together with Tidewave makes it even better. It takes me now just a couple of days to build a project from
  scratch, which would have taken me by myself probably weeks."
- **mau013**, 74717 post 10, 2026-03-21 — "my experience with Claude has been rather good"; "Ash is probably
  not an Elixir beginner library, BUT it is a game changer if you decide to go all in".
- **AndyL**, 74717 post 3, 2026-03-15 — "I've seen good results with Claude, Ash and usage_rules. YMMV".
- **dimitarvp**, 74717 post 5, 2026-03-16 — positive overall, with one LLM episode: on a JWT auth problem "it
  was a hike and I needed to dump the entire source code to Gemini Pro and it found what incantations should
  I use."
- **mindok**, 70980 post 14, 2025-05-22 — "I just read the usage rules for Ash and thought 'darn - should have
  read this a couple of years back!'"
- **anibal**, 70980 post 15, 2025-05-22 — "Claude 4 is looking good, it nailed setting up a set of nested forms
  for Dash Admin".
- **redrapids**, 69829 post 24, 2025-03-14 — "coding agents are going to need better structure. Ash simply
  consolidates the important bits to make it easier for people to understand and build. The same is true of
  machines." (A prediction, not a report.)
- **ghannam80**, 69829 post 27, 2025-03-15 — the declarative hypothesis: Ash "could be a strong baseline for
  more like AI code generators… so it is not far from writing maybe AI prompt where you supply your data model
  in simple English".
- **dartos**, HN item 41896590, 2024-10-20, https://news.ycombinator.com/item?id=41896590 — "I recently picked
  up the Ash framework for elixir and it does all that too, but in a declarative, precise language which
  codegens the implementation in a deterministic way."
- **stray**, HN item 45431182, 2025-09-30, https://news.ycombinator.com/item?id=45431182 — "Elixir with Ash
  Framework, backed by PostgreSQL. Claude Code did just fine -- but this was back in June before Claude got
  nerfed."

### 6f. Evidence against
- **egeersoz**, 74717 post 2, 2026-03-15 — "I've found that even Opus 4.6 and Codex 5.3 struggle with Ash. For
  some reason they can't figure out the 'Ash way' of doing standard operations and always overcomplicate
  things. Stuff like 'pull the entire dataset from db and sort in memory' are anti patterns they constantly
  fall for with Ash. With Ecto they don't. Maybe because Ecto is so similar to SQL."
- **egeersoz**, 74717 post 7, 2026-03-17 — "over the past year of working with AI, it has never ever gotten
  moderately complex expressions right (although I think Opus 4.5 came close once)". And: "This has tripped
  our AI agents several times, to the point where I now have a local copy of the AshJsonApi repo that I keep
  updated and when the AI struggles I just say 'go read the source code to see if this is even possible' and
  it usually comes back with 'OK so it looks like Ash has not implemented this'."
- **troupo**, HN item 37380622, 2023-09-04, https://news.ycombinator.com/item?id=37380622 — "Currently working
  on an Elixir project with Ash Framework, and I wouldn't trust a single Chat GPT output for either of them."
- **olivermt**, 69829 post 28, 2025-03-16, https://elixirforum.com/t/my-thoughts-on-ash/28 — "An LLM by its
  very nature has unstable output… Ash main feature is to simply remove a whole class of code you don't have
  ownership of any more. An LLM will bring tons more of code under your ownership and it will all be slightly
  different."
- **garrison**, 70980 post 4, 2025-05-22 — the training-data argument against a novel DSL: "they were
  implementing a DSL, they could have chosen any syntax, so they went with Python knowing that the model would
  perform a bit better with it." Post 8: "Why do I need Ash 7 when Ash 6 works fine and my cluster is churning
  out code? It's not like my LLMs have an opinion about the changes!" **zachdaniel**, post 9: "The concept is
  predicated on the idea that all code with the same ultimate effect is of the same level of quality."
  **garrison**, post 10: "It could well end up being that abstractions which are useful to us humans… are less
  helpful to models."
- **llamex**, https://github.com/dmitriid/llamex (created 2026-08-11) — described in its own repository as a
  "Credo Plugin that detects issues that LLM-assisted Elixir refactors commonly introduce", with checks
  including `NoAdHocAshQueries`, `NoDBWorkInMemory` and `NoAuthorizeBypass`. The Ash-specific anti-patterns it
  checks are the same family egeersoz reports. Its author's HN identity is supported but not proven: troupo's
  HN profile links dmitriid.com (checked 2026-10-01), and troupo is cited twice above.
- **troupo**, HN item 41655676, 2024-09-26, https://news.ycombinator.com/item?id=41655676 — under the story
  "Llama 3.2: Revolutionizing edge AI and vision with open, customizable models" (submitted by nmwnmw, HN
  41649763, 2024-09-25), troupo posts a Llama 3.2 conversation in which the model invents Ash history ("Ash
  has been merged into Elixir itself… no longer actively maintained"): "It's hallucinating so badly, it's
  kinda hilarious… Literally everything about the quote below is wrong." **zachdaniel** (HN handle borromakot)
  replies "Wildly incorrect" (HN item 41660895, 2024-09-26).

---

## 7. Production use

### Named organisations on the project's own site
"Trusted in production", https://ash-hq.org/ (fetched 2026-10-01): **Remedy**, **Alembic**, **Daylite**,
**Heretask**, **GroupFlow**, **Zoonect**, **ScribbleVet**, **Plangora**, **Coinbits**, **Wintermeyer
Consulting**, **Boring Business Leads**, **Linguavid**, **Communities**, **Intcube**, **SalesHood**. Vendor-curated;
depth of use unconfirmed. Whether Alembic is "the maintainer's own consultancy" is **[unverified]** — the site
only links Alembic's Premium Support page, and ElixirConf's bio describes Zach Daniel as "VP of Engineering at
Remedy" (https://elixirconf.com/participants/zach-daniel/).

### Testimonials printed in the docs
`what-is-ash.md` — Frank Dugan III, SunnyCor Inc.; Scott Woodall, Principal Software Engineer, **Microsoft**
(`:29-34`); Yousef Janajri, CTO & Co-Founder, **Coinbits** (`:106-109`); Brett Kolodny, full stack engineer,
**MEW** (`:123-125`) — "I can't imagine starting a new Elixir project that doesn't use Ash."

### Independent production reports
- **egeersoz**, 74717 post 2, 2026-03-15 — the postmortem: "Used it for two years, had a support contract with
  the library creator's employer and everything, and the productivity penalty has been so drastic we decided to
  rip it all out and return to Ecto + standard json views. We are a team of ten and the codebase is about 200k
  LoC. Maybe larger teams have a different experience." And (post 7, 2026-03-17): "we're all super excited
  to be going back to normal Elixir with Ecto and good ol' controller and view modules." A paying customer who
  still left.
- **binarypaladin**, 69829 post 32, 2025-11-05 — a year in and positive: "We're a little over a year in on it";
  added incrementally; "My place of business is in a safer place with Ash than it is with some internally grown
  toolset… Yeah, maybe there is a risk of @zachdaniel vanishes one day, but if you're running a bespoke
  framework, you're already at risk for that with fewer safety nets." Also: "it's helped me personally no
  longer be the sort of technical bottleneck on my team."
- **mindok**, 69829 post 10, 2025-03-08 — early adopter, unnamed company, "the engine room… pretty much look
  after itself".
- **mudspot**, 69829 post 22, 2025-03-09 — "The primary customer facing parts of our application stacks are
  all on the Phoenix Framework… further increased by another factor of 2 with the adoption of Ash."
- **clsource**, 69829 post 25, 2025-03-14 — advisory: "Production projects made by many people will surely
  be wild if there is little conventions in place. Ash can ease creating a standard and a common ground for
  projects that will be maintained for years."
- **ScribbleVet**, verified via **hanrelan**, HN item 45095780, 2025-09-01,
  https://news.ycombinator.com/item?id=45095780: "Our tech stack: Postgres, Elixir (+ Ash framework)".

---

## 8. Ash vs plain Phoenix contexts + Ecto — the "do not use Ash" case, fairly

### caslu — chose Ash, then abandoned it (69829, 2025-03-07/08)
Explicitly not an attack. Post 1: "this is **NOT** a hate or random critique about Ash!… the support from Zach
is almost instantaneous, so congratulations, guys." Three headings. **Testing** — "Ash gives me the feeling that
it's useless to test my resources and code in general, and I've noticed it's not very clear how my test designs
should look… coverage is a useless metric to define code safety/quality with Ash, since things only run at
compile time, so your resources will always remain with 0% coverage." **Learning Curve** — "it reminded me of
when I first encountered the `devise` gem in the Rails world… it's kind of boring to open the documentation
every time you want to do a preparation, change, or calculation." **Lock-in** — "You cannot decouple Ash, and it
would be a silly thing to do… if Zach wakes up and is no longer in the mood to maintain Ash or to answer my
doubts, my application would be doomed."

**His hedges, which belong in any fair account.** Post 1: "Again, this isn't hate or empty criticism; it's just
my opinion, and I'm assuming that some of these things may just be a '*skill issue*'." and "I'm still not 100%
sure if the good parts don't compensate for [this]." Post 16, answering **Stefano1990**'s "sounds like a skill
issue": "I agree that saying 'Ash keeps you away from Elixir' was perhaps an overstatement on my part, it
undeniably diverges from the 'Phoenix context workflow.'" Post 13: "i think it'll make myself regret my
decision to give up Ash." He describes his product only as "my SaaS that I'm currently developing" — nothing
indicates it was paid.

### egeersoz — the strongest negative voice (69829 post 18, 2025-03-08; 74717 posts 2 and 7, 2026-03)
Post 18: "Ash has a lot of features that can sometimes speed up development, but it isn't for everyone or every
team—largely because it comes with significant drawbacks that aren't immediately obvious. For context, I've
been programming for over a decade, I've used Elixir for about eight years, and I've been working with Ash on a
daily basis for the past four months." The Vue/React analogy: "I like Vue because it provides a skeleton and
guidance but mostly stays out of the way—you're still basically writing JavaScript. In contrast, React is always
in your face, and straying from 'the React way' can be painful. In that sense, Vue is like Phoenix, and React is
like Ash." And: "once I built a new feature with it, I realized it drastically reduced both my productivity and
my enjoyment of programming. I'm not the only team member who feels this way."

Post 7, asked to elaborate: "Ash makes some annoying and repetitive things easier and can reduce boilerplate.
But it has an extremely steep learning curve, and also makes a lot of very basic things extremely difficult and
confusing. And for the latter, there's usually no way to find the solution without absurd amounts of trial and
error, spending hours poring over the docs and eventually giving up and asking in their Slack/Discord. The last
one eventually becomes the primary means of getting help because it's the path of least resistance by far."
His bottom line: "Ash can be useful, depending on context. I strongly believe however that it should not be the
default choice for any team, especially those just starting out."

He is also scrupulous about fairness: "I'm sure some Ash users/maintainers will respond by saying some or all of
this is incorrect… Ultimately it's probably good that the framework exists, as it represents probably the most
significant and ambitious undertaking in the ecosystem and some people seem to like using it."

**zachdaniel**, 69829 post 19, replying: "If you've ever felt truly limited by Ash please bring those things up
to us." **sevenseacat**, post 20: "Yes there's room for improvement in the docs, but different people learn in
different ways and perfect should never be the enemy of good. It's a work in progress."

### Other negative voices
- **acrolink**, 69802 post 1, 2025-03-06, https://elixirforum.com/t/reasons-not-to-use-ash-split-thread/1 —
  "I will never Ash. I like to do things my way." Post 3: "I prefer to avoid adding another layers of tools over
  existing working ones."
- **napsterbr**, HN item 45159742, 2025-09-07, https://news.ycombinator.com/item?id=45159742 — "Seems great
  on paper, but quickly turns into a nightmare. Magic is great to get you up to speed, but as soon as you find
  yourself having to bend the magic, good luck."
- **Dmk**, 74717 post 6, 2026-03-16 — "I don't love big frameworks… Currently very happy with pace of
  development with plain Elixir/Phoenix applications & LLMs."
- **Stefano1990**, 69829 posts 15 and 17, 2025-03-08 — the fairest framing of the bus-factor risk, because it
  applies to any dependency: "At work we use DRF (Django rest framework)… Two years ago the maintainers
  decided that it's perfect and disabled issues and discussions on GitHub due to 'social DDOSing'… So any time
  you choose to depend on any type of software you run this risk."

### The strongest pro replies
- **sodapopcan**, 69829 post 11, 2025-03-08 — "Ash's escape hatches aren't even codified, they're simply:
  just write the function for yourself."
- **ken-kost**, 69829 post 4, 2025-03-07 — "Don't let the declarations fool you, it's functions all the way
  down."
- **Stefano1990**, 69829 post 17, 2025-03-08 — "Of course I can implement this all by myself in my vanilla
  contexts but I will, inevitably, re-invent the wheel and simply try to do what Ash does better anyway."
- **binarypaladin**, 69829 post 32, 2025-11-05 — the direct answer to the bus-factor argument: "if you're
  running a bespoke framework, you're already at risk for that with fewer safety nets."
- **zachdaniel**, 69802 post 4 — "the pros ultimately outweigh the cons when you can use a truly integrated
  stack".
- **mike1o1**, 69829 post 8, 2025-03-07 — when *not* to use Ash: "if you're starting out building a simple Task
  management system, using Ash might seem like total overkill."

### Forms, and the honest verdict on a small app
**Matt**, 2025-07-11 — "This was the only real headache I had in the whole process… I had a hell of a time
getting this working… over the course of a few days and 20+ messages, and we found a working (but hacky)
solution. When I wrote up a guide with the solution, Rebecca Le (the author of the above mentioned Prag Prog
book) pointed out how I was making this more complicated than it needed to be." And: "For an app this simple, Ash
might not provide any game-changing benefits, but it was a great learning experience."

---

## Implications for Mesh (researcher's analysis)

Everything below is my inference. The facts are above.

1. **The learning-curve risk is concentrated in one place: overlapping concepts.** No maintainer names this
   mechanism in the cited sources; it comes from egeersoz (74717 post 7: "policies, filter checks, preparations,
   and expression calculations… four different abstraction paths"), echoed by dimitarvp (74717 post 9, on
   module calculations) — one user's detailed claim, echoed by one other. A
   framework deriving fewer *kinds* of thing does not have this problem. For Mesh: a very small concept set
   (resource, action, input), with the compiler rejecting an ambiguous one at build time.
2. **Ship conservative defaults from day one; the maintainers paid for the alternative.** Every 3.0 change with a
   stated reason moves from implicit-permissive to explicit-conservative: `reject` → `accept`, `default_accept`
   → `[]`, `require_atomic?` → `true`, and — the one I had backwards in round 1 — attributes from
   public-by-default to **private-by-default** ("It was too easy to add an attribute and not realize that you
   had exposed it over your api"). Corrected, the picture is stronger: there is no exception.
3. **The compiled artefact should be committed, ordinary, and behaviour-bearing.** Two independent Ash problems —
   coverage reading 0% (caslu) and "missing/broken stack traces" (egeersoz) — share one root: the behaviour
   lives in a runtime library, not in your code. If Mesh emits committed TypeScript *containing the logic*,
   tests and coverage see it. If it emits thin wrappers over a shared runtime, Mesh reproduces both problems
   exactly. This is a design decision with a measurable consequence, not a cosmetic one.
4. **The LLM evidence does not support the premise as stated, and the reason is specific.** The only controlled
   study available (arXiv 2602.11198) finds declarativeness alone does not help and convention alignment does;
   the maintainer's own strongest claim is about shipped `usage-rules.md`; and the sharpest 2026 report
   describes frontier models producing Ash-specific anti-patterns they do not produce in Ecto, with the stated
   mechanism "Ecto is so similar to SQL". Read carefully: **Ecto wins because it is convention-aligned with
   training data; the study's authors attribute the failure to "declarative novelty" — abstractions
   under-represented in training data — not to declarativeness, and their top scorer, Agno, is itself
   declarative but convention-aligned.** Ash's own docs concede the training-data
   problem. A brand-new `.mx` syntax adds no training data, so Mesh starts strictly further off-distribution
   than Ash. The mitigation the study actually identifies is convention alignment — for Mesh, that means
   emitting TypeScript that looks like the TypeScript in the training set, and emitting a `usage-rules.md` from
   the compiler on every build. That is a different bet from "a declarative resource model helps agents write
   correct code". The evidence here is one controlled study (ten Python agent frameworks, one task,
   Claude-backed assistants) plus anecdotes on both sides: it *suggests* convention alignment matters more
   than declarativeness. It does not establish this for Ash or for TypeScript.
5. **Do not build Ash's breadth.** Two users independently say the value appears only at scale — mike1o1's
   "total overkill" and Matt's "might not provide any game-changing benefits" — and egeersoz's team, at 200k
   LoC, still concluded it "should not be the default choice for any team". The lesson is about *surface area*,
   not scaling: aim at the 80% Ash serves, at a fraction of its conceptual surface.
6. **Bus factor: 79% of human commits, and a paying customer still left.** Better than round 1's 96%, which was
   computed over the top 8 contributors only; over all contributors, zachdaniel has 5,315 of 6,719 human
   contributions = 79.1% (GitHub contributors API, paginated, 2026-10-01). But the
   fairest framing is binarypaladin's — a bespoke framework carries the same risk with fewer safety nets. So the
   mitigation is not "grow the community", it is **substitutability**. Ash's floor: "every resource is also an
   Ecto schema". Mesh's floor should be: "delete the `.mx` directory and keep the TypeScript" — stated on the
   front page. **Inference:** no source says any single change would have reversed caslu's decision; he gave
   three reasons (testing, learning curve, lock-in).
7. **Copy the staged-migration pattern.** `config :ash, :require_atomic_by_default?, false` (removed in 3.1) and
   the "do this before you upgrade" instruction for `Ash.set_*` are both good practice. Behaviour flips should
   ship with a compat flag and a named removal version.
8. **Avoid implicit ambient context.** `Ash.set_*` was removed because storing actor/tenant/context in the
   process dictionary had "fundamental issues with this pattern that manifested in subtle bugs". Pass context
   explicitly, always.

---

## Open questions

1. **ElixirForum's own search endpoint is unusable** (403/406/302 on `elixirforum.com`), so I surveyed six named
   threads via the Discourse JSON at `forum.elixirforum.com/t/<id>.json` rather than the whole forum. There is
   almost certainly more criticism in threads I did not reach.
2. **No whole-project comparison of Ash against plain Phoenix + Ecto compile time.** I have per-resource and
   per-`code_interface` numbers (11,260 vs 2,270 ms; 4,148 vs 533 ms) and the 187-compilation-cycles figure, but
   no end-to-end comparison. **Not found.**
3. **No Ash-vs-Ecto runtime query benchmark.** The only runtime numbers are ash#2921's telemetry measurements,
   from one team, produced with AI assistance. **Not found** otherwise.
4. **The "Trusted in production" list is vendor-curated logos only.** No independent confirmation for any of the
   fifteen companies, and no independent postmortem of a company that left (egeersoz is the closest, under a
   pseudonym).
5. **S5, S9, S10 and W9 are single-source; the editor-support half of W10 has one source** (a Spark doc
   line, not a user complaint). All are marked rather than padded. I could not find a user
   reporting editor problems with Ash.
6. **The "Elixir tops AutoCodeBench at 97.5%" claim** circulating in secondary blogs — I did not reach a primary
   source. **[unverified]**, and deliberately not used as evidence above.
7. **egeersoz's macro counts (Phoenix 19, Ash 62)** are his own and explicitly labelled unscientific; I did not
   count them. The complaint is sourced; the number is his.
8. **No Thinking Elixir or Elixir Wizards episode on Ash** was located, and no talk transcript was retrieved;
   the ElixirConf talk is referenced in sources but not quoted. **Not found.**

---

## Sources

### Local paths (under `/Users/svallory/work/mesh/`)
- `scratch/ash-src/ash/mix.exs:13` (v3.33.11); `documentation/topics/about_ash/what-is-ash.md` (9, 29-34, 90,
  104, 106-109, 110, 112, 123-125); `documentation/topics/about_ash/design-principles.md` (:19 and the tenets);
  `documentation/topics/about_ash/alternatives.md`; `documentation/topics/development/upgrading-to-3.0.md`
  (23-25, 29, 33, 47, 49, 59, 84, 94, 182, 197, 220, 284, 385, 424, 592-601, 617);
  `documentation/topics/development/working-with-llms.md` (9, 13-15, 30)
- `scratch/ash-src/spark/documentation/how_to/setup-autocomplete.md:11`
- `scratch/ash-src/usage_rules/mix.exs:8` (v1.2.8), `README.md`
- `scratch/ash-src/ash_ai/mix.exs:12` (v1.1.1), `README.md:72`

### Forum (read 2026-10-01 via `forum.elixirforum.com/t/<id>.json`)
- **69829** "My thoughts on Ash" — 34 posts, 2025-03-07 to 2026-08-20, all read. Quoted posts: 1 (caslu), 2
  (zachdaniel), 3 (sevenseacat), 4 (ken-kost), 5 (caslu), 8 (mike1o1), 9 (caslu), 10 (mindok), 11 (sodapopcan),
  13 (caslu), 17 (Stefano1990), 18 (egeersoz), 19 (zachdaniel), 20 (sevenseacat), 21 (zachdaniel), 22 (mudspot),
  23 (dewetblomerus), 24 (redrapids), 25 (clsource), 27 (ghannam80), 28 (olivermt), 29 (sodapopcan), 31
  (ken-kost), 32 (binarypaladin)
- **70080** "What is the benefit of using the Ash Framework?", 2025-03-22 — posts 4 (mike1o1), 5 (julienmarie)
- **70980** "Ash Framework: Official LLM development tooling and guidance", 2025-05-22 — posts 2, 3, 4, 5, 8, 9,
  10, 12, 13, 14, 15 (per-post dates from the page capture; the Discourse JSON was rate-limited at check time)
- **74717** "Ash with AI (split thread)", 2026-03-09 to 2026-03-21 — posts 1, 2, 3, 5, 6, 7, 10, 11
- **69802** "Reasons not to use Ash (split thread)", 2025-03-06 — posts 1, 2, 3, 4
- **73196** "Using code_interface makes resource slow to compile", 2025-11-05 — posts 1, 2, 3, 6
- **72265** "Strategies to make resources compile faster", 2025-08-28 — posts 1, 4

### Hacker News (hn.algolia.com items API, read 2026-10-01)
27591079 (zachdaniel, 2021-06-23) · 37380622 (troupo, 2023-09-04) · 37629719 (2023-09-24) · 37630792
(kkarpkkarp, 2023-09-24) · 37630837 (bradrn, 2023-09-24) · 37632243 (troupo, 2023-09-24) · 37637169 (avarun,
2023-09-24) · 37801485 (skybrian, 2023-10-07) · 37801585 (zachdaniel, 2023-10-07) · 37800063 (spiderice,
2023-10-07) · 37811686 (DylanSp, 2023-10-08) · 37824132 (zachdaniel, 2023-10-09) · 41649763 (story, nmwnmw,
2024-09-25) · 41655676 (troupo, 2024-09-26) · 41660895 (borromakot, 2024-09-26) · 41896590 (dartos,
2024-10-20) · 45095780 (hanrelan, 2025-09-01) · 45159742 (napsterbr, 2025-09-07) · 45431182 (stray,
2025-09-30)

### GitHub (`ash-project/ash`, read 2026-10-01)
Issues **#1792** (open, sevenseacat, 2025-02-14) · **#2267** (open, chazwatkins, 2025-08-09) · **#2274**
(olivermt, 2025-08-15) · **#2331** (open, 2025-09-19) · **#2392** (jimsynz, 2025-10-16) · **#2397** (sezaru,
2025-10-17) · **#2670** (joshprice, 2026-04-09) · **#2798** (2026-07-23) ·
**#2921** (lardcanoe, 2026-09-09) · PR **#2241** (2025-07-31). Contributors API, pages 1-3: 300 contributors,
6,719 human commits.

### Web
- Ahmed & Deshpande, arXiv 2602.11198, 2026-02-03 — https://arxiv.org/abs/2602.11198
- Zach Daniel, "Usage Rules: Leveling the Playing Field…", 2025-07-18 — https://www.zachdaniel.dev/p/usage-rules-leveling-the-playing
- Zach Daniel, "LLMs & Elixir: Windfall or Deathblow?", 2025-06-01 — https://www.zachdaniel.dev/p/llms-and-elixir-windfall-or-deathblow
- Alembic, "Ash AI: A Comprehensive LLM Toolbox for Ash Framework", 2025-05-15 — https://alembic.com.au/blog/ash-ai-comprehensive-llm-toolbox-for-ash-framework
- Matt, "Migrating my Existing Elixir App to Ash Framework", 2025-07-11 — https://blog.1-800-rad-dude.com/posts/2025/07-11-Migrating-my-Existing-Elixir-App-to-Ash-Framework.html
- https://ash-hq.org/ · https://elixirconf.com/participants/zach-daniel/ · https://pragprog.com/titles/ldash/ash-framework/
- https://github.com/dmitriid/llamex · https://github.com/sezaru/test_slow_code_interface

---

## Revision log

### Round 2

What the round-2 rewrite actually changed (verified against the document, 2026-10-01). Sources were re-fetched
before writing.

**Attribution and sourcing**
1. "AI slop astronomical" is from Zach's blog, not Ash's docs; the "hallucination magnet" claim was removed.
   `working-with-llms.md:13-15` is quoted as a support-etiquette rule, stated as such.
2. troupo's 2025-10-01 Codex-vs-Claude comment was dropped as evidence about Ash.
3. The HN 41649763 "résumé" claim was replaced with what the thread is: a Llama 3.2 hallucination about Ash
   plus the maintainer's "Wildly incorrect" (re-attributed again in round 3, see B1).
4. spiderice's "alternative to Ecto" re-attributed from zachdaniel (S9); the maintainer's own position cites
   `what-is-ash.md:104`, labelled a vendor page.
5. The invented "skybrian (Brian Harry, Microsoft)" identity deleted.
6. The sph/DylanSp composite split into DylanSp (HN 37811686, 2023-10-08) and zachdaniel's reply (HN 37824132,
   2023-10-09).
7. sodapopcan and caslu moved from thread 70080 to 69829 post 11 and post 1.
8. All 69829 quotes re-dated from the Discourse JSON (2025-03-07 onward) with corrected post numbers; all 34
   posts read.
9. Woodall's testimonial no longer called "maintainer-written"; S2 gained mudspot as a user source.
10. ash-hq.org quote corrected; Alembic-as-consultancy marked `[unverified]`; ScribbleVet verified via
    hanrelan, HN 45095780.
11. `usage_rules` v1.2.8 and `ash_ai` v1.1.1 versions stated.

**Corrected facts**
12. The `private?: true` → `public?: true` inversion corrected with `upgrading-to-3.0.md:424` verbatim; the
    analysis lesson rewritten (every 3.0 default flip is conservative).
13. Bus factor recomputed over all 300 contributors: 5,315 of 6,719 human commits = 79.1% (was 96%).
14. The two invented migration "stated reasons" replaced with the guide's verbatim text (`:220`, `:385`); rows
    without a stated reason are marked as such; the `Ash.Flow` split added (`:23-25`).
15. Matt's blog removed as 2→3 evidence (it is plain-Ecto-to-Ash); W6 re-sourced onto #2397, #2670 and
    binarypaladin.
16. "A dozen-plus issues" corrected to the cited three; #2798 noted as closed as fixed in Elixir `main`.
17. The unsourced rename/macro design lesson deleted.
18. Local `upgrading-to-3.0.md` line anchors re-verified against the v3.33.11 clone.

**Rewritten sections**
19. §6 rewritten as facts (6a-6d) plus two lists (6e for, 6f against): arXiv 2602.11198, egeersoz's 2026
    reports, llamex, the Alembic guardrails claim, zachdaniel's "I concur", his "practically useless →
    production-ready" claim, and his admission that no Elixir benchmark exists.
20. W8 and W9 gained measured numbers: 11,260 vs 2,270 ms and the 4,148/533 and 3,719/368 ms repro, ">30
    seconds" per resource, 187 compilation cycles (#2267), the #2921 telemetry figures.
21. §7 gained egeersoz's postmortem (team of ten, 200k LoC, two years, support contract, removed Ash),
    binarypaladin, mudspot and clsource.
22. §8 gained egeersoz in full and caslu's hedges and walk-back (posts 1, 13, 16); the claims that the critics
    "said the code was fine" and that caslu's product was paid were removed.
23. §3 rebuilt around user-filed asks with maintainer to-dos separated; #1792's data-leak content restored.
24. §5 gained zachdaniel 69802 post 4, 69829 post 21, and his 73196 self-criticism.

**Classifications and the two-source rule**
25. W2 and W4 cause tags labelled inference, with contrary evidence (`design-principles.md:19`) stated; the
    invented "caslu's fixes were configuration changes" deleted; sevenseacat no longer described as conceding
    and is referred to as "she".
26. S2, S4, S6, S8, W3 and W10 (hiring half) given genuine second sources; S7 re-sourced onto generators and
    installers. S5, S9 and S10 did not reach two independent sources and are **marked single-source** (S5 and
    S9 re-confirmed single-source in round 3). W9 stayed single-source and was **not** given a second source;
    it is marked in round 3. W10's editor half is single-source and labelled.
27. Analysis point 3 corrected (committed TypeScript only fixes coverage if the generated code contains the
    logic).
28. Mesh reasoning removed from the facts sections; it appears only in the final analysis.
29. Length still above the 6,000-word target; flagged to the lead rather than cut further.

### Round 3

Each round-2 re-verification finding (B1-B18) and what changed. Every touched source was re-fetched and read on
2026-10-01 before writing (HN via the Algolia items API, forum threads via `forum.elixirforum.com/t/<id>.json`,
GitHub via `gh`, the arXiv abstract and HTML, Zach's blog, the local docs).

- **B1.** The Llama 3.2 hallucination was attributed to nmwnmw, who only submitted the story. Re-attributed to
  **troupo**, HN item 41655676, 2024-09-26, with his own words; "Wildly incorrect" pinned to borromakot
  (zachdaniel's HN handle), HN item 41660895, 2024-09-26. The llamex bullet now notes that troupo's HN profile
  links dmitriid.com (checked), which supports but does not prove the identity.
- **B2.** Two HN links pointed at unrelated comments (37799963, 37799680). zachdaniel's four-point answer is
  **37801585** and skybrian's critique is **37801485** (both 2023-10-07); fixed in S3, W4 and Sources.
- **B3.** The concept-overload quote ("Having to constantly remember the differences between calculations,
  aggregations, preparations, policies…") was mis-cited to 69829 post 18. Split: it is **74717 post 7,
  2026-03-17**; the "deviate from 'the Ash way'" quote stays at 69829 post 18.
- **B4.** "re-invent the wheel" was attributed to ken-kost. Re-attributed to **Stefano1990**, 69829 post 17,
  2025-03-08, quoted in full.
- **B5.** The telemetry sentence in quotation marks was the reviewer's paraphrase. Replaced with lardcanoe's
  own words from his 2026-09-09 comment on #2921: "Across our entire dependency tree,
  :telemetry.list_handlers is called in exactly one place: ash/lib/ash/tracer/tracer.ex:103".
- **B6.** ken-kost's supportive comment ("IMO Ash amplifies this even further. Especially since the dawn of
  usage rules.") was filed under "evidence against". Moved to 6e "for", with the thread-title context
  ("Elixir is the productivity language of the Agentic era").
- **B7.** arXiv 2602.11198 is now described exactly: three assistants (GitHub Copilot, Claude Code, Cursor,
  each configured with Claude models via Anthropic's API, agent mode) re-implementing one fixed agent
  (DDL2PropBank, Agent-as-a-Tool) in ten Python frameworks; scores combine an LLM-as-judge structural-alignment
  score with pass@1. The "Agno's API is itself declarative… declarative novelty" sentence and the
  "deliberately controlled scope" sentence are quoted, plus one sentence on what the study is and is not
  evidence about. Summary 8 and analysis point 4 reworded to match.
- **B8.** W9 marked *single source*; the round-2 log item claiming it was "given a genuine second source" is
  corrected (item 26 above).
- **B9.** S9's body contradicted its "single source" label. The unquoted Matt line and the contradictory
  sentence removed; label and body now agree.
- **B10.** S5 marked *single source (vendor)*, with the reason stated: neither user quote is about named domain
  actions.
- **B11.** Cause tags with no evidence relabelled: W6 is "[EM]/implementation (inference)" (point-release
  regressions, not the declarative model); W9 is "[EM] (inference)" (the per-span `list_handlers` scan in
  `Ash.Tracer`).
- **B12.** "All three were acted on in 3.0" deleted — the asks are from 2025-2026, after 3.0 shipped. Replaced
  with a statement that makes no causation claim.
- **B13.** binarypaladin's "fixed sometimes in under an hour" row deleted from the wishes table; it is praise,
  not a wish.
- **B14.** "over the past few months" corrected to the post's own words: "Over the last few months I've
  observed:".
- **B15.** Quotation marks removed from two strings that appear in no source: Summary 1 now quotes sodapopcan's
  exact chain, and the W4 heading now quotes skybrian's exact words ("There is often no reasoning about config
  files").
- **B16.** "we're all super excited to be going back to normal Elixir…" now attributed to **74717 post 7,
  2026-03-17**.
- **B17.** Small misquotes fixed: "dump the entire source code to Gemini Pro" (was "into"); "it's helped me"
  (was "it has helped me").
- **B18.** The "no quote was repaired from memory" claim kept after fixing B1-B5 and B14-B17, and qualified
  with the 70980 per-post-date caveat (page capture, not per-post JSON).

**Restored content dropped by the round-2 rewrite** (each re-fetched and quoted):
- 6e "for": **dartos** (HN 41896590, 2024-10-20) and **stray** (HN 45431182, 2025-09-30).
- 6f "against": **troupo** (HN 37380622, 2023-09-04, "wouldn't trust a single Chat GPT output").
- S3: **troupo**'s escape-hatch post (HN 37632243, 2023-09-24), including his report of Zach's ElixirConf DX
  goal (labelled as troupo's summary, not a transcript).
- §5: the slogan "Model your domain, derive the rest" (`what-is-ash.md:112`; the ash-hq.org headline; caslu,
  69829 post 1).
- W5: the three 2023 HN reports from readers who could not tell Ash was for Elixir (kkarpkkarp 37630792,
  bradrn 37630837, avarun 37637169, all 2023-09-24).
- W2: GitHub evidence restored — #2274 (olivermt, 2025-08-15, obtuse stack trace from a policy syntax error)
  and #2392 (jimsynz, 2025-10-16, cryptic compile error).

**Left open after round 3.** Length is still above the 6,000-word target (flagged to the lead in round 2; the
round-3 additions are restored evidence, not new scope). The llamex authorship is supported but not proven. The
"Elixir tops AutoCodeBench" claim remains `[unverified]` and unused. Per-post dates inside thread 70980 come
from the page capture (all 2025-05-22), not the per-post JSON.

### Round 4

Final check: **ACCEPT**, all 183 source quotes confirmed. Applied the residual corrections; no other change, and
nothing was shortened.

1. Analysis 6 said the corrected bus factor was "Worse than round 1's 96%". Backwards — 79.1% is a *lower*
   concentration, so it is better than round 1 claimed. Reworded, with the 5,315 / 6,719 figure and the API
   citation.
2. W6's cause tag "[EM]/implementation" used a category outside this document's legend and implied macro
   causation the sources do not support. Now "cause category not established (inference) — implementation
   churn".
3. §3's pattern sentence claimed the asks cluster on "safety defaults". No ask in the table does. Replaced with
   the actual cluster (internals documentation, error messages, clearer semantics) and a statement that no ask
   concerns safety defaults.
4. Analysis 1 claimed "two maintainers and three users independently name the same mechanism". No maintainer
   names it; it is egeersoz (74717 post 7), echoed by dimitarvp (74717 post 9). Reworded as one user's detailed
   claim echoed by one other.
5. W1's classification said "five distinct concepts all reduce queries"; egeersoz names four query-shaping
   paths. Corrected to four, with his own concept list quoted, and the researcher phrase "which page do I read"
   no longer put in quotation marks.
6. Analysis 6 said the "delete the `.mx` directory" floor "is the one thing that would have changed caslu's
   decision". No source says that; he gave three reasons. Now labelled **inference**, with the three reasons.
7. Summary 9's "frontier models actively fight Ash" was a gloss on egeersoz's "struggle with Ash… always
   overcomplicate things". Reworded to what he says.
8. 6b silently corrected a typo in Zach's blog. The source reads "thse"; the quote now reproduces it with
   `[sic: "thse" in the source]`. Verified against the post on 2026-10-01.
9. 6e's reading of ken-kost's "this" (the split-thread title, visible only inside egeersoz's cross-quote, the
   parent post not retrieved) is now labelled **inference** and softened to "most likely".
10. Analysis 4 said "the evidence supports the former, not the latter". Overstated. Reworded: the evidence is
    one controlled study (ten Python agent frameworks, one task, Claude-backed assistants) plus anecdotes on
    both sides; it *suggests* convention alignment matters more than declarativeness, and does not establish
    this for Ash or for TypeScript.

Length (11,991 words against the 6,000 target) remains a decision for the lead, unchanged by this round.

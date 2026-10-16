---
title: "Open questions and findings"
description: "Everything the user docs deliberately do not say: unsettled decisions, DX findings, and what the docs had to invent."
---

# Open questions and findings

::: callout info "Vocabulary note"
The pages under [Docs](../docs/index.md) are written in the terms the operator ruled on 2026-10-04 and 2026-10-05: an **entity** (not a resource), each folder inside `src/domain/` is a **module**, generated code lives in **`.mesh/`** (not `generated/`), an action's second argument is the **action context** (not a scope), and entity files are written in [entity file syntax v4](#syntax-v4), following the additional rulings of 2026-10-08.

The rest of this section was brought to the same vocabulary in [PR #24](https://github.com/svallory/mesh/pull/24), and the framework packages are `@meshfw/*` (`@meshfw/runtime`, `@meshfw/data-sqlite`, `@meshfw/data-postgres`). The [amendments to ADR-0060](./decisions/0060-meshfw-package-scope.md) name the CLI package `meshfw` and the starter `create-meshfw`, invoked with `bun create meshfw <dir>`; authorization is core, so there is no policies package. The product is Mesh, the command is `mesh`, the import specifiers are `#mesh` and, per module, `#mesh/domain/<module>`, and the configuration file is `mesh.config.ts`.

**The code and the Docs now share one vocabulary.** PR #47 and PR #48 (merged 2026-10-09) moved `packages/`, `examples/blog` and the compiler's fixtures to `entity`, `src/domain`, `.mesh/` and the action context. What differs from the Docs is what is not built yet; the [roadmap](./roadmap/roadmap.md) says which milestones are done. Where a Docs page and a source file disagree, the Docs page states the target.
:::

The pages under Docs describe what Mesh will be: no open questions, no milestones, no hedges. Everything below is what those pages had to leave out, and where each item has to be settled. A page under Docs that has to say "this is not decided" has found a gap, which is the point of writing it first.

## DX findings

The findings below came from writing the Docs pages against the design. Each names what a user would have had to work out alone, and the record it touches. **Settled** marks those the operator has since ruled on; the rest are open.

| # | Finding | Status |
|:--|:--|:--|
| 1 | How a generated handler gets its database connection. `Todo.create(input, context)` leaves only module state. Settled by `bind(dataLayer)` and `connect()` ([ADR-0047](decisions/0047-actions-are-bound-to-a-data-layer.md)). | settled |
| 2 | Tests on SQLite `:memory:` need the schema inside the test's own process, while the schema tools are commands in another process. Settled by the adapter's own schema function ([ADR-0048](decisions/0048-schema-inside-the-process-for-tests.md)). | settled |
| 3 | `validate` had no `input` parameter, so on an update it saw only the stored value and could not reject a new empty one. The Docs pages state the lead's amendment to [ADR-0017](decisions/0017-atomic-by-default-and-classification.md): `validate` receives the record as it will be after the changes, plus the caller's `input`. Needs the operator's ratification. | open |
| 4 | A create policy that reads a related record had no place in the lifecycle. The Docs pages state the lead's amendment to [ADR-0022](decisions/0022-policies-simple-tier-as-extension.md). Needs the operator's ratification. | open |
| 5 | Generated code imports `zod`, `drizzle-orm` and `@opentelemetry/api`, so a user's project must depend on them at versions Mesh pins. Settled by [ADR-0062](decisions/0062-direct-dependencies-zod-drizzle-opentelemetry.md): a project depends directly on Zod 4 and `drizzle-orm`, as ordinary dependencies rather than hidden behind `@meshfw/runtime`; `@opentelemetry/api` comes with tracing, after Mesh 1.0. | settled |
| 6 | "Policies on by default" cannot be a core default, because core must not know an extension. The Docs pages read it as "the starter enables `policies()`" and rely on deny-by-default once it is on ([ADR-0036](decisions/0036-deny-by-default-arrives-with-policies.md), mapping exception X2). | open |
| 7 | Adapter commands wrap drizzle-kit, which is a development dependency, so a user who skips it meets a confusing failure at `mesh db push`. | open |
| 8 | `<action><Entity>` names read badly: `pendingTodo` for a read named `pending`, and `readTodo` returning an array. Settled by [ADR-0086](decisions/0086-entity-values-privileged-barrels-and-fqns.md): an action is called on its entity value, `Todo.pending(...)`, and no composed name exists. | settled |
| 9 | Nothing says how a `.mx` file calls hand-written code. `structural: "reject"` means there is no import tag, so the Docs pages say a `change` or a `validate` calls a helper by name. Touches [the contract between Mesh and MX](in-depth/mx-integration.md). | open |
| 10 | No `mesh` watch mode, so every edit needs a manual `mesh build`. MX's own tools do check `.mesh.mx` files as you type (the language server and the TypeScript plugin; `mx-tsc` is not released) and report Mesh's `MESH_*` codes, as [the MX contract](in-depth/mx-integration.md#37-mxs-tools-for-meshmx-files) says; only the build step is manual. | open |
| 11 | Connection details were written twice: in `mesh.config.ts` for the build and the commands, and again at run time. Settled: `connect()` takes no arguments and reads `mesh.config.ts` at run time; `defineConfig` and `MeshConfig` come from `@meshfw/runtime`, and the config key for entity files is `domain: "src/domain"`. | settled |
| 12 | Whether committed migrations are covered by `mesh build --check` is not stated, so a hand-edited migration and a stale `.mesh/schema.ts` can drift. The Docs pages do not claim the guard covers `migrations/`. See [generated code and the guard](in-depth/generated-code-and-guard.md). | open |
| 13 | Column naming from field names. Settled: a column is named exactly like its attribute, with no transform ([data layer](in-depth/data-layer.md#the-build-half-a-generator-and-a-command)). | settled |
| 14 | Grouping several action calls in one transaction. Settled by [ADR-0068](decisions/0068-actions-compose-through-actions-and-tx.md): entity calls and `Mesh.privileged` in a step, and `transaction` from `#mesh` for the application, as [ADR-0086](decisions/0086-entity-values-privileged-barrels-and-fqns.md) amends it. | settled |
| 15 | The repository instructions said v1 was M0–M8 plus M10 while the roadmap renumbered it to M0–M9. The Docs pages carry no milestone numbers, so nothing user-facing depends on it. | settled |
| 16 | No `require-atomic=false` example survives in the Docs, because the attribute belongs to a milestone the pages may not name. The reference page states the rule in prose instead. | open |
| 17 | `sort` on a read has no settled form: Mesh keeps a `sort` child tag, Ash has no such entity and sorts through `prepare build(sort: …)`. The Docs pages now use a `sort` section with `asc &field` / `desc &field` lines ([ADR-0066](./decisions/0066-names-and-references-are-atoms.md), the lead's fourth choice); how it maps to Ash's `prepare build(sort: …)` is still open. Mapping rows D17 and G1. | open |
| 18 | `load` has three jobs and one spelling: a calculation, a relationship and an aggregate. The Docs pages state which of the three runs in SQL. | open |
| 19 | The density of "not decided yet" callouts in the old example page was itself a finding: eight in one page is the cost of writing the smallest complete example from the current design. | settled by the rewrite |
| 20 | `bun create meshfw todo-app` assumes the package `create-meshfw`. The CLI is the unscoped package `meshfw` with the binary `mesh`, and the starter is `create-meshfw`, falling back to `@meshfw/create-app`. Neither is on npm yet, by the operator's choice. MX publishes nothing to npm until its next major version and its framework targets exist, so a Mesh published on npm would need its users to add the `@mxlang` scope to their own `bunfig.toml`; the operator hears this before any npm publish of Mesh ([ADR-0060](decisions/0060-meshfw-package-scope.md)). | settled; publishing waits |
| 21 | Generated code needs a rule for colliding identifiers. Settled by [ADR-0086](decisions/0086-entity-values-privileged-barrels-and-fqns.md): an action is called on its entity value (`Todo.complete(...)`), no generated name is unique across the project, each folder has a barrel, and Mesh imposes no rule on names beyond `__proto__` as a member name. Two exports of one barrel with the same name (an entity and a subfolder namespace, two sibling folders that normalise alike, a duplicate generated type) are `MESH_EMIT_NAME`, naming both: an entity by its FQN, a folder by its path. No name is reserved, because `#mesh` and the domain barrels are separate modules, and generated locals never use a bare entity name ([generated code and the guard](in-depth/generated-code-and-guard.md#binding-and-barrels)). | settled |
| 22 | `public` is declared and recorded but never read, because v1 has no transport that leaves the process. The Docs pages say nothing about it. [ADR-0035](decisions/0035-meaning-of-public.md). | open |
| 23 | Sharing one policy across action types required duplication: Ash's `action_type(["read", "destroy"])` is an array inside the call, and Mesh's contract rejects an array there while accepting an outer list of checks, which means *and*. The Docs pages use `action_type(["read", "destroy"])` for *or* and state the difference between the two lists. The compiler must accept the array argument as Ash does. [ADR-0034](decisions/0034-vocabulary-copies-ash-dsl.md), mapping rows 90–91. | settled in the docs; open in the contract |

## New open points

- **Imports and the parser.** Entity and helper imports are part of the entity syntax. The compiler pins `@mxlang/core` by exact version and reads each file through `lowerSource` with Mesh's dialect, which parses each import into `from` and `names`. There is no parser bridge: the docs samples parse as authored.
- **No page on writing an extension.** Three pages describe what an extension may contribute and none shows how to write one. It is its own piece of work.

- **The action context's type.** The operator ruled on 2026-10-04 that the second argument is one flat `ActionContext` the user declares by declaration merging. Two records still describe the older shape and have to be amended in the rename task: [ADR-0007](decisions/0007-scope-is-a-plain-argument.md) and [ADR-0047](decisions/0047-actions-are-bound-to-a-data-layer.md) both say "scope" and describe `{ actor, context }`.
- **Generator templates.** Settled ([ADR-0061](decisions/0061-generators-are-jig-templates.md)): generators are [Jig](https://jig.saulo.engineer/docs/introduction) templates; `mesh export generators` copies them into the project, where a template overrides Mesh's own one by one. TypeScript computes a typed view of the model, and the template only renders it. The user page [Customising generated code](../docs/customising-generated-code.md) still proposes a named mixin hook in each template as a smaller escape hatch than a copy; that part is not decided.
- **Whether a nearer `concepts/` folder may shadow a shared concept.** Nothing is global in an entity file: a file sees only its own declarations and what it imports, and concepts are the one exception, shared across the project. Not decided: whether a `concepts/` folder nearer to a file may shadow a shared concept of the same name, as the nearest-wins walk of tag discovery ([ADR-0085](decisions/0085-tag-discovery-for-dialect-tags.md)) would allow.
- **What "what exists today" covers.** The contributor page holds it, but nothing states when it is rewritten as each milestone lands.
- **The highlighter for code other than `mx`.** The site highlights non-`mx` code with docmd's built-in highlight.js; the ruling named Shiki. Not decided: move to Shiki or keep highlight.js.

## Decided by the lead, awaiting the operator

The lead has decided the points below, and the pages state them; each still needs the operator's ruling. Where a page is named, it carries the rule.

**Data layer** ([data layer](in-depth/data-layer.md)):

- The SQLite schema module exports only `tables`, with no per-entity `<camelName>Table` constants and no duplicate-export error, since only `tables` is read (by `createSchema` and `mesh db push`) and no table references another.
- When `BEGIN IMMEDIATE` meets another connection's write lock, `@meshfw/data-sqlite` awaits a short sleep and tries again, for up to 5 seconds in all, and SQLite's own `busy_timeout` stays at 0, because `bun:sqlite` is synchronous and a `busy_timeout` wait would freeze the process. A transaction still blocked fails with `MESH_DATABASE_BUSY`, naming the file and the wait, never with a raw `SQLITE_BUSY`. Schema preparation (`createSchema`, `mesh db push`) does not wait. Five seconds stays below the 15-second lapse of an event deliverer's claim.
- Every file database is put in WAL mode when it is opened, and the open fails if the switch does not take; there is no option to turn WAL off. Every `SQLITE_BUSY` the adapter does not retry is reported as `MESH_DATABASE_BUSY` too. WAL needs every process that opens the file to run on one host, as the deliverer claim does.

**Generated code and names** ([generated code and the guard](in-depth/generated-code-and-guard.md)):

- An entity call made inside a running transaction joins it through async context.
- `#mesh` keeps only what belongs to the whole project: `bind`, `connect`, `disconnect`, `transaction`, `tables`, and the types `Binding` and `Privileged`. Entity values, entity types and load functions are imported from their module.
- The name conversion, for an entity and for every name Mesh generates as a class, capitalises the first letter, drops each `_` and capitalises the letter after it (`invoice_line` gives `InvoiceLine`). Two entities of one module whose names convert alike are `MESH_DUPLICATE_ENTITY`; a name that converts to no identifier is `MESH_ENTITY_NAME`, whose message shows the converted form; inside its own file an entity names itself by the converted name.
- The build gives no warning about the spelling of a name it converts (`event :invoicePaid` and `event :InvoicePaid` both make `InvoicePaid`), and commands follow the same rule as events.
- The binding that `bind` returns holds nothing apart from `run`, `transaction` and delivery (`deliver()` and `startDelivery()`): no `close` and no layer, because the caller owns the layer and closes it.
- If Mesh adopts type-fest, the re-exports come from `@meshfw/runtime`.

**Permission questions** (`Mesh.can`, `Mesh.checkPolicies`; [permission questions](in-depth/action-lifecycle.md#permission-questions)):

- A read's question answers whether the read is allowed at all: a read whose covering policy denies the caller, whose `when`s are all false, or that no policy covers answers `allowed: false`.
- On an allowed answer, `decisive` marks, in each covering policy, the `authorize-if` checks that held, or its `forbid-if` checks when it has none. A denial is unchanged.
- When every check reads only the caller and they pass, the question decides before it reads the row, so a missing row answers `allowed: true` and only the call throws `NotFoundError`.
- While a question is answered, no write action starts through any binding of the project: it is refused before its cast with a `FrameworkError` that `checkPolicies` throws, even when a policy helper catches it, and no seam runs. Reads run as they would, an error in one never fails the running transaction, and the mark stays on work the policies leave running after the answer.
- Out of reach, and documented in the code: a helper writing through a data layer it holds itself, bindings of another project, and work handed to code whose async context was made outside the question.
- `mesh-api.d.ts` types the input as `Parameters<A>[0]` for `A extends ActionFunction`.
- A question asked more than 32 deep, each inside a policy of the one before, throws a `FrameworkError` that sticks to the outermost question: every question under it throws it at entry and the outermost throws it when it settles, even when a helper caught it, so a call from outside rejects with it, and a call whose own policy helper asks and catches is denied with `ForbiddenError`.
- Under a mark (a question, or a computed field or read policy being evaluated) every refusal throws synchronously: an action call, `Mesh.privileged`, a privileged handle's reads, `Mesh.can`, `Mesh.checkPolicies`. Outside a mark every error is a rejected promise.

**Names typed as input and names written as output** ([command line](../docs/command-line.md#inspect)):

- Shortening a name to the fewest trailing qualifiers applies to names outside `.mesh.mx` files only, since names inside them come from imports.
- The stored or wire name of an event is output too, so it is the fully qualified name.

**Packages** ([contributing](contributing.md#what-exists-today), [three rings](in-depth/three-rings.md#packages)):

- A project lists `meshfw` in `dependencies`, not `devDependencies`, and loading it at run time loads only the runtime; `meshfw` takes `@meshfw/runtime` as a peer dependency, so `Mesh` and the generated code share one copy of the runtime.
- `@meshfw/jsonrpc` does its own envelope validation and dispatch and has no run-time dependency: Bun supplies the socket and JSON, and `@meshfw/runtime` is a peer dependency. The one candidate library, `json-rpc-2.0`, covers about 60 of some 400 lines, answers batches, which Hyper's protocol forbids, and would add a public dependency.

**Domain events and commands.** These come with the second half of M6, whose design is under the operator's review; no Docs page describes them yet.

- Commands are generated as classes, as events are, named by the same conversion, with a constructor that checks each field against the declaration. Application code runs one with `dispatch(new PayInvoice({ ... }), context)`, and a serialised command carries its fully qualified name (`billing.PayInvoice`).
- A delivered event is an `EventRecord<E>`, `{ id, position, name, entity, action, key, causedBy, metadata, occurredAt, payload }`, with `payload` the event's class instance, so payload fields named `id`, `name` or `key` do not clash with the envelope. `#mesh` exports `DomainEvent`, the union of every event class's instance type, and keeps a table from each event's fully qualified name to its class, which turns stored rows back into instances. `Mesh.fqnOf(InvoicePaid)` returns a class's fully qualified name (`billing.InvoicePaid`).
- Constructing an event in a `.mesh.mx` function outside a `publish` step is a build warning, `MESH_EVENT_NOT_PUBLISHED`, never an error: such an event raises nothing, yet tests and application code construct events on purpose.
- An action with neither a name nor `on=` is `MESH_NAME`, whose message says an action needs a name or `on=`. An `on=` that names anything but an imported command is `MESH_UNKNOWN_COMMAND`, suggesting the nearest imported command. A computed action name that clashes with another member is `MESH_DUPLICATE_MEMBER`, naming the command.
- `mesh.config.ts` configures events under one key, `events: { bus, load, keep, requires }`. `load` (`() => import("./src/events.ts")`) loads the module that exports `handlers`, `metadata` and `context`; core calls it at run time (in `connect()`, or under `bind` at the binding's first `publish`, `deliver()` or `startDelivery()`), and the build never does, because the build imports `mesh.config.ts` before it generates `#mesh` and a handler's module imports `#mesh`. `bind(layer, { events })` takes the same configuration. The build checks `requires`, which `bind` then ignores, and checks `keep`, which whatever starts delivery reads at run time, so the value in force is always the deliverer's. `Mesh.handler({ events, run })` is an identity function that types a handler by letting TypeScript infer the event's type from `events`.
- `published()` (the events published so far in the current outermost transaction, in order), `dispatch(command, context)` (runs the action whose `on=` names the command's class, joining a running transaction), `resumeHandler(name)`, `retryFailed(name)` and `forgetHandler(name)` are exports of `#mesh`, bound to the project as `transaction` is, because they find the running transaction or the project's deliverer through the project's async frame.

**MX messages about Mesh files** ([the contract between Mesh and MX](in-depth/mx-integration.md)):

- MX's word "attribute" (a `key=value`) is "option" in the mapped codes (`MESH_UNKNOWN_OPTION`, `MESH_OPTION_VALUE`) and in MX's messages, since in Mesh an attribute is an entity's data member. MX codes for mistakes Mesh's own rules already report as `MESH_SYNTAX` (a bound `:=` option, a tag variable, a misplaced trigger) map to `MESH_SYNTAX`.
- MX's messages spell a tag as its line head is written (`belongs-to`, `&title`), not as `<belongs-to>`.

## Syntax v4

The operator's 2026-10-08 rulings distinguish declarations (`:name`), members (`&name`) and imported entities (`Name`), put all action input in one `input` section, and keep entity files static. [ADR-0067](./decisions/0067-members-imports-input-static-files.md) records the rules, the lead's choices and MX decisions 182 addendum 1 and 187 addendum 2. **The Docs pages are the target; the compiler and example follow the entity syntax (PR #47, PR #48), `&` positions included since the MX alpha.13 pin.**

Measured on `@mxlang/data` alpha.5 with `structural: "reject"`, before the pin moved to alpha.11, and not re-measured since; the highlighter column is `@mxlang/tree-sitter-mx` alpha.2:

| Spelling | Parser | Highlighter |
|:--|:--|:--|
| `import { Customer } from "./customer.mesh.mx"` | Accepted with `imports: "pass"`, as measured; rejected without it under structural rejection | Already accepted |
| `asc &dueOn` | Invalid attribute name | Accepted by the grammar, not a semantic member token |
| `() => &status === :sent`, `load=[&customer]` | Unexpected token at the operand | No MX ERROR, but layer-2 member highlighting is still owed |
| `&title` in `input` | Accepted syntactically, without Mesh semantics | Rejected: `input` is treated as an HTML void tag, even with an ordinary `string :x` child |
| `&status=:sent` under `set` | Accepted syntactically | Accepted |
| `belongs-to :customer entity=Customer` | Accepted | Accepted |

**No parser bridge.** Mesh's syntax module (`packages/compiler/src/syntax.ts`) gives MX the `&` trigger, and MX lowers every member position before the compiler or the docs checks read the tree, so fences parse as authored, comments and imports included. Production and tests never rewrite source.

**One temporary highlighter allowance.** `MX_V4_INPUT_PENDING_SYNTAX_TABLE` uses same-width stand-ins for standalone nested `input` sections and their bare member lines. It renders the original text, leaves those member names uncoloured, counts and prints the bridged lines, and still fails all other grammar errors. Tests pin both halves. MX item `mesh-syntax-highlighting-route` owns the permanent route, through semantic tokens or a Mesh grammar; no grammar is patched here.

A declaration name and atom value still have separate colours (`ts-name`, `ts-atom`). A check label and declaration name still share a capture. The `mesh` host package remains necessary for `.mesh.mx` tooling, and its target design is `builtOn: "tree"`. The target is static: no conditional declarations, loops, `let`, `const` or `define`.

**Planned, not v1.** (Reusable step files and the `after-commit` step are no longer planned: [ADR-0082](./decisions/0082-named-checks-and-mixins.md), [ADR-0079](./decisions/0079-commands-events-and-the-outbox.md).) Not in the Docs pages, because a reader would plan on them: `lock="version"` and `relate=…` steps; a raw-SQL escape hatch like Ash's `fragment`; and `bypass` on a policy, which the operator removed because it fails open and is order-dependent (write `isStaff(actor) || …` with a helper instead). Two more items the syntax reference does not settle and the docs therefore do not show: an `increment` step (`set` with an expression covers it), and a cap declared on the entity (a read declares `filter` and `sort`; `limit` and `offset` arrive in the caller's input).

**Static by ruling, not just by parser limitation.** Declaration and member names are written out; entities use explicit imports. A condition is `when=` on its policy or check, or part of the expression. The future evaluated `data` target is not Mesh's target (MX decision 187 addendum 2).

**The checks keep their teeth.** Every fence passes the compiler's own parse with the production contracts. `checkDocsSyntaxV4` requires `entity :Name`, and `oldSpellingInV4` rejects old input options, the old relationship shape, atoms in reference positions, quoted names and `sort=`. Planted fence tests prove these failures in both the compiler's sample check and the Docs check. Contract semantics and reference resolution are checked by the production contracts and builder.

Two consequences for records that predate v2: [ADR-0034](./decisions/0034-vocabulary-copies-ash-dsl.md) ("copy Ash's DSL") is superseded for entity files, and [ADR-0022](./decisions/0022-policies-simple-tier-as-extension.md) is superseded on packaging, since `policies` is now a section of the entity file rather than an extension. [ADR-0017](./decisions/0017-atomic-by-default-and-classification.md) is amended again: `validate` sees the record with the accepted input applied, not the record after the changes, and `require-atomic` does not appear in v2 — a `run(…) { }` step, or any expression Mesh cannot translate to SQL, is what makes an action read-then-write.

**Changed 2026-10-11 (operator).** `validate` no longer sees the record with the accepted input applied: a check and a policy see `self` before the input is applied (the stored record on an update or destroy, a create's new instance with its defaults), and the caller's values are in `input`. See the amendment of [ADR-0053](./decisions/0053-validate-then-do.md). The paragraph above is kept as history.

## What the Docs pages invented

Nothing on this list is decided. Each entry is a design made while writing, because a page could not be written without it. The alternative is the one that was rejected.

- **`connect()` takes no arguments** and reads `mesh.config.ts`. Since settled (finding 11).
- **The adapter's own schema function**, for ADR-0048's "create schema on this connection". Since settled as `createSchema(db, tables)`, which takes the connection and the generated tables. Rejected: keeping the drizzle-kit spelling, which exposes the underlying tool.
- **The annotated figure on the Introduction** splits one `todo.mx` into nine code blocks so each block lines up with one callout beside it, and the same file is shown whole underneath. Rejected: an SVG diagram, which does not reflow at phone width, and a table of blocks with a column of comments, which reads as a table and not as a file.
- **"Excerpt" fences.** A TypeScript block on a Docs page is a complete file and is type-checked; two signature one-liners are fenced as excerpts and are not. Rejected: leaving the fragments unchecked, which is where a stale signature would hide.
- **`mesh inspect` and `mesh explain` are the agent's tools**, and `.mesh/rules.md` is the generated rules file. Rejected: an MCP server ([ADR-0027](decisions/0027-no-mcp-agent-surface.md)).
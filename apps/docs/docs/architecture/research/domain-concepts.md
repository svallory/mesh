---
title: "Domain concepts"
description: "Which DDD, CQRS and event-sourcing ideas Mesh should model, and the project structure that leaves room for them: twenty-four proposed decisions, each with what was ruled and the record that holds it."
---

# Domain concepts: which DDD, CQRS and event-sourcing ideas Mesh should model, and the project structure that leaves room for them

Date: 2026-10-10 (revision 3 of the study); rulings 2026-10-10 and 2026-10-11. This page is a study written before the decisions were taken. It proposes twenty-four decisions, D1 to D24 (section 7). The project then ruled on most of them, in some places differently from what the study recommended. **The decision records are the source of truth, and the table below says which record holds each outcome.** Where a proposal in the text was replaced, a note under it says so and names the replacement; the analysis and its citations stay as written, because they were checked against the sources and still explain why the options looked as they did. A few points in the records are marked "lead reading": they are one reading of a ruling and are not yet confirmed.

## What was decided

Each row is one proposed decision. "Row" is the id the decision records cite for a ruling (DOM rows come from the domain-concepts discussion; CMP, SYN and RDM rows from other areas of the project's decision log). The last column is the record to read.

| D | Proposed | Outcome | Row | Record |
|:--|:--|:--|:--|:--|
| D1 | Name of the audience-specific entry-point file | **Ruled as proposed:** `surface`, not `app` | DOM-11 | [ADR-0077](../decisions/0077-surfaces-and-file-kinds.md) |
| D2 | How a file's kind is recognised | **Ruled as proposed:** the root tag decides; every file keeps `.mesh.mx` | DOM-12 | [ADR-0077](../decisions/0077-surfaces-and-file-kinds.md) |
| D3 | Where services live | **Ruled as proposed:** domain services in their module folder, application services with their surface; the domain never imports a surface | DOM-13 | [ADR-0078](../decisions/0078-services-and-where-effects-go.md) |
| D4 | Services (options A to D) | **Partly ruled:** services follow Vernon's definition (domain service, application service). The construct's shape and when it is built are **open**; no new construct comes before the port unless the port needs it, and as many planned constructs as possible come before 1.0 | DOM-14, DOM-09 (open), RDM-01 | [ADR-0078](../decisions/0078-services-and-where-effects-go.md), [ADR-0072](../decisions/0072-mesh-1-0-is-the-port-gate.md) |
| D5 | Cascade or service command | **Ruled, differently:** a three-way split. The root writes its own parts in the entity file; an effect across aggregates is a service (plain code over `transaction` until services exist); effects that may happen later are publish and listen. A core rule warns when an entity action calls another aggregate's action. Whether Mesh supports publish-subscribe in general is **open** | DOM-15, DOM-08 (open) | [ADR-0078](../decisions/0078-services-and-where-effects-go.md), [ADR-0068](../decisions/0068-actions-compose-through-actions-and-tx.md) (amended) |
| D6 | The single-entity check | **Ruled as proposed, with a new keyword:** declared dependencies stay (they narrow the handles and `tsc` enforces them), the warning can be switched off, and the dependency line starts with `uses`, not `call` | DOM-16, DOM-01 | [ADR-0078](../decisions/0078-services-and-where-effects-go.md) |
| D7 | Command in core | **Ruled, differently:** `command` and `event` are declarations in their own files, and an action names the commands it answers with `handles=[...]`. A command is a serialised request to run a write action; a query is a serialised read request | DOM-17 | [ADR-0079](../decisions/0079-commands-events-and-the-outbox.md) |
| D8 | Domain events: form and timing | **Ruled, differently:** domain events are built in milestone M6, before the gate, and the Hyper application's hand-written event table is dropped | DOM-18 | [ADR-0079](../decisions/0079-commands-events-and-the-outbox.md) |
| D9 | Seam payloads and declared events | **Ruled, differently:** declaring events and publishing them are separate syntax. An action says `publish :task-completed`; a surface lists what leaves with `publishes events=[...]`. Option (a), an `events` field on the seams, was not taken; with events delivered from the outbox the seams need no such field (a consequence, not a ruling; the payloads are settled in M6's design) | DOM-19, DOM-02 | [ADR-0079](../decisions/0079-commands-events-and-the-outbox.md), [ADR-0077](../decisions/0077-surfaces-and-file-kinds.md) |
| D10 | The JSON-RPC adapter and surfaces | **Ruled as proposed:** option (c), `@meshfw/jsonrpc` before the gate with a hand-written method table; surfaces generate the table after 1.0 | DOM-20 | [ADR-0077](../decisions/0077-surfaces-and-file-kinds.md) |
| D11 | The surface format in core | **Ruled as proposed:** core owns the format, view and manifest; readers are adapters | DOM-21 | [ADR-0077](../decisions/0077-surfaces-and-file-kinds.md) |
| D12 | Fields through a surface | **Ruled as proposed:** fail closed (`fields=[...]` or `fields=:all`); replaces the proposed `public` flag of [ADR-0035](../decisions/0035-meaning-of-public.md) | DOM-22 | [ADR-0077](../decisions/0077-surfaces-and-file-kinds.md) |
| D13 | Aggregates | **Ruled, differently:** an aggregate file (`aggregate :Name`, a `root` line and an `entities` section), not a `part-of` flag; an aggregate contains concepts through its entities' attributes. Mesh does not prevent an entity from being a part of two aggregates | DOM-23, DOM-03, DOM-31 | [ADR-0080](../decisions/0080-aggregates-and-concepts.md) |
| D14 | Event sourcing and CQRS | **Ruled as proposed:** two extensions, `@meshfw/event-sourcing` and `@meshfw/cqrs` | DOM-24 | [ADR-0081](../decisions/0081-event-sourcing-and-cqrs-are-extensions.md) |
| D15 | Outbox | **Ruled, differently:** the outbox is core, and it comes with domain events in M6 | DOM-06 | [ADR-0079](../decisions/0079-commands-events-and-the-outbox.md) |
| D16 | Reactions and after-commit work | **Ruled, differently:** the planned `after-commit` step is dropped and the `afterCommit` seam is not used for it either; the way is `publish` plus a listener. `emit` became `publish`; a handler that updates a read-model row is `apply`, one that runs commands is `process` (the draft's `react`) | DOM-25, DOM-05 | [ADR-0079](../decisions/0079-commands-events-and-the-outbox.md), [ADR-0083](../decisions/0083-names-for-the-new-constructs.md), [ADR-0053](../decisions/0053-validate-then-do.md) (amended) |
| D17 | Value types | **Ruled, differently:** `concept`, one construct that is both the value object and the Concepts library idea: a shared understanding of something with no identity and as many fields as it needs. A repository is allowed as a pattern, with no construct | DOM-26, DOM-27 | [ADR-0080](../decisions/0080-aggregates-and-concepts.md) |
| D18 | Named checks | **Ruled, differently:** an entity-level `checks` section, referenced by a bare `check :name`, in core (not MX check files, and not an extension-host point). Reusable blocks are `mixin` files included with `use`; Mesh ships `:timestamps` and `:versioned`. Step files (reusable steps) are dropped | DOM-28, DOM-04, DOM-33 | [ADR-0082](../decisions/0082-named-checks-and-mixins.md), [ADR-0053](../decisions/0053-validate-then-do.md) (amended) |
| D19 | Name clashes | **Ruled as proposed for the port:** the table in section 5 is accepted, with the changed words (`publish`, `apply`, `process`, `uses`) | DOM-29 | [ADR-0083](../decisions/0083-names-for-the-new-constructs.md) |
| D20 | Decide now: flat namespace, the meaning of `&`, seam payloads | **Partly ruled differently:** item 1 recommended one flat namespace, and the ruling is folder modules, not a flat namespace (`#mesh/domain/<module>`); `&name` always refers to a member declared by the type it sits in; item 3 (seam payloads) follows D9: no `events` field is needed once events come from the outbox | CMP-12, CMP-16, CMP-17, SYN-19 | [ADR-0058](../decisions/0058-generated-code-in-mesh-imported-as-hash-mesh.md) (amended), [ADR-0067](../decisions/0067-members-imports-input-static-files.md) |
| D21 | Architecture rules: ring | **Ruled, differently:** the rule language, the engine and the presets are core, not an extension. Mesh uses them to guide users and agents. When they are built is **open** | DOM-30, DOM-10 (open) | [ADR-0084](../decisions/0084-architecture-rules-are-core.md) |
| D22 | Architecture rules: file name and root tag | **Ruled as proposed:** `architecture.mesh.mx`, root `architecture :name` | DOM-30 | [ADR-0084](../decisions/0084-architecture-rules-are-core.md) |
| D23 | Presets | **Ruled as proposed:** `use :mesh-recommended`, with per-rule `severity` and `disable` | DOM-30 | [ADR-0084](../decisions/0084-architecture-rules-are-core.md) |
| D24 | Two tiers | **Ruled as proposed:** built-in invariants no file can remove, plus the file; Mesh's own checker over the import graph and the model | DOM-30 | [ADR-0084](../decisions/0084-architecture-rules-are-core.md) |
| none | How dialect tags (such as concepts) are found | **Ruled as a target design, not built:** MX discovers tags from directories the dialect declares (`tagDirs`, `reservedTags`), designed with the MX project | DOM-07 | [ADR-0085](../decisions/0085-tag-discovery-for-dialect-tags.md) |

The relationship rows of the same discussion (DOM-32 to DOM-35: `inverse=`, a stand-alone `belongs-to`, `through=`) belong to [ADR-0070](../decisions/0070-has-many-via.md) and are not part of this study.

## 0. How to read this

**Mesh** is a TypeScript framework (Bun only). A developer writes one *entity file* (`.mesh.mx`, MX
syntax) per entity, declaring its data, operations (*actions*) and rules; Mesh generates types,
validators, one TypeScript function per action and the database schema ([Entities][d-entities],
[ADR-0005]). This page asks which concepts from Domain-Driven Design (DDD), Command Query
Responsibility Segregation (CQRS) and event sourcing Mesh should *eventually* model, and in what form,
so that the file kinds and folders chosen now never need a refactor.

**Which docs are authoritative.** The user docs describe the target design of Mesh, not a version
([ADR-0063], amended by [ADR-0072]): Postgres, migrations, extensions, `can`, tracing and `on:load` are
part of that target even where the [roadmap] moves them after 1.0. The roadmap gives only timing.
The sketches below follow the syntax of those pages: a line is `kind :name options`.

**Inputs behind the page.** The question began with the view that "a service groups many operations".
Section 3 evaluates that view instead of assuming it. A stated preference for Vernon's split between
domain services and application services shaped section 3 as well.

**Mesh's three rings** ([ADR-0001]): *core* is what Mesh cannot run without; an *adapter* is one
replaceable implementation of a contract core owns; an *extension* is an optional feature built on
core's declared extension points ([ADR-0020]).

**The 1.0 gate** ([ADR-0072]): Mesh 1.0 is done when Hyper, a work tracker for people and agents,
built on Mesh, passes the 126 conformance cases of its specification (`PROTOCOL.md` v0 on the spec
repository's `protocol-phases` branch). Every "Hyper" line below is checked against that spec and the
[gap analysis][gap].

**Sources** and the short names used below:

| Short name | Source |
|:--|:--|
| Evans | Eric Evans, *Domain-Driven Design: Tackling Complexity in the Heart of Software*, Addison-Wesley, 2004 (copyright 2004, published August 2003). Chapter numbers are the book's. |
| DDD Reference | Eric Evans, *Domain-Driven Design Reference*, 2015, CC BY 4.0, <https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf>. Printed page numbers. |
| Vernon | Vaughn Vernon, *Implementing Domain-Driven Design*, Addison-Wesley, 2013. |
| Vernon EAD | Vaughn Vernon, "Effective Aggregate Design", parts I and II, 2011: <https://dddcommunity.org/wp-content/uploads/files/pdf_articles/Vernon_2011_1.pdf>, <https://dddcommunity.org/wp-content/uploads/files/pdf_articles/Vernon_2011_2.pdf>. Printed page numbers. |
| Young CQRS | Greg Young, *CQRS Documents*, 2010, <https://cqrs.wordpress.com/wp-content/uploads/2010/11/cqrs_documents.pdf>. PDF page numbers. |
| Young Versioning | Greg Young, *Versioning in an Event Sourced System*, Leanpub, 2017, <https://leanpub.com/esversioning> |
| Fowler PoEAA | Martin Fowler, *Patterns of Enterprise Application Architecture*, Addison-Wesley, 2002; catalogue at <https://martinfowler.com/eaaCatalog/> |
| Fowler bliki | The pages linked where used |

**What was checked, and how.** Quotations from the DDD Reference, Young CQRS, Vernon EAD and the
Evans–Fowler Specifications paper were checked against the full text of the PDFs; quotations from
Fowler's bliki and PoEAA catalogue, Hohpe and Woolf, Richardson, Microsoft and the DDD Crew glossary
against the fetched pages, and an independent review re-checked them. Evans's and Vernon's books are cited by
chapter only, from their published structure, and are not quoted. Young Versioning is cited by its
table of contents; its text was not read. Two secondary sources are used where the primary authors say
nothing quotable, and are marked: Microsoft's *.NET Microservices* guide (integration events) and the
DDD Crew *EventStorming Glossary* (the EventStorming "policy").

## 1. Summary

> **Read with the table above.** This summary is the study's proposal. The table says what was ruled: the `value` kind became `concept`, the `step` kind is dropped, domain events and the outbox are core and arrive in M6, and architecture rules are core.

- **Own file kinds** (eventually): *entity* (today), *step* (planned, [ADR-0053]), *service* (a
  domain service in Vernon's sense, with `command` and `query` members; section 3), *surface* (the
  brief's "app" file; section 4), *value*, and from extensions *projection*, *workflow* and
  *architecture* (the rules file, 2.24, whose built-in invariants stay core). A
  file's kind is its root tag; the extension stays `.mesh.mx`.
- **Constructs inside existing kinds**: domain events (an `events` section and an `emit` step in an
  entity), aggregate membership (a flag on a `belongs-to`), and, from extensions, event upcasters,
  snapshots and asynchronous reactions.
- **Generated only**: application services (Mesh's term for the wrapper it generates around every
  action and service operation: transaction, policies, validation), command and query objects, the
  per-surface manifest, repositories (the generated reads and writes).
- **Nothing**: bounded context (a package), context map (documentation), anti-corruption layer (plain
  code), factory (the create action), synchronous reactions (cascades, [ADR-0068]).
- **Core**: entity, step, value, service, the surface *format* and its manifest, domain events and
  their delivery to seams. **Extensions**: event sourcing, CQRS projections, outbox, jobs, workflows,
  reactions. **Adapters**: every transport (Elysia, oclif, JSON-RPC, admin UI), event stores, job
  runners.
- **Recommended name for the "app" file: `surface`.**
- **Three proposals reverse a ruled "not planned" line** in roadmap §6, and each is its own decision:
  services (§6 "manual and generic actions"), value types (§6 "embedded entities"), and an admin UI
  adapter (§6 "an admin interface"). The [roadmap] section 6 now carries the rulings.
- **Decide now**, because each would force a refactor later: the seam payloads gain a place for
  declared events (M6 builds them before the gate); one flat generated namespace across entities and
  service operations (finding 21 is live); what `&name` means outside entity files.
- **On the 1.0 path**: the JSON-RPC adapter (D10, option c), and the reserved `events`
  field on M6's seam payloads that D9(a) proposed (not taken; domain events are built in M6 instead, see D8). Everything else in this
  page comes after the gate.

## 2. The concepts

Each concept has the same fields: **What** (with a source), **Mesh today**, **Form**, **Ring**,
**Depends on**, **Hyper**, **When**, and a sketch where it has its own file or construct. Sketches use
the documented syntax: `kind :name options`, atoms for names and fixed-set values, `&name` for a member
of the file's own declaration, imported identifiers for other entities ([ADR-0050], [ADR-0066],
[ADR-0067]). A member of *another* entity is an atom beside that entity's reference, as
`entity=Membership inverse=:collaborator` does ([ADR-0070], whose first draft called the option `via=`): Mesh has "no qualified-name spelling"
([Entities: names and references][d-names]; [ADR-0067]), so `Task.completed` is never used. Tag and
option names are proposals.

### 2.1 Entity (the baseline)

- **What.** "When an object is distinguished by its identity, rather than its attributes, make this
  primary to its definition in the model" (DDD Reference, p. 11; Evans ch. 5).
- **Mesh today.** The `entity` file: one entity per `.mesh.mx` file under `src/domain/<module>/`
  ([Entities][d-entities], [ADR-0057]). `uuid :id primary-key` gives identity.
- **Form.** Own file kind (exists). **Ring.** Core. **Hyper.** Yes (12 entities in the gate). **When.**
  Now.

### 2.2 Aggregate, aggregate root, consistency boundary

- **What.** "Cluster the entities and value objects into aggregates and define boundaries around each.
  Choose one entity to be the root of each aggregate, and allow external objects to hold references to
  the root only ... Use the same aggregate boundaries to govern transactions and distribution. Within
  an aggregate boundary, apply consistency rules synchronously. Across boundaries, handle updates
  asynchronously" (DDD Reference, p. 16; Evans ch. 6). Fowler: "Transactions should not cross aggregate
  boundaries" ([DDD_Aggregate][f-aggregate], 2013). Vernon's four rules: model true invariants in
  consistency boundaries, design small aggregates, reference other aggregates by identity, use eventual
  consistency outside the boundary (Vernon EAD I pp. 3–4, II p. 8; Vernon ch. 10).
- **Mesh today.** No aggregate concept. The consistency boundary is the *transaction of one call*: an
  update reads its row locked and writes it in one transaction ([Using your domain: update][d-update]),
  and a cascade joins the caller's transaction through `actions` ([ADR-0068]). A cascade that writes
  several entities in one transaction is, in Vernon's terms, breaking the one-aggregate-per-transaction
  rule; of the four reasons he accepts for doing so (Vernon EAD II p. 10: user-interface convenience,
  lack of technical mechanisms, global transactions, query performance), Mesh's case is closest to the
  second. Relationships reference other entities by key (`belongs-to` stores `listId`), which matches
  Vernon's third rule. Modules are not aggregates: a module is a naming group ([ADR-0057]).
- **Form.** A flag on the `belongs-to` that leads to the root (`part-of`), so the fact sits on the
  relationship it qualifies. This handles Hyper's Dependency, which has two `belongs-to` Task and
  whose aggregate follows only `dependent` (`PROTOCOL.md` §4.5). What it buys: (1) the generated code
  bumps the root's `version` **once per outermost call** that changes any part, not once per part write
  (§4.5: "+1 per committed command that changes it (not per event)"); today this is a recipe of a
  `check` and a `set` (gap G02); (2) a domain event's `record` is the root (§6); (3) a verifier that
  other modules hold `belongs-to` only to roots; (4) a load of the whole aggregate. An entity-line
  option (`entity :Claim part-of=&task`) is the alternative (decision D13).

  > **Replaced by a ruling.** Aggregates are declared in an **aggregate file** (`aggregate :Name`, a `root` line, an `entities` section), not by a flag on a `belongs-to`. See [ADR-0080] (DOM-23, DOM-03, DOM-31). The analysis of why the boundary matters stands.
- **Ring.** Core. **Depends on.** Relationships, the optimistic version (`lock="version"`, planned in
  [ADR-0053]), domain events for (2).
- **Hyper.** It uses the idea (§4.5, §6), but the gate passes with the recipe. **When.** After 1.0.

```mx "src/domain/work/claim.mesh.mx (sketch; replaced by an aggregate file)"
import { Task } from "./task.mesh.mx"

entity :Claim
  attributes
    uuid :id primary-key
    integer :fence
  relationships
    belongs-to :task entity=Task part-of
```

### 2.3 Value object

- **What.** "When you care only about the attributes and logic of an element of the model, classify it
  as a value object ... Treat the value object as immutable ... Don't give a value object any identity"
  (DDD Reference, p. 12; Evans ch. 5). Fowler: "value objects should be immutable" ([ValueObject][f-vo],
  2016).
- **Mesh today.** Scalars plus `json` ([Entities: the types][d-types]). Roadmap §6 lists "embedded
  entities" under "not planned at all". A saved idea of a library of **Concepts**
  (`string :email concept=:Email`, carrying validation, a default UI input type and i18n) is a
  single-field value object.
- **Form.** Its own file kind, `value`, imported by path like an entity; attributes and computed
  fields, no id, no actions, no policies; stored as columns of the owning table (or `json`). That is
  Ash's embedded resource, so **this reverses §6's "embedded entities: not planned"** (decision D17).
  The Concepts library would be the first-party set of single-field values. Spelling of use:
  `value :price type=Money`, the house style of `belongs-to :customer entity=Customer`. (A capitalised
  tag such as `Money :price` would need a new MX feature: MX treats a capitalised tag naming an import
  as a component call, which the data target rejects.)

  > **Replaced by a ruling.** There is one construct, `concept`: a shared understanding of something with no identity and as many fields as it needs. It is the value object, and the saved Concepts idea is the same thing. It is not spelled `value :price type=Money`. See [ADR-0080] (DOM-26).
- **Ring.** Core (an attribute type). **Hyper.** No (G10 is `json`). **When.** After 1.0.

```mx "src/domain/billing/money.mesh.mx (sketch; replaced by concept)"
value :Money
  attributes
    decimal :amount
    string :currency match=/^[A-Z]{3}$/
```

```mx "src/domain/billing/invoice.mesh.mx (excerpt, sketch; replaced by concept)"
import { Money } from "./money.mesh.mx"

entity :Invoice
  attributes
    uuid :id primary-key
    value :total type=Money
```

### 2.4 Domain service and application service

Section 3 has the evaluation. In short: a `service` file is a domain service in Vernon's sense
(stateless, cross-entity, writes only through entity actions), with `command` and `query` members;
"application service" is the docs' name for what Mesh generates around every action and operation.
This reverses §6's "manual and generic actions: not planned" (decision D4).

> **Ruled in part.** Services follow Vernon's definition, and the three-way split of effects is ruled. The shape of the service construct and when it is built are still open (DOM-09). See [ADR-0078].

**Hyper.** It would use one
(`submission.submit` with its late-result outcome, `task.complete` with `warnings`, `task.get`,
`task.next`), but the gate passes with application code over `transaction` ([ADR-0068] decision 3).
**When.** After 1.0.

### 2.5 Repository

- **What.** "For each type of aggregate that needs global access, create a service that can provide
  the illusion of an in-memory collection of all objects of that aggregate's root type ... Provide
  repositories only for aggregate roots that actually need direct access" (DDD Reference, p. 17; Evans
  ch. 6). PoEAA: "Mediates between the domain and data mapping layers using a collection-like interface
  for accessing domain objects" (Edward Hieatt and Rob Mee, [catalogue][f-repository]).
- **Mesh today.** The generated functions are the repository: `readTodo` with plain-data `filter`,
  `sort`, `limit`, `load`; `createTodo`, `destroyTodo` ([Using your domain: signatures][d-signatures]).
  Inside a transaction, `tx` gives the same reads without read policies ([ADR-0068]). The data layer is
  *not* a repository: it works on rows below the entity ([data layer][a-data-layer]).
- **Form.** Generated code only (exists). Mesh never uses the word (section 5). *Ruled: a repository is allowed as a pattern, with no construct for now; a construct may come later ([ADR-0080], DOM-27).* **Ring.** Core.
  **Hyper.** Yes. **When.** Now.

### 2.6 Factory

- **What.** "Shift the responsibility for creating instances of complex objects and aggregates to a
  separate object ... Create an entire aggregate as a piece, enforcing its invariants" (DDD Reference,
  p. 18; Evans ch. 6).
- **Mesh today.** A `create` action with `input`, `validate`, `set` and, for children, a `run
  [after=:write]` step calling the children's create actions in the same transaction ([Entities:
  do][d-do]; [ADR-0068]).
- **Form.** Nothing new; a second creation construct would be a second home for "create". **Ring.**
  Core (exists). **Hyper.** Covered (bootstrap is a cascade or application code). **When.** Now.

### 2.7 Specification and named checks

- **What.** "The central idea of Specification is to separate the statement of how to match a
  candidate, from the candidate object that it is matched against. As well as its usefulness in
  selection, it is also valuable for validation and for building to order" (Evans and Fowler,
  "Specifications", <https://martinfowler.com/apsupp/spec.pdf>, p. 1; Evans ch. 9).
- **Mesh today.** A translatable `computed` boolean is a named specification on one entity: it serves
  selection (`filter=() => &isOverdue`) and validation (`that=() => &isOverdue`) ([Entities:
  computed][d-computed]). Named checks reusable across entities are documented as an extension-host
  *run-time point*: "Named, reusable checks, computed fields and policy helpers an entity file refers
  to by name" ([extension host][a-ext-host]; roadmap §6 and M11), that is, TypeScript contributed
  through the host.
- **Form.** The computed boolean is the specification. For named checks, the documented form stands
  unless the [ADR-0053] model used for reusable steps is preferred: MX definition files
  (`check :taskOpen` with options and a body) that extensions contribute *the same way*, so user-written
  and extension-contributed checks share one contract and one home (decision D18). Under that option a
  root `check` and the `check` line inside `validate` share a tag name in two roles; root-tag dispatch
  distinguishes them by parent.

  > **Replaced by a ruling.** Named checks are an entity-level `checks` section, referenced by a bare `check :name`; they are core, not an extension-host run-time point and not MX `check` files. See [ADR-0082] (DOM-28).
- **Ring.** Core. **Hyper.** 57 rules referenced 94 times would use named checks (G04); the gate
  repeats the `check`. **When.** Computed: now. Named checks: after 1.0 (M11).

### 2.8 Domain event

- **What.** "Model information about activity in the domain as a series of discrete events. Represent
  each event as a domain object ... Domain events are ordinarily immutable, as they are a record of
  something in the past. In addition to a description of the event, a domain event typically contains
  a timestamp for the time the event occurred and the identity of entities involved in the event. Also,
  a domain event often has a separate timestamp indicating when the event was entered into the system
  and the identity of the person who entered it" (DDD Reference, p. 13; one of the three patterns the
  Reference adds to the 2004 book, with Partnership and Big Ball of Mud). Young: "An event is something
  that has happened in the past. All events should be represented as verbs in the past tense" (Young
  CQRS p. 25). Vernon ch. 8.
- **Mesh today.** None declared. The `afterWrite` seam receives every row written (`{ entity, action,
  before, after, input, context }`), once per row; `afterCommit` receives `{ changes }` once
  ([ADR-0075], [Using your domain: seams][d-seams]). Hyper's typed events are an application table
  from (entity, action) to event type and payload on that seam ([ADR-0075] consequences). A seam
  payload is a *change*, not a domain event.
- **Form.** A construct inside the entity (core may have a simple Event without
  event sourcing). An `events` section declares typed events, each with payload lines in the shape of
  an `input` section; an `emit` step in `do` raises one, ordered with the other steps and allowed under
  `when`.
  - **When an event is emitted, and which seam call carries it.** `emit` is a `do` step, and `do`
    steps run before the action's own row is written; only a `run` step can be `after=:write`, and a
    `run` body is code, not steps, so an `emit` after the write cannot be written (it is a build error
    if one appears inside an `after=:write` scope). The `emit` step decides *whether* and *with what
    payload*; the event is **recorded at the action's own row write**. Nested writes belong to the
    actions they call and record their own events at their own writes. So:
    - `afterWrite` keeps [ADR-0075]'s timing (right after each row, before any `after=:write` step) and
      carries the events of the action whose row it is (one row per action today; per row of its own
      once bulk actions arrive after 1.0);
    - `afterCommit.events` lists every event of the call in **emission order**, which is the order of
      the row writes across the whole call.

    This reproduces Hyper's orders in `PROTOCOL.md` §6.1 without extra machinery: in `task.complete`, a
    `run` step before the write calls `Submission :submit` (`submission.submitted`), the Task's own
    write records `task.completed`, and an `after=:write` cascade releases the claim
    (`claim.released`); in `task.cancel`, the claim and submission cascades run before the write, so
    their events precede `task.canceled`; in `review.accept`, the Review's own event comes first and the
    `after=:write` call into `Task :complete` follows. This changes [ADR-0075]'s payloads; decision D9
    asks to reserve the field now, with this meaning.
  - **Not an event log.** Core types the payload, attaches metadata (`occurredAt`, `actor`, the action,
    the causing event in a nested call) and hands events to the seams. It does not store them, so §6's
    "event log ... not planned as a Mesh feature" stands. Storage is the application's table on the
    seam, the outbox extension or the event-sourcing extension.
  - **One way.** After D8, declared events are *the* way to produce typed events. A mapping table on
    the seam stays legal application code, as any seam code is, and the docs say so.
  - **Replaced by a ruling.** Events are declared in `event` files, separate from the action that raises one, and an action raises one with `publish :task-completed`; `publish` writes the event to the outbox in the action's transaction, and an event bus delivers from there. There is no `emit` step and no `events` section in the entity. With events delivered from the outbox, the seam payloads need no `events` field (a consequence of these rows, not a ruling of its own; the payloads are settled in M6's design). Domain events and the outbox are built in M6. See [ADR-0079] (DOM-19, DOM-02, DOM-06, DOM-18). The timing analysis above (which row write records an event, and in what order the events of a call come out) is the reasoning the Hyper event order must still satisfy.
  - **Names.** Events would be members (`&completed`), beside attributes, relationships, computed
    fields, actions, checks and policies, so an event cannot share a name with an action. Past-tense
    names (`complete`/`completed`) avoid it; `cancel`/`canceled` too. Decision D8 includes this.
- **Ring.** Core. **Depends on.** Actions and steps, seams ([ADR-0075]), the action context
  ([ADR-0059]).
- **Hyper.** Typed events are central to v0 (`PROTOCOL.md` §6, §6.1, §8); the gate passes with the
  application's table. **When.** After 1.0 (the payload field now, D9).

```mx "src/domain/work/task.mesh.mx (excerpt, sketch; replaced by event files and publish)"
entity :Task
  attributes
    uuid :id primary-key
    uuid :workspaceId
    enum :state values=[:open, :done, :canceled] default=:open

  events
    event :completed
      &id
      &workspaceId
      uuid :completedBy

  actions
    update :complete
      do
        set
          &state=:done
        emit &completed [completedBy=({ actor }) => actor.id]
```

### 2.9 Integration event

- **What.** An event published to other bounded contexts or systems, only after the change committed.
  Vernon ch. 8 and ch. 13 cover publishing domain events to other bounded contexts. The clearest
  short statement is secondary: "the purpose of integration events is to propagate committed
  transactions and updates to additional subsystems, whether they are other microservices, Bounded
  Contexts or even external applications. Hence, they should occur only if the entity is successfully
  persisted" (Microsoft, *.NET Microservices Architecture*, "Domain events: design and implementation",
  <https://learn.microsoft.com/en-us/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/domain-events-design-implementation>).
- **Mesh today.** `afterCommit` is the after-commit point ([ADR-0075]); nothing declares what leaves.
- **Form.** Not a second event declaration: a domain event that a *surface* publishes, under the
  surface's name and shape (section 4, `publish`; ruled as `publishes events=[...]`, [ADR-0077]). That keeps "nothing leaves unless listed" for events
  and keeps the domain event the one home of its meaning. Durable delivery goes through the outbox.
- **Ring.** The `publish` line is part of the surface format (core); delivery is an adapter. **Hyper.**
  `events.subscribe` (§8) is this; the gate does it in application code over `afterCommit`. **When.**
  After 1.0.

### 2.10 Bounded context

- **What.** "Explicitly define the context within which a model applies. Explicitly set boundaries in
  terms of team organization, usage within specific parts of the application, and physical
  manifestations such as code bases and database schemas" (DDD Reference, p. 2; Evans ch. 14). Fowler,
  [BoundedContext][f-bc].
- **Mesh today.** One domain per app at `src/domain/`; "an application that wants Ash's several
  independent domains must split into packages" ([ADR-0057]). One Mesh project is one bounded context;
  modules are Evans's *Modules* (DDD Reference, p. 15), not contexts.
- **Form.** Nothing: it is a package. No `context` construct; `context` is the action context
  ([ADR-0059]). **Hyper.** One context. **When.** Never as a construct.

### 2.11 Context map

- **What.** "Identify each model in play on the project and define its bounded context ... Describe the
  points of contact between the models, outlining explicit translation for any communication" (DDD
  Reference, p. 29; Evans ch. 14).
- **Form.** Nothing; documentation across packages. Two of its patterns land through the surface: a
  surface is an Open-host Service ("Define a protocol that gives access to your subsystem as a set of
  services", p. 35) and its generated manifest is its Published Language (p. 36). **When.** Never as a
  construct.

### 2.12 Anti-corruption layer

- **What.** "As a downstream client, create an isolating layer to provide your system with
  functionality of the upstream system in terms of your own domain model ... Internally, the layer
  translates in one or both directions as necessary between the two models" (DDD Reference, p. 34;
  Evans ch. 14).
- **Form.** Plain code: helper modules called from an application service (section 3.6) or a domain
  service. A declarative translation construct would be a second, weaker programming language.
  **When.** Never as a construct.

### 2.13 Command

- **What.** "A command is a simple object with a name of an operation and the data required to perform
  that operation. Many think of Commands as being Serializable Method Calls ... Commands ... are always
  in the imperative tense ... the Application Server is allowed to reject the Command" (Young CQRS
  pp. 11–12). Meyer's command-query separation underlies it ([CQRS][f-cqrs]).
- **Mesh today.** Every write action is a command in this sense ([Using your domain][d-using]). The
  *serialised* form (`{ action, input }` that can be queued, logged, deduplicated or dispatched) does
  not exist. The "action manifest for generic dispatch" first appears in roadmap revision 5, from gap
  G14 (gap analysis row 3.2; roadmap §6 "the action manifest for generic dispatch of 61 RPC actions";
  [ADR-0075] consequences), listed after 1.0 and out of scope for revision 5's M6.
- **Form.** Generated code only: `Command` and `Query` unions over the calls a surface exposes and a
  `dispatch(command, context)` per surface (section 4). No `command` declaration inside an entity: the
  action is the command's definition. The `command` *member* of a service (section 3) is a write
  operation no single entity owns.

  > **Replaced by a ruling.** `command` and `event` are declarations in their own files, and an action names the commands it answers with `handles=[...]`. See [ADR-0079] (DOM-17).
- **Ring.** Core (generated). **Hyper.** v0 is commands with an envelope (`commandId`, `actor`,
  `caller`, `expectedVersion`, `payload`; §4.1) and idempotency in the command's transaction (§4.3),
  done in application code. **When.** After 1.0, with surfaces.

### 2.14 Query

- **What.** The read side of CQS and CQRS: "the Query side will only contain the methods for getting
  data" (Young CQRS pp. 19–20; [CQRS][f-cqrs]).
- **Mesh today.** Read actions, called with plain-data `filter`, `sort`, `limit`, `offset`, `load`
  ([Entities: reads][d-reads], [Using your domain: filters][d-filters]).
- **Form.** Exists for one entity. A read whose result is not one entity's records (Hyper's `task.get`
  with history, `task.next`) is a `query` member of a service (section 3). **Hyper.** Yes; the gate
  writes them as application code (G27). **When.** Reads now; service queries after 1.0.

### 2.15 Read model or projection

- **What.** CQRS: "you can use a different model to update information than the model you use to read
  information" ([CQRS][f-cqrs], 2011); Young's "Thin Read Layer" (Young CQRS p. 21). A projection is a
  read model built by applying events. Fowler: "For most systems CQRS adds risky complexity"
  ([CQRS][f-cqrs]).
- **Mesh today.** Computed fields and rollups give derived values on the same model
  ([Entities: computed][d-computed]).
- **Form.** Own file kind from an extension: `projection :Name` with attributes (its table) and one
  `handle` block per event it consumes. A `handle` names the row it updates with `key=`, a function of
  the event returning the projection row's id; that row is the handler's `self` (created with its
  defaults when absent), so `&openTasks` reads and `set` writes it as in an entity's `do`.
  Callers get generated reads and no writes. **Ring.** Extension (`@meshfw/cqrs`). **Depends on.**
  Domain events, outbox or event store. **Hyper.** No (the Task view is computed in memory, M7).
  **When.** After 1.0.

  > **Names.** The block that updates a read-model row is called `apply`, not `handle`, and the one that runs commands is `process` ([ADR-0083], DOM-05). The syntax inside a projection is still the extension's to settle ([ADR-0081]).

```mx "src/domain/work/open-work.mesh.mx (sketch; extension @meshfw/cqrs)"
import { Task } from "./task.mesh.mx"

projection :OpenWork
  attributes
    uuid :id primary-key
    integer :openTasks default=0
  handle entity=Task event=:completed key=({ event }) => event.workspaceId
    set
      &openTasks=() => &openTasks - 1
```

(The event declares `workspaceId` in its payload (2.8), so `key=` reads a field the event carries.
`&openTasks` is a member of the projection, read on the row `key=` selects; see the `&` rule in 6.5
item 2. The `&`-trigger form of `set` lines comes from MX later, as for entities.)

### 2.16 Event store

- **What.** "Capture all changes to an application state as a sequence of events ... We can discard
  the application state completely and rebuild it by re-running the events from the event log on an
  empty application" ([Event Sourcing][f-es], 2005). Young's event store is two relational tables keyed
  by aggregate id, with a per-aggregate `version` tested against the expected version (Young CQRS
  pp. 41–43).
- **Mesh today.** State is primary. Hyper's Event table is an event log beside state, not event
  sourcing (the same question split the Ash community over AshEvents: [Ash ecosystem research][a-ash-eco]
  §4.1).
- **Form.** An adapter contract (`appendToStream(stream, expectedVersion, events)`, `readStream`)
  owned by the event-sourcing extension, plus an option it contributes to the entity line (`sourced`)
  that turns the entity's generated actions from row writes into event appends, with state folded from
  events through an `apply` body on each event. **Ring.** Extension (`@meshfw/event-sourcing`), store
  adapters. **Hyper.** No. **When.** After 1.0.

### 2.17 Snapshot

- **What.** "A Rolling Snapshot is a denormalization of the current state of an aggregate at a given
  point in time ... used as a heuristic to prevent the need to load all events for the entire history
  of an aggregate" (Young CQRS p. 33).
- **Form.** An option the event-sourcing extension contributes to `sourced` entities (`snapshot
  every=500`). **Ring.** Extension. **Hyper.** No. **When.** After 1.0.

### 2.18 Upcaster

- **What.** A function that converts a stored event of an old schema version into the current one when
  read, so old events never need rewriting. Young Versioning covers it (its table of contents has
  "Upcasting" sections; the text was not read for this page). Hyper already carries `schemaVersion` on
  events (§6).
- **Form.** A construct inside an event declaration, contributed by the event-sourcing extension:
  `version=2` on the event plus an `upcast from=1` body. **Ring.** Extension. **Hyper.** No. **When.**
  After 1.0.

```mx "src/domain/work/task.mesh.mx (excerpt, sketch; extension @meshfw/event-sourcing)"
events
  event :completed version=2
    &id
    uuid :completedBy
    upcast from=1 ({ payload }) => ({ ...payload, completedBy: null })
```

### 2.19 Process manager, saga, reactions, and the planned `after-commit` step

- **What.** Process Manager: "Use a central processing unit, a Process Manager, to maintain the state
  of the sequence and determine the next processing step based on intermediate results" (Hohpe and
  Woolf, *Enterprise Integration Patterns*, 2003,
  <https://www.enterpriseintegrationpatterns.com/patterns/messaging/ProcessManager.html>). Saga: a
  long-lived transaction split into short transactions, each with a compensating transaction run in
  reverse on failure (Garcia-Molina and Salem, "Sagas", SIGMOD 1987,
  <https://dl.acm.org/doi/10.1145/38714.38742>). A *reaction* is the stateless case. EventStorming
  names it a **policy** (Alberto Brandolini, *Introducing EventStorming*, Leanpub, ch. 14 "Policies");
  the definition used here is secondary: "A policy is a reaction that says 'whenever X happens, we do
  Y'", drawn on a lilac sticky note (DDD Crew, *EventStorming Glossary & Cheat sheet*,
  <https://github.com/ddd-crew/eventstorming-glossary-cheat-sheet>).
- **Mesh today.** Synchronous reactions have a home: a `run [after=:write]` step calling another action
  through `actions` ([ADR-0068]); Hyper's 13 cascades are this. [ADR-0053] also plans an
  `after-commit(...) { }` step inside `do`. Workflows and jobs are deferred ([ADR-0023]).
- **After-commit work would have four spellings** if everything proposed here were added: the planned
  `after-commit` step, the `afterCommit` seam ([ADR-0075]), asynchronous reactions, and surface
  `publish`. Each serves a different reader, so this page proposes:
  - **Drop the planned `after-commit` step.** It is not durable (a crash after commit loses it), and
    its typical uses (send an email, call an API) are non-domain work, which belongs in an application
    service (3.6) or the `afterCommit` seam. Durable domain reactions are `emit` plus a reaction.
  - **Synchronous reactions: nothing new.** They are cascades.
  - **Asynchronous reactions:** a `react` block in a service (after commit, a new transaction, via the
    outbox), contributed by the workflows extension. Not `on`, which already means two things
    (`on=:create` on a timestamp, `on:load`).
  - **Sagas and process managers:** a `workflow` file kind from the workflows extension; its state is
    the engine's ([durable engines][a-durable]).
  > **Replaced by a ruling.** The planned `after-commit` step is dropped, and the `afterCommit` seam is not used for this either. An effect after commit is a `publish` plus a listener; `emit` became `publish`, and `react` became `process` (a handler that runs commands) or `apply` (one that updates a read-model row). Step files are dropped as well (see 2.7). See [ADR-0079], [ADR-0083], [ADR-0053] (amended) (DOM-25, DOM-05).

- **Ring.** Extension (`@meshfw/workflows`, owning reactions, jobs and workflows) with runner adapters.
  **Hyper.** No; lease expiry is an application timer (G17). **When.** After 1.0. Decision D16.

### 2.20 Outbox

- **What.** "The solution is for the service that sends the message to first store the message in the
  database as part of the transaction that updates the business entities. A separate process then
  sends the messages to the message broker" (Chris Richardson,
  <https://microservices.io/patterns/data/transactional-outbox.html>).
- **Mesh today.** After 1.0 ([ADR-0023]; roadmap §6). ADR-0023 records a provisional sub-decision
  "Outbox in core (Q7)". `afterWrite` can already write an outbox row in the transaction.
- **Form.** No file kind. An extension that persists published events and serialised commands through
  `afterWrite`, and a relay. **Ring.** Extension: Mesh runs without it, so ADR-0023's provisional line
  should be revisited (decision D15). **Hyper.** No. **When.** After 1.0.

> **Replaced by a ruling.** The outbox is core, and it comes with domain events in M6: `publish` writes to it and an event bus delivers from it ([ADR-0079], DOM-06). [ADR-0023]'s provisional "outbox in core" line stands, and its "after 1.0" does not.

### 2.21 Jobs and workflows

- **What.** A job is a command run later or on a schedule; a workflow is a durable multi-step process
  ([durable engines][a-durable]; [ADR-0023]).
- **Form.** A job is a serialised command (2.13) handed to a runner. A *schedule* is an entry point
  that calls actions on the system's behalf, so it belongs in a surface (`schedule :sweepLeases
  every="1s" ...`), with the scheduler as an adapter. Workflows are the `workflow` file kind.
  **Ring.** Extension, runner adapters. **Hyper.** The lease sweeper is application code. **When.**
  After 1.0.

### 2.22 The app file

Section 4. Own file kind, recommended name `surface`; the format and manifest are core; every reader
is an adapter.

### 2.23 Concepts the brief did not list

- **Invariant.** "An invariant is a business rule that must always be consistent" (Vernon EAD I p. 3).
  Mesh: a `check` or a one-field rule ([ADR-0053]). Covered.
- **Unit of work / transaction.** Mesh: one transaction per call, re-entrant `transaction` for the
  application ([ADR-0068]). Covered.
- **Optimistic concurrency.** Young's expected-version test (CQRS p. 43); Hyper's `expectedVersion`
  (§4.1, §4.5). A recipe today (G02), `lock="version"` planned ([ADR-0053]); ties to aggregates.
- **Idempotency key.** Hyper §4.3. A surface or adapter option, implemented by writing the result in
  the command's transaction through `afterWrite`. Application code until then.
- **Causation metadata.** Hyper's `cause` (§6). Core event metadata carries the causing command or
  event; `caller` stays an application context key.
- **State machine.** After 1.0, a section inside the entity (roadmap §6, G03).
- **Identity (natural key).** After 1.0 (G08).

### 2.24 Architecture rules (the `arch.mesh.mx` idea)

> **Ruled in part.** The rule language, its engine and the presets are **core**, not an extension, and Mesh uses them to guide users and agents; the file is `architecture.mesh.mx` with root `architecture :name`. When they are built is open. See [ADR-0084] (DOM-30, DOM-10). The ring analysis below proposed the split that was not taken.

The idea, raised on 2026-10-10 as a view to evaluate, was an `arch.mesh.mx` file
holding architecture rules. Mesh fills it with its own recommendations, rule sets merge through `use`,
and users add rules. The original sketch:

```text "original sketch (verbatim)"
rule-set :onion-arch
  rule :"Domain Can't Require Any Layers"
    files inFolder="domain"
      @should not
      @depend-on
        @files inFolder="surfaces"
```

- **What.** Architecture fitness rules checked against the code's dependency graph: Evans's layered
  architecture ("Develop a design within each layer that is cohesive and that depends only on the
  layers below", DDD Reference p. 10) made executable, as ArchUnit does for Java and ts-arch
  (`tsarch` on npm, <https://github.com/ts-arch/ts-arch>; its fluent API is `filesOfProject()
  .inFolder(...).shouldNot().dependOnFiles().inFolder(...)`, which the original sketch mirrors) and
  ArchUnitTS (`archunit` on npm, <https://github.com/LukasNiessen/ArchUnitTS>) do for TypeScript.
  These are prior art only: Mesh uses none of them as an engine ([ADR-0084]).
- **Mesh today.** Nothing. This page already depends on such rules in three places: the domain never
  imports a surface (6.3); a service's helpers must not import the data layer and must not hold
  module-level state (3.2); and the import rule for `.mesh.mx` files (only relative imports inside
  `src/domain/`, [Entities: the shape of a file][d-shape]) is a built-in architecture rule already.
- **A position, weighed point by point.**
  1. **`use :mesh-recommended` instead of a pre-filled copy**, as eslint's `extends` works, so the
     rules upgrade with Mesh, and the user can change a rule's severity or turn it off. Agreed: a
     copied file freezes on the day it was generated and drifts from Mesh's own layout.
  2. **Two tiers.** Mesh's semantic invariants (a service holds no state; `&` reads a value only
     where a `self` exists; a domain file imports only inside the domain) are built-in errors that no file can
     remove; the file holds recommendations and user rules. Agreed, and it follows the fail-closed
     reasoning of [ADR-0055]: a rule whose removal would let Mesh generate wrong code is not a
     preference.
  3. **Mesh line syntax with atoms**, not a nested fluent chain. Layers are declared once and referred
     to by atom; a rule's name is an atom slug plus `message=`. Agreed: the original sketch has three
     problems in Mesh's syntax. `:"Domain Can't Require Any Layers"` is a sentence where Mesh uses an
     atom name plus `message=` (as `check` does, [ADR-0053]); `@should not` / `@depend-on` are MX
     attribute tags used as words of an English sentence, a second grammar inside the file; and
     `inFolder="domain"` repeats a path in every rule.
  4. **`mesh build` checks the rules against the import graph**, so the editor, the CLI and CI give the
     same positioned diagnostics, with no generated test files. Agreed, and settled by a ruling:
     the engine is Mesh's own checker over the import graph and the model, with no
     third-party rule library. That is a deliberate exception to "established tools first"
     ([ADR-0030]): the rules refer to Mesh concepts (point 5), which no general tool knows.
  5. **Rules can refer to Mesh concepts** (entities, services, surfaces, modules), not only folders.
     Agreed: this is what a generic tool cannot do, and it is the reason to have the file in Mesh at
     all. "No module imports another module's helpers", "a surface exposes no entity of module X",
     "only the `work` module's services may call `Claim` actions" are checkable from the model.
- **Form.** Its own file kind. Root tag `architecture` (or `arch`), one file at the project root or
  `src/`, recommended name `architecture.mesh.mx`. Layers can be folders or Mesh concepts.
- **Ring.** Proposed as a split: the built-in invariants are **core** (they are the compiler's own
  checks, mostly existing or proposed in this page); the rule language, its engine and the presets are
  an **extension** (`@meshfw/architecture`), because Mesh runs without them. **Depends on.** The import
  graph, the model, the root-tag dispatch (6.2). **Hyper.** No. **When.** After 1.0.

```mx "architecture.mesh.mx (sketch)"
import { Claim } from "./src/domain/work/claim.mesh.mx"

architecture :hyper
  use :mesh-recommended
    severity :domain-is-independent level=:error
    disable :no-cross-module-helpers

  layers
    layer :domain path="src/domain"
    layer :surfaces path="src/surfaces"
    layer :work path="src/domain/work"

  rules
    rule :surfaces-stay-thin message="a surface's services may not call the data layer"
      forbid from=:surfaces to=:data-layer
    rule :claims-owned-by-work message="only the work module calls Claim actions"
      only from=:work calls=Claim
```

(`:data-layer` would be a built-in layer the preset defines. A module is named by its path, not by a
`module=` atom, which [ADR-0057] and [ADR-0067] rule out; an entity is an import in value position
(`calls=Claim`), as everywhere else. Importing from outside `src/domain/` needs the same import-rule
extension as surfaces, 6.3.)

## 3. Services

### 3.1 Three meanings, and a fourth view

| Meaning | Source | Defining property |
|:--|:--|:--|
| Domain service | Evans ch. 5; DDD Reference p. 14 ("Sometimes, it just isn't a thing"); Vernon ch. 7 | Stateless domain logic, named for an activity, that belongs to no single entity or aggregate. Evans: "add an operation to the model as a standalone interface declared as a service" |
| Application service | Evans ch. 4–5 (the application layer); Vernon ch. 14; Fowler PoEAA *Service Layer* (Randy Stafford): "Defines an application's boundary with a layer of services that establishes a set of available operations and coordinates the application's response in each operation" ([catalogue][f-servicelayer]) | A thin coordinator per use case: transaction, security, delegation to the domain. Evans, quoted by Fowler: the application layer "does not contain business rules or knowledge, but only coordinates tasks" ([AnemicDomainModel][f-anemic]) |
| Grab-bag service class | Common industry usage (a NestJS or Spring `UserService` per entity) | Groups many operations, often holding the domain logic |

Fowler's anemic-model critique targets the third, not grouping as such: in an anemic model "there are
a set of service objects which capture all the domain logic, carrying out all the computation and
updating the model objects with the results", and "if all your logic is in services, you've robbed
yourself blind" ([AnemicDomainModel][f-anemic], 2003).

**The view that a service groups operations, taken at its strongest.** A service groups related operations under one name.
That is not the grab-bag: Evans's service is an *interface*, and Vernon's domain services commonly
expose several operations on one interface. Grouping gives a reader one place to see a use-case
family (`Work.submit`, `Work.complete`, `Work.next`), one place for the policies they share, and one
name in surfaces and generated code. What would make it anemic is single-entity logic living in it,
and the rules below prevent that whether operations are grouped or not.

**The preference for Vernon's split** between domain and application services fits Mesh closely, and it is the one that was ruled (DOM-14, [ADR-0078]):

- **Mesh already generates the application service.** Each generated action function opens or joins
  the transaction, applies policies, validates input and runs the steps ([ADR-0053], [ADR-0055],
  [ADR-0068]); a surface chooses which use cases an audience reaches. One correction to "application
  service = what Mesh generates": Vernon's application service *delegates to* an aggregate method,
  while a Mesh action *fuses* the aggregate method (its checks and steps) with the wrapper. So the
  generated **wrapper** (transaction, policies, validation) is the application service; the action's
  body is domain logic. The same split holds for a service operation: the user writes the body (domain
  logic), Mesh generates the wrapper. That matches Vernon's point that domain services do not manage
  transactions or security.
- **The `service` file is the domain service.** Stateless, cross-entity, writing only through entity
  actions.

### 3.2 The recommendation

- `service :Name` is the root tag. Its members are `command :name` (writes) and `query :name` (reads
  only, through `tx`), one per operation, which keeps command-query separation. Several members per
  file are allowed (the grouping the view above asks for).
- "Application service" is a docs term only, never a tag: "Mesh generates your application services:
  the transaction, policies and validation around each action and each service operation, and the
  surfaces that expose them."
- **Stateless by grammar.** The `service` contract has no `attributes`, `relationships`, `events` or
  `computed` children (`unknownTags: "reject"`), so state is a positioned build error. Two limits are
  stated, not hidden: module-level mutable state in a helper is undetectable (a convention, later an
  architecture lint), and helpers are ordinary TypeScript that can import anything (the `.mesh.mx`
  import rule keeps `#mesh` and the data layer out of the service file itself, not out of helpers).
- **Writes only through entity actions.** No `set`, no data layer, no `self`. A service's commands,
  queries and policies are its members, so `&submit` may name one (for example in a policy's
  `actions=[&submit]`), but `&` never reads a value in a service, because there is no record.
  Every write runs the target action's own validation and policies, as a cascade does ([ADR-0068]).
- **Declared and enforced dependencies.** Each operation declares one `call entity=X actions=[...]
  reads=[...]` line per entity it uses (`actions=` for writes, `reads=` for `tx` reads), and the
  generated `actions` and `tx` handles it receives contain **only** those entries. *Ruled: the
  declared dependencies stay, and the keyword is `uses`, not `call`, because the line also lists
  entities that are only read ([ADR-0078], DOM-16, DOM-01).* An undeclared call, even from inside a helper typed with the generated handle, fails `tsc`
  in `bun run verify`, and the run-time handle carries nothing else. Scanning the `run` body would be
  unsound: the sketch below passes `actions` and `tx` straight to a helper.
- **The single-entity warning** is computed from the declaration: warn when its `call` lines name one
  entity, unless the operation's `output` is not that entity's record (Hyper's `warnings`, `outcome`;
  entity actions cannot return such a result, so the operation has no other home). A warning, with a project option to make it an error (decision D6). *Ruled: a warning that
  `architecture.mesh.mx` can switch off ([ADR-0078], DOM-16).*
- **Own policies**, fail closed ([ADR-0055]). An `always`-style shared policy section at service level
  is possible later.
- **It reverses roadmap §6's "manual and generic actions: not planned"** (accepted 09:05). A service
  operation (arbitrary input, a `run` body, a declared output) is Ash's generic action in all but
  placement. The reasons to reverse it: Evans's "it just isn't a thing" operations otherwise get forced
  onto an arbitrary entity, and non-record results (G25) stay outside Mesh with no input validation, no
  policies and no surface. D4 carries the §6 amendment, and [ADR-0068] decision 1 ("`tx` ... available
  only to code written in the entity file") gains "or a service file".

### 3.3 Cascade or service operation: one home each

Both can write several entities in one transaction, so a rule must separate them (decision D5):

- **A cascade** is an entity action whose core is a write to *its own row*, with consequences for
  other entities: `Task :complete` sets the task done, then records a Completion and releases the
  Claim. It stays in the entity as `run [after=:write]` ([ADR-0068]).
- **A service command** has *no leading row*: it decides which entities to write (`submitWork` chooses
  `Submission :submit` or `Claim :recordLateResult`), or it returns something that is not one entity's
  record (`warnings`, `outcome`).
- **Checkable part:** a service command whose `call` lines name one entity and whose output is that
  entity's record gets the warning above. The "own row" half is a judgement the docs state; the build
  cannot tell whether a `run` step is "consequence" or "core".

### 3.4 Options (decision D4)

| Option | What | For | Against |
|:--|:--|:--|:--|
| A | Nothing new: cascades plus application code over `transaction` | True today; no new vocabulary | Activity-shaped operations forced onto an entity; non-record results invisible to Mesh and surfaces |
| **B** | `service :Name` (domain service, Vernon) with `command`/`query` members, grouping allowed, rules of 3.2 | The grouping the view asks for and the Vernon split; one home per operation with 3.3; checkable | New file kind; reverses §6 "generic actions" |
| C | As B but one `command`/`query` per file, no `service` word | Avoids an overloaded word | Loses the grouping; still reverses §6 |
| D | `service` grouping any operations, single-entity ones included | Familiar to NestJS/Spring users | Second home for single-entity operations; anemic drift |

**Recommendation: A for 1.0, B after 1.0.** *Outcome: the shape and the timing are open (DOM-09); until services exist, option A's plain code over `transaction` is what the three-way split names ([ADR-0078]).* The word "service" stays overloaded in general (it is also
microservices' deployable unit), but binding it to Vernon's domain service in the docs removes the
ambiguity inside Mesh.

```mx "src/domain/work/work.mesh.mx (sketch, option B; the call lines became uses)"
import { Submission } from "./submission.mesh.mx"
import { Claim } from "./claim.mesh.mx"
import { Task } from "./task.mesh.mx"
import { submitOrRecordLate, nextReadyTask } from "./work.helpers"

service :Work
  command :submit
    call entity=Submission actions=[:submit]
    call entity=Claim actions=[:recordLateResult] reads=[:read]
    input
      uuid :taskId
      integer :fence nullable
      string :summary
    output
      enum :outcome values=[:submitted, :lateResultRecorded]
      uuid :submissionId nullable
    policies
      policy :members
        authorize-if=({ actor }) => actor.membership !== null
    run({ input, actions, tx }) {
      return submitOrRecordLate(input, actions, tx)
    }

  query :next
    call entity=Task reads=[:read]
    call entity=Claim reads=[:read]
    output
      uuid :taskId nullable
    policies
      policy :members
        authorize-if=({ actor }) => actor.membership !== null
    run({ actor, tx }) {
      return nextReadyTask(actor, tx)
    }
```

(Each `call` line keeps the imported entity in value position and names its members with atoms, the
[ADR-0067] and [ADR-0070] pattern; a capitalised line such as `Submission=[:submit]` would parse as a
component tag, which the MX data target rejects. `actions=` fills the narrowed `actions` handle,
`reads=` the narrowed `tx`. Generated names follow the flat namespace of D20 item 1, for example
`submitWork`.)

### 3.5 Where service files live (decision D3, both positions)

*Ruled: the second position. Domain services live in their module folder and application services with their surface ([ADR-0078], DOM-13).*

- **The first position:** domain services in `src/domain/services/`; application services in
  `src/apps/<name>/services/` (or under surfaces).
- **The second:** agrees on application services; disagrees on domain services, which belong in their
  module folder, `src/domain/<module>/<name>.mesh.mx`, because (1) [ADR-0057] reads every folder under
  `src/domain/` as a module, so `services/` would be a module named "services"; (2) Evans and Vernon
  name modules after domain concepts, not building-block types ("Choose modules that tell the story of
  the system", DDD Reference p. 15); (3) the root tag already says the file is a service.
- **This page recommended the second position** for the same three reasons, and adds that a Work
  service next to Task, Claim and Submission is read with the entities it orchestrates.

### 3.6 Application services written by the user

Separate from the generated wrappers, an application may need a use case that combines several actions
with non-domain work (send an email, call an external API). The view this page adopts:
these are user-written, per surface, thin, and live with that surface (`src/surfaces/<name>/services/`
under D1's name; ruled, [ADR-0078]). Orchestration two surfaces need moves into the domain as a service operation, and
the domain never imports a surface. Whether a surface can expose such a TypeScript function directly
(with an input schema), or only domain actions and service operations, is open; recommended: allow it,
with a Standard Schema input, so the surface stays the one list of what an audience can call.

## 4. The app file

### 4.1 What it is

One file per audience-specific entry point. It lists what that audience may call and see, under which
names, grouped how, with options per transport and hints for a generated admin UI. Elysia, oclif, a
JSON-RPC adapter and a future admin UI generator read it. Nothing is exposed unless listed.

In DDD terms it is an **Open-host Service** with a **Published Language** (DDD Reference pp. 35–36).
Ash has the same split: AshTypescript declares its RPC surface in the *domain*
(`typescript_rpc do resource MyApp.Todo do rpc_action :list_todos, :read ...`), not in resources
([Ash ecosystem research][a-ash-eco] §7). Field lists in the surface replace [ADR-0035]'s proposed
per-attribute `public` flag ("decided with the first transport"), so D12 supersedes ADR-0035 (ruled, [ADR-0077]).

### 4.2 Contents

> **Changed by a ruling.** The "Published events" row is `publishes events=[:completed, :updated]` in the ruled syntax, naming events declared in `event` files ([ADR-0077], [ADR-0079]; DOM-02). `fields=[...]` or `fields=:all` is ruled as written (DOM-22). The other sketches below keep the study's spelling.

| Part | Lines | Notes |
|:--|:--|:--|
| Identity | `surface :admin` | One per file |
| Adapters | `adapters` section: `http prefix="/admin"`, `jsonrpc socket=:unix`, `cli bin="hyper"`, `admin-ui` | Each tag contributed by its adapter through a contribution point ([ADR-0020]) |
| Groups | `expose :tasks entity=Task`, `expose :work service=Work` | The group name feeds wire names (`task.set-priority`) |
| Exposed calls | `action :complete`, `action :list from=:read`, `name="set-priority"` | `:name` declares the exposed name; `from=` is an atom naming the entity's action or service operation when names differ ([ADR-0070] pattern) |
| Fields | `fields=[:title, :state]` or `fields=:all` | Fail closed (D12) |
| Per-transport options | `http method=:post path="/tasks/:id/complete"`, `cli command="task:complete"` | Contributed by the adapter |
| Presentation hints | `label=`, `columns=[...]`, `form fields=[...]`, `help=` | Read by the admin UI adapter; defaults from value types and Concepts |
| Published events | `publish :claimAcquired entity=Claim event=:acquired` | Integration events (2.9) |
| Schedules | `schedule :sweepLeases every="1s" ...` | Jobs; the scheduler is an adapter |

A surface declares no behaviour: no checks, no steps, no policies. It narrows what an audience can
reach; it never widens what policies allow.

```mx "src/surfaces/admin.mesh.mx (sketch)"
import { Task } from "../domain/work/task.mesh.mx"
import { Membership } from "../domain/team/membership.mesh.mx"

surface :admin
  adapters
    http prefix="/admin"
    admin-ui title="Hyper admin"

  expose :tasks entity=Task label="Tasks" fields=:all
    action :list from=:read columns=[:title, :state, :priority]
    action :create
      form fields=[:title, :priority, :parent]
    action :cancel label="Cancel task"
      http method=:post path="/tasks/:id/cancel"

  expose :memberships entity=Membership fields=[:role, :collaborator]
    action :changeRole name="change-role"
```

```mx "src/surfaces/engine.mesh.mx (sketch: Hyper's v0 wire)"
import { Task } from "../domain/work/task.mesh.mx"
import { Claim } from "../domain/work/claim.mesh.mx"
import { Work } from "../domain/work/work.mesh.mx"

surface :engine
  adapters
    jsonrpc socket=:unix idempotent

  expose :task entity=Task fields=:all
    action :create
    action :setPriority name="set-priority"
  expose :claim entity=Claim fields=:all
    action :acquire
  expose :submission service=Work
    action :submit

  publish :claimAcquired entity=Claim event=:acquired name="claim.acquired"
```

### 4.3 How adapters read it

At build time each surface becomes a typed view (as emitters already work, [ADR-0061]) written to
`.mesh/surfaces/<name>/`: a plain-data `manifest.ts` (one entry per exposed call: wire name, generated
function, input validator, output schema, adapter options, hints; published events; schedules; the
`Command`/`Query` unions and `dispatch()`), plus whatever the surface's adapters emit (Elysia routes,
oclif command classes, a JSON-RPC method table, admin UI pages). At run time an adapter imports that
folder and `@meshfw/runtime` only, never the model ([ADR-0033], [ADR-0003]). The core interface stays a
function call ([ADR-0005]).

### 4.4 Relation to the action manifest

The action manifest for generic dispatch is gap G14's after-1.0 item, introduced in roadmap revision 5
(not in revision 4, whose M6 was the extension host and whose "manifest" was the extension contribution
manifest). The surface is the form that item takes: one manifest per surface, generated from the
surface file. There is no global *exposure* manifest, because one would expose everything.

Two ruled records assume a whole-model view and need reconciling:

- [ADR-0027]: "later a CLI adapter generated from the action list". Proposed amendment: the agent CLI
  is generated from a surface (`surface :agent`), so it follows "nothing exposed unless listed".
- Roadmap §6, "agent and test surface" (`.mesh/rules.md`, test data builders): these are tooling, not
  exposure, and keep reading the whole model through `.mesh/model.json`, which exists today.

### 4.5 Names (decision D1)

| Name | For | Against |
|:--|:--|:--|
| `app` | The brief's working name and its location sketch (`src/apps/<name>/`) | Clashes with the monorepo's `apps/`, with "your app" and "one domain per app" ([ADR-0057], [project structure][d-structure]), and with the separate user-facing app that is out of scope for Mesh |
| **`surface`** | Already the docs' loose word ("agent surface" in [ADR-0027], "RPC surface" in the gap analysis); no clash in TypeScript, DDD or the repo | Less familiar; abstract |
| `interface` | Accurate | TypeScript's `interface` keyword |
| `api` | Familiar | Implies HTTP; a CLI or admin UI is not usually called an API |
| `port` | Hexagonal architecture's word | Clashes with "the Hyper port" and sits beside Mesh's "adapter" |

**Recommendation: `surface`**, files in `src/surfaces/` (a file per surface, or a folder per surface
once it has application services, 3.6).

### 4.6 Ring, and the texts it changes

The surface format, contract, view and manifest emitter are **core**, as the transport contract every
transport adapter implements ([ADR-0001]); every reader is an **adapter**. Because D11 was ruled as proposed, these texts change (the record
lists which have been edited and which wait for their user-docs pages, [ADR-0077]):

- Roadmap principle 8 ("No application concerns in core ... how a program is exposed"): becomes "core
  declares exposure as data; transports are adapters".
- Roadmap §6 "Not planned at all: ... an admin interface": becomes "an admin UI adapter reads a
  surface; after 1.0". This is a third §6 reversal.
- [Project structure][d-structure]: "Mesh prescribes nothing under `src/` ... what matters is that the
  domain folder is where the `.mesh.mx` files are": both halves change with `src/surfaces/`.
- [Using your domain][d-using], "From a command line" and "Over HTTP": "oclif owns argument parsing and
  command registration, not Mesh" and "These excerpts show calls, not ready-made Mesh integrations":
  rewrite once adapters generate from surfaces (the hand-written form stays valid).
- [ADR-0027]: the amendment in 4.4.

## 5. Name clashes (decision D19)

> **Ruled.** The table is accepted for the port, with the words that changed (`publish` for `emit`, `process` for `react` and `apply` for `handle`, `uses` for `call`, `concept` for `value`, `mixin` for fragments). A repository construct may come later. See [ADR-0083] (DOM-29, DOM-27).

| Word | Meanings in play | Resolution |
|:--|:--|:--|
| **policy** | Mesh authorization ([ADR-0055]); EventStorming reaction; Evans ch. 12 Strategy "a.k.a. Policy" | `policy` is authorization only; a reaction is a listener, `apply` or `process` (the study proposed `react`; [ADR-0083]) |
| **repository** | DDD repository; Mesh's generated functions; the data layer | Mesh never uses the word; docs map it to the generated reads and writes |
| **app** | Ruling-1 file; `apps/`; "your app"; application service; "the Hyper application" | Name the file `surface`; keep "application" for the user's program |
| **service** | Domain, application, grab-bag class, microservice | `service` = Vernon's domain service; "application service" = the generated wrapper, docs only |
| **command** | CQRS message; an entity write action; a service `command` member; oclif's `Command` class and `src/commands/` in the docs' oclif example | Every write action is a command; a `command` member is one no single entity owns; the docs' oclif example keeps its own names |
| **action / operation** | Mesh action = one named operation on an entity ([ADR-0005]) | Keep; service members are commands and queries |
| **event / change** | Seam payloads (row writes); declared domain events; Hyper's `Event` entity | A *change* is a row write; an *event* is a declared domain event |
| **aggregate** | DDD aggregate; Ash's aggregates | Free: Mesh calls Ash's aggregates *rollups* ([ADR-0050]); warn Ash users in the [vocabulary mapping][vocab] |
| **context** | Action context; bounded context | `context` is the action context; write "bounded context" in full |
| **domain** | Mesh's `src/domain/`; Ash's domain; DDD's problem domain | A Mesh domain is one bounded context's model |
| **module** | Mesh folder; Evans's Module; ES modules | Same as Evans's; no change |
| **adapter / port** | Mesh ring; hexagonal; the Hyper port | Name nothing "port" |
| **step** | `do` step; `step` file; workflow step | Decide with the workflows ADR |
| **on** | `on=:create`; `on:load`; proposed reactions and projection handlers | Use `process` and `apply` (proposed as `react` and `handle`, in that order), not `on` ([ADR-0083]) |
| **check** | Mesh validation; Hyper's checks, which are every named rule across its four phases (§4.4, §7.1: `claim.assignee`, `expected-version`, ...) | Hyper's checks map to Mesh `check`s, policies and named checks (G04); the shared word is accurate |

## 6. The target project structure

### 6.1 File kinds

> **Ruled file kinds** (each record is the reference): `entity`, `aggregate`, `concept`, `mixin`, `command`, `event`, `surface` and `architecture` ([ADR-0077], [ADR-0079], [ADR-0080], [ADR-0082], [ADR-0084]). `service` is proposed, and its shape is open ([ADR-0078]). No record rules on `projection` and `workflow`. The table below is the study's.

| Kind (root tag) | Where | Ring | Owner | When |
|:--|:--|:--|:--|:--|
| `entity` | `src/domain/<module>/` | core | core | now |
| `step` ([ADR-0053]) | `src/domain/<module>/` | core | core; extensions add steps | **dropped** (reuse is a TypeScript helper or a mixin, [ADR-0082]) |
| `value` | `src/domain/<module>/` | core | core | became `concept` ([ADR-0080]) |
| `service` (`command`, `query` members) | `src/domain/<module>/` (D3) | core | core | after 1.0 (D4) |
| `surface` | `src/surfaces/` | core format; adapters read | core | after 1.0 |
| `check` (only if D18 picks MX files) | `src/domain/<module>/` | core | core; extensions add checks | not taken: named checks are a `checks` section ([ADR-0082]) |
| `projection` | `src/domain/<module>/` | extension | `@meshfw/cqrs` | after 1.0 |
| `workflow` | `src/domain/<module>/` | extension | `@meshfw/workflows` | after 1.0 |
| `architecture` | `architecture.mesh.mx` at the root (D22) | rule language: extension; invariants: core | `@meshfw/architecture` | after 1.0 (ruled: all core, timing open, [ADR-0084]) |

Constructs in existing kinds: `events` and `emit`, `part-of`, a `state-machine` section (core);
`sourced`, `snapshot`, `apply`, `upcast` (event sourcing); `react` in services (workflows); adapter tags
in surfaces. User-written application services (3.6) are TypeScript under `src/surfaces/<name>/`.

### 6.2 How a file's kind is recognised (decision D2)

*Ruled: option 1, the root tag ([ADR-0077], DOM-12).*

1. **Root tag** (recommended). The single root tag is the kind. One fact, one place: a suffix would
   repeat `service :Work` (the argument [ADR-0057] used to drop `domain=`). [ADR-0051] already treats
   step files this way ("Entity and step files end in `.mesh.mx`"). One dialect handles the whole
   file; the dialect's extension list stays open (as ruled on 2026-10-10).
2. **Suffix** (`work.service.mesh.mx`). Visible in a file list; two sources for one fact; MX's
   longest-suffix rule would still route it to Mesh.
3. **Folder** (`src/domain/services/`). Breaks modules as folders (3.5).

Not forced now: no second kind exists, so discovery can change when one arrives.

### 6.3 Layout

> **Changed by a ruling.** Concept files are dialect tags, found in a `concepts` directory that Mesh loads by itself ([ADR-0085], DOM-07), so `money.mesh.mx` would sit there and not be imported. The layout otherwise stands.

```text
my-app/
  .mesh/                         generated, committed, imported as "#mesh"
    index.ts
    work/  task.*.ts  claim.*.ts  work.service.ts
    surfaces/
      admin/  manifest.ts  routes.ts ...
      engine/ manifest.ts  methods.ts
    schema.ts  model.json  mx-contracts.js  rules.md
  migrations/
  mesh.config.ts                 domain, surfaces, data, extensions, seams
  src/
    domain/                      one bounded context
      work/                      the work module
        task.mesh.mx             entity :Task
        claim.mesh.mx            entity :Claim
        submission.mesh.mx       entity :Submission
        work.mesh.mx             service :Work
        work.helpers.ts
      billing/
        money.mesh.mx            value :Money (a concept after the ruling)
        invoice.mesh.mx          entity :Invoice
    surfaces/
      engine.mesh.mx             surface :engine (JSON-RPC)
      admin/
        admin.mesh.mx            surface :admin (HTTP, admin UI)
        services/
          invite-member.ts       application service: actions plus email
    extensions/
    context.ts
    main.ts
```

Import direction: a surface imports the domain; the domain never imports a surface (Evans's layered
architecture: each layer "depends only on the layers below", DDD Reference p. 10).

### 6.4 What an extension contributes

Through declared contribution points only ([ADR-0020]): new file kinds (`projection`, `workflow`),
constructs in existing kinds (on `entity`, on `event`, on the entity line, `react` in services), surface
tags (each transport adapter's tag and per-call options), emitters, and run-time halves. Core would
publish three points it does not plan today: the file root, the `event` declaration and the `surface`.
The extension host is after 1.0 (M11).

### 6.5 Decide now, or wait

> **Outcome.** Item 1 was ruled differently: the study recommended one flat namespace, and the ruling is folder modules, not a flat namespace (CMP-17, built). Item 2 was ruled (`&name` always refers to a member declared by the type it sits in). Item 3 was not taken: events are published through the outbox, so the seams need no `events` field (a consequence, not a ruling; [ADR-0079]).

**Decide now**, because each forces a refactor later:

1. **One flat generated namespace across entity actions and service operations.** `.mesh/index.ts`
   shipped in PR #54 and open finding 21 ([open questions][a-open]) is live; the rule should reserve
   names for service operations now.
2. **What `&name` means outside entity files.** Recommended: "`&name` refers to a member of the
   declaration the file defines; inside a function `&x` reads `self.x`, so it reads a value only where
   the function has a `self`." Every kind's declarations are its members (an entity's attributes,
   actions, checks and policies; a service's commands, queries and policies; a projection's
   attributes). Values exist to read only where there is a record: entity functions, a value's computed
   fields, and a projection handler, whose `self` is the row its `key=` selects (2.15). In a service or
   a surface `&` can name a member but never reads one. Members of another entity are atoms beside the
   entity reference. This rewrites the documented sentence "`&name` refers to a member of this
   entity" ([Entities: names and references][d-names]) and [ADR-0067] §1; D20 lists both edits. It
   decides the grammar of every future kind, and step files are already planned.
3. **Seam payloads and declared events** (D9). M6 builds the seams before the gate and Hyper binds to
   their signatures. Reserve `events` on both payloads now, with the meaning of 2.8: an event is
   recorded at its action's own row write, `afterWrite` (ADR-0075 timing unchanged) carries the events
   of the action whose row it is, and `afterCommit` lists every event of the call in emission order;
   empty until D8 lands; or decide that
   declared events get a seam of their own. Either is a line in [ADR-0075] today and a breaking change
   later.

A free extra while editing the docs: "every `.mesh.mx` file beneath it is an entity file"
([Configuration][d-config]) can become "every `.mesh.mx` file is a Mesh file; its root tag says which
kind".

**Can wait:** root-tag dispatch itself, `src/surfaces/` and its config key (configurable with a
default, same work later), the `.mesh/` layout (regenerated and guarded), reserved words (the
vocabulary is closed with `unknownTags: "reject"`, so only Mesh can take a word), the syntax inside
each kind, admin hints, event-sourcing details.

## 7. The decisions as proposed

The list below is the study's text, kept as proposed. The table at the top says what was ruled.

1. **D1. Name of the audience-specific file.** (a) `surface`; (b) `app`; (c) `interface`; (d) `api`.
   Recommendation: (a) (4.5).
   *Outcome: Ruled as recommended: `surface` ([ADR-0077], DOM-11).*
2. **D2. How a file's kind is recognised.** (a) root tag; (b) suffix; (c) folder. Recommendation: (a).
   *Outcome: Ruled as recommended: (a) ([ADR-0077], DOM-12).*
3. **D3. Where services live.** (a) `src/domain/services/` for domain services,
   `src/apps/<name>/services/` for application services; (b) domain services in their
   module folder `src/domain/<module>/`, application services with their surface
   `src/surfaces/<name>/services/`, the domain never importing a surface. Recommendation: (b) (3.5).
   *Outcome: Ruled as recommended: (b) ([ADR-0078], DOM-13).*
4. **D4. Services.** Options A–D of 3.4. Recommendation: A for 1.0; B after 1.0 (`service :Name`,
   Vernon's domain service, `command`/`query` members, grouping allowed, stateless by grammar). Amends
   roadmap §6 ("manual and generic actions: not planned") and [ADR-0068] decision 1 (`tx` in service
   files).
   *Outcome: Partly ruled. Services follow Vernon's definition (DOM-14); the shape and the timing are open (DOM-09) ([ADR-0078]).*
5. **D5. Cascade or service command.** (a) the rule of 3.3: an operation whose core is a write to one
   entity's own row is that entity's action with cascades; one with no leading row or a non-record
   result is a service command; (b) service commands for every cross-entity write, cascades limited to
   one entity's children; (c) no rule. Recommendation: (a).
   *Outcome: Ruled differently: a three-way split, with publish and listen for later effects (DOM-15; DOM-08 open) ([ADR-0078], [ADR-0068] amended).*
6. **D6. The single-entity check.** (a) a warning computed from the `call` lines with narrowed handles,
   suppressed for non-record output, opt-in error; (b) an error; (c) no check. Recommendation: (a).
   *Outcome: Ruled as recommended, with `uses` as the keyword and the warning switchable off ([ADR-0078], DOM-16, DOM-01).*
7. **D7. Command in core.** (a) generated only (`Command`/`Query` unions, `dispatch()` per surface); (b)
   a `command` declaration per entity action. Recommendation: (a).
   *Outcome: Ruled differently: `command` and `event` declarations in their own files, `handles=[...]` on the action ([ADR-0079], DOM-17).*
8. **D8. Domain events.** Form: (a) `events` section and `emit` step, events as members (`&completed`,
   sharing the member namespace), delivered to seams, not stored by core, so §6's "no event log in
   Mesh" stands; (b) an `emits=` option on the action line; (c) application code on seams only.
   Timing: (i) after 1.0, Hyper keeps its table at the gate; (ii) before the gate. Recommendation:
   (a)(i).
   *Outcome: Ruled differently: built in M6, before the gate, as declared events with the outbox; HA's hand-written event table is dropped ([ADR-0079], DOM-18).*
9. **D9. Seam payloads, now.** (a) reserve an `events` field on `afterWrite` and `afterCommit` in
   [ADR-0075] today, defined as in 2.8 (recorded at the action's own row write; `afterCommit` in
   emission order; `afterWrite` timing unchanged; no `emit` after the write); (b) declared events get their own seam later; (c) decide later and accept a
   breaking change. Recommendation: (a).
   *Outcome: Not taken. Declaring events and publishing them are separate syntax, and with events delivered from the outbox the seams need no `events` field (a consequence, not a ruling; [ADR-0079], DOM-19, DOM-02).*
10. **D10. The JSON-RPC adapter and surfaces.** (a) both after 1.0, Hyper writes its server and method
    table in `examples/hyper`; (b) both before the gate; (c) the adapter before the gate,
    `@meshfw/jsonrpc`: newline-delimited JSON-RPC 2.0 over a Unix socket taking a hand-written method
    table as plain data, with Hyper's envelope mapping (`commandId`, `actor`, `caller`, phases)
    staying application code; surfaces after 1.0 generate that table. Recommendation: (c). Hyper
    writes this server anyway (`PROTOCOL.md` §1; roadmap HA), so packaging it costs about the same and
    follows the study's brief literally (JSON-RPC as its own small adapter, with Hyper's v0 as
    its first user). It does not conflict with [ADR-0075]'s "no action manifest before 1.0", because the
    table is hand-written. The "no transport" line in revision 5 comes from M6's out-of-scope list and
    HA, not from [ADR-0072], and needs a one-line amendment.
   *Outcome: Ruled as recommended: (c) ([ADR-0077], DOM-20).*
11. **D11. The surface format in core.** (a) core owns format, view and manifest; readers are
    adapters; amend the texts listed in 4.6 (principle 8, §6 "admin interface", project structure, the
    oclif and HTTP sections, [ADR-0027]); (b) the format belongs to an extension. Recommendation: (a).
   *Outcome: Ruled as recommended: (a) ([ADR-0077], DOM-21).*
12. **D12. Fields through a surface.** (a) fail closed: `fields=[...]` or explicit `fields=:all`,
    superseding [ADR-0035]'s proposed `public` flag; (b) all attributes by default with `omit=`.
    Recommendation: (a), the rule that made policies fail closed ([ADR-0055]).
   *Outcome: Ruled as recommended: (a) ([ADR-0077], DOM-22).*
13. **D13. Aggregates.** (a) a `part-of` flag on the `belongs-to`; (b) `part-of=&rel` on the entity
    line; (c) nothing. Version bump once per outermost call. Recommendation: (a).
   *Outcome: Ruled differently: an aggregate file, not a `part-of` flag ([ADR-0080], DOM-23, DOM-03, DOM-31).*
14. **D14. Event sourcing and CQRS.** (a) extensions `@meshfw/event-sourcing` and `@meshfw/cqrs`;
    (b) one combined extension; (c) core. Recommendation: (a).
   *Outcome: Ruled as recommended: (a) ([ADR-0081], DOM-24).*
15. **D15. Outbox.** (a) an extension, revisiting [ADR-0023]'s provisional "outbox in core"; (b) core.
    Recommendation: (a).
   *Outcome: Ruled differently: (b), the outbox is core, in M6 ([ADR-0079], DOM-06).*
16. **D16. Reactions and after-commit work.** (a) drop the planned `after-commit` step; synchronous
    reactions stay cascades; asynchronous reactions are `react` in services (workflows extension);
    non-durable after-commit work is an application service or the `afterCommit` seam; (b) keep the
    `after-commit` step for one-off side effects as well. Recommendation: (a). Amends [ADR-0053].
   *Outcome: Ruled differently: the `after-commit` step is dropped, as recommended; asynchronous reactions are publish plus a listener, not a `react` block, and the `afterCommit` seam is not used for it ([ADR-0079], DOM-25, DOM-05).*
17. **D17. Value types.** (a) a `value` file kind after 1.0, used as `value :price type=Money`, also
    hosting the Concepts library; amends §6 "embedded entities: not planned"; (b) Concepts only
    (single-field); (c) neither. Recommendation: (a).
   *Outcome: Ruled differently: `concept`, not `value` ([ADR-0080], DOM-26).*
18. **D18. Named checks.** (a) the documented form: an extension-host run-time point (TypeScript)
    after M11; (b) the [ADR-0053] step model: MX `check` definition files, extensions contributing the
    same contract. Recommendation: (b), one contract for user and extension checks, consistent with
    steps; amends the extension-host page.
   *Outcome: Ruled differently: a `checks` section and `check :name`, plus `mixin` files with `use`; step files dropped ([ADR-0082], DOM-28, DOM-04, DOM-33).*
19. **D19. Name clashes**, the table in section 5 as one batch. Recommendation: accept.
   *Outcome: Ruled as recommended, with changed words ([ADR-0083], DOM-29).*
20. **D20. Decide now** the three items of 6.5 (namespace, `&` meaning, seam payloads), in one ADR with
    the doc edits they carry: the configuration sentence, the `&` sentence in Entities (names and
    references), [ADR-0067] §1, and [ADR-0075]'s payloads. Recommendation: yes.
   *Outcome: Item 1 ruled differently (folder modules, not a flat namespace, CMP-17, built); item 2 ruled as recommended (CMP-12, SYN-19); item 3 follows D9's outcome ([ADR-0058] amended).*
21. **D21. Architecture rules: ring.** (a) built-in invariants in core, the rule language, engine and
    presets as an extension (`@meshfw/architecture`), after 1.0; (b) all in core. Recommendation: (a). Either way the engine is Mesh's own checker over the import
    graph and the model (ruled, [ADR-0084]); no third-party rule library.
   *Outcome: Ruled differently: (b), all in core; timing open ([ADR-0084], DOM-30, DOM-10).*
22. **D22. File name and root tag.** (a) `architecture.mesh.mx`, root `architecture :name`; (b)
    `arch.mesh.mx`, root `arch`; (c) a `rule-set :name` root, several rule-set files.
    Recommendation: (a): one file per project, a full word as elsewhere in the vocabulary; rule sets
    from presets arrive through `use`, so the file itself does not need to be a rule set.
   *Outcome: Ruled as recommended: (a) ([ADR-0084], DOM-30).*
23. **D23. Presets.** (a) `use :mesh-recommended` referring to a preset shipped in the extension and
    versioned with Mesh, with per-rule `severity` and `disable`; extensions and npm packages may ship
    further presets; (b) Mesh writes a pre-filled copy into the project. Recommendation: (a).
   *Outcome: Ruled as recommended: (a) ([ADR-0084], DOM-30).*
24. **D24. Two tiers.** (a) Mesh's semantic invariants are built-in errors no file can remove; the file
    holds recommendations and user rules; (b) every rule, Mesh's included, can be changed in the file.
    Recommendation: (a). Also: rules use Mesh line syntax with atoms (layers declared once, rule =
    atom slug plus `message=`), refer to Mesh concepts as well as folders, and are checked by `mesh
    build` with Mesh's own checker over the import graph, with no generated test files.
   *Outcome: Ruled as recommended: (a) ([ADR-0084], DOM-30).*


## References

[ADR-0001]: ../decisions/0001-three-rings.md
[ADR-0003]: ../decisions/0003-generated-code-carries-behaviour.md
[ADR-0005]: ../decisions/0005-core-interface-is-a-function-call.md
[ADR-0020]: ../decisions/0020-extension-contributions-through-declared-points.md
[ADR-0023]: ../decisions/0023-workflows-and-jobs-deferred.md
[ADR-0027]: ../decisions/0027-no-mcp-agent-surface.md
[ADR-0033]: ../decisions/0033-core-split-build-time-run-time.md
[ADR-0035]: ../decisions/0035-meaning-of-public.md
[ADR-0050]: ../decisions/0050-entity-file-syntax.md
[ADR-0051]: ../decisions/0051-mesh-mx-files-and-the-mesh-host.md
[ADR-0053]: ../decisions/0053-validate-then-do.md
[ADR-0055]: ../decisions/0055-policies-are-core.md
[ADR-0057]: ../decisions/0057-one-domain-modules-as-folders.md
[ADR-0059]: ../decisions/0059-action-context.md
[ADR-0061]: ../decisions/0061-generators-are-jig-templates.md
[ADR-0066]: ../decisions/0066-names-and-references-are-atoms.md
[ADR-0067]: ../decisions/0067-members-imports-input-static-files.md
[ADR-0068]: ../decisions/0068-actions-compose-through-actions-and-tx.md
[ADR-0070]: ../decisions/0070-has-many-via.md
[ADR-0072]: ../decisions/0072-mesh-1-0-is-the-port-gate.md
[ADR-0075]: ../decisions/0075-seams-use-the-extension-hosts-names.md
[roadmap]: ../roadmap/roadmap.md
[vocab]: ../roadmap/vocabulary-mapping.md
[gap]: ../research/hyper-port-gap-analysis.md
[a-data-layer]: ../in-depth/data-layer.md
[a-ext-host]: ../in-depth/extension-host.md
[a-open]: ../open-questions.md
[a-ash-eco]: ../research/ash-ecosystem-packages.md
[a-durable]: ../research/durable-engines.md
[d-entities]: ../../docs/entities.md
[d-shape]: ../../docs/entities.md#the-shape-of-a-file
[d-types]: ../../docs/entities.md#the-types
[d-computed]: ../../docs/entities.md#computed
[d-do]: ../../docs/entities.md#do
[d-reads]: ../../docs/entities.md#reads-filter-and-sort
[d-using]: ../../docs/using-your-domain.md
[d-signatures]: ../../docs/using-your-domain.md#signatures
[d-update]: ../../docs/using-your-domain.md#update
[d-filters]: ../../docs/using-your-domain.md#filters-sort-and-paging
[d-seams]: ../../docs/using-your-domain.md#seams
[d-structure]: ../../docs/project-structure.md
[d-config]: ../../docs/configuration.md
[f-aggregate]: https://martinfowler.com/bliki/DDD_Aggregate.html
[f-vo]: https://martinfowler.com/bliki/ValueObject.html
[f-bc]: https://martinfowler.com/bliki/BoundedContext.html
[f-cqrs]: https://martinfowler.com/bliki/CQRS.html
[f-es]: https://martinfowler.com/eaaDev/EventSourcing.html
[f-anemic]: https://martinfowler.com/bliki/AnemicDomainModel.html
[f-servicelayer]: https://martinfowler.com/eaaCatalog/serviceLayer.html
[f-repository]: https://martinfowler.com/eaaCatalog/repository.html
[ADR-0030]: ../decisions/0030-established-tools-first.md
[d-names]: ../../docs/entities.md#names-and-references
[ADR-0058]: ../decisions/0058-generated-code-in-mesh-imported-as-hash-mesh.md
[ADR-0063]: ../decisions/0063-user-docs-first-and-the-hold.md
[ADR-0077]: ../decisions/0077-surfaces-and-file-kinds.md
[ADR-0078]: ../decisions/0078-services-and-where-effects-go.md
[ADR-0079]: ../decisions/0079-commands-events-and-the-outbox.md
[ADR-0080]: ../decisions/0080-aggregates-and-concepts.md
[ADR-0081]: ../decisions/0081-event-sourcing-and-cqrs-are-extensions.md
[ADR-0082]: ../decisions/0082-named-checks-and-mixins.md
[ADR-0083]: ../decisions/0083-names-for-the-new-constructs.md
[ADR-0084]: ../decisions/0084-architecture-rules-are-core.md
[ADR-0085]: ../decisions/0085-tag-discovery-for-dialect-tags.md

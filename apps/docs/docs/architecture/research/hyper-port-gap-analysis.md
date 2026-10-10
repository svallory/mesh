---
title: "Hyper on Mesh: gap analysis"
description: "What porting the Hyper engine to Mesh needs that Mesh does not have, resource by resource and feature by feature, with the milestone that delivers each gap."
---

# Hyper on Mesh: gap analysis

Date: 2026-10-10. This page is the evidence behind [roadmap revision 5](../roadmap/roadmap.md). No Mesh code was changed to write it.

## 0. What this is, and how to read it

**Hyper** is a work tracker for people and AI agents, and it is a separate project from Mesh. Its engine is an Elixir program on Ash (the framework Mesh is modelled on) and Postgres: 8,996 lines in 137 files under `lib/`, read at commit `1829f0b` of the `hyper` repository (`engine/code/ex`, `lib/hyper/`). **Mesh** is a TypeScript framework that derives types, validators, a schema and action functions from `.mesh.mx` entity files; it was read at commit `583150b` of the `mesh` repository. On 2026-10-07 the operator (the project owner) ruled that Mesh 1.0 is done when the Hyper engine can be ported to Mesh. This page answers one question: **what would the port need that Mesh does not have yet, and which milestone delivers it?**

You do not need to know Ash or Elixir to read it. Two Ash terms recur. A **resource** is Ash's name for what Mesh calls an *entity*: one declaration of data, its operations and its rules. A **change** is a module of code that runs inside one of those operations; Mesh's nearest equivalents are `set` and `run` steps. A **rule** is Hyper's unit of validation: a named check such as `task.open` that clients branch on. A **cascade** is an action that writes other entities in its own transaction. A **seam** is a place in a generated action where the application may put code (before the transaction opens, inside it after the write, after it commits).

**What the engine is made of.** Counts come from the source named. Paths below are relative to `lib/hyper/` in the `hyper` repository's engine, unless they start with `test/` or `NOTES.md`.

- **18 Ash resources**: 17 domain resources and the `Event` log. `use Ash.Resource,` appears in exactly 18 files under `lib/`. They are Workspace, Collaborator, Membership, Machine, SessionReference, EvidenceReference, Task, Assignment, Dependency, Claim, Submission, Review, Completion, LateResult, Run, Attempt, Invocation and Event. (Three other files mention `Ash.Resource`: a generic-action implementation, `portability/export.ex:14`; a validation module, `pipeline/rules.ex:10`; and the `Versioned` fragment that every domain resource includes, `pipeline/versioned.ex:13-15`.)
- **38 custom Ash modules**: 24 changes, 1 preparation, 7 policy checks, 3 calculations, 2 generic-action implementations and 1 validation module. Appendix B lists every one with its disposition.
- **57 named content rules** in 17 rules modules (`use Hyper.Pipeline.RuleSet`, for example `tasks/task/rules.ex`).
- **Run-time machinery outside the resources**: the write pipeline (`pipeline/`), the transport (`transport/`), plugins (`plugins/`), export and import (`portability/`), the embedded Postgres (`persistence/`), the lease sweeper and the bootstrap. Section 3 maps these.
- **Two contracts, and the operator's ruling names the older one.** The Hyper project keeps a specification repository (`hyper`, `engine/code/spec`). Its `main` branch holds a one-line README, but the specification is on the `protocol-phases` branch (the `spec-ci` branch has the same content plus a CI workflow): `PROTOCOL.md` v0 (368 lines), `PLUGIN-HOST.md`, `schemas/protocol.ts`, a harness that drives any engine through `ENGINE_CMD --socket --db`, a plugin SDK, and `conformance/01..10-*.test.ts` with **126 `test(` cases**. The operator's ruling (MX decision 185) names it: "the wire protocol and conformance suite in `~/work/hyper/engine/code/spec`". The engine's own v2 replaced the spec's wire (newline-delimited JSON-RPC 2.0 over a Unix socket, SQLite) with AshTypescript RPC over HTTP, and its `AGENTS.md:3` calls the v0 wire "historical"; `NOTES.md` section 1 says "the hand-written JSON-RPC wire contract (`code/spec`) no longer binds". So the port had two candidate contracts: **v0, the spec** (gate: the 126 cases, black box) and **v2, the engine** (gate: the ExUnit suite under `test/`, 51 `*_test.exs` files and about 380 `test "..."` blocks; `test/behaviour/` holds the 126 cases ported into ExUnit, which cannot drive a Bun engine). The port follows v0 ([ADR-0072](../decisions/0072-mesh-1-0-is-the-port-gate.md)); section 3.2 maps both. The v0 slice covers 12 of the 18 resources (`NOTES.md` section 1); Run, Attempt, Invocation, Machine, SessionReference and the export are engine extensions the spec does not mention.

**How Mesh was checked.** The user docs (`apps/docs/docs/docs/`) win over the code. Every entity file was then run through the compiler as it stood. Section 5 gives every diagnostic. What this showed about the code's state, beyond the docs:

- The contracts and the model accept a lot that the generated code does not run. A generated action applies only a **constant `set`**. It lists checks, other steps, `on:load` and policies in a "Not run in this version" comment, and a read with `filter` or `sort` throws `FrameworkError` (`packages/compiler/src/views/actions.ts:126-162`, and `:209-215` for a read).
- A `set` block that mixes a constant with an expression drops the constant as well (`views/actions.ts:141-149`: a block is applied only if every value in it is a literal). In a smoke test, `completeTask` with `&state=:done` and `&version=() => &version + 1` returned the task unchanged.
- Expression bodies (`that=`, `filter=`, `authorize-if=`, `set` values) are stored as source text. Mesh checks only that each `&name` is a member. Whether a body translates to SQL is not checked until the expressions milestone, so none of the `.some(...)` and `.find(...)` bodies in the entity files is validated.

The 18 entity files used here are drafts, kept in the Mesh team's notes and not published. Where this page says "the entity file", it means those drafts.

### Status words

- **on main**: the construct parses, is in the model, and the generated code runs it today (attribute types and options, `belongs-to` key columns, constant `set`, typed input, the plain CRUD actions; `can` is not built).
- **documented, not built (Mn)**: the docs describe it, the contracts may accept it, and a later milestone makes it run. "Parsed" constructs that the generator lists as "not run" are in this group.
- **not in the docs**: no page or decision record described it when this analysis was written. The contract rejects it or the docs are silent. Where a rejection is tested, the probe number (P01 to P16, section 5.4) is given. Revision 5 adds some of these constructs to the docs; the roadmap's changelog lists them.

In the per-resource tables, the **Milestone** column is the milestone that delivers the row in revision 4; "none" means no revision 4 milestone does.

### Size words

None, S, M, L, XL mean: nothing to build; one pull request; two to four; five or more; and more than one milestone. They are scope, as in the roadmap.

### The feature codes

Each gap has a code, `G01` to `G38`, used in the per-resource tables, the entity files' `// GAP(Gnn)` comments and the summary in section 4. Section 4 is the glossary. G32 was merged into G12 and the code is unused.

### Links

Docs links point at the published pages. Engine references are `path:line` relative to `lib/hyper/` in the `hyper` repository's engine, unless they start with `test/` or `NOTES.md`.

## 1. How a Hyper write works, and where each step lands in Mesh

Every Hyper resource includes one fragment, `Hyper.Pipeline.Versioned` (`pipeline/versioned.ex:13-28`), whose one global change, `WritePipeline` (`pipeline/changes/write_pipeline.ex:57-77`), wraps every create, update and destroy. The order of a top-level write is written at `write_pipeline.ex:7-26`:

1. Before the transaction: the plugin checks of the first tier, then a wait in a FIFO queue of writers (`pipeline/workspace_queue.ex:47-56`), bounded by 2,000 ms and 500 waiters. A refusal is the typed error `server.busy` (`write_pipeline.ex:96-107`).
2. In the transaction: take a Postgres advisory lock (`pipeline/workspace_lock.ex:45-60`), **reload the row** (`write_pipeline.ex:125-144`), run the action's rules (all failures reported together, `pipeline/changes/check_rules.ex:12-21`), the state transition, the version bump (`pipeline/changes/version.ex:13-43`).
3. The write.
4. After the write, still in the transaction: append an `Event` (`write_pipeline.ex:150-160`), forget the cached Task snapshots, then run the action's own `after_action` hooks, whose nested writes append their events after the command's own.
5. After the transaction: the second-tier hooks' cleanup, the queue release; the event is broadcast on a PubSub topic (`pipeline/event.ex:45-50`).

Where each piece lands in Mesh:

| Hyper step | Mesh construct | Status | Milestone |
|:--|:--|:--|:--|
| One writer at a time, FIFO | `data-sqlite` runs "its own queued `BEGIN IMMEDIATE` transactions" (`packages/data-sqlite/src/layer.ts:119`; `CLAUDE.md`, data layer). On Postgres, M9 needs an equivalent. | on main (SQLite) | M9 (Postgres) |
| Overload becomes `server.busy` | Nothing. The docs have no bounded queue and no typed refusal. | not in the docs | none (G16) |
| Reload the row under the lock, then check | An update whose `check` reads `self` "reads the row first, locked, in the same transaction, and then writes" ([ADR-0054], [using: update][u-update]) | documented, not built (M5) | M5 |
| Rules, all failures together | `validate` with `check :label [ that code message ]`; "Several checks may fail in one call" ([validate][e-validate]) | documented, not built (M4, M5) | M4, M5 |
| Rules shared by name across actions and entities | Revision 4's extension host lists "named, reusable checks ... an entity file refers to by name" ([extension host][in-ext]; M6 acceptance test 5). `always` covers one entity; reusable steps are "planned after v1" ([ADR-0053]) | documented, not built (M6, the extension host) | M6; revision 5 moves it after 1.0 ([ADR-0072](../decisions/0072-mesh-1-0-is-the-port-gate.md)) |
| State transition | No state machine. An `enum` plus a `check` per action ([ADR-0050]; the mapping page lists no state-machine row) | not in the docs (G03) | none |
| Version bump, `expected-version` | A `check` on an optional `integer` input and a `set` that adds 1 (G02) | documented, not built (M4, M5) | M5 |
| Event row per write, same transaction | Nothing. "audit trail, event log, state machine ... (extensions, none blocks core)" ([roadmap, section 6][roadmap]) | not in the docs (G12) | none |
| PubSub after commit | Nothing | not in the docs (G13) | none |
| Plugin checks (two tiers) | Nothing | not in the docs (G11, G31) | none |
| Actions calling other actions in the same transaction | Nothing: `run({ self, input, actor }) { }` gets no transaction handle ([ADR-0053], [do][e-do]); a nested transaction on the data layer "is an error" (`packages/runtime/src/data-layer.ts:34`) | not in the docs (G05) | none |

The last row is the largest single gap. Hyper's actions are cascades: `Task :complete` records a Completion, settles a Submission and releases a Claim (`tasks/task/changes/record_completion.ex:15-43`); `Task :cancel` revokes claims, withdraws a submission and cancels runs (`tasks/task/changes/settle_work.ex:14-33`); twelve of the 24 change modules write to another resource (eleven call `Ash.create!` or `Ash.update!` themselves; `membership/changes/revoke_claims.ex` goes through `EndClaim.revoke_all`), and `WritePipeline` appends an Event to every write. Mesh's only cross-entity write in the docs is the one-statement CRUD of a single action.

## 2. The resources

Each section names the Hyper source, the entity file drafted for it (`<name>.mesh.mx`, unpublished), a table that maps every attribute, identity, relationship, action, policy, calculation and rule, and a table of that resource's custom modules.

**Disposition of a custom module** is one of:

- **Declaration**: it becomes a line of the entity file (a `check`, a `set`, a `policy`, a computed field).
- **Expression (M4)**: its body is one expression Mesh can translate ([ADR-0056]).
- **Plain code**: it becomes a `run` body or an application function. Where it must write to another entity in the same transaction, that depends on G05.
- **No place**: Mesh has no construct for it, and the gap code says what would be needed.

Common to every Hyper resource, and not repeated in the tables: a `uuid_v7` primary key (G01); `public?: true` on each attribute (no transport leaves the process in Mesh 1.0, so `public` has no meaning yet: [ADR-0035]); a `typescript do type_name` block (replaced by the generated types, on main); the `Hyper.Pipeline.Versioned` fragment (section 1); read policy `Hyper.Checks.Member`. That check passes any active member and, for anyone else, turns the read into an empty list rather than a refusal (`checks/member.ex:16-17`). Mesh does the same by design: a read policy becomes a filter on the query, so a row the caller may not see "is not found" ([ADR-0055], [action lifecycle](../in-depth/action-lifecycle.md)), and an actor-only check such as `isStaff(actor)` "runs once before the query and enters SQL as a bound value" ([entities: helpers][e-helpers]). There is no gap here. Read policy in Mesh: `policy :membersRead types=[:read] authorize-if=({ actor }) => isMember(actor)`, documented, not built (M8).

### 2.1 Workspace

Source: `workspaces/workspace.ex`, `workspaces/workspace/rules.ex`, `workspaces/workspace/calculations/owner_ids.ex`, `workspaces/workspace/actions/stats.ex`, `portability/export.ex`. The one workspace a daemon hosts; there is no `workspace_id` on any other record. Entity file: `workspace.mesh.mx`.

| Item | Hyper | Mesh construct | Docs | Status | Milestone |
|:--|:--|:--|:--|:--|:--|
| `id` | `uuid_v7_primary_key` `:76` | `uuid :id primary-key` | [attributes][e-attr] | on main (no UUIDv7, G01) | none |
| `name` | nullable string `:77` | `string :name nullable` | [attributes][e-attr] | on main | M2 |
| `location` | string, regex `^(local\|shared)$`, default `"local"` `:79-84` | `enum :location values=[:local, :shared] default=:local` | [attributes][e-attr] | on main | M2 |
| `state` | string, default `"active"` `:85` | `enum :state values=[:active] default=:active` | [attributes][e-attr] | on main | M2 |
| `version` | integer, default 1 `:86` | `integer :version default=1` | [attributes][e-attr] | on main | M2 |
| calculation `owner_ids` | array of ids from the active owner memberships `:89-93`, `owner_ids.ex:8-19` | none: a computed field returns one scalar and cannot query an entity nothing relates to | [computed][e-comp] | not in the docs (G06, G10) | none |
| action `create` | accepts name, location `:25-29`; run by the bootstrap with `authorize?: false` (`bootstrap.ex:36`) | `create :create` with `input &name &location` | [actions][e-actions] | on main | M2 |
| action `rename` | accepts name; `expected_version`; rule `workspace.active`; version bump `:30-37` | `update :rename` with a `check`, a version `check` and `set &version` | [validate][e-validate], [do][e-do] | documented, not built (M4, M5) | M5 |
| read | `defaults [:read]` `:23` | `actions auto=[:read]` | [actions][e-actions] | on main | M2 |
| action `export` | generic action returning `{path, manifest}` `:38-50`, `portability/export.ex:22-45` | none: Mesh plans no generic actions | [mapping: row 55][mapping] | not in the docs (G18, G26) | none; see section 3 |
| action `stats` | generic action, BEAM gauges `:51-64`, `actions/stats.ex:12-22` | none; drop it or write a Bun function | [mapping: row 55][mapping] | not in the docs (G26) | none |
| policy: read | `Member` `:66-68` | `policy :membersRead types=[:read]` | [policies][e-policies] | documented, not built (M8) | M8 |
| policy: write | `Role roles: ["owner"]` on create, rename, export, stats `:70-72` | `policy :ownersWrite types=[:create, :update]` | [policies][e-policies] | documented, not built (M8) | M8 |
| rule `workspace.active` | `workspace/rules.ex:7-8` | `check :workspaceActive` with code `workspace.active` | [validate][e-validate] | documented, not built (M5) | M5 |

| Custom module | What it does | Disposition |
|:--|:--|:--|
| `Calculations.OwnerIds` | ids of collaborators with an active owner membership | No place (G06, G10): expose it as a filtered read on Membership |
| `Actions.Stats` | memory, process, port and connection counts | No place (G26): application code, or dropped |
| `Portability.Export` | one `REPEATABLE READ` snapshot to a tar.gz bundle, then an `export` event | Plain code in the application over the generated reads (G18) |

### 2.2 Collaborator

Source: `collaborators/collaborator.ex`, `collaborator/rules.ex`, `collaborator/changes/revoke_memberships.ex`, `collaborators/rules.ex`. A human or an agent; the actor of every command is a Collaborator. Entity file: `collaborator.mesh.mx`.

| Item | Hyper | Mesh construct | Docs | Status | Milestone |
|:--|:--|:--|:--|:--|:--|
| `kind` | string, regex `^(human\|agent)$`, required `:88-93` | `enum :kind values=[:human, :agent]` | [attributes][e-attr] | on main | M2 |
| `name`, `state`, `retired_at`, `version`, `created_at` | `:94-98` | `string`, `enum :state values=[:active, :retired]`, `timestamp ... nullable`, `integer :version`, `timestamp :createdAt on=:create` | [attributes][e-attr] | on main | M2 |
| `retired_at` precision | `utc_datetime_usec` | `timestamp` is a JavaScript `Date`, to the millisecond | [attributes][e-attr] | not in the docs (G24) | none |
| identity "active collaborators have distinct names" | unique index on `name` where `state = 'active'` `:21-25` | none: `unique` is one whole column | [attributes: options][e-attr] | not in the docs (G08). Mapping rows 78, 79: "identities beyond `unique` on one attribute", after v1 | after 1.0 |
| `active_membership` | `has_one` with filter `state == "active"` `:101-105` | `has-many :memberships` (the filtered has-one has no construct) | [relationships][e-rel] | not in the docs (G07, G28). Mapping rows 42-46: relationship options, "not scheduled" | none |
| `register` | accepts kind, name; rule `collaborator.name-unique` `:30-35` | `create :register`; the uniqueness check reads sibling rows | [actions][e-actions] | create on main; the check is not in the docs (G06, G08) | none |
| `update` | accepts name; arg `kind`; `expected_version`; rules `collaborator.active`, `collaborator.kind-immutable`, `name-unique`; Version `:36-52` | `update :update` with typed arg `string :kind nullable` and three checks | [input][e-input], [validate][e-validate] | documented, not built (M4, M5); `name-unique`: G06, G08 | M5 |
| `retire` | rules `collaborator.active`, `membership.last-owner`; `state`, `retired_at`; Version; cascade `RevokeMemberships` `:53-68` | `update :retire` with `set &state=:retired`, `&retiredAt=now()`, `&version`; `run` for the cascade | [do][e-do] | set: documented, not built (M5); `now()`: not in the docs (G23); `last-owner`: G06, G07; cascade: G05 | M5, none |
| policy | read `Member`; register, retire owner; update `Role self: :id` `:69-83` | three policies; the "owner or the collaborator themself" check is `authorize-if=({ actor }) => hasRole(actor, ["owner"]) \|\| actor.id === &id` | [policies][e-policies] | documented, not built (M8) | M8 |
| rule `collaborator.active` (`collaborators/rules.ex:9-24`) | shared with Membership, Task `:assign` | `check` repeated in each action (G04) | [validate][e-validate] | documented, not built (M5) | M5 |
| rule `collaborator.name-unique`, `kind-immutable` | `collaborator/rules.ex:9-26` | `kind-immutable` is a check; `name-unique` has no form | | see above | |

| Custom module | What it does | Disposition |
|:--|:--|:--|
| `Changes.RevokeMemberships` | in the retiring transaction: revoke the active membership and every active claim of the collaborator | Plain code, blocked by G05 |
| `Checks.Role` (`checks/role.ex:16-70`) | the actor's active membership role is in a list; `self:` also admits the record's own id; denies with a named `forbidden` error | Declaration (a policy over a helper) for the test. The role is read at decision time in Hyper; in Mesh the application builds `actor.role` before the call (G21). The named, structured denial has no form (G22) |
| `Checks.Member` | read filter for active members | Declaration (policy), with the empty-list behaviour lost (G22) |

### 2.3 Membership

Source: `memberships/membership.ex`, `membership/rules.ex`, `membership/changes/revoke_claims.ex`, `memberships/rules.ex`, `memberships/queries.ex`. A collaborator's role in the workspace; at most one active per collaborator. Entity file: `membership.mesh.mx`.

| Item | Hyper | Mesh construct | Docs | Status | Milestone |
|:--|:--|:--|:--|:--|:--|
| `role` | string, regex `^(owner\|member\|guest)$` `:90-95` | `enum :role values=[:owner, :member, :guest]` | [attributes][e-attr] | on main | M2 |
| `state`, `granted_at` (required), `revoked_at`, `version` | `:96-99` | `enum :state`, `timestamp :grantedAt`, `timestamp :revokedAt nullable`, `integer :version` | [attributes][e-attr] | on main; `grantedAt` set by a step cannot be built on a create today (D04) | M5 |
| identity "one active membership per collaborator" | unique index on `collaborator_id` where `state = 'active'` `:21-27` | none | [attributes: options][e-attr] | not in the docs (G08) | after 1.0 |
| `collaborator`, `granted_by`, `revoked_by` | three `belongs_to` to Collaborator `:103-105` | three `belongs-to` with `entity=Collaborator` | [relationships][e-rel] | on main (key columns `collaboratorId`, `grantedById`, `revokedById`) | M2; loading M7 |
| the inverse `has-many` from Collaborator | none in Hyper | `has-many :memberships entity=Membership` accepts without saying which of the three keys it follows | [relationships][e-rel] | not in the docs (G28) | M7 |
| `grant` | accepts collaborator, role; rules `collaborator.active`, `membership.none-active`; `granted_at` now; `granted_by` the actor `:34-46` | `create :grant` with `input &collaborator &role`; a check through `&collaborator.state`; two `set` lines | [input][e-input], [validate][e-validate], [do][e-do] | `granted_by` from the actor: rejected by the build (D01, not in the docs, G30). `now()`: G23. `none-active`: G06, G08 | M5 |
| `change_role` | accepts role; rules `membership.active`, `membership.unchanged`, `membership.last-owner`; Version `:47-58` | `update :changeRole`; the new role is a typed argument so that `unchanged` can compare it with the stored one | [input][e-input], [what `self` holds][e-self] | the argument form: G35; `last-owner`: G06, G07 | M5 |
| `revoke` | rules `active`, `last-owner`; `state`, `revoked_at`, `revoked_by`; cascade `RevokeClaims` `:59-76` | `update :revoke` | [do][e-do] | as above; cascade: G05 | M5 |
| rule `membership.last-owner` | the workspace would have no owner (`memberships/rules.ex:19-45`): counts active owner memberships over the whole table | none: an aggregate over a filtered table that nothing relates to | | not in the docs (G06, G07) | none |
| rule `role` | actor's gate (`memberships/rules.ex:12-17`) | the write policy covers it | [policies][e-policies] | documented, not built (M8) | M8 |
| policy | read `Member`; grant, change_role, revoke owner `:77-85` | two policies | [policies][e-policies] | documented, not built (M8) | M8 |

| Custom module | What it does | Disposition |
|:--|:--|:--|
| `Changes.RevokeClaims` | revoke the collaborator's active claims | Plain code, blocked by G05 |

### 2.4 Machine

Source: `machines/machine.ex`, `machine/rules.ex`, `machines/changes/report_machine.ex`. The host an attempt or session ran on, named by a stable name. Entity file: `machine.mesh.mx`.

| Item | Hyper | Mesh construct | Docs | Status | Milestone |
|:--|:--|:--|:--|:--|:--|
| `name`, `platform`, `state`, `version`, `registered_at` | `:78-82` | five attribute lines; `unique` on `name` | [attributes][e-attr] | on main | M2 |
| identity `name` | `identity(:name, [:name])` `:89-91` | `string :name unique` | [attributes: options][e-attr] | on main (one column) | M2 |
| `first_reported_by` | `belongs_to` Collaborator, nullable `:86` | `belongs-to :firstReportedBy entity=Collaborator nullable` | [relationships][e-rel] | on main | M2 |
| `register` | accepts name, platform; rules `role`, `machine.name-free` `:30-38` | `create :register`; `unique` replaces the rule; `set &firstReportedBy` | [actions][e-actions] | the `set` of a relationship is rejected (D01, G30) | M5 |
| `report` | creates a machine from a host name, as the engine `:39-44` | none | | not in the docs (G05) | none |
| `update`, `retire` | rules `machine.active`, `machine.idle`; Version `:45-61` | `update :update`, `update :retire`; `machine.idle` is a count of running attempts | [validate][e-validate] | documented, not built (M5); the filtered count: G07 | M5, M7 |
| rule `machine.idle` | no attempt on this machine is running (`machine/rules.ex:21-29`) | `count :runningAttempts of="attempts"` has no filter | [computed][e-comp] | not in the docs (G07) | none |
| policy | read `Member`; register `owner, member`; update, retire `owner` `:62-74` | three policies | [policies][e-policies] | documented, not built (M8) | M8 |

| Custom module | What it does | Disposition |
|:--|:--|:--|
| `Changes.ReportMachine` | in a report's transaction: a `machine` argument (a host name) resolves to a Machine, creating it as the reporter when unknown, refusing a retired one | Plain code, blocked by G05 (find-or-create in another entity inside someone else's action) |

### 2.5 SessionReference

Source: `sessions/session_reference.ex`, `session_reference/rules.ex`. A pointer to an agent runtime's own session. Entity file: `session-reference.mesh.mx`.

| Item | Hyper | Mesh construct | Docs | Status | Milestone |
|:--|:--|:--|:--|:--|:--|
| `runtime`, `runtime_session_id`, `availability` (regex `^(complete\|partial\|unavailable\|redacted)$`), `location`, `version`, `recorded_at` | `:89-100` | six attribute lines | [attributes][e-attr] | on main | M2 |
| `machine`, `agent_profile`, `recorded_by` | `belongs_to` `:104-106` | three `belongs-to` | [relationships][e-rel] | on main | M2 |
| identity `runtime_session` | `[:runtime, :runtime_session_id]` `:110` | none | | not in the docs (G08); mapping rows 78, 79 | after 1.0 |
| `record` | upsert on the identity, returning the existing record on a repeat report `:31-42`; arg `machine` | none | [mapping: row 62][mapping] | not in the docs (G09), "after v1" | after 1.0 |
| `set_availability` | rules `session.not-redacted`, `session.availability`; Version `:43-55` | `update :setAvailability`; the new values are typed arguments, because `validate` cannot read the stored value of a field the action also accepts | [what `self` holds][e-self] | G35; checks documented, not built (M5) | M5 |
| `redact` | `availability` redacted, `location` nil `:56-66` | `update :redact` with two `set` lines | [do][e-do] | documented, not built (M5) | M5 |
| rule `session.agent-profile` | the profile exists (`session_reference/rules.ex:10-11`) | a check through `&agentProfile.state` | [validate][e-validate] | documented, not built (M5) | M5 |
| policy | `set_availability` is `Role roles: [] self: :recorded_by_id`: the recorder only; `redact` owner `:67-85` | `authorize-if=({ actor }) => actor.id === &recordedBy.id` | [policies][e-policies] | documented, not built (M8) | M8 |

Custom modules used: `Changes.ReportMachine` (see Machine).

### 2.6 EvidenceReference

Source: `evidence/evidence_reference.ex`. An immutable pointer to evidence. Entity file: `evidence-reference.mesh.mx`.

| Item | Hyper | Mesh construct | Docs | Status | Milestone |
|:--|:--|:--|:--|:--|:--|
| `kind`, `locator` (required), `content_hash`, `description`, `recorded_at` | `:44-48` | attribute lines | [attributes][e-attr] | on main | M2 |
| `recorded_by` | `belongs_to`, required `:52` | `belongs-to :recordedBy` | [relationships][e-rel] | on main | M2 |
| `record` | accepts the four fields; `recorded_by` the actor `:25-31` | `create :record`; `set &recordedBy` | [actions][e-actions] | the `set` of a relationship is rejected (D01, G30) | M5 |
| immutability | only `record` and `read` exist | `actions auto=[:read]` plus `create :record` | [actions][e-actions] | on main | M2 |
| policy | read `Member`; record `owner, member` `:32-40` | two policies | [policies][e-policies] | documented, not built (M8) | M8 |

No custom module.

### 2.7 Task

Source: `tasks/task.ex`, `task/rules.ex`, `task/states.ex`, `task/queries.ex`, `task/calculations/blocked_reasons.ex`, `task/calculations/derived_state.ex`, `task/preparations/first_ready.ex`, `task/changes/{reassign,record_completion,settle_work}.ex`, `task/checks/manager.ex`, `tasks/rules.ex`, `tasks/queries.ex`, `tasks/locked_task.ex`, `tasks/blocking_condition.ex`. The unit of tracked work and the root of the aggregate. Entity file: `task.mesh.mx`.

| Item | Hyper | Mesh construct | Docs | Status | Milestone |
|:--|:--|:--|:--|:--|:--|
| `title` (required), `intent`, `priority`, `version`, `created_at` | `:188-195` | attribute lines | [attributes][e-attr] | on main | M2 |
| `state` and its machine | `state_machine` `:27-36`: initial `open`; `complete` open to done, `cancel` open to canceled, `reopen` done or canceled to open | `enum :state values=[:open, :done, :canceled] default=:open` and a `check` on `state` in every action | [attributes][e-attr] | the enum is on main; the machine is not in the docs (G03). The roadmap lists "state machine" among extensions "none blocks core" ([roadmap, section 6][roadmap]) | none |
| `parent`, `children` | `belongs_to` to itself, `has_many` back `:198`, `:200` | `belongs-to :parent entity=Task nullable`, `has-many :children entity=Task` | [relationships][e-rel] | on main only with the entity importing itself (D06); the docs show no self-reference (G28) | M7 |
| `creator` | `belongs_to` Collaborator, required `:199` | `belongs-to :creator entity=Collaborator` | [relationships][e-rel] | on main | M2 |
| `dependencies` | `has_many` Dependency, key `dependent_id` `:201` | `has-many :dependencies entity=Dependency`; Dependency has two keys to Task (`dependent`, `prerequisite`) and the docs have no way to choose | [relationships][e-rel] | not in the docs (G28) | M7 |
| `assignments`, `claims`, `submissions`, `completions` | `has_many` `:202`, `:204-206` | four `has-many` | [relationships][e-rel] | on main (the model records them; loading is M7) | M7 |
| `current_assignment`, `active_claim`, `pending_submission` | `has_one` with a filter `:203`, `:208-210`, `:212` | none. `has-one` takes no `filter` (P01), and [ADR-0045] forbids a `has-one` beside a `has-many` over the same key | [relationships][e-rel] | not in the docs (G07). Written as `.some(...)` over the `has-many`, which the docs mention only as `.every(...)` ([entities: static files][e-static]) | M7 (unfiltered) |
| index on `parent_id` | custom index `:22-25` | none: Mesh emits no index but a unique one | | not in the docs (G08) | none |
| aggregate `max_fence` | `max(:max_fence, :claims, :fence)` `:216` | `max :maxFence of="claims.fence"` | [computed][e-comp] | documented, not built (M7). The path is checked at build today | M7 |
| calculations `in_review?`, `claimed?`, `assigned?`, `lapsed_claim?`, `open_prerequisite?` | `expr(exists(... , <filter>))` `:220-235` | computed fields with a one-expression body over a `has-many` | [computed][e-comp] | documented, not built (M4, M7); the filtered quantifier: G07 | M7 |
| calculation `blocked_reasons` | a list of `{kind, taskId, message}` maps: open prerequisites, then providers' reasons (`calculations/blocked_reasons.ex:12-40`) | `boolean :blocked()` for the prerequisite part | [computed][e-comp] | the map list: not in the docs (G10, G29); the providers: G11 | none |
| calculation `derived_state` | stored done or canceled win, then in-review, claimed, blocked, ready (`calculations/derived_state.ex:10-25`) | `string :derivedState()` with a nested conditional | [computed][e-comp] | documented, not built (M7). It "runs in memory after load" because it reads computed fields | M7 |
| action `create` | accepts title, intent, parent, priority; creator = actor; rule `task.parent-open` `:41-47` | `create :create` with `input`, a `check`, a `set` | [actions][e-actions] | creator = actor: rejected by the build (D01, G30); the check: documented, not built (M5) | M5 |
| action `update` | accepts title, intent; rules `task.open`, `task.unchanged`; Version `:48-54` | `update :update`; the new values are typed arguments | [what `self` holds][e-self] | G35; checks: M5 | M5 |
| action `set_priority` | accepts priority; rule `task.open`; Version `:55-61` | `update :setPriority` | [actions][e-actions] | documented, not built (M5) | M5 |
| action `move` | accepts parent; rules `task.open`, `task.parent-open`, `task.no-cycle`, `task.no-active-claim` `:62-73` | `update :move` | [actions][e-actions] | `no-cycle` walks ancestors one row at a time (`task/rules.ex:150-165`): G36 | M5, none |
| action `cancel` | arg `reason`; rule `task.open`; transition; Version; `SettleWork` `:74-83` | `update :cancel` with `set &state=:canceled` | [do][e-do] | set on main only as a constant; cascade: G05 | M5 |
| action `complete` | args `fence`, `expected_version`; eight rules; plugin hook `task.complete`; transition; Version; `RecordCompletion` `:84-109` | `update :complete` with eight checks | [validate][e-validate] | see the rule table below; hook: G11, G31; cascade: G05 | M5 |
| action `reopen` | arg `reason`; rule `task.settled`; transition; Version `:110-118` | `update :reopen` | [actions][e-actions] | documented, not built (M5) | M5 |
| action `assign` | args `assignee_id`, `waive_review` (default false), `expected_version`; rules `task.open`, `collaborator.active`, `assignment.assignee-role`, `assignment.unchanged`; Version; `Reassign` `:119-138` | `update :assign` with typed args | [input][e-input] | `assignee-role` reads the assignee's Membership: G06; cascade and the assignment returned as metadata: G05, G25 | M5, none |
| action `unassign` | rule `assignment.current`; Version; `Reassign` `:139-146` | `update :unassign` | [actions][e-actions] | cascade: G05 | M5 |
| read `get` | `get_by(:id)` `:147-150` | `read :get` with `uuid :id` and a `filter` | [reads][e-reads] | filter documented, not built (M4); the generated read "cannot run in this version" (S4, section 5.3) | M4 |
| read `list` | optional args `parent_id`, `state`; sort by `created_at`, `id` `:151-158` | `read :list` with two optional args, `filter`, `sort` | [reads][e-reads] | documented, not built (M4) | M4 |
| read `next` | open, not in review, not claimed, assigned to the actor or nobody; sort `priority desc nils last, created_at`; then the first not held back by a provider `:159-169` | `read :next` with `filter` and `sort` | [reads][e-reads] | filter and sort: M4, M7; "nils last" has no spelling (G37); the post-query `prepare` (G27) | M4 |
| rule `task.open` | `tasks/rules.ex:13-18`; shared by six entities | `check :taskOpen` repeated per action (G04) | [validate][e-validate] | documented, not built (M5) | M5 |
| rule `task.settled`, `task.unchanged`, `task.parent-open`, `task.no-cycle` | `task/rules.ex:13-38` | one `check` each | [validate][e-validate] | `no-cycle`: G36; `unchanged`: G35 | M5 |
| rule `task.children-settled` | no open child (`:40-53`) | `&children.every((c) => c.state !== :open)` | [static files][e-static] | documented, not built (M4, M7) | M7 |
| rule `task.review-required` | the actor is the reviewer, or the assignment waived review (`:55-68`) | `check` over `&reviewerId` and `&assignments.some(...)` | [validate][e-validate] | G07 | M7 |
| rule `task.no-foreign-submission` | another collaborator's submission is pending (`:70-80`) | `!&submissions.some(...)` | [validate][e-validate] | G07 | M7 |
| rule `task.not-blocked` | no blocking-condition provider holds the Task (`:82-90`) | none | | not in the docs (G11) | none |
| rule `claim.current-fence` | `tasks/rules.ex:20-41`, five cases by resource | one `check` per entity that lists it | [validate][e-validate] | documented, not built (M5, M7); the stale detail `details.stale`: G22 | M5 |
| rule `claim.invalidated` | the actor's claim expired or was revoked since the last complete or reopen, read from the event log (`:101-113`, `:168-195`) | `check` over `&lastSettledAt` | | not in the docs (G06, G07) | none |
| policies | read `Member`; create, update, set_priority, move, assign, complete `owner, member`; cancel, reopen `Manager creator?: true`; unassign `Manager` `:170-186` | `policy :workersWrite`, `:managersCancelAndReopen`, `:managersUnassign` | [policies][e-policies] | documented, not built (M8); the manager test reads the Task's assignments: related read | M8 |

| Custom module | What it does | Disposition |
|:--|:--|:--|
| `Changes.Reassign` | on assign or unassign: revoke the previous assignee's claims, end the current assignment, create the new one, return it as result metadata | Plain code, blocked by G05 (and G25 for the metadata) |
| `Changes.RecordCompletion` | create the Completion with its rule, settle the actor's own pending submission as accepted, release the actor's claim | Plain code, blocked by G05 |
| `Changes.SettleWork` | on cancel: revoke claims, withdraw the pending submission, cancel running runs | Plain code, blocked by G05 |
| `Checks.Manager` | owner, current assignee or delegator, or the creator while unassigned | Declaration (policy). The expression reads related rows (M8) |
| `Calculations.BlockedReasons` | prerequisites not done, then provider reasons | Expression for the prerequisite test; the structured list and the providers have no place (G10, G11, G29) |
| `Calculations.DerivedState` | stored state, in-review, claimed, blocked, ready | Expression (M4, M7) |
| `Preparations.FirstReady` | after the query: for an owner or member, load `blocked_reasons`, take the first Task with none | No place (G27). Application code over the list, or a provider-aware read |
| `LockedTask` (not an Ash module) | one SELECT of the six computed values, cached for the transaction | Not needed: it is a performance cache over G07's fields. M7 decides how computed fields load |

### 2.8 Assignment

Source: `tasks/assignment.ex`. Who is responsible for a Task and who delegated it. Written only by Task actions and `Claim :acquire`. Entity file: `assignment.mesh.mx`.

| Item | Hyper | Mesh construct | Docs | Status | Milestone |
|:--|:--|:--|:--|:--|:--|
| `review_waived` (default false), `started_at`, `ended_at`, `end_reason` (regex `^(reassigned\|unassigned)$`) | `:47-57` | `boolean`, `timestamp`, `timestamp nullable`, `enum nullable` | [attributes][e-attr] | on main | M2 |
| `task`, `assignee`, `delegator` | `belongs_to` `:59-63` | three `belongs-to` | [relationships][e-rel] | on main | M2 |
| index on `task_id` | `:21-24` | none | | G08 | none |
| action `start` | accepts task, assignee, delegator, review_waived; `started_at` now `:29-34` | `create :start`; `set &startedAt=() => now()` | [do][e-do] | a required attribute filled by an expression cannot be built on a create today (D04); `now()`: G23 | M5 |
| action `finish` | accepts end_reason; `ended_at` now `:35-40` | `update :finish` | [do][e-do] | documented, not built (M5) | M5 |
| policy | read `Member`; no policy for the writes (engine only) `:41-45` | `policy :engineWrites actions=[&start, &finish]` admitting `context.system` | [policies][e-policies] | an action no policy covers is forbidden ([ADR-0055]); the `system` context key: G20 ([ADR-0071](../decisions/0071-system-key-on-the-action-context.md)) | M8 |

No custom module of its own (written by `Task.Changes.Reassign` and `Claim.Changes.AssignOnClaim`).

### 2.9 Dependency

Source: `tasks/dependency.ex`, `dependency/rules.ex`. A finish-to-start edge. Entity file: `dependency.mesh.mx`.

| Item | Hyper | Mesh construct | Docs | Status | Milestone |
|:--|:--|:--|:--|:--|:--|
| `created_at` | `:57-60` | `timestamp :createdAt on=:create` | [attributes][e-attr] | on main | M2 |
| `dependent`, `prerequisite`, `created_by` | `belongs_to` Task, Task, Collaborator `:62-66` | three `belongs-to` | [relationships][e-rel] | on main | M2 |
| identity `edge` | `[:dependent_id, :prerequisite_id]` `:68-70` | none | | G08 | after 1.0 |
| action `add` | accepts the two ids; creator = actor; rules `dependency.exists`, `distinct`, `duplicate`, `no-cycle` `:25-40` | `create :add` with `input &dependent &prerequisite` and three checks | [validate][e-validate] | `exists` is the relationship; `distinct` documented, not built (M5); `duplicate` G06, G08; `no-cycle` G36 | M5 |
| action `remove` | destroy with an optional `reason` argument `:41-46` | `destroy :remove` with `string :reason nullable` | [using: destroy][u-destroy] | documented ("A destroy that accepts fields takes them after the id"), but the generator refuses it (D05) | M5 |
| rule `dependency.no-cycle` | breadth-first over prerequisite edges (`dependency/rules.ex:30-60`) | a `check` with plain code | | G36 | none |
| policy | read `Member`; add, remove `owner, member` `:47-55` | two policies | [policies][e-policies] | M8 | M8 |

No custom module.

### 2.10 Claim

Source: `tasks/claim.ex`, `claim/states.ex`, `claim/rules.ex`, `claim/changes/{assign_on_claim,end_claim,lease}.ex`, `claim/checks/{assignee,revoker}.ex`, `claim/sweeper.ex`. A fenced lease on a Task. Entity file: `claim.mesh.mx`.

| Item | Hyper | Mesh construct | Docs | Status | Milestone |
|:--|:--|:--|:--|:--|:--|
| `fence`, `acquired_at`, `expires_at` (required), `ended_at`, `end_reason`, `version` | `:128-136` | attribute lines | [attributes][e-attr] | on main | M2 |
| `state` and machine | `active` to `released`, `revoked`, `expired` `:37-46` | `enum :state` | [attributes][e-attr] | enum on main; machine G03 | none |
| `task`, `holder` | `belongs_to` `:138-141` | two `belongs-to` | [relationships][e-rel] | on main | M2 |
| identity `fence` | `[:task_id, :fence]` `:143-145` | none | | G08 | after 1.0 |
| "at most one active claim per Task" | partial unique index `claim_one_active_per_task` `:28-35` | the check `taskReady` under the writer lock; no index | | G08. Correct without the index while one writer runs at a time | M5 |
| action `acquire` | accepts task; holder = actor; rules `role`, `claim.task-ready`; hook `task.claim`; `Lease`; `AssignOnClaim` `:51-61` | `create :acquire` with `input &task` and a ready check | [actions][e-actions] | fence = the Task's highest + 1 needs an expression over a rollup in a create (D04); holder: D01; hook: G11; cascade: G05 | M5 |
| action `renew` | arg `fence`; rules `claim.current-fence`, `claim.active`, `claim.expired`; extends the lease; Version `:62-74` | `update :renew` | [validate][e-validate] | documented, not built (M5); `lease_ms` comes from configuration: pass it in `context` (G34) | M5 |
| action `release` | args `fence`, `reason`; same rules; transition; end `:75-88` | `update :release` | [do][e-do] | documented, not built (M5) | M5 |
| action `revoke` | arg `reason`; rule `claim.active`; transition; end `:89-96` | `update :revoke` | [do][e-do] | documented, not built (M5) | M5 |
| action `expire` | the sweeper's `:97-105` | `update :expire`, policy admits the engine only | [policies][e-policies] | G20 | M8 |
| rule `claim.task-ready` | open, not in review, not claimed, no open prerequisite, no provider (`claim/rules.ex:14-23`) | one `check` through `&task` | [validate][e-validate] | needs the filtered quantifiers (G07) | M7 |
| policy | read `Member`; acquire `owner, member` and `Assignee`; renew, release: the holder only; revoke `Revoker` `:106-126` | four policies | [policies][e-policies] | M8 | M8 |

| Custom module | What it does | Disposition |
|:--|:--|:--|
| `Changes.Lease` | on acquire, expire a lapsed claim the sweeper has not reached; compute `fence = max + 1`; set `expires_at = now + lease_ms` | Mixed: the fence and the expiry are expressions (M4); the nested expiry is plain code (G05) |
| `Changes.AssignOnClaim` | claiming an unassigned Task assigns it to the holder | Plain code, blocked by G05 |
| `Changes.EndClaim` | set `ended_at` and `end_reason`; `revoke_all(filter, reason)` revokes many claims | Declaration for the two `set` lines; `revoke_all` is plain code used by five cascades (G05) |
| `Checks.Assignee` | a Task assigned to someone else is claimable only by that assignee | Declaration (`forbid-if` over the Task's assignments) |
| `Checks.Revoker` | owner, the current delegator, or the Task's reviewer | Declaration (policy) over `&task.reviewerId` and `&task.assignments` |
| `Sweeper` (GenServer) | every `sweep_interval_ms` expire each overdue claim, one transaction each | Application code (G17): `setInterval` over `readClaim` and `expireClaim` |

### 2.11 Submission

Source: `tasks/submission.ex`, `submission/rules.ex`, `submission/changes/submit.ex`. A result offered for the Task version the claim holder worked on. Entity file: `submission.mesh.mx`.

| Item | Hyper | Mesh construct | Docs | Status | Milestone |
|:--|:--|:--|:--|:--|:--|
| `summary`, `fence`, `task_version` (required), `state` (default `"pending"`), `submitted_at` | `:85-93` | attribute lines; `state` as an enum of four values | [attributes][e-attr] | on main | M2 |
| `evidence` | array of EvidenceReference ids, required, default `[]` `:88` | `string :evidence default="[]"` (JSON text) | [attributes][e-attr] | not in the docs (G10) | none |
| `task`, `submitter` | `belongs_to` `:95-98` | two `belongs-to` | [relationships][e-rel] | on main | M2 |
| index: one pending per Task | partial unique index `:21-31` | the check `nonePending` | | G08 | M5 |
| action `submit` | accepts task, summary, evidence, fence; submitter = actor; `present(:summary)`; rules `task.open`, `claim.current-fence`, `submission.none-pending`, `evidence.exists`; `Submit` `:36-54` | `create :submit` | [actions][e-actions] | `task_version` copied from the Task: an expression in a create (D04); submitter: D01; `evidence.exists`: G10; cascade: G05 | M5 |
| action `withdraw` | arg `reason`; rule `submission.pending`; state withdrawn `:55-61` | `update :withdraw` | [do][e-do] | M5 | M5 |
| action `settle` | internal: review and cancel settle a pending submission `:62-68` | `update :settle` with a typed `newState`, engine-only policy | [policies][e-policies] | G20 | M5 |
| policy | read `Member`; submit `owner, member`; withdraw: the submitter only `:69-83` | three policies | [policies][e-policies] | M8 | M8 |

| Custom module | What it does | Disposition |
|:--|:--|:--|
| `Changes.Submit` | before the write copy the Task's version into `task_version`; after the write release the submitter's active claim | Expression for the copy (M4); plain code for the release (G05) |

### 2.12 Review

Source: `tasks/review.ex`, `review/rules.ex`, `review/changes/review.ex`, `review/checks/reviewer.ex`. The reviewer's decision on a pending submission. Entity file: `review.mesh.mx`.

| Item | Hyper | Mesh construct | Docs | Status | Milestone |
|:--|:--|:--|:--|:--|:--|
| `decision` (required), `reasons`, `reviewed_at` | `:62-67` | `enum :decision values=[:accept, :return]`, `string :reasons nullable`, `timestamp on=:create` | [attributes][e-attr] | on main | M2 |
| `submission`, `reviewer` | `belongs_to` `:69-72` | two `belongs-to` | [relationships][e-rel] | on main | M2 |
| identity `one_per_submission` | `[:submission_id]` `:74-76` | none: `unique` goes on an attribute and the relationship's key column is generated | [relationships][e-rel] | not in the docs (G08) | after 1.0 |
| action `accept` | accepts submission; `expected_version`; rules `submission.pending`, `submission.task-version`, `expected-version`; hook `task.complete`; `Review` `:25-41` | `create :accept` | [actions][e-actions] | reviewer: D01, G30; hook: G11; cascade: G05 | M5 |
| action `return` | accepts submission, reasons; `present(:reasons)`; rule `submission.pending` `:42-51` | `create :return` | [actions][e-actions] | M5 | M5 |
| rule `submission.task-version` | the Task has not changed since submission (`review/rules.ex:11-26`) | a check through `&submission.task.version` | [validate][e-validate] | documented, not built (M5) | M5 |
| rule `expected-version` on the Task | `review/rules.ex:28-41` | a check on the same read | | M5 | M5 |
| policy | read `Member`; create `Reviewer` `:52-60` | `authorize-if` comparing the actor with `&submission.task.reviewerId` | [policies][e-policies] | M8; the denial's `reviewerId` detail: G22 | M8 |

| Custom module | What it does | Disposition |
|:--|:--|:--|
| `Changes.Review` | settle the submission, and for an accept complete the Task as the reviewer with the rule "review accepted" | Plain code, blocked by G05 |
| `Checks.Reviewer` | only the collaborator the reviewer rule names may review | Declaration (policy) |

### 2.13 Completion

Source: `tasks/completion.ex`. How a Task was completed; written by `task.complete` and `review.accept`, kept on reopen. Entity file: `completion.mesh.mx`.

| Item | Hyper | Mesh construct | Docs | Status | Milestone |
|:--|:--|:--|:--|:--|:--|
| `rule` (required text), `completed_at` | `:41-45` | `string :rule`, `timestamp on=:create` | [attributes][e-attr] | on main | M2 |
| `task`, `submission` (optional), `completed_by` | `belongs_to` `:47-51` | three `belongs-to` | [relationships][e-rel] | on main | M2 |
| index on `task_id` | `:21-24` | none | | G08 | none |
| action `record` | accepts task, rule, submission, completed_by `:29-34` | `create :record` | [actions][e-actions] | on main | M2 |
| policy | read `Member`; no write policy (engine only) `:35-39` | engine-only policy | [policies][e-policies] | G20 | M8 |

No custom module.

### 2.14 LateResult

Source: `tasks/late_result.ex`, `late_result/rules.ex`. A result delivered under an expired or revoked fence the actor held. Entity file: `late-result.mesh.mx`.

| Item | Hyper | Mesh construct | Docs | Status | Milestone |
|:--|:--|:--|:--|:--|:--|
| `fence`, `summary`, `recorded_at` | `:51-57` | attribute lines | [attributes][e-attr] | on main | M2 |
| `evidence` | array of ids `:55` | JSON text | | G10 | none |
| `task`, `holder` | `belongs_to` `:59-62` | two `belongs-to` | [relationships][e-rel] | on main | M2 |
| action `record` | accepts task, fence, summary, evidence; holder = actor; rules `claim.stale-fence`, `evidence.exists` `:30-40` | `create :record` | [actions][e-actions] | holder: D01, G30; `stale-fence` reads the Task's claims (G07) | M5, M7 |
| policy | read `Member`; record `owner, member` `:41-49` | two policies | [policies][e-policies] | M8 | M8 |

No custom module.

### 2.15 Run

Source: `runs/run.ex`, `run/rules.ex`, `run/changes/{start_run,end_run}.ex`, `runs/checks/reporter.ex`. One reported execution of a Task. Entity file: `run.mesh.mx`.

| Item | Hyper | Mesh construct | Docs | Status | Milestone |
|:--|:--|:--|:--|:--|:--|
| `inputs` (map, required, default `{}`), `outcome` (map) | `:92-93` | `string` holding JSON | [attributes][e-attr] | not in the docs (G10) | none |
| `cancel_reason`, `ended_at`, `version`, `started_at` | `:94-97` | attribute lines | [attributes][e-attr] | on main | M2 |
| `state` and machine | running to canceled, succeeded, failed `:30-38` | `enum :state` | | G03 | none |
| `task`, `responsible`, `started_by`, `parent_run`, `attempts` | `:101-105` | five relationships | [relationships][e-rel] | on main only with the self-import (D06, G28) | M7 |
| action `start` | accepts task, inputs, parent_run; starter = actor; responsible = the Task's assignee else the starter; rules `role`, `run.task-open`, `run.parent-running`; `StartRun` `:43-55` | `create :start` | [actions][e-actions] | D01 for both relationships; the assignee lookup: G07 | M5 |
| action `cancel` | arg `reason`; rule `run.cancelable`; transition; `EndRun`; Version `:56-66` | `update :cancel` | [do][e-do] | M5 | M5 |
| action `settle` | engine-only; arg `state` in {succeeded, failed} `:67-75` | `update :settle`, engine policy | | G20 | M5, M8 |
| policy | read `Member`; start `owner, member`; cancel `Reporter as: :run_canceler` `:76-88` | three policies | [policies][e-policies] | M8 | M8 |

| Custom module | What it does | Disposition |
|:--|:--|:--|
| `Changes.StartRun` | responsible = the Task's current assignee, else the starter | Expression over the Task's assignments (G07) |
| `Changes.EndRun` | `ended_at` now, `cancel_reason` from the argument | Declaration (`set`) |
| `Checks.Reporter` (as `run_canceler`) | the responsible collaborator, the starter, the Task's delegator, or an owner | Declaration (policy) |

### 2.16 Attempt

Source: `runs/attempt.ex`, `attempt/rules.ex`, `attempt/changes/{start_attempt,end_attempt,settle_run}.ex`, `runs/checks/reporter.ex`. One try at a run's step, reported by its performer. Entity file: `attempt.mesh.mx`.

| Item | Hyper | Mesh construct | Docs | Status | Milestone |
|:--|:--|:--|:--|:--|:--|
| `step` (default `"main"`), `number`, `claim_fence`, `runtime`, `ended_at`, `version`, `started_at` | `:127-136` | attribute lines | [attributes][e-attr] | on main | M2 |
| `outcome` | map `:133` | JSON text | | G10 | none |
| `state` and machine | running to succeeded, failed, stopped, abandoned `:35-44` | `enum :state` | | G03 | none |
| `run`, `task`, `performer`, `delegator`, `machine`, `session` | `belongs_to` `:140-145` | six `belongs-to` | [relationships][e-rel] | on main | M2 |
| unique index `(run_id, step, number)` | `:30-33` | none | | G08 | after 1.0 |
| action `start` | accepts run, step, runtime, session; arg `machine` (a host name); performer = actor; rules `role`, `attempt.claimer`, `run-running`, `step-idle`, `attempt.session`; `StartAttempt`; `ReportMachine` `:49-69` | `create :start` | [actions][e-actions] | D01 for performer, task, delegator; `number` is an expression over a filtered count (D04, G07); machine find-or-create: G05 | M5 |
| action `finish` | args `result`, `outputs`, `evidence`, `error`, `expected_version`; rules `attempt.running`, `attempt.error`, `attempt.evidence`; transition from an argument; `EndAttempt`; Version; `SettleRun` `:70-89` | `update :finish` | [input][e-input] | the map and array arguments: G10; cascade: G05 | M5 |
| action `report_stopped`, `abandon` | `:90-110` | two `update` actions | [do][e-do] | M5 | M5 |
| policy | read `Member`; start `Reporter as: :claimer`; finish, report_stopped, abandon: the performer only `:111-125` | policies | [policies][e-policies] | M8 | M8 |

| Custom module | What it does | Disposition |
|:--|:--|:--|
| `Changes.StartAttempt` | under the lock: next number for the step, the run's Task, the delegator, the claim fence | Expression (M4) over the run's attempts and claims (G07) |
| `Changes.EndAttempt` | `ended_at` now; the reported keys become the `outcome` map | Declaration, with the map (G10) |
| `Changes.SettleRun` | when the attempt succeeded, or failed with an error not marked retryable, settle the run | Plain code, blocked by G05 |
| `Checks.Reporter` (as `claimer`) | the actor holds the active claim on the run's Task | Declaration (policy) |

### 2.17 Invocation

Source: `runs/invocation.ex`, `invocation/rules.ex`, `invocation/changes/invocation_task.ex`, `runs/checks/reporter.ex`. One model call made during an attempt. Entity file: `invocation.mesh.mx`.

| Item | Hyper | Mesh construct | Docs | Status | Milestone |
|:--|:--|:--|:--|:--|:--|
| provider and model fields, four token counts (nullable, `min: 0`), `usage_source` (regex), `pricing_basis`, `started_at`, `ended_at`, `reason`, `recorded_at` | `:87-110` | attribute lines; `integer ... nullable min=0` | [attributes][e-attr] | on main | M2 |
| `estimated_cost` | `:decimal`, exact | `decimal`, which is a TypeScript `number` | [attributes][e-attr] | on main with a precision caveat (G38) | none |
| `attempt`, `task`, `session`, `corrects`, `recorded_by` | `belongs_to` `:112-118` | five `belongs-to` | [relationships][e-rel] | on main only with the self-import (D06, G28) | M7 |
| action `record` | accepts the reported fields; recorder = actor; rules `role`, `invocation.session`, `invocation.cost-unknown`; `InvocationTask` `:47-59` | `create :record` | [actions][e-actions] | D01; the task copied from the attempt | M5 |
| action `correct` | accepts `corrects` and `reason` and the fields; rules `not-corrected`, `reason`, `cost-unknown` `:60-72` | `create :correct` | [actions][e-actions] | `not-corrected` reads other invocations (G06, G08) | M5 |
| policy | read `Member`; record `Reporter as: :attempt_performer`; correct `Reporter as: :invocation_corrector` `:73-85` | two policies | [policies][e-policies] | M8 | M8 |

| Custom module | What it does | Disposition |
|:--|:--|:--|
| `Changes.InvocationTask` | copy the attempt's Task (and a corrected invocation's attempt) onto the record | Declaration (`set` from a related read) |
| `Checks.Reporter` (as `attempt_performer`, `invocation_corrector`) | the performer; the recorder or an owner | Declaration (policy) |

### 2.18 Event

Source: `pipeline/event.ex`, `pipeline/changes/write_pipeline.ex`, `pipeline/workspace_lock.ex`, `transport/events.ex`. The append-only log of every write, with a gap-free `seq`. Entity file: `event.mesh.mx`.

In the spec's v0 the log holds typed domain events (`claim.acquired`, `task.completed`) with payloads, a cause and the aggregate root, not row changes (section 3.2); this entity models the engine's v2 log. Under v0 the application also keeps the table from (entity, action) to event type.

| Item | Hyper | Mesh construct | Docs | Status | Milestone |
|:--|:--|:--|:--|:--|:--|
| `seq` | integer primary key, `max + 1` under the lock `:136`, `:77-100` | `integer :seq primary-key` | [attributes][e-attr] | an integer key cannot be created: Mesh fills only a `uuid` key, and `&seq` as an input is refused (D02, D07) | none |
| `resource`, `action`, `record_id`, `record_version`, `task_id`, `actor_id`, `caller`, `command_id`, `changes` (map), `occurred_at` | `:137-146` | attribute lines; `changes` as JSON text | [attributes][e-attr] | on main; the map: G10 | none |
| index `(task_id, seq)` | `:40-43` | none | | G08 | none |
| one row per write | global change on every resource | none | | not in the docs (G12) | none |
| `pub_sub` after commit | `:45-50` | none | | not in the docs (G13) | none |
| action `record` | engine-only, appends under the lock `:77-109` | `create :record` | | G12, G20 | none |
| action `restore` | import: rows with their own `seq` `:110-122` | none | | G18 | none |
| read `read` | args `after`, `task_id`, `task_ids`, `limit` (default 200, max 1000); sort `seq`; subtree filter `:56-76` | `read :after` with two args | [reads][e-reads] | filter and sort: M4. The subtree is a recursive walk (G36) | M4 |
| policy | read: members, filter on `seq`; record, restore: always `:123-133` | two policies | [policies][e-policies] | M8 | M8 |

| Custom module | What it does | Disposition |
|:--|:--|:--|
| `Changes.WritePipeline` (the append and the broadcast) | section 1 | No place (G12, G13). It needs a seam on every write |

## 3. Protocol and runtime features outside the resources

These are the parts of the engine that no resource declares. For each: where it lives, what the Mesh answer is, and who owns the code in the port. "Application" means the Hyper repository, written against the generated functions; it is not a Mesh feature. "Mesh needs" says what, if anything, the framework must add before the application can do it.

| # | Feature | Hyper (source) | Mesh construct | Docs | Status | Mesh needs | Milestone |
|:--|:--|:--|:--|:--|:--|:--|:--|
| 3.1 | **HTTP server on a Unix socket**, mode 0600, started inside the application tree | `application.ex:84-110`, `transport/router.ex:47-50` | Application code: `Bun.serve({ unix })` calling the generated functions ([ADR-0005], [using: over HTTP][u-http]) | [using your domain][using] | not in the docs for a socket; HTTP "after v1" ([roadmap, section 6][roadmap]) | Nothing, except 3.2 | none |
| 3.2 | **RPC surface**: 61 `rpc_action`s, one per command or query, with a generated typed client (`client/ash_rpc.ts`, 98 KB) | `transport/rpc.ex:14-157` | The generated action functions are the surface. There is no manifest a generic dispatcher can read, and no typed client | [using your domain][using]; "Typed client, OpenAPI" is after v1 ([roadmap, section 6][roadmap]) | documented, not built | An action manifest (name, entity, type, input schema) for generic dispatch, and a typed client (G14). The port needs neither: the spec's v0 dispatches a fixed method table that the application writes once | none; after 1.0 |
| 3.3 | **RPC envelope**: always HTTP 200, `{success, data}` or `{success: false, errors: [{type, message, shortMessage, details, fields, path}]}`, `/rpc/validate`, field selection (`fields`), generic `filter`, `sort`, `page` | `transport/router.ex:52-86`, `transport/rpc_error.ex:1-31`; `NOTES.md` section 3 | Application code maps `InvalidInputError.issues`, `ForbiddenError.breakdown` and `NotFoundError` to the envelope. A read takes `{ filter, sort, limit, offset, load }` as plain data | [errors][u-errors], [filters][u-filters] | filters: documented, not built (M3); the rest is application code | A validate-only entry point (parse and check without writing) and field selection are not in the docs (G14) | M3 for filters |
| 3.4 | **Actor and caller headers**: `x-hyper-actor` loads the Collaborator as the actor; an unknown or retired actor is refused before any action; `x-hyper-caller` is recorded on every event | `transport/router.ex:102-123` | `ActionContext` with `actor`, plus the application's own keys `caller` and `commandId` ([ADR-0059]) | [the action context][u-context] | on main (the type and the pass-through) | Nothing | M2 |
| 3.5 | **Role of the actor at decision time**: the actor's active Membership is read inside the policy check | `checks/role.ex:16-61` | The application builds `actor.role` before the call and policies test it. The role can go stale between the lookup and the write; an owner revoked in between still passes | [policies][e-policies] | documented, not built (M8). The staleness: G21 | Decide whether a policy may read an entity (a `Membership` lookup by `actor.id`) | M8 |
| 3.6 | **Idempotency-Key**: replay of a committed response for 24 hours, scoped by actor; mismatches are typed errors; 16 tracker shards | `transport/idempotency.ex:1-133`, `transport/idempotency/store.ex` | Application code and one table of its own. Mesh passes `commandId` through the context | none | not in the docs (G15). It is not a framework concern | Nothing | none |
| 3.7 | **Event log**: one `Event` per write, gap-free `seq`, in the writer's transaction | `pipeline/event.ex:77-100`, `write_pipeline.ex:150-160` | No construct. Needs a seam on every write and a gap-free integer key | none | not in the docs (G12) | **A lifecycle seam**: code that runs inside every action's transaction, after the write, knowing entity, action, record, input and actor (G12) | none |
| 3.8 | **After-commit broadcast and the `/events` SSE stream**: cursor replay in pages of 500, a Task-subtree filter that follows moves, keepalive every 15 s, disconnect at 1,000 pending | `pipeline/event.ex:45-50`, `transport/events.ex:1-175` | Application code over reads of Event plus an in-process publisher | none | not in the docs (G13) | **An after-commit seam** (G13) so that nothing is published for a rolled-back write | none |
| 3.9 | **Write serialization**: a FIFO queue, a Postgres advisory lock, per-transaction memoisation, `server.busy` under overload | `pipeline/workspace_queue.ex:47-115`, `workspace_lock.ex:45-117`, `busy.ex:1-179` | `data-sqlite` queues `BEGIN IMMEDIATE` transactions, one at a time. No timeout, no depth bound, no typed refusal | [data layer][in-data-layer] | on main for SQLite (ordering); bounds and refusal: not in the docs (G16) | Nothing for the port: the spec's v0 has no busy error and applies writes one at a time (G16) | none; after 1.0 |
| 3.10 | **Lease sweeper**: expire overdue claims every `sweep_interval_ms` | `tasks/claim/sweeper.ex:19-61`, started at `application.ex:44` | Application code: a timer that calls `expireClaim` with `context.system`. [ADR-0023] and [ADR-0024] defer jobs, and nothing here needs them | none | not in the docs (G17); application code | Nothing, once `expireClaim` can be called with `context.system` (G20, [ADR-0071](../decisions/0071-system-key-on-the-action-context.md)) | none |
| 3.11 | **Plugins**: required checks at two hook points (`task.claim`, `task.complete`). A Bun host runs TypeScript plugins before the transaction. A Lua tier runs inside it, under the write lock, so a WIP limit is race-free. Blocking-condition providers add reasons to a Task | `plugins.ex:1-97`, `plugins/{hooks,lua_plugins,plugin_host}.ex`, `pipeline/hook_points.ex:20`, `pipeline/changes/{hooks,run_hooks}.ex`, `tasks/blocking_condition.ex:1-9` | An extension that contributes a check at a named point of an action's lifecycle ([ADR-0020], [extension host][in-ext]) | the extension host page names tags, transforms, verifiers, emitters, functions, types, tooling hooks and run-time points (named checks, computed fields, policy helpers), none at a lifecycle point of an action | not in the docs (G11, G31) | **Lifecycle seams** (G11, G31): one before the transaction and one inside it after the write. The port keeps only the spec's single `task.claim` hook, which runs before the transaction ([ADR-0073](../decisions/0073-plugins-follow-the-specs-single-hook.md)) | M6 |
| 3.12 | **Workspace export and import** (not in the spec; outside the v0 gate): a tar.gz of `state/<table>.jsonl`, `events.jsonl` and a manifest with SHA-256 checksums; a restore that inserts rows with their own ids, versions, timestamps and event `seq` | `portability/{bundle,export,restore}.ex` (461 lines), `application.ex:69-76` | Application code over the generated reads for export. Import needs a write path that accepts a given id, `version` and `occurredAt`; `on=:create` timestamps "cannot be set" by callers and a `primary-key` is filled by Mesh | [entities: attributes][e-attr] | not in the docs (G18) | A restore path that bypasses id generation, timestamp stamping and checks (G18). Outside the v0 gate | after 1.0 |
| 3.13 | **Bootstrap**: on first start create the workspace, the first owner and its owner membership in one transaction, as the engine | `bootstrap.ex:13-52` | Application code at start-up with `context.system` | none | not in the docs (G33); needs `context.system` (G20, [ADR-0071](../decisions/0071-system-key-on-the-action-context.md)) | Nothing else | M8 |
| 3.14 | **Embedded Postgres 17**, a data directory with a lock file, hosted mode via `--database-url`, three migrations | `persistence/embedded_postgres.ex` and `embedded_postgres/*` (930 lines), `cli.ex:8-188`, `priv/repo/migrations/` | `data-sqlite` already creates the file; `mesh db push` creates the schema. Postgres and `mesh migrate` are M9 | [command line][u-cli] | SQLite: on main. Postgres, migrations: documented, not built (M9) | Nothing: the port runs on SQLite and Postgres follows the gate ([ADR-0072](../decisions/0072-mesh-1-0-is-the-port-gate.md)) | M9, after 1.0 |
| 3.15 | **A single binary** (Burrito) and the daemon's flags | `NOTES.md` (Burrito section), `cli.ex` | `bun build --compile` is "unmeasured" ([roadmap, section 6][roadmap]) | none | not in the docs | Nothing | after 1.0 |
| 3.16 | **Config values reaching rules**: `lease_ms`, `sweep_interval_ms`, queue bounds, page sizes | `claim/changes/lease.ex:29-34`, `cli.ex:31-37` | `context` keys the application sets (`context.leaseMs`) | [the action context][u-context] | on main (the context is open) | Nothing | M2 |

### 3.1 What the application owns, and what Mesh must give it

- **Nothing from Mesh**: 3.1, 3.4, 3.6, 3.15, 3.16. Hyper's own repository writes them against the generated functions.
- **Only the internal-write convention (G20, [ADR-0071](../decisions/0071-system-key-on-the-action-context.md))**: 3.10 and 3.13. Hyper calls its own actions with authorization off; Mesh has no bypass ([ADR-0055]). Revision 5 adds a reserved `system` key on `ActionContext` that the application sets and write policies admit.
- **A Mesh addition**: the action manifest (3.2), the bounded write queue (3.9), the restore path (3.12), and **three lifecycle seams** (3.7, 3.8, 3.11). The seams are one idea three times: the generated action has a transaction, and the application must put code in it at named points (before it opens, inside it after the write, after it commits). Hyper's whole event log, its plugin tiers and its broadcast are code at those points.
- **Decided by the choice of contract**: 3.14 (the port does not need Postgres) and 3.3's validate-only entry and field selection (the port follows the spec's v0 wire, which has neither; [ADR-0072](../decisions/0072-mesh-1-0-is-the-port-gate.md)).

### 3.2 The same features against the spec's v0 protocol

Source: `PROTOCOL.md` on the `protocol-phases` branch of the `hyper` repository (`engine/code/spec`) (368 lines; section numbers below are its own), `schemas/protocol.ts`, `PLUGIN-HOST.md`, and the 126 `test(` cases in `conformance/01..10-*.test.ts` (13, 19, 17, 10, 18, 18, 11, 9, 3, 8). The suite is black box: `ENGINE_CMD="..." bun test conformance` starts the engine as `<cmd> --socket <path> --db <path> [--lease-ms n] [--plugins dir]`, waits for `READY` on stdout, speaks JSON-RPC and validates every response against the schemas (strict by default; `SCHEMA_STRICT=0` only downgrades violations to warnings). It is TypeScript and runs under Bun as it stands. The engine's v2 does not pass it (NOTES section 1: v2's wire "no longer binds"); `test/behaviour/` is the suite ported to ExUnit and its HTTP router.

| Topic | v0, the spec | v2, the engine (section 3.1) | Consequence for the port |
|:--|:--|:--|:--|
| Transport (§1) | Newline-delimited JSON-RPC 2.0 over a Unix socket; `Bun.listen({ unix })`; notifications on the same connection; batch refused with `-32600`; requests may pipeline, writes are serialised | HTTP/1.1 `POST /rpc/run`, `GET /events` SSE | Application code either way. v0 is the simpler Bun program and needs no manifest for dispatch beyond the method table |
| Daemon (§2) | `--socket --db --lease-ms --plugins`; `READY` on stdout; exit 0 within 5 s of `SIGTERM`; consistent after `SIGKILL` (every command is one transaction); `--db` is a SQLite file in WAL mode | `--socket --data-dir/--database-url ...`, Postgres | The spec pins SQLite, which is `data-sqlite` as it stands. Evidence for running the port on SQLite ([ADR-0072](../decisions/0072-mesh-1-0-is-the-port-gate.md)) |
| Bootstrap (§3) | Empty database: register owner, create workspace, grant owner; events seq 1 to 3 (`collaborator.registered`, `workspace.created`, `membership.granted`), actor and caller `"engine"`, cause rule `workspace.bootstrap`; `workspace.get` needs no actor | `bootstrap.ex:13-52` with `authorize?: false` | Application code with the engine actor (G20, G33) |
| Envelope (§4.1) | `commandId` (required, client chosen), `actor`, `caller`, `expectedVersion`, `payload`; the method names of the proposal (`task.complete`, `claim.acquire`) | `Idempotency-Key`, `x-hyper-actor`, `x-hyper-caller` headers; `expected_version` argument | The application maps methods to generated functions. `expectedVersion` is checked against the **target aggregate's** version (see Versions) |
| Idempotency (§4.3) | The result and a canonical hash of `{method, params}` are stored **in the same transaction as the change**; a repeat returns the stored result; a different request with the same id is `-32006`; rejections are not stored | A separate store, outside the action's transaction (`NOTES.md` section 6) | Stronger than v2: needs an application table written inside the command's transaction, so the seam `afterWrite` (or the command wrapper) must reach `tx` (G15 is no longer purely "app") |
| Check phases (§4.4, §7) | Four phases `shape`, `permission`, `content`, `hooks`; a phase runs only if the earlier ones passed; a rejection names its phase and lists that phase's failures, `data: { phase, failures: [{check, reason, details}] }`; codes `-32001` to `-32006`; a missing record or one the actor cannot access is the same `not_found` | One flat list of Ash errors with `type` | Mesh's order is validate-input, authorize, validate, steps ([ADR-0053]); the application classifies a failure into a phase from the error class (`InvalidInputError.issues[].label`, `ForbiddenError.breakdown`, `NotFoundError`). `details` on checks (G22) is required by the suite, not optional |
| Versions (§4.5) | **The Task aggregate** has one version: it includes assignments, dependencies (as dependent), claims, submissions, reviews and completions, so `claim.acquire` and `claim.renew` bump the Task's version; a late result does not | **Per resource**: `claim.renew` never touches the Task (`NOTES.md` section 6) | The Task cascades must bump `Task.version` (a `set` in the cascade). The entity drafts follow v2 and bump the Claim's version; under v0 they change |
| Events (§6) | Typed **domain events** (`claim.acquired`, `task.completed`), `schemaVersion`, `record` = the aggregate root, `taskId`, `actor`, `caller`, `occurredAt`/`recordedAt`, `cause` (command, event or rule), `checks`, a per-type `payload`; appended in the same SQLite transaction; ordering table in §6.1 (for example `task.complete`: `submission.submitted`, `task.completed`, `claim.released`) | A row-change log: `resource`, `action`, `record_id`, `changes` (`event.ex:135-147`) | A generic `afterWrite` seam yields row changes, not these events. The application keeps a table from (entity, action) to event type and payload builder: more code than v2, and the order of §6.1 differs from v2's in places (`task.complete` puts `task.completed` before `claim.released`; `review.accept` puts its own event first, as v2 does) |
| Queries (§5) | `workspace.get`, `task.get` (task plus a history of assignments, claims, submissions with reviews, late results and completions), `task.list`, `task.next`, `events.read` (`after`, `limit`, `taskSubtree`, `types`; returns `cursor`, `hasMore`); a Task view with `derived: {state, reasons}`, `dependsOn`, `assignment`, `activeClaim`, `pendingSubmission`, `reviewer` | `get_task`, `list_tasks`, `next_task`, `list_events` with field selection | Application code over generated reads; the Task view is built with loads (M7) |
| Subscriptions (§8) | `events.subscribe { after, taskSubtree?, types? }`: response first, then backlog, then live notifications on the same connection, at least once, subtree evaluated at delivery | SSE | Application code over the Event table and an after-commit publication (G13) |
| Lease expiry (§9) | `claim.expired` within 1,000 ms after `expiresAt`, actor `engine`, cause rule `claim.lease-expiry`, even when no command touches the Task | `Claim.Sweeper` | Application timer (G17) |
| Stale fences (§9) | A submit or a complete with a fence the actor held that is now expired or revoked **succeeds** with `outcome: "late-result-recorded"` and commits only `claim.late-result-recorded` | `claim.current-fence` error with `details.stale` and a separate `record_late_result` | A different behaviour: an action that returns success and writes a different row. v2's check plus a separate action is not conformant |
| `task.complete` with summary or evidence (§9) | Records an accepted submission first, then completes; with the actor's own pending submission, accepts it | Not implemented in v2 (`NOTES.md` section 6, "Not implemented") | New behaviour for the port, a cascade (G05) |
| Dependency warnings (§9) | `task.complete` and `review.accept` succeed and list open prerequisites in `warnings` | Not implemented in v2 | A result field Mesh's generated action does not have (G25 grows: a result other than the record) |
| Hooks (§9, §10) | One hook, `task.claim`; handlers run after `shape`, `permission` and `content` pass, **outside** the write transaction, a 5,000 ms deadline, killable (Worker, process or the shared plugin host); the engine **re-validates at commit**; all handlers run; passing checks are listed on `claim.acquired`; the TypeScript engine `import()`s plugins in-process | Two hook points and a Lua tier | `beforeTransaction` seam plus a revalidation step in the transaction (a `check` that re-runs, M5). In-process `import()` is allowed, so a Bun port needs the SDK but not the host |
| Export and move (§3) | `workspace.export` and `workspace.move` may answer `-32010 not_implemented` | Export and `:restore` exist | **Outside the v0 gate**: G18 is not required |
| Execution (Run, Attempt, Invocation, Machine, SessionReference) | Not in the spec | The engine's "execution extension" (`NOTES.md`) | **Outside the v0 gate**; six of the 18 entity files serve v2 only |

What v0 adds to the gap analysis: typed events per command (a mapping table, not a seam), aggregate versions on Task, the phased error shape with `details`, an idempotency record written inside the transaction, active lease expiry, two behaviours v2 lacks (late results as successful outcomes, completion with a summary), and the `warnings` result. What it removes: export, import, the six execution entities, SSE, HTTP, the embedded Postgres and the Lua tier.

## 4. Summary: features, who needs them, and the milestone

One row per gap code. "Hyper places" counts uses in the engine's `lib/`. "Rev 4" is the milestone that delivers it in the roadmap as it stands; "Rev 5" is where [revision 5 of the roadmap](../roadmap/roadmap.md) puts it. "Size" is the size of the Mesh work (S, M, L, XL as above; "app" means the Hyper repository writes it and Mesh adds nothing).

| Code | Feature | Hyper places that need it | Rev 4 | Rev 5 | Size |
|:--|:--|:--|:--|:--|:--|
| G01 | Time-ordered UUID primary keys (UUIDv7) | `uuid_v7_primary_key` on all 18 resources; `{:array, :uuid_v7}` in 4 places | none ("not scheduled", [mapping rows 16-17][mapping]) | M3: make `uuid` keys time-ordered | S |
| G02 | Optimistic versions: a `version` column, `expected-version`, a bump per changing action | `version` on 9 resources; the `Version` change in 23 actions (`pipeline/changes/version.ex:13-43`) | M4, M5 (a `check` and a `set`). `lock="version"` is "planned, after v1" ([ADR-0053]) | M5: works as written; no new construct | none |
| G03 | State machines with named transitions | 4 machines, 11 transitions (Task, Claim, Run, Attempt) | none (an extension "none blocks core") | after 1.0; enum plus a `check` per action works | S to M |
| G04 | One rule reused by name across actions and entities, reported with a stable name | 57 rules referenced 94 times in 44 actions (`task.open` 7 times, `role` 7, `claim.active` 4); `pipeline/rule_set.ex`, `rule_registry.ex` | M6, the extension host: "named, reusable checks" ([extension host][in-ext], M6 test 5); [ADR-0053] reusable steps are after v1 | after 1.0 ([ADR-0072](../decisions/0072-mesh-1-0-is-the-port-gate.md)); repeat the `check` meanwhile | M |
| G05 | **An action writes other entities in its own transaction** (cascades), and plain code in an action may call actions | 12 change modules; 13 actions (Task complete, cancel, assign, unassign; Claim acquire; Submission submit; Review accept, return; Collaborator retire; Membership revoke; Attempt start, finish; SessionReference record) | none ([open question 14][oq]: "Grouping several action calls in one transaction is not designed") | **M5** | L |
| G06 | Reading rows of entities the current one has no relationship to, in a check, a step or a policy | 9 rules (`collaborator.name-unique`, `membership.none-active`, `membership.last-owner`, `machine.name-free`, `dependency.duplicate`, `assignment.assignee-role`, `invocation.not-corrected`, `claim.invalidated`, `attempt.step-idle`) and every `Role` check (29 uses) | M7 reads related records only | M5, through G05's transaction handle | M |
| G07 | Filtered relationships, filtered aggregates, and existence tests over a has-many | 3 filtered has-ones; 5 `exists` calculations; about 20 rules and policy checks (`claim.task-ready`, `task.review-required`, `claim.current-fence` in 4 entities, `Manager`, `Revoker`, `Assignee`, `Reporter`) | M7 has unfiltered rollups; `.every` named once; relationship options "not scheduled" ([mapping rows 42-46][mapping]) | M7 minimal; filtered forms after 1.0 (plain code covers them) | M |
| G08 | Composite and partial unique constraints, plain indexes | 4 partial unique indexes, 3 composite identities (SessionReference, Claim, Dependency), 1 composite unique index (Attempt), 5 plain indexes; the 2 single-column identities (Machine `name`, Review `submission_id`) are `unique` on an attribute, which Mesh has for Machine and not for a relationship key | after v1 ([mapping rows 78-79][mapping]) | after 1.0; correct without them while one writer runs | M |
| G09 | Upsert | `SessionReference :record` (1 action) | after v1 ([mapping row 62][mapping]) | after 1.0; application find-or-create through G05 | M |
| G10 | Array and map (JSON) attribute types | `evidence` x2, `inputs`, `outcome` x2, `changes`; `Attempt :finish` arguments; `blocked_reasons` and `owner_ids` results | none ([mapping row 34][mapping]: arrays "not scheduled") | M3: a `json` type | M |
| G11 | Contributed run-time checks at named points of an action (plugin hooks, blocking conditions) | 2 hook points on 3 actions; 3 provider call sites; 755 lines of plugin host and Lua | M6 manifest names "tooling hooks" and run-time points, not a check at a lifecycle point ([extension host][in-ext]); the [action lifecycle](../in-depth/action-lifecycle.md) page gives each phase an extension point (steps, authorizer slot, policy checks, data layer, tracer) and "none in v1" for commit | M6 provides the seams; the plugin host is application code | L |
| G12 | An event row for every write, in the same transaction, with a gap-free sequence | 18 resources, every create, update and destroy (`write_pipeline.ex:150-160`). The spec's v0 events are typed domain events with payloads, causes and aggregate roots, not row changes (section 3.2) | none, but see below | M6 (the seam) and M3 (the integer key). Alternative to a global seam: an `always types=[:create, :update, :destroy]` block with an after-write `run` on each of the 18 entities, once G05 exists: 18 blocks that repeat, no new construct; revision 5 chose the seam ([ADR-0075](../decisions/0075-seams-use-the-extension-hosts-names.md)) | M |
| G13 | After-commit publication and a replaying stream | `/events`: 175 lines; `pub_sub` on Event; the spec's `events.subscribe` (PROTOCOL §8) | `after-commit` is "planned, not in v1" ([ADR-0053]; [mapping row 71][mapping]) | M6 (the seam); the stream is application code | S |
| G14 | A transport: socket, envelope, typed client, validate-only entry, field selection | 61 `rpc_action`s; `router.ex`; `client/ash_rpc.ts` | after v1 ([ADR-0005], [roadmap, section 6][roadmap]) | After 1.0 (the manifest); the transport is application code | M |
| G15 | Idempotency-Key replay | `transport/idempotency.ex` and store (247 lines). The spec's v0 stores the command id, hash and result in the command's own transaction (PROTOCOL §4.3) | none | app, with a write inside the command's transaction (the `afterWrite` seam, M6) | app |
| G16 | A bounded write queue and a typed refusal under load | `workspace_queue.ex`, `busy.ex` (294 lines) | none | After 1.0: the spec's v0 has no busy error | S |
| G17 | Periodic background work | the lease sweeper (61 lines) | after v1 ([ADR-0023]) | app | app |
| G18 | Export and import, and a restore write path | `portability/` (461 lines); `:restore` on 18 resources. Not in the spec: `workspace.export` is `-32010 not_implemented` there (PROTOCOL §3) | none | after 1.0, with the export extension: a restore path (a bypass of checks and stamps); the bundle is application code, and both are outside the v0 gate | M |
| G19 | A second database, migrations, embedded server | `persistence/` (930 lines), 3 migrations | M9 | M9, after 1.0 ([ADR-0072](../decisions/0072-mesh-1-0-is-the-port-gate.md)) | L |
| G20 | A way for internal and nested writes to pass authorization (a reserved `system` context key, [ADR-0071](../decisions/0071-system-key-on-the-action-context.md)) | `authorize?: false` at 70 call sites in `lib/` (bootstrap, sweeper, export, 11 nested change modules) | none ([ADR-0055]: no bypass) | M8: the `system` key ([ADR-0071](../decisions/0071-system-key-on-the-action-context.md)) | S |
| G21 | The actor's role read from the database at decision time | `Role` in 29 places | M8 reads `actor` only | M8: a write policy reads the actor's membership through `tx` inside the transaction, so the role cannot go stale ([ADR-0074](../decisions/0074-write-policies-may-read-through-tx.md)) | S |
| G22 | Stable error names and a `details` payload | 57 rule names, 14 denial names (`membership`, `role`, `task.manager`, `claim.holder`, ...), about 10 detail payloads | M5 gives `code` and `message`; `ForbiddenError.breakdown` gives policy names | M5, M8: add `details` to a check; the rest in the transport | M |
| G23 | `now()` in expressions and engine-set timestamps | 25 uses of `now()` in filters and rules, 5 `set_attribute ... utc_now` | M4 registry has `today()` | M4 | S |
| G24 | Microsecond timestamps | 12 `utc_datetime_usec` attributes | none | accept milliseconds | S |
| G25 | A result other than the record: metadata in v2; `warnings` and `outcome: "late-result-recorded"` in the spec's v0 (PROTOCOL §9) | `Task :assign` (1) in v2; `task.complete`, `review.accept`, `submission.submit` in v0 | none | M5: an application-level transaction over the bound actions (before the gate) | S |
| G26 | Generic (non-CRUD) actions | `Workspace :export`, `:stats` (2) | not planned ([mapping row 55][mapping]) | app | app |
| G27 | A post-query preparation | `Task :next` (1) | none | app | app |
| G28 | Relationship shapes: to itself, several to one entity, choosing the inverse | 4 self-references; Membership has 3 keys to Collaborator, Dependency 2 to Task, Run and Invocation 2 to Collaborator | M7, not described | M7 | M |
| G29 | Structured computed results (a list of maps) | `blocked_reasons` | none | G10 | M |
| G30 | Setting a relationship in a step (`relate_actor`) | 17 `relate_actor` uses: 16 on create actions, 1 on `Membership :revoke` | M5 documents `set` of fields only. The docs do show recording the actor in a plain attribute (`uuid :paidById nullable`, `&paidById=({ actor }) => actor.id`: [entities][e-attr], [ADR-0050]) | M5: let `set` name the relationship; or keep the documented plain attribute and lose the `belongs-to` | S |
| G31 | A phase before the transaction for contributed checks | `RunHooks` (3 actions) | M5's "authorizer slot" is empty until M8 | M6 | M |
| G33 | First-run bootstrap | `bootstrap.ex` (52 lines) | none | app | app |
| G34 | Configuration reaching rules | `lease_ms` and 5 others | `context` | works as written | none |
| G35 | The stored value of a field when the action also accepts it | 7 rules (`task.unchanged`, `membership.unchanged`, `kind-immutable`, `assignment.unchanged`, `session.not-redacted`, `session.availability`, `membership.last-owner`) | none ([what `self` holds][e-self]: inputs are applied first) | M5: expose the stored record as `before` in `validate`, or keep the typed-argument pattern. The pattern renames wire inputs (`newTitle`, `newRole`), which the spec's v0 forbids; the entity files change back when `before` exists | S |
| G36 | Recursive traversal (ancestors, subtree, cycles) | `task.no-cycle`, `dependency.no-cycle`, `Event.subtree` | none | M5, as plain code over G05 | S |
| G37 | Null ordering in a sort | `Task :next` (1) | none | app | S |
| G38 | Exact decimals | `Invocation.estimated_cost` (1) | none: `decimal` is a `number` | decide the representation in M3 | S |

### 4.1 Reading the table

- **Three gaps are Mesh features the port cannot route around.** G05 (an action writing other entities in its transaction, and plain code calling actions) because 13 actions are cascades. The **lifecycle seams** (G11, G12, G13, G31) because the event log, the plugin tiers and the broadcast all live there. And **G10** (a JSON type) because six attributes and two argument shapes are maps or arrays of ids. Everything else has a workaround.
- **Twelve gaps are replaced by plain code once G05 exists**: G04, G06, G07, G08 (as checks), G09, G22 (partly), G25, G27, G30 (via input and a check), G36, G37 and G38. The port is then less declarative than Hyper and is done earlier.
- **Six rows need nothing from Mesh**: G15, G17, G26, G27, G33, G34. The application halves of G13, G14 and G18 add three more.
- **Seven rows are conventions or decisions, not code**: G02 and G03 (works as written), G20 and G21 (a reserved `system` context key, and a role on the actor read through `tx`), G24 (accept milliseconds), G25 (the application builds `warnings` and `outcome`), G38 (pick a representation).

## 5. What today's compiler said about the entity files

### 5.1 How the compiler was run

`examples/blog` was copied to a scratch directory (its `node_modules` links re-pointed at the checkout's packages). Its `src/domain/blog/` was replaced with the 18 entity files, and `hyper.helpers.ts` was added in `src/domain/hyper/`. The blog's own check, `mesh build --check` (`examples/blog/package.json`, script `validate`), was run with `bun node_modules/.bin/mesh`. Where a pass stopped at errors, a variant that removes the offending lines was made, to see the next stage. The scratch directory was deleted afterwards.

Mesh reports in stages. The contract and model stage reports all its errors; the emit stage (the generators) throws on the first problem it meets. So the list below is in the order the compiler revealed it, and each entry says which stage found it.

### 5.2 The diagnostics

"Docs gap" means the documentation has no construct or sentence for it, and the code agrees with the docs' silence. "Code gap" means the docs describe it and the code refuses or skips it, with the milestone. "Author's mistake" means the entity file broke a rule the docs state, and was fixed.

| ID | Stage | Diagnostic (abbreviated) | Sites | Verdict | Notes |
|:--|:--|:--|:--|:--|:--|
| D01 | model | `&creator is not a member of :Task.` (`&holder`, `&recordedBy`, `&submitter`, `&reviewer`, `&grantedBy`, `&task`, `&attempt` ...) | 22 `set` lines in 13 files | **Docs gap, narrower than it looks** | `set` takes attributes only (`packages/compiler/src/build.ts:669-679`: for scope `set` the allowed members are `entity.attributes`). The docs do show recording the actor: a plain attribute and `&paidById=({ actor }) => actor.id` ([entities: larger example][e-attr], [ADR-0050]). That is a documented spelling of `relate_actor`; what it loses is the `belongs-to` (the key column is generated and "the entity file names the relationship, never its generated key column", [relationships][e-rel]). The gap is setting a declared relationship's key from a step (G30). Accepting the relationship in `input` and checking it equals `actor.id` also works but changes the wire. |
| D02 | model | `&seq is set by Mesh and cannot be an input` | `event.mesh.mx:36` | **Code gap, and a docs gap** | The vocabulary mapping lists "`uuid_v7` and integer keys" as not scheduled ([rows 16-17][mapping]), yet the contract accepts an `integer` or `string` `primary-key`; it is accepted by the contract (`contracts.ts`: `primary-key` on `uuid`, `integer`, `string`) and cannot be input. P14 reproduces it in a 3-line entity. |
| D03 | model | `max needs a number, date or datetime, &occurredAt is :timestamp` | `task.mesh.mx:70` | **Docs gap** | [Computed][e-comp] lists `max` without operand types. `timestamp` is an attribute type ([attributes][e-attr]), so a rollup over it is a natural thing to write. |
| D06 | model | `Task is not an imported entity.` | 4 sites: `Task.parent`, `Task.children`, `Run.parentRun`, `Invocation.corrects` | **Docs gap**, fixed | A relationship to the entity's own type needs `import { Task } from "./task.mesh.mx"` inside `task.mesh.mx`. With that import the build accepts it. The docs show imports of other entities only (G28). Fixed in the files. |
| D07 | emit | `A primary key cannot be nullable` (after `&seq` is removed from the input, the create "cannot fill `seq`") | `event.mesh.mx` | **Code gap, and a docs gap** | With D02 this makes an `integer` key unusable on a create: it cannot be sent and Mesh fills only `uuid` keys (`views/actions.ts:281`, `uuidKey: attribute.primaryKey && attribute.type === "uuid"`). The docs say a `primary-key` is "filled by Mesh on create" ([attributes: options][e-attr]) and generate only a UUID. |
| D04 | emit | `Create action :acquire of :Claim cannot fill `fence`: it is not accepted, has no default and is not nullable` | 7 attributes: `Assignment.startedAt`, `Attempt.number`, `Claim.fence`, `Claim.acquiredAt`, `Claim.expiresAt`, `Membership.grantedAt`, `Submission.taskVersion`; plus 17 relationship keys that D01 left unfilled | **Code gap**, documented, not built (M4, M5) | The generated create applies only a constant `set`; a value written as an arrow does not count (`views/actions.ts:141-149`, `:262-282`). The docs say "a create's required attribute must be ... set by a step" ([input][e-input]). The message reads as a mistake in the file and never says that the limit is a milestone. [ADR-0018] asks for a message that names it. |
| D05 | emit | `Destroy action :remove of :Dependency: a destroy action accepts no attributes in this version` | `dependency.mesh.mx:49` | **Code gap**, documented, not built (M5) | [Using your domain][u-destroy] says "A destroy that accepts fields takes them after the id". |

The compiler caught no author's mistake. Three of the kind it cannot catch were made and fixed: `Membership.changeRole`, `SessionReference.setAvailability` and `Task.update` first compared `input.x` with `&x`, but `validate` sees the record with the member inputs already applied, so `&x` was the new value ([what `self` holds][e-self]). They were rewritten with typed arguments (G35).

### 5.3 What passes, and what the generated code does

After removing the D01 `set` lines, writing `Event` as `uuid :id` plus `integer :seq unique`, replacing the timestamp `max` with a `count`, adding the four self-imports, making the 24 attributes of D04 `nullable` and dropping the `input` of `destroy :remove`:

- `mesh build`: **0 errors, 0 warnings.** It writes 18 x 3 entity files, `index.ts`, `schema.ts` and `model.json` (365 KB).
- `tsc --noEmit` over `.mesh/`, the config and the helpers: clean.
- `mesh db push`: `applied 18 statements to blog.db` (one `CREATE TABLE` per entity).
- A policy with two `authorize-if` lines is accepted and stored as a list. A `has-many` over an entity with three keys back (`Collaborator.memberships`, `Task.dependencies`) is accepted without saying which key it follows: the model records no key. A `run` body that calls an action (`await updateK(...)`, P10) is accepted, and so is `now()` (P11): bodies are stored as text.

Smoke test of the generated functions against `blog.db` (S1-S4):

| ID | Call | Result |
|:--|:--|:--|
| S1 | `registerCollaborator({ kind: "human", name: "ann" }, { actor })` | Row created, `state: "active"`. |
| S2 | `createTask({ title: "t1" }, { actor })` | Row created, `state: "open"`, `version: 1`, `creatorId: null`. |
| S3 | `completeTask({ id }, { actor: { role: null } })` | Returns the Task unchanged (`state: "open"`, `version: 1`): no policy ran, no check ran, and the `set` block that mixed `&state=:done` with `&version=...` was dropped whole. The generator's comment lists them as "Not run in this version". |
| S4 | `listTask`, `nextTask` | `FrameworkError: ... cannot run in this version: its filter and sort are evaluated from M4`. |

### 5.4 Probes: what the contracts reject

One small entity file per question; each ran alone. Rows with 0 errors are findings too.

| ID | Probe | Result | Verdict |
|:--|:--|:--|:--|
| P01 | `has-one :current entity=B filter=() => ...` | `<has-one>: unknown attribute filter` | not in the docs (G07) |
| P02 | `json :data`, `array :tags` | `<json> is not a known tag` | not in the docs (G10) |
| P03 | `uuid_v7 :id primary-key` | `<uuid_v7> is not a known tag` | not in the docs (G01) |
| P04 | `identities` with `identity :ab fields=[&a, &b]` | `<identities> is not a known tag` | not in the docs (G08) |
| P05 | `string :a unique=[&a]` | `attribute unique must be a literal` | not in the docs (G08) |
| P06 | `state-machine` with `transition` | `<state-machine> is not a known tag` | not in the docs (G03) |
| P07 | `count :open of="bs" filter=...` | `<count>: unknown attribute filter` | not in the docs (G07) |
| P08 | `lock="version"` in an update | `<lock> is not a known tag` | planned after v1 ([ADR-0053]) |
| P09 | `after-commit() { }` in `do` | `<after-commit> is not a known tag` | planned after v1 ([ADR-0053]); G13 |
| P10 | `run({ self }) { await updateK({ id: self.id }) }` | 0 errors | accepted; the body is not checked, and nothing documents a handle for it (G05) |
| P11 | `&at=() => now()` | 0 errors | accepted; `now()` is not in the registry the docs list (G23) |
| P12 | `create :make upsert=true` | `<create>: unknown attribute upsert` | planned after v1 ([mapping row 62][mapping]) |
| P13 | `action :export` (a generic action) | `<action> is not a known tag; did you mean <actions>?` | not planned ([mapping row 55][mapping]) |
| P14 | `integer :seq primary-key` plus a create with `&seq` | `&seq is set by Mesh and cannot be an input` | D02 |
| P15 | `indexes` with `index :ia fields=[&a]` | `<indexes> is not a known tag` | not in the docs (G08) |
| P16 | `string :a description="hello"` | `<string>: unknown attribute description` | not scheduled ([mapping row 26][mapping]) |

### 5.5 Status of each file

| File | As written | Why | After the variant edits |
|:--|:--|:--|:--|
| `assignment`, `collaborator`, `completion`, `workspace` | model stage passes | no relationship `set`, no integer key | emit: `assignment` needs D04; the others build |
| `attempt` (3), `claim` (1), `dependency` (1), `evidence-reference` (1), `invocation` (5), `late-result` (1), `machine` (1), `membership` (2), `review` (2), `run` (2), `session-reference` (1), `submission` (1) | **fail**, D01 | `set` of a relationship | build, with D04 and D05 at emit |
| `event` | **fails**, D02 | integer primary key | builds as `uuid :id` plus `seq unique` |
| `task` | **fails**, D01 and D03 | `&creator`; `max` of a timestamp | builds |
| `hyper.helpers.ts` | resolves | imported by every file (`build.ts:847-870` requires an imported helper to exist) | resolves |

Placeholder checks (`that=() => true`) stand in for rules Mesh cannot express: `collaborator.nameFree`, `task.noCycle`, `task.notBlockedByProviders`, `task.assigneeIsWorker`, `dependency.notDuplicate`, `dependency.noCycle` and `invocation.notCorrected` (seven uses in four files). They build green and hide the rule, so the gate review counts them.

## Appendix A. The 57 named rules

A rule has a stable name that clients branch on and a reason that says what to do. In Mesh each becomes a `check :label [ that code message ]` whose `code` is the Hyper name (`code="task.open"`; a `code` is a string, so the dots are fine). All 57 are run by `CheckRules` under the write lock, on the reloaded row (`pipeline/changes/check_rules.ex:12-21`). In Mesh, a check that reads `self` makes an update read first and write second, with the row locked ([ADR-0054]): the same guarantee, from M5.

**Form** is what the check is in Mesh. "Record" means it reads `self` and `input` only. "Related" means it reads through a `belongs-to` ([a check may read a related record][e-validate]). "Plain code" means a body that needs G05's transaction handle.

| Rule | Defined | Form | Gap |
|:--|:--|:--|:--|
| `workspace.active` | `workspaces/workspace/rules.ex:7` | Record | none |
| `collaborator.active` | `collaborators/rules.ex:9` | Related (Collaborator by id) | none |
| `collaborator.name-unique` | `collaborators/collaborator/rules.ex:9` | Plain code over siblings | G06, G08 |
| `collaborator.kind-immutable` | `collaborators/collaborator/rules.ex:21` | Record, typed argument | G35 |
| `role` | `memberships/rules.ex:12` | Policy (`canWork(actor)`) | G21, G22 |
| `membership.last-owner` | `memberships/rules.ex:19` | Plain code, count of active owners | G06, G07 |
| `membership.none-active` | `memberships/membership/rules.ex:9` | Plain code over siblings | G06, G08 |
| `membership.active` | `memberships/membership/rules.ex:19` | Record | none |
| `membership.unchanged` | `memberships/membership/rules.ex:22` | Record, typed argument | G35 |
| `machine.name-free` | `machines/machine/rules.ex:9` | `unique` on `name` | none |
| `machine.active` | `machines/machine/rules.ex:18` | Record | none |
| `machine.idle` | `machines/machine/rules.ex:21` | Filtered count of attempts | G07 |
| `session.agent-profile` | `sessions/session_reference/rules.ex:9` | Related | none |
| `session.not-redacted` | `sessions/session_reference/rules.ex:12` | Record | none |
| `session.availability` | `sessions/session_reference/rules.ex:15` | Record, typed argument | G35 |
| `task.open` | `tasks/rules.ex:13` | Record, or Related from six other entities | G04 |
| `claim.current-fence` | `tasks/rules.ex:20` | Related plus a quantifier over claims, 4 variants | G07 |
| `submission.pending` | `tasks/rules.ex:43` | Record, or Related | none |
| `evidence.exists` | `tasks/rules.ex:48` | Plain code over an array of ids | G10 |
| `task.settled` | `tasks/task/rules.ex:13` | Record | none |
| `task.unchanged` | `tasks/task/rules.ex:17` | Record, typed arguments | G35 |
| `task.parent-open` | `tasks/task/rules.ex:24` | Related (nullable) | none |
| `task.no-cycle` | `tasks/task/rules.ex:35` | Plain code, ancestors walk | G36 |
| `task.children-settled` | `tasks/task/rules.ex:40` | `&children.every(...)` | M7 |
| `task.review-required` | `tasks/task/rules.ex:55` | Related plus the reviewer rule | G07 |
| `task.no-foreign-submission` | `tasks/task/rules.ex:70` | Quantifier over submissions | G07 |
| `task.not-blocked` | `tasks/task/rules.ex:82` | Provider call | G11 |
| `task.no-active-claim` | `tasks/task/rules.ex:91` | Quantifier over claims | G07 |
| `claim.invalidated` | `tasks/task/rules.ex:101` | Quantifier plus the event log | G06, G07 |
| `assignment.assignee-role` | `tasks/task/rules.ex:115` | Plain code over Membership | G06 |
| `assignment.unchanged` | `tasks/task/rules.ex:126` | Quantifier over assignments | G07 |
| `assignment.current` | `tasks/task/rules.ex:141` | Quantifier over assignments | G07 |
| `claim.task-ready` | `tasks/claim/rules.ex:14` | Related plus quantifiers | G07 |
| `claim.active` | `tasks/claim/rules.ex:20` | Record | none |
| `claim.expired` | `tasks/claim/rules.ex:28` | Record, `now()` | G23 |
| `submission.none-pending` | `tasks/submission/rules.ex:9` | Quantifier over submissions | G07 |
| `submission.task-version` | `tasks/review/rules.ex:11` | Related | none |
| `expected-version` | `tasks/review/rules.ex:28` | Related, on the Task's version | G02 |
| `claim.stale-fence` | `tasks/late_result/rules.ex:9` | Quantifier over claims | G07 |
| `dependency.exists` | `tasks/dependency/rules.ex:10` | The relationship | none |
| `dependency.distinct` | `tasks/dependency/rules.ex:16` | Related | none |
| `dependency.duplicate` | `tasks/dependency/rules.ex:19` | Plain code over siblings | G06, G08 |
| `dependency.no-cycle` | `tasks/dependency/rules.ex:30` | Plain code, breadth-first | G36 |
| `run.task-open` | `runs/run/rules.ex:10` | Related | none |
| `run.parent-running` | `runs/run/rules.ex:15` | Related (nullable) | none |
| `run.cancelable` | `runs/run/rules.ex:26` | Record | none |
| `attempt.claimer` | `runs/attempt/rules.ex:15` | Quantifier over claims | G07 |
| `attempt.run-running` | `runs/attempt/rules.ex:32` | Related | none |
| `attempt.step-idle` | `runs/attempt/rules.ex:37` | Quantifier over the run's attempts | G07 |
| `attempt.session` | `runs/attempt/rules.ex:51` | Related (nullable) | none |
| `attempt.running` | `runs/attempt/rules.ex:58` | Record | none |
| `attempt.error` | `runs/attempt/rules.ex:61` | Record, typed arguments | none |
| `attempt.evidence` | `runs/attempt/rules.ex:68` | Plain code over an array argument | G10 |
| `invocation.session` | `runs/invocation/rules.ex:10` | Related | none |
| `invocation.cost-unknown` | `runs/invocation/rules.ex:22` | Record | none |
| `invocation.not-corrected` | `runs/invocation/rules.ex:32` | Plain code over siblings | G06, G08 |
| `invocation.reason` | `runs/invocation/rules.ex:43` | Record | none |

Counts, from the table: **28 rules** need nothing beyond the milestones M4, M5 and M7 (a check of the record or of a related record, or the one-column `unique`); **4** use the typed-argument pattern (G35); **1** is a policy (`role`); **24** need plain code or a construct Mesh lacks: 12 need a quantifier over a has-many (G07 alone), 7 read rows nothing relates to (G06, with G07 or G08), 2 need arrays (G10), 2 are recursive walks (G36) and 1 calls a provider (G11). So **33 of the 57 are declarable** from documented constructs and **24 become plain code** unless Mesh adds filtered quantifiers and unrelated reads.

## Appendix B. The 38 custom modules and what each becomes

Disposition: **D** declaration, **E** expression (M4), **P** plain code in a `run` body or the application, **N** no place in Mesh. A pair means both.

| Module (under `lib/hyper/`) | What it does | Disp. | Needs |
|:--|:--|:--|:--|
| `pipeline/changes/check_rules.ex` | run the action's rules in one `before_action` | D | M5 |
| `pipeline/changes/hooks.ex` | install both tiers of plugin checks | N | G11, G31 |
| `pipeline/changes/restore_attributes.ex` | the import's insert as is | N | G18 |
| `pipeline/changes/run_hooks.ex` | first-tier hooks before the transaction, and a version recheck | N | G31 |
| `pipeline/changes/transition.ex` | apply the state machine's transition after the rules | D | G03: a `set` after a `check` |
| `pipeline/changes/version.ex` | bump the version; check `expected_version` | D | G02: a `check` and a `set` |
| `pipeline/changes/write_pipeline.ex` | queue, lock, reload, event, forget, release | N | G12, G13, G16 |
| `collaborators/collaborator/changes/revoke_memberships.ex` | retire cascades to the membership and the claims | P | G05 |
| `memberships/membership/changes/revoke_claims.ex` | revoke cascades to the claims | P | G05 |
| `machines/changes/report_machine.ex` | find or create a Machine from a host name | P | G05 |
| `runs/invocation/changes/invocation_task.ex` | copy the attempt's Task onto the Invocation | D | M5 |
| `runs/run/changes/end_run.ex` | `ended_at`, `cancel_reason` | D | M5 |
| `runs/run/changes/start_run.ex` | responsible = the Task's assignee, else the starter | E | G07 |
| `runs/attempt/changes/end_attempt.ex` | `ended_at`, the outcome map | D | G10 |
| `runs/attempt/changes/settle_run.ex` | settle the run when the attempt ends | P | G05 |
| `runs/attempt/changes/start_attempt.ex` | number, Task, delegator, claim fence | E | G07 |
| `tasks/claim/changes/assign_on_claim.ex` | claiming an unassigned Task assigns it | P | G05 |
| `tasks/claim/changes/end_claim.ex` | `ended_at`, `end_reason`; `revoke_all` | D, P | G05 for `revoke_all` |
| `tasks/claim/changes/lease.ex` | fence = max + 1, `expires_at`, expire a lapsed claim | E, P | G05 |
| `tasks/submission/changes/submit.ex` | copy the Task's version; release the claim | E, P | G05 |
| `tasks/review/changes/review.ex` | settle the submission; accept completes the Task | P | G05 |
| `tasks/task/changes/reassign.ex` | end claims and the assignment, create the new one | P | G05, G25 |
| `tasks/task/changes/record_completion.ex` | create the Completion, settle the submission, release the claim | P | G05 |
| `tasks/task/changes/settle_work.ex` | cancel cascades to claims, submission, runs | P | G05 |
| `tasks/task/preparations/first_ready.ex` | first Task no provider holds back | N | G27 |
| `checks/member.ex` | read filter for active members | D | M8 |
| `checks/role.ex` | role test with named denial | D | M8; G21, G22 |
| `tasks/task/checks/manager.ex` | owner, assignee, delegator, creator while unassigned | D | M8; G07 |
| `tasks/claim/checks/assignee.ex` | an assigned Task is claimable only by its assignee | D | M8; G07 |
| `tasks/claim/checks/revoker.ex` | owner, delegator, reviewer | D | M8; G07 |
| `tasks/review/checks/reviewer.ex` | the reviewer rule | D | M8; G07 |
| `runs/checks/reporter.ex` | four report permissions | D | M8; G07 |
| `workspaces/workspace/calculations/owner_ids.ex` | ids of active owners | N | G06, G10 |
| `tasks/task/calculations/blocked_reasons.ex` | prerequisite and provider reasons | E, N | G10, G11, G29 |
| `tasks/task/calculations/derived_state.ex` | stored state, in review, claimed, blocked, ready | E | M7 |
| `portability/export.ex` | snapshot to a bundle | P | G18 (application) |
| `workspaces/workspace/actions/stats.ex` | BEAM gauges | N | G26 (dropped) |
| `pipeline/rules.ex` | the validation module that runs a rule by name | D | M5 |

Tally: 14 D, 3 E, 4 D or E with P or N, 10 P (9 blocked by G05; export is application code), 7 N. The infrastructure modules that are not Ash extensions (`pipeline/rule_set.ex`, `rule_registry.ex`, `rule_names*.ex`, `hook_names*.ex`, `hook_points.ex`, `workspace_lock.ex`, `workspace_queue.ex`, `locked_task.ex`, `busy.ex`, the transport, the plugins, `portability/`, `persistence/`) are covered by section 3 or are not needed: the rule-name and hook-name transformers exist to catch a misspelled name at compile time, which a local `check :label` in the same file does not need.


[e-attr]: ../../docs/entities.md#attributes
[e-rel]: ../../docs/entities.md#relationships
[e-comp]: ../../docs/entities.md#computed
[e-actions]: ../../docs/entities.md#actions
[e-input]: ../../docs/entities.md#input
[e-validate]: ../../docs/entities.md#validate
[e-do]: ../../docs/entities.md#do
[e-reads]: ../../docs/entities.md#reads-filter-and-sort
[e-policies]: ../../docs/entities.md#policies
[e-self]: ../../docs/entities.md#what-self-holds
[e-helpers]: ../../docs/entities.md#the-shape-of-a-file
[e-static]: ../../docs/entities.md#static-files
[using]: ../../docs/using-your-domain.md
[u-update]: ../../docs/using-your-domain.md#update
[u-destroy]: ../../docs/using-your-domain.md#destroy
[u-errors]: ../../docs/using-your-domain.md#errors
[u-filters]: ../../docs/using-your-domain.md#filters-sort-and-paging
[u-context]: ../../docs/using-your-domain.md#the-action-context
[u-http]: ../../docs/using-your-domain.md#over-http
[u-cli]: ../../docs/command-line.md
[in-data-layer]: ../in-depth/data-layer.md
[in-ext]: ../in-depth/extension-host.md
[roadmap]: ../roadmap/roadmap.md
[mapping]: ../roadmap/vocabulary-mapping.md
[oq]: ../open-questions.md
[ADR-0005]: ../decisions/0005-core-interface-is-a-function-call.md
[ADR-0018]: ../decisions/0018-not-implemented-is-a-build-error.md
[ADR-0020]: ../decisions/0020-extension-contributions-through-declared-points.md
[ADR-0023]: ../decisions/0023-workflows-and-jobs-deferred.md
[ADR-0024]: ../decisions/0024-in-process-runner-first.md
[ADR-0035]: ../decisions/0035-meaning-of-public.md
[ADR-0045]: ../decisions/0045-has-one-uniqueness.md
[ADR-0050]: ../decisions/0050-entity-file-syntax.md
[ADR-0053]: ../decisions/0053-validate-then-do.md
[ADR-0054]: ../decisions/0054-write-strategy-is-inferred.md
[ADR-0055]: ../decisions/0055-policies-are-core.md
[ADR-0056]: ../decisions/0056-translated-expressions-are-one-expression-arrows.md
[ADR-0059]: ../decisions/0059-action-context.md

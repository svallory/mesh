---
title: "0097. The service construct: a file of operations, each with its `uses` lines, enforced at run time"
description: "Decision record 0097: the shape of a domain service (a `service :Name` file of `operation` members, each with `uses entity=X actions=[...]` lines, an `input` and a `run` body), its fail-closed policies, what a service file may import, how `uses` is enforced (the build checks the names the body writes, the run time every call the body makes) and the one-entity warning. Status: Proposed (lead ruling D42, pending operator review)."
---

# 0097. The service construct: a file of operations, each with its `uses` lines, enforced at run time

## Status

Proposed (lead ruling D42, pending operator review). Built: the run-time half (service values, `runOperation`, the `uses` check and the nesting refusal), the file kind, read and checked into the model, and the generated service values (`<service>.service.ts` and `<service>.inputs.ts`, exported by the module barrel) are on `main`. The port of Hyper's cross-aggregate commands to a service waits for the operator (lead ruling D49), since it changes the example the 1.0 gate rests on.

Decides DOM-09 of [ADR-0078](./0078-services-and-where-effects-go.md), whose 2026-10-17 amendment left the shape "decided after 1.0, and enforcing `uses` comes with it"; the operator's order of 2026-11-17 to build every unblocked bead (lead ruling D28) brought it forward.

## Date

2026-11-17

## Deciders

lead, delegated: ruling D42 of 2026-11-17 takes every recommendation of the reviewed services design (open decisions OD-1 to OD-14) and names the one-entity warning's code; it waits for the operator's review with the other rulings of that run.

## Context

ADR-0078 fixed what a service is (Vernon's domain service: stateless logic across entities), where its file lives (the module folder), its dependency keyword (`uses`) and the warning for an operation that touches one entity, and left the construct itself open. Until it exists, an effect across aggregates is a plain TypeScript function over `transaction(fn)` from `#mesh` ([Using your domain](../../docs/using-your-domain.md)): it has no input validation or policy of its own, no model node, and nothing stops it from writing any entity. The [domain concepts study](../research/domain-concepts.md) (section 3.4) proposed options A to D; DOM-16 excludes D.

## Decision

1. **A service file of operations (OD-2: option B; OD-3: the word `operation`).** A file whose root line is `service :Name`, in the module folder of the entities it orchestrates, declares one or more `operation :name` lines. Each operation has one `uses entity=Task actions=[:complete]` line per entity it reaches (at least one, OD-9), an optional `input` of typed field lines, and one `run` body of plain TypeScript, which gets `{ input, actor, context }`. A service is stateless by grammar: no `attributes`, `relationships`, `computed`, `checks` or `actions` section, and `self`, `before` and `&name` are not defined in its functions. Its FQN is `<module>.<Name>`, as an entity's.
2. **One list per entity (OD-5).** `actions=` is required and lists every action of the entity the operation may call, a `Mesh.privileged` read and a `Mesh.checkPolicies`/`Mesh.can` question included; an `auto=` action counts. A line that grants everything does not exist.
3. **`uses` is enforced (OD-4).** The build refuses a body that names an entity, or a namespace member, that no `uses` line lists (`MESH_SERVICE_USES`). At run time, while the body runs (and every helper it calls), a direct entity call, a privileged read or a policy question the lines do not list is a `FrameworkError` that fails the operation's transaction, even when the body catches it. What a listed action does on its own, and what a listed read loads, is that action's or that read's, and is not checked. A helper that writes through `tables` or a database client it holds is out of reach.
4. **No operation inside another (OD-12).** An operation called while another operation's body runs, or inside an action's transaction, is refused, so an inner allow-list cannot widen an outer one. Application code, a seam and a handler call operations, and two may run one after the other in one application `transaction(fn)`.
5. **Policies fail closed (OD-6).** A service's `policies` section is an entity's, scoped by `actions=[&operation]`: an operation no policy covers is forbidden, a service with no section builds and forbids every call, and a policy is evaluated before the transaction and inside it as an action's is. `types=` is refused (an operation has no action type). Every service function is plain code; `tsc` checks it in the generated file.
6. **No output, `validate` or `do` (OD-7)**, and the body's entity calls resolve with plain values (OD-8). The result's type is the body's inferred return type.
7. **Imports (OD-12).** A service file imports entity files, helper modules and `Mesh` from "meshfw". An event, a command or another service is `MESH_UNKNOWN_IMPORT`, and so is a service file imported by an entity, aggregate or surface file: a service calls entities, and the domain calls no service.
8. **The one-entity warning (OD-10).** An operation whose `uses` lines name one entity is the warning `MESH_SERVICE_ONE_ENTITY` at its line, the code of the architecture rule `:service-touches-one-entity` ([ADR-0084](./0084-architecture-rules-are-core.md)). It is that rule's check, run by the architecture rule pass at the end of the build at the level the architecture file sets for the rule: `disable` switches it off and `severity` re-grades it.
9. **Not in this construct (OD-11, OD-14).** A service owns no events or commands and its operations publish nothing (an operation calls an entity action that publishes); `on=` on an operation is refused; there is no `handlers` section under `service`. An operation runs no `beforeTransaction` seam, as an application `transaction(fn)` runs none, and its `afterCommit` runs once when it opened the transaction. Application services (`src/surfaces/<name>/services/`) are not built.
10. **The model.** `ModelDocument.services` (`Service`, `Operation`, `ServiceUse` in `@meshfw/model`) is present only when a project declares a service, so a project without one keeps its `model.json` byte for byte.

## Options considered

1. Option A, nothing new: does not deliver the construct the spec states. Option C, one operation per file with no `service` word: loses one name for a family of use cases, and can be had later as a one-operation service. Option D is excluded by DOM-16.
2. `command`/`query` or `write`/`read` as the operation keyword (OD-3): `command` declares a request's fields ([ADR-0079](./0079-commands-events-and-the-outbox.md)) and `read` is an action type, so either collides.
3. Enforcing `uses` at build time only (OD-4 (b)): a body that hands an entity value to a helper escapes it. Declaration only (c) breaks "reaches only what that line lists"; narrowed handles (d) were rejected by [ADR-0086](./0086-entity-values-privileged-barrels-and-fqns.md).
4. Separate `reads=` or `privileged=` lists (OD-5 (b)): two lists to keep for one dependency; splitting the one list later is mechanical. `actions=` optional, meaning every action (c): a line that grants everything defeats the check.
5. Per-operation policies (OD-6 (b)) repeat them; no policies (c) would make a service the one callable in Mesh that fails open, and adding fail-closed later would break every project.

## Trade-off analysis

Every refusal here can be lifted later without breaking a project (an `output`, service-owned events, a service calling a service, a second list in `uses`, a switch for the warning), and none could be added later without breaking one. The cost is a construct whose operations each need a policy and a `uses` line per entity, and a run-time set lookup per entity call made inside an operation.

## Consequences

- [ADR-0078](./0078-services-and-where-effects-go.md)'s DOM-09 is decided here, and its Decision item 5 ("`tsc` enforces them") is replaced by item 3 above: `tsc` enforces nothing about `uses`.
- The roadmap's "manual and generic actions: not planned at all" no longer holds for service operations; it still holds for an entity ([roadmap](../roadmap/roadmap.md), section 6).
- `service`, `operation` and `uses` are reserved tags; `call` stays unknown.

## Action items

- [x] The run-time half: service values, `runOperation`, the `uses` check, the nesting refusal.
- [x] The file kind: contracts, the checks above, `ModelDocument.services`, and a `MESH_NOT_IMPLEMENTED` stopgap in `generateFiles` while nothing was generated (removed with the generated values).
- [x] The generated service values: `<service>.service.ts` (the value, its operations' bodies, policies and `uses` lines) and `<service>.inputs.ts` (each operation's input type and schema, a file of its own so that the service file's helpers keep any name), the barrel exports and their name claims, the [Services](../../docs/services.md) page and the in-depth pages.
- [ ] The architecture file switches the one-entity warning (the rule's check, with the cross-aggregate rule).
- [ ] Operator: accept the construct, and decide the port of Hyper's work commands to a `Work` service (lead ruling D49).

# Porting Hyper to Mesh: what the entity files leave out

The entity files in `src/domain/` hold what Mesh builds today: attributes, keys, relationships, the actions that take member inputs, and, since M5's first half, the single-entity rules (`check`, `before`, `details`, a `set` with a function, the version check). They follow the Hyper specification (`svallory/hyper-engine-spec`, branch `feat/protocol-phases`, commit `ccc00f9`: `PROTOCOL.md` and `schemas/protocol.ts`) and nothing else, as [ADR-0072](../../apps/docs/docs/architecture/decisions/0072-mesh-1-0-is-the-port-gate.md) requires; the five execution entities (Run, Attempt, Invocation, Machine, SessionReference) are not in the spec's twelve and follow the drafts in `notes/hyper-port/entities/`. Every read is the auto read: a caller's `{ filter, sort, limit, offset }` serves Hyper's `get_*`, `list_*` and `list_events`, so those reads are not omissions.

Each line names the entity, the construct left out, its code in the [gap analysis](../../apps/docs/docs/architecture/research/hyper-port-gap-analysis.md) (`G` for a gap, `D` for a draft finding), and the milestone of [roadmap revision 5](../../apps/docs/docs/architecture/roadmap/roadmap.md) that delivers it. "No gap code" marks a limit the analysis does not list.

- All entities: the rules that read other entities through `tx`, or that need a rollup over a filtered set, with the rest of the stable rule names (G22): M5.
- Task, Collaborator, Membership, Machine, Attempt, Run, Submission, Review: the `version` bump and the `expectedVersion` check on the actions not yet written (`complete`, `cancel`, `assign`, `unassign`, `retire`, `revoke` and the rest; the recipe is in `entities.md`) (G02): M5.
- All entities: one rule reused by name across actions and entities, so each check is repeated (G04): after 1.0.
- All entities: policies, with the actor's role read through `tx` inside the transaction (G21): M8.
- All entities: a `system` context key so internal and nested writes pass authorization (G20): M8.
- All entities: a read's `load` input (the roadmap has no milestone for it); the `load` step of an action works, and `loadTaskFields(tx, rows, names)` and its siblings load a relationship or computed field inside a transaction (no gap code): not scheduled.
- All entities: filtering or sorting a read by a rollup or computed field (`maxFence`, `derivedState`) fails with an error that names M10 (G07): M10.
- All entities: the plugin hook points and blocking-condition providers (G11, G31): M6.
- All entities: microsecond timestamps; Mesh stores milliseconds (G24): not scheduled.
- Task, Claim, Run, Attempt: the state machines and their named transitions; `state` is an enum and each action would carry a check (G03): after 1.0.
- Task, Dependency, Assignment, Claim, Submission, Review, Completion, LateResult, EvidenceReference, Membership, Run, Attempt, Invocation, Machine, SessionReference: a relationship Hyper sets from the actor (`creator`, `createdBy`, `delegator`, `holder`, `submitter`, `reviewer`, `completedBy`, `recordedBy`, `grantedBy`, `startedBy`, `performer`, `firstReportedBy`) is a client input here, which changes Hyper's wire; `set &creator=({ actor }) => actor.id` stores it since M5 and `test/lifecycle.test.ts` in `@meshfw/data-sqlite` shows it, but the existing cases create rows with distinct creators, so the entity files switch with the rewrite of their callers (G30, D01): M5.
- Claim: `renew` takes a typed `newExpiresAt` from the caller, where the spec sets `expiresAt = now + lease-ms` on the server (PROTOCOL.md:311); the wire differs until the lease length is a `set` from configuration (no gap code): M5.
- Task, Workspace, Collaborator, Membership, Machine, SessionReference: `expected-version` is one issue in an `InvalidInputError` in declaration order, where the spec files it under `version_conflict` (-32002) and checks it first (PROTOCOL.md:111, :210); the port's error mapping picks it out by code (G02): M5.
- Claim, Membership, Assignment: engine-set timestamps (`acquiredAt`, `expiresAt`, `grantedAt`, `startedAt`, `endedAt`, `revokedAt`) are client inputs or left null, except Claim `release` and `revoke`, which set `endedAt` from `now()`; the rest switch with the rewrite of their callers (D04): M5.
- Claim, Attempt, Submission: engine-computed values (`fence` as the highest plus one, `number`, `taskVersion`) are client inputs; a `set` can fill them, but they read `&task.maxFence` and the Task's version, which the rewrite of `acquire` and `submit` brings (D04): M5.
- Review: `ruleApplied` and `reviewer` are client inputs; Hyper derives both from the reviewer rule (G07, D04): after 1.0.
- Task: the filtered has-ones (`currentAssignment`, `activeClaim`, `pendingSubmission`) as relationships; the file has the booleans `assigned`, `claimed` and `inReview`, written as `.some` over the unfiltered has-many, and application code reads the row itself with `.find` over the loaded list (G07): after 1.0.
- Task: the `reviewer` computed field (`{ collaboratorId, rule }`) and `blocked_reasons` (a list of `{ kind, taskId, message }`), which are structured results and not attributes; application code builds them from the loaded `assignments` and `dependencies` (G10, G29): application code.
- Task: the `lastSettledAt` rollup over a filtered subset of events (G07): after 1.0.
- Task: `complete`, `cancel`, `assign` and `unassign`, which write the claim, submission, completion and assignment in one transaction (G05): M5.
- Task: `move`'s `task.no-cycle` and the ancestor walk (G36): M5.
- Task: the `next` read's post-query filtering and its null ordering (G27, G37): application code.
- Collaborator: `retire`, which also revokes memberships (G05): M5.
- Collaborator: the name-unique rule, which reads other rows (G06): M5.
- Membership: `revoke`, the none-active and last-owner rules (G05, G06, G35): M5.
- Claim: `expire`, and `revoke` and `release` ending the claim's assignment and submission (G05): M5.
- Claim: the `claim.task-ready` rule, a `check` that reads `&task.derivedState` and reports `details`, with `acquire` (G07, G22): M5.
- Task, Submission: the `claim.current-fence` rule over the actor's active claim on `complete` and `submit`, plain code over `tx` (G05): M5.
- Claim, Dependency, Review, SessionReference, Attempt: the composite and partial unique indexes and the identity on a relationship key (`(task, fence)`, the dependency edge, one review per submission, `(runtime, runtimeSessionId)`, `(run, step, number)`, the active-only partials) (G08): after 1.0.
- Submission, Review: `withdraw`, `settle`, and the cascade to the task and the claim (G05): M5.
- Submission, Review, LateResult: the `warnings` and `late-result-recorded` outcomes (G25): M5.
- Completion: the "performer is reviewer or review waived" rule (G06): M5.
- Dependency: the duplicate rule (G06) and the no-cycle rule (G36): M5.
- Dependency: `remove` drops its `reason` argument; a destroy accepts `input` since M5, and the file takes it back when its caller is rewritten (D05): M5.
- Assignment: `finish`, the end of the previous assignment on a new one, and the assignee-role rule (G05, G06): M5.
- Run, Attempt: `cancel`, `settle`, `finish`, `reportStopped` and `abandon`, which settle the task and the attempts together (G05): M5.
- Attempt: the `attempt.step-idle` rule (G06): M5.
- Invocation: the `invocation.not-corrected` rule (G06): M5.
- Invocation: an exact `estimatedCost`; `decimal` is a number, so it round-trips as a double (G38): not scheduled.
- Machine: `retire`, whose `machine.idle` rule counts the running attempts (G22): M5.
- SessionReference: `record` as an upsert (G09): after 1.0.
- Event: the event written in the same transaction as every change, with a gap-free sequence (G12): M6.
- Event: the spec's `id` beside `seq`; Mesh fills one key, so `seq` is the key and the wire `id` and the nested `record` object are assembled by the application (G12): application code.
- Event: the `subtree` read, a walk over descendants (G36): application code.
- Workspace: `owner_ids` and `stats`, results that are not a record (G10, G26): application code.
- Workspace: `export` and `import` (G18): after 1.0.

What M4 added: the spec's computed fields that are one expression over a has-many are written and evaluated in memory (`test/expressions.test.ts`): Task's `childrenSettled` (rule `task.children-settled`), `claimed`, `inReview`, `assigned` and `lapsedClaim` (the `.some(...)` forms the spec uses instead of the filtered has-ones), and Claim's `lapsed` (rule `claim.expired`). The rules that read them are `check`s, which M5 runs (G07).

What M7 added: `Task.parent` and `Task.children`, `Run.parentRun` and `Invocation.corrects` relate to their own type with no import; `Task.dependencies` (`via=:dependent`) and `Task.dependents` (`via=:prerequisite`) follow the two keys Dependency holds to Task, and `Collaborator.memberships` (`via=:collaborator`) the first of the three Membership holds to Collaborator; Task has `blocked` (a prerequisite that is not done), `maxFence` (an unfiltered `max` over the claims, as the Elixir engine's aggregate) and `derivedState` (the spec's rule, first match wins: stored `done` or `canceled`, then `in-review`, `claimed`, `blocked`, `ready`; `test/relationships.test.ts` checks all 180 combinations of stored state, submission, claim and prerequisites against the spec's text). A relationship or computed field loads by name through `loadTaskFields` and its siblings; the cost of `Claim :acquire`'s reads is measured in the same test file and in the M7 report.

What M5 (first half) added, in `test/rules.test.ts` with a passing and a failing case for each rule, named by Hyper's own rule name as the issue `code`: Task `task.open` (`setPriority`, `update`, `move`), `task.parent-open` (`create`, `move`), `task.unchanged` (`update`, comparing `self` with `before`), `task.no-active-claim` (`move`, through the `claimed` computed field), `task.settled` (`reopen`); `expected-version` with `details.currentVersion` and the version bump on Task, Workspace, Collaborator, Membership, Machine and SessionReference (the recipe in `entities.md`, a `check` and a `set`); `workspace.active`; `collaborator.active` and `collaborator.kind-immutable` (a typed `kind` argument); `membership.active` and `membership.unchanged`; `machine.active`; `session.not-redacted` and `session.availability` (the stored value through `before`, because `self` holds the input), with `redact` as a state transition; `dependency.distinct`; and Claim's `claim.current-fence` with `details.stale`, `claim.active` and `claim.expired` on `renew`, `release` and `revoke`, whose `endedAt` comes from `now()` in a `set`. Every failing rule of one call is reported together (an update that fails `task.open`, `task.unchanged` and `expected-version` returns all three). What remains for the second half is every rule that needs composition (`actions`, `tx`, `after=:write`): the cascades, the rules that read other entities through `tx`, and `Task :complete`, `:cancel`, `:assign` and `:unassign`.

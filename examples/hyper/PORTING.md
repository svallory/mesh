# Porting Hyper to Mesh: what the entity files leave out

The entity files in `src/domain/` hold what Mesh builds today: attributes, keys, relationships, and the actions that take member inputs, with a constant `set` where one is enough. They follow the Hyper specification (`svallory/hyper-engine-spec`, branch `feat/protocol-phases`, commit `ccc00f9`: `PROTOCOL.md` and `schemas/protocol.ts`) and nothing else, as [ADR-0072](../../apps/docs/docs/architecture/decisions/0072-mesh-1-0-is-the-port-gate.md) requires; the five execution entities (Run, Attempt, Invocation, Machine, SessionReference) are not in the spec's twelve and follow the drafts in `notes/hyper-port/entities/`. Every read is the auto read: a caller's `{ filter, sort, limit, offset }` serves Hyper's `get_*`, `list_*` and `list_events`, so those reads are not omissions.

Each line names the entity, the construct left out, its code in the [gap analysis](../../apps/docs/docs/architecture/research/hyper-port-gap-analysis.md) (`G` for a gap, `D` for a draft finding), and the milestone of [roadmap revision 5](../../apps/docs/docs/architecture/roadmap/roadmap.md) that delivers it. "No gap code" marks a limit the analysis does not list.

- All entities: `check`s and the stable rule names Hyper reports (G22): M5.
- All entities: the `version` bump and the `expectedVersion` check on every update (G02): M5.
- All entities: one rule reused by name across actions and entities, so each check is repeated (G04): after 1.0.
- All entities: policies, with the actor's role read through `tx` inside the transaction (G21): M8.
- All entities: a `system` context key so internal and nested writes pass authorization (G20): M8.
- All entities: the plugin hook points and blocking-condition providers (G11, G31): M6.
- All entities: microsecond timestamps; Mesh stores milliseconds (G24): not scheduled.
- Task, Claim, Run, Attempt: the state machines and their named transitions; `state` is an enum and each action would carry a check (G03): after 1.0.
- Task, Dependency, Assignment, Claim, Submission, Review, Completion, LateResult, EvidenceReference, Membership, Run, Attempt, Invocation, Machine, SessionReference: a relationship Hyper sets from the actor (`creator`, `createdBy`, `delegator`, `holder`, `submitter`, `reviewer`, `completedBy`, `recordedBy`, `grantedBy`, `startedBy`, `performer`, `firstReportedBy`) is a client input here, which changes Hyper's wire (G30, D01): M5.
- Claim, Membership, Assignment: engine-set timestamps (`acquiredAt`, `expiresAt`, `grantedAt`, `startedAt`, `endedAt`, `revokedAt`) are client inputs or left null, for want of `now()` (G23, D04): M4.
- Claim, Attempt, Submission: engine-computed values (`fence` as the highest plus one, `number`, `taskVersion`) are client inputs (D04): M5.
- Review: `ruleApplied` and `reviewer` are client inputs; Hyper derives both from the reviewer rule (G07, D04): after 1.0.
- Review, Completion, Event: the spec's enums with hyphenated values (`parent-assignee`, `review-accepted`, the event `type` and `record.type`) are strings, because atoms cannot hold a hyphen (no gap code): not scheduled.
- Task: the filtered has-ones (`currentAssignment`, `activeClaim`, `pendingSubmission`) and the `exists` computed fields built on them (`claimed`, `inReview`, `assigned`) (G07): after 1.0.
- Task: the `reviewer` and `derivedState` computed fields, and `blocked_reasons` as a list of maps (G07, G29): M7.
- Task: the `maxFence` and `lastSettledAt` rollups over a filtered subset (G07): after 1.0.
- Task, Collaborator: the `dependencies` and `memberships` has-manys, because Dependency has two keys to Task and Membership three to Collaborator (G28): M7.
- Task: `complete`, `cancel`, `assign` and `unassign`, which write the claim, submission, completion and assignment in one transaction (G05): M5.
- Task: `reopen`, whose preconditions are checks (G22): M5.
- Task: `update`, which compares new and stored values (`task.unchanged`) (G35): M5.
- Task: `move`'s `task.no-cycle` and the ancestor walk (G36): M5.
- Task: the `next` read's post-query filtering and its null ordering (G27, G37): application code.
- Collaborator: `retire`, which also revokes memberships (G05): M5.
- Collaborator: the name-unique rule, which reads other rows (G06): M5.
- Membership: `revoke`, the none-active and last-owner rules (G05, G06, G35): M5.
- Membership, SessionReference: the "unchanged" and availability rules on `changeRole` and `setAvailability` (G35): M5.
- Claim: `renew`, `release`, `revoke` and `expire` (G05): M5.
- Claim: the `claim.task-ready` and `claim.current-fence` rules over the has-many of claims (G07): after 1.0.
- Claim, Dependency, Review, SessionReference, Attempt: the composite and partial unique indexes and the identity on a relationship key (`(task, fence)`, the dependency edge, one review per submission, `(runtime, runtimeSessionId)`, `(run, step, number)`, the active-only partials) (G08): after 1.0.
- Submission, Review: `withdraw`, `settle`, and the cascade to the task and the claim (G05): M5.
- Submission, Review, LateResult: the `warnings` and `late-result-recorded` outcomes (G25): M5.
- Completion: the "performer is reviewer or review waived" rule (G06): M5.
- Dependency: the duplicate rule (G06) and the no-cycle rule (G36): M5.
- Dependency: `remove` drops its `reason` argument, because a destroy takes no attributes (D05): M5.
- Assignment: `finish`, the end of the previous assignment on a new one, and the assignee-role rule (G05, G06): M5.
- Run, Attempt: `cancel`, `settle`, `finish`, `reportStopped` and `abandon`, which settle the task and the attempts together (G05): M5.
- Attempt: the `attempt.step-idle` rule (G06): M5.
- Invocation: the `invocation.not-corrected` rule (G06): M5.
- Invocation: an exact `estimatedCost`; `decimal` is a number, so it round-trips as a double (G38): not scheduled.
- Machine: `retire` (G22): M5.
- SessionReference: `record` as an upsert, and `redact` (G09, G35): after 1.0.
- Event: the event written in the same transaction as every change, with a gap-free sequence (G12): M6.
- Event: the spec's `id` beside `seq`; Mesh fills one key, so `seq` is the key and the wire `id` and the nested `record` object are assembled by the application (G12): application code.
- Event: the `subtree` read, a walk over descendants (G36): M5.
- Workspace: `owner_ids` and `stats`, results that are not a record (G10, G26): application code.
- Workspace: `export` and `import` (G18): after 1.0.

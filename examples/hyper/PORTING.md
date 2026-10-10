# Porting Hyper to Mesh: what the entity files leave out

The entity files in `src/domain/` hold what Mesh builds today: attributes, keys, relationships, and the actions that take member inputs, with a constant `set` where one is enough. They are ported from the drafts in `notes/hyper-port/entities/` against the Hyper specification (`svallory/hyper-engine-spec`, branch `feat/protocol-phases`, commit `ccc00f9`). Each line below names the entity, the construct left out, and the milestone of the [roadmap](../../apps/docs/docs/architecture/roadmap/roadmap.md) that delivers it. "Gap" numbers refer to the [gap analysis](../../apps/docs/docs/architecture/research/hyper-port-gap-analysis.md).

- All entities: `check`s and the stable rule names Hyper reports (G04, G22): M4.
- All entities: the `version` increment and the `expectedVersion` check on every update, which need an expression over the stored row (G35): M4.
- All entities: the policies, with the actor's role read through `tx` (G21): M8.
- All entities: `now()` for engine-set timestamps (`retiredAt`, `endedAt`, `revokedAt`, `expiresAt`), so those are inputs or left null (G23): M4.
- All entities: the `Event` written in the same transaction as every change (G05): M5.
- All entities: the plugin hook points and the blocking-condition providers (G11, G31): after 1.0.
- Task: the filtered has-one relationships (`currentAssignment`, `activeClaim`, `pendingSubmission`) and the computed `claimed`, `inReview`, `assigned`, `blocked`, `derivedState` fields (G07): M7.
- Task: the `maxFence` and `lastSettledAt` rollups over a filtered subset (G06, G07): M7.
- Task: the `dependencies` has-many, because Dependency has two keys to Task and the inverse cannot be chosen (G28): M7.
- Task: the `complete`, `cancel`, `reopen`, `assign` and `unassign` actions, whose steps read other entities and write them in the same transaction (G05): M5.
- Task: the `get`, `list` and `next` reads declared in the file, which filter on a caller's argument or a computed field (G27, G37): M10.
- Task: the `update` action that compares new and stored values (`task.unchanged`) (G35): M5.
- Task: the `task.no-cycle` and `task.parent-open` checks, a walk over ancestors (G36): M5.
- Task, Collaborator, Membership, Claim, Run, Attempt, Machine, SessionReference: the state machines and their transitions (G03): after 1.0.
- Collaborator: the `memberships` has-many, because Membership has three keys to Collaborator (G28): M7.
- Collaborator: `retire`, which also revokes the memberships (G05): M5.
- Collaborator, Machine: the name-unique rules, which read other rows (G06): M5.
- Membership: the `revoke` action and the last-owner rule (G06, G05): M5.
- Claim: `renew`, `release`, `revoke` and `expire`, and the lease length from the context (G05): M5.
- Claim: the `claim.task-ready` and `claim.active` rules, which filter a has-many (G07): M7.
- Submission: `withdraw` and `settle`, which update the task and the claim (G05): M5.
- Review: the accept and return rules and their cascade to Submission and Task (G05): M5.
- Completion: the "performer is reviewer or review waived" rule (G06): M5.
- Dependency: the duplicate and no-cycle rules (G06, G36): M5.
- Assignment: `finish`, and the end of the previous assignment when a new one starts (G05): M5.
- Run: `cancel` and `settle`, which cancel attempts and settle the task (G05): M5.
- Attempt: `finish`, `reportStopped` and `abandon`, and the `attempt.step-idle` rule (G06): M5.
- Invocation: the `invocation.not-corrected` rule (G06): M5.
- Invocation: an exact `estimatedCost`; `decimal` is a TypeScript number, so the value round-trips as a double (G38): not scheduled.
- Machine: `retire`, and the `update` that takes a name through the unique rule (G06): M5.
- SessionReference: `redact` and the availability rules (G35): M5.
- Event: the `after` read and the `subtree` read, which filter by a caller's argument and walk ancestors (G36): M10.
- Claim, Run, Attempt, Invocation, Machine, SessionReference, Assignment, Collaborator, Membership, Task, Submission, Review, Completion, LateResult, EvidenceReference, Event, Dependency, Workspace: microsecond timestamps; Hyper keeps microseconds and Mesh stores milliseconds (G24): not scheduled.

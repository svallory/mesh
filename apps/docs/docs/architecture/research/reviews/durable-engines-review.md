---
title: "Review: Durable workflow engines"
description: "Independent fact-check of the durable workflow engines document; final verdict ACCEPT-WITH-FIXES."
---

# Fact-check review: [`notes/research/08-durable-engines.md`](../durable-engines.md)

> Review of: [Durable workflow engines](../durable-engines.md).

VERDICT: ACCEPT-WITH-FIXES


Reviewer: independent fact-checker, 2026-10-04. I re-fetched every source named below on
2026-10-04, using the npm registry, `gh api` for the GitHub API, raw GitHub files and the
official docs. I did not edit the research document.

## Why ACCEPT-WITH-FIXES

Most of the per-engine facts hold. I sampled 58 claims and confirmed 44 as written. The
licences, versions, release dates, the DBOS transaction quote, the pg-boss `db` option, the
Inngest 24-hour dedupe window, the Restate BSL grant and the Bun statements are all correct.
The comparison table and the common denominator are usable.

The proposed interface (section 6) is a different matter. It has four defects that would ship
a wrong guarantee if Mesh built it as written:

1. **The outbox does not guarantee a single start.** Section 6.1.3 says a relay retry "cannot
   start a workflow twice". That holds only inside each engine's dedupe window. On Temporal the
   default reuse policy allows a duplicate once the first run has closed (H1).
2. **Seam (b) is not kept for steps.** Steps run at least once. On every engine except DBOS,
   and for the in-process runner's plain `step`, a step that writes to the app database can run
   twice. Rule 6.3.4 covers only effects *outside* the app database (H2).
3. **DBOS "native" enqueue-in-transaction has conditions the document leaves out.** The
   transaction must be on the DBOS *system* database, and the call cannot return an existing run
   (H3).
4. **`step(name, fn)` with an inline closure does not map to Temporal.** Temporal activities are
   functions registered on the Worker and called by name from a sandboxed workflow (H4).

Several UNVERIFIED items can now be closed from source: Temporal's replay matching, Restate's
step-name role, Inngest single-run cancel, DBOS child workflows and the Trigger.dev licence
split. Closing them changes two claims, step identity and Inngest cancel (M1, M3).

The in-process runner does implement the sketch with no HTTP, as section 6.4 says. Nothing in
it needs an inbound request. There is one caveat on cross-process cancel (L12).

---

## Findings

Severity: **high** means a design decision would go wrong if taken from the document.
**Medium** means a materially wrong or unsupported fact, or an internal contradiction in the
interface. **Low** means wording, citation or cosmetic.

Each finding gives the section and line, the claim, what the source says, and the fix.

### High

**H1. §6.1.3 l.467-468, §6.5 l.635, §6.2 l.580.** Claim: "A relay calls `start` after commit
with the dedupe key equal to the outbox row id, so a relay crash and retry cannot start a
workflow twice." The Temporal mapping calls `workflowId = dedupeKey` "native".
→ Source: Temporal documents the Workflow Id Reuse Policy as follows. "**Allow Duplicate** … *This is the default policy*",
meaning a closed run's id can be reused. Uniqueness is guaranteed only "in an Open state". Even
Reject Duplicate is checked only "against the Closed Workflow Executions for the last 30 days"
(the retention period). The default *conflict* policy for an open run returns a "Workflow
execution already started" error rather than the existing run
([workflowid-runid.mdx](https://raw.githubusercontent.com/temporalio/documentation/main/docs/encyclopedia/workflow/workflow-execution/workflowid-runid.mdx),
lines 38-39, 105-135). Inngest's window is 24 h, and so is Restate's default. The document
records both windows elsewhere (l.155, l.439) but drops them here.
→ Fix: state the real guarantee. The relay delivers at least once, and the engine's dedupe gives
one start only while relay lag is shorter than `dedupeWindow`. The relay must refuse loudly
(seam d) to deliver a row older than the adapter's window. The Temporal adapter must set reuse
policy `REJECT_DUPLICATE` and conflict policy `USE_EXISTING` to meet "a second call returns the
same run". Declare Temporal's `dedupeWindow` as the namespace retention. Change the mapping
cell from "native" to "native with non-default policies".

**H2. §6.3 rule 4 l.607-608, §6.1.3 l.470 ("keeps seam (b) for every engine").**
→ Source: Inngest says "A request can succeed before Inngest records the step result. A retry
can then call the API again"
([idempotency](https://www.inngest.com/docs-markdown/durable-execution/guides-and-advanced/idempotency),
l.15). Temporal says "Temporal recommends that Activities be idempotent"
([activity definition](https://raw.githubusercontent.com/temporalio/documentation/main/docs/encyclopedia/activities/activity-definition.mdx),
l.176-179). Both apply equally to writes into the app's own database. On Temporal, Inngest and
Restate, and for the in-process runner's plain `step`, a step that commits app state and its
events can crash before its checkpoint is recorded. It then commits again on retry. The outbox
covers only the *start* of a workflow. It does not cover signals or cancels that an action sends
to a running workflow, which are equally "events committed with state". DBOS has a native
`sendInTransaction` for exactly this, and the document misses it
([client reference](https://docs.dbos.dev/typescript/reference/client.md), l.300-328).
→ Fix:
- Extend rule 4 to app-database writes.
- Add a core shim: a step that invokes a Mesh action passes `${runId}:${stepName}`. The action
  records that key and its result in a `mesh_step_effects` table inside its own transaction,
  and returns the stored result on a repeat. This is the Restate idempotency-table pattern the
  document already cites
  ([databases guide](https://docs.restate.dev/guides/databases.md), l.309). It gives the same
  effect once, without `stepInTransaction`.
- Route `signal`/`cancel` issued from inside an action through the outbox as well. Map DBOS
  signals to `sendInTransaction`.
- Rewrite l.470 as "seam (b) holds for starts, and for signals once they go through the
  outbox. For step writes it holds through the idempotency shim, or natively on DBOS."

**H3. §2.4 l.253-256, §6.1.3 l.469, §6.5 l.685 (DBOS `startInTransaction` = native).**
→ Source:
- "`client` must be connected to your DBOS system database" (warning box).
- "`duplicationPolicy: 'return-existing'` is not supported (throws an error)".
- The default policy is `'reject'`, which throws `DBOSQueueDuplicatedError`.

All three are in the
[client reference](https://docs.dbos.dev/typescript/reference/client.md), l.236-245 and
l.160-162. A throw inside a Postgres transaction aborts the caller's whole transaction.
→ Fix: say that enqueue-in-transaction is atomic with app writes only when the app's tables
live in the DBOS system database, or in the same Postgres database and connection. Say that it
cannot honour the `start` contract "a second call returns the same run" (l.580). The fix is
acceptable when the dedupe key is a fresh outbox row id, because no duplicate can occur inside
one transaction, but the contract text must say so. Add this to open question 8.1.

**H4. §6.2 l.528, §6.5 l.630 (Temporal `step(name, fn)` = "an activity … native").**
→ Source: Temporal activities are "plain functions in a separate file", reached from the
workflow through `proxyActivities` and registered on `Worker.create({ activities })`
([activities](https://raw.githubusercontent.com/temporalio/documentation/main/docs/develop/typescript/activities/basics.mdx)).
Workflow code runs in a V8 sandbox, a separate isolated JavaScript context
([workflows](https://raw.githubusercontent.com/temporalio/documentation/main/docs/develop/typescript/workflows/basics.mdx)).
A closure created inside `run` cannot be shipped to an activity worker. If the adapter ran `fn`
inline, it would run inside the deterministic sandbox, with no I/O.
→ Fix: change the contract so a step is a top-level, registered function with an explicit
serialisable input, for example `steps: Record<string, (input, scope) => Promise<T>>` and
`ctx.step(name, input)`. The generator then emits each declared step as a named activity. Note
that `StepScope` must then carry `context` (see L11).

### Medium

**M1. §1 item 2 l.39-41, §2.1 l.80-83, §2.3 l.192-195, §2.4 l.241-242, §3 l.396-399,
§4.2 l.433.** Claim: Temporal, Restate and DBOS key on order "and treat a name as a label". The
DBOS mismatch error is given as `DBOSStepNondeterminismError`.
→ Source: all three match by position **and** check the recorded name.
- **Temporal.** `activity_state_machine.rs` raises
  `nondeterminism!("Activity type of scheduled event '{}' does not match activity type of activity command '{}'")`
  ([sdk-core](https://raw.githubusercontent.com/temporalio/sdk-core/master/crates/sdk-core/src/worker/workflow/machines/activity_state_machine.rs),
  l.391-405, which also checks the activity id).
- **Restate.** `impl_message_traits!(RunCommand: command eq)` makes `header_eq` full struct
  equality. `RunCommandMessage` holds `result_completion_id` and `name`
  ([messages.rs](https://raw.githubusercontent.com/restatedev/sdk-shared-core/main/src/service_protocol/messages.rs),
  l.46-50, 76-80, 308;
  [generated proto](https://raw.githubusercontent.com/restatedev/sdk-shared-core/main/src/service_protocol/generated/dev.restate.service.protocol.rs),
  l.734-739). A renamed `ctx.run` is a journal mismatch (error 570).
- **DBOS.** `DBOSUnexpectedStepError` is the "step has an unexpected recorded name" error.
  `DBOSStepNondeterminismError` is something else: "recorded twice by the same execution with
  different results"
  ([error.ts](https://raw.githubusercontent.com/dbos-inc/dbos-transact-ts/main/src/error.ts),
  l.104-115, 251-261).

→ Fix: "order-keyed, name-checked". Renaming a step breaks in-flight runs on all three. On
Inngest a rename silently reruns the step. Close the Temporal and Restate UNVERIFIED items (l.83,
l.194, l.733).

**M2. §2.1 l.96-98.** Claim: "Activities retry by default with unlimited attempts and
exponential backoff capped at 10 minutes."
→ Source: "The default Retry Policy uses exponential backoff with a 2.0 backoff coefficient,
starting with a 1-second initial interval and capping at a maximum interval of 100 seconds".
The 10-minute cap is for *Workflow Task* retries, which "Retry Policies do not apply to"
([retry policies](https://raw.githubusercontent.com/temporalio/documentation/main/docs/encyclopedia/retry-policies.mdx),
l.30-31, 136-138, 172-174, 199).
→ Fix: 100 seconds (100 × the initial interval).

**M3. §2.2 l.182-184, §4.1 l.423, §6.5 l.653 and l.695.** Claim: Inngest single-run cancel is
UNVERIFIED, so the adapter declares `cancel: "pending-only"`, and running-run cancel is
"cannot honour".
→ Source: the Inngest server routes `r.Delete("/runs/{runID}", a.cancelFunctionRun)` and
`r.Get("/runs/{runID}", a.GetFunctionRun)`
([apiv1.go](https://raw.githubusercontent.com/inngest/inngest/main/pkg/api/apiv1/apiv1.go),
l.220-224). The docs say cancellation "prevents queued and sleeping runs from continuing and
stops active runs between steps"
([cancellation](https://www.inngest.com/docs-markdown/durable-execution/guides-and-advanced/cancellation),
l.5).
→ Fix: declare `cancel: "running"`, effective between steps. Remove the cancel entry from the
cannot-honour table. Use `GET /v1/runs/{runID}` for `status`.

**M4. §2.2 l.180-181, §6.5 l.654.** `start()` must return a `RunHandle` with a `runId`
(l.565-566, 581). But Inngest `send()` returns *event* ids. A run id exists only once the run is
created, and is found through `GET /v1/events/{id}/runs`, which the document cites.
→ Fix: mark `start` and `attach` as **shim** for Inngest, not only `result()`. Either make
`runId` the dedupe key, with the adapter resolving the engine id lazily, or let
`RunHandle.runId` be resolved asynchronously.

**M5. §6.1.2 l.461-462 vs §6.3.1 l.601-602 and §6.2 l.519, l.527.** Section 6.1.2 allows
derived loop names (`"charge:" + index`). Section 6.3.1 says the verifier "fails the build on …
a non-literal name". `step` says "`name` MUST be a declared step", and `steps: readonly string[]`
cannot list dynamic names.
→ Fix: introduce a declared step *family*, for example `charge[]` with an index key that is
deterministic given prior results. Make the verifier and `steps` aware of families. Otherwise
loops are impossible, which bears on open question 8.2.

**M6. §1 item 2 l.41-43, §6.1.2 l.464, §6.6 l.701-704.** Claim: Mesh "can guarantee both a
stable name and a fixed order", and `version = hash(name + ordered step names)` detects
breaking changes.
→ Source: replay safety depends on determinism *given recorded results*, not on a fixed order.
DBOS: "the same steps with the same inputs in the same order (given the same return values)"
([workflow tutorial](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial.md), l.138).
A changed branch condition changes the run-time order without touching the declared list.
→ Fix: call the hash a necessary check, not a sufficient one. Note that control-flow edits are
also breaking. The guard would need to hash the generated `run` body, not only the step names.

**M7. §1 item 3 l.44-46, §2.7 table l.349, §6.2 `JobQueueAdapter` l.592.** Claim: "Only DBOS
commits a step together with application database writes."
→ Source: pg-boss says "To go the other way, and commit a worker's writes with the job's
completion, use a transactional worker"
([adapters.md](https://raw.githubusercontent.com/timgit/pg-boss/master/docs/api/adapters.md),
l.3-7).
→ Fix: add pg-boss's transactional worker as job-level atomic completion. Add a
`completeInTransaction` capability to `JobQueueAdapter`.

**M8. §6.5 DBOS l.682.** `waitForSignal` maps to `DBOS.recv(topic, timeout)`.
→ Source: `recv(topic?, timeoutSeconds?)`: "returning `null` if the wait times out. The default
timeout is 60 seconds"
([communication](https://docs.dbos.dev/typescript/tutorials/workflow-communication.md), l.29-33).
A Mesh `waitForSignal` with no timeout would therefore resolve `undefined` after 60 s. That is
a silent fallback, which seam (d) forbids. The unit is seconds, while Mesh uses `Duration`.
→ Fix: the adapter must always pass an explicit timeout (a very large one when Mesh says "no
timeout") and convert to seconds.

**M9. §0 l.30-31, §2.7 table l.346.** Claim: Graphile Worker's "cadence is one release a year";
"one release in the last 365 days".
→ Source: npm `time` lists five stable releases in the last 365 days: 0.17.0, 0.17.1 and 0.17.2
on 2026-06-12, 0.17.3 on 2026-07-08 and 0.18.0 on 2026-09-08. Before 0.17.0 there was a
26-month gap after 0.16.6, published 2024-04-26
([registry](https://registry.npmjs.org/graphile-worker)). GitHub has a Release object only for
v0.18.0, which is what document 07 counted (`gh api repos/graphile/worker/releases`).
→ Fix: "five npm releases since June 2026 after a two-year gap. GitHub Releases show only one."
Explain why this matters: it is bursty, not dead.

**M10. §6.2 l.577 vs §6.1.6 l.476 and ruling 4.** `register()` "rejects if a definition needs
a missing capability" at boot. Ruling 4 (`decisions-2026-10-04.md`) requires a **build-time**
error.
→ Fix: capabilities must be static data that the build's Verify stage (stage 5) reads. One
option is an adapter manifest imported at build time. Keep the boot check only as a backstop.

**M11. §6.1.3 l.468-469.** pg-boss and Graphile are listed as declaring `startInTransaction`,
which is a `WorkflowCapabilities` field. Section 6.1.1 says they implement only
`JobQueueAdapter`, whose field is `enqueueInTransaction`. The outbox section therefore does not
say whether jobs go through the outbox.
→ Fix: name the job capability and state the outbox rule for jobs. The job dedupe window
matters too: BullMQ `jobId`, and Graphile `job_key` once the job is deleted (l.351).

**M12. Writing rules (brief criterion 4).**
- Terms used without explanation: CRIU (l.285), BSL 1.1 and SSPL (what they forbid for a Mesh
  user, l.176, 201), BYOC (l.224), SKIP LOCKED (l.347), CEL (l.326), RRULE (l.352), Conductor
  (l.247), Standard Schema (l.159), "bus factor" (l.226), Build IDs (l.111).
- Numbers and claims with no link: the maintenance lines for Inngest (l.178-179), Restate
  (l.225), DBOS (l.274), Trigger.dev (l.304-305) and Hatchet (l.335-336), plus the job-queue
  version and contributor rows (l.346, l.356). The DBOS client method list (l.275-276), Hatchet
  retries and timeouts (l.325-327) and Vercel's version and contributors (l.370) are also
  unlinked.
- Contributor counts match GitHub only with `anon=1` (pg-boss 106 vs 96 named; Trigger.dev 145
  vs 140). Say so.

→ Fix: add a one-line gloss for each term, and links for each number.

### Low

**L1. §2.1 l.78-79.** The quote "no mechanism to customize" is not in the source, which reads
"there isn't a mechanism to customize the Workflow Type"
([workflows](https://raw.githubusercontent.com/temporalio/documentation/main/docs/develop/typescript/workflows/basics.mdx),
l.101). Fix the quote.

**L2. §1 item 5 l.54-55.** Claim: "Only the pg-boss, BullMQ, Restate and Inngest docs claim
Bun." The document's own §2.5 cites Trigger.dev's Bun guide, which documents experimental Bun
([bun guide](https://trigger.dev/docs/guides/frameworks/bun.md)). §2.6 cites Hatchet's
client-only Bun mode. Fix: qualify the sentence.

**L3. §2.2 l.167, §3 l.397.** Inngest issue #1624 is called the "open Bun issue". Its title is
"Lazily instantiate StreamTools TransformStream to avoid per-execution allocation and Bun GC
retention" (`gh api repos/inngest/inngest-js/issues/1624`, open). That is a memory-retention
performance issue, not a sign that Bun is unsupported. Fix the wording.

**L4. §2.5 l.304-305, §8 l.734.** The Trigger.dev npm-MIT versus repo-Apache split is
UNVERIFIED in the document. Resolved: `packages/trigger-sdk/LICENSE` is "MIT License,
Copyright (c) 2023 Trigger.dev", and the root licence is Apache-2.0
([package LICENSE](https://raw.githubusercontent.com/triggerdotdev/trigger.dev/main/packages/trigger-sdk/LICENSE)).
Close it.

**L5. §2.4 l.262-263, §6.5 l.683, §8 l.733.** DBOS child workflows are UNVERIFIED in the
document. Resolved: "start child workflows with `startWorkflow` and await the results from
their `WorkflowHandle`s". A timeout cancels "the workflow and all its children"
([workflow tutorial](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial.md),
l.194-203), and `cancelWorkflow(id, { cancelChildren })` exists (client reference l.68). Mark
`invoke` as native.

**L6. §2.2 l.172-173.** The source of GitHub's GPL-3.0 detection remains unknown.
`gh api repos/inngest/inngest-js` reports `gpl-3.0`, while `/license` returns 404 because there
is no root licence file. The detection is likely stale metadata. Say so, and keep it UNVERIFIED.

**L7. §4.2 l.440.** Claim: "Cron: native on all except Restate." The dev report lists Vercel
Workflow cron as UNVERIFIED, and Cloudflare cron is not evidenced in the document. Fix: say
"all compared engines except Restate. Vercel and Cloudflare are not checked."

**L8. §6.5 l.655.** The Inngest `connect()` limits of 3 and 20 connections are Inngest Cloud
plan limits. A self-hosted server exposes its own Connect gateway on port 8289
([connect](https://www.inngest.com/docs-markdown/durable-execution/deploying-functions/connect),
l.13-16, 760). Fix: say "on Inngest Cloud".

**L9. §6.5 l.672.** Claim: "a CLI must start a local HTTP listener". The listener belongs to
the worker process (`work()`). A CLI that calls `start`, `signal` or `cancel` makes outbound
HTTP calls to Restate ingress and the admin API (`PATCH :9070/invocations/{id}/cancel`,
[managing invocations](https://docs.restate.dev/services/invocation/managing-invocations.md),
l.60). Ruling 8 concerns Mesh's own transport, not outbound calls. Fix: restate the cost
precisely, as "the worker needs an inbound HTTP endpoint".

**L10. §6.6 l.705, §6.5 l.639.** Claim: "`version` maps to `patched()` ids". Temporal's
`patched()` requires the workflow code to keep both the old and the new branch, so a hash
cannot drive it automatically. Worker Versioning (Build IDs) is the drain-style match. Fix.

**L11. §6.2 l.548 vs §6.1.5 l.474-475.** Section 6.1.5 says context is "handed to every step",
but `StepScope` has no `context`. On Temporal a step cannot close over `ctx` (H4). Fix: add
`readonly context: MeshContext` to `StepScope`.

**L12. §6.4 l.616.** Claim: in-process `cancel` is `"running"`, "cooperative, through the
`AbortSignal`". When the CLI that calls `cancel` and the worker running `work()` are different
processes, an `AbortSignal` cannot cross between them. The runner needs a persisted cancel flag
that the worker polls. Fix: state the mechanism.

**L13. §2.1 l.89-90.** The persistence versions (PostgreSQL 13.18 to 16.6, MySQL 5.7 and 8.0,
SQLite for development) are not on the cited `temporal-service.mdx`. They are on
[persistence.mdx](https://raw.githubusercontent.com/temporalio/documentation/main/docs/encyclopedia/temporal-service/persistence.mdx),
l.50-59, where the PostgreSQL list is the specific versions 13.18, 14.15, 15.10 and 16.6, not a
range. Fix the link and the wording.

**L14. §2.4 l.270-271.** The cited DBOS Bun issue #1126 is closed. It was "Production crash:
'Duplicate debug point name' on Bun 1.3.1+". The claim is fine; add the title so a reader knows
what broke.

---

## Claims sampled and confirmed (44)

**npm registry, latest versions, licences and engines.**
- `@temporalio/client` and `worker` 1.24.0, MIT, node ≥ 20.3.0, published 2026-09-15.
- `inngest` 4.21.1, Apache-2.0, node ≥ 20, published 2026-10-01.
- `@restatedev/restate-sdk` 1.17.2, MIT, published 2026-09-21.
- `@dbos-inc/dbos-sdk` 5.2.11, MIT, node ≥ 20, published 2026-09-29.
- `@trigger.dev/sdk` 4.7.2, MIT, published 2026-10-02.
- `@hatchet-dev/typescript-sdk` 1.34.0, MIT, node ≥ 20, published 2026-10-02.
- `bullmq` 6.3.11, MIT, published 2026-10-01.
- `pg-boss` 12.36.0, MIT, node ≥ 22.12, published 2026-10-02.
- `graphile-worker` 0.18.0, MIT, node ≥ 22.18, published 2026-09-08.
- `workflow` 5.0.1, Apache-2.0.

**GitHub.**
- Hatchet engine v0.107.0 was released 2026-09-15, and Inngest server v1.45.1 on 2026-09-17.
- Contributor counts with `anon=1`: Temporal 96 (doc says 93), Inngest SDK 58, Inngest server
  51, Restate 19, DBOS 26, Hatchet 89, BullMQ 212, pg-boss 106, Graphile 60, Vercel 125,
  Trigger.dev 145.
- Issue states as described: Temporal #2273 open, Restate #662 open, DBOS #1126 closed.

**Temporal.**
- README: "officially supported on Node 20, 22, and 24". The client is "believed to work … Bun,
  Deno, and Cloudflare Workers". The README says it would "strongly discourage running Temporal
  Workers in anything except authentic Node.js".
- The replay warning about adding, removing or reordering `await` calls.
- The workflow type is the function name.
- Workflow Id uniqueness among open runs.

**DBOS.**
- The transaction quote, atomically committing user changes and a DBOS checkpoint.
- The seven datasource packages.
- `enqueueInTransaction`: the caller owns commit, and the workflow is not enqueued until commit.
- The `function_id` "monotonically increasing … order in which steps execute" quote.
- Cost of one write per step plus two per workflow.
- Step `retriesAllowed` defaults to false.
- `DBOS.createSchedule` stores schedules in the system database.
- `workflowID` as an idempotency key; the default returns the existing run.

**pg-boss.**
- The `db` option quote: "If the transaction rolls back, so does the job".
- `flow()` with `dependsOn`.
- Supports "Node 22.12 or higher, or Bun", and `fromBunSql` on Bun 1.4.0 and later.

**Graphile Worker.**
- Requires PostgreSQL 12+ and Node 22.18+.
- `addJob` defaults to 25 attempts.
- The JavaScript `addJob` "simply defers to the underlying `addJob` SQL function". That makes the
  §2.7 UNVERIFIED moot: a caller can run `graphile_worker.add_job` on its own transaction.

**BullMQ.**
- The Postgres backend exists and requires PostgreSQL 13+.
- The README lists "Node.js / Bun".

**Inngest.**
- Four retries by default, with a range of 0 to 20.
- Event id dedupe for 24 h, and the `idempotency` expression for 24 h.
- `connect()` needs Node 22.4+, Deno 1.4+ or Bun 1.1+, with 3 or 20 connections by plan.
- Reorder logs a warning; a changed id is a new step.
- The step id is hashed as the state key.
- Checkpointing is on by default in v4.
- Self-hosting uses an embedded Redis-compatible store plus SQLite, with single-node mode
  labelled beta.
- The server is SSPL with a future Apache-2.0 grant; the SDK `LICENSE.md` is Apache-2.0.
- `step.waitForSignal` exists.
- The "a request can succeed before Inngest records the step result" quote is correct, though
  it is a paraphrase in the document.

**Restate.**
- The LICENSE starts "Business Source License 1.1" and contains the "Public Restate Platform
  Service" grant.
- Prerequisite: "NodeJS >= v22 or Bun or Deno".
- The tunnel is for Restate Cloud and BYOC only.
- Single binary with an embedded store; a persistent volume is required for single-node.
- Idempotency keys are retained for 24 h.
- Signals, awakeables and workflow promises.
- The idempotency-table pattern and 2PC (two-phase commit) in the databases guide.
- The key-concepts replay quote.
- Cron is a guide pattern, not a primitive.

**Trigger.dev.**
- Self-hosting lists Checkpoints as ❌.
- "The trigger.dev CLI does not yet support Bun".
- Minimums of 3+ vCPU / 6+ GB and 4+ vCPU / 8+ GB.

**Hatchet.** Scheduling timeout defaults to 5 min, execution timeout to 60 s.

**Cloudflare Workflows.**
- GA on 2025-04-07.
- Step names "act as the 'cache key'".
- 1 MiB per step result, and 10,000 steps by default on the paid plan (1,024 on free).

**Vercel Postgres world.** It is a "reference implementation" with "no authentication" and uses
graphile-worker.

**Synthesis references.**
- "Design the seams (stable step identity, events committed in the same transaction as state)".
- Stage 5 is "Verify" and stage 8 is "Guard".
- Run-time phases 5-7 are Transaction, Data layer and Commit.

## Acceptance criteria

| # | Criterion | Status |
|---|---|---|
| 1 | Per-engine facts from primary sources, each linked | Met for facts. Partly met for links (M12). Fix M2, M9, L13 |
| 2 | Comparison table plus common denominator | Met. Fix the identity column (M1) and the cancel note (M3) |
| 3 | Interface that in-process implements fully, maps to Temporal, Inngest, Restate and DBOS, keeps the seams, needs no HTTP | In-process and no-HTTP: met. Seam (b): **not met** for steps and signals (H2). Mappings: Temporal (H1, H4), DBOS (H3, M8) and Inngest (M3, M4) need correction |
| 4 | Writing rules | Partly met (M12) |

## Required fixes, in priority order

1. H2: add the step-effect idempotency shim and outbox the signals. Correct "keeps seam (b)".
2. H1: state the dedupe-window bound and set the Temporal reuse and conflict policies.
3. H4: make step functions registered and top-level in the contract.
4. H3: add the DBOS system-database and `return-existing` conditions.
5. M1, M3, M4: correct step identity and Inngest cancel and run ids, and close the resolved
   UNVERIFIED items (L4, L5).
6. M5, M6, M10, M11: fix the internal contradictions in the interface.
7. M2, M7, M8, M9, then M12 and the low items.

---

## Round 2

VERDICT: ACCEPT-WITH-FIXES

Reviewer: same, 2026-10-04. I re-read the whole revised document (937 lines) against each
round-1 finding, then checked the new design pieces and the UNVERIFIED list in §8.5. I re-used
my round-1 fetches. The new evidence is the Inngest `signals.go` handler, the Inngest
`waitForSignal` reference, the Restate signals docs and the source of the Restate clients
library.

### R2.1 Status of the 30 round-1 findings

All 30 are applied, and applied correctly.

| Finding | Where in the revision | Status |
|---|---|---|
| H1 | §6.1.4 l.556-569; §6.5 l.784; §4.2 l.521 | Fixed. The relay is at least once, bounded by `dedupeWindow`, and refuses rows older than the window. The Temporal adapter sets `REJECT_DUPLICATE` and `USE_EXISTING`, and its window is the namespace retention |
| H2 | §1 l.53-58; §6.1.5 l.570-580; §6.3.4-5 | Fixed in principle. R3 has gaps; see R2.2 N1 |
| H3 | §2.4 l.307-315; §6.2 l.688-690; §6.5 l.831; §8.1 | Fixed |
| H4 | §6.1.2; `StepFn` and `steps` record; §6.5 l.778 | Fixed. The step-family case on Temporal is not covered; see N4 |
| M1 | §2.1 l.90-96; §2.3 l.232-237; §2.4 l.287-293; §3; §4.2 | Fixed. I spot-checked the error types against my round-1 copy of `error.ts`. `DBOSUnexpectedStepError` is documented there as "step has an unexpected recorded name" (l.104-106), and `DBOSStepNondeterminismError` as "recorded twice … with different results" (l.251-259). Both match the revision. The Temporal sdk-core quote (l.93-95) and the Restate `RunCommandMessage` description (l.232-234) also match source |
| M2 | §2.1 l.111-115 | Fixed. The note about the page stating both 10 minutes and 100 seconds is accurate |
| M3 | §2.2 l.216-224; §4.1 item 6; §6.5 l.801; the cannot-honour table | Fixed |
| M4 | §6.1.9; §6.5 l.799-800 | Fixed. The child-run id is still open; see N5 |
| M5 | §6.1.2; §6.3.1 | Fixed. The contradiction is gone |
| M6 | §1 l.47-49; §6.6 | Fixed |
| M7 | §1 l.50-51; §2.7; `completeInTransaction` | Fixed. The §4.2 row is stale; see N7 |
| M8 | §6.2 l.669-672 (`timeout` now required); §6.5 l.828 | Fixed |
| M9 | §0 l.33-35; §2.7 l.427 | Fixed |
| M10 | §6.1.3; §6.2 l.712-715 | Fixed |
| M11 | §6.1.6; `JobQueueAdapter.capabilities` | Fixed |
| M12 | Glosses and links throughout; §0 `anon=1` note | Fixed. One garbled sentence remains; see N8 |
| L1-L14 | As listed in §10 | Fixed. I checked each at its line |

### R2.2 New findings

Severity scale as in round 1.

**N1 (medium). §6.1.5 rule R3 and §6.2 `StepScope.stepKey`.**
Claim: rule R3 "gives exactly-once *effect* without `stepInTransaction`".

That holds for one action call per step attempt, run one attempt at a time. It breaks in two
cases the document does not cover.

*(a) Two actions in one step share a key.* A step that calls two Mesh actions passes the same
`${runId}:${stepName}` to both. On a retry, the second action finds the first action's row and
returns the first action's result.
→ Fix: key each call as `${stepKey}:${callIndex}`, or allow one action per step and enforce
that in the Verify stage.

*(b) Two attempts of the same step can run at the same time.* On Temporal, when an attempt hits
its start-to-close timeout the server schedules a retry. The worker running the timed-out
attempt is not stopped, so both attempts can reach the action. Inngest and Restate retry the
same way on timeout. Both attempts can then find "no row", write their effects, and commit
twice.
→ Fix: give `mesh_step_effects.step_key` a **unique constraint**, inserted at the start of the
action's transaction. The losing transaction then fails on the conflict, rolls back, and
returns the stored result.

*(c) Row retention is unstated.* A row must be kept longer than the longest retry span plus
the replay horizon. Otherwise a late retry finds no row and re-applies the effect.

With (a) and (b) fixed, R3 does give exactly-once effect for app-database writes on Temporal,
Inngest and Restate. That rests on three things:
- the engine reuses the same `runId` and step name on retry, which Temporal, Inngest and
  Restate do;
- the action commits its writes and its effects row in one transaction;
- the stored result is returned unchanged, which keeps replay deterministic.

Note also that `forkWorkflow` (DBOS) or a Temporal reset re-runs steps under the same run id.
R3 would then return the old results. Say whether that is intended.

**N2 (medium). §6.5 Inngest l.797 maps `waitForSignal` to `step.waitForSignal` as "native".**
Inngest does not buffer signals. The signal API returns
`publicerr.Wrap(err, 404, "No signal found")` when no run is waiting on that signal
([signals.go](https://raw.githubusercontent.com/inngest/inngest/main/pkg/api/apiv1/signals.go),
l.49-51). The signal string is also global rather than scoped to one run: "a unique identifier
for the signal, used to resume this function run". By default "duplicate signals will fail the
function" (`onConflict`), according to the
[step.waitForSignal reference](https://www.inngest.com/docs/reference/typescript/v4/functions/step-wait-for-signal).

A Mesh signal relayed through the outbox can arrive before the run reaches its wait, or while
the run is inside a step. Either way it gets a 404.

Temporal, DBOS (`send`/`recv` messages are persisted) and Restate signals ("each `await` of the
signal receives the next resolution") all buffer.
→ Fix: mark this mapping **shim**. The adapter must:
- compose the signal string as `${runId}:${name}`, so it is unique per run;
- treat a 404 as "retry later" in the relay, so the outbox row stays undelivered.

The relay must not let that retry loop trip the stale-row refusal rule (§8.4). Otherwise use
`step.waitForEvent` with an `if` match on the run id. Either way, state that Mesh signals are
buffered and that Inngest needs this emulation.

**N3 (medium). §6.5 Restate l.813, `waitForSignal` → `ctx.signal` or `ctx.awakeable`, "native".**
A Restate signal is "identified by the target invocation ID and a name". It is resolved through
`ctx.invocation(request.invocationId).signal(...).resolve(...)`, which needs a Restate `ctx`, so
it is sent from inside another handler
([external events](https://docs.restate.dev/develop/ts/external-events.md), Signals section).
Mesh addresses runs by `runId`, which is the workflow key, not the invocation id. Mesh signals
also come from the outbox relay, which runs outside Restate. An awakeable needs its generated id
published somewhere first.
→ Fix: the adapter generates a shared handler on each workflow, for example `signal(name,
payload)`. The relay calls it through the workflow client using the workflow key, and the
handler resolves the run's signal. Restate's workflow promises resolve only once, so a repeated
signal must go through a signal rather than a promise. Mark the row **shim**.

**N4 (medium). Step families on Temporal, §6.1.2 vs §6.5 l.778-779.**
Question: does step-family naming conflict with the engines' replay name checks?

On Restate, DBOS and Inngest it does not. The instance name `charge[<key>]` is recomputed
deterministically on replay, so the recorded and expected names match. The DBOS
`DBOSUnexpectedStepError` and the Restate `RunCommand` equality both pass.

On Temporal the mapping breaks. The mapping calls <code>proxyActivities()[name&#93;&#40;input)</code> with the
instance name. `charge[3]` is not a registered activity type, so the call fails with an
unregistered-activity error.
→ Fix: on Temporal, use the family name (`charge`) as the activity type, with the key in the
input or the activity id. Replay matches by position and by activity type, which stays stable.
§6.1.2 also says the verifier fails "a non-deterministic family key". That needs data-flow
analysis of the generated `run` body. Say what the verifier actually checks; for example, a key
expression may only read recorded step results and the input.

**N5 (medium). §6.1.9 "`RunHandle.runId` equals `StartOptions.dedupeKey` for every adapter"
vs `invoke` l.675.**
Round 1 had a `dedupeKey` option on `invoke`. The revision removed it, and child runs now get
no stated id. R3 keys on `runId`, and Temporal `executeChild` and DBOS `startWorkflow` need a
deterministic child id so that a replayed parent re-attaches to the same child rather than
starting a new one.
→ Fix: define the child id as `${parentRunId}:${invokeName}`, or `…[key]` inside a family, and
map it to the engine's child workflow id.

**N6 (low). §6.2 l.662-664, `stepInTransaction`.**
"Receives the transaction through `StepScope`-adjacent adapter wiring" does not define a
contract. `StepFn` has no `tx` parameter.
→ Fix: add `readonly tx?: Tx` to `StepScope`, present only for `stepInTransaction`, or give it a
distinct `TxStepFn` type.

**N7 (low). §4.2 l.517, the Transactions row.**
It still reads "only DBOS (steps, enqueue) and pg-boss/Graphile (enqueue)". It omits DBOS
`sendInTransaction` and the pg-boss transactional worker, which §1, §2.4 and §3 now include.

**N8 (low). §2.1 l.142-143.**
The text is garbled: "the count (is from [contributors]…". Fix the sentence.

**N9 (low). §2.1 l.110 vs §8.5.**
"Temporal: no outbox feature … **UNVERIFIED**" is missing from the §8.5 list, and so is the
Trigger.dev idempotency TTL from the dev report. Add both, or drop the Temporal item. A missing
feature is not a claim that needs a source.

**N10 (low, resolves an UNVERIFIED item). §2.3 l.279, §6.5 l.816, §8.5.**
"Restate's client-library cancel method" can be closed.
`packages/libs/restate-sdk-clients/src/api.ts` and `ingress.ts` contain no cancel or kill
method (grep for `cancel` returns nothing;
[api.ts](https://raw.githubusercontent.com/restatedev/sdk-typescript/main/packages/libs/restate-sdk-clients/src/api.ts),
[ingress.ts](https://raw.githubusercontent.com/restatedev/sdk-typescript/main/packages/libs/restate-sdk-clients/src/ingress.ts)).
Cancel is only through the admin API or the CLI, as the mapping already says.

### R2.3 Remaining UNVERIFIED items in §8.5

| Item | Status |
|---|---|
| Inngest TS run-handle helper | Still open. Harmless, because the adapter uses `GET /v1/runs/{runID}` |
| Inngest GPL detection source | Still open. The stale-metadata explanation is reasonable |
| Restate client-library cancel | **Closed** (N10): there is none |
| DBOS worker-side Bun and Deno | Still open. It matters for the "best external fit" ranking; test before choosing DBOS |
| Hatchet wait keying and Bun worker | Still open. Hatchet is not in the mapping, so this is low impact |
| BullMQ ioredis on Bun and Postgres-backend transaction | Still open. The BullMQ Postgres guide (l.251-301) describes BullMQ's own transactions only, with no caller-transaction option; "not documented" is the accurate wording |
| Graphile timeouts and Bun | Still open. Low impact |
| Vercel and Cloudflare items | Still open. Both engines are excluded, so no impact |
| Temporal Cloud terms | Still open. No impact on the interface |

None of the open items affects the interface sketch. DBOS Bun support affects only the
adapter-order recommendation.

### R2.4 Design check: answers to the coordinator's questions

- **Does R3 give exactly-once effect for app-database writes on Temporal, Inngest and
  Restate?** Yes, once N1 (a) and (b) are fixed. Without the unique constraint, two attempts
  running at the same time can both apply the effect.
- **Does step-family naming conflict with the replay name checks?** Not on Restate, DBOS or
  Inngest, because the name is deterministic on replay. On Temporal the mapping must use the
  family name as the activity type (N4).
- **Is the outbox sound?** Yes for starts, as now written. Signals rely on buffering, which
  Inngest lacks (N2) and Restate gives only through a generated handler (N3).
- **Do the capabilities fit the build-time manifest?** Yes. This is consistent with ruling 4.
- **Does the in-process runner still implement everything with no HTTP?** Yes. The persisted
  cancel flag closes round-1 L12.

### R2.5 Counts

Round 1: all 30 findings fixed.

Round 2: 10 new findings, all on design pieces added in this revision rather than on facts.

| Severity | Count | Findings |
|---|---|---|
| High | 0 | |
| Medium | 5 | N1-N5 |
| Low | 5 | N6-N10 |

Required before acceptance: N1, N2, N3, N4 and N5.

---

## Round 3

VERDICT: ACCEPT-WITH-FIXES

Reviewer: same, 2026-10-04. I re-read §1, §2.1, §2.3, §4.2 and §6.1-§6.5, and §8 and §11 of
the revised document (992 lines). I checked each round-2 finding at its line and then read the new
design pieces against each other. The one new source fetch was the DBOS client reference for
`forkWorkflow`.

### R3.1 Status of the 10 round-2 findings

All 10 are applied. Each change does what the round-2 finding asked.

| Finding | Where in the revision | Status |
|---|---|---|
| N1 | §6.1.5 l.578-597; `StepScope.effectKey` | Fixed. The key is per call, the unique constraint is inserted first, retention is stated, and reset and fork behaviour is stated. The constraint handles concurrent attempts correctly. In Postgres under READ COMMITTED, the second INSERT waits for the first transaction to finish. It then fails, or proceeds if the first rolled back. SQLite's single writer serialises the two. The "return the stored result" read must happen in a fresh transaction after the rollback. That is implicit in the text and acceptable |
| N2 | §6.5 Inngest `waitForSignal` | Fixed. It is a shim. The run-scoped string is `${runId}:${name}`, and a 404 means "retry later" without counting as a stale row. See P2 for a missing stop condition |
| N3 | §6.5 Restate `waitForSignal` | Fixed. It is a shim with a generated shared `signal` handler. See P3 |
| N4 | §6.1.2; §6.5 Temporal `step` row | Fixed for the activity type. The verifier rule is now stated precisely. See P1 for the step identity inside the activity |
| N5 | §6.1.9; the `invoke` rows | Fixed for Temporal, DBOS and Restate. See P4 for Inngest |
| N6 | `StepScope.tx` and its `stepInTransaction` doc comment | Fixed |
| N7 | §4.2 l.520 | Fixed |
| N8 | §2.1 l.142-145 | Fixed |
| N9 | §8.5 | Fixed |
| N10 | §2.3 l.277-283; §6.5 Restate `cancel` | Fixed |

### R3.2 New findings

**P1 (medium, correctness). Family instances lose their identity in the step functions and in
the effect keys. Affects §6.1.2, §6.1.5, the `StepScope` sketch and every §6.5 `step` row.**

The effect key is `${runId}:${stepName}:${callIndex}`. For a family, `stepName` has to be the
*instance* name, `charge[<key>]`. On Temporal, though, the registered activity type is the
family name `charge`, and the key travels in the input (§6.5). Nothing in the document says the
adapter rebuilds the instance name from the key when it builds the `StepScope`.

If the adapter uses the activity type, every instance gets the same effect key,
`${runId}:charge:0`. Rule R3 then returns the first instance's stored result for `charge[2]`,
`charge[3]` and so on. The charges are silently skipped and the run reports success. That
breaks seam (d), "no silent fallbacks", in exactly the path R3 exists to protect.

The same gap shows in the other mappings. The Inngest, Restate and DBOS rows call
<code>steps[name&#93;&#40;input)</code>. For `name = "charge[3]"` that lookup returns `undefined`, because the
function lives in `stepFamilies["charge"]`.

→ Fix:
- State that the scope's step name is always the instance name, built as `family[key]`.
- On Temporal, the adapter takes the key from the input or the activity id. It does not take it
  from the activity type.
- Resolve the function from `stepFamilies[family]` for family instances.
- Add one sentence to §6.1.5 saying that effect keys use instance names.

**P2 (low). §6.5 Inngest `waitForSignal`.** The relay retries a 404 indefinitely. That never
ends when the run has finished or been cancelled, or when it takes a branch that never waits on
that signal. A row like that never settles. If delivery is ordered per run, it also blocks every
later signal to the same run.
→ Fix: on a 404, check `GET /v1/runs/{runID}`. If the run is terminal, dead-letter the row with
an operator error (seam d). Keep retrying only while the run is live. The "alternative"
`waitForEvent` with an `if` match needs the same rule. This document gives no evidence that it
matches events sent before the wait starts, so do not present it as avoiding the problem.

**P3 (low). §6.5 Restate `waitForSignal`.** The generated shared handler has to know the run
handler's *invocation id* to call `ctx.invocation(id).signal(name).resolve(...)`. The document
does not say where it gets it.
→ Fix: as its first action, the `run` handler stores `ctx.request().id` in workflow state. The
shared handler reads that state. If the signal arrives before the id is stored, the handler
fails with a retryable error, and the relay retries.

**P4 (low). §6.5 Inngest `invoke`.** "Addressed by the deterministic child id in the adapter's
run-id mapping" does not say how the child *function* learns its Mesh run id. `step.invoke` does
not let the caller set the child's Inngest run id, and the child's `StepScope.runId` and effect
keys depend on that value.
→ Fix: the adapter puts `${parentRunId}:${invokeName}` into the invoke payload. The generated
child handler uses it as `runId`.

**P5 (low). §6.1.5, `callIndex`.** The text does not say who assigns `callIndex`. If it is a
run-time counter, it is not stable when a step makes calls inside `Promise.all` or a
data-dependent loop.
→ Fix: the generator assigns each action call site a static index. A call inside a loop uses
`${index}:${loopKey}`, where the loop key is deterministic.

**P6 (low). §6.3.1.** The verifier checks step names for uniqueness, but child ids are now
derived from `invokeName` (§6.1.9). Two `invoke("x", …)` calls in one run would map to the same
child id. On Temporal the second `executeChild` fails while the first child is open. On DBOS the
default returns the first child's result.
→ Fix: extend the uniqueness rule to `invoke` names. Within a family, the rule applies per key.
Apply it to `sleep` and `waitForSignal` names too, since those names are also step ids on
Inngest.

**P7 (low; closes an UNVERIFIED item). §6.1.5 and §8.5, "whether DBOS `forkWorkflow` keeps the
run id".** It does not. The signature is
`forkWorkflow(workflowID, startStep, options?: { newWorkflowID?, … }): Promise<string>`, described
as "Start a new execution of a workflow from a specific step"
([client reference](https://docs.dbos.dev/typescript/reference/client.md), l.74-75, 527-530).
The new execution has a new id, so R3 keys differ and steps from `startStep` onward re-apply
their effects. Steps before `startStep` are copied, not re-run. DBOS's `rewindWorkflow`
(l.532-538) keeps the id, so it matches the "returns old results" case the document describes.
→ Fix: replace the UNVERIFIED with this, and map fork to "new run id" and rewind to "same run
id".

### R3.3 Internal consistency

I found no other contradictions:
- §1, §6.1.4-6.1.5, §6.3.4 and §6.4 use the same R3 and outbox wording.
- No old single-key `${runId}:${stepName}` text remains; the only hits for `mesh_step_effects`
  are at l.583, 787 and 950.
- The capability fields match the cannot-honour table.
- The in-process runner still implements everything with no HTTP.

### R3.4 Counts and verdict

Round 2: all 10 findings fixed.

Round 3: 7 new findings.

| Severity | Count | Findings |
|---|---|---|
| High | 0 | |
| Medium | 1 | P1, a silent wrong-result bug in R3 for step families |
| Low | 6 | P2-P7 |

The bar for acceptance is no bugs and nothing worth another round. P1 is a correctness bug, so
the verdict is **accept-with-fixes**. The fixes are local: a few sentences in §6.1.2, §6.1.5 and
§6.5, plus the `StepScope` comment. If they are applied as written above, a further round needs
only a spot-check of P1 and P2, not a full re-review.

---

## Round 4

VERDICT: ACCEPT

Reviewer: same, 2026-10-04. In this spot-check I read P1 and P2 in full, looked at P3-P7 at the
lines they changed, and searched for any leftover text that contradicts them. I read §12 and
§6.1.5 l.578-606, `StepScope`, §6.3.1, every §6.5 row these fixes touch, and §8.5.

### R4.1 P1 and P2 (full check)

**P1: fixed.**
- §6.1.5 now states that the `stepName` in an effect key is always the instance name, such as
  `charge[3]`. It also explains the silent-skip failure that would happen otherwise.
- `StepScope` has a new `stepName` field, documented as "the INSTANCE name … never the family name
  (or an engine activity type) alone". `effectKey` is defined in terms of it.
- In the Temporal `step` row, the activity type is the family name. The adapter "rebuilds the
  instance name `charge[<key>]` from that key (not from the activity type)".
- The Inngest, Restate and DBOS rows look the function up in `stepFamilies[family]` for an
  instance. The Restate lookup is in its `register` row.

Effect keys are now per instance on all four engines. The replay name checks still pass on
Restate, DBOS and Inngest, because those engines see the deterministic instance name. Temporal
sees the stable family activity type.

**P2: fixed.** In the Inngest `waitForSignal` row, a 404 triggers a check of
`GET /v1/runs/{runID}`. While the run is live, the relay retries, and the retry does not count
toward the stale-row refusal (§8.4). When the run is terminal, the relay dead-letters the row
with an operator error. The `waitForEvent` alternative is now described as needing the same rule.
A signal row can no longer retry forever or block later signals to the same run.

### R4.2 P3-P7 (glance)

| Finding | Status |
|---|---|
| P3 | Fixed. The Restate `run` handler stores `ctx.request().id` in workflow state first. An early signal fails retryably. This appears in both the `register` and `waitForSignal` rows |
| P4 | Fixed. The Inngest `invoke` row passes `${parentRunId}:${invokeName}` in the invoke payload, and the child uses it as its `runId` |
| P5 | Fixed. `callIndex` is a static per-call-site index. A call inside a loop uses `${index}:${loopKey}` |
| P6 | Fixed. §6.3.1 extends the uniqueness rule to `invoke`, `sleep` and `waitForSignal` names, applied per key inside a family |
| P7 | Fixed. Fork means a new run id, so effects re-apply from `startStep`; rewind keeps the id. Both match the client reference I fetched in round 3. The item is gone from the §8.5 UNVERIFIED list |

### R4.3 Consistency

I found no contradiction that changes behaviour. There are two editorial nits. Neither needs
another round.

1. **§6.5 Temporal `register` row (l.823).** It still writes the wrapper as
   <code>proxyActivities&lt;...&gt;()[name&#93;&#40;input)</code>. Read on its own, that uses the instance name as the
   activity type. The `step` row directly below it gives the correct family-name rule.
   → Change it to <code>[familyOrStepName&#93;&#40;input)</code>, or point to the `step` row.
2. **`StepScope.effectKey(callIndex: number)`.** Section 6.1.5 allows the composite form
   `${index}:${loopKey}` for calls inside a loop, which is not a number.
   → Widen the parameter to `number | string`, or add a `loopKey?` parameter.

### R4.4 Counts and verdict

Round 3: all 7 findings fixed. P1 and P2 were checked in full; P3-P7 were checked at their
changed lines.

Round 4: 0 high, 0 medium, 0 low findings, plus 2 editorial nits that can be applied without
re-review.

Final verdict: **ACCEPT.** The facts were checked against primary sources over four rounds. The
interface keeps seams (a) to (e). The in-process runner implements the whole contract with no
HTTP. The remaining UNVERIFIED items (§8.5) do not affect the interface, apart from DBOS Bun
support on the worker, which the document already says must be tested before DBOS is chosen as
the first external adapter.

---
title: "Durable workflow engines"
description: "Eleven durable workflow engines compared, and a proposed, not yet agreed, Mesh workflow adapter interface."
---

# Durable workflow engines and the Mesh workflow adapter interface

> Independent fact-check: [review of this document](./reviews/durable-engines-review.md).

Date: 2026-10-04. Status: research plus a proposal. The interface in section 6 is **not agreed**.

## 0. Who this is for and what it answers

**Mesh** is a planned TypeScript framework in which one resource file declares data, operations
and rules, and Mesh derives the rest. Its architecture proposal is in
[`notes/research/00-synthesis.md`](./synthesis.md). That document says Mesh should "design the seams (stable step
identity, events committed in the same transaction as state) and stop there" for durable workflows
(section "Do not build yet"), and lists "Durable workflows: which engine, if any" as open question 7.
On 2026-10-04 the operator ruled (`notes/decisions-2026-10-04.md`, row 7) to compare durable engines
now, in order to define Mesh's **workflow adapter interface**, with the in-process runner as the
first adapter. Row 8 of the same file makes the first transport a **CLI**, so nothing here may
assume an HTTP request.

A *durable workflow engine* runs a multi-step function so that it survives a crash, a deploy or a
months-long sleep: completed steps are recorded and not run again. A *job queue* only runs
independent jobs with retries; it has no notion of a multi-step function. This document compares
six durable engines and three job queues, adds two cloud-platform workflow products, and proposes
one TypeScript interface that the in-process runner implements completely and that maps onto
Temporal, Inngest, Restate and DBOS.

**How facts were gathered.** Facts come from official docs, SDK source on GitHub, the npm registry
and the GitHub API, fetched on 2026-10-04. Three read-only research agents did the first pass; I
re-fetched and re-read the sources for the claims the interface depends on most (marked
"re-checked" below). Anything not confirmed from a fetched page is marked **UNVERIFIED**.
Contributor counts come from the last page number of the GitHub contributors API requested with
`anon=1`, which also counts contributors who have no GitHub account, so they run slightly higher
than the named-contributor list (pg-boss shows 106 with and 96 without; Trigger.dev 145 and 140).
Contributor count matters because it estimates how many people could fix a bug in the SDK Mesh
would depend on. Release dates matter because they show whether the project is alive: every engine
below had a release within the preceding five weeks, but Graphile Worker's cadence is bursty: five npm
releases since June 2026 after a 26-month gap, and only one GitHub Release object (see section
2.7), so a recent date there is not a sign of steady activity.

## 1. Summary

1. **Every durable engine exposes the same seven operations**: start a named workflow with an
   input and a dedupe key, run a named step with retries, durable sleep, wait for an external
   signal with a timeout, call a child workflow, cancel, and read status/result. Section 4 lists
   them and the cases where an engine's version of an operation is weaker.
2. **They disagree on what identifies a step.** Inngest and Cloudflare key on a string name.
   Temporal, Restate and DBOS match recorded steps by *position* and also check the recorded
   name, so a rename is a replay failure on all three (Inngest instead silently re-runs a renamed
   step). This is the most important divergence for Mesh's "stable step identity" seam. Because a
   Mesh workflow is declared in a resource file, Mesh can keep names stable and declared; replay
   safety also needs the *control flow* to be deterministic given recorded results, which names
   alone do not guarantee (section 6.3, 6.6).
3. **Only DBOS commits a durable-workflow step together with application database writes**
   (pg-boss does the same for a job's completion), and only DBOS, pg-boss and Graphile Worker can
   enqueue work in the caller's own Postgres transaction, with conditions (section 2.4). For every
   other engine, "events committed in the same transaction as state" needs an **outbox**: a row
   written in the action's transaction and relayed to the engine afterwards. The relay delivers
   at least once, so a workflow is started once only while the relay lag is shorter than the
   engine's dedupe memory (section 6.1). Steps also run at least once on every engine, so a step
   that writes to the app database needs an idempotency shim (section 6.1, rule R3). The
   proposed interface makes both a Mesh-core responsibility.
4. **Running with no HTTP request narrows the field.** Temporal and Hatchet workers connect out
   over gRPC and DBOS is a library on Postgres. Restate needs a server plus an HTTP service
   endpoint (an outbound tunnel exists but only for Restate Cloud/BYOC). Inngest's default
   `serve()` is an HTTP endpoint; its `connect()` worker avoids that but needs WebSocket support.
5. **Bun is unproven for most workers.** The pg-boss, BullMQ, Restate and Inngest docs claim Bun;
   Trigger.dev documents an experimental Bun runtime but its CLI must run under Node; Hatchet
   documents a client-only mode on Bun; Temporal explicitly warns against non-Node workers.
   Mesh targets Bun and Node (`CLAUDE.md`), so any adapter other than in-process or pg-boss
   carries a runtime caveat.
6. **Recommendation.** Define the interface as two small contracts, `JobQueueAdapter` and
   `WorkflowAdapter`, with a declared capability list in the style of ruling 4 (an unsupported
   capability is a build-time error, never a silent fallback). Build the in-process runner first,
   then DBOS as the first external adapter (Postgres only, no server, in-process, native
   transactions), then Temporal. Restate and Inngest are mappable but need an HTTP endpoint or
   an extra server. Trigger.dev, Hatchet and the cloud products are poor fits (section 7).

## 2. Per-engine findings

Each subsection is ordered: programming model, step identity, determinism and replay, storage and
infrastructure, transactions, retries/timers/signals/children/schedules/dedupe, versioning,
TypeScript typing, runtime, licence and maintenance, client API. A table in section 3 repeats the
key rows side by side.

### 2.1 Temporal (`@temporalio/*`, TypeScript SDK)

- **Model.** A workflow is an exported async function. Activities (the side-effecting steps) are
  plain functions in a separate file, called through `proxyActivities<typeof activities>({ startToCloseTimeout })`
  ([workflows](https://raw.githubusercontent.com/temporalio/documentation/main/docs/develop/typescript/workflows/basics.mdx),
  [activities](https://raw.githubusercontent.com/temporalio/documentation/main/docs/develop/typescript/activities/basics.mdx)).
- **Step identity.** The workflow type is the function name, with no way to customise it in
  TypeScript ("there isn't a mechanism to customize the Workflow Type", workflows page). An activity type name can be customised at worker registration
  (activities page). Replay matches commands by **sequence and name**: the docs warn that "adding, removing, or
  reordering `await` calls on Command-producing APIs" breaks replay
  ([versioning](https://raw.githubusercontent.com/temporalio/documentation/main/docs/develop/typescript/workflows/versioning.mdx)),
  and the core library raises a nondeterminism error when "Activity type of scheduled event ... does
  not match activity type of activity command" (it also checks the activity id)
  ([activity_state_machine.rs](https://raw.githubusercontent.com/temporalio/sdk-core/master/crates/sdk-core/src/worker/workflow/machines/activity_state_machine.rs)).
  So a rename breaks an in-flight run. (Closed from reviewer evidence.)
- **Determinism and replay.** Event-history replay. Workflow code runs in a V8 sandbox where
  `Math.random`, `Date` and `setTimeout` are replaced by deterministic versions; side effects go in
  activities ([workflows page](https://raw.githubusercontent.com/temporalio/documentation/main/docs/develop/typescript/workflows/basics.mdx);
  [definition](https://raw.githubusercontent.com/temporalio/documentation/main/docs/encyclopedia/workflow/workflow-definition.mdx)).
- **Storage and infrastructure.** A Temporal Service (server plus persistence plus visibility
  stores). Persistence: Cassandra, PostgreSQL (specific versions 13.18, 14.15, 15.10, 16.6), MySQL 5.7/8.0;
  SQLite for dev only
  ([persistence](https://raw.githubusercontent.com/temporalio/documentation/main/docs/encyclopedia/temporal-service/persistence.mdx);
  architecture in [service docs](https://raw.githubusercontent.com/temporalio/documentation/main/docs/encyclopedia/temporal-service/temporal-service.mdx)).
  Workers are separate processes started with `Worker.create`. A server is always required.
- **Transactions.** No atomic step-plus-application-DB commit. The docs recommend idempotent
  activities and "idempotency keys for critical side effects"
  ([activity definition](https://raw.githubusercontent.com/temporalio/documentation/main/docs/encyclopedia/activities/activity-definition.mdx)).
  No outbox feature found (absence of evidence; **UNVERIFIED**).
- **Retries, timers, signals, children, schedules, dedupe.** Activities retry by default with
  unlimited attempts and exponential backoff (coefficient 2.0, 1 s initial interval, capped at a
  maximum interval of 100 seconds, i.e. 100 times the initial interval; the 10-minute figure on the
  same page applies to Workflow Task retries, which retry policies do not govern)
  ([retry policies](https://raw.githubusercontent.com/temporalio/documentation/main/docs/encyclopedia/retry-policies.mdx));
  `sleep('30 days')` and `condition(fn, timeout)`
  ([timers](https://raw.githubusercontent.com/temporalio/documentation/main/docs/develop/typescript/workflows/timers.mdx));
  `defineSignal`/`defineQuery`/`defineUpdate`
  ([message passing](https://raw.githubusercontent.com/temporalio/documentation/main/docs/develop/typescript/workflows/message-passing.mdx));
  `startChild`/`executeChild`
  ([children](https://raw.githubusercontent.com/temporalio/documentation/main/docs/develop/typescript/workflows/child-workflows.mdx));
  schedules and cron
  ([schedules](https://raw.githubusercontent.com/temporalio/documentation/main/docs/develop/typescript/workflows/schedules.mdx)).
  Dedupe: the Workflow Id is unique only among **open** workflows in a namespace. The default
  *reuse* policy, Allow Duplicate, lets a closed run's id start again; Reject Duplicate checks only
  closed runs still within the namespace's retention period; the default *conflict* policy for an
  open run returns a "Workflow execution already started" error rather than the existing run
  (`USE_EXISTING` changes that)
  ([workflow id](https://raw.githubusercontent.com/temporalio/documentation/main/docs/encyclopedia/workflow/workflow-execution/workflowid-runid.mdx)).
- **Versioning.** `patched('id')`/`deprecatePatch('id')` markers in history, or Worker Versioning
  with Build IDs, which pin a run to the worker build that started it, so old runs finish on old
  code (versioning page above).
- **Typing.** `proxyActivities<A>`, `client.workflow.start(fn, { args })` typed from the workflow
  function, generic `defineSignal`/`defineQuery`
  ([workflow.ts](https://raw.githubusercontent.com/temporalio/sdk-typescript/main/packages/workflow/src/workflow.ts)).
- **Runtime.** Workers: Node 20/22/24 only; the README says they "strongly discourage running
  Temporal Workers in anything except authentic Node.js". The client is "believed to work" on Bun,
  Deno and Workers but is untested (re-checked,
  [README](https://raw.githubusercontent.com/temporalio/sdk-typescript/main/README.md)). Open Bun
  tracking issue: [#2273](https://github.com/temporalio/sdk-typescript/issues/2273). No inbound HTTP
  is needed; the server is reached over gRPC.
- **Licence and maintenance.** MIT. 1.24.0 released 2026-09-15; last commit 2026-10-02; 96 contributors with `anon=1`; the
  figures come from [contributors](https://api.github.com/repos/temporalio/sdk-typescript/contributors?per_page=1&anon=1),
  [release](https://api.github.com/repos/temporalio/sdk-typescript/releases/latest) and
  [commits](https://api.github.com/repos/temporalio/sdk-typescript/commits?per_page=1). Temporal
  Cloud terms: **UNVERIFIED**.
- **Client.** `client.workflow.start/execute/getHandle`, handle `result/describe/cancel/terminate/signal/query/executeUpdate`
  ([workflow-client.ts](https://raw.githubusercontent.com/temporalio/sdk-typescript/main/packages/client/src/workflow-client.ts)).

### 2.2 Inngest (`inngest`)

- **Model.** `inngest.createFunction({ id, triggers }, async ({ event, step }) => { await step.run("load-task", ...) })`
  ([step.run](https://www.inngest.com/docs-markdown/durable-execution/primitives/step-run)).
- **Step identity.** The string id of each `step.run`. The SDK hashes the id as the state key and
  records the step index; reordering steps only logs a warning, because results are matched by id
  ([durable workflows](https://www.inngest.com/docs-markdown/durable-execution/durable-workflows),
  [versioning](https://www.inngest.com/docs-markdown/durable-execution/guides-and-advanced/versioning)).
- **Determinism and replay.** Memoisation: "Inngest resumes a run by replaying your handler and
  returning saved step results." Code outside a step may run again on every replay. SDK v4
  checkpointing is an optimisation that runs steps eagerly in one request
  ([checkpointing](https://www.inngest.com/docs-markdown/durable-execution/guides-and-advanced/checkpointing)).
- **Storage and infrastructure.** Inngest Cloud, or self-host with `inngest start`: single node
  with embedded Redis-compatible store plus SQLite (labelled beta), or external Redis and Postgres
  for larger installs
  ([self-hosting](https://www.inngest.com/docs-markdown/platform-and-operations/self-host-inngest)).
- **Transactions.** No documented atomic step plus application DB commit; the docs tell you to
  use idempotency keys or upserts because "a request can succeed before Inngest records the step
  result" ([idempotency](https://www.inngest.com/docs-markdown/durable-execution/guides-and-advanced/idempotency)).
  `step.sendEvent` is atomic only with respect to Inngest's own state.
- **Retries and the rest.** Default 4 retries (0–20), `timeouts.start/finish`, `step.sleep`,
  `step.sleepUntil`, `step.waitForEvent`, `step.waitForSignal`, `step.invoke`, cron triggers,
  event-id dedupe for 24 hours, plus concurrency, throttle, rate-limit, debounce, singleton,
  priority and batching
  ([retries](https://www.inngest.com/docs-markdown/durable-execution/guides-and-advanced/error-handling/retries),
  [create](https://www.inngest.com/docs-markdown/reference/typescript/v4/functions/create),
  [invoke](https://www.inngest.com/docs-markdown/reference/typescript/v4/functions/step-invoke)).
  The 24-hour dedupe window matters: a start request retried after 24 hours is not deduplicated.
- **Versioning.** New code applies to in-flight runs; completed steps are reused by matching id;
  a changed id is a new step; for rewrites, create a new function id and let the old one drain
  (versioning page above).
- **Typing.** `eventType(name, { schema })` accepts any library implementing Standard Schema (a shared
  validator interface that Zod, Valibot and ArkType implement), giving typed
  `event.data` and typed `send`
  ([triggers](https://www.inngest.com/docs-markdown/reference/typescript/v4/functions/triggers)).
- **Runtime.** Docs claim Node, Bun and Deno; npm `engines` is `node>=20`. `serve()` needs an
  HTTP endpoint ([serve](https://www.inngest.com/docs-markdown/durable-execution/deploying-functions/serve)).
  `connect()` is an outbound WebSocket worker with no inbound HTTP, needing Node 22.4+, Bun 1.1+ or
  Deno, and limited, on Inngest Cloud, to 3 connections on Free and 20 on paid plans (a self-hosted
  server exposes its own connect gateway)
  ([connect](https://www.inngest.com/docs-markdown/durable-execution/deploying-functions/connect)).
  Related open issue: [#1624](https://github.com/inngest/inngest-js/issues/1624), a memory-retention
  performance fix ("Lazily instantiate StreamTools TransformStream to avoid ... Bun GC
  retention"), not evidence that Bun is unsupported.
- **Licence (resolved).** npm `latest` says Apache-2.0 (re-checked,
  [registry](https://registry.npmjs.org/inngest/latest)), the published tarball contains an
  Apache-2.0 `LICENSE.md`
  ([package LICENSE](https://raw.githubusercontent.com/inngest/inngest-js/main/packages/inngest/LICENSE.md)),
and the monorepo has no root LICENSE (the GitHub licence endpoint returns 404 while the repository
  metadata says `gpl-3.0`), so the GPL-3.0 label is probably stale detector metadata; the source
  of the detection stays **UNVERIFIED**, and the SDK that Mesh would import is Apache-2.0 in
  practice. The **server** (`inngest/inngest`) is under the Server Side Public
  License v1 (SSPL: a source-available licence that requires anyone offering the software as a
  service to publish their whole service stack) plus a future Apache-2.0 grant
  ([LICENSE](https://raw.githubusercontent.com/inngest/inngest/main/LICENSE.md)), which matters
  for anyone self-hosting.
- **Maintenance.** SDK 4.21.1 released 2026-10-01
  ([release](https://api.github.com/repos/inngest/inngest-js/releases/latest)); server v1.45.1
  released 2026-09-17 ([release](https://api.github.com/repos/inngest/inngest/releases/latest));
  58 (SDK) and 51 (server) contributors with `anon=1`
  ([SDK](https://api.github.com/repos/inngest/inngest-js/contributors?per_page=1&anon=1),
  [server](https://api.github.com/repos/inngest/inngest/contributors?per_page=1&anon=1)).
- **Client.** `inngest.send({ name, data })` returns ids. Status and results come from the REST API
  (`GET /v1/events/{id}/runs`, [example](https://www.inngest.com/docs-markdown/examples/fetch-run-status-and-output)).
  `send()` returns *event* ids; a run id exists only once the run is created and is found through
  that endpoint, so a run handle needs a lookup. A TypeScript run-handle with an await-result
  helper: **UNVERIFIED**. Single-run cancel and status exist on the server API
  (`DELETE /v1/runs/{runID}`, `GET /v1/runs/{runID}`,
  [apiv1.go](https://raw.githubusercontent.com/inngest/inngest/main/pkg/api/apiv1/apiv1.go)); the
  docs say cancellation "prevents queued and sleeping runs from continuing and stops active runs
  between steps"
  ([cancellation](https://www.inngest.com/docs-markdown/durable-execution/guides-and-advanced/cancellation));
  `cancelOn` events and
  [bulk cancel](https://www.inngest.com/docs-markdown/durable-execution/guides-and-advanced/cancellation/bulk-cancellation)
  also exist.

### 2.3 Restate (`@restatedev/restate-sdk`)

- **Model.** Services, virtual objects and workflows with handlers that take a `ctx`; steps are
  `ctx.run("write", () => ..., retryPolicy)`
  ([services](https://docs.restate.dev/develop/ts/services.md),
  [durable steps](https://docs.restate.dev/develop/ts/durable-steps.md)).
- **Step identity.** Position in the journal, with the recorded name also compared: the protocol's
  `RunCommandMessage` holds the completion id and the `name`, and message equality is full-struct
  equality, so a renamed `ctx.run` is a journal mismatch (error 570)
  ([messages.rs](https://raw.githubusercontent.com/restatedev/sdk-shared-core/main/src/service_protocol/messages.rs),
  [key concepts](https://docs.restate.dev/foundations/key-concepts.md)). The name is optional in
  the API. (Closed from reviewer evidence.)
- **Determinism and replay.** Journal replay: "Restate replays the journal, skipping completed
  steps". Non-deterministic work goes in `ctx.run`; use `ctx.rand` and `ctx.date.now()`.
- **Storage and infrastructure.** The Restate Server, a single binary with an embedded store, plus
  your service as an HTTP endpoint (default port 9080); no external Postgres or Redis; needs a
  persistent volume ([server overview](https://docs.restate.dev/server/overview.md)). The server
  is under the Business Source License 1.1 (BSL: source-available; free to use except for a
  stated competing use, here offering a "Public Restate Platform Service", and converting to an open
  licence after a set date) (re-checked: [LICENSE](https://raw.githubusercontent.com/restatedev/restate/main/LICENSE)
  begins "Business Source License 1.1" and contains the "Public Restate Platform Service" grant).
  Restate Cloud is the hosted service; BYOC ("bring your own cloud") runs Restate's managed server
  inside the customer's cloud account.
- **Transactions.** None built in. The docs show user-built patterns: an idempotency-token table
  written "in the same transaction as the main operation", and Postgres two-phase commit
  ([databases guide](https://docs.restate.dev/guides/databases.md)).
- **Retries and the rest.** Per-`ctx.run` retry policy; `ctx.sleep`; delayed sends; signals,
  awakeables and workflow promises; typed service clients; idempotency keys with 24-hour retention;
  **no native cron**
  ([timers](https://docs.restate.dev/develop/ts/durable-timers.md),
  [external events](https://docs.restate.dev/develop/ts/external-events.md),
  [communication](https://docs.restate.dev/develop/ts/service-communication.md),
  [clients](https://docs.restate.dev/services/invocation/clients/typescript-sdk.md)).
- **Versioning.** Immutable deployments: each invocation is pinned to the deployment where it
  started, so no patching API exists; a new endpoint is registered per version and old ones are
  drained ([versioning](https://docs.restate.dev/services/versioning.md)). Long sleeps keep old
  deployments alive.
- **Typing.** Generic clients (`serviceClient<MyService>`); known gap: workflow client generics
  ([issue 662](https://github.com/restatedev/sdk-typescript/issues/662)).
- **Runtime.** Docs prerequisite line: "NodeJS >= v22 or Bun or Deno"
  ([services](https://docs.restate.dev/develop/ts/services.md)); Node HTTP/2, Lambda and fetch
  handlers ([serving](https://docs.restate.dev/develop/ts/serving.md)). A server plus an HTTP
  endpoint is always required; `@restatedev/restate-sdk-tunnel` avoids an inbound endpoint but is
  for Restate Cloud/BYOC.
- **Licence and maintenance.** SDK MIT; server BSL 1.1. SDK 1.17.2 released 2026-09-21; about 19
  contributors (19 with `anon=1`,
  [contributors](https://api.github.com/repos/restatedev/sdk-typescript/contributors?per_page=1&anon=1);
  [release](https://api.github.com/repos/restatedev/sdk-typescript/releases/latest)), the smallest of
  the engines compared. That matters because very few people can fix a bug in an SDK Mesh would
  depend on.
- **Client.** `clients.connect({ url })`, `workflowClient(...).workflowSubmit(...)`, result
  attach. Cancel by CLI or admin API
  ([managing invocations](https://docs.restate.dev/services/invocation/managing-invocations.md));
  the client library has no cancel method (no `cancel` in the clients package's
  [api.ts](https://raw.githubusercontent.com/restatedev/sdk-typescript/main/packages/libs/restate-sdk-clients/src/api.ts)
  or [ingress.ts](https://raw.githubusercontent.com/restatedev/sdk-typescript/main/packages/libs/restate-sdk-clients/src/ingress.ts)),
  so cancel is admin API or CLI only.

### 2.4 DBOS (`@dbos-inc/dbos-sdk`)

- **Model.** A library. `DBOS.registerWorkflow(fn)` and `DBOS.runStep(() => stepOne(), { name: "stepOne" })`,
  or `@DBOS.workflow()`/`@DBOS.step()` decorators
  ([workflows](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial.md),
  [steps](https://docs.dbos.dev/typescript/tutorials/step-tutorial.md)).
- **Step identity.** Execution order: `function_id` is "the monotonically increasing ID of the step
  … based on the order in which steps execute"
  ([system tables](https://docs.dbos.dev/explanations/system-tables.md)); the recorded name is also
  checked: `DBOSUnexpectedStepError` is the "step has an unexpected recorded name" error
  ([error.ts](https://raw.githubusercontent.com/dbos-inc/dbos-transact-ts/main/src/error.ts)).
  (`DBOSStepNondeterminismError` is a different error: a step recorded twice with different
  results.)
- **Determinism and replay.** Checkpoint to Postgres and resume from the last completed step;
  steps must be invoked "with the same inputs in the same order". Cost: one DB write per step plus
  two per workflow ([architecture](https://docs.dbos.dev/architecture.md)).
- **Storage and infrastructure.** Postgres only (the "system database"), no orchestrator; an
  optional Conductor, DBOS's control plane for monitoring and managing workflows, hosted or
  self-hosted.
- **Transactions (re-checked).** "DBOS Transactions are a special kind of step intended for
  database access. They execute as a single database transaction, atomically committing both
  user-defined changes and a DBOS checkpoint"
  ([transactions](https://docs.dbos.dev/typescript/tutorials/transaction-tutorial.md)); data
  sources exist for Knex, Kysely, Drizzle, TypeORM, Prisma, node-postgres and Postgres.js. A
  client call `enqueueInTransaction(pgClient, options, ...args)` enqueues a workflow in your own
  transaction; the caller owns commit/rollback and the workflow is not enqueued until commit
  ([client reference](https://docs.dbos.dev/typescript/reference/client.md)). **Conditions** (same
  page): the client "must be connected to your DBOS system database", so the app tables must live
  in that database for the write to be atomic with the enqueue; `duplicationPolicy: 'return-existing'`
  is not supported inside a transaction and the default `'reject'` throws
  `DBOSQueueDuplicatedError`, which aborts the caller's whole transaction; and no existing-run
  handle comes back on a duplicate. The same page documents `sendInTransaction(client,
  destinationID, message, topic, idempotencyKey)`, which sends a message (a signal) to a running
  workflow atomically with your writes. DBOS is the only engine here with transactional steps,
  transactional start and transactional signal.
- **Retries and the rest.** Step `retriesAllowed` (default false), `maxAttempts`, `backoffRate`,
  `timeoutMS`; durable workflow timeouts; `DBOS.sleep`; `DBOS.send/recv` with topics (`recv` takes seconds and, by default, returns `null` after 60
  seconds) and `setEvent/getEvent`; queues with concurrency, rate limits and priority; DB-stored cron
  schedules; `workflowID` as an idempotency key
  ([communication](https://docs.dbos.dev/typescript/tutorials/workflow-communication.md),
  [schedules](https://docs.dbos.dev/typescript/tutorials/scheduled-workflows.md)). Child workflows: "start child workflows with `startWorkflow` and await the results from their
  `WorkflowHandle`s"; a timeout cancels the workflow and all its children, and
  `cancelWorkflow(id, { cancelChildren })` exists (workflow tutorial, client reference).
- **Versioning.** `DBOS.patch('id')`/`deprecatePatch` (needs `enablePatching`) and
  `applicationVersion` (default a hash of workflow source); only same-version workflows are
  recovered, so deploys are blue-green
  ([upgrading](https://docs.dbos.dev/typescript/tutorials/upgrading-workflows.md)).
- **Typing.** `DBOSClient.enqueue<typeof Class.method>` is type-safe given the function type;
  otherwise args are unchecked. Inputs and outputs must be JSON-serialisable (SuperJSON default).
- **Runtime.** npm `engines` `node >= 20`. No official Bun statement; a Bun crash report exists
  ([#1126](https://github.com/dbos-inc/dbos-transact-ts/issues/1126), closed: "Production crash:
  'Duplicate debug point name' on Bun 1.3.1+"). Needs no HTTP
  server: `DBOS.launch()` connects to Postgres, and `DBOSClient.create({ systemDatabaseUrl })`
  works from a CLI. Worker-side Bun/Deno support: **UNVERIFIED**.
- **Licence and maintenance.** MIT. 5.2.11 released 2026-09-29; 26 contributors with `anon=1`
  ([release](https://api.github.com/repos/dbos-inc/dbos-transact-ts/releases/latest),
  [contributors](https://api.github.com/repos/dbos-inc/dbos-transact-ts/contributors?per_page=1&anon=1)).
- **Client** ([client reference](https://docs.dbos.dev/typescript/reference/client.md)).
  `DBOS.startWorkflow`, `handle.getResult()`, `retrieveWorkflow`, plus
  `getWorkflow`, `listWorkflows`, `cancelWorkflow`, `resumeWorkflow`, `forkWorkflow(id, startStep)`.

### 2.5 Trigger.dev (`@trigger.dev/sdk` v4)

- **Model.** `task({ id, retry, run })` with ordinary async code and no step primitive
  ([how it works](https://trigger.dev/docs/how-it-works.md)).
- **Step identity.** None below the task: the task `id` only. Durability across attempts comes
  from `idempotencyKeys` on child `triggerAndWait` calls.
- **Replay vs checkpoint.** Checkpoint/restore, not replay (CRIU, "Checkpoint/Restore In Userspace", is a Linux tool that
  freezes a running process's memory and state to disk so it can be resumed later): while a run waits (`triggerAndWait`,
  `wait.for` of 60 seconds or more) the platform snapshots the process with CRIU and restores it
  later. **Cloud only; self-hosted has no checkpoints**
  ([self-hosting](https://trigger.dev/docs/self-hosting/overview.md)). A retry is a fresh attempt
  of `run`.
- **Infrastructure.** Cloud, or self-host a webapp (Postgres, Redis) plus workers; documented
  minimums are 3+ vCPU/6 GB and 4+ vCPU/8 GB
  ([docker](https://trigger.dev/docs/self-hosting/docker.md)).
- **Transactions.** No documented atomic commit with app DB writes.
- **Retries and the rest.** `retry.maxAttempts` (default 3), `maxDuration`, `wait.for/until`,
  wait tokens (`wait.createToken/forToken/completeToken`) for external events, `triggerAndWait`,
  `schedules.task`, `idempotencyKey`, queues with `concurrencyLimit`
  ([wait](https://trigger.dev/docs/wait.md), [triggering](https://trigger.dev/docs/triggering.md),
  [idempotency](https://trigger.dev/docs/idempotency.md)). No event-bus wait.
- **Versioning.** A run is locked to the code version it started on; children inherit the
  parent's version ([versioning](https://trigger.dev/docs/versioning.md)); no in-flight migration.
- **Typing.** `tasks.trigger<typeof task>`; `schemaTask` validates payloads with Zod.
- **Runtime.** Node officially; Bun experimental (`runtime: "bun"`), but the CLI must run under
  Node ([bun guide](https://trigger.dev/docs/guides/frameworks/bun.md)). No HTTP endpoint in your
  app; code is built and deployed to the platform's workers.
- **Licence and maintenance.** The SDK package is MIT (npm; its
  [LICENSE](https://raw.githubusercontent.com/triggerdotdev/trigger.dev/main/packages/trigger-sdk/LICENSE)
  reads "MIT License, Copyright (c) 2023 Trigger.dev") while the repository root is Apache-2.0
  ([repo](https://api.github.com/repos/triggerdotdev/trigger.dev)): different licences for
  different packages. 4.7.2 released 2026-10-02
  ([release](https://api.github.com/repos/triggerdotdev/trigger.dev/releases/latest)); 145
  contributors with `anon=1`
  ([contributors](https://api.github.com/repos/triggerdotdev/trigger.dev/contributors?per_page=1&anon=1)).

### 2.6 Hatchet (`@hatchet-dev/typescript-sdk`)

- **Model.** `hatchet.task({ name, retries, fn })`; DAGs via `hatchet.workflow` plus
  `dag.task({ name, parents, fn })`; durable tasks via `durableTask` with `ctx.sleepFor` and
  `ctx.waitForEvent` ([tasks](https://docs.hatchet.run/v1/tasks.md),
  [DAGs](https://docs.hatchet.run/v1/directed-acyclic-graphs.md),
  [durable sleep](https://docs.hatchet.run/v1/durable-sleep.md)).
- **Step identity.** Task `name`; DAG edges are explicit. How waits are keyed inside a durable task
  is **UNVERIFIED**.
- **Determinism and replay.** Hybrid: durable tasks replay a durable event log from the latest
  checkpoint, and "must be deterministic given the event history"; ordinary tasks are at-least-once
  and must be idempotent
  ([durable tasks](https://docs.hatchet.run/v1/durable-tasks.md),
  [guarantees](https://docs.hatchet.run/v1/architecture-and-guarantees.md)).
- **Infrastructure.** Postgres is the source of truth; RabbitMQ is optional; an engine plus API
  server run as separate processes; Hatchet Lite is a single image for low throughput
  ([self-hosting](https://docs.hatchet.run/self-hosting/index.md)).
- **Transactions.** No documented atomic commit with app DB; guidance is idempotent child tasks.
- **Retries and the rest.** `retries` ([retry policies](https://docs.hatchet.run/v1/retry-policies.md)),
  `scheduleTimeout` (5 min default) and `executionTimeout` (60 s default)
  ([timeouts](https://docs.hatchet.run/v1/timeouts.md)), `ctx.waitForEvent(key, celExpr)`
  ([event waits](https://docs.hatchet.run/v1/durable-event-waits.md)), `child.run()`
  ([children](https://docs.hatchet.run/v1/child-spawning.md)), cron, and idempotency and
  concurrency strategies keyed by CEL (Common Expression Language, a small expression language for
  evaluating conditions on event data)
  ([idempotency](https://docs.hatchet.run/v1/idempotency.md),
  [concurrency](https://docs.hatchet.run/v1/concurrency.md)).
- **Versioning.** None in-flight: "deploy a new durable task definition and let the old work
  drain" ([Temporal migration page](https://docs.hatchet.run/llms-full.txt)).
- **Typing.** Generic input/output, Zod support; no event-schema registry.
- **Runtime.** Worker is a long-running process over gRPC (`@grpc/grpc-js`), no HTTP server; npm
  `engines` `node>=20`. A fetch-based client-only mode is said to work on Bun/Deno/Workers
  ([changelog](https://docs.hatchet.run/reference/changelog/typescript.md)); Bun as a *worker*
  runtime is **UNVERIFIED**.
- **Licence and maintenance.** MIT (SDK and repo). SDK 1.34.0 released 2026-10-02; engine v0.107.0
  released 2026-09-15 (a 0.x engine,
  [release](https://api.github.com/repos/hatchet-dev/hatchet/releases/latest)); SDK 1.34.0 from
  [npm](https://registry.npmjs.org/@hatchet-dev/typescript-sdk/latest); 89 contributors with
  `anon=1`
  ([contributors](https://api.github.com/repos/hatchet-dev/hatchet/contributors?per_page=1&anon=1)).

### 2.7 Job queues

These have no workflow, replay or step model. They are listed because the Mesh interface also
needs a `jobs` contract (a one-off background action) and because two of them can enqueue in the
caller's Postgres transaction.

| | BullMQ | pg-boss | Graphile Worker |
|---|---|---|---|
| Version, last release | 6.3.11, 2026-10-01 ([npm](https://registry.npmjs.org/bullmq/latest)) | 12.36.0, 2026-10-02 ([npm](https://registry.npmjs.org/pg-boss/latest)) | 0.18.0, 2026-09-08 ([npm](https://registry.npmjs.org/graphile-worker)); 0.x; five npm releases since June 2026 after a 26-month gap (0.16.6 on 2024-04-26), but only one GitHub Release object, which is what [`07-ts-foundation-candidates.md`](./ts-foundation-candidates.md) counted. Bursty, not dead |
| Storage | Redis; v6 adds an optional Postgres backend ([guide](https://raw.githubusercontent.com/taskforcesh/bullmq/master/docs/gitbook/guide/postgresql.md)) | Postgres 13+, claiming jobs with `SKIP LOCKED` (a Postgres clause that lets many workers take different rows without waiting on each other) | Postgres 12+ |
| Composition | `FlowProducer` parent/child tree ([flows](https://raw.githubusercontent.com/taskforcesh/bullmq/master/docs/gitbook/guide/flows/README.md)) | `boss.flow([...dependsOn])` ([jobs](https://raw.githubusercontent.com/timgit/pg-boss/master/docs/api/jobs.md)) | manual: a task calls `addJob` |
| Same-transaction enqueue and completion | Not possible with Redis (inference); Postgres backend: no documented way to join your transaction (**UNVERIFIED**) | **Yes**: `send()`, `insert()`, `fetch()`, `complete()` accept a `db` option; "If the transaction rolls back, so does the job" (re-checked, [adapters](https://raw.githubusercontent.com/timgit/pg-boss/master/docs/api/adapters.md)). A **transactional worker** also commits a worker's writes together with the job's completion (same page), the only job-level atomic completion here | **Yes**: `graphile_worker.add_job` is a SQL function callable inside your transaction ([docs](https://raw.githubusercontent.com/graphile/worker/main/website/docs/sql-add-job.md), re-checked); the JS `addJob` "simply defers to" the SQL function, so a caller can run `graphile_worker.add_job` on its own transaction ([add-job](https://raw.githubusercontent.com/graphile/worker/main/website/docs/library/add-job.md)) |
| Retries | `attempts`, `backoff` | `retryLimit`, `retryBackoff` | `max_attempts` default 25, exponential backoff |
| Dedupe | `jobId`, `deduplication: {id, ttl}` | `singletonKey`, queue policies | `job_key` (modes replace, preserve_run_at, unsafe_dedupe); completed jobs are deleted so keys are not permanent |
| Delay and cron | `delay`; job schedulers | `startAfter`; cron or RRULE (the iCalendar recurrence-rule format, e.g. "every second Tuesday") `schedule()` | `run_at`; crontab |
| Timeouts | none built in | `expireInSeconds` default 15 min, heartbeats | none documented (**UNVERIFIED**) |
| In-flight versioning | none | none | none; paid "Worker Pro" adds live migration |
| Bun | README says "Node.js / Bun"; Bun test config in repo; ioredis on Bun **UNVERIFIED** | README: Node 22.12+ or Bun; `fromBunSql` adapter for Bun 1.4.0+ | `engines` Node >= 22.18; Bun **UNVERIFIED** |
| Licence, contributors (`anon=1`) | MIT, 212 ([contributors](https://api.github.com/repos/taskforcesh/bullmq/contributors?per_page=1&anon=1)) | MIT, 106 ([contributors](https://api.github.com/repos/timgit/pg-boss/contributors?per_page=1&anon=1)) | MIT, 60 ([contributors](https://api.github.com/repos/graphile/worker/contributors?per_page=1&anon=1)) |

Sources: [BullMQ README](https://raw.githubusercontent.com/taskforcesh/bullmq/master/README.md),
[BullMQ connections](https://raw.githubusercontent.com/taskforcesh/bullmq/master/docs/gitbook/guide/connections.md),
[pg-boss README](https://raw.githubusercontent.com/timgit/pg-boss/master/README.md),
[pg-boss queues](https://raw.githubusercontent.com/timgit/pg-boss/master/docs/api/queues.md),
[pg-boss database backends](https://raw.githubusercontent.com/timgit/pg-boss/master/docs/database-backends.md),
[Graphile tasks](https://raw.githubusercontent.com/graphile/worker/main/website/docs/tasks.md),
[Graphile job keys](https://raw.githubusercontent.com/graphile/worker/main/website/docs/job-key.md),
[Graphile requirements](https://raw.githubusercontent.com/graphile/worker/main/website/docs/requirements.md),
[Graphile project status](https://raw.githubusercontent.com/graphile/worker/main/website/docs/project-status.md).

### 2.8 Cloud-platform workflows (included because their TypeScript APIs are public and documented)

- **Vercel Workflow SDK / Workflow DevKit** (npm `workflow` 5.0.1, Apache-2.0, [npm](https://registry.npmjs.org/workflow/latest); 125
  contributors with `anon=1`,
  [contributors](https://api.github.com/repos/vercel/workflow/contributors?per_page=1&anon=1)). Directives `"use workflow"` and `"use step"` compiled
  by a framework or bundler plugin; deterministic replay against an event log; steps carry a stable
  `stepId` usable as an idempotency key
  ([workflows and steps](https://workflow-sdk.dev/docs/foundations/workflows-and-steps.md)).
  Storage is pluggable ("Worlds"): local, Vercel, Postgres, or custom. The Postgres world runs
  outside Vercel but is described by its own docs as a "reference implementation ... not optimized
  for scale, speed, or security" with no authentication on its HTTP routes, and needs a
  long-running HTTP server plus graphile-worker
  ([postgres world](https://workflow-sdk.dev/worlds/postgres.md)). Whether npm `latest` 5.0.1 is
  "generally available" is **UNVERIFIED** (no GA statement found). Because it requires a bundler
  integration and an HTTP server, it does not fit a CLI-first runtime.
- **Cloudflare Workflows** (generally available since April 2025,
  [changelog](https://developers.cloudflare.com/workflows/reference/changelog/index.md)). `WorkflowEntrypoint.run(event, step)`
  with `step.do(name, config, cb)`, where the name (up to 256 characters) is the replay cache key
  ([rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/index.md)).
  Closed-source, Workers-only, no self-hosting, so there is no way to run it from a Bun/Node CLI.
  Limits include 1 MiB per step result and 10,000 steps by default
  ([limits](https://developers.cloudflare.com/workflows/reference/limits/index.md)). First-party
  documentation on in-flight versioning: **UNVERIFIED**. Both are excluded from the adapter
  mapping in section 6.5 because they cannot run without their platform.

## 3. Comparison table

| Engine | Step identity | Durability model | Infrastructure | Native tx with app DB | No inbound HTTP | Bun worker | Licence |
|---|---|---|---|---|---|---|---|
| Temporal | call order, name checked | event-history replay | Temporal Service + Postgres/MySQL/Cassandra | no | yes (gRPC out) | discouraged; client untested | MIT |
| Inngest | string id | memoised step replay | Cloud, or self-host (SQLite or Redis+Postgres) | no | `connect()` only | claimed in docs | SDK Apache-2.0; server SSPL+future Apache |
| Restate | journal order, name checked | journal replay | Restate Server + HTTP endpoint | no (user patterns) | no (tunnel on Cloud) | claimed | SDK MIT; server BSL 1.1 |
| DBOS | order, name checked | checkpoint to Postgres | Postgres only | **yes** (transaction steps, enqueue and send in tx, with conditions) | yes (library) | unverified | MIT |
| Trigger.dev | task id only | CRIU checkpoint (Cloud only) | Cloud, or self-host (Postgres, Redis, no checkpoints) | no | yes | experimental | npm MIT; repo Apache-2.0 |
| Hatchet | task name; DAG edges | DAG plus durable-log replay | Postgres (+ RabbitMQ optional), engine | no | yes (gRPC out) | unverified | MIT |
| BullMQ | job id | none (queue) | Redis or Postgres | no | yes | partial | MIT |
| pg-boss | job id | none (queue) | Postgres | **yes** (enqueue in tx; transactional worker commits with completion) | yes | yes (docs) | MIT |
| Graphile Worker | task id | none (queue) | Postgres | **yes** (SQL `add_job`) | yes | unverified | MIT |
| Vercel Workflow | stable `stepId` | deterministic replay | Vercel, or Postgres world + HTTP | n/a | no | unverified | Apache-2.0 |
| Cloudflare Workflows | step name | memoised replay | Cloudflare only | n/a | n/a | n/a | closed |

## 4. The common denominator, and what diverges

### 4.1 What every durable engine supports

All of Temporal, Inngest, Restate, DBOS, Trigger.dev, Hatchet, Vercel and Cloudflare support:

1. **Start** a named workflow with a typed input and a caller-supplied dedupe key (Temporal
   Workflow Id; Inngest event id or `idempotency` expression; Restate `idempotencyKey`; DBOS
   `workflowID`; Trigger.dev and Hatchet `idempotencyKey`; Cloudflare instance `id`).
2. **Run a named unit of work** durably, with a retry policy.
3. **Sleep** durably for an arbitrary duration.
4. **Wait for an external event/signal**, with a timeout (Temporal signals, Inngest `waitForEvent`
   and `waitForSignal`, Restate awakeables, DBOS `recv`, Trigger.dev wait tokens, Hatchet
   `waitForEvent`, Vercel hooks, Cloudflare `waitForEvent`).
5. **Call a child workflow** and wait for its result.
6. **Cancel** a run (Inngest cancels queued and sleeping runs and stops active runs between steps).
7. **Read status and result** by run id.

Job queues give only 1 (with a dedupe key), 2, a *start-time delay* (not mid-run sleep), cancel,
and some child composition.

### 4.2 What diverges

| Axis | Divergence | Why it matters for Mesh |
|---|---|---|
| Step identity | name-keyed (Inngest, Cloudflare, Vercel) vs order-keyed with the name also checked (Temporal, Restate, DBOS) vs none (Trigger.dev) | Mesh's seam is "stable, declared step names"; order-keyed engines need the order to be stable too |
| Determinism | replay engines forbid non-deterministic code in the workflow body; Trigger.dev (checkpoint) does not | The in-process runner must apply the strictest rule so a workflow that runs in-process also runs on any replay engine |
| Transactions | DBOS: transactional steps, enqueue and `sendInTransaction` (with conditions); pg-boss: enqueue and a transactional worker that commits with job completion; Graphile Worker: enqueue via SQL `add_job`; none of the others | decides whether the outbox and the step-effects shim (6.1.5) are needed |
| Infrastructure | none (DBOS: Postgres you already have) to a server cluster | decides what a Mesh app must provision |
| Transport | HTTP endpoint required (Restate, Inngest `serve`, Vercel) vs outbound worker | decides CLI fit |
| Versioning | patch markers (Temporal, DBOS), drain-the-old-version (Restate, Trigger.dev, Hatchet, Inngest new id), none for queues | Mesh declares steps statically, so Mesh can diff versions at build time (section 6.6) |
| Dedupe window | Inngest 24 h; Restate 24 h by default; Temporal only among open runs by default (closed runs reusable unless reject policy, then bounded by namespace retention); DBOS and Hatchet per their policies | a relayed start retried after the window creates a duplicate (section 6.1) |
| Cron | native on all compared engines except Restate; Vercel and Cloudflare cron not checked | a Mesh `schedule` must degrade to a Mesh-owned timer on Restate |

## 5. Mesh seams the interface must preserve

From [`00-synthesis.md`](./synthesis.md): **(a)** "Step identity by content hash → Stable, declared step names;
persisted sagas break on redeploy"; **(b)** "events committed in the same transaction as state";
**(c)** "Explicit context value on every call" (actor and tenant are never ambient); **(d)** "Silent
fallbacks → hard errors"; and from `decisions-2026-10-04.md` row 4, adapters declare capabilities
and using one an adapter lacks is a build-time error. Row 8 adds **(e)**: a workflow may be started
from a CLI with no HTTP request.

## 6. Proposed adapter interface (proposal, not agreed)

### 6.1 Design decisions

1. **Two contracts, not one.** `JobQueueAdapter` (fire-and-forget background action) and
   `WorkflowAdapter` (multi-step durable function). A durable engine implements both (a job is a
   one-step workflow); pg-boss and Graphile implement only the first.
2. **Steps are generated, top-level, named functions.** A step is not a closure written inside
   the workflow body. Temporal activities, for example, are functions registered on the Worker
   and called by name from a sandboxed workflow (a closure created inside the workflow cannot be
   shipped to an activity worker; run inline it would execute inside the deterministic sandbox,
   without I/O). So the generator emits each declared step as a named function with an explicit,
   serialisable input, and the workflow body calls `ctx.step("reserve-stock", input)`. This also
   fits the architecture decision that "generated code carries the behaviour; the shared engine
   stays thin" (`decisions-2026-10-04.md`, row 2). For a loop, a **step family** is declared
   (`charge[]`): its instances are named `charge[<key>]` where the key is a pure function of the
   workflow input and earlier recorded step results (an index, a record id). The verifier knows
   families, so the declared list stays finite while loops stay possible. What the verifier
   checks: a key expression may only read the workflow input and recorded step results, and may
   call no non-deterministic source; it does not attempt general data-flow analysis of the `run`
   body. On engines that match a step by activity type or registered function (Temporal), the
   **family name** is the registered step and the key travels in the step input (6.5).
3. **Capabilities are static data read at build time.** Ruling 4 requires a build-time error, so
   each adapter publishes a manifest of plain data (the `capabilities` object below) that the
   build's Verify stage (stage 5, [`00-synthesis.md`](./synthesis.md) section 16) reads without starting the
   adapter. A definition that uses `waitForSignal` against an adapter with `signals: false`
   fails the build. `register()` repeats the check at boot only as a backstop.
4. **Mesh owns an outbox, and the outbox is at-least-once.** The data layer writes a `mesh_outbox`
   row in the action's transaction (run-time phases 5–7, [`00-synthesis.md`](./synthesis.md) section 17). A row has
   a `kind` (`start`, `signal`, `cancel`, or a job), the target, the payload, and a dedupe key
   equal to the row id. A relay delivers rows after commit and retries until the engine
   acknowledges. Because delivery is at least once, a workflow starts exactly once **only while the
   relay lag is shorter than the engine's dedupe memory** (`dedupeWindow` in the manifest). The
   relay must refuse loudly (seam d) to deliver a row older than that window and raise an
   operator error instead of risking a second run. Per-engine consequence: Temporal's default
   reuse policy lets a closed run's id start again and its default conflict policy errors instead
   of returning the open run, so the Temporal adapter must set reuse policy `REJECT_DUPLICATE`
   and conflict policy `USE_EXISTING`, and its window is the namespace's closed-run retention;
   Inngest and Restate windows are 24 hours. Signals have no engine-level dedupe on most engines,
   so a signal row carries its id and the generated workflow code ignores a signal id it has already
   consumed.
5. **Steps are at-least-once; effects on the app database need an idempotency shim.** Every engine
   can run a step twice (the step commits, the process dies before the checkpoint is recorded, the
   step re-runs). So seam (b) does not hold for a step that writes to the app database unless
   Mesh adds a rule: **R3.** Each call a step makes to a Mesh action passes an **effect key** that
   is unique *per call*, `${runId}:${stepName}:${callIndex}` (`StepScope.effectKey(callIndex)`), so
   two actions inside one step do not share a key. The action inserts that key into a
   `mesh_step_effects` table with a **unique constraint on the key**, as the first statement of its
   own transaction, and commits its writes, its events and the stored result in that same
   transaction. A repeat finds the row and returns the stored result. The unique constraint matters
   because two attempts of one step can run at the same time (on Temporal, Inngest and Restate a
   timed-out attempt is not stopped when the retry starts): the losing transaction fails on the
   conflict, rolls back, and then returns the stored result, so the effect applies once. Rows must
   be kept longer than the longest retry span plus the replay horizon of the engine (otherwise a
   late retry finds no row and re-applies the effect); the retention is a per-adapter setting
   with a safe default of the engine's maximum run retention. The `stepName` in an effect key is always the **instance** name: `reserve-stock` for a plain
   step and `charge[3]` for a family instance, never the family name alone. If the key used the
   family name, every instance would share one key and R3 would return the first instance's stored
   result for all the others, silently skipping the effect. The generator assigns `callIndex`
   **per call site** (a static index in the generated code); a call inside a loop uses
   `${index}:${loopKey}` where the loop key is deterministic, so the key does not depend on a
   run-time counter (which would be unstable under `Promise.all` or data-dependent loops). If a
   reset re-runs steps under the same run id, R3 returns the old recorded results, which is the
   intended behaviour (history is replayed, not re-applied). DBOS `rewindWorkflow` keeps the run id
   and behaves that way; DBOS `forkWorkflow(workflowID, startStep, { newWorkflowID })` starts a
   **new** execution with a new id, so its R3 keys differ and steps from `startStep` onward re-apply
   their effects, while earlier steps are copied
   ([client reference](https://docs.dbos.dev/typescript/reference/client.md)). Mesh maps fork to
   "new run id" and rewind to "same run id". This is the idempotency-table pattern Restate
   documents ([databases guide](https://docs.restate.dev/guides/databases.md)), made safe against
   concurrent attempts. It gives exactly-once *effect* without `stepInTransaction`. Where the adapter declares `stepInTransaction` (the
   in-process runner, DBOS) the step's writes and its checkpoint commit together and the shim is
   unnecessary.
6. **The same rules cover jobs.** A job enqueued from an action goes through the outbox like a
   workflow start, unless the job adapter declares `enqueueInTransaction` (pg-boss, Graphile
   Worker), in which case the enqueue joins the action's transaction. Job dedupe memory differs:
   BullMQ `deduplication` has a ttl, and a Graphile `job_key` disappears once the job is deleted,
   so the same lag bound applies. `completeInTransaction` (pg-boss transactional worker) lets a job
   handler's writes commit with the job's completion.
7. **No transport in the contract.** `start()` takes a plain value and returns a handle; whether
   the engine is reached over gRPC, Postgres or memory is internal. A CLI can call `start`,
   `attach`, `signal` and `cancel` directly; an HTTP server appears in no signature. An adapter
   whose *worker* needs an inbound HTTP endpoint declares `runsWithoutHttp: false`.
8. **Context is explicit** (seam c): `StartOptions.context` is persisted with the run and passed to
   every step through `StepScope.context`.
9. **A run id is the dedupe key.** `RunHandle.runId` equals `StartOptions.dedupeKey` for every
   adapter. The adapter maps it to the engine's own id (Temporal workflow id, DBOS workflow id,
   Restate key) or resolves it lazily (Inngest, whose `send()` returns *event* ids). A **child**
   run started by `invoke` gets the deterministic id `${parentRunId}:${invokeName}` (inside a
   family, `${parentRunId}:${invokeName}[<key>]`), mapped to the engine's child id (Temporal
   `executeChild` workflow id, DBOS `startWorkflow` workflow id, Restate workflow key), so a
   replayed parent re-attaches to the same child instead of starting a new one, and the child's own
   effect keys stay stable.

### 6.2 Type sketch

```ts
/** Opaque to Mesh core; the adapter and the data-layer adapter agree on it. */
type Tx = unknown;

type Duration = number | `${number}${"ms" | "s" | "m" | "h" | "d"}`;

interface RetryPolicy {
  maxAttempts: number;                 // >= 1
  initialInterval?: Duration;
  backoffFactor?: number;
  maxInterval?: Duration;
  nonRetryable?: readonly string[];    // error class names
}

interface MeshContext {                // seam (c): never ambient
  actor: unknown;
  tenant?: unknown;
  [extra: string]: unknown;
}

/** Static data. Published by the adapter package; read by the build's Verify stage. */
interface WorkflowCapabilities {
  startInTransaction: boolean;         // start can join the caller's DB tx (see 6.5 DBOS conditions)
  signalInTransaction: boolean;        // signal can join the caller's DB tx
  stepInTransaction: boolean;          // a step's app writes commit atomically with its checkpoint
  signals: boolean;
  childWorkflows: boolean;
  schedules: boolean;                  // native cron
  durableSleep: boolean;
  cancel: "running" | "pending-only" | "none"; // "running" may take effect between steps
  dedupeWindow: Duration | "namespace-retention" | "forever"; // bound for outbox relay lag
  runsWithoutHttp: boolean;            // worker AND client need no inbound HTTP endpoint
  runtimes: readonly ("node" | "bun")[]; // verified runtimes only
  requires: readonly ("postgres" | "server" | "saas" | "http-endpoint")[];
}

interface StepScope {
  readonly runId: string;
  /** The INSTANCE name: `reserve-stock`, or `charge[3]` for a family instance. Adapters rebuild it
   *  as `family[key]`; they never use the family name (or an engine activity type) alone. */
  readonly stepName: string;
  /** Per-call key for rule R3: `${runId}:${stepName}:${callIndex}`, where `stepName` is the instance
   *  name and `callIndex` is a static per-call-site index assigned by the generator. */
  effectKey(callIndex: number | string): string; // static call-site index, or `${index}:${loopKey}` in a loop
  /** Present only inside `stepInTransaction`: the transaction that commits with the checkpoint. */
  readonly tx?: Tx;
  readonly attempt: number;
  readonly context: MeshContext;
  readonly signal: AbortSignal;
}

/** A generated, top-level, registered step. Input and output are JSON-serialisable. */
type StepFn<In, Out> = (input: In, scope: StepScope) => Promise<Out>;

/** What Mesh generates from the resource file. */
interface WorkflowDefinition<I, O> {
  name: string;                        // stable, unique; part of the persisted identity
  version: string;                     // see 6.6
  steps: Record<string, StepFn<any, any>>;       // declared step functions, by name
  stepFamilies?: Record<string, StepFn<any, any>>; // `name[<key>]` instances
  run(ctx: WorkflowContext, input: I): Promise<O>; // deterministic body; no I/O
}

interface WorkflowContext {
  readonly runId: string;
  readonly context: MeshContext;

  /** Run a declared step once; its result is recorded. `name` MUST be in `steps`, or `family[key]`. */
  step<T>(name: string, input: unknown, opts?: { retry?: RetryPolicy; timeout?: Duration }): Promise<T>;

  /** Same, but the step's app-DB writes commit atomically with its checkpoint. Needs stepInTransaction.
   *  The adapter opens the transaction and hands it to the step as `scope.tx`; the step must use
   *  it for every app-DB write. Without the capability this is a build error. */
  stepInTransaction<T>(name: string, input: unknown, opts?: { retry?: RetryPolicy }): Promise<T>;

  sleep(name: string, d: Duration): Promise<void>;
  sleepUntil(name: string, at: Date): Promise<void>;

  /** Needs signals. Resolves with the payload, or `undefined` when `timeout` elapses.
   *  `timeout` is REQUIRED; "no timeout" must be written as an explicit very large value, because
   *  some engines (DBOS `recv`) would otherwise apply a default and return null silently. */
  waitForSignal<T>(name: string, opts: { timeout: Duration }): Promise<T | undefined>;

  /** Needs childWorkflows. */
  invoke<I2, O2>(name: string, child: WorkflowRef<I2, O2>, input: I2): Promise<O2>;

  /** Deterministic replacements for non-deterministic sources. */
  now(): Date;
  random(): number;
  uuid(): string;
}

interface WorkflowRef<I, O> { readonly name: string; readonly __io?: [I, O] }

interface StartOptions {
  dedupeKey: string;                   // REQUIRED. The outbox row id. Becomes the run id.
  context: MeshContext;
  /** Only honoured when startInTransaction. Then `dedupeKey` MUST be fresh (an outbox row id):
   *  the adapter need not return an existing run for a duplicate and may throw. The handle is
   *  usable only after the caller commits. */
  tx?: Tx;
  delay?: Duration;
}

type RunStatus =
  | { state: "pending" | "running" | "sleeping" | "waiting" }
  | { state: "succeeded" }
  | { state: "failed"; error: { name: string; message: string } }
  | { state: "cancelled" };

interface RunHandle<O> {
  readonly runId: string;              // === dedupeKey
  status(): Promise<RunStatus>;
  result(opts?: { timeout?: Duration }): Promise<O>;   // rejects on failed/cancelled
  /** `tx` honoured only when signalInTransaction. `signalId` lets the receiver ignore repeats. */
  signal<T>(name: string, payload: T, opts: { signalId: string; tx?: Tx }): Promise<void>;
  cancel(reason?: string): Promise<void>;
}

interface WorkflowAdapter {
  readonly id: string;                 // "in-process", "dbos", "temporal", ...
  readonly capabilities: WorkflowCapabilities;   // MUST equal the build-time manifest

  /** Boot-time backstop: rejects if a definition needs a missing capability. */
  register(defs: readonly WorkflowDefinition<any, any>[]): Promise<void>;

  /** Idempotent on `dedupeKey` within `dedupeWindow` when no `tx` is passed. */
  start<I, O>(wf: WorkflowRef<I, O>, input: I, opts: StartOptions): Promise<RunHandle<O>>;

  attach<O>(runId: string): RunHandle<O>;

  /** Process runs in this process until `stop()`. A CLI calls this for `mesh worker`. */
  work(): Promise<void>;
  stop(): Promise<void>;
}

interface JobQueueAdapter {
  readonly id: string;
  readonly capabilities: {
    enqueueInTransaction: boolean;     // pg-boss, Graphile Worker
    completeInTransaction: boolean;    // pg-boss transactional worker
    delay: boolean; cron: boolean; dedupe: boolean;
    dedupeWindow: Duration | "until-completion" | "forever";
  };
  enqueue<P>(job: string, payload: P, opts: { dedupeKey: string; context: MeshContext; tx?: Tx; delay?: Duration; retry?: RetryPolicy }): Promise<{ jobId: string }>;
  work(handlers: Record<string, (payload: any, ctx: { context: MeshContext; signal: AbortSignal; tx?: Tx }) => Promise<void>>): Promise<void>;
  stop(): Promise<void>;
}
```

### 6.3 Rules the adapter contract imposes on generated code

1. Step names are declared in the definition (`steps`, or a declared family with a key that is a
   pure function of recorded results); the verifier fails the build on a duplicate name, an
   undeclared name or a family key that reads anything but the input and recorded results (seam a,
   stage 5 "Verify"). The uniqueness rule also covers `invoke`, `sleep` and `waitForSignal` names
   (child ids derive from `invokeName`, and sleep and wait names are step ids on Inngest): two
   `invoke("x", ...)` calls would map to one child id, which fails on Temporal while the first child
   is open and returns the first child's result on DBOS. Inside a family the rule applies per key.
2. Code in `run` outside `ctx.step` may only call `ctx.now/random/uuid`, `sleep`, `waitForSignal`,
   `invoke`, and pure functions of recorded results. This is the strictest replay rule
   (Temporal's), applied everywhere, so a workflow valid in-process is valid on every replay engine.
3. Step inputs and outputs are JSON-serialisable (DBOS requires it; the others serialise too).
   A step cannot close over `ctx`; whatever it needs arrives in its input and `StepScope`.
4. Steps are at-least-once. Effects outside the app database need an idempotency key derived from
   `scope.effectKey(callIndex)`; effects *inside* the app database follow rule R3 (6.1.5).
5. Every `signal`, `cancel` or `start` issued from inside an action goes through the outbox (6.1.4)
   unless the adapter declares the matching `...InTransaction` capability.

### 6.4 The in-process runner implements everything

The first adapter keeps a journal (`mesh_runs`, `mesh_steps(run_id, step_name, result, attempt)`,
`mesh_step_effects`, `mesh_outbox`) in the app's own database (SQLite, Postgres, or memory for
tests). Because it shares the transaction with the data layer, `startInTransaction`,
`signalInTransaction` and `stepInTransaction` are all **true**; `signals`, `childWorkflows`,
`durableSleep` and `schedules` use a polling loop; `dedupeWindow` is `"forever"`;
`runsWithoutHttp` is true; `requires` is empty. It replays the `run` body and returns recorded
results by step name. **Cancel** is `"running"`: `cancel()` writes a persisted cancel flag on the
run row, and the worker polls it and fires the step's `AbortSignal`. A bare `AbortSignal` could not
work when the CLI that cancels and the process running `work()` are different processes. This is a
design claim; no code exists yet.

### 6.5 Mapping tables

Legend: **native** = maps directly; **shim** = Mesh or the adapter builds it; **cannot** = the
engine cannot honour it and the capability is declared false.

**Temporal**

| Mesh operation | Temporal |
|---|---|
| `register` | `Worker.create({ workflowsPath, activities, taskQueue })`; the generator emits the declared `steps` as the registered `activities` and a workflow wrapper whose `ctx.step(name, input)` is <code>proxyActivities&lt;...&gt;()[name&#93;&#40;input)</code>, where `name` is the declared step name, or for a step family the **family name** (`charge`) with the instance key passed in the input (consistent with the `step` row) (native, because steps are top-level functions, 6.1.2) |
| `step(name, input)` | an activity whose type is the declared step name; Temporal matches by position **and** checks the activity type, so a rename breaks in-flight runs (6.6). For a **step family** the activity type is the family name (`charge`) and the instance key travels in the input and the activity id, because `charge[3]` is not a registered activity type; the adapter rebuilds the instance name `charge[<key>]` from that key (not from the activity type) when it builds `StepScope.stepName`, so effect keys stay per instance |
| `stepInTransaction`, `signalInTransaction`, `startInTransaction` | **cannot** (no atomic commit with the app DB); use rule R3 and the outbox |
| `sleep` | `sleep()` (native) |
| `waitForSignal` | `defineSignal` + `condition(fn, timeout)` (native) |
| `invoke` | `executeChild` with `workflowId = ${parentRunId}:${invokeName}` (native) |
| `start` with `dedupeKey` | `workflowId = dedupeKey` with reuse policy `REJECT_DUPLICATE` and conflict policy `USE_EXISTING` (**native with non-default policies**; with defaults a closed run's id can start again). `dedupeWindow: "namespace-retention"`: Reject Duplicate checks only closed runs still retained |
| `cancel` | `handle.cancel()` (native) |
| `schedules` | `client.schedule.create` (native) |
| Constraints | Node workers only (Bun discouraged); server required; `version` maps to Worker Versioning (Build IDs); `patched()` needs both code branches kept by hand |

**Inngest**

| Mesh operation | Inngest |
|---|---|
| `register` | `createFunction({ id: def.name })` per definition; each declared step function is called from `step.run(name, ...)` inside the generated handler; plus `serve()` or `connect()` |
| `step(name, input)` | `step.run(name, () => fn(input, scope))` where `fn` is `steps[name]`, or `stepFamilies[family]` for an instance `family[key]` (native, name-keyed; a rename silently re-runs the step) |
| `stepInTransaction`, `signalInTransaction`, `startInTransaction` | **cannot**; use R3 and the outbox |
| `sleep` | `step.sleep(name, d)` (native) |
| `waitForSignal` | **shim**. Inngest does not buffer signals: the signal API answers 404 "No signal found" when no run is waiting ([signals.go](https://raw.githubusercontent.com/inngest/inngest/main/pkg/api/apiv1/signals.go)); the signal string is global, not per run; and by default duplicate signals fail the function (`onConflict`) ([reference](https://www.inngest.com/docs/reference/typescript/v4/functions/step-wait-for-signal)). Mesh signals are buffered (Temporal, DBOS and Restate buffer), so the adapter composes the signal string as `${runId}:${name}`, and on a 404 the relay checks `GET /v1/runs/{runID}`: while the run is live it treats the 404 as "not yet waiting, retry later" (the row stays undelivered without tripping the stale-row refusal, 8.4); if the run is terminal (finished, failed or cancelled) the relay **dead-letters** the row with an operator error (seam d), so a signal for a run that will never wait cannot retry forever or block later signals to the same run. Alternative: `step.waitForEvent` with an `if` match on the run id; no evidence found that it matches events sent before the wait starts, so it does not avoid the problem and needs the same terminal-run rule |
| `invoke` | `step.invoke` (native); `step.invoke` does not let the caller set the child's Inngest run id, so the adapter puts the deterministic Mesh child id `${parentRunId}:${invokeName}` into the invoke payload and the generated child handler uses it as its `runId` (which its `StepScope` and effect keys depend on) |
| `start` with `dedupeKey` | **shim**: event `id = dedupeKey`, which dedupes for **24 h only** (`dedupeWindow: "24h"`); `send()` returns event ids, so the adapter resolves the run through `GET /v1/events/{id}/runs` and caches the mapping |
| `attach` / `status` / `result` | **shim**: `GET /v1/runs/{runID}` (or the events endpoint); SDK await helper **UNVERIFIED** |
| `cancel` | `DELETE /v1/runs/{runID}` or `cancelOn`: declare `cancel: "running"` (queued and sleeping runs do not continue; active runs stop between steps) |
| `runsWithoutHttp` | only with `connect()` (WebSocket; on Inngest Cloud 3 or 20 connections by plan) |
| Constraints | server is SSPL; SDK is Apache-2.0; replay reruns the body, so rule 6.3.2 is mandatory |

**Restate**

| Mesh operation | Restate |
|---|---|
| `register` | a `restate.workflow({ name, handlers: { run } })` per definition, served over HTTP; `ctx.step(name, input)` is `ctx.run(name, () => fn(input, scope))` with `fn` resolved from `steps[name]`, or `stepFamilies[family]` for an instance `family[key]`; the run handler first stores `ctx.request().id` in workflow state (see `waitForSignal`) |
| `step(name, input)` | `ctx.run(name, fn, retryPolicy)` (native; journal position **and** recorded name are compared, so a rename is a journal mismatch) |
| `stepInTransaction`, `signalInTransaction`, `startInTransaction` | **cannot** natively; the idempotency-table pattern is exactly rule R3, which is not atomic with the journal |
| `sleep` | `ctx.sleep` (native) |
| `waitForSignal` | **shim**. A Restate signal is identified by the target invocation id and a name and is resolved from inside another handler (`ctx.invocation(id).signal(...).resolve(...)`, [external events](https://docs.restate.dev/develop/ts/external-events.md)); Mesh addresses runs by workflow key and sends signals from the outbox relay, which runs outside Restate; an awakeable's generated id would have to be published first. So the generator adds a shared handler `signal(name, payload)` to every workflow; the relay calls it through the workflow client with the workflow key and the handler resolves the run's signal. To address the run handler's invocation, the `run` handler stores `ctx.request().id` in workflow state as its first action and the shared handler reads it; a signal that arrives before that id is stored fails with a retryable error and the relay retries. A workflow promise resolves only once, so repeated signals use signals, not promises |
| `invoke` | `ctx.workflowClient(...)` call with workflow key `${parentRunId}:${invokeName}` (native) |
| `start` with `dedupeKey` | `idempotencyKey` or the workflow key (native, 24 h default retention) |
| `cancel` | admin API `PATCH :9070/invocations/{id}/cancel` (the client library has none); the adapter calls the admin API |
| `schedules` | **cannot** (no native cron); Mesh runs its own timer and calls `start` |
| Constraints | server plus HTTP endpoint always. The **worker** (`work()`) needs an inbound HTTP endpoint (`runsWithoutHttp: false`); a CLI that only calls `start`, `signal` or `cancel` makes outbound HTTP calls to Restate's ingress and admin API, which ruling 8 (Mesh's own transport) does not forbid. Server is BSL 1.1 |

**DBOS**

| Mesh operation | DBOS |
|---|---|
| `register` | `DBOS.registerWorkflow(fn)` per definition; declared steps become `DBOS.registerStep`; `DBOS.launch()` |
| `step(name, input)` | `DBOS.runStep(() => fn(input, scope), { name, retriesAllowed, maxAttempts })` with `fn` resolved from `steps[name]` or `stepFamilies[family]` (native; order **and** recorded name checked via `DBOSUnexpectedStepError`) |
| `stepInTransaction` | a DBOS transaction step on the Drizzle/Kysely/Knex/Prisma/pg data source (**native**, atomic with the checkpoint). Needs Mesh's data-layer transaction to be that data source (open question 8.1) |
| `sleep` | `DBOS.sleep(ms)` (native) |
| `waitForSignal` | `DBOS.recv(topic, timeoutSeconds)`; the adapter **always** passes an explicit timeout, converts `Duration` to seconds, and uses a very large value for "no timeout", because the default of 60 s returns `null` |
| `invoke` | `startWorkflow` inside a workflow with `workflowID = ${parentRunId}:${invokeName}`, awaiting the child handle (**native**) |
| `start` with `dedupeKey` | `workflowID = dedupeKey` (native); on a duplicate the default returns the existing run |
| `startInTransaction` | `client.enqueueInTransaction(pgClient, ...)`, **with conditions**: the client must be connected to the DBOS *system* database (app tables must live there for atomicity); `'return-existing'` is unsupported and the default `'reject'` throws `DBOSQueueDuplicatedError`, aborting the caller's transaction. So the `start` contract's "a second call returns the same run" does not hold with `tx`; the contract (6.2) therefore requires a fresh `dedupeKey` when `tx` is passed, which an outbox row id always is. The workflow is not enqueued until the caller commits |
| `signalInTransaction` | `client.sendInTransaction(pgClient, workflowId, message, topic, idempotencyKey)` (native, same system-database condition) |
| `cancel` | `cancelWorkflow(id, { cancelChildren })` (native) |
| `schedules` | `DBOS.createSchedule` (native) |
| Constraints | Postgres only (no SQLite adapter); Bun worker support **UNVERIFIED**; `version` maps to `applicationVersion` (default a hash of workflow source) or `DBOS.patch` |

**Operations each engine cannot honour** (capability declared false; using it is a build error):

| Engine | Cannot honour |
|---|---|
| Temporal | `stepInTransaction`, `signalInTransaction`, `startInTransaction`; dedupe beyond namespace retention; Bun worker |
| Inngest | `stepInTransaction`, `signalInTransaction`, `startInTransaction`; dedupe beyond 24 h; `runsWithoutHttp` unless `connect()` |
| Restate | `stepInTransaction`, `signalInTransaction`, `startInTransaction`, `schedules`; `runsWithoutHttp` for the worker |
| DBOS | non-Postgres databases; `startInTransaction` for a duplicate key; the transactional capabilities when app tables are outside the DBOS system database |

### 6.6 Versioning running workflows

Replay engines break when a persisted run meets changed code. A hash of the declared step names is
a **necessary** check, not a sufficient one: replay safety depends on the body being deterministic
*given recorded results* ("the same steps with the same inputs in the same order (given the same
return values)",
[DBOS workflow tutorial](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial.md)), so a
changed branch condition alters the run-time order without touching the declared list. Because
Mesh commits its generated code, the guard (stage 8, [`00-synthesis.md`](./synthesis.md) section 16) can hash the
generated `run` body as well as the step names and the step-function inputs, and fail CI when that
hash changes for a released workflow without a migration entry. Renaming a step is breaking on
Temporal, Restate and DBOS (name checked) and silently re-runs the step on Inngest. Adapters map the
policy: Temporal Worker Versioning (Build IDs) or hand-written `patched()` branches, DBOS
`applicationVersion` or `DBOS.patch`, Restate, Trigger.dev and Hatchet drain old deployments,
Inngest adds a new function id. Whether Mesh should automate any of this is a decision for the
operator.

## 7. Fit assessment

| Engine | Adapter fit | Reason |
|---|---|---|
| In-process | first adapter | implements every operation, no infrastructure |
| DBOS | **best external fit** | Postgres only, library, native transactions for steps, starts and signals, no HTTP; unknowns are Bun worker support (**must be tested before DBOS is chosen as the first external adapter**), the shared-transaction integration, and the system-database condition |
| pg-boss | `JobQueueAdapter` | native enqueue and completion in a transaction, Bun documented |
| Temporal | good second adapter | mature, strict model matches the contract (generated steps become registered activities); needs a server, Node workers, non-default dedupe policies |
| Inngest | possible | name-keyed identity fits; run-id shim, 24 h dedupe, HTTP or `connect()`, SSPL server are costs |
| Restate | possible but awkward | worker needs an HTTP endpoint, no cron, BSL server, 19 contributors |
| Graphile Worker | `JobQueueAdapter` | 0.x, Node-only, but SQL-level enqueue is the cleanest transactional job primitive |
| BullMQ | `JobQueueAdapter` for Redis shops | no same-transaction enqueue |
| Hatchet | poor | task-name model, no transactions, engine process to run |
| Trigger.dev | poor | no step primitive; checkpointing is Cloud only; a Mesh step would have to become a child task |
| Vercel, Cloudflare | excluded | bound to their platforms |

## 8. Open questions

1. Can Mesh's data-layer transaction be exposed as a DBOS data source, and can Mesh's app tables
   live in (or share a connection with) the DBOS system database? Without both, DBOS cannot give
   `stepInTransaction`, `startInTransaction` or `signalInTransaction` atomically, and DBOS
   degrades to the outbox plus rule R3 like the other engines. Not tested.
2. Are step families (6.1.2) enough for dynamic control flow, or does the resource-file syntax need
   first-class `for-each` and `parallel` steps? Not decided; MX tag design is out of scope here.
3. Should the outbox relay be core or an extension? The synthesis puts "events committed in the
   same transaction as state" in core; this document keeps it there.
4. What should the relay do when a row is older than the adapter's `dedupeWindow`: stop and alert,
   or start anyway after a human check? This document proposes "stop and alert" (seam d).
5. Still **UNVERIFIED** (none changes the interface; DBOS worker Bun support changes only the
   adapter order): Inngest's TypeScript run-handle helper and the source of its GPL-3.0
   detection (Restate's client-library cancel is closed: there is none); DBOS worker-side Bun and
   Deno support, which must be tested before DBOS is picked as the first external adapter;
   the Trigger.dev idempotency-key TTL; that Temporal
   has no outbox-style feature (an absence, not a claim needing a source);
   Hatchet's durable-wait keying and Bun worker support; BullMQ ioredis on Bun and enqueue in a
   caller's transaction on its Postgres backend; Graphile timeouts and Bun; Vercel GA status,
   run-level dedupe and cron; Cloudflare in-flight versioning and duplicate-id behaviour;
   Temporal Cloud terms.

## 9. Not changed

No other research document was edited. [`07-ts-foundation-candidates.md`](./ts-foundation-candidates.md) lists Inngest SDK 4.21.0,
Trigger.dev 4.7.0, Hatchet SDK 1.33.2 and pg-boss 12.35.1; the engines have since released
4.21.1, 4.7.2, 1.34.0 and 12.36.0 (one to three weeks later). Its open item on the Inngest
licence (line ~1413) can now be closed: the SDK is Apache-2.0. That document is left as it is.

## 10. Review corrections (round 1)

The independent review ([`notes/team-lead/reviews/08-durable-engines-review.md`](./reviews/durable-engines-review.md)) found 30 issues;
all were applied. I re-fetched the sources for the Temporal retry cap, the Temporal reuse and
conflict policies, the DBOS enqueue conditions and `recv` default, the Inngest run endpoints, the
Graphile npm release history, the Trigger.dev SDK licence and the pg-boss transactional worker; each
matched the reviewer. No finding was rejected. One nuance: the Temporal retry-policy page states
both "max interval of 10 minutes" (intro) and "100 seconds" (default section); the document uses
the specific default (100 s = 100 × the 1 s initial interval) and says the 10 minutes belongs to
Workflow Task retries, as the reviewer reads it.

- **H1** outbox is at-least-once; dedupe is bounded by `dedupeWindow`; relay refuses old rows;
  Temporal needs `REJECT_DUPLICATE` + `USE_EXISTING` (6.1.4, 6.5).
- **H2** rule R3 and `mesh_step_effects` for app-DB writes in steps; signals and cancels go through
  the outbox; DBOS `sendInTransaction` added; seam (b) claim rewritten (1.3, 6.1.4–6.1.5, 6.3.4–6.3.5).
- **H3** DBOS enqueue-in-transaction conditions; `start` contract requires a fresh key with `tx`
  (2.4, 6.2, 6.5, 8.1).
- **H4** steps are generated top-level registered functions; Temporal mapping fixed (6.1.2, 6.2, 6.5).
- **M1** "order-keyed, name checked" for Temporal, Restate, DBOS; UNVERIFIED items closed. **M2**
  Temporal retry cap is 100 s. **M3** Inngest cancel is `"running"`, status via `GET /v1/runs`.
  **M4** Inngest start/attach is a shim; `runId` is the dedupe key. **M5** step families resolve
  the naming contradiction. **M6** hash is necessary, not sufficient; guard hashes the `run` body.
  **M7** pg-boss transactional worker and `completeInTransaction` added. **M8** DBOS `recv`
  timeout is explicit and in seconds; `waitForSignal` requires `timeout`. **M9** Graphile release
  cadence corrected. **M10** capabilities are build-time static data. **M11** job capability
  names and outbox rule for jobs. **M12** glosses added for CRIU, BSL, SSPL, BYOC, SKIP LOCKED,
  CEL, RRULE, Conductor, Standard Schema, Build IDs; maintenance numbers linked; `anon=1` explained.
- **L1–L14** quote fixed (L1), Bun claim qualified (L2), Inngest #1624 reworded (L3), Trigger.dev
  licence split resolved (L4), DBOS children closed (L5), Inngest GPL left UNVERIFIED with the
  stale-metadata observation (L6), cron claim narrowed (L7), Inngest `connect()` limits scoped to
  Cloud (L8), Restate HTTP cost restated (L9), Temporal `patched()` vs Build IDs (L10),
  `StepScope.context` added (L11), persisted cancel flag (L12), persistence link and versions
  corrected (L13), DBOS #1126 titled (L14).

## 11. Review corrections (round 2)

The round-2 review ([`notes/team-lead/reviews/08-durable-engines-review.md`](./reviews/durable-engines-review.md), "## Round 2") confirmed
the 30 round-1 fixes and raised 10 findings on the revised design. All were applied. I re-fetched
the Restate clients package (no `cancel`) and the Inngest signals handler (404 "No signal found");
both matched.

- **N1** R3 key is per call (`effectKey(callIndex)`), the effects table has a unique key inserted
  first in the action's transaction (so concurrent attempts cannot both apply), rows have a stated
  retention rule, and reset/fork behaviour is stated (6.1.5, 6.2).
- **N2** Inngest `waitForSignal` is a shim (404 on early signals, global names, duplicate failure);
  relay retries on 404 without tripping the stale-row refusal (6.5).
- **N3** Restate `waitForSignal` is a shim with a generated shared `signal` handler per workflow (6.5).
- **N4** Temporal step families register the family name as the activity type, key in the input;
  the verifier's family-key check is stated precisely (6.1.2, 6.5).
- **N5** Child runs get the deterministic id `${parentRunId}:${invokeName}` on every engine
  (6.1.9, 6.5).
- **N6** `StepScope.tx` defined for `stepInTransaction` (6.2). **N7** section 4.2 transactions row
  refreshed. **N8** garbled sentence in 2.1 fixed. **N9** the two missing UNVERIFIED items added to
  8.5. **N10** Restate client cancel closed: admin API or CLI only (2.3, 6.5).
- Added the reviewer's note that DBOS worker Bun support must be tested before DBOS is picked as
  the first external adapter (section 7, 8.5).

## 12. Review corrections (round 3)

The round-3 review (same file, "## Round 3") confirmed the 10 round-2 fixes and raised 7 findings.
All were applied as written; the DBOS `forkWorkflow` signature (P7) is taken from the reviewer's
fetch of the DBOS client reference and was not re-fetched by me.

- **P1** (medium) effect keys use the instance name (`charge[3]`); `StepScope.stepName` added;
  Temporal rebuilds the instance name from the key in the input; Inngest, Restate and DBOS look
  up `stepFamilies` as well as `steps` (6.1.5, 6.2, 6.5).
- **P2** Inngest signal relay checks `GET /v1/runs/{runID}` on a 404 and dead-letters the row when
  the run is terminal; the `waitForEvent` alternative needs the same rule (6.5).
- **P3** Restate: the `run` handler stores its invocation id in workflow state first; an early
  signal fails retryably (6.5).
- **P4** Inngest child: the adapter passes the Mesh child id in the invoke payload (6.5).
- **P5** `callIndex` is a static per-call-site index from the generator (6.1.5).
- **P6** verifier uniqueness covers `invoke`, `sleep` and `waitForSignal` names (6.3.1).
- **P7** DBOS `forkWorkflow` starts a new execution with a new id (effects re-apply from
  `startStep`); `rewindWorkflow` keeps the id; the UNVERIFIED item is closed (6.1.5, 8.5).
- **Nits** (final acceptance): the Temporal `register` row now says the proxied activity is the family name with the instance key in the input; `effectKey` takes `number | string` to match the `${index}:${loopKey}` form.

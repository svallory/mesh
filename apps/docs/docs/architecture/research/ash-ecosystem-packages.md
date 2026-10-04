---
title: "The Ash ecosystem packages"
description: "The Ash ecosystem packages that matter for domain work, with versions and evidence."
---

# 04 — The Ash ecosystem: the packages that matter for domain work

> Independent fact-check: [review of this document](./reviews/ash-ecosystem-packages-review.md).

Ref: `ash-ecosystem`. Written 2026-10-01.

Versions examined (from each clone's `mix.exs` `@version`, which matched the hex.pm latest release
in every case): `ash` 3.33.11, `ash_postgres` 2.13.1, `ash_sql` 0.7.6, `ash_sqlite` 0.2.19,
`ash_phoenix` 2.3.25, `ash_json_api` 1.7.1, `ash_graphql` 1.12.0, `ash_typescript` 0.18.4,
`ash_authentication` 5.0.0-rc.14, `ash_state_machine` 0.2.13, `ash_paper_trail` 0.7.0,
`ash_archival` 2.0.3, `ash_events` 0.8.2, `ash_commanded` 0.2.0, `reactor` 1.0.7, `ash_oban` 0.9.0,
`ash_money` 0.2.6, `ash_double_entry` 1.0.19, `ash_cloak` 0.4.0, `ash_admin` 1.3.2, `ash_ai` 1.1.1,
`usage_rules` 1.2.8, `ash_rate_limiter` 2.0.1, `ash_csv` 0.9.9, `ash_slug` 0.2.1, `smokestack` 0.9.2,
`igniter` 0.8.4, `spark` 2.7.3, `splode` 0.3.2.

Note on `ash_authentication`: the latest hex release is a **release candidate** (`5.0.0-rc.14`,
2026-09-17). Anything you read about AshAuthentication 4.x is not what the current line looks like.

A note on terminology for a reader who does not know Elixir: a **macro** is compile-time code
generation; a **behaviour** is Elixir's version of an interface (a module of `@callback`s);
a **changeset** is the struct that carries a pending change through an action; a **GenServer** is a
process that owns state and answers messages.

## Summary

- Ash's official package count is large but the *domain-work* cluster is small: `reactor`
  (sagas/workflows), `ash_paper_trail` + `ash_events` (audit/history), `ash_ai` + `usage_rules`
  (LLM agents). Everything else is transport (phoenix/json_api/graphql/typescript), storage
  (postgres/sqlite/csv), or narrow domain types (money).
- **Sagas**: Reactor is a real saga executor — DAG of steps, per-step `compensate/4` (retry /
  continue / fail) and `undo/4` (rollback), a three-tier error model (compensation → backoff →
  undo), async-by-default concurrency with `max_concurrency`, `middleware` and `around` hooks, and
  halt/resume. `Ash.Reactor` adds the `transaction` step and binds saga steps to Ash *actions*, so
  any Reactor can be the `run` target of a generic action and a saga is reachable from the domain as
  one operation.
  `reactor_file` / `reactor_process` / `reactor_req` are official add-ons.
- **Auditing** has two genuinely different shapes: AshPaperTrail writes a *version resource per
  domain resource* (4 change-tracking modes, actor attribution via `belongs_to_actor`,
  operation-id grouping, temporal-inline mode); AshEvents writes to *one central event log*
  (`event_log` resource + `events` block on the source), with action versioning, `replay_overrides`
  routing old versions to old actions, and `changed_attributes` capture.
- **Testing** is first-party, not a package: `Ash.Generator` (StreamData-backed generators and
  `action_input/3`), `Ash.Seed` (bypass-actions seeding straight to the data layer), `Ash.Test`
  (`assert_has_error`/`refute_has_error`/`strip_metadata`/`assert_stripped`), `Ash.can?`,
  in-memory data layers (`Ash.DataLayer.Ets` / `.Mnesia` /
  `.Simple`), plus property tests via `ExUnitProperties`. `smokestack` is the old community factory
  DSL and its own README now tells you **not** to use it.
- **Event sourcing / CQRS**: AshEvents records every create/update/destroy as an event in a central
  log and can *replay* that log, serializing writes with Postgres advisory locks; whether that
  counts as event sourcing is genuinely contested — see §4, which gives both positions. AshCommanded
  0.2.0 (a **third-party** repo, `accountex-org`) is the Commanded binding: a
  commands/events/projections/event_handlers DSL that generates a Commanded application, at 880
  all-time downloads, 2 hex releases, and a known compile bug on the published 0.2.0.
- **`ash_typescript` is the single most relevant package for Mesh.** 0.18 generates, from an
  Ash domain manifest, a TypeScript client with one typed function per exposed action, discriminated
  union results (`{success:true}|{success:false, errors}`), field selection with nested per-
  relationship pagination/filter/sort, typed query DSLs, Zod/Valibot schemas, typed Phoenix
  controllers and channels. Limits: it needs Ash ≥ 3.27 and a mandatory manifest module; hand-written
  clients that relied on silently-dropped `filter`/`sort`/`page` now get errors.
- **LLM support is a first-class design decision in the ecosystem**, not an afterthought:
  `usage_rules` aggregates each dependency's `usage-rules.md` into `AGENTS.md`/`CLAUDE.md` and into
  agent skills; `ash`, `ash_postgres`, `ash_phoenix`, `ash_graphql`, `ash_oban`, `ash_ai`,
  `ash_typescript`, `reactor`, `spark`, `igniter`, `ash_json_api`, `ash_money`, `ash_authentication`,
  `ash_events` all ship one. `ash_ai` exposes Ash actions as LLM/MCP tools, and ships a
  pre-built MCP server with OAuth 2.1 or API-key auth.
- Downloads are dominated by infrastructure packages, not domain ones. Top of the domain cluster by
  90-day downloads: `reactor` 395,665 → `ash_oban` 161,510 → `ash_state_machine` 123,291 →
  `ash_ai` 100,126 → `ash_archival` 88,614 → `ash_paper_trail` 88,476 → `ash_events` 22,826 →
  `ash_commanded` 154.
- Gaps with evidence (§10): **no mature shared library of reusable test generators**, **no built-in
  way to hydrate a historical AshPaperTrail version back into a resource**, **no first-party
  durable saga engine** (durability has to be hand-assembled from Reactor halt/resume + AshOban +
  AshStateMachine), and **the only CQRS/ES binding is broken on its latest published release**.

---

## 1. Sagas and workflows

### 1.1 Reactor

Reactor is the saga/workflow engine, and it is framework-independent — Ash support is an *extension*,
not a dependency (`reactor/README.md`, and the glossary entry "Framework Independence" in
`reactor/documentation/reference/glossary.md`).

**Steps, arguments, dependencies, return** (verbatim,
`reactor/documentation/tutorials/01-getting-started.md:64-112`):

```elixir
defmodule UserRegistration do
  use Reactor

  # Define what inputs this reactor expects
  input :email
  input :password

  # Define a simple step that validates email
  step :validate_email do
    argument :email, input(:email)

    run fn %{email: email}, _context ->
      if String.contains?(email, "@") do
        {:ok, email}
      else
        {:error, "Email must contain @"}
      end
    end
  end

  # Define a step that hashes the password
  step :hash_password do
    argument :password, input(:password)

    run fn %{password: password}, _context ->
      hashed = :crypto.hash(:sha256, password) |> Base.encode16()
      {:ok, hashed}
    end
  end

  # Define a step that creates the user
  step :create_user do
    argument :email, result(:validate_email)
    argument :password_hash, result(:hash_password)

    run fn %{email: email, password_hash: password_hash}, _context ->
      user = %{
        id: :rand.uniform(10000),
        email: email,
        password_hash: password_hash,
        created_at: DateTime.utc_now()
      }
      {:ok, user}
    end
  end

  # Specify what to return when the reactor completes
  return :create_user
end
```

Two facts matter for a re-design:

1. **Dependencies are inferred from arguments, not declared.** `reactor/documentation/tutorials/01-getting-started.md:95` — `:create_user` depends on `:validate_email` and `:hash_password` purely because it names them in `argument`. The doc says it directly: "Dependencies are created automatically based on arguments" (same file, "Step 3: Understanding your reactor").
2. **Execution order is the graph, not the source.** "Reactor doesn't execute steps in the order you wrote them" (same file, "Step 5"). The planner builds a DAG at compile time and detects cycles (`reactor/documentation/explanation/architecture.md`, "DSL Processing Flow"; glossary, "Cycle Detection").

**Compensation vs undo** (`reactor/documentation/tutorials/02-error-handling.md:132` and
`reactor/documentation/reference/glossary.md`, "Three-Tier Error Handling"):

- `compensate/4` runs when the step *fails*. It returns `:retry`, `{:continue, value}`, `:ok`, or
  `{:error, reason}`.
- `undo/4` runs when the step *succeeded* but a later step failed. Its return type is
  `:ok | :retry | {:retry | :error, reason}` (`reactor/lib/reactor/step.ex:69`) — so undo can
  itself be retried.
- `max_retries` bounds retries; `backoff/4` decides the delay (fixed, exponential, jittered).

```elixir
def compensate(error, _arguments, _context, _options) do
  case error do
    %{type: :network_timeout} ->
      IO.puts("🔄 Network timeout - retrying email send...")
      :retry
    %{type: :blocked_email} ->
      IO.puts("❌ Email blocked - cannot retry")
      :ok
    _other ->
      :ok
  end
end
```
(abridged: the `:rate_limit` and `:invalid_email` clauses are omitted, and the two comments
`# Temporary failures - retry with helpful logging` and `# Permanent failures - don't retry` are
dropped — `reactor/documentation/tutorials/02-error-handling.md:132-160`)

A warning worth copying verbatim into any re-implementation:
**"Steps retry infinitely: Always set `max_retries` and ensure compensation doesn't always return
`:retry`"** (`reactor/documentation/tutorials/02-error-handling.md:610`).

**Async execution** (`reactor/documentation/tutorials/03-async-workflows.md:55-66`):

```elixir
step :fetch_data do
  async? true  # This is the default
  run &fetch_from_api/1
end

step :critical_operation do
  async? false # Forces synchronous execution
  run &update_database/1
end
```

The executor loop prioritises (1) finished async tasks, (2) starting new async steps within
concurrency limits, (3) running one sync step, (4) deadlock prevention for shared pools, (5)
completion checks (`reactor/documentation/explanation/architecture.md`, "Main Executor").
`max_concurrency` defaults to CPU count, and `concurrency_key` (a `reference()`, "Only used if `async?`
is set to `true`") lets *nested* reactors share a pool across a call tree
(`reactor/lib/reactor.ex:108-110`; the glossary entry "Shared Pools" describes the concept but does
not name the option).

**Middleware and around** (`reactor/documentation/tutorials/reactor-cheatsheet.cheatmd:384`,
`:155`):

```elixir
middlewares do
  middleware MyApp.LoggingMiddleware
  middleware Reactor.Middleware.Telemetry
end

around :transaction, &MyApp.with_transaction/4 do
  step :create_user do
    # runs inside the wrapper
  end
end
```

`Reactor.Middleware` is a behaviour with all-optional callbacks — `complete/2` (`:63`),
`error/2` (`:77`), `halt/1` (`:85`), `init/1` (`:93`), `get_process_context/0` (`:102`),
`set_process_context/1` (`:111`) and `event/3` (`:119`). The `step_event` names that `event/3`
receives are a type declared at `:25-46`: `run_start`, `guard_fail`, `compensate_retry`, `undo_start`,
`process_terminate`, and so on (`reactor/lib/reactor/middleware.ex`). This is cross-cutting
concerns (telemetry, auth, logging) at the *workflow* level, which is a level Ash itself does not
have.

**Halt and resume** — an important capability I missed in round 1
(`reactor/documentation/tutorials/reactor-cheatsheet.cheatmd:53-55`):

```elixir
# Halting and resuming
{:halted, state} = Reactor.run(MyReactor, inputs)
{:ok, result} = Reactor.run(state, %{}, %{})
```

The reactor lifecycle includes a `:halted` state alongside `:pending`, `:executing`, `:failed` and
`:successful` (`reactor/documentation/explanation/architecture.md:78`). `Reactor.run/3` can also
take `max_concurrency`, `concurrency_key` and `fully_reversible?` as run options
(`reactor/lib/reactor.ex:108-127`). Note that `fully_reversible?` is **not** a durability option:
"When this option is set the Reactor will return a copy of the completed Reactor struct for
potential future undo" (`reactor/lib/reactor.ex:112-116`) — it keeps a *completed* run around so it
can be undone later, and says nothing about persisting progress mid-run.

**Other step types** (glossary + cheatsheet): `compose` (sub-reactor as one step), `collect`,
`map` (per-item fan-out with batch size and optional strict ordering), `switch`, `recurse`,
`template`, `group`, `guard`/`where`, `wait_for`, `debug`, `flunk`. Notably
**`Reactor.Step.async?/1` and `nested_steps/1` are part of the step behaviour**
(`reactor/lib/reactor/step.ex:207,229`), which is how a step opts into sync execution or declares
inner steps.

**Ecosystem add-ons** (glossary, "Ecosystem Extensions"): `reactor_file` (v0.18.5, 818 downloads
recent), `reactor_process` (0.5.0, 177), `reactor_req` (0.1.7, 1,224).

### 1.2 Ash.Reactor

`Ash.Reactor` is a Reactor extension that maps saga steps onto Ash actions
(`ash/documentation/topics/advanced/reactor.md`, "Ash.Reactor is an extension for Reactor which
adds explicit support for interacting with resources via their defined actions"). It is a Spark DSL
extension, so `use Reactor, extensions: [Ash.Reactor]` or `use Ash.Reactor` both work.

```elixir
defmodule ExampleReactor do
  use Ash.Reactor

  ash do
    default_domain ExampleDomain
  end

  input :customer_name
  input :customer_email
  input :plan_name
  input :payment_nonce

  create :create_customer, Customer do
    inputs %{name: input(:customer_name), email: input(:customer_email)}
  end

  read_one :get_plan, Plan, :get_plan_by_name do
    inputs %{name: input(:plan_name)}
    fail_on_not_found? true
  end

  action :take_payment, PaymentProvider do
    inputs %{
      nonce: input(:payment_nonce),
      amount: result(:get_plan, [:price])
    }
  end

  create :subscription, Subscription do
    inputs %{
      plan_id: result(:get_plan, [:id]),
      payment_provider_id: result(:take_payment, :id)
    }
  end
end
```
(verbatim, `ash/documentation/topics/advanced/reactor.md:64-99`. Note the four step types in play:
`create`, `read_one`, `action` on a non-persisted resource, and `create` again.)

**How an action joins a saga** — this is the key integration idea and it is elegant: a *generic
action* whose `run` option is the Reactor module
(`ash/documentation/topics/advanced/reactor.md:36-60`):

```elixir
defmodule MyApp.Blog.Actions do
  use Ash.Resource

  action :create_post, :struct do
    constraints instance_of: MyBlog.Post

    argument :blog_title, :string, allow_nil?: false
    argument :blog_body, :string, allow_nil?: false
    argument :author_email, :ci_string, allow_nil?: false

    run MyApp.Blog.Reactors.CreatePost
  end
end
```

The doc states the contract explicitly: "Every Reactor input must have a corresponding action
argument. Ash's action context is passed in as the Reactor's context (including things like actor,
tenant, etc)." A resource with **one generic action and no attributes/data layer at all** is a
legitimate thing to define — that is the "operation resource" pattern, and the guide says so
explicitly ("Not all resources need to have state/data layers associated with them",
`ash/documentation/topics/advanced/reactor.md:41`).

**Undo in `Ash.Reactor`** (`ash/documentation/topics/advanced/reactor.md:145-180`): by default
`create`/`update`/`destroy` steps set `undo: :never` (best performance, no intermediate storage).
You opt in per step:

- `undo: :outside_transaction` — decide at runtime; if inside a transaction, skip undo.
- `undo: :always` — always undo.
- `undo_action` names the compensating action, and is action specific
  (`ash/documentation/topics/advanced/reactor.md:168-180`):
  - for `create`, "`a destroy` **or `update`** action with no specific requirements";
  - for `update`, "an `update` action which takes a `changeset` argument, which will contain the
    `Ash.Changeset` which was used to execute the original update";
  - for `destroy`, "`a create` action which takes a `record` argument, which will contain the
    resource record which was used destroyed".

**Transactions** (`ash/documentation/topics/advanced/reactor.md:184-215`): a `transaction` step wraps
a group of steps, but with two documented caveats — everything inside must run in the *same
process* (so it is always synchronous), and notifications are only sent on commit. And: "Because a
reactor has transaction-like semantics notifications are automatically batched and only sent upon
successful completion" (same file, "Notifications").

### 1.3 Other options the community uses

From the hex.pm search API (`https://hex.pm/api/packages?search=...`, retrieved 2026-10-01):

| Package | Version | Downloads (all / recent) | What it is |
|---|---|---|---|
| `ash_workflow` | 0.8.0 (2026-09-30) | 210 / 210 | "Declarative workflow orchestration for the Ash Framework — multi-step workflows combining human actions, background jobs, and time-based deadlines" (hex description), repo `team-alembic/ash_workflow`. First released 2026-09-18 — five releases in twelve days, so the download count measures *newness*, not disuse. |
| `ash_flow` | 0.1.1 (2024-05-11) | 35,074 / 1,555 | Official `ash-project` package, self-described as 'A "soft deprecated" tool for composing workflows with your Ash Framework resources'. **This is the predecessor Reactor replaced** — important history for anyone porting the saga concept. |
| `hephaestus` (+ `_oban`, `_ecto`) | 0.3.1 / 0.5.0 / 0.3.0 | 674 / 299; 448 / 199; 396 / 173 | durable-ish workflow engines, not Ash-specific (`hephaestus-org/hephaestus_core`, `lucas-stellet/*`) |

Maturity verdict: **`reactor` is the established saga engine.** `ash_workflow` is a *new*
Ash-native durable-workflow package (12 days old at time of writing) whose README describes storing
workflow state in a resource via generated `ash_state_machine` states plus `ash_oban` triggers with
day-scale timeouts (https://github.com/team-alembic/ash_workflow, "Concepts") — worth watching,
not yet worth adopting. `hephaestus` is tiny (674 all-time).

**Durability: what the community actually does.** There is no first-party durable saga engine, but
the pattern is well established: run a Reactor *inside* an Oban job, and keep the durable state in a
resource driven by AshStateMachine + AshOban. Core-team advice points this way —
https://elixirforum.com/t/long-running-queued-background-processes/59508 (jimsynz, 2023-11-06;
older than 2025, cited as guidance of record). Reactor's own `halt`/`resume` is the other half of
that assembly — but note what the cited cheatsheet actually shows
(`reactor-cheatsheet.cheatmd:53-55`): an **in-process** pause, `{:halted, state} =
Reactor.run(MyReactor, inputs)` followed by `Reactor.run(state, %{}, %{})` on the returned struct.
Persisting that `%Reactor{}` between processes or across a deploy is left to the application and is
**not documented**; the ecosystem pattern of storing it in a resource is community practice
(`[unverified]` — I found no source in the Reactor docs for it, only the `fully_reversible?`
run option and the halt example above).

The non-Ash saga engines above and `ariadne_flow` (see §4 — it is an event-sourcing library, not a
workflow engine) complete the picture.

---

## 2. Auditing

Two official packages, and they are genuinely different designs.

### 2.1 AshPaperTrail — one version resource per domain resource

`ash_paper_trail/documentation/tutorials/getting-started-with-ash-paper-trail.md:29-46`:

```elixir
use Ash.Resource,
  domain: MyDomain,
  extensions: [
    AshPaperTrail.Resource
  ]

  paper_trail do
    primary_key_type :uuid_v7   # default is :uuid
    change_tracking_mode :changes_only # default is :snapshot
    store_action_name? true # default is false
    ignore_attributes [:inserted_at, :updated_at] # the primary keys are always ignored
    ignore_actions [:destroy] # default is []
  end
```

What it adds:

- An **auto-generated version resource** named `<Resource>.Version`, added to the domain, with
  `paper_trail_versions` (`has_many`, `no_attributes?`) on the source and `version_source` back
  (same file, lines 48-56). Domain-level opt-in via `AshPaperTrail.Domain` +
  `include_versions? true`, or per-resource listing.
- **Four change-tracking modes** (same file, lines 200-243): `:snapshot` (dump every attribute),
  `:changes_only` (dump changed attributes), `:full_diff` (`{from: …, to: …}` per attribute),
  `:previous_values` (previous value of changed attributes only; designed for temporal resources).
- **Actor attribution** (lines 246-260):
  ```elixir
  paper_trail do
    belongs_to_actor :user, MyApp.Accounts.User, domain: MyApp.Accounts
    belongs_to_actor :news_feed, MyApp.Accounts.NewsFeed, domain: MyApp.Accounts
  end
  ```
  Declares the actor's resource, creates a `belongs_to` with `on_delete: :nilify`. Non-resource
  actors are possible via an `:on_create` `change`.
- **Operation grouping** (lines 262-282): `operation_id_field :operation_id` stores a UUIDv7 on
  every version created by one top-level action, propagated through `context.shared` so nested
  actions, loads and managed relationships share it. Bulk actions share one id per batch.
- **Composite primary keys** (lines 94-116): `version_source_team_id` / `version_source_user_id`.
- **Temporal inline mode** (lines 330+): `mode :temporal_inline` skips the separate version table
  and stamps `version_action_type`, `version_action_inputs` etc. onto each period row. `:full_diff`
  cannot be tracked atomically in this mode.
- **Known gaps from the docs**: destroys are awkward on AshPostgres — three documented workarounds
  (`create_version_on_destroy? false` + a mixin with `on_delete: :delete`, soft destroys via
  AshArchival, or `reference_source? false`) (lines 118-160).

### 2.2 AshEvents — one central log, with replay

`ash_events/README.md:54-72` (event log resource) and `:110-130` (per-resource opt-in). Both
blocks below are abridged: from the first, all comments, the second
`persist_actor_primary_key :system_actor, MyApp.SystemActor, attribute_type: :string` line and the
`.....` placeholder are omitted; from the second, all comments and the `attributes do … end` /
`actions do … end` stubs are omitted:

```elixir
defmodule MyApp.Events.Event do
  use Ash.Resource, extensions: [AshEvents.EventLog]

  event_log do
    clear_records_for_replay MyApp.Events.ClearAllRecords
    primary_key_type Ash.Type.UUIDv7
    record_id_type :uuid
    persist_actor_primary_key :user_id, MyApp.Accounts.User
    public_fields :all  # or [:id, :resource, :action, :occurred_at], or [] (default)
  end

  replay_overrides do
    replay_override MyApp.Accounts.User, :create do
      versions [1]
      route_to MyApp.Accounts.User, :old_create_v1
    end
  end
end

defmodule MyApp.Accounts.User do
  use Ash.Resource, extensions: [AshEvents.Events]

  events do
    event_log MyApp.Events.Event
    ignore_actions [:old_create_v1]
    current_action_versions create: 2, update: 3, destroy: 2
  end
end
```

Mechanics (`ash_events/README.md:197-203`): "AshEvents works by wrapping resource actions. […] The
action wrapper intercepts the request, creates an event in your event log resource, then calls the
original action implementation." More precisely (`ash_events/README.md:515-525`): "AshEvents
implements event tracking by installing its own manual implementation on every tracked create,
update and destroy action, so the wrapper can write the event around the data layer call. An action
that already declares `manual` cannot be tracked, and the combination is rejected at compile time
with a `Spark.Error.DslError`."

Replay (`ash_events/README.md:157-172`; abridged — the source shows three examples, replay-all,
up-to-an-event-id and up-to-a-point-in-time, and only the second is kept here):

```elixir
MyApp.Events.Event
|> Ash.ActionInput.for_action(:replay, %{last_event_id: 1000})
|> Ash.run_action!()
```

Two features that are genuinely good and worth stealing:

- **`changed_attributes`** (`ash_events/README.md:212-265`). Events split original input
  (`event.data`) from values produced by defaults, slugs, UUIDs and business logic
  (`event.changed_attributes`). Replay applies both, controlled per action by
  `replay_non_input_attribute_changes [create: :force_change, update: :as_arguments]`. Without
  this, replay silently loses every derived field.
- **Hooks are skipped during replay** (`ash_events/README.md:317-331`): `before_action`,
  `after_action`, `around_action`, `before_transaction`, `after_transaction`, `around_transaction`
  all no-op on replay, so emails are not re-sent. The recommended practice (`README.md:333-349`) is
  to wrap side effects in *their own action on an event-logged resource*, so the side effect becomes
  an event too and is replayable.

Other facts that constrain the design, all from the README:

- **Postgres-only.** `ash_events/mix.exs:146` declares `{:ash_postgres, "~> 2.0"}`, and write
  serialisation uses "Postgres transaction-based advisory locks" (`ash_events/README.md:644-651`).
  The default key passed to `pg_advisory_lock` is `2_147_483_647` for non-multitenant resources;
  with the multitenancy attribute-strategy the tenant id is used, and a `:uuid` tenant id is
  reduced to two 32-bit ints, which "increases the risk of collisions and unnecessarily blocking writes for
  other tenants as well, but it is still extremely unlikely to occur in practice". Non-integer, non-UUID tenant ids are unsupported without a custom
  `AshEvents.AdvisoryLockKeyGenerator` behaviour.
- **Event-log notifiers** (`ash_events/README.md:490-513`): the log is an ordinary Ash resource, so
  `notifiers: [...]` fire for every event — "The notifier fires for events recorded by create,
  update and soft destroy actions, and for all bulk actions." Documented limitation: events from a
  *single* (non-bulk) hard destroy produce **no** notification, because Ash's non-bulk destroy
  pipeline cannot carry notifications out of a manual destroy; bulk destroys are unaffected.
- **Encrypted event logs** (`ash_events/README.md:596-622`): attributes/arguments marked
  `sensitive?: true` are stored as `nil` in `data` on a plain log, "so that plaintext password
  arguments from AshAuthentication never reach the log" — but "A sensitive attribute set by a
  change, such as a hashed password or a generated token, is written to `changed_attributes`
  verbatim." Configuring a Cloak vault moves `data`, `changed_attributes` and `metadata` into
  `encrypted_*` columns; the trade-off is that encrypted payloads cannot be filtered or indexed.

Whether AshEvents is "event sourcing" is contested; §4 gives both positions and my reading is in
the analysis section. What is not contested: the README itself says you can use it "solely as an
audit logging system" by skipping `clear_records_for_replay` and `action_versions`
(`ash_events/README.md:174-182`), and replay is destructive: `clear_records_for_replay` names a
module **you** implement — `use AshEvents.ClearRecordsForReplay` with a `clear_records!/1` callback
(`ash_events/README.md:84-98`) — and replay calls it to clear the records, then loads events in
chronological order and applies each one (`ash_events/README.md:205-210`). AshEvents itself wipes
nothing.

### 2.3 The official comparison

AshEvents' README compares the two directly (`ash_events/README.md:184-195`):

1. AshEvents stores events in a **centralized table/resource**; ash_paper_trail adds a **separate
   version-resource for each resource**.
2. ash_paper_trail's version resource has "several options for change tracking and storing action
   inputs"; AshEvents only stores the action inputs.
3. Because ash_paper_trail uses a per-resource table, versions can store attributes as real columns
   and can ignore specific attributes. AshEvents cannot.
4. ash_paper_trail has better support for **exposing earlier versions to the app**, e.g. through
   `ash_graphql` or `ash_json_api` (it even ships a documented `version_extensions` + `mixin`
   recipe, `getting-started-with-ash-paper-trail.md:302-330`).

### 2.4 Other approaches

- **`AshAuthentication.AuditLogResource`** — an audit log for authentication actions specifically
  (`extensions: [AshAuthentication.AuditLogResource]` in `ash_authentication`'s docs). Narrower.
- **`ash_event_log`** (third-party, `sephianl/ash_event_log` v0.1.5, 2026-08-31, 1,507 all-time /
  910 recent downloads): "An Ash extension for automatic event logging and audit trails on
  resources" — the same space AshEvents occupies, but **newer, not older**: `ash_event_log` was
  first released 2026-04-23 whereas `ash_events` 0.1.0 shipped 2025-05-06. Adoption ratio ≈ 1/42
  all-time and ≈ 1/25 over 90 days (hex APIs, 2026-10-01).

---

## 3. Testing

### 3.1 What Ash ships

**Configuration** (`ash/documentation/topics/development/testing.md:10-13`):

```elixir
# config/test.exs
config :ash, :disable_async?, true
config :ash, :missed_notifications, :ignore
```

`disable_async?` stops Ash spawning tasks, which is what makes transactional tests possible with
AshPostgres; `DataCase` (Ecto's sandbox) wraps each test in a rolled-back transaction
(same file, lines 30-40).

**In-memory data layers** — `ash/lib/ash/data_layer/` contains `ets/`, `mnesia/` and `simple/`.
`Ash.DataLayer.Ets` has a `private?` option explicitly "Used in testing" that scopes the ETS table
to the calling process (`ash/lib/ash/data_layer/ets/ets.ex:12-25`). The testing guide's own example
resources use `data_layer: Ash.DataLayer.Ets`
(`ash/documentation/how-to/test-resources.livemd:52-56`). This is what lets you property-test
resources with no database at all.

**`Ash.Generator`** — StreamData-backed generators (`ash/lib/ash/generator/generator.ex:8-40`;
the block below adds one comma after the `sequence(...)` line — the source moduledoc omits it, a
typo in the source — and reflows the `defaults:` list onto one line):

```elixir
defmodule YourApp.Generator do
  use Ash.Generator

  # using `seed_generator`, bypasses the action and saves directly to the data layer
  def blog_post(opts \\ []) do
    seed_generator(
      %MyApp.Blog.Post{
        name: sequence(:title, &"My Blog Post \#{&1}"),
        text: StreamData.repeatedly(fn -> Faker.Lorem.paragraph() end)
      },
      overrides: opts
    )
  end

  # using `changeset_generator`, calls the action when passed to `generate`
  def blog_post_comment(opts \\ []) do
    blog_post_id = opts[:blog_post_id] || once(:default_blog_post_id, fn -> generate(blog_post()).id end)

    changeset_generator(
      MyApp.Blog.Comment,
      :create,
      defaults: [blog_post_id: blog_post_id],
      overrides: opts
    )
  end
end
```

The two generator kinds matter: `seed_generator` goes straight to the data layer (fast, no
business logic), `changeset_generator` actually invokes the action.

**The recommended test shapes** (`ash/documentation/how-to/test-resources.livemd:196-262`):

```elixir
# now if our action inputs are invalid when we think they should be valid, we will find out here
property "accepts all valid input" do
  user = generate(user())

  check all(input <- Ash.Generator.action_input(Tweet, :create)) do
    {text, other_inputs} = Map.pop!(input, :text)

    assert Domain.changeset_to_create_tweet(
             text,
             other_inputs,
             authorize?: false,
             actor: user
           ).valid?
  end
end
```

and policy testing in isolation:

```elixir
test "allows a user to update their own tweet" do
  user = generate(user())
  tweet = generate(tweet(text: "Hello world!", actor: user))

  assert Domain.can_update_tweet?(user, tweet, "Goodbye world!")
end

test "does not allow a user to update someone elses tweet" do
  [user, user2] = generate_many(user(admin?: false), 2)
  tweet = Domain.create_tweet!("Hello world!", actor: user)

  refute Domain.can_update_tweet?(user2, tweet, "Goodbye world!")
end
```

The comments in the source name the two axes explicitly: one property tests *input validation*
alone, the other "actually call the action. This tests the underlying action implementation not just
initial validation" (`test-resources.livemd:214-215`). `Ash.can?/3` is the underlying primitive —
it "Calls `can/3` with a `maybe_is: true`" (`ash/lib/ash.ex:1812-1826`), and the generated
`can_<action>?` wrappers come from the domain's code interface (`define :can_update_tweet, ...`).

The doc's own conclusion (`test-resources.livemd:25-28`): test *thoroughly* — "testing has two
primary roles: 1. Confirming our understanding of the way that our application behaves now
2. Ensuring that our application does not change in unintended ways later".

**`Ash.Seed`** (`ash/lib/ash/seed.ex:5-11`): "Helpers for seeding data […] **Important: this
bypasses resource actions, and goes straight to the data layer. No action changes or validations are
run.** The only thing that it does at the moment is ensure that default values for attributes are
set". It also offers `keep_nil/0` and `:__skip__` sentinels for explicit control.

**`Ash.Test`** (`ash/lib/ash/test.ex`) — four helpers, not one:
`assert_has_error/4` (`:25`), `refute_has_error/4` (`:118`), `strip_metadata/1` (`:179-201`, which
recurses through lists, tuples, pages and maps to remove Ash metadata before comparison) and the
`assert_stripped/1` **macro** (`:238-283`, which accepts `==`, `===`, `!=`, `!==`, `in`, `not in` and
a bare expression and compares the stripped values). Error classes are the ones Ash registers with
Splode: `Forbidden`, `Invalid`, `Framework`, `Unknown` (`ash/lib/ash/error/error.ex:10-14`).

**The wider `Ash.Generator` API** (`ash/lib/ash/generator/generator.ex`), beyond
`changeset_generator`/`seed_generator`: `seed!/2` (`:753`), `seed_many!/3` (`:764`),
`generate_many/2` (`:814`), `action_input/3` (`:870`), `many_changesets/3` (`:932`),
`seed_input/2` (`:988`) and `mixed_map/2` (`:1035`), which fills a map with a mix of constant and
generated values.

**Two more testing aids worth knowing:**
- `mix ash.generate_policy_chart` (`ash/lib/mix/tasks/ash.generate_policy_chart.ex`) renders a chart
  of the policies on your resources — a review aid for authorization.
- `ash/usage-rules/testing.md:19-32` warns that fixed values for identity attributes cause
  deadlocks in concurrent tests — "When running tests concurrently, using fixed values for identity
  attributes can cause deadlock errors" — and prescribes globally unique values
  (`email: "test-#{System.unique_integer([:positive])}@example.com"`).

**Community test packages** (hex API, 2026-10-01): `ash_scenario` 0.6.1 (2026-02-03, 1,838 all /
355 recent, `marot/ash_scenario`) — "Reusable test data generation … with dependency resolution";
`ash_random_params` 0.2.1 (2025-10-11, 7,593 / 4,914, `devall-org/ash_random_params`) — random action
params for tests. Both are small but they do exist, so the honest gap statement is about *maturity*,
not absence.

### 3.2 Community: Smokestack, deprecated by its own author

`smokestack/README.md` opens with:

> **TIP** Having spent some time with Smokestack, I no longer think it's the correct approach for
> test factories. As highlihted [sic] in the testing chapter of
> *Ash Framework: Create Declarative Elixir Web Apps* you should probably use a combination of
> `Ash.Generator` and `Ash.Seed`.
> — James Harton (`smokestack/README.md:6-7`)

(James Harton is the author of Reactor and a member of the Ash core team — even core members have
deprecated their own factory DSL in favour of generators.)

The DSL it replaces (`smokestack/README.md:13-30`; abridged — the second factory,
`factory Character, :trek`, and the `MyApp.CharacterTest` module that follow it in the source are
omitted):

```elixir
defmodule MyApp.Factory do
  use Smokestack

  factory Character do
    attribute :name, &Faker.StarWars.character/0
    attribute :affiliation, choose(["Galactic Empire", "Rebel Alliance"])
  end
end
```

Downloads confirm the decline: 46,612 all-time, 9,328 in 90 days, **last release 2025-01-30** —
it is dormant. Note the license: HL3-FULL, not MIT (`smokestack/README.md`, "License"), which is a
real adoption blocker.

### 3.3 Reactor testing

`reactor/documentation/how-to/testing-strategies.md` recommends: unit-test individual step modules
by calling `Step.run(arguments, context, options)` directly; use **Mimic** for mocking; and disable
async for deterministic execution ("Synchronous Execution […] used for testing",
`reactor/documentation/reference/glossary.md`).

---

## 4. Event Sourcing and CQRS — the precise answer

| | AshEvents 0.8.2 | AshCommanded 0.2.0 |
|---|---|---|
| Repo | `ash-project/ash_events` | **`accountex-org/ash_commanded`** (not the core team) |
| Hex owners | `ash-project`, `torkan` | `pcharbon70` |
| Latest release | 0.8.2, 2026-09-19 | 0.2.0, 2025-12-08 |
| Downloads all / recent | 62,604 / 22,826 | 880 / 154 |
| Model | central event log + optional replay | Commanded commands/events/projections |
| Replay | destructive: clear all, re-run actions | projections applied from Commanded |
| Versioning | `current_action_versions`, `replay_overrides` routing | event handler dispatch by event type |
| Maturity | official, actively released, 0.x | 0.2.0, 2 hex releases, ~10 months without one, **compile bug on the published release** |

### 4.1 Is AshEvents event sourcing? Both positions

**Position A — "it is event sourcing" (the maintainers).** Zach Daniel, 2025-05-11, in
https://elixirforum.com/t/ashevents-event-sourcing-made-simple-for-ash/70777:

- post #7: "the most important property is that you can delete all of the projections from the
  event store, and then rebuild them all by playing forward an event log" — and AshEvents "has this
  property", meaning the projection can be rebuilt from the log alone.
- post #9: "it fits the need, and fits enough definitions for the term for us to say 'this is one
  way to do event sourcing with Ash'".
- post #11: "an event is always committed first, transactionally, representing exactly what changes
  are about to occur in the projection". The post links `create_action_wrapper.ex` **at v0.1.1**, so
  it describes the May-2025 implementation, not necessarily the current one — see the 0.8.2 write
  order below.

The README's own framing is narrower than the announcement's: skipping the replay options lets you
use it "purely as an audit log system **rather than** a full event sourcing solution"
(`ash_events/README.md:182`).

**Position B — "it is not event sourcing" (practitioners).** Same thread, katafrakt, post #3
(2025-05-11), quoted directly: "One of my first thought when I was reading the announcement was
that it's great, but also I don't think it's event sourcing. Ability to replay the state is great,
but it seems that the state is still a primary concept and events are secondary. Still great
though. I would just avoid marketing it as event sourcing (as the readme does)." In post #10 he
adds: "it still has 'sourcing' in the name, meaning that the events are actually the source (what I
meant by primary vs secondary)", and quotes Fowler — "Now the service creates an event object to
record the change and processes it to update the ship" — i.e. the event should initiate the state
change, not trail it. He does not call it an "audit log"; that was my round-2 paraphrase, and it
was inaccurate.

**The write path in 0.8.2 (checked in source).** The write path is not "the action runs normally":
AshEvents *replaces* each tracked action with its own `manual` implementation
(`ash_events/README.md:515-525`; the transformer sets `manual:` to its wrapper modules,
`ash_events/lib/events/transformers/wrap_actions.ex:172-188`), and both writes happen inside the
action's transaction — but the order varies by action type:

- **update:** the event is created first, then the row
  (`lib/events/update_action_wrapper.ex:28-39` — `create_event!` at :28-33, `data_layer.update` at
  :37).
- **create:** the row is written first via `data_layer.create`/`upsert`, then `create_event!` runs
  with the real primary key (`lib/events/create_action_wrapper.ex:25-58`).
- **destroy:** the row is updated/destroyed first, then the event
  (`lib/events/destroy_action_wrapper.ex:36-37` for soft destroys, `:106` for hard destroys).

So "events are committed before the projection changes" holds in 0.8.2 **only for updates**; for
creates and destroys the row is written first and the event second, inside the same transaction.

**Supporting facts for B:** replay "Clears existing records using your `clear_records_for_replay`
implementation" and then "Loads events in chronological order" and "Applies each event to rebuild
resource state" (`ash_events/README.md:205-210`) — the resource tables remain the primary store,
and replay is destructive.

**Supporting facts for A:** both writes are bound in one transaction, tracked writes are serialised
with Postgres advisory locks (`README.md:644-651`), and notifiers on the log fire for every event
(`README.md:490-513`), which is the hook a projection would hang off.

On `manual` actions: 0.8.2 rejects an action that already declares `manual` at compile time
(`wrap_actions.ex:51,264`, `reject_manual_actions!`). The open issue
https://github.com/ash-project/ash_events/issues/99 was filed against **0.8.1** and reports the
opposite behaviour: a resource's own `manual` was *silently discarded*, with "no compile warning".
The issue is still open; in the 0.8.2 clone the same combination is a compile error.

My own reading is in the analysis section at the end, not here.

### 4.2 AshCommanded

**AshCommanded is the only real CQRS binding**, and it is the most under-rated thing in this
inventory. Its README (`ash_commanded/README.md:4`) says it provides "CQRS **and Event-Sourcing
(ES)** patterns for the Ash Framework"; the hex package description is "CQRS pattern implementation
for Ash Framework resources using Commanded". It relies on the Commanded library. The DSL has five
sections — `commands`, `events`, `projections`, `event_handlers`, `application`
(`README.md:34-39`) — and it generates a lot of Elixir: command structs, event structs, projection
modules, Commanded projectors, aggregate modules, a per-domain router, a main router, and the
Commanded application itself with projector and handler supervision (`README.md:41-60`). It also
does command middleware pipelines, parameter transformation and validation, transactional commands,
and context propagation (`README.md:62-68`).

```elixir
commanded do
  commands do
    command :register_customer do
      fields([:id, :name, :email])
      identity_field(:id)
      action :register
    end
  end

  events do
    event :customer_registered do
      fields([:id, :name, :email])
    end
  end

  projections do
    projection :customer_registered do
      action(:create)
      changes(%{status: :pending})
    end
  end
end
```
(`ash_commanded/README.md:88-140`; abridged — the `confirm_email` command, the `email_confirmed`
event and its projection, and the resource module around the `commanded do` block are omitted)

Maturity warning, stated plainly: it is `0.2.0` on a **non-core** repository (`accountex-org`, via the
hex.pm API `meta.links.GitHub` field, 2026-10-01), owned by one hex user (`pcharbon70`), with
**exactly 2 hex releases** (0.1.0 on 2025-05-16 and 0.2.0 on 2025-12-08) and 880 all-time downloads.
GitHub shows 4 contributors (pcharbon70-leco 30 commits, pcharbon70 9, suranyami 5, vivek-alembic 1)
with PRs merged as late as 2026-05-12 (https://api.github.com/repos/accountex-org/ash_commanded/commits).

**The published release is broken.** 0.1.0 did not compile at all, and 0.2.0 was published to fix
that (https://elixirforum.com/t/ashcommanded-a-declarative-cqrs-es-extension-for-ash/70900,
posts #3-#5, 2025-12). 0.2.0 still fails when generating aggregates
(`undefined function snapshot_state_if_needed/1`, post #10, 2026-02-10). The fix (PR #7,
https://github.com/accountex-org/ash_commanded/pull/7) was merged on 2026-05-12 but **never
released**. Process managers are also unaddressed; per the same thread the author recommends Reactor.

Its downstream base is real though — `commanded` itself is at 1.4.11 with 158,205 recent downloads,
and `eventstore` at 1.4.10 with 157,001. **For Mesh: the pattern matters, the package does not.**

### 4.3 The rest of the ES landscape

No other Ash package does event sourcing. The hex search for "event sourcing" returns `eventstore`,
`commanded_eventstore_adapter`, `evoq`, `reckon_db`, `oban_events` — none Ash-specific. Two worth
naming: **`ariadne_flow`** 0.11.0 (2026-10-01, 2,427 all-time) is an event-sourcing library for
Elixir — hex description: "Event sourcing for Elixir built on Dynamic Consistency Boundaries: an
append-only…" (https://hex.pm/api/packages/ariadne_flow), repo `modell-aachen/flow` — which is
adjacent to, not built on, Ash; and **`ash_event_log`** 0.1.5 (see §2.4).

---

## 5. Ranked inventory (20 packages)

**Ranking rule** (one rule, applied in two bands): **(1) Domain relevance first, adoption
second.** A package ranks on whether it expresses the domain lifecycle — saga, history, state,
domain types, background work, security, LLM/agent surface. The three packages that serve the
brief's mandatory areas take ranks 1-3 whatever their downloads: sagas (`reactor`), auditing
(`ash_paper_trail`, `ash_events`; the fourth mandatory area, testing, is first-party and has no
package). **The rest of the domain band is ordered by hex.pm 90-day downloads, descending.**
**(2) Storage, transport and admin-UI packages sit in a separate band below the domain band,
ranked by adoption.** That is the rule's stated exception, and the reason for it: the Mesh plan
fixes its own runtime (Bun) and frontend (Marko) and leaves the HTTP layer open, so storage and
transport packages are pattern references, not design blueprints — a domain package ranks above a
storage/transport package even at a fraction of the downloads. `ash_admin` sits in this band
because it is a generated admin UI over the domain, i.e. the same kind of reference. **(3)
Infrastructure and plumbing (`spark`, `igniter`, `splode`, `ash_sql`) are not ranked at all** —
they are in §9 honorable mentions. Core-team = `ash-project` hex owner; community = anyone else.
`ash_typescript` is ranked in the domain band although it is arguably transport, because Mesh is
a TypeScript framework and its generated client is a core design concern (§7); inside the band it
still sits at its adoption position.

**Maturity gate:** a package must have been published for at least two weeks before it can take a
ranked slot. This is why `ash_workflow` (first released 2026-09-18) stays in §9 even though its
area — durable workflows — is squarely a mandatory one: a saga package twelve days old is not yet
a design input. It is a tiebreak on *age*, not on relevance: `ash_workflow` is arguably more
domain-relevant than the package that took the slot, and a reader should treat ranks 14-15 as
interchangeable with it.

Downloads from `https://hex.pm/api/packages/<name>` (`downloads.all` and `downloads.recent`,
which is the 90-day window), retrieved 2026-10-01 and re-fetched for every row added or moved in
round 3.

**RANKING (round 3):** `splode` was demoted out of the 20 to honorable mentions — promoting it in
round 2 for "structured errors behind every result" contradicted the same rule that demoted
`igniter`/`spark`; it is plumbing. The free slot goes to **`ash_onetime`** (idempotency-key and
one-time-nonce semantics — a domain concern, 19 releases since 2026-08-09). Evaluated for that slot
and left in §9: `ash_workflow` (durable workflows, but 12 days old — fails the maturity gate above),
`ash_credo` (static-analysis tooling, not domain modelling; 47,947 all / 29,661 recent) and
`ash_scenario` (test-data generation; 1,838 / 355; covered in gap #1).

| # | Package | Category | What it does (one line) | Version | Released | All DL | 90d DL | Maintainer | Ash extension points |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `reactor` | Saga / workflow | Async graph-based saga executor with compensation and undo | 1.0.7 | 2026-09-16 | 1,410,207 | 395,665 | core | `Reactor` DSL; `Ash.Reactor` ext (in `ash`) |
| 2 | `ash_paper_trail` | Auditing | Per-resource version resources with 4 change-tracking modes + actor attribution | 0.7.0 | 2026-08-30 | 309,565 | 88,476 | core | `AshPaperTrail.Resource`, `.Domain` |
| 3 | `ash_events` | Auditing / event log | Central event log; optional destructive replay; changed-attribute capture; Postgres advisory locks | 0.8.2 | 2026-09-19 | 62,604 | 22,826 | core (hex owners `ash-project`, `torkan`) | `AshEvents.EventLog`, `AshEvents.Events` |
| 4 | `usage_rules` | LLM agent tooling | Aggregates dependency `usage-rules.md` into AGENTS.md / SKILL.md; docs search | 1.2.8 | 2026-09-07 | 686,589 | 301,065 | core | none (dev dependency, reads other packages' files) |
| 5 | `ash_authentication` | Security | Authentication only (strategies, tokens, sessions, subjects); authorization is Ash core policies | 5.0.0-rc.14 (latest **stable** 4.15.0) | 2026-09-17 | 937,379 | 216,171 | core, but repo is `team-alembic/ash_authentication`; hex owners `ash-project`, `jamesotron`, `joshcprice` | `AshAuthentication`, `.Strategies.*`, `.AuditLogResource` |
| 6 | `ash_oban` | Async work | Run actions in background workers; data-driven triggers and cron scheduling | 0.9.0 | 2026-09-30 | 519,352 | 161,510 | core | `AshOban` ext, `oban do triggers do` |
| 7 | `ash_state_machine` | Domain | Attribute-backed state machine; `transition_state` change; integrates `Ash.can?` | 0.2.13 | 2026-04-13 | 369,000 | 123,291 | core | `AshStateMachine` ext, `state_machine do` |
| 8 | `ash_ai` | LLM / agent | Vectorize attributes, expose actions as LLM/MCP tools, MCP server, LLM actions | 1.1.1 | 2026-09-23 | 258,089 | 100,126 | core | `AshAi` ext, `tools`, `mcp_resources`, `vectorize`, `evaluate` |
| 9 | `ash_archival` | Domain | Soft archive instead of delete; default visibility filter; archive/unarchive actions | 2.0.3 | 2025-11-05 | 403,793 | 88,614 | core | `AshArchival.Resource`, `archive do` |
| 10 | `ash_cloak` | Domain | Transparent attribute encryption/decryption with a vault | 0.4.0 | 2026-08-30 | 230,354 | 86,696 | core | `AshCloak` ext, `cloak do` |
| 11 | `ash_money` | Domain | Money `Ash.Type` + Postgres extension + `Comp` for `%Money{}`; required by `ash_double_entry` (`ash_double_entry/mix.exs:156`) | 0.2.6 | 2026-06-08 | 163,618 | 46,717 | core | `Ash.Type` + `AshPostgres.Extension` |
| 12 | `ash_rate_limiter` | Cross-cutting | Per-actor/action rate limiting with a pluggable backend (Hammer) | 2.0.1 | 2026-08-17 | 104,808 | 43,309 | core | `AshRateLimiter` ext, `rate_limit do` |
| 13 | `ash_typescript` | TS codegen | Generates a typed TypeScript RPC client, Zod schemas, typed controllers/channels | 0.18.4 | 2026-09-29 | 92,766 | 41,363 | core | `AshTypescript.Rpc` (domain), `.Resource`, typed controllers/channels |
| 14 | `ash_double_entry` | Domain | Double-entry accounting: accounts, transfers, balances | 1.0.19 | 2026-09-07 | 75,696 | 21,137 | core | `AshDoubleEntry.{Account,Transfer,Balance}` DSLs |
| 15 | `ash_onetime` | Domain | Idempotency-key and one-time-nonce admission for effectful actions, Postgres-authoritative | 1.4.0 | 2026-09-24 | 2,831 | 2,831 | community (`baselabs`) | `AshOnetime.Resource` ext |
| 16 | `ash_postgres` | Storage | The production data layer (Ecto/Postgres), migrations, references | 2.13.1 | 2026-09-08 | 1,522,717 | 305,291 | core | `Ash.DataLayer`, `postgres`/`references` DSL, `mixin` |
| 17 | `ash_phoenix` | Transport | LiveView/Form/LiveStream integration for Ash resources | 2.3.25 | 2026-08-31 | 1,276,891 | 272,637 | core | `AshPhoenix` ext (`forms do`), `AshPhoenix.Form`/`.LiveView`/`.FilterForm` |
| 18 | `ash_json_api` | Transport | JSON:API server from resources (spec-compliant, core recommendation) | 1.7.1 | 2026-07-07 | 700,777 | 164,474 | core | `AshJsonApi.Domain`, `.Resource` |
| 19 | `ash_admin` | Admin UI | Auto-generated super-admin LiveView dashboard for your domain | 1.3.2 | 2026-09-04 | 521,034 | 119,477 | core | `AshAdmin.Domain`, `.Resource` |
| 20 | `ash_graphql` | Transport | GraphQL server; complex, actively developed | 1.12.0 | 2026-09-18 | 465,613 | 62,537 | core | `AshGraphql.Domain`, `.Resource` |

### Ranked candidates I deliberately cut, and why

- **`ash_commanded` (0.2.0, 880 DL)** — the *only* CQRS option, so it is discussed in depth in §4,
  but 880 all-time downloads, 10 months since release and a compile bug on the published release
  keep it out of the top 20. (Listed with data in §9.)
- **`ash_sqlite` (0.2.19, 13,145 recent)** — real, but a second data layer rather than a domain
  concept, and it is built on the shared `ash_sql` (0.7.6, 325,160 recent) which is not in the list
  either. For Mesh this matters as a *pattern* (a portable data-layer contract with two backends),
  which is `ash-runtime`'s territory.

(`splode` was in this list in round 1 and ranked #20 in round 2; in round 3 it moved to §9
honorable mentions as plumbing — see the ranking rule.)

---

## 6. Per-package notes

Each entry: a real DSL example (copied from the package's own docs), what it adds, maturity/gaps,
and what Mesh would need.

### 1. `reactor` 1.0.7 — sagas

See §1.1 for the DSL. Adds: saga execution over a resource graph, inferred dependencies, async
fan-out, compensation/undo, middleware. Gaps: `undo: :never` is the default, so you get no rollback
unless you configure every step (documented as "the most performant option" but a foot-gun); steps
inside a `transaction` are forced synchronous; `max_retries` must be set manually.
**Mesh equivalent:** a first-class workflow/saga layer with inferred dependency graphs, a
compensation contract per step, a bounded retry policy with a default, and the ability to bind a
saga to a named operation on a resource.

### 2. `ash_paper_trail` 0.7.0 — audit/versioning

DSL in §2.1. Adds: an auto-generated sibling version resource per resource, four change-tracking
modes, actor FKs, operation-id grouping, temporal inline mode. Gaps: destroy handling on Postgres
requires three documented workarounds (§2.1); composite-PK support uses filter-based `has_one`
rather than a `belongs_to`, so there is no single FK to the parent (`getting-started-with-ash-paper-trail.md:118-140`); `:full_diff` cannot be tracked atomically in temporal mode.
**Mesh equivalent:** version/history resources as a first-class generated artefact, with change
tracking and actor attribution built in, and a story for soft-delete that doesn't fight the storage
layer.

### 3. `ash_events` 0.8.2 — event log

DSL in §2.2. Adds: one log table for everything, action versioning and replay routing, derived-value
capture, hook suppression on replay. Gaps: replay is destructive and requires you to implement
`clear_records_for_replay` (§2.2); whether it counts as event sourcing is **contested** — §4.1 gives
both positions; the README itself says it can be used "purely as an audit log system" if you skip
two options (`ash_events/README.md:174-182`). **Mesh equivalent:** an event log with per-event
"declared input vs derived change" separation and a hook-suppression flag on replay.

### 4. `usage_rules` 1.2.8 — agent tooling (**high relevance**)

`usage_rules/README.md:57-90` (abridged: several comments are dropped, and the comment on the
commented-out alternative `usage_rules:` line is reworded from the source's "# If your CLAUDE.md is
getting too big, link instead of inlining:"):

```elixir
defp usage_rules do
  [
    file: "CLAUDE.md",
    usage_rules: [:usage_rules, :ash, ~r/^ash_/],
    # or link instead of inlining when the file gets big:
    # usage_rules: [:ash, {~r/^ash_/, link: :markdown}],
    skills: [
      location: ".claude/skills",
      build: [
        "ash-framework": [
          description: "Use this skill working with Ash Framework or any of its extensions. Always consult this when making any domain changes, features or fixes.",
          usage_rules: [:ash, ~r/^ash_/]
        ],
        "phoenix-framework": [
          description: "Use this skill working with Phoenix Framework. Consult this when working with the web layer, controllers, views, liveviews etc.",
          usage_rules: [:phoenix, ~r/^phoenix_/]
        ]
      ]
    ]
  ]
end
```

What it actually does (`usage_rules/README.md:12-19`): gathers `usage-rules.md` files (or a
`usage-rules/` directory) from your **dependencies** and consolidates them into one agent file,
generates `SKILL.md` files per skill, ships built-in Elixir/OTP rules, and provides
`mix usage_rules.search_docs`. Which packages ship rules today (found on disk,
`find scratch/ash-src -name 'usage-rules*'`): `ash`, `ash_postgres`, `ash_phoenix`, `ash_graphql`,
`ash_oban`, `ash_ai`, `ash_typescript`, `ash_authentication`, `ash_json_api`, `ash_events`,
`ash_money`, `reactor`, `spark`, `igniter`, `usage_rules` itself. `ash` splits its rules into 14
files under `ash/usage-rules/` (`actions.md`, `authorization.md`, `testing.md`, …).
**Mesh equivalent:** every Mesh package should ship a machine-readable rules file, and Mesh's
build should have an equivalent of `usage_rules.search_docs` so an agent can grep the DSL
reference without downloading hexdocs. This is the cheapest, highest-leverage thing in this
document for an LLM-targeted framework.

### 5. `ash_authentication` 5.0.0-rc.14 — security

Extensions: `AshAuthentication`, `AshAuthentication.Strategies.*`, and `AshAuthentication.AuditLogResource`.
DSL example (verbatim, `ash_authentication/documentation/tutorials/get-started.md:183-199`):

```elixir
  authentication do
    tokens do
      enabled? true
      token_resource MyApp.Accounts.Token
      store_all_tokens? true
      require_token_presence_for_authentication? true
      signing_secret fn _, _ ->
        # This is a secret key used to sign tokens. See the note below on secrets management
        Application.fetch_env(:my_app, :token_signing_secret)
      end
    end

    add_ons do
      log_out_everywhere do
        apply_on_password_change? true
      end
    end
  end
```

Adds: strategies (password, OAuth, magic link, API key…), tokens, sessions, the `Subject` concept,
and rate limiting via `AshRateLimiter` (`extensions: [AshAuthentication, AshRateLimiter]` in its own
docs). Maturity: **the current release line is a release candidate**. **Mesh equivalent:** a
pluggable authentication strategy interface and a first-class "subject" concept, with policies
evaluated against it.

### 6. `ash_oban` 0.9.0 — background work

`ash_oban/documentation/tutorials/getting-started-with-ash-oban.md:76-95` (abridged: the `...`
placeholder and four explanatory comments are omitted):

```elixir
defmodule MyApp.Resource do
  use Ash.Resource, domain: MyDomain, extensions: [AshOban]

  oban do
    triggers do
      trigger :process do
        action :process
        where expr(processed != true)
        scheduler_cron "* * * * *"
        on_error :errored
      end
    end
  end
end
```

Needs config wiring: replace `{Oban, your_config}` with
`{Oban, AshOban.config(Application.fetch_env!(:my_app, :ash_domains), your_config)}` (same file).
Adds: running *actions* as jobs (so policies and changes run in the background), plus data-driven
triggers and cron. Gaps: couples you to Oban; domain config is per-domain, not per-action.
**Mesh equivalent:** "run this operation in the background, with this retry policy" as a property of
the operation, decoupled from a specific queue library where possible.

### 7. `ash_state_machine` 0.2.13 — state machines

`ash_state_machine/documentation/tutorials/getting-started-with-ash-state-machine.md`
(stitched from two places — the `state_machine do` block at :140-143 and the action block at
:161-165):

```elixir
state_machine do
  initial_states [:received]
  default_initial_state :received
end

actions do
  update :request_more_information do
    change transition_state(:needs_more_info)
  end
end
```

States live in a status attribute; the extension generates state/transition attributes, restricts
which actions are legal from which state, and (per its docs topic
`documentation/topics/working-with-ash-can.md`) integrates with `Ash.can?` so transitions can be
authorized. Maturity: last release 2026-04-13 (six months stale), still 0.2.x.
**Mesh equivalent:** a lifecycle/state block on a resource with legal-transition enforcement.

### 8. `ash_ai` 1.1.1 — LLM surface

`ash_ai/README.md:243-250` (abridged: `tool :read_comments, MyApp.Blog.Comment, :read` and the
`defmodule MyApp.Blog … use Ash.Domain, extensions: [AshAi]` wrapper around the `tools do` block
are omitted):

```elixir
tools do
  tool :read_posts, MyApp.Blog.Post, :read
  tool :get_post_by_id, MyApp.Blog.Post, :read, get_by: :id
  tool :create_post, MyApp.Blog.Post, :create
  tool :publish_post, MyApp.Blog.Post, :publish
end
```

Also: `vectorize do full_text do text(fn record -> ... end) end; strategy :ash_oban;
embedding_model MyApp.OpenAiEmbeddingModel end` (`ash_ai/usage-rules.md:29-49`), `mcp_resources` for
read-only content (`README.md:283-288`), prompt-backed actions, evaluation actions, a
`ToolLoop.run/2`, and a **pre-built production MCP server** supporting protocol versions
`2026-07-28`, `2025-06-18`, `2025-03-26` with OAuth 2.1 or API-key auth (`README.md:57-115`).
Maturity warning in the README: "We are still experimenting to see what tools (if any) are useful
while developing with agents" about the *dev* MCP server (`README.md:72`), and the MCP roadmap has
sessions "just commented out" (`README.md:82`). **Mesh equivalent:** a way to declare, from the
resource, which actions are agent-callable, plus an MCP/HTTP endpoint that serves them with the same
authorization as any other caller. This is a first-class requirement in the Mesh plan, and AshAi is
the closest prior art by a wide margin.

### 9. `ash_archival` 2.0.3 — soft delete

`ash_archival/documentation/tutorials/get-started-with-ash-archival.md`:

```elixir
defmodule MyApp.Post do
  use Ash.Resource, extensions: [AshArchival.Resource]

  archive do
    archive_related([:comments])
    archive_related_authorize?(false)  # Recommended: bypass authorization for related records
  end
end
```

plus — *optionally* — a `base_filter expr(is_nil(archived_at))` on the domain resource and the
matching `base_filter_sql "(archived_at IS NULL)"` in the Postgres block; both are only needed if
you opt in with `base_filter? true`, because the extension adds its own `is_nil(archived_at)`
preparation by default (`get-started-with-ash-archival.md:38-53`). Adds: archive instead
of destroy, a default filter that hides archived rows everywhere, cascade archiving. Maturity: 2.x,
but last release 2025-11-05 — the stalest of the core packages. **Mesh equivalent:** soft delete
with a *framework-level* default-visibility filter, not something each query must remember.

### 10. `ash_cloak` 0.4.0 — encryption

`ash_cloak/documentation/tutorials/getting-started-with-ash-cloak.md:23-52` (abridged: five
comments are omitted, including the policies sentence on `on_decrypt` quoted below):

```elixir
defmodule User do
  use Ash.Resource, extensions: [AshCloak]

  cloak do
    vault MyApp.Vault
    attributes [:address, :phone_number]
    decrypt_by_default [:address]
    on_decrypt fn records, field, context ->
      Audit.user_accessed_encrypted_field(records, field, context)
      if context.user.name == "marty" do
        {:error, "No martys at the party!"}
      else
        :ok
      end
    end
  end
end
```

The `on_decrypt` doc comment is instructive: "Ash has policies that allow forbidding certain users
to load data. You should generally use those for authorization rules, and only use this callback
for auditing/logging." **Mesh equivalent:** encrypted attribute types with a decrypt hook.

### 11. `ash_money` 0.2.6 — domain

Declared use (verbatim,
`ash_money/documentation/tutorials/getting-started-with-ash-money.md:34-36`):

```elixir
attribute :balance, AshMoney.Types.Money
```

and, to use money in runtime expressions, it must be registered as a known type
(`getting-started-with-ash-money.md:40-43`):

```
config :ash, :known_types, [AshMoney.Types.Money]
```

Adds: an `Ash.Type` for `Money` backed by `ex_money`, an `AshPostgres.Extension` for database-side
money operations, and a `Comp` implementation so Ash can compare `%Money{}` values
(`ash_money/README.md:20-22`). It is ranked (and was kept in the top 20 in round 2) because
`ash_double_entry` declares a hard dependency on it (`ash_double_entry/mix.exs:156`) — cutting a
required dependency of a ranked package was inconsistent. Maturity: 0.2.x; the latest release
requires `ex_money ~> 6.0`, which replaced the `ex_cldr` backends with `localize` (`README.md:24-26`).
**Mesh equivalent:** a money/value type with explicit currency semantics — but note this needs a
`Comp`/`compare` story too, or equality is a silent trap.

### 12. `ash_rate_limiter` 2.0.1 — cross-cutting

Needs a backend started in your supervision tree and wired via config
(`ash_rate_limiter/README.md`): `use Hammer, backend: :ets`, add `{MyApp.Hammer, clean_period:
:timer.minutes(1)}` to children, then
`config :my_app, :ash_rate_limiter, hammer: MyApp.Hammer`. The DSL (verbatim,
`ash_rate_limiter/README.md:104-113`):

```elixir
  rate_limit do
    # Configure hammer backend
    backend MyApp.Hammer

    # Limit create action to 10 requests per 5 minutes
    action :create, limit: 10, per: :timer.minutes(5)

    # Limit read action to 100 requests per minute
    action :read, limit: 100, per: :timer.minutes(1)
  end
```

Extension point: `AshRateLimiter`.
**Mesh equivalent:** a pluggable, per-operation rate-limit policy with a pluggable store.

### 13. `ash_typescript` 0.18.4 — TypeScript codegen (**high relevance**)

See §7 for detail. Adds: a generated TS client per action, field selection, nested relationship
query options, typed query DSLs, typed Phoenix controllers and channels, Zod/Valibot schemas, a
compile-time manifest. **Mesh equivalent:** this is nearly a feature-for-feature blueprint for
Mesh's frontend type layer. See §7 for what to copy and what to change.

### 14. `ash_double_entry` 1.0.19 — domain

Three generated resources — `AshDoubleEntry.Account`, `.Transfer`, `.Balance`
(`ash_double_entry/README.md:24-30`); creating a balance transfer "creates entries for both the
credit and debit accounts and updates all future balances". The README is explicit that this is
deliberately a **separate repo** so "Ash applications that don't need double entry accounting can
safely ignore this" (`README.md:33-36`) — a good packaging principle Mesh should copy.
**Mesh equivalent:** a worked example that proves the framework composes for real accounting
domains.

### 15. `ash_onetime` 1.4.0 — domain

A community package (`baselabs/ash_onetime`), first published 2026-08-09 as 0.1.0 and now at
19 releases (latest 1.4.0, 2026-09-24); its 2,831 downloads accumulated over about seven weeks
(hex API, 2026-10-01). DSL (verbatim from the GitHub README's quick start,
`https://github.com/baselabs/ash_onetime`, "Quick start", the `onetime do` block):

```elixir
  onetime do
    protect :charge do
      strategy :idempotency
      scope([{:static, "charge"}, {:attribute, :account_id}])
      key({:client, :idempotency_key})
      fingerprint(attributes: [:account_id, :amount])
      response(MyApp.ChargeCodec, fields: [:id, :account_id, :amount], classify: MyApp.Classifier)
      retention({24, :hour})
    end

    protect :redeem do
      strategy :one_time_nonce
      scope([{:static, "redeem"}])
      key({:verified, :proof, MyApp.ProofVerifier})
      window(max_age: {5, :minute}, clock_skew: {30, :second})
      commit :independent   # RFC 9449 §11.1 replay fence (omit for the default :with_action)
    end
  end
```

Adds: explicit *admission* semantics for effectful actions — `:idempotency` executes the effect
once per key and replays the stored response verbatim on retries; `:one_time_nonce` authenticates a
single opportunity and rejects every collision. Both the effect and the claim commit inside the
action's existing transaction, and "the unique constraint — not application code — decides
concurrent races". Gaps (README): Postgres is mandatory (no fallback data layer); read-only or
non-transactional actions are rejected; and it does not give end-to-end exactly-once *delivery*,
only once-per-key local admission. Maturity: new, small adoption, but the failure modes it names
are exactly the ones a hand-rolled idempotency table gets wrong.
**Mesh equivalent:** if Mesh ships saga steps that call third parties, an idempotency claim with a
request fingerprint should be a framework primitive rather than an application table.

---

### 16. `ash_postgres` 2.13.1 — storage

Example DSL (verbatim, `ash_postgres/documentation/topics/resources/references.md:13-19`):

```elixir
postgres do
  # other PostgreSQL config here

  references do
    reference :post, on_delete: :delete, on_update: :update, name: "comments_to_posts_fkey"
  end
end
```

Adds: the only production data layer, migrations, DB-level references, multitenancy strategies. Maturity: 2.13.x, very high
adoption, but tied to Postgres/Ecto. **Mesh equivalent:** owned by `ash-runtime`, but Mesh needs at
least one real data layer plus migrations before anything else works.

### 17. `ash_phoenix` 2.3.25 — transport

Extensions: the `AshPhoenix` Spark extension with a `forms do` section that customises the form
code interfaces on a domain (verbatim example from `ash_phoenix/lib/ash_phoenix.ex:133-138`):

```elixir
forms do
  # customize the generated `form_to_create_student` function
  form :create_student, args: [:school_id]
end
```

The main API is `AshPhoenix.Form` — `AshPhoenix.Form.for_create(MyApp.Operations.Service, :create,
as: "service")` then `assign(socket, form: to_form(form))`
(`ash_phoenix/documentation/topics/forms-for-relationships-between-existing-records.md:180-183`) —
plus LiveView helpers, `live_action`s and `has_many` form inputs. Adds: the standard Ash web story. **Mesh equivalent:** out of scope per the Mesh plan
(Marko on the frontend), but the *form* idea — declaring which attributes a UI form accepts,
derived from the resource — is worth porting.

### 18. `ash_json_api` 1.7.1 — transport

`AshJsonApi.Domain` + `AshJsonApi.Resource`. DSL example (verbatim,
`ash_json_api/documentation/tutorials/getting-started-with-ash-json-api.md:145-147`):

```elixir
  json_api do
    type "ticket"
  end
```

Adds: spec-compliant REST. Notable: JSON:API has 2.6× GraphQL's 90-day downloads (164,474 vs
62,537 — it is *not* stalling relative to GraphQL), and its last release is 2026-07-07, three
months stale.
**Mesh equivalent:** HTTP transport is explicitly undecided in the Mesh plan; the lesson is that
the *spec-compliant* transport won adoption.

### 19. `ash_admin` 1.3.2 — admin UI

`AshAdmin.Domain` + `AshAdmin.Resource`. DSL example (verbatim,
`ash_admin/documentation/tutorials/getting-started-with-ash-admin.md:63-68`):

```elixir
use Ash.Domain,
  extensions: [AshAdmin.Domain]

admin do
  show? true
end
```

Auto-generates a LiveView dashboard from the domain.
**Mesh equivalent:** a schema-driven admin/backoffice is a strong argument for a
schema-inspection API at runtime.

### 20. `ash_graphql` 1.12.0 — transport

`AshGraphql` / `.Domain` / `.Resource`. DSL example (verbatim,
`ash_graphql/documentation/topics/graphql-generation.md:36-43`):

```elixir
  graphql do
    type :ticket

    queries do
      # create a field called `get_ticket` that uses the `read` read action to fetch a single ticket
      get :get_ticket, :read
    end
  end
```

Adds: typed GraphQL derived from resources.
**Mesh equivalent:** less relevant if Mesh exposes a typed RPC rather than a query language.

---

---

## 7. `ash_typescript` — extra attention

**What it is:** "Automatic TypeScript type generation for Ash resources and actions […]
Generate type-safe TypeScript clients directly from your Elixir Ash resources"
(`ash_typescript/README.md:17-19`).

**Manifest architecture (0.18.0, the current major line).** AshTypescript "builds a single,
app-wide `Ash.Info.Manifest` at compile time — the source of truth that both codegen and the
runtime RPC pipeline read from" and "**Codegen and the pipeline raise if `manifest` is not
configured**" (`README.md:29-33`). Migration requires Ash 3.27+:

```elixir
defmodule MyApp.AshTypescriptManifest do
  use AshTypescript.Manifest, otp_app: :my_app
end

config :ash_typescript, manifest: MyApp.AshTypescriptManifest
```
(`README.md:38-48`; the source has these as two blocks — the module and the config line, each with a
file-path comment above it — merged here, comments dropped)

**How a typed client works.** You declare an RPC surface in your **domain** (verbatim,
`documentation/getting-started/installation.md:151-162`), then run `mix ash_typescript.codegen`
(`installation.md:224-230`):

```elixir
  typescript_rpc do
    resource MyApp.Todo do
      rpc_action :list_todos, :read
      rpc_action :get_todo, :read, get_by: [:id]
      rpc_action :create_todo, :create
      rpc_action :update_todo, :update
      rpc_action :destroy_todo, :destroy
    end
  end
```

Referenced actions are verified `public? true` at compile time (`README.md:135-137`). Per-action
options in the `rpc_action` entity include `get?`, `get_by`, `identities` (defaults to
`[:_primary_key]`), `allowed_loads` / `denied_loads`, `enable_filter?` / `enable_sort?`,
`show_metadata`, `not_found_error?`, `read_action` (`lib/ash_typescript/rpc.ex:150-220`); the
section also holds `typed_queries` (`rpc.ex:225-246`).

The generated file gives one typed function per action (verbatim,
`documentation/getting-started/first-rpc-action.md:53-71`):

```typescript
import { createTodo } from './ash_rpc';

async function addTodo(title: string) {
  const result = await createTodo({
    fields: ["id", "title", "completed"],
    input: {
      title: title
    }
  });

  if (result.success) {
    console.log("Created:", result.data);
    return result.data;
  } else {
    console.error("Failed:", result.errors);
    return null;
  }
}
```

`get_by: [:id]` produces a `getTodo({ getBy: { id } })` signature (same file, `:77-92`). Field
selection is nested and type-inferred (verbatim, same file, `:99-109`):

```typescript
const result = await getTodo({
  fields: [
    "id",
    "title",
    {
      user: ["name", "email"],
      tags: ["name", "color"]
    }
  ],
  getBy: { id: "123" }
});
```

Since 0.18, relationship query options are generated and **capability-gated in the types**
(`README.md:67-99`):

```typescript
const todo = await getTodo({
  input: { id: todoId },
  fields: ["id", { comments: { page: { limit: 20, offset: 0, count: true },
                               filter: { rating: { greaterThan: 2 } },
                               sort: "-rating",
                               fields: ["id", "content", "rating"] } }],
});
```

`page` only appears when the relationship's read action has pagination; `filter`/`sort` only when
the relationship is filterable/sortable and the RPC action doesn't disable them. `page` and bare
`limit`/`offset` are mutually exclusive. Envelopes nest to any depth and respect
`allowed_loads`/`denied_loads`.

**Beyond the client:** Zod and Valibot schemas (opt-in via `generate_zod_schemas` /
`generate_valibot_schemas`, written to `ash_zod.ts` / `ash_valibot.ts` and covering resources, RPC
actions and typed-controller routes — `rpc.ex:324-325`, `documentation/reference/configuration.md:40-45` (the two
`generate_*` flags) and `:136-140` (the output-file table)), typed Phoenix controllers and channels (`lib/ash_typescript/typed_controller/`, `typed_channel/`), multitenancy, Phoenix LiveView integration, typed query DSLs, and a JSON manifest for third-party integrations (version `1.1`, `README.md:87`).

### 7.1 The wire transport (0.18.4)

Everything below was checked in the clone at `scratch/ash-src/ash_typescript` (v0.18.4).

**Endpoints.** Exactly two POST routes, `/rpc/run` and `/rpc/validate`, served by a controller the
installer generates (`documentation/getting-started/installation.md:69-75`). The controller is four
lines (verbatim, `installation.md:172-184`):

```elixir
  def run(conn, params) do
    result = AshTypescript.Rpc.run_action(:my_app, conn, params)
    json(conn, result)
  end

  def validate(conn, params) do
    result = AshTypescript.Rpc.validate_action(:my_app, conn, params)
    json(conn, result)
  end
```

Both paths are configurable via `run_endpoint` / `validate_endpoint`
(`installation.md:212-221`). The `otp_app` argument **does not scope which actions are reachable**:
"actions are resolved from the single manifest in `config :ash_typescript, manifest:`, so passing a
different `otp_app` does not restrict — or widen — the set of reachable actions"
(`lib/ash_typescript/rpc.ex:666-671`).

**Request shape.** Every generated function builds a JSON payload starting with
`action: "<rpc_action_name>"`, plus — depending on the action — `tenant`, `identity` (for
update/destroy), `getBy`, `input`, `fields`, `filter`/`sort`/`page` and `metadataFields`
(`lib/ash_typescript/rpc/codegen/helpers/payload_builder.ex:48-110`). Typed queries send
`typed_query_action` instead of `action` (`lib/ash_typescript/rpc/pipeline.ex:381-390`). Server
side, `parse_request/4` pops `input` and `identity`, converts the remaining keys with the
configured `input_field_formatter` (camelCase by default, `installation.md:219`), and takes actor,
tenant and context from the Plug conn or the socket assigns (`pipeline.ex:59-82`), before
validating required parameters, fields, input, `get_by` and pagination (`pipeline.ex:59-140`).

**Response shape.** Always a map, never a tuple: `%{"success" => true, "data" => …}` or
`%{"success" => false, "errors" => [...]}`; key casing follows `output_field_formatter`
(`rpc.ex:673-686`, `run_action/3` at `:686-695`).

**Errors.** Each error carries `type`, `message`, `shortMessage`, `vars`, `fields`, `path` and an
optional `details` map (`documentation/guides/error-handling.md:36-52`). Client-side, a non-2xx
HTTP response is turned into a synthetic `network_error` with `statusCode`
(`lib/ash_typescript/rpc/codegen/typescript_static.ex:529-547`). Since 0.18, an unusable top-level
`filter`/`sort`/`page` returns `filter_not_supported` / `sort_not_supported` /
`pagination_not_supported` rather than being dropped (`README.md:49-53`).

**Field selection and typed results.** `fields` is an array of attribute names plus nested objects
for relationships (`first-rpc-action.md:99-109`), and the generated runtime carries utility types
(`TypedSchema`, `InferResult`) that derive the result type from the selected fields
(`typescript_static.ex:10-13`). Relationship envelopes (`page`/`filter`/`sort`/`fields`) are gated
in the types by capability (`README.md:55-87`).

**Fetch layer.** `executeActionRpcRequest` / `executeValidationRpcRequest` POST with
`Content-Type: application/json`, merge `headers` and `fetchOptions` from the call config, and use
`config.customFetch || fetch` (`typescript_static.ex:433-552`). `fetchOptions` (e.g.
`AbortSignal.timeout`, `credentials`) and `customFetch` (e.g. an axios adapter) are documented in
`documentation/advanced/custom-fetch.md:10-30`. A `buildCSRFHeaders()` helper is generated for
browser apps (`first-rpc-action.md:20-23`, `:150-158`).

**Lifecycle hooks.** Configured by name — `rpc_action_before_request_hook`,
`rpc_action_after_request_hook`, `rpc_validation_before_request_hook`,
`rpc_validation_after_request_hook`, all default `nil` (`documentation/features/lifecycle-hooks.md:57-70`).
The before-hook receives `(action, config)` and returns a modified config; the after-hook receives
`(action, response, result, config)` (`typescript_static.ex:471-480`). Channel equivalents are
generated too (`typescript_static.ex:555-560`).

**Validation functions.** `validate<Action>` functions are generated when
`generate_validation_functions: true` (`documentation/guides/form-validation.md:159-165`). They POST
to `/rpc/validate`, which builds the changeset or query *without executing it* and returns
`{success: true}` or the same error array as `run_action/3`
(`form-validation.md:159-215`; server side `rpc.ex:704-717`).

**Typed controllers.** `use AshTypescript.TypedController` with a
`typed_controller do module_name …; get :auth do run fn conn, params -> … end end … end` DSL
generates an ordinary Phoenix controller plus TypeScript path helpers and typed fetch functions
(`documentation/guides/typed-controllers.md:9-16`). Route `argument`s are validated, and since 0.18
enforced at runtime with 422s; router path params must match arguments
(`typed-controllers.md:450-456`, `README.md:97`). Intended for cookie/session-style endpoints "where
an rpc action isn't a natural fit" (`typed-controllers.md:14-16`).

**Multitenancy.** With `require_tenant_parameters: true` a `tenant` parameter is required in every
generated signature; with the default `false` it is optional and otherwise taken from the conn
(`documentation/features/multitenancy.md:18-36`; fallback
`normalized_params[:tenant] || Ash.PlugHelpers.get_tenant(conn)` at `pipeline.ex:77-81`).

**Stated limits.** Ash ≥ 3.27 and a manifest module are required (`README.md:26-29`). A type
module with no TypeScript mapping fails compilation outright — "Unsupported types found"
(`documentation/advanced/custom-types.md:95`). A hand-rolled `use Ash.Type` module whose
`storage_type/1` has no unambiguous JSON form degrades to `z.any()` / `z.record(z.string(), z.any())`
in schemas unless you express it as an `Ash.Type.NewType` or set a mapping override
(`documentation/reference/troubleshooting.md:221-240`). An Ash version bump alone can change
generated output (`README.md:102`). Open issues: #100 (destroying a nonexistent record reports
success), #95 (the igniter installer creates invalid routes), #84 (control over custom-type
generation), #51 (TanStack Query factories requested). And there is no UI-facing authorization
metadata — the maintainer's workaround is a hand-written generic action around `Ash.can?`
(https://elixirforum.com/t/ash-typescript-pass-list-of-available-policies-to-the-user/73730).

**Limits and sharp edges (all from `README.md:29-140`):**

- Hard requirement on Ash `~> 3.27` plus a manifest module; both codegen and the runtime raise
  without them.
- **Breaking:** a top-level `filter`/`sort`/`page` the action cannot honour now returns
  `filter_not_supported` / `sort_not_supported` / `pagination_not_supported` instead of being
  silently dropped. "Generated TypeScript clients are unaffected — the generated types never offered
  these parameters where they were unusable. Hand-crafted or stale clients that relied on silent
  dropping must remove the parameters."
- Multi-file output since 0.16: types and Zod schemas moved to `ash_types.ts` / `ash_zod.ts`;
  `import_into_generated` paths became project-root-relative.
- Type-level churn: aggregates `avg`/`max`/`min`/`first`/`sum` became `T | null`; `count`/`exists`/
  `list` lost `isNil`; update actions' `input` is now optional; typed-map members holding embedded
  resources require nested field selection; field/type ordering is now alphabetical and
  deterministic ("expect a large but purely cosmetic diff the first time you regenerate").
- "Generated output now derives filter operators, input requiredness, aggregate nullability, and
  sortability from Ash's manifest generator, so an Ash version bump alone can change generated
  TypeScript." — a real long-term maintenance hazard.
- Zod strings get `min(1)` from Ash's default `allow_empty?: false`, so empty-string valid domains
  must declare `constraints: [allow_empty?: true]`.

---

## 8. `ash_ai` and `usage_rules` — extra attention (LLM agents)

Both exist because **the Ash team treats LLM agents as a first-class consumer of the framework's
API surface**, and both solve a different half of the problem:

| | `usage_rules` | `ash_ai` |
|---|---|---|
| Problem solved | an agent does not know the framework's conventions | an agent cannot *call* the domain |
| Mechanism | aggregate dependency `usage-rules.md` into `AGENTS.md` / `SKILL.md` | declare actions as tools; serve over MCP |
| Install | `mix igniter.install usage_rules` | `mix igniter.install ash_ai` |
| Output | prose + doc search for humans and LLMs | a live MCP/JSON endpoint |
| Cost | dev-only dependency | production code |

**How Ash packages ship rules for LLMs.** The convention is a root-level `usage-rules.md` (or a
`usage-rules/` directory of topic files) in the package root; `usage_rules` finds them through the
project's dependency graph and concatenates. Found on disk in the Ash ecosystem: `ash` (plus 14
topic files under `ash/usage-rules/`), `ash_postgres`, `ash_phoenix`, `ash_graphql`, `ash_oban`,
`ash_ai`, `ash_typescript`, `ash_authentication`, `ash_json_api`, `ash_events`, `ash_money`,
`reactor`, `spark`, `igniter`, `usage_rules` itself. They are written as *normative instructions*,
e.g. `ash/usage-rules.md:11`:

> Ash is an opinionated, composable framework for building applications in Elixir […] Read
> documentation *before* attempting to use its features. Do not assume that you have prior knowledge
> of the framework or its conventions.

and `ash_ai/usage-rules.md` opens the same way for the AI package, then proceeds to
vectorization/tooling/prompt-actions/MCP. Ash repos also carry a conventional `AGENTS.md`
(`ash_ai/AGENTS.md` documents test commands, `mix check` = format + credo + dialyzer + sobelow).
The command that actually writes the files is `mix usage_rules.sync` (`usage_rules/README.md:89-95`):
"The config is the source of truth — packages in the file but not in config are automatically
removed on each sync." The same README also warns that agents decide when to auto-load a skill
from its `description:`, so descriptions should carry observable signals ("Load when any file uses
Ash.Resource or when debugging Ash.Error.Forbidden") rather than generic topic labels (`:87`).

The `skills:` config turns *groups* of packages into one agent skill with a trigger description —
exactly the shape of the skills this session is running under.

**What `ash_ai` adds on top** (`ash_ai/README.md`): `vectorize` (text → embeddings, with
`strategy :ash_oban` for re-embedding), `tools` (actions → LLM tools; domain-level or resource-level),
`mcp_resources` (read-only content for the LLM to reference), prompt-backed actions, evaluation
actions, `AshAi.build_tools_and_registry/1`, `AshAi.ToolLoop.run/2` / `.stream/2`, a dev MCP plug
(`AshAi.Mcp.Dev`) and a production MCP server with OAuth 2.1 (`ash_authentication_oauth2_server`)
or API keys, speaking protocol versions `2026-07-28`, `2025-06-18`, `2025-03-26`.

Important design notes. First, a tool returns **public attributes by default**, and `load:` can add
relationships/calculations *including private attributes* (`ash_ai/README.md:318-330`) — so public
vs private declaration controls *field visibility*, not authorization. Second, and correcting an
overstatement from round 1: the MCP plug "loads the user from the token's `sub` claim and sets it as
the conn's actor, so your tools run with the authenticated user just like any other Ash request",
with verified claims (including granted scopes) on `conn.assigns.oauth_claims`
(`ash_ai/README.md:133-137`). **Authorization is the ordinary Ash policy path**, inherited
unchanged by tools; public/private only decides which fields come back.

---

## 9. Honorable mentions (not in the 20)

| Package | Version / released | DL all / 90d | Why notable |
|---|---|---|---|
| `ash_authentication_phoenix` | 3.0.0-rc.11, 2026-09-17 | 816,451 / 182,944 | LiveView integration for auth; also an RC |
| `ash_authentication_oauth2_server` | 0.3.1, 2026-09-07 | 26,665 / 18,513 | OAuth 2.1 auth server built to host MCP servers |
| `ash_commanded` | 0.2.0, 2025-12-08 | 880 / 154 | the only CQRS binding; see §4 |
| `ash_sqlite` | 0.2.19, 2026-09-05 | 42,141 / 13,145 | second data layer, proves the data-layer contract |
| `ash_csv` | 0.9.9, 2026-09-07 | 35,917 / 5,523 | CSV import/export as a data layer |
| `ash_slug` | 0.2.1, 2025-02-11 | 24,348 / 4,238 | `change slugify(:text, into: :text_slug)` |
| `smokestack` | 0.9.2, 2025-01-30 | 46,612 / 9,328 | deprecated by its author; HL3 license |
| `splode` | 0.3.2, 2026-08-06 | 1,810,058 / 670,174 | structured errors behind every Ash result |
| `ash_geo` | 0.3.0, 2024-07-31 | 76,196 / 16,929 | geography types; dormant |
| `ash_diagram` | 0.2.2, 2026-07-02 | 31,686 / 8,653 | visualises resources/relationships |
| `ash_uuid` | 1.1.2, 2024-11-04 | 28,260 / 2,708 | UUIDv7/ULID types |
| `ash_credo` | 0.18.0, 2026-09-19 | 47,947 / 29,661 | static-analysis rules for Ash code (`leonqadirie/ash_credo`) — relevant to the "rules for agents" story |
| `ash_appsignal` | 0.2.4, 2026-04-30 | 96,844 / 9,308 | official APM integration, sibling of `opentelemetry_ash` |
| `ash_grant` / `ash_rbac` | 0.22.0 / 0.6.1 | 4,209 / 1,785; 11,459 / 1,182 | third-party permission/RBAC layers on top of Ash policies |
| `ash_flow` | 0.1.1, 2024-05-11 | 35,074 / 1,555 | official, soft-deprecated predecessor of Reactor; see §1.3 |
| `ash_jason` | 3.1.0, 2026-03-04 | 60,503 / 5,549 | Jason codec extension |
| `ash_oaskit` | 0.4.2, 2026-09-16 | 1,303 / 874 | OpenAPI kit helper |
| `igniter` | 0.8.4, 2026-09-07 | 2,431,786 / 663,096 | code-generation engine; demoted out of the top 20 — infrastructure, not domain |
| `spark` | 2.7.3, 2026-09-15 | 2,218,374 / 441,876 | the DSL engine itself; demoted out of the top 20 — infrastructure, not domain |
| `opentelemetry_ash` | 0.1.4, 2026-09-21 | 110,243 / 45,245 | OTel instrumentation for actions |
| `ash_pagify` | 1.5.3, 2026-08-14 | 24,053 / 4,924 | cursor pagination helpers |
| `ash_scylla` | 1.11.0, 2026-09-14 | 3,612 / 2,705 | ScyllaDB data layer |
| `ash_arcadic` | 1.1.0, 2026-08-23 | 297 / 297 | ArcadeDB data layer (OpenCypher) |
| `ash_feistel_cipher` | 1.1.2, 2026-07-27 | 22,850 / 4,634 | reversible token/value objects (`devall-org`) |
| `ash_translation` | 0.2.6, 2026-04-04 | 8,084 / 3,037 | i18n for resources |
| `ash_jido` | 1.0.1, 2026-08-12 | 5,821 / 5,130 | bridge to the Jido agent framework |
| `ash_workflow` | 0.8.0, 2026-09-30 | 210 / 210 | human-in-the-loop workflows; see §1.3 |
| `ash_event_log` | 0.1.5, 2026-08-31 | 1,507 / 910 | Ash audit log; first released 2026-04-23, i.e. *after* `ash_events` 0.1.0 |
| `ash_scenario` | 0.6.1, 2026-02-03 | 1,838 / 355 | reusable test-data generation with dependency resolution |
| `ash_random_params` | 0.2.1, 2025-10-11 | 7,593 / 4,914 | random action params for tests |
| `ariadne_flow` | 0.11.0, 2026-10-01 | 2,427 / 2,427 | event sourcing for Elixir, not Ash-specific; see §4.3 |
| `reactor_file` | 0.18.5, 2026-09-16 | 3,362 / 818 | official Reactor step pack: filesystem |
| `reactor_req` | 0.1.7, 2026-02-15 | 6,992 / 1,224 | official Reactor step pack: HTTP |
| `reactor_process` | 0.5.0, 2026-09-16 | 819 / 177 | official Reactor step pack: OTP processes |

---


### Notes on the demoted infrastructure packages

**`igniter` 0.8.4 — codegen/DX** (not ranked)

`mix igniter.install ash ash_postgres`, `mix igniter.new my_project --install ash,ash_postgres`
(`ash/documentation/topics/development/generators.md:16-40`). Adds: composable
install-and-modify generators; every package's installer is an igniter task (e.g.
`AshTypescript` writes the manifest module and config automatically,
`ash_typescript/lib/mix/tasks/ash_typescript.install.ex`). It is the basis for reactor's tutorial project generator
(`reactor/documentation/tutorials/01-getting-started.md:47`), and is an `ash-project` package
(hex owner `ash-project`, not third-party).
**Mesh equivalent:** a scaffold generator is table stakes; ideally one that edits `.mx` files
rather than writing boilerplate.

**`spark` 2.7.3 — DSL engine** (not ranked)

Every extension in this list is a `Spark.Dsl.Extension` (e.g.
`ash_typescript/lib/ash_typescript/rpc.ex:282`: `use Spark.Dsl.Extension, sections: [@rpc]`).
**Mesh equivalent:** this is `ash-dsl-ext`'s topic, but the headline is: a declarative DSL is only
cheap to extend if someone has already built the extension engine. MX ships with the compiler, so
Mesh gets this for free *only if* the MX entity/transformer/verifier model is at least as capable as
Spark's.

## 10. Gaps — what the ecosystem does not cover well

Every item here is backed by a repository document, a GitHub issue or a forum thread. Where I could
not find evidence, I say so instead of asserting it.

1. **No mature shared library of reusable test generators.** The community factory DSL
   (`smokestack`) is deprecated by its own author in favour of `Ash.Generator` + `Ash.Seed`
   (`smokestack/README.md:6-7`), is HL3-FULL licensed, and has had no release since 2025-01-30. The
   recommended practice is a home-grown `use Ash.Generator` module per app
   (`ash/lib/ash/generator/generator.ex:13-40`). Reusable generators *do* exist —
   `ash_scenario` 0.6.1 (1,838 all-time / 355 recent, `marot/ash_scenario`) offers "Reusable test
   data generation … with dependency resolution" — but at 355 recent downloads it is not mature.
   There is still no fixture or snapshot story. (Sources: hex API 2026-10-01, `smokestack/README.md`.)
2. **No built-in way to hydrate a historical AshPaperTrail version back into a resource struct.**
   Asked directly, Zach Daniel answered "There is nothing built in for that, no", suggesting
   instead a hand-written calculation over `:snapshot` mode:
   https://elixirforum.com/t/are-there-any-best-practices-for-referencing-versioned-resources/75012
   (2026-04-14/15).
3. **AshPaperTrail does not support bulk actions or non-resource actors, and does not scrub
   sensitive inputs.** Open issues:
   https://github.com/ash-project/ash_paper_trail/issues/40 (bulk actions),
   https://github.com/ash-project/ash_paper_trail/issues/104 (non-referenced actors),
   https://github.com/ash-project/ash_paper_trail/issues/30 (redact `sensitive` values from stored
   inputs/changes),
   https://github.com/ash-project/ash_paper_trail/issues/171 (errors with managed relationships).
   Only one actor can be recorded per version:
   https://elixirforum.com/t/how-to-pass-second-actor-parameter-to-the-ash-paper-trail/69322
   (2025-02-10).
4. **Approval / draft-then-publish workflows have no package; people bend AshPaperTrail into it.**
   https://elixirforum.com/t/manager-approval-workflow-with-ash-paper-trail-for-record-changes/67343
   (2024-11-08; older than 2025, cited as an example of the workaround).
5. **AshEvents edge cases with generated primary keys and manual/around hooks.** Replay fails with
   "No such input `id`" for auto-generated primary keys; the maintainer's workaround is to make `id`
   writable and accepted:
   https://elixirforum.com/t/ashevents-no-such-input-id-for-action-how-to-handle-auto-generated-primary-keys/73950
   (2026-01-13/15). Open issues: https://github.com/ash-project/ash_events/issues/101 (bulk update
   + `around_action` raises `InvalidReturnType`, 0.8.1+) and
   https://github.com/ash-project/ash_events/issues/99 (in 0.8.1 a declared `manual` action was
   *silently discarded* with no compile warning; 0.8.2 rejects the combination at compile time —
   `ash_events/lib/events/transformers/wrap_actions.ex:51,264`; the issue is still open).
   No snapshots: a user looking for one found nothing, in the same thread as the ES debate
   (https://elixirforum.com/t/ashevents-event-sourcing-made-simple-for-ash/70777, posts #2, #3,
   #7-#11, 2025-05).
6. **The only CQRS/ES binding is broken on its latest published release.** 0.1.0 did not compile;
   0.2.0 fails generating aggregates; the fix was merged 2026-05-12 but never released; process
   managers are unaddressed (the author recommends Reactor instead).
   https://elixirforum.com/t/ashcommanded-a-declarative-cqrs-es-extension-for-ash/70900
   (2025-11 to 2026-02);
   https://github.com/accountex-org/ash_commanded/pull/7.
7. **Durable workflows are hand-assembled, and persistence is fragile.** Reactor supports
   halt/resume (`reactor/documentation/tutorials/reactor-cheatsheet.cheatmd:53-55`) and the
   documented pattern is Reactor + Oban with persistence left to the application. The *mechanism*
   behind the fragility is in Spark's source: when a DSL block lifts an anonymous function into a
   generated module function, the name is `"#{key}_…_generated_#{fn_name}"` where `fn_name` is the
   **MD5 hash of the function's AST** (`spark/lib/spark/code_helpers.ex:332-336`,
   `code_identifier/1` at `:15-21`). A persisted reactor therefore names steps by content hash, and
   editing a step's body changes its identity, so a persisted run does not survive the redeploy.
   (The issue filed on this — https://github.com/ash-project/reactor/issues/334, 2026-08-14 — was
   opened by mistake by an AI agent and closed `not_planned` the same day, so it is *not* evidence
   of a community complaint; the source above is the evidence.) Users asking for a workflow engine
   with persistence and manual approval steps are pointed at Reactor + Oban, with persistence still
   theirs to build:
   https://elixirforum.com/t/any-tips-on-building-a-workflow-engine-similar-to-n8n/71782
   (posts #10, #14, 2025-07/08). There is no first-party durable saga engine.
8. **The generated TypeScript client carries no authorization metadata for UI gating.** To tell the
   frontend what a user may do you must hand-write a generic action around `Ash.can?`:
   https://elixirforum.com/t/ash-typescript-pass-list-of-available-policies-to-the-user/73730
   (2025-12-22). Also open: destroying a record that does not exist reports success —
   https://github.com/ash-project/ash_typescript/issues/100.
9. **Storage-agnostic behaviour is thinner than it looks.** `ash_sqlite` exists but several
   features are Postgres-shaped: AshPaperTrail's destroy story needs `on_delete: :delete` mixins or
   soft destroys (`ash_paper_trail/documentation/tutorials/getting-started-with-ash-paper-trail.md:118-160`)
   and AshMoney ships an `AshPostgres.Extension` (`ash_money/README.md:17-23`). AshArchival is
   *not* an instance — `base_filter` is optional and the extension adds its own
   `is_nil(archived_at)` filter by default; `base_filter_sql` is only needed if you opt in with
   `base_filter? true` (`ash_archival/documentation/tutorials/get-started-with-ash-archival.md:38-53`).
10. **Authorization ergonomics are a recurring community build.** `ash_grant` 0.22.0 (4,209 all /
    1,785 recent) and `ash_rbac` 0.6.1 (11,459 / 1,182) both exist as third-party permission layers
    built on top of Ash policies rather than as part of them (hex API 2026-10-01) — *my inference
    from their existence, not a sourced community complaint*; note also that `ash_rbac`'s last
    release is 2024-10-01, i.e. it is dormant, which weakens the "recurring demand" reading.

---

## Implications for Mesh (researcher's analysis)

Everything below is my own reading, not a fact from the sources.

**1. The four mandatory areas are four separate extension categories in Ash, and Mesh should not
merge them.** Reactor's saga model (graph, compensation, undo, middleware) has no analogue in
AshPaperTrail or AshEvents, and the audit packages know nothing about sagas. A Mesh design that
tries to make `history` a mode of `workflow` (or vice versa) will end up with Reactor's awkward
edges. Keep them orthogonal: a saga *orchestrates* operations; a version log *records* what
operations did.

**2. Copy Reactor's compensation/undo split verbatim.** The distinction — `compensate` answers
"the step failed, retry or continue?"; `undo` answers "the step succeeded but a later one failed,
roll it back?" — is the cleanest part of the whole ecosystem, and it maps perfectly onto
JavaScript's async/await. Ash.Reactor's `undo_action` convention (a create is undone by the
resource's `destroy`; an update by an update taking the original changeset; a destroy by a create
taking the record) is a good default, and Mesh's "equivalent" is natural: declare `undoFor: "destroy"`
on the operation and the framework finds it. But take Reactor's warning seriously — **ship a
default `max_retries`, do not make it opt-in** (`reactor/.../02-error-handling.md:610`). And consider
defaulting `undo` to `:always` in a framework targeting TypeScript, since Reactivity is cheap and
the surprise of half-compensated state is expensive.

**3. Compiled-away dependencies are the right model.** Reactor infers the DAG from `argument`
declarations at compile time and refuses cycles before runtime
(`reactor/documentation/explanation/architecture.md`). Do the same in MX: `dependsOn: [otherStep]`
(or better, derived from the arguments a step reads) with a build-time cycle error. The user should
never write a step order.

**4. `ash_typescript` is the blueprint, but Mesh should invert one decision.** AshTypescript's
generated client is a set of *one function per action* with a `fields` selector — essentially
GraphQL-lite over a POST endpoint. That is correct and I would copy the shape. But note the 0.18
changelog's own lesson: generated types changed materially when *Ash itself* changed
("an Ash version bump alone can change generated TypeScript"). Mesh should pin the generated
output to the resource manifest's own version and fail loudly on mismatch rather than silently
regenerating differently — the churn was framed as "mostly type-level… purely cosmetic", which is
exactly the kind of change that breaks a downstream TS build for no domain reason. Also copy the
0.18 strictness decision: **reject a `filter`/`sort`/`page` the operation cannot honour instead of
silently dropping it.** Silent dropping is a correctness hazard that will surface as a missing-ordering
bug report.

**5. Make the agent surface a first-class compile target, not a bolt-on.** `ash_ai` + `usage_rules`
together are the single most transferable idea here. Ash's insight is that an LLM has two separate
needs — *knowing the conventions* and *calling the domain* — and they have different answers
(prose/AGENTS.md vs MCP tools). For Mesh, the equivalent is: (a) every Mesh package ships a
machine-readable rules file and Mesh has a docs-search task for agents, and (b) Mesh generates
MCP/JSON tool definitions **from the resource manifest**, so exposing an operation to an agent is a
one-line declaration with authorization inherited from the operation's own policy. Correcting an
overstatement I made in round 1: in AshAi, public/private attributes are *not* the security
boundary — the MCP plug "loads the user from the token's `sub` claim and sets it as the conn's
actor, so your tools run with the authenticated user just like any other Ash request"
(`ash_ai/README.md:133-137`), so ordinary policies decide what a tool may do, and public/private
only decides which fields come back. Mesh should copy that: every generated tool call runs as the
caller's own identity through the same policy path as any other call. Public/private field markers
are still worth having (they are what the LLM sees), but they must not be relied on as the
authorization check.

**6. Follow `ash_double_entry`'s packaging rule.** Its README argues a specialized domain feature
should live in its own repo so the core stays clean. For Mesh this argues for: keep the framework
core (resource, action, changeset, policy, saga, audit) in one language package, and put money,
double-entry, auth, admin in separate ones that depend only on the core. The counter-consideration
is that Ash's high-value packages (`ash_postgres`, `ash_phoenix`) are where the adoption is, so
Mesh should ship at least one first-party storage and one first-party HTTP binding.

**7. Testing: do not build a factory DSL.** Ash's own ecosystem converged on property-based
generation over factories, and the community factory package deprecated itself. Mesh should ship:
a generator concept derived from the resource (optional overrides, "give me a valid instance"),
a seed path that bypasses actions for fixture speed, and a policy-testing primitive equivalent to
`Ash.can?` (a pure function `can(resource, operation, actor, input) → {ok} | {error}` that tests can
assert on directly). The property-based part matters most: generating *valid inputs from the schema*
and asserting the operation accepts them catches whole classes of bugs that example-based tests miss,
and it needs no extra library in JS (fast-check is the obvious choice).

**8. Do not chase full event sourcing — but understand why the maintainers claim it anyway.** My
verdict on §4.1: AshEvents is functionally an **audit log with optional rebuild**, because the
resource tables remain the source of truth and replay is destructive. Daniel's claim (events
committed first, transactionally, so a projection can be rebuilt) is the standard ES argument and
is not *wrong* — but note it describes the May-2025 version (his post links the create wrapper at
v0.1.1), and in 0.8.2 the event is written first only for *updates*: creates and destroys write
the row first and the event second, inside the same transaction (§4.1). Either way the thing that
is rebuildable here is the resource tables — and those were primary all along, which is exactly
katafrakt's point: "the state is still a primary concept and events are secondary" (§4.1). It is ES-shaped infrastructure with a state-store-primary model. For
Mesh, the practical conclusion is unchanged and is worth stating precisely: ship the event log with
AshEvents' two best ideas (declared input vs derived change separation; hook suppression on replay),
be honest that the tables are the source of truth, and do not build a projection model until
someone asks. The one thing worth borrowing from the ES framing is the *ordering guarantee* — commit
the event in the same transaction as the state change, which is exactly what AshEvents does and what
makes a future projection migration possible at all. CQRS/projections can be a later package; the
evidence says it is a niche.

**9. Prioritise accordingly.** If I had to pick five things for a Mesh MVP, from this ecosystem:
Reactor's saga model, AshPaperTrail's change tracking, `Ash.Generator` + `Ash.can?`-equivalent
testing, `ash_typescript`-style codegen, and the `usage_rules` agent surface. That is roughly what
the Ash team themselves treats as core.

**10. Durability is a composition problem, not a solved problem — design the seams.** The evidence in
§10.7 is that everyone assembles the same three pieces by hand: Reactor for in-process compensation
and halt/resume, AshOban for the durable queue, and a state-machine resource for the durable state.
The sharpest illustration is name stability: Spark names a lifted anonymous function after the MD5
of its AST (`spark/lib/spark/code_helpers.ex:15-21,332-336`), so a step's identity is its content,
and a persisted saga breaks on redeploy when any step body changes. A saga engine that survives a
deploy needs steps addressed by stable identity, not by content hash. Mesh should make that a
first-class design constraint even if it does not ship a durable saga engine.

**11. Ship a shared, versioned generator library — the gap is maturity, not absence.** `ash_scenario`
exists and is tiny (355 recent downloads). A framework whose testing story is "write your own
`use Ash.Generator` module" will fragment. A reusable-gens package with a stable DSL is cheap to build
and removes the main incentive to write a factory framework from scratch.

**12. Copy the "no silent drops" contract and be stricter than AshTypescript was.** §10.8 shows the
other side of the same coin: the generated TS client cannot tell a UI what the user may do, so people
hand-write a generic action around `Ash.can?`. If Mesh's codegen emitted per-operation capability
metadata alongside the client — "this actor can do X" — the frontend could gate the UI without a
hand-written shim. Capability metadata is cheap at build time and expensive to retrofit, so it should
be generated from day one, not added after the first authorization bug.

---

## Open questions

- **Downloads vs. real usage.** hex.pm download counts count CI resolution, not applications; the
  ranking rule mitigates but does not eliminate this. I did not verify any download count against
  a registry of real apps.
- **`ash_paper_trail` temporal-inline mode `:full_diff`.** The docs say it "cannot be tracked
  atomically, as before" (`getting-started-with-ash-paper-trail.md:372`); I did not read the
  transformer to confirm whether it errors or silently degrades.
- **Whether `ash_archival` being 10 months stale is a signal or noise.** Its last release is
  2025-11-05 yet it still has 88,614 recent downloads; it may simply be stable.
- **Version alignment.** There is no shared version line to survey: Ash is 3.33.11 and each package
  versions itself. I verified each package's `ash` dependency range by grepping `mix.exs` but did
  not build a compatibility matrix.

## Sources

**URLs** (all retrieved 2026-10-01 unless noted)

- https://hex.pm/api/packages/ash
- https://hex.pm/api/packages/ash_postgres
- https://hex.pm/api/packages/ash_sqlite
- https://hex.pm/api/packages/ash_phoenix
- https://hex.pm/api/packages/ash_json_api
- https://hex.pm/api/packages/ash_graphql
- https://hex.pm/api/packages/ash_typescript
- https://hex.pm/api/packages/ash_authentication
- https://hex.pm/api/packages/ash_state_machine
- https://hex.pm/api/packages/ash_paper_trail
- https://hex.pm/api/packages/ash_archival
- https://hex.pm/api/packages/ash_events
- https://hex.pm/api/packages/ash_commanded
- https://hex.pm/api/packages/reactor
- https://hex.pm/api/packages/ash_oban
- https://hex.pm/api/packages/ash_money
- https://hex.pm/api/packages/ash_double_entry
- https://hex.pm/api/packages/ash_cloak
- https://hex.pm/api/packages/ash_admin
- https://hex.pm/api/packages/ash_ai
- https://hex.pm/api/packages/usage_rules
- https://hex.pm/api/packages/ash_rate_limiter
- https://hex.pm/api/packages/ash_csv
- https://hex.pm/api/packages/ash_slug
- https://hex.pm/api/packages/smokestack
- https://hex.pm/api/packages/igniter
- https://hex.pm/api/packages/spark
- https://hex.pm/api/packages/splode
- https://hex.pm/api/packages/ash_sql
- https://hex.pm/api/packages/ash_workflow
- https://hex.pm/api/packages/ash_event_log
- https://hex.pm/api/packages/ash_dispatch
- https://hex.pm/api/packages/ash_arcadic
- https://hex.pm/api/packages/commanded_aggregateless
- https://hex.pm/api/packages?search=ash&sort=recent_downloads&packages_per_page=200
- https://hex.pm/api/packages?search=reactor&sort=recent_downloads&packages_per_page=12
- https://hex.pm/api/packages?search=commanded&sort=recent_downloads&packages_per_page=12
- https://hex.pm/api/packages?search=%22event%20sourcing%22&sort=recent_downloads&packages_per_page=12
- https://hex.pm/api/packages?search=workflow&sort=recent_downloads&packages_per_page=12
- https://hex.pm/api/packages?search=factory&sort=recent_downloads&packages_per_page=12
- https://hex.pm/api/packages?search=%22event%20sourcing%22 … (see list above)
- https://github.com/jimsynz/smokestack (Smokestack README, deprecation notice + HL3 license)
- https://github.com/accountex-org/ash_commanded (AshCommanded; the only non-core CQRS binding)
- https://github.com/sephianl/ash_event_log (community Ash audit log)
- https://github.com/team-alembic/ash_workflow (community Ash workflow engine)
- https://ash-hq.org ; https://hexdocs.pm/ash ; https://elixirforum.com/c/ash-framework-forum/
  (referenced by package READMEs; forum threads cited in this document were read via
  `https://forum.elixirforum.com/t/<id>.json`)

- https://hex.pm/api/packages/ash_workflow
- https://hex.pm/api/packages/ash_credo
- https://hex.pm/api/packages/ash_scenario
- https://hex.pm/api/packages/ash_random_params
- https://hex.pm/api/packages/ash_grant
- https://hex.pm/api/packages/ash_rbac
- https://hex.pm/api/packages/ash_flow
- https://hex.pm/api/packages/ash_appsignal
- https://hex.pm/api/packages/ash_oaskit
- https://hex.pm/api/packages/reactor_file
- https://hex.pm/api/packages/reactor_req
- https://hex.pm/api/packages/reactor_process
- https://hex.pm/api/packages/hephaestus
- https://hex.pm/api/packages/ash_uuid
- https://hex.pm/api/packages/ash_translation
- https://hex.pm/api/packages/ash_feistel_cipher
- https://hex.pm/api/packages/ash_onetime
- https://github.com/team-alembic/ash_authentication (AshAuthentication's real repo, not ash-project)
- https://github.com/team-alembic/ash_workflow (durable workflow state via AshStateMachine + AshOban)
- https://github.com/accountex-org/ash_commanded/pull/7 (the unreleased aggregate-generation fix)
- https://api.github.com/repos/accountex-org/ash_commanded/commits (contributor/commit activity)
- https://github.com/ash-project/reactor/issues/334 (an AI-filed report about persisted reactors, closed `not_planned` the same day — used only as a pointer, the mechanism is cited to Spark source)
- https://github.com/ash-project/ash_events/issues/99 (a declared `manual` action silently discarded in 0.8.1; 0.8.2 rejects it at compile time)
- https://github.com/ash-project/ash_paper_trail/issues/40 (bulk actions)
- https://github.com/ash-project/ash_paper_trail/issues/104 (non-referenced actors)
- https://github.com/ash-project/ash_paper_trail/issues/30 (sensitive values not scrubbed)
- https://github.com/ash-project/ash_paper_trail/issues/171 (managed relationships)
- https://github.com/ash-project/ash_typescript/issues/100 (destroy of a nonexistent record reports success)
- https://github.com/baselabs/ash_onetime (README: idempotency / one-time-nonce DSL quoted in §6)
- https://elixirforum.com/t/ashevents-event-sourcing-made-simple-for-ash/70777 (2025-05 — the ES debate, both sides, read via the forum's `.json` endpoint)
- https://elixirforum.com/t/ashcommanded-a-declarative-cqrs-es-extension-for-ash/70900 (2025-12 to 2026-02 — 0.1.0 did not compile; 0.2.0 aggregate bug)
- https://elixirforum.com/t/long-running-queued-background-processes/59508 (jimsynz, 2023-11-06 — Reactor inside an Oban job)
- https://elixirforum.com/t/are-there-any-best-practices-for-referencing-versioned-resources/75012 (2026-04 — no built-in way to hydrate a version)
- https://elixirforum.com/t/how-to-pass-second-actor-parameter-to-the-ash-paper-trail/69322 (2025-02 — one actor per version)
- https://elixirforum.com/t/manager-approval-workflow-with-ash-paper-trail-for-record-changes/67343 (2024-11 — no approval package)
- https://elixirforum.com/t/ashevents-no-such-input-id-for-action-how-to-handle-auto-generated-primary-keys/73950 (2026-01 — replay + auto PKs)
- https://elixirforum.com/t/any-tips-on-building-a-workflow-engine-similar-to-n8n/71782 (2025-07/08 — durability left to the app)
- https://elixirforum.com/t/ash-typescript-pass-list-of-available-policies-to-the-user/73730 (2025-12 — no authz metadata in the TS client)

**Main local paths**

- `scratch/ash-src/ash/documentation/topics/advanced/reactor.md`
- `scratch/ash-src/ash/documentation/topics/development/testing.md`
- `scratch/ash-src/ash/documentation/how-to/test-resources.livemd`
- `scratch/ash-src/ash/documentation/topics/development/generators.md`
- `scratch/ash-src/ash/usage-rules.md`, `scratch/ash-src/ash/usage-rules/*.md`
- `scratch/ash-src/ash/lib/ash.ex` (`Ash.can?`), `lib/ash/test.ex`, `lib/ash/seed.ex`,
  `lib/ash/generator/generator.ex`, `lib/ash/data_layer/{ets,mnesia,simple}`
- `scratch/ash-src/ash/lib/ash/reactor/builders/*.ex` (the Ash action→step builders);
  `lib/ash/reactor/dsl/transaction.ex` (the `transaction` step — an Ash.Reactor entity, not core Reactor)
- `scratch/ash-src/ash/lib/ash/error/error.ex:10-14` (the four error classes)
- `scratch/ash-src/ash/lib/mix/tasks/ash.generate_policy_chart.ex`
- `scratch/ash-src/ash/usage-rules/testing.md:19-32` (unique identity values to avoid test deadlocks)
- `scratch/ash-src/ash/lib/ash/data_layer/{ets,mnesia,simple}`
- `scratch/ash-src/reactor/documentation/{tutorials,how-to,explanation,reference}/…`
- `scratch/ash-src/reactor/lib/reactor/{step.ex,middleware.ex,executor/*,dsl/*}`
- `scratch/ash-src/ash_paper_trail/documentation/tutorials/getting-started-with-ash-paper-trail.md`
- `scratch/ash-src/ash_events/README.md`
- `scratch/ash-src/ash_commanded/README.md`
- `scratch/ash-src/ash_typescript/README.md`, `documentation/getting-started/first-rpc-action.md`,
  `lib/ash_typescript/rpc.ex`, `lib/ash_typescript/manifest/dsl.ex`
- `scratch/ash-src/ash_ai/{README.md,usage-rules.md,AGENTS.md}`
- `scratch/ash-src/usage_rules/README.md`
- `scratch/ash-src/spark/lib/spark/code_helpers.ex:15-21,332-336` (AST-hash-based function naming — the durable-saga name-stability problem)
- `scratch/ash-src/ash_events/lib/events/{create,update,destroy}_action_wrapper.ex`
  (the per-action write order in 0.8.2), `lib/events/transformers/wrap_actions.ex:51,264`
  (compile-time rejection of a declared `manual`)
- `scratch/ash-src/ash_authentication/documentation/tutorials/get-started.md` (the `authentication do` example)
- `scratch/ash-src/ash_admin/documentation/tutorials/getting-started-with-ash-admin.md` (`admin do`)
- `scratch/ash-src/ash_graphql/documentation/topics/graphql-generation.md` (`graphql do`)
- `scratch/ash-src/ash_json_api/documentation/tutorials/getting-started-with-ash-json-api.md` (`json_api do`)
- `scratch/ash-src/ash_phoenix/lib/ash_phoenix.ex:130-139` (`forms do`), `documentation/topics/forms-for-relationships-between-existing-records.md:180-183`
- `scratch/ash-src/ash_rate_limiter/README.md:104-113` (`rate_limit do`)
- `scratch/ash-src/ash_postgres/documentation/topics/resources/references.md:13-19` (`references do`)
- `scratch/ash-src/ash_money/documentation/tutorials/getting-started-with-ash-money.md:34-43`
- `scratch/ash-src/ash_typescript/lib/ash_typescript/rpc/pipeline.ex`, `rpc/codegen/typescript_static.ex`,
  `rpc/codegen/helpers/payload_builder.ex` (the wire transport of §7.1)
- `scratch/ash-src/{ash_state_machine,ash_oban,ash_cloak,ash_archival,ash_double_entry,ash_slug,ash_rate_limiter}/README.md` and `documentation/tutorials/*.md`
- `scratch/ash-src/smokestack/README.md`
---

## Revision log

### Round 2

Review verdict was ACCEPT-WITH-FIXES. This list contains **only the changes that are actually in the
document above**; four round-2 claims that were logged but never applied are listed at the end as
open items, and they were completed in round 3.

| Finding | Sev | Change made in round 2 |
|---|---|---|
| `ExampleReactor` was hand-altered but presented as copied | high | Replaced with the verbatim block from `ash/documentation/topics/advanced/reactor.md` (all four inputs, all four step types, `take_payment`, `payment_provider_id`). |
| `Ash.Test` "one helper" / gap #7 "nearly empty" | high | Corrected to four helpers (`ash/lib/ash/test.ex:25,118,179-201,238-283`); gap #7 deleted. |
| Durability / resume gaps | high | Halt-and-resume added (`reactor-cheatsheet.cheatmd:53-55`, `architecture.md:78`); §1.3's durability paragraph rewritten around the documented Reactor + AshOban + AshStateMachine pattern (forum 59508). |
| AshEvents presented as fact-only "not event sourcing" | high | §4.1 restructured to give both positions with the maintainer's own quotes; the write-path claim corrected — AshEvents *replaces* the action with a `manual` implementation (`README.md:515-525`). The verdict moved to Implications #8. |
| Missing AshEvents facts | medium | Advisory locks (incl. the UUID-collision caveat and `AdvisoryLockKeyGenerator`), event-log notifiers (incl. the non-bulk hard-destroy gap), encrypted event logs, the `{:ash_postgres, "~> 2.0"}` dependency and the `manual`-action restriction added. |
| `ash_event_log` chronology and adoption ratio | medium | Corrected: first released 2026-04-23, i.e. **after** `ash_events` 0.1.0; ratio restated as ≈1/42 all-time, ≈1/25 over 90 days. |
| AshCommanded release history and authors | medium | Corrected to exactly 2 hex releases, 4 GitHub contributors, PRs merged to 2026-05-12. |
| AshCommanded maturity | high | §4.2 rewritten with the forum 70900 evidence: 0.1.0 did not compile, 0.2.0 fails aggregate generation, PR #7 merged 2026-05-12 but never released. |
| `ash_commanded/README.md:8-11` quote | medium | Re-cited to `README.md:4` for the README's own "CQRS and Event-Sourcing (ES)" wording; the hex description identified as the hex description. |
| Summary attributed the `transaction` step to core Reactor | medium | Corrected — `transaction` is an `Ash.Reactor` entity. |
| `undo/4` return values; middleware callback lines; `concurrency_key`; `undo_action`; `igniter` "third-party"; feistel/onetime split; `ash_translation`/`ash_uuid` dates; reactor add-on download figures; state_machine "type sugar"; Smokestack `[sic]` | low | All corrected, with the sources re-opened. |
| `ash_flow`, `ash_workflow`, hephaestus, `ariadne_flow`, `ash_authentication` (repo + stable version), `ash_events` hex owners | medium / low | Fetched and described accurately; `ariadne_flow` moved out of the sagas section into §4.3 as the event-sourcing library it is. |
| AshArchival `base_filter` | medium | Corrected in gap #9: `base_filter` is optional; `base_filter_sql` only with `base_filter? true`. |
| `ash_ai` public/private as the security boundary | medium | Corrected in §8 (actor + policies apply). |
| `igniter` and `spark` demoted to honorable mentions | medium | Done, with the reason (infrastructure) stated. |

**Round-2 claims that were logged but not actually applied (fixed in round 3):** the claim that all
17 wrong-line citations were re-pointed (six were not); the ash_postgres re-cite (not done); the
claim that DSL examples were added for the packages that lacked them (not done); the claim that
every unlabelled code block was verbatim (about fifteen were trimmed without a label); and the
claim that the AshCommanded open question was closed (the bullet still said "unresolved").

### Round 3

Every item below was opened in source before writing. Nothing is claimed that is not in the document
above.

| Review finding (round 2 re-verification) | Sev | What changed |
|---|---|---|
| **R2-3.1** AshEvents `manual` actions: issue #99 cited as the reason | high | §4.1 now states the 0.8.2 behaviour from source — `reject_manual_actions!` rejects a declared `manual` at compile time (`ash_events/lib/events/transformers/wrap_actions.ex:51,264`) — and describes #99 (filed against 0.8.1) as the opposite behaviour: silently discarded, "no compile warning", issue still open. |
| **R2-3.2** "events are committed before the projection changes" as a general claim | high | Replaced with the per-action-type order verified in 0.8.2: update = event then row (`update_action_wrapper.ex:28-39`); create = row then event (`create_action_wrapper.ex:25-58`); destroy = row then event (`destroy_action_wrapper.ex:36-37,106`). Zach Daniel's "always committed first" post is dated 2025-05-11 and noted as describing v0.1.1 (it links the create wrapper at that tag). Implications #8 updated to match. |
| **R2-3.3** katafrakt paraphrased as "it is an audit log" | high | Post #3 is now quoted directly, and post #10's Fowler argument added. Post #9's "fits enough definitions … one way to do event sourcing with Ash" added on the maintainer side. The README's own phrase is quoted in full context — "purely as an audit log system **rather than** a full event sourcing solution" (`README.md:182`) — instead of the truncated "full event sourcing solution". |
| **R2-3.4** Reactor issue #334 as community evidence | high | The mechanism is now cited to Spark's source — generated function names embed `code_identifier/1`, the MD5 of the function's AST (`spark/lib/spark/code_helpers.ex:332-336`, `:15-21`) — and #334 is described as what it is: an AI-filed report, closed `not_planned` the same day, no maintainer confirmation. Gap #7 and Implications #10 both re-cited. |
| **R2-3.5** `fully_reversible` read as half of the durability assembly | high | Corrected in both places it appeared (§1.1, §1.3): the option is `fully_reversible?`, "the Reactor will return a copy of the completed Reactor struct for potential future undo" (`reactor/lib/reactor.ex:112-116`) — it concerns undoing a *completed* run later and has nothing to do with persisting progress. |
| **R2-3.6** advisory-lock quote missing the README's qualifier | low | Restored: "but it is still extremely unlikely to occur in practice" (`ash_events/README.md:650`). |
| **R2-2** ~15 trimmed code blocks without an "(abridged)" label, one hand-written block, one altered block | high | Every block compared with its source. The Reactor getting-started block is now **verbatim** (`:hash_password` step and the real `create_user` body restored); the compensate block's dropped comments are named; abridged labels added to the AshEvents event_log/events, replay, `Ash.Generator` (source typo noted), Smokestack, AshCommanded, ash_ai tools, AshOban, AshStateMachine, `usage_rules`, AshCloak and ash_typescript manifest blocks. The hand-written "rpc.ex" pseudo-block was **deleted** and replaced with the real `typescript_rpc do` domain block (`installation.md:151-162`); the altered `createTodo` block is now verbatim (`first-rpc-action.md:53-71`); the reflowed `getTodo` block is now verbatim (`:96-108`). |
| **R2-4** ranking: `splode` promoted for the same reason `igniter`/`spark` were demoted; cut list and honorable mentions still listing ranked packages; rule contradicted by the table | high | Rule rewritten as one rule in two bands — domain relevance first, adoption second; storage/transport in a band below ranked by adoption; infrastructure and plumbing not ranked at all. Table reordered to match and renumbered; `splode` demoted to §9; `ash_money` removed from both the cut list and §9; `ash_onetime` takes the free slot (hex API re-fetched 2026-10-01, as for every row added or moved); `ash_workflow`, `ash_credo` and `ash_scenario` explicitly evaluated and left in §9 with reasons. |
| **R2-4.4** §6 numbering stale; no notes for `ash_money`/`splode`; missing DSL examples | high | §6 renumbered 1-20 to match the ranked table, `igniter`/`spark` notes moved into §9 as "Notes on the demoted infrastructure packages". New notes for `ash_money` (now ranked #14) and `ash_onetime` (#15). Real DSL examples added for `ash_authentication` (`authentication do`, get-started.md:183-199), `ash_phoenix` (`forms do`, `ash_phoenix.ex:133-138` — the table's "`phoenix do`" was also wrong), `ash_json_api` (`json_api do`), `ash_graphql` (`graphql do`), `ash_admin` (`admin do`) and `ash_rate_limiter` (`rate_limit do`). |
| **R2-5** §6 ash_events note still asserted "not projections/event sourcing" | medium | Changed to "contested — §4.1 gives both positions". |
| **R2-5** JSON:API "plateaued relative to GraphQL" | medium | Deleted: JSON:API has 2.6× GraphQL's 90-day downloads, so the comparison ran backwards. Restated as a fact. |
| **R2-5** `clear_records_for_replay/1` "wipes the relevant tables" | medium | Corrected: it names a module the user implements (`use AshEvents.ClearRecordsForReplay`, `clear_records!/1`, `README.md:84-98`); replay calls it, then loads and applies events (`README.md:205-210`); AshEvents itself wipes nothing. |
| **R2-1** six citation line numbers still wrong | low | All six re-pointed: `test-resources.livemd:44-50`→`:25-28`; `ash_ai/README.md:57`→`:72` and `:66`→`:82`; `ash_typescript/README.md:93`→`:87`; `rpc.ex:315-321`→`:324-325`; `ash/usage-rules.md:7-9`→`:11`; `getting-started-with-ash-paper-trail.md:325-327`→`:372`. (Round 1's `usage_rules/README.md:86`→`:87` was also fixed; its sibling `reactor.md:50-52`→`:41` was **not** — it slipped through and was fixed in round 4.) |
| **R2-1** ash_postgres DSL example still cited to `ash_archival` | medium | Replaced with the verbatim `references do` block from `ash_postgres/documentation/topics/resources/references.md:13-19`. |
| **R2-1** §6 ash_archival still presented `base_filter`/`base_filter_sql` as required | medium | Now marked optional, with the `base_filter? true` opt-in and the default `is_nil(archived_at)` preparation cited. |
| **R2-1** Implications #5 still called public/private the security boundary | medium | Rewritten: AshAi's MCP plug sets the authenticated user as actor so tools run under ordinary policies; public/private only decides which fields come back. |
| **R2-1** AshCommanded open question still said "unresolved" | high | Deleted; the question is answered in §4.2 (0.2.0 broken on hex, fix merged but unreleased). |
| **R2-7** ash_typescript transport left open | high | Merged as §7.1, each point confirmed in the clone and cited: endpoints and generated controller, request shape, response shape, errors, field selection and typed results, fetch layer, lifecycle hooks, validation functions, typed controllers, multitenancy and stated limits. The corresponding Open questions entry is gone. |
| **R2-5** stale Open questions (absence-of-evidence gaps, "forum unreadable") | medium | Both deleted. The gaps were replaced in round 2 with sourced ones and the forum is readable via `forum.elixirforum.com/t/<id>.json`, which is how the post #3/#9/#10/#11 quotes in §4.1 were obtained. |
| **R2-5** Sources still said the forum was unreadable | low | Deleted; the Sources now record the `.json` endpoint. Spark, the ash_events wrappers and the new §6 example paths were added to the local-path list. |
| **R2-3.7 / §5** gap #10 (ash_grant/ash_rbac) inferred a community complaint | medium | Marked explicitly as inference from existence, with the note that `ash_rbac`'s last release is 2024-10-01 (dormant). |

**Judgement calls the reviewer may want to check:** (a) ranking `ash_onetime` at #15 rather than
`ash_workflow` — round 3 applied adoption as the tiebreaker between two very new packages; round 4
replaces that with an explicit two-week **maturity gate** (age, not adoption, not relevance), which
is the only tie-break that does not contradict the stated rule; (b) `ash_typescript` placed in the
domain band as an explicit exception, since Mesh is a TypeScript framework.

### Round 4

The final check returned ACCEPT. Its *Residual errors (for readers)* list was applied in full; each
source was opened before writing. Nothing outside that list was touched and nothing was shortened.

| Residual finding | What changed |
|---|---|
| `reactor.md:50-52` cited for "Not all resources need to have state/data layers…" | Re-pointed to `reactor.md:41`, where the sentence is. The round-3 log had claimed this fix; it is now true. |
| Reactor getting-started block cited `:64-110` | Corrected to `:64-112` — the block ends with `return :create_user` / `end` at 111-112. |
| `ExampleReactor` cited `reactor.md:64-97` | Corrected to `:64-99`. |
| `getTodo` nested-fields block cited `first-rpc-action.md:96-108` | Corrected to `:99-109` (the prose above it still sits at `:96-97`). |
| AshCloak block cited `getting-started-with-ash-cloak.md:26-41` | Corrected to `:23-52`. |
| Zod/Valibot opt-in cited `configuration.md:26-30,64-67,136-140` | Split into the right ranges: the `generate_zod_schemas` / `generate_valibot_schemas` flags are at `configuration.md:40-45`, the output-file table at `:136-140`. |
| `ash_onetime` "released 2026-09-24 … all of them in its first days" | Corrected from the hex API: **first published 2026-08-09** (0.1.0), **19 releases**, latest 1.4.0 on 2026-09-24; the 2,831 downloads accumulated over about seven weeks. |
| `ash_onetime` DSL block labelled "verbatim" | Made genuinely verbatim: the README's second `protect :redeem do` block (`:one_time_nonce`, `key`, `window`, `commit :independent`) is now included instead of omitted. |
| Revision log: "`ash_onetime` … and `ash_workflow` … both are days old" | Corrected in both places: `ash_workflow` was 12 days old (first release 2026-09-18, 5 releases — re-fetched); `ash_onetime` is about seven weeks old. |
| Ranking rule vs table inside the domain band | The rule now says exactly what the table does: the three mandatory-area packages take ranks 1-3 (sagas; auditing — testing is first-party and has no package), and the rest of the domain band is ordered by 90-day downloads descending. Rows 4-15 were re-ordered accordingly (`usage_rules` 301,065 now above `ash_authentication` 216,171, etc.), with `ash_typescript` keeping its stated exception and staying at its adoption position. §6 renumbered to match, 1:1. |
| Garbled "sagas (1-3), auditing (2-3), background work and durability (4), state and lifecycle (5-6)" | Deleted; it also wrongly implied background work and state/lifecycle were brief-mandatory areas. The rule now names only sagas and auditing as the ranked mandatory areas. |
| `ash_admin` in the "storage and transport" band | The band is now named "storage, transport and admin UI", and the rule says why `ash_admin` belongs there (a generated admin UI over the domain is the same kind of pattern reference as a transport). |
| `ash_workflow` called "more domain-relevant" while left out under a relevance-first rule | Replaced the ad-hoc adoption tiebreaker with an explicit two-week **maturity gate** stated in the rule. The evaluation paragraph no longer implies a relevance judgement that the ranking contradicts, and the rule says ranks 14-15 are interchangeable with `ash_workflow`. |
| Implications #8: "the resource tables, which were never the primary store to begin with" | Contradicted §4.1 and the same paragraph. Rewritten: the tables were primary all along, which is katafrakt's "the state is still a primary concept and events are secondary". |
| §1.3: halt/resume cited as "persisting the `%Reactor{}` struct between runs" | Corrected: `reactor-cheatsheet.cheatmd:53-55` shows an in-process pause and resume only. Persisting the struct across processes or deploys is left to the application and is marked `[unverified]` — no Reactor doc says so. |

**Not changed:** §7's "Limits and sharp edges" still partly overlaps §7.1's "Stated limits" — the
reviewer called this redundant rather than wrong, and the brief said not to restructure sections
without a finding against them.

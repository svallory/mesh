---
title: "Ash run-time architecture"
description: "Ash's action lifecycle, data layer contract, expression engine, policy engine and loading engine."
---

# Ash run-time architecture: action lifecycle, data layer contract, expression engine, policy engine, loading engine

> Independent fact-check: [review of this document](./reviews/ash-runtime-internals-review.md).

Ref: `ash-runtime` · Written 2026-10-01 · Author: researcher `ash-runtime` · Revised 2026-10-01 (round 2, corrections after rejected review — see `## Revision log (round 2)`)

## Versions examined

| Package | Version | Source |
| --- | --- | --- |
| `ash` | 3.33.11 | `scratch/ash-src/ash/mix.exs:13` |
| `ash_sql` | 0.7.6 | `scratch/ash-src/ash_sql/mix.exs:13` |
| `ash_postgres` | 2.13.1 | `scratch/ash-src/ash_postgres/mix.exs:12` |
| `splode` | 0.3.2 | `scratch/ash-src/splode/mix.exs:8` |

All source paths below are relative to `/Users/svallory/work/mesh/`.

Glossary for the Elixir-specific terms used here: a **behaviour** is an interface module (a set of callbacks) that a module declares with `@behaviour`; a **macro** is a compile-time function that receives unparsed syntax and returns quoted code; a **changeset** is a struct carrying the original record, the requested changes, accumulated errors and the hooks to run; a **GenServer** is an Erlang/Elixir process holding state and answering messages (relevant to Mnesia).

## Summary

- The write lifecycle is a **nested onion**: `around_transaction` → `before_transaction` → [ transaction opens ] → `around_action` → `before_action` → data-layer call → `after_action` → **`authorize_results`, still inside the transaction** → [ transaction closes ] → `after_transaction`. Every hook is a plain Elixir function stored in a list on the changeset (`scratch/ash-src/ash/lib/ash/changeset/changeset.ex:4935-5050`, `:5387-5395`).
- Changes and validations run **at changeset-build time**, not at action time: `Ash.Changeset.for_create/for_update/for_destroy` runs action changes and validations, then global changes, then global validations (`changeset.ex:3613-3671`, `:4328-4366`). A validation with `before_action? true` is instead *appended as a before_action hook*. On a single-record atomic update **both** callbacks run: `change/3` at build time, then `atomic/3` on a rebuilt changeset.
- Preparations run on reads **and generic actions**: `Ash.Query.for_read` and `Ash.ActionInput.for_action` both run global preparations, then action preparations, then global validations (`scratch/ash-src/ash/lib/ash/query/query.ex:1122-1167`; `scratch/ash-src/ash/lib/ash/action_input.ex:253-271`, `:1328-1361`).
- Write authorization has **six placements**, not one: strict checks in `do_run` before the transaction; create filter checks as `authorize_results` after `after_action`, inside the transaction; update/destroy runtime checks as a prepended `before_action` inside the transaction — but as a pre-flight SELECT outside any transaction when the action will not transact; filter checks on non-atomic update/destroy as a SELECT **before** the transaction opens; atomic updates with the check compiled into the statement; and generic actions authorizing inside the transaction (`scratch/ash-src/ash/lib/ash/can.ex:1027-1300`, `:1392-1462`, `:1591-1596`, `:1618-1700`).
- Reads authorize **before** `before_transaction` hooks (`scratch/ash-src/ash/lib/ash/actions/read/read.ex:579` vs. `:609`) via the main `do_read/5` path, and a read opens a data-layer transaction when the action sets `transaction? true` (`read.ex:1650-1676`), with `after_transaction` hooks then running inside it (`read.ex:819-823`).
- "Atomic" is an **expression-rewriting protocol**, not a flag: a change's `atomic/3` returns `{:atomic, %{attr => expr}}` and the data layer folds those into the UPDATE/INSERT statement (`scratch/ash-src/ash/lib/ash/resource/change/change.ex:380-441`). A single-record `Ash.update` that can run atomically is rebuilt with `Ash.Changeset.fully_atomic_changeset/4` and routed through `Ash.Actions.Update.Bulk.run` with `strategy: [:atomic, :stream]`, authorization becoming an error expression inside the single UPDATE (`scratch/ash-src/ash/lib/ash/actions/update/update.ex:93-233`). `require_atomic?` defaults to `true` for explicitly declared update/destroy actions; `defaults [...]`-generated actions follow `:default_actions_require_atomic?`, which defaults to `false` (`scratch/ash-src/ash/lib/ash/resource/actions/update.ex:20`; `scratch/ash-src/ash/lib/ash/resource/transformers/set_primary_actions.ex:18-22`).
- Bulk strategies are `:atomic`, `:atomic_batches`, `:stream`; the default for `Ash.bulk_update` is `[:atomic]` and for `Ash.bulk_destroy` `:atomic` (`scratch/ash-src/ash/lib/ash.ex:574-578`, `:634-639`). `:stream` is the **only** strategy that keeps per-record changes and hooks; the atomic strategies keep only `after_action`/`after_transaction`.
- The `Ash.DataLayer` behaviour declares **46 callbacks, 44 of them optional; `can?/2` and `resource_to_query/2` are required**, plus a `feature()` type with 47 distinct alternatives (`scratch/ash-src/ash/lib/ash/data_layer/data_layer.ex:88-137`, `:141-377`, `:379-421`).
- Expressions are a **two-stage AST**: the `expr/1` macro emits unresolved `%Ash.Query.Call{}` and ref nodes, which `Ash.Filter` resolves into `Ash.Query.Operator.*` / `Ash.Query.Function.*` structs when the filter is parsed (`scratch/ash-src/ash/lib/ash/expr/expr.ex:826`, `:839`; `scratch/ash-src/ash/lib/ash/filter/filter.ex:3727-3876`) — so the same tree can be evaluated in the BEAM (`Ash.Filter.Runtime`) or compiled to Ecto dynamic SQL (`AshSql.Expr.dynamic_expr/6`).
- Policies compile to a **boolean formula over check references**, solved by `Crux` on an optional SAT backend (`picosat_elixir` or `simple_sat`), returning *scenarios* rather than a single boolean (`scratch/ash-src/ash/lib/ash/policy/policy.ex:103-131`; `scratch/ash-src/ash/mix.exs:406-408`).
- Notifications are **queued in the process dictionary while a transaction is open** and released only after the outermost transaction commits (`changeset.ex:4877-4888`, `scratch/ash-src/ash/lib/ash/notifier/notifier.ex:180-196`). Destroy is the exception that *builds* its notification inside the transaction (`scratch/ash-src/ash/lib/ash/actions/destroy/destroy.ex:276-289`).
- `ash_postgres` installs SQL functions to make Elixir semantics work in the database — `ash_elixir_and`, `ash_elixir_or`, `ash_required`, `ash_raise_error`, `ash_trim_whitespace`, `uuid_generate_v7` (`scratch/ash-src/ash_postgres/lib/migration_generator/ash_functions.ex:15-54`, `:237-286`).

---

## 1. Action lifecycle, exact order

All four write action types share the same skeleton; the differences are called out.

### 1.0 The shared skeleton

`Ash.Changeset.with_hooks/3` (`scratch/ash-src/ash/lib/ash/changeset/changeset.ex:4749`) decides whether to open a data-layer transaction at all. It only *skips* the explicit transaction when **all** of these hook lists are empty and the action is not manual and the data layer prefers it:

```elixir
# changeset.ex:4753-4764
if !(changeset.action && changeset.action.manual) &&
     Enum.empty?(changeset.before_transaction) && Enum.empty?(changeset.around_transaction) &&
     Enum.empty?(changeset.before_action) && Enum.empty?(changeset.after_action) &&
     Enum.empty?(changeset.around_action) && Enum.empty?(changeset.relationships) &&
     Enum.empty?(changeset.authorize_results) do
  data_layer_prefers_transaction?
else
  true
end
```

`transaction_hooks/2` (`changeset.ex:4935-5050`) is the actual nesting:

```
around_transaction (first one added wraps the rest; iterate the list, each receives a continuation)
└─ before_transaction (reduce_while; halts if changeset.valid? becomes false)
   └─ Ash.DataLayer.transaction(...)
      └─ around_action
         └─ before_action (run_before_actions/1, changeset.ex:5119)
            └─ the action body: data-layer create/update/upsert/destroy, or ManualCreate/Update/Destroy
            └─ after_action (run_after_actions/3, changeset.ex:5308)
            └─ authorize_results (run_authorize_results/2, changeset.ex:5387-5395) — post-action authorization, still inside the transaction
      └─ [transaction commits or rolls back here]
   └─ after_transaction (run_after_transactions/2, changeset.ex:5205)
```

Note the transaction opens **inside** `before_transaction` and closes **before** `after_transaction`. `before_transaction`/`around_transaction` therefore run outside the transaction — Ash warns when that is not what you expect (`changeset.ex:4912-4932`, `warn_on_transaction_hooks`).

`around_transaction` and `around_action` are "consume from the head, recurse" recursion, so the **first** hook added is the outermost (`changeset.ex:5058-5064`, `:5296-5302`).

### 1.1 Create

Entry: `Ash.create` → `Ash.Actions.Create.run/4` (`scratch/ash-src/ash/lib/ash/actions/create/create.ex:16`).

1. Reject atomics the data layer cannot do: `Ash.DataLayer.data_layer_can?(resource, {:atomic, :create})` / `{:atomic, :upsert}` → `Ash.Error.Invalid.AtomicsNotSupported` (`create.ex:19-47`). `atomic_update` on a create is rejected outright (`create.ex:38-45`).
2. `multitenancy: :bypass / :bypass_all` on the action writes `context.shared.private.multitenancy = :bypass_all` (`create.ex:52-59`).
3. Open span `:action` and emit telemetry `[:ash, <domain>, :create]` with metadata `%{domain, resource, resource_short_name, actor, tenant, action, authorize?}` (`create.ex:64-88`).
4. `do_run/4` pipeline (`create.ex:182-186`):
   1. `handle_multitenancy(changeset, action)`
   2. `changeset/4` → `Ash.Changeset.for_create(changeset, action.name, %{}, opts)` unless already validated for this action, then `set_defaults(:create, true)` and `timeout` (`create.ex:272-282`).
      Inside `do_for_action/4` (`changeset.ex:2989-3060`), in order: resolve domain → set context (actor/tenant/authorize?/tracer) → tracer span `:changeset` + telemetry `[:ash, :changeset]` → set private arguments → `prepare_changeset_for_action` → `handle_params` (cast, argument defaults, require arguments) → `handle_upsert` → **`run_action_changes`** → **`add_validations`** → `mark_validated` → `eager_validate_identities` → `require_values`.
      `run_action_changes` runs **action changes first, then global resource changes**, both in the `:validate` phase (`changeset.ex:3613-3621`); each is gated on `module.has_change?()` (an atomic-only change is skipped here and handled by `run_atomic_change`) and on its `where` validations.
      `add_validations` runs global validations unless `skip_global_validations?`, and turns each into either an immediate run or a `before_action` hook when `before_action?` is set — or `delay_global_validations?` on the action forces all of them into `before_action?` (`changeset.ex:4328-4359`).
   3. `check_upsert_support`
   4. **`authorize/2`** — `Ash.can(changeset, actor, alter_source?: true, pre_flight?: true, return_forbidden_error?: true, maybe_is: false)` (`create.ex:219-239`). Still **outside** the transaction. Data-dependent filter checks are *not* resolved here; they are stashed as `authorize_results` hooks to run post-insert (`can.ex:1471-1484`, `:1618-1645`).
   5. `commit/3`.
5. Inside `commit/3` (`create.ex:284-586`):
   1. Resolve upsert identity/keys; `set_tenant`.
   2. `Ash.Changeset.with_hooks(body, transaction?: ..., rollback_on_error?: ..., notification_metadata: ..., transaction_metadata: ...)` — the call itself is at `create.ex:324-326` and its option map at `:550-563`.
   3. Body (`create.ex:343-548`): `hydrate_atomic_refs` → `apply_atomic_constraints` → `set_action_select` → `setup_managed_belongs_to_relationships` (a `manage_relationship` becomes its own nested create/update, see §1.5) → `require_values(:create)` and `require_values(:update, false, action.require_attributes)` → final `require_values(:create, true, final_check)` for every non-nullable, non-generated, non-belongs_to attribute → `validate_required_belongs_to` → branch:
      * **manual action** → `Ash.Resource.ManualCreate.create/4`; return value is validated to be `{:ok, %Resource{}}`, `{:ok, %Resource{}, notifications}` or `{:error, error}` (`create.ex:376-403`; `validate_manual_action_return_result!` at `:588-620`).
      * **`upsert?`** → `Ash.DataLayer.upsert/4`; `{:upsert_skipped, ...}` becomes `Ash.Error.Changes.StaleRecord` unless `return_skipped_upsert?` (`create.ex:455-501`).
      * otherwise → `handle_allow_nil_atomics` then `Ash.DataLayer.create/2`, then `rollback_if_in_transaction`, `add_tenant`, `manage_relationships`.
   4. `Helpers.select(result, %{resource:, select: changeset.action_select})`.
6. [Inside the transaction, after the body and the `after_action` hooks:] **`run_authorize_results/2`** (`changeset.ex:5387-5395`). This is where **create filter policies** run: Ash issues `SELECT … WHERE pk AND ^policy_filter` in the same transaction; a miss rolls back and returns `Ash.Error.Forbidden` (`can.ex:1618-1700`). `Ash.Error.Forbidden.CannotFilterCreates` is raised at install time when the data layer cannot transact, when `transaction? false`, or when `before_transaction`/`around_transaction` hooks exist without `allow_post_action_authorization?` (`can.ex:1618-1645`).
7. [Inside `with_hooks`, after the transaction commits:] `after_transaction` hooks run **before** `Helpers.load` and before the resource's own notification (`changeset.ex:4989-4996`).
8. [Outside the transaction:] notifications returned by hooks or nested actions are sent, or queued if an outer Ash transaction is open (`changeset.ex:4877-4888`), then `Helpers.load(...)` with `reuse_values?: true` and context `just_created_by_action`, then **`Helpers.notify`** for the resource's own notification (`create.ex:565-581`, `helpers.ex:564-594`), then `Helpers.select`, then `Helpers.restrict_field_access`.
9. `add_notifications/5` returns `{:ok, result, notifications}` when `return_notifications?`, otherwise `Helpers.warn_missed!` (`create.ex:257-267`).

Error paths: any `{:error, changeset}` is run through `Ash.Changeset.run_after_transactions` so `after_transaction` still fires (`create.ex:203-215`). Raised exceptions are converted with bread crumbs `"Exception raised in: <Resource>.<action>"` (`create.ex:124-133`).

### 1.2 Update

`Ash.update/2` runs `Ash.Changeset.for_update/4` when the changeset has not been validated for an action yet (`scratch/ash-src/ash/lib/ash.ex:4159-4165`), so **every change's `change/3` runs at changeset-build time**, exactly as for create. `Ash.Actions.Update.run/4` then proceeds (`scratch/ash-src/ash/lib/ash/actions/update/update.ex:36-155`):

1. Reject atomics the data layer cannot do (`{:atomic, :update}` → `AtomicsNotSupported`, `update.ex:36-42`) and apply the multitenancy bypass context (`update.ex:44-51`).
2. **The atomic-upgrade decision**, computed *before* the `:action` span opens (`update.ex:53-155`). Each condition yields `{:not_atomic, reason}` (`update.ex:69-97`):

   ```elixir
   # update.ex:65-97 (abridged, real strings)
   dirty_hooks = changeset.dirty_hooks -- [:after_action, :after_transaction]

   cond do
     !action.require_atomic? && !action.atomic_upgrade? ->
       {{:not_atomic, "action has `atomic_upgrade? false`"}, nil}
     !Ash.DataLayer.data_layer_can?(changeset.resource, :expr_error) && opts[:authorize?] ->
       {{:not_atomic, "data layer does not support adding errors to a query"}, nil}
     !Ash.DataLayer.data_layer_can?(changeset.resource, :update_query) ->
       {{:not_atomic, "data layer does not support updating a query"}, nil}
     :manage_relationships in changeset.dirty_hooks ->
       {{:not_atomic, "cannot atomically manage relationships"}, nil}
     !Enum.empty?(dirty_hooks) ->
       {{:not_atomic, "cannot atomically run a changeset with hooks in any phase other than `after_action` or `after_transaction`, got hooks in phases #{inspect(dirty_hooks)}"}, nil}
     !atomic_upgrade_read ->
       {{:not_atomic, "cannot atomically update a record without a primary read action or a configured `atomic_upgrade_with` action"}, nil}
     opts[:atomic_upgrade?] == false ->
       {{:not_atomic, "atomic upgrade was disabled with opts"}, nil}
     true ->
       # rebuild from the original params so each change's atomic/3 can run
       Ash.Changeset.fully_atomic_changeset(resource, action, params, ...)
   end
   ```

   Note what `dirty_hooks` really means: `maybe_dirty_hook/2` records a hook **only while the changeset phase is `:pending`**, i.e. only hooks the *caller* added; hooks that the action's own changes add during `for_update` do **not** block the upgrade (`scratch/ash-src/ash/lib/ash/changeset/changeset.ex:7741-7747`).
3a. **Atomic path.** The changeset is **rebuilt from the original params** by `Ash.Changeset.fully_atomic_changeset/4` (`scratch/ash-src/ash/lib/ash/changeset/changeset.ex:813-890`), which runs every change's **`atomic/3`** and the atomic validations. Because `Ash.update` already ran `change/3` while building the changeset, **both callbacks run**. `atomic_after_action`/`atomic_after_transaction` hooks are re-attached and caller-added filters are *merged* into the rebuilt changeset's filter (`update.ex:128-179`). Ash then calls **`Ash.Actions.Update.Bulk.run`** with a primary-key query and `strategy: [:atomic, :stream]`, `authorize_query?: false` and `authorize_changeset_with: :error` when the data layer supports `:expr_error` (otherwise `:filter`) — authorization is compiled into the single UPDATE as an error expression (`update.ex:198-233`). Zero rows updated returns `Ash.Error.Changes.StaleRecord` (`update.ex:241-251`).

> **What the rebuild keeps and what it drops.** `fully_atomic_changeset/4` builds a **new** changeset carrying the original `data` (or `%OriginalDataNotAvailable{}` when there is none, `changeset.ex:831`), the context, the params, the action, `no_atomic_constraints` and the tenant. What arrives from `update.ex:120-124` in `opts[:atomics]` is the original changeset's `atomic_changes` **merged with its `attribute_changes`**. So attribute *values* that `change/3` set during `for_update` **are** carried across as literal atomics; what is dropped is everything else `change/3` did — its hooks, its filters and its other side effects. That asymmetry is precisely issue #2969 (§12.B item 21): a `change filter(...)` was lost on the atomic path while the caller filters still applied, so the row was written even though it did not match the action's own filter. The rebuild pipeline is `verify_notifiers_support_atomic` (notifiers needing original data block atomicity, `:1099`) → `atomic_params` (`:1813`) → `set_argument_defaults` → `require_arguments` → **`atomic_changes`** (`:1115-1162`) → `atomic_update` → set `changed?` → `atomic_defaults` (static and lazy `update_default`s as conditional atomics, `:895+`) → `hydrate_atomic_refs` (adds atomic validations, fills templates, hydrates refs, extracts eager errors with `error_is_not_atomic?: true`) → `apply_atomic_constraints` (definition at `:3880`) (`changeset.ex:860-880`). `atomic_changes` runs the action's changes and validations **as declared**, then the global changes, then the global validations (unless `skip_global_validations?`), each through `run_atomic_change`/`run_atomic_validation`; the first `{:not_atomic, reason}` halts the pipeline.
3b. **Not atomic, but `require_atomic?` is true and the data layer could have supported it** → hard run-time error `Ash.Error.Framework.MustBeAtomic` (`update.ex:257-269`).
3c. **Classic path.** The `:action` span opens, then `do_run/4`: `handle_multitenancy` (with `:attribute` multitenancy this adds a **changeset filter**, `update.ex:831-843`) → `changeset` → **`authorize`** (`Ash.can`, `pre_flight?: false`, `update.ex:395-400`; filter checks run a pk+filter SELECT *now, outside the transaction*, and runtime checks are deferred to a prepended `before_action` — see §6.5) → **`Ash.Changeset.add_atomic_validations`** (update calls this too, unlike the old text of this document) → `commit` (`update.ex:354-360`).
4. `commit/3`: managed relationships are registered as a **`before_action` hook** (`update.ex:463-477`), then `with_hooks`: around_transaction → before_transaction → [T] around_action → before_action → body: `require_values`; if `changed?`, `Ash.DataLayer.update` with `changeset.filter`, otherwise no write and at most a re-select under the filter (`update.ex:575-668`); then `manage_relationships` → after_action → `authorize_results` → commit → after_transaction.
5. [Outside the transaction:] hook notifications, then `Helpers.load`, `Helpers.notify`, `Helpers.select`, `Helpers.restrict_field_access` (`update.ex:717-729`).

### 1.3 Destroy

- **Soft destroy** (`soft? true`) runs `for_destroy` and then hands off to **`Ash.Actions.Update.run`** — the entire update lifecycle applies, atomic upgrade included (`scratch/ash-src/ash/lib/ash/actions/destroy/destroy.ex:19-52`).
- **Hard destroy has no atomic upgrade** (`destroy.ex:55-130`; `scratch/ash-src/ash/lib/ash.ex:4335-4345`). `do_run/4` (`destroy.ex:133-160`): set tenant → `handle_multitenancy` (`:attribute` adds a changeset filter, as in update) → `changeset` (`for_destroy`) → **`authorize`** (`Ash.can`, `pre_flight?: false`, `destroy.ex:186-191`; the same pre-flight SELECT for filter checks and deferred runtime checks as update — see §6.5) → **`Ash.Changeset.add_atomic_validations`** → `commit`. Destroy has no `require_values` phase; atomics are validations instead.
- Inside `with_hooks`, the body **loads the record before deleting it** (`Helpers.load` with `reuse_values?: true`, `destroy.ex:216-224`), sets the tenant, calls `ManualDestroy.destroy/3` or `Ash.DataLayer.destroy`, runs `manage_relationships`, and then calls **`Helpers.notify` inside the transaction** — the notification is queued until the outermost Ash transaction ends (`destroy.ex:276-289`). This differs from create/update, which notify outside the transaction.
- After `after_action` and `authorize_results` the transaction commits and `after_transaction` runs; outside, hook notifications are sent and the result is selected (`destroy.ex:318-334`).

### 1.4 Generic actions

`Ash.run_action` → `Ash.Actions.Action.run/3` (`scratch/ash-src/ash/lib/ash/actions/action.ex:14`):

1. **Build phase** — `Ash.ActionInput.for_action/4` runs cast params, argument defaults, require arguments, then **global preparations, then action preparations, then global validations** (`on: :action`), then `load` (`scratch/ash-src/ash/lib/ash/action_input.ex:253-271`, `:1328-1361`). Preparations are therefore **not** a read-side-only concept.
2. Span `:action` + telemetry `[:ash, <domain>, :action]`, then `around_transaction` hooks wrap everything that follows (`action.ex:53-86`).
3. With `transaction?` (the default): `before_transaction` hooks → the transaction opens over `action.touches_resources ++ [resource]` → **[T] `authorize`** → `before_action` → the implementation's `run/3` (or a Reactor) → the `allow_nil?` check → `after_action` → commit, or rollback on error (`action.ex:181-225`, `:369-431`, `:436-515`). Without a transaction: `before_transaction` → `authorize` → hooks and `run/3`, all outside one (`action.ex:275-310`).
4. [Outside:] **notifications are sent first, then the `after_transaction` hooks** — the reverse of create/update (`action.ex:227-258`).
5. `maybe_load/3` — if `action.returns` is a type that can load and `input.load` is set, `Ash.Type.load/2` is applied (`action.ex:148-177`).

Two things to note. First, generic actions authorize **after** `before_transaction` and, when transactional, **inside** the transaction (`action.ex:183-198`, `:277-280`) — the opposite placement from create/update/destroy's strict pre-flight. Second, only **strict** checks are allowed: a filter check raises "Cannot use filter checks with generic actions" and a runtime check raises "Cannot use runtime checks with generic actions" (`action.ex:405-431`). There is **no `around_action`** for generic actions.

### 1.5 Managed relationships

`manage_relationship` is expanded before the action body: `setup_managed_belongs_to_relationships` creates the owned record (`create.ex:350-355`) and `manage_relationships` runs after the parent's data-layer call — after the manual branch (`:405-409`), after the result (`:449-453`), after an upsert (`:497-501`) and after a create (`:513-517`). That is why `:manage_relationships in changeset.dirty_hooks` disqualifies an atomic update (`update.ex:77-78`), and why on update the managed relationships are installed as a `before_action` hook (`update.ex:463-477`).

**Load-then-diff, and one nested action per input** (`scratch/ash-src/ash/lib/ash/actions/managed_relationships.ex`, 3,693 lines). `load/4` (`:20-35`) loads the *current* related records before anything is diffed. A freshly created parent normally skips that, but `could_be_related_at_creation?` is set when the parent action is an **upsert** (`engine_opts[:upsert?]`, `:28-29`), so related records are loaded and diffed even on create. `manage_relationships/4` (`:576-600`) then walks each relationship's inputs in `opts[:meta][:order]` order, matches inputs against existing related records and applies `on_lookup`/`on_no_match`/`on_match`/`on_missing` — with **one nested `Ash.create` / `Ash.update` / `Ash.destroy` / `Ash.read_one` per input** (`:537`, `:1723`, `:1989`, `:2106`). That per-input nesting is the N+1 of issue #1581 (§12.B item 19).

A **bulk path** exists but is narrow: `Ash.bulk_create` is used (`:1361`, `:1509`, `:1638`) only when `opts[:bulk?] == true`, `on_no_match` is `{:create, …}`, and the destination supports `:bulk_create`; for the one-step form it additionally requires that the relationship is not many-to-many (`can_bulk_create?/2`, `:879-890`). **Updates and destroys are always sequential**, which is exactly what the maintainer described in #1581 on 2026-03-21 ("it's the update case that still needs to be done").

### 1.6 Read

Entry: `Ash.read` → `Ash.Actions.Read.run/4`. The main path is **`do_read/5`** (`scratch/ash-src/ash/lib/ash/actions/read/read.ex:569-850`); `data_layer_query/5` (`read.ex:896`) is only used when the caller passes `data_layer_query?: true` (`read.ex:420-427`). A read **does** open a data-layer transaction when the action sets `transaction? true` — `maybe_in_transaction/3` calls `Ash.DataLayer.transaction` on `query.action.transaction?` (`read.ex:1650-1676`; the action option defaults to `false`, `scratch/ash-src/ash/lib/ash/resource/actions/read.ex:27`). When a transaction is opened, the `after_transaction` hooks run **inside** it, because they are inside the function passed to `maybe_in_transaction` (`read.ex:653`, `:819-823`). When it is not, the phases below simply run outside a transaction.

1. Span `:action` and telemetry `[:ash, <domain>, :read]`; `around_transaction` hooks wrap everything that follows (`read.ex:66-120`).
2. `do_run` → **`for_read`** (`scratch/ash-src/ash/lib/ash/query/query.ex:893-963`): apply `opts[:load]`, tracer span `:query` + telemetry `[:ash, :query]`, set action, actor, tenant and `as_of`, then `cast_params`, `set_argument_defaults`, `require_arguments`, **`run_preparations`**, `add_action_filters` (`query.ex:960-963`), then mark `__validated_for_action__`. `run_preparations` runs **global preparations, then action preparations, then global read validations** (`query.ex:1122-1167`); a validation with `before_action? true` is turned into a query `before_action` hook.
3. `add_field_level_auth` (each authorizer's `initial_state`, then `add_calculations` — field policies inject calculations), timeout, calculation context, pagination, `load_and_select_sort`, relationship count aggregates, **`split_and_load_calculations`**, ensure selected (`read.ex:267-418`).
4. `do_read` (`read.ex:569`): `handle_multitenancy` → `add_select_if_none_exists` → **`authorize_query`** (`Ash.can`, `pre_flight?: false`, `filter_with: opts[:authorize_with] || :filter`, `alter_source?: true`, `read.ex:579`) → calc context into sort, then into filter → **`run_before_transaction_hooks`** (`read.ex:609`). The order matters: **authorization runs before `before_transaction`**, not after.
5. **The transaction opens** if `action.transaction?` (a timeout task wraps the work otherwise) (`read.ex:653`, `:1650-1676`).
6. [T?] Hydrate calculations, aggregates, sorts and combinations; expand relationship-path authorization filters (`relationship_filters`, `authorize_calculation_expressions`, `authorize_loaded_aggregates`, `authorize_sorts`, `filter_with_related`, other-data-layer filters, `update_aggregate_filters`) (`read.ex:654-780`).
7. [T?] **`run_before_action`** — loads added here are ignored with a warning ("Load statements added in `before_action` hooks are not supported and will be ignored. Use `prepare` to add loads", `read.ex:3905-3930`) → `fetch_count` when a count is requested → paginate → build the data-layer query → **run the query** → `validate_get` → drop the pagination extra → `add_keysets` → **`run_authorize_results`** → **`run_after_action`** (`read.ex:781-818`). Read `after_action` hooks are **prepended**, so they run in reverse insertion order, unless `config :ash, read_action_after_action_hooks_in_order?: true` (compile default `false`, `query.ex:250-253`, `:1612-1620`).
8. [T?] Notifications are sent or stored → **`run_after_transaction_hooks`**, inside the transaction when one was opened (`read.ex:819-823`).
9. [Outside:] the transaction closes and queued notifications flush (`read.ex:1716-1720`).
10. [Outside:] `add_read_metadata` → `load_through_attributes` → **`load_relationships`** (each relationship is a nested read with its own authorization) → **runtime calculations** → `load_through_attributes` again → `restrict_field_access` → page (`read.ex:465-513`).

There is **no `around_action` on reads**; `query.before_action`, `query.after_action` and `query.authorize_results` are the three hook lists.

### 1.7 Where the guides and the code disagree

The documentation is not a reliable ordering source; two contradictions found 2026-10-01:

- `scratch/ash-src/ash/documentation/topics/actions/read-actions.md:104-115` lists "Run before action hooks" **before** "Strict Check & Filter Authorization". The code does the opposite: `authorize_query` at `read.ex:579`, `run_before_action` at `read.ex:781`.
- `scratch/ash-src/ash/documentation/topics/actions/actions.md:635` says resource-level "Preparations/Validations/Changes are no longer part of the core action lifecycle", yet `changeset.ex:3616-3621` and `:4328-4344` still run them during `for_create`/`for_update`/`for_destroy`.

The same file (`actions.md:636`) says before/after action hooks run "in the order they are added (not reverse order)" — true for writes, false for read `after_action` hooks unless the config flag is set (above). Treat the guides' lifecycle diagrams as approximations; §§1.1–1.6 are the authority.

---

## 2. Atomic and bulk execution

### 2.1 What "atomic" means

Atomicity in Ash is not a database feature — it is a **protocol by which a change rewrites itself into expressions**. `Ash.Resource.Change`'s `atomic/3` returns one of (`scratch/ash-src/ash/lib/ash/resource/change/change.ex:380-441`):

| Return | Meaning |
| --- | --- |
| `{:atomic, %{attr => expr}}` | values for the UPDATE phase; existing values referenced via `atomic_ref(:field)` |
| `{:atomic_set, %{attr => expr}}` | values for the INSERT phase of a create; `atomic_ref/1` is not allowed (no existing row) |
| `[{:atomic, ...}, {:atomic_set, ...}]` | both phases, for upserts |
| `{:atomic, changeset, %{attr => expr}, constraints}` | plus per-field constraints: `{:atomic, involved_fields, condition_expr, error_expr}` |
| `{:ok, changeset}` | applied in memory instead |
| `{:not_atomic, reason}` | cannot be atomic; the caller decides what to do |
| `:ok` | nothing to do |

Constraints are **not** installed as database `CHECK` constraints: they are compiled into the write statement itself as conditional `ash_raise_error(...)` expressions. `apply_atomic_constraints` is defined at `scratch/ash-src/ash/lib/ash/changeset/changeset.ex:3880` and is called from `fully_atomic_changeset/4` at `:875-877`. See §4.2 for `ash_raise_error`.

`always_atomic? true` on a change/validation turns a failure to be atomic into an error rather than a silent fallback (`changeset.ex:3679-3723`): "Change … was configured with `always_atomic?` to `true`, but could not be done atomically: #{reason}". Create actions can never be atomic in this sense — attempting it raises `Ash.Error.Framework.CanNotBeAtomic` (`changeset.ex:3679-3689`).

### 2.2 `require_atomic?`

`require_atomic?` defaults to `Application.compile_env(:ash, :require_atomic_by_default?, true)` on **explicitly declared** update and destroy actions (`scratch/ash-src/ash/lib/ash/resource/actions/update.ex:20`, `.../destroy.ex:16`). Actions generated by `defaults [...]` are handled by a transformer that reads a *different* config, `:default_actions_require_atomic?`, whose compile-time default is **`false`**; the Ash installer sets it to `true` in newly generated apps (`scratch/ash-src/ash/lib/ash/resource/transformers/set_primary_actions.ex:18-22`, `:150-158`; `scratch/ash-src/ash/lib/mix/tasks/install/ash.install.ex:188`).

The compile-time check **warns, it does not reject**: `Ash.Resource.Verifiers.VerifyActionsAtomic` returns `{:warn, Enum.map(warnings, &Exception.message/1)}` (`scratch/ash-src/ash/lib/ash/resource/verifiers/verify_actions_atomic.ex:147`). The hard failure happens at run time: when an update cannot be made atomic but the action has `require_atomic? true` and the data layer had the capability, Ash raises `Ash.Error.Framework.MustBeAtomic` (`scratch/ash-src/ash/lib/ash/actions/update/update.ex:257-269`). With `require_atomic? false`, `atomic_upgrade?` (default `true`) still upgrades individual calls opportunistically (`update.ex:68-70`).

### 2.3 Bulk strategies

These are the strategies for **`Ash.bulk_update/4` and `Ash.bulk_destroy/4`** — *not* for `Ash.update_many` and *not* for `Ash.bulk_create/4`, which has no `:strategy` option at all (see below). `Ash.update_many/3` is a different API again: it takes a list of `{record_or_identifier, input}` tuples and has its own strategy defaults and docstring (`scratch/ash-src/ash/lib/ash.ex:3868-3900`). The semantics below come from the update-actions guide (`scratch/ash-src/ash/documentation/topics/actions/update-actions.md:179-227`) and from the option declarations (`ash.ex:574-578` for bulk_update, `:634-639` for bulk_destroy).

| Strategy | Behaviour | What is lost |
| --- | --- | --- |
| `:atomic` | The subject is a query and the action can be done atomically: one `update_query`/`destroy_query` over the query — a single `UPDATE … WHERE <filter>` (or `DELETE`) statement. **Default**: `[:atomic]` for `Ash.bulk_update`, `:atomic` for `Ash.bulk_destroy`. | Every per-record change and hook. The atomic strategies run no `change/3`, no `before_action`/`around_action` and no per-record notifications; only hooks re-attached as `atomic_after_action`/`atomic_after_transaction` survive (the re-attachment is at `update.ex:128-148`; `update.ex:64` and `:80-84` are the dirty-hook disqualifier). A query carrying `before_action` or `after_action` hooks cannot be updated atomically at all (`scratch/ash-src/ash/lib/ash/actions/update/bulk.ex:98-102`). |
| `:atomic_batches` | The subject is an enumerable: records are pulled out in `:batch_size` (default 1000) batches and each batch is updated with one atomic statement (`WHERE id IN (…)`) (`update-actions.md:203-221`). | The same per-record hooks as `:atomic`, plus whole-input atomicity: N statements, not one. |
| `:stream` | A changeset per record, one at a time; each record goes through the full non-atomic write path (`update-actions.md:224-227`). | Concurrency safety and speed — "it will naturally be slower than the other two strategies" (`update-actions.md:226`). But it is the **only** strategy that runs `change/3`, `before_transaction`, `before_action` and `around_action` per record, and produces per-record notifications. |

Selection happens in `set_strategy/3` (`scratch/ash-src/ash/lib/ash/actions/update/bulk.ex:1232-1248`; destroy: `scratch/ash-src/ash/lib/ash/actions/destroy/bulk.ex:905-918`):

- the data layer lacks `:update_query` → the strategy is **forced to `[:stream]`**;
- it has `:update_query` but lacks `:expr_error` → updates default to all three (`[:stream, :atomic_batches, :atomic]`), because authorization cannot be embedded in the statement. **Destroy requires both `:update_query` and `:expr_error`** and otherwise falls back to `[:stream]` — note that it tests `:update_query`, not `:destroy_query`, even though it then emits a `destroy_query`; that looks like an upstream quirk and is reproduced faithfully here (`scratch/ash-src/ash/lib/ash/actions/destroy/bulk.ex:906-912`);
- the input is an enumerable and `:atomic` was requested → `:atomic_batches` is prepended automatically.

| API | How it batches | Per-record hooks | Source |
| --- | --- | --- | --- |
| `Ash.bulk_create/4` — **no `:strategy` option** (its option schema is `ash.ex:673-741`) | Batches the inputs and calls `Ash.DataLayer.bulk_create/3` when the data layer supports `:bulk_create` (`scratch/ash-src/ash/lib/ash/actions/create/bulk.ex:186`). Changesets carrying `around_transaction` or `around_action` hooks are split out and run **one by one** through the single-record path (`scratch/ash-src/ash/lib/ash/actions/helpers.ex:18-37`) | `before_transaction` runs per changeset in `split_and_run_simple` (`helpers.ex:18-37`); `before_action` (`create/bulk.ex:1183-1187`), `after_action` (`:1589`) and `after_transaction` (`:1647`) each run **per changeset** as the batch is iterated. Only the data-layer `bulk_create` call itself is per batch | `ash/lib/ash.ex:673-741`; `create/bulk.ex:186`, `:1183-1187`, `:1589`, `:1647`; `helpers.ex:18-37` |

When no allowed strategy applies, `Ash.Error.Invalid.NoMatchingBulkStrategy` reports each strategy together with its rejection reason (`not_stream_reason`, `not_atomic_batches_reason`, `not_atomic_reason`) (`scratch/ash-src/ash/lib/ash/error/invalid/no_matching_bulk_strategy.ex:22-56`).

Changes also have **batch** callbacks that only run on the streaming path: `batch_change/3`, `before_batch/3`, `after_batch/3`, `batch_callbacks?/3` (`scratch/ash-src/ash/lib/ash/resource/change/change.ex:325-367`). The `Ash.update_many` docstring is the one that says "per-record `after_action` hooks force a non-atomic action and run on the streaming path instead" (`ash.ex:3893-3895`).

---

## 3. The data layer contract

### 3.1 Required vs. optional callbacks

`Ash.DataLayer` declares **46 `@callback`s** (`scratch/ash-src/ash/lib/ash/data_layer/data_layer.ex:141-377`; `upsert/3` and `upsert/4` are two separate declarations). The `@optional_callbacks` declaration lists **44** of them (`data_layer.ex:379-421`). **Two are required: `can?/2` (`data_layer.ex:364`) and `resource_to_query/2` (`data_layer.ex:180`).**

The 44 optional callbacks: `functions/1`, `combination_of/3`, `filter/3`, `combination_acc/1`, `sort/3`, `distinct_sort/3`, `distinct/3`, `prefer_lateral_join_for_many_to_many?/0`, `limit/3`, `offset/3`, `data_layer_keyset_by_default?/0`, `select/3`, `set_tenant/3`, `set_as_of/3`, `transform_query/1`, `run_query/2`, `lock/3`, `run_aggregate_query/3`, `run_aggregate_query_with_lateral_join/5`, `run_query_with_lateral_join/4`, `return_query/2`, `bulk_create/3`, `create/2`, `upsert/3`, `upsert/4`, `update/2`, `update_query/4`, `destroy_query/4`, `update_many/3`, `add_aggregate/3`, `add_aggregates/3`, `add_calculation/4`, `add_calculations/3`, `destroy/2`, `transaction/4`, `in_transaction?/1`, `source/1`, `rollback/2`, `calculate/3`, `prefer_transaction?/1`, `prefer_transaction_for_atomic_updates?/1`, `default_bulk_batch_size/2`, `set_context/3`, `attribute_ecto_type/2`.

### 3.2 `can?/2` features

`@type feature()` (`data_layer.ex:88-137`): `:transact`, `:multitenancy`, `:temporal`, `:combine`, `{:combine, type}`, `{:atomic, :update | :upsert | :create}`, `{:exists, :unrelated}`, `{:lateral_join, [resources]}`, `{:join, resource}`, `{:aggregate, :unrelated}`, `{:aggregate, kind}`, `{:aggregate_relationship, rel}`, `{:query_aggregate, kind}`, `:select`, `:expr_error`, `:calculate`, `:expression_calculation`, `:expression_calculation_sort`, `:aggregate_filter`, `:aggregate_sort`, `:boolean_filter`, `:async_engine`, `:bulk_create`, `:bulk_create_with_partial_success`, `:update_query`, `:destroy_query`, `:update_many`, `:create`, `:read`, `:update`, `:destroy`, `:limit`, `:offset`, `:keyset`, `:filter`, `:composite_type`, `{:lock, lock_type}`, `{:filter_expr, struct}`, `{:filter_relationship, rel}`, `:sort`, `{:sort, type}`, `:upsert`, `:composite_primary_key`, `:through_relationship`, `:bulk_upsert_return_skipped`.

Three caveats on this list: the type has 48 alternatives as written but lists `:transact` twice (`data_layer.ex:89` and `:125`), so there are **47 distinct** features; written as the 45-item list above the three `{:atomic, …}` alternatives count once. And the type is **not exhaustive** — core queries features it does not declare, including `:timeout` (`scratch/ash-src/ash/lib/ash/query/query.ex:977`), `:atomic_update` (`scratch/ash-src/ash/lib/ash/actions/update/update.ex:578`), `:changeset_filter`, `:action_select`, `:required_error`, `:nested_expressions`, `:distinct` and `:distinct_sort`.

### 3.3 How core reacts to a missing capability

Ash resolves `can?/2` through `Ash.DataLayer.data_layer_can?/2` (`data_layer.ex:464`) and reacts in three distinct ways:

1. **Hard error.** Missing `{:atomic, …}` → `Ash.Error.Invalid.AtomicsNotSupported` (`create.ex:31`, `:322-333`). Missing `:expression_calculation` while hydrating calculations → a plain string error, "Expression calculations are not supported by #{data_layer}" (`read.ex:4560-4562`). Missing `:transact` prevents the transaction from being opened at all (`changeset.ex:4765-4766`).
2. **Strategy downgrade.** Missing atomic support turns a `:not_atomic` reason string that the bulk strategies then either accept (fall back to `:stream`) or reject (`NoMatchingBulkStrategy`), §2.3.
3. **In-memory fallback.** Missing `:expression_calculation` makes `can_expression_calculation?` false in `split_and_load_calculations`, which pushes the calculation to `calculations_at_runtime` and it is evaluated by `Ash.Actions.Read.Calculations.run` over the fetched records (`calculations.ex:940-942`, `:1015-1022`; `read.ex:481-486`). Missing `{:lateral_join, resources}` makes `lateral_join?/4` return false, so the related records are fetched by a **separate query** (`relationships.ex:1863-1867`). Missing `:timeout` makes `Ash.Query.timeout/2` add `Ash.Error.Query.TimeoutNotSupported` (`query.ex:975-981`). Missing `:expr_error` with `authorize?` forces an update out of atomic mode (`update.ex:70-71`).

### 3.4 Built-in data layers

| Data layer | File | Notable `can?` answers |
| --- | --- | --- |
| `Ash.DataLayer.Simple` (no persistence) | `scratch/ash-src/ash/lib/ash/data_layer/simple/simple.ex:18-32` | `:create`, `:bulk_create`, `:update`, `:destroy`, `:sort`, `:limit`, `:offset`, `{:sort,_}`, `:filter`, `:boolean_filter`, `:composite_primary_key`, `:nested_expressions`, `{:filter_expr,_}`, `:multitenancy`; everything else `false` |
| `Ash.DataLayer.Ets` | `scratch/ash-src/ash/lib/ash/data_layer/ets/ets.ex:214-291` | all aggregates (`:count`, `:first`, `:sum`, `:list`, `:max`, `:min`, `:avg`, `:exists`, `:unrelated`), `:temporal`, `:upsert`, `:calculate`, `:update_query`, `:destroy_query`, `:distinct`, `:combine`, `:lateral_join`, `:expression_calculation(_sort)`, `:expr_error`, `:changeset_filter`, `:multitenancy`, `:through_relationship`, `{:filter_relationship, _}`; **`:transact` is `false`**; `:update`/`:destroy` are true only when the resource has a primary key (`:249-252`); `:async_engine` only when not private; `{:join,_}` unless `Application.compile_env(:ash, :no_join_mnesia_ets)` |
| `Ash.DataLayer.Mnesia` | `scratch/ash-src/ash/lib/ash/data_layer/mnesia/mnesia.ex:89-151` | A **standalone data layer** (`@behaviour Ash.DataLayer`, `mnesia.ex:6`), not an ETS wrapper. True: all aggregates, `{:atomic, :update/:upsert/:create}`, `:expression_calculation(_sort)`, `:expr_error`, `:upsert`, `:calculate`, `:nested_expressions`, `{:filter_expr,_}`, `{:filter_relationship,_}`, `:through_relationship`, `:boolean_filter`, `:aggregate_filter`, `:aggregate_sort`, `:composite_primary_key`, and **`:transact` true (`:106`)** — the only built-in data layer with transactions. False (falls through to `def can?(_, _), do: false`): `:multitenancy`, `:update_query`, `:destroy_query`, `:lateral_join`, `:combine`, `:temporal`. |

ETS's `false` answers are why `Ash.Error.Forbidden.CannotFilterCreates` fires for ETS-backed resources in `access_type :filter` create policies (`documentation/topics/security/policies.md:290-295`).

### 3.5 How `ash_sql` and `ash_postgres` split the work

- `AshPostgres.DataLayer` is the module that declares `@behaviour Ash.DataLayer` (`scratch/ash-src/ash_postgres/lib/data_layer.ex:436`) and owns everything database-shaped: repo config, the `postgres do` DSL (`table`, `repo`, `migrate?`, `schema`, `manage_tenant`, `custom_indexes`, `statement`, `migration_primary_key`…), `set_tenant/3` for schema-based multitenancy, `attribute_ecto_type/2`, and the custom aggregate/index/extension DSL.
- `ash_sql` is the **SQL translation library**. It does have a behaviour of its own: **`AshSql.Implementation`**, with **24 callbacks** of which `determine_types/3` is optional. It is where data-layer-specific pieces live, notably `expr/6` overrides for expressions the generic translation cannot express (`scratch/ash-src/ash_sql/lib/implementation.ex:7-89`); `ash_postgres` implements it in `scratch/ash-src/ash_postgres/lib/sql_implementation.ex:7`. Alongside it, `ash_sql` contains `AshSql.Expr` (expression → `Ecto.Query.dynamic`), `AshSql.Filter`, `AshSql.Join`, `AshSql.Sort`, `AshSql.Aggregate`, `AshSql.Atomics`, `AshSql.Calculation`, `AshSql.Distinct`, `AshSql.Bindings`, `AshSql.AggregateQuery`. `AshSql.Filter.filter/4` joins relationships first, adds used aggregates, then reduces the filter into `Ecto.Query.where` with a binding accumulator (`scratch/ash-src/ash_sql/lib/filter.ex:9-58`).
- `ash_sql`'s own docs: `documentation/topics/advanced/expressions.md` in `ash_postgres`.

---

## 4. AshPostgres specifics

### 4.1 Filters/expressions → SQL

`AshSql.Expr.dynamic_expr(query, expr, bindings, embedded?, type, acc)` walks the `Ash.Query.*` AST and returns `{Ecto.Query.dynamic(...), acc}` (`scratch/ash-src/ash_sql/lib/expr.ex:93-107`). Representative renderings:

- `is_nil(left)` → `Ecto.Query.dynamic(is_nil(^left_expr))` (`expr.ex:158`)
- `not(expr)` → `Ecto.Query.dynamic(not (^new_expression))` (`expr.ex:138`)
- `is_distinct_from` → `Ecto.Query.dynamic(fragment("(? IS DISTINCT FROM ?)", ^l, ^r))` (`expr.ex:273`)
- `ago(n, unit)` → `Ecto.Query.dynamic(fragment("(?::timestamp - ?)", ^DateTime.utc_now(), ^duration))` (`expr.ex:335`)
- `get_path(ref, [2])` → `Ecto.Query.dynamic(fragment("(?)[? + 1]", ^left, ^right))` (`expr.ex:449`)
- Anything with no native Ecto macro becomes a `%Ash.Query.Function.Fragment{arguments: [{raw: "...", expr: ...}]}` (`expr.ex:736-750`, and 30+ further sites)

`Ash.Query.Function.Fragment.new/1` enforces that the number of `?` slots equals the number of extra arguments (`scratch/ash-src/ash/lib/ash/query/function/fragment.ex:30-45`). This is the escape hatch users reach for with SQL Postgres cannot express (`AshSql.Expr.default_dynamic_expr`).

### 4.2 Database objects installed

`AshPostgres.MigrationGenerator.AshFunctions` (`@latest_version 7`, `ash_functions.ex:6`) installs (all `SET search_path = ''`, i.e. hardening):

| Object | Source |
| --- | --- |
| `ash_elixir_or(BOOLEAN, ANYCOMPATIBLE, out ANYCOMPATIBLE)` → `COALESCE(NULLIF($1, FALSE), $2)` | `scratch/ash-src/ash_postgres/lib/migration_generator/ash_functions.ex:15-21` |
| `ash_elixir_or(ANYCOMPATIBLE, …)` → `COALESCE($1, $2)` | `ash_functions.ex:24-30` |
| `ash_elixir_and(BOOLEAN, …)` → `CASE WHEN $1 IS TRUE THEN $2 ELSE $1 END` | `ash_functions.ex:32-42` |
| `ash_elixir_and(ANYCOMPATIBLE, …)` | `ash_functions.ex:43-53` |
| `ash_trim_whitespace(text[])` (plpgsql) | `ash_functions.ex:55-78` |
| `ash_required(ANYCOMPATIBLE, jsonb)` | `ash_functions.ex:237-254` |
| `ash_raise_error(jsonb)` and `ash_raise_error(jsonb, ANYCOMPATIBLE)` | `ash_functions.ex:256-286` |
| `uuid_generate_v7()` (unless `use_builtin_uuidv7_function?`) | `ash_functions.ex:288-322` |
| `AshPostgres.Extensions.ImmutableRaiseError` (opt-in via the repo's `installed_extensions`; installs `ash_raise_error_immutable` **and** `ash_to_jsonb_immutable`) | `scratch/ash-src/ash_postgres/lib/extensions/immutable_raise_error.ex:6-47` |

`ash_raise_error` is a `STABLE` plpgsql function that raises `RAISE EXCEPTION 'ash_error: %', json_data::text` and returns NULL (`ash_functions.ex:259-271`; prefix constant `ash_functions.ex:7`). This is how an expression-level constraint violation in a data-layer-executed expression becomes a structured Ash error. The extension version is tracked in a snapshot file so upgrades generate an `install_ash_functions_extension_v7_<ts>` migration (`migration_generator.ex:262-315`).

### 4.3 The migration generator

`AshPostgres.MigrationGenerator.generate/2` (`scratch/ash-src/ash_postgres/lib/migration_generator/migration_generator.ex:29-140`):

1. Collect resources from the domains, keep only `AshPostgres.DataLayer` ones (`migration_generator.ex:33-39`).
2. Split by `migrate?(resource)` into managed / unmanaged (`migration_generator.ex:41-42`). Unmanaged still gets snapshots.
3. Split snapshots by `multitenancy.strategy == :context` (tenant migrations, separate `tenant_migration_path`) vs. global; `:global` tenant resources are folded into the global set with their multitenancy stripped (`migration_generator.ex:44-66`).
4. `create_extension_migrations` (compares `repo.installed_extensions()` against the snapshot's `installed` list) (`migration_generator.ex:74-75`, `:268-315`).
5. `create_migrations` per snapshot set.

A **snapshot** is a plain JSON-serializable map built by `do_snapshot/3`, with fields `attributes`, `identities`, `table`, `schema`, `check_constraints`, `custom_indexes`, `custom_statements`, `repo`, `multitenancy`, `temporal`, `base_filter`, `has_create_action`, `create_table_options`, plus a sha256 `hash` (`migration_generator.ex:3878-3898`). There is no `empty?` field — the map at `migration_generator.ex:2108-2127` is the *empty* snapshot used as the base of create-table diffs. Snapshots live in `priv/resource_snapshots` by default (`migration_generator.ex:226-234`).

Diffing compares each snapshot to its predecessor and emits `%Operation{}` records (`migration_generator.ex:2153+`). The complete operation vocabulary is:

`CreateTable`, `DropTable`, `RenameTable`, `MoveTableSchema`, `AddAttribute`, `RemoveAttribute`, `RenameAttribute`, `AlterAttribute`, `AddPrimaryKey`, `RemovePrimaryKey`, `AddPrimaryKeyDown`, `RemovePrimaryKeyDown`, `AlterDeferrability`, `AddUniqueIndex`, `RemoveUniqueIndex`, `RenameUniqueIndex`, `AddReferenceIndex`, `RemoveReferenceIndex`, `AddCustomIndex`, `RemoveCustomIndex`, `AddCheckConstraint`, `RemoveCheckConstraint`, `AddCustomStatement`, `RemoveCustomStatement`, `SerialSequenceTransition`, `AddTemporalForeignKey`, `DropForeignKey`.

Ordering is a **fact/provide-require dependency graph**, not a hand-written phase list. `AshPostgres.MigrationGenerator.OperationDeps` documents that each operation may *provide* facts (e.g. `:table_structure_ready`, `:column_ready`) and *require* facts; `toposort_operations/1` builds the graph and topologically sorts it (`scratch/ash-src/ash_postgres/lib/migration_generator/operation_deps.ex:1-45`). Cycles raise `OperationCycleError`, whose message tells the user to split mutually-referencing tables across migrations or make one FK nullable/deferrable, and to open an issue otherwise (`scratch/ash-src/ash_postgres/lib/migration_generator/operation_cycle_error.ex:12-35`). Phases (`Phase.Create`, and others in `scratch/ash-src/ash_postgres/lib/migration_generator/phase.ex`) render grouped operations into Ecto migration source; `Phase.Create` emits `execute("CREATE SCHEMA IF NOT EXISTS ...")` for schemas and switches to `prefix()` when multitenancy is `:context` (`phase.ex:20-58`).

**What the user reviews:** the generated `.exs` migration files, plus *review flags*. The generator prints warnings for things a human must decide (`emit_review_warnings`, `migration_generator.ex:620`) and writes files with `Mix.Generator.create_file(file, contents, force: true)` — `force: true` means it overwrites **without prompting** (`migration_generator.ex:126-129`). `--check` raises `Ash.Error.Framework.PendingCodegen` with the diff, for CI (`migration_generator.ex:110-112`); `--dry-run` prints to stdout (`migration_generator.ex:114-121`).

**What it cannot generate** — anything not derivable from the resource DSL: triggers, materialized views, sequences beyond the serial transition, custom SQL functions, row-level security policies, partitioning (`partitioned-tables.md` is a manual guide), extensions' internals, and data backfills. `custom_indexes` and `statement` (raw up/down or code) are the escape hatches (`data_layer.ex:63-80`). Working against a database you do not own is supported by `migrate? false` plus Spark fragments (`documentation/topics/resources/working-with-existing-databases.md:9-46`).

---

## 5. The expression engine (`Ash.Expr`)

### 5.1 An expression is data

`Ash.Expr.t()` is `any` (`scratch/ash-src/ash/lib/ash/expr/expr.ex:12`). `expr(...)` is a macro, but it does **not** produce resolved operator structs: at compile time it emits an **unresolved** `%Ash.Query.Call{name, args, operator?: true}` node for operators and function calls, and `ref` nodes for field references (`expr.ex:826`, `:839`). Resolution into the concrete `Ash.Query.Operator.*` / `Ash.Query.Function.*` structs, bound to a resource, happens later, when the filter is parsed (`Ash.Filter.resolve_call`, `scratch/ash-src/ash/lib/ash/filter/filter.ex:3727-3876`; `hydrate_refs`, `filter.ex:4178`). So an expression is a **two-stage representation**: a Call/ref tree that is cheap to build, then a resolved operator/function tree that can be evaluated or compiled. The node types:

| Node | Struct | Source |
| --- | --- | --- |
| Reference to a field/relationship/calculation/aggregate | `Ash.Query.Ref{attribute, resource, simple_equality?, bare?, input?, combinations?, relationship_path}` | `scratch/ash-src/ash/lib/ash/query/ref.ex:7-16` |
| Function call | `Ash.Query.Call{name, args, relationship_path, operator?}` | `scratch/ash-src/ash/lib/ash/query/call.ex:8` |
| Operator | one struct per operator, e.g. `Ash.Query.Operator.Eq{left, right}` (generated by the `use Ash.Query.Operator` macro) | `scratch/ash-src/ash/lib/ash/query/operator/eq.ex:14-19` |
| Boolean combination | `Ash.Query.BooleanExpression{op, left, right}` | `scratch/ash-src/ash/lib/ash/query/boolean_expression.ex:9` |
| Negation | `Ash.Query.Not{expression}` | `scratch/ash-src/ash/lib/ash/query/not.ex:7` |
| Filter wrapper | `Ash.Filter{resource, expression}` | `scratch/ash-src/ash/lib/ash/filter/filter.ex:242` |

`Ash.Query.Operator` is a behaviour with **8 callbacks, none optional**: `new/2`, `to_string/2`, `evaluate/1`, `evaluate_nil_inputs?/0`, `types/0`, `returns/0`, `predicate?/0`, `can_return_nil?/1` (`scratch/ash-src/ash/lib/ash/query/operator/operator.ex:23-64`). Functions have their own behaviour, `Ash.Query.Function`, with **11 callbacks** of which `partial_evaluate/1` is optional (`scratch/ash-src/ash/lib/ash/query/function/function.ex:19-65`). `Ash.Filter.Predicate` adds `compare/2`, `bulk_compare/1` and `simplify/1`, all optional (`scratch/ash-src/ash/lib/ash/filter/predicate.ex:24-48`) — `compare/2` is what lets Ash merge `x == 1 and x != 1` into `false` (`scratch/ash-src/ash/lib/ash/query/operator/eq.ex:52-63`). Boolean expression construction is aggressively simplified: `and`/`or` with `nil`/`true`/`false` collapse (`scratch/ash-src/ash/lib/ash/query/boolean_expression.ex:12-56`).

### 5.2 Templates

In DSL modules an expression is a **template** whose references are Erlang tuples substituted at runtime by `Ash.Expr.fill_template/2` (`expr.ex:222-320`). The user-facing list (`documentation/topics/reference/expressions.md:187-197`):

| Template | Runtime substitution | Source |
| --- | --- | --- |
| `^actor(:key)` / `^actor([:k1,:k2])` | `Map.get(actor, …)`; `^actor(:_primary_key)` becomes `Map.take(actor, primary_key)` | `expr.ex:264-277` |
| `^arg(:name)` | `Map.fetch(args, name)` falling back to the string key | `expr.ex:286-293` |
| `^context(:key)` / `^context([…])` | `Map.get(context, …)` / `get_path` | `expr.ex:309-315` |
| `^ref(:key)` / `^ref([:path], :key)` | `Ash.Query.Ref` with a filled attribute name / relationship path | `expr.ex:317-322` |
| `^atomic_ref(:field)` | `Ash.Changeset.atomic_ref(changeset, field)` | `expr.ex:295-302` |
| `^tenant` (`:_tenant`) | `opts[:tenant]` | `expr.ex:279-280` |

`fill_template` **also rewrites time functions** when the changeset/query is temporal (`as_of`): `now()` becomes the `as_of` DateTime, `ago(7, :day)` becomes `datetime_add(as_of, -7, :day)`, `today()` becomes `DateTime.to_date(as_of)` (`expr.ex:231-256`).

`parent/1` is not a fill-template placeholder — it is a real function meaning "the field of the source resource". Its scope is wider than inline aggregates: it is used in resource-based inline aggregates and filters, in relationship filters and `exists`, and in the many-to-many join-row special case `parent(join_relationship)` (`documentation/topics/reference/expressions.md:157-186`, `:233-247`). Its presence also forces the lateral-join decision on the loading path (`relationships.ex:1894`). The runtime resolves the template tuples `{:_parent, _}` / `{:_parent, _, _}` to `:unknown` (`scratch/ash-src/ash/lib/ash/filter/runtime.ex:447-448`).

### 5.3 In-memory evaluation

`Ash.Expr.eval/2` (`expr.ex:42`) and `Ash.Filter.Runtime` (`scratch/ash-src/ash/lib/ash/filter/runtime.ex:5-9`) evaluate against a record:

1. `filter_matches/4` hydrates refs once for the whole record list, computes `Ash.Filter.relationship_paths/1`, and calls `matches/4` per record (`runtime.ex:21-64`).
2. If the filter references unloaded relationships, `paths_to_load/3` + `load_records_and_parent/5` runs a **real `Ash.load!` with `authorize?: false`** to fetch them (`runtime.ex:374-391`, `:119-146`).
3. `to_many` relationships are expanded into "scenarios" — one scenario per combination of related records — and a record matches if **any** scenario matches (`runtime.ex:150-165`). This is how `comments.points > 10 and comments.tag.name == "elixir"` ends up meaning "one comment satisfying both".
4. `resolve_expr/5` walks the tree: templates → `:unknown`, `%Ref{}` → read from the record (or `nil` if `Ash.NotLoaded{}`), `%BooleanExpression{op: :and}` → short-circuits (`runtime.ex:441-500`).
5. `:unknown` resolves to `{:ok, nil}` unless `unknown_on_unknown_refs?: true` (`runtime.ex:355-371`).

### 5.4 Data-layer evaluation and the fallback

The same AST goes to the data layer. `AshSql.Expr.dynamic_expr/6` (§4.1) is the Postgres implementation. Whether a calculation goes into the query or into the app is decided by `split_and_load_calculations/6` (`calculations.ex:932-…`): a calculation whose module `has_expression?/0` **and** whose used calculations all have expressions **and** whose `calculation.context[:should_be_in_expression?]` is not explicitly false, **and** the data layer answers `:expression_calculation`, goes into the query (`calculations.ex:962-1022`, `:1151-1209`). Everything else is in `calculations_at_runtime` and is run by `Ash.Resource.Calculation.calculate/3` over the fetched records (`calculations.ex:501-530`).

When a data layer cannot run an expression the error is explicit: `"Expression calculations are not supported by #{data_layer}"` (`read.ex:4560-4562`). Expressions used in `filter`/`sort`/aggregates on a data layer without support behave analogously — the ETS layer synthesises filters in Elixir via `Ash.Filter.Runtime` instead of a join (`scratch/ash-src/ash/lib/ash/data_layer/ets/ets.ex:264-274`).

### 5.5 Custom expressions and fragments

`Ash.CustomExpression` is a behaviour with `expression/2`, `name/0`, `arguments/0` (`scratch/ash-src/ash/lib/ash/custom_expression.ex:71-101`). Register globally and recompile:

```elixir
# documentation/topics/reference/expressions.md:206-212
config :ash, :custom_expressions, [MyApp.CustomExpression]
```
```
mix deps.compile ash --force
```

`Ash.Query.Function.Fragment` is the per-call escape hatch: a string with `?` slots plus expressions, or a function or MFA (`fragment.ex:24-48`). Both appear in the AST, so both can be evaluated in-memory too (`fragment.ex:50+`).

### 5.6 Expression calculations vs. `calculate/3`

`Ash.Resource.Calculation` has optional `expression/2` and `calculate/3`, plus `load/3` (what must be selected), `init/1`, `describe/1`, `strict_loads?/0` (`scratch/ash-src/ash/lib/ash/resource/calculation/calculation.ex:209-224`). Docs recommend module calculations when "calculations require more complex code or can't be pushed down into the data layer" (`documentation/topics/resources/calculations.md:54-60`). Expression calculations can declare `calculate :full_name, :auto, expr(...)` and Ash infers `:string` / `:boolean` / `:integer` (`calculations.md:29-51`). In-memory `calculate/3` is always batch-oriented — it receives a *list* of records and returns a list (`calculations.ex:531-534`).

---

## 6. The policy engine

### 6.1 `Ash.Authorizer` behaviour

**12 callbacks.** Required (not in `@optional_callbacks`): `initial_state/4`, `strict_check_context/1`, `strict_check/2`, `check_context/1`, `check/2`. Optional: `exception/2`, `add_calculations/3`, `alter_results/3`, `alter_filter/3`, `apply_field_level_auth/3`, `evaluate_field_policies/3`, `protected_fields/1` (`scratch/ash-src/ash/lib/ash/authorizer.ex:17-94`).

`strict_check/2` returns `{:authorized, state} | {:continue, state} | {:filter, kw} | {:filter, kw, state} | {:filter_and_continue, kw, state} | {:error, term}` (`authorizer.ex:24-30`). `check/2` returns `:authorized | {:data, records} | {:error, :forbidden, state} | {:error, error}` (`authorizer.ex:71-75`).

### 6.2 Check kinds

| Kind | Behaviour | Callback | Source |
| --- | --- | --- | --- |
| Simple | `Ash.Policy.SimpleCheck` | `match?(actor, context, opts)` | `scratch/ash-src/ash/lib/ash/policy/simple_check.ex:39` |
| Filter | `Ash.Policy.FilterCheck` | `filter/3`, optional `reject/3` | `scratch/ash-src/ash/lib/ash/policy/filter_check.ex:43-46` |
| Manual | `Ash.Policy.Check` | all callbacks by hand | `scratch/ash-src/ash/lib/ash/policy/check.ex:43-130` |

`Ash.Policy.Check` full callback list: `strict_check/3`, `auto_filter/3` (optional), `check/4` (optional), `describe/1`, `expand_description/3` (optional), `prefer_expanded_description?/0`, `requires_original_data?/2`, `type/0`, `eager_evaluate?/0`, `simplify/2` (optional), `implies?/3` (optional), `conflicts?/3` (optional), `init/1` (`check.ex:43-137`). Optional list: `check: 4, auto_filter: 3, expand_description: 3, simplify: 2, implies?: 3, conflicts?: 3` (`check.ex:135-137`).

`reject/3` exists because of SQL NULL semantics: "the opposite of `owner.id == 1` … is not `not(owner.id == 1)` because in postgres that would be `NOT (owner.id = NULL)`" (`filter_check.ex:4-26`).

### 6.3 `strict_check` and `auto_filter`

`strict_check` must be cheap and must not do I/O: return `{:ok, true}` / `{:ok, false}` / `{:ok, :unknown}` (`check.ex:43-48`). The policy authorizer runs `Checker.strict_check_scenarios()` then interprets the answer (`authorizer.ex:2203-2223`):

| Scenario result | Outcome |
| --- | --- |
| `{:ok, true, _}` | `{:authorized, authorizer}` |
| `{:ok, false, _}` or `{:ok, [], _}` | treated as `:unsatisfiable` |
| `{:ok, [], _}` from `find_real_scenarios` | `maybe_strict_filter` → `strict_filter` → `{:filter, …}` |
| at least one real scenario | `{:authorized, authorizer}` |
| `:unsatisfiable` and not a generic action | With the **code default** (config unset → `no_filter_static_forbidden_reads?` defaults to `true`), `forbidden_due_to_strict_policy?/1` returns true and a statically forbidden read **raises Forbidden**. Only when `no_filter_static_forbidden_reads?: false` is configured — which the installer does for new apps — does it become `{:filter, authorizer, false}` ("match nothing") (`authorizer.ex:2232-2264`; `scratch/ash-src/ash/documentation/topics/development/backwards-compatibility-config.md:86-120`; `scratch/ash-src/ash/lib/mix/tasks/install/ash.install.ex:186`) |

`strict_filter/1` (`authorizer.ex:1751-1804`) splits the satisfying scenarios into "filterable" (all checks `access_type == :filter`, or already known true) and "needs a runtime check". For each filterable scenario it calls `auto_filter/3` per check with `:positive`/`:negative` direction, ANDs the checks within a scenario, ORs across scenarios. If anything is deferred, it returns `{:filter_and_continue, filter, authorizer}` — a distinct result so runtime checks are not silently dropped (`authorizer.ex:766-792`).

### 6.4 Policies as a boolean problem solved by SAT

`Ash.Policy.Policy` is a struct `{condition, policies, bypass?, description, access_type, error_message}` (`policy.ex:17-25`). `Policy.expression/2` builds a `Crux.Expression` over check references: per policy, `complete_expr = condition and policies_expression(policy)`; the whole thing is folded with `b(one_condition_matches and all_policies_match)` where bypasses contribute only when they actually authorize (`policy.ex:53-101`). `Crux` runs on an **optional SAT backend** — `picosat_elixir` or `simple_sat` (`scratch/ash-src/ash/mix.exs:406-408`).

`Policy.solve/1` (`policy.ex:103-131`):

```elixir
case expression do
  expr when is_boolean(expr) -> {:ok, expr, authorizer}
  expression ->
    expression
    |> Formula.from_expression()
    |> Crux.satisfying_scenarios(scenario_options)
    |> case do
      [] -> {:error, authorizer, :unsatisfiable}
      scenarios -> {:ok, Enum.uniq(Enum.map(scenarios, &Map.drop(&1, [true, false]))), authorizer}
    end
end
```

So the solver returns a **list of scenarios** — sets of checks that could all be true — not a boolean. `Check.simplify/2`, `Check.implies?/3` and `Check.conflicts?/3` exist purely to make the SAT search smaller (`check.ex:101-124`). The lower-level DNF conversion lives in `Ash.Expr.SAT.to_sat_expression/2`, which consolidates relationships, upgrades related filters to join keys, and builds an expression carrying predicate information (`scratch/ash-src/ash/lib/ash/expr/sat.ex:16-23`).

`Policy.evaluate/2` is **not** the record-level decision procedure — its own docstring says it is an error-construction helper that reads facts only (`policy.ex:165-182`): it walks the checks of a policy in source order over a supplied `facts` map, without invoking strict checks, so it is safe to call from error-construction paths. The rule it implements, and the one callers follow, is that the **first decisive** check wins: `authorize_if X` true → `:authorized`; `forbid_if X` true → `:forbidden`; `authorize_unless X` false → `:authorized`; `forbid_unless X` false → `:forbidden`; anything else leaves the policy at `:unknown`, which callers treat as forbidden. The actual authorize/deny decision for a request comes from `Checker.strict_check_scenarios` / `check_result` in the policy authorizer (§6.3).

### 6.5 Read policies become query filters

`strict_filter/1` builds the filter (above). It is returned to `Ash.Can`, which applies it. For field policies, `add_calculations/3` injects a calculation per field so the data layer can compute visibility in the same query, and `alter_filter/3` rewrites refs to forbidden fields into expressions that evaluate to `nil` (`scratch/ash-src/ash/lib/ash/policy/authorizer/authorizer.ex:796-808`; `documentation/topics/security/policies.md:833`). `alter_sort/3` rewrites sorts on protected fields (`authorizer.ex:818-860`).

Default behaviour: **reads are filtered, not errored**. "When a user is not allowed to see certain records, those records are simply filtered out… users typically get a `NotFound` error" — deliberately, to prevent enumeration attacks (`documentation/topics/security/policies.md:124-137`). `authorize_with: :error` opts back into a Forbidden error, on data layers with `:expr_error` (`policies.md:139-150`).

`access_type` controls the *latest* point a check may be applied: `:strict` (static only, else forbidden), `:filter` (default; reads filtered, update/destroy evaluated against the original record, creates evaluated post-insert inside the transaction), `:runtime` (after data is read; needs `transaction? true` and no `before_transaction`/`around_transaction` hooks) (`policies.md:227-245`).

For **create** + filter checks, Ash inserts the row, runs the user's `after_action` hooks, then issues `SELECT … WHERE pkey = ^inserted.id AND ^filter` in the same transaction; a miss rolls back and returns `Ash.Error.Forbidden` (`policies.md:271-289`). This requires `:transact` support — otherwise `Ash.Error.Forbidden.CannotFilterCreates` at pre-flight (`policies.md:290-295`).

Write policies are **not** checked in one place. The strict pass runs in `authorize/2` before `commit/3`; filter checks, runtime checks and the atomic variant run elsewhere. §6.6 gives the full placement table with source lines — and note that a runtime check runs inside the transaction **only when the action will transact**.

### 6.6 Where write authorization actually runs

The runtime write path lives in **`Ash.Can`**, not in the authorizer, and it has **six** placements depending on action type and check kind: four for create/update/destroy, one for the atomic single-record update, one for generic actions. This is the single most surprising thing about Ash's write authorization, and it is easy to get wrong when copying it.

| Action / path | Check kind | Where it runs relative to the transaction and hooks | Source |
| --- | --- | --- | --- |
| create, update, destroy — strict / simple checks | static, context-only | In `do_run`, **before** `commit/3` — therefore before `with_hooks`, before `before_transaction` and before the transaction. They are evaluated by `run_check/4` through `Ash.Authorizer.strict_check/3` (`can.ex:1027-1300`, call at `:1083`). Create calls `Ash.can` with `pre_flight?: true` (`create.ex:219-239`); update and destroy use `pre_flight?: false` (`update.ex:395-400`, `destroy.ex:186-191`). All three use the default `run_queries?: true` (`can.ex:165`) | `can.ex:1027-1300` |
| create — filter checks (`access_type :filter`) | data-dependent filter | **After `after_action`, inside the transaction**, as `authorize_results` hooks: `SELECT … WHERE pk AND ^filter`, then rollback + `Ash.Error.Forbidden` on a miss. Stashed during `authorize`, raised as `CannotFilterCreates` at install time when the data layer cannot transact, when `transaction? false`, or when there are `before_transaction`/`around_transaction` hooks without `allow_post_action_authorization?` | `can.ex:1471-1484`, `:1618-1700`; `changeset.ex:5387-5395` |
| update, destroy — runtime checks (`access_type :runtime`) | record-level | `defer_changeset_authorization?` decides, and it has **three** outcomes. **(a)** When the action *will* transact and there are no `before_transaction`/`around_transaction` hooks, the check is **deferred** and installed as a **prepended `before_action` hook, inside the transaction**. **(b)** It returns **false — do not defer** — when the resource is already in a transaction, when the data layer lacks `:transact`, or when `action.transaction? == false`; the check then runs immediately at pre-flight via `run_changeset_query`. Note where that SELECT lands: in the **first** case it runs **inside the caller's transaction**, before the action's own hooks; in the latter two there is no transaction at all, which is the check-then-act gap the next row describes. **(c)** It **raises** only for `before_transaction`/`around_transaction` hooks, which would run outside the transaction and therefore before authorization; the installed hook also raises if it fires with no active transaction | `can.ex:1392-1420` (defer test), `:1409-1419` (raise), `:1432-1462` (installed hook), `:1591-1596` (non-deferred path) |
| update, destroy, **non-atomic** — filter checks | data-dependent filter | A **SELECT on primary key + policy filter runs before the transaction opens** (`run_queries?: true` + `pre_flight?: false`). This is a **check-then-act gap**: the row can change between the check and the UPDATE | `can.ex:1591-1596`, `:1306+` |
| update, single-record atomic | any | Compiled **into the UPDATE statement** as an `ash_raise_error` expression (`authorize_changeset_with: :error`) | `update.ex:211-233` |
| generic action | strict only | **Inside** the transaction (or after `before_transaction` when there is none); filter and runtime checks raise | `action.ex:183-198`, `:277-280`, `:405-431` |

The practical consequence: "writes authorize before the transaction" is only true of the *strict* pass. Data-dependent parts of write authorization run **inside** the transaction for creates, and inside it for runtime checks **only when the action will transact**; they run **outside** it for non-atomic filter checks and for runtime checks on actions that will not transact, and **inside the statement** for atomic updates.

**Bulk paths** follow the same classification. Bulk create runs the create filter checks as **per-record `authorize_results`** (`documentation/topics/security/policies.md:316-322`); bulk update and bulk destroy authorize the *query* rather than individual records, and the per-record checks then depend on the strategy in force (§2.3).

### 6.7 Record-level evaluation: `check_result/1`

The pass behind `access_type :runtime` is `check_result/1` — it takes **one** argument, the authorizer, and is called from `check/2` (`scratch/ash-src/ash/lib/ash/policy/authorizer/authorizer.ex:755-757`; body at `:2006-2034`). Per record it works like this:

1. drop the scenarios that are impossible for this record (`scenario_impossible?/3`, `:2112`);
2. if nothing is left, the record is **forbidden**;
3. otherwise `do_check_result` (`:2074-2086`) accepts the record if any remaining scenario applies — every clause is a known fact, or the record's primary key is present in `data_facts` for that clause (`:2088-2110`);
4. otherwise `check_facts_until_known` (`:2136-2157`) picks the next **unknown** fact, runs `check_fact`, and loops until some scenario applies or none remain.

`check_fact` (`:2159+`) is the expensive step and it is **batched**: it calls `Ash.Policy.Check.check/4` **once over all records**, not once per record, and stores the authorized primary keys in `data_facts`. It **raises** — verbatim, "Attempted to use a `check/4` function on a non-read action with a resource who's data layer does not support transactions or is not currently in a transaction. This means that you have a policy set to `access_type :runtime` that is unsafe to be set as such. Authorization over create/update/destroy actions for resources that don't support transactions must only be done with filter and/or strict checks." — unless the action is a read, or the data layer supports `:transact` **and** the resource is currently in a transaction (condition at `:2163-2165`, message at `authorizer.ex:2184-2190`). This is the authorizer-side counterpart to §6.6: a write whose runtime checks need a fact that is not yet known will refuse to run unless it is inside a transaction.

The result is `:authorized` when no record was forbidden, otherwise `{:data, allowed_records}`. Reads consume `{:data, …}` to filter the results; for writes, `Ash.Can` treats anything other than authorized as forbidden.

### 6.8 Field policies

```elixir
# documentation/topics/security/policies.md:798-804
field_policies do
  field_policy :role do
    authorize_if actor_attribute_equals(:role, :supervisor)
  end
end
```

If *any* field policy exists, **all** fields must be authorized (deny-list style needs a `:*` catch-all). Primary keys are always readable (`policies.md:806-812`). Forbidden fields are replaced with `%Ash.ForbiddenField{}` in results (`policies.md:836`) and with a `nil`-evaluating expression in filters, which is why only simple and filter checks are allowed in field policies (`policies.md:838`). `Ash.can_see_fields?/4` answers "can this actor see this field" without records (`policies.md:835-844`).

### 6.9 Policy breakdowns and debugging

`Ash.Error.Forbidden.Policy.report/2` renders a breakdown on demand; `config :ash, :policies, show_policy_breakdowns?: true` inlines it into error messages; `log_policy_breakdowns: :error` logs failures; `log_successful_policy_breakdowns: :error` logs everything; `Ash.can(…, log?: true)` logs one request (`documentation/topics/security/policies.md:967-1046`). The breakdown format uses `?` (not needed), `⬇` (moved on), `🌟`/`⛔` (decisive):

```text
# policies.md:986-994
  Admins and managers can create posts | ⛔:
    authorize if: actor.admin == true | ✘ | ⬇
    authorize if: actor.manager == true | ✘ | ⬇
```

`Policy.responsible_for_forbidden/2` picks the policy blamed for a denial: condition applies, not a bypass, and its `evaluate/2` decision is `:forbidden` (preferred) or `:unknown` (`policy.ex:213-236`).

---

## 7. The loading engine

### 7.1 Relationship loads

`Ash.Actions.Read.Relationships` (2235 lines). Per relationship it builds a related query (limit/offset, sort, default_sort, relationship filter, relationship context, `hydrate_refs`) and then decides lateral join vs. separate query (`scratch/ash-src/ash/lib/ash/actions/read/relationships.ex:340-364`).

`lateral_join?/4` (`relationships.ex:1838-1912`) is a single `cond`, in this order:

1. a **manual read action** → `false` (after `raise_if_parent_expr!` if the query uses `parent()`); manual **relationships** → `false` too, since they return their own data (`relationships.ex:1840-1843`, `:1877-1881`);
2. the data layer does not answer `{:lateral_join, resources}` for `resources` = source + expanded `through` path + destination → `false` (`relationships.ex:1863-1867`);
3. many-to-many **without unique constraints on the join attributes** → `false`, after `raise_if_parent_expr!` (`relationships.ex:1869-1876`);
4. `from_many?` → `true`;
5. `limit == 1` with no relationship context/filter/sort and cardinality ≠ `:many` → returns **`has_parent_expr?`**, not `true` unconditionally;
6. `limit == 1` with a single (or unknown) source record and type ≠ many-to-many → again **`has_parent_expr?`**;
7. any `parent()` expression anywhere in the query → `true` (`relationships.ex:1893-1895`);
8. a list-form `through` → `true`;
9. many-to-many with `Ash.DataLayer.prefer_lateral_join_for_many_to_many?/0` → `true`;
10. **`limit || offset || distinct || page`** → `true` — the most common trigger in practice (`relationships.ex:1904-1907`);
11. otherwise → `false`.

When lateral, the source records are attached to the query context as `data_layer.lateral_join_source: {records, path}` (`relationships.ex:556-561`) and each returned related record carries a `__lateral_join_source__` field holding the source primary key (`relationships.ex:920-924`, `:1030`). Attachment back to parents happens in `attach_lateral_join_related_records/4` / `do_attach_related_records/4` (`relationships.ex:1728-1760`, `:1467+`). Otherwise a separate `Ash.Query.filter(attribute in ^keys)` query runs and results are grouped by the source attribute (`relationships.ex:1470-1480`).

The `distinct` interaction is the opposite of what it looks like: `distinct` **forces** a lateral join (branch 10 above), and the `ArgumentError` "Cannot yet use `distinct` when loading related records" fires when `distinct` is used **without** one (`relationships.ex:359-361`).

### 7.2 Aggregates

Aggregates are requested per relationship path or "unrelated" (resource-based). `AshSql.Aggregate.add_aggregates/4` folds used aggregates into the Ecto query and `run_aggregate_query/3` executes them (`scratch/ash-src/ash_sql/lib/filter.ex:13-22`; `scratch/ash-src/ash/lib/ash/data_layer/data_layer.ex:186-199`). Aggregates requested in a load are added to the main data-layer query, not run through a separate callback. The data-layer callback `run_aggregate_query_with_lateral_join/5` (`data_layer.ex:186-199`) has exactly **one** core caller: `read.ex:4079`, inside `run_count_query/2` (`read.ex:4062-4090`), where it counts per parent for paginated relationship loads. `add_relationship_count_aggregates/1` adds `:count` aggregates for loaded relationships so pagination works (`read.ex:310`).

**Lateral or grouped?** The strategy is chosen **per resource** by the data layer through the `aggregate_strategy/1` callback on `AshSql.Implementation` (`scratch/ash-src/ash_sql/lib/implementation.ex:75-87`), whose `use` default is `:lateral` (`:110`); `AshSql.Aggregate.strategy/2` dispatches on it to `AshSql.Aggregate.Lateral` or `AshSql.Aggregate.Grouped` (`scratch/ash-src/ash_sql/lib/aggregate.ex:146-150`). `ash_postgres` keeps the default, so related aggregates there are always lateral subqueries; `ash_sqlite` returns `:grouped` (`scratch/ash-src/ash_sqlite/lib/sql_implementation.ex:13`), because grouped means "grouped and windowed subqueries … for databases without lateral joins" and assumes SQLite-compatible SQL (offset-only query aggregates use `LIMIT -1`, list aggregates a JSON list representation).

### 7.3 Calculation dependencies

`split_and_load_calculations/6` first runs `load_calculation_requirements/…` over every calculation, which recursively resolves the calculation's `load` statements (and those loads' own calculations) into the query, with cycle detection via `checked_calculations` (`calculations.ex:1210-1250`). The split itself is §5.4. Runtime calculations then run in `Ash.Actions.Read.Calculations.run/4` after `load_relationships`, in the order returned by the splitter, and `load_through_attributes` runs before and after so `load_through` calculations can chain (`read.ex:465-497`). Each calculation gets a `:calculation` tracer span and `[:ash, :calculation]` telemetry event (`calculations.ex:557-592`).

### 7.4 Policies of the related resource

Two places:

- **On the related query.** The related query is built with `authorize?: source_query.context[:private][:authorize?]` and `actor:` (`relationships.ex:396-400`), so the destination resource's own authorizers run. For through-paths each hop is separately authorized with `Ash.can(entry_query, …, run_queries?: false, …)` and the error path is annotated with `Ash.Error.set_path(error, relationship.name)` (`relationships.ex:412-437`).
- **As path filters on the parent.** `update_aggregate_filters/10` and `expand?` inject the parent's authorization into filters/aggregates that traverse relationships (`read.ex:760-780`).
- After the read, `run_authorize_results(query, results)` runs runtime checks against the returned records, and `add_field_level_auth` scrubbing replaces `%Ash.ForbiddenField{}` (`read.ex:268`, `:3960-3974`).

---

## 8. Multitenancy at run time

Two strategies (`documentation/topics/advanced/multitenancy.md:7-27`):

| Strategy | Enforcement |
| --- | --- |
| `:attribute` | `Ash.Query.set_tenant/2` / `Ash.Changeset.set_tenant/2`; a filter `attribute == tenant` is added automatically to every query (`multitenancy.md:104-108`), and on create the attribute is **set** to the tenant (`multitenancy.md:110-116`). Missing tenant ⇒ `Ash.Error.Invalid` "Queries against … require a tenant to be specified" (`multitenancy.md:95-102`). `global? true` permits tenant-less queries. |
| `:context` | The data layer decides. For `ash_postgres` this is **schema-per-tenant** (`multitenancy.md:245-253`). |

**Where in the runtime:**

- Writes: `handle_multitenancy(changeset, action)` is step 1 of `do_run` for create/update/destroy (`create.ex:182`, `update.ex:355`, `destroy.ex:146`). For creates the tenant is also written into the multitenancy attribute (`set_tenant/1` in `create.ex:314`). `identity.all_tenants?` controls whether an identity is scoped per tenant; with `:attribute` the multitenancy attribute is added to the identity keys automatically (`create.ex:285-312`).
- Reads: `handle_multitenancy(query)` is the first step of `do_read`, *before* authorization and before the query is built (`read.ex:576`, `:2813-2840`).
- Action-level multitenancy: every action takes `multitenancy` with **four modes** — `:enforce` (default; a tenant is required), `:allow_global` (a tenant is optional), `:bypass`, `:bypass_all` (`scratch/ash-src/ash/lib/ash/resource/actions/read.ex:96-101`). On **reads**, `:bypass` merely drops the tenant filter for the resource itself, whereas `:bypass_all` additionally writes `context.shared.multitenancy = :bypass_all` so nested resources bypass tenancy too (`read.ex:2813-2840`). On **writes** both collapse to writing `:bypass_all` into the shared context, so a bypassed write also bypasses tenancy for nested actions (`create.ex:52-59`, `update.ex:44-51`).
- For `:attribute` multitenancy on update/destroy, enforcement is a **changeset filter** `expr(^ref(attribute) == ^tenant)`, not a query filter (`update.ex:831-843`, and the equivalent `handle_attribute_multitenancy` in `destroy.ex`).
- `Ash.ToTenant` converts a rich value (e.g. an `%Organization{}`) into the strategy-specific scalar (`multitenancy.md:266-284`).
- `ash_postgres`' `manage_tenant do template ["organization_", :id] end` creates/renames the tenant schema when a resource of that kind is written (`scratch/ash-src/ash_postgres/lib/data_layer.ex:7-39`).

---

## 9. Notifiers

`Ash.Notifier` behaviour: required `notify/1` and `requires_original_data?/2`; optional `load/2` (statements to load before notifying) (`scratch/ash-src/ash/lib/ash/notifier/notifier.ex:9-26`).

**Holding and release.** `Ash.Notifier.notify/1` splits the queue by `Ash.DataLayer.in_transaction?/1`: notifications for resources **currently in a transaction** are *not sent* and are returned as `unsent` ("A notification can only be sent if you are not currently in a transaction for the resource in question", `notifier.ex:180-196`). `Ash.Changeset.with_hooks` sets a process flag `:ash_started_transaction?`, collects `:ash_notifications` from the process dictionary, and after the transaction commits either takes the queued nested notifications and sends them (`changeset.ex:4786-4806`) or — if the transaction *failed but committed* because `rollback_on_error?: false` — sends them anyway ("anything queued inside of it is real and must be sent now", `changeset.ex:4809-4820`). On a real rollback it calls `restore_queued_notifications(queued_notifications)` (`changeset.ex:4822-4824`). The `rescue`/`after` blocks restore and delete the flag (`changeset.ex:4825-4834`).

So the contract is: **notifications are released after the outermost transaction commits, and are discarded if it rolls back** — except that `before_transaction`/`around_transaction` hooks already ran outside the transaction, so any side effects they performed are not rolled back (documented at `documentation/topics/security/policies.md:297-315`).

**Where notifications go relative to the rest of the lifecycle.** For create and update the order is: `after_transaction` hooks (inside `with_hooks`) → hook/nested notifications sent (`changeset.ex:4989-4996`, `:4877-4888`) → `Helpers.load` → the resource's own notification via `Helpers.notify` (`create.ex:565-581`, `update.ex:717-729`, `helpers.ex:564-594`). Two actions differ: **destroy builds and sends its notification inside the transaction** (queued until the outermost Ash transaction ends, `destroy.ex:276-289`), and **generic actions send notifications *before* the `after_transaction` hooks** (`action.ex:227-258`).

`load/2` results are loaded once per action by a calculation-dependency resolver (`notifier.ex:13-24`, `:225-229`).

`Ash.Notifier.PubSub` configures `publish :action, "event", :topic`, `publish_all`, a `module` to call `broadcast/3` on, a `prefix`, a `delimiter` and a `filter` (`scratch/ash-src/ash/lib/ash/notifier/pub_sub/pub_sub.ex:8-80`). It emits `[:ash, :notifier]` telemetry.

---

## 10. Errors and observability

### 10.1 Splode error classes

`Ash.Error` is `use Splode, error_classes: [forbidden: Ash.Error.Forbidden, invalid: Ash.Error.Invalid, framework: Ash.Error.Framework, unknown: Ash.Error.Unknown], merge_with: [Reactor.Error], filter_stacktraces: ["Ash.", "Splode."], unknown_error: Ash.Error.Unknown.UnknownError` (`scratch/ash-src/ash/lib/ash/error/error.ex:7-17`). Sub-namespaces: `Ash.Error.{action,changes,forbidden,framework,invalid,load,page,query,unknown,simple_data_layer}` (`scratch/ash-src/ash/lib/ash/error/`).

Every action wraps raised exceptions with `Ash.Error.to_error_class(e, changeset: …, stacktrace: …, bread_crumbs: ["Exception raised in: #{resource}.#{action}"])` (`create.ex:124-133`, `update.ex:341-350`, `read.ex:123-132`, `action.ex:24-38`). Errors collected on a changeset/query are aggregated at the end via `Ash.Error.to_error_class(errors, changeset: changeset)` (`create.ex:205-215`). When Splode aggregates several errors it chooses the wrapper class by **position in the `error_classes` list** — forbidden first, then invalid, then framework, then unknown — and nests the remaining errors under it (`scratch/ash-src/splode/lib/splode.ex:460-482`). Stacktraces are filtered to remove Ash/Splode frames (`error.ex:15`). `Changeset`-level keywords (`field:`, `value:`, `path:`, `message:`) are accepted everywhere an error is added (`error.ex:20-35`).

Notables: `Ash.Error.Invalid.AtomicsNotSupported`, `Ash.Error.Changes.StaleRecord`, `Ash.Error.Changes.InvalidChanges`, `Ash.Error.Framework.CanNotBeAtomic`, `Ash.Error.Framework.MustBeAtomic`, `Ash.Error.Framework.NotAtomicOverRange`, `Ash.Error.Framework.LoadOverRange`, `Ash.Error.Framework.NotTemporalSafe`, `Ash.Error.Framework.SynchronousEngineStuck`, `Ash.Error.Framework.PendingCodegen`, `Ash.Error.Invalid.NoMatchingBulkStrategy`, `Ash.Error.Query.{TimeoutNotSupported, NoSuchFunction, NoSuchOperator, NoSuchFilterPredicate, NoSuchField, InvalidFilterValue, NotFound}`, `Ash.Error.Forbidden.{Policy, Placeholder, CannotFilterCreates}`.

### 10.2 Tracing and telemetry

`Ash.Tracer` behaviour: `start_span/2`, `stop_span/0`, `get_span_context/0`, `set_span_context/1`, `set_error/1`, `trace_type?/1` (optional), `set_handled_error/2` (optional), `set_metadata/2`, `set_error/2` (optional) (`scratch/ash-src/ash/lib/ash/tracer/tracer.ex:45-61`). Configured globally with `config :ash, :tracer, MyApp.Tracer` or per-call via `tracer:` (`documentation/topics/advanced/monitoring.md:53-64`).

Trace types (each with a matching tracer span name): `:action`, `:bulk_create`, `:bulk_update`, `:bulk_destroy`, `:bulk_batch`, `:changeset`, `:query`, `:validation`, `:change`, `:calculation`, `:before_transaction`, `:before_action`, `:after_transaction`, `:after_action`, `:request_step`, `:notifier`, `:preparation`, `:custom` (`monitoring.md:72-95`).

Telemetry events, each emitted with `:start`/`:stop` and `:system_time`/`:duration`: `[:ash, <domain>, :create|:update|:read|:destroy|:action|:bulk_create|:bulk_update|:bulk_destroy]`, `[:ash, :changeset]`, `[:ash, :query]`, `[:ash, :validation]`, `[:ash, :change]`, `[:ash, :calculation]`, `[:ash, :before_action]`, `[:ash, :after_action]`, `[:ash, :preparation]`, `[:ash, :notifier]`, `[:ash, :request_step]` (`monitoring.md:32-51`). Core additionally emits **`[:ash, :before_transaction]` and `[:ash, :after_transaction]`** around those hook phases, which `monitoring.md` does not list (`changeset.ex:5091`, `:5233`; `read.ex:176`, `:232`). Every span carries `%{domain, resource, resource_short_name, actor, tenant, action, authorize?}` metadata (e.g. `create.ex:70-79`).

Honest caveat from the docs: "Due to the way before/after action hooks run, their execution time won't be included in the span created for the change… We start a corresponding `span` and emit a telemetry event for before and after hooks, but they are only so useful" (`monitoring.md:97-105`).

---

## 11. Contract table

| Behaviour | Required callbacks | Optional callbacks | Purpose |
| --- | --- | --- | --- |
| `Ash.DataLayer` (`data_layer.ex:141-377`, `:379-421`) | 2 of 46: `can?/2`, `resource_to_query/2` | the other 44, listed in full in §3.1 | Persistence + query translation. Core probes `can?/2` and degrades gracefully. |
| `Ash.Authorizer` (`authorizer.ex:17-94`) | `initial_state/4`, `strict_check_context/1`, `strict_check/2`, `check_context/1`, `check/2` | `exception/2`, `add_calculations/3`, `alter_results/3`, `alter_filter/3`, `apply_field_level_auth/3`, `evaluate_field_policies/3`, `protected_fields/1` | Pre-flight → filter → post-read authorization. |
| `Ash.Notifier` (`notifier.ex:9-26`) | `notify/1`, `requires_original_data?/2` | `load/2` | Post-commit side effects. |
| `Ash.Type` (`type.ex:311-759`) | 33 of 58, including `storage_type/1`, `cast_input/2`, `cast_stored/2`, `dump_to_native/2`, `ecto_type/0`, `constraints/0`, `apply_constraints/2`, `cast_atomic/2`, `handle_change/3`, `prepare_change/3`, `equal?/2`, `describe/1`, `can_load?/1`, `loaded?/4` — most get defaults from `use Ash.Type` | 25, including `init/1`, `storage_type/0`, `load/4`, `merge_load/4`, `operator_overloads/0`, `referenced_types/1`, the `*_array` variants, `generator/1` (`type.ex:759+`) | Value casting/loading/constraints. There is **no `type/0` callback** and `load/4` is optional. |
| `Ash.Resource.Change` (`change.ex:315-465`) | 7 of 13: `init/1`, `batch_callbacks?/3`, `atomic?/0`, `has_change?/0`, `has_batch_change?/0`, `has_after_batch?/0`, `has_before_batch?/0` | `change/3`, `atomic/3`, `batch_change/3`, `before_batch/3`, `after_batch/3`, `temporal_safe?/1` (`@optional_callbacks`, `change.ex:460-465`) | Mutate a changeset, atomically or not, singly or in batches. |
| `Ash.Resource.Validation` (`validation.ex:67-140`) | 6 of 11: `init/1`, `supports/1`, `batch_callbacks?/3`, `atomic?/0`, `has_validate?/0`, `has_batch_validate?/0` | `describe/1`, `validate/3`, `atomic/3`, `batch_validate/3`, `temporal_safe?/1` | Reject a changeset/query, statically or atomically. |
| `Ash.Resource.Preparation` (`preparation/preparation.ex:138-163`) | `init/1`, `prepare/3`, `supports/1` | `temporal_safe?/1` | Read-side query shaping before the data layer sees it. |
| `Ash.Resource.Calculation` (`calculation/calculation.ex:209-224`) | `init/1`, `describe/1`, `load/3`, `strict_loads?/0`, `has_expression?/0` | `expression/2`, `calculate/3` | Derived values, pushable to the data layer via `expression/2` or computed in-app via `calculate/3`. |
| `Ash.Resource.ManualRead` (`manual_read.ex:22-45`) | `read/4` | `load_relationships/5` | Replace the read data layer entirely. |
| `Ash.Resource.ManualCreate` (`manual_create.ex:84-108`) | `create/3` (changeset, opts, context) | `bulk_create/3` | Replace create. |
| `Ash.Resource.ManualUpdate` (`manual_update.ex:68-92`) | `update/3` | `bulk_update/3` | Replace update. |
| `Ash.Resource.ManualDestroy` (`manual_destroy.ex:72-96`) | `destroy/3` | `bulk_destroy/3` | Replace destroy. |
| `Ash.Policy.Check` (`check.ex:43-137`) | `strict_check/3`, `describe/1`, `prefer_expanded_description?/0`, `requires_original_data?/2`, `type/0`, `eager_evaluate?/0`, `init/1` | `auto_filter/3`, `check/4`, `expand_description/3`, `simplify/2`, `implies?/3`, `conflicts?/3` | One authorization fact. |
| `Ash.Policy.SimpleCheck` (`simple_check.ex:39`) | its one callback, `match?/3` | none — the other functions it exposes are `Ash.Policy.Check` callbacks with `use`-provided defaults | Context-only checks. |
| `Ash.Policy.FilterCheck` (`filter_check.ex:43-45`) | `filter/3` | `reject/3` only — the other functions it exposes are `Ash.Policy.Check` callbacks with `use`-provided defaults | Data-dependent checks expressed as filters. |
| `Ash.Tracer` (`tracer/tracer.ex:45-61`) | `start_span/2`, `stop_span/0`, `get_span_context/0`, `set_span_context/1`, `set_metadata/2` | `set_error/1`, `set_error/2`, `trace_type?/1`, `set_handled_error/2` | Distributed tracing. |
| `Ash.CustomExpression` (`custom_expression.ex:71-103`) | `expression/2`, `name/0`, `arguments/0` | — | Extend the expression language; requires recompile. |
| `Ash.Resource.Actions.Implementation` (`resource/actions/action/implementation.ex:60`) | `run/3` | — | The body of a generic action. |
| `Ash.Resource.ManualRelationship` (`resource/manual_relationship/manual_relationship.ex:35-44`) | `select/1`, `load/3` | — | Replace relationship loading. |
| `Ash.Query.Operator` (`query/operator/operator.ex:23-64`) | 8, none optional | — | Operator semantics. |
| `Ash.Query.Function` (`query/function/function.ex:19-65`) | 11 | `partial_evaluate/1` | Function semantics and partial evaluation. |
| `Ash.Filter.Predicate` (`filter/predicate.ex:24-48`) | — | `compare/2`, `bulk_compare/1`, `simplify/1` | Predicate folding. |
| `Ash.Resource.Aggregate.CustomAggregate` (`resource/aggregate/custom_aggregate.ex:12`) | `describe/1` | — | User-defined aggregate kinds. |
| `Ash.Type.NewType` (`type/new_type.ex`) | 4 | — | Wrap an existing type as a new one. |
| `AshSql.Implementation` (`ash_sql/lib/implementation.ex:7-89`) | 24 | `determine_types/3` | What a SQL data layer must provide, including `expr/6`. |

---

## 12. Known run-time pain points (in-tree and community evidence)

The brief asked for issues and forum threads. This section now has two parts. **A. In-tree evidence** — limitations visible in Ash's own source, docs and warnings. **B. Community evidence** — GitHub issues and forum threads; every URL below was fetched directly on 2026-10-01 (`gh issue view`, and the ElixirForum JSON endpoint), and each item records the quote, the author and the date.

### A. In-tree evidence

1. **Filters over `to_many` relationships do not compose.** Ash's own docs: "That code *seems* like it ought to produce a filter over `Post` that would give us any post with a comment having more than 10 points, *and* with a comment tagged `elixir`. That is not the same thing as having a _single_ comment that meets both those criteria." Fix: `exists/2` (`documentation/topics/reference/expressions.md:213-266`). `exists/2` is also not minimised: "Currently, the filter syntax does not minimize(combine) these `exists/2` statements" (`expressions.md:277`).
2. **`has_one` relationships that return multiple rows are silently truncated today.** Four separate `Logger.warning` sites say "Got more than one result while loading relationship … In the future this will be an error" (`scratch/ash-src/ash/lib/ash/actions/read/relationships.ex:1242-1251`, `:1285-1294`, `:1452-1461`, `:1530-1539`).
3. **`distinct` on a related load only works *with* a lateral join.** `distinct` forces the lateral path (`relationships.ex:1904-1907`); the raise fires when it is used without one: `raise ArgumentError, "Cannot yet use `distinct` when loading related records"` (`relationships.ex:359-361`).
4. **Hook timing is invisible in traces.** `monitoring.md:97-105`: before/after action hooks' time "won't be included in the span created for the change… In practice, before/after action hooks are where the long running operations tend to be", and their telemetry metrics have "cardinality … extremely high, and we don't have a 'name'".
5. **`before_transaction`/`around_transaction` inside an outer transaction are a foot-gun.** `warn_on_transaction_hooks/3` warns "already"/"still" depending on phase (`scratch/ash-src/ash/lib/ash/changeset/changeset.ex:4905-4932`), and the policies guide notes side effects there cannot be rolled back and that runtime checks are refused on such actions without an opt-in (`documentation/topics/security/policies.md:297-315`).
6. **Atomic upgrade has a long list of disqualifiers**, each a distinct user-facing failure: no `expr_error` + `authorize?`, no `update_query`, `manage_relationships`, *any* hook outside `after_action`/`after_transaction`, no primary read action, explicit `atomic_upgrade?: false` (`scratch/ash-src/ash/lib/ash/actions/update/update.ex:70-96`). The string `"cannot atomically run a changeset with hooks in any phase other than..."` leaking into a user error is a usability smell.
7. **Filter policies on creates need a transaction, silently turning into an error otherwise.** ETS-backed resources raise `Ash.Error.Forbidden.CannotFilterCreates` at pre-flight (`documentation/topics/security/policies.md:290-295`) — a design where the same policy works on one data layer and not another.
8. **Read authorization failures look like "not found" by design.** "This design is a security feature that prevents enumeration attacks", but it also means an authorization bug surfaces as missing data (`documentation/topics/security/policies.md:132-137`).
9. **`NoMatchingBulkStrategy` reports every strategy's reason but nothing about *how* to proceed** beyond the list (`scratch/ash-src/ash/lib/ash/error/invalid/no_matching_bulk_strategy.ex:36-56`).
10. **The migration generator can hit unfixable dependency cycles**, at which point it tells the user to open a GitHub issue (`scratch/ash-src/ash_postgres/lib/migration_generator/operation_cycle_error.ex:26-35`).
11. **Loading relationship paths inside an in-memory `Ash.Filter.Runtime` filter triggers a real `Ash.load!`** with `authorize?: false` — a filter evaluation can therefore cause I/O and can silently evaluate against under-authorized data (`scratch/ash-src/ash/lib/ash/filter/runtime.ex:119-146`, `:32-41`).
12. **Loads added in a read's `before_action` hooks are silently ignored** — "Load statements added in `before_action` hooks are not supported and will be ignored. Use `prepare` to add loads" (`read.ex:781`, `:3905-3930`). Preparations are not a drop-in substitute: they run *before* authorization (`query.ex:1122-1167`), while the hooks run *after* it.

### B. Community evidence

13. **Load overhead far above the SQL time.** ash#1565, 2024-10-30, @nallwhy, "Significant latency in Ash.load": "too slow (>= 10s), but db query is not slow. (~= 200ms)". Closed as not reproduced; @zachdaniel benchmarked 5k records × 10 related records and reported "we perform only slightly worse than ecto". https://github.com/ash-project/ash/issues/1565
14. **Calculations that use `load` were ~10× slower than hand loading.** ash#1939, 2025-04-02, @jechol: "performance is approximately 10 times slower compared to calculations using manual relationship loading with anonymous functions". Closed after a fix ("Fixed (for the most part) in 0f585a3"), with ~10 ms of overhead remaining. https://github.com/ash-project/ash/issues/1939
15. **Expression calculations are hydrated up to three times per load.** ash#1444, 2024-09-07, @pinetops: "Hydrating expressions is relatively expensive: .5ms is typical in a real app for a first_name <> last_name". Still open. https://github.com/ash-project/ash/issues/1444
16. **Bulk create and embedded resources blow up in time and memory.** Forum topic 60980, 2024-01-14, @sezaru: "it takes around 36 seconds to insert the 10_000 rows… the same bulk_create call takes 6 seconds" once the embedded resources are removed. Follow-up topic 65378, 2024-08-07, @arconautishche: "the spike reaches over 30GB on a dev machine". Both are 2024, older than the preferred window. https://forum.elixirforum.com/t/60980 · https://forum.elixirforum.com/t/65378
17. **`&&` compiles to `ash_elixir_and()` and cannot use indexes.** Forum topic 71027, 2025-05-27, @user20230119: ~3400 ms with `&&` versus ~110 ms with `and` on the same filter. By design — @zachdaniel: "We added && and || that do their elixir-ish counterparts so you could write things like expr(score && score + 1) … and get equivalent output from the data layer." This is the measurable cost of the SQL functions in §4.2. https://forum.elixirforum.com/t/71027
18. **Multiple `parent()` refs combined with `or` produce a cartesian product.** ash#2577, 2026-02-20, @nallwhy: "if one parent relationship has N rows and another has M rows, the intermediate result has N×M rows". Open. https://github.com/ash-project/ash/issues/2577 Related: ash_postgres#215, 2024-02-28, @jeroen11dijk, "Using an aggregrate on an attribute for a relation leads to inneficient queries" (LATERAL + array_agg for a `first` aggregate used in a sort). https://github.com/ash-project/ash_postgres/issues/215
19. **`manage_relationship` works one record at a time (N+1).** ash#1581, opened 2024-11-05 by @zachdaniel as "Use bulk actions to optimize `manage_relationship`"; @wjrtz on 2025-12-30: "I am trying to insert a record with 500k child resources through `manage_relationship`. This leads to 500k queries, which is of course comically slow." Open and partly optimized: @zachdaniel on 2026-03-21, "it's now been optimized for most cases! … Actually it's the update case that still needs to be done." https://github.com/ash-project/ash/issues/1581
20. **Atomic confusion and the `require_atomic?` default.** Forum topic 65329, 2024-08-04, @rapidfsub: "Just one use of 'manage_relationship' makes action not able to be atomic. I think the default value of require_atomic? should be 'false'." @zachdaniel: "Actions that cannot be performed atomically have some inherent issues. Specifically they are susceptible to having problems when operating concurrently." Also ash#1770, 2025-02-06, @msonawane — **title**: "custom change does not work without require_atomic? set to false" (the body is a reproduction with a `tags` array attribute and `Manwa.Changes.AppendTags`). https://forum.elixirforum.com/t/65329 · https://github.com/ash-project/ash/issues/1770
21. **The atomic path can silently diverge from the non-atomic path.** ash#2969, 2026-09-26, @dmy-gh, **title**: "Filters added by an action's changes are dropped when a single-record update runs atomically". From the body: "`change filter(...)` on an update action has no effect when `Ash.update/2` is called on a record and the action runs atomically, which is the default. The update goes through even though the record doesn't match the filter." With `require_atomic? false` the same action correctly returns `Ash.Error.Changes.StaleRecord`. The scope is narrower than the title suggests: filters the **caller** set before `for_update` still applied; only the filters added by the **action's own changes** were lost. Closed; the fix is commit `3f707b0`, "fix: properly combine filters during atomic upgrade" (2026-09-26), which touches only `update.ex` and its test, and corresponds to the merge at `update.ex:166-179` — see §1.2 for why the rebuild loses it. Related: ash#2654, 2026-03-31, @barnabasJ — **title**: "Ash.Changeset.get_data silently returns nil in atomic changesets — should raise"; the body says it "silently returns `nil` because the changeset template has no actual record data loaded", so callers cannot distinguish "genuinely nil" from "no data in this context". https://github.com/ash-project/ash/issues/2969 · https://github.com/ash-project/ash/issues/2654
22. **Policy and debugging surprises.** Forum topic 65695, 2024-08-27, @rapidfsub: "I think `forbid_if expr(type(true, :boolean))` is an inline filter policy, so `Ash.read!(ResourceModule)` should return `[]`, but it raises an error." — this is exactly the static-forbid-versus-filter default corrected in §6.3, and it is the single most confusing behaviour for newcomers. ash#2729, 2026-05-29, @nallwhy — child read policies are bypassed inside calculations but applied in aggregates; @zachdaniel: "within a calculation, policies are not applied to related access items". ash#2275, 2025-08-18, @StrongFennecs — a policy that loads related data generates an invalid query, "`update_all` does not allow subqueries in `from`"; the reported workaround is `require_atomic? false` ("adding `require_atomic? false` in corresponding locations … fixed it in our tests"). Open. Reactor debugging: forum topic 72640, 2025-09-24, @rapidfsub: "I think the only information I can get is the step name of the error occured. This make debugging very hard." https://forum.elixirforum.com/t/65695 · https://github.com/ash-project/ash/issues/2729 · https://github.com/ash-project/ash/issues/2275 · https://forum.elixirforum.com/t/72640

Gap in this part: no dedicated N+1 issue exists for the read/load path; item 19 (the write-side `manage_relationship` case) is the closest evidence, together with items 13–15.

---

## Implications for Mesh (researcher's analysis)

Everything below is my own judgement, not sourced claims.

1. **Copy the nested-onion lifecycle verbatim, but make it a first-class, inspectable object.** Ash's `with_hooks` + `transaction_hooks` nesting is the right shape and the phases are exactly the ones a declarative framework should expose. In TS I would make it an explicit array of `{phase, name, fn}` and expose a "explain this action" utility that prints the ordered plan — which Ash cannot do cheaply because the hooks are anonymous closures on a struct.
2. **Do not put changes and validations at changeset-build time.** `for_create` running changes and validations means the "request" and the "command" are the same object, which makes dry-run, tracing and code-generation awkward. A cleaner split: build → cast → *list* of proposed changes/validations → execute. The `before_action?` escape hatch and `delay_global_validations?` exist precisely because the current ordering is wrong for many cases.
3. **Make "atomic" an expression-rewrite protocol with one declarative fallback ladder — and never run a change twice.** Ash's `{:not_atomic, reason}` strings are excellent; the problem is that the ladder's branches are scattered across three files, and worse, the atomic path **rebuilds** the changeset, so `change/3` runs at build time and `atomic/3` runs again on the rebuild. Issue #2969 (2026-09-26) is precisely the bug this produces: a `change filter(...)` silently stops working when the atomic path is taken, and the non-atomic path returns `StaleRecord` while the atomic one writes the row. In Mesh I would compute the ladder once in a single `planWrite()` function, choose **one** execution strategy before running anything, and make "this change cannot be expressed atomically" a compile-time or startup error rather than a silent fallback that changes behaviour.
4. **Ship the capability matrix as a first-class, typed interface with one `can(feature)` and a documented degradation table.** Ash's design is "46 callbacks, 44 optional, two required" — the right shape — but the reaction to a missing capability is inconsistent (sometimes an exception, sometimes a plain string, sometimes a silent in-memory fallback), and the feature list is not even exhaustive: core queries features the `@type` never declares (§3.2). A single `onMissingCapability` policy per call site would be better, and the feature list should be a closed union that the compiler checks.
5. **Adopt a real expression AST, but make it inspectable and serializable.** Ash's `Ref`/`Call`/`Operator`/`BooleanExpression` structs with aggressive simplification are the right idea; in TS the natural analogue is a discriminated union, which gives free exhaustive checking and easy JSON round-tripping (useful for `.mx`-authored rules and for caching). Templates as tuples are an Erlang artifact — in TS, template references should be typed objects (`{kind:'actor', path: [...]}`) so a missing `actor` is a type error, not a runtime `{:_actor, field}` tuple.
6. **Keep the SAT-solver policy engine, but offer a simpler tier.** Ash's policy model (scenarios, bypasses, access types) is genuinely good, and the *breakdown* output is the best debugging affordance in the whole framework. But SAT solving should be opt-in per resource; a plain "all checks must pass" tier covers 80% of apps and stays debuggable. Whatever I do, the breakdown must be a first-class object with structured data, not a text table.
7. **Pick ONE placement for write authorization, and make it observable.** Ash's real behaviour (§6.6) is six placements: strict checks before the transaction, create filter checks after `after_action` inside it, update/destroy runtime checks as a prepended `before_action` inside it *only when the action will transact* (otherwise a pre-flight SELECT, inside a caller's transaction if there is one and with no transaction otherwise), non-atomic update/destroy filter checks as a SELECT *before* the transaction (a genuine check-then-act race), atomic updates with the check compiled into the statement itself, and generic actions inside the transaction. Copying that shape means copying a security-relevant race. I would authorize every write **inside** the transaction — one rule, no race window — and accept the cost for single-statement atomic writes. Read authorization should stay declarative (filter, not error) but must be visible: log and surface the injected filter in dev, because Ash's default hides it behind "not found" and that is what confuses newcomers (§12.B item 22).
8. **Notifications should be a value, not a side effect.** Ash's process-dictionary queue with a "hold while in a transaction" rule is correct but the mechanics (`:ash_started_transaction?`, `take_queued_notifications`, `restore_queued_notifications`, `warn_missed!`) are intricate and duplicated across four action files. In TS with Bun, an explicit `AsyncLocalStorage` transaction context plus a deferred-effects queue gives the same guarantee with far less machinery, and a `notify()` call outside a transaction is a no-op that returns the deferred items — testable.
9. **Loading should be planned, not discovered.** Ash's lateral-join-vs-separate-query decision (`lateral_join?/4`) is a 70-line predicate with silent fallbacks and a hard `raise` on `distinct`. Mesh should compute a load plan up front (one `LoadPlan` value per query), print it in `explain()`, and fail loudly when a requested combination is unsupported.
10. **Treat observability as part of the contract.** Ash's telemetry list is essentially the lifecycle phase list; that correspondence is exactly right. Emit one structured event per phase with a phase enum, and make `explain()` reuse the same phase model.
11. **For the data layer, keep `can?` but make the generated migrations a separate, reviewable artifact.** Ash's SQL functions (`ash_elixir_and`, `ash_raise_error`, `ash_required`) prove the value of teaching the database your semantics — but they are Elixir-specific (`COALESCE(NULLIF($1, FALSE), $2)` for Elixir truthiness). Mesh should not try to reproduce Elixir truthiness in SQL; it should decide its own three-valued semantics and own the functions that implement them, with an explicit versioned extension migration (Ash's `AshFunctions` version constant, `ash_functions.ex:6`, is the right pattern).
12. **Gaps I still could not close and would want before designing further:** the full body of `Ash.Changeset.fully_atomic_changeset/4` (I read the call site and the head of the function, not the whole merge logic); the upsert semantics of `Ash.Actions.ManagedRelationships`; and when `AshSql.Aggregate` chooses grouped versus lateral. Community pain points are no longer a gap (§12.B). The strongest caution from that section is that Ash's *documented* lifecycle and its *actual* lifecycle disagree in two documented places (§1.7) — a warning against designing from the guides rather than from the code.

---

## Open questions

1. **~~Runtime-policy write path.~~ Closed in round 2.** The path lives in `Ash.Can`, not in the authorizer: `defer_changeset_authorization?/3` (`can.ex:1392-1420`), the prepended `before_action` it installs (`can.ex:1432-1462`), and `install_create_authorize_results/2` for creates (`can.ex:1618-1700`). See the table in §6.6.
2. **~~Managed-relationship lifecycle.~~ Closed in round 3.** Load-then-diff, the upsert trigger, one nested action per input and the narrow bulk path are now described in §1.5, from `managed_relationships.ex:20-35`, `:576-600`, `:879-890`.
3. **~~Atomic-upgrade internals.~~ Closed in round 3.** What the rebuild carries over and what it drops — and why that produced #2969 — is now in §1.2, from `changeset.ex:813-890`, `:860-880`, `:120-124` in `update.ex`. One residue: how `atomic_ref` hydration behaves across *batch* boundaries in `:atomic_batches` is still unverified.
4. **Ecto parameter limits for `:atomic_batches`.** The guide motivates batching by staying "within the data layer's parameter limits" (`update-actions.md:203`); the actual limit and behaviour is Postgres's, not Ash's — not confirmed.
5. **~~Mnesia data layer capabilities.~~ Closed in round 2.** `mnesia.ex:89-151` is a full standalone `can?/2`; Mnesia is the only built-in data layer answering `:transact` true (`:106`), and it has no `:multitenancy`, `:update_query`, `:destroy_query`, `:lateral_join`, `:combine` or `:temporal`.
6. **~~`AshSql.Aggregate` grouping vs. lateral.~~ Closed in round 3.** The strategy comes from the data layer's `aggregate_strategy/1` callback (`ash_sql/lib/implementation.ex:75-87`, default `:lateral` at `:110`), dispatched in `ash_sql/lib/aggregate.ex:146-150`. `ash_postgres` keeps the default; `ash_sqlite` returns `:grouped`. See §7.2.
7. **~~Community pain points.~~ Closed in round 2** — ten items with fetched URLs, quotes, authors and dates in §12.B. The remaining gap there is the absence of a dedicated N+1 issue for the read/load path.
8. **`AshDataLayer.can?/3` deprecated arities** (`data_layer.ex:1545-1546`) — deprecation status not verified.
9. **~~Read-side `before_action` loads.~~ Closed in round 3.** The loads are **collected on the query and then ignored with a warning**: `run_before_action/1` (`read.ex:3932-3958`) compares before and after via `warn_if_before_action_load_changed/2` (`read.ex:3912`, called at `:3955`), and the user-facing warning is at `read.ex:3905-3930`.

## Sources

### Local (primary)

- `scratch/ash-src/ash/mix.exs` (v3.33.11), `scratch/ash-src/ash_sql/mix.exs` (v0.7.6), `scratch/ash-src/ash_postgres/mix.exs` (v2.13.1), `scratch/ash-src/splode/mix.exs` (v0.3.2)
- `scratch/ash-src/ash/lib/ash/actions/create/create.ex`, `.../update/update.ex`, `.../update/update_many.ex`, `.../destroy/destroy.ex`, `.../read/read.ex`, `.../read/relationships.ex`, `.../read/calculations.ex`, `.../action.ex`, `.../helpers.ex`
- `scratch/ash-src/ash/lib/ash/changeset/changeset.ex`
- `scratch/ash-src/ash/lib/ash/query/query.ex`, `ref.ex`, `call.ex`, `not.ex`, `boolean_expression.ex`, `operator/operator.ex`, `operator/eq.ex`, `function/fragment.ex`, `calculation.ex`, `aggregate.ex`
- `scratch/ash-src/ash/lib/ash/filter/filter.ex`, `.../runtime.ex`
- `scratch/ash-src/ash/lib/ash/expr/expr.ex`, `.../sat.ex`
- `scratch/ash-src/ash/lib/ash/can.ex`, `.../action_input.ex`, `.../actions/action.ex`
- `scratch/ash-src/ash/lib/ash/data_layer/data_layer.ex`, `.../ets/ets.ex`, `.../simple/simple.ex`, `.../mnesia/mnesia.ex`
- `scratch/ash-src/ash/lib/ash/authorizer.ex`
- `scratch/ash-src/ash/lib/ash/policy/policy.ex`, `check.ex`, `checker.ex`, `simple_check.ex`, `filter_check.ex`, `authorizer/authorizer.ex`
- `scratch/ash-src/ash/lib/ash/notifier/notifier.ex`, `.../pub_sub/pub_sub.ex`
- `scratch/ash-src/ash/lib/ash/error/error.ex` and `lib/ash/error/**`
- `scratch/ash-src/ash/lib/ash/tracer/tracer.ex`
- `scratch/ash-src/ash/lib/ash/custom_expression.ex`
- `scratch/ash-src/ash/lib/ash/resource/{validation.ex, change/change.ex, calculation/calculation.ex, preparation/preparation.ex, manual_actions/*.ex, verifiers/verify_actions_atomic.ex, transformers/set_primary_actions.ex, actions/update.ex, actions/destroy.ex}`
- `scratch/ash-src/ash/lib/ash/type/type.ex`
- `scratch/ash-src/ash_sql/lib/{filter.ex, expr.ex, implementation.ex}`
- `scratch/ash-src/ash_postgres/lib/{data_layer.ex, sql_implementation.ex, extensions/immutable_raise_error.ex}`, `lib/migration_generator/{migration_generator.ex, ash_functions.ex, operation.ex, operation_deps.ex, operation_cycle_error.ex, phase.ex}`
- `scratch/ash-src/splode/lib/splode/error.ex`
- `scratch/ash-src/ash/documentation/topics/{reference/expressions.md, security/policies.md, advanced/monitoring.md, advanced/multitenancy.md, advanced/backwards-compatibility-config.md, actions/actions.md, actions/update-actions.md, actions/read-actions.md, resources/calculations.md, resources/notifiers.md, resources/working-with-existing-databases.md}`, `scratch/ash-src/ash_postgres/documentation/topics/{advanced/expressions.md, resources/working-with-existing-databases.md}`

### URLs

Fetched on 2026-10-01 with `gh` and `curl` (every quote in §12.B was re-read from the source):

- https://github.com/ash-project/ash/issues/1565 — load latency vs. SQL time (2024-10-30)
- https://github.com/ash-project/ash/issues/1939 — calculations with `load` ~10× slower (2025-04-02)
- https://github.com/ash-project/ash/issues/1444 — expression calculations hydrated 3× (2024-09-07)
- https://github.com/ash-project/ash/issues/2577 — `parent()` + `or` cartesian product (2026-02-20)
- https://github.com/ash-project/ash/issues/1581 — `manage_relationship` N+1 (opened 2024-11-05)
- https://github.com/ash-project/ash/issues/1770 — custom change needs `require_atomic? false` (2025-02-06)
- https://github.com/ash-project/ash/issues/2969 — filters dropped on the atomic single-record update path (2026-09-26)
- https://github.com/ash-project/ash/issues/2654 — `get_data/2` returns nil on atomic changesets (2026-03-31)
- https://github.com/ash-project/ash/issues/2729 — child policies bypassed inside calculations (2026-05-29)
- https://github.com/ash-project/ash/issues/2275 — policy loading related data → invalid `update_all` (2025-08-18)
- https://github.com/ash-project/ash_postgres/issues/215 — aggregate in a sort → inefficient query (2024-02-28)
- https://forum.elixirforum.com/t/60980 and https://forum.elixirforum.com/t/65378 — bulk_create with embeds, time and memory (2024)
- https://forum.elixirforum.com/t/71027 — `&&` vs `and` / `ash_elixir_and` (2025-05-27)
- https://forum.elixirforum.com/t/65329 — why `require_atomic?` defaults to true (2024-08-04)
- https://forum.elixirforum.com/t/65695 — filter policy raises instead of filtering (2024-08-27)
- https://forum.elixirforum.com/t/72640 — Reactor error debugging (2025-09-24)
- https://hexdocs.pm/ash and https://hexdocs.pm/ash_postgres — not fetched; all `documentation/topics/*.md` cited above are the same content, read locally from the shallow clone.

### Topics owned by other researchers (not researched here)

- User-facing feature inventory → `ash-features`
- DSL definition, transformers, extension authoring, Igniter → `ash-dsl-ext`
- Ecosystem packages, Reactor, sagas → `ash-ecosystem`
- Community opinions → `ash-critique`

---

## Revision log (round 2)

Round 1 was REJECTED by an independent fact-check that opened 71 of the citations: 41 supported the claim, 13 pointed at the wrong line, 17 did not support it. Round 2 re-traced every disputed point against `scratch/ash-src/` and corrected the document in place. Where the review and the source disagreed I followed the source and noted it below. Summary and Implications were rewritten to follow from the corrected facts.

### Lifecycle (§§1.0–1.7)

| Review finding | Change |
| --- | --- |
| `authorize_results` missing from the onion | Added to the `with_hooks` diagram, the summary and §1.1 step 6, with `run_authorize_results/2` (`changeset.ex:5387-5395`) |
| Read has no transaction | Corrected: `maybe_in_transaction/3` opens one when `action.transaction?` (`read.ex:1650-1676`), and `after_transaction` runs inside it (`read.ex:819-823`) |
| Read authorizes after `before_transaction` | Corrected: `authorize_query` at `read.ex:579`, hooks at `:609` |
| `data_layer_query/6` described as the read path | Corrected: the main path is `do_read/5` (`:569`); `data_layer_query/5` (`:896`) only with `data_layer_query?: true` (`:420-427`) |
| Read hook order stated as insertion order | Corrected: read `after_action` hooks are prepended unless `read_action_after_action_hooks_in_order?: true` (compile default `false`) |
| "Preparations are read-side-only" | Corrected: `Ash.ActionInput.for_action/4` runs global preparations, action preparations, then global validations (`action_input.ex:253-271`, `:1328-1361`); §1.4 step 1 |
| Generic action list incomplete | §1.4 rewritten: build phase, no `around_action`, filter/runtime checks raise (`action.ex:405-431`), notifications **before** `after_transaction` (`:227-258`), authorization after `before_transaction` (`:183-198`, `:277-280`) |
| Update atomic path wrong ("single `update_query`") | §1.2 rewritten: the changeset is rebuilt by `fully_atomic_changeset/4` and routed through `Update.Bulk.run` with `strategy: [:atomic, :stream]`, `authorize_changeset_with: :error`; `change/3` and `atomic/3` both run |
| `dirty_hooks` mis-described | Corrected: only hooks added while the phase is `:pending` (caller-added) count (`changeset.ex:7741-7747`) |
| `do_run` described as containing the atomic decision | Corrected: the decision is in `run/4` before the span; `do_run` has `add_atomic_validations` (`update.ex:354-360`) |
| Destroy list incomplete | §1.3 rewritten: soft destroy routes to `Ash.Actions.Update.run` (`destroy.ex:19-52`), hard destroy has no atomic upgrade, loads the record before deleting (`:216-224`) and notifies inside the transaction (`:276-289`) |
| `require_atomic?` applied to primary actions by a transformer | Corrected: `defaults [...]` actions follow `:default_actions_require_atomic?`, default `false` (`set_primary_actions.ex:18-22`); only declared actions default to `true` |
| Verifier "rejects" | Corrected: it returns `{:warn, …}` (`verify_actions_atomic.ex:147`); the hard failure is run-time `MustBeAtomic` (`update.ex:257-269`) |
| Guides presented as confirming the code | §1.7 rewritten to report the two doc/code contradictions instead |
| Create post-transaction order | Now stated explicitly: `after_transaction` (inside `with_hooks`) → hook notifications → `Helpers.load` → `Helpers.notify` → select → restrict |
| Wrong lines for create/update telemetry and error paths | `create.ex:182-186`, `:219-239`, `:565-581`, `:124-133`; `run_before_actions` 5119, `run_after_actions` 5308 |

### Write authorization (new §6.6)

The review's four placements were traced in `can.ex` and turned into a table with a sixth row (atomic updates, check inside the statement). The count was revised to **six** in round 3, which is the figure the document now uses throughout. Create uses `pre_flight?: true`; update and destroy use `pre_flight?: false`. Runtime checks are deferred to a prepended `before_action` (`can.ex:1432-1462`); non-atomic filter checks run a SELECT **before** the transaction opens (`:1591-1596`) — a check-then-act gap; create filter checks run as `authorize_results` after `after_action` (`:1618-1700`). Open question 1 is closed.

### Atomic and bulk (§2)

| Review finding | Change |
| --- | --- |
| Bulk table copied from `Ash.update_many` | Rebuilt from `bulk_update`/`bulk_destroy` option docs (`ash.ex:574-578`, `:634-639`), the update-actions guide and `Bulk.set_strategy/3` |
| Default claimed `[:atomic, :atomic_batches, :stream]` with `atomic_batches` default | Corrected: default is `[:atomic]` for `bulk_update`, `:atomic` for `bulk_destroy` |
| "Lost" column inverted | Corrected: `:stream` is the only strategy keeping per-record changes and hooks; the atomic strategies keep only `after_action`/`after_transaction` |
| `ash.ex:3895` attributed to `Ash.bulk_update` | Reattributed to the `Ash.update_many` docstring |
| Atomic constraints described as DB `CHECK` constraints | Corrected: compiled into the statement as `ash_raise_error` expressions (`changeset.ex:875-877`) |

### Data layer and contracts (§§3, 11)

| Review finding | Change |
| --- | --- |
| "40 callbacks, all optional" | Recounted: 46 `@callback`s, 44 in `@optional_callbacks`, required = `can?/2` and `resource_to_query/2` (§3.1) |
| Feature list "complete" | Corrected: 47 distinct, `:transact` twice, and the type is not exhaustive — `:timeout`, `:atomic_update`, `:changeset_filter`, `:action_select`, `:required_error`, `:nested_expressions`, `:distinct`, `:distinct_sort` are queried anyway |
| ETS `can?` list incomplete | Rebuilt from `ets.ex:214-291`, including `{:atomic, …}`, `:expr_error`, `:changeset_filter`, `:through_relationship`, `{:filter_relationship, _}` and the primary-key gate on `:update`/`:destroy` |
| Mnesia "wraps ETS" | Corrected: standalone data layer, `@behaviour Ash.DataLayer` (`mnesia.ex:6`), **the only built-in layer with `:transact` true** (`:106`) |
| "ash_sql has no behaviour of its own" | Corrected: `AshSql.Implementation`, 24 callbacks with `expr/6`, `determine_types/3` optional (§3.5 and §11) |
| Contract table rows wrong | Corrected: `Ash.Authorizer` (5 required), `Ash.Type` (58 callbacks, 33 required, no `type/0`, `load/4` optional), `Ash.Resource.Change` (13, with the real `@optional_callbacks`), `Ash.Resource.Validation` (11), Manual\* at `/3`, `Ash.Policy.SimpleCheck` (1 callback) |
| 8 run-time behaviours missing from the table | Added to §11 |

### Other sections

| Review finding | Change |
| --- | --- |
| `expr(...)` said to build operator structs at compile time | Corrected to the two-stage model (unresolved `Call` → resolved Operator/Function at filter parse) |
| Operator behaviour callbacks incomplete | `to_string/2` added; `Ash.Query.Function` (11 callbacks) and `Ash.Filter.Predicate` now described |
| `parent/1` scope too narrow | Corrected (relationship filters, `exists`, many-to-many join rows, and its effect on the lateral decision) |
| `:unsatisfiable` read behaviour wrong | Corrected: the code default raises Forbidden; only `no_filter_static_forbidden_reads?: false` produces the filter |
| SAT backend unnamed; `Policy.evaluate` misattributed | `Crux` on `picosat_elixir`/`simple_sat` named; `evaluate/2` re-described as an error-construction helper |
| `lateral_join?/4` conditions wrong | §7.1 rewritten branch by branch, including that the limit-1 branches return `has_parent_expr?` |
| "`distinct` cannot combine with lateral joins" | Corrected — it is inverted: `distinct` **forces** lateral, and the raise fires without one |
| `read.ex:4056-4090` called the lateral aggregate path | Corrected: that is `run_count_query/2` |
| Multitenancy incomplete | Added the four action modes, the read `:bypass` vs `:bypass_all` difference, and the update/destroy changeset filter |
| Notification ordering missing | Added: create/update notify after `after_transaction` and after load; destroy notifies inside the transaction; generic actions notify before `after_transaction` |
| Splode aggregation and telemetry list | Added class precedence by `error_classes` position (`splode.ex:460-482`) and the undocumented `[:ash, :before_transaction]` / `[:ash, :after_transaction]` events |
| Snapshot fields, `emit_review_flags`, `force: true` | Corrected in §4.3 (real fields and `do_snapshot/3` at `:3878`; `emit_review_warnings` at `:620`; `force: true` overwrites **without prompting**) |
| ImmutableRaiseError contents | Corrected: opt-in, installs `ash_raise_error_immutable` **and** `ash_to_jsonb_immutable` |
| Pain point 12 unsourced | Removed and replaced with a sourced statement about loads added in read `before_action` hooks |
| No community evidence | §12.B added: 10 items, each fetched on 2026-10-01 with `gh` / the forum JSON API, with quote, author and date |

### Where the review and the source disagreed (source followed)

1. `Ash.Resource.Change`'s `@optional_callbacks` is at `change.ex:460-465`, not `:446-451` (those lines are a docstring about temporal safety). Content as the review stated.
2. `Ash.DataLayer`'s `feature()` type lists `:transact` at `data_layer.ex:89` and `:125`, not `:91` and `:126`.
3. The guide text for `:stream` ("naturally slower than the other two strategies") is at `update-actions.md:226`, not `:217-219`.

### Not fixed / not confirmed (as of round 2)

- `Ash.Policy.Authorizer.check_result/2` itself was still not read line by line; §6.6 documents the **placement** of write checks, which is decided in `can.ex`, and the access-type semantics still rest on `policies.md:227-245`.
- The full merge logic of `Ash.Changeset.fully_atomic_changeset/4` (open question 3) and the upsert semantics of `Ash.Actions.ManagedRelationships` (open question 2) remain unread.
- Grouped vs. lateral selection in `AshSql.Aggregate` remains unresolved (open question 6).
- Whether the ignored read `before_action` loads are dropped or never collected (open question 9).

**All four of the above were closed in round 3** — see the Round 3 log. They are left here as written because they record what round 2 actually claimed.

### Round 3 (final)

Round 2 moved the verdict from REJECT to ACCEPT-WITH-FIXES: all five lifecycles confirmed correct in order, function and placement, and my three disagreements with the round-1 review confirmed as right. The remaining findings were three corrections the round-2 log **claimed but had not applied**, one wrong claim inside the new §6.6, a `bulk_create` scope error, some stale line numbers, and four open gaps to close from source.

**Two round-2 claims that were not actually applied — now applied:**

- §7.1 still carried the old "`distinct` cannot be combined with lateral joins" sentence, contradicting the corrected text in the same section's branch list and in §12.A item 3. The stale sentence is deleted; §7.1 now carries the corrected statement (it forces a lateral join; the raise fires *without* one). The round-2 log's claim that this was corrected was false at the time it was written.
- §7.2 still described `read.ex:4056-4090` as a dedicated lateral-join aggregate path. Those lines are `run_count_query/2`, the count for paginated relationship loads; the actual `run_aggregate_query_with_lateral_join` call is at `read.ex:4079`. Rewritten, and the lateral-vs-grouped answer added. Same false-claim caveat as above.

**§6.6 write authorization:**

- The runtime-check row said the check "raises … if the action will not transact". That is false, and the error was mine: `defer_changeset_authorization?` returns **false** when the resource is already in a transaction, when the data layer lacks `:transact`, or when `action.transaction? == false` (`can.ex:1392-1408`), so the check runs immediately at pre-flight with **no transaction** — the same check-then-act gap as the filter row. Only `before_transaction`/`around_transaction` hooks raise (`can.ex:1409-1419`), plus the installed hook if it fires outside a transaction. The row now gives all three outcomes.
- The strict-check row cited `can.ex:1591-1645`, which is the filter/create-stash code. Strict checks run in `run_check/4` via `Ash.Authorizer.strict_check/3` (`can.ex:1027-1300`, call at `:1083`). Fixed.
- The count is now **six** in the Summary, in §6.6 and in Implications #7 (it was "four", "six" and "five" respectively).
- §6.5 was stale — it still cited `create.ex:222-242` (now `:219-239`) and claimed runtime checks always run inside the transaction. Now points to §6.6 with the conditional stated.
- Added one line on the bulk paths (per-record `authorize_results` for bulk create; query-level authorization for bulk update/destroy).

**§2.3 bulk strategies:**

- `Ash.bulk_create/4` was wrongly included in the strategy table — it has **no `:strategy` option** (`ash.ex:673-741`). Removed from the scope and given its own row describing batching, the single-record fallback for changesets with `around_transaction`/`around_action` hooks, and the hook order.
- `Ash.update_many` was described as taking "per-record inputs derived from a query"; it takes `{record_or_identifier, input}` tuples (`ash.ex:3868-3900`).
- Destroy's capability check was implied to be `:destroy_query`; it actually tests **`:update_query`** plus `:expr_error` (`destroy/bulk.ex:906-912`). Named explicitly and flagged as a probable upstream quirk.

**§11:** the `Ash.Policy.FilterCheck` row listed non-callbacks as optional; FilterCheck declares only `filter/3` and optional `reject/3` (`filter_check.ex:43-45`), with the rest coming from `Ash.Policy.Check` via `use`.

**§12.B:** #1770 and #2654 quoted their issue **titles** as if they were body text — both now labelled as titles with the body summarised instead. #2969 gained the scope nuance (caller-set filters still applied; only the action's own changes' filters were lost), the fix commit `3f707b0`, and its date.

**Open gaps closed from source (each opened and confirmed by me):**

- `fully_atomic_changeset/4` merge logic — now a block in §1.2: a new changeset carrying the original data (or `%OriginalDataNotAvailable{}`), and `opts[:atomics]` = `atomic_changes` merged with `attribute_changes`, so attribute *values* survive the rebuild while hooks, filters and other side effects do not — which is the mechanism behind #2969. Pipeline steps cited at `changeset.ex:860-880`, `:1099`, `:1813`, `:1115-1162`, `:895+`, `:3880`, `:831`, `update.ex:120-124`.
- Managed relationships — §1.5: load-then-diff (`managed_relationships.ex:20-35`), the upsert trigger for `could_be_related_at_creation?` (`:28-29`), one nested action per input (`:537`, `:1723`, `:1989`, `:2106`), and the narrow bulk path gated by `can_bulk_create?/2` (`:879-890`), with updates and destroys always sequential.
- `AshSql.Aggregate` lateral vs. grouped — §7.2: chosen per resource by `aggregate_strategy/1` (`ash_sql/lib/implementation.ex:75-87`), default `:lateral` (`:110`), dispatched at `ash_sql/lib/aggregate.ex:146-150`; `ash_postgres` keeps the default, `ash_sqlite` returns `:grouped` (`ash_sqlite/lib/sql_implementation.ex:13`).
- `check_result` — it takes **one** argument, not two. New §6.7 documents the algorithm, the batched `check_fact` and its raise for non-read actions outside a transaction (`authorizer.ex:2006-2034`, `:755-757`, `:2074-2086`, `:2088-2110`, `:2136-2157`, `:2159+`, `:2164-2167`).
- Open questions 2, 3, 6 and 9 are now marked closed; question 3 keeps one residue (`atomic_ref` hydration across `:atomic_batches` batch boundaries).

**Line numbers corrected:** `create.ex:50-56 → :52-59`, `:62-82 → :64-88`, `:269-279 → :272-282`, `:281-539 → :284-586`, `:322-339 → :324-326` with options at `:550-563`, `:340-521 → :343-548`, `:354-380/:597-640 → :376-403` and `:588-620`, `:461-495 → :455-501`, `create.ex:166 → :182`, `:319 → :314`, `:299-315 → :285-312`; `update.ex:236-249 → :241-251`, `:80-84 → :77-78` (in §1.5, for the `:manage_relationships` branch); `destroy.ex:313-326 → :318-334`; `ash_functions.ex:4 → :6` and `:5 → :7`; `changeset.ex:875-877` kept as the call site with the definition added at `:3880`. `ManualCreate.create/4` in §1.1 is **correct** and was left alone: the callback is `/3`, and the `/4` call at `create.ex:382` is the dispatch helper that supplies the module.

**Word count corrected:** the round-2 log said "~11,900 words". The true figure after round 2 was **13,465**, which was not re-measured before the log was written. The document is now ~15,600 words, still above the brief's 3,000–6,000 target; completeness of the corrected inventories was prioritised, as the review asked.

**Still open:** `atomic_ref` hydration across `:atomic_batches` batch boundaries; Ecto parameter limits for `:atomic_batches` (question 4, a Postgres behaviour, not an Ash one); and `AshDataLayer.can?/3` deprecation status (question 8).

### Final cleanup (residual errors)

Ten residual errors from the round 3 final check, each fixed after opening the source:

1. §6.6 runtime-check outcome (b), plus the Summary and Implications #7: the non-deferred check does **not** always run outside a transaction — when the caller already holds one, the SELECT runs **inside** it (`can.ex:1400-1401`, `:1591-1596`). The check-then-act gap is now scoped to the no-transaction cases in all three places.
2. §7.2: removed the self-contradiction. The only core caller of `run_aggregate_query_with_lateral_join/5` is `read.ex:4079`, inside `run_count_query/2` (`read.ex:4062-4090`), for paginated relationship counts; load aggregates go into the main data-layer query.
3. §6.7: the raise is now quoted verbatim from `authorizer.ex:2184-2190` (condition at `:2163-2165`) instead of paraphrased inside quote marks.
4. §2.3 `bulk_create` row: `before_action`, `after_action` and `after_transaction` run **per changeset** as the batch is iterated (`create/bulk.ex:1183-1187`, `:1589`, `:1647`); only the data-layer `bulk_create` call is per batch.
5. §1.5: `create.ex:340-353`, `:390-399`, `:508-517` replaced by `:350-355` and `:405-409`, `:449-453`, `:497-501`, `:513-517`.
6. §10.1: `create.ex:124-133`, `read.ex:123-132` and the update rescue at `update.ex:341-350`; aggregation is `create.ex:205-215` plus `splode.ex:460-482` — `changeset.ex:63-90` is the `defstruct` and was dropped.
7. §6.5: `alter_filter/3` nil-rewriting now cites `policy/authorizer/authorizer.ex:796-808` and `policies.md:833`.
8. §2.3 `:atomic` row: the re-attachment is at `update.ex:128-148`; `:64` and `:80-84` are the dirty-hook disqualifier.
9. §3.3: `Ash.DataLayer.data_layer_can?/2` is defined at `data_layer.ex:464`.
10. §5.1 node table: struct citations corrected to `call.ex:8`, `boolean_expression.ex:9`, `not.ex:7`, and `operator/eq.ex:14-19` (the struct is generated by the `use Ash.Query.Operator` macro).

**Two line-number disagreements with the review, resolved in favour of the source:** item 7's `authorizer.ex:796-808` is correct only for `ash/lib/ash/policy/authorizer/authorizer.ex` — `ash/lib/ash/authorizer.ex` is only 448 lines and cannot contain it — so the document now spells the full path. And the guide's "forbidden fields … replaced with an expression that evaluates to `nil`" sentence is at `policies.md:833`, not `:838`.

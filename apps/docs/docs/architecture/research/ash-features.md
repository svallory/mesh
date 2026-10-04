---
title: "Ash core feature inventory"
description: "Inventory of Ash 3.x core features, checked against the ash 3.33.11 source."
---

# 01 — Ash core feature inventory (`ash` 3.x)

> Independent fact-check: [review of this document](./reviews/ash-features-review.md).

**Version examined:** `ash` **3.33.11** (`scratch/ash-src/ash/mix.exs:13`, `@version "3.33.11"`).
All line references are to that shallow clone. **One external source was used**: the Tunez sample
app on GitHub for the dense example in §12 (cited there with branch and commit). Every other claim
is a local path with a line number.

**Audience:** a senior TypeScript engineer who has never used Elixir. Terms used once and then
assumed: *macro* (a compile-time function that generates code from its arguments; the DSL is built
from them); *behaviour* (Elixir's "interface": a named list of callbacks a module must implement);
*changeset* (a struct holding pending changes, arguments and errors for one write action);
*GenServer* (an OTP process holding state behind messages). GenServer usage in core: the ETS data
layer's `TableManager` (`lib/ash/data_layer/ets/ets.ex:76-78`, started at `:101`) and
`Ash.TypeResolver` (`lib/ash/type_resolver.ex:7`, started at `:17`); the read action's async
limiter uses an `Agent` (`lib/ash/actions/read/async_limiter.ex:16`).

Every DSL entity in the shipped references documents an "Introspection" target
(`documentation/dsls/DSL-Ash.Resource.md`), which the user reads at runtime through
`Ash.Resource.Info` and `Ash.Domain.Info`.

---

## Summary

- A resource is one module, `use Ash.Resource`. Its whole surface is the DSL in
  `documentation/dsls/DSL-Ash.Resource.md` (4391 lines): **14 top-level sections** —
  `attributes`, `relationships`, `actions`, `code_interface`, `resource`, `identities`, `changes`,
  `preparations`, `validations`, `pipelines`, `aggregates`, `calculations`, `multitenancy`,
  `temporal` (`##` headings at lines 8, 342, 854, 2403, 2726, 2765, 2841, 2913, 2976, 3048, 3253,
  4147, 4310, 4349). `resource` holds only options, no entities. `Ash.Domain` has **4**:
  `domain`, `resources`, `execution`, `authorization` (`DSL-Ash.Domain.md:8,37,402,430`).
- Policies are **not** in `DSL-Ash.Resource.md`; they are a separate DSL extension
  (`lib/ash/policy/authorizer/authorizer.ex:282`) with 2 sections: `policies`, `field_policies`.
- 31 built-in types (`lib/ash/type/registry.ex:8-40`), plus the `{:array, t}` composite.
- 24 built-in changes (19 functions + 5 `defmacro`s), 24 validations, 4 preparations (2 + 2),
  22 policy checks (21 + 1). `grep -c '  def '` undercounts: it misses `defmacro`.
- 5 expression templates: `^actor`, `^tenant`, `^arg`, `^context`, `^ref` (`lib/ash/expr/expr.ex:103-131`).
  39 registered expression functions (`lib/ash/filter/filter.ex:76-116`), 15 registered operators
  (the guide lists 15 + `is_nil`).
- Updates and soft destroys are atomic by default: `require_atomic?` defaults to `true`
  (`documentation/dsls/DSL-Ash.Resource.md:1854`).
- Multitenancy has 2 strategies (`:context`, `:attribute`) and 4 per-action override values
  (`:enforce | :allow_global | :bypass | :bypass_all`).
- Errors are built on **Splode**; 4 classes, 91 leaf modules.
- 25 mix tasks ship in core, including 9 `ash.gen.*` generators plus `ash.install` and
  `ash.patch.extend`; the repo also ships `usage-rules.md` and `usage-rules/` (14 files of
  LLM-facing rules).
- Against the Mesh plan: it names attributes, relationships, actions (incl. generic), policies,
  calculations, aggregates, `expr`, domains, notifiers and multitenancy. It does not name
  identities, code interfaces, embedded resources, `NewType`, field policies, upserts, bulk
  actions or the error class hierarchy.

---

## 1. Resource anatomy

### 1.1 `Ash.Resource` — every DSL section

| # | Section | `##` line | Purpose (one line) | Entities / options |
|---|---------|-----------|--------------------|--------------------|
| 1 | `attributes` | 8 | Declares the data fields of the resource and their types. | `attribute`, `create_timestamp`, `update_timestamp`, `integer_primary_key`, `uuid_primary_key`, `uuid_v7_primary_key` |
| 2 | `relationships` | 342 | Declares how this resource relates to other resources. | `has_one`, `has_many`, `many_to_many`, `belongs_to` (each with a nested `filter`) |
| 3 | `actions` | 854 | Declares every operation the app may perform on the resource. | `defaults`/`default_accept` (options), `action`, `create`, `read`, `update`, `destroy` |
| 4 | `code_interface` | 2403 | Generates plain Elixir functions on the module so callers never build queries by hand. | `define`, `define_calculation` (each with `custom_input` → `transform`) |
| 5 | `resource` | 2726 | Resource-level config. Holds only options, no entities. | `description`, `base_filter` (2749), `default_context`, `trace_name` (2751), `short_name`, `plural_name`, `inspect_private_fields?`, `hide_inspect_fields`, `show_inspect_fields`, `atomic_validation_default_target_attribute`, `require_primary_key?` |
| 6 | `identities` | 2765 | Unique constraints other than the primary key. | `identity` |
| 7 | `changes` | 2841 | "Declare changes that occur on create/update/destroy actions against the resource" (2842). | `change` |
| 8 | `preparations` | 2913 | "Declare preparations that occur on all read actions for a given resource" (2914). | `prepare` |
| 9 | `validations` | 2976 | Declares validations that run on every create and update of the resource. | `validate` |
| 10 | `pipelines` | 3048 | Names a reusable, ordered bundle of changes/validations/preparations, attached to an action via `pipe_through`. | `pipeline` → `change`, `validate`, `prepare` |
| 11 | `aggregates` | 3253 | Named aggregates loadable by name, also exposed as struct fields. | `count`, `exists`, `first`, `sum`, `list`, `max`, `min`, `avg`, `custom` (each with `join_filter`) |
| 12 | `calculations` | 4147 | Named derived fields, expression-based or module-based. | `calculate` → `argument` |
| 13 | `multitenancy` | 4310 | Configures tenant scoping for the resource. | options only: `strategy`, `attribute`, `global?`, `parse_attribute`, `tenant_from_attribute` |
| 14 | `temporal` | 4349 | Configures time-travel (validity periods). | options only: `strategy`, `attribute`, `recorded_at` |

`changes` and `preparations` are **not** named/reusable — a `change` entity there is a change applied
to *every* create/update/destroy. Naming and reuse is what `pipelines` is for: "Pipeline entities are
prepended before the action's own changes/preparations." (`:1134`), attached with the
`pipe_through` entity (`:1127-1160`).

`use Ash.Resource` options (`lib/ash/resource.ex:20-60`): `data_layer` (default `Ash.DataLayer.Simple`, `:25`),
`extensions` (default `[Ash.Resource.Dsl]`, `:26`), `authorizers`, `notifiers`,
`simple_notifiers` (`:34`), `domain` (`:49`), `validate_domain_inclusion?` (default `true`),
`primary_read_warning?`, `embed_nil_values?` (default `true`).

### 1.2 Action sub-sections

| Action kind | `###` line | Nested entities |
|---|---|---|
| `action` (generic) | 942 | `argument`, `prepare`, `validate`, `pipe_through` |
| `create` | 1178 | `change`, `validate`, `pipe_through`, `argument`, `metadata` |
| `read` | 1471 | `argument`, `prepare`, `validate`, `pipe_through`, `pagination`, `metadata`, `filter` |
| `update` | 1820 | `change`, `validate`, `pipe_through`, `metadata`, `argument` |
| `destroy` | 2107 | `change`, `validate`, `pipe_through`, `metadata`, `argument` |

`actions` section options (`:935-940`):

- `defaults` — "Creates a simple action of each specified type, with the same name as the type. These
  will be `primary?` unless one already exists for that type." So `defaults [:read]` creates **only**
  `:read` (`:937`).
- `default_accept` — default value for `accept` on each action; "Ash >= 3.0 defaults to no
  attributes accepted" (`:938`).

### 1.3 `Ash.Domain`

| Section | `##` line | Purpose | Entities / options |
|---|---|---|---|
| `domain` | 8 | Description of the domain. | `description` |
| `resources` | 37 | The list of resources the app may touch. | `resource` (→ `define`, `define_calculation`); section options `allow` (mfa), `allow_unregistered?`; `resource` option `namespace` (`:104`) |
| `execution` | 402 | Per-domain execution defaults. | `timeout` (default `:infinity`, `:422`), `trace_name` (`:423`) |
| `authorization` | 430 | Per-domain authorization defaults. | `require_actor?` (default `false`, `:451`), `authorize` (`:always` \| `:by_default` \| `:when_requested`, default `:by_default`, `:452`) |

```elixir
resources do
  resource MyApp.Tweet
  resource MyApp.Comment
end
```
(verbatim, `documentation/dsls/DSL-Ash.Domain.md:52-55`)

### 1.4 Policies DSL (separate extension)

`documentation/dsls/DSL-Ash.Policy.Authorizer.md`, `##` headings at lines 35 and 813:

- `policies` → `policy` (98), `policy_group` (322), `bypass` (612). Section option
  `default_access_type` (`:strict | :filter | :runtime`, default `:filter`;
  `lib/ash/policy/authorizer/authorizer.ex:325-331`).
- `policy` → `authorize_if` (155), `forbid_if` (195), `authorize_unless` (235), `forbid_unless` (275).
- `policy_group` → `policy` (381), which has the same four check entities (438, 478, 518, 558).
- `bypass` → **all four**: `authorize_if` (643), `forbid_if` (683), `authorize_unless` (723),
  `forbid_unless` (763).
- `field_policies` → `field_policy`, `field_policy_bypass`
  (`lib/ash/policy/authorizer/authorizer.ex:335-376`).

---

## 2. Attributes and types

### 2.1 Built-in types

The authoritative list is the 31 short names in `@builtin_short_names`
(`lib/ash/type/registry.ex:8-40`):

`map`, `keyword`, `term`, `atom`, `tuple`, `string`, `integer`, `file`, `float`, `duration_name`,
`function`, `boolean`, `struct`, `uuid`, `uuid_v7`, `binary`, `date`, `time`, `time_usec`,
`decimal`, `ci_string`, `naive_datetime`, `utc_datetime`, `utc_datetime_usec`, `datetime`,
`duration`, `url_encoded_binary`, `union`, `module`, `vector`, `range`.

`:array` is a **composite** usable with any type (`{:array, MyApp.Profile}`,
`documentation/topics/resources/embedded-resources.md:81`). The same file also lists
`@custom_short_names Application.compile_env(:ash, :custom_types, [])` (`:44`), so apps can
register their own.

`lib/ash/type/` also contains files that are **not** types: `comparable.ex`,
`composite_type_helpers.ex`, `helpers.ex`, `registry.ex`, `type.ex` (the behaviour module).
`enum.ex` and `new_type.ex` are macro/behaviour modules for defining your own types.

`:struct`, `:union`, `:range`, `:file` and `:function` **are** plain atom short names
(`registry.ex:21`, `:36`, `:39`, `:16`, `:19`) and are configured through constraints, not callbacks.

- `Ash.Type.NewType` declares `subtype_of/0`, `lazy_init?/0`, `subtype_constraints/0`,
  `type_constraints/2` (`lib/ash/type/new_type.ex:39-45`).
- `Ash.Type.Enum` declares `values/0`, `label/1`, `description/1`, `details/1`, `match?/1`,
  `match/1` (`lib/ash/type/enum.ex:142-155`).
- `Ash.Type.Union`, `Ash.Type.Struct` and `Ash.Type.Range` declare no `@callback`.

For structs there is also `Ash.TypedStruct` (`lib/ash/typed_struct.ex:5`,
`documentation/dsls/DSL-Ash.TypedStruct.md`) — there is no `Ash.Type.TypedStruct`.

### 2.2 `attribute` options

Full list of 16, `documentation/dsls/DSL-Ash.Resource.md:86-107`:

| Option | Default | Meaning |
|---|---|---|
| `constraints` | — | Extra rules handed to the type, e.g. `one_of:`, `max_length:`. |
| `description` | — | Human description, used by generated docs. |
| `sensitive?` | `false` | Value is PII; hidden from `inspect` and public interfaces. |
| `source` | — | Map to a different column name in the data layer. |
| `select_by_default?` | `true` | Included in a plain read. |
| `always_select?` | `false` | Always fetched from the DB even under a `select`. |
| `primary_key?` | `false` | Part of the primary key; composite keys are several of these. |
| `allow_nil?` | `true` | Whether `nil` is accepted. |
| `generated?` | `false` | Value may be produced by the data layer. |
| `writable?` | `true` | Whether input can set it. |
| `public?` | `false` (`DSL-Ash.Resource.md:98`) | Whether it appears over public interfaces. Attributes are private by default. |
| `default` | — | Value set on create. |
| `update_default` | — | Value set on update. |
| `filterable?` | `true` (or `:simple_equality`) | Whether filters may reference it. |
| `sortable?` | `true` | Whether sorts may reference it. |
| `match_other_defaults?` | `false` | Share one computed value among attributes with the same lazy default. |

### 2.3 Timestamps and primary keys

`attributes` has five convenience entities: `create_timestamp` (113), `update_timestamp` (157),
`integer_primary_key` (202), `uuid_primary_key` (248), `uuid_v7_primary_key` (292). They expand into
ordinary `attribute` entries, but the options differ:

| Entity | Options it sets | Line |
|---|---|---|
| `create_timestamp`, `update_timestamp` | `writable? false`, `match_other_defaults? true`, `allow_nil? false` | 125-131 |
| `integer_primary_key` | `type :integer`, `primary_key? true`, `writable? false`, `default`, and the only one that sets `generated? true` | 212-224 |
| `uuid_primary_key`, `uuid_v7_primary_key` | `writable? false`, `public? true`, `default`, `primary_key? true` — **no** `generated?` | 262-268, 309-315 |

### 2.4 Constraints, custom types, embedded resources

- **Constraints** are per-type keyword lists passed to the type at cast time. Tutorial usage:
  `constraints [one_of: [:open, :closed]]` on an `:atom` (`documentation/tutorials/get-started.md:253`).
- **Embedded resources** are `use Ash.Resource, data_layer: :embedded`
  (`documentation/topics/resources/embedded-resources.md:52-59`). Because an embedded resource
  defines an `Ash.Type` under the hood, it can be used anywhere a type can
  (`:71-78`). The guide warns embedded resources cannot have aggregates or data-layer-specific
  expression calculations (`:61-64`).

### 2.5 Custom change / validation / preparation behaviours

| Behaviour | Callbacks | Doc |
|---|---|---|
| `Ash.Resource.Change` | `change/3`, `atomic/3`, `batch_change/3` | `documentation/topics/resources/changes.md` |
| `Ash.Resource.Validation` | `validate/3`, `atomic/3`, `batch_validate/3` (`lib/ash/resource/validation.ex:69`, `:77`, `:99`) | `documentation/topics/resources/validations.md` |
| `Ash.Resource.Preparation` | `prepare/3` | `documentation/topics/resources/preparations.md` |
| `Ash.Resource.ManualRelationship` | `load/3`, `select/1` (`lib/ash/resource/manual_relationship/manual_relationship.ex:35-37`) | `documentation/topics/resources/relationships.md` |
| `Ash.Resource.Calculation` | `init/1`, `describe/1`, `calculate/3`, `expression/2`, `load/3`, `strict_loads?/0`, `has_expression?/0` (`lib/ash/resource/calculation/calculation.ex:209-222`) | `documentation/topics/resources/calculations.md` |
| `Ash.CustomExpression` | `expression/2`, `name/0`, `arguments/0` (`lib/ash/custom_expression.ex:71-101`) | `documentation/topics/reference/expressions.md:200-215` |

---

## 3. Relationships

Kinds: `has_one` (`:405`), `has_many` (`:517`), `many_to_many` (`:630`), `belongs_to` (`:743`).
Each accepts a nested `filter` entity.

### 3.1 Options — the four lists are NOT identical

| Option | `has_one` | `has_many` | `many_to_many` | `belongs_to` |
|---|---|---|---|---|
| `manual` | ✅ `:448` | ✅ `:562` | ❌ | ❌ |
| `no_attributes?` | ✅ `:449` | ✅ `:563` | ❌ | ❌ |
| `through` | ✅ traversal `:450` | ✅ traversal `:564` | ✅ **join resource** `:678` | ❌ |
| `allow_nil?` | ✅ `:451` | ❌ | ❌ | ✅ `:783` (on the generated attribute) |
| `from_many?`, `offset` | ✅ `:452-453` | `offset` only `:566` | ❌ | ❌ |
| `limit` | ❌ | ✅ `:565` | ❌ | ❌ |
| `join_relationship`, `source_attribute_on_join_resource`, `destination_attribute_on_join_resource` | ❌ | ❌ | ✅ `:676-679` | ❌ |
| `define_attribute?`, `attribute_type`, `attribute_writable?`, `attribute_public?`, `attribute_always_select?`, `primary_key?` | ❌ | ❌ | ❌ | ✅ `:782-788` |
| `could_be_related_at_creation?` | ✅ `:469` | ✅ `:582` | ✅ `:695` | ❌ |
| Shared with all four | `description`, `destination_attribute`, `validate_destination_attribute?`, `source_attribute`, `relationship_context`, `public?`, `not_found_message`, `writable?`, `read_action`, `read_action_arguments`, `domain`, `filterable?`, `sortable?`, `sort`, `default_sort`, `violation_message`, `authorize_read_with`, `allow_forbidden_field?`, `temporal_keys` | | | |

### 3.2 Manual relationships

`manual` takes a module implementing `Ash.Resource.ManualRelationship` or a 2-arg function
`(source_records, context)`; setting it implies `no_attributes? true`
(`documentation/dsls/DSL-Ash.Resource.md:448`).

### 3.3 `through` / many-to-many

`through` on `has_one`/`has_many` is a list of relationship names to traverse:
"for example, `through: [:classrooms, :teachers]` would load all teachers from all classrooms"
(`:564`). For `many_to_many`, `through` names the join **resource** and `join_relationship` names
the `has_many` to it, defaulting to `<relationship_name>_join_assoc` (`:678-679`).

### 3.4 Managing relationships from actions

Built-in change `manage_relationship(argument, relationship_name \\ nil, opts)`
(`lib/ash/resource/change/builtins.ex:305`). Its `@doc` (`:290-296`) gives the two forms:

```elixir
change manage_relationship(:comments, type: :append)
change manage_relationship(:remove_comments, :comments, type: :remove)
```

The `type:` values are `:append_and_remove`, `:append`, `:remove`, `:create`, `:direct_control`
(`lib/ash/changeset/changeset.ex:5697`, `:5707`, `:5717`, `:5726`, `:5734`). On the changeset:
`manage_relationship/4` (`:6136`), `manage_relationship_opts/1` (`:5697-5743`),
`manage_relationship_schema/0` (an `@doc false` schema constant, `:6010`). Related built-ins: `cascade_destroy`
(`lib/ash/resource/change/builtins.ex:407`) and `cascade_update` (`:447`).

---

## 4. Actions

### 4.1 The five action types

`create` (1178), `read` (1471), `update` (1820), `destroy` (2107), generic `action` (942).

`defaults` names which standard actions to generate, each with the same name as its type
(`:937`). Tutorial usage: `defaults [:read]` creates only `:read` — "Use the default implementation
of the :read action" (`documentation/tutorials/get-started.md:164-165`).

**Shared by create/update/destroy only** (read and generic `action` lack them): `accept` (`:1228`,
`:1864`, `:2157`), `action_select` (`:1229`), `require_attributes`, `allow_nil_input`,
`delay_global_validations?`, `notifiers` (`:1235`), `manual?` (`:1236`).

**Shared by create/read/update/destroy but not generic `action`**: `multitenancy` (`:1220`,
`:1514`, `:1857`, `:2147`) and `skip_global_validations?` (`:1233`, `:1515`).

**Shared by create, update, destroy and generic `action` — not read**: `error_handler`, "Sets the
error handler on the changeset" (`:1234`) or "on the action input" (`:988`).

**Shared by all five** (`:1222-1227`, `:989-994`): `primary?` (`:1222`), `description`,
`transaction?` (reads default `false`, writes `true` when supported), `touches_resources` (`:1225`),
`skip_unknown_inputs`, `public?`.

**Read's full option list** (`:1509-1521`): `manual`, `get?`, `modify_query`, `get_by`, `timeout`,
`multitenancy`, `skip_global_validations?`, `primary?`, `description`, `transaction?`,
`touches_resources`, `skip_unknown_inputs`, `public?`. Read has none of `accept`, `action_select`,
`require_attributes`, `allow_nil_input`, `delay_global_validations?`, `notifiers`, `manual?` or
`error_handler`.

**Generic `action` only** (`:985-994`): `returns` (positional), `constraints`, `allow_nil?`
(default `false`), `run` (an `Ash.Resource.Actions.Implementation` module or a `Reactor`).

- `accept` — "the list of attributes to accept. Use `:*` to accept all public attributes" (`:1228`).
  Tutorial: `create :open do accept [:subject] end` (`documentation/tutorials/get-started.md:271-273`).
- `action_select` — "controls which attributes are present (vs `%Ash.NotLoaded{}`) on the record
  passed to after_action hooks, notifiers, and returned to the caller" (`:1229`).
- Read-specific: `manual`, `get?`, `modify_query`, `get_by` (`:1512` — "sets `get?`
  to true, add args for each of the specified fields, and adds a filter for each of the arguments"),
  `timeout` (`:1513`).

### 4.2 Arguments

`argument name, type` (`:1019`) — `type` is a **positional argument**, not an option. Options are
`description`, `constraints`, `allow_nil?`, `public?`, `sensitive?`, `default` (`:1025-1030`).
There is no `doc` option.

### 4.3 Built-in changes (complete, 24)

`lib/ash/resource/change/builtins.ex` — 19 functions + 5 macros:

`filter` (18), `relate_actor` (34), `debug_log` (44), `optimistic_lock` (53),
`get_and_lock_for_update` (74), `get_and_lock` (92), **`update_change` macro (102)**, `increment`
(122), `set_attribute` (156), `atomic_set` (206), `atomic_update` (247), `set_new_attribute` (267),
`prevent_change` (283), `manage_relationship` (305), `set_context` (325), `load` (338), `select`
(357), `ensure_selected` (371), `cascade_destroy` (407), `cascade_update` (447),
**`after_action` macro (466)**, **`after_transaction` macro (496)**,
**`before_action` macro (523)**, **`before_transaction` macro (550)**.

### 4.4 Built-in validations (complete, 24)

`lib/ash/resource/validation/builtins.ex`: `one_of` (22), `data_one_of` (34), `changing` (52),
`confirm` (66), `attribute_does_not_equal` (81), `negate` (93), `any` (108), `all` (129),
`action_is` (143), `attribute_equals` (158), `attribute_in` (175), `string_length` (193),
`byte_size` (211), `numericality` (233), `compare` (239), `match` (253), `present` (282),
`attributes_present` (301), `absent` (337), `attributes_absent` (375),
`argument_does_not_equal` (415), `argument_equals` (430), `argument_in` (445),
`pre_flight_authorization` (463).

```elixir
validate attribute_does_not_equal(:status, :closed) do
  message "Ticket is already closed"
end
```
(verbatim, `documentation/tutorials/get-started.md:325-327`)

### 4.5 Built-in preparations (complete, 4)

`lib/ash/resource/preparation/builtins.ex`: `set_context` (21), `build` (39),
**`before_action` macro (57)**, **`after_action` macro (82)**. Preparations take no action-input
arguments — they rewrite a query.

### 4.6 Lifecycle hooks

The **DSL-level** way users attach them — these are the 6 macros in §4.3/§4.5, written inside a
`change` or `prepare` entity. Two of the six, verbatim from the macro docs — note the arities:
`before_action` gets `(changeset, context)`, `after_action` also gets the record:

```elixir
change before_action(fn changeset, _context ->
  Logger.debug("About to execute #{changeset.action.name} on #{inspect(changeset.resource)}")

  changeset
end)
```
(verbatim, `lib/ash/resource/change/builtins.ex:517-522`)

```elixir
change after_action(fn changeset, record, _context ->
  Logger.debug("Successfully executed action #{changeset.action.name} on #{inspect(changeset.resource)}")
  {:ok, record}
end)
```
(verbatim, `lib/ash/resource/change/builtins.ex:460-464`)

The other four heads (verbatim, one line each): `change before_transaction(fn changeset, _context ->`
(`lib/ash/resource/change/builtins.ex:544`), `change after_transaction(fn` (`:487`),
`prepare before_action(fn query, _context ->` (`lib/ash/resource/preparation/builtins.ex:51`),
`prepare after_action(fn query, records, _context ->` (`:76`).

On `Ash.Changeset` the imperative equivalents are `before_transaction/2`,
`around_transaction/2`, `after_transaction/2`, `before_action/2`, `around_action/2`,
`after_action/2`; the runners are `run_before_transaction_hooks/1` (`:5066`),
`run_before_actions/1` (`:5115`), `run_after_transactions/2` (`:5205`),
`run_after_actions/3` (`:5308`). `with_hooks/3` is the wrapper (`:4743`).

`Ash.Query` has **no** `around_action`. Generic actions have a dedicated "Action Hooks" section
(`documentation/topics/actions/generic-actions.md:258`) and an "Execution Order" section (`:391`).

### 4.7 Upserts

Create-action options: `upsert?`, `upsert_identity`, `upsert_fields`
(`:replace_all | {:replace, …} | {:replace_all_except, …} | atom | list(atom)`),
`upsert_condition`, `return_skipped_upsert?` (`:1214-1219`). The `upsert_conflict/1` expression
function refers to the *incoming* value during an upsert
(`documentation/topics/reference/expressions.md:91`).

### 4.8 Bulk actions

`Ash.bulk_create/3`, `Ash.bulk_update/4`, `Ash.bulk_destroy/4` plus bang variants.
Strategies: ":strategy - One or more of :atomic, :atomic_batches, and :stream" (`lib/ash.ex:3880`);
":stream is used in all cases if the data layer does not support atomics" (`:578`, `:639`). Other
shared bulk options: `return_records?`, `notify?`, `stream_batch_size`, `allow_stream_with`
(`:keyset | :offset | :full_read`, `:555`, `:625`). Filter checks apply to the reads bulk update and
destroy generate (`policies.md:122`).

### 4.9 Atomic updates and `require_atomic?`

`update` and `destroy` both default `require_atomic? true` (`:1854`, `:2148`). "This means that all
changes and validations implement the `atomic` callback" (`:1854`). `atomic_upgrade?` (default
`false`) is the option that is "Ignored if `required_atomic?` is `true`" (`:1855`);
`atomic_upgrade_with` is the read action used when upgrading (`:1856`). Atomic built-ins:
`atomic_set` (`lib/ash/resource/change/builtins.ex:206`), `atomic_update` (`:247`), plus
`increment` (`:122`) and `optimistic_lock` (`:53`). Among the atomic-execution helpers named here,
`fully_atomic_changeset/4` (`:813`) is the only public one. Other public atomic functions are `atomic_defaults` (`:895`), `atomic_ref` (`:1703`),
`atomic_update` (`:2417`) and `atomic_set` (`:2607`); `run_atomic_change/3` (`:1300`),
`run_atomic_validation/3` (`:1217`), `add_atomic_validations/3` (`:3985`) and
`apply_atomic_constraints/3` (`:3880`) are `@doc false` internals.

### 4.10 Manual actions

`manual` on read/create/update/destroy accepts a module, `{module, opts}` or a function
(`:1509`, `:1853`, `:2146`); `manual? true` skips the data-layer call (`:1236`). Guide:
`documentation/topics/actions/manual-actions.md`.

### 4.11 Pagination

`actions.read.pagination` (`:1698-1727`), 9 options: `keyset?` (default `false`), `offset?`
(default `false`), `via_data_layer?` (default `:data_layer_default`), `default_limit`, `countable`
(default `true`), `max_page_size` (default `250`), `stable_sort` (defaults to the primary key),
`required?`, `paginate_by_default?`. Runtime: `Ash.get`, `Ash.get!`, `Ash.first`, `Ash.list`,
`Ash.page`, `Ash.count`, `Ash.load` (`lib/ash.ex`). Guide:
`documentation/topics/advanced/pagination.livemd`.

### 4.12 Transactions

`transaction?` on every action type and `touches_resources` (`:1225`) "used when building
transactions". `Ash.transact/3` and `Ash.transaction/3` (`lib/ash.ex`). Notifiers only fire after
commit (`documentation/topics/resources/notifiers.md:113`).

### 4.13 Soft destroy

`destroy` has `soft?` — "If specified, the destroy action behaves as an update internally"
(`:2145`) — and its `require_atomic?` is "Only relevant if `soft?` is set to `true`" (`:2148`).

---

## 5. Query features

`Ash.Query` public functions (`lib/ash/query/query.ex`): `filter_input`, `sort_input`, `do_filter`,
`filter`, `sort`, `select`, `deselect`, `selecting?`, `ensure_selected`, `distinct`, `distinct_sort`,
`limit`, `offset`, `page`, `default_sort`, `load`, `load_through`, `loading?`, `unload`,
`merge_query_load`, `calculate`, `load_calculation_as`, `aggregate`, `lock`, `set_actor`,
`set_argument`, `set_arguments`, `get_argument`, `fetch_argument`, `delete_argument`, `set_context`,
`put_context`, `set_tenant`, `set_domain`, `set_authorize?`, `set_tracer`, `as_of`, `for_read`,
`for_read_opts`, `authorize_results`, `add_error`, `set_result`, `clear_result`, `unset`,
`equivalent_to?`, `subset_of?`, `superset_of?`, `before_action`, `after_action`,
`before_transaction`, `around_transaction`, `after_transaction`, `build`, `data_layer_query`,
`new`, `apply_to`, `combination_of`, `combination_hydration_context`, `timeout`, `validate_load`,
`validate_calculation_arguments`.

```elixir
Helpdesk.Support.Ticket
|> Ash.Query.filter(contains(subject, "2"))
|> Ash.read!()
```
(verbatim, `documentation/tutorials/get-started.md:503-505`)

Combination queries (`union`, `intersect`, `except`, `combine`, `left_join`) are described in
`documentation/topics/advanced/combination-queries.md` and exposed on `Ash.Query` as
`combination_of/2` and `combination_hydration_context/1` (`lib/ash/query/query.ex:564`).

### 5.1 Calculations

Expression-based or module-based, with `load:` for required fields (`:4200-4214`). Options (`:4230-4245`):
`async?`, `constraints`, `description`, `public?`, `sensitive?`, `load`, `allow_nil?`, `filterable?`,
`sortable?`, `field?`, `multitenancy`. Calculations can take their own `argument` entities (`:4247`).

```elixir
calculate :full_name, :string, expr(first_name <> " " <> last_name)
```
(verbatim, `documentation/dsls/DSL-Ash.Resource.md:4204`)

### 5.2 Aggregates

9 kinds. Options shared by **all** kinds (`:3296-4102`): `relationship_path`, `read_action`,
`filter`, `description`, `default`, `public?`, `filterable?`, `sortable?`, `sensitive?`,
`authorize?`, `multitenancy`.

| Extra option | Kinds | Line |
|---|---|---|
| `field` | all except `exists` | 3344, 3522, 3616, 3709, 3804, 3896, 3988, 4089 |
| `uniq?` | `count`, `list` | 3342, 3715 |
| `include_nil?` | `first`, `list` | 3527, 3714 |
| `sort` | `first`, `list`, `custom` | 3530, 3718, 4091 |
| `type`, `implementation` | `custom` | 4082, 4087 |

`join_filter` takes `relationship_path` and `filter` (`:3356-3398`).

```elixir
aggregates do
  count :assigned_ticket_count, :reported_tickets do
    filter [active: true]
  end
end
```
(verbatim, `documentation/dsls/DSL-Ash.Resource.md:3285-3289`)

### 5.3 Expression operators

`documentation/topics/reference/expressions.md:34-49` lists 15 operators plus `is_nil`. The
registered operator modules are also 15: the 8 named at `lib/ash/filter/filter.ex:120-129`
(`IsNil, Eq, NotEq, In, LessThan, GreaterThan, LessThanOrEqual, GreaterThanOrEqual`) plus the 7
symbols of `Ash.Query.Operator.Basic` (`+ * - / <> || &&`, `lib/ash/query/operator/basic.ex:9-10`),
registered through `Ash.Query.Operator.Basic.operator_modules()`. `and`/`or` are boolean
expressions, not operator modules. `filter.ex:135-142` registers the aliases `equals`, `not_equals`,
`gt`, `lt`, `gte`, `lte`. **Treat the guide's list as a readable rendering of the registered list.**

### 5.4 Expression functions

`lib/ash/filter/filter.ex:76-116` registers **39** functions:
`Ago`, `At`, `CompositeType`, `Contains`, `CountNils`, `DateAdd`, `DateTimeAdd`, `Fragment`,
`FromNow`, `GetPath`, `Has`, `IsDistinctFrom`, `IsNil`, `IsNotDistinctFrom`, `If`, `Intersects`,
`Lazy`, `Length`, `Minus`, `Now`, `RangeAdjacent`, `RangeContains`, `RangeLower`, `RangeOverlaps`,
`RangeUpper`, `Error`, `Rem`, `Round`, `Today`, `Type`, `StartOfDay`, `StringDowncase`,
`StringEndsWith`, `StringJoin`, `StringLength`, `StringPosition`, `StringSplit`,
`StringStartsWith`, `StringTrim`.

The guide documents a readable subset of these plus the special forms `exists/2`, `path.exists/2`
and `parent/1` (`documentation/topics/reference/expressions.md:69-91`, `:106-130`, `:135-139`),
inline aggregates (`:141-184`), error expressions (`:414-482`) and `lazy/1` (`:137`).

### 5.5 Expression templates — 5, not 6

The guide documents 4 (`:190-197`); the source has a 5th, `^tenant()` (`lib/ash/expr/expr.ex:106`,
expanded at `:277`). `parent/1` and `path.exists/2` are *sub-expressions*, not templates
(`expressions.md:117`, `:118`).

```elixir
^actor(:key) # equivalent to `get_in(actor || %{}, [:key])`
^actor([:key1, :key2]) # equivalent to `get_in(actor || %{}, [:key, :key2])`
^arg(:arg_name) # equivalent to `Map.get(arguments, :arg_name)`
^context(:key) # equivalent to `get_in(context, :key)`
^context([:key1, :key2]) # equivalent to `get_in(context, [:key1, :key2])`
^ref(:key) # equivalent to referring to `key`. Allows for dynamic references
^ref([:path], :key) # equivalent to referring to `path.key`. Allows for dynamic references with dynamic (or static) paths.
```
(verbatim, `documentation/topics/reference/expressions.md:190-197`; `^tenant()` is at
`lib/ash/expr/expr.ex:106`)

---

## 6. Policies

Guide: `documentation/topics/security/policies.md`. DSL: `documentation/dsls/DSL-Ash.Policy.Authorizer.md`.

### 6.1 Structure and options

- **policy** — options are exactly four (`lib/ash/policy/authorizer/authorizer.ex:166-202`):
  `description`, `access_type` (`:strict | :filter | :runtime`, `:170-175`), `condition` (`:176-181`,
  "A check or list of checks that must be true in order for this policy to apply") and
  `error_message` (`:182-201`, a string or a 2-arity `(subject, context)` function). Its
  `condition` is an ordinary check such as `action_type(:read)`. Its entities are the four check
  forms `authorize_if`, `forbid_if`, `authorize_unless`, `forbid_unless`.
- **bypass** — same four check entities; if a bypass passes, later policies need not
  (`documentation/topics/security/policies.md:151-154`).
- **policy_group** — "groups a set of policies together by some condition. If the condition on the
  policy group does not apply, then none of the policies within it apply"
  (`lib/ash/policy/authorizer/authorizer.ex:222-224`). Groups nest.
- **field policies** — `field_policy` takes `fields` (positional, `:wrap_list`), `description` and
  an optional `condition`, plus the four check entities (`:335-367`); `field_policy_bypass` is the
  same with `bypass?: true` (`:370-376`). "If *any* field policies exist then *all* fields must be
  authorized by a field policy" (`:387`), except primary keys (`:392`); the deny-list style uses
  the special field name `:*` (`:389`). Forbidden fields become `%Ash.ForbiddenField{}`.

Decision rule: checks run top to bottom; the first to return `:authorized`/`:forbidden` decides the
policy; `:unknown` falls through. If all are `:unknown`, the policy is treated as forbidden
(`documentation/topics/security/policies.md:78-115`, `:609-620`).

Realistic example (verbatim, `documentation/topics/security/policies.md:159-178`):

```elixir
policies do
  # Anything you can use in a condition, you can use in a check, and vice-versa
  # This policy applies if the actor is a super_user
  # Additionally, this policy is declared as a `bypass`. That means that this check is allowed to fail without
  # failing the whole request, and that if this check *passes*, the entire request passes.
  bypass actor_attribute_equals(:super_user, true) do
    authorize_if always()
  end

  # This will likely be a common occurrence. Specifically, policies that apply to all read actions
  policy action_type(:read) do
    # unless the actor is an active user, forbid
    forbid_unless actor_attribute_equals(:active, true)
    # if the record is marked as public, authorize
    authorize_if expr(public == true)
    # if the actor is related to the data via that data's `owner` relationship, authorize
    authorize_if relates_to_actor_via(:owner)
  end
end
```

### 6.2 Access types

`access_type` decides the *latest point* at which a check may be applied
(`documentation/topics/security/policies.md:227-244`). Default `:filter`; the resource-level
section option is `default_access_type` (`lib/ash/policy/authorizer/authorizer.ex:325-331`).

| Access type | Behaviour |
|---|---|
| `:strict` | All checks must be applied statically; unmet → forbidden error. |
| `:filter` | Statically or as a filter. Reads → filtered read; update/destroy → the original loaded record; create → the inserted record *inside the transaction*, rolled back on mismatch (`:231-234`, `:271-295`). |
| `:runtime` | Checks run *after* the read. Needs a transactional data layer and `transaction? true`; refused on actions with `before_transaction`/`around_transaction` hooks unless you opened the transaction. "exceedingly rare". |

### 6.3 Built-in checks (complete, 22)

`lib/ash/policy/check/built_in_checks.ex`: `always` (24), `never` (35), `action_type` (62),
`just_created_with_action` (73), `action` (83), `resource` (91), `private_action?` (108),
`actor_present` (116), `actor_absent` (124), `filtering_on` (165), `selecting` (194), `loading` (204),
`accessing_from` (229), `relates_to_actor_via` (256), `can_read` (328), `actor_attribute_equals`
(340), `context_equals` (361), `changing_attributes` (386), `relating_to_actor` (407),
`changing_relationship` (412), `changing_relationships` (417), **`matches` macro (422)**.

### 6.4 Check kinds

- **Simple check** (`documentation/topics/security/policies.md:617`) — `use Ash.Policy.SimpleCheck`
  (`:625`), implement `describe/1` and `match?/3`; returns true/false.
- **Filter check** (`:662`) — `use Ash.Policy.FilterCheck` (`:677`), implement `filter/3`.
- **Inline checks** (`:704`) — filter checks written directly in the policy (`:711`).
- **Manual check** — the supertype both of the above fall under (`:609`).

### 6.5 Reads vs writes

"Read actions are, by default, **filtered** by policies rather than returning authorization errors"
(`:126`). Forbidden records do not appear; a single-record read then yields `NotFound`. Opt out
with `authorize_with: :error` (`:136-149`). Filter checks on update/destroy apply before the action
runs; on create they run against the inserted row inside the transaction (`:122`, `:229-233`).
Cross-resource composition uses `can_read` and `accessing_from` (`:516-579`); relationships carry
`authorize_read_with` and `allow_forbidden_field?` (`:467-515`).

### 6.6 `error_message` and debugging

A policy's `error_message` is a string or a `(subject, context)` function; the function may return
an `Exception.t()` that "**replaces** the default `Ash.Error.Forbidden.Policy` entirely" and
otherwise sets the message (`lib/ash/policy/authorizer/authorizer.ex:186-200`; guide `:370-447`).
Policy breakdowns and logging: `:967-1047`.

### 6.7 `Ash.can?` and friends

`lib/ash.ex:1840` `can?/3` (spec: "Ash.Can.subject(), actor() | Ash.Scope.t(), Keyword.t()"),
`:1963` `can/3`, `:2063` `can_see_fields?/4`, `:2101` `can_see_fields/4`, `:2164`
`can_do_all?/2`, `:2207` `can_do_all/2`.

### 6.8 Default when no policy applies

Settled from source. `raw_expression/1` folds the applicable policies from `{false, true}`
(`lib/ash/policy/policy.ex:81`) and returns `one_condition_matches and all_policies_match` (`:97`).
With **zero** applicable policies that is `false`, so a request no policy applies to is
**forbidden**. A bypass counts toward "at least one applies" only if it authorizes (`:85-86`).
Separately the authorizer is **opt-in**: a resource has policy authorization only if it declares
`authorizers: [Ash.Policy.Authorizer]` (`policies.md:20`).

### 6.9 Actors and `Ash.Scope`

Actor/tenant/authorize are passed per call as `actor:`, `tenant:`, `authorize?:`, and `scope:`
options (`documentation/topics/security/actors-and-authorization.md`). `Ash.Scope`
(`lib/ash/scope.ex`) determines how `actor`, `tenant` and `context` are extracted from a data
structure: the user implements the `Ash.Scope.ToOpts` protocol for their own struct so the actor,
tenant, context, `authorize?` and tracer can be pulled out of it (`lib/ash/scope.ex:5-12`,
`:55-61`). Sensitive data:
`documentation/topics/security/sensitive-data.md`.

---

## 7. Multitenancy

`documentation/dsls/DSL-Ash.Resource.md:4310-4348`, guide
`documentation/topics/advanced/multitenancy.md`.

| Option | Type | Default | Notes |
|---|---|---|---|
| `strategy` | `:context` \| `:attribute` | `:context` | `:context` defers to data-layer features; `:attribute` filters on an attribute. |
| `attribute` | atom | — | Required for `:attribute`, e.g. `org_id`. |
| `global?` | boolean | `false` | Whether data may be accessed without a tenant set. |
| `parse_attribute` | mfa | — | Tenant → attribute value. |
| `tenant_from_attribute` | mfa | — | The inverse. |

```elixir
multitenancy do
  strategy :attribute
  attribute :organization_id
  global? true
end
```
(verbatim, `documentation/dsls/DSL-Ash.Resource.md:4323-4327`)

Tenant is set with `Ash.Query.set_tenant/2` or `Ash.Changeset.set_tenant/2` (`:4315`) or
`Ash.PlugHelpers.set_tenant` / `Ash.Scope` (`documentation/topics/advanced/multitenancy.md:31-64`).

The per-action/calculation `multitenancy` override is `:enforce | :allow_global | :bypass |
:bypass_all`, default `:enforce` (e.g. `:1220`). It exists on create, read, update, destroy
(`:1220`, `:1514`, `:1857`, `:2147`) and on calculations (`:4244`) — **not** on generic `action`
(`:985-994`). Identities have `all_tenants?` (`:2828`). Guide sections: "Setting Tenant" (`:31`),
"Attribute Multitenancy" (`:66`), "Transforming Tenant Values" (`:140`), "Tenant-Aware Identities"
(`:189`), "Context Multitenancy" (`:245`), "Possible Values for tenant" (`:256`).

---

## 8. Code interfaces, `Ash.Changeset`, `Ash.Query`, `Ash.ActionInput`, `Ash.*`

### 8.1 `code_interface`

Section options (`:2428-2436`): `domain`, `define?`, `namespace`.

```elixir
code_interface do
  define :create_user, action: :create
  define :get_user_by_id, action: :get_by_id, args: [:id], get?: true
end
```
(verbatim, `documentation/dsls/DSL-Ash.Resource.md:2418-2421`)

`define` options (`:2466-2480`): `action`, `args`, `not_found_error?` (default `true`),
`require_reference?`, `exclude_inputs`, `get?`, `get_by`, `get_by_identity`, `default_options`,
`namespace`, and `functions` — which by default generates **all five** of
`:subject, :can, :can?, :action, :action!` (`:2478`).

`define_calculation` options (`:2614-2620`): `calculation`, `exclude_inputs`, `args`
(`:name`, `{:arg, :name}`, `{:ref, :name}`), `namespace`. Use `:_record` to take a record instance.

Both can be declared on the resource **or** on the domain's `resources.resource`
(`documentation/dsls/DSL-Ash.Domain.md:107-291`). Guide:
`documentation/topics/resources/code-interfaces.md`.

### 8.2 `Ash.Changeset` public API

Public functions in `lib/ash/changeset/changeset.ex` (`@doc false` internals excluded):
`new` (508), `select` (592), `load` (688), `ensure_selected` (723), `deselect` (739),
`selecting?` (753), `loading?` (783), `accessing` (795), `fully_atomic_changeset` (813),
`atomic_defaults` (895), `atomic_ref` (1703), `for_action` (1934),
`for_create` (2100), `for_update` (2210), `for_destroy` (2293), `atomic_update` (2417, 2498),
`atomic_set` (2607, 2614), `set_result` (2900), `expand_upsert_fields` (2908-2925),
`present?` (3140), `attribute_present?` (3176), `prepare_changeset_for_action` (3196), `with_hooks` (4743), `run_before_transaction_hooks` (5066),
`get_argument` (5438, 5446), `fetch_argument` (5462, 5475), `get_attribute` (5491),
`fetch_attribute` (5513), `get_argument_or_attribute` (5525),
`fetch_argument_or_attribute` (5544), `fetch_argument_or_change` (5559),
`fetch_change` (5553), `get_data` (5568), `fetch_data` (5596), `put_context` (5606),
`set_tenant` (5611), `as_of` (5628, 5630), `timeout` (5642), `set_context` (5652, 5654),
`manage_relationship` (6136), `changing_attributes?` (6564), `changing_attribute?` (6605),
`changing_relationship?` (6613), `change_new_attribute` (6619), `change_new_attribute_lazy` (6636),
`force_change_new_attribute` (6896), `force_change_new_attribute_lazy` (6910),
`update_change` (6671), `set_argument` (6720), `set_private_argument` (6729),
`force_set_argument` (6784), `delete_argument` (6849), `force_delete_argument` (6862),
`set_arguments` (6873), `force_set_arguments` (6884), `change_attributes` (6948), `change_attribute` (6989),
`change_default_attribute` (7114), `force_change_attributes` (7138), `force_change_attribute` (7146),
`before_action` (7326), `before_transaction` (7389), `after_action` (7471),
`after_transaction` (7607), `around_action` (7677), `around_transaction` (7731),
`clear_change` (7782), `handle_errors` (7818), `filter` (7832), `add_error` (7901),
`apply_attributes` (7758).

`get_result` and `run_atomic_conditions` do **not** exist. `handle_allow_nil_atomics` (2817),
`hydrate_atomic_refs` (3825), `validate_multitenancy` (3495) — and the runners
`run_before_actions` (5115), `run_after_transactions` (5205), `run_after_actions` (5308),
`split_atomic_conditions` (1169), `run_atomic_validation` (1217), `run_atomic_change` (1300),
`set_on_upsert` (2930), `handle_params` (3222), `require_values` (4517), `manage_relationship_opts`
(5697), `manage_relationship_schema` (6010), `set_action_select` (613), `atomic_condition` (1743),
`temporal_recorded_at` (4307) and `set_private_arguments_for_action` (6739) — are `@doc false`
internals.

### 8.3 `Ash.*` top-level functions

`lib/ash.ex`: `create/2`, `update/3`, `destroy/2`, `get/3`, `get!`, `read/2`, `read!`, `read_one/2`,
`read_one!`, `read_first/2`, `read_first!`, `load/3`, `load!`, `update_many/3`, `update_many!`,
`first/2`, `list/2`, `page/2`, `page!`, `reload/2`, `stream!/2`, `count/2`, `exists/2`, `exists?/2`,
`sum/3`, `max/3`, `min/3`, `avg/3`, `aggregate/3`, `calculate/3`, `bulk_create/3`, `bulk_update/4`,
`bulk_destroy/4` and the bang variants, `run_action/2`, `transact/3`, `transaction/3`,
`data_layer_query/2`, `pkey_filter/2`, plus `can?`, `can`, `can_see_fields?`, `can_see_fields`,
`can_do_all?`, `can_do_all` (`:1840-2207`) and the `*_opts` helpers (`:1061`, `:1066`, `:1103`).
Arities are the maximum ones: `exists/2`, `exists?/2`, `aggregate/3`, `run_action/2` and
`data_layer_query/2` each take an optional `opts` keyword list as their last argument
(`lib/ash.ex:1193`, `:1299`, `:1329`, `:2299`, `:3086`); `pkey_filter/2` takes `(records, pkey)`
(`:4642`).

### 8.4 `Ash.ActionInput`

The generic-action counterpart of `Changeset`/`Query` (`lib/ash/action_input.ex`), built by
`Ash.ActionInput.for_action/4` (`lib/ash/action_input.ex:253`) and carrying `error_handler`
(`documentation/dsls/DSL-Ash.Resource.md:988`).

---

## 9. Identities, resource-level validations, notifiers, pub_sub

**Identities** (`:2785-2833`). `identity name, keys`; 10 options: `where`, `nils_distinct?`
(default `true`), `eager_check?`, `eager_check_with`, `pre_check?`, `pre_check_with`, `description`,
`field_names`, `message`, `all_tenants?` (`:2828`).

```elixir
identities do
  identity :full_name, [:first_name, :last_name]
  identity :email, [:email]
end
```
(verbatim, `documentation/dsls/DSL-Ash.Resource.md:2775-2778`)

**Resource-level validations** (`:2976-3041`). `validate validation` applies to creates and updates
by default (`on:`, default `[:create, :update]`, `:3030`); options `where`, `on`, `only_when_valid?`,
`message`, `description`, `before_action?`, `always_atomic?`. The same mechanism backs the
`preparations` (`:2913`) and `changes` (`:2841`) sections; `pipelines` (`:3048`) names a reusable
bundle attached with `pipe_through` (`:1127-1160`).

**Notifiers.** Attached to the resource — `use Ash.Resource, notifiers: [ExampleNotifier]`, or
`simple_notifiers:` to avoid a compile-time dependency — or to a single action —
`create :create do notifiers [ExampleNotifier] end` (`documentation/topics/resources/notifiers.md:33-56`).
A notifier implements one callback, `notify/1`; it "does not have to implement an Ash DSL extension,
but they may" (`:65-70`). Notifiers run after commit (`:113`).

**PubSub.** The builtin is `Ash.Notifier.PubSub`, configured through a `pub_sub` section
(`documentation/dsls/DSL-Ash.Notifier.PubSub.md:147`) with entities `publish` and `publish_all`.
Topic templates are a list whose atoms are replaced by record values and joined with `:`
(`:43-56`):

```elixir
pub_sub do
  module MyAppWeb.Endpoint
  prefix "post"

  publish :create, "created", load: [:comment, author: [:full_name]]
  publish :update, ["updated", :id], load: [:comment, author: [:full_name]]
end
```
(verbatim, `documentation/dsls/DSL-Ash.Notifier.PubSub.md:135-141`)

`broadcast_type` selects `:notification`, `:phoenix_broadcast` or `:broadcast` (`:116-125`).
`load:` on a publication preloads fields before broadcasting, deduplicated across publications
(`:127-146`).

---

## 10. Errors

### 10.1 Basis: Splode

Ash errors are **not** hand-rolled. `Ash.Error` does
`use Splode, error_classes: [forbidden: Ash.Error.Forbidden, invalid: Ash.Error.Invalid, framework: Ash.Error.Framework, unknown: Ash.Error.Unknown], merge_with: [Reactor.Error], filter_stacktraces: ["Ash.", "Splode."], unknown_error: Ash.Error.Unknown.UnknownError`
(`lib/ash/error/error.ex:9-18`). The Splode library defines the shared struct: every error is a
`defexception` with its own `fields` plus `splode: nil, bread_crumbs: [], vars: [], path: [],
stacktrace: nil, class:` (`scratch/ash-src/splode/lib/splode/error.ex:112-120`; the reserved names
are listed at `:94`), and error classes also add `errors: []`
(`scratch/ash-src/splode/lib/splode/error_class.ex:11`). Ash re-exports it; the definitions at
`lib/ash/error/error.ex:20-37` are only `@type`s. Splode version examined: **0.3.2**
(`scratch/ash-src/splode/mix.exs:8`), the version pinned by ash's `mix.lock:53`.

`Ash.Error.to_error_class/2` (`:78-96`) reduces a changeset/query/action-input to one of the four
classes; `to_ash_error/3` (`:53`) converts any exception into an Ash error.

### 10.2 Classes

| Class | File | Meaning to a user |
|---|---|---|
| `Ash.Error.Invalid` | `lib/ash/error/invalid.ex` | Their input was bad. Fixable by changing the request. |
| `Ash.Error.Forbidden` | `lib/ash/error/forbidden.ex` | Policy or permission denied. |
| `Ash.Error.Unknown` | `lib/ash/error/unknown.ex` | Something unexpected; a bug. |
| `Ash.Error.Framework` | `lib/ash/error/framework.ex` | A framework invariant failed; a bug in the app or extension. |

### 10.3 Leaves — 91 modules

`lib/ash/error/` holds 99 `.ex` files; 8 are top-level (`error.ex`, `error_kind.ex`, `exception.ex`,
`stacktrace.ex`, `invalid.ex`, `forbidden.ex`, `framework.ex`, `unknown.ex`), leaving **91 leaf
modules**. Representative list:

- `changes/`: `required`, `invalid_attribute`, `no_such_attribute`, `invalid_relationship`,
  `no_such_relationship`, `invalid_argument`, `action_requires_actor`, `stale_record`,
  `period_out_of_bounds`
- `query/`: `not_found`, `no_read_action`, `read_action_required`, `invalid_filter_reference`,
  `invalid_sort`, `invalid_limit`, `invalid_offset`, `no_such_operator`, `no_such_function`,
  `calculation_requires_primary_key`, `unsupported_predicate`, `as_of_not_an_instant`
- `invalid/`: `no_primary_action`, `no_such_action`, `invalid_primary_key`, `tenant_required`,
  `pagination_required`, `action_requires_pagination`, `multiple_results`
- `forbidden/`: `policy`, `domain_requires_actor`, `domain_requires_authorization`,
  `forbidden_field`, `must_pass_strict_check`, `cannot_filter_creates`
- `framework/`: `must_be_atomic`, `can_not_be_atomic`, `pending_codegen`, `load_over_range`
- `unknown/`: `invalid_casted_value`, `invalid_stored_value`

### 10.4 Shape and catching

Errors are returned as `{:error, %Ash.Error.X{}}`; bang variants raise. Tutorial output
(verbatim, `documentation/tutorials/get-started.md:305-307`):

```text
** (Ash.Error.Invalid) Invalid Error

* attribute subject is required
```

The non-bang form returns the struct (`documentation/tutorials/get-started.md:398-403`):

```text
{:error,
 %Ash.Error.Invalid{
...
       message: "Ticket is already closed",
...
```

`error_handler` on the action sets the handler on the changeset or action input
(`:1234`, `:988`); `Ash.Changeset.handle_errors/2` and `Ash.ActionInput.handle_errors/2` are the
APIs. Guide: `documentation/topics/development/error-handling.md`.

---

## 11. Tooling shipped with core

### 11.1 Mix tasks — 25

**14 top-level** (`lib/mix/tasks/*.ex`): `ash.codegen`, `ash.ex`, `ash.extend`,
`ash.generate_livebook`, `ash.generate_policy_charts` (module `Mix.Tasks.Ash.GeneratePolicyCharts`,
`lib/mix/tasks/ash.generate_policy_chart.ex:5`), `ash.generate_resource_diagrams`,
`ash.gettext.extract`, `ash.manifest.dump`, `ash.migrate`, `ash.reset`, `ash.rollback`,
`ash.set.domains`, `ash.setup`, `ash.tear_down`.

**9 generators** (`lib/mix/tasks/gen/*.ex`): `ash.gen.base_resource`, `ash.gen.change`,
`ash.gen.custom_expression`, `ash.gen.domain`, `ash.gen.enum`, `ash.gen.gettext`,
`ash.gen.preparation`, `ash.gen.resource`, `ash.gen.validation`.

**2 more**: `lib/mix/tasks/install/ash.install.ex` (installer),
`lib/mix/tasks/patch/ash.patch.extend.ex` (patcher).

`lib/mix/tasks/helpers.ex` is a helper module, not a task. The generators guide has sections
`## Installer` (`documentation/topics/development/generators.md:13`), `## Generators` (`:45`) and
`## Patchers` (`:56`). `lib/mix/mermaid.ex` is a rendering helper.

### 11.2 Formatter

`.formatter.exs` exports `spark_locals_without_parens` (`:5`), a long list of DSL keyword names the
Elixir formatter must not put parentheses around (e.g. `accept: 1`, `action_select: 1`,
`allow_nil?: 1`). This is how the paren-free DSL stays readable.

### 11.3 Cheat sheets and LLM docs

- The `documentation/dsls/DSL-*.md` files are Spark-generated cheat sheets for every DSL
  (the header of `documentation/dsls/DSL-Ash.Resource.md:2` reads "This file was generated by
  Spark. Do not edit it by hand.").
- `documentation/topics/reference/glossary.md` — the Elixir-for-Ash vocabulary.
- `documentation/2.0-CHANGELOG.md` — migration notes, not a cheat sheet.
- `usage-rules.md` plus `usage-rules/` (**14 files**: `actions.md`, `aggregates.md`,
  `authorization.md`, `calculations.md`, `code_interfaces.md`, `code_structure.md`,
  `data_layers.md`, `exist_expressions.md`, `generating_code.md`, `migrations.md`,
  `query_filter.md`, `querying_data.md`, `relationships.md`, `testing.md`) — rules written for AI
  agents coding against Ash.
- `documentation/topics/development/working-with-llms.md` — how to use Ash with LLMs.
- `documentation/how-to/*.livemd` — 7 executable how-to guides: `test-resources`,
  `authorize-access-to-resources`, `write-queries`, `polymorphic-relationships`,
  `encrypt-attributes`, `prevent-concurrent-writes` (`optimistic_lock`), `wrap-external-apis`.

### 11.4 Tracing / telemetry

`documentation/topics/advanced/monitoring.md` — 18 telemetry events, each emitted twice with
`:start` and `:stop` suffixes (`:17-44`):

- `[:ash, domain_short_name, :create | :update | :read | :destroy | :action | :bulk_create | :bulk_update | :bulk_destroy]`
- `[:ash, :changeset]`, `[:ash, :query]`, `[:ash, :validation]`, `[:ash, :change]`,
  `[:ash, :calculation]`, `[:ash, :before_action]`, `[:ash, :after_action]`,
  `[:ash, :preparation]`, `[:ash, :notifier]`, `[:ash, :request_step]`

Start events carry `system_time`; stop events carry `system_time` and `duration` (`:17`). There are
also 18 trace types (`:75-92`). Both resources and domains accept `trace_name`
(`documentation/dsls/DSL-Ash.Resource.md:2751`, `documentation/dsls/DSL-Ash.Domain.md:423`).
Timeouts: `execution timeout` on the domain (`documentation/dsls/DSL-Ash.Domain.md:422`) and
`timeout` on read actions (`documentation/dsls/DSL-Ash.Resource.md:1513`). Guides:
`documentation/topics/advanced/timeouts.md` and, for the `temporal` DSL section,
`documentation/topics/advanced/temporal-resources.md`.

### 11.5 Built-in data layers

`Ash.DataLayer.Simple` (the default, `lib/ash/resource.ex:25`), `Ash.DataLayer.Ets` and
`Ash.DataLayer.Mnesia` (`lib/ash/data_layer/{ets,mnesia,simple}`), with DSL references
`documentation/dsls/DSL-Ash.DataLayer.Ets.md` and `DSL-Ash.DataLayer.Mnesia.md`. SQL data layers
live in `ash_sql`/`ash_postgres` — owned by `ash-ecosystem`.

### 11.6 Testing support

`Ash.Generator` (`lib/ash/generator/generator.ex`), `Ash.Seed` (`lib/ash/seed.ex`), `Ash.Test`
(`lib/ash/test.ex`); guide `documentation/topics/development/testing.md`.

### 11.7 Ash.Reactor in core

Core ships an `Ash.Reactor` DSL (`documentation/dsls/DSL-Ash.Reactor.md`) for composing multi-step
work across actions; guides `documentation/topics/advanced/reactor.md` and
`documentation/topics/advanced/multi-step-actions.md`. A generic action's `run` accepts a Reactor
module directly (§4.1). The standalone Reactor library and its ecosystem integrations are owned by
`ash-ecosystem`.

---

## 12. Density example

The official getting-started tutorial's `Helpdesk.Support.Ticket`, assembled from its **7 verbatim
fragments**. Each block is quoted in full including its comment lines. The tutorial is incremental,
so this is a concatenation, not one contiguous listing.

**This resource uses 3 of the 14 `Ash.Resource` sections** — `attributes` (:47), `actions` (:12),
`relationships` (:33). It has no `policies`, `identities`, `aggregates`, `calculations`,
`code_interface`, `multitenancy`, `changes`, `preparations`, `validations` or `pipelines`. In the
`ash` clone itself there is no documented example resource that uses most sections — the richest
complete resources are assembled across the guide snippets cited in §2–§10. A denser **real**
resource does exist outside the clone, in the Ash book's sample app; it is quoted in §12.1 below.

```elixir
# documentation/tutorials/get-started.md:159-178
defmodule Helpdesk.Support.Ticket do
  # This turns this module into a resource
  use Ash.Resource, domain: Helpdesk.Support

  actions do
    # Use the default implementation of the :read action
    defaults [:read]

    # and a create action, which we'll customize later
    create :create
  end

  # Attributes are the simple pieces of data that exist on your resource
  attributes do
    # Add an autogenerated UUID primary key called `:id`.
    uuid_primary_key :id

    # Add a string type attribute called `:subject`
    attribute :subject, :string
  end
end
```

```elixir
# documentation/tutorials/get-started.md:236-261
attributes do
  ...
  attribute :subject, :string do
    # Don't allow `nil` values
    allow_nil? false

    # Allow this attribute to be public. By default, all attributes are private.
    public? true
  end

  # status is either `open` or `closed`. We can add more statuses later
  attribute :status, :atom do
    # Constraints allow you to provide extra rules for the value.
    # The available constraints depend on the type
    # See the documentation for each type to know what constraints are available
    # Since atoms are generally only used when we know all of the values
    # it provides a `one_of` constraint, that only allows those values
    constraints [one_of: [:open, :closed]]

    # The status defaulting to open makes sense
    default :open

    # We also don't want status to ever be `nil`
    allow_nil? false
  end
end
```
(leading `...` marks lines elided from the tutorial itself, which uses them as placeholders)

```elixir
# documentation/tutorials/get-started.md:267-274
# lib/helpdesk/support/ticket.ex

actions do
  ...
  create :open do
    accept [:subject]
  end
end
```

```elixir
# documentation/tutorials/get-started.md:317-335
# lib/helpdesk/support/ticket.ex

actions do
  ...
  update :close do
    # We don't want to accept any input here
    accept []

    validate attribute_does_not_equal(:status, :closed) do
      message "Ticket is already closed"
    end

    change set_attribute(:status, :closed)
    # A custom change could be added like so:
    #
    # change MyCustomChange
    # change {MyCustomChange, opt: :val}
  end
end
```

```elixir
# documentation/tutorials/get-started.md:476-478
use Ash.Resource,
  domain: Helpdesk.Support,
  data_layer: Ash.DataLayer.Ets
```

```elixir
# documentation/tutorials/get-started.md:561-567
relationships do
  # belongs_to means that the destination attribute is unique, meaning only one related record could exist.
  # We assume that the destination attribute is `representative_id` based
  # on the name of this relationship and that the source attribute is `representative_id`.
  # We create `representative_id` automatically.
  belongs_to :representative, Helpdesk.Support.Representative
end
```

```elixir
# documentation/tutorials/get-started.md:595-598
update :assign do
  accept [:representative_id]
end
```

### What Ash derives from that one file

Every row below is a derivation the source states explicitly. The inverse `has_many :tickets` on
`Representative` is **not** derived — the tutorial has the user declare it by hand (`:547-551`).

| Declared | Derived | Source of the derivation |
|---|---|---|
| `uuid_primary_key :id` | A `:uuid` attribute with `writable? false, public? true, primary_key? true` and a generated default. | `documentation/dsls/DSL-Ash.Resource.md:262-268` |
| `attribute :subject, :string` | The comment says only "Add a string type attribute called `:subject`". The struct field follows from the attribute; the `Ash.Query` keyword form (`contains(subject, "2")`) is used at `documentation/tutorials/get-started.md:504`. | `get-started.md:177-178`, `:504` |
| `allow_nil? false` | Omitting the input yields `** (Ash.Error.Invalid) Invalid Error / * attribute subject is required`. | `get-started.md:302-308` |
| `public? true` | The comment states it: "Allow this attribute to be public. By default, all attributes are private." | `get-started.md:242-243` |
| `constraints [one_of: [:open, :closed]]` | The comment states it supplies "a `one_of` constraint, that only allows those values". | `get-started.md:248-253` |
| `default :open` | "The status defaulting to open makes sense" — a created ticket shows `status: :open`. | `get-started.md:256`, `:294-300` |
| `create :open do accept [:subject] end` | An input schema: `for_create(:open, %{subject: "..."})` is the calling convention. | `get-started.md:285-287` |
| `defaults [:read]` | Exactly one action, `:read` — "Use the default implementation of the :read action". | `get-started.md:164-165`; `DSL-Ash.Resource.md:937` |
| `validate attribute_does_not_equal(:status, :closed) do message … end` | An `Ash.Error.Invalid` carrying "Ticket is already closed". The leaf module is `Ash.Error.Changes.InvalidAttribute` (`lib/ash/error/changes/invalid_attribute.ex`). | `get-started.md:325-327`, `:379-383` |
| `change set_attribute(:status, :closed)` | A forced attribute change; the tutorial shows `status: :closed` after the update. | `get-started.md:329`, `:356-363` |
| `belongs_to :representative, Helpdesk.Support.Representative` | "We create `representative_id` automatically" — a `:uuid` attribute via `define_attribute?` (default `true`). | `get-started.md:566`; `DSL-Ash.Resource.md:787` |
| `update :assign do accept [:representative_id] end` | An update pipeline writing only the FK, driven with `for_update(:assign, %{representative_id: …})`. | `get-started.md:595-598`, `:632-634` |
| `data_layer: Ash.DataLayer.Ets` | Persistence: the tutorial drops its `Ash.DataLayer.Simple.set_data/2` calls and reads the tickets back. | `get-started.md:476-478`, `:489-505` |
| The file as a whole | Compile-time errors when a resource is missing from the domain or a `belongs_to` is absent. | `get-started.md:581` |

### 12.1 A dense real resource: `Tunez.Music.Album`

From the Ash book's sample app Tunez (Rebecca Le, `sevenseacat/tunez`), file
`lib/tunez/music/album.ex` on branch `end-of-chapter-10`, commit
`5ea6daeac0d8634bca22cddd3fc7331f6391f3c3`:
<https://github.com/sevenseacat/tunez/blob/end-of-chapter-10/lib/tunez/music/album.ex>.
The file is 146 lines. The branch's `mix.lock` pins **ash 3.12.0** — older than the 3.33.11 clone
the rest of this document cites (fetched 2026-10-01; the `main` branch is the starter app and has
no `album.ex`, hence the branch pin). Quoted verbatim, **abridged** — each omission is named inline:
the `json_api` and `postgres` extension sections, two `attribute` blocks, the `validations`
section, and the `def next_year` helper at `album.ex:88` that its `numericality` validation calls.
Nothing else is removed.

```elixir
defmodule Tunez.Music.Album do
  use Ash.Resource,
    otp_app: :tunez,
    domain: Tunez.Music,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshGraphql.Resource, AshJsonApi.Resource],
    authorizers: [Ash.Policy.Authorizer]

  graphql do
    type :album
  end

  # (abridged: the `json_api` and `postgres` extension sections are omitted)

  actions do
    defaults [:read]

    create :create do
      accept [:name, :year_released, :cover_image_url, :artist_id]
      argument :tracks, {:array, :map}
      change manage_relationship(:tracks, type: :direct_control, order_is_key: :order)
    end

    update :update do
      accept [:name, :year_released, :cover_image_url]
      require_atomic? false
      argument :tracks, {:array, :map}
      change manage_relationship(:tracks, type: :direct_control, order_is_key: :order)
    end

    destroy :destroy do
      primary? true

      change cascade_destroy(:notifications, return_notifications?: true, after_action?: false)
    end
  end

  policies do
    bypass actor_attribute_equals(:role, :admin) do
      authorize_if always()
    end

    policy action(:create) do
      authorize_if actor_attribute_equals(:role, :editor)
    end

    policy action_type([:update, :destroy]) do
      authorize_if expr(can_manage_album?)
    end

    policy action_type(:read) do
      authorize_if always()
    end
  end

  changes do
    change Tunez.Accounts.Changes.SendNewAlbumNotifications, on: [:create]

    change relate_actor(:created_by, allow_nil?: true), on: [:create]
    change relate_actor(:updated_by, allow_nil?: true)
  end

  # (abridged: `validations` — `numericality(:year_released, ...)` and
  # `match(:cover_image_url, ...)`, both with `where:` and `message:` — omitted)

  # (abridged: `def next_year, do: Date.utc_today().year + 1` (album.ex:88) is omitted)

  attributes do
    uuid_primary_key :id

    attribute :name, :string do
      allow_nil? false
      public? true
    end

    # (abridged: the `:year_released` and `:cover_image_url` attribute blocks are omitted)

    create_timestamp :inserted_at
    update_timestamp :updated_at
  end

  relationships do
    belongs_to :artist, Tunez.Music.Artist do
      allow_nil? false
    end

    has_many :tracks, Tunez.Music.Track do
      sort order: :asc
      public? true
    end

    has_many :notifications, Tunez.Accounts.Notification

    belongs_to :created_by, Tunez.Accounts.User
    belongs_to :updated_by, Tunez.Accounts.User
  end

  calculations do
    calculate :duration, :string, Tunez.Music.Calculations.SecondsToMinutes

    calculate :can_manage_album?,
              :boolean,
              expr(
                ^actor(:role) == :admin or
                  (^actor(:role) == :editor and created_by_id == ^actor(:id))
              )
  end

  aggregates do
    sum :duration_seconds, :tracks, :duration_seconds
  end

  identities do
    identity :unique_album_names_per_artist, [:name, :artist_id],
      message: "already exists for this artist"
  end
end
```

**Sections used: 8 of the 14** `Ash.Resource` sections — `actions`, `changes`, `validations`,
`attributes`, `relationships`, `calculations`, `aggregates`, `identities` — plus `policies` (from
the `Ash.Policy.Authorizer` extension) and 3 extension sections (`graphql`, `json_api`, `postgres`).

**The code interface is declared on the domain, not the resource.** Same branch,
`lib/tunez/music.ex:68-73` (verbatim):

```elixir
    resource Tunez.Music.Album do
      define :create_album, action: :create
      define :get_album_by_id, action: :read, get_by: :id
      define :update_album, action: :update
      define :destroy_album, action: :destroy
    end
```

**What Ash derives from it:**

| Declared | Derived | Source of the derivation |
|---|---|---|
| `uuid_primary_key :id` | A `:uuid` attribute with `writable? false, public? true, primary_key? true` and a generated default. | `documentation/dsls/DSL-Ash.Resource.md:262-268` |
| `create_timestamp :inserted_at`, `update_timestamp :updated_at` | Two `:utc_datetime_usec` attributes with `writable? false, match_other_defaults? true, allow_nil? false`. | `DSL-Ash.Resource.md:125-131` |
| `belongs_to :artist, Tunez.Music.Artist` | An `:artist_id` attribute on Album (`define_attribute?` defaults to `true`). | `DSL-Ash.Resource.md:787` |
| `argument :tracks, {:array, :map}` + `change manage_relationship(:tracks, type: :direct_control, order_is_key: :order)` | Create/update take nested track input and diff it against the existing records. | `lib/ash/resource/change/builtins.ex:305`; `lib/ash/changeset/changeset.ex:5734` |
| `change relate_actor(:created_by, allow_nil?: true), on: [:create]` | `created_by` is set from the actor on create. | `lib/ash/resource/change/builtins.ex:34` |
| `change cascade_destroy(:notifications, ...)` in `destroy` | Destroying an album destroys its notifications. | `lib/ash/resource/change/builtins.ex:407` |
| `identity :unique_album_names_per_artist, [:name, :artist_id], message: ...` | A unique constraint over name+artist with a custom error message. | `DSL-Ash.Resource.md:2785-2833` |
| `aggregates: sum :duration_seconds, :tracks, :duration_seconds` | A named aggregate, loadable by name, summing across the `tracks` relationship. | `DSL-Ash.Resource.md:3253`, `:3616` |
| `calculate :can_manage_album?, :boolean, expr(...)` | A derived boolean the `policies` block then uses in `authorize_if expr(can_manage_album?)`. | `DSL-Ash.Resource.md:4147`; `policies` excerpt above |
| `define :get_album_by_id, action: :read, get_by: :id` on the domain | The five code-interface function kinds (`:subject, :can, :can?, :action, :action!`) generated on `Tunez.Music`. | `documentation/dsls/DSL-Ash.Domain.md:107-291`; `DSL-Ash.Resource.md:2478` |

The runner-up inside the `ash` clone is `test/support/policy_complex/resources/post.ex` (120
lines), but it is test scaffolding, not a documented example.

---

## 13. Coverage against the Mesh plan

Plan: `notes/Ash-style Resource Framework on MX + TypeScript Implementation Plan.md` (204 lines).
Factual mapping only.

| # | Ash feature group (this doc) | Plan mentions it? | Quoted plan line / evidence |
|---|---|---|---|
| 1 | Resource anatomy, `Ash.Domain` | **mentioned** | `\| Ash.Resource + DSL sections \| resource tag + child tags \|` (plan:141); `\| Domain \| domain attribute, one generated domain module \|` (plan:142). Section names not enumerated. |
| 2 | Attributes, types, constraints, `NewType`, embedded resources, enums, defaults, `allow_nil?`, `public?`, `sensitive?`, `writable?`, generated values, timestamps, primary keys | **partial** | `\| Attributes, types, constraints \| attribute tags \|` (plan:143); dialect uses `uuid-primary-key`, `required`, `public`, `type="string"`, `type="enum" values=[...] default="draft"`, `timestamps` (plan:42-46). **Not:** `NewType`, embedded resources, `sensitive?`, `writable?`, `generated?`, `update_default`. |
| 3 | Relationships (4 kinds, `through`, `manage_relationship`, manual) | **partial** | `\| Relationships \| belongs-to, has-many, has-one, many-to-many \| IR linking + Drizzle relations \|` (plan:144). **Not:** `through`/join resources, `manage_relationship`, manual, per-relationship options. |
| 4 | Actions (5 types, `accept`, arguments, `primary?`, changes/validations/preparations, hooks, upserts, bulk, atomic, manual, pagination, transactions, soft destroy) | **partial** | `\| Actions (create, read, update, destroy, generic) \| Action tags \|` (plan:145) — generic actions **are** named. `\| Changes, validations \| change, validate callbacks \|` (plan:146). Hooks and transactions **are** named: "after-hooks, transaction boundary" (plan:118), "Call the data layer inside a transaction" (plan:132). **Not:** argument entities, `primary?`, preparations, upserts, bulk, `require_atomic?`, manual, pagination config, transaction *config*, soft destroy. |
| 5 | Query features | **partial** | `\| expr \| Translatable arrow functions \| TS AST to SQL compiler \|` (plan:147); `\| Calculations, aggregates \| calculate, count, sum, ... \|` (plan:149); `read="published" filter=… sort=["-insertedAt"]` and `count="commentCount" relationship="comments"` (plan:62-64, :81); "filters, sorting, pagination, aggregates" (plan:120). **Not:** `distinct`, the operator/function list, expression templates. |
| 6 | Policies (bypass, groups, checks, field policies, `Ash.can?`, access types) | **partial** | `\| Policies \| policies block \| Filter for reads, check for writes \|` (plan:148); dialect has `policy action-type="read"` and `policy action="publish"` with `authorize-if` (plan:66-72). **Not:** `bypass`, `policy_group`, field policies, the check catalogue, `Ash.can?`, `access_type`, `error_message`, `authorize_with: :error`. |
| 7 | Multitenancy | **mentioned, deferred** | "- [ ] Multi-tenancy: in v1 IR or deferred to an extension?" (plan:190); "Extensions like AshStateMachine, AshPaperTrail or multi-tenancy come after the core proves itself" (plan:26). Named but explicitly out of v1; no strategy names. |
| 8 | Code interfaces, `Ash.Changeset`/`Ash.Query`/`Ash.ActionInput`, `Ash.*` | **partial** | `\| Ash.Changeset / Ash.Query \| Typed builders on generated code \| Codegen \|` (plan:154); `core` row describes the pipeline (plan:118). **Not:** `code_interface`/`define`/`define_calculation`, the five generated function kinds, `Ash.ActionInput`, the `Ash.*` list. |
| 9 | Identities, resource-level validations, notifiers, pub_sub | **partial** | `\| Notifiers, PubSub \| notifier \| Post-commit events \|` (plan:152); step 6 "Emit notifications after commit" (plan:133); a `notifier` runtime package (plan:124). **Not:** `identities` (no `identity` tag in the plan), or the `changes`/`preparations`/`validations`/`pipelines` sections. |
| 10 | Error classes and shape | **mentioned as DX, not as classes** | "**Errors name the fix.**" (plan:168); "errors point at the `.mx` source line" (plan:17). **Not:** the four runtime classes, `bread_crumbs`, `error_handler`, `authorize_with: :error`. |
| 11 | Tooling: mix tasks, generators, formatter, cheat sheets, telemetry | **partial** | "a build-time tool (`<cli> build`, `<cli> watch`)" (plan:93); "Drizzle schema + SQL migrations" (plan:103); "`<cli> inspect` dumps the IR as JSON" (plan:171); "A maintained `SKILL.md` and an MCP server" (plan:172). **Not:** `mix ash.*` tasks, Igniter generators, formatter config, `usage-rules`, `trace_name`, the 18 telemetry events. |
| 12 | (density) one resource using most sections | **mentioned as a goal** | "Reproduce Ash's density: one resource file declares attributes, relationships, actions, policies and calculations" (plan:13); "**One resource, one file.**" (plan:166). The plan's own example uses 6 blocks (plan:41-81) — 5 of the 14 `Ash.Resource` sections; `policies` is not one of them. |

---

## Open questions

1. **`managing-relationship` guide depth.** The `type:` values are read from
   `lib/ash/changeset/changeset.ex:5697-5743`; the full option list per type lives in
   `documentation/topics/resources/relationships.md`, which I did not read.
2. **`custom_expression` generator and `Ash.CustomExpression`** are named but their callback set is
   only summarised (`documentation/topics/reference/expressions.md:200-215`).
3. **Combination queries.** Named from `lib/ash/query/query.ex` function names plus the guide's
   existence; I did not read the guide.
4. **Web sources.** Only one was needed: the Tunez sample app for §12.1. Everything else is a local
   `path:line` from ash 3.33.11 (and splode 0.3.2 for §10.1).

---

## Implications for Mesh (researcher's analysis)

1. **The closed vocabulary is the asset, and this review proved it.** The lists failed in three
   different ways, and the failure mode mattered: the **types** list came from a *file listing*
   instead of the registered set; the changes, preparations and checks lists came from
   `grep '  def '`, which silently misses `defmacro`; the expression-function list came from the
   guide instead of `filter.ex:76-116`. In every case Ash keeps the authoritative list in one
   place — `@builtin_short_names` in `registry.ex:8-40`, the `add_expression_function/3` calls in
   `filter.ex` — and docs, generators and errors all derive from it. Mesh should do the same: one
   registry per vocabulary, read by the compiler, the docs generator and the error messages. A
   list in prose is a liability; a list in a data file is an asset. The tooling lesson generalises:
   a generator that reads the registry, not a human reading a directory.
2. **Registered vs documented is where DX is lost.** 39 registered expression functions vs ~30
   documented; 22 policy checks vs 21 obvious ones. The plan already has the slot: the
   machine-readable IR plus `<cli> inspect`. A `<cli> list-checks` printing exactly what the
   compiler accepts, with no prose drift, is the cheap fix.
3. **`Ash.Scope` is a small idea with large leverage.** Bundling `{actor, authorize?, tenant,
   context}` into one value gives those four a single place to live, and makes "how was this call
   authorized?" answerable in one place. Note what it is *not*: the options are not removed — "the
   `actor`, `tenant` and `context` options will always remain available"
   (`lib/ash/scope.ex:7-9`), and explicit options override values taken from the scope. It is an
   alternative way to pass the same values, not a replacement. The plan has no equivalent; generated
   handlers would otherwise thread actor/tenant by hand.
4. **Access types (`:strict`/`:filter`/`:runtime`) are the most transferable idea here.** They
   separate "must be checked before the DB call" from "may be a SQL filter" — the same split the
   plan already has as "translatable" vs "opaque" expressions. Wiring `access_type` into that split
   is nearly free and prevents the silent in-memory fallback the plan forbids (plan:89).
5. **Error classes map 1:1 onto HTTP status codes.** Naming the four up front means the OpenAPI
   generator and `api-http` need no per-error special-casing.
6. **Everything opt-in is load-bearing.** The authorizer is opt-in via `authorizers:`; the data
   layer defaults to `Ash.DataLayer.Simple`; `simple_notifiers` exists to avoid compile-time
   dependencies. A resource that declares nothing still works. Mesh's tag set should behave the
   same: an empty resource compiles and runs.
7. **Density, measured honestly.** The clone's tutorial uses 3 of 14 sections; the book's sample
   app reaches 8 (§12.1); the plan's own uses 5. "Full Ash parity in v1" (plan:26) is consistent
   with that — but so is naming those 5 as the explicit v1 target instead of leaving it to the
   mapping table.
8. **`usage-rules/` is the cheapest lesson in agent legibility.** 14 files of prose rules shipped
   in the framework, written for exactly the plan's audience. It costs almost nothing and matches
   the plan's existing "Skill file ships with the framework" principle (plan:172).

## Revision log (round 2)

| Review finding | Fix |
|---|---|
| Summary says "10 sections" | 14; `resource` = "holds only options, no entities". |
| Built-in counts wrong (macros missed by `grep '  def '`) | Recounted from `def`+`defmacro`: **24 changes**, 24 validations, **4 preparations**, **22 checks**. Added `update_change`, the 4 hook macros, `before_action`/`after_action` preparations, `matches`. |
| Fake "two private `def atomic/3`" | Deleted; those lines are `@doc` example code. |
| "multitenancy on every action" | Not on generic `action`; the 4 types that have it are listed. |
| "6 templates" | **5**; added `^tenant()` (`lib/ash/expr/expr.ex:106`); `parent/1`/`path.exists/2` demoted to sub-expressions. |
| "~30 expression functions" | Replaced by the **39** registered at `lib/ash/filter/filter.ex:76-116`; added `+` and the operator aliases; guide stated to be a subset. |
| "~110 error modules" | **91** leaves (99 files − 8 top-level). |
| Splode never mentioned | Added §10.1 with the `use Splode` declaration (`lib/ash/error/error.ex:9-18`). |
| Error-shape citation unsupported | Replaced; Splode's field list marked `[unverified]`. |
| "13 mix tasks / no generators" | **25**: 14 + 9 `ash.gen.*` + `ash.install` + `ash.patch.extend`; module is `ash.generate_policy_charts`. |
| Summary contradicted §13 | Summary now matches rows 4 and 7 (generic actions and multitenancy are named by the plan). |
| `changes` purpose wrong | Rewritten to the source text (all create/update/destroy). |
| `preparations` purpose wrong | Rewritten to the source text (all read actions). |
| Argument options wrong | `type` is positional; real 6 options listed; no `doc`. |
| `bypass` had 2 check entities | All four listed with line numbers. |
| Type list was a file listing | Replaced with the **31** `registry.ex:8-40` short names; helper modules dropped; `{:array, t}` and custom types added. |
| "not plain atoms" + `Ash.Type.TypedStruct` | They *are* atom short names; renamed to `Ash.TypedStruct`. |
| `public?` cited at :96 | `:98`. |
| PK/timestamp derived options | Per-entity table; only `integer_primary_key` sets `generated?`. |
| "relationship options are the same set" | 4-column presence matrix. |
| `defaults [:read]` = "four actions" | It names which actions to create; `[:read]` creates one. |
| Shared action options at :933-940 | Split into shared-by-4, shared-by-5, generic-only. |
| Lifecycle hooks list wrong | Split into the 6 DSL macros (the user path) and the changeset runners; noted `Ash.Query` has no `around_action`. |
| `atomic_upgrade_with` vs `atomic_upgrade?` | Corrected. |
| Policy options "made up" | Replaced with the real 4 (`authorizer.ex:166-202`); invented `target_action` reference removed. |
| No-policy default `[unverified]` | Settled: **forbidden**, via `lib/ash/policy/policy.ex:81,97,85-86`; authorizer is opt-in. |
| `can?` subject citation | Re-pointed to `lib/ash.ex:1840` + its spec. |
| `Ash.Changeset` list had non-existent/internals | Rebuilt from real `def` lines; dropped `get_result`, `run_atomic_conditions`, `change`, `inspect`; `@doc false` internals marked. |
| `Ash.Query` list wrong | `loading?`/`set_authorize?` fixed; 11 missing functions added. |
| Density: 4 unsupported "derived" rows | Removed (code-interface functions, `Ash.Error.Invalid.InvalidAttribute` → `Ash.Error.Changes.InvalidAttribute`, derived inverse `has_many`, "unknown action references"). Every row now names a source. |
| Density example uses 3 of 14 | Stated in the section header; noted no official example in the clone uses most sections. |
| 6 examples silently trimmed | All restored verbatim with comment lines; exact line ranges given. |
| 44% wrong-line citations | All re-derived; the review's 24 listed offsets each checked and applied. |
| §13 row 4 said hooks/transactions not mentioned | Corrected; plan:118 and plan:132 quoted. |
| §13 row 11 only quoted migrations | Added plan:93, :107, :171, :172. |
| "plan example covers 7 of 14" | Corrected to 6 blocks / 5 sections. |
| Omissions (review §7) | Added: data layers + `use` options (§1.1, §11.5), access types (§6.2), `error_message`/breakdowns/`can_read`/`authorize_read_with` (§6.5-6.6), actors and `Ash.Scope` (§6.9), custom behaviours (§2.5), pub_sub DSL (§9), telemetry events (§11.4), `usage-rules` (§11.3), testing (§11.6), bulk strategies (§4.8), aggregate per-kind options (§5.2), field-policy options (§6.1), pipelines (§1.1), `manage_relationship` options + example (§3.4), `Ash.Query` example + combination queries + `Ash.ActionInput` (§5, §8.4), `NewType`/`Enum` callbacks (§2.1). |
| Word count | The document was 8,419 words by `wc -w` after this pass (round-2 review measurement) — above the 6,000-word target in `_rules.md`. Round 1 was 6,544 and round 2 initially ballooned to 9,100 once the omissions were added; the prose was compressed to absorb them. Corrected to the real number in round 3 (see below). |

### Round 3

| Review finding (round 2 re-verification) | Fix |
|---|---|
| §4.1 "Shared by create/read/update/destroy only" wrong: read has none of `accept`/`notifiers`/`manual?` etc. | Split into four lists: create/update/destroy only; create/read/update/destroy (`multitenancy`, `skip_global_validations?`); create/update/destroy/generic-action (`error_handler`); all five. Read's full 13-option list added (`DSL-Ash.Resource.md:1509-1521`). |
| `error_handler` in two contradictory lists | Listed once: shared by create, update, destroy and generic `action` (`:1234`, `:988`); not on read. |
| §4.6 hook example uncited, wrong arities | Replaced with verbatim examples from `lib/ash/resource/change/builtins.ex:460-464`, `:517-522` and the four one-line heads at `:544`, `:487`, `preparation/builtins.ex:51`, `:76`, each cited. |
| `Ash.Resource.Calculation.batch/2` invented | Real callbacks listed: `init/1`, `describe/1`, `calculate/3`, `expression/2`, `load/3`, `strict_loads?/0`, `has_expression?/0` (`calculation.ex:209-222`). |
| `Ash.Resource.ManualRelationship` callback wrong | Real callbacks: `load/3`, `select/1` (`manual_relationship.ex:35-37`). |
| `Ash.for_action/4` does not exist | `Ash.ActionInput.for_action/4` (`lib/ash/action_input.ex:253`). |
| §8.2 list held 12 `@doc false` functions, missed 18 public ones | Rebuilt from `lib/ash/changeset/changeset.ex`: 12 internals removed (named as `@doc false`), 18 public functions added (`change_attribute(s)`, `force_change_attribute(s)`, `change_default_attribute`, `clear_change`, `set_arguments`, `force_set_arguments`, `delete_argument`, `force_set_argument`, `add_error`, `handle_errors`, `filter`, and the 6 hook functions). §4.9's atomic helpers marked `@doc false` too. |
| Pipeline quote cited at `:3049-3050` | Real text "Pipeline entities are prepended before the action's own changes/preparations." at `DSL-Ash.Resource.md:1134`. |
| `field` on aggregates | `count` does have `field` (`:3344`); exception is only `exists`. All per-kind line numbers re-derived (:3342-:4091). |
| §2.5 incomplete | `Validation`: added `atomic/3`, `batch_validate/3` (`validation.ex:77`, `:99`); `CustomExpression`: added `name/0`, `arguments/0` (`custom_expression.ex:99-101`). |
| 16 operators | 15 registered operator modules: 8 at `filter.ex:120-129` + 7 `Basic` symbols; `and`/`or` are boolean expressions; aliases at `:135-142`. |
| `Ash.Scope` "every call" unsourced | Rewritten from `lib/ash/scope.ex:5-12`, `:55-61`: user implements `Ash.Scope.ToOpts` for their struct. |
| `[unverified]` Splode fields | Settled: `defexception` fields `splode, bread_crumbs, vars, path, stacktrace, class` (`splode/lib/splode/error.ex:112-120`, reserved `:94`), classes add `errors: []` (`error_class.ex:11`); splode 0.3.2 (`mix.exs:8`, ash `mix.lock:53`). |
| `[unverified]` GenServer usage | Settled: ETS `TableManager` (`ets.ex:76-78`, `:101`), `Ash.TypeResolver` (`type_resolver.ex:7`, `:17`); async limiter is an `Agent` (`async_limiter.ex:16`). |
| "No official example uses most sections" `[unverified]` | Settled: added §12.1 `Tunez.Music.Album` (branch `end-of-chapter-10`, commit `5ea6dae`, pins ash 3.12.0): 146 lines, quoted verbatim-abridged, 8 of 14 sections, code interface on the domain (`music.ex:68-73`), derivation table with sources. Claim qualified to the `ash` clone. |
| Missing omissions | Added §11.7 Ash.Reactor in core; timeouts and temporal-resources guides (§11.4); how-to count 4 → **7** with names. |
| Low line drift (~30 citations) | All applied after re-checking against source: relationship matrix, `require_atomic?` :2148, `accept` :1864/:2157, update `manual` :1853, multitenancy option lines, `defaults` :937, registry short names (:16/:19/:21/:36/:39, custom :44), `embedded-resources.md:81`, `expr.ex:103-131`, field-policy :387/:389/:392, `policies.md:231-234`/`:271-295`, `get-started.md` query example :503-505, DSL header :2, §13 plan lines (13, 42-46, 62-64, 81, 66-72, 103, 118, 120, 124, 148, 149, 154, 166, 168), Implications plan:89/:26. |
| Copy fidelity | Restored blank lines in the policies example (now cited `:159-178`) and the pub_sub example; split the merged `attributes do` / `...` line in §12. |
| Word count "~5,900" | Real `wc -w` was 8,419 at round-2 close; after this round's additions it is 10,020. Reported as-is per the review ("either cut or report the real number"); the round-2 cell was corrected too. |

### Round 4

| Review finding (round 3 final check, "Residual errors") | Fix |
|---|---|
| 1. §4.1 `defaults` cited at `:936` | `:937` (`:936` is a table separator). |
| 2. §3.4 `manage_relationship_schema/2` | Arity 0, `@doc false` (`changeset.ex:6010`); §3.4 and the §8.2 internals list updated. |
| 3. §4.9 "only `fully_atomic_changeset/4` is public" | Scoped to "among the atomic-execution helpers named here"; added the other public atomic functions `atomic_defaults` (`:895`), `atomic_ref` (`:1703`), `atomic_update` (`:2417`), `atomic_set` (`:2607`). |
| 4. §8.2 `atomic_condition` listed as public | `@doc false` (`:1732`); moved to the internals list. |
| 5. §8.2 `temporal_recorded_at` listed as public | `@doc false` (`:4304`); moved to the internals list. |
| 6. §8.2 `fetch_argument_or_change` cited at `:5544` | `:5559`; `:5544` is `fetch_argument_or_attribute`. |
| 7. §8.2 `filter` cited at `:7836` | `:7832`. |
| 8. §8.2 five public functions missing | Added `apply_attributes/2` (`:7758`), `fetch_argument_or_attribute/2` (`:5544`), `force_change_new_attribute/3` (`:6896`), `force_change_new_attribute_lazy/3` (`:6910`), `force_delete_argument/2` (`:6862`). |
| 9. §8.3 `exists/3`, `exists?/3` | Arity 1-2, `exists(query, opts \\ [])` (`lib/ash.ex:1329`, `:1299`); written `exists/2`, `exists?/2`. |
| 10. §8.3 `aggregate/4` | Arity 2-3 (`:1193`); written `aggregate/3`. |
| 11. §8.3 `run_action/3` | Arity 1-2 (`:2299`); written `run_action/2`. |
| 12. §8.3 `data_layer_query/3`, `pkey_filter/3` | `data_layer_query/2` (`:3086`), `pkey_filter/2` taking `(records, pkey)` (`:4642`); optional-`opts` note added. |
| 13. §5 `combination_hydration_context/2` | Arity 1 (`lib/ash/query/query.ex:564`); `combination_of/2` unchanged. |
| 14. §12.1 Tunez quote omitted `def next_year` unmarked | Marked inline in the quote and named in the abridgement list (`album.ex:88`); "and nothing else" replaced with "Nothing else is removed." |
| 15. Analysis: `Ash.Scope` "removes four options" | Corrected: the `actor`/`tenant`/`context` options "will always remain available" and explicit options override the scope (`lib/ash/scope.ex:7-9`); it is an alternative, not a replacement. |
| 16. Analysis: "all six wrong lists failed the same way" | Corrected: three distinct causes — file listing (types), `grep '  def '` missing `defmacro` (changes/preparations/checks), guide instead of `filter.ex:76-116` (expression functions). |
| Word count | 10,216 by `wc -w` after the 16 fixes, 10,569 with this log entry (the round-3 figure of 10,020 was correct at its close). Still above the 6,000 target in `_rules.md`; reported as-is. |

## Sources

**Web:**

- `Tunez.Music.Album`, `sevenseacat/tunez`, branch `end-of-chapter-10`, commit
  `5ea6daeac0d8634bca22cddd3fc7331f6391f3c3` (pins ash 3.12.0), fetched 2026-10-01:
  <https://github.com/sevenseacat/tunez/blob/end-of-chapter-10/lib/tunez/music/album.ex> and
  `lib/tunez/music.ex:68-73` on the same branch. Used only in §12.1.

**Local (all under `scratch/ash-src/`):**

- `ash/` (3.33.11): `documentation/dsls/DSL-Ash.Resource.md`, `DSL-Ash.Domain.md`,
  `DSL-Ash.Policy.Authorizer.md`, `DSL-Ash.Notifier.PubSub.md`, `DSL-Ash.TypedStruct.md`,
  `DSL-Ash.Reactor.md`; `documentation/tutorials/get-started.md`;
  `documentation/topics/` (`security/policies.md`, `security/actors-and-authorization.md`,
  `security/sensitive-data.md`, `advanced/multitenancy.md`, `advanced/monitoring.md`,
  `advanced/combination-queries.md`, `advanced/timeouts.md`, `advanced/temporal-resources.md`,
  `advanced/reactor.md`, `reference/expressions.md`, `resources/*.md`,
  `development/generators.md`, `development/testing.md`); `documentation/how-to/` (7 files);
  `usage-rules.md`, `usage-rules/` (14 files);
  `lib/ash.ex`, `lib/ash/resource.ex`, `lib/ash/scope.ex`, `lib/ash/action_input.ex`,
  `lib/ash/changeset/changeset.ex`, `lib/ash/query/query.ex`,
  `lib/ash/resource/{change,preparation,validation}/builtins.ex`,
  `lib/ash/resource/{change/change.ex,preparation/preparation.ex,validation.ex}`,
  `lib/ash/resource/calculation/calculation.ex`,
  `lib/ash/resource/manual_relationship/manual_relationship.ex`,
  `lib/ash/policy/{authorizer/authorizer.ex,policy.ex,check/built_in_checks.ex}`,
  `lib/ash/filter/filter.ex`, `lib/ash/query/operator/basic.ex`, `lib/ash/expr/expr.ex`,
  `lib/ash/type/registry.ex`, `lib/ash/type/{new_type.ex,enum.ex}`, `lib/ash/typed_struct.ex`,
  `lib/ash/error/` (99 files), `lib/ash/data_layer/{ets,mnesia,simple}`,
  `lib/ash/type_resolver.ex`, `lib/ash/actions/read/async_limiter.ex`,
  `lib/mix/tasks/` (25 tasks), `.formatter.exs`, `mix.exs`, `mix.lock`.
- `splode/` (0.3.2): `lib/splode/error.ex`, `lib/splode/error_class.ex`, `mix.exs`.
- `notes/Ash-style Resource Framework on MX + TypeScript Implementation Plan.md` (the Mesh plan, §13).

---
title: "Review: Ash core feature inventory"
description: "Independent fact-check of the Ash core feature inventory document; final verdict ACCEPT-WITH-FIXES."
---

# Review: ash-features ([`notes/research/01-ash-features.md`](../ash-features.md))

> Review of: [Ash core feature inventory](../ash-features.md).

VERDICT: ACCEPT-WITH-FIXES


Reviewer: independent fact-check against `scratch/ash-src/ash` (3.33.11, `mix.exs:13` `@version "3.33.11"`).
All paths below are relative to `scratch/ash-src/ash/` unless they start with `notes/`.

The verdict is revise and resubmit. The structure is good and most section and entity names are
right. But the document calls itself a "complete" inventory, and six of its "complete" lists have
the wrong count:
- changes, preparations, policy checks and mix tasks are each missing items;
- the expression function list is missing about 15 registered functions;
- the type list mixes in helper modules and a module name that does not exist.

Other problems:
- One headline claim is false: "no generators". The generators guide that the document itself cites lists 8 `ash.gen.*` tasks.
- 4 of the 13 Summary bullets are wrong and 2 more are partly wrong.
- The density "derived" table contains derivations that are made up.
- 44% of sampled citations point at the wrong line, and 17% do not support the claim.

---

## 1. Error table

Line = line in [`notes/research/01-ash-features.md`](../ash-features.md).

| Doc line | Claim | What the source says | Severity |
|---|---|---|---|
| 20 | "It has **10 top-level sections**" | It then lists 14, and there are 14 `##` headings (`documentation/dsls/DSL-Ash.Resource.md:8,342,854,2403,2726,2765,2841,2913,2976,3048,3253,4147,4310,4349`). Fix it to 14. | medium |
| 23 | "`resource` is the config section, not a block" | It is a block: `resource do … end` (`DSL-Ash.Resource.md:2734`). Say "holds only options, no entities". | low |
| 35-37, 294, 324 | "19 built-in changes … 2 built-in preparations, 21 built-in policy checks", "all 19 public functions", "(complete)" | `lib/ash/resource/change/builtins.ex` also exports 5 public macros: `update_change` (:102), `after_action` (:466), `after_transaction` (:496), `before_action` (:523), `before_transaction` (:550). That makes 24. `preparation/builtins.ex` also has `before_action` (:57) and `after_action` (:82), which makes 4. `policy/check/built_in_checks.ex` also has `matches/2` (:422), which makes 22. `grep -c '  def '` misses `defmacro`. | high |
| 301-302 | "two private `def atomic/3` helpers at lines 191 and 197 … not user-facing" | Those lines are example code inside the `atomic_set` `@doc` string (`change/builtins.ex:185-200`). They are not functions. Delete the sentence. | low |
| 41-43, 563 | multitenancy overrides "on every action type" / "Every action … has a `multitenancy` option" | Generic `action` has no `multitenancy` option. Its options are `returns, constraints, allow_nil?, run, error_handler, primary?, description, transaction?, touches_resources, skip_unknown_inputs, public?` (`DSL-Ash.Resource.md:979-994`). Create, read, update, destroy, calculations and aggregates do have it. | medium |
| 46-48, 443-456 | "6 templates (`^actor`, `^arg`, `^context`, `^ref`, plus `parent/1` and `path.exists/2`)" | The guide documents 4 templates (`documentation/topics/reference/expressions.md:190-197`). `path.exists/2` is a sub-expression (`:117`), not a template. The source also has a 5th template, `^tenant()` (`lib/ash/expr/expr.ex:106`, expanded at `:277`), which the document does not mention. | medium |
| 46, 426-435 | "~30 functions", presented as the function list | `lib/ash/filter/filter.ex:76-116` registers 39 functions. Missing from the doc: `composite_type`, `count_nils`, `has`, `intersects`, `is_distinct_from`, `is_not_distinct_from`, `minus`, `rem`, `range_adjacent`, `range_contains`, `range_lower`, `range_overlaps`, `range_upper`, `string_starts_with`, `string_ends_with`. The operator list leaves out `+` (`lib/ash/query/operator/basic.ex:10`). Say the guide's list is a subset of the registered list. | medium |
| 51, 676 | "~110 error modules" / "About 110" | `lib/ash/error/**` has 99 `.ex` files. 8 of them are top-level (`error.ex, error_kind.ex, exception.ex, stacktrace.ex, invalid.ex, forbidden.ex, framework.ex, unknown.ex`), so there are **91 leaf modules**. | medium |
| 51-52, 664 | The four classes come from `to_error_class` at `error.ex:78-96` | The classes are declared with `use Splode, error_classes: [forbidden:, invalid:, framework:, unknown:]` at `lib/ash/error/error.ex:9-18`. The doc never says Ash errors are built on the Splode library, which is the main fact about how errors are shaped. | medium |
| 53-55, 715-723 | "Only **13 mix tasks** … there is no `lib/mix/generators` … generation lives in the Igniter-based code" | The doc lists 14 names under "13". It also misses `lib/mix/tasks/gen/`, which holds 9 generator tasks: `ash.gen.base_resource, ash.gen.change, ash.gen.custom_expression, ash.gen.domain, ash.gen.enum, ash.gen.gettext, ash.gen.preparation, ash.gen.resource, ash.gen.validation`. It also misses `lib/mix/tasks/install/ash.install.ex` and `lib/mix/tasks/patch/ash.patch.extend.ex`. Total: **25 tasks**. The generators guide the doc cites lists them (`documentation/topics/development/generators.md:47-54`, sections `## Installer` :13, `## Generators` :45, `## Patchers` :56). Also, `ash.generate_policy_chart` is really `ash.generate_policy_charts` (module `Mix.Tasks.Ash.GeneratePolicyCharts`). | **high** |
| 56-58 | Summary: the plan does not name "multitenancy … generics" | The plan names both: generic actions at plan:145 ("Actions (create, read, update, destroy, generic)") and plan:189; multi-tenancy at plan:26 and plan:190. The doc's own §13 row 7 says multitenancy is "mentioned only as an open question", so the Summary contradicts it. | medium |
| 78 | `changes`: "Declares reusable named change modules, called by `change` entities" | Wrong. The section declares changes applied to **all** create/update/destroy actions: "Declare changes that occur on create/update/destroy actions against the resource" (`DSL-Ash.Resource.md:2842`). Changes are not named or reusable; that is what `pipelines` does. | **high** |
| 79 | `preparations`: "reusable named preparation modules" | Wrong. "Declare preparations that occur on all read actions for a given resource" (`DSL-Ash.Resource.md:2914`). | **high** |
| 106-107, 289-290 | Argument options are "`type`, `constraints`, `allow_nil?`, `default`, `sensitive?`, `doc`" | `type` is a positional argument (`:1020`). There is no `doc` option. The real options are `description, constraints, allow_nil?, public?, sensitive?, default` (`DSL-Ash.Resource.md:1025-1030`). | medium |
| 137-138 | `bypass` → `authorize_if`, `forbid_if` | Bypass has all four check entities: `authorize_if` :643, `forbid_if` :683, `authorize_unless` :723, `forbid_unless` :763 (`DSL-Ash.Policy.Authorizer.md`). | low |
| 148-154 | "Complete list of modules in `lib/ash/type/`", presented as the built-in types | It is a list of file names. `comparable`, `composite_type_helpers`, `helpers`, `registry` and `type` are not types. `enum` and `new_type` are macros/behaviours for defining your own types. The authoritative list is the 31 short names in `lib/ash/type/registry.ex:8-40`: `map keyword term atom tuple string integer file float duration_name function boolean struct uuid uuid_v7 binary date time time_usec decimal ci_string naive_datetime utc_datetime utc_datetime_usec datetime duration url_encoded_binary union module vector range`. Also mention `{:array, type}`. | medium |
| 157-159 | `Struct`, `Union`, `Range`, `File`, `Function` are "*not* plain atoms"; `Ash.Type.TypedStruct` | `:struct`, `:union`, `:range`, `:file` and `:function` are all atom short names (`registry.ex:16,21,20,37,40`). `Ash.Type.TypedStruct` does not exist. The module is `Ash.TypedStruct` (`lib/ash/typed_struct.ex:5`, DSL doc `documentation/dsls/DSL-Ash.TypedStruct.md`). | medium |
| 183-184 | `public? false` cited at `DSL-Ash.Resource.md:96` | Line 96 is `generated?`. `public?` is at :98. | low |
| 188-191 | The PK/timestamp entities expand with "`primary_key? true` / `generated? true`" | Only `integer_primary_key` sets `generated? true` (`:212-224`). `uuid_primary_key` and `uuid_v7_primary_key` set `writable? false, public? true, default …, primary_key? true` (`:262-268`, `:309-315`). Timestamps set `writable? false, match_other_defaults? true, allow_nil? false` (`:125-131`). | low |
| 216-223 | "Shared options (all four kinds) … the `has_many`/`many_to_many`/`belongs_to` lists are the same set" | They differ. `manual`, `no_attributes?` and `through` (traversal) exist only on `has_one`/`has_many` (`:448`, `:562-564`). On `many_to_many`, `through` means the join resource (`:678`). `belongs_to` has no `manual`, `no_attributes?`, `through` or `could_be_related_at_creation?` (`:778-810`). | medium |
| 266-267, 866 | "`defaults [:read]` is shorthand for the four standard actions"; derived "The four standard read actions" | `defaults [:read]` defines only `:read`. The cited tutorial line says "Use the default implementation of the :read action" (`documentation/tutorials/get-started.md:164-165`). The list names which defaults to create. | **high** |
| 269-274 | The "shared action options" are cited at `:933-940` | Lines 933-940 are the `actions` section options (`defaults`, `default_accept`). The listed options are not shared by generic actions: `accept`, `action_select`, `require_attributes`, `allow_nil_input`, `notifiers`, `manual?`, `multitenancy`, `delay_global_validations?` and `skip_global_validations?` do not exist on `action` (`:985-994`). Split the list per action type. | medium |
| 329-333 | Lifecycle hooks: the six on `Ash.Changeset` "(and `Ash.Query`)"; `:4743` | `Ash.Query` has no `around_action` (`lib/ash/query/query.ex:1379,1415,1475,1532,1612`). `changeset.ex:4743` is `with_hooks`. The runners are at :5115, :5205 and :5308. The DSL-level way users attach hooks (`change before_action(fn …)`, `prepare after_action(...)`) is missing. | medium |
| 355-356 | "`atomic_upgrade_with` is ignored when `require_atomic?` is `true`" | The source says `atomic_upgrade?` is the one that is "Ignored if `required_atomic?` is `true`" (`DSL-Ash.Resource.md:1855`). `atomic_upgrade_with` picks the read action (`:1856`). | low |
| 468 | A policy is "scoped by an optional `action_type`, `action`, `resource`, `action_name`, `description` filter (… `target_action` machinery, `authorizer.ex:260-280`)" | Made up. `policy` options are `description`, `access_type` (`:strict \| :filter \| :runtime`), `condition` and `error_message` (`lib/ash/policy/authorizer/authorizer.ex:166-202`). Lines 260-280 are the `policy_group` condition schema and the `@bypass` definition. Conditions are ordinary checks such as `action_type(:read)`. | **high** |
| 535-536, 909 | No-policy default `[unverified]`, pointing at `authorizer.ex:164-210` | Settled, see §5. Those lines are the `policy` entity schema, not a default path. | medium |
| 528 | `can?` subject types sourced from `lib/ash/error/error.ex:30` | That line is the `ash_error_subject` type used by the error module, not the `can?` signature. Cite `lib/ash.ex:1840` and its spec. | low |
| 599-616 | "`Ash.Changeset` public API" | `get_result` and `run_atomic_conditions` do not exist. `change` (:22) belongs to a nested module. `inspect` (:112) is the `Inspect` protocol implementation. `handle_allow_nil_atomics`, `hydrate_atomic_refs`, `split_atomic_conditions`, `run_authorize_results` and `validate_multitenancy` are `@doc false` (internal). `for_read-side filter` is garbled. | low |
| 393-400 | `Ash.Query` list | `loading` is really `loading?`, and `set_authorize` is really `set_authorize?`. The list leaves out `add_error, get_argument, fetch_argument, delete_argument, set_result, clear_result, equivalent_to?, subset_of?, superset_of?, unset, selecting?, for_read_opts`. | low |
| 693-694 | Every error class "carries `bread_crumbs`, `path`, `stacktrace`, `vars` … (`lib/ash/error/error.ex:20-37`)" | Lines 20-37 are `@type` definitions (`error_keyword_option`, `ash_error_subject`, …). Nothing there supports the claim. Cite the Splode error struct or the class modules. | medium |
| 859 | `uuid_primary_key :id` derives "`allow_nil? false`, `generated? true`" | The source sets no `generated?`. It sets `writable? false, public? true` (`DSL-Ash.Resource.md:262-268`). | low |
| 865 | `create :open do accept [:subject] end` derives "a code-interface function … `can_open?` / `can_open` / `changeset_to_open`" | Made up. The tutorial Ticket has no `code_interface` block, and code-interface functions exist only for `define` entries (`DSL-Ash.Resource.md:2438-2480`). The doc itself says on line 875 that the tutorial uses no `code_interface`. | **high** |
| 867 | Error is "`Ash.Error.Invalid.InvalidAttribute`" | That module does not exist. It is `Ash.Error.Changes.InvalidAttribute` (`lib/ash/error/changes/invalid_attribute.ex`). | low |
| 869 | `belongs_to` derives "the inverse `has_many :tickets` on Representative" | Not derived. The user declares it by hand (`get-started.md:547-552`). | medium |
| 872 | Compile-time verifiers include "unknown action references", cited at `get-started.md:569-573` | The tutorial (`:581`) mentions only a resource missing from the domain and a missing `belongs_to`. "Unknown action references" has no source. | low |
| 889-898 (§13 row 4) | Not mentioned: "lifecycle hooks … transaction config" | The plan mentions "after-hooks, transaction boundary" (plan:118) and "Call the data layer inside a transaction" (plan:132). Hooks and transactions are mentioned. Only the *configuration* is missing. | medium |
| 898 (§13 row 11) | Tooling: only migrations are quoted | The plan also names `<cli> build`, `<cli> watch` (plan:93), `<cli> inspect` (plan:171), and "`SKILL.md` and an MCP server" (plan:172). These are the CLI-task and LLM-docs equivalents. | low |
| 899, 929, 966 | "The plan's own example resource covers 7 of the 14 sections" / "best official example uses 7 of 14" | The plan example uses 6 blocks: attributes, relationships, actions, policies, calculations, aggregates (plan:41-81). `policies` is not one of the 14 `Ash.Resource` sections. The tutorial Ticket uses 3 of the 14 (attributes, actions, relationships), not 7. | low |
| 3 | "Docs shipped in the clone are the ones at hexdocs.pm/ash for this version" | No source given. | low |
| 10-11 | GenServer: "Ash's ETS data layer uses them, and nothing else here does" | No source given. | low |
| 937 | "Pololicies" | Typo. | low |
| report | Word count 6,544 | This is over the 6,000-word limit in `_rules.md`. Cutting the wrong lists would fix it. | low |

Tally: 9 high, 18 medium, 17 low.

---

## 2. Acceptance criteria

| # | Criterion | Verdict | What is missing or wrong |
|---|---|---|---|
| 1 | Resource anatomy (every section and entity, purpose, table) | partial | All 14 sections and all entities are correctly named. The purposes of `changes` and `preparations` are wrong. The Summary says "10". `resources.resource` is missing its `namespace` option (`DSL-Ash.Domain.md:104`). The `policies` section options (`default_access_type`) are missing. |
| 2 | Attributes and types | partial | The type list is a file listing, not a type list (§1). There is no real explanation or example for union types, enums, `NewType` or custom types. The `Ash.Type` behaviour callbacks are not listed. `Ash.TypedStruct` is misnamed. The PK and timestamp defaults are partly wrong. |
| 3 | Relationships | partial | The "shared options" claim is false. `manage_relationship` has no option list (`type:` `:append_and_remove`, `:direct_control`, …) and no example. There is no `many_to_many` example. |
| 4 | Actions | partial | The built-in change and preparation lists are missing 7 macros. The `defaults` semantics are wrong. Generic-action options are mixed with the others. The bulk strategies (`:atomic`, `:atomic_batches`, `:stream`) are missing. There are no examples for upsert, bulk, atomic, manual or pagination. The DSL-level hook macros are missing. |
| 5 | Query features | partial | About 15 registered expression functions and the `^tenant()` template are missing. The aggregate list is correct, but per-kind options (`uniq?`, `include_nil?`, `sort`, `type`/`implementation` for `custom`) are not given. There is no `Ash.Query` filter/sort/load usage example. Combination queries (`documentation/topics/advanced/combination-queries.md`) appear only as function names. |
| 6 | Policies | partial | The built-in check list is missing `matches/2`. Policy options are made up. `access_type` / `default_access_type` (`policies.md:227-269`) and `error_message` (`policies.md:370`) are missing. Bypass entities are wrong. The no-policy default is left unverified. The field-policy options are not listed. |
| 7 | Multitenancy | complete (minor error) | The table and example are correct. The claim that every action type has the `multitenancy` option is false for generic actions. Setting the tenant via `Ash.Scope` / `Ash.PlugHelpers.set_tenant` (`multitenancy.md:31-64`) is missing. |
| 8 | Code interfaces, Changeset, Query, `Ash.*` | partial | `define` and `define_calculation` are correct. The Changeset list contains functions that do not exist and internal ones. There is no example of *calling* a generated function. `Ash.ActionInput` (the generic-action counterpart of Changeset/Query, `lib/ash/action_input.ex`) is not covered. |
| 9 | Identities, resource validations, notifiers, pub_sub | partial | Identities and validations are complete. `pub_sub` is only named: the `pub_sub` DSL (`documentation/dsls/DSL-Ash.Notifier.PubSub.md:147`), topic templates (:43) and broadcast types (:116) are missing, and there is no example. |
| 10 | Errors | partial | The leaf count is wrong (91). The Splode basis is omitted. The citation for the error shape does not support it. The class table is fine. |
| 11 | Tooling | partial | The mix task count is wrong (25). The "no generators" claim is false. The "cheat sheets" item lists the 2.0 CHANGELOG, which is not a cheat sheet. It misses the in-core `usage-rules.md` and `usage-rules/*.md` (14 files), and that the `DSL-*.md` files are the Spark-generated cheat sheets. Telemetry events are not listed (settled in §5). |
| 12 | Density example | partial | The assembly is honestly labelled, but it uses 3 of the 14 sections, which is not "most sections". The "derived" table has 4 made-up or wrong rows (lines 859, 865, 866, 869). Code blocks drop comment lines without marking it (see §4). |
| 13 | Coverage table vs plan | partial | All 12 rows are present with quotes. Row 4 wrongly says hooks and transactions are not mentioned. Row 11 is missing the CLI and skill-file lines. The Summary contradicts row 7 and the generic-actions mention. |

0 complete, 1 complete with a minor error, 12 partial, 0 missing.

---

## 3. Citation sample

70 citations checked across all 13 sections, the Summary and §13.

| Result | Count | % |
|---|---|---|
| Supports | 26 | 37% |
| Wrong line, claim true | 32 | 46% |
| Does not support | 12 | 17% |
| File does not exist | 0 | 0% |

Most wrong-line citations into `DSL-Ash.Resource.md` are 1-4 lines off, all in the same direction. The researcher likely counted from table headers. Examples, each cited → actual:
- `require_atomic?` :1851 → :1854
- `accept` :1230 → :1228
- `primary?` :1225 → :1222
- `manual?` :1237 → :1236
- `action_select` :1231 → :1229
- `touches_resources` :1213 → :1225
- `get_by` :1509 → :1512
- read `timeout` :1510 → :1513
- `soft?` :2141 → :2145
- `notifiers` :1236 → :1235
- `error_handler` :1235 → :1234
- `base_filter` :2746 → :2749
- `trace_name` :2748 → :2751
- `all_tenants?` :2831 → :2828
- validate `on` :3031 → :3030
- `manual` :446 → :448
- `through` example :566 → :564
- `many_to_many.through`/`join_relationship` :675-676 → :678-679

In other files, cited → actual:
- `DSL-Ash.Domain.md`: authorization :447-449 → :451-452; timeout :418 → :422; trace_name :422 → :423; resources example :44-48 → :51-54.
- `lib/ash.ex`: `can?` :1838 → :1840; `can` :1956 → :1963; `can_see_fields?` :2056 → :2063; `can_see_fields` :2094 → :2101; `can_do_all?` :2161 → :2164; `can_do_all` :2203 → :2207.
- `expressions.md`: functions :65-88 → :69-91; `upsert_conflict` :88 → :91.
- `policies.md`: :120 → :122.
- `mix.exs`: :2 → :13.
- `.formatter.exs`: :3 → :5.

In `get-started.md` the drift is 7-40 lines:
- `attribute :subject` :250 → :177/:238
- constraints :246 → :253
- accept :262-264 → :271-273
- validate :322-325 → :325-327
- error output :308-311 → :304-308
- belongs_to :551-556 → :561-567
- ETS :436-440 → :476-479
- attribute block :224-250 → :236-261
- create :open :256-266 → :266-275
- assign :586-588 → :593-598

The 12 citations that do not support their claim:
- `get-started.md:165` (four actions)
- `DSL-Ash.Resource.md:1021-1034` (argument options)
- `changeset.ex:4743`
- `DSL-Ash.Resource.md:1852-1854` (atomic_upgrade_with)
- `authorizer.ex:260-280`
- `policies.md:119-121` (the update/destroy/create semantics are at :229-233)
- `error.ex:30`
- `authorizer.ex:164-210`
- `error.ex:20-37`
- `get-started.md:569-573`
- `DSL-Ash.Resource.md:248` (generated?)
- `DSL-Ash.Resource.md:933-940`

Citations that do support, for the record:
- all 14 Resource and 4 Domain headings
- `authorizer.ex:282`, `:222-224`
- `policies.md:124-149`, `:151-154`, `:157-178`, `:609-711`
- all 21 `built_in_checks.ex` lines, and every `change/builtins.ex` and `validation/builtins.ex` line
- `notifiers.md:31-70`, `:113`
- `generic-actions.md:258`, `:391`
- the multitenancy and monitoring guide headings
- `expressions.md:188-198`
- `DSL-Ash.Resource.md:2416-2480`, `:2612-2620`, `:2785-2833`, `:1709-1725`, `:4200-4245`, `:4334-4348`, `:4377-4388`
- `error.ex:53`, `:78-96`
- `changeset.ex:5066`

---

## 4. Code examples

| Doc lines | Verdict |
|---|---|
| 124-129 (domain `resources`) | Verbatim (`DSL-Ash.Domain.md:51-54`). Wrong line. |
| 316-320 (validate) | Verbatim (`get-started.md:325-327`). |
| 410-416 (aggregates) | Verbatim (`DSL-Ash.Resource.md:3285-3290`). |
| 447-453 (templates) | **Altered.** The `# equivalent to …` comments are rewritten, and the list-path variants `^actor([:key1, :key2])` and `^context([:key1, :key2])` (`expressions.md:192,195`) are dropped. The meaning of what remains is kept, but it is not a copy. Restore it verbatim. |
| 484-495 (policies) | **Altered.** The 4 explanatory comment lines from `policies.md:161-174` are removed without marking. The code itself is unchanged. |
| 554-560 (multitenancy) | Verbatim. |
| 577-582 (code_interface) | Verbatim. |
| 636-641 (identities) | Verbatim. |
| 698-702 (error text) | Verbatim (`get-started.md:305-307`). |
| 755-778 (density 1) | Verbatim (`get-started.md:159-179`). |
| 781-803 (density 2) | **Altered.** The 5-line constraint comment (`get-started.md:248-252`) is dropped without marking. The citation `224-250` is wrong (real lines 236-261). |
| 806-813, 849-853 | Verbatim. Wrong line numbers. |
| 816-830 (density 4) | **Altered.** The 4-line custom-change comment (`get-started.md:330-333`) is dropped. |
| 833-837 (ETS) | Verbatim, but the real location is `get-started.md:476-479`, not 436-440. |
| 840-846 (belongs_to) | **Altered.** 2 of the 4 comment lines (`get-started.md:563-564`) are dropped. Wrong line numbers. |

No example is invented. Six are trimmed without an ellipsis or note, which breaks rule 5's "copied" requirement. The doc's own claim at line 752 ("I have not silently merged in anything else") holds, but it did silently remove lines.

---

## 5. Settled `[unverified]` claims and open questions

1. **Callbacks of NewType, Struct, Union, Enum and Range.**
   - `Ash.Type.NewType` declares `subtype_of/0`, `lazy_init?/0`, `subtype_constraints/0` and `type_constraints/2` (`lib/ash/type/new_type.ex:39-45`).
   - `Ash.Type.Enum` declares `values/0`, `label/1`, `description/1`, `details/1`, `match?/1` and `match/1` (`lib/ash/type/enum.ex:142-155`).
   - `Union`, `Struct` and `Range` declare no `@callback`. They are concrete types configured through constraints, not behaviours.
2. **No-policy default.** Once a resource uses `Ash.Policy.Authorizer`, a request that no policy applies to is **forbidden**.
   - `raw_expression/1` folds the policies from `{false, true}` (`lib/ash/policy/policy.ex:81`).
   - It returns `one_condition_matches and all_policies_match` (`:97`).
   - So with zero applicable policies the expression is `false`.
   - A bypass counts toward "at least one applies" only if it authorizes (`:85-86`).
   - A resource without the authorizer has no policy authorization at all. The authorizer is opt-in through `authorizers: [Ash.Policy.Authorizer]` (`policies.md:20`).
3. **Field-policy options.**
   - `field_policy` takes `fields` (required, positional), an optional `condition` and `description`, plus the 4 check entities (`authorizer.ex:335-367`).
   - `field_policy_bypass` is the same with `bypass?: true` (`:370-376`).
   - Only filter or expression checks are allowed (`DSL-Ash.Policy.Authorizer.md:813-845`).
   - Forbidden fields become `%Ash.ForbiddenField{}`.
4. **Pipelines.** An action uses a pipeline through the `pipe_through` entity. Example: `pipe_through [:change_state], where: …`. Pipeline entities are prepended to the action's own changes and preparations (`DSL-Ash.Resource.md:1127-1160`, and the section intro at `:3049-3050`).
5. **Telemetry events.** There are 18 events, each with `:start`/`:stop` suffixes (`monitoring.md:17-44`): `[:ash, domain, :create|:update|:read|:destroy|:action|:bulk_create|:bulk_update|:bulk_destroy]`, plus `[:ash, :changeset|:query|:validation|:change|:calculation|:before_action|:after_action|:preparation|:notifier|:request_step]`. There are also 18 trace types (`monitoring.md:75-92`).
6. **Generators.** They exist in core. See the mix tasks row in §1 (`lib/mix/tasks/gen/*.ex`, `generators.md:45-54`).
7. **Per-kind aggregate options** (`DSL-Ash.Resource.md:3296-4102`).
   - Shared by all kinds: `relationship_path, read_action, filter, description, default, public?, filterable?, sortable?, sensitive?, authorize?, multitenancy`.
   - `field` on every kind except `count` and `exists`.
   - `uniq?` on `count` and `list`.
   - `include_nil?` on `first` and `list`.
   - `sort` on `first`, `list` and `custom`.
   - `type` and `implementation` on `custom`.
   - `join_filter` takes `relationship_path, filter` (`:3356-3398`).
8. Open question 8 ("no web sources needed") is fine as a statement.

---

## 6. List recounts

| List | Doc says | Source count | Missing (by name) | Invented or wrong |
|---|---|---|---|---|
| Resource DSL sections | 10 (Summary) / 14 (table) | 14 | — | "10" |
| Domain DSL sections | 4 | 4 | `resources.resource` option `namespace` | — |
| Policy DSL sections | 2 | 2 | `policies` option `default_access_type`; bypass `authorize_unless`/`forbid_unless` | — |
| Built-in types | 38 file names, "37 modules" in report | 31 short names (`registry.ex:8-40`) | `{:array, t}` composite | `comparable`, `composite_type_helpers`, `helpers`, `registry`, `type` (not types); `Ash.Type.TypedStruct` (does not exist) |
| `attribute` options | "Full list" | 16 | — (`update_default` is folded into the `default` row) | — |
| Relationship kinds | 4 | 4 | — | false "same set" claim |
| Built-in changes | 19 | 24 | `update_change`, `after_action`, `after_transaction`, `before_action`, `before_transaction` | — |
| Built-in validations | 24 | 24 | — | — |
| Built-in preparations | 2 | 4 | `before_action`, `after_action` | — |
| Built-in policy checks | 21 | 22 | `matches` | — |
| Aggregate kinds | 9 | 9 | — | — |
| Expression operators | 15 + `is_nil` | guide 15 + `is_nil`; source adds `+` | `+` | — |
| Expression functions | ~30 | 39 registered (`filter.ex:76-116`), plus special forms (`exists`, `parent`, `upsert_conflict`, `required!`) | 15 named in §1 | — |
| Expression templates | 6 | 4 in guide, 5 in source | `^tenant()` | `parent/1` and `path.exists/2` counted as templates |
| Error classes | 4 | 4 | — | — |
| Error leaf modules | ~110 | 91 | — | the count |
| Mix tasks | 13 (14 listed) | 25 | the 9 `ash.gen.*` tasks, `ash.install`, `ash.patch.extend` | `ash.generate_policy_chart` (it is `…_charts`) |
| `Ash.*` functions | ~55 | about 80 public names including `_opts`/bang variants | `exists/3` (non-`?`) and the `*_opts` helpers are not listed; otherwise complete | — |
| `code_interface` generated kinds | 5 | 5 | — | — |
| Pagination options | 9 | 9 | — | — |
| Identity options | 10 | 10 | — | — |

---

## 7. Omissions (user-facing features absent from the document)

Compared against `DSL-Ash.Resource.md`, `DSL-Ash.Domain.md`, `DSL-Ash.Policy.Authorizer.md` and `documentation/topics/`:

1. **Built-in data layers.** `Ash.DataLayer.Ets`, `Ash.DataLayer.Mnesia` and `Ash.DataLayer.Simple` ship in core (`lib/ash/data_layer/{ets,mnesia,simple}`, `documentation/dsls/DSL-Ash.DataLayer.Ets.md`, `DSL-Ash.DataLayer.Mnesia.md`). The `use Ash.Resource` options (`data_layer`, `authorizers`, `notifiers`, `simple_notifiers`, `extensions`, `domain`) are never listed.
2. **Policy access types.** `access_type` (`:strict`/`:filter`/`:runtime`) and `default_access_type` are missing (`policies.md:227-269`). They decide filter-versus-error behaviour, which is central to criterion 6.
3. **Policy `error_message`** (`policies.md:370-447`), **policy breakdowns and logging** (`:967-1047`), **`can_read`/`accessing_from` composition** (`:516-579`) and **`authorize_read_with` / `allow_forbidden_field?`** on relationships (`:467-515`).
4. **Actors and `Ash.Scope`** (`documentation/topics/security/actors-and-authorization.md`, `multitenancy.md:51`, `lib/ash/scope.ex`). The `actor:`, `tenant:`, `authorize?:` and `scope:` call options are never explained.
5. **Sensitive data guide** (`documentation/topics/security/sensitive-data.md`). Only the `sensitive?` flag appears.
6. **Ash.Reactor in core** (`documentation/dsls/DSL-Ash.Reactor.md`, `documentation/topics/advanced/reactor.md`, `multi-step-actions.md`). A one-line pointer to `ash-ecosystem` is enough, but it is core.
7. **`Ash.TypedStruct` DSL** (`documentation/dsls/DSL-Ash.TypedStruct.md`).
8. **Custom change, validation and preparation behaviours** (`Ash.Resource.Change`, `Ash.Resource.Validation`, `Ash.Resource.Preparation`). Their callbacks (`change/3`, `atomic/3`, `batch_change/3`, `validate/3`, `prepare/3`) are how users extend actions (`documentation/topics/resources/changes.md`, `validations.md`, `preparations.md`).
9. **Custom expressions** (`Ash.CustomExpression`, `expressions.md:200-215`) and **calculation arguments and module callbacks** (`documentation/topics/resources/calculations.md`).
10. **Bulk action strategies and options** (`:atomic`, `:atomic_batches`, `:stream`, `return_records?`, `notify?`), found in `lib/ash.ex` `bulk_update_opts` (:609) and the update-action guide.
11. **Testing support**: `Ash.Generator`, `Ash.Seed`, `Ash.Test` (`lib/ash/generator/generator.ex`, `lib/ash/seed.ex`, `lib/ash/test.ex`, `documentation/topics/development/testing.md`).
12. **Timeouts guide** (`documentation/topics/advanced/timeouts.md`), **temporal resources guide** (`documentation/topics/advanced/temporal-resources.md`; only the option list is given) and **combination queries** (`documentation/topics/advanced/combination-queries.md`).
13. **Introspection modules** `Ash.Resource.Info` and `Ash.Domain.Info`. Every DSL entity documents an "Introspection" target.
14. **`usage-rules.md` and `usage-rules/` (14 files)** shipped in the `ash` repo. These are LLM rules, directly relevant to mesh's agent-legibility goal.
15. **How-to guides** in `documentation/how-to/`: polymorphic relationships, encrypt attributes, prevent concurrent writes (`optimistic_lock`), wrap external APIs.

---

## Round 2 re-verification

Re-checked the revised [`notes/research/01-ash-features.md`](../ash-features.md) (1,211 lines, ends with `## Revision log (round 2)`) against source again.

Verdict: **ACCEPT-WITH-FIXES**.
- Every high finding from round 1 is fixed correctly.
- All seven corrected counts now match source.
- What is left: 7 medium issues, most of them new errors in the text added this round, and a set of low issues (line drift and two counts).
- None of them needs restructuring.

### R2.1 Reviewer corrections: errors in my own round-1 review

The researcher copied two of these into the document, so both sides need to fix them.
- **`field` is an option on `count`.** I wrote "`field` on every kind except `count` and `exists`". In fact `count` has `field` (`DSL-Ash.Resource.md:3344`). Correct statement: `field` is on every kind except `exists`.
- **`registry.ex` line numbers.** I gave wrong line numbers for the short names. The correct ones are: `file` :16, `function` :19, `struct` :21, `union` :36, `range` :39, and `@custom_short_names` :44.

### R2.2 Status of round-1 high and medium findings

All of the following are now correct in the document, checked against source:
- 14 sections.
- The `changes` and `preparations` purposes, quoted at :2842 and :2914.
- Built-in counts: 24 changes, 24 validations, 4 preparations and 22 checks. The macro lines (102, 466, 496, 523, 550; 57, 82; 422) match.
- 5 templates, with `^tenant` at `expr.ex:106`.
- 39 functions (`filter.ex:76-116`).
- 91 error leaf modules.
- Splode, at `error.ex:9-18`.
- 25 mix tasks.
- The Summary now agrees with §13.
- Argument options (:1025-1030).
- `bypass` has all four check entities.
- The 31 types; `Ash.TypedStruct`.
- PK and timestamp options (:212-224, :262-268, :309-315).
- The relationship matrix: which kind has which option is now right.
- `defaults` (:937).
- `atomic_upgrade?` (:1855).
- The four `policy` options (`authorizer.ex:166-202`).
- No-policy default (`policy.ex:81,97`).
- `can?` citation.
- The `Ash.Query` list.
- The density "derived" rows and the "3 of 14" statement.
- §13 rows 4 and 11.

Low findings, sampled 9 of 17. Fixed: `public?` :98, the `atomic/3` sentence, the `Ash.Error.Changes.InvalidAttribute` name, `ash.generate_policy_charts`, and the plan "6 blocks / 5 sections". Still wrong: the registry lines (see R2.4), the `get-started.md` query citation (see R2.4), and the word count (see R2.4).

### R2.3 Still wrong: medium (fix before acceptance)

| Doc line | Problem | Source / fix |
|---|---|---|
| 285-288 | "**Shared by create/read/update/destroy only**: `accept`, `action_select`, `require_attributes`, `allow_nil_input`, `delay_global_validations?`, `notifiers`, `manual?`, `error_handler`" | `read` has none of these except `multitenancy` and `skip_global_validations?`. Read's options are `manual, get?, modify_query, get_by, timeout, multitenancy, skip_global_validations?, primary?, description, transaction?, touches_resources, skip_unknown_inputs, public?` (`DSL-Ash.Resource.md:1509-1521`). Relabel the list as "create/update/destroy", and say `multitenancy` and `skip_global_validations?` are also on read. `error_handler` is also on generic `action` (:988), so it cannot be in the "generic lacks them" list and the "generic only" list at the same time. Remove it from both lists and list it as shared by create, update, destroy and action. |
| 352-359 | The §4.6 hook example has no citation and the wrong function arities | The real examples are `change before_action(fn changeset, _context ->` (`lib/ash/resource/change/builtins.ex:517`), `change before_transaction(fn changeset, _context ->` (:544), `change after_action(fn changeset, record, _context ->` (:460), `change after_transaction(fn` (:487), `prepare before_action(fn query, _context ->` (`lib/ash/resource/preparation/builtins.ex:51`) and `prepare after_action(fn query, records, _context ->` (:76). Copy these lines verbatim with their citations (rule 5). |
| 219 | `Ash.Resource.Calculation` callbacks "`calculate/3`, `batch/2`" | There is no `batch/2`. The callbacks are `init/1`, `describe/1`, `calculate/3`, `expression/2`, `load/3`, `strict_loads?/0`, `has_expression?/0` (`lib/ash/resource/calculation/calculation.ex:209-222`). |
| 218 | `Ash.Resource.ManualRelationship` callback is "relationship read" | The callbacks are `load/3` and `select/1` (`lib/ash/resource/manual_relationship/manual_relationship.ex:35-37`). |
| 749 | "`Ash.ActionInput` … built by `Ash.for_action/4`" | `Ash.for_action/4` does not exist; `lib/ash.ex` defines no `for_action`. The function is `Ash.ActionInput.for_action/4` (`lib/ash/action_input.ex:253`). |
| 713-734 | The §8.2 heading says "Public functions … (`@doc false` internals excluded)" | 12 functions in the list are `@doc false` in `lib/ash/changeset/changeset.ex`: `split_atomic_conditions`, `run_atomic_validation`, `run_atomic_change`, `set_on_upsert`, `handle_params`, `require_values`, `run_before_actions`, `run_after_transactions`, `run_after_actions`, `manage_relationship_opts`, `set_action_select`, `set_private_arguments_for_action`. Each has `@doc false` on the line before its first `def`. Meanwhile the list leaves out real public functions: `change_attribute`, `change_attributes`, `force_change_attribute`, `force_change_attributes`, `change_default_attribute`, `clear_change`, `set_arguments`, `delete_argument`, `force_set_argument`, `add_error`, `handle_errors`, `filter`, `before_action`, `after_action`, `before_transaction`, `after_transaction`, `around_action`, `around_transaction`. Remove the 12, add the missing ones, or call it "selected". §4.9 (lines 394-396) also presents `add_atomic_validations`, `apply_atomic_constraints`, `run_atomic_change` and `run_atomic_validation` as changeset API, but they are internal. |
| 72-75, 472 | "Pipeline entities are prepended to the action's own changes and preparations" is quoted as source text at `:3049-3050`; `field` is "all except `count` and `exists`" | The real text is "Pipeline entities are prepended before the action's own changes/preparations." at `DSL-Ash.Resource.md:1134`; lines 3049-3050 say something else. For `field`, see R2.1: drop `count` from the exception, so `field` is "all except `exists`". |

### R2.4 Still wrong: low

**Wrong line numbers.** The claims are true; only the line is wrong.

| Doc line | Cited | Actual |
|---|---|---|
| 233-241 (relationship matrix) | `no_attributes?` :451 / :565 | :449 / :563 |
| | `through` :454 | :450 |
| | `allow_nil?` :456 | :451 |
| | `from_many?`, `offset` :460-463 | :452-453 |
| | has_many `offset` :582 | :566 |
| | has_many `limit` :581 | :565 |
| | `could_be_related_at_creation?` :472 / :586 / :700 | :469 / :582 / :695 |
| | m2m join options :679-681 | :676-679 |
| | belongs_to block :780-792 | :782-788 |
| 389, 422 | destroy `require_atomic?` :2150 (this is a regression: round 1 had the correct :2148) | :2148 |
| 285 | `accept` :1862, :2163 | :1864, :2157 |
| 401 | update `manual` :1852 | :1853 |
| 288, 677-678 | `multitenancy` :1218, :1512, :1865, :2148 | :1220, :1514, :1857, :2147 |
| 677-678 | calculations `multitenancy` :4245 | :4244 |
| 95 | `defaults` :936 | :937 |
| 155 | registry short names (see R2.1) | :16, :19, :21, :36, :39 |
| 147 | `@custom_short_names` :41 | :44 |
| 146 | `{:array, …}` example :78 | `embedded-resources.md:81` |
| 34 | templates at `expr.ex:103-112` | `context/1` is at :131, so the range is :103-131 |
| 494 | aliases `filter.ex:133-140` | :135-142 |
| 472-476 (aggregate table) | — | `field`: count :3344, first :3522, sum :3616, list :3709, max :3804, min :3896, avg :3988, custom :4089. `uniq?` :3342, :3715. `include_nil?` :3527, :3714. `sort` :3530, :3718, :4091. `type`/`implementation` :4082, :4087. (The table cites 3430 for `exists`, which has no `field`.) |
| 551-552 | field-policy text `authorizer.ex:389-393`, `:395` | "If *any*…" :387, `:*` :389, primary keys :392 |
| 590 | `:filter` create behaviour `policies.md:246-269` (those lines are about `:runtime`) | :231-234 and :271-295 |
| 440 | "Usage (verbatim, `get-started.md:411`, `:414`)" (line 411 is `Ash.read!(Helpdesk.Support.Ticket)`) | Delete the line; the block's correct citation is :503-505. Row 1078 has the same problem: `:411` → :504. |
| 899 | `DSL-Ash.Resource.md:1` | The Spark header is on line 2. |
| §13 (plan line numbers) | density goal plan:14; Policies plan:149; Calculations plan:148 (swapped); Changeset/Query plan:155; notifier package plan:127; "Errors name the fix" plan:167; Drizzle plan:107; data-postgres plan:123; dialect plan:44-48; read/filter plan:60-62; count plan:79; policies plan:64-71; core plan:117; one-resource plan:165; parity plan:25; plan:87 | 13; 148; 149; 154; 124; 168; 103; 120; 42-46; 62-64; 81; 66-72; 118; 166; 26; 89 |

**Copy fidelity and wrong facts.**
- Line 35: "16 operators". Registered operator modules are 15: 8 at `filter.ex:120-129` plus the 7 symbols in `basic.ex` (`+ * - / <> || &&`). `and`/`or` are boolean expressions, not operator modules. Say "15 registered operators; the guide lists 15 + `is_nil`".
- Line 909: "4 executable how-to guides". `documentation/how-to/` has 7 `.livemd` files.
- Line 644-646: `Ash.Scope` "bundles actor + authorize? + tenant + context into one value that every `Ash.*` call accepts". The source says a user struct implements the `Ash.Scope.ToOpts` protocol so that actor, tenant, context, `authorize?` and tracer can be pulled out of it (`lib/ash/scope.ex:5-12` and the "Passing scope and options" section). The cited `multitenancy.md:51-64` does not say "every call".
- Lines 560-578 and 785-790: the "verbatim" policy and pub_sub examples each drop one blank line (`policies.md:168`, `DSL-Ash.Notifier.PubSub.md:137`). The policy citation `:161-174` should be `:159-178`.
- Line 982: the tutorial's `attributes do` and `...` lines (`get-started.md:236-237`) are merged onto one line.
- Line 1210: "~5,900 words". `wc -w` gives 8,419. Either cut the document or report the real number.

### R2.5 Recounts against source

| List | Doc now | Source | Result |
|---|---|---|---|
| Mix tasks | 25 | 14 in `lib/mix/tasks/*.ex` (excluding `helpers.ex`) + 9 in `gen/` + `install/ash.install` + `patch/ash.patch.extend` = 25 | ✅ |
| Built-in changes | 24 | 19 `def` + 5 `defmacro` (`change/builtins.ex`) | ✅ |
| Preparations | 4 | 2 + 2 | ✅ |
| Policy checks | 22 | 21 + `matches` | ✅ |
| Expression functions | 39 | 39 names, matched name by name (`filter.ex:76-116`) | ✅ |
| Types | 31 | 31 (`registry.ex:9-39`) | ✅ (line numbers wrong, see R2.4) |
| Error leaf modules | 91 | 99 − 8 | ✅ |

### R2.6 Fresh citation sample (30 not checked in round 1)

| Result | Count | % |
|---|---|---|
| Supports | 17 | 57% |
| Wrong line, claim true | 10 | 33% |
| Does not support | 3 | 10% |
| File does not exist | 0 | 0% |

**Supports:**
- `lib/ash/resource.ex:20-60`, `:25`
- `DSL-Ash.Resource.md:938`, `:988`
- `lib/ash.ex:3880`, `:578`/`:639`
- `changeset.ex:5697-5734`, `:6136`, `:813`
- `authorizer.ex:325-331`, `:186-200`
- `policy.ex:81,97`
- `basic.ex:9-10`
- `get-started.md:503-505`
- `DSL-Ash.Notifier.PubSub.md:135-141`
- `monitoring.md:17-44`
- `ash.generate_policy_chart.ex:5`

**Wrong line, claim true:**
- `DSL-Ash.Resource.md:936`
- registry short-name lines
- `registry.ex:41`
- `embedded-resources.md:78`
- the multitenancy option lines
- `DSL-Ash.Resource.md:2150`
- `:1862`/`:2163`
- `authorizer.ex:389-395`
- `expr.ex:103-112`
- the relationship-matrix lines

**Does not support:**
- `DSL-Ash.Resource.md:3049-3050`: the quoted text is not there.
- `policies.md:246-269`: those lines are about `:runtime`, not `:filter`/create.
- `get-started.md:411`/`:414`: not the cited code.

**Outside the sample but invented:** `Ash.for_action/4` and `Calculation.batch/2` (both in R2.3).

### R2.7 The 15 omissions

| # | Omission | Added? | Correct? |
|---|---|---|---|
| 1 | Data layers and `use` options | yes (§1.1, §11.5) | ✅ `resource.ex:18-60` matches |
| 2 | Access types | yes (§6.2) | ✅ |
| 3 | `error_message`, breakdowns, `can_read`, `authorize_read_with` | yes (§6.5-6.6) | ✅ |
| 4 | Actors and `Ash.Scope` | yes (§6.9) | ⚠️ "every call" is unsourced; see R2.4 |
| 5 | Sensitive data | pointer only | ✅ |
| 6 | Ash.Reactor in core | **no** | Add one line: `documentation/dsls/DSL-Ash.Reactor.md`, `documentation/topics/advanced/reactor.md`, pointer to `ash-ecosystem`. Generic `run` accepting a Reactor (line 295) is not enough. |
| 7 | `Ash.TypedStruct` | yes (§2.1) | ✅ |
| 8 | Custom behaviours | yes (§2.5) | ❌ `batch/2` is invented and ManualRelationship is wrong (R2.3). `Validation` also has `atomic/3` and `batch_validate`; `CustomExpression` also has `name/0` and `arguments/0`. |
| 9 | Custom expressions, calculation callbacks | yes (§2.5) | see #8 |
| 10 | Bulk strategies | yes (§4.8) | ✅ |
| 11 | Testing | yes (§11.6) | ✅ paths exist |
| 12 | Timeouts, temporal and combination-query guides | combination queries yes; **timeouts and temporal guides no** | Add `documentation/topics/advanced/timeouts.md` and `documentation/topics/advanced/temporal-resources.md` |
| 13 | `Ash.Resource.Info` / `Ash.Domain.Info` | yes (line 14) | ✅ |
| 14 | `usage-rules` | yes (§11.3) | ✅ all 14 file names correct |
| 15 | How-to guides | yes, named | ❌ count: there are 7, not 4 |

### R2.8 The `[unverified]` claims, settled

1. **Splode field list.** Every error is a `defexception` with its own `fields` plus `splode: nil, bread_crumbs: [], vars: [], path: [], stacktrace: nil, class:` (`scratch/ash-src/splode/lib/splode/error.ex:112-120`). The reserved names are listed at `:94`. Error classes also add `errors: []` (`splode/lib/splode/error_class.ex:11`). Version: splode 0.3.2 (`splode/mix.exs:8`), the version pinned by ash's `mix.lock:53`.
2. **GenServer usage.**
   - `Ash.DataLayer.Ets.TableManager` uses GenServer (`lib/ash/data_layer/ets/ets.ex:76-78`, started at `:101`).
   - `Ash.TypeResolver` uses GenServer (`lib/ash/type_resolver.ex:7`, started at `:17`).
   - `lib/ash/actions/read/async_limiter.ex:16` uses an `Agent`.
   - Replace the `[unverified]` on lines 11-12 and open question 3 with these.
3. **A denser real example exists.** See R2.9. Remove "no official example uses most sections" (lines 950-953) and open question 2, or qualify the claim as "in the `ash` clone".

### R2.9 Dense real resource for §12

**Pick: `Tunez.Music.Album`.** It comes from the Ash book's sample app (Rebecca Le, `sevenseacat/tunez`).
- URL: https://github.com/sevenseacat/tunez/blob/end-of-chapter-10/lib/tunez/music/album.ex
- Branch `end-of-chapter-10`, commit `5ea6daeac0d8634bca22cddd3fc7331f6391f3c3` (2026-01-11).
- `mix.lock` pins ash 3.12.0.
- **146 lines.**
- The `main` branch is the starter app and has no `album.ex`, so cite the branch.

**What it uses:**
- 8 of the 14 `Ash.Resource` sections:
  - `actions`: `defaults [:read]`, `create`, `update` with `require_atomic? false`, `destroy`, an argument, and the `manage_relationship` and `cascade_destroy` changes.
  - `changes`: a custom change plus `relate_actor` with `on:`.
  - `validations`: `numericality` and `match`, with `where:` and `message:`.
  - `attributes`: including `create_timestamp` and `update_timestamp`.
  - `relationships`: `belongs_to` and `has_many` with `sort`.
  - `calculations`: one module-based and one `expr` using `^actor`.
  - `aggregates`: `sum`.
  - `identities`: with `message:`.
- `policies` (from the authorizer extension): `bypass`, `action`, `action_type` and an `expr` check.
- 3 extension sections: `graphql`, `json_api` and `postgres`.
- **The code interface is declared on the domain, not the resource.** `lib/tunez/music.ex:68-73` on the same branch has `define :create_album`, `:get_album_by_id` (`get_by: :id`), `:update_album` and `:destroy_album`. Cite both files.

Excerpt (lines 27-66, verbatim, 40 lines):

```elixir
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
```

**Runner-up in the Ash clone:** `scratch/ash-src/ash/test/support/policy_complex/resources/post.ex` (120 lines). It uses 7 of the 12 section keywords checked, but it is test scaffolding, not a documented example.

**Note for the researcher:** Tunez is pinned to ash 3.12.0, while the clone is 3.33.11. Say so when citing it (rule 3).

---

## Round 3 final check

This is the final check of [`notes/research/01-ash-features.md`](../ash-features.md) after round 3: 1,484 lines and 10,020 words by `wc -w`. All findings were re-verified against `scratch/ash-src/ash` 3.33.11, `scratch/ash-src/splode` 0.3.2, and the Tunez file fetched with `gh api` at commit `5ea6daeac0d8634bca22cddd3fc7331f6391f3c3`.

**Final verdict: ACCEPT-WITH-FIXES.**
- The document is reliable if readers apply the 16 errata in "Residual errors" below.
- There are no high or medium factual errors left in the inventory.
- What remains:
  - 6 wrong function arities in §8.3 and §3.4/§5;
  - 2 `@doc false` functions listed as public, and 5 public functions missing, in §8.2;
  - 2 wrong line numbers;
  - 1 unmarked omission in the Tunez quote;
  - 2 inaccurate statements in the analysis section.

### R3.1 Status of the round-2 "still wrong" items

| Round-2 item | Status | Evidence |
|---|---|---|
| §4.1 action-option sharing | **fixed correctly** | create/update/destroy-only list; `multitenancy` and `skip_global_validations?` on create, read, update and destroy (:1220/:1514/:1857/:2147, :1233/:1515); `error_handler` on create, update, destroy and action (:1234, :988); read's full list (:1509-1521). All match `DSL-Ash.Resource.md`. |
| §4.6 hook example | **fixed correctly** | The two blocks match `lib/ash/resource/change/builtins.ex:460-464` and `:517-522` exactly. The four heads match :544, :487 and `preparation/builtins.ex:51`, :76. |
| `Calculation.batch/2` | **fixed correctly** | `calculation.ex:209-222` |
| ManualRelationship callbacks | **fixed correctly** | `load/3`, `select/1` (`manual_relationship.ex:35-37`) |
| `Ash.for_action/4` | **fixed correctly** | `Ash.ActionInput.for_action/4` (`action_input.ex:253`) |
| §8.2 Changeset list | **partly fixed** | The 12 internals were removed and the 18 publics added. Still wrong: 2 `@doc false` functions listed as public, 5 public functions missing, 2 line numbers (residual errors #4-#8). |
| Pipeline quote; aggregate `field` | **fixed correctly** | `DSL-Ash.Resource.md:1134`. `field` is on every kind except `exists`, and all aggregate line numbers match. |
| Missing Reactor, timeouts and temporal guides | **fixed correctly** | §11.7 and §11.4. The files exist. |
| Low: relationship matrix, `require_atomic?` :2148, `accept` :1864/:2157, update `manual` :1853, multitenancy lines, calculations :4244, registry lines, `:44`, `embedded-resources.md:81`, `expr.ex:103-131`, aliases :135-142, field-policy :387/:389/:392, `policies.md:231-234`/`:271-295`, query example citation, DSL header :2, every §13 plan line, operators = 15, how-to = 7, `Ash.Scope` rewrite, three copy-fidelity fixes | **fixed correctly** | Each was re-checked against source. |
| Low: `defaults` :936 → :937 | **partly fixed** | Fixed at doc line 100; still `:936` at doc line 286. |
| Low: word count | **fixed (honestly reported)** | 10,020 is correct. It is still above the 6,000-word target in `_rules.md`. |

### R3.2 API existence sweep (§4, §6, §8)

I checked every function, callback, module and option name in these sections against `def`/`defmacro`/`@callback`/`defmodule`/`defprotocol` and the DSL option tables, including arity and default arguments. Everything exists except the items numbered #2, #4-#5 and #9-#13 under "Residual errors". Names confirmed in this sweep that were never checked in earlier rounds:
- `Ash.Resource.Actions.Implementation` (`lib/ash/resource/actions/action/implementation.ex:5`)
- `Ash.Scope.ToOpts` (`lib/ash/scope.ex:127`, nested `defprotocol`)
- `Ash.ForbiddenField` (`lib/ash/forbidden_field.ex:5`)
- `Ash.Error.Forbidden.Policy` (`lib/ash/error/forbidden/policy.ex:5`)
- `Ash.PlugHelpers.set_tenant/2` (`lib/ash/plug_helpers.ex:134`)
- SimpleCheck `match?/3` (`simple_check.ex:43`) and Check `describe/1` (`check.ex:76`)
- FilterCheck `filter/3` (`filter_check.ex:43`)
- `Ash.Changeset.handle_errors/2` (:7818) and `Ash.ActionInput.handle_errors/2` (`action_input.ex:1034`)
- the six changeset hook functions (`changeset.ex:7326-7731`, `/2` with optional opts)
- `with_hooks/3` (:4743)
- the runners `run_before_transaction_hooks/1`, `run_before_actions/1`, `run_after_transactions/2`, `run_after_actions/3`
- `fully_atomic_changeset/4`
- `bulk_create/3`, `bulk_update/4`, `bulk_destroy/4` (arities valid with defaults)
- `can_see_fields?/4`, `can_do_all?/2`
- `transact/3`, `transaction/3`
- the `authorize_with` option (`lib/ash.ex:152`, `:298`)

### R3.3 §12.1 `Tunez.Music.Album`

- I fetched the file at the cited commit. It is byte-identical to the `end-of-chapter-10` branch (146 lines).
- The quote is verbatim except for the marked omissions (json_api, postgres, validations, two attribute blocks) and **one unmarked omission**: `def next_year, do: Date.utc_today().year + 1` (album.ex:88). This contradicts "and nothing else" at doc lines 1156-1158 (residual #14).
- `lib/tunez/music.ex:68-73` at that commit matches the quote exactly.
- "8 of the 14 sections" is correct.
- Derivation table, all 10 rows supported:
  - `uuid_primary_key` → `DSL-Ash.Resource.md:262-268`
  - timestamps `Ash.Type.UTCDatetimeUsec` → :125-131, :166-174
  - `define_attribute?` default `true` → :787
  - `:direct_control` = `on_lookup: :ignore, on_no_match: :create, on_match: :update, on_missing: :destroy`, matching "diff against existing" → `changeset.ex:5734-5741`
  - `relate_actor` → `builtins.ex:34`
  - `cascade_destroy` → :407
  - identity → :2785-2833
  - `sum`/`field` → :3616
  - the calculation is used by the policy, as visible in the quote
  - the domain `define` has a `functions` option, default all five → `DSL-Ash.Domain.md:147`

### R3.4 §8.2 compared with `changeset.ex`

I classified every top-level `def` in `lib/ash/changeset/changeset.ex` as public or `@doc false`. There are 71 public functions.
- Listed but `@doc false`: `atomic_condition` (`@doc false` at :1732) and `temporal_recorded_at` (`@doc false` at :4304).
- Public but missing: `apply_attributes` (:7758), `fetch_argument_or_attribute` (:5544), `force_change_new_attribute` (:6896), `force_change_new_attribute_lazy` (:6910), `force_delete_argument` (:6862).
- Wrong line numbers: `fetch_argument_or_change` is cited at :5544 but is at :5559 (:5544 is `fetch_argument_or_attribute`); `filter` is cited at :7836 but is at :7832.
- Every other listed function is public and its line number is correct. The list of `@doc false` internals at doc lines 767-773 is correct.

### R3.5 Fresh citation sample (25 not checked in earlier rounds)

| Result | Count | % |
|---|---|---|
| Supports | 21 | 84% |
| Wrong line, claim true | 2 | 8% |
| Does not support | 2 | 8% |
| File does not exist | 0 | 0% |

**Supports:**
- `DSL-Ash.Resource.md:1233`, `:1515`, `:1222-1227`, `:989-994`, `:1509-1521`, `:1134`, `:787`, `:3616`
- `change/builtins.ex:517-522`, `:460-464`, `:544`/`:487`, and `preparation/builtins.ex:51`/`:76`
- `validation.ex:69,77,99`
- `calculation.ex:209-222`
- `custom_expression.ex:71-101`
- `manual_relationship.ex:35-37`
- `action_input.ex:253`
- `scope.ex:5-12`, `:55-61`
- `splode/lib/splode/error.ex:112-120`, `:94`
- `ets.ex:76-78`, `:101`
- `DSL-Ash.Domain.md:107-291` (`functions` at :147)
- tunez `music.ex:68-73`

**Wrong line, claim true:** `changeset.ex:5544` (`fetch_argument_or_change`), `:7836` (`filter`).

**Does not support:** `changeset.ex:1743` and `:4307`, cited as public functions when both are `@doc false`.

### R3.6 Did round 3 break anything?

No regressions found. Every section that was correct after round 2 is still present, with the same facts:
- §1, §2.1-2.4, §3, §4.2-4.5, §4.7-4.13, §5, §6, §7, §9, §10, §11.1-11.6, §12 Ticket, §13.

Round 3 deleted only these:
- the round-2 open questions it settled: Splode, GenServer and the dense example;
- the "generic only" `error_handler` line, which was moved to the correct list.

### Residual errors (for readers)

Read the document with these corrections. Doc line numbers refer to the round-3 file.

| # | Doc line | Statement in the document | Correct fact (source) |
|---|---|---|---|
| 1 | 286 | `defaults` … (`:936`) | The option is on `DSL-Ash.Resource.md:937` (`:936` is a table separator). |
| 2 | 274 | `manage_relationship_schema/2` | Arity 0: `def manage_relationship_schema, do: @manage_opts` (`lib/ash/changeset/changeset.ex:6010`). It is also `@doc false`. |
| 3 | 422-425 | "On the changeset only `fully_atomic_changeset/4` (`:813`) is public" | It is the only public one *among the atomic-execution helpers named there*. `atomic_update` (:2417), `atomic_set` (:2607), `atomic_ref` (:1703) and `atomic_defaults` (:895) are also public. |
| 4 | 748 | `atomic_condition` (1743) listed as public | `@doc false` (`changeset.ex:1732`). |
| 5 | 752 | `temporal_recorded_at` (4307) listed as public | `@doc false` (`changeset.ex:4304`). |
| 6 | 754 | `fetch_argument_or_change` (5544) | It is at `changeset.ex:5559`. Line 5544 is `fetch_argument_or_attribute`. |
| 7 | 765 | `filter` (7836) | `changeset.ex:7832`. |
| 8 | 745-765 | The §8.2 "Public functions" list | It also needs `apply_attributes/2` (:7758), `fetch_argument_or_attribute/2` (:5544), `force_change_new_attribute/3` (:6896), `force_change_new_attribute_lazy/3` (:6910) and `force_delete_argument/2` (:6862). |
| 9 | 779 | `exists/3`, `exists?/3` | Both are arity 1-2: `exists(query, opts \\ [])` and `exists?(query, opts \\ [])` (`lib/ash.ex:1329`, `:1299`). |
| 10 | 780 | `aggregate/4` | `aggregate(query, aggregate_or_aggregates, opts \\ [])`, arity 2-3 (`lib/ash.ex:1193`). |
| 11 | 781 | `run_action/3` | `run_action(input, opts \\ [])`, arity 1-2 (`lib/ash.ex:2299`). |
| 12 | 782 | `data_layer_query/3`, `pkey_filter/3` | `data_layer_query(query, opts \\ [])` is arity 1-2 (`lib/ash.ex:3086`). `pkey_filter(records, pkey)` is arity 2 (`:4642`). |
| 13 | 478 | `combination_hydration_context/2` | `combination_hydration_context(query)`, arity 1 (`lib/ash/query/query.ex:564`). `combination_of/2` is correct (:542). |
| 14 | 1156-1158 | The Tunez quote omits "nothing else" beyond the named sections | It also omits, without marking, `def next_year, do: Date.utc_today().year + 1` (tunez `lib/tunez/music/album.ex:88`), which the omitted `numericality` validation calls. |
| 15 | 1362-1365 (analysis) | `Ash.Scope` "removes four options from ~40 top-level functions" | The options are not removed. "the `actor`, `tenant` and `context` options will always remain available" (`lib/ash/scope.ex:7-9`). Explicit options override values taken from the scope ("Passing scope and options" section of `lib/ash/scope.ex`). Scope is an alternative way to pass them, not a replacement. |
| 16 | 1352-1353 (analysis) | "All six wrong lists failed the same way: I read a *file listing*" | Only the types list (and arguably the error count) came from a file listing. The changes, preparations and checks lists failed because `grep '  def '` misses `defmacro`, as Summary line 36 itself says. The expression function list was taken from the guide instead of `filter.ex:76-116`. |

Non-factual issue: the document is 10,020 words, above the 3,000-6,000 target in `_rules.md`. The document reports this honestly at line 1449.

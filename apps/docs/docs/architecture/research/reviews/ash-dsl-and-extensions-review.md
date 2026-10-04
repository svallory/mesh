---
title: "Review: Ash DSL and extension system"
description: "Independent fact-check of the Ash DSL and extension system document; final verdict ACCEPT."
---

# Review: ash-dsl-ext ([`notes/research/02-ash-dsl-and-extensions.md`](../ash-dsl-and-extensions.md))

> Review of: [Ash DSL and extension system](../ash-dsl-and-extensions.md).

VERDICT: ACCEPT


Reviewer: independent fact-check, 2026-10-01. Ground truth: clones under `scratch/ash-src/` (spark 2.7.3, ash 3.33.11, igniter 0.8.4, ash_state_machine 0.2.13, ash_paper_trail 0.7.0, ash_archival 2.0.3, ash_oban 0.9.0, ash_events 0.8.2; versions confirmed) plus `gh` and forum.elixirforum.com.
Paths below are relative to `scratch/ash-src/` unless they are URLs.

**Overall.** Most of the document is right: the structure, the inventories, the line counts and most citations. The case-study line counts are exact. But **seven high-severity mechanism errors** sit in exactly the parts that will shape mesh's extension architecture: verifier error handling, `after_compile?` timing, the semantics of `before?`/`after?` conflicts, the `Ash.Extension` behaviour (including `migrate/1`), the install hook, and a maintainer quote that was made up and that implication #1 relies on. The verdict is ACCEPT-WITH-FIXES only because every fix is a local edit. **All rows marked high must be fixed before anyone uses the document for design.**

---

## 1. Error table

| Doc line | Claim | What the source says | Sev |
|---|---|---|---|
| 46, 932, 1245 | `Ash.Resource` registers **21** transformers / "21 transformers and 28 verifiers" / "21 + 8 + 28" | 20 transformers, 8 persisters, **27** verifiers (`ash/lib/ash/resource/dsl.ex:1807-1828`, `:1830-1839`, `:1841-1869`). The doc's own list at 447-457 has 27 names under a "28 of them" heading. The status report says 20/8/28. Neither count is right. Fix all three places and the report. | medium |
| 857-860 (and 7.3 heading "confirmed in source", Summary 64-68, report) | "**There is no `migrate/1` callback on data layers.**" `codegen/1`/`setup/1`/`tear_down/1` are "plain public functions", "duck-typed, not a behaviour" | `Ash.Extension` (`ash/lib/ash/extension.ex:5-45`) is a behaviour whose **optional callbacks** are `migrate/1, reset/1, rollback/1, setup/1, tear_down/1, codegen/1, install/5`. `mix ash.migrate` calls `extension.migrate(argv)` if exported (`ash/lib/mix/tasks/ash.migrate.ex:19-28`), and so do `ash.rollback` (`ash.rollback.ex:19-29`), `ash.tear_down` (`:19-28`) and `ash.setup` (`:52-63`). AshPostgres implements `migrate/1` at `ash_postgres/lib/data_layer.ex:459` and `rollback/1` at `:464`. The accurate statement: the mix tasks *invoke* these duck-typed with `function_exported?/3`, a behaviour declares them as optional callbacks, and no extension in the clones declares `@behaviour Ash.Extension` (grep finds none). `name/0` is the only one that is not in the behaviour. The `reset/1` callback is declared, but `mix ash.reset` just runs `ash.tear_down` + `ash.setup` (`ash.reset.ex:15-16`), so nothing calls `reset/1`. | **high** |
| 852, 864-867 | `install/1` "via `Igniter.Mix.Task`"; `ash.gen.*`: "extensions are not automatically plugged into them" | The extension hook is `install/5` on `Ash.Extension` (`ash/lib/ash/extension.ex:28-34`). `mix ash.extend` calls `extension.install(igniter, module, kind, path, argv)` when it is exported (`ash/lib/mix/tasks/ash.extend.ex:178-180`), and `mix ash.gen.resource --extend …` composes `ash.extend` (`ash/lib/mix/tasks/gen/ash.gen.resource.ex:202-207`). Implementers: `AshPostgres.DataLayer` (`ash_postgres/lib/data_layer.ex:4854`), AshSqlite, AshGraphql Resource and Domain, AshJsonApi Resource and Domain, `Ash.Policy.Authorizer`. So extensions **are** plugged into resource generation. The Igniter callback is `igniter/1` (or `/2`), not `install/1` (`igniter/lib/mix/task.ex:32-36`). | **high** |
| 361-364, 1039 | Verifier hook steps: "2. runs the `after_compile?` transformers, 3. runs all verifiers"; catalogue row 9: "after compilation, **before verifiers**" | `__verify_spark_dsl__` runs the verifiers first. It runs the `after_compile?` transformers only when `final_errors == []`, i.e. **after** verifiers and only if they passed (`spark/lib/spark/dsl.ex:468-523`). Maintainer in spark#104: transformers with `after_compile?` are "called with specific transformers … not all transformers". | **high** |
| 363-364 | "on error: reraise a single `DslError` … or … `Multiple Errors Occurred`" (implying compilation fails) | The whole generated function has a `catch kind, reason` clause that turns any raised error into `Spark.Warning.warn` → `IO.warn` (`spark/lib/spark/dsl.ex:558-574`, `spark/lib/spark/warning.ex:35-54`). **Verifier errors do not fail compilation; they become stderr warnings.** Spark documents this: "Verifier errors raised inside Spark's `@after_verify` hook are caught by the framework and emitted as stderr warnings instead of propagated as exceptions" (`spark/documentation/how_to/test-spark-verifiers.md:9-12`, `spark/lib/spark/test.ex:9-13`). This is the reason `Spark.Test` exists, not a side detail. Transformer errors, in contrast, do abort compilation (`spark/lib/spark/dsl/extension.ex:704-722`). | **high** |
| 381-385, 1197 | Conflict is dropped only "if a transformer declares both `before?(_) -> true` and `after?(_) -> true`"; "cycles … degrade to declaration order" | (a) The drop rule is per pair: for any pair where `left.before?(right) \|\| right.after?(left)` **and** `left.after?(right) \|\| right.before?(left)` are both true, no edge is added (`spark/lib/spark/dsl/transformer.ex:410-418`). The pattern Ash's own guide recommends, "`after?(_) -> true` … except I go before `SomeOtherTransformer`" (`ash/documentation/topics/advanced/writing-extensions.md:128-136`), is therefore **silently discarded**. A real victim: `AshPaperTrail…RelateVersionResource` has `before?(SetRelationshipSource)` + `after?(_) -> true` (`ash_paper_trail/lib/resource/transformers/relate_version_resource.ex:29-32`), so its `before?` is dead. Ash core contains a mutual contradiction that gets dropped the same way: `SetPrimaryActions.after?(DefaultAccept)` (`ash/lib/ash/resource/transformers/set_primary_actions.ex:24`) and `DefaultAccept.after?(SetPrimaryActions)` (`default_accept.ex:190`). (b) "Declaration order" is wrong twice over. Ties among ready vertices are broken by `:digraph.vertices/1` order (ETS order), not declaration order (`transformer.ex:452`). When there is a cycle, the chosen vertex (the earliest-declared remaining one) and any sink are appended with `acc ++ [vertex]` to an accumulator that is reversed at the end (`transformer.ex:445-471`), so they land at the **front** of the final order, ahead of transformers already emitted. Reviewer's reading of the code; not executed. | **high** |
| 1171-1172 (analysis #1) | "issue #2670 … caused precisely by validating at entity-build time, and the maintainer's answer was 'do it in the verifier'" | The only maintainer comment (zachdaniel, 2026-04-09) says to "fix it on the caller end not to have a compile time dependency on the calling resource" by avoiding struct pattern matches in function heads, and that compile-time `init` "is much better". The issue was closed in the same minute (https://github.com/ash-project/ash/issues/2670). Verifiers are not mentioned anywhere. The cause was the new `init/1` callback, not validation. The quote is made up, and analysis #1 rests on it. §8.2 (901-919) quotes it correctly but leaves out that the issue was closed as a caller-side problem. | **high** |
| 69-73, 934-938 | spark#86: "a ~1k-line **resource** taking 30 s" listed as documented pain | The module is a SeedFactory schema (a non-Ash Spark DSL), not an Ash resource. The issue was **closed 2024-06-26** by the maintainer: "improvement on the order of 40s -> 6s" (https://github.com/ash-project/spark/issues/86). Say it was resolved. | medium |
| 959-1006 | Pain points #239, #103, #259, #94, #193, #29, #57, #78, #231 presented as current | All are **closed** (gh: #239 closed 2026-03-01, #103 2025-06-10, #259 2026-02-07, #94 2024-05-14, #193 same day with fix commit 30b45a7, #29 2024-03-19, #57 2023-09-04, #78 2024-02-29, #231 2025-10-30). Only #126 is marked "since fixed". Add the state and close date to every issue, and drop or downgrade the ones that are fixed. | medium |
| 1005 | "**#103/#78**: the formatter 'requires explicit compilation…'" | #103 is about long module names, not the formatter. Cite #78 alone. | low |
| 141, 560, 853 | `Spark.Dsl.Extension` behaviour "is only 8 callbacks" including `module_prefix/0`, `dsl_patches/0` | 7 callbacks: `sections, module_imports, transformers, verifiers, persisters, explain (optional), add_extensions` (`spark/lib/spark/dsl/extension.ex:137-145`). `module_prefix/0` and `dsl_patches/0` are generated functions, not callbacks (`:470-475`). | medium |
| 239-243 | InfoGenerator: "three families"; "plain returns `value \| :error`" | Plain option getters return `{:ok, value} \| :error` (`spark/lib/spark/info_generator.ex:204-229`). Boolean options also get a `?` predicate (`:175-190`). There is a **fourth** family: entity-list functions per section (e.g. `state_machine_transitions/1`) (`:95-115`). | medium |
| 392 | `DslError` has "exactly six attributes" (then lists five) | Five: `[:module, :message, :path, :stacktrace, :location]` (`spark/lib/spark/error/dsl_error.ex:7`). | low |
| 351-353 | "read-only" is enforced because "there are simply no write helpers in scope" | A verifier can still call `Spark.Dsl.Transformer.set_option/4` fully qualified. Read-only holds because `verify/1` returns only `:ok \| {:error,_} \| {:warn,_}` (`spark/lib/spark/dsl/verifier.ex:54-57`) and the result is discarded after compilation. Reword. | low |
| 420, 437-440 | Table header "What it does (from its `@moduledoc`)"; #17 `SetDefineFor` "fills `for` on code interface definitions"; #18 `SetEagerCheckWith` "fills `check_with` for eager loading"; #19 "fills `pre_check_with`" | `AddPeriodAttribute`, `SetInterfaceExcludeInputs`, `SetDefineFor`, `SetEagerCheckWith`, `SetPreCheckWith` all have `@moduledoc false`. `SetDefineFor` sets the `[:code_interface] :domain` option from the persisted domain (`set_define_for.ex:9-17`). `SetEagerCheckWith`/`SetPreCheckWith` set `eager_check_with`/`pre_check_with` on **identities** to the resource's domain and raise if no domain is set (`set_eager_check_with.ex:10-35`, `set_pre_check_with.ex:10-30`). This has nothing to do with eager loading. | medium |
| 434 | #13 `SetPrimaryActions` "validates the primary action configuration" | It also **adds the default actions** (`add_defaults/1`, `set_primary_actions.ex:27-28`). PaperTrail's comment quoted at 680 depends on this. | low |
| 427 | #6 `AddTemporalRelationshipFilters` "compile-time wiring of temporal filters onto relationships" | Also rejects accepting the period attribute as action input (`add_temporal_relationship_filters.ex:6-20, 29`). | low |
| 486 | `Ash.Reactor` patches **14** entities into "Ash's own `[:reactor]` section" | 13 entities (`ash/lib/ash/reactor/reactor.ex:42-56`), patched into the `[:reactor]` section of the **Reactor** library's DSL, not Ash's. | low |
| 535, 551-552 | "26 builders"; `add_new_*` "is what makes extensions idempotent" | 23 `defbuilder`s (the doc's own list has 23) plus 18 `build_*` helpers that are not listed (`ash/lib/ash/resource/builder.ex:23-703`). `add_change`/`add_preparation` have no `add_new_*` form, so AshArchival's and AshStateMachine's `add_preparation` calls are not idempotent. | low |
| 1086-1089 (open Q5) | "Whether [ReplaceEntity/DeleteEntity] landed under another name is unconfirmed" | Settled: the maintainer rejected it. "allowing extensions to overwrite entities by other extensions is a whole can of worms that we should avoid" (https://github.com/ash-project/spark/issues/83, closed 2024-03-30). Move it to facts: patches can only *add*. | medium |
| 1069-1077, 1039 | "**five** ecosystem modules" set `after_compile?` | Seven in the clones: 6 in AshGraphql (`ash_graphql/lib/resource/transformers/{validate_actions,validate_compatible_names,require_keyset_for_relay_queries}.ex:12`, `ash_graphql/lib/domain/transformers/{same three}.ex:12`) plus `ash_authentication/lib/ash_authentication/user_identity/verifier.ex:27`. | low |
| 56-58 | "between 3 and 8 extension points"; PaperTrail "is the ceiling" | Not supported. The doc's own per-study lists have about 7 to 14 items, and AshOban (5,196 lines) is larger than PaperTrail (3,827). Restate or remove. | low |
| 604, 1056 | "an `Ash.Check` `ValidNextState`"; row 26 "Check \| `Ash.Check` behaviour \| runtime, on a field \| pass/fail validation of one value" | No `Ash.Check` module exists in ash/lib. `AshStateMachine.Checks.ValidNextState` is a **policy check**, `use Ash.Policy.FilterCheck` (`ash_state_machine/lib/checks/valid_next_state.ex:5-9`). The contract is `Ash.Policy.Check` / `SimpleCheck` / `FilterCheck` (`ash/lib/ash/policy/{check,simple_check,filter_check}.ex`), and it runs during authorization, not "on a field". | medium |
| 598 | `EnsureStateSelected` adds a runtime preparation "to every action" | Global `preparations` apply to read actions (queries), not to every action. | low |
| 708-709 | `create_version_resource.ex:165-210` is the main generator; "a second `Module.create` at `:367` for the `temporal_inline` variant" | Reversed. `:165` is inside `create_inline_version_resource/1` (defined at `:28`). `:367` is in `create_version_resource/1` (defined at `:227`). | low |
| 727 | PaperTrail uses "`replace_entity` on actions" (fine), "per-extension `codegen`-adjacent options" | No codegen is involved. `version_extensions` just injects extensions into the generated resource. Remove "codegen-adjacent". | low |
| 765-766 | `AshEvents.EventLog` "itself creates a data-layer-backed resource" | There is no `Module.create` in `ash_events/lib`. EventLog is an extension applied to a resource the user writes. Its transformers add actions and attributes to it (`ash_events/lib/event_log/event_log.ex:152-155`). | low |
| 866 | "`AshPaperTrail` and `AshOban` ship their own extra tasks" | `ash_paper_trail/lib` contains no mix tasks. Only AshOban does (install, upgrade, set_default_module_names). | low |
| 1052 | Authorizer "14 callbacks" | 12 `@callback`s (`ash/lib/ash/authorizer.ex:17-84`). §4 lists 12 correctly. | low |
| 1058 | Row 28 contract "`Ash.Resource.Aggregate`, `Ash.Type`", example `Ash.Resource.Aggregate.Count` | `Ash.Resource.Aggregate.Count` does not exist (`ash/lib/ash/resource/aggregate/` has only `aggregate.ex`, `custom_aggregate.ex`). Calculation contract: `Ash.Resource.Calculation` behaviour (`resource/calculation/calculation.ex`). Custom aggregate contract: `Ash.Resource.Aggregate.CustomAggregate`. | medium |
| 1059 | Row 29 Interface: "runtime" | Code interfaces generate functions on the domain/resource at **compile time**. That cost is measurable: a forum thread shows 4148 ms vs 533 ms with and without `code_interface` (https://forum.elixirforum.com/t/73196). | medium |
| 1141 | Sources: `https://github.com/ash-project/spark/issues/2670` | Wrong repo. Should be `ash-project/ash/issues/2670`. | low |
| 368, 2.4 | "The docs say this explicitly (`writing-extensions.md`, 'Verifiers')" | That section is in **Spark's** `spark/documentation/how_to/writing-extensions.md:88-91`. Ash's guide has no Verifiers section. Fix the path. | low |
| 10-11 | spark `mix.exs:9`, ash `mix.exs:9` | `spark/mix.exs:8`, `ash/mix.exs:13`. | low |
| 895 | `no_depend_modules` at `entity.ex:70`, `section.ex:50` | `spark/lib/spark/dsl/entity.ex:87`, `spark/lib/spark/dsl/section.ex:44`. | low |
| 293-304 | Helper line numbers | Wrong-line-but-true: `get_persisted` is at `:148` (doc `:113`), `fetch_persisted` `:157` (`:124`), `build_entity!` `:166` (`:171`), `get_entities` `:301`, `fetch_option` `:310`, `get_option` `:342`, `remove_entity` `:290`, `get_opt_anno` `:332`. | low |
| 836, 848, 850-851 | AshPostgres `codegen` `:648`, `setup` `:653`, `tear_down` `:670` | `:649`, `:654`, `:671`. | low |
| 643-648 | AshArchival ordering shown as one-line attributes | The real source spreads these over several lines (`setup_archival.ex:10-17, 32-36`). Content is the same. Rule 5 says to copy code, not reformat it. Also "does four things" lists three. | low |

## 2. Recount results (check 2)

| List | Doc | Actual | Names/order match? |
|---|---|---|---|
| `Ash.Resource` transformers | 20 in table, **21** in Summary/§8.3/§10 | **20** (`dsl.ex:1807-1828`) | Yes, all 20 in order |
| `Ash.Resource` persisters | 8 | 8 (`:1830-1839`) | Yes |
| `Ash.Resource` verifiers | "28" (lists 27) | **27** (`:1841-1869`) | Yes, 27 names in order |
| `Ash.Domain` transformers | 2 | 2 (`domain/dsl.ex:198-201`) | Yes |
| `Ash.Domain` verifiers | 3 | 3 (`:192-196`) | Yes |
| Resource sections | 14 | 14 (`:1790-1805`) | Yes |

Also worth adding: there are 28 files in `transformers/` because 20 transformers + 8 persisters = 28. The researcher's "transformers/* (28)" is files, not transformers.

One-line descriptions checked against source (20 transformers + 4 persisters/verifiers = 24): **17 accurate**. Five transformers have `@moduledoc false` (so "from its moduledoc" is false for them). `SetDefineFor`, `SetEagerCheckWith` and `SetPreCheckWith` are wrong. `SetPrimaryActions` and `AddTemporalRelationshipFilters` are incomplete.

## 3. Compile-pipeline claims (check 3)

| Claim | Result |
|---|---|
| Transformers receive the dsl_state map and return `:ok \| {:ok,map} \| {:error,_} \| {:warn,map,w} \| :halt` | Correct (`spark/lib/spark/dsl/transformer.ex:60-68`, `extension.ex:747-812`). Missing: `:halt` stops the **whole** remaining list, persisters included, because persisters are concatenated into the same reduce (`extension.ex:693-711`). |
| Persisters sorted separately, ordering against transformers ignored | Correct (`extension.ex:693-702`; Spark moduledoc `:96-99`). |
| Verifiers in `@after_verify` | Correct (`dsl.ex:464`). They receive the compile-time `@spark_dsl_config` map, not the module. |
| Verifiers raise on error | **Wrong.** They are caught and turned into warnings (see error table). |
| `after_compile?` transformers before verifiers | **Wrong.** They run after, and only if there were no errors. |
| `before?`/`after?` via digraph | Correct as far as it goes. The pairwise-conflict drop and the cycle placement are described wrongly (see error table). |
| "Cycle broken silently" | True (no error, no warning). But the order it produces is not "declaration order". |
| Errors carry location | Correct: `location` + `Spark.Dsl.Entity.anno/1` + `__spark_metadata__`. Missing: the extension module's own `@after_verify Spark.Dsl.Extension` emits a **deprecation warning at extension compile time** for every entity target struct that lacks `__spark_metadata__` (`extension.ex:453, 2243-2262`), not only at read time. Also, with a location, transformer DslErrors are emitted as an extra diagnostic warning and then re-raised with an empty stacktrace (`extension.ex:713-722`). |

## 4. Issues (check 4)

- **ash#2670**: title and date (opened 2026-04-09 by joshprice, **closed** 2026-04-09T17:18:51Z) are right, and so is the trace excerpt (trimmed). The description "init/1 called at compile time from `transform/1`" is right. The "do it in the verifier" answer **does not exist** (see error table).
- **spark#290**: title, author jechol, opened 2026-08-24T05:19:04Z, **OPEN** as of 2026-10-01, no comments. Both quotes are verbatim. The proposal summary (consumption-site ownership, `Macro.compile_apply/4`, eventual removal of `no_depend_modules`) is accurate. Confirmed.
- spark#289: closed 2026-09-03. The doc says "closed". OK.

## 5. AshArchival stale names (check 5)

Both halves confirmed. `setup_archival.ex:10-17` lists `Ash.Resource.Transformers.ValidatePrimaryActions` (after) and `…SetTypes` (before). `grep -rn "SetTypes\|ValidatePrimaryActions" ash/lib` finds nothing. Note that the `DefaultAccept` entry in the same list is live. Under-reported: this is not the only dead ordering assertion. PaperTrail `RelateVersionResource.before?(SetRelationshipSource)` is dropped by the pairwise-conflict rule, and so is Ash core's `SetPrimaryActions`↔`DefaultAccept` pair.

## 6. Callbacks (check 6)

- Duck-typed invocation with `function_exported?/3`: **true** for `codegen/1`, `name/0` (`ash.codegen.ex:61-67`), `migrate/1`, `rollback/1`, `setup/1`, `tear_down/1`, `install/5`.
- "Rather than behaviour callbacks": **false**. `Ash.Extension` declares all of them except `name/0` as optional callbacks (`ash/lib/ash/extension.ex:21-44`).
- "No `migrate/1` data-layer callback": **false** (see error table).

## 7. Citation sample (check 10)

68 citations sampled across all sections.

| Judgement | Count | % |
|---|---|---|
| Supports | 43 | 63% |
| Wrong line, claim true | 14 | 21% |
| Does not support | 10 | 15% |
| Nonexistent | 1 | 1% |

**Supports:** `spark/lib/spark/dsl.ex:620-740`, `:464`, `:11-63`, `transformer.ex:398-473`, `:88`, `:98`, `:132`, `:273`, `:372`, `:104-106`, `ash/lib/ash/resource/dsl.ex:1807-1868`, `domain/dsl.ex:192-205`, `resource.ex:18-36`, `domain/domain.ex:27-34`, `ash.codegen.ex:60-76`, `extension.ex:425-477`, `:458-462`, `:634-727`, `:270`, `:322`, `:385`, `:747-828`, `:757-766`, `:693-702`, `:742-745`, `:100-110`, `ash_state_machine/lib/info.ex:7`, `ash_events/lib/events/events.ex:86-93`, `patch/add_entity.ex:1-24`, `strategies/custom.ex:117`, `setup_archival.ex:9-16`, `ash_paper_trail/lib/resource/resource.ex:26`, `define_schedulers.ex:12`, `:38-44`, `helpers.ex:70-76`, `development-utilities.md:23`, `spark.formatter.ex:35`, `elixir_sense/plugin.ex:14-45`, `test.ex:341-357`, spark#290 quotes, ash#2267 quote, Ash guide ordering quote, Spark tutorial quote.

**Wrong line:** transformer.ex `:113 :124 :171 :300 :317 :335 :289`, `verifier.ex:47-50` (callback at 54), `entity.ex:70`, `section.ex:50`, `data_layer.ex:648/653/670`, `create_version_resource.ex:165/367` (swapped), `spark/mix.exs:9`, `ash/mix.exs:9`.

**Does not support:** `extension.ex:137-145` (8 callbacks), `dsl_error.ex` (six attrs), `info_generator.ex:48-60` (return shape), `reactor.ex:41-59` (14 / Ash's section), `builder.ex` (26), `ash.codegen.ex` as proof that `migrate/1` does not exist, ash#2670 for "do it in the verifier", spark#86 for "resource, current pain", `dsl.ex:464-540` for the step order and the error outcome, `transformer.ex:414-417` for the conflict condition.

**Nonexistent:** `https://github.com/ash-project/spark/issues/2670`.

## 8. Acceptance criteria (check 11)

| # | Criterion | Status | Missing / wrong |
|---|---|---|---|
| 1 | Spark DSL definition | partial | Extension behaviour has 7 callbacks; InfoGenerator return shape and the 4th (entity) family. Otherwise good. |
| 2 | Compile pipeline + full lists | partial | Counts (20/27); verifier errors become warnings; `after_compile?` order; conflict-drop and cycle-placement semantics; `:halt` skips persisters; 5 wrong/incomplete one-liners. |
| 3 | Extending other DSLs | complete (minor errors) | Reactor 13 / Reactor's section; 23 builders + `build_*`; add the #83 rejection (patches can only add). |
| 4 | Kinds of extension | complete | Resource extensions use untyped `extensions:`, not `single_extension_kinds` (line 560). |
| 5 | Case studies | partial | See §9. Main gaps: dead ordering in PaperTrail, cross-extension writes in AddTemporalInlineAttributes, DefineSchedulers mutations and compile-time config read, ValidNextState is a policy check. |
| 6 | Free tooling | complete | Could add `mix spark.cheat_sheets_in_search`. Should note that the ElixirSense plugin does not work with Expert (forum, below). |
| 7 | Igniter and codegen | partial | `Ash.Extension` behaviour; `migrate/rollback/reset`; `install/5` via `ash.extend` / `ash.gen.resource --extend`; full `ash.gen.*` list (base_resource, change, custom_expression, domain, enum, gettext, preparation, resource, validation) plus `ash.install`, `ash.patch.extend`. |
| 8 | Pain points with evidence | partial | Most cited issues are closed/fixed but presented as current; #86 resolved; no forum evidence (now supplied below); the #2670 analysis is misattributed. |
| 9 | Catalogue | partial | Rows 9, 22, 26, 28, 29 are wrong; missing points listed in §10. |

## 9. Check 7: case studies

**AshStateMachine** (1,184 lines, confirmed). Transformers and verifiers are confirmed (`ash_state_machine/lib/ash_state_machine.ex:116-130`), and so are the per-file line counts. Fixes:
- `FillInTransitionDefaults` lives in `lib/transformers/fill_in_event_defaults.ex`. It also rewrites `initial_states` with `set_option` (`:28-33`).
- `ValidNextState` is an `Ash.Policy.FilterCheck`.
- Missing pieces: `lib/charts.ex` (76), `lib/clarity/state_machine_diagram.ex` (51), `lib/mix/generate_flow_charts.ex` (101).
- Undeclared ordering dependency: `AddState` reads `default_initial_state`, which `SetDefaultInitialState` sets, but neither declares ordering against the other. `AddState` declares only `after?(FillInTransitionDefaults)` and `before?(DefaultAccept)` (`add_state.ex:11-15`). The order depends on the digraph tie-break. Reviewer's inference; this case-study example of the ordering problem is worth more than the AshArchival one.

**AshArchival** (430, confirmed). One transformer, no verifiers (`resource.ex:78-80`). Omitted: an Info module (`resource/info.ex`, 8 lines) and the bail-out on `embedded?` (it is mentioned in prose).

**AshPaperTrail** (3,827, confirmed; all six transformers, the verifier and their line counts confirmed).
- `AddTemporalInlineAttributes`, read in full (188 lines). The doc says only "stamps version attributes on the resource itself". It actually:
  1. builds and adds `version_action_type`, optional `version_action_name`, `version_action_inputs`, `changes` (`sensitive?` derived from the source attributes), the operation-id field, and every `metadata` entity as attributes, with `writable?: false` (`:36-95`);
  2. adds a `belongs_to` **relationship** per `belongs_to_actor`, with `temporal_keys` and a hand-set `source` (`:97-136`);
  3. **writes a `reference` entity into another extension's section**, AshPostgres `[:postgres, :references]` or AshSqlite `[:sqlite, :references]`, through `build_entity(extension, path, :reference, …)`, with the data-layer module names hard-coded (`:138-175`). This is cross-extension mutation without `dsl_patches`: a key extension point the catalogue does not mention;
  4. declares `before?(BelongsToAttribute)` and `before?(SetRelationshipSource)` so that core generates the FK attribute (`:22-24`);
  5. returns a `DslError` on name conflicts with path `[:paper_trail, :mode]` (`:177-187`).
- `RelateVersionResource`: its `before?(SetRelationshipSource)` is dead because of `after?(_) -> true`.
- `CreateVersionResource`: the `Module.create` citations are swapped (see error table).
- The domain transformer `AllowResourceVersions` calls `Spark.extensions(resource)` and `AshPaperTrail.Resource.Info.version_resource?(resource)` on **other compiled modules** from inside a transformer (`ash_paper_trail/lib/domain/transformers/allow_resource_versions.ex:16-20`). That is a compile-time cross-module dependency of exactly the kind §8.1 discusses, and the doc should flag it.

**AshOban** (5,196, confirmed; transformer/verifier lists and line counts confirmed). `DefineSchedulers`, read in full (1,715 lines). Missed or wrong in the doc:
- It **mutates the DSL**: `replace_entity([:oban, :triggers], …)` fills `scheduler:` and `worker:` module names on every trigger (`define_schedulers.ex:30-35`). `DefineActionWorkers` does the same for `scheduled_actions` (`define_action_workers.ex:26-29`). The doc says only "generates a worker module".
- The **worker** is created synchronously with `Module.create`. Only the **scheduler** goes through `async_compile` (`:28, :36-43`). The doc implies everything is async.
- There are three generators, not two: the scheduler (`:57-294`), a standard worker (`:433-697`), and an Oban Pro **chunk worker** when `trigger.chunks` is set (`:306-430`).
- It reads **application config at compile time with `Application.get_env`**: `AshOban.Info.pro?()` (`ash_oban/lib/info.ex:11-13`, used at `define_schedulers.ex:61, 435`). Generated code switches between `Oban.Worker`/`perform` and `Oban.Pro.Worker`/`process`. Because this is not `compile_env`, changing `:pro?` does not trigger recompilation (reviewer's inference from Elixir semantics). This is a real pain point.
- It reads data-layer **capabilities at compile time**: `Ash.DataLayer.data_layer_can?(dsl, :transact)` and `{:lock, :for_update}` decide whether to emit locking and transaction code (`:446-491`).
- It **validates inside the transformer** (raises `DslError` if the `on_error` action is missing, `:448-457`), not in a verifier.
- The bulk of the file is generated error handling (`handle_error/6`, `:699-1008`: on the final attempt, call the `on_error` action via `bulk_update!`/`bulk_destroy!` when atomic, otherwise re-read the record and run the action) and `work/8` / `work_chunk/7` (`:1026-1715`), which run the trigger action, generic actions included (`Ash.run_action!`, `:1068-1081`).
- The DSL also has a `schedule` entity under `scheduled_actions` (`ash_oban.ex:549`), which the doc omits.

## 10. Check 8: catalogue

Every row's contract name was checked. Nonexistent names: row 26 `Ash.Check`, row 28 `Ash.Resource.Aggregate.Count`. Wrong timing: row 9 (it runs after verifiers) and row 29 (it is compile time). Wrong count: row 22 (12 callbacks). Row 1's cited `ash_state_machine.ex:71-107` is fine. Row 15 (`dsl.ex:178-181`) is fine. The other rows are correct.

**Missing extension points** (all exist in `ash/lib/ash/` unless noted):
1. `Ash.Extension` optional callbacks `migrate/1`, `rollback/1`, `reset/1`, `install/5` (mix-task time). `install/5` is invoked by `mix ash.extend`.
2. `Ash.Type` / `Ash.Type.NewType` (custom types), with compile-time `init/1` on constraints.
3. `Ash.Resource.Calculation` behaviour (`resource/calculation/calculation.ex`), runtime.
4. `Ash.Resource.Aggregate.CustomAggregate` (`resource/aggregate/custom_aggregate.ex`), runtime.
5. Manual actions: `Ash.Resource.ManualRead`, `ManualCreate`, `ManualUpdate`, `ManualDestroy` (`resource/manual_actions/`), runtime.
6. `Ash.Resource.ManualRelationship` (`resource/manual_relationship/`), runtime.
7. Generic action implementations: `Ash.Resource.Actions.Implementation` (`resource/actions/action/`), runtime.
8. Policy checks: `Ash.Policy.Check`, `SimpleCheck`, `FilterCheck`, run at authorization time. This should replace row 26.
9. `Ash.CustomExpression` (`custom_expression.ex`), compile-time registration with run-time evaluation.
10. `Ash.Tracer` (`tracer/`), runtime.
11. Cross-extension entity writes via `Transformer.build_entity(OtherExtension, path, …)` + `add_entity` (PaperTrail → AshPostgres references): compile time.
12. `Spark.Dsl.Entity` `recursive_as`, and `Spark.Dsl.Section` `after_define` (`spark/lib/spark/dsl/entity.ex:72`, `section.ex:40`): compile time.
13. `Spark.Dsl.Extension` `explain/1` (optional callback that contributes to the generated `@moduledoc`): compile time.

## 11. Check 12: forum pain points (forum.elixirforum.com; the old host 302-redirects there, and its Discourse `search.json` / `t/<id>.json` endpoints work)

1. **Code interfaces dominate compile time.** sezaru, 2025-11-05: a resource compiled in 4148 ms with `code_interface` and 533 ms without; the domain took 3719 ms vs 368 ms. zachdaniel admitted "the code interface logic is not really the greatest macro code anyone ever wrote" and shipped improvements on 2025-11-15. https://forum.elixirforum.com/t/using-code-interface-makes-resource-slow-to-compile/73196
2. **Resources taking over 30 s to compile.** sezaru, 2025-08-28. zachdaniel's advice: "remove as many anonymous functions from your resources as possible"; whether fragments help is "heard … but I haven't confirmed it". https://forum.elixirforum.com/t/strategies-to-make-resources-compile-faster/72265
3. **Incremental recompiles growing to 8–10 s** in an Ash/Phoenix app. joangavelan, 2025-08-15. The replies offer only generic `mix xref` cycle advice. https://forum.elixirforum.com/t/reducing-incremental-compilation-times-in-phoenix-ash-project/72113
4. **Editor support: no Spark DSL completion in Expert, the new official Elixir LSP.** zachdaniel, 2026-02-27: "the spark extension that we wrote for ElixirLS/elixir_sense does not work with expert unfortunately". katafrakt, 2026-03-01, explains why a fallback is not viable for completion. https://forum.elixirforum.com/t/expert-lsp-compatibility/74451. This updates §8.7: the single-vendor problem is now a live regression, not only issue #94 from 2024.
5. **An extension cannot add to core's computed defaults; you must copy core transformer logic.** zachdaniel, 2024-09-23, on adding a field to `default_accept`: "the way it's designed is not conducive to that change … copy the logic from our core transformer". He also says to order with `before?(Ash.Resource.Transformers.DefaultAccept)`. https://forum.elixirforum.com/t/how-do-i-set-default-accepts-to-a-resource-through-ash-extension-transformer/66257
6. **An extension cannot add an option to another extension's entity** (e.g. `cached? true` inside `read`). zachdaniel, 2024-01-12: "won't be possible with the current DSL extension options"; he recommends studying AshArchival as the template. https://forum.elixirforum.com/t/inputs-on-cache-layer-extension-for-read-actions/60933. This corroborates spark#83: patches can only add top-level entities.
7. **Builder/transformer authoring friction and misleading errors.** kamaroly, 2024-09-06: the maintainer-suggested `add_new_relationship(..., filter: expr(...))` "was not working … the error message says it requires filter options even if it has been passed". https://forum.elixirforum.com/t/how-to-extract-a-relationship-into-a-separate-module-for-reuse-in-ash/65890
8. **Learning Spark means reading other extensions.** steele232, 2026-03-17: got a first DSL working only after "cloning down ash_graphql to take a closer look at that DSL extension and also the Ash DSL". https://forum.elixirforum.com/t/trying-spark-for-the-first-time-and-dsl-doesnt-seem-to-be-recognized/74684. Also on error quality: At7heb, 2024-10-20, a duplicate `use Ash.Domain` produced "def can?/3 defines defaults multiple times" pointing at the `defmodule` line; zachdaniel agreed it should be detected. https://forum.elixirforum.com/t/misleading-error-message-def-can-3-defines-defaults-multiple-times/66875

Remove the "Not found: ElixirForum unreachable" note (line 1020) and open question 6.

## 12. Required fixes, in priority order

1. Rewrite §7.3 and the Summary bullet on codegen: the `Ash.Extension` behaviour, its optional callbacks, `migrate/1` exists, `install/5` via `ash.extend` / `ash.gen.resource --extend`. Update the status report too, which repeats the false claim.
2. §2.4 and catalogue row 9: verifier errors are caught and emitted as warnings; `after_compile?` transformers run after verifiers and only when there are no errors.
3. §2.5, §8.4 and analysis #4: the pairwise-conflict drop (including the guide's own documented pattern, PaperTrail's dead `before?`, core's SetPrimaryActions/DefaultAccept pair), the tie-break by digraph order, and the cycle-break vertex placed at the front.
4. Analysis #1: remove "do it in the verifier"; restate #2670 as the maintainer's caller-side fix, closed.
5. Counts: 20/8/27 everywhere (Summary, §8.3, §10, report).
6. State and close date for every cited issue; mark #86 as resolved.
7. The remaining medium and low rows in §1, plus the §9 case-study additions and the §10 catalogue additions.

---

## Round 2 re-verification

Re-checked on 2026-10-01 against the revised document (1,778 lines, 14,319 words, with a revision log). Line numbers below refer to the **revised** document. Paths are relative to `scratch/ash-src/`.

**Verdict: ACCEPT-WITH-FIXES.** All seven high findings are now fixed correctly *in substance*: I re-read the source for each one, not only the new text. The rewritten mechanism sections read the code correctly, and the "read from code, not executed" caveat appears where it should (§2.5 lines 484-486, §5.1 line 739, §5.4 lines 979-980, Open Q6). What is left is medium and low. The two things to take seriously:
- The revision log claims "fixed" for at least four items that were **not changed** in the text.
- The new catalogue rows name **example modules that do not exist**.

### R2.1 High findings: status

| Round-1 finding | Status | Note |
|---|---|---|
| `Ash.Extension` behaviour, `migrate/1`, duck-typed invocation | **Fixed, correct** | §7.3 matches `ash/lib/ash/extension.ex:21-44` and the task files. The callers table is right, and so is "`reset/1` never invoked". |
| `install/5` via `ash.extend` / `ash.gen.resource --extend`; Igniter callback is `igniter/1` | **Fixed, correct** | `ash.extend.ex:178-186` verified, including the fallback to `simple_add_extension`. |
| Verifier errors become warnings; transformer errors abort | **Fixed, correct** | `dsl.ex:558-574`, `extension.ex:704-722`. The Spark doc quote is verbatim. |
| `after_compile?` runs after verifiers, only on success | **Fixed, correct** | `dsl.ex:521-523`. |
| Ordering: pairwise-conflict drop, tie-break, cycle placement | **Fixed, reading correct**, but one wrong consequence and wrong line numbers (R2.2 #1, #2) | |
| ash#2670 invented quote | **Fixed**; the analysis no longer depends on it. The quote is not fully verbatim (R2.2 #5). | |
| Counts 20/8/27 | **Mostly fixed**; one stray "21" left (R2.2 #3) | |

### R2.2 Still wrong (fix each as stated)

| # | Doc line | Problem | Correct statement / source | Sev |
|---|---|---|---|---|
| 1 | 446, 840 | "leaving `X` unordered with respect to **everything**"; `RelateVersionResource` "is unordered relative to everything" | Only the edge to the one named transformer is dropped. Every other pair still gets an edge from `after?(_) -> true`, so `X` stays after all the others (`spark/lib/spark/dsl/transformer.ex:418-433`). Write: "unordered relative to `SomeOtherTransformer` (resp. `SetRelationshipSource`) only; still after every other transformer." | medium |
| 2 | 431-433, 447, 465-474 | Line citations in §2.5 are off by 3 to 5 | Conflict branch `:418-419` (doc `:415-416`); "annoying" comment `:415-417` (doc `:412-414`); `walk_rest` `:444-473` (doc `:439-471`); reverse `:447` (doc `:442`); cycle `min_by` `:455-460` (doc `:453-457`); sink append `:464` (doc `:460-461`); prepend `:469` (doc `:467-468`). The reading is right. | low |
| 3 | 1265-1266 | "`Ash.Resource.Dsl` … lists all **21** transformers and 27 verifiers" | 20 transformers (`ash/lib/ash/resource/dsl.ex:1807-1828`). | medium |
| 4 | 156-157 | Leftover sentence "The behaviour itself … is only **8** callbacks", which contradicts line 141 a few lines above | Delete it. The behaviour has 7 callbacks (`spark/lib/spark/dsl/extension.ex:137-145`). | medium |
| 5 | 1240-1248 | Presented as "verbatim", but it is not: `somethign = %Something%` is altered (original `somethign = %Something{}`), and the three code blocks are collapsed into prose without ellipsis markers. 1224: "29 minutes apart, by joshprice": the issue was opened 16:48:51 and closed 17:18:51, which is **30** minutes, and joshprice only opened it. | Copy the comment exactly from https://github.com/ash-project/ash/issues/2670, keeping the code as code, or drop the word "verbatim". Say "opened by joshprice; closed 30 minutes later, at the same timestamp as zachdaniel's comment". | medium |
| 6 | 1474-1489 (catalogue) | **Example users that do not exist** (grep over all clones finds no `defmodule`): `AshGraphql.ManualCreate` (row 28c), `AshGraphql.CustomExpression` (37), `AshGraphql.ManualRelationship` (38), `Ash.Money` (36; the real module is `AshMoney.Types.Money`, `ash_money/lib/ash_money/types/money.ex:5`), `Ash.Tracer.Telemetry` (40; `ash/lib/ash/tracer/` has only `simple.ex` and `tracer.ex`). Row 39 gives `Ash.Reactor` as an `Ash.Resource.Actions.Implementation` user: no reactor module uses it (`grep` matches only `scope.ex`, `actions/action.ex` and the implementation files). Row 42 "used in deeply nested aggregate schemas" and row 43 "used to inject shared helper macros" are made up. | Replace them with real users or write "no example in the clones". Real ones: row 36 `Ash.Type.UUID` (`ash/lib/ash/type/uuid.ex`) and `AshMoney.Types.Money`; row 28b `AshPostgres.CustomAggregate` (correct, keep it); row 40 `Ash.Tracer.Simple` (`ash/lib/ash/tracer/simple.ex`); row 42 `recursive_as: :policies` (`ash/lib/ash/policy/authorizer/authorizer.ex:266`) and `recursive_as: :steps` (`ash/lib/ash/reactor/dsl/transaction.ex:57`); row 43 `Ash.TypedStruct` `after_define: {__MODULE__, :after_define}` (`ash/lib/ash/typed_struct.ex:146`). Row 42's citation is `entity.ex:74`, not `:72`. | **medium** |
| 7 | 529-530, 549, 555-557 | "rows 1, 16, 17, 18, 19 all carry `@moduledoc false`" | Wrong rows. `RequireStringLengthCountConfig` (row 1) **has** a moduledoc (`require_string_length_count_config.ex:6-10`). The five with `@moduledoc false` are rows **5** (`AddPeriodAttribute`, `add_period_attribute.ex:8`), 16, 17, 18, 19. Row 16 cites `dsl.ex:1807-1828` as evidence for `@moduledoc false`; cite `set_interface_exclude_inputs.ex:6`. The column header at 532 still says "(from its `@moduledoc`)". Rename it "What it does". | medium |
| 8 | 812-813 | "(The real module is `RequireStringLengthCountConfig`, and there is no `SetTypes` at all.)" | No source, and implausible: validating primary actions is done by `SetPrimaryActions` (`set_primary_actions.ex:6-10`). Delete the parenthetical or cite a commit that shows the rename. | medium |
| 9 | 1217-1218 | `no_depend_modules` at `entity.ex:70`, `section.ex:50`. The revision log (#24) says fixed. It is not. | `spark/lib/spark/dsl/entity.ex:87`, `spark/lib/spark/dsl/section.ex:44`. | low |
| 10 | 313-324 | Helper-table line numbers unchanged. The revision log (#24) claims "the eight `transformer.ex` helper lines" were corrected. They were not. | `get_entities` `:301`, `fetch_option` `:310`, `get_option` `:342`, `remove_entity` `:290`, `build_entity!` `:166`, `get_persisted` `:148`, `fetch_persisted` `:157`, `get_opt_anno` `:332`. | low |
| 11 | 1084, 1477-1478 | Still `ash_postgres/lib/data_layer.ex:648-651`, `:653-670` (§7.2, catalogue rows 30-31). The log says moved to 649/654/671. Rows 30-31 still call these "duck-typed plain functions" with no mention of the behaviour. | `codegen` `:649-652`, `setup` `:654-670`, `tear_down` `:671-674`. Rows 30-31: "optional `Ash.Extension` callbacks, invoked duck-typed", or merge them into row 34. | low |
| 12 | 779-780 | Still "which does **four** things" with three listed. The log (#28) says fixed. | "three things". | low |
| 13 | 1572 | spark#104 "closed 2024-07-13" | Closed 2024-07-07T08:17:51Z (`gh issue view 104 --repo ash-project/spark`). | low |
| 14 | 1022 | `mix spark.cheat_sheets_in_search` "now **only** emits a deprecation warning" | It warns, then still runs: `Mix.Task.run("compile")` and the old logic follow (`spark/lib/mix/tasks/spark.cheat_sheets_in_search.ex:11-26`). Say "deprecated; warns, then still runs". | low |
| 15 | 254, 261 | "**four** families" over a five-row table. The example `state_machine_temporal_inline?(r)` does not exist (the `state_machine` section has no such option). | Say "five kinds (options getter / bang / `?` predicate / `_options` map / entity list)". Use a real predicate, e.g. `paper_trail_temporal_inline?` if it exists in `AshPaperTrail.Resource.Info`, or `archive_base_filter?` (`AshArchival.Resource.Info`, called at `ash_archival/lib/ash_archival/resource/preparations/filter_archived.ex:12`). | low |
| 16 | 858-860 | AddTemporalInlineAttributes citations: module-name matching "`:164-166`", build/add "`:138-162`" | Matching is at `add_temporal_inline_attributes.ex:171-175`; `build_entity(extension, path, :reference, …)` + `add_entity` at `:140-169`. The substance is correct (verified line by line). The §5.3 table cell at 841 says "four different things" but five are listed. | low |
| 17 | 936 | PaperTrail "`replace_entity` on actions **and triggers**" | Triggers belong to AshOban. PaperTrail only replaces actions (`set_operation_id.ex:63`). | low |
| 18 | 83-84 | Summary: forum threads "document … **dead ordering assertions**" | No forum thread is about dead ordering assertions; that finding comes from source reading. Remove those words from the forum clause. | low |
| 19 | 1290 | "The three concrete casualties:" over a four-row table | "four". | low |
| 20 | 733 | `ensure_state_selected.ex:5` | The comment is at `:6`. | low |

### R2.3 New round-2 material: verification

- **AddTemporalInlineAttributes** (§5.3, 846-872): every point is confirmed against `ash_paper_trail/lib/resource/transformers/add_temporal_inline_attributes.ex`. That includes the cross-extension `reference` write via `Transformer.build_entity(extension, path, :reference, …)` with hard-coded `AshPostgres.DataLayer` / `AshSqlite.DataLayer` matching and no `dsl_patch`. Only the line numbers are off (#16).
- **DefineSchedulers** (§5.4, 962-989): all four points and every cited line range confirmed (`:28`, `:30-35`, `:36-43`, `:57-294`, `:306-430`, `:433-697`, `:61/:435`, `:206-213`, `:446`, `:471`, `:448-457`, `:699-1008`, `:1068-1081`; `ash_oban/lib/info.ex:11-13`). The `get_env` vs `compile_env` consequence carries the caveat.
- **AllowResourceVersions** compile-time cross-module calls: confirmed (`allow_resource_versions.ex:18-19`).
- **Nine forum threads:** all authors, dates and quoted text checked against `https://forum.elixirforum.com/t/<id>.json`. All correct, including the two new quotes in thread 73196 (#7 DGollings 2025-11-16 "from ~32s to ~9s"; #8 sezaru 2025-11-17 "From 18 seconds in a resource to around 6s"). The spark#86 maintainer quotes ("sleeping in a genserver loop", "pathologically strange") are verbatim.
- **Issue states and close dates:** #290 open; #289, #86, #239, #103, #259, #94, #193, #29, #57, #126, #78, #231, #38, #83, #54 all match `gh`. Only #104 is wrong (#13).

### R2.4 Catalogue

- `Ash.Check` and `Ash.Resource.Aggregate.Count` are removed as contracts. Row 28b mentions Count only to say it does not exist, which is fine.
- Added and correct: rows 26 (policy check), 28/28b/28c, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, all with real contract paths.
- "When it runs" is now right for every row (9 → after verifiers; 29 → compile time; 36 → compile-time `init` then runtime; 37 → compile-time registration, runtime evaluation).
- Still wrong: the **example users** in #6 above, and the row 30-31 wording in #11.

### R2.5 Counts

20 / 8 / 27 is consistent in the Summary (50), §2.7 (527, 563), §4, Sources (1537) and analysis #10 (1715). The one exception is line 1265 (#3).

### R2.6 Low findings, sampled (half of round 1's low rows)

Fixed and correct: DslError 5 attributes; read-only wording; Reactor 13 / its own section; 23 builders + 18 `build_*` (lines 214/261 verified); `after_compile?` users = 7; untyped `extensions:`; authorizer 12; AshEvents has no `Module.create`; EnsureStateSelected affects read actions only; CreateVersionResource `:165`/`:367` un-swapped; `mix.exs:8`/`:13`; PaperTrail ships no tasks; `:halt` skips persisters; `__spark_metadata__` deprecation warning; empty-stacktrace re-raise.

Not fixed despite the log: helper lines (#10), `no_depend_modules` lines (#9), "four things" (#12), AshPostgres lines in §7.2 and rows 30-31 (#11).

### R2.7 Fresh citation sample (30 citations not checked in round 1)

| Judgement | Count |
|---|---|
| Supports | 22 |
| Wrong line, claim true | 6 |
| Does not support | 2 |
| Nonexistent | 0 |

Supports: `add_state.ex:25-30`; `fill_in_event_defaults.ex:28-33`; `setup_archival.ex:23-29`; `add_temporal_inline_attributes.ex:36-95`; `:97-136`; `allow_resource_versions.ex:16-20`; `define_schedulers.ex:30-35`; `:306-430`; `:206-213`; `:479-497`; `:699-1008`; `ash_oban/lib/info.ex:11-13`; `ash_oban.ex:549`; `spark/lib/spark/dsl/extension.ex:2243-2262`; `:713-722`; `spark/lib/spark/dsl.ex:557-574`; `test-spark-verifiers.md:9-12`; `warning.ex:35-54`; `ash/lib/mix/tasks/ash.extend.ex:178-186`; `igniter/lib/mix/task.ex:32-36`; `builder.ex:214`/`:261`; `info_generator.ex:204-229`.

Wrong line: `ensure_state_selected.ex:5` (→6); `add_temporal_inline_attributes.ex:164-166` (→171-175); `:138-162` (→140-169); `entity.ex:72` (→74); `dsl.ex:517-521` (→521-523); the `transformer.ex` walk lines in §2.5 (see #2).

Does not support: `spark.cheat_sheets_in_search.ex:11-25` for "only emits a warning" (#14); spark#104 close date (#13).

Separately, the catalogue names **5 nonexistent example modules plus 3 made-up or unsupported usage claims** (#6). They are not counted in the 30 above.

### R2.8 Required before final acceptance

1. Fix #1 (the ordering consequence is a mechanism claim), #6 (made-up catalogue examples), #7, #8, #3, #4, #5.
2. Fix the four items the revision log marks as done but which are not (#9-#12), then correct the log.
3. The rest are one-line fixes.

---

## Round 3 final check

Checked on 2026-10-01 against the round-3 document (1,842 lines, 15,302 words; revision log "Round 2" amended, "Round 3" added). Line numbers below refer to this version. Paths are relative to `scratch/ash-src/`.

**Final verdict: ACCEPT.**
- The mechanism sections are now correct: `Ash.Extension`, verifier errors becoming warnings, the `after_compile?` timing, the pairwise-conflict rule and its scope, and cycle handling. They match source, and the "read from code, not executed" caveat appears where it applies (§2.5 lines 488-490, §5.1, §5.4, Open questions).
- All 20 round-2 items are addressed. 18 are fixed correctly; 2 are fixed with a new or leftover defect (see R3.1).
- The amended round-2 log now honestly records the four claims that were false before.
- What remains is a short list of citation, naming and code-labelling errors. None changes a mechanism. Readers can rely on the document **together with the residual-errors list below**.

### R3.1 Round-2 items

| # | Item | Status |
|---|---|---|
| 1 | Ordering consequence | **Fixed correctly** (lines 448-451, 844). Only the edge to the named transformer is dropped. `X` still runs after every other transformer (`spark/lib/spark/dsl/transformer.ex:414-433`). |
| 2 | §2.5 line citations | **Fixed** (`:418-419`, `:415-417`, `:444-473`, `:447`, `:455-460`, `:464`, `:469` all verified). |
| 3 | stray "21" | **Fixed** (line 1290). |
| 4 | "only 8 callbacks" leftover | **Fixed** (deleted). |
| 5 | ash#2670 comment and timing | **Fixed correctly.** The quote matches the comment text exactly, code included, and the comment URL `#issuecomment-4216132881` exists (`gh api repos/ash-project/ash/issues/2670/comments`). "30 minutes apart; opened by joshprice, closed at the same timestamp as zachdaniel's comment" is accurate. The trace block above it (1234-1239) is still an abridged excerpt with no label (R3.3). |
| 6 | Catalogue example modules | **Mostly fixed.** Verified to exist: `AshMoney.Types.Money`, `Ash.Test.Expressions.JaroDistance` (uses `Ash.CustomExpression`), `…PolicyComplex.User.Relationships.BestFriend` (uses `Ash.Resource.ManualRelationship`), `Ash.Resource.Action.ImplementationFunction` (uses `Ash.Resource.Actions.Implementation`), `Ash.Tracer.Simple`, the `recursive_as` and `after_define` users. **Fixed wrongly:** row 28c names `Ash.Resource.ManualCreateFunction`, which does not exist (residual list). |
| 7 | `@moduledoc false` rows | **Fixed** (rows 5, 16-19; row 1 has a moduledoc). |
| 8 | invented parenthetical | **Fixed** (deleted). |
| 9 | `no_depend_modules` lines (previously claimed but not done) | **Fixed** (`entity.ex:87`, `section.ex:44`, line 1222). |
| 10 | helper-table lines (previously claimed but not done) | **Fixed** (lines 315-326 all verified). |
| 11 | AshPostgres lines and rows 30-31 (previously claimed but not done) | **Fixed** (`:649-652`, `:654-670`, `:671-674`). Row 30 now has a small new contradiction (residual list). |
| 12 | "four things" (previously claimed but not done) | **Fixed** (line 784). |
| 13 | spark#104 date | **Fixed** (2024-07-07). |
| 14 | cheat_sheets_in_search | **Fixed.** |
| 15 | InfoGenerator kinds and example | **Fixed** (`archive_base_filter?/1` is real, called at `filter_archived.ex:14`). Small wording slip (residual list). |
| 16 | AddTemporalInlineAttributes lines | **Fixed in §5.3**, but catalogue row 41 still has the old citation (residual list). |
| 17-20 | triggers, forum summary, "four casualties", `ensure_state_selected.ex:6` | **Fixed.** |

### R3.2 Catalogue (all 44+ rows)

Every contract name exists in source: `Spark.Dsl.Section/Entity/Transformer/Verifier/Fragment/Builder/InfoGenerator`, `Spark.Dsl.Patch.AddEntity`, `Ash.DataLayer`, `Ash.Authorizer`, `Ash.Notifier`, `Ash.Resource.Change/Preparation/Validation/Calculation`, `Ash.Resource.Aggregate.CustomAggregate`, `Ash.Resource.Manual{Read,Create,Update,Destroy}`, `Ash.Resource.Interface`, `Ash.Extension`, `Ash.Type`/`NewType`, `Ash.CustomExpression`, `Ash.Resource.ManualRelationship`, `Ash.Resource.Actions.Implementation`, `Ash.Tracer`, `Ash.Policy.Check/SimpleCheck/FilterCheck`, `Igniter.Mix.Task`.

The two fixes the researcher reported are confirmed: `Ash.Notifier.PubSub` (`ash/lib/ash/notifier/pub_sub/pub_sub.ex:5`; §4 line 704 and row 23) and `Mix.Tasks.AshOban.Install` (`ash_oban/lib/mix/tasks/ash_oban.install.ex:30`).

"When it runs" is correct for every row.

Remaining name problems: row 28c (nonexistent module); row 28's example is the contract itself; row 30 calls `name/0` an `Ash.Extension` callback. All three are in the residual list.

### R3.3 Code blocks

None is labelled "(abridged)". Verbatim, or abridged with visible `...`/`…` placeholders: 148-154 (verifiers), 428-431, 774-781, 796-811 (verbatim), 891-914 (top verified verbatim against `create_version_resource.ex:367-379`, then `…`). **Not verbatim and not labelled** (residual list):
- 210-215 (map example: the `persist:` line is not in the source guide);
- 299-306 and 371-373 (callback specs reformatted);
- 351-358 (the `if transform? do` wrapper is omitted);
- 503-507 (DslError output constructed; the tutorial's real output has no location);
- 636-648 (fragment example invented; the Spark guide uses a DataLayer/postgres fragment);
- 1075-1083 (codegen loop simplified);
- 1104-1123 (`@optional_callbacks` collapsed onto one line);
- 1234-1239 (trace with lines dropped).

126-136 is an illustrative composite. None of these changes a stated mechanism.

### R3.4 Counts

20 / 8 / 27 appears consistently: lines 50, 531, 568, 1290-1291, 1562, 1740. No "21" or "28 verifiers" remains outside the revision log, which quotes the old values on purpose.

### R3.5 Fresh citation sample (25, none checked in earlier rounds)

| Judgement | Count |
|---|---|
| Supports | 14 |
| Wrong line, claim true | 9 |
| Does not support | 1 |
| Nonexistent | 1 |

Supports: `spark/lib/spark/info_generator.ex:48-60`; `ash_postgres/lib/data_layer.ex:438-455`; `spark/lib/spark/dsl.ex:702-741`; `dsl.ex:724-734`; `ash_state_machine/lib/ash_state_machine.ex:23-49`; `:129`; `ash_archival/.../filter_archived.ex:14`; the AshArchival Info is an InfoGenerator over `[:archive]`; ash#2670 comment URL; `ash_oban.install.ex:30-45`; `pub_sub.ex:5`; `implementation_function.ex:5-7`; `best_friend.ex:5`; `jaro_distance.ex:5`.

Wrong line:
- `transformer.ex:52-56` (callbacks at `:60-68`); `transformer.ex:58-67` (`__using__` at `:70`)
- `section.ex:38-58` (`@fields` `:33-54`); `entity.ex:62-82` (`:70-93`)
- `ash/lib/ash/resource.ex:38-41` (`simple_notifiers` at `:34-37`)
- `ash_state_machine.ex:26` (`identifier` at `:27`)
- `ash/lib/ash/domain/dsl.ex:165-168` (`{:spark, Ash.Resource}` at `:148`)
- `igniter/lib/igniter.ex:402-434` (`defstruct` at `:33`; 402-434 are the `add_issue`/`add_warning`/`add_notice`/`add_task` helpers)
- `igniter.ex:715-800` (`update_elixir_file` `:558`, `update_file` `:618`, `include_or_create_file` `:717`)

Does not support: `spark/lib/spark/dsl/entity.ex:388-397` as the place where target structs must declare `__spark_metadata__`. Those lines are `maybe_apply_identifier`. The metadata is set at `entity.ex:311-313`, and `Spark.Dsl.Entity.Meta` is defined in `spark/lib/spark/dsl/entity/meta.ex:5`.

Nonexistent: `Ash.Resource.ManualCreateFunction` (row 28c).

### R3.6 Did round 3 lose or break content?

No content that was correct after round 2 was lost. Section structure, case studies, forum evidence, issue states and the analysis section are intact. The new defects introduced in round 3 are only three: row 28c's module name, row 30's `name/0` wording, and catalogue row 41 keeping the old citation that §5.3 corrected.

### Residual errors (for readers)

Every statement below is still wrong in the final document. Use the correct fact instead. Everything else in the document checked out or sits outside what was sampled.

| Doc line | Statement | Correct fact (source) |
|---|---|---|
| 1500 | Row 28c example "`Ash.Resource.ManualCreateFunction`" | The module is `Ash.Resource.ManualCreate.Function` (`ash/lib/ash/resource/manual_actions/manual_create_function.ex:5`; `use Ash.Resource.ManualCreate` at `:7`). |
| 1498 | Row 28 example user is "`Ash.Resource.Calculation`" (that is the contract itself) | A real implementer: `Ash.Resource.Calculation.Concat` (`ash/lib/ash/resource/calculation/concat.ex:7`, `use Ash.Resource.Calculation`). |
| 1502 | Row 30: "`codegen/1` + `name/0` … optional `Ash.Extension` callbacks" | `codegen/1` is an optional callback. `name/0` is **not** in the behaviour; it is only probed with `function_exported?/3` (`ash/lib/ash/extension.ex:21-44`; `ash/lib/mix/tasks/ash.codegen.ex:63-67`). Row 34 states this correctly. |
| 1513 | Row 41 cites `add_temporal_inline_attributes.ex:138-166` | `:140-175` (build/add `:140-169`, module matching `:171-175`), as §5.3 line 863-864 says. |
| 263-264 | "`AshArchival.Resource.Info` is `use Spark.InfoGenerator, sections: [:archive]`" | It is `use Spark.InfoGenerator, extension: AshArchival.Resource, sections: [:archive]` (`ash_archival/lib/ash_archival/resource/info.ex`). |
| 297 | Transformer behaviour at `transformer.ex:52-56`; the block is reformatted | The callbacks are at `spark/lib/spark/dsl/transformer.ex:60-68`. Treat the block as abridged. |
| 309 | Defaults injected at `transformer.ex:58-67` | `__using__` is at `transformer.ex:70`. |
| 96, 100 | `section.ex:38-58`, `entity.ex:62-82` for the field lists | `spark/lib/spark/dsl/section.ex:33-54`, `spark/lib/spark/dsl/entity.ex:70-93`. |
| 122 | `{:spark, Ash.Resource}` at `ash/lib/ash/domain/dsl.ex:165-168` | `ash/lib/ash/domain/dsl.ex:148`. |
| ~703 | `simple_notifiers` at `ash/lib/ash/resource.ex:38-41` | `ash/lib/ash/resource.ex:34-37`. |
| ~724, 1475 | `identifier: {:auto, :unique_integer}` at `ash_state_machine.ex:26` | `ash_state_machine/lib/ash_state_machine.ex:27`. |
| 511 | "`__spark_metadata__` … (`spark/lib/spark/dsl/entity.ex:388-397`)" | The metadata is written at `entity.ex:311-313`. `Spark.Dsl.Entity.Meta` is defined in `spark/lib/spark/dsl/entity/meta.ex:5`. Lines 388-397 are `maybe_apply_identifier`. |
| §7.1 (~1044, ~1050) | `Igniter.t()` struct at `igniter.ex:402-434`; `update_elixir_file/4`, `update_file/4`, `include_or_create_file/4` at `igniter.ex:715-800` | `defstruct` at `igniter/lib/igniter.ex:33`. `update_elixir_file` `:558`, `update_file` `:618`, `include_or_create_file` `:717`. |
| 393 | `cond` at `dsl.ex:518-556` | The `cond` begins at `spark/lib/spark/dsl.ex:521`. |
| 210-215 | Map example presented as from the tutorial and the Ash guide | The Ash guide (`ash/documentation/topics/advanced/writing-extensions.md:36-44`) shows only the `[:attributes]` entry plus `...`. The `persist: %{module: MyApp.Tweet, …}` line is the researcher's illustration. |
| 503-507 | DslError output with "`defined in lib/my_app/bad_validator.ex:3:12:`" | Constructed from the `message/1` code (`dsl_error.ex:47-62`). The tutorial's actual output is `fields -> required:` with no location (`spark/documentation/tutorials/get-started-with-spark.md:390-392`). |
| 636-648 | Fragment example (`AshGraphql.Resource`, `graphql do`) | Not in the source. The Spark guide's example is a DataLayer fragment (`spark/documentation/how_to/split-up-large-dsls.md`, `use Spark.Dsl.Fragment, of: Ash.Resource, data_layer: AshPostgres.DataLayer`). The mechanics described are correct. |
| 1075-1083 | `ash.codegen` loop shows `extension.codegen(argv ++ ["--name", name])` unconditionally | Source appends `--name` only when `"--name"` is not already in `argv` (`ash/lib/mix/tasks/ash.codegen.ex:69-76`). |
| 351-358 | `transformers_to_run` block shown without its wrapper | In source it sits inside `if transform? do … else [] end` (`spark/lib/spark/dsl/extension.ex:693-702`). |
| 1234-1239 | ash#2670 trace shown as a contiguous block | Abridged: the issue's trace also contains `Ash.BehaviourHelpers.call_and_validate_return/5`, `…ForbidUnless.__build__/5` and `lib/my_app/some_resource.ex:10: (module)` lines (https://github.com/ash-project/ash/issues/2670). |

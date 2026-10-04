---
title: "Review: The Ash ecosystem packages"
description: "Independent fact-check of the The Ash ecosystem packages document; final verdict ACCEPT."
---

# Review: [`notes/research/04-ash-ecosystem-packages.md`](../ash-ecosystem-packages.md) (ref `ash-ecosystem`)

> Review of: [The Ash ecosystem packages](../ash-ecosystem-packages.md).

VERDICT: ACCEPT

(Final verdict after round 3, 2026-10-01: ACCEPT. The document can be used as is, provided the
reader applies the list under `### Residual errors (for readers)` in `## Round 3 final check` at the
end. Earlier verdicts: round 1 ACCEPT-WITH-FIXES, round 2 ACCEPT-WITH-FIXES.)


Reviewer: independent fact-check, 2026-10-01. Read-only; the document was not edited.
Ground truth: clones under `scratch/ash-src/` (paths below are relative to it unless absolute), hex.pm API
fetched 2026-10-01, GitHub API, Elixir Forum (`forum.elixirforum.com/t/<id>.json`).

**Bottom line.** The hex.pm data is excellent: all 20 ranked rows match the API exactly. Most
technical claims about Reactor, AshPaperTrail, AshEvents and ash_typescript hold up against the source.
The problems: one code example was changed by hand and is presented as copied (rule 5); two "gaps"
are false (Ash.Test "nearly empty"; "nothing persists a workflow" / "no way to resume a Reactor");
several facts about community packages are wrong (ash_event_log "pre-dating", ash_commanded "~10
releases a year", ash_flow, ariadne_flow, ash_onetime); and the AshEvents "not event sourcing" verdict
leaves out that the Ash maintainers publicly argue the opposite. About 25% of citations point at the
wrong line. Everything here can be fixed without new research beyond the URLs given.

---

## 1. Error table

Severity: **high** = wrong fact a design decision could rest on, or an evidence-rule violation;
**medium** = wrong or misleading but local; **low** = imprecision.

| Doc line | Claim | What the source says | Sev |
|---|---|---|---|
| 200-228 | `ExampleReactor` "copied" from `ash/documentation/topics/advanced/reactor.md:66-90` | The source (lines 64-100) has inputs `customer_name, customer_email, plan_name, payment_nonce`, steps `create :create_customer`, `read_one :get_plan`, `action :take_payment, PaymentProvider`, and `subscription` with `payment_provider_id: result(:take_payment, :id)`. The document renames `:create_customer`→`:customer`, deletes two inputs and the `take_payment` step, and invents `customer_id: result(:customer, :id)`. That breaks rule 5 (code must be copied). Replace it with the verbatim block, or label it "abridged and modified". | high |
| 539-542, 1201-1202 (gap #7) | "`Ash.Test` … currently one helper, `assert_has_error/4`"; "`Ash.Test` is nearly empty" | `ash/lib/ash/test.ex` defines `assert_has_error` (l.25), `refute_has_error` (l.118), `strip_metadata/1` (l.179-201) and the `assert_stripped/1` macro (l.238-283). Gap #7 as written is false. Rewrite or delete it. | high |
| 1182-1185 (gap #3), 1190-1195 (gap #5), 65-66 | "nothing in the ecosystem persists a workflow's progress across a process crash or a multi-day wait"; "There is no documented way to resume a Reactor" | (a) Reactor supports halt and resume: `reactor/documentation/tutorials/reactor-cheatsheet.cheatmd:53-55` (`{:halted, state} = Reactor.run(MyReactor, inputs)` then `Reactor.run(state, %{}, %{})`); lifecycle state `:halted` at `reactor/documentation/explanation/architecture.md:78`; people persist `%Reactor{}` for "durable workflows, checkpoint/resume": https://github.com/ash-project/reactor/issues/334 (2026-08-14). (b) `ash_workflow` (cited in the document itself) stores workflow state in a resource through generated `ash_state_machine` states and `ash_oban` triggers, with day-scale timeouts: https://github.com/team-alembic/ash_workflow (README "Concepts"). (c) Core team advice is AshOban + AshStateMachine for durable work, with Reactor run inside an Oban job: https://elixirforum.com/t/long-running-queued-background-processes/59508 (jimsynz, 2023-11-06, older than 2025). Restate the gap as "durability is assembled by hand from Reactor halt/resume, AshOban and AshStateMachine; there is no first-party durable saga engine". | high |
| 593-598, 44-46, 401-403 | "AshEvents is an event log with replay, not event sourcing … The write path is unchanged — the action runs normally and the wrapper writes a log row around it" | Defensible as analysis, but the document presents it as fact and leaves out that the maintainers argue the other way. Zach Daniel (2025-05-11): "an event is always committed first, transactionally, representing exactly what changes are about to occur in the projection", and AshEvents "has this property" (projections can be rebuilt from the log): https://elixirforum.com/t/ashevents-event-sourcing-made-simple-for-ash/70777 (posts #7, #9, #11). The opposing view is in the same thread (katafrakt, post #3). The README itself uses "full event sourcing solution" (`ash_events/README.md:182`). Also, the wrapper *replaces* the action with a manual implementation (`ash_events/README.md:515-525`), so "the action runs normally" is wrong. Give both positions with URLs and put the verdict under Implications. | high |
| 401-403 | "no projection model, no optimistic-concurrency check, no snapshot support" | Leaves out that AshEvents serializes writes with Postgres advisory locks (`ash_events/README.md:644-660`) and that notifiers on the event log fire for every event, which is the hook for projections (`README.md:490-513`, including the known gap for single hard destroys). Also leaves out the hard Postgres dependency (`ash_events/mix.exs:146` `{:ash_postgres, "~> 2.0"}`), the encrypted event log (`README.md:596-622`) and the rejection of `manual` actions (`README.md:515-525`; open issue https://github.com/ash-project/ash_events/issues/99). | medium |
| 423-425, 1164 | `ash_event_log` is "pre-dating" AshEvents, "with 1/15th the adoption" | hex.pm: `ash_event_log` was first released 2026-04-23; `ash_events` 0.1.0 on 2025-05-06. It came after, not before. Ratio: 1,507/62,604 ≈ 1/42 all-time, 910/22,826 ≈ 1/25 over 90 days. Neither is 1/15. | medium |
| 48 | AshCommanded is "one author, ~10 releases a year scale" | hex.pm lists exactly 2 releases (0.1.0 on 2025-05-16, 0.2.0 on 2025-12-08). GitHub shows 4 contributors (pcharbon70-leco 30 commits, pcharbon70 9, suranyami 5, vivek-alembic 1) and PRs merged as late as 2026-05-12 (https://api.github.com/repos/accountex-org/ash_commanded/commits). It is "one main author, 2 releases, unreleased fixes on main". | medium |
| 636-640, 1306-1308 | AshCommanded maturity; "dormant vs actively developed" left as an open question | Answerable from the forum: 0.1.0 did not compile, and 0.2.0 was published to fix it (https://elixirforum.com/t/ashcommanded-a-declarative-cqrs-es-extension-for-ash/70900, posts #3-#5, 2025-12). 0.2.0 still fails on aggregate generation (`undefined function snapshot_state_if_needed/1`, post #10, 2026-02-10). The fix (PR #7) was merged on 2026-05-12 but never released. The hex release **has a known compile bug**. Add this and close the open question. | high |
| 601 | `ash_commanded/README.md:8-11` describes it as "CQRS pattern implementation for Ash Framework resources using Commanded" | That sentence is the **hex description**, not the README. The README (`ash_commanded/README.md:4`) says it provides "CQRS **and Event-Sourcing (ES)** patterns". Lines 8-11 are build commands. Fix the quote and the citation. | medium |
| 30-31 | Summary: Reactor has "… `middleware` and `around` hooks, and a `transaction` step" | `transaction` is an **Ash.Reactor** DSL entity (`ash/lib/ash/reactor/dsl/transaction.ex`). Core Reactor has no transaction step (`reactor/lib/reactor/dsl/` has `around.ex` but no transaction). §1.2 gets this right; the Summary does not. | medium |
| 122-123 | "`undo/4` … returns `:ok` or `{:error, reason}`" | `reactor/lib/reactor/step.ex:69`: `@type undo_result :: :ok \| :retry \| {:retry \| :error, reason}`. Undo can also retry (doc l.169). | low |
| 177-179 | Middleware callbacks "`complete/2`, `error/2`, `halt/1`, plus per-step event hooks" at `middleware.ex:70-80` | The callbacks are at `reactor/lib/reactor/middleware.ex:63-121` and also include `init/1`, `get_process_context/0`, `set_process_context/1` and `event/3`; the event names are a type at l.25-46. The claim is right but the line numbers are wrong. | low |
| 158-159 | `concurrency_key` cited to glossary "Shared Pools" | The glossary entry (l.140) does not mention `concurrency_key`. It is at `reactor/lib/reactor.ex:110,125`. | low |
| 260-261 | `undo_action` for a create is "`destroy`" | `ash/documentation/topics/advanced/reactor.md:172-173`: "a `destroy` **or `update`** action". | low |
| 275-280 | `ash_workflow` "has 210 all-time downloads — it is an experiment, not a competitor" | hex.pm: first release 2026-09-18, five releases in 12 days, published from team-alembic (the consultancy that also hosts ash_authentication). The download count says the package is new, not that it is an experiment. It also builds on AshStateMachine + AshOban (see gap #3 row). Describe it accurately. | medium |
| 276 | `ash_flow`: "not separately fetched", "Ash + Flow" | https://hex.pm/api/packages/ash_flow: an official `ash-project` package, 35,074 all / 1,555 recent, described as 'A "soft deprecated" tool for composing workflows with your Ash Framework resources'. This is the old Ash.Flow that Reactor replaced, which is relevant history for the sagas section. | medium |
| 277 | hephaestus family "299 / 199 / 173" in a column labelled "Downloads (all / recent)" | Those are the 90-day numbers. All-time is 674 / 448 / 396. | low |
| 278 | `ariadne_flow` = "general Elixir flow engine" | hex description: "Event sourcing for Elixir built on Dynamic Consistency Boundaries: an append-only…" (https://hex.pm/api/packages/ariadne_flow). It belongs in §4 (ES options), not in sagas. | low |
| 665, 765-770 | `ash_authentication` = "Full authn/authz"; maintainer "core" | It does authentication only; authorization is Ash core policies. Its repository is `team-alembic/ash_authentication` (hex `meta.links`), with hex owners `ash-project, jamesotron, joshcprice`. Latest **stable** is 4.15.0 (hex `latest_stable_version`); say so next to the RC. | low |
| 1309-1311 | "while most of the ecosystem is on 4.x" | There is no shared version line. Ash is 3.33.11, and every package has its own version. Delete or rephrase. | low |
| 683-686 vs row 20 | `ash_money` cut as "type sugar" while `ash_double_entry` is ranked #20 | `ash_double_entry/mix.exs:156` depends on `{:ash_money, "~> 0.1"}`. Ranking a package and cutting its required dependency is inconsistent under the stated rule (money is a domain type). Either rank ash_money or explain the choice. | medium |
| 713-715 | ash_postgres DSL example `references do reference :version_source, on_delete: :delete end` cited to `ash_archival/.../get-started-with-ash-archival.md` | That snippet does not appear in ash_archival. It is in `ash_paper_trail/documentation/tutorials/getting-started-with-ash-paper-trail.md:158`. ash_postgres has its own source to quote: `ash_postgres/documentation/topics/resources/references.md`. | medium |
| 845-846, 1199-1200 (gap #6) | AshArchival "needs a `base_filter_sql` alongside the Ash-level filter" | `base_filter` is **optional**. By default the extension adds its own `is_nil(archived_at)` preparation (`ash_archival/documentation/topics/how-does-ash-archival-work.md`, "Resource Modifications" item 2). `base_filter_sql` is only needed if you opt into `base_filter?` (`get-started-with-ash-archival.md:38-53`). | medium |
| 541 | Error classes "`Invalid`, `Internal`, `Unknown`, `Validation`" | `ash/lib/ash/error/error.ex:10-14`: `Forbidden`, `Invalid`, `Framework`, `Unknown`. | low |
| 1133-1136 + status report | Public/private attributes are "the primary security boundary for agent access" (report: "not tool-level authz") | `ash_ai/README.md:133-137`: the MCP plug sets the authenticated user as actor, "so your tools run with the authenticated user just like any other Ash request". Policies apply, and public/private only controls which fields are visible. Correct the security statement. | medium |
| 919 | igniter is "the third-party basis for reactor's tutorial project generator" | igniter is an `ash-project` package (hex owner `ash-project`), not third-party. | low |
| 1160 | `ash_feistel_cipher / ash_onetime` 1.1.2/1.4.0, "22,850 / 2,831", "token/crypto value objects" | The two numbers are the two packages' **all-time** counts, shown in a column labelled all/90d. `ash_onetime` is "explicit idempotency and one-time nonce semantics" (hex description), which is domain-relevant. Split into two rows. | low |
| 1161 | `ash_translation` released 2026-06-11 | hex: last release 2026-04-04. | low |
| 1155 | `ash_uuid` released 2024-11-28 | hex: 2024-11-04. | low |
| 1165 | reactor_file/req/process "818 / 1,224 / 177" under "DL all / 90d" | Those are 90-day numbers. All-time is 3,362 / 6,992 / 819. | low |
| 26-27 | Summary: state_machine is "type sugar" | The ranked table puts `ash_state_machine` under category "Domain" (l.668). Make the two consistent. | low |
| 62-63 | "Top of the domain cluster by 90-day downloads" omits `ash_state_machine` (123,291) and `ash_archival` (88,614) | Both are labelled "Domain" in the table and belong in that list. | low |
| 551 | Smokestack quote | The source has "highlihted" (`smokestack/README.md:7`); the typo was silently fixed. Harmless; mark it `[sic]` or keep the typo. The author (James Harton) is the Reactor author and a core-team member, so add "even core members". | low |
| 82-111, 126-134, 234-247 | Reactor getting-started, compensate and generic-action examples | All three are trimmed without saying so: the `hash_password` step that `create_user` depends on is missing, two compensate clauses and the logging are removed, and the `author_email` argument is removed. Add "(abridged)". | low |

---

## 2. hex.pm comparison (fetched 2026-10-01, `https://hex.pm/api/packages/<name>`)

Every ranked row matches the API exactly on version, last release date, all-time downloads and
90-day downloads. Repo URL is the `meta.links` GitHub/Source entry. All 20 are alive (released in the
last 12 months, none retired at the latest version).

| # | Package | Doc version / date | API version / date | Doc all / 90d | API all / 90d | Repo (API) | Hex owners | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | reactor | 1.0.7 / 2026-09-16 | same | 1,410,207 / 395,665 | same | ash-project/reactor | ash-project, jamesotron | OK |
| 2 | ash_postgres | 2.13.1 / 2026-09-08 | same | 1,522,717 / 305,291 | same | ash-project/ash_postgres | ash-project | OK |
| 3 | ash_paper_trail | 0.7.0 / 2026-08-30 | same | 309,565 / 88,476 | same | ash-project/ash_paper_trail | ash-project | OK |
| 4 | ash_events | 0.8.2 / 2026-09-19 | same | 62,604 / 22,826 | same | ash-project/ash_events | ash-project, torkan | OK (§4 table says owner "ash-project" only) |
| 5 | ash_ai | 1.1.1 / 2026-09-23 | same | 258,089 / 100,126 | same | ash-project/ash_ai | ash-project | OK |
| 6 | ash_authentication | 5.0.0-rc.14 / 2026-09-17 | same (stable 4.15.0) | 937,379 / 216,171 | same | **team-alembic**/ash_authentication | ash-project, jamesotron, joshcprice | Data OK; repo is not ash-project; say stable is 4.15.0 |
| 7 | ash_oban | 0.9.0 / 2026-09-30 | same | 519,352 / 161,510 | same | ash-project/ash_oban | ash-project | OK |
| 8 | ash_typescript | 0.18.4 / 2026-09-29 | same | 92,766 / 41,363 | same | ash-project/ash_typescript | ash-project, torkan | OK |
| 9 | ash_state_machine | 0.2.13 / 2026-04-13 | same | 369,000 / 123,291 | same | ash-project/ash_state_machine | ash-project | OK |
| 10 | ash_archival | 2.0.3 / 2025-11-05 | same | 403,793 / 88,614 | same | ash-project/ash_archival | ash-project | OK |
| 11 | usage_rules | 1.2.8 / 2026-09-07 | same | 686,589 / 301,065 | same | ash-project/usage_rules | ash-project | OK |
| 12 | ash_phoenix | 2.3.25 / 2026-08-31 | same | 1,276,891 / 272,637 | same | ash-project/ash_phoenix | ash-project | OK |
| 13 | ash_json_api | 1.7.1 / 2026-07-07 | same | 700,777 / 164,474 | same | ash-project/ash_json_api | ash-project | OK |
| 14 | ash_graphql | 1.12.0 / 2026-09-18 | same | 465,613 / 62,537 | same | ash-project/ash_graphql | ash-project | OK |
| 15 | igniter | 0.8.4 / 2026-09-07 | same | 2,431,786 / 663,096 | same | ash-project/igniter | ash-project, zachallaun | OK |
| 16 | spark | 2.7.3 / 2026-09-15 | same | 2,218,374 / 441,876 | same | ash-project/spark | ash-project | OK |
| 17 | ash_cloak | 0.4.0 / 2026-08-30 | same | 230,354 / 86,696 | same | ash-project/ash_cloak | ash-project | OK |
| 18 | ash_admin | 1.3.2 / 2026-09-04 | same | 521,034 / 119,477 | same | ash-project/ash_admin | ash-project | OK |
| 19 | ash_rate_limiter | 2.0.1 / 2026-08-17 | same | 104,808 / 43,309 | same | ash-project/ash_rate_limiter | ash-project | OK |
| 20 | ash_double_entry | 1.0.19 / 2026-09-07 | same | 75,696 / 21,137 | same | ash-project/ash_double_entry | ash-project | OK |
| – | ash_commanded | 0.2.0 / 2025-12-08 | same | 880 / 154 | same | accountex-org/ash_commanded | pcharbon70 | OK ("third-party", 0.2.0, 880 all confirmed). "~10 releases a year" wrong: 2 releases total |
| – | smokestack | 0.9.2 / 2025-01-30 | same | 46,612 / 9,328 | same | harton.dev/james/smokestack (GitHub mirror jimsynz/smokestack) | jamesotron | OK. Deprecated **only in the README** (`smokestack/README.md:6-7`); not retired on hex. HL3-FULL license confirmed (`README.md:4,57-66`) |

The ranked table has no repository column. The brief did not require one, but the URLs above should
go into §5 or §9, because two "core" packages live outside `ash-project` on GitHub
(ash_authentication, ash_authentication_phoenix under team-alembic).

Honorable-mention spot checks: `ash_authentication_phoenix`, `ash_authentication_oauth2_server`,
`ash_money`, `ash_sqlite`, `ash_csv`, `ash_slug`, `splode`, `ash_geo`, `ash_diagram`,
`opentelemetry_ash`, `ash_pagify`, `ash_scylla`, `ash_arcadic`, `ash_jido`, `ash_workflow` and
`ash_event_log` match. Mismatches (ash_translation, ash_uuid, reactor_*, feistel/onetime,
hephaestus) are listed in §1.

---

## 3. Citation sample

70 local-path citations were opened and judged, plus the 20 hex URLs of the ranked table.

| Judgement | Count | % |
|---|---|---|
| Supports (cited place says it) | 50 | 71% |
| Wrong line, claim true | 17 | 24% |
| Does not support | 3 | 4% |
| Nonexistent | 0 | 0% |
| hex.pm URLs (ranked table) | 20/20 support | 100% |

**Does not support:** `ash/documentation/topics/advanced/reactor.md:66-90` (code altered);
`ash/lib/ash/test.ex:5-25` ("one helper"); `ash_commanded/README.md:8-11` (quote is the hex
description, and the lines are build commands).

**Wrong line, claim true** (fix the numbers):
- `ash_events/README.md`: 145-160→157-172; 163-171→174-182; 172-181→197-203; 180-193→184-195; 181-186→205-210; 191-260→212-265.
- `ash_commanded/README.md`: 20-27→34-39; 29-52→41-60; 54-61→62-68.
- `reactor/lib/reactor/middleware.ex`: 70-80→63-121.
- `concurrency_key` is in `reactor/lib/reactor.ex:110`, not the glossary.
- `ash_paper_trail/.../getting-started-with-ash-paper-trail.md`: 325-327→372.
- `ash/documentation/how-to/test-resources.livemd`: 44-50→25-28.
- `ash_ai/README.md`: 57→72; 66→82.
- `ash_typescript/README.md`: 93→87.
- `ash_typescript/lib/ash_typescript/rpc.ex`: 315-321→324-325.
- `ash/usage-rules.md`: 7-9→11.

**Supports** (sample): reactor 01-getting-started:95, 02-error-handling:132-160 and :610,
03-async-workflows:55-66, glossary entries (Three-Tier, Cycle Detection, Ecosystem Extensions,
Synchronous Execution), architecture "Main Executor", cheatsheet :155/:384, step.ex:207,229,
testing-strategies (Mimic, `async?: false`); ash reactor.md:9, :36-60, :145-180, :184-215; paper trail
guide 29-46, 200-243, 246-260, 262-282, 94-116, 118-160; ash_events README 54-72, 110-130, 317-331,
333-349; ash testing.md:10-13; ets.ex:12-25; generator.ex:8-40; test-resources.livemd 52-56, 196-262,
214-215; ash.ex:1812-1826; seed.ex:5-11; smokestack README; ash_commanded README 88-140;
ash_money README 17-23; ash_ai README 243-250, 318-330; ash_ai usage-rules 29-49; ash_typescript
README 17-19, 29-33, 38-48, 67-99; rpc.ex 282, 225-246, 150-220; first-rpc-action 29-75; usage_rules
README 12-19, 57-90; generators.md 16-40; reactor getting-started :47; ash_double_entry README 24-36;
AuditLogResource (`ash_authentication/documentation/tutorials/audit-log.md:57`); AshRateLimiter in
`otp.md:46`; ash_rate_limiter README Hammer config; `usage-rules*` inventory (exactly the 15 listed
exist under `scratch/ash-src`, maxdepth 2); `ash/usage-rules/` has 14 files.

---

## 4. Acceptance criteria

| # | Criterion | Status | What is missing |
|---|---|---|---|
| 1a | Sagas: Reactor + Ash.Reactor + community | **partial** | Altered `ExampleReactor` (rule 5). Leaves out Reactor **halt/resume** (cheatsheet:53-55) and therefore draws a false durability conclusion. Leaves out the official soft-deprecated `ash_flow`. Leaves out the community's actual durable pattern (AshOban + AshStateMachine, Reactor inside Oban jobs; forum 59508, 65945). The Summary attributes `transaction` to core Reactor. |
| 1b | Auditing: PaperTrail + AshEvents + other | **complete with fixes** | PaperTrail coverage is accurate. AshEvents: add advisory locks, notifiers, encryption, the `manual` restriction and the Postgres dependency. Fix the `ash_event_log` chronology. Known PaperTrail limits from issues are missing: bulk actions (#40), managed relationships (#171), non-referenced actors (#104), sensitive-value scrubbing (#30). |
| 1c | Testing | **partial** | `Ash.Test` misdescribed (it has refute_has_error, strip_metadata, assert_stripped). Generator API only half covered (`seed!`, `seed_many!`, `many_changesets`, `generate_many`, `mixed_map` exist: `ash/lib/ash/generator/generator.ex`). Leaves out `mix ash.generate_policy_chart` (`ash/lib/mix/tasks/ash.generate_policy_chart.ex`) for policy review, and `ash/usage-rules/testing.md` (globally unique identity values to avoid deadlocks). Community test packages missed: `ash_scenario`, `ash_random_params`, `ash_mock` (see §5). Error classes wrong. |
| 1d | Event Sourcing / CQRS | **partial** | Leaves out the maintainer's counter-position on "is AshEvents ES" (forum 70777). Leaves out that AshCommanded 0.2.0 on hex has a known compile bug, with the fix merged but unreleased (forum 70900, PR #7). AshCommanded's README claims ES as well as CQRS. Leaves out `ariadne_flow` (an ES library, mislabelled in §1.3). |
| 2 | Ranked table ≤ 20 with all columns + rule | **complete with fixes** | Data accurate. The rule is applied inconsistently: igniter/spark (infrastructure) rank above ash_cloak/ash_double_entry, and ash_money is cut although ranked #20 depends on it. Add repo URLs or at least flag the team-alembic-hosted packages. |
| 3 | Per-package notes (DSL example, adds, gaps from README/issues/forum, mesh line) | **partial** | No real DSL example for ash_phoenix (#12), ash_json_api (#13), ash_graphql (#14), ash_authentication (#6), ash_admin (#18) or spark (#16, which shows an internal line, not user DSL). ash_postgres (#2) uses a mis-cited snippet from another package. ash_rate_limiter (#19) shows only config, not the `rate_limit do … end` DSL. "Known gaps" come only from READMEs and never from issues or forum, although open issues exist (examples in §6). |
| 4 | ash_typescript extra attention | **partial** | "Limits" is mostly the 0.18/0.16 changelog. Missing: the wire transport (single `POST /rpc/run` and `/rpc/validate` endpoints calling `AshTypescript.Rpc.run_action/validate_action`, `ash_typescript/documentation/getting-started/installation.md:75,177-195`); generated `validate*` functions (`documentation/guides/form-validation.md:10-30`); HTTP/channel lifecycle hooks (`documentation/features/lifecycle-hooks.md`); `customFetch`/`fetchOptions` (`documentation/advanced/custom-fetch.md`); compile failure on unmapped types (`documentation/advanced/custom-types.md:95`); actions must be `public?` (README:135-137). Open issues: #100 (destroying a nonexistent record reports success), #95 (igniter installer creates invalid routes), #51 (TanStack Query factories requested). No field-level authorization metadata for the UI: the maintainer's workaround is a hand-written generic action around `Ash.can?` (forum 73730). |
| 5 | ash_ai + usage_rules extra attention | **complete with fixes** | Leaves out `mix usage_rules.sync` (the command that actually writes the files, `usage_rules/README.md:89-95`) and that removal of unconfigured packages is automatic. Security statement wrong (actor + policies apply, `ash_ai/README.md:133-137`). |
| 6 | Honorable mentions + gaps with evidence | **partial** | Honorable mentions have several data errors (§1). Gaps #3, #5, #6, #7 are false or overstated, and none of the 8 cites a community source. See §6 for replacements. |

Format rules: the Summary has 10 bullets (≤ 12, OK). Facts and analysis are kept apart (OK), but
"Precise statement of what AshEvents is" and gap #8 are analysis inside fact sections. Word count is
9,180 against a 3,000-6,000 target; the overrun is declared in the report and is acceptable.

---

## 5. Check 7: ranking sanity / missed packages

Sources: `https://hex.pm/api/packages?search=ash&sort=recent_downloads` (pages 1-3) and the
individual package endpoints.

**Missed and relevant to domain modeling or testing (add to honorable mentions at minimum):**

| Package | Version / date | All / 90d | Repo | Why |
|---|---|---|---|---|
| `ash_credo` | 0.18.0 / 2026-09-19 | 47,947 / 29,661 | leonqadirie/ash_credo | Static-analysis rules for Ash code. 90-day adoption is higher than half the honorable mentions; relevant to mesh's "rules for agents" story. |
| `ash_appsignal` | 0.2.4 / 2026-04-30 | 96,844 / 9,308 | ash-project/ash_appsignal | Official APM integration, a sibling of opentelemetry_ash. |
| `ash_scenario` | 0.6.1 / 2026-02-03 | 1,838 / 355 | marot/ash_scenario | "Reusable test data generation … with dependency resolution". It directly answers gap #1 ("no shared, versioned library of reusable generators"). |
| `ash_random_params` | 0.2.1 / 2025-10-11 | 7,593 / 4,914 | devall-org/ash_random_params | Random action params for tests. |
| `ash_onetime` | 1.4.0 / 2026-09-24 | 2,831 / 2,831 | baselabs/ash_onetime | Idempotency / one-time nonce semantics, a domain concern (mislabelled in the doc). |
| `ash_grant`, `ash_rbac` | 0.22.0 / 0.6.1 | 4,209 / 1,785; 11,459 / 1,182 | jhlee111/ash_grant | Permission/RBAC layers on top of policies; evidence of an authorization-ergonomics gap. |
| `ash_flow` | 0.1.1 / 2024-05-11 | 35,074 / 1,555 | ash-project/ash_flow | Official, soft-deprecated predecessor of Ash.Reactor. |
| `ash_jason`, `ash_oaskit` | 3.1.0 / 0.4.2 | 60,503 / 5,549; 1,303 / 874 | – | Minor; optional. |

**Included but questionable under the stated rule ("domain first"):** `igniter` (#15) and `spark`
(#16) are tooling/infrastructure ranked above domain packages (`ash_cloak`, `ash_double_entry`). By
the document's own rule they belong at the bottom or in honorable mentions. `ash_admin` (#18) and
`ash_rate_limiter` (#19) are less domain-relevant than `ash_money`, which #20 depends on. Nothing
included is dead or irrelevant, so no row needs to be removed for correctness. This is a consistency
fix.

---

## 6. Check 9: the gaps section

**Gap claims with no real evidence or contradicted:**
1. Gap #1, "no shared, versioned library of reusable generators": `ash_scenario` exists (low
   adoption). Restate as "no mature shared library".
2. Gap #2, "no first-class domain operation that is durable, retryable and observable": no source;
   opinion. Move to Implications.
3. Gap #3, "nothing persists a workflow's progress": contradicted (Reactor halt/resume, ash_workflow,
   AshOban + AshStateMachine; see §1).
4. Gap #5, "no documented way to resume a Reactor": contradicted (`reactor-cheatsheet.cheatmd:53-55`).
   "No way to express a Reactor step as an Oban job" is also unsourced; the documented pattern is
   the reverse (Reactor inside an Oban job, forum 59508 and 65945).
5. Gap #6, "AshArchival needs base_filter_sql": wrong (optional). The PaperTrail and AshMoney parts
   are supported.
6. Gap #7, "Ash.Test nearly empty": wrong.
7. Gap #8, "GraphQL complex by reputation / JSON:API stalling": self-declared inference with no
   evidence. The download comparison runs opposite to the heading (JSON:API has 2.6× GraphQL's
   90-day downloads, so it is not "stalling"). Delete or source it.
8. Gap #4, "afterthought": loaded wording; the facts (third-party, 0.2.0, 880 downloads) are right.

**Documented gaps to add (with evidence):**

1. **No built-in way to hydrate a historical version back into a resource struct (AshPaperTrail).**
   Zach Daniel: "There is nothing built in for that, no", and he suggests a hand-written calculation
   over the `:snapshot` mode. https://elixirforum.com/t/are-there-any-best-practices-for-referencing-versioned-resources/75012 (2026-04-14/15).
2. **AshPaperTrail does not support bulk actions or non-resource actors, and does not scrub sensitive
   inputs.** Open issues https://github.com/ash-project/ash_paper_trail/issues/40 (bulk actions),
   /issues/104 (non-referenced actors), /issues/30 (redact `sensitive` values in stored inputs/changes),
   /issues/171 (errors with managed relationships). Only one actor per version: https://elixirforum.com/t/how-to-pass-second-actor-parameter-to-the-ash-paper-trail/69322 (2025-02-10).
3. **Approval / draft-then-publish workflows have no package; people bend PaperTrail into it.**
   https://elixirforum.com/t/manager-approval-workflow-with-ash-paper-trail-for-record-changes/67343 (2024-11-08, older than 2025).
4. **AshEvents edge cases with generated primary keys and manual/around hooks.** Replay fails with
   "No such input `id`" for auto-generated PKs; the maintainer's workaround is to make `id` writable and
   accepted: https://elixirforum.com/t/ashevents-no-such-input-id-for-action-how-to-handle-auto-generated-primary-keys/73950 (2026-01-13/15).
   Open issues https://github.com/ash-project/ash_events/issues/101 (bulk update + around_action raises
   InvalidReturnType, 0.8.1+) and /issues/99 (wrapping discards a declared `manual`).
5. **No snapshots, and a contested event-sourcing model in AshEvents.** A user looked for "snapshot"
   and found nothing; another argues it is not ES; the maintainer defends the model.
   https://elixirforum.com/t/ashevents-event-sourcing-made-simple-for-ash/70777 (posts #2, #3, #7-#11, 2025-05).
6. **The only CQRS/ES binding is broken on its latest release.** 0.1.0 did not compile; 0.2.0 fails
   generating aggregates; the fix was merged 2026-05-12 but not released; process managers are
   unaddressed (the author recommends Reactor).
   https://elixirforum.com/t/ashcommanded-a-declarative-cqrs-es-extension-for-ash/70900 (2025-11 to 2026-02);
   https://github.com/accountex-org/ash_commanded/pull/7.
7. **Durable workflows are hand-assembled.** Persisted reactors break on redeploy when steps use inline
   `run fn` (the function name embeds a body hash):
   https://github.com/ash-project/reactor/issues/334 (2026-08-14). Users asking for workflow engines with
   persistence and manual approval steps are pointed at Reactor + Oban, with persistence left to them:
   https://elixirforum.com/t/any-tips-on-building-a-workflow-engine-similar-to-n8n/71782 (posts #10, #14, 2025-07/08).
8. **The TypeScript client has no authorization metadata for UI gating.** You must write a generic
   action around `Ash.can?` to tell the frontend what the user may do:
   https://elixirforum.com/t/ash-typescript-pass-list-of-available-policies-to-the-user/73730 (2025-12-22).
   Also open: https://github.com/ash-project/ash_typescript/issues/100 (destroy of a nonexistent record
   reports success).

---

## Round 2 re-verification

Document re-read in full (1,765 lines, ending with `## Revision log (round 2)`). Line numbers
below refer to the **revised** document. Sources were re-opened; "fixed" below means I checked the
new text against the source, not only that the text changed.

**Verdict: ACCEPT-WITH-FIXES (unchanged).**
- **Verified fixed:** the ExampleReactor block (now verbatim), `Ash.Test`, error classes, the
  Reactor halt/resume retraction, AshEvents advisory locks / notifiers / encryption / Postgres /
  `manual`, the AshCommanded release history and compile bug, `ash_event_log` chronology,
  `transaction` attribution, `undo/4`, middleware callbacks, `undo_action`, `ash_flow`,
  `ash_workflow`, hephaestus, `ariadne_flow`, ash_authentication, the ash_ai security statement in
  §8, the honorable-mention numbers, and archival gap #9.
- **Not acceptable as is:** the revision log claims several fixes that were not made. Round 2
  introduced one new factual error (the AshEvents write ordering) and leans on one weak piece of
  evidence (reactor #334). The ranking edit left the document contradicting itself. All of this is
  editing work; no new research is needed.

### R2-1. Round-1 findings: status (all high/medium; half of lows sampled)

| Round-1 finding | Sev | Status after round 2 |
|---|---|---|
| ExampleReactor altered | high | **Fixed.** Lines 232-268 match `ash/documentation/topics/advanced/reactor.md:64-99` verbatim (cite says 64-97; the block ends at 99, low). |
| Ash.Test "one helper" / gap #7 | high | **Fixed** (l.627-632). Lines `test.ex:25,118,179-201,238-283` and `error.ex:10-14` confirmed. |
| Durability / resume gaps | high | **Mostly fixed** (l.201-213, 335-340, 1398-1406). New problems with `fully_reversible` and #334: see R2-3. |
| AshEvents "not ES" one-sided | high | **Mostly fixed** (§4.1, l.706-731). New factual error on write ordering and an unfair paraphrase of katafrakt: see R2-3. |
| AshEvents missing facts | medium | **Fixed** (l.464-483). Minor: the advisory-lock quote at l.469-471 drops the README's own qualifier "but it is still extremely unlikely to occur in practice" (`ash_events/README.md:650`); add it back. |
| ash_event_log chronology/ratio | medium | **Fixed** (l.509-513). |
| AshCommanded releases/authors | medium | **Fixed** (l.772-776). |
| AshCommanded maturity / open question | high | **Fixed in §4.2** (l.778-783), but the Open questions entry is **not** updated (l.1549-1551 still says "unresolved"), although the revision log (l.1696) says it was. Delete that bullet. |
| ash_commanded README quote | medium | **Fixed** (l.736-738). |
| Summary `transaction` attribution | medium | **Fixed** (l.31). |
| ash_workflow "experiment" | medium | **Fixed** (l.325, 329-333). |
| ash_flow | medium | **Fixed** (l.326, 1327). |
| ash_money cut vs dependant ranked | medium | **Contradictory fix**: see R2-4. |
| ash_postgres DSL example mis-cited | medium | **NOT fixed.** l.870-872 still says "from `ash_archival`'s docs" with the `reference :version_source` snippet, although the revision log (l.1710) claims a re-cite to `ash_postgres/documentation/topics/resources/references.md`. Do what the log says: quote a block from that file. |
| AshArchival base_filter | medium | **Fixed in gap #9** (l.1412-1418). §6 #10 (l.1002-1003) still presents `base_filter` + `base_filter_sql` as part of setup. Add "optional; only with `base_filter? true`". |
| ash_ai public/private as security boundary | medium | **Fixed in §8** (l.1297-1304), **but Implications #5 (l.1472-1475) still says "public vs private attributes are the boundary"**. Rewrite it to match §8. |
| Low findings (sampled 8 of 17) | low | undo/4 (l.129-131) fixed; middleware (l.193-197) fixed; concurrency_key (l.172-175) fixed; error classes fixed; igniter (l.1076-1077) fixed; feistel/onetime split fixed; ash_translation/ash_uuid dates fixed; smokestack `[sic]` fixed. |
| 17 wrong-line citations | low | **6 NOT re-pointed**, although the revision log (l.1723-1727) says "All 17": `test-resources.livemd:44-50` (l.618, should be :25-28); `ash_ai/README.md:57` and `:66` (l.914-915, should be :72 and :82); `ash_typescript/README.md:93` (l.1228, should be :87); `rpc.ex:315-321` (l.1225, should be :324-325); `ash/usage-rules.md:7-9` (l.1272, should be :11); `getting-started-with-ash-paper-trail.md:325-327` (Open questions l.1540, should be :372). |

### R2-2. Code blocks: verbatim check (every block)

Verbatim: ExampleReactor (l.232-268), generic action (l.276-290), PaperTrail config (l.355-369;
source 29-41), test-resources property and policy blocks (l.576-610), async block (l.157-167),
middleware/around (l.180-191), halt/resume (l.204-208), AshArchival (l.991-1000), ash_typescript
nested-relationship TS (l.1210-1217; reflowed whitespace only).

The revision log (l.1731-1736) says every other block is verbatim or labelled "(abridged)". That is
**false** for the following. Label each "(abridged: … omitted)" naming what was dropped, or paste it
verbatim:

| Doc lines | Block | What differs from source |
|---|---|---|
| 87-117 | Reactor getting-started, labelled "abridged … `run` bodies shortened" | Not only omission: the `create_user` body is **rewritten** (source l.98-106 builds `user = %{id:…, email:…, password_hash:…, created_at: DateTime.utc_now()}` then `{:ok, user}`; the doc collapses it into one invented line and drops `created_at`). Comments are dropped without being named. Paste the real body, or write "rewritten". |
| 134-149 | compensate, labelled abridged | The two omitted clauses are named; the dropped comments (`# Temporary failures - retry with helpful logging`, `# Permanent failures - don't retry`) are not. Low. |
| 404-433 | AshEvents event_log + events | Not labelled. Drops all comments, the second `persist_actor_primary_key :system_actor …` line (`README.md:67`), the `.....` placeholder and the `attributes`/`actions` stubs (`README.md:123-130`). |
| 445-449 | Replay | Shows one of three examples (`README.md:157-172`), not labelled. |
| 542-569 | Ash.Generator | The source lacks a comma after the `sequence(...)` line (`generator.ex` moduledoc) and the doc silently adds it. `defaults:` is reflowed. Add "(comma added; source has a typo)". |
| 669-678 | Smokestack | Drops the second `factory Character, :trek` and the test module (`smokestack/README.md:20-33`); not labelled. |
| 746-770 | AshCommanded `commanded do` | Drops the `confirm_email` command, the `email_confirmed` event and its projection (`README.md:116-120,128-130,141-146`) and the resource around it; not labelled. |
| 899-906 | ash_ai tools | Drops `tool :read_comments, MyApp.Blog.Comment, :read` and the `defmodule MyApp.Blog … use Ash.Domain, extensions: [AshAi]` wrapper (`README.md:239-250`); not labelled. |
| 933-948 | AshOban | Drops `...` and four comments (`getting-started-with-ash-oban.md:76-96`); not labelled. |
| 968-979 | AshStateMachine | Stitched from two places (`getting-started-with-ash-state-machine.md:141-142` and `:162-163`); not labelled. |
| 1012-1034 | usage_rules | Comments dropped. The second `usage_rules:` line is commented out and its comment **reworded** (source l.63: "# If your CLAUDE.md is getting too big, link instead of inlining:"; doc: "# or link instead of inlining when the file gets big:"). Not labelled. |
| 1094-1112 | AshCloak | Drops five comments, including the policies sentence that the doc then quotes as a "doc comment" (`getting-started-with-ash-cloak.md:26-41`); not labelled. |
| 1155-1161 | ash_typescript manifest | Two source blocks merged (`README.md:32-42`), file-path comments dropped; not labelled. |
| 1167-1172 | "rpc.ex" block | **Not source code**: the second and third lines are a hand-written annotation (`#   entities: rpc_actions (args: [:name, :action]), typed_queries`) formatted as code. Replace with the real `typescript_rpc do resource … rpc_action … end` block from `documentation/getting-started/installation.md:150-162`. |
| 1181-1194 | createTodo | Composite and modified: the source (`first-rpc-action.md:53-71`) imports only `createTodo`, names the variable `result` and wraps it in `async function addTodo`. The doc invents `import { listTodos, createTodo, getTodo }` and renames the variable `created`. |
| 1199-1204 | getTodo nested fields | Reflowed from multi-line (`first-rpc-action.md:96-108`); acceptable, but label it. |

### R2-3. New round-2 claims

1. **"AshEvents replaces the action with a `manual` implementation."** **Correct.**
   `ash_events/lib/events/transformers/wrap_actions.ex:172-188` sets `manual:` to
   `Create/Update/DestroyActionWrapper`, the comment at l.260-263 says so, and
   `reject_manual_actions!` (l.51, l.264) rejects an action that already declares one.
   **Citation problem (l.722-724):** issue #99 (open, filed against **0.8.1**) reports the opposite
   behaviour: the resource's own manual was *silently discarded*, "no compile warning". The 0.8.2
   clone rejects it at compile time. Cite `wrap_actions.ex:51,264` for the rejection and describe
   #99 as "the 0.8.1 behaviour, now a compile error; issue still open". Do not cite #99 as the
   reason it rejects.
2. **§4.1, "events are committed before the projection changes" (l.727) and Implications #8
   (l.1495-1496).** **Wrong as a general statement for 0.8.2.** Order varies by action type:
   - **update:** event first, then the row (`lib/events/update_action_wrapper.ex:28-39`).
   - **create:** row first via `data_layer.create`/`upsert`, then `create_event!` with the real
     primary key (`lib/events/create_action_wrapper.ex:25-58`).
   - **destroy:** row first (`data_layer.update`/`destroy`), then the event
     (`lib/events/destroy_action_wrapper.ex:36-37,106`).

   Zach Daniel's post #11 links `create_action_wrapper.ex` **at v0.1.1**, so it describes 2025
   behaviour. Rewrite as: "both writes happen inside the action's transaction; in 0.8.2 the event is
   written first for updates and after the row for creates and destroys". Keep Daniel's quote,
   dated, as his position.
3. **Position B paraphrase (l.715-716): "katafrakt … argues it is an audit log".** **Inaccurate.**
   katafrakt's post #3 says: "Ability to replay the state is great, but it seems that the state is
   still a primary concept and events are secondary … I would just avoid marketing it as event
   sourcing". Post #10 adds Fowler's "all changes … are initiated by the event objects". He does not
   say "audit log". Quote post #3 directly. Position A's quotes (post #7 "AshEvents has this
   property"; post #11 "an event is always committed first, transactionally…") are accurate. Post #9
   is cited but not quoted; its gist is "fits enough definitions … one way to do event sourcing with
   Ash", so add it. The README phrase at l.712 is "rather than a full event sourcing solution"
   (`README.md:182`); quote it with "rather than", because without that context it reads as a claim.
4. **Reactor issue #334 (gap #7, l.1401-1402; Implications #10, l.1515-1517).** **Weak evidence.**
   The issue exists, but it was **closed as `not_planned` the same day (2026-08-14)**, with the
   reporter's only comment: "Sorry my claude agent opened this !, I was asking it to report it to me"
   (`gh api repos/ash-project/reactor/issues/334/comments`). No maintainer confirmed it. The
   *mechanism* is real, and the source shows it: Spark names lifted anonymous functions
   `"#{key}_#{n}_generated_#{fn_name}"`, where `fn_name` is the MD5 of the function's AST
   (`spark/lib/spark/code_helpers.ex:15-21` `code_identifier/1`, `:332-336`
   `generate_unique_function_name/2`). Re-cite the Spark source as the evidence and describe #334 as
   "an AI-filed report closed as not planned". (My round-1 review also cited #334 too readily.)
5. **`fully_reversible` as half of the durability assembly (l.211-213, 339-340).** **Misread.** The
   option is `fully_reversible?` (with `?`), and its doc says: "When this option is set the Reactor
   will return a copy of the completed Reactor struct for potential future undo"
   (`reactor/lib/reactor.ex:112-116`). It concerns undoing a *completed* run later, not persisting
   progress. Fix the name, and drop it from the durability sentence (or say it is an undo-after-
   success option).
6. **"Durability is hand-assembled from Reactor + AshOban + AshStateMachine" and the core-team
   guidance (l.335-340, 1398-1406).** **Supported.** Forum 59508 post #3 (jimsynz, 2023-11-06):
   "Oban is the way to go … We have ash_oban … You can run a reactor inside your Oban job … Also look
   at ash_state_machine". Forum 65945 post #4 (zachdaniel, 2024-09-09) notes "the sync nature of
   reactor". Both predate 2025 and are labelled as such. Fine.
7. **The 10 gaps (every URL fetched).**
   - **#1:** supported (hex API; `smokestack/README.md:6-7`).
   - **#2:** supported; forum 75012 post #2 quote is exact.
   - **#3:** supported. ash_paper_trail issues #40, #104, #30 and #171 are all open with matching
     titles; forum 69322 post #2: "There is only ever one actor".
   - **#4:** supported (forum 67343, 2024).
   - **#5:** supported (forum 73950 post #2, Torkan's workaround is accurate; ash_events #101 and
     #99 open; forum 70777 post #2 on snapshots). Fix the #99 framing per item 1.
   - **#6:** supported (forum 70900 posts #3-#5, #10-#12). PR #7 was merged 2026-05-12 per the
     commit list.
   - **#7:** see item 4.
   - **#8:** supported (forum 73730 post #3; ash_typescript #100 open).
   - **#9:** supported.
   - **#10 (ash_grant/ash_rbac → "the core policy model leaves work to do"):** the hex numbers are
     right, but the conclusion is **inference from existence**, not evidence of a community complaint.
     It also leaves out that ash_rbac's last release is 2024-10-01 (hex), i.e. dormant. Mark it as
     inference or move it to Implications.

### R2-4. Ranking

The 20 rows still match hex.pm exactly (re-checked; `ash_money` 0.2.6 / 2026-06-08 /
163,618 / 46,717 and `splode` 0.3.2 / 2026-08-06 / 1,810,058 / 670,174 match). Honorable-mention
additions (`ash_credo`, `ash_appsignal`, `ash_grant`, `ash_rbac`, `ash_jason` 2026-03-04, `ash_oaskit`
2026-09-16, `ash_scenario`, `ash_random_params`) match hex. **The ranking rule is still not applied
consistently, and the edit created contradictions:**
1. **`splode` promoted to #20 (l.836) for the same reason `igniter`/`spark` were demoted.** The table
   itself calls it "plumbing", and l.809-810 demote igniter/spark as "infrastructure". Either demote
   splode too and fill slot #20 with the best-adopted domain-relevant honorable mention by the stated
   rule (for example `ash_onetime`, idempotency, or `ash_workflow`, durable workflows), or state a
   rule that admits splode.
2. **"Ranked candidates I deliberately cut" (l.838-849) still lists `ash_money` and `splode` as
   cut**, and §9 honorable mentions still list both (l.1315, l.1320), while they are ranked #19 and
   #20. Delete those entries.
3. **The stated rule (l.801-804) says transport/storage packages rank below domain packages "even at
   10× the downloads".** Yet `ash_postgres` (storage) is #2 and `ash_phoenix`/`ash_json_api`/
   `ash_graphql` (transport) are #12-#14, above `ash_cloak` (#15), `ash_double_entry` (#18) and
   `ash_money` (#19), which the table categorises as "Domain". Reorder, or amend the rule to say
   storage and transport are ranked by adoption within a separate band.
4. **§6 was not renumbered.** Headings still run `### 15. igniter`, `### 16. spark`, `### 17. ash_cloak`
   … `### 20. ash_double_entry` (l.1069-1132). There are **no per-package notes for `ash_money` or
   `splode`**, which criterion 3 requires for every ranked package. The revision log (l.1750-1751)
   says "DSL examples added for the packages that lacked them", but §6 #6 ash_authentication, #12
   ash_phoenix, #13 ash_json_api, #14 ash_graphql and #18 ash_admin still have no DSL example, and
   ash_rate_limiter has only config. Add them, from `ash_phoenix/documentation/`,
   `ash_json_api/documentation/`, `ash_graphql/documentation/`, `ash_admin/README.md`,
   `ash_authentication/documentation/tutorials/` and the `rate_limit do … end` block in
   `ash_rate_limiter/README.md:100-140`.

### R2-5. Other residual errors

| Line | Problem | Fix |
|---|---|---|
| 891 | §6 #4 still states "it is not projections/event sourcing" as fact | Contradicts §4.1's two-position framing; say "contested, see §4.1". |
| 1059-1060 | JSON:API "downloads have plateaued relative to GraphQL (164k vs 63k recent…)" | JSON:API has 2.6× GraphQL's 90-day downloads; "plateaued relative to GraphQL" is backwards. Delete or rephrase. |
| 1542-1546 | Open question still says gaps #5/#8 are absence-of-evidence and the forum was unreadable | Gaps were replaced; delete. |
| 1612-1613 | Sources still say the forum "was **not** readable from this environment" | The document now cites 9 forum threads; delete the parenthesis. |
| 1555-1561 | ash_typescript transport left open | Use the account in R2-7 below; then close the question. |
| 488 | "`clear_records_for_replay/1` wipes the relevant tables" | `clear_records_for_replay` is a DSL option naming a module; the user implements `clear_records!/1` in it (`ash_events/README.md:84-98`), and AshEvents itself wipes nothing. |

### R2-6. Fresh citation sample (30 citations not checked in round 1)

| Judgement | Count |
|---|---|
| Supports | 24 |
| Wrong line, claim true | 2 |
| Does not support | 4 |
| Nonexistent | 0 |

- **Supports:** `reactor.ex:108-110` (concurrency_key); `architecture.md:78`; `cheatsheet:53-55`;
  `reactor.md:168-180`; `reactor.md:64-97` (verbatim); `ash_events/README.md:515-525`, `:174-182`,
  `:205-210`, `:182`, `:490-513`, `:596-622`, `:644-651`; `ash_events/mix.exs:146`; forum 70777
  posts #7/#11 quotes; `test.ex:25,118,179-201,238-283`; `error.ex:10-14`; `generator.ex:753,764,
  814,870,932,988,1035` (all seven function heads at the stated lines); `ash/usage-rules/testing.md:19-32`;
  `ash_commanded/README.md:4`, `:34-39`/`:41-60`/`:62-68`; forum 70900 posts #3-#5, #10; PR #7
  merge date; `ash_double_entry/mix.exs:156`; `ash_ai/README.md:133-137`.
- **Wrong line, claim true:** `reactor.md:50-52` (the sentence is at :41); `usage_rules/README.md:86`
  (the tip is at :87).
- **Does not support:**
  - `01-getting-started.md:70-110` as an "abridged" copy (the body is rewritten).
  - `reactor.ex:108-127` for `fully_reversible` as durability.
  - Forum 70777 post #3 as "argues it is an audit log".
  - Reactor issue #334 as community evidence (closed not_planned, AI-filed).

### R2-7. ash_typescript wire transport: factual account (from the clone, v0.18.4)

All paths are under `scratch/ash-src/ash_typescript/`.

- **What the developer declares.**
  - On the **domain**: `use Ash.Domain, extensions: [AshTypescript.Rpc]` and a
    `typescript_rpc do resource MyApp.Todo do rpc_action :list_todos, :read; rpc_action :get_todo,
    :read, get_by: [:id]; … end end` block (`documentation/getting-started/installation.md:150-162`).
  - On each **resource**: `extensions: [AshTypescript.Resource]` with `typescript do type_name "Todo"
    end`; the example attributes are `public? true` (`installation.md:112-136`).
  - Referenced actions must be `public? true`, verified at compile time (`README.md:135-137`).
  - An app-wide manifest module (`use AshTypescript.Manifest, otp_app:`) registered as
    `config :ash_typescript, manifest:` is mandatory (`README.md:26-45`).
  - Codegen: `mix ash_typescript.codegen` or `mix ash.codegen` (`installation.md:224-230`).
- **Endpoints.** Two POST routes, `/rpc/run` and `/rpc/validate`, served by a controller the
  installer generates (`installation.md:69-75`). The controller calls
  `AshTypescript.Rpc.run_action(:my_app, conn, params)` and `validate_action/3` and returns
  `json(conn, result)` (`installation.md:171-196`). Endpoint paths are configurable via
  `run_endpoint`/`validate_endpoint` (`installation.md:212-221`). `otp_app` does **not** scope which
  actions are reachable; actions resolve from the single manifest (`lib/ash_typescript/rpc.ex:667-671`).
- **Request shape.** Every generated function builds a JSON payload starting with
  `action: "<rpc_action_name>"`, plus, depending on the action: `tenant`, `identity` (for
  update/destroy), `getBy`, `input`, `fields`, `filter`/`sort`/`page`, `metadataFields`
  (`lib/ash_typescript/rpc/codegen/helpers/payload_builder.ex:48-110`). Typed queries send
  `typed_query_action` instead of `action` (`lib/ash_typescript/rpc/pipeline.ex:381-406`). The
  server pops `input` and `identity`, converts other keys from the configured
  `input_field_formatter` (camelCase by default, `installation.md:219-220`), takes the actor, tenant
  and context from the Plug conn (or socket assigns for channels), then validates required
  parameters, top-level query params, requested fields, input, get_by and pagination
  (`pipeline.ex:59-140`).
- **Response shape.** Always a map, never a tuple: `%{"success" => true, "data" => …}` or
  `%{"success" => false, "errors" => [...]}`. Key casing follows `output_field_formatter`
  (`rpc.ex:673-686`, `run_action/3` at `:686-695`).
- **Errors.** Each error has `type`, `message`, `shortMessage`, `vars`, `fields`, `path` and
  optional `details` (`documentation/guides/error-handling.md:36-52`). A non-2xx HTTP response is
  turned client-side into a synthetic `network_error` with `statusCode` (`lib/ash_typescript/rpc/
  codegen/typescript_static.ex:529-547`). Since 0.18, unusable top-level `filter`/`sort`/`page`
  return `filter_not_supported`/`sort_not_supported`/`pagination_not_supported`
  (`README.md:49-53`).
- **Field selection and typed results.** `fields` is an array of attribute names plus nested objects
  for relationships/embedded values (`first-rpc-action.md:96-108`). The generated runtime includes
  utility types (`TypedSchema`, `InferResult`) that derive the result type from the selected fields
  (`typescript_static.ex:10-13`). Relationship envelopes (`page`/`filter`/`sort`/`fields`) are gated
  in the types by capability (`README.md:55-87`).
- **Fetch layer.** `executeActionRpcRequest`/`executeValidationRpcRequest` do `POST` with
  `Content-Type: application/json`, merge `headers` and `fetchOptions` from the call config, and use
  `config.customFetch || fetch` (`typescript_static.ex:433-552`). `fetchOptions` (e.g.
  `AbortSignal.timeout`, `credentials`) and `customFetch` (e.g. an axios adapter) are documented in
  `documentation/advanced/custom-fetch.md:10-70`. A `buildCSRFHeaders()` helper is generated for
  browser apps (`first-rpc-action.md:23,152-157`).
- **Lifecycle hooks.** Configured by name: `rpc_action_before_request_hook`,
  `rpc_action_after_request_hook`, `rpc_validation_before_request_hook` and
  `rpc_validation_after_request_hook` (all default `nil`;
  `documentation/features/lifecycle-hooks.md:57-86`). The before-hook receives `(action, config)`
  and returns a modified config; the after-hook receives `(action, response, result, config)`
  (`typescript_static.ex:471-492`). Channel equivalents also exist (`typescript_static.ex:555-620`).
- **Validation functions.** `validate<Action>` functions are generated when
  `generate_validation_functions: true`. They call `/rpc/validate`, which builds the
  changeset/query without executing and returns `{success: true}` or the same error array
  (`documentation/guides/form-validation.md:159-215`; server side `rpc.ex:704-717`). Channel
  variants exist (`form-validation.md:216-235`).
- **Zod/Valibot.** Opt-in via `generate_zod_schemas: true` / `generate_valibot_schemas: true`, with
  import paths and suffixes configurable, written to `ash_zod.ts` / `ash_valibot.ts` and covering
  resources, RPC actions and typed-controller routes (`documentation/reference/configuration.md:
  26-67,138-139`).
- **Typed controllers.** `use AshTypescript.TypedController` with a `typed_controller do
  module_name …; get :auth do run fn conn, params -> … end end … end` DSL. It generates an ordinary
  Phoenix controller plus TypeScript path helpers and typed fetch functions. Route `argument`s are
  validated (and since 0.18 enforced at runtime with 422s), and router path params must match
  arguments (`documentation/guides/typed-controllers.md:1-70,454`; `README.md:97`). Intended for
  cookie/session-style endpoints "where an rpc action isn't a natural fit" (`typed-controllers.md:14-16`).
- **Multitenancy.**
  - With `require_tenant_parameters: true`, a `tenant` parameter is required in every generated
    signature.
  - With the default `false`, the tenant is optional and otherwise taken from the conn
    (`documentation/features/multitenancy.md:18-36`; server fallback
    `normalized_params[:tenant] || Ash.PlugHelpers.get_tenant(conn)` at `pipeline.ex:77-81`).
- **Stated limits.**
  - Ash ≥ 3.27 and a manifest module are required (`README.md:28`).
  - Types with no TypeScript mapping fail compilation ("Unsupported types found",
    `documentation/advanced/custom-types.md:95`).
  - Hand-rolled custom types degrade to `z.any()` / `z.record(z.string(), z.any())` in schemas unless
    you use `Ash.Type.NewType` or mapping overrides (`documentation/reference/troubleshooting.md:221-240`).
  - An Ash version bump alone can change generated output (`README.md:102`).
  - Open issues: #100 (destroying a nonexistent record reports success), #95 (the igniter installer
    creates invalid routes), #84 (control over custom-type generation), #51 (TanStack Query factories
    requested).
  - There is no UI-facing authorization metadata; the maintainer's workaround is a generic action
    around `Ash.can?` (forum 73730).

### R2-8. Criteria after round 2

| # | Status | Still missing |
|---|---|---|
| 1a Sagas | complete with fixes | R2-3 items 4-5; the getting-started block label. |
| 1b Auditing | complete with fixes | Advisory-lock quote qualifier; unlabelled AshEvents block. |
| 1c Testing | **complete** | – |
| 1d ES/CQRS | complete with fixes | R2-3 items 1-3 (#99 framing, write ordering, katafrakt paraphrase). |
| 2 Ranked table | partial | R2-4 items 1-3. |
| 3 Per-package notes | partial | R2-4 item 4 (no notes for ash_money/splode, stale numbering, missing DSL examples). |
| 4 ash_typescript | partial in the document | Fold R2-7 into §7 and close the open question. |
| 5 ash_ai/usage_rules | complete with fixes | Implications #5 contradiction (l.1472-1475). |
| 6 Honorable mentions + gaps | complete with fixes | Gap #7 re-citation (Spark source), gap #10 marked as inference, stale Open questions/Sources lines. |

---

## Round 3 final check

The document was re-read in full (2,135 lines, revision log with truthful Round 2 and Round 3
sections). Line numbers below are for the **round-3** document. Every item was re-opened in the
clones, on hex.pm (moved and added rows re-fetched today), on GitHub or on the forum.

**Final verdict: ACCEPT.**
- All round-2 "still wrong" items are fixed correctly, apart from one citation that the revision log
  says was fixed and was not (`reactor.md:50-52`).
- Every code block is now verbatim or labelled as abridged, except two minor mislabels.
- The ranked table matches hex.pm. Section 7.1 matches the clone.
- Two kinds of problem remain:
  - The ranking rule's "adoption orders the rest" is not what the table does inside the domain band.
  - A handful of small factual slips.

  None of these changes a design conclusion, and all are listed under *Residual errors* with the
  correct fact, so readers can use the document without another revision.

### R3-1. Round-2 "still wrong" items

| Item | Status | Evidence |
|---|---|---|
| AshEvents write order per action type (0.8.2) | **Fixed correctly** (l.772-787) | Update: event first (`ash_events/lib/events/update_action_wrapper.ex:28-39`). Create: row first, then `create_event!` (`create_action_wrapper.ex:25-58`). Destroy: row first (`destroy_action_wrapper.ex:36-37,106`). |
| Dating of the maintainer's quote | **Fixed correctly** (l.752-755, 1882-1884) | Post #11 (2025-05-11) links `create_action_wrapper.ex` at v0.1.1. |
| Redeploy mechanism cited to Spark; #334 described accurately | **Fixed correctly** (l.1773-1781, 1902-1904) | `spark/lib/spark/code_helpers.ex:15-21` (`code_identifier/1` = MD5 of the stripped AST) and `:332-336` (`"#{key}_#{n}_generated_#{fn_name}"`). Spark lifts function-valued entity options via `lift_functions` (`spark/lib/spark/dsl/extension/entity_option.ex:30`), so Reactor's `run fn` is affected. #334 is described as AI-filed and closed `not_planned` the same day (confirmed via `gh api`). |
| `fully_reversible?` | **Fixed correctly** (l.232-236, 362-364) | `reactor/lib/reactor.ex:112-116`. |
| katafrakt quote | **Fixed correctly** (l.761-770) | Post #3 and post #10 quoted accurately (forum 70777 `.json`); post #9 quote for Position A accurate; README phrase quoted with "rather than" (`ash_events/README.md:182`). |
| Issue #99 framing | **Fixed correctly** (l.798-802, 1759-1761) | `wrap_actions.ex:51,264` (compile-time rejection in 0.8.2); #99 (open, filed against 0.8.1) reports silent discard. |
| ash_postgres example citation | **Fixed correctly** (l.1284-1294) | Verbatim match with `ash_postgres/documentation/topics/resources/references.md:13-19`. |
| Six unapplied line fixes | **Fixed correctly** | `test-resources.livemd:25-28` (l.652); `ash_ai/README.md:72`/`:82` (l.1074-1075); `ash_typescript/README.md:87` (l.1479); `rpc.ex:324-325` (l.1479); `ash/usage-rules.md:11` (l.1621); paper trail `:372` (l.1928). |
| Revision-log extra claim "`reactor.md:50-52`→`:41` also fixed" (l.2121) | **Not fixed** | l.320 still cites `ash/documentation/topics/advanced/reactor.md:50-52`; the sentence is at `:41`. |
| Ranking contradictions (splode, cut list, HM duplicates) | **Fixed** | splode is now only in §9 (l.1668); ash_money is not in the cut list or §9; no ranked package appears in either list. |
| §6 numbering / missing notes / missing DSL examples | **Fixed correctly** | 20 notes numbered 1-20 matching the table (l.947-1371). New examples verified verbatim: ash_authentication `get-started.md:183-199` (+ closing `end`), ash_rate_limiter `README.md:104-113`, ash_money tutorial `:34-36`/`:40-43`, ash_phoenix `lib/ash_phoenix.ex:133-138` (inside a docstring example), ash_json_api tutorial `:145-147`, ash_admin tutorial `:63-68`, ash_graphql `graphql-generation.md:36-43`. |
| Stale text (Implications #5, Open questions, Sources) | **Fixed correctly** | Implications #5 rewritten (l.1852-1860); Open questions (l.1922-1934) and Sources (l.~1985-1988) no longer claim the forum was unreadable or that AshCommanded is unresolved. |
| §7.1 wire transport | **Matches my account and the clone** (l.1481-1577) | Spot-checked: `installation.md:172-184` controller verbatim; `rpc.ex:666-671` quote exact; `payload_builder.ex:48-110`; `pipeline.ex:59-82, 381-390`; `typescript_static.ex:433-552, 471-480, 529-547, 555-560`; `lifecycle-hooks.md:57-70`; `form-validation.md:159-215`; `multitenancy.md:18-36`; `troubleshooting.md:221-240`. One wrong range: Zod/Valibot opt-in cited to `configuration.md:26-30,64-67,136-140`; the `generate_zod_schemas`/`generate_valibot_schemas` flags are at `:40-45` (see residuals). |

### R3-2. Code blocks

Each block was compared with its source.
- **Verbatim:**
  - Reactor getting-started: `01-getting-started.md:64-112`. The cited range `:64-110` stops two
    lines early.
  - ExampleReactor; generic action; PaperTrail config; middleware/around; halt/resume; async.
  - Generator, with its label naming the added comma and the reflow.
  - test-resources blocks; ash_archival; the ash_typescript `typescript_rpc` domain block
    (`installation.md:154-162`); `createTodo` (`first-rpc-action.md:53-71`); `getTodo` (source
    `:99-109`); the controller in §7.1.
  - All the new §6 examples, except ash_onetime (below).
- **Abridged, correctly labelled and only by omission:** compensate, AshEvents event_log/events,
  replay, Smokestack, AshCommanded, ash_ai tools, AshOban, AshStateMachine (stitched; labelled),
  AshCloak, ash_typescript manifest (merged; labelled).
- **Abridged, but the label also admits a modification:** `usage_rules` (l.1082-1084). One comment
  is reworded, and the label says so. This is not "abridged only by omission", but it is disclosed.
- **Mislabelled:** ash_onetime (l.1253-1267) is labelled "verbatim", but the README quick-start
  block continues with a second `protect :redeem do … end` (`strategy :one_time_nonce`,
  `window(...)`, `commit :independent`) that is omitted (https://github.com/baselabs/ash_onetime,
  README l.108-114).
- **Hand-written blocks:** none remain.

### R3-3. Ranking

Hex.pm re-fetched for the moved or added rows: `ash_onetime` 1.4.0 / 2026-09-24 / 2,831 / 2,831;
`ash_postgres`, `ash_phoenix`, `ash_admin`, `ash_graphql`, `ash_money`, `ash_rate_limiter` and
`splode`. All match the table. No package is both ranked and listed in the cut list or §9.

- **ash_onetime facts:** right on version, downloads, `AshOnetime.Resource`, Postgres-mandatory,
  rejection of read-only/non-transactional actions, and "not end-to-end exactly-once delivery"
  (README l.11-16, 43-55, 67).
  - **Wrong:** "released 2026-09-24 … all of them in its first days" (l.1252-1253). The package was
    first published **2026-08-09** and has **19 releases**; 2026-09-24 is only the latest one
    (hex `inserted_at`, `releases`).
  - **Also wrong:** the revision log's "both are days old" (l.2133).
- **ash_workflow / ash_credo / ash_scenario evaluations (l.897-901):** factually right (dates,
  downloads, descriptions).
- **The rule is not applied as written inside the domain band.** l.887-888 say the mandatory areas
  come first and then "adoption orders the rest". Rows 7-15 are not in adoption order:
  - `usage_rules` (301,065) sits below `ash_ai` (100,126);
  - `ash_authentication` (216,171) below `ash_typescript` (41,363);
  - `ash_money` (46,717) below `ash_rate_limiter` (43,309) and `ash_double_entry` (21,137).

  `ash_typescript`'s position is an explicitly stated exception; the others are not. Also, the
  storage/transport band contains `ash_admin` (category "Admin UI"), which is neither storage nor
  transport.

  Choosing `ash_onetime` over `ash_workflow` while calling ash_workflow "more domain-relevant"
  contradicts "relevance first"; the log admits adoption was used as a tiebreaker. This is a
  judgement call, not a factual error.
- **Storage/transport band order** (postgres 305k > phoenix 272k > json_api 164k > admin 119k >
  graphql 62k) is correct.

### R3-4. Did round 3 break content that was right after round 2?

No loss found:
- igniter/spark notes moved intact into §9 ("Notes on the demoted infrastructure packages").
- Honorable mentions are unchanged apart from removing ash_money.
- §7's pre-existing content is kept; the "Limits and sharp edges" list now partly duplicates §7.1's
  "Stated limits" (redundant, not wrong).
- One internal inconsistency is new (Implications #8, below).

### R3-5. Fresh citation sample (25 not checked in rounds 1-2)

| Judgement | Count |
|---|---|
| Supports | 21 |
| Wrong line, claim true | 3 |
| Does not support | 1 |
| Nonexistent | 0 |

- **Supports:** `installation.md:151-162`; `installation.md:224-230`; `first-rpc-action.md:53-71`;
  `ash_authentication/.../get-started.md:183-199`; `ash_rate_limiter/README.md:104-113`; ash_money
  tutorial `:34-36` and `:40-43`; `ash_money/README.md:20-22` and `:24-26`;
  `references.md:13-19`; `ash_phoenix.ex:133-138`; `forms-for-relationships-between-existing-records.md:180-183`;
  ash_json_api tutorial `:145-147`; ash_admin tutorial `:63-68`; `graphql-generation.md:36-43`;
  ash_state_machine tutorial `:140-143`/`:161-165`; ash_oban tutorial `:76-95`;
  `wrap_actions.ex:172-188`; `update_action_wrapper.ex:28-39`; `destroy_action_wrapper.ex:36-37,106`;
  `spark/lib/spark/code_helpers.ex:15-21,332-336`.
- **Wrong line, claim true:** `first-rpc-action.md:96-108` (block is `:99-109`);
  `getting-started-with-ash-cloak.md:26-41` (block is `:23-52`); `configuration.md:26-30,64-67,136-140`
  for the Zod/Valibot opt-in (flags are at `:40-45`).
- **Does not support:** the ash_onetime README block labelled "verbatim" (it omits
  `protect :redeem`).

### Residual errors (for readers)

Every statement in the round-3 document that is still wrong, with the correct fact. Apply these when
reading; everything else checked in the three rounds is reliable.

| Doc line | Statement | Correct fact and source |
|---|---|---|
| 320 | "Not all resources need to have state/data layers…" cited to `ash/documentation/topics/advanced/reactor.md:50-52` | The sentence is at `reactor.md:41`. The revision log (l.2121) wrongly says this was fixed. |
| 84 | Reactor getting-started block cited to `01-getting-started.md:64-110` | The block spans `:64-112` (the final `return :create_user` / `end` are at 111-112). |
| 292 | ExampleReactor cited to `reactor.md:64-97` | The block spans `reactor.md:64-99`. |
| 1443 | getTodo nested-fields block cited to `first-rpc-action.md:96-108` | The block is at `first-rpc-action.md:99-109`. |
| 1164 | AshCloak block cited to `getting-started-with-ash-cloak.md:26-41` | The block is at `:23-52`. |
| 1479 | Zod/Valibot opt-in cited to `configuration.md:26-30,64-67,136-140` | The flags `generate_zod_schemas` / `generate_valibot_schemas` are at `ash_typescript/documentation/reference/configuration.md:40-45`; the output-file table is at `:136-140`. |
| 1252-1253 | `ash_onetime` "released 2026-09-24 with 2,831 downloads — all of them in its first days" | First published **2026-08-09**; **19 releases**; 2026-09-24 is the latest release (1.4.0). The 2,831 downloads accumulated over about seven weeks (`https://hex.pm/api/packages/ash_onetime`: `inserted_at`, `releases`). |
| 1253 | ash_onetime DSL block labelled "verbatim … Quick start" | Abridged: the README block also contains `protect :redeem do strategy :one_time_nonce; scope([{:static, "redeem"}]); key({:verified, :proof, MyApp.ProofVerifier}); window(max_age: {5, :minute}, clock_skew: {30, :second}); commit :independent end` (README l.108-114), which shows the `:one_time_nonce` strategy described in the prose below the block. |
| 2133 | Revision log: "`ash_onetime` … and `ash_workflow` … both are days old" | ash_workflow was 12 days old (first release 2026-09-18); ash_onetime about 7 weeks (2026-08-09). |
| 887-888 | Ranking rule: "the brief's mandatory areas come first … sagas (1-3), auditing (2-3) … and adoption orders the rest" | (a) "sagas (1-3)" is garbled: reactor is #1, the auditing packages are #2-#3. (b) Rows 7-15 are **not** in adoption order (90-day downloads: usage_rules 301,065 > ash_authentication 216,171 > ash_ai 100,126 > ash_cloak 86,696 > ash_money 46,717 > ash_rate_limiter 43,309 > ash_typescript 41,363 [stated exception] > ash_double_entry 21,137 > ash_onetime 2,831). Read positions 7-15 as relevance judgements, not as an adoption ranking. (c) Brief's mandatory areas are sagas, auditing, testing and ES/CQRS (`notes/team-lead/briefs/ash-ecosystem.md:10-12`); "background work" and "state and lifecycle" (rows 4-6) are the researcher's additions, not mandatory areas. |
| 924 | `ash_admin` placed in the "storage and transport" band | It is an admin UI, neither storage nor transport; its band is a judgement call, not what the rule says. |
| 897-898 vs table | `ash_workflow` "more domain-relevant than `ash_onetime`" yet left out under a "relevance first" rule | Contradicts the stated rule. The revision log (l.2131-2133) admits adoption was used as a tiebreaker. A reader should treat #15 as interchangeable with ash_workflow. |
| 1885 (Implications #8, analysis) | "the resource tables, which were never the primary store to begin with" | Contradicts the same paragraph (l.1879-1880, 1888: "the tables are the source of truth") and §4.1 l.791 ("the resource tables remain the primary store"). The intended meaning is that the *tables* are primary and the event log is secondary. |
| 362-364 | Halt/resume described as "persisting the `%Reactor{}` struct between runs" | The cited cheatsheet (`reactor-cheatsheet.cheatmd:53-55`) shows only in-memory halt and resume (`{:halted, state}` then `Reactor.run(state, …)`). Persisting that struct is left to the application and is not documented. That is consistent with gap #7, but it is not what the citation shows. |

No other residual errors were found. Hex.pm numbers, the AshEvents, AshCommanded and Reactor
technical claims, §7.1, the gaps' URLs, and the honorable-mention data were all re-verified as
correct.

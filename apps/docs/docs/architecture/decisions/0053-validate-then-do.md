---
title: "0053. An action body is `validate`, then `do`; steps are `set`, `when`, `load` and `run`"
description: "Decision record 0053: validations, the steps of an action, the shared `always` body and reusable steps. Status: Accepted."
---

# 0053. An action body is `validate`, then `do`; steps are `set`, `when`, `load` and `run`

## Status

Accepted. Amends [ADR-0017](./0017-atomic-by-default-and-classification.md) (what a validation sees, and the end of `change`).

## Date

2026-10-05

## Deciders

operator (Saulo Vallory) for the rulings; the lead, delegated by the operator, for the three points marked "lead" below

## Context

Ash, the Elixir framework Mesh is modelled on, puts the work of an action in `change` entities and its rules in `validate` entities, interleaved in one list, plus resource-wide `changes` and `validations` sections ([Ash features](../research/ash-features.md), sections 1.1, 4.3, 4.4). Mesh copied `change=` and `validate=` as arrow functions on the action ([ADR-0034](./0034-vocabulary-copies-ash-dsl.md), superseded).

Writing the user docs showed three problems ([open questions and findings](../open-questions.md), DX finding 3). A `validate` had no `input`, so it could not reject a new empty value. The lead's amendment of 2026-10-04 made it see the record after the changes, which meant a rule ran after the work it was meant to guard. And `change` read as "a change to the record" while it was really "a step of the action", which grew to hooks, loads and arbitrary code.

## Decision

Operator, 2026-10-05, [rulings of 2026-10-04](./rulings-2026-10-04.md), section "Entity file syntax, continued (2026-10-05 morning, operator)", rows "Steps (`do`)", "Validations", "Shared body", "Reusable steps" and "Confirmed (2026-10-05)". In summary:

**Validations.**

- The shape of one field (length, pattern, range) goes on its attribute or argument line: `string #notes nullable max=2000`, `string #number match=/^INV-\d+$/`.
- The rules of an action go in a `validate` block: `require=[...]` (fields that must be present) and `check :name [ that=fn code=... message=... ]`. `:name` is a label (MX's `:name` sugar); `code` is the caller-facing code, a string or a number; `when` nests checks under a condition.
- "`validate` runs before `do` and sees the stored record plus `input` (replaces the lead's earlier 'sees the record after the changes')." A `check` runs only before the steps.

**Steps.**

- "The word `change` is gone. An action's steps go in a `do` block, run in written order; the tag is the kind of step."
- v1 steps: `set` (child lines `#field=value`, a plain value or a one-expression function), `when=cond` with nested steps (not `if`, which MX treats as control flow), `load=[...]`, and `run({ self, input, actor }) { ... }`, one-off plain code inside the transaction that makes the action non-atomic.
- Planned, not shown to users: `lock="version"`, `relate=...`, `after-commit(...) { }`. No `increment` step: `set` with an expression covers it.

**Shared body.** "`actions > always [types=... actions=...]` takes the same body as an action (`validate`, `do`) and applies it to every action in scope. Replaces Ash's top-level `changes` and `validations`."

**Reusable steps** (planned now, built later): "Defined in MX, one file per step (`step #slugify` with an `options` section and a body), under `src/domain/`; Mesh derives the tag's contract from the definition, and entity files use it as a tag: `slugify from="title" to="slug"`. Extensions contribute steps the same way."

Three points the rulings leave open, decided by the lead under the operator's delegation:

1. **Create.** A create has no stored record. Its `validate` sees, as `self`, the record built from the accepted input and the declared defaults, before any step runs.
2. **`self` during `do`.** Each step sees the record as the earlier steps left it; `when=({ self }) => self.amount > 10000` reads the amount after any `set` above it.
3. **`load`.** `load=["customer"]` loads the named relationships or computed fields onto the record the action returns, as Ash's `load` change does. It writes nothing.

The order of `always` against an action's own body: the `always` validations run before the action's, and the `always` steps before the action's, in the order the `always` blocks are written. (lead)

## Options considered

### Option A: `validate` before `do`, declared step kinds (chosen)

**Pros:** a rule guards the work instead of checking its result; each step says what kind of work it is, so the build can classify it ([ADR-0054](./0054-write-strategy-is-inferred.md)); one block shape for an action and for `always`.
**Cons:** a rule about the result of the steps cannot be written as a `check`; it needs a `run` step that throws, which makes the action non-atomic.

### Option B: Ash's interleaved `change` and `validate` list

**Pros:** familiar to Ash users; one list.
**Cons:** order-dependent and hard to read; validations ran twice in Ash's atomic path ([Ash runtime internals](../research/ash-runtime-internals.md), "Implications for Mesh", item 3).

### Option C: `validate` after the changes (the lead's amendment of 2026-10-04)

**Pros:** a rule can check computed values.
**Cons:** the rule runs after the work it guards; superseded by the operator.

## Trade-off analysis

Option A puts the rules first and makes every kind of work visible to the build, which is what lets Mesh pick the write strategy without a hint from the author ([ADR-0054](./0054-write-strategy-is-inferred.md)). The loss, rules on computed results, is rare and still expressible with `run`.

## Consequences

- `change=` and the `validate=` attribute leave the vocabulary; the code on `main` keeps them until the realignment task.
- A failed `check` raises `InvalidInputError` with the check's `code`, `message` and the `.mesh.mx` position of the `check` tag ([ADR-0039](./0039-run-time-error-positions.md) decides how the position travels).
- `always` replaces Ash's `changes` and `validations` sections.
- Step files share the `.mesh.mx` extension ([ADR-0051](./0051-mesh-mx-files-and-the-mesh-host.md)); the extension host gains "steps" as a contribution kind when they are built ([extension host](../in-depth/extension-host.md)).
- The question "which further declared steps would read better" (for example `increment`) stays open for the operator.

## Action items

- [ ] Realignment task: contracts for `validate`, `require`, `check`, `do`, `set`, `when`, `load`, `run`, `always`.
- [ ] M4: classify `check` and `set` values ([ADR-0056](./0056-translated-expressions-are-one-expression-arrows.md)).
- [ ] M5: run `validate` then `do` in the generated handler, collecting every failed check.
- [ ] Operator: list candidate declared steps (`increment` and others) and decide which to add.

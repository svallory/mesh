---
title: "0068. Steps and checks receive bound `actions` and `tx`; a `run` step may run `after=:write`"
description: "Decision record 0068: how an action calls other actions in its own transaction, what the called action checks, and how a step runs after the row is written. Status: Accepted."
---

# 0068. Steps and checks receive bound `actions` and `tx`; a `run` step may run `after=:write`

## Status

Accepted. Amends [ADR-0053](./0053-validate-then-do.md) (what a `run` body and a function-valued check, `when` or `set` value receive).

## Date

2026-10-10

## Deciders

operator (Saulo Vallory), accepting [roadmap revision 5](../roadmap/roadmap.md) on 2026-10-10 at 09:05, decision D6 with its recommended option. The names `actions` and `tx` are the roadmap author's, ruled with it.

## Context

[ADR-0053](./0053-validate-then-do.md) gives a `run` step `{ self, input, actor }` and says it "may call anything". It does not say what it can reach inside the action's transaction, and the data layer treats a nested transaction as an error (`packages/runtime/src/data-layer.ts`). That is enough for a one-off side effect and not enough for an action that writes other entities.

The [Hyper gap analysis](../research/hyper-port-gap-analysis.md) (gap G05, the largest in it) shows why this matters. Thirteen of Hyper's actions are cascades: `Task :complete` records a Completion, settles the actor's pending Submission and releases the actor's Claim in one transaction; `Task :cancel` revokes claims, withdraws a submission and cancels runs. The command's own event must come before the nested ones, so the cascade runs after the row is written. [Open question 14](../open-questions.md) already said: "Grouping several action calls in one transaction is not designed."

## Decision

1. **`actions` and `tx`.** A `run` step, and a function-valued `check`, `when` or `set` value, receive two more things beside `self`, `input`, `actor` and `context`:
   - `actions`: every generated action function, bound to the running transaction. A call joins the caller's transaction, so a throw anywhere rolls everything back. It carries the caller's context unless the call passes its own, and it is checked by the called action's own policies and runs its own steps, so a cascade can never do what its target action forbids.
   - `tx`: the reads of the running transaction, one function per read action, named as the generated ones and taking the same plain-data `filter`, `sort`, `limit` and `load`. A read through `tx` does not run read policies: it is the rule's view of stored data, available only to code written in the entity file.
2. **A step after the write.** A `run` step takes `after=:write`, written `run [after=:write] ({ self, actions }) { ... }`. It runs after the action's own row is written, still inside the transaction, and sees the stored record as `self`. A step without it runs before the write, as before. The value is an atom because it is one of a fixed set ([ADR-0066](./0066-names-and-references-are-atoms.md)).
3. **The same handle for the application.** `#mesh` exports `transaction(fn, context)`, which opens a transaction (or joins the running one) and hands `fn` `{ actions, tx }`. An application method that must answer with more than the record, such as a late result recorded in place of a rejection, composes the generated actions this way instead of re-implementing their rules. The data layer's `transaction` is re-entrant for this.
4. **Three smaller additions in the same milestone**, each needed by the port and each too small for a record of its own: a `check` may return `details` (data carried on its issue); `validate` sees `before`, the stored record, beside `self`, the record with the inputs applied; and `set` may name a relationship (`&creator=({ actor }) => actor.id`), which stores its key.

## Options considered

1. **Bound `actions` and `tx` (chosen).** Cascades are plain code in the entity file that calls the same generated functions a user would.
2. **A declarative step** (`also deleteClaim from=...`). More like Mesh, but it needs a new vocabulary and its own record, and Hyper's cascades read rows to decide what to write. Possible later.
3. **Cascades in the application**, as service functions over `layer.transaction`. No Mesh change, but then the generated actions are not the whole behaviour of the entity, which breaks [ADR-0003](./0003-generated-code-carries-behaviour.md).

## Trade-off analysis

Option 1 keeps the behaviour in the entity file and the generated code, and it makes the policies of the called action the only authority on what a cascade may do. It gives up declarativeness: a cascade is code a model cannot reason about, so `mesh explain` can say that an action composes others but not what it writes. The service-function pattern of option 3 is still used in one place on purpose, the application's own `transaction`, because it shapes results and holds no domain rule.

## Consequences

- The data-layer contract gains a re-entrant `transaction`: a call made inside a transaction joins it. The M3 acceptance tests cover it.
- Generated actions list their `run` steps and `after=:write` steps in order; a repeated cascade becomes a small pure helper that takes values, never the model ([ADR-0003](./0003-generated-code-carries-behaviour.md)).
- The user docs describe all of this in [Entities](../../docs/entities.md#do) and [Using your domain](../../docs/using-your-domain.md#several-actions-in-one-transaction).
- A policy on a called action sees the caller's `actor` and `context`, so [ADR-0071](./0071-system-key-on-the-action-context.md) is how an internal cascade is admitted.

## Action items

- [ ] M3: the re-entrant `transaction` in the data-layer contract and `data-sqlite`.
- [ ] M5: `actions`, `tx`, `after=:write`, `details`, `before` and a relationship `set` in the contracts, the actions view and the template.

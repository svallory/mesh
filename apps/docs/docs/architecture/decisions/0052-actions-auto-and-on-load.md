---
title: "0052. Actions are always named; `auto` generates plain actions; `on:load` picks the read Mesh uses"
description: "Decision record 0052: action declarations, `auto` in place of `defaults`, `on:load`, and the `arguments` section. Status: Accepted."
---

# 0052. Actions are always named; `auto` generates plain actions; `on:load` picks the read Mesh uses

## Status

Accepted. Amended by [ADR-0067](./0067-members-imports-input-static-files.md): one `input` section replaces `accept` and `arguments`; `on:load` takes a member reference.

## Date

2026-10-05

## Deciders

operator (Saulo Vallory); the lead, delegated by the operator, for the points marked below

## Context

An *action* is one named operation on an entity, and each becomes a generated TypeScript function ([ADR-0005](./0005-core-interface-is-a-function-call.md)). Ash, the Elixir framework Mesh is modelled on, lets an entity list `defaults [:read, :destroy]` to get plain actions without declaring them; Mesh copied it as `actions defaults=["read", "destroy"]` ([ADR-0034](./0034-vocabulary-copies-ash-dsl.md), now superseded). A default action was named after its type.

`defaults` did two jobs. It generated plain actions, and the generated read was also the one Mesh used when it loaded the entity on its own, for example through a relationship (`load: ["customer"]`). The second job was implicit. An entity that wanted relationship loads to hide cancelled rows had no way to say so.

Ash's positional `update :publish` became `update="publish"` in M1. With [ADR-0050](./0050-entity-file-syntax.md) every declaration is `kind #name`.

## Decision

Operator, 2026-10-05, [rulings of 2026-10-04](./rulings-2026-10-04.md), sections "Entity file syntax (2026-10-05, operator)", rows "Actions" and "Arguments", and "Entity file syntax, continued", row "Automatic actions":

> Written actions are `type #name ...`, always named. `actions auto=["read", "destroy"]` generates the plain action of each listed type, named after the type and primary. `auto` replaces `defaults`. Bare `read` / `destroy` lines are not valid.

> A nested `arguments` section with the attribute line shape: `datetime #paidAt`.

> `actions auto=["read", "destroy"]` only generates the plain actions. Which action Mesh uses when it acts on its own is a separate attribute with a modifier: `on:load="visible"`. Without it, the job falls back to the auto action of the type it needs; neither present is a build error. v1 key: `load`.

So:

- `create #create accept=[...]`, `update #pay`, `read #overdue`, `destroy #archive`. The generated function is the action name followed by the entity name: `payInvoice`, `overdueInvoice`.
- `auto=["read", "destroy"]` gives `readInvoice` and `destroyInvoice`.
- `on:load="visible"` names a read action of this same entity that exists; Mesh uses it when the entity is loaded through a relationship. Naming a read that does not exist is a build error. MX delivers it as one attribute named `on:load`. Other `on:` keys may follow; v1 has only `load`.
- Without `on:load`, Mesh uses the auto `read`. An entity loaded through a relationship with neither fails the build.
- **What a caller must send.** On a create, every accepted field that is required and has no default; on an update, none of the accepted fields (only the key).
- `arguments` holds inputs that are not attributes, in the attribute line shape. They share one input object with the accepted fields; an argument whose name collides with an accepted field is a build error. They reach functions as `input` ([ADR-0053](./0053-validate-then-do.md)).

The last three points, and the existence check on `on:load`, are the lead's, delegated by the operator ([rulings of 2026-10-04](./rulings-2026-10-04.md), section "Rulings after the review of the user docs (2026-10-05, lead under delegation)").

## Options considered

### Option A: always-named actions, `auto`, and a separate `on:load` (chosen)

**Pros:** every line has the `kind #name` shape; the automatic read is chosen explicitly, never as a side effect of a convenience list.
**Cons:** one more attribute to learn when an entity's loads need a filter.

### Option B: keep `defaults` and its implicit role

**Pros:** Ash's behaviour.
**Cons:** no way to filter relationship loads; one list doing two jobs.

### Option C: mark one read as `primary`

**Pros:** Ash has `primary?` for this.
**Cons:** a flag on one action that changes behaviour elsewhere; harder to find than an attribute on `actions`.

## Trade-off analysis

The operator's principle is one way to write each thing and few rules. Option A splits a hidden rule into a visible attribute, at the cost of one word.

## Consequences

- `defaults` disappears from the vocabulary; the contracts on `main` still have it until the realignment task.
- M7 (relationships) reads `on:load` when it emits relationship loads.
- [ADR-0050](./0050-entity-file-syntax.md)'s name-uniqueness check covers action names within `actions`, auto ones included.
- Two entities exporting the same function name stay a build error naming both ([rulings of 2026-10-04](./rulings-2026-10-04.md), "Rulings before M2", lead decisions).

## Action items

- [ ] Realignment task: replace `defaults` with `auto`; named actions in the contracts.
- [ ] M5: `arguments` reach the generated input type and `input`.
- [ ] M7: `on:load` and its build error.

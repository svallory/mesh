---
title: "0040. Package scope and command name"
description: "Decision record 0040: Package scope and command name. Status: Proposed."
---

# 0040. Package scope and command name

## Status

Proposed

## Date

2026-10-04

## Deciders

operator (Saulo Vallory), at publishing time

## Context

Mesh is split into packages in a bun workspace: `model`, `compiler`, `runtime`, `cli`, `data-drizzle`, `data-sqlite`, `data-postgres` and `ext-policies`. The roadmap writes them as `@mesh/*` and calls the developer command `mesh`. It says these "are working names; npm availability was not checked" ([roadmap](../roadmap/roadmap.md), section 3).

Plan revision 2 took the same position (question Q9, decided by the lead on the roadmap author's recommendation): the names are "Kept as working names" ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 9.1, Q9). The operator did not rule on them.

The names matter beyond publishing. Generated code imports from `@mesh/runtime` (it is "what generated code imports", roadmap, section 3), and the import rules that `verify` checks name `@mesh/model`, `@mesh/compiler` and Drizzle (roadmap, M2 test 4). So a rename after M2 changes committed generated files in every project and the rules themselves. The sister project uses a scope of its own, `@mxlang/data` and `@mxlang/core` (MX project notes, getting-started, section 2), so a scoped name is the existing convention.

No registry has been checked for `@mesh`, `mesh` or any alternative. Whether the name collides with other tools is also not checked.

## Decision

Not decided. Recommendation: keep `@mesh/*` and `mesh` as working names through development, but check npm for the scope and the command name before M2 emits the first generated import, because that is the point after which a rename starts to cost something. The final decision is the operator's, at publishing time.

It blocks nothing in M0 or M1; it blocks first publication, and, if a check fails, the shape of M2's generated imports.

## Options considered

### Option A: Keep the working names until publishing

| Dimension | Assessment |
|-----------|------------|
| Complexity | None now. |
| Cost | Zero now; a rename later touches generated files, import rules and docs. |
| Reversibility | Falls as M2 and later milestones land. |
| Risk | The scope or command may be taken. |

**Pros:** No effort; names are consistent in plan, docs and code.
**Cons:** The cost of being wrong grows with each milestone, and nothing has checked availability.

### Option B: Check and pick final names now

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: a check plus a decision. |
| Cost | A small effort now; avoids a rename later. |
| Reversibility | Easy now, harder after M2. |
| Risk | Reserving a name early ties the operator to a choice made without the whole product shape. |

**Pros:** Removes the rename risk before generated code exists.
**Cons:** Uses operator time on a decision that is not yet needed. A scope may need to be registered, which publishes nothing but is an action outside the repository.

### Option C: Unscoped names

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low. |
| Cost | Same. |
| Reversibility | Same as the others. |
| Availability | Each name is an independent claim on a shared namespace: `mesh-runtime`, `mesh-compiler`. |

**Pros:** No scope to register.
**Cons:** Eight names to find free instead of one scope; the existing convention (`@mxlang/*`) is scoped. Packages are less clearly grouped.

## Trade-off analysis

The three options differ in when the check happens, not in what the names are. Waiting costs nothing until generated code exists. After that, each milestone makes a wrong name dearer. A check before M2 keeps the saving of Option A and removes its main risk.

## Consequences

- Easier: development continues with no naming work.
- Harder: if the name proves taken, the rename touches the import rules, generated output and the docs.
- Revisit: before M2, and again at first publication.

## Action items

- [ ] Before M2: operator or lead checks whether the npm scope `@mesh` and the command `mesh` are available.
- [ ] After v1, at publishing: operator rules on the final names and records the result here.
- [ ] After v1, if renamed: update the roadmap, the import rule in `verify`, and the generated imports in one pull request.

---
title: "0082. Named checks live in a `checks` section; reusable blocks are `mixin` files; step files are dropped"
description: "Decision record 0082: the entity-level `checks` section and bare `check :name`, `mixin` files included with `use`, Mesh's `Timestamps` and `Versioned` mixins (imported from `meshfw/mixins`), and the end of step files and reusable steps. Status: Accepted (DOM-04, DOM-28, DOM-33); DOM-33's tie-break is moot after the amendment of 2026-10-13. Amended 2026-10-12 (DOM-28: a check is referenced with `&name`) and 2026-10-13 (DOM-33, DOM-04: Mesh's mixins are imported from `meshfw/mixins` and used as `use mixin=Timestamps`)."
---

# 0082. Named checks live in a `checks` section; reusable blocks are `mixin` files; step files are dropped

> **Amendment, 2026-11-17 (project mixins built).** A project's `mixin` file and `use mixin=Name` are built ([Mixins](../../docs/mixins.md)). The lead ruled the design's open decisions on 2026-11-17 (D37 in the lead's decision log, as the design recommends), awaiting the operator's review: a mixin's members come after the entity's own within each kind, in `use` order (OD2); a mixin file takes no import (OD3); a mixin uses no mixin (OD4); a shipped mixin's members are positioned at the `use` line (OD5); a name a mixin shares with the entity or another mixin is `MESH_DUPLICATE_MEMBER` at the (later) `use` line, a check on either side included (OD6); a bad `use mixin=` reuses `MESH_OPTION_VALUE` and `MESH_UNKNOWN_IMPORT` (OD7); a mixin's `actions` line takes no `on:load=` (OD8); no npm export `meshfw/mixins` (OD9); a mixin no entity uses is checked by its contracts only (OD10); a member set by a covering `always` block and by the action's own `set` will be `MESH_DUPLICATE_SET` (OD11, with the shipped mixins); a concept line in a mixin resolves against the `concepts` folder nearest the mixin's file (OD12). `Timestamps` and `Versioned` from `"meshfw/mixins"` (OD1: `insertedAt`/`updatedAt`, and `integer :version default=1` with an `always types=[:update]` bump, which does not combine with `lock &version`) are the next change.

> **Amendment, 2026-11-16 (built).** The `checks` section and `check &name` are built (`mesh-checks-section`), with a check name counted once per entity (`mesh-syn-08-check-name-uniqueness`). The illustration below reads `input`, so its create must declare the input it reads: `create :issue` takes `&issuedOn` and `&dueOn`, as [Entities](../../docs/entities.md#a-rule-several-actions-share) shows. The lead ruled the open points on 2026-11-14 (D13, D25 in the lead's decision log), awaiting the operator's review: a named check is checked once per action that uses it, in that action's scope, and `input.x` where that action takes no `x` is an error at the declaration naming the action (a translated function only; a plain one is left to `tsc` on the generated code); `check &name` may be used in an `always` block's `validate`, and is then checked for each action the block covers; a reference line takes no option; the same check listed twice for one action (in one block, or through an `always` block that covers it) is a build error; the `validate` warnings about a create's unfilled record are reported at the declaration once per create that uses it, naming it; a named check no `validate` uses is a warning; a failed named check reports the declaration's position; the model records only where a check is used (`Check.reference`), not a list of the entity's named checks. SYN-08 and the migration of `examples/hyper` landed in the same change.

> **Amendment, 2026-10-13 (DOM-33, DOM-04).** Mesh's own mixins, `Timestamps` and `Versioned`, are imported like a project's mixin, from `meshfw/mixins`, and included with `use mixin=Name`: `import { Timestamps } from "meshfw/mixins"` at the top of the entity file, then `use mixin=Timestamps` in the entity. A project's own mixin is imported from its file the same way. There is no atom form (`use :timestamps`, `use :name`), so items 2 and 3 and the example below no longer hold for the include line; in the example, the entity starts with the import and `use mixin=Timestamps`. Because each mixin is imported under its own name, a Mesh mixin and a project mixin of one name cannot clash, so the tie-break in item 3 ("the project's own mixin wins"), its trade-off paragraph and the action item to confirm it are moot, and nothing is left for the operator to confirm. The operator ruled this on 2026-10-11 and amended it on 2026-10-13. The body below is kept as history.

> **Amendment, 2026-10-12 (DOM-28, SYN-19).** `check :name` declares a check; a reference to it is `&name`, as SYN-19 says for every member ([ADR-0067](./0067-members-imports-input-static-files.md)), so item 1 below no longer holds for the reference: it is not a bare `check :name`. The operator amended DOM-28 on 2026-10-12. The reference line in `validate` is `check &name`, following SYN-19's "after a kind (`asc &dueOn`)"; that line is the lead's reading, for operator review. In the example, `validate` reads `check &dueAfterIssue`. The body below is kept as history.

## Status

Accepted. Amends [ADR-0053](./0053-validate-then-do.md) (step files and reusable steps), [ADR-0050](./0050-entity-file-syntax.md) and [ADR-0051](./0051-mesh-mx-files-and-the-mesh-host.md). The line "a project's own mixin wins over Mesh's of the same name" in DOM-33 is the lead's reading, for operator review.

Rows: DOM-04, DOM-28, DOM-33. None is open.

## Date

2026-10-11

## Deciders

operator (Saulo Vallory), 2026-10-11 (DOM-04 at 07:07; DOM-33 at 07:57).

## Context

[ADR-0053](./0053-validate-then-do.md) planned reusable steps (`step :slugify`) in their own files. The [study](../research/domain-concepts.md) (D18) found that what teams repeat is a check, or a block of attributes and actions (timestamps, a version column), and that a step file is a second kind of reuse.

## Decision

1. **Named checks are an entity-level `checks` section**, referenced by a bare `check :name` in `validate` (DOM-28).
2. **Importable fragments are `mixin` files**: the root is `mixin :name`, and an entity includes one with `use :name` (DOM-04, DOM-28). `use` is the include word for all reusable blocks.
3. **Mesh ships `:timestamps` and `:versioned` mixins**, and a project may define its own, including ones named like Mesh's (DOM-33). Lead's reading, for operator review: the project's own mixin wins over Mesh's of the same name.
4. **Step files and reusable steps are dropped** ([ADR-0053](./0053-validate-then-do.md)); no DOM row states this. Reuse is a TypeScript helper, or a mixin.

```mx "An illustration; the section and the keywords are ruled, the inner lines follow Entities"
entity :Invoice
  use :timestamps
  checks
    check :dueAfterIssue [
      that=({ input }) => input.dueOn >= input.issuedOn
      code="invalid_dates"
      message="the due date cannot be before the issue date"
    ]
  actions
    create :issue
      validate
        check :dueAfterIssue
```

## Options considered

The study's D18: (a) named checks as an extension-host run-time point written in TypeScript, after the host exists (the documented form); (b) the ADR-0053 step model, with MX `check` definition files that extensions can also contribute (recommended). The ruling took neither: named checks are an entity-level `checks` section (DOM-28), and step files were dropped, with reuse by a TypeScript helper or a mixin. That drop was ruled on 2026-10-11 with the study's answers; no DOM row states it, so this record is its source.

## Trade-off analysis

A `checks` section keeps a named rule next to the entity that owns it and needs no new file kind. Mixins cover what a helper cannot, since a helper cannot add attributes or actions. The tie-break (project wins) lets a project replace `:timestamps` with its own, at the cost that a typo in a mixin name shadows Mesh's silently; a diagnostic noting the shadowing would help.

## Consequences

- [ADR-0053](./0053-validate-then-do.md) and [ADR-0050](./0050-entity-file-syntax.md): their lists of "planned" reusable steps are replaced. [ADR-0051](./0051-mesh-mx-files-and-the-mesh-host.md): there are no step files.
- Named, reusable checks are core, not a run-time extension point; the extension-host page and the overview say so.
- User docs: [Entities](../../docs/entities.md) needs the `checks` section and a page for mixins when built.

## Action items

- [ ] Build `checks`, `mixin` and `use`, with `Timestamps` and `Versioned`. (`checks`, `mixin` and `use` are built; `Timestamps` and `Versioned` are not.)
- [x] Operator: confirm the project-wins tie-break. (Moot since the amendment of 2026-10-13: each mixin is imported under its own name.)

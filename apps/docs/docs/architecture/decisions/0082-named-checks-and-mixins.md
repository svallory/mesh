---
title: "0082. Named checks live in a `checks` section; reusable blocks are `mixin` files; step files are dropped"
description: "Decision record 0082: the entity-level `checks` section and bare `check :name`, `mixin` files included with `use`, Mesh's `Timestamps` and `Versioned` mixins (imported from `meshfw/mixins`), and the end of step files and reusable steps. Status: Accepted (DOM-04, DOM-28, DOM-33); DOM-33's tie-break is moot after the amendment of 2026-10-13. Amended 2026-10-12 (DOM-28: a check is referenced with `&name`) and 2026-10-13 (DOM-33, DOM-04: Mesh's mixins are imported from `meshfw/mixins` and used as `use mixin=Timestamps`)."
---

# 0082. Named checks live in a `checks` section; reusable blocks are `mixin` files; step files are dropped

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

A named check has the options of any `check`, and `message=` is fixed text or a function of the same arguments as `that=` and `details=` (ACT-30): `message=({ self }) => ...`. The function runs when the check fails, so a rule that lives in a `checks` section or in a mixin can name the record it refused, and the entity that includes it supplies the record. A function that throws, or returns anything but a string, fails the call with a `FrameworkError` that names the entity, the check and its line.

## Options considered

The study's D18: (a) named checks as an extension-host run-time point written in TypeScript, after the host exists (the documented form); (b) the ADR-0053 step model, with MX `check` definition files that extensions can also contribute (recommended). The ruling took neither: named checks are an entity-level `checks` section (DOM-28), and step files were dropped, with reuse by a TypeScript helper or a mixin. That drop was ruled on 2026-10-11 with the study's answers; no DOM row states it, so this record is its source.

## Trade-off analysis

A `checks` section keeps a named rule next to the entity that owns it and needs no new file kind. Mixins cover what a helper cannot, since a helper cannot add attributes or actions. The tie-break (project wins) lets a project replace `:timestamps` with its own, at the cost that a typo in a mixin name shadows Mesh's silently; a diagnostic noting the shadowing would help.

## Consequences

- [ADR-0053](./0053-validate-then-do.md) and [ADR-0050](./0050-entity-file-syntax.md): their lists of "planned" reusable steps are replaced. [ADR-0051](./0051-mesh-mx-files-and-the-mesh-host.md): there are no step files.
- Named, reusable checks are core, not a run-time extension point; the extension-host page and the overview say so.
- User docs: [Entities](../../docs/entities.md) needs the `checks` section and a page for mixins when built.

## Action items

- [ ] Build `checks`, `mixin` and `use`, with `:timestamps` and `:versioned`.
- [ ] Operator: confirm the project-wins tie-break.

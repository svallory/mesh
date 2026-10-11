---
title: "0082. Named checks live in a `checks` section; reusable blocks are `mixin` files; step files are dropped"
description: "Decision record 0082: the entity-level `checks` section and bare `check :name`, `mixin` files included with `use`, Mesh's `:timestamps` and `:versioned` mixins, and the end of step files and reusable steps. Status: Accepted (DOM-04, DOM-28, DOM-33); DOM-33's tie-break is the lead's reading."
---

# 0082. Named checks live in a `checks` section; reusable blocks are `mixin` files; step files are dropped

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
4. **Step files and reusable steps are dropped** ([ADR-0053](./0053-validate-then-do.md)). Reuse is a TypeScript helper, or a mixin.

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

Reusable steps in files (ADR-0053's plan, dropped); named checks as separate files; a `checks` section in the entity (chosen); `include` or `import` instead of `use`; a mixin kind versus a TypeScript helper only (both kept: helper for logic, mixin for declarations).

## Trade-off analysis

A `checks` section keeps a named rule next to the entity that owns it and needs no new file kind. Mixins cover what a helper cannot, since a helper cannot add attributes or actions. The tie-break (project wins) lets a project replace `:timestamps` with its own, at the cost that a typo in a mixin name shadows Mesh's silently; a diagnostic noting the shadowing would help.

## Consequences

- [ADR-0053](./0053-validate-then-do.md) and [ADR-0050](./0050-entity-file-syntax.md): their lists of "planned" reusable steps are replaced. [ADR-0051](./0051-mesh-mx-files-and-the-mesh-host.md): there are no step files.
- Named, reusable checks are core, not a run-time extension point; the extension-host page and the overview say so.
- User docs: [Entities](../../docs/entities.md) needs the `checks` section and a page for mixins when built.

## Action items

- [ ] Build `checks`, `mixin` and `use`, with `:timestamps` and `:versioned`.
- [ ] Operator: confirm the project-wins tie-break.

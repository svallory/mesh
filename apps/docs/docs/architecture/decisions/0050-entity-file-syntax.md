---
title: "0050. Entity file syntax: `kind #name options`"
description: "Decision record 0050: the line shape, sections, attributes, relationships and computed fields of an entity file, with the reference file. Status: Accepted."
---

# 0050. Entity file syntax: `kind #name options`

## Status

Accepted. Amends [ADR-0002](./0002-resource-files-are-mx.md) (what the tree contains). Builds on [ADR-0049](./0049-vocabulary-is-meshs-own.md).

## Date

2026-10-05

## Deciders

operator (Saulo Vallory)

## Context

An *entity file* declares one entity: its data, the operations on it and the rules around them ([ADR-0049](./0049-vocabulary-is-meshs-own.md)). It is written in MX concise syntax, which is indentation-based Marko syntax parsed by MX, a separate project ([ADR-0041](./0041-mx-concise-syntax.md)). MX returns a static tree of tags and attributes and runs nothing ([ADR-0002](./0002-resource-files-are-mx.md)).

The vocabulary copied from Ash gave each kind of line its own shape: `attribute="title" type="string" allow-nil=false`, `belongs-to="author" destination="user"`, `update="publish"`, `calculate="excerpt" type="string"` with a child `value`. A reader had to learn where the name goes for each tag. [ADR-0049](./0049-vocabulary-is-meshs-own.md) freed the vocabulary from Ash; this record is the shape it took.

MX concise syntax already has a shorthand for an id: `#name` after a tag. It arrives in the tree as the tag's `id`. Using it for every name means one sigil carries every name.

## Decision

The operator's rulings of 2026-10-05, [rulings of 2026-10-04](./rulings-2026-10-04.md), sections "Entity file syntax (2026-10-05, operator)" and "Entity file syntax, continued (2026-10-05 morning, operator)". In summary:

- **Line shape.** "Every declaration is `kind #name options`: the tag is the kind, `#name` (the id shorthand) names it. Names are unique within their scope; Mesh checks that. One sigil only; `:name` is not used in entity files." (`:name` is allowed only as the label of a `check`, [ADR-0053](./0053-validate-then-do.md).)
- **Entity.** `entity #Invoice table="invoices"`.
- **Attributes.** "The type is the tag: `uuid #id primary-key`, `string #number unique`, `enum #status values=[...] default="draft"`, `timestamp #insertedAt on="create"`. Required by default; `nullable` marks the exception." Shape rules for one field (`min`, `max`, `match`) go on its line.
- **Relationships.** "The destination is the tag's value: `belongs-to=Customer #customer`, `has-many=InvoiceLine #lines`, `has-one=Payment #payment`."
- **Computed fields.** "One `computed` section replaces `calculations` and `aggregates`." A calculation is a typed field with a method body, `boolean #isOverdue({ self }) { return ... }`. A rollup is `count #lineCount of="lines"` or `sum #total of="lines.amount"`; `of` is a path string checked at build time against generated path types, with a function form where a path cannot express it.
- **The record.** "Functions receive the record as `self` (fixed key), beside `actor`, `input`, `context`. Not a name derived from the entity."
- **Sections.** `attributes`, `relationships`, `computed`, `actions`, `policies`; inside an action, `arguments`, `validate` and `do`.

Actions, steps and validations are in [ADR-0052](./0052-actions-auto-and-on-load.md) and [ADR-0053](./0053-validate-then-do.md); policies in [ADR-0055](./0055-policies-are-core.md); expressions in [ADR-0056](./0056-translated-expressions-are-one-expression-arrows.md); file names and the MX host in [ADR-0051](./0051-mesh-mx-files-and-the-mesh-host.md).

### The reference file

This is the worked reference the user docs and the code follow. It uses every v1 construct once.

```mx
// src/domain/billing/invoice.mesh.mx
import { formatMoney, isStaff } from "./invoice.helpers"

entity #Invoice table="invoices"
  attributes
    uuid #id primary-key
    string #number unique match=/^INV-\d+$/
    enum #status values=["draft", "sent", "paid", "cancelled"] default="draft"
    decimal #amount
    date #dueOn
    datetime #paidAt nullable
    string #notes nullable max=2000
    boolean #needsReview default=false
    uuid #paidById nullable
    timestamp #insertedAt on="create"
    timestamp #updatedAt on="update"

  relationships
    belongs-to=Customer #customer
    has-many=InvoiceLine #lines
    has-one=Payment #payment

  computed
    boolean #isOverdue({ self }) {
      return self.status === "sent" && self.dueOn < today()
    }
    string #label({ self }) {
      return self.number + " · " + formatMoney(self.total)
    }
    count #lineCount of="lines"
    sum #total of="lines.amount"

  actions auto=["read", "destroy"] on:load="visible"
    always types=["create", "update"]
      validate
        check :amountNotNegative [
          that=({ self }) => self.amount >= 0
          code="invalid_amount"
          message="the amount cannot be negative"
        ]

    create #create accept=["number", "customerId", "amount", "dueOn", "notes"]

    update #send
      validate
        check :invoiceHasNoLines [
          that=({ self }) => self.lineCount > 0
          code="invalid_state"
          message="an invoice needs at least one line"
        ]
      do
        set
          #status="sent"

    update #pay
      arguments
        datetime #paidAt
      validate
        check :invoiceNotSent [
          that=({ self }) => self.status === "sent"
          code="invalid_state"
          message="only a sent invoice can be paid"
        ]
      do
        set
          #status="paid"
          #paidAt=({ input }) => input.paidAt
          #paidById=({ actor }) => actor.id
        when=({ self }) => self.amount > 10000
          set
            #needsReview=true
        load=["customer"]

    read #visible
      filter=({ self }) => self.status !== "cancelled"

    read #overdue
      filter=({ self }) => self.isOverdue
      sort=["dueOn"]

    read #forCustomer
      arguments
        uuid #customerId
      filter=({ self, input }) => self.customerId === input.customerId

  policies
    policy #staffOrOwnerReads types=["read"]
      authorize-if=({ self, actor }) => isStaff(actor) || self.customer.userId === actor.id
    policy #staffWrites types=["create", "update", "destroy"]
      authorize-if=({ actor }) => isStaff(actor)
    policy #neverDestroyPaid types=["destroy"]
      forbid-if=({ self }) => self.status === "paid"
```

### The rules a reader must know

1. A declaration is `kind #name options`: the tag says what it is, `#name` names it. Names are unique within their scope.
2. Sections group declarations: `attributes`, `relationships`, `computed`, `actions`, `policies`; inside an action: `arguments`, `validate`, `do`.
3. An attribute's type is its tag. Attributes are required unless marked `nullable`. Shape rules for one field (`min`, `max`, `match`) go on its line.
4. A relationship names its destination entity as the tag's value: `has-many=InvoiceLine #lines`.
5. A computed field is either a typed field with a body, or a rollup (`count`, `sum`, ...) with `of=` a path.
6. Functions receive `{ self, input, actor, context }`. A one-expression arrow is translated (it also runs in SQL); a block body is plain code.
7. `actions auto=[...]` generates the plain actions of those types, named after the type. Every written action is `type #name`. `on:load="name"` says which read Mesh uses when it loads this entity through a relationship; without it, the auto read.
8. `validate` runs first, on the stored record plus `input`: `require=[...]` and `check :label [ that code message ]`. `do` runs next, top to bottom: `set` with `#field=value` lines, `when=cond` with nested steps, `load=[...]`, `run(...) { }` for one-off code.
9. `always` under `actions` takes an action body and applies it to every action in its scope.
10. A policy has a scope (`types=`, `actions=`, or neither for all) and checks. Every policy covering an action must pass; an action no policy covers is forbidden.
11. Files end in `.mesh.mx`; one entity per file; the folder under `src/domain/` is the module.

### Not in v1

`lock`, `relate`, `after-commit`, reusable steps defined in MX (`step #slugify`), the raw-SQL escape hatch and `bypass` are planned or rejected and are not shown to users ([ADR-0053](./0053-validate-then-do.md), [ADR-0055](./0055-policies-are-core.md), [ADR-0056](./0056-translated-expressions-are-one-expression-arrows.md)).

## Options considered

### Option A: `kind #name options` for every line (chosen)

**Pros:** one shape for attributes, relationships, computed fields, actions, arguments and policies; uses an MX shorthand that exists; the type, the relationship kind or the action type is the first word a reader sees.
**Cons:** depends on MX parsing `#id` after a space ([ADR-0051](./0051-mesh-mx-files-and-the-mesh-host.md)); the set of tag names grows with every attribute type, so the contracts must be generated from the type registry.

### Option B: Ash's shapes ([ADR-0034](./0034-vocabulary-copies-ash-dsl.md))

**Pros:** already on `main`.
**Cons:** several shapes to learn; see [ADR-0049](./0049-vocabulary-is-meshs-own.md).

### Option C: A name attribute on every tag (`attribute name="title" type="string"`)

**Pros:** no dependency on MX shorthands.
**Cons:** longer lines, and two words (`attribute`, `type`) where one carries the meaning.

## Trade-off analysis

Option A minimises what a user must remember, which the operator ranks first. Its costs fall on Mesh: contracts per attribute type, an MX dependency, and a name-uniqueness check Mesh owns. Option C keeps Mesh independent of MX's shorthands at the price of every line in every user file.

## Consequences

- Easier: the user docs teach eleven rules; an agent can write an entity file from them.
- Harder: the attribute-type tags (`string`, `uuid`, `decimal`, ...) are generated from the type registry in `packages/model`, so the open question of [ADR-0037](./0037-vocabulary-source-of-truth.md) (contracts or registries as the source of truth) now decides tag names too.
- `required` by default inverts Ash's `allow_nil? true` default. A missing `nullable` is a build-time and type-level error, never a silent null.
- `self` replaces the record name derived from the entity (`post`, `todo`) in every function.
- New attribute types (`decimal`, `date`, `timestamp`) and rollup kinds (`sum`) enter the registry; which rollup kinds v1 ships is decided in M7.
- The code on `main` still has the M1 vocabulary until the realignment task ([ADR-0064](./0064-order-of-work-after-approval.md)).

## Action items

- [ ] Realignment task: contracts, fixtures and the model follow this record; `examples/blog` is rewritten in this syntax.
- [ ] M7: decide the rollup kinds (`count`, `sum`, ...) and the generated path types `of` is checked against.

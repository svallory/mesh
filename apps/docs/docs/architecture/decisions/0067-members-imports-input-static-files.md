---
title: "0067. Members are &name, entities are imports, one input section, static files"
description: "Decision record 0067: entity file syntax v4 separates declarations, member references and imported entities, unifies action input and keeps files static. Status: Accepted."
---

# 0067. Members are `&name`, entities are imports, one `input` section, static files

## Status

Accepted. Amends [ADR-0050](./0050-entity-file-syntax.md), [ADR-0051](./0051-mesh-mx-files-and-the-mesh-host.md) and [ADR-0066](./0066-names-and-references-are-atoms.md). The action-input portions of [ADR-0052](./0052-actions-auto-and-on-load.md) and [ADR-0053](./0053-validate-then-do.md) follow this amendment too.

## Date

2026-10-08

## Deciders

Operator (Saulo Vallory), with the lead's choices below explicitly distinguished from the rulings.

## Context

The operator reviewed the home example and found two things that made the language harder to read: the relationship alone put a value before its name, and action input was split between an `accept` option and an `arguments` section. Entity names resolved against a project-wide index also collided across domain modules and gave the editor no import to follow.

The resulting rulings are recorded verbatim in [Operator rulings of 2026-10-08](./rulings-2026-10-04.md#operator-rulings-of-2026-10-08-morning-review-of-the-home-example), copied from the project's working record `notes/decisions-2026-10-04.md`. The worked reference is `notes/team-lead-2026-10-04/briefs/syntax-v4.md`; its Invoice file is published in [ADR-0050](./0050-entity-file-syntax.md#the-reference-file) and [Entities](../../docs/entities.md#a-larger-example).

MX decision **182 addendum 1** adds `lineTriggers` to the planned syntax table and records Mesh's `&` sigil. MX decision **187 addendum 2** fixes Mesh's base as the static `tree` target, not the future evaluated `data` target. Both are relayed in the linked rulings. These decisions describe the target language, not the limits of the parser Mesh currently pins.

## Decision

### 1. `:name` declares; `&name` refers; `Name` is imported

An entity member — an attribute, relationship, computed field, action, check or policy — is referenced as `&name` in every position:

- After a kind: `asc &dueOn`.
- At the start of a tagless line: `&title` in `input`, `&amount=expr` in `set`.
- Inside an expression: `load=[&customer]`, `actions=[&pay]`, `() => &status === :sent`.

Inside a function `&x` means `self.x`. The latter remains legal: Mesh does not make legal syntax illegal. The docs write `&x`; they show `self` only when passing the whole record to a helper. An unknown member is a positioned build error with a suggestion.

Declaration names remain atoms (`entity :Invoice`, `check :invoiceIsSent`). Fixed-set and enum values remain atoms too: `auto=[:read]`, `types=[:create]`, `on=:create`, `values=[:draft, :sent]`, `default=:draft`. Text and paths remain strings, including `code="invalid_state"` and `of="lines.amount"`.

### 2. Other entities are imported identifiers

A file exports its entity under its declared name. Import it by relative path: `import { Customer } from "./customer.mesh.mx"`, then write `belongs-to :customer entity=Customer`. The same shape applies to `has-many :lines entity=InvoiceLine` and `has-one :payment entity=Payment`.

There is no atom destination and no qualified-name alternative. The folder under `src/domain/` remains the module: no `module=` line, no top-level application name. Two folders may each declare an `entity :List` without conflict because paths distinguish them.

A `belongs-to` puts the key column on this entity; a `has-one` expects it on the other. The generated column is TypeScript surface, not entity-file vocabulary: the file names `&customer`, not the generated `customerId` column.

### 3. One `input` section is the whole action input

Each line is either:

- `&title`: take a declared attribute as declared, with its type and rules. No options are allowed on this line. A declared `belongs-to` such as `&customer` takes the related record's id.
- `kind :name options`: declare an argument, with the same shape as an attribute. It reaches code as `input.name` and is not stored as sent.

The same name twice is a build error, including a member line and an argument with that name. A read takes `input` too: `uuid :customerId`, used by its filter as `input.customerId`. `accept=`, the `arguments` section and `require=` are gone.

### 4. Entity files are static

No conditionals or loops add or remove declarations. A condition is `when=` on the policy or check it conditions, or is inside the expression. A rule over a has-many is an expression such as `&lines.every(...)`, not a `for` that generates checks. Expressions must still translate where SQL is required.

`structural: "reject"` stays. Mesh builds on `tree`; it does not request the future evaluated `data` target. There is no `let`, `const` or `define` in the entity vocabulary. A reusable fragment, if the engine port needs one, is future Mesh vocabulary rather than adopted control flow.

### The lead's choices inside the rulings

These choices come from the worked reference and remain overrulable by the operator:

- `&customer.id` in a filter compares the key column without a join.
- A function that reads only members takes no parameters: `() => &status === :sent`. Destructure `actor` and `input` when used, and `self` only to pass the whole record.
- A computed method reading only members has empty parameters: `boolean :isOverdue() { … }`.
- `on:load=&visible` is a member reference like any other.
- The create input type has `customer: Customer["id"]`; the record type keeps `customerId: string` and a customer property when loaded. [Calling actions](../../docs/calling-actions.md#relationship-input-and-record-fields) explains the distinction once.

## Options considered

- **Keep atoms for references and entity lookup.** Fewer changes, but declarations and uses remain visually identical and project-wide entity names collide.
- **Use imports for entities and a separate member sigil (chosen).** Paths resolve cross-file identity; `&` makes a use distinct from a declaration. It costs a syntax-table dependency.
- **Keep input split between two places.** Smaller implementation change, but the reader has to combine two declarations to find one function's input.
- **Evaluate control flow to build the entity tree.** Could save repeated declarations, but an input-dependent tree adds another level of behaviour to a language intended to declare the domain statically. Rejected.

## Consequences

- The docs, reference file, input type samples and diagnostics move together to syntax v4. The compiler and example still await realignment; this record does not claim they implement v4.
- `accept`, `arguments` and `require` leave the vocabulary. MX also drops the special `:name`-after-value form that the old relationship spelling needed.
- **Pinned parser gap:** `@mxlang/data` alpha.5 rejects `asc &dueOn` and `&x` in operand positions. Under structural rejection, imports need `imports: "pass"`, which was verified in the pinned alpha.5 at run time. It accepts `entity=Customer` and tagless member lines, but that does not give them Mesh semantics. Full member syntax waits for the syntax table (decision 182 addendum 1).
- **Temporary docs bridge:** `normaliseV4` in the compiler's repository check maps unsupported member spellings in memory, then really parses with `structural: "reject", imports: "pass"`. Imports stay authored. The pin also rejects comments as structure, so the bridge blanks only leading file comments (the Invoice path line); in-body comments remain a reported MX gap rather than an excuse to weaken rejection. Old v3 reference and input spellings fail before parsing. Only the contracts parse is deferred, counted and printed as `syntax v4, pending the MX syntax table`.
- **Highlighting is owed to MX:** semantic tokens from the resolved syntax table or a Mesh grammar will supply the layer-2 route (`mesh-syntax-highlighting-route`). Uncoloured member references are accepted for this docs review round; the existing grammar already recognises imports. The pinned highlighter also treats `input` as an HTML void tag. `MX_V4_INPUT_PENDING_SYNTAX_TABLE` temporarily gives a standalone nested input section and its bare member lines same-width stand-ins, renders the authored text, and reports its count. Other grammar failures still fail the build.
- Same-named entities in different folders no longer conflict as references. How the generated aggregate entry point exposes colliding action exports remains a separate [open question](../open-questions.md), not a reason to restore a global entity-name index.

## Action items

- [ ] Realignment: implement the v4 vocabulary and imported entity identity on the current MX release.
- [ ] Pin the MX syntax table and remove `normaliseV4` once its parser reads the authored fences.
- [ ] MX: deliver the highlighting route, including non-void `input`, then remove the named highlighter allowance.

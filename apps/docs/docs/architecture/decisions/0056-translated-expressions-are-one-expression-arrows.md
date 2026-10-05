---
title: "0056. Translated expressions are one-expression arrows; Mesh builds its own translator"
description: "Decision record 0056: which functions in an entity file run in SQL, how unsupported code is reported, and the result of the expression-language research. Status: Accepted."
---

# 0056. Translated expressions are one-expression arrows; Mesh builds its own translator

## Status

Accepted. Amends [ADR-0010](./0010-one-expression-tree-two-evaluators.md) (how an expression is classified).

## Date

2026-10-05

## Deciders

operator (Saulo Vallory) for the rule and the research; the lead, delegated by the operator, for acting on the research result (after its fact-check) and for the parameter rule below

## Context

An entity file holds small functions: a `filter`, a `check`'s `that`, a `set` value, a policy check, a computed field. [ADR-0010](./0010-one-expression-tree-two-evaluators.md) turns each into one expression tree with two evaluators, in memory and in SQL, as Ash does. It classified an expression by its content: *translatable* if every construct converts to the tree, *opaque* otherwise, emitted as TypeScript. A user could not see which class a function had without running `mesh explain`, and a small edit (calling a helper) silently moved a filter from SQL to an error, or a rule from SQL to memory.

The operator asked, before Mesh builds a translator, whether an existing project already lets one write ordinary TypeScript expressions bound to a data model and run them both in memory and as SQL.

## Decision

Operator, 2026-10-05, [rulings of 2026-10-04](./rulings-2026-10-04.md), section "Entity file syntax, continued (2026-10-05 morning, operator)", row "Expressions":

> Translated expressions are one-expression arrows; a block body is never translated. Their parameter types expose only what translates; unsupported constructs are diagnosed in the editor through the contracts' `analyze` hook. Before building the translator, research whether an existing project lets one write ordinary TypeScript expressions bound to a data model and run them both in memory and as SQL; if none fits, Mesh implements it. A raw-SQL escape hatch (like Ash's `fragment`) is planned, not in v1.

So the class is decided by the form the author chose, not by what the body contains:

- `({ self }) => self.status === "sent"` is **translated**: one tree, run in SQL where a query needs it and in memory otherwise. A construct the translator does not support is an error at that node, in the editor and in the build. It is never silently demoted to plain code.
- `({ self }) { return ... }` (a block body, a method body on a computed field, or a `run` step) is **plain code**: emitted as TypeScript, run in memory only. It cannot appear where SQL is required (`filter`, a read policy, a rollup's `of`).
- The function parameters `{ self, input, actor, context }` are typed so that, inside a one-expression arrow, the editor offers only what translates.

**The research** ([expression language](../research/expression-language.md), fact-checked in [its review](../research/reviews/expression-language-review.md)) found no *established* project that captures a normal TypeScript arrow and runs it both in memory and as SQL. It found one young project with the same design: Greffon (<https://github.com/PhenX/Greffon>), which captures TypeScript lambdas at build time and runs one expression tree in memory and as Postgres or SQLite SQL. Greffon's repository was created on 2026-08-14; it has no stars and four downloads a week, and its behaviour is known only from its docs. The lead, delegated by the operator, decided ([rulings of 2026-10-04](./rulings-2026-10-04.md), section "Expression language, after the fact-check"):

> Does Mesh still implement its own expression language? Yes. Greffon is seven weeks old with no users; Mesh cannot put its core on it. The research conclusion changes from "no project" to "no established project".

> The dev who designs the expression compiler reads Greffon's source and docs first and reports what to copy and whether depending on it later is realistic.

So Mesh implements the translator, after reading Greffon, and copies the design the research recommends: two interpreters over one tree; a small enumerated node vocabulary with an allow-listed function call; relationship traversal rewritten into joins as a normalisation pass before SQL; a declared supported subset checked before anything else; parameters, never closures; policies folded into the query tree.

**Parameters** (lead). A part of a translated expression that does not read `self` (for example `isStaff(actor)` or `today()`) is evaluated once, in memory, before the query, and enters the SQL as a bound parameter. This is how an imported helper may appear in a policy check, and why imported helpers must be pure.

The raw-SQL escape hatch is planned after v1.

## Options considered

### Option A: classify by form; build the translator (chosen)

**Pros:** the author sees from the code whether a rule runs in SQL; errors appear in the editor, not at run time; the research shows there is nothing established to reuse.
**Cons:** Mesh owns a translator, an evaluator and their agreement tables ([ADR-0010](./0010-one-expression-tree-two-evaluators.md)); editor diagnostics depend on MX's editor support for data files.

### Option B: classify by content ([ADR-0010](./0010-one-expression-tree-two-evaluators.md) as written)

**Pros:** any function that happens to translate runs in SQL.
**Cons:** invisible classification; a small edit changes where a rule runs.

### Option C: depend on an existing project

**Pros:** less code.
**Cons:** no established one fits ([expression language](../research/expression-language.md), section 6). Greffon has the same design but is at version 0.1.1, seven weeks old, with no users; Mesh cannot put its core on it. tinqer, the older neighbour, is at 0.0.28, has no in-memory evaluator and reports errors only at run time.

## Trade-off analysis

Option A trades flexibility (a block body never runs in SQL) for predictability, which the project ranks above convenience everywhere else (no silent fallback, [roadmap](../roadmap/roadmap.md), section 2, principle 2). Option C was checked: the only matching project is too young to depend on, though worth reading first.

## Consequences

- "Opaque" now means "a block body". The [expressions](../in-depth/expressions.md) page and the roadmap's M4 tests change from "classified as translatable or opaque" to "a one-expression arrow either translates or fails at the node".
- The write-strategy inference of [ADR-0054](./0054-write-strategy-is-inferred.md) reads the form: a block body in a `set` value or a `run` step makes an update read-then-write.
- The research's list of pitfalls (null and `undefined`, booleans on SQLite, dates, string case and `LIKE`, short-circuit evaluation, coercion) is input to [ADR-0012](./0012-expression-semantics.md), which stays Proposed and must be ruled before M4.
- The translator works over the Babel node MX hands over ([ADR-0043](./0043-mx-is-core.md)); the editor diagnostics come from the composed contracts' `analyze` hook ([ADR-0021](./0021-composed-contracts-module.md)).

## Action items

- [ ] Operator or lead: rule [ADR-0012](./0012-expression-semantics.md) before M4.
- [ ] M4, first task: read Greffon's source and docs and report what to copy, and whether depending on it later is realistic.
- [ ] M4: the translator, the supported subset, the parameter rule and the agreement tables.
- [ ] After v1: the raw-SQL escape hatch.

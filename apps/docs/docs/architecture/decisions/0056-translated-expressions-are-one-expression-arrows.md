---
title: "0056. A function whose body is one expression is translated; Mesh builds its own translator"
description: "Decision record 0056: which functions in an entity file run in SQL, how unsupported code is reported, and the result of the expression-language research. Status: Accepted."
---

# 0056. A function whose body is one expression is translated; Mesh builds its own translator

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

The lead, delegated by the operator, sharpened the first sentence after the review of the user docs ([rulings of 2026-10-04](./rulings-2026-10-04.md), section "Rulings after the review of the user docs (2026-10-05, lead under delegation)", row "Which functions does Mesh translate to SQL?"):

> A function whose body is one expression: an arrow `(...) => expression`, or a method body that is a single `return expression`. Anything else is plain code and runs in memory only. Using a plain-code computed field in a filter, a sort, a policy or another translated expression is a build error that names the field.

The reason: the reference file's `boolean #isOverdue({ self }) { return ... }` is a method body used by a filter, so "a block body is never translated" made the reference fail its own build.

So the class is decided by the form the author chose, not by what the body contains:

The lead then settled what happens to a computed field whose one-expression body cannot be translated (same file, same section, its second table):

> It is not an error. A computed field is translated when its body is one expression Mesh can translate; otherwise it runs in memory. The build error comes only where SQL is required: a filter, a sort, a policy, or a translated expression that uses that field. The error names the field and the part that could not be translated. `mesh explain` shows which computed fields are translated. Nobody writes a second statement to opt out.

Without it, `string #label({ self }) { return self.number + " · " + formatMoney(self.total) }` (a helper call on `self`) fails the build, and the only fix is an artificial two-statement body.

So:

- **Translated**: a body that is one expression Mesh can translate. `({ self }) => self.status === "sent"`, or a computed field written `boolean #isOverdue({ self }) { return self.status === "sent" && self.dueOn < today() }`. One tree, run in SQL where a query needs it and in memory otherwise.
- **Where SQL is required** (a `filter`, a `sort`, a policy check, a rollup's `of`, or inside another translated expression), the expression must translate. A construct the translator does not support there is a build error at that node, in the editor and in the build; using a computed field that runs in memory there is a build error that names the field and the part that could not be translated.
- **A computed field** whose single expression cannot be translated (`#label`, which calls `formatMoney(self.total)`) is not an error: it runs in memory after the record is loaded. `mesh explain` shows which computed fields are translated.
- **Plain code**: a body with more than one statement, or a `run` step. Emitted as TypeScript, run in memory only, with the same restriction where SQL is required.
- **A `check`'s `that`, a `when` or a `set` value** whose single expression cannot be translated is not an error either: it runs in memory, which makes the action read-then-write, and `mesh explain` names the expression that caused it ([ADR-0054](./0054-write-strategy-is-inferred.md)).
- So only a `filter`, a `sort` and a policy (and a rollup's `of`, or a translated expression that uses a field) require SQL, and only there is an untranslatable expression a build error.

The lead then ruled the same for steps and checks (same file, same section, second table, next row): an untranslatable one-expression body in a `check`, a `when` or a `set` value "Not an error either. It runs in memory, which makes the action read the record first and then write (not one statement); `mesh explain` says so and names the expression that caused it." It is the inferred write strategy of [ADR-0054](./0054-write-strategy-is-inferred.md) applied to expressions: an error there would contradict it.
- The function parameters `{ self, input, actor, context }` are typed so that, inside a translated body, the editor offers only what translates.

**The research** ([expression language](../research/expression-language.md), fact-checked in [its review](../research/reviews/expression-language-review.md)) found no *established* project that captures a normal TypeScript arrow and runs it both in memory and as SQL. It found one young project with the same design: Greffon (<https://github.com/PhenX/Greffon>), which captures TypeScript lambdas at build time and runs one expression tree in memory and as Postgres or SQLite SQL. Greffon's repository was created on 2026-08-14; it has no stars and four downloads a week, and its behaviour is known only from its docs. The lead, delegated by the operator, decided ([rulings of 2026-10-04](./rulings-2026-10-04.md), section "Expression language, after the fact-check (2026-10-05, lead under delegation)"):

> Does Mesh still implement its own expression language? Yes. Greffon is seven weeks old with no users; Mesh cannot put its core on it. The research conclusion changes from "no project" to "no established project".

> The dev who designs the expression compiler reads Greffon's source and docs first and reports what to copy and whether depending on it later is realistic.

So Mesh implements the translator, after reading Greffon, and copies the design the research recommends: two interpreters over one tree; a small enumerated node vocabulary with an allow-listed function call; relationship traversal rewritten into joins as a normalisation pass before SQL; a declared supported subset checked before anything else; parameters, never closures; policies folded into the query tree.

**What a translated expression may reference** (the lead, delegated by the operator, [rulings of 2026-10-04](./rulings-2026-10-04.md), section "Rulings after the review of the contributor docs (2026-10-05, lead under delegation)"): its parameters, registered functions, and calls to imported pure functions that do not read `self`, such as `isStaff(actor)` or `today()`. Such a call is evaluated once in memory before the query and bound as a parameter. A bare captured value (a variable from the file) is a build error.

The raw-SQL escape hatch is planned after v1.

## Options considered

### Option A: classify by form; build the translator (chosen)

**Pros:** the author sees from the form of the code whether a rule runs in SQL; errors appear in the editor, not at run time; the research shows there is nothing established to reuse.
**Cons:** Mesh owns a translator, an evaluator and their agreement tables ([ADR-0010](./0010-one-expression-tree-two-evaluators.md)); editor diagnostics depend on MX's editor support for data files.

### Option B: classify by content ([ADR-0010](./0010-one-expression-tree-two-evaluators.md) as written)

**Pros:** any function that happens to translate runs in SQL.
**Cons:** invisible classification; a small edit changes where a rule runs.

### Option C: depend on an existing project

**Pros:** less code.
**Cons:** no established one fits ([expression language](../research/expression-language.md), section 6). Greffon has the same design but is at version 0.1.1, seven weeks old, with no users; Mesh cannot put its core on it. tinqer, the older neighbour, is at 0.0.28, has no in-memory evaluator and reports errors only at run time.

## Trade-off analysis

Option A trades flexibility (a multi-statement body never runs in SQL; a computed field that cannot be translated cannot be filtered on) for predictability, which the project ranks above convenience everywhere else (no silent fallback, [roadmap](../roadmap/roadmap.md), section 2, principle 2). Option C was checked: the only matching project is too young to depend on, though worth reading first.

## Consequences

- "Opaque" now means "plain code": a body that is not one expression. The [expressions](../in-depth/expressions.md) page and the roadmap's M4 tests change from "classified as translatable or opaque" to "a one-expression body either translates or fails at the node".
- The write-strategy inference of [ADR-0054](./0054-write-strategy-is-inferred.md) reads the form: a plain-code `set` value or a `run` step makes an update read-then-write.
- The research's list of pitfalls (null and `undefined`, booleans on SQLite, dates, string case and `LIKE`, short-circuit evaluation, coercion) is input to [ADR-0012](./0012-expression-semantics.md), which stays Proposed and must be ruled before M4.
- The translator works over the Babel node MX hands over ([ADR-0043](./0043-mx-is-core.md)); the editor diagnostics come from the composed contracts' `analyze` hook ([ADR-0021](./0021-composed-contracts-module.md)).

## Action items

- [ ] Operator or lead: rule [ADR-0012](./0012-expression-semantics.md) before M4.
- [ ] M4, first task: read Greffon's source and docs and report what to copy, and whether depending on it later is realistic.
- [ ] M4: the translator, the supported subset, the parameter rule and the agreement tables.
- [ ] After v1: the raw-SQL escape hatch.

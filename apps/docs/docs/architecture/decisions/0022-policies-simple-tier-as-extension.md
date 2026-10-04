---
title: "0022. Policies start as a simple tier, in a first-party extension"
description: "Decision record 0022: Policies start as a simple tier, in a first-party extension. Status: Accepted."
---

# 0022. Policies start as a simple tier, in a first-party extension

## Status

Accepted

## Date

2026-10-04

## Deciders

operator (Saulo Vallory) for the depth of the engine; the roadmap author for placing it in an extension (plan revision 2, D3), following the research proposal; lead and operator may overrule

## Context

A *policy* is a declared rule about who may run an action or see a record. Ash, the Elixir framework Mesh is modelled on, compiles every policy of an action into one boolean formula over its checks and solves it with a SAT solver (a program that finds which combinations of true and false satisfy a formula). The solver returns a list of "scenarios", sets of checks that could all be true, not a single yes or no ([Ash runtime internals](../research/ash-runtime-internals.md), section 6.4). Read policies become query filters, so a forbidden record looks like "not found" (same file, section 6.5). Its breakdown output is "the best debugging tool in the framework" ([research synthesis](../research/synthesis.md), section 2.2).

The synthesis put authorization in "a fixed slot in the core lifecycle, filled by a first-party policy extension" ([research synthesis](../research/synthesis.md), section 10, last paragraph) and listed "Policies (first-party, on by default)" in the extension column of the ring table (section 15).

## Decision

Ruling 6, operator, 2026-10-04, [rulings of 2026-10-04](./rulings-2026-10-04.md), table of eight rulings:

> Simple tier first: ordered allow/deny checks, read policies as query filters, structured breakdown output. Keep the policy formula representation so a SAT solver can be added later.

The rest is the roadmap author's design. The slot is core; the engine is the `ext-policies` extension. The policy tags, now in the core contracts, move to it in M8 through the mechanism of [ADR-0020](./0020-extension-contributions-through-declared-points.md) ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), section 8, D3), and `forbid-if` is added so a check can deny as well as allow ([roadmap](../roadmap/roadmap.md), M8). The policy is kept as a boolean formula in the model. Field policies, bypass rules, policy groups and access types are out of scope.

Write policies ([roadmap](../roadmap/roadmap.md), M8): a check that needs no record runs in memory before the statement. A check that reads the record is folded into the atomic statement's condition, so a row the caller may not change is reported as not found, as for reads. The lead accepted this as matching Ash ([rulings of 2026-10-04](./rulings-2026-10-04.md), section "Lead decisions of the architecture-docs brief"). The research supports only part of that: for a single-record atomic update Ash compiles the authorization check into the UPDATE statement, but as an expression that raises an error, not as a filter ([Ash runtime internals](../research/ash-runtime-internals.md), section 6.6). The research documents the read case (filtered, so "not found": same file, section 6.5, and [research synthesis](../research/synthesis.md), section 2.2); "not found" for a forbidden write is a deliberate deviation from Ash, which reports an error, and the write case is not checked further. On a non-atomic action it is evaluated in memory on the locked row and a denial is reported as forbidden, with the breakdown. A write policy that cannot be translated on an atomic action is a build error. `can` gives the breakdown. From M8 the example gets a policy for every action of every example resource. That outcome is a working assumption, not a decision: [ADR-0046](./0046-denied-atomic-write-outcome.md) (Proposed) holds the options, with Ash's behaviour as the alternative.

## Options considered

### Option A: Simple tier (chosen)
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: ordered checks, filter translation, breakdown as data |
| Cost | Moderate in M8; no solver dependency |
| Debuggability | High: first decisive check wins, as in Ash's own `evaluate` rule ([Ash runtime internals](../research/ash-runtime-internals.md), section 6.4) |
| Reversibility | Good: the formula stays in the model |

**Pros:** the researcher's view is that SAT "should be opt-in" and a plain tier covers most apps ([Ash runtime internals](../research/ash-runtime-internals.md), "Implications for Mesh", item 6; the 80% figure there is an estimate, not a measurement). Read policies must become filters over Mesh's own expression tree ([roadmap](../roadmap/roadmap.md), section 7); an external engine would need an integration that translates its conditions into that tree, and nobody has assessed that.
**Cons:** no reasoning across overlapping policies; teams used to Ash's bypasses and groups must restructure. Mesh builds and maintains its own engine.

### Option B: SAT solver from the start (Ash)
| Dimension | Assessment |
|-----------|------------|
| Complexity | High: formula building, simplification helpers, scenario handling |
| Cost | High; Ash's solver sits on an optional backend, one of two packages ([Ash runtime internals](../research/ash-runtime-internals.md), section 6.4) |
| Debuggability | Good output, hard internals |
| Reversibility | Hard to simplify later |

**Pros:** the full Ash model; scenarios let the system decide before reading data.
**Cons:** the synthesis says not to build it yet ([research synthesis](../research/synthesis.md), section 8, "Do not build yet").

### Option C: An external authorization tool
| Dimension | Assessment |
|-----------|------------|
| Complexity | Not assessed |
| Cost | Not assessed |
| Read policies as filters | Cerbos-style engines need explicit host integration before a condition can become SQL ([TypeScript prior art](../research/ts-prior-art.md), section 3.6) |
| Reversibility | Not assessed |

Cerbos, OpenFGA, Oso and CASL appear in the inventory ([TypeScript foundation candidates](../research/ts-foundation-candidates.md), "Authorization"). They were inventoried, not compared ([research synthesis](../research/synthesis.md), section 13), so no pros and cons are claimed.

## Trade-off analysis

B costs most and the synthesis defers it. C cannot be assessed without a comparison nobody has done. A is the cheapest step that keeps Ash's best ideas (filters, breakdowns) and does not close the door on B.

## Consequences

Easier: reading why a call was denied. Harder: users needing bypasses or field policies wait. Revisit if a project needs overlapping policies, or if an external tool is compared.

## Amendment — 2026-10-04: create policies see the proposed record

**Status: Proposed. Deciders: lead; the operator may overrule.** Source: [rulings before M2](./rulings-2026-10-04.md).

A create policy sees the proposed record after the action's changes, not a stored row that does not exist yet. Reading a related record, such as `todo.list.ownerId`, is a query **inside the transaction, before the insert**. The generated action obtains the related data there and checks the policy before writing. It does not insert first and authorise afterwards, or query outside the transaction.

This fills the create case that the earlier write-policy discussion left unstated; the update and destroy discussion remains historical and is not rewritten. M8 must test both an allowed create and a denied create that leaves no inserted row, including a check that reads a related record.

## Action items
- [ ] M8: move policy tags into `ext-policies`; add `forbid-if`.
- [ ] M8: structured breakdown, `can` per action, formula round-trip through `model.json`.
- [ ] M8: write policies folded into atomic statements, in-memory on locked rows otherwise; a policy for every example action.
- [ ] After v1: compare external authorization tools if the simple tier proves too small.

---
title: "Open questions and findings"
description: "Everything the user docs deliberately do not say: unsettled decisions, DX findings, and what the docs had to invent."
---

# Open questions and findings

::: callout info "Vocabulary note"
The pages under [Docs](../docs/index.md) are written in the terms the operator ruled on 2026-10-04: an **entity** (not a resource), each folder inside `src/domain/` is a **module**, generated code lives in **`.mesh/`** (not `generated/`), and an action's second argument is the **action context** (not a scope).

The code, the decision records, the roadmap and the research pages in this section still say *resource*, the `domain=` attribute, *`generated/`* and *scope*, and the packages are still `@mesh/*` (the operator ruled the npm scope to be **`meshfw`**: `@meshfw/cli`, `@meshfw/runtime`, `@meshfw/data-sqlite`, `@meshfw/data-postgres`, `@meshfw/ext-policies`, scaffolded with `bun create meshfw <dir>`). The product is Mesh, the command is `mesh`, the import specifier is `#mesh` and the configuration file is `mesh.config.ts` in both vocabularies. That is not drift to fix page by page: a rename task sweeps the code, the contracts, the fixtures and these architecture pages together. Until it runs, a reader comparing a Docs page with an Architecture page will see two vocabularies, and the Docs page is the one that states the target.
:::

The pages under Docs are written as if Mesh 1.0 were released: no open questions, no milestones, no hedges. Everything below is what those pages had to leave out, and where each item has to be settled. A page under Docs that has to say "this is not decided" has found a gap, which is the point of writing it first.

## DX findings

The findings below came from writing the Docs pages against the design. Each names what a user would have had to work out alone, and the record it touches. **Settled** marks the three the operator has since ruled on; the rest are open.

| # | Finding | Status |
|:--|:--|:--|
| 1 | How a generated handler gets its database connection. `createTodo(input, context)` leaves only module state. Settled by `bind(dataLayer)` and `connect()` ([ADR-0047](decisions/0047-actions-are-bound-to-a-data-layer.md)). | settled |
| 2 | Tests on SQLite `:memory:` need the schema inside the test's own process, while the schema tools are commands in another process. Settled by the adapter's own schema function ([ADR-0048](decisions/0048-schema-inside-the-process-for-tests.md)). | settled |
| 3 | `validate` had no `input` parameter, so on an update it saw only the stored value and could not reject a new empty one. The Docs pages state the lead's amendment to [ADR-0017](decisions/0017-atomic-by-default-and-classification.md): `validate` receives the record as it will be after the changes, plus the caller's `input`. Needs the operator's ratification. | open |
| 4 | A create policy that reads a related record had no place in the lifecycle. The Docs pages state the lead's amendment to [ADR-0022](decisions/0022-policies-simple-tier-as-extension.md). Needs the operator's ratification. | open |
| 5 | Generated code imports `zod`, `drizzle-orm` and `@opentelemetry/api`, so a user's project must depend on them at versions Mesh pins. The Docs pages state the three as ordinary dependencies rather than hiding them behind `@mesh/runtime`. Touches [ADR-0014](decisions/0014-sql-adapters-on-drizzle.md), [ADR-0028](decisions/0028-validation-zod-behind-standard-schema.md), [ADR-0029](decisions/0029-tracing-opentelemetry-api.md). | open |
| 6 | "Policies on by default" cannot be a core default, because core must not know an extension. The Docs pages read it as "the starter enables `policies()`" and rely on deny-by-default once it is on ([ADR-0036](decisions/0036-deny-by-default-arrives-with-policies.md), mapping exception X2). | open |
| 7 | Adapter commands wrap drizzle-kit, which is a development dependency, so a user who skips it meets a confusing failure at `mesh db push`. | open |
| 8 | `<action><Entity>` names read badly: `pendingTodo` for a read named `pending`, and `readTodo` returning an array. The Docs pages use the rule the roadmap states and say so plainly. | open |
| 9 | Nothing says how a `.mx` file calls hand-written code. `structural: "reject"` means there is no import tag, so the Docs pages say a `change` or a `validate` calls a helper by name. Touches [How Mesh uses MX](in-depth/mx-integration.md). | open |
| 10 | No watch mode and no editor diagnostics for `.mx` files, so every edit needs a manual `mesh build`. | open |
| 11 | Connection details were written twice: in `mesh.config.ts` for the build and the commands, and again at run time. The Docs pages resolve it by making `connect()` take no arguments and read the configuration. That is a decision the operator has not ratified; the alternative was `connect({ file })`. | open |
| 12 | Whether committed migrations are covered by `mesh build --check` is not stated, so a hand-edited migration and a stale `.mesh/schema.ts` can drift. The Docs pages do not claim the guard covers `migrations/`. See [generated code and the guard](in-depth/generated-code-and-guard.md). | open |
| 13 | Column naming from field names is not decided in a record. The Docs pages state the lead's ruling: a column is named exactly like its field, with no transform. | open |
| 14 | Grouping several action calls in one transaction is not designed. The Docs pages say each call is its own transaction. | open |
| 15 | The repository instructions said v1 was M0–M8 plus M10 while the roadmap renumbered it to M0–M9. The Docs pages carry no milestone numbers, so nothing user-facing depends on it. | settled |
| 16 | No `require-atomic=false` example survives in the Docs, because the attribute belongs to a milestone the pages may not name. The reference page states the rule in prose instead. | open |
| 17 | `sort` on a read has no settled form: Mesh keeps a `sort` child tag, Ash has no such entity and sorts through `prepare build(sort: …)`. The Docs pages use the `sort` tag on both sides and say the strings are the same. Mapping rows D17 and G1. | open |
| 18 | `load` has three jobs and one spelling: a calculation, a relationship and an aggregate. The Docs pages state which of the three runs in SQL. | open |
| 19 | The density of "not decided yet" callouts in the old example page was itself a finding: eight in one page is the cost of writing the smallest complete example from the current design. | settled by the rewrite |
| 20 | `bun create mesh todo-app` assumes a package whose name and availability nobody has checked, beside the `@mesh` scope [ADR-0040](decisions/0040-package-and-command-names.md) already records as unchecked. | open |
| 21 | The generated `index.ts` needs a rule for colliding export identifiers after action and entity names are composed. The Docs pages say a collision fails the build, naming both. | open |
| 22 | `public` is declared and recorded but never read, because v1 has no transport that leaves the process. The Docs pages say nothing about it. [ADR-0035](decisions/0035-meaning-of-public.md). | open |
| 23 | Sharing one policy across action types required duplication: Ash's `action_type(["read", "destroy"])` is an array inside the call, and Mesh's contract rejects an array there while accepting an outer list of checks, which means *and*. The Docs pages use `action_type(["read", "destroy"])` for *or* and state the difference between the two lists. The compiler must accept the array argument as Ash does. [ADR-0034](decisions/0034-vocabulary-copies-ash-dsl.md), mapping rows 90–91. | settled in the docs; open in the contract |

## New open points

- **Importing hand-written code from an `.mx` file.** The Entities page states one design: an entity file opens with ordinary `import` lines, and only relative, named imports of files inside `src/domain/` are allowed. Today's contracts parse with `structural: "reject"`, which rejects an import line outright, so this needs a change in how Mesh calls MX and the MX lead's agreement. The sample check parses the example with the root tag rewritten and defers it under a named reason until that lands.
- **No page on writing an extension.** Three pages describe what an extension may contribute and none shows how to write one. It is its own piece of work.

- **The action context's type.** The operator ruled on 2026-10-04 that the second argument is one flat `ActionContext` the user declares by declaration merging. Two records still describe the older shape and have to be amended in the rename task: [ADR-0007](decisions/0007-scope-is-a-plain-argument.md) and [ADR-0047](decisions/0047-actions-are-bound-to-a-data-layer.md) both say "scope" and describe `{ actor, context }`.
- **Generator templates as an escape hatch.** `mesh export generators` would copy the templates into the project so an advanced user could edit them, and the templates would be written in [Jig](https://jig.saulo.engineer/docs/introduction). It is undecided. The user page [Customising generated code](../docs/customising-generated-code.md) is written as a proposal so the operator can judge the developer experience, and it recommends a named mixin hook in each template instead of a copy of the whole template. A copy means the project owns the generated output and upgrades stop applying; a hook keeps the escape hatch small.
- **What "what exists today" covers.** The contributor page holds it, but nothing states when it is rewritten as each milestone lands.

## What the Docs pages invented

Nothing on this list is decided. Each entry is a design made while writing, because a page could not be written without it. The alternative is the one that was rejected.

- **`connect()` takes no arguments** and reads `mesh.config.ts`. Rejected: `connect({ file })`, which writes the same connection details twice (finding 11).
- **`pushSQLiteSchema(dataLayer)`** as the adapter's own name for ADR-0048's "create schema on this connection" function. Rejected: keeping the drizzle-kit spelling, which exposes the underlying tool.
- **The annotated figure on the Introduction** splits one `todo.mx` into nine code blocks so each block lines up with one callout beside it, and the same file is shown whole underneath. Rejected: an SVG diagram, which does not reflow at phone width, and a table of blocks with a column of comments, which reads as a table and not as a file.
- **"Excerpt" fences.** A TypeScript block on a Docs page is a complete file and is type-checked; two signature one-liners are fenced as excerpts and are not. Rejected: leaving the fragments unchecked, which is where a stale signature would hide.
- **`mesh inspect` and `mesh explain` are the agent's tools**, and `.mesh/rules.md` is the generated rules file. Rejected: an MCP server ([ADR-0027](decisions/0027-no-mcp-agent-surface.md)).
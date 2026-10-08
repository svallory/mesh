---
title: "Open questions and findings"
description: "Everything the user docs deliberately do not say: unsettled decisions, DX findings, and what the docs had to invent."
---

# Open questions and findings

::: callout info "Vocabulary note"
The pages under [Docs](../docs/index.md) are written in the terms the operator ruled on 2026-10-04 and 2026-10-05: an **entity** (not a resource), each folder inside `src/domain/` is a **module**, generated code lives in **`.mesh/`** (not `generated/`), an action's second argument is the **action context** (not a scope), and entity files are written in [entity file syntax v4](#syntax-v4), following the additional rulings of 2026-10-08.

The rest of this section was brought to the same vocabulary in [PR #24](https://github.com/svallory/mesh/pull/24), and the packages are `@meshfw/*` (the operator ruled the npm scope to be **`meshfw`**: `@meshfw/cli`, `@meshfw/runtime`, `@meshfw/data-sqlite`, `@meshfw/data-postgres`, scaffolded with `bun create meshfw <dir>`; authorization is core, so there is no policies package). The product is Mesh, the command is `mesh`, the import specifier is `#mesh` and the configuration file is `mesh.config.ts`.

**Only the code still says the old words.** `packages/`, `examples/blog` and the compiler's fixtures still use `resource`, `domain=`, *`generated/`* and *scope*, and the contracts still describe the pre-v2 vocabulary. That is not drift to fix page by page: the realignment task sweeps the code and the contracts together. Until it runs, a reader who opens a Docs page and a source file will see two vocabularies, and the Docs page is the one that states the target.
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
| 17 | `sort` on a read has no settled form: Mesh keeps a `sort` child tag, Ash has no such entity and sorts through `prepare build(sort: …)`. The Docs pages now use a `sort` section with `asc &field` / `desc &field` lines ([ADR-0066](./decisions/0066-names-and-references-are-atoms.md), the lead's fourth choice); how it maps to Ash's `prepare build(sort: …)` is still open. Mapping rows D17 and G1. | open |
| 18 | `load` has three jobs and one spelling: a calculation, a relationship and an aggregate. The Docs pages state which of the three runs in SQL. | open |
| 19 | The density of "not decided yet" callouts in the old example page was itself a finding: eight in one page is the cost of writing the smallest complete example from the current design. | settled by the rewrite |
| 20 | `bun create mesh todo-app` assumes a package whose name and availability nobody has checked, beside the `@mesh` scope [ADR-0040](decisions/0040-package-and-command-names.md) already records as unchecked. | open |
| 21 | The generated `index.ts` needs a rule for colliding export identifiers after action and entity names are composed. ADR-0067 allows same-named entities in different folders through imports. How the aggregate entry point exposes their action exports remains open; the docs no longer forbid the entities themselves. | open |
| 22 | `public` is declared and recorded but never read, because v1 has no transport that leaves the process. The Docs pages say nothing about it. [ADR-0035](decisions/0035-meaning-of-public.md). | open |
| 23 | Sharing one policy across action types required duplication: Ash's `action_type(["read", "destroy"])` is an array inside the call, and Mesh's contract rejects an array there while accepting an outer list of checks, which means *and*. The Docs pages use `action_type(["read", "destroy"])` for *or* and state the difference between the two lists. The compiler must accept the array argument as Ash does. [ADR-0034](decisions/0034-vocabulary-copies-ash-dsl.md), mapping rows 90–91. | settled in the docs; open in the contract |

## New open points

- **Imports and the pinned parser.** Entity and helper imports are part of v4. The pinned alpha.5 rejects imports under `structural: "reject"` unless `imports: "pass"` is set; that option was verified on the pin itself. The realignment updates the call. The docs' temporary spelling bridge and its removal condition are below.
- **No page on writing an extension.** Three pages describe what an extension may contribute and none shows how to write one. It is its own piece of work.

- **The action context's type.** The operator ruled on 2026-10-04 that the second argument is one flat `ActionContext` the user declares by declaration merging. Two records still describe the older shape and have to be amended in the rename task: [ADR-0007](decisions/0007-scope-is-a-plain-argument.md) and [ADR-0047](decisions/0047-actions-are-bound-to-a-data-layer.md) both say "scope" and describe `{ actor, context }`.
- **Generator templates as an escape hatch.** `mesh export generators` would copy the templates into the project so an advanced user could edit them, and the templates would be written in [Jig](https://jig.saulo.engineer/docs/introduction). It is undecided. The user page [Customising generated code](../docs/customising-generated-code.md) is written as a proposal so the operator can judge the developer experience, and it recommends a named mixin hook in each template instead of a copy of the whole template. A copy means the project owns the generated output and upgrades stop applying; a hook keeps the escape hatch small.
- **What "what exists today" covers.** The contributor page holds it, but nothing states when it is rewritten as each milestone lands.

## Syntax v4

The operator's 2026-10-08 rulings distinguish declarations (`:name`), members (`&name`) and imported entities (`Name`), put all action input in one `input` section, and keep entity files static. [ADR-0067](./decisions/0067-members-imports-input-static-files.md) records the rules, the lead's choices and MX decisions 182 addendum 1 and 187 addendum 2. **The Docs pages are the target; the compiler and example still await realignment.**

The pinned `@mxlang/data` alpha.5, with `structural: "reject"`, and `@mxlang/tree-sitter-mx` alpha.2 have these measured gaps:

| Spelling | Parser | Highlighter |
|:--|:--|:--|
| `import { Customer } from "./customer.mesh.mx"` | Accepted with `imports: "pass"`, verified on alpha.5; rejected without it under structural rejection | Already accepted |
| `asc &dueOn` | Invalid attribute name | Accepted by the grammar, not a semantic member token |
| `() => &status === :sent`, `load=[&customer]` | Unexpected token at the operand | No MX ERROR, but layer-2 member highlighting is still owed |
| `&title` in `input` | Accepted syntactically, without Mesh semantics | Rejected: `input` is treated as an HTML void tag, even with an ordinary `string :x` child |
| `&status=:sent` under `set` | Accepted syntactically | Accepted |
| `belongs-to :customer entity=Customer` | Accepted | Accepted |

**One temporary parser bridge.** `normaliseV4` in `packages/compiler/test/repository-checks.ts` rewrites a member after a kind and a tagless member line to the atom spelling the pin understands, and rewrites an expression's operand member to a record read. Imports pass unchanged through alpha.5's verified `imports: "pass"` option. Strings, expression comments and infix `&`/`&&` stay untouched. The parser still uses `structural: "reject"`. That option also rejects comments on the pin, so only leading file comments are blanked, preserving rows; body comments remain untouched and rejected until MX fixes that gap. Remove it when Mesh pins MX's syntax table, including `lineTriggers` (decision 182 addendum 1). This is test-only compatibility, not a second parser in Mesh's compiler.

**One temporary highlighter allowance.** `MX_V4_INPUT_PENDING_SYNTAX_TABLE` uses same-width stand-ins for standalone nested `input` sections and their bare member lines. It renders the original text, leaves those member names uncoloured, counts and prints the bridged lines, and still fails all other grammar errors. Tests pin both halves. MX item `mesh-syntax-highlighting-route` owns the permanent route, through semantic tokens or a Mesh grammar; no grammar is patched here.

A declaration name and atom value still have separate colours (`ts-name`, `ts-atom`). A check label and declaration name still share a capture. The `mesh` host package remains necessary for `.mesh.mx` tooling, and its target design is `builtOn: "tree"`. The target is static: no conditional declarations, loops, `let`, `const` or `define`.

**Planned, not v1.** Not in the Docs pages, because a reader would plan on them: `lock="version"`, `relate=…` and `after-commit(…) { }` steps; reusable steps defined in MX (`step :slugify`, one file per step under `src/domain/`, used from an entity file as `slugify from="title" to="slug"`); a raw-SQL escape hatch like Ash's `fragment`; and `bypass` on a policy, which the operator removed because it fails open and is order-dependent (write `isStaff(actor) || …` with a helper instead). Two more items the syntax reference does not settle and the docs therefore do not show: an `increment` step (`set` with an expression covers it), and a cap declared on the entity (a read declares `filter` and `sort`; `limit` and `offset` arrive in the caller's input).

**Static by ruling, not just by parser limitation.** Declaration and member names are written out; entities use explicit imports. A condition is `when=` on its policy or check, or part of the expression. The future evaluated `data` target is not Mesh's target (MX decision 187 addendum 2).

**The checks keep their teeth.** Only the contracts parse is deferred, under `syntax v4, pending the MX syntax table`; every fence still passes a real normalised parse. `checkDocsSyntaxV4` requires `entity :Name`, and `oldSpellingInV4` rejects old input options, the old relationship shape, atoms in reference positions, quoted names and `sort=`. Planted fence tests prove these failures in both the compiler's sample check and the Docs check. Contract semantics and reference resolution become real checks in the realignment task.

Two consequences for records that predate v2: [ADR-0034](./decisions/0034-vocabulary-copies-ash-dsl.md) ("copy Ash's DSL") is superseded for entity files, and [ADR-0022](./decisions/0022-policies-simple-tier-as-extension.md) is superseded on packaging, since `policies` is now a section of the entity file rather than an extension. [ADR-0017](./decisions/0017-atomic-by-default-and-classification.md) is amended again: `validate` sees the record with the accepted input applied, not the record after the changes, and `require-atomic` does not appear in v2 — a `run(…) { }` step, or any expression Mesh cannot translate to SQL, is what makes an action read-then-write.

## What the Docs pages invented

Nothing on this list is decided. Each entry is a design made while writing, because a page could not be written without it. The alternative is the one that was rejected.

- **`connect()` takes no arguments** and reads `mesh.config.ts`. Rejected: `connect({ file })`, which writes the same connection details twice (finding 11).
- **`pushSQLiteSchema(dataLayer)`** as the adapter's own name for ADR-0048's "create schema on this connection" function. Rejected: keeping the drizzle-kit spelling, which exposes the underlying tool.
- **The annotated figure on the Introduction** splits one `todo.mx` into nine code blocks so each block lines up with one callout beside it, and the same file is shown whole underneath. Rejected: an SVG diagram, which does not reflow at phone width, and a table of blocks with a column of comments, which reads as a table and not as a file.
- **"Excerpt" fences.** A TypeScript block on a Docs page is a complete file and is type-checked; two signature one-liners are fenced as excerpts and are not. Rejected: leaving the fragments unchecked, which is where a stale signature would hide.
- **`mesh inspect` and `mesh explain` are the agent's tools**, and `.mesh/rules.md` is the generated rules file. Rejected: an MCP server ([ADR-0027](decisions/0027-no-mcp-agent-surface.md)).
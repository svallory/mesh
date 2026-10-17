---
title: "Open questions and findings"
description: "Everything the user docs deliberately do not say: the three questions still open, the DX findings, and what the docs had to invent."
---

# Open questions and findings

::: callout info "Vocabulary note"
The pages under [Docs](../docs/index.md) are written in the terms the operator ruled on 2026-10-04 and 2026-10-05: an **entity** (not a resource), each folder inside `src/domain/` is a **module**, generated code lives in **`.mesh/`** (not `generated/`), an action's second argument is the **action context** (not a scope), and entity files are written in [entity file syntax v4](#syntax-v4), following the additional rulings of 2026-10-08.

The rest of this section was brought to the same vocabulary in [PR #24](https://github.com/svallory/mesh/pull/24), and the framework packages are `@meshfw/*` (`@meshfw/runtime`, `@meshfw/data-sqlite`, `@meshfw/data-postgres`). The [amendments to ADR-0060](./decisions/0060-meshfw-package-scope.md) name the CLI package `meshfw` and the starter `create-meshfw`, invoked with `bun create meshfw <dir>`; authorization is core, so there is no policies package. The product is Mesh, the command is `mesh`, the import specifiers are `#mesh` and, per module, `#mesh/domain/<module>`, and the configuration file is `mesh.config.ts`.

**The code and the Docs now share one vocabulary.** PR #47 and PR #48 (merged 2026-10-09) moved `packages/`, `examples/blog` and the compiler's fixtures to `entity`, `src/domain`, `.mesh/` and the action context. What differs from the Docs is what is not built yet; the [roadmap](./roadmap/roadmap.md) says which milestones are done. Where a Docs page and a source file disagree, the Docs page states the target.
:::

The pages under Docs describe what Mesh will be: no open questions, no milestones, no hedges. Everything below is what those pages had to leave out. Three questions are still open, listed first; the rest of the page is the record of what writing the Docs found and settled. A page under Docs that has to say "this is not decided" has found a gap, which is the point of writing it first.

## Open questions

- **Whether a project's concept may shadow a concept Mesh ships.** When a project declares `concepts/Email.mesh.mx` and Mesh ships a concept named `Email`, which one `Email :email` means is not decided. Mesh reserves its whole vocabulary, which points to a build error, as for any reserved Mesh tag, but the other answers (the project's concept wins, with or without a warning) are not ruled out.
- **Whether a nearer `concepts/` folder may shadow a project-wide concept.** Nothing is global in an entity file: a file sees only its own declarations and what it imports, and concepts are the one exception, shared across the project. Not decided: whether a `concepts/` folder nearer to a file may shadow a shared concept of the same name, as the nearest-wins walk of tag discovery ([ADR-0085](decisions/0085-tag-discovery-for-dialect-tags.md)) would allow, or whether a concept's name is unique across the project.
- **What a denied write reports when the action runs as one statement.** When a write action runs as one SQL statement, whether a caller denied by a policy receives not found or forbidden, and whether a re-read tells the two apart, is the choice between the options of [ADR-0046](decisions/0046-denied-atomic-write-outcome.md). The build follows option A today: no extra read, and a denied caller learns nothing about the row.

## Open tooling findings

These are tooling work, not language questions. They keep the numbers they had among the findings below.

| # | Finding |
|:--|:--|
| 7 | Adapter commands wrap drizzle-kit, which is a development dependency, so a user who skips it meets a confusing failure at `mesh db push`. |
| 10 | No `mesh` watch mode, so every edit needs a manual `mesh build`. MX's own tools do check `.mesh.mx` files as you type (the language server and the TypeScript plugin; `mx-tsc` is not released) and report Mesh's `MESH_*` codes, as [the MX contract](in-depth/mx-integration.md#37-mxs-tools-for-meshmx-files) says; only the build step is manual. |
| 12 | Whether committed migrations are covered by `mesh build --check` is not stated, so a hand-edited migration and a stale `.mesh/schema.ts` can drift. The Docs pages do not claim the guard covers `migrations/`. See [generated code and the guard](in-depth/generated-code-and-guard.md). |

## DX findings

The findings below came from writing the Docs pages against the design. Each names what a user would have had to work out alone, and the record it touches. Only the settled findings are kept here; the numbers are stable, and the missing numbers were settled or made obsolete by later rulings.

| # | Finding | Status |
|:--|:--|:--|
| 1 | How a generated handler gets its database connection. `Todo.create(input, context)` leaves only module state. Settled by `bind(dataLayer)` and `connect()` ([ADR-0047](decisions/0047-actions-are-bound-to-a-data-layer.md)). | settled |
| 2 | Tests on SQLite `:memory:` need the schema inside the test's own process, while the schema tools are commands in another process. Settled by the adapter's own schema function ([ADR-0048](decisions/0048-schema-inside-the-process-for-tests.md)). | settled |
| 5 | Generated code imports `zod`, `drizzle-orm` and `@opentelemetry/api`, so a user's project must depend on them at versions Mesh pins. Settled by [ADR-0062](decisions/0062-direct-dependencies-zod-drizzle-opentelemetry.md): a project depends directly on Zod 4 and `drizzle-orm`, as ordinary dependencies rather than hidden behind `@meshfw/runtime`; `@opentelemetry/api` comes with tracing, after Mesh 1.0. | settled |
| 8 | `<action><Entity>` names read badly: `pendingTodo` for a read named `pending`, and `readTodo` returning an array. Settled by [ADR-0086](decisions/0086-entity-values-privileged-barrels-and-fqns.md): an action is called on its entity value, `Todo.pending(...)`, and no composed name exists. | settled |
| 11 | Connection details were written twice: in `mesh.config.ts` for the build and the commands, and again at run time. Settled: `connect()` takes no arguments and reads `mesh.config.ts` at run time; `defineConfig` and `MeshConfig` come from `@meshfw/runtime`, and the config key for entity files is `domain: "src/domain"`. | settled |
| 13 | Column naming from field names. Settled: a column is named exactly like its attribute, with no transform ([data layer](in-depth/data-layer.md#the-build-half-a-generator-and-a-command)). | settled |
| 14 | Grouping several action calls in one transaction. Settled by [ADR-0068](decisions/0068-actions-compose-through-actions-and-tx.md): entity calls and `Mesh.privileged` in a step, and `transaction` from `#mesh` for the application, as [ADR-0086](decisions/0086-entity-values-privileged-barrels-and-fqns.md) amends it. | settled |
| 15 | The repository instructions said v1 was M0–M8 plus M10 while the roadmap renumbered it to M0–M9. The Docs pages carry no milestone numbers, so nothing user-facing depends on it. | settled |
| 19 | The density of "not decided yet" callouts in the old example page was itself a finding: eight in one page is the cost of writing the smallest complete example from the current design. | settled by the rewrite |
| 20 | `bun create meshfw todo-app` assumes the package `create-meshfw`. The CLI is the unscoped package `meshfw` with the binary `mesh`, and the starter is `create-meshfw`, falling back to `@meshfw/create-app`. Neither is on npm yet, by the operator's choice. MX publishes nothing to npm until its next major version and its framework targets exist, so a Mesh published on npm would need its users to add the `@mxlang` scope to their own `bunfig.toml`; the operator hears this before any npm publish of Mesh ([ADR-0060](decisions/0060-meshfw-package-scope.md)). | settled; publishing waits |
| 21 | Generated code needs a rule for colliding identifiers. Settled by [ADR-0086](decisions/0086-entity-values-privileged-barrels-and-fqns.md): an action is called on its entity value (`Todo.complete(...)`), no generated name is unique across the project, each folder has a barrel, and Mesh imposes no rule on names beyond `__proto__` as a member name. Two exports of one barrel with the same name (an entity and a subfolder namespace, two sibling folders that normalise alike, a duplicate generated type) are `MESH_EMIT_NAME`, naming both: an entity by its FQN, a folder by its path. No name is reserved, because `#mesh` and the domain barrels are separate modules, and generated locals never use a bare entity name ([generated code and the guard](in-depth/generated-code-and-guard.md#binding-and-barrels)). | settled |

## Syntax v4

The operator's 2026-10-08 rulings distinguish declarations (`:name`), members (`&name`) and imported entities (`Name`), put all action input in one `input` section, and keep entity files static. [ADR-0067](./decisions/0067-members-imports-input-static-files.md) records the rules, the lead's choices and MX decisions 182 addendum 1 and 187 addendum 2. **The Docs pages are the target; the compiler and example follow the entity syntax (PR #47, PR #48), `&` positions included since the MX alpha.13 pin.**

Measured on `@mxlang/data` alpha.5 with `structural: "reject"`, before the pin moved to alpha.11, and not re-measured since; the highlighter column is `@mxlang/tree-sitter-mx` alpha.2:

| Spelling | Parser | Highlighter |
|:--|:--|:--|
| `import { Customer } from "./customer.mesh.mx"` | Accepted with `imports: "pass"`, as measured; rejected without it under structural rejection | Already accepted |
| `asc &dueOn` | Invalid attribute name | Accepted by the grammar, not a semantic member token |
| `() => &status === :sent`, `load=[&customer]` | Unexpected token at the operand | No MX ERROR, but layer-2 member highlighting is still owed |
| `&title` in `input` | Accepted syntactically, without Mesh semantics | Rejected: `input` is treated as an HTML void tag, even with an ordinary `string :x` child |
| `&status=:sent` under `set` | Accepted syntactically | Accepted |
| `belongs-to :customer entity=Customer` | Accepted | Accepted |

**No parser bridge.** Mesh's syntax module (`packages/compiler/src/syntax.ts`) gives MX the `&` trigger, and MX lowers every member position before the compiler or the docs checks read the tree, so fences parse as authored, comments and imports included. Production and tests never rewrite source.

**One temporary highlighter allowance.** `MX_V4_INPUT_PENDING_SYNTAX_TABLE` uses same-width stand-ins for standalone nested `input` sections and their bare member lines. It renders the original text, leaves those member names uncoloured, counts and prints the bridged lines, and still fails all other grammar errors. Tests pin both halves. MX item `mesh-syntax-highlighting-route` owns the permanent route, through semantic tokens or a Mesh grammar; no grammar is patched here.

A declaration name and atom value still have separate colours (`ts-name`, `ts-atom`). A check label and declaration name still share a capture. The `mesh` host package remains necessary for `.mesh.mx` tooling, and its target design is `builtOn: "tree"`. The target is static: no conditional declarations, loops, `let`, `const` or `define`.

**Planned, not v1.** (Reusable step files and the `after-commit` step are no longer planned: [ADR-0082](./decisions/0082-named-checks-and-mixins.md), [ADR-0079](./decisions/0079-commands-events-and-the-outbox.md).) Not in the Docs pages, because a reader would plan on them: `lock="version"` and `relate=…` steps; a raw-SQL escape hatch like Ash's `fragment`; and `bypass` on a policy, which the operator removed because it fails open and is order-dependent (write `isStaff(actor) || …` with a helper instead). Two more items the docs do not show: a cap declared on the entity is planned (a read declares `filter` and `sort`; `limit` and `offset` arrive in the caller's input); an `increment` step is not planned: `set` with an expression covers it.

**Static by ruling, not just by parser limitation.** Declaration and member names are written out; entities use explicit imports. A condition is `when=` on its policy or check, or part of the expression. The future evaluated `data` target is not Mesh's target (MX decision 187 addendum 2).

**The checks keep their teeth.** Every fence passes the compiler's own parse with the production contracts. `checkDocsSyntaxV4` requires `entity :Name`, and `oldSpellingInV4` rejects old input options, the old relationship shape, atoms in reference positions, quoted names and `sort=`. Planted fence tests prove these failures in both the compiler's sample check and the Docs check. Contract semantics and reference resolution are checked by the production contracts and builder.

Two consequences for records that predate v2: [ADR-0034](./decisions/0034-vocabulary-copies-ash-dsl.md) ("copy Ash's DSL") is superseded for entity files, and [ADR-0022](./decisions/0022-policies-simple-tier-as-extension.md) is superseded on packaging, since `policies` is now a section of the entity file rather than an extension. [ADR-0017](./decisions/0017-atomic-by-default-and-classification.md) is amended again: `validate` sees the record with the accepted input applied, not the record after the changes, and `require-atomic` does not appear in v2 — a `run(…) { }` step, or any expression Mesh cannot translate to SQL, is what makes an action read-then-write.

**Changed 2026-10-11 (operator).** `validate` no longer sees the record with the accepted input applied: a check and a policy see `self` before the input is applied (the stored record on an update or destroy, a create's new instance with its defaults), and the caller's values are in `input`. See the amendment of [ADR-0053](./decisions/0053-validate-then-do.md). The paragraph above is kept as history.

## What the Docs pages invented

Each entry is a design made while writing, because a page could not be written without it. The alternative is the one that was rejected.

- **`connect()` takes no arguments** and reads `mesh.config.ts`. Since settled (finding 11).
- **The adapter's own schema function**, for ADR-0048's "create schema on this connection". Since settled as `createSchema(db, tables)`, which takes the connection and the generated tables. Rejected: keeping the drizzle-kit spelling, which exposes the underlying tool.
- **The annotated figure on the Introduction** splits one `todo.mx` into nine code blocks so each block lines up with one callout beside it, and the same file is shown whole underneath. Rejected: an SVG diagram, which does not reflow at phone width, and a table of blocks with a column of comments, which reads as a table and not as a file.
- **"Excerpt" fences.** A TypeScript block on a Docs page is a complete file and is type-checked; two signature one-liners are fenced as excerpts and are not. Rejected: leaving the fragments unchecked, which is where a stale signature would hide.
- **`mesh inspect` and `mesh explain` are the agent's tools**, and `.mesh/rules.md` is the generated rules file. Rejected: an MCP server ([ADR-0027](decisions/0027-no-mcp-agent-surface.md)).
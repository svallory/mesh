---
title: "Ash to Mesh: where each Ash concept went"
description: "For an Ash user: how each part of Ash's resource DSL is written in a Mesh entity file, which Ash concepts have no equivalent yet, and the M1 alignment kept as history."
---

# Ash to Mesh: where each Ash concept went

Updated: 2026-10-08. Mesh is modelled on Ash, the declarative framework for Elixir. Until 2026-10-05 Mesh's vocabulary copied Ash's DSL ([ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md), superseded). It is now Mesh's own, informed by Ash ([ADR-0049](../decisions/0049-vocabulary-is-meshs-own.md)): what Ash calls a *resource* is an *entity*, and every declaration in an entity file is `kind :name options` ([ADR-0050](../decisions/0050-entity-file-syntax.md)). This page tells an Ash user where each Ash concept went, and which have no equivalent yet.

::: callout info "Two spellings on this page"
The code on `main` reads entity file syntax v4 since PR #47 and PR #48 (2026-10-09). Section 3 is in that spelling, and a test in `packages/compiler/test` reads it to check the contracts on `main` (roadmap M1, acceptance test 7). Sections 4.0.1 and 5 to 7 and the appendices record the M1 alignment, which copied Ash (`resource`, `attribute="title" type="string"`, `defaults`, `change`, `calculations`, `aggregates`, `policy=action_type("read")`), and are history. For current spelling, use [Entities](../../docs/entities.md) and [ADR-0067](../decisions/0067-members-imports-input-static-files.md).
:::

## 0. How to read this page

- **Section 1** is the short version: the Ash constructs a typical resource uses, and the Mesh line for each.
- **Section 2** lists the Ash concepts Mesh has no equivalent for yet, and why.
- **Section 3** is the full mapping, 110 rows, one per Ash section, entity or option that Mesh v1 touches, with the source in the research for each Ash fact.
- **Section 4** lists where Mesh's design deliberately differs from Ash, then keeps the record of the M1 alignment as history.
- **Sections 5 to 7 and the appendices** are the M1 alignment's exceptions, Ash lookups and fixture, kept because they record checked facts about Ash. The contracts they describe are the M1 contracts, replaced in PR #47.

In current files, `:title` declares a name, `&title` refers to a member and an imported identifier names another entity. Expressions use TypeScript plus Mesh's member and atom spellings.

## 1. At a glance

Ash examples follow [Ash features](../research/ash-features.md), section 12; the Mesh lines follow the reference file in [ADR-0050](../decisions/0050-entity-file-syntax.md).

| Ash | Mesh | Record |
|---|---|---|
| `defmodule MyApp.Blog.Post do use Ash.Resource, domain: MyApp.Blog` | `entity :Post table="posts"` in `src/domain/blog/post.mesh.mx`; the folder is the module | [ADR-0049](../decisions/0049-vocabulary-is-meshs-own.md), [ADR-0057](../decisions/0057-one-domain-modules-as-folders.md) |
| `postgres do table "posts" end` | `table="posts"` on the entity line | [ADR-0050](../decisions/0050-entity-file-syntax.md) |
| `uuid_primary_key :id` | `uuid :id primary-key` | [ADR-0050](../decisions/0050-entity-file-syntax.md) |
| `attribute :title, :string, allow_nil?: false` | `string :title` (required by default) | [ADR-0050](../decisions/0050-entity-file-syntax.md) |
| `attribute :notes, :string` (nullable by default) | `string :notes nullable` | [ADR-0050](../decisions/0050-entity-file-syntax.md) |
| `attribute :state, :atom, constraints: [one_of: [:draft, :published]]` | `enum :state values=[:draft, :published]` | [ADR-0050](../decisions/0050-entity-file-syntax.md) |
| `constraints: [max_length: 2000]`, `constraints: [min: 0]` | `max=2000`, `min=0` on the line (never a `check`) | [ADR-0053](../decisions/0053-validate-then-do.md) |
| `create_timestamp :inserted_at` | `timestamp :insertedAt on=:create` | [ADR-0050](../decisions/0050-entity-file-syntax.md) |
| `belongs_to :author, MyApp.Accounts.User` | Import `User` by relative path, then `belongs-to :author entity=User` (`nullable` makes it optional) | [ADR-0050](../decisions/0050-entity-file-syntax.md) |
| `has_many :comments, Comment` | Import `Comment`, then `has-many :comments entity=Comment` | [ADR-0050](../decisions/0050-entity-file-syntax.md) |
| `calculate :excerpt, :string, expr(...)` | `string :excerpt() { ... }` in `computed` | [ADR-0050](../decisions/0050-entity-file-syntax.md) |
| `count :comment_count, :comments` | `count :commentCount of="comments"` in `computed` | [ADR-0050](../decisions/0050-entity-file-syntax.md) |
| `defaults [:read, :destroy]` | `actions auto=[:read, :destroy]` | [ADR-0052](../decisions/0052-actions-auto-and-on-load.md) |
| `update :publish do ... end` | `update :publish` | [ADR-0052](../decisions/0052-actions-auto-and-on-load.md) |
| `argument :paid_at, :utc_datetime` | `input` section: `datetime :paidAt` | [ADR-0067](../decisions/0067-members-imports-input-static-files.md) |
| `change set_attribute(:state, :published)` | `do` then `set` then `&state=:published` | [ADR-0053](../decisions/0053-validate-then-do.md) |
| `validate present(:title)` | `string :title` is required by default; `input` takes `&title` | [ADR-0067](../decisions/0067-members-imports-input-static-files.md) |
| a custom validation module with a message | `check :label [ that=fn code=... message=... ]` | [ADR-0053](../decisions/0053-validate-then-do.md) |
| resource-level `changes` and `validations` | `always types=[...]` under `actions` | [ADR-0053](../decisions/0053-validate-then-do.md) |
| `require_atomic? false` | nothing: the build infers the write strategy | [ADR-0054](../decisions/0054-write-strategy-is-inferred.md) |
| `filter expr(state == :published)` | `filter=() => &state === :published` | [ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md) |
| `^actor(:id)`, `^arg(:name)`, `^context(:key)` | `actor.id`, `input.name`, `context.key` | [ADR-0059](../decisions/0059-action-context.md) |
| `authorizers: [Ash.Policy.Authorizer]` | nothing: policies are core, and an entity without them forbids every action | [ADR-0055](../decisions/0055-policies-are-core.md) |
| `policy action_type(:read) do authorize_if ... end` | `policy :reads types=[:read]` then `authorize-if=...` | [ADR-0055](../decisions/0055-policies-are-core.md) |
| `bypass actor_attribute_equals(:admin, true)` | none: write `isAdmin(actor) \|\| ...` in each policy | [ADR-0055](../decisions/0055-policies-are-core.md) |
| `Ash.can?` | a generated `can` function per action | [ADR-0022](../decisions/0022-policies-simple-tier-as-extension.md) |
| `actor:`, `tenant:`, `context:` options on a call | one `ActionContext` argument: `payInvoice(input, { actor, tenantId })` | [ADR-0059](../decisions/0059-action-context.md) |

## 2. Ash concepts with no Mesh equivalent yet

Grouped by why. Row numbers refer to section 3.

- **Not planned**: generic actions (55), manual actions (61), many-to-many and join resources (40), `NewType` and embedded resources (35), `bypass` and policy groups (97, rejected because a passing bypass fails open and depends on order), a policy solver.
- **After v1**: identities beyond `unique` on one attribute (78, 79), upserts (62), bulk actions (63), multitenancy as an extension (12, 109), `relate` for managing related records (47), `after-commit` and other hooks (71), a raw-SQL `fragment` (103, 104).
- **Not scheduled**: the resource options of row 6, preparations (9, 70, 72), pipelines (11, 76), temporal resources (13), `uuid_v7` and integer keys (16, 17), `update_default` (24), `description`, `sensitive`, `source` (26), selection and filterability options (28, 29), arrays (34), relationship options (42 to 46), action options (50, 58, 64, 65, 77), field policies (98), access types (99), `authorize_unless` and `forbid_unless` (94), calculation options and arguments (83, 84), aggregate options (88), `^ref` (108).
- **Replaced by something different**: `public?` (22, open in [ADR-0035](../decisions/0035-meaning-of-public.md)), `require_atomic?` (59, inferred), `code_interface` (7, generated functions), `data_layer` and `authorizers` (3, 5, configuration or core).

## 3. Contract coverage

Each example is a complete tag or tagless member line, tested in a minimal entity with its declared ancestors, stored fields, and an imported Line entity. The test parses **and builds** every cell. The rows equal the production contracts: options unavailable for a particular type have no row. MX lowers a tagless `&title` line to a `member` child tag, which an inline wildcard contract under `input` and `set` accepts: `input.member` takes no value, while `set.member.value` holds the assigned value (the compiler requires it). The coverage test enumerates these wildcard options as well as the named contracts; `member` is not an authored tag. Slots that hold one member only (`asc`/`desc` and `on:load`) have MX's contract type `member`; lists of members (`load`, `actions`) are arrays whose elements Mesh checks.

“On main” records the delivered compiler/model coverage, not runtime execution. MX lowers authored `&` in every position through Mesh's syntax module; the production compiler never rewrites source.

| Construct | Example | Contract | Status |
|---|---|---|---|
| `actions` | `actions auto=[:read]` | `actions` | on main |
| `actions.auto` | `actions auto=[:read]` | `actions.auto` | on main |
| `actions.on:load` | `actions on:load=&custom` | `actions.on:load` | on main |
| `always` | `always types=[:update]` | `always` | on main |
| `always.types` | `always types=[:update]` | `always.types` | on main |
| `always.actions` | `always actions=[&custom]` | `always.actions` | on main |
| `asc` | `asc &title` | `asc` | on main |
| `asc.member` | `asc &title` | `asc.member` | on main |
| `attributes` | `attributes` | `attributes` | on main |
| `authorize-if` | `authorize-if=() => true` | `authorize-if` | on main |
| `authorize-if.value` | `authorize-if=() => true` | `authorize-if.value` | on main |
| `avg` | `avg :total of="lines.amount"` | `avg` | on main |
| `avg.name` | `avg :total of="lines.amount"` | `avg.name` | on main |
| `avg.of` | `avg :total of="lines.amount"` | `avg.of` | on main |
| `belongs-to` | `belongs-to :related entity=Line` | `belongs-to` | on main |
| `belongs-to.name` | `belongs-to :related entity=Line` | `belongs-to.name` | on main |
| `belongs-to.entity` | `belongs-to :related entity=Line` | `belongs-to.entity` | on main |
| `belongs-to.nullable` | `belongs-to :related entity=Line nullable` | `belongs-to.nullable` | on main |
| `boolean` | `boolean :field` | `boolean` | on main |
| `boolean.name` | `boolean :field` | `boolean.name` | on main |
| `boolean.nullable` | `boolean :field nullable` | `boolean.nullable` | on main |
| `boolean.default` | `boolean :field default=false` | `boolean.default` | on main |
| `boolean.unique` | `boolean :field unique` | `boolean.unique` | on main |
| `boolean.value` | `boolean :field() { return false }` | `boolean.value` | on main |
| `check` | `check :valid that=() => true code="invalid" message="Invalid input"` | `check` | on main |
| `check.name` | `check :valid that=() => true code="invalid" message="Invalid input"` | `check.name` | on main |
| `check.that` | `check :valid that=() => true code="invalid" message="Invalid input"` | `check.that` | on main |
| `check.code` | `check :valid that=() => true code="invalid" message="Invalid input"` | `check.code` | on main |
| `check.message` | `check :valid that=() => true code="invalid" message="Invalid input"` | `check.message` | on main |
| `check.when` | `check :valid that=() => true code="invalid" message="Invalid input" when=() => true` | `check.when` | on main |
| `computed` | `computed` | `computed` | on main |
| `count` | `count :total of="lines"` | `count` | on main |
| `count.name` | `count :total of="lines"` | `count.name` | on main |
| `count.of` | `count :total of="lines"` | `count.of` | on main |
| `create` | `create :work` | `create` | on main |
| `create.name` | `create :work` | `create.name` | on main |
| `date` | `date :field` | `date` | on main |
| `date.name` | `date :field` | `date.name` | on main |
| `date.nullable` | `date :field nullable` | `date.nullable` | on main |
| `date.default` | `date :field default="2026-10-09"` | `date.default` | on main |
| `date.unique` | `date :field unique` | `date.unique` | on main |
| `date.value` | `date :field() { return new Date() }` | `date.value` | on main |
| `datetime` | `datetime :field` | `datetime` | on main |
| `datetime.name` | `datetime :field` | `datetime.name` | on main |
| `datetime.nullable` | `datetime :field nullable` | `datetime.nullable` | on main |
| `datetime.default` | `datetime :field default="2026-10-09T12:00:00Z"` | `datetime.default` | on main |
| `datetime.unique` | `datetime :field unique` | `datetime.unique` | on main |
| `datetime.value` | `datetime :field() { return new Date() }` | `datetime.value` | on main |
| `decimal` | `decimal :field` | `decimal` | on main |
| `decimal.name` | `decimal :field` | `decimal.name` | on main |
| `decimal.nullable` | `decimal :field nullable` | `decimal.nullable` | on main |
| `decimal.default` | `decimal :field default=1.5` | `decimal.default` | on main |
| `decimal.min` | `decimal :field min=0` | `decimal.min` | on main |
| `decimal.max` | `decimal :field max=100` | `decimal.max` | on main |
| `decimal.unique` | `decimal :field unique` | `decimal.unique` | on main |
| `decimal.value` | `decimal :field() { return 1.5 }` | `decimal.value` | on main |
| `desc` | `desc &title` | `desc` | on main |
| `desc.member` | `desc &title` | `desc.member` | on main |
| `destroy` | `destroy :work` | `destroy` | on main |
| `destroy.name` | `destroy :work` | `destroy.name` | on main |
| `do` | `do` | `do` | on main |
| `entity` | `entity :Sample table="samples"` | `entity` | on main |
| `entity.name` | `entity :Sample table="samples"` | `entity.name` | on main |
| `entity.table` | `entity :Sample table="samples"` | `entity.table` | on main |
| `enum` | `enum :field values=[:draft, :sent]` | `enum` | on main |
| `enum.name` | `enum :field values=[:draft, :sent]` | `enum.name` | on main |
| `enum.nullable` | `enum :field values=[:draft, :sent] nullable` | `enum.nullable` | on main |
| `enum.default` | `enum :field values=[:draft, :sent] default=:draft` | `enum.default` | on main |
| `enum.values` | `enum :field values=[:draft, :sent]` | `enum.values` | on main |
| `enum.unique` | `enum :field values=[:draft, :sent] unique` | `enum.unique` | on main |
| `enum.value` | `enum :field() { return :draft }` | `enum.value` | on main |
| `filter` | `filter=() => true` | `filter` | on main |
| `filter.value` | `filter=() => true` | `filter.value` | on main |
| `float` | `float :field` | `float` | on main |
| `float.name` | `float :field` | `float.name` | on main |
| `float.nullable` | `float :field nullable` | `float.nullable` | on main |
| `float.default` | `float :field default=0.5` | `float.default` | on main |
| `float.min` | `float :field min=0` | `float.min` | on main |
| `float.max` | `float :field max=100` | `float.max` | on main |
| `float.unique` | `float :field unique` | `float.unique` | on main |
| `float.value` | `float :field() { return 0.5 }` | `float.value` | on main |
| `forbid-if` | `forbid-if=() => false` | `forbid-if` | on main |
| `forbid-if.value` | `forbid-if=() => false` | `forbid-if.value` | on main |
| `has-many` | `has-many :related entity=Line` | `has-many` | on main |
| `has-many.name` | `has-many :related entity=Line` | `has-many.name` | on main |
| `has-many.entity` | `has-many :related entity=Line` | `has-many.entity` | on main |
| `has-many.via` | `has-many :related entity=Line via=:owner` | `has-many.via` | on main |
| `has-one` | `has-one :related entity=Line` | `has-one` | on main |
| `has-one.name` | `has-one :related entity=Line` | `has-one.name` | on main |
| `has-one.entity` | `has-one :related entity=Line` | `has-one.entity` | on main |
| `input` | `input` | `input` | on main |
| `input` member line | `&title` | `input.member` | on main |
| `integer` | `integer :field` | `integer` | on main |
| `integer.name` | `integer :field` | `integer.name` | on main |
| `integer.nullable` | `integer :field nullable` | `integer.nullable` | on main |
| `integer.default` | `integer :field default=0` | `integer.default` | on main |
| `integer.min` | `integer :field min=0` | `integer.min` | on main |
| `integer.max` | `integer :field max=100` | `integer.max` | on main |
| `integer.primary-key` | `integer :field primary-key` | `integer.primary-key` | on main |
| `integer.unique` | `integer :field unique` | `integer.unique` | on main |
| `integer.value` | `integer :field() { return 0 }` | `integer.value` | on main |
| `json` | `json :field` | `json` | on main |
| `json.name` | `json :field` | `json.name` | on main |
| `json.nullable` | `json :field nullable` | `json.nullable` | on main |
| `json.default` | `json :field default={ list: [1, 2] }` | `json.default` | on main |
| `json.value` | `json :field() { return null }` | `json.value` | on main |
| `load` | `load=[&lines]` | `load` | on main |
| `load.value` | `load=[&lines]` | `load.value` | on main |
| `max` | `max :total of="lines.dueOn"` | `max` | on main |
| `max.name` | `max :total of="lines.dueOn"` | `max.name` | on main |
| `max.of` | `max :total of="lines.dueOn"` | `max.of` | on main |
| `min` | `min :total of="lines.amount"` | `min` | on main |
| `min.name` | `min :total of="lines.amount"` | `min.name` | on main |
| `min.of` | `min :total of="lines.amount"` | `min.of` | on main |
| `policies` | `policies` | `policies` | on main |
| `policy` | `policy :rule types=[:read]` | `policy` | on main |
| `policy.name` | `policy :rule types=[:read]` | `policy.name` | on main |
| `policy.types` | `policy :rule types=[:read]` | `policy.types` | on main |
| `policy.actions` | `policy :rule actions=[&custom]` | `policy.actions` | on main |
| `policy.when` | `policy :rule when=() => true` | `policy.when` | on main |
| `policy.authorize-if` | `policy :rule authorize-if=() => true` | `policy.authorize-if` | on main |
| `policy.forbid-if` | `policy :rule forbid-if=() => true` | `policy.forbid-if` | on main |
| `read` | `read :work` | `read` | on main |
| `read.name` | `read :work` | `read.name` | on main |
| `read.filter` | `read :work filter=() => true` | `read.filter` | on main |
| `relationships` | `relationships` | `relationships` | on main |
| `run` | `run({ self }) { audit(self) }` | `run` | on main |
| `run.value` | `run({ self }) { audit(self) }` | `run.value` | on main |
| `set` | `set` | `set` | on main |
| `set` assignment line | `&title="new"` | `set.member.value` | on main |
| `sort` | `sort` | `sort` | on main |
| `string` | `string :field` | `string` | on main |
| `string.name` | `string :field` | `string.name` | on main |
| `string.nullable` | `string :field nullable` | `string.nullable` | on main |
| `string.default` | `string :field default="hello"` | `string.default` | on main |
| `string.min` | `string :field min=0` | `string.min` | on main |
| `string.max` | `string :field max=100` | `string.max` | on main |
| `string.match` | `string :field match=/^hello$/` | `string.match` | on main |
| `string.primary-key` | `string :field primary-key` | `string.primary-key` | on main |
| `string.unique` | `string :field unique` | `string.unique` | on main |
| `string.value` | `string :field() { return "hello" }` | `string.value` | on main |
| `sum` | `sum :total of="lines.amount"` | `sum` | on main |
| `sum.name` | `sum :total of="lines.amount"` | `sum.name` | on main |
| `sum.of` | `sum :total of="lines.amount"` | `sum.of` | on main |
| `timestamp` | `timestamp :field` | `timestamp` | on main |
| `timestamp.name` | `timestamp :field` | `timestamp.name` | on main |
| `timestamp.nullable` | `timestamp :field nullable` | `timestamp.nullable` | on main |
| `timestamp.default` | `timestamp :field default="2026-10-09T12:00:00Z"` | `timestamp.default` | on main |
| `timestamp.unique` | `timestamp :field unique` | `timestamp.unique` | on main |
| `timestamp.on` | `timestamp :field on=:create` | `timestamp.on` | on main |
| `timestamp.value` | `timestamp :field() { return new Date() }` | `timestamp.value` | on main |
| `update` | `update :work` | `update` | on main |
| `update.name` | `update :work` | `update.name` | on main |
| `uuid` | `uuid :field` | `uuid` | on main |
| `uuid.name` | `uuid :field` | `uuid.name` | on main |
| `uuid.nullable` | `uuid :field nullable` | `uuid.nullable` | on main |
| `uuid.default` | `uuid :field default="00000000-0000-4000-8000-000000000001"` | `uuid.default` | on main |
| `uuid.primary-key` | `uuid :field primary-key` | `uuid.primary-key` | on main |
| `uuid.unique` | `uuid :field unique` | `uuid.unique` | on main |
| `uuid.value` | `uuid :field() { return "00000000-0000-4000-8000-000000000001" }` | `uuid.value` | on main |
| `validate` | `validate` | `validate` | on main |
| `when` | `when=() => true` | `when` | on main |
| `when.value` | `when=() => true` | `when.value` | on main |

## 4. Deviations

### 4.0 Where Mesh's design differs from Ash

These are deliberate. Each has its record.

| # | Mesh | Ash | Record |
|---|---|---|---|
| V1 | One line shape, `kind #name options`; the type, relationship kind or action type is the tag | Positional arguments and per-entity options | [ADR-0050](../decisions/0050-entity-file-syntax.md) |
| V2 | Attributes are required unless `nullable` | `allow_nil?` defaults to `true` | [ADR-0050](../decisions/0050-entity-file-syntax.md) |
| V3 | One domain per app; folders are modules; no attribute names the domain | Many domains; each resource names its own | [ADR-0057](../decisions/0057-one-domain-modules-as-folders.md) |
| V4 | `validate` runs before the steps; `self` is the record with the accepted input applied; one-field rules go on the attribute line, `check` only for cross-field or stored-state rules | Changes and validations interleaved in one list | [ADR-0053](../decisions/0053-validate-then-do.md) |
| V5 | The write strategy is inferred and printed by `mesh explain` | `require_atomic?` declared per action | [ADR-0054](../decisions/0054-write-strategy-is-inferred.md) |
| V6 | Policies are core; checks inside a policy combine without order; every covering policy must pass; no policies means forbidden; no `bypass` | The authorizer is opt-in per resource; bypass policies | [ADR-0055](../decisions/0055-policies-are-core.md) |
| V7 | A function whose body is one expression is translated; anything else is plain code; the record is `self` | `expr(...)` with bare attribute names and `^actor` templates | [ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md) |
| V8 | One flat action context argument | `actor:`, `tenant:`, `context:` options, or `Ash.Scope` | [ADR-0059](../decisions/0059-action-context.md) |
| V9 | A `has-one` target gets a unique index | Truncates silently | [ADR-0045](../decisions/0045-has-one-uniqueness.md) (proposed) |
| V10 | Generated code carries the behaviour and is committed | Behaviour lives in the library | [ADR-0003](../decisions/0003-generated-code-carries-behaviour.md) |

### 4.0.1 The M1 alignment (history)

History: the M1 alignment as decided on 2026-10-04. The vocabulary decisions that superseded it are records 0049 to 0056 (section 4.0); where a sentence below disagrees with them, the records win.

The rest of this section, and sections 5 to 7, record the alignment of the contracts with Ash's DSL done in M1, when the vocabulary still copied Ash. They describe the M1 contracts, not the code on `main`. "Now" below means the contracts before that alignment.

"Now" is what `contracts.ts` or the roadmap has today. "Alignment" is the change the ruling implies. Exceptions go to Section 5; open research to Section 6.

### 4.1 Names and structure

| # | Mesh now | Ash | Alignment |
|---|---|---|---|
| D1 | kebab-case names (`uuid-primary-key`, `belongs-to`, `authorize-if`, `action-type`) and booleans without `?` (`public`, `required`) against Ash's snake_case and `?` | `uuid_primary_key`, `belongs_to`, `authorize_if`, `action_type`, `allow_nil?`, `public?` | Not a deviation: the naming rule of Section 0 maps one to the other. Only the names that differ by more than the rule (`required` against `allow-nil`, `timestamps`, `number`, `enum`) are listed below. **Done:** the names in `contracts.ts` follow the rule; a test checks every tag and attribute name. |
| D3 | `attribute="title" type="string"`: name as the default attribute, `type` as a named attribute | `attribute :subject, :string` ([Ash features](../research/ash-features.md) §12) | Aligned in the only way MX holds positionals (Section 2). |
| D4 | `uuid-primary-key="id"` (338-342) | `uuid_primary_key :id`, with `writable? false`, `public? true` ([Ash features](../research/ash-features.md) §2.3) | The name follows the rule; the model applies the same defaults. |
| D5 | one `timestamps` tag (355) | two entities, `create_timestamp name` and `update_timestamp name` ([Ash features](../research/ash-features.md) §2.3, §12.1). Whether Ash also has a combined entity: not in the research. | Align: replace with the two entities, each with an explicit name. **Done:** `create-timestamp` and `update-timestamp`, each optional and at most once, each with a required name. |
| D6 | `required` (348), a flag meaning "not null" | `allow_nil?`, default `true` ([Ash features](../research/ash-features.md) §2.2) | Align: replace with `allow-nil=false`. The default (nullable) is the same. **Done:** `allow-nil=false`; `required` is gone. |
| D7 | `public` flag (349) | `public?`, default `false` ([Ash features](../research/ash-features.md) §2.2) | The name follows the rule. The roadmap already treats the meaning as Ash does: recorded, not read in v1 ([roadmap](./roadmap.md) M1; [ADR-0035](../decisions/0035-meaning-of-public.md)). **Done:** `public` is unchanged. |
| D8 | type `number` (45) | `integer`, `float`, `decimal` ([Ash features](../research/ash-features.md) §2.1); no `number` | Align: replace `number` with `integer` and `float`. `decimal` is not in the roadmap. **Done:** `integer` and `float`; `number` is gone. |
| D9 | type `enum` with `values` (47, 348); `calculate.type` excludes it (57, 459) | an atom with `constraints [one_of: [...]]` ([Ash features](../research/ash-features.md) §12), or an `Ash.Type.Enum` module with `values/0` ([Ash features](../research/ash-features.md) §2.1) | Align: `type="atom"` with `constraints={ one_of: [...] }`. MX can express it: a contract attribute may omit its `type` (`contracts.ts:351` does), and `analyze` reads the object literal's Babel node. Whether the untyped attribute may keep `literalOnly` for an object literal is not checked; if not, drop `literalOnly` for `constraints` and check it in `analyze`. The `calculate.type` list (R9) then excludes `atom`. **Done:** `type="atom"` with `constraints={ one_of: [...] }`; `values` and `enum` are gone. An untyped contract attribute keeps `literalOnly` for an object literal: the negative fixture `literal-only-constraints` shows an identifier is rejected and every positive fixture with `constraints` parses (Appendix B). `analyze` reads the object literal's Babel node, rejects a `constraints` that is not an object literal, has no `one_of` or has an unknown constraint, and rejects `one_of` that is not a list of non-blank, non-repeated strings, at least one. |
| D10 | `belongs-to="author" resource="user"` (366) | `belongs_to name, destination`, the destination being a module ([Ash features](../research/ash-features.md) §12) | Align: Ash's name for the second positional is `destination` (G9, Ash 3.34.0, checked 2026-10-04). **Done:** `destination=` on `belongs-to` and `has-many`; `resource=` is gone. |
| D11 | `has_one` absent (358-362); [roadmap](./roadmap.md) M7 adds it | `has_one` ([Ash features](../research/ash-features.md) §3) | Align: add `has-one`, same shape as `has-many`, in M7. |
| D12 | foreign key: [roadmap](./roadmap.md) M7 says a `belongs-to` adds its foreign-key attribute (the fixture's `authorId`) | `belongs_to :representative` creates `representative_id` ([Ash features](../research/ash-features.md) §12, get-started 561-567) | Not vocabulary: the generated name is a value (Section 0). Ash's rule is `<name>_id`. Settled: the relationship's name plus `Id` (`belongs-to=List #list` creates `listId`), [ADR-0050](../decisions/0050-entity-file-syntax.md). |
| D13 | `defaults=[...]` is a child tag of `actions` (378, 385-389) | an option of the `actions` section ([Ash features](../research/ash-features.md) §1.2) | Align: an attribute of `actions`; remove the `defaults` tag. **Done:** `defaults` is an attribute of `actions`; the `defaults` tag is gone. |
| D14 | no `accept` on `destroy` (404) | `accept` on create, update and destroy ([Ash features](../research/ash-features.md) §4.1) | Align: add `accept` to `destroy`. **Done:** `accept` on `destroy`, checked like the others. |
| D15 | `validate` allowed in update and destroy only (399, 405, 419); none in create (393) or read (411) | `validate` nested in create, read, update, destroy and generic ([Ash features](../research/ash-features.md) §1.2) | Align: allow `validate` in create and read. The review of PR #1 records no reason for the omission. **Done:** `validate` allowed in `create` and `read`. |
| D16 | `change`, `validate`, `filter`, `authorize-if` take an arrow function with destructured parameters, `({ post, actor }) => ...` (78, 415-416, 419, 424, 447); the roadmap converts arrow functions ([roadmap](./roadmap.md) M4) | `change`/`validate` take a built-in call (24 changes, 24 validations, [Ash features](../research/ash-features.md) §4.3-4.4), a module, or `{Module, opts}` ([Ash features](../research/ash-features.md) §12); `filter`, calculations and policy checks take `expr(...)` ([Ash features](../research/ash-features.md) §5.1, §6.1) | Align in form where the research documents the helper: built-in calls with Ash's snake_case names as JavaScript identifiers (`set_attribute(...)`). MX can express it: a call is accepted by `function` attributes (MX project notes, contract-extensions §5, table, last row). The form of a translatable expression (arrow function with declared parameters, or an `expr(...)` call around one) is designed in M4 (D37); an arrow function stays the form of code that is not a built-in (Ash's custom change module, [Ash features](../research/ash-features.md) §2.5). Because [roadmap](./roadmap.md) M4 and M5 are written around arrow functions, Section 7 keeps arrow functions until then. Roadmap edits: Section 4.3. |
| D17 | `sort=["-insertedAt"]` as a child of `read` (411, 427-431) | no `sort` entity on a read action ([Ash features](../research/ash-features.md) §1.2) | Open: G1. Checked (G1): Ash sorts a read through `prepare build(sort: ...)`, with `-` for descending as in Mesh's strings; see row 75. The `sort` tag stays until M3/M5 decides the form. |
| D18 | pagination named only as "new vocabulary" ([roadmap](./roadmap.md) M3) | nested `pagination` with 9 options ([Ash features](../research/ash-features.md) §4.11) | Align: a `pagination` child of `read` with Ash's option names; M3 implements `offset` and `keyset`. |
| D19 | preparations ([roadmap](./roadmap.md) M5): no name given | nested `prepare` on read ([Ash features](../research/ash-features.md) §1.2, §4.5) | Align: a `prepare` child of `read`. |
| D20 | arguments ([roadmap](./roadmap.md) M5): no shape given | `argument name, type` with options ([Ash features](../research/ash-features.md) §4.2) | Align: an `argument` child of every action. |
| D21 | [roadmap](./roadmap.md) M5: an action with an opaque change, or a change or validation that reads the stored record, is not atomic and must say Ash's `require_atomic?` set to false | `require_atomic?`, default `true`, update and destroy ([Ash features](../research/ash-features.md) §4.9) | Already aligned in the roadmap; spelled `require-atomic=false` (Section 0). The proposal put `require-atomic=false` on `publish`, which validates `post.title`; the contracts add the attribute in M5, and the fixture of Section 7 does not carry it yet (it is M5 vocabulary). |
| D22 | `policy` takes `action` or `action-type` as string attributes (440-441) | the policy's condition is a check call, `action_type(:read)`, `action(:name)`, "a check or list of checks" ([Ash features](../research/ash-features.md) §6.1, §6.3) | Align: `policy=action_type("read")`, a list for several (call names are JavaScript identifiers, Section 0). MX can express it: the default attribute may be untyped and take a call (MX project notes, contract-extensions §5; `contracts.ts:351` for an untyped attribute); `analyze` reads the call. **Done:** `policy=action_type("read")`, `policy=action("publish")`, or a list. `analyze` accepts the two checks on main (row 91), each with one string literal or a non-empty array of string literals (any listed name matches); blank or repeated array items are errors. An unknown check, a non-call, a call with another argument count or type, and an empty condition list are errors. A condition list means all checks must match. |
| D23 | exactly one of `action`, `action-type`; both is an error (`analyzePolicy`, 233-244) | conditions combine as a list ([Ash features](../research/ash-features.md) §6.1) | Align: the "not both" rule goes; a list of checks replaces it (D22). **Done:** the "not both" rule is gone; a list of checks replaces it. |
| D24 | `authorize-if` required, at least one, in every `policy` (443) | a policy's entities are four check forms ([Ash features](../research/ash-features.md) §6.1); whether a policy may have zero checks is not in the research (G8) | Align at M8: "at least one check of any of the four kinds" as an `analyze` rule. Until then keep. Checked (G8, Ash 3.34.0, checked 2026-10-04): in Ash a policy may have no condition (it then always applies) but needs at least one check of the four kinds; the source error is "Policies must have at least one check." (`src/lib/ash/policy/policy.ex`). So the M8 rule "at least one check of any kind" is Ash's, and Mesh's required condition is a deviation to revisit in M8 (Ash's condition is optional). |
| D25 | `forbid-if` ([roadmap](./roadmap.md) M8) | `forbid_if` ([Ash features](../research/ash-features.md) §6.1) | The name follows the rule. `authorize-unless` and `forbid-unless` are not in the roadmap. |
| D26 | `action-type` limited to create, read, update, destroy (`ACTION_TYPES`, 40) | five action types including generic `action` ([Ash features](../research/ash-features.md) §4.1) | Align when generic actions arrive (not planned, [roadmap](./roadmap.md) section 6). |
| D27 | `calculate="excerpt" type="string"` with a child tag `value` holding the body (455-467; fixture lines 36-39) | `calculate :name, :type, expr(...)` in one line ([Ash features](../research/ash-features.md) §5.1) | Open: G2. Checked (G2): Ash's third positional is `calculation`, optional, and takes `expr(...)`, a module, `{module, opts}` or a function; no multi-line expression form exists. Alignment follows in M7 with the child tag `value`'s replacement; not done in this task. |
| D28 | `count` with attribute `relationship` (475) | `count name, relationship_path` ([Ash features](../research/ash-features.md) §5.2; the positional's name is inferred, Section 2) | Align: rename the attribute to `relationship-path`. **Done:** `relationship-path`. |
| D29 | only `count` (471-472); [roadmap](./roadmap.md) M7 says "`count` and the other aggregates" | 9 kinds ([Ash features](../research/ash-features.md) §5.2) | Align: M7 names the kinds it implements from Ash's list, with `field` on all but `exists`. |
| D30 | `table` on `resource` (317) | `table` in the data layer's section (rows 3-4) | Exception X1. (`domain` is aligned: row 1.) |
| D31 | `attributes` required in a `resource` (320); no primary-key rule | `ValidatePrimaryKey` and `VerifyPrimaryKeyPresent` verifiers exist ([Ash DSL and extensions](../research/ash-dsl-and-extensions.md) §2.7); when the key is required is not in the research | **Done in M1 ([PR #12](https://github.com/svallory/mesh/pull/12)):** the checks step rejects a resource with no primary-key attribute at the resource name, with a fix to declare `uuid-primary-key` ([roadmap](./roadmap.md) M2 selects by key). There is no opt-out in M1. |
| D32 | a `has-one` target gets an implicit unique index on the foreign key, with no new vocabulary; declared identities stay after v1 ([roadmap](./roadmap.md) M7; [ADR-0045](../decisions/0045-has-one-uniqueness.md), Proposed) | Ash does not enforce it; it truncates silently ([research synthesis](../research/synthesis.md) §6, item 7). `identity name, keys` is Ash's way to declare uniqueness ([Ash features](../research/ash-features.md) §9) | Recorded deviation from Ash, in [ADR-0045](../decisions/0045-has-one-uniqueness.md). It is an emitted-schema rule, not vocabulary, and it is ruling-neutral, so it is not an operator exception. It adds a guarantee Ash lacks. |
| D33 | camelCase names the author chose in the fixture (`commentCount`, `insertedAt`, `authorId`; `post.mx:25, 17, 42`) | snake_case atoms (`inserted_at`, `representative_id`; [Ash features](../research/ash-features.md) §12) | Not vocabulary: names an author chooses are values and stay as written (Section 0). The fixture in Section 7 keeps its camelCase. Lead ruling, 2026-10-04: a column is named exactly like its attribute, with no transform ([rulings before M2](../decisions/rulings-2026-10-04.md)). |
| D34 | policies are in `ext-policies`, "first-party, on by default"; deny by default arrives with it ([roadmap](./roadmap.md) section 3, M8; [ADR-0036](../decisions/0036-deny-by-default-arrives-with-policies.md)) | the authorizer is opt-in per resource: "a resource has policy authorization only if it declares `authorizers: [Ash.Policy.Authorizer]`" ([Ash features](../research/ash-features.md) §6.8) | Exception X2. |
| D35 | hooks: [roadmap](./roadmap.md) M5 names no tag | hooks are changes: `change before_action(fn)` ([Ash features](../research/ash-features.md) §4.6) | Align: `change=before_action(...)` (rows 71-72; the call name is a JavaScript identifier, Section 0). MX can express it (a call, MX project notes, contract-extensions §5). Checked (G6): `before_action` and `after_action` run inside the transaction, `before_transaction` before it, `after_transaction` after it ends (committed or rolled back); see row 71. |
| D36 | the contract has only `message` on `validate` (420) | `where`, `on`, `only_when_valid?`, `before_action?`, `always_atomic?` on resource-level `validate` ([Ash features](../research/ash-features.md) §9); action-level options not in the research | Align when the roadmap needs them (`always-atomic` and `only-when-valid` bear on the M5 protocol); G7. Checked (G7): the action-level `validate` options are `where`, `only_when_valid?`, `message`, `description`, `before_action?`, `always_atomic?` (no `on`); the action-level `change` options are `where`, `only_when_valid?`, `description`, `always_atomic?`. Not added to the contracts; M5 adds what the protocol needs. |
| D37 | expression references go through a declared parameter (`post.state`, `actor.id`) | bare attribute names inside `expr(...)` and the templates `^actor(:id)`, `^arg(:name)`, `^context(:key)`, `^ref(...)` ([Ash features](../research/ash-features.md) §5.5, §6.1) | Recorded deviation, kept (the scope rule of [roadmap](./roadmap.md) M4 and [ADR-0010](../decisions/0010-one-expression-tree-two-evaluators.md)): JavaScript has no implicit record scope, and [roadmap](./roadmap.md) M4 allows a translatable expression only its declared parameters and registered functions (a free variable is a build error). The templates have no JavaScript spelling; they map to declared parameters (rows 105-107), exact form designed in M4. Not aligned. |
| D38 | the M4 registry is Mesh's own and small | 15 operators, 39 functions ([Ash features](../research/ash-features.md) §5.3-5.4); call names inside `expr(...)` are not in the research | Align: each registry entry takes an Ash name written as a JavaScript identifier; G3. Checked (G3): the call names are listed in row 103. |

### 4.2 Rules the developer inferred or review required

Each row is a rule in `contracts.ts` that is not a name. "Ash" is what the research says; many rules are not in the research at all. "Origin" cites PR #1 (https://github.com/svallory/mesh/pull/1), whose description records the developer's list "Inferred by me" and rounds 1 to 4 of its review; it does not record who proposed each review finding.

| # | Rule and origin | Mesh now | Ash | Alignment |
|---|---|---|---|---|
| R1 | `values` required for `enum`, and rejected for any other type. Origin: "required" from MX project notes, contract-extensions §10; the reverse is the developer's inference | `analyzeAttribute`, 178-186 | `constraints` depend on the type ([Ash features](../research/ash-features.md) §2.4); whether an inapplicable one is an error: not in the research | Replaced by D9: `constraints` allowed only for types that accept them. **Done:** `analyzeAttribute` checks `constraints` by type. |
| R2 | `policy` exactly one of `action`, `action-type`. Origin: "one of" in MX project notes, contract-extensions §10; "exactly one" is the developer's | 233-244 | see D23 | Align (D23). **Done:** D23. |
| R3 | closed type list of six and closed action list of four. Origin: the developer ("the notes say 'fixed list' but give no list") | 43-50, 40 | 31 short names plus custom types ([Ash features](../research/ash-features.md) §2.1) | Align (D8, D26). **Done:** the type list (D8). The action list stays four (D26). |
| R4 | `authorize-if` required in `policy`; child `value` required in `calculate`. Origin: the developer | 443, 461 | not in the research | Keep for now; D24 and G2 revisit them. |
| R5 | `table` optional on `resource`. Origin: the developer, from MX project notes, contract-extensions / the MX data-target note | 317 | not in the research | Keep; X1. |
| R6 | `accept` allowed on `update`; `change` and `validate` repeatable on `update`. Origin: the developer | 398-399 | `accept` on update ([Ash features](../research/ash-features.md) §4.1) | Already consistent. |
| R7 | every contract closed: `closed()` fills `attributes`, `attributeTags`, `children` (leaf tags take no children, no attribute tags). Origin: review of PR #1, round 1 correction and round 2 items 1, 3, 4 | 62-64; header 18-21 | not in the research | Keep: an MX-contract rule with no Ash counterpart; M6 composes contracts for extensions ([ADR-0021](../decisions/0021-composed-contracts-module.md)). |
| R8 | every non-function attribute is `literalOnly`, so `resource=post` is an error. Origin: review of PR #1, round 2 item 2 | 18-23, 66-77 | not in the research | Keep: MX's static tree cannot evaluate an identifier. |
| R9 | `calculate.type` excludes `enum`. Origin: review of PR #1, round 2 item 5 | 57, 459 | not in the research | Keep; follows D9. **Done:** `calculate.type` excludes `atom`. |
| R10 | `destroy` contract with `change` and `validate`. Origin: review of PR #1, round 2 item 6 | 402-407 | destroy is an Ash action type ([Ash features](../research/ash-features.md) §4.1) | Align (adds `accept`, D14). **Done:** `destroy` has `accept`. |
| R11 | one `resource` per file, not in the contracts (MX has no root cardinality); enforced by the model. Origin: review of PR #1, round 2 item 7, round 3 item 2 | header 34-36 | "one module per resource" ([research synthesis](../research/synthesis.md) §1, first paragraph) | Already consistent. |
| R12 | `defaults` items must be action types, no repeats, no blanks, not empty. Origin: rounds 2 (item 8), 3 (items 3, 5), 4 (item 2) | 288-307, 267-276 | `defaults` names action types ([Ash features](../research/ash-features.md) §1.2) | Align the type check; keep the rest (not in the research). **Done:** the `defaults` type check is unchanged; it reads the `actions` attribute. |
| R13 | list items: no blank, no repeats, in `one_of` (was `values`), `defaults`, `accept`, `sort`; `sort=[]`, `defaults=[]` and `one_of: []` rejected, `accept=[]` accepted | 247-264, 266-276, 188-190 | `accept []` is valid in Ash ([Ash features](../research/ash-features.md) §12, get-started 317-335); the rest not in the research | Keep. |
| R14 | `default`: a string, number or boolean literal; negative numbers read; `null`, arrays, objects rejected; checked against the type; an atom default must be in `one_of`. Origin: round 2 item 9, round 3 item 1 | 106-124, 193-224 | `default` is "Value set on create" ([Ash features](../research/ash-features.md) §2.2); whether it can be a function: not in the research (G5) | Keep; the enum check follows D9. Checked (G5): Ash allows a function (zero-arity), an MFA tuple or a literal for `default` and `update_default`; Mesh keeps literals. |
| R15 | names may not be empty or whitespace; empty sections allowed; `validate` `message` may not be empty. Origin: round 2 item 10, round 3 item 4, round 4 item 3 | 146-159, 32-36, 421 | not in the research | Keep. |
| R16 | unknown tags rejected at any depth (`unknownTags: "reject"`). Origin: PR #2 (https://github.com/svallory/mesh/pull/2), MX `e65707a0` (MX project notes, updates) | tests | not in the research | Keep. |

### 4.3 Roadmap text that changes with the alignment

These were the edits to the roadmap the alignment implied on 2026-10-04. The roadmap has since been rewritten for syntax v2 (revision 4), so the list is history.

- **Done in the alignment pull request:** the roadmap's section 1 item 6 and M1's "Vocabulary alignment first" bullet now say the alignment is done, and the M1 model bullet quotes the aligned names (seven types, `allow-nil`, `constraints`, `create-timestamp`, `update-timestamp`, the `defaults` attribute). The "M1, model" item below is kept as the record of what changed.
- **M1, alignment.** The alignment is the first part of M1; its acceptance test ("every row marked 'on main' has a contract and a fixture that match it") is checked against Section 3 with the naming rule of Section 0.
- **M1, model.** Replace "attributes of the six types" with the aligned type list (D8, D9); `required` becomes `allow-nil` (D6); `timestamps` becomes `create-timestamp` and `update-timestamp` (D5); "the four action kinds with `accept` and `defaults`" becomes `defaults` as an attribute of `actions` (D13) with `accept` on destroy as well (D14); add the primary-key verifier (D31); the not-implemented list uses the aligned names; names an author chooses stay as written (D33); the registry/contract drift test ([ADR-0037](../decisions/0037-vocabulary-source-of-truth.md)) covers the new type list.
- **M3.** "New vocabulary" for pagination becomes the `pagination` child (D18); `sort` waits on G1.
- **M4.** The expression form is designed here: arrow functions with declared parameters stay (D37), built-in calls take Ash's snake_case names as JavaScript identifiers (D16), the first registry takes Ash's names (D38); `validate` in create and read adds positions to classify (D15).
- **M5.** Hooks are `change=before_action(...)` and the other three, as JavaScript calls (D35), with read-side hooks as `prepare` (rows 71-72); `prepare` and `argument` named (D19, D20); `before_transaction` is not scheduled; validation options (D36) if the protocol needs them.
- **M7.** `has-one` (D11); the generated foreign-key name is settled (D12); aggregate kinds (D29) and `relationship-path` (D28); the unique-index rule stays (D32).
- **M8.** `forbid-if` (D25); policy conditions are check calls (D22, D23); the rule "at least one check of any kind" (D24); if the operator rules against X2, [roadmap](./roadmap.md) section 3 ("on by default") and [ADR-0036](../decisions/0036-deny-by-default-arrives-with-policies.md) change.

## 5. Exceptions for the operator (both closed)

History: the M1 alignment recorded two deviations from Ash for the operator. Both are now closed by later records.

| # | Deviation | How it closed |
|---|---|---|
| X1 | Where the table name lives. In Ash, `table` sits in the data layer's own section (`postgres do table "users" end`, [Ash DSL and extensions](../research/ash-dsl-and-extensions.md) §3.3 and §4). | The operator ruled on 2026-10-04 that `table` stays on the root tag and would move to a data-layer section at M6 or the post-v1 vocabulary review ([rulings before M2](../decisions/rulings-2026-10-04.md)). Syntax v2 keeps it on the entity line, `entity #Post table="posts"` ([ADR-0050](../decisions/0050-entity-file-syntax.md)); the M6 move is withdrawn. |
| X2 | Policies on for every entity, where Ash's policy authorizer is opt-in per resource ([Ash features](../research/ash-features.md) §6.8). | Closed by [ADR-0055](../decisions/0055-policies-are-core.md): policies are core, not an extension, and an entity without a `policies` section forbids every action. |

## 6. Ash's form: the lookups, checked

These were gaps in the research. Each was looked up in Ash's documentation and source and the answer was then fact-checked. All facts below are **Ash 3.34.0, checked 2026-10-04**; the documentation is https://hexdocs.pm/ash/ (`dsl-ash-resource.html`, `dsl-ash-policy-authorizer.html`, `Ash.Query.html`, `Ash.Changeset.html`) and the source is https://github.com/ash-project/ash (`main`). Only checked facts are recorded; an unchecked sub-claim stays listed as open. "Applied" says whether the fact changed the contracts; vocabulary of a later milestone is recorded and the code is left alone.

| # | Fact | Source | Where it lands | Applied |
|---|---|---|---|---|
| G1 | `build` is a pass-through to `Ash.Query.build/2`; its options are `filter`, `filter_input`, `sort`, `sort_input`, `default_sort`, `distinct_sort`, `limit`, `offset`, `load`, `strict_load`, `select`, `ensure_selected`, `aggregate`, `calculate`, `distinct`, `context`. Sort strings: none or `+` ascending, `++` ascending nulls first, `-` descending, `--` descending nulls last; comma separated or a list. Example: `prepare build(sort: [song_rank: :desc], limit: 10)` | https://hexdocs.pm/ash/Ash.Query.html; `lib/ash/resource/preparation/builtins.ex`, `build.ex` | row 75, D17; M3 | no: later milestone |
| G2 | `calculate name, type, calculation \\ nil`: the third positional is `calculation`, optional, and takes `expr(...)`, a module, `{module, opts}` or a function of the records and the context. The multi-line form is a `do` block holding options | https://hexdocs.pm/ash/dsl-ash-resource.html | row 81, D27; M7 | no: `calculate` is not restructured here |
| G3 | The 39 registered functions are module names; the call names inside `expr(...)` are listed in row 103 (`is_nil`, `string_length`, `if`, `-` for `Minus`, ...). Built-in changes, validations and checks are DSL calls, not functions in `expr(...)`. **Open:** the validation and check builtins were not fetched, so how Mesh spells them is not settled | `lib/ash/filter/filter.ex` (`@functions`), `lib/ash/query/function/*.ex` (`use Ash.Query.Function, name: ...`), `lib/ash/resource/change/builtins.ex` | row 103, D16, D38; M4 | no: later milestone |
| G4 | `belongs_to`: `allow_nil?` true, `destination_attribute` `id`, `source_attribute` `<name>_id`. `has_one`/`has_many`: `source_attribute` `id`; `destination_attribute` has no default value and is guessed from the last segment of the source module's name plus `_id`. `allow_nil?` exists on `has_one` (true) and not on `has_many`. Also on all three: `public?` false, `writable?` true, `filterable?` true, `sortable?` true | https://hexdocs.pm/ash/dsl-ash-resource.html; `lib/ash/resource/transformers/has_destination_field.ex`, `relationships/{belongs_to,has_one,has_many}.ex` | rows 41-44; M7 | no: no on-main option contradicts them (the contracts have none of these options) |
| G5 | `default` and `update_default` have type `(-> any) \| mfa \| any`: a zero-arity function, an MFA tuple or a literal. **Open:** that `{MyModule, :my_func, []}` appears as an example on the page | https://hexdocs.pm/ash/dsl-ash-resource.html | rows 23-24, R14 | no: Mesh keeps literal defaults |
| G6 | Inside the transaction: `before_action` (after validations and changes, before the data layer action), `after_action` (success only), `around_action`. Outside: `before_transaction` (before it starts), `after_transaction` (after it ends, committed or rolled back; receives `{:ok, record}` or `{:error, reason}`) | https://hexdocs.pm/ash/Ash.Changeset.html; `lib/ash/resource/change/builtins.ex` | row 71, D35; M5 | no: later milestone |
| G7 | Action-level `validate`: `where`, `only_when_valid?`, `message`, `description`, `before_action?`, `always_atomic?`. Action-level `change`: `where`, `only_when_valid?`, `description`, `always_atomic?`. `on` exists only on the resource-level `validate` and `change` | https://hexdocs.pm/ash/dsl-ash-resource.html (`actions.create.validate`, `actions.create.change`) | row 68, D36; M5 | no: later milestone |
| G8 | A policy needs at least one check of `authorize_if`, `forbid_if`, `authorize_unless`, `forbid_unless` (error "Policies must have at least one check."); its condition is optional (`policy condition \\ nil`), and with none it always applies | `lib/ash/policy/policy.ex` (`transform/1`), `lib/ash/policy/authorizer/authorizer.ex`; https://hexdocs.pm/ash/dsl-ash-policy-authorizer.html | row 90, D24; M8 | no: Mesh's required condition stays until M8 |
| G9 | The positional names are in Section 2. In particular `belongs_to name, destination`, `has_many name, destination`, `create name`, `attribute name, type`, `count name, relationship_path` | https://hexdocs.pm/ash/dsl-ash-resource.html | Section 2, rows 37-38, 86, D10 | yes: `resource=` became `destination=` on `belongs-to` and `has-many` |
| model | `uuid_primary_key`: `public?` true, `writable?` false, `primary_key?` true, `allow_nil?` false (not accepted as an option), type `uuid`. `create_timestamp` and `update_timestamp`: `writable?` false, `allow_nil?` false, `public?` false (not overridden), `primary_key?` false | https://hexdocs.pm/ash/dsl-ash-resource.html; `lib/ash/resource/dsl.ex` | rows 15, 18, 19 | no change needed: the contracts take only a name for each |

The fact-check said the first lookups' quoted sentences for G1, G2, G3, G5, G6, G7 and G8 were not literal text of Ash's documentation; none of those sentences is used here.

## 7. Current fixtures

The compiler fixtures and the blog now use [entity file syntax v4](../../docs/entities.md). They serve different purposes; the full reference is not a copy of the runnable blog.

| File | What it checks | Current limit |
|---|---|---|
| [`packages/compiler/test/fixtures/post.mesh.mx`](https://github.com/svallory/mesh/blob/main/packages/compiler/test/fixtures/post.mesh.mx) | The full Invoice reference, including imported Customer, InvoiceLine and Payment entities, computed fields, checks, action steps and policies | Despite its historical filename, it declares `Invoice`. The compiler test builds it and compares the result with the hand-built model |
| [`packages/model/test/sample.ts`](https://github.com/svallory/mesh/blob/main/packages/model/test/sample.ts) | The independently hand-written Invoice model used as the compiler's expected result | Plain data, not generated from the compiler |
| [`packages/compiler/test/v4.ts`](https://github.com/svallory/mesh/blob/main/packages/compiler/test/v4.ts) | Executable Todo and List fixtures covering the currently parseable vocabulary | Uses declared `self` parameters for record reads in functions |
| [`examples/blog/src/domain/blog/post.mesh.mx`](https://github.com/svallory/mesh/blob/main/examples/blog/src/domain/blog/post.mesh.mx) | Post declaration: ten scalar types, User/Comment imports, relationships, a computed body and rollup, validation, steps, a filtered and sorted read, `on:load`, policies, and `&name` members in every position | Builds types, validators and the model, not action behaviour |

Mesh reads `&name` through its syntax module (`packages/compiler/src/syntax.ts`), which MX lowers before the compiler reads the tree; production never rewrites source or executes expressions.

The blog's domain root is `src/domain/`; its `blog` folder supplies the module name. `mesh build` writes the committed `.mesh/blog/*.types.ts`, `.validators.ts` and `.mesh/model.json`. The guard compares those bytes with a fresh in-memory build. The `#mesh` entry point and the action-function generators are not built yet; they come with M2.

---

## Appendix A. Current contract and model boundaries

The source of truth is [`packages/compiler/src/contracts.ts`](https://github.com/svallory/mesh/blob/main/packages/compiler/src/contracts.ts). [Section 3](#3-contract-coverage) enumerates its 44 authorable tags, their applicable options and the two tagless member forms. Each contract is closed: unlisted options, children and attribute tags are errors. `member` is reserved for MX's future lowering output, not an authored Mesh tag.

| Group | Current form | Where checked |
|---|---|---|
| Entity and sections | `entity :Name`, optional `table`, and `attributes`, `relationships`, `computed`, `actions`, `policies` | Contracts constrain nesting; the builder requires exactly one entity per file and a PascalCase name |
| Stored attributes and arguments | `uuid`, `string`, `integer`, `float`, `decimal`, `boolean`, `enum`, `date`, `datetime`, `timestamp` | Type-specific options in contracts; defaults and scalar formats in the builder. Attributes are required unless `nullable` |
| Primary keys | `primary-key` on `uuid`, `integer` or `string` only | Contracts reject other types; the builder requires exactly one non-null key |
| Relationships | `belongs-to`, `has-many`, `has-one`, each with an imported entity identifier | Contracts check the written identifier; the builder resolves named imports and their relative paths |
| Computed fields | A typed function body, or `count`, `sum`, `avg`, `min`, `max` with `of` | Function text is preserved; rollups resolve attributes through relationships, not computed fields |
| Actions | `create`, `read`, `update`, `destroy`, plus shared `always` rules and `auto` | The builder resolves input members, rejects managed input fields and duplicate names, and preserves checks and ordered steps |
| Checks and steps | `validate`/`check`, `do`/`set`/`when`/`load`/`run` | Checks retain labels, codes and messages. Literal assignments must fit the member's scalar type; functions are not evaluated |
| Query and policy declarations | `filter`, `sort`/`asc`/`desc`, `policy`, `authorize-if`, `forbid-if` | Contracts check function/reference shapes; the model retains declarations without executing SQL or authorization |

The builder also derives modules from the domain root, diagnoses duplicate entity names within a module, and retains source positions. [The fixtures in section 7](#7-current-fixtures) separate executable coverage from the authored member positions still waiting for MX. Translation described by [ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md) is later work; preserving a function in the model does not implement it.

## Appendix B. What this page did not verify

- Checked by the alignment (no longer open): an untyped contract attribute keeps `literalOnly` for an object literal (D9). An identifier is rejected (`literal-only-constraints`) and an object literal is accepted (every fixture with `constraints`).
- The two values the model package (`@meshfw/model`) records where this page was silent are now checked (Section 6, row "model"): `uuid-primary-key` is allow-nil false and public true; `create-timestamp` and `update-timestamp` are allow-nil false and public false. They match what the model records.
- The two sub-claims Section 6 keeps open: how Mesh spells the validation and check builtins (G3), and the `{MyModule, :my_func, []}` example of G5.
- Where adapters and extensions are enabled for a project in the Ash sense (rows 3 and 5): the roadmap places it in the project configuration, M1 and M6.
- Who proposed each finding in rounds 1 to 4 of the review of PR #1: the PR records what changed, not the author of each finding.

## Appendix C. The M1 naming rule and introduction (history)

This was the opening of the page while the vocabulary copied Ash ([ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md), superseded by [ADR-0049](../decisions/0049-vocabulary-is-meshs-own.md)). It still explains the spelling of the M1 contracts in section 3.

### C.0 The naming rule

**Mesh names are Ash's names in kebab-case with the trailing `?` dropped.** `belongs_to` becomes `belongs-to`, `uuid_primary_key` becomes `uuid-primary-key`, `allow_nil?` becomes `allow-nil`, `require_atomic?` becomes `require-atomic`. The mapping is mechanical and one-to-one: `_` becomes `-`, a trailing `?` is dropped, nothing else changes. A trailing `?` is disallowed by ruling, not by MX. The MX maintainers first measured on MX `main` at `7a404916` that an attribute name takes letters, digits and `._:-` and never `?` (recorded in [rulings of 2026-10-04](../decisions/rulings-2026-10-04.md), section "Lead decisions of the architecture-docs brief"), and later confirmed that the data target could allow it in attribute names; MX still allows it in tag names, as Marko does, and MX decision 144 reserves `?=` as a future attribute operator and bans a trailing `?` in attribute names on every target. The operator ruled on 2026-10-04 (table "Rulings after the decision review", row "Trailing `?` in attribute names") that Mesh does not use it, in attribute names or in tag names. Reasons: in TypeScript `name?` means optional, so `allow-nil?` reads wrong; it would permanently block a future `name?=expr` syntax; it diverges from Marko's translator; and a bare boolean attribute already carries the predicate meaning (`public`, `allow-nil=false`). The spelling is unchanged: Ash names in kebab-case with `?` dropped. Mesh declares no tag and no attribute whose name ends in `?` or contains `_`; a test asserts it (`contracts.test.ts`, "no tag name and no attribute name ends in `?` or contains `_`"). `_` would be accepted by MX in tag and attribute names; Mesh does not use it. **Scope of the rule.** It applies to *tag names and attribute names* only: the vocabulary. Three things are not vocabulary and the rule does not touch them. (1) Attribute values are strings the author writes: `insertedAt` in `create-timestamp="insertedAt"` is a value. (2) The names a resource author chooses for attributes, relationships and actions (the fixture's `authorId`, `commentCount`) are values too; they stay as the author writes them. (3) Everything inside an expression is JavaScript, parsed by Babel, and must be valid JavaScript: a call name keeps Ash's snake_case as an identifier (`action_type("read")`, `before_action(...)`, `set_attribute(...)`), because `action-type("read")` would parse as a subtraction. Ash's `^actor`, `^arg`, `^context`, `^ref` and `^tenant` templates have no valid JavaScript spelling; Section 3.9 maps them to the declared parameters of the arrow function.

**Decision record.** 2026-10-04, recorded in [rulings of 2026-10-04](../decisions/rulings-2026-10-04.md), section "Lead decisions of the architecture-docs brief"; a working decision (not an operator ruling); the operator may overrule. Alternative considered: Ash's exact spelling with `_` where MX allows it (`belongs_to`) and a different spelling only for booleans, which would have renamed every tag on `main` and left two conventions. Kebab-case matches what is on `main`, avoids renaming twice, and the operator revisits naming for MX after v1 ([ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md)). Consequence: names that differ from Ash only by this rule are not deviations and are not listed in Section 4.

**Attribute-name safety (M2).** The builder rejects these fixed built-in object property names for every attribute-declaring tag, even when no action accepts the field: `__proto__`, `constructor`, `prototype`, `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`, `toString`, `valueOf`, `__defineGetter__`, `__defineSetter__`, `__lookupGetter__`, `__lookupSetter__`. This is a restriction on author-chosen field names, not a vocabulary spelling change; it prevents prototype-sensitive input validation from silently losing or misreading fields.

### C.1 Introduction

The **vocabulary** of Mesh is the set of tag and attribute names a *resource file* may use. A resource file is a `.mx` file: Marko syntax, parsed by MX, a separate project. Mesh invents tag names, not syntax. For each tag name there is one MX **tag contract** (`CustomTag`) that says which attributes, children and parents the tag allows, plus `analyze` hooks for rules a declaration cannot express. MX is core in Mesh, not an adapter ([ADR-0043](../decisions/0043-mx-is-core.md)), so the 26 contracts live in the compiler package, `packages/compiler/src/contracts.ts`, with tests in `packages/compiler/test/`. (M0 moved them there. The alignment kept the count at 26: `defaults` and `timestamps` left, `create-timestamp` and `update-timestamp` arrived. The `contracts.ts:N` line numbers on this page are those of the file before the alignment, at `a3b52f4`; rows marked aligned describe the new form in the Mesh name column and the old one in the "On main today" column.) They are the only vocabulary code so far. PR #1 (https://github.com/svallory/mesh/pull/1) added them; PR #2 (https://github.com/svallory/mesh/pull/2) adopted MX's `unknownTags` option; PR #4 (https://github.com/svallory/mesh/pull/4) changed one test.

**Where the 26 came from.** The names were copied from an MX test fixture (`packages/targets/data/fixtures/ash-resource/post.mx` in the MX repository; MX project notes, getting-started section 1). The Mesh copy is `packages/compiler/test/fixtures/post.mx`; it has 31 tag occurrences and 25 distinct names. The 26th contract, `destroy`, was added in round 2 of the review of PR #1. Several rules were inferred by the developer in PR #1 or required in four rounds of review of PR #1. The operator never ruled on them.

**The ruling.** On 2026-10-04 the operator ruled ([rulings of 2026-10-04](../decisions/rulings-2026-10-04.md), table "Rulings after the decision review", row "Vocabulary"):

> Copy Ash's DSL for now (names and structure). After v1, review it and optimise for what feels natural in MX. Resource files and every example always use MX concise syntax.

It is recorded in [ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md) (copy Ash now, optimise after v1) and, for the third sentence, [ADR-0041](../decisions/0041-mx-concise-syntax.md). The consequence stated in [ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md): where the contracts or the roadmap deviate from Ash in names, defaults or inferred rules, they are aligned with Ash unless MX cannot express it. Only those exceptions go to the operator. A second reason is used on this page for the exceptions that remain: the deviation conflicts with a decision record (the record is named). After v1 the vocabulary is reviewed for what reads naturally in MX; that is a breaking rename for every resource file, planned separately ([ADR-0034](../decisions/0034-vocabulary-copies-ash-dsl.md), Consequences).

**What "copy Ash's DSL" means here.** **Ash** is the Elixir resource framework Mesh is modelled on. Its DSL is organised in *sections* (`attributes`, `actions`, ...), each holding *entities* (`attribute`, `create`, ...) that take *options*. Section 3 maps every Ash section, entity and option that Mesh v1 touches to a Mesh tag or attribute, with its status. Section 4 lists each place where `contracts.ts` or the roadmap differs from Ash and the alignment that follows. Section 5 holds the two deviations that go to the operator. Section 6 holds the points where Ash's form is not in the research, so the alignment cannot be written yet. Section 7 shows the fixture after alignment. Appendix A is the vocabulary on `main`, as it is.

Sources used on this page: [Ash features](../research/ash-features.md) (cited by section), [Ash DSL and extensions](../research/ash-dsl-and-extensions.md), [research synthesis](../research/synthesis.md), [roadmap](./roadmap.md), [rulings of 2026-10-04](../decisions/rulings-2026-10-04.md), MX project notes, getting-started, MX project notes, contract-extensions, MX project notes, updates, and the contracts file `contracts.ts:N` (line N of `packages/compiler/src/contracts.ts`). Where a detail (a default, an option name) is not in the research, the page says "not in the research" and does not fill it from memory.

### C.2 How to read the mapping

**Positional arguments.** Ash writes `attribute :subject, :string`: name and type are positional ([Ash features](../research/ash-features.md) section 12 examples). An MX tag has one *default attribute* (written `attribute="subject"`, and arriving in the tree as an attribute named `value`) plus named attributes (MX project notes, getting-started section 1). The rule used here: the first positional becomes the default attribute; a later positional becomes a named attribute carrying the name Ash gives it (`type` for `attribute` and `argument`, `keys` for `identity name, keys`, `destination` for a relationship, `relationship_path` for an aggregate), and otherwise the name Mesh has now, marked "inferred". The positional names were checked against Ash's documentation (Ash 3.34.0, checked 2026-10-04, G9 in Section 6, https://hexdocs.pm/ash/dsl-ash-resource.html): `attribute name, type`; `belongs_to name, destination`; `has_many name, destination`; `has_one name, destination`; `create name` (also `read`, `update`, `destroy`); `calculate name, type, calculation` (the third is optional); `count name, relationship_path` (the other aggregates add `field`; `custom` adds `type`); `identity name, keys`; `argument name, type`; `policy condition` (optional); `validate validation`; `change change`; `prepare preparation`. The two names that were inferred before the check, `relationship_path` and the relationship's destination, are Ash's own: the relationship's destination is `destination=` on `belongs-to` and `has-many`. `policy` and `calculate` are the two on-main tags whose positional Mesh does not name as Ash does (the policy's condition arrives as the default attribute `value`; `calculate`'s third positional is the child tag `value`); see D22, D27 and G2, G8.

**Concise syntax.** Every example is concise syntax, as in the fixture: indentation nests, no angle brackets ([ADR-0041](../decisions/0041-mx-concise-syntax.md)).

**Names.** The rule of Section 0. Ash atoms (`:read`) become strings (`"read"`). A bare boolean attribute means true (`public`); `allow-nil=false` is the explicit form (`contracts.ts:116-122` reads a `BooleanLiteral`).

**Status values.** *On main* (with line); *M3*, *M5*, *M7*, *M8* (the milestone the roadmap adds it in); *M4* (the expression milestone); *M6* (extension host); *after v1* ([roadmap](./roadmap.md) section 6 or a ruling); *not planned* ([roadmap](./roadmap.md) section 6, "Not planned at all"); *out of M8* (named as out of scope of that milestone); *not in roadmap* (neither scheduled nor excluded).


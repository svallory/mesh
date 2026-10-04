---
title: "Ash DSL and extension system"
description: "How Ash's Spark DSL, extension authoring and Igniter work, checked against source."
---

# How Ash's DSL and extension system works (Spark, extension authoring, Igniter)

> Independent fact-check: [review of this document](./reviews/ash-dsl-and-extensions-review.md).

Research ref: `ash-dsl-ext`. Written 2026-10-01.

**Versions examined** (from each repo's `mix.exs` `@version`, shallow clones at
`scratch/ash-src/`):

| Repo | Version |
|---|---|
| `spark` | 2.7.3 (`scratch/ash-src/spark/mix.exs:8`) |
| `ash` | 3.33.11 (`scratch/ash-src/ash/mix.exs:13`) |
| `igniter` | 0.8.4 (`scratch/ash-src/igniter/mix.exs:8`) |
| `ash_state_machine` | 0.2.13 |
| `ash_paper_trail` | 0.7.0 |
| `ash_archival` | 2.0.3 |
| `ash_oban` | 0.9.0 |
| `ash_events` | 0.8.2 |

Line references below are to these local clones unless a URL is given.

Elixir terms used throughout, defined once: a **macro** is compile-time code that
generates code; a **behaviour** is a list of required callbacks that a module opts into
with `@behaviour`; a **struct** is a fixed-shape map; a `__using__` macro injects code when
a module says `use MyThing`; **persisted** means a value written onto a module at compile
time and readable at runtime from the module itself.

---

## Summary

- Spark (`spark` 2.7.3) is a generic DSL toolkit. Ash itself is just one Spark user; every
  Ash DSL (`Ash.Resource`, `Ash.Domain`, `Ash.Reactor`, `Ash.Policy.Authorizer`, …) is
  declared as a `Spark.Dsl.Extension` — a module that returns a list of `Spark.Dsl.Section`
  structs (`spark/lib/spark/dsl/extension.ex:137`).
- A Spark DSL compiles down to a **plain map** (`dsl_state`) keyed by section path, plus a
  `:persist` sub-map. Nothing about the DSL is a runtime object; the whole config is
  `Macro.escape`d into functions on the module (`spark/lib/spark/dsl.ex:620-740`).
- Three compile-time hook kinds, in strict order: **transformers** (mutate the map), then
  **persisters** (also transformers, but always last, and conventionally only write to
  `:persist`), then **verifiers** — which run in an `@after_verify` hook *after* the module
  is compiled (`spark/lib/spark/dsl.ex:464`). **Verifier errors do not fail compilation**:
  the whole hook is wrapped in a `catch` clause that converts every raise into
  `IO.warn` (`spark/lib/spark/dsl.ex:558-574`). Transformer errors, by contrast, do abort
  the build.
- Ordering between transformers is a partial order expressed with `before?/1` / `after?/1`,
  topologically sorted with an Erlang digraph (`spark/lib/spark/dsl/transformer.ex:398-473`).
  Two sharp edges: a **pairwise contradiction is silently discarded** (`:418-419`), and a
  cycle is broken with no error and no warning, placing the chosen vertex at the *front* of
  the result (`:444-473`).
- `Ash.Resource` registers 20 transformers, 8 persisters and 27 verifiers
  (`ash/lib/ash/resource/dsl.ex:1807-1828`, `:1830-1839`, `:1841-1869`); `Ash.Domain`
  registers 2 transformers and 3 verifiers (`ash/lib/ash/domain/dsl.ex:192-205`).
- Extension *kinds* (resource extension, data layer, authorizer, notifier) are declared on
  the `use Spark.Dsl` call as `single_extension_kinds` / `many_extension_kinds` and are
  enforced by `Spark.Options` type checks such as `{:behaviour, Ash.DataLayer}`
  (`ash/lib/ash/resource.ex:18-36`).
- Extensions can (a) add their own sections, (b) add entities to *other* extensions' sections
  via `dsl_patches` (`%Spark.Dsl.Patch.AddEntity{}`), (c) mutate the whole resource in a
  transformer, and (d) generate whole new modules with `Module.create/3`.
- The four case studies range from AshArchival (430 lines, 1 transformer, no verifiers) to
  AshOban (5,196 lines, 3 transformers of which the largest is 1,715 lines, 3 verifiers,
  an Igniter module and 3 mix tasks). The clearest extension-authoring lesson is
  `AddTemporalInlineAttributes`, which writes a `reference` entity into **another
  package's** DSL section (`[:postgres, :references]`) without any `dsl_patch`.
- `Ash.Extension` (`ash/lib/ash/extension.ex:5-45`) is a behaviour whose seven callbacks
  (`migrate/1`, `reset/1`, `rollback/1`, `setup/1`, `tear_down/1`, `codegen/1`, `install/5`)
  are **all optional**; mix tasks invoke them duck-typed via `function_exported?/3`. No
  module in the clones declares `@behaviour Ash.Extension`.
- Tooling for free: `mix spark.formatter` (locals-without-parens), `Spark.Formatter`
  (section ordering), `mix spark.cheat_sheets` (Markdown cheat sheets with a `--check` CI
  mode), the ElixirSense/ElixirLS autocomplete plugin, `Spark.Dsl` auto-`@moduledoc`
  Options section, and `Spark.Test` for asserting verifier errors.
- Igniter (0.8.4) is an AST-aware project modifier. `mix igniter.install <pkg>` adds the dep,
  then runs the package's `Igniter.Mix.Task` installer, which edits `mix.exs`, `config.exs`
  and source files through zippers (AST cursors). Ash's own extension-aware hook is
  `Ash.Extension.install/5`, called by `mix ash.extend` (`ash/lib/mix/tasks/ash.extend.ex:178-180`),
  which `mix ash.gen.resource --extend` composes
  (`ash/lib/mix/tasks/gen/ash.gen.resource.ex:202-207`).
- Documented pain: Spark's own issue #290 (open, 2026-08-24) argues module-valued DSL fields
  create over-approximated compile-time dependencies; Ash #2267 (open, 2025-08-09) tracks
  185 compilation cycles in Ash itself; Ash #2670 (opened and closed 2026-04-09) is a
  compile **deadlock** caused by calling a policy-check module at compile time from an
  entity `transform/1`; and nine ElixirForum threads document compile times, the "copy
  core's transformer logic" ceiling for extensions, and the loss of DSL autocomplete in
  the new official Elixir LSP.

---

## 1. How a DSL is declared

### 1.1 The two structs

Everything is built from two plain structs, both `defstruct`s with a `@fields` list and a
`@type t`:

- **`Spark.Dsl.Section`** — `scratch/ash-src/spark/lib/spark/dsl/section.ex:33-54` (`@fields`). Fields
  include `name`, `schema` (option schema), `entities`, `sections` (nested sections),
  `imports`, `top_level?`, `auto_set_fields`, `singleton_entity_keys`, `deprecations`,
  `patchable?`, `modules`, `no_depend_modules`.
- **`Spark.Dsl.Entity`** — `scratch/ash-src/spark/lib/spark/dsl/entity.ex:70-93` (`@fields`). A "DSL
  constructor whose resulting value is a struct" (its own words). Fields: `name`, `target`
  (the struct built), `schema`, `args` (positional arguments), `identifier`, `transform`, and
  nested `entities` as a keyword list.

The two ways to write them are raw structs or the `Spark.Builder.*` API
(`Entity.new/3 |> Entity.build!()`, `Section.new/3 |> Section.build!()`,
`Field.new/3`) — `scratch/ash-src/spark/documentation/how_to/build-extensions-with-builders.md`.
Ash core itself still uses raw structs (`ash/lib/ash/resource/dsl.ex`); the builders are the
newer, recommended style.

### 1.2 Option schemas

Options are a keyword list of keyword lists, validated by `Spark.Options`
(`spark/lib/spark/options/options.ex`, 2,020 lines). The type language is substantial:
`{:one_of, [...]}`, `{:in, [...]}`, `{:list, type}`, `{:or, [...]}`, `{:wrap_list, type}`,
`{:fun, arity}`, `{:mfa, ...}`, `{:behaviour, Mod}`, `{:spark, Mod}`, `{:spark_function_behaviour, Mod, {Mod, arity}}`,
`{:quoted, ...}`, `:timeout`, `:keyword_list`, `{:list, {:struct, Mod}}`, and nested `keys:`
dicts. Validation errors come back as `%Spark.Options.ValidationError{}`
(`spark/lib/spark/options/validation_error.ex:1`).

`{:spark, Ash.Resource}` is what makes a DSL field mean "another Spark module" — Ash's domain
DSL uses it for the resource list (`ash/lib/ash/domain/dsl.ex:148`).

### 1.3 Declaring the extension

```elixir
use Spark.Dsl.Extension,
  sections: [@paper_trail],
  transformers: [...],
  persisters: [...],
  verifiers: [...],
  dsl_patches: [...],
  imports: [...],
  module_prefix: nil,
  add_extensions: []
```

`Spark.Dsl.Extension.__using__/1` (`spark/lib/spark/dsl/extension.ex:425-477`) validates the
sections, stores them in `@_sections`, builds a module per section/entity, and defines the
behaviour callbacks: `sections/0`, `transformers/0`, `verifiers/0`, `persisters/0`,
`module_imports/0`, `add_extensions/0`, and optional `explain/1`
(`spark/lib/spark/dsl/extension.ex:137-145`). It *also* defines two functions that are **not
callbacks** — `module_prefix/0` and `dsl_patches/0` (`:470-475`) — which is a source of
confusion, since they are generated like the callbacks but are absent from the behaviour.
Note that `verifiers/0` is prefixed with two built-ins automatically
(`spark/lib/spark/dsl/extension.ex:458-462`):

```elixir
def verifiers,
  do: [
    Spark.Dsl.Verifiers.VerifyEntityUniqueness,
    Spark.Dsl.Verifiers.VerifySectionSingletonEntities | @_verifiers
  ]
```

### 1.4 Declaring the DSL host

```elixir
defmodule MyApp.Vehicle do
  use Spark.Dsl
end
```

`Spark.Dsl.__using__/1` (`spark/lib/spark/dsl.ex:111-345`) is where the extension *kinds*
live. Its options (`spark/lib/spark/dsl.ex:11-63`):

| Option | Meaning |
|---|---|
| `single_extension_kinds` | e.g. `[:data_layer]` — one value, overwritten if the user also sets it |
| `many_extension_kinds` | e.g. `[:authorizers, :notifiers]` — appended to |
| `extension_kind_types` | e.g. `data_layer: {:behaviour, Ash.DataLayer}` — becomes a `Spark.Options` type check |
| `extension_kind_docs` | short doc string used in autocomplete |
| `default_extensions` | e.g. `data_layer: Ash.DataLayer.Simple, extensions: [Ash.Resource.Dsl]` |
| `untyped_extensions?` | default `true` — adds a free-form `extensions:` key accepting any `Spark.Dsl.Extension` |
| `opt_schema` | extra options for `use YourSpark` |
| `opts_to_document` | `:all` or a list; controls what goes into the auto-generated `@moduledoc` |

`use Spark.Dsl` also injects default `@behaviour Spark.Dsl` implementations of
`init/1`, `explain/2`, `verify/2`, `handle_opts/1`, `handle_before_compile/1`, all
`defoverridable` (`spark/lib/spark/dsl.ex:212-340`).

`Ash.Resource` uses all of it (`ash/lib/ash/resource.ex:18-36`):

```elixir
use Spark.Dsl,
  single_extension_kinds: [:data_layer],
  many_extension_kinds: [:authorizers, :notifiers],
  default_extensions: [
    data_layer: Ash.DataLayer.Simple,
    extensions: [Ash.Resource.Dsl]
  ],
  extension_kind_types: [
    authorizers: {:wrap_list, {:behaviour, Ash.Authorizer}},
    data_layer: {:behaviour, Ash.DataLayer},
    notifiers: {:wrap_list, {:behaviour, Ash.Notifier}}
  ],
  opt_schema: [...]
```

`Ash.Domain` only has `many_extension_kinds: [:authorizers]`
(`ash/lib/ash/domain/domain.ex:27-34`).

### 1.5 What it compiles to

The result is a **map**, not a struct and not a process. From the tutorial
(`scratch/ash-src/spark/documentation/tutorials/get-started-with-spark.md`, "Getting
information out of our DSL") and from the Ash writing-extensions guide
(`ash/documentation/topics/advanced/writing-extensions.md:36-44`, verbatim):

```elixir
%{
  [:attributes] => %{entities: [
      %Ash.Resource.Attribute{name: :name, type: :string}
    ]
  },
  ...
}
```

The guide's own snippet has only the `[:attributes]` entry plus `...`; the `persist:`
sub-map mentioned in the sentence above is real but is not part of this snippet.

Real section entries carry more: `entities`, `opts`, `section_anno`, `opts_anno`
(source locations, see §2.5). The whole thing is built in
`Spark.Dsl.Extension.set_state/3` (`spark/lib/spark/dsl/extension.ex:634-727`).

`set_state` collects each section's config out of the **process dictionary** keyed by
`{Module, :spark, section_path}` (sections are filled by generated `__set_and_validate_options__/4`
functions during module compilation), merges fragment configs, then runs transformers and
persisters.

### 1.6 How it is stored and read back

`Spark.Dsl.__before_compile__/1` (`spark/lib/spark/dsl.ex:457-750`) generates, on the module
itself:

- `entities(path)` — the entity list for a section path (`dsl.ex:629-633`)
- `fetch_opt(path, key)` — a clause per configured option (`dsl.ex:636-644`)
- `section_anno(path)`, `opt_anno(path, key)`, `opts_anno(path)`, `section_opts(path)`
- `persisted()` / `persisted(key, default)` / `fetch_persisted(key)` (`dsl.ex:702-741`)
- `spark_dsl_config()` — rebuilds the full map at runtime from those functions (`dsl.ex:724-734`)

Everything is `Macro.escape`d at compile time, so the runtime cost is reading a literal.

The public read API is `Spark.Dsl.Extension` (`spark/lib/spark/dsl/extension.ex`):
`get_entities/2` (`:270`), `get_opt/5` (`:322`), `fetch_opt/4` (`:329`), `get_persisted/3`
(`:282`), `fetch_persisted/2` (`:301`). All of them accept **either** a module **or** a
`dsl_state` map, which is why a transformer can pass `dsl_state` straight into an Info
function.

`get_opt/5` has a `configurable?` flag: when true it first checks app config
(`get_opt_config/3`, `extension.ex:385`) so an option can be overridden by `config :my_app`
rather than by editing the resource.

### 1.7 Info modules

`Spark.InfoGenerator` (`spark/lib/spark/info_generator.ex:25-46`) generates **five** kinds
of functions from an extension + a list of sections (option getter / bang getter / `?`
predicate / `_options` map / entity list):

| Family | Example | Returns | Line |
|---|---|---|---|
| plain option getter | `state_machine_state_attribute(r)` | `{:ok, value}` \| `:error` | `:204-229` |
| bang option getter | `state_machine_state_attribute!(r)` | `value`, raises if unset | same |
| boolean predicate | `archive_base_filter?(r)` | `true` \| `false` | `:175-190` |
| options map | `state_machine_options(r)` | all options with defaults applied | `:48-60` |
| entity list | `state_machine_transitions(r)` | list of entity structs for the section | `:95-115` |

A real generated predicate: `AshArchival.Resource.Info.archive_base_filter?/1`
(`AshArchival.Resource.Info` is `use Spark.InfoGenerator, extension: AshArchival.Resource,
sections: [:archive]`), called at
`ash_archival/lib/ash_archival/resource/preparations/filter_archived.ex:14`.

Extensions that follow the convention:

- `AshStateMachine.Info` — `use Spark.InfoGenerator, extension: AshStateMachine, sections: [:state_machine]`
  (`ash_state_machine/lib/info.ex:7`)
- `AshEvents.Events.Info` — `ash_events/lib/events/events.ex:86-93`
- `AshPaperTrail.Resource.Info` — 216 lines, `ash_paper_trail/lib/resource/info.ex`

`Ash.Resource.Info` is the counterexample: it is **hand-written**, 119 `def`s
(`ash/lib/ash/resource/info.ex`), calling `Extension.get_entities/2` and
`Extension.get_opt/3` by hand. It exists because Ash needed filters, lookups and
`reverse_relationship/2` that a generator cannot produce.

---

## 2. The compile pipeline

### 2.1 Order

1. **Transformers** — during compilation, dependency-ordered, may mutate anything.
2. **Persisters** — during compilation, always after all transformers, conventionally only
   write `:persist`.
3. **Verifiers** — after the module is compiled, read-only.

This is stated identically in `Spark.Dsl.Transformer`'s moduledoc
(`spark/lib/spark/dsl/transformer.ex:1-45`), `Spark.Dsl.Verifier`'s moduledoc
(`spark/lib/spark/dsl/verifier.ex:1-45`), `Spark.Dsl.Extension`'s moduledoc
(`spark/lib/spark/dsl/extension.ex:82-96`) and `writing-extensions.md`.

### 2.2 Transformers

Behaviour (`spark/lib/spark/dsl/transformer.ex:60-68`, verbatim; the source breaks the
`transform/1` return union over several lines):

```elixir
@callback transform(map) ::
            :ok
            | {:ok, map}
            | {:error, term}
            | {:warn, map, warning() | list(warning())}
            | :halt
@callback before?(module) :: boolean
@callback after?(module) :: boolean
@callback after_compile?() :: boolean
```

`use Spark.Dsl.Transformer` injects `before?(_) -> false`, `after?(_) -> false`,
`after_compile?() -> false`, all overridable (`__using__/1` at `transformer.ex:70`).

Helper API (all on `Spark.Dsl.Transformer`):

| Function | Line | What it does |
|---|---|---|
| `get_entities/2` | `:301` | read entities at a path |
| `fetch_option/3`, `get_option/4` | `:310`, `:342` | read options at a path |
| `add_entity/4` | `:273` | add, prepend (default) or `type: :append` |
| `replace_entity/4` | `:372` | replace, default matcher on `__struct__` + `__identifier__` |
| `remove_entity/3` | `:290` | remove by predicate |
| `set_option/4` | `:353` | write an option |
| `build_entity/4`, `build_entity!/4` | `:192`, `:166` | construct an entity struct through its extension's schema |
| `persist/3` | `:88` | write into the `:persist` map |
| `get_persisted/2,3`, `fetch_persisted/2` | `:148`, `:157` | read `:persist` |
| `eval/3` | `:132` | queue a quoted block for `Code.eval_quoted` in the DSL module |
| `async_compile/2` | `:98` | queue a function to run in a parallel compiler |
| `get_section_anno/2`, `get_opt_anno/3` | `:322`, `:332` | source locations |

The `eval/3` docstring is unusually candid: *"Use this **extremely sparingly**. It should
almost never be necessary"* (`transformer.ex:104-106`).

`run_transformers/4` (`spark/lib/spark/dsl/extension.ex:747-828`) is the driver. It
injects `:env` into `:persist` (so extensions can get the `Macro.Env`), then reduces:

- `:ok` → continue unchanged
- `:halt` → stop, keep current state. Note this halts the **whole** remaining list,
  persisters included, because persisters are concatenated into the same
  `Enum.reduce_while` (§2.3) rather than run in a separate pass.
- `{:warn, dsl, warnings}` → emit `Spark.Warning.warn/3` per warning, continue with new dsl
- `{:ok, dsl}` → continue
- `{:error, %Spark.Error.DslError{}}` → re-raise
- anything else → `raise` with the list of five valid returns

Any exception that is not a `DslError` is re-raised as
`"Exception in transformer <mod> on <resource>: ..."` (`extension.ex:757-766`).

### 2.3 Persisters

Listed under `persisters:` but use the same `Spark.Dsl.Transformer` behaviour. The sort in
`set_state` is explicit (`spark/lib/spark/dsl/extension.ex:693-702`):

```elixir
transformers_to_run =
  if transform? do
    @extensions
    |> Enum.flat_map(& &1.transformers())
    |> Transformer.sort()
    |> Enum.reject(& &1.after_compile?())
    |> Enum.concat(@extensions |> Enum.flat_map(& &1.persisters()) |> Transformer.sort())
  else
    []
  end
```

(Verbatim, `spark/lib/spark/dsl/extension.ex:693-702`; the `if transform?` wrapper decides
whether any transformer runs at all for this resource.) So: sort transformers, drop the
`after_compile?` ones, then concat a separately-sorted
persister list. Ordering declarations that target a transformer are ignored by construction —
the two lists are sorted independently and concatenated.

`await_persisted_compile_funs/1` (`extension.ex:742-745`) runs everything queued via
`async_compile/2` after the serial pipeline finishes.

### 2.4 Verifiers

Behaviour is one callback (`spark/lib/spark/dsl/verifier.ex:54-57`):

```elixir
@callback verify(map) :: :ok | {:error, term} | {:warn, warning() | list(warning())}
```

`Spark.Dsl.Verifier` re-exports the read-only helpers from `Transformer`
(`verifier.ex:65-71`). That re-export is a convenience, **not** the enforcement of
"read-only": a verifier can still call `Spark.Dsl.Transformer.set_option/4` fully
qualified. What actually makes the contract read-only is that `verify/1` returns only
`:ok | {:error, _} | {:warn, _}` and the result is discarded once the module is compiled —
a mutating verifier would simply have its effects thrown away.

They run in an `@after_verify {__MODULE__, :__verify_spark_dsl__}` hook registered in
`Spark.Dsl.__before_compile__/1` (`spark/lib/spark/dsl.ex:464`). That generated function
(`dsl.ex:464-574`) does, in this order:

1. calls the parent `verify/2` callback (e.g. `Ash.Resource.verify/2`, which checks the
   resource is in a configured domain — `ash/lib/ash/resource.ex:78-100`);
2. computes `transformers_to_run` = the transformers with `after_compile?() == true`, sorted
   (`dsl.ex:466-471`) — **but does not run them yet**;
3. runs all verifiers, collecting `{:error, _}` returns (and rescued exceptions) into
   `errors`, and emitting `{:warn, _}` via `Spark.Warning.warn/3` or to a test collector
   (`dsl.ex:473-513`);
4. `final_errors = Enum.uniq(errors)` (`:518`), then a `cond` (`:521`, running to `:556`):
   - `final_errors == []` → run the `after_compile?` transformers;
   - a test collector is registered → send the errors to it and return `:ok`;
   - otherwise → reraise a single `DslError` with its own stacktrace, or `raise` a combined
     `"Multiple Errors Occurred"` `DslError`.

So `after_compile?` transformers run **after** the verifiers, and **only if the verifiers
passed**. This is the opposite of the order one might assume, and it matters: a transformer
that assumes its own earlier verification succeeded may never run at all.

**The critical consequence: step 4's `raise` never fails the build.** The whole generated
function body is followed by a `catch kind, reason -> …` clause (`dsl.ex:557-574`) that
catches throws, errors and exits alike and turns each into
`Spark.Warning.warn(...)` → `IO.warn/2` (`spark/lib/spark/warning.ex:35-54`). Spark states
this itself:

> "Verifier errors raised inside Spark's `@after_verify` hook are caught by the framework and
> emitted as stderr warnings instead of propagated as exceptions. This keeps compilation
> flowing when a DSL is invalid, but it means the natural ExUnit pattern — `assert_raise/2`
> — does not work."
> — `spark/documentation/how_to/test-spark-verifiers.md:9-12`, repeated in
> `spark/lib/spark/test.ex:9-13`

**Transformer errors behave the opposite way**: `run_transformers/4` re-raises, and
`set_state`'s `rescue` clause re-raises again (`extension.ex:704-722`), so a bad transform
aborts compilation. The asymmetry is deliberate — it is why `Spark.Test` exists (it turns
verifier output into structured data, §6) and why authors are steered toward verifiers for
validation and transformers for mutation.

### 2.5 Ordering

`Spark.Dsl.Transformer.sort/1` (`spark/lib/spark/dsl/transformer.ex:398-442`) builds an
`:digraph` with one vertex per transformer, then for **every ordered pair** `(left, right)`
computes two booleans:

```elixir
left_before_right? = left.before?(right) || right.after?(left)
left_after_right?  = left.after?(right)  || right.before?(left)
```

and then (`:413-433`):

- both true → **add no edge at all** (`:418-419`);
- only `left_before_right?` → edge `left -> right`;
- only `left_after_right?` → edge `right -> left`.

**The pairwise-conflict rule is the first sharp edge, and it is not a rare pattern — it is
the pattern Ash's own guide teaches.** The guide says:

> "# I go after every transformer / `def after?(_), do: true` / # except I go before
> `SomeOtherTransformer` / `def before?(SomeOtherTransformer), do: true`"
> — `ash/documentation/topics/advanced/writing-extensions.md:128-136`

For the pair (`X`, `SomeOtherTransformer`), `X.after?(_) -> true` makes `left_after_right?`
true, and `X.before?(SomeOtherTransformer) -> true` makes `left_before_right?` true — so the
one assertion the author cared about is **silently discarded**. Note the scope of the drop:
only the edge to `SomeOtherTransformer` is lost. Every other pair still gets an edge from
`after?(_) -> true`, so `X` is unordered relative to `SomeOtherTransformer` **only** — it
still runs after every other transformer. The inline comment at `transformer.ex:415-417`
shows the maintainers knew the pattern existed and chose silence over a warning:

> "# This is annoying, but some modules have `def after?(_), do: true`"

Two live victims in the clones:

- `AshPaperTrail.Resource.Transformers.RelateVersionResource` declares
  `before?(Ash.Resource.Transformers.SetRelationshipSource), do: true` **and**
  `after?(_), do: true` (`ash_paper_trail/lib/resource/transformers/relate_version_resource.ex:29-32`).
  The `before?` is dead.
- Ash core itself contains a mutual contradiction:
  `SetPrimaryActions.after?(DefaultAccept) -> true`
  (`ash/lib/ash/resource/transformers/set_primary_actions.ex:24`) and
  `DefaultAccept.after?(SetPrimaryActions) -> true`
  (`ash/lib/ash/resource/transformers/default_accept.ex:190`). For that pair both booleans
  are true, so the edge is dropped.

**The second sharp edge is the walk itself** (`transformer.ex:444-473`). Repeatedly:

1. if a vertex has no in-neighbours, take it, and prepend it to the accumulator
   `acc = [vertex | acc]` (`:469`);
2. else if a vertex has no out-neighbours (a sink), take it and **append**:
   `acc = acc ++ [vertex]` (`:464`);
3. else there is a cycle: take the vertex earliest in the *original declaration list* and
   **append** it the same way (`:455-460`).

The result is `Enum.reverse(acc)` (`:447`). So the two branches that append land at the
**front** of the final order, ahead of transformers already emitted, while the normal branch
lands at the back. Two consequences:

- **Ties are not broken by declaration order.** Among several ready vertices,
  `Enum.find(vertices, …)` picks the first in `:digraph.vertices/1` order, which is ETS
  `:ets.tab2list` order — unspecified and not the declaration order.
- **A cycle produces no error and no warning**, and the cycle-breaking vertex is moved to the
  *front* of the order, which is a strange place for it.

*Both of these last two points are read from the code, not observed by running it — I did
not execute Spark. The AshArchival, AshStateMachine and AshPaperTrail orderings described in
§5 are the same kind of code-reading, and I flag each one where it appears.*

### 2.6 Errors and source locations

`Spark.Error.DslError` (`spark/lib/spark/error/dsl_error.ex:1-45`) is a
`defexception` with exactly **five** attributes:
`[:module, :message, :path, :stacktrace, :location]` (`dsl_error.ex:7`).
`exception/1` captures the current stacktrace into a private
`Spark.Error.DslError.Stacktrace` struct, which `Inspect` renders as `%Stacktrace{}` to keep
BEAM traces compact.

`message/1` (`dsl_error.ex:40-59`) renders as:

```
[MyApp.BadValidator]
fields -> required defined in lib/my_app/bad_validator.ex:3:12:
  All required fields must be specified in fields
```

(Illustrative, composed from the `message/1` code at `dsl_error.ex:47-62`: the
`fields -> required defined in <file>:<line>:<col>:` prefix is what `get_location/1`
renders when a location is present. The Spark tutorial's actual output is the same shape
without the location — `fields -> required:` — `get-started-with-spark.md:390-392`.)

Source locations come from `%Spark.Dsl.Entity.Meta{anno, properties_anno}` stored in a
`__spark_metadata__` field that **entity target structs must declare** (the struct is
`%Spark.Dsl.Entity.Meta{anno, properties_anno}`, defined at
`spark/lib/spark/dsl/entity/meta.ex:5`, and written onto the built struct at
`spark/lib/spark/dsl/entity.ex:311-313`). There are two separate enforcement points:
Spark's own `@after_verify Spark.Dsl.Extension` hook walks every entity target struct of
every section and dsl patch, and emits a **deprecation warning at extension-compile time**
for any struct missing the field (`spark/lib/spark/dsl/extension.ex:453`, `:2243-2262`);
and reading `anno/1` off a struct without the field emits an `IO.warn` at read time
(`entity.ex:429-437`). Section-level locations come from `section_anno` / `opt_anno` /
`opts_anno` on the module (`dsl.ex:646-694`).

One more behaviour worth knowing: a transformer `DslError` that **carries a `location`** is
first emitted as an extra diagnostic warning via `diagnostic_warning/1` and then re-raised
with an **empty stacktrace** (`extension.ex:713-722`), precisely so the squiggly line in the
source file is what the reader sees rather than a trace.

### 2.7 Everything `Ash.Resource` registers

`ash/lib/ash/resource/dsl.ex`. Sections (`dsl.ex:1790-1806`), in order: `@attributes`,
`@relationships`, `@actions`, `@code_interface`, `@resource`, `@identities`, `@changes`,
`@preparations`, `@validations`, `@pipelines`, `@aggregates`, `@calculations`,
`@multitenancy`, `@temporal`. Registered at `dsl.ex:1873-1877`.

**Transformers** (`dsl.ex:1807-1828`) — 20 modules, in declaration order. Note this is
*declaration* order, not necessarily execution order; the actual order is the topological
sort of §2.5. Five of these have `@moduledoc false`, so their one-liners below are read from
the body, not from a moduledoc, and are marked accordingly.

| # | Module | What it does |
|---|---|---|
| 1 | `RequireStringLengthCountConfig` | requires `config :ash, :default_string_length_count` to be set |
| 2 | `ResolvePipelines` | replaces `PipeThrough` entities with pipeline contents in place |
| 3 | `RequireUniqueActionNames` | ensures all actions have unique names |
| 4 | `SetRelationshipSource` | sets `source` on relationships to the resource they were defined on |
| 5 | `AddPeriodAttribute` | `@moduledoc false`; adds or checks the `period` attribute of a temporal resource, and adds its `recorded_at` attribute if it names one it doesn't declare (source comment, `add_period_attribute.ex:6-7`) |
| 6 | `AddTemporalRelationshipFilters` | also rejects accepting the period attribute as action input (`add_temporal_relationship_filters.ex:6-20`); bakes a `range_overlaps` filter into relationships declaring `temporal_keys` — done at transform time specifically to avoid a compile-time dependency on the destination (`:9-15`) |
| 7 | `BelongsToAttribute` | creates the source attribute for `belongs_to` with `define_attribute?` |
| 8 | `HasDestinationField` | guesses `destination_attribute` for `has_many`/`has_one` |
| 9 | `ManyToManySourceAttributeOnJoinResource` | guesses `source_attribute_on_join_resource` |
| 10 | `ManyToManyDestinationAttributeOnJoinResource` | guesses `destination_attribute_on_join_resource` |
| 11 | `CreateJoinRelationship` | creates an auto-named `has_many` for each `many_to_many` |
| 12 | `CachePrimaryKey` | validates and caches the primary key |
| 13 | `SetPrimaryActions` | adds the default actions via `add_defaults/1` (`set_primary_actions.ex:27-28`) and validates the primary action configuration |
| 14 | `DefaultAccept` | sets the default `accept` for each action |
| 15 | `RequireUniqueFieldNames` | no duplicate names across attributes/calculations/aggregates/relationships |
| 16 | `SetInterfaceExcludeInputs` | `@moduledoc false` (`set_interface_exclude_inputs.ex:6`) |
| 17 | `SetDefineFor` | `@moduledoc false`; sets the `[:code_interface] :domain` option from the persisted domain, if unset (`set_define_for.ex:9-17`) — nothing to do with `for` |
| 18 | `SetEagerCheckWith` | `@moduledoc false`; sets `eager_check_with` on **identities** to the resource's domain, raising a `DslError` if no domain is set (`set_eager_check_with.ex:10-35`) — nothing to do with eager loading |
| 19 | `SetPreCheckWith` | `@moduledoc false`; the same for `pre_check_with` (`set_pre_check_with.ex:10-30`) |
| 20 | `GetByReadActions` | turns a read action's `get_by` option into a real get action |

*Read from source, not from a moduledoc:* rows 5, 16, 17, 18 and 19 carry
`@moduledoc false`, so their one-liners above are read from the body, not from a
moduledoc. (`RequireStringLengthCountConfig`, row 1, does have a moduledoc —
`require_string_length_count_config.ex:6-10`.)

**Persisters** (`dsl.ex:1830-1839`): `CacheRelationships`, `ResolveAutoTypes`,
`CacheCalculations`, `AttributesByName`, `ValidationsAndChangesForType`,
`CacheUniqueKeys`, `CacheActionInputs`, `SetActionTransactions`.

**Verifiers** (`dsl.ex:1841-1869`), **27** of them:
`ValidateRelationshipAttributesMatch`, `VerifyReservedCalculationArguments`,
`VerifyCalculations`, `VerifyIdentityFields`, `VerifyPrimaryReadActionHasNoArguments`,
`VerifySelectedByDefault`, `VerifyFilterExpressions`, `ValidateAggregateField`,
`ValidateRelationshipAttributes`, `ValidateThroughRelationships`, `NoReservedFieldNames`,
`ValidateAccept`, `ValidateActionTypesSupported`, `ValidateAggregatesSupported`,
`ValidateEagerIdentities`, `ValidateManagedRelationshipOpts`, `ValidateMultitenancy`,
`ValidateTemporal`, `ValidateTemporalKeys`, `ValidatePrimaryKey`,
`ValidateAtomicValidationDefaultTargetAttribute`, `VerifyAcceptedByDomain`,
`VerifyActionsAtomic`, `VerifyNotifiers`, `VerifyPrimaryKeyPresent`,
`VerifyGenericActionReactorInputs`, `ValidateArgumentsToCodeInterface`.

### 2.8 Everything `Ash.Domain` registers

`ash/lib/ash/domain/dsl.ex:192-205`. Sections: `@domain`, `@resources`, `@execution`,
`@authorization`.

- Transformers: `SetInterfaceExcludeInputs`, `DedupResources` (`domain/dsl.ex:198-201`)
- Verifiers: `EnsureNoEmbeds`, `ValidateRelatedResourceInclusion`, `ValidateArgumentsToCodeInterface` (`domain/dsl.ex:192-196`)
- No persisters.

---

## 3. Extending other DSLs

### 3.1 Adding sections to a resource

Just `sections: [@my_section]` in `use Spark.Dsl.Extension`, and the user adds
`extensions: [MyExt]` (or puts it in a base resource). The section becomes a builder macro
in the DSL module via `Spark.Dsl.Extension.prepare/1`
(`spark/lib/spark/dsl/extension.ex:504-631`), which emits
`import unquote(extension), only: [my_section: 1]`, and for `top_level?` sections, imports
the section module and the entity modules' macros.

### 3.2 `dsl_patches` — adding entities to *someone else's* section

The single struct is `%Spark.Dsl.Patch.AddEntity{section_path: [...], entity: entity}`
(`spark/lib/spark/dsl/patch/add_entity.ex:1-24`). Two real users:

- `Ash.Reactor` patches **13** entities into the `[:reactor]` section of **its own** DSL,
  the Reactor library's — not into Ash's (`ash/lib/ash/reactor/reactor.ex:41-57`).
- `AshAuthentication.Strategy.Custom` takes a user-supplied `%Spark.Dsl.Entity{}` and patches
  it into a configurable section path (`ash_authentication/lib/ash_authentication/strategies/custom.ex:117`).

Patches can only **add** top-level entities to a section — they cannot modify an existing
entity. This was asked for and refused: issue #83 requested `Spark.Dsl.Patch.ReplaceEntity`
and `DeleteEntity`, and the maintainer closed it (2024-03-30) with:

> "I'm going to close this particular issue, because allowing extensions to overwrite entities
> by other extensions is a whole can of worms that we should avoid unless we have no other
> option :)"
> — https://github.com/ash-project/spark/issues/83

The same limit shows up in practice: a user wanting `cached? true` *inside* a `read` action
was told by the maintainer, "The first one, `cached? true` won't be possible with the current
DSL extension options (maybe some day, but probably not)"
(https://forum.elixirforum.com/t/inputs-on-cache-layer-extension-for-read-actions/60933,
2024-01-12).

`module_prefix:` exists because generated modules are named
`ExtensionName.SectionName.EntityName` and can collide with user code
(`extension.ex:100-110`).

### 3.3 `Spark.Dsl.Fragment` — splitting one resource across files

`spark/lib/spark/dsl/fragment.ex:1-111`. A fragment is its own module that says what it is
a fragment *of*:

```elixir
defmodule MyApp.Accounts.User.Fragments.DataLayer do
  use Spark.Dsl.Fragment,
    of: Ash.Resource,
    data_layer: AshPostgres.DataLayer

  postgres do
    table "users"
    repo MyApp.Repo
    ...
  end
end

defmodule MyApp.Accounts.User do
  use Ash.Resource,
    fragments: [MyApp.Accounts.User.Fragments.DataLayer]

  ...
end
```

(Verbatim from `spark/documentation/how_to/split-up-large-dsls.md:25-44`, where the
fragment holds a `data_layer:` value and a `postgres` block. My own earlier example used an
`extensions:` fragment; the shape is the same.)

Mechanics: the fragment runs the same `prepare/1` and the same
`__set_and_validate_options__` machinery, exposes `extensions/0`, `opts/0`,
`spark_dsl_config/0`, `persisted/0`; the parent then calls
`Spark.Dsl.handle_fragments/2` (`spark/lib/spark/dsl.ex:756-780`), which concatenates
entity lists and merges opts — **merging two different values for the same option emits a
warning** naming the fragment (`dsl.ex:782-802`).

Constraints: "A DSL has all extensions that any of its fragments has"
(`split-up-large-dsls.md`); fragments are explicitly *not* for sharing behaviour across
instances — that is what extensions are for. Single-valued extension kinds cannot be set both
directly and via a fragment; that raises
`"<key> is being set as an option, but is also set in fragments: ..."` (`dsl.ex:280-292`).

### 3.4 `Spark.Dsl.Builder` and `Ash.Resource.Builder`

`Spark.Dsl.Builder` (`spark/lib/spark/dsl/builder.ex`) provides `defbuilder/2` and
`defbuilderp/2` macros that generate both a function head and **three clauses** so a builder
accepts `dsl_state`, `{:ok, dsl_state}` or `{:error, reason}` transparently
(`builder.ex:22-146`). Plus `handle_nested_builders/2` for unwrapping nested builder results.

`Ash.Resource.Builder` (`ash/lib/ash/resource/builder.ex`, 711 lines) is the Ash-level
convenience layer built on it. It defines **23** `defbuilder`s plus **18** `build_*` helpers
(`builder.ex:23-703`). The `defbuilder`s, each `@spec`ped:

```
add_new_action/4, add_action/4, prepend_action/4,
add_new_relationship/5, add_relationship/5,
add_new_identity/4, add_identity/4,
add_change/3, add_preparation/3,
add_new_update_timestamp/3, add_update_timestamp/3,
add_new_create_timestamp/3, add_create_timestamp/3,
add_new_attribute/4, add_attribute/4,
add_new_calculation/5, add_calculation/5,
add_new_aggregate/6, add_aggregate/6,
add_new_interface/3, add_interface/3,
add_new_calculation_interface/3, add_calculation_interface/3
```

The `add_new_*` variants are no-ops if the thing already exists. That is what makes most
extensions idempotent — but note that **`add_change/3` and `add_preparation/3` have no
`add_new_*` form** (`builder.ex:214`, `:261`), so the `add_preparation` calls in AshArchival
and AshStateMachine are not idempotent and will add a duplicate preparation on every
transform pass.

---

## 4. Kinds of extension in Ash

| Kind | Declared where | How registered on a resource | Contract | Count |
|---|---|---|---|---|
| Resource extension | the untyped `extensions:` key (`untyped_extensions?`, default `true`) | `use Ash.Resource, extensions: [MyExt]` | `Spark.Dsl.Extension` behaviour (7 callbacks) | many |
| Domain extension | same, on `Ash.Domain` | `use MyDomain, extensions: [MyExt]` | `Spark.Dsl.Extension` | many |
| Data layer | `single_extension_kinds: [:data_layer]` | `use Ash.Resource, data_layer: AshPostgres.DataLayer` | `Ash.DataLayer` behaviour, ~50 callbacks, ~40 of them `@optional` (`ash/lib/ash/data_layer/data_layer.ex:141-418`) | 1 |
| Authorizer | `many_extension_kinds: [:authorizers]` on **both** `Ash.Resource` and `Ash.Domain` | `authorizers: [Ash.Policy.Authorizer]` | `Ash.Authorizer` — 12 `@callback`s (`ash/lib/ash/authorizer.ex:17-84`): `initial_state/4`, `check/3`, `strict_check/3`, `check_context/1`, `strict_check_context/1`, `alter_filter/3`, `add_calculations/3`, `alter_results/4`, `apply_field_level_auth/…`, `evaluate_field_policies/…`, `protected_fields/1`, `exception/2` | many |
| Notifier | `many_extension_kinds: [:notifiers]` | `notifiers: [Ash.Notifier.PubSub]` | `Ash.Notifier` — `notify/1`, `requires_original_data?/2`, optional `load/2` (`ash/lib/ash/notifier/notifier.ex:9-26`) | many |

Notes:

- `Ash.Resource` also has an untyped escape hatch `simple_notifiers: [...]` for
  `Ash.Notifier`s with no DSL of their own (`ash/lib/ash/resource.ex:34-37`).
- `data_layer: :embedded` is special-cased in `Ash.Resource.init/1` and rewritten to
  `Ash.DataLayer.Simple` with `embedded?: true` (`ash/lib/ash/resource.ex:65-76`).
- Data layer and extension kinds are mutually dependent: a data layer *is* also a
  `Spark.Dsl.Extension` (AshPostgres declares `sections: [@postgres]`,
  `transformers: [ValidateTemporalReferences]`, 3+ verifiers at
  `ash_postgres/lib/data_layer.ex:438-455`), so `postgres do table "users" end` works inside
  a resource *because* `AshPostgres.DataLayer` is registered in `extensions`.

---

## 5. Case studies from source

### 5.1 AshStateMachine 0.2.13 — 1,184 lines total, ~840 relevant

**DSL** (`ash_state_machine/lib/ash_state_machine.ex:23-114`): one top-level section
`state_machine` (schema: `deprecated_states`, `extra_states`, `state_attribute` (default
`:state`), `initial_states` (required), `default_initial_state`) with one nested section
`transitions` and one entity `transition` targeting `AshStateMachine.Transition` with
`args: [:action]` and `identifier: {:auto, :unique_integer}` (`:27`). Registered at `:116-130` with
4 transformers, 2 verifiers, and `imports: [AshStateMachine.BuiltinChanges]`.

**Transformers**

| Module | Lines | Mutates |
|---|---|---|
| `SetDefaultInitialState` | 32 | if `initial_states` has exactly one entry, `Transformer.set_option([:state_machine], :default_initial_state, …)` |
| `FillInTransitionDefaults` | 58 | in `lib/transformers/fill_in_event_defaults.ex`; computes the union of all `from`/`to`/`initial_states`/`extra_states`, rewrites `[:state_machine] :initial_states` with `set_option` (`:28-33`), expands `:*` in place with `Transformer.replace_entity/3`, then `Transformer.persist(:all_state_machine_states, …)` |
| `AddState` | 124 | `before?(Ash.Resource.Transformers.DefaultAccept) -> true`, `after?(FillInTransitionDefaults) -> true` (`add_state.ex:11-15`); adds the state **attribute** via `Ash.Resource.Builder.add_attribute` with `constraints: [one_of: all_states]`, or, if it exists, rejects `allow_nil?: true` and unwraps `Ash.Type.NewType` |
| `EnsureStateSelected` | 19 | `Ash.Resource.Builder.add_preparation({Ash.Resource.Preparation.Build, ensure_selected: [state_attribute]})`. Global `preparations` apply to **read actions (queries)**, not to every action — the module's own comment says "Ensures that `state` is always selected on queries" (`ensure_state_selected.ex:6`) |

⚠️ **An undeclared ordering dependency, and the sharpest ordering problem in the whole
study.** `AddState` reads `default_initial_state` (`add_state.ex:25-30`), which
`SetDefaultInitialState` *sets* — but neither transformer declares ordering against the
other. The only order that matters is set by the digraph tie-break described in §2.5,
which is not the declaration order. *This is read from the code; I did not execute it.*

**Verifiers**: `VerifyDefaultInitialState` (38) checks the default is in `initial_states`;
`VerifyTransitionActions` (62) checks each `transition.action` names a real update action.

**Runtime modules**: `AshStateMachine.BuiltinChanges.transition_state/2` (82 lines),
`NextState` (26), and `AshStateMachine.Checks.ValidNextState` (70) — which despite living in
`lib/checks/` and its file name is **not** an `Ash.Check`; there is no `Ash.Check` module in
`ash/lib`. It is a **policy filter check**: `use Ash.Policy.FilterCheck`
(`ash_state_machine/lib/checks/valid_next_state.ex:5-9`), and it runs during authorization,
not on a field value.

Also outside the DSL proper but part of the extension: `lib/charts.ex` (76),
`lib/clarity/state_machine_diagram.ex` (51) and `lib/mix/generate_flow_charts.ex` (101),
which render state-machine diagrams from the compiled DSL.

**Extension points used**: sections, entity, transformer ×4, verifier ×2, Info module
(`lib/info.ex`, 21 lines), `imports:` for built-in changes, runtime change, policy
`FilterCheck`, and a mix task (`ash_state_machine.install`, 75 lines).

**Verdict: the minimum viable extension.** One section, no new resources, one attribute,
one preparation.

### 5.2 AshArchival 2.0.3 — 430 lines total, essentially all relevant

**DSL** (`ash_archival/lib/ash_archival/resource/resource.ex:6-70`): one section `archive`
with pure options — `attribute` (default `:archived_at`), `attribute_type`,
`base_filter?`, `exclude_read_actions`, `exclude_destroy_actions`, `archive_related`,
`archive_related_authorize?`, and one of the most interesting schema types in the codebase:

```elixir
archive_related_arguments: [
  type:
    {:spark_function_behaviour, AshArchival.ArchiveRelatedArguments,
     {AshArchival.ArchiveRelatedArguments.Function, 2}},
  ...
]
```

**One transformer**, `SetupArchival` (91 lines,
`ash_archival/lib/ash_archival/resource/transformers/setup_archival.ex`), which does three
things and bails out entirely if the resource is embedded:

1. `add_archived_at` — `Ash.Resource.Builder.add_new_attribute(… public?: false, allow_nil?: true)`
2. `update_destroy_actions` — for every `destroy` action not excluded, uses
   `Transformer.build_entity(Ash.Resource.Dsl, [:actions, :destroy], :change, change: …)`
   **twice** (to set the timestamp, and to archive related), flips `soft?: true`, and
   `Transformer.replace_entity` with a custom matcher `&(&1.name == destroy_action.name)`
3. `add_preparation` — adds `AshArchival.Resource.Preparations.FilterArchived`

Ordering, exactly as written in the source (`setup_archival.ex:10-17`, `:32-36`):

```elixir
@after_transformers [
  Ash.Resource.Transformers.ValidatePrimaryActions
]

@before_transformers [
  Ash.Resource.Transformers.DefaultAccept,
  Ash.Resource.Transformers.SetTypes
]

def after?(transformer) when transformer in @after_transformers, do: true
def after?(_), do: false

def before?(transformer) when transformer in @before_transformers, do: true
def before?(_), do: false
```

⚠️ Two of those three module names **do not exist** in Ash 3.33.11: `grep -rn
"SetTypes\|ValidatePrimaryActions" ash/lib` finds nothing outside this file. Only the
`DefaultAccept` entry is live. Because `before?/1` and `after?/1` matching a non-existent
module simply returns `false`, the stale assertions are **silently dead code** — no warning,
no error.

**Runtime**: `Changes.ArchiveRelated` (187 lines), `Preparations.FilterArchived` (21),
`ArchiveRelatedArguments.Function` (19). **No verifiers at all** — AshArchival trusts its
options and the transformer raises `DslError` directly. It also ships an 8-line Info module
(`ash_archival/lib/ash_archival/resource/info.ex`) and bails out of `transform/1` entirely
for embedded resources (`setup_archival.ex:23-29`).

**Extension points used**: section, transformer ×1, builder ×3 (`add_new_attribute`,
`build_entity` for changes, `add_preparation`), runtime change, runtime preparation,
`{:spark_function_behaviour, …}` option type.

### 5.3 AshPaperTrail 0.7.0 — 3,827 lines total, ~3,300 relevant

The most ambitious case study: it **generates an entire second resource at compile time** and
registers a domain extension too.

**Resource DSL** (`ash_paper_trail/lib/resource/resource.ex:50-224`): one section
`paper_trail` with ~25 options and 2 entities — `belongs_to_actor` and `metadata` — the
latter with `transform: {Ash.Type, :set_type_transformation, []}`. Registered at `:226-238`
with 6 transformers and 1 verifier.

**Transformers** (`ash_paper_trail/lib/resource/transformers/`)

| Module | Lines | Mutates |
|---|---|---|
| `ValidateBelongsToActor` | 24 | validates the `belongs_to_actor` config |
| `RelateVersionResource` | 105 | declares `before?(SetRelationshipSource) -> true` **and** `after?(_) -> true` (`relate_version_resource.ex:29-32`) — so by the pairwise-conflict rule of §2.5 the `before?` is **dead**: the edge to `SetRelationshipSource` is dropped, but every other pair still gets an edge from `after?(_) -> true`, so it still runs after every other transformer. It builds a `has_many` to the version resource with a key filter and `Transformer.add_entity([:relationships], …)` |
| `AddTemporalInlineAttributes` | 188 | in `:temporal_inline` mode, mutates five different things — see below |
| `SetOperationId` | 70 | `after?(SetPrimaryActions)`, `after?(ResolvePipelines)`; prepends a change to every non-read action and a global preparation. Comment: *"Default actions are added by `SetPrimaryActions`, and pipelines are expanded in place by `ResolvePipelines`, so both must happen first for our change to stay at the front."* |
| `CreateVersionResource` | 647 | **generates a whole new module** (see below) |
| `VersionOnChange` | 28 | `Transformer.build_entity(Ash.Resource.Dsl, [:changes], :change, change: AshPaperTrail.Resource.Changes.CreateNewVersion, on: [:update, :create, :destroy])` then `add_entity([:changes], change, type: :append or :prepend)` depending on mode |

**`AddTemporalInlineAttributes` read in full** (`add_temporal_inline_attributes.ex`, 188
lines) is the most instructive transformer in this study, because it is the only one that
**writes into another package's DSL section**. In `:temporal_inline` mode it:

1. builds and adds attributes `version_action_type` (constrained to
   `one_of: [:create, :update]`), optionally `version_action_name`, `version_action_inputs`
   and `changes` (whose `sensitive?` is derived from whether *any* non-ignored source
   attribute is sensitive), the configured operation-id field, and every `metadata` entity —
   all with `writable?: false, allow_nil?: true` (`:36-95`);
2. adds a `belongs_to` **relationship** per `belongs_to_actor`, with `temporal_keys` set and
   `source` set by hand (`:97-136`);
3. **adds a `reference` entity into a foreign extension's section** —
   AshPostgres `[:postgres, :references]` or AshSqlite `[:sqlite, :references]`, selected by
   hard-coded module-name matching on the data layer (`:171-175`), then written with
   `Transformer.build_entity(extension, path, :reference, …)` + `add_entity` (`:140-169`).
   No `dsl_patch` is involved, and the data-layer module names are compile-time constants;
4. declares `before?(Ash.Resource.Transformers.BelongsToAttribute)` and
   `before?(SetRelationshipSource)` so core generates the foreign-key attribute *after*
   (`:22-24`);
5. returns a `DslError` with path `[:paper_trail, :mode]` on any name conflict
   (`:177-187`).

Point 3 is an extension point the catalogue in §9 had missed entirely: **an extension can
construct an entity belonging to a different extension and insert it**, using
`Transformer.build_entity/4` with the other extension as the first argument. It is more
powerful than `dsl_patches` (which can only add *declared* entities) and more fragile
(it hard-codes the other package's section path).

`CreateVersionResource` (647 lines) is the single most interesting file in this study. It
reads the source resource's attributes, mirrors constraints, picks a data layer, builds a
`postgres { table … repo … migrate? false }` / `sqlite { … }` / ETS block as **quoted AST**,
and then calls `Module.create/3`. There are **two** generators and the file is easy to
misread because the definitions are not in citation order:

- `create_inline_version_resource/1`, defined at `:28`, builds a read-only, non-temporal
  view over the resource's own table; its `Module.create` is at `:165`.
- `create_version_resource/1`, defined at `:227`, builds the separate version resource; its
  `Module.create` is at `:367`.

The generated body looks like this (`create_version_resource.ex:367-375` onward):

```elixir
Module.create(
  version_module,
  quote do
    use Ash.Resource,
            unquote(
              version_extensions
              |> Keyword.put(:data_layer, data_layer)
              |> Keyword.put(:domain, Ash.Resource.Info.domain(dsl_state))
              |> Keyword.put(:validate_domain_inclusion?, false)
            )

    def resource_version?, do: true
    def version_source_resource, do: unquote(module)

    unquote(data_layer_section)
    unquote(multitenancy)
    attributes do … end
    actions do defaults([:read]) end
    relationships do … end
  end,
  Macro.Env.location(__ENV__)
)
```

The file ends with `def after?(_), do: true` (`:646`) so it runs after everything else.

**Verifier**: `ValidateTemporalInline` (101 lines).

**Domain extension** (`ash_paper_trail/lib/domain/domain.ex`): a second
`Spark.Dsl.Extension` with its own `paper_trail` section (`include_versions?`) and one
transformer, `AllowResourceVersions` (48 lines), which either adds every version resource
into the domain's `[:resources]` section, or replaces the `[:resources] :allow` option with
`{AshPaperTrail, :allow_resource_versions, [existing_mfa]}` — a *runtime* allow callback.

⚠️ Note what that transformer does on the way: it calls `Spark.extensions(resource)` and
`AshPaperTrail.Resource.Info.version_resource?(resource)` on **other, separately compiled
modules** from inside a transformer
(`ash_paper_trail/lib/domain/transformers/allow_resource_versions.ex:16-20`). That is a
compile-time cross-module dependency of exactly the kind §8.1 discusses — and it is the
price of a *domain* extension reaching into *resource* extensions.

**Runtime**: `Changes.CreateNewVersion` (666 lines), `Changes.SetOperationId` (46),
`Preparations.SetOperationId` (28), plus ~1,066 lines of `change_builders/` implementing the
four `change_tracking_mode`s (`:snapshot`, `:changes_only`, `:full_diff`, `:previous_values`).

**Extension points used**: resource section + 2 entities, 6 transformers, 1 verifier, domain
section, domain transformer, `Module.create/3` (new resource), `build_entity` for changes,
preparations **and for another extension's `reference` entities**, `add_entity` into
`[:relationships]` and `[:changes]`, `replace_entity` on actions, `persist`, an
`Info` module (216 lines), `no_depend_modules` on an entity (`resource.ex:26`), and a
`version_extensions` option that injects further extensions into the *generated* resource.

### 5.4 AshOban 0.9.0 — 5,196 lines, the "biggest transformer" case

**DSL** (`ash_oban/lib/ash_oban.ex`, 1,617 lines): a single top-level section `oban`
(`:700-777`) with nested sections `triggers` (`:684`) and `scheduled_actions` (`:669`,
which itself holds a `schedule` entity at `:549`), plus a `:chunks` entity (`:125`) and a
`:trigger` entity (`:185`). Registered at `:801-813` with 3 transformers, 3 verifiers,
`imports: [AshOban.Changes.BuiltinChanges]`.

**Transformers**

| Module | Lines | What it does |
|---|---|---|
| `SetDefaults` | 220 | `after?(Ash.Resource.Transformers.SetPrimaryActions)`, `before?(DefineSchedulers)`; defaults the domain from the resource, defaults trigger/scheduled-action fields, validates global uniqueness of names |
| `DefineSchedulers` | **1,715** | for every trigger, rewrites the entity with generated worker/scheduler module names, creates the worker synchronously and the scheduler asynchronously; generates a chunk worker for Oban Pro |
| `DefineActionWorkers` | 174 | for every scheduled action, generates a worker module and rewrites the entity's `worker:` field; also `def after?(_), do: true` |

Both module-generating transformers declare `def after?(_), do: true` — "I run after
everything" (`define_schedulers.ex:12`, `define_action_workers.ex:12`) — and both **mutate
the DSL**: `Transformer.replace_entity([:oban, :triggers], …)` fills in the `scheduler:` and
`worker:` module names on every trigger (`define_schedulers.ex:30-35`), and
`DefineActionWorkers` does the same for `scheduled_actions` (`:26-29`).

**`DefineSchedulers` read in full** (1,715 lines) turns out to be four things, and the
module-size number hides all of them:

1. **DSL mutation** as above, plus: the **worker** is created synchronously with
   `Module.create` (`:28`); only the **scheduler** goes through
   `Transformer.async_compile/2` (`:36-43`, awaited later by §2.3's
   `await_persisted_compile_funs/1`).
2. **Three generators, not two**: the scheduler (`:57-294`), a standard worker
   (`:433-697`), and an Oban Pro **chunk worker** when `trigger.chunks` is set
   (`:306-430`, using `Oban.Pro.Workers.Chunk`).
3. **Compile-time reads of mutable global state.** `AshOban.Info.pro?()` is
   `Application.get_env(:ash_oban, :pro?) || false` (`ash_oban/lib/info.ex:11-13`), read at
   `:61` and `:435`; the generated code then switches between `Oban.Worker`/`perform` and
   `Oban.Pro.Worker`/`process` (`:206-213`, `:438-439`). Because this is `get_env` and not
   `compile_env`, changing `:pro?` does **not** trigger recompilation. It also reads
   data-layer **capabilities** at compile time — `Ash.DataLayer.data_layer_can?(dsl,
   :transact)` (`:446`) and `{:lock, :for_update}` (`:471`) — to decide whether to emit
   transaction and row-locking code at all (`:479-497`). *The recompilation consequence is
   read from Elixir's semantics, not observed.*
4. **Validation inside the transformer.** It raises `DslError` directly when the configured
   `on_error` action does not exist (`:448-457`, path
   `[:oban, :triggers, trigger.name, :on_error]`) rather than deferring to a verifier.

The bulk of the file is generated error handling — `handle_error/6` (`:699-1008`: on the
final attempt, call the `on_error` action via `bulk_update!`/`bulk_destroy!` when atomic,
otherwise re-read the record and run the action) — and the work functions `work/8` and
`work_chunk/7` (`:1026-1715`), which invoke the trigger action, generic actions included
(`Ash.run_action!`, `:1068-1081`).

**Verifiers**: `VerifyModuleNames` (82), `VerifyUseTenantFromRecord` (53), `VerifyChunks` (74).

**Runtime**: `Changes.RunObanTrigger` (78), `Changes.BuiltinChanges` (11),
`Check.AshObanInteraction` (31), plus `Test` helpers (384) and an `Igniter` module (101).

**Extension points used**: section, entities, 3 transformers (one of which is 1.7 kLOC of
module generation), 3 verifiers, `async_compile/2`, `imports:`, runtime change, runtime
check, Igniter installer + 3 mix tasks.

### 5.5 AshEvents 0.8.2 — brief, as a fifth data point

`ash_events/lib/events/events.ex:75-84` — one `events` section, one transformer
(`WrapActions`, 286 lines, `after?(_) -> true`) that **rewrites every eligible action into a
wrapper action** (delegating to the original), and 4 verifiers. Plus a second extension,
`AshEvents.EventLog` (`event_log.ex`, 181 lines) with 2 transformers (`AddActions`,
`AddAttributes`) and 8 verifiers. EventLog is **not** self-generating: there is no
`Module.create` anywhere in `ash_events/lib` — it is an extension the user applies to a
resource they write themselves, and its transformers add actions and attributes to *that*
resource (`ash_events/lib/event_log/event_log.ex:152-155`).

---

## 6. Tooling an extension gets for free

| Tool | Where | What it does |
|---|---|---|
| Auto `@moduledoc` Options | `spark/lib/spark/dsl.ex:190-224` | `Spark.Options.docs/1` renders the whole option schema into a `### Options` section of the DSL host's `@moduledoc`; `opts_to_document` limits it |
| Autocomplete / hover docs | `spark/lib/spark/elixir_sense/plugin.ex:1-100` | Spark registers an ElixirSense / ElixirLS `Plugin` + `GenericReducer`; it finds DSLs by scanning Spark modules in deps, so "it just works" inside a DSL module. `documentation/how_to/setup-autocomplete.md` states it **only works with ElixirLS**. |
| `Spark.Formatter` | `spark/lib/spark/formatter.ex:1-60` | Mix formatter plugin. Alphabetically sorts top-level sections by default, or reads `config :spark, :formatter, "Ash.Resource" => [section_order: [...], type: …, extensions: [...]]`. Also `remove_parens?`. |
| `mix spark.formatter` | `spark/lib/mix/tasks/spark.formatter.ex:1-50` | Maintains `spark_locals_without_parens:` in `.formatter.exs` from `extension.sections()` **and** `extension.dsl_patches()` |
| `mix spark.cheat_sheets` | `spark/lib/mix/tasks/spark.cheat_sheets.ex` | Generates a Markdown cheat sheet per extension via `Spark.CheatSheet.cheat_sheet/1`; has `--check` for CI |
| `mix spark.cheat_sheets_in_search` | `spark/lib/mix/tasks/spark.cheat_sheets_in_search.ex:11-26` | **Deprecated** — warns and points at `Spark.Docs.search_data_for/1`, then still runs (`Mix.Task.run("compile")` and the old logic follow) |
| `Spark.CheatSheet` | `spark/lib/spark/cheat_sheet.ex:1-50` | Renders sections, entities, options, required markers and the extension's own `@moduledoc` |
| `Spark.InfoGenerator` | `spark/lib/spark/info_generator.ex:25-46` | Generates typed, documented introspection functions |
| `mix spark.install` | `spark/lib/mix/tasks/spark.install.ex` | Adds `Spark.Formatter` to `plugins:`, adds `sourceror` dep, writes `config :spark, :formatter, remove_parens?: true` |
| `Spark.Test` | `spark/lib/spark/test.ex` | Turns verifier output into structured, assertable values instead of stderr, **because verifier errors are swallowed into warnings by the framework** (§2.4): `dsl_errors/1`, `assert_dsl_error/2`, `refute_dsl_errors/1`, `dsl_warnings/1`, `assert_dsl_warning/2` (`verifier.ex:26-43` documents them). Implemented via a `Process.get({Spark.Dsl, :test_collector})` hook in `dsl.ex:473-513` and `test.ex:341-357` (`__drain_errors__/1`, `__drain_warnings__/1`) |
| `mix ash.gen.*` | `ash/lib/mix/tasks/gen/` | Resource/domain generators (not extension-owned, but extensions hook into them — see §7) |
| `mix spark.replace_doc_links` | `spark/lib/mix/tasks/spark.replace_doc_links.ex` | Rewrites DSL doc links for HexDocs |

The `describe`, `examples`, `snippet`, `links`, `hide` and `deprecations` fields on
`Section`/`Entity` are *not* decoration: they are the single source for the cheat sheet, the
autocomplete hover text and the generated docs. Writing them is the price of the free
tooling.

---

## 7. Igniter and code generation

### 7.1 What Igniter is

Igniter 0.8.4 (`igniter/lib/igniter.ex`, ~2,200 lines) is a library for **AST-aware
modification of an Elixir project**. Its central type is `Igniter.t()`, a struct (`defstruct`
at `igniter/lib/igniter.ex:33`) holding pending file changes plus `issues`, `warnings`,
`notices` and a `tasks` queue.

Two design choices matter:

- It works on **zippers** (`Sourceror.Zipper`) — cursors into an AST — so edits are
  structural, not textual. `update_elixir_file/4` (`:558`), `update_file/4` (`:618`),
  `include_or_create_file/4` (`:717`) all take `zipper_updater` functions.
- The unit of work is an **`Igniter.Mix.Task`**: a module with `info/2` returning an
  `%Igniter.Mix.Task.Info{}` (argument schema, `adds_deps`, `installs`, `group`) and
  `igniter/1` returning a modified `Igniter.t()`. All three of AshOban's task modules
  follow this (`ash_oban/lib/mix/tasks/ash_oban.install.ex:27-45`).

Installers are **not** found via a behaviour. `mix igniter.install <pkg>`
(`igniter/lib/mix/tasks/igniter.install.ex:9-90`) resolves the dep, adds it to `mix.exs`,
recompiles, and then runs the installed packages' `Igniter.Mix.Task` modules. Supports
`--dry-run`, `--yes`, `--skip-installed`, `--only <env>`, and passes remaining `argv` through
to the package's installer task. The callback a task implements is **`igniter/1`** (optionally
`igniter/2`), *not* `install/1` (`igniter/lib/mix/task.ex:32-36`) — the `install` name in
Ash's world means something else entirely (§7.3). `Spark.Igniter`
(`spark/lib/spark/igniter.ex:1-30`) adds DSL-aware helpers, e.g.
`prepend_to_section_order/3` which writes into `.formatter.exs`.

### 7.2 `mix ash.codegen`

`ash/lib/mix/tasks/ash.codegen.ex:5-90`. It compiles the project, collects extensions via
`Ash.Mix.Tasks.Helpers.extensions!/1`, and for each one:

```elixir
|> Enum.map(fn extension ->
  if function_exported?(extension, :codegen, 1) do
    extension_name =
      if function_exported?(extension, :name, 0) do
        extension.name()
      else
        inspect(extension)
      end

    Mix.shell().info("Running codegen for #{extension_name}...")

    argv =
      if "--name" in argv do
        argv
      else
        argv ++ ["--name", name]
      end

    extension.codegen(argv)
  end
end)
```

(Verbatim body, `ash/lib/mix/tasks/ash.codegen.ex:60-79`; the `argv` passed in is piped in
at `:58` and the `Enum.map` closes at `:79`. Note that `--name` is appended **only** when it
is not already present.)

**`codegen/1` is an optional callback of the `Ash.Extension` behaviour, invoked
duck-typed.** Confirmed by reading the task and by
`AshPostgres`, which implements `def codegen(args)` and `def setup(args)` as plain public
functions (`ash_postgres/lib/data_layer.ex:649-652`, `:654-670`) — not `@impl` anything.

`Ash.Mix.Tasks.Helpers.extensions!/2` (`ash/lib/mix/tasks/helpers.ex:12-49`) is itself
interesting for compile cost: it walks `Mix.Project.deps_tree()`, filters to apps that
depend on `:spark` or `:ash`, and calls `Ash.Info.defined_extensions/1` in parallel. The
comment at `helpers.ex:70-76` says the naive version is *"actually a surprisingly expensive
thing to do"*.

### 7.3 `Ash.Extension` — the extension-side task callbacks

This is the part my first pass got wrong, so it is worth stating precisely.

`Ash.Extension` (`ash/lib/ash/extension.ex:5-45`) **is a behaviour**, and it declares
**seven** callbacks, **all of them optional**
(`ash/lib/ash/extension.ex:21-44`):

```elixir
@callback migrate(argv) :: term
@callback reset(argv) :: term
@callback rollback(argv) :: term
@callback setup(argv) :: term
@callback tear_down(argv) :: term
@callback codegen(argv) :: term

@callback install(
            igniter,
            module :: module(),
            type :: Ash.Resource.t() | Ash.Domain.t(),
            location :: String.t(),
            argv
          ) :: igniter

@optional_callbacks [
  migrate: 1,
  reset: 1,
  rollback: 1,
  setup: 1,
  tear_down: 1,
  codegen: 1,
  install: 5
]
```

(Verbatim, `ash/lib/ash/extension.ex:21-44`, de-indented by two spaces to sit outside the
`defmodule`.)

Its own moduledoc is candid about the split: *"It is not necessary to adopt this behavior, but
it is recommended to do so if you want to define these functions on your extension. These
functions are invoked when their relevant Mix task is run."* (`extension.ex:5-10`).

So both things are true, and they are not in tension:

- The **mix tasks invoke the callbacks duck-typed**, with `function_exported?/3` guards;
- a **behaviour declares them as optional callbacks**, so Dialyzer and editor tooling know
  they may exist.

The nuance worth knowing: **no module in any of the clones declares
`@behaviour Ash.Extension`** (`grep -rn "@behaviour Ash.Extension"` returns nothing). The
behaviour is advisory only; nothing enforces adoption.

Which mix task calls what, and where:

| Task | Calls | Guard | Source |
|---|---|---|---|
| `mix ash.codegen` | `extension.codegen(argv)` | `function_exported?(extension, :codegen, 1)` | `ash/lib/mix/tasks/ash.codegen.ex:61-76` |
| `mix ash.migrate` | `extension.migrate(argv)` | `function_exported?(extension, :migrate, 1)` | `ash/lib/mix/tasks/ash.migrate.ex:19-28` |
| `mix ash.rollback` | `extension.rollback(argv)` | `function_exported?(3)` | `ash/lib/mix/tasks/ash.rollback.ex:19-29` |
| `mix ash.tear_down` | `extension.tear_down(argv)` | `function_exported?(3)` | `ash/lib/mix/tasks/ash.tear_down.ex:19-28` |
| `mix ash.setup` | `extension.setup(argv)` | `function_exported?(3)` | `ash/lib/mix/tasks/ash.setup.ex:52-63` |
| `mix ash.reset` | *nothing* | — | `ash/lib/mix/tasks/ash.reset.ex:15-16` just runs `ash.tear_down` then `ash.setup` |
| `mix ash.extend` | `extension.install(igniter, module, kind, path, argv)` | `function_exported?(extension, :install, 5)` | `ash/lib/mix/tasks/ash.extend.ex:178-180` |

Two consequences:

- **`reset/1` is declared but never invoked** by any task in the clones — `mix ash.reset`
  is defined as tear-down + setup. The callback is vestigial.
- **`install/5` is the real extension hook for codegen-time project surgery**, and it is
  *not* the Igniter installer of §7.1. `mix ash.extend <module> <ext>` builds an Igniter
  function that, when the extension exports `install/5`, calls it and then adds the
  extension to the resource; otherwise it just adds the extension
  (`ash.extend.ex:178-186`). `mix ash.gen.resource --extend …` composes `ash.extend`
  (`ash/lib/mix/tasks/gen/ash.gen.resource.ex:202-207`), so **extensions do participate in
  resource generation**, which my first pass wrongly said they did not.

Implementers of `install/5` in the clones: `AshPostgres.DataLayer`
(`ash_postgres/lib/data_layer.ex:4854`), `AshSqlite.DataLayer`, `AshGraphql.Resource` and
`AshGraphql.Domain`, `AshJsonApi.Resource` and `AshJsonApi.Domain`, and
`Ash.Policy.Authorizer`.

AshPostgres as the reference implementation of the whole family
(`ash_postgres/lib/data_layer.ex`): `migrate/1` at `:459`, `rollback/1` at `:464`,
`codegen/1` at `:649`, `setup/1` at `:654`, `tear_down/1` at `:671`, `install/5` at `:4854`.
Each is a thin wrapper over its own mix task — e.g. `codegen/1` re-enables and runs
`ash_postgres.generate_migrations` (`:649-652`), and `setup/1` runs `ash_postgres.create`
then `ash_postgres.migrate` (`:654-670`). **There is no `migrate` magic in Spark**; the
lifecycle is entirely convention plus a behaviour with all-optional callbacks.

`Ash.Mix.Tasks.Helpers.extensions!/2` (`ash/lib/mix/tasks/helpers.ex:12-49`) is itself
interesting for compile cost: it walks `Mix.Project.deps_tree()`, filters to apps that
depend on `:spark` or `:ash`, and calls `Ash.Info.defined_extensions/1` in parallel. The
comment at `helpers.ex:70-76` says the naive version is *"actually a surprisingly expensive
thing to do"*.

### 7.4 `mix ash.gen.*`

Full set of generators in `ash/lib/mix/tasks/gen/`: `ash.gen.base_resource`,
`ash.gen.change`, `ash.gen.custom_expression`, `ash.gen.domain`, `ash.gen.enum`,
`ash.gen.gettext`, `ash.gen.preparation`, `ash.gen.resource`, `ash.gen.validation`. Plus
`mix ash.install` (`ash/lib/mix/tasks/install/ash.install.ex`) and
`mix ash.patch.extend` (`ash/lib/mix/tasks/patch/ash.patch.extend.ex`).

These are Ash's own Igniter tasks. The extension-aware path is `--extend`, which composes
`ash.extend` → `install/5` (§7.3). AshOban ships three extra tasks of its own
(`ash_oban.install`, `ash_oban.upgrade`, `ash_oban.set_default_module_names`); AshPaperTrail
ships none — `ash_paper_trail/lib` contains no `mix/tasks` directory.

---

## 8. Known pain points, with evidence

### 8.1 Compile-time dependencies are over-approximated and hard to reason about

Spark issue **#290**, "Track DSL module dependencies at compile-time consumption sites"
(OPEN, opened 2026-08-24, https://github.com/ash-project/spark/issues/290) is the clearest
statement of the problem by an outside contributor:

> "Spark currently determines module dependencies where module-valued DSL fields are declared.
> Unclassified module references create compile dependencies, while extension authors can opt
> fields out through `no_depend_modules`. […] The declaration and the code that determines the
> actual dependency semantics are separated, so they can become inconsistent as an extension
> evolves."

and

> "The conservative default avoids stale compile-time state, but it can also create broad
> incremental recompilation paths for modules that are never inspected during compilation."

The proposed fix is to move dependency ownership from declarations to the transformers and
verifiers that actually consume module metadata, and to eventually remove
`no_depend_modules` entirely. Related: #289 (2026-08-21, closed) on dependency policies for
nested module references, which #290 says makes the declaration-site model harder still.

The same field appears in `Spark.Dsl.Entity` (`entity.ex:87`) and `Spark.Dsl.Section`
(`section.ex:44`); AshPaperTrail uses it on its `belongs_to_actor` entity
(`ash_paper_trail/lib/resource/resource.ex:26`).

### 8.2 Compile-time deadlocks (the sharpest failure mode)

Ash issue **#2670**, "Compilation deadlock in policy checks due to new `init/1` callback in
3.23.1" (opened **and closed 2026-04-09**, 30 minutes apart; opened by joshprice, closed at
the same timestamp as zachdaniel's comment,
https://github.com/ash-project/ash/issues/2670). Adding an `init/1` call to
`Ash.Policy.Check.transform/1` made an entity's *build-time* `transform` require the
referenced check module to be fully compiled:

```
** (CompileError) deadlocked waiting on module MyApp.Policy.Checks.MyCustomCheck
    (ash 3.23.1) lib/ash/policy/check.ex:26: Ash.Policy.Check.transform/1
    (spark 2.6.1) lib/spark/dsl/entity.ex:305: Spark.Dsl.Entity.build/5
    (spark 2.6.1) lib/spark/dsl/extension/entity.ex:102: …Entity.handle/6
```

(Abridged from the trace in https://github.com/ash-project/ash/issues/2670: the original
also contains `Ash.BehaviourHelpers.call_and_validate_return/5`,
`…ForbidUnless.__build__/5` and `lib/my_app/some_resource.ex:10: (module)` lines, dropped
here for length.)

The cause was **the new `init/1` callback being called at compile time**, not validation as
such. The maintainer's response (zachdaniel, 2026-04-09, the only comment on the issue) is
verbatim:

> "Its unfortunate, but the best thing to do here is to fix it on the caller end not to have a
> compile time dependency on the calling resource. In newer versions of Elixir this will not
> be an issue AFAIK because pattern matching in function heads will not induce compile time
> dependencies. You can refactor this:
>
>     def foo(%Something{}) do
>
>     end
>
> to
>
>     def foo(%{__struct__: Something}) do
>
>     end
>
> or
>
>     def foo(something) do
>       somethign = %Something{}
>     end
>
> etc.
>
> Not ideal but the `init` callback being done at compile time is much better, and its the
> same way we do Ash.Type initialization. We can't do it for changes/preparations/queries and
> its a categorically worse experience 😄"
> — zachdaniel, 2026-04-09,
> https://github.com/ash-project/ash/issues/2670#issuecomment-4216132881 (the `somethign`
> typo is in the original)

What this establishes, and what it does not: it establishes that a compile-time call from
inside a Spark entity `transform/1` is a deadlock hazard, and that the maintainer's chosen
fix was **caller-side** (restructure the *referencing* code to avoid the dependency) rather
than moving the call to a different hook. Verifiers are not mentioned anywhere in the issue
or the comment. The trailing remark does say compile-time initialization is the *better*
trade-off and is used for `Ash.Type` initialization, so the lesson is closer to "be
deliberate about where you call across module boundaries" than to "defer validation".

### 8.3 Compilation cycles and compile time

- Ash issue **#2267**, "Initiative: Reduce compilation time" (OPEN, 2025-08-09,
  https://github.com/ash-project/ash/issues/2267): *"Ash currently has 187 compilation cycles,
  which causes slower compilation time and most of the project to recompile for even small
  code changes."* The current stats comment (chazwatkins) reports 185 cycles, 506 compile
  dependency edges, and names `lib/ash/resource/dsl.ex` as having the most outgoing
  dependencies (74). Note that `Ash.Resource.Dsl` is the module that lists all 20
  transformers and 27 verifiers.
- Spark issue **#86**, "Performance issues" (opened 2024-04-18, **closed 2024-06-26**,
  https://github.com/ash-project/spark/issues/86): a ~1k-line **SeedFactory schema** — a
  plain Spark DSL, *not* an Ash resource — took **30 s** to compile; a smaller repro took
  ~5 s. **Resolved.** The maintainer closed it with: "This issue has been resolved 'for the
  most part'. It could be faster, but we've seen an improvement on the order of 40s -> 6s to
  compile any given module." A bounty was funded against it
  (https://until.dev/bounty/ash-project/spark/86). His diagnosis in the thread is worth
  keeping: "the bulk of the time is waiting on the compiler for some reason (its sleeping in
  a genserver loop at compile time) […] Some of the things that spark does are practically
  pathologically strange under the hood".
- The `eval/3` escape hatch (`spark/lib/spark/dsl/transformer.ex:104-132`) is unquoted code
  executed in the DSL module — architecturally the same thing `Module.create/3` does, and
  used at scale by AshPaperTrail and AshOban.

### 8.4 Transformer ordering is implicit, and the "obvious" pattern is a trap

Ash's own guide says so (`ash/documentation/topics/advanced/writing-extensions.md`,
"Ordering of transformers"):

> "As of the writing of this guide, the best way to look at the list of transformers is to
> look at the source of the extension, and see what transformers it has and what they do."

And the guide then teaches the `after?(_) -> true` + `before?(X)` pattern that §2.5 shows is
**silently discarded** whenever the two collide. The four concrete casualties:

| Victim | Assertion | Effect |
|---|---|---|
| `AshArchival…SetupArchival` | `before?(DefaultAccept)`, `before?(SetTypes)`, `after?(ValidatePrimaryActions)` (`setup_archival.ex:10-17`) | `SetTypes` and `ValidatePrimaryActions` do not exist in Ash 3.33.11 — dead, no warning; only `DefaultAccept` is live |
| `AshPaperTrail…RelateVersionResource` | `before?(SetRelationshipSource)` + `after?(_) -> true` (`relate_version_resource.ex:29-32`) | the `before?` is dropped by the pairwise-conflict rule |
| Ash core itself | `SetPrimaryActions.after?(DefaultAccept)` (`set_primary_actions.ex:24`) vs `DefaultAccept.after?(SetPrimaryActions)` (`default_accept.ex:190`) | the edge between them is dropped |
| `AshStateMachine…AddState` | reads a value `SetDefaultInitialState` sets, declares no ordering to it | correct only by digraph tie-break luck |

And a cycle is broken with no error, no warning, and the broken vertex moved to the **front**
of the result (§2.5). `Spark.Test` does not cover ordering at all.

### 8.5 Error message quality

- Spark issue **#239**, "Validate Error Message should be improve" (opened 2025-11-11,
  **closed 2026-03-01**, https://github.com/ash-project/spark/issues/239): the schema says
  `bar` is a `:string`, the error says *"invalid value for :bar option: expected integer, got:
  123"* — the wrong type name.
- The Spark tutorial still carries an explicit admission
  (`get-started-with-spark.md`, after the error example): *"In the future we will add support
  for including location information in these errors, by allowing you to look up where a given
  entity/option was defined in the source code, so the user gets nice squiggly lines in their
  editor."* Section-level `location` support does exist now (`dsl_error.ex:47-57`), and
  entity-level location requires `__spark_metadata__` — whose absence is a **deprecation
  warning at extension-compile time** (`extension.ex:2243-2262`), not just an `IO.warn` at
  read time.
- A duplicate `use Ash.Domain` in one module produced "def can?/3 defines defaults multiple
  times" pointing at the `defmodule` line, which the reporter found misleading; the
  maintainer agreed it "would be relatively easy to detect"
  (At7heb and zachdaniel, https://forum.elixirforum.com/t/misleading-error-message-def-can-3-defines-defaults-multiple-times/66875,
  2024-10-20).
- Spark issue **#38** (2023-06-01, **closed 2024-03-19**): "Transformer behaviour error add
  irrelevant stacktrace" — the machinery had to grow a custom `Stacktrace` struct to suppress
  noisy BEAM traces (`dsl_error.ex:16-23`).

### 8.6 Generated module names

Spark issue **#103** (opened 2024-06-22, **closed 2025-06-10**,
https://github.com/ash-project/spark/issues/103): deeply nested DSLs generate module names
like
`Elixir.Wayfarer.Dsl.Wayfarer.Config.Wayfarer.Targets.Targets....HealthChecks.HealthChecks`,
producing `** (File.Error) could not write to file "…/ebin/Elixir.Wayfarer....beam": file
name too long` on filesystems with a short name limit. Issue **#259** (opened 2026-02-06,
**closed 2026-02-07**, https://github.com/ash-project/spark/issues/259) is a different
flavour of the same problem: two sibling sections with same-named child sections produce the
same generated module name, silently shadowing the first (`warning: redefining module
Repro.Extension.Settings`).

### 8.7 Editor support is single-vendor — and now actively broken

`documentation/how_to/setup-autocomplete.md`: *"Autocomplete is enhanced by a plugin to
ElixirSense, and therefore it only works for those who are using ElixirLS."* The plugin
registers against three APIs (`Spark.ElixirSense.Plugin`:
`ElixirSense.Plugin`, `ElixirSense.Providers.Plugin`, `ElixirLS.LanguageServer.Plugin` —
`spark/lib/spark/elixir_sense/plugin.ex:14-45`), and issue **#94** (opened 2024-05-12,
**closed 2024-05-14**, https://github.com/ash-project/spark/issues/94) is "Plugin doesn't
work with latest elixir-ls" — the plugin breaks whenever the language server changes shape.
Ash repeats the caveat in its own docs
(`documentation/topics/development/development-utilities.md:23`): *"it only works with
ElixirLS (not other language server tools)."*

**This is now a live regression, not just historical.** Expert is the new official Elixir
LSP. FlyingNoodle opened the thread (2026-02-27) reporting no Ash completions in expert
0.1.0.rc5; zachdaniel replied the same day: *"AFAIK the spark extension that we wrote for
ElixirLS/elixir_sense does not work with expert unfortunately. Currently they have other
priorities WRT the LSP but I will circle back and have a discussion with them on that topic
when the time is right"*. katafrakt (2026-03-01) explains why a fallback is not viable:
*"Expert still uses elixir_sense, but not for completion. It still serves as the fallback
method for 'definition' and 'hover' calls. With completion, however, […]"*.
https://forum.elixirforum.com/t/expert-lsp-compatibility/74451

### 8.8 Fragments and formatter rough edges (all now closed)

- **#193** (2025-06-05, **closed 2025-06-05**, fix commit `30b45a7`): a fragment using an
  extension that has `imports:` does not inherit them, producing undefined-function errors.
- **#29** (2023-04-07, **closed 2024-03-19**): merging fragments overwrites set values with
  defaults.
- **#57** (2023-09-01, **closed 2023-09-04**): extensions could not patch top-level sections
  with new entities.
- **#126** (2025-01-28, **closed 2025-01-29**): `mix spark.formatter` doesn't detect DSL
  patches — fixed; `spark.formatter.ex:35` now passes `extension_mod.dsl_patches()`.
- **#78** (2024-02-29, **closed 2024-02-29**): the formatter "requires explicit compilation
  to work with custom modules".
- **#231** (2025-10-23, **closed 2025-10-30**): `mix format` crashes at umbrella roots with
  `MatchError`.

### 8.9 Writing an extension is under-documented, and the ceiling is "copy core's logic"

Ash's guide says so directly (`ash/documentation/topics/advanced/writing-extensions.md`):

> "`Spark` is still lacking in documentation, unfortunately, as its something that mostly the
> adventurous/power users work with, and they often learn by way of examples, looking at `Ash`
> extensions. We would like to rectify this in the future."

The forum fills in the rest. Five threads, all read directly:

1. **An extension cannot extend a core *default*; you must copy core's transformer.**
   A user wanted to add a field to `default_accept` via an extension. zachdaniel
   (2024-09-23): *"Ah, I see. Unfortunately, the way it's designed is not conducive to that
   change right now. Because we have a single transformer that both sets the 'default default
   accept' and sets the accept on each corresponding action. What you will have to do (not
   ideal, but the only good way to do it), is copy the logic from our core transformer"*, and
   to order with `before?(Ash.Resource.Transformers.DefaultAccept)`.
   https://forum.elixirforum.com/t/how-do-i-set-default-accepts-to-a-resource-through-ash-extension-transformer/66257
   (Note the irony: that `before?` advice is exactly the kind of assertion that can be
   silently dropped, §2.5.)
2. **An extension cannot add an option to another extension's entity** — e.g. `cached? true`
   inside a `read`. zachdaniel (2024-01-12): *"The first one, `cached? true` won't be
   possible with the current DSL extension options (maybe some day, but probably not)"*, and
   recommends studying AshArchival as the template.
   https://forum.elixirforum.com/t/inputs-on-cache-layer-extension-for-read-actions/60933
3. **Builder/transformer authoring friction and misleading errors.** kamaroly (2024-09)
   could not apply `filter:` through `Ash.Resource.Builder.add_new_relationship/5`; the
   error message *"says it requires filter options even if it has been passed"*.
   https://forum.elixirforum.com/t/how-to-extract-a-relationship-into-a-separate-module-for-reuse-in-ash/65890
4. **Learning Spark means reading other people's extensions.** steele232 (2026-03-17) got a
   first DSL working only after *"cloning down ash_graphql to take a closer look at that DSL
   extension and also the Ash DSL (seeing a working example)"*.
   https://forum.elixirforum.com/t/trying-spark-for-the-first-time-and-dsl-doesnt-seem-to-be-recognized/74684
5. **Resources taking over 30 s to compile.** sezaru (2025-08-28):
   https://forum.elixirforum.com/t/strategies-to-make-resources-compile-faster/72265.
   zachdaniel: *"The biggest thing you can do here is to remove as many anonymous functions
   from your resources as possible and extract them into module changes/preparations etc."*
   Asked whether fragments help: *"I've heard that it can yes but I haven't confirmed it
   personally."*

### 8.10 Compile time is dominated by generated-code machinery, not by Spark

Three independent measurements, all from the same reporter (sezaru) or the same
maintainer:

- **Code interfaces dominate.** A resource compiled in **4148 ms** with `code_interface` and
  **533 ms** without; the domain, 3719 ms vs 368 ms
  (https://forum.elixirforum.com/t/using-code-interface-makes-resource-slow-to-compile/73196,
  2025-11-05/06). zachdaniel: *"the code interface logic is not really the greatest macro
  code anyone ever wrote, I wrote it pretty early on and I know a lot more than I did back
  then"*. Fixed in Ash `main` by 2025-11-15: *"should be some pretty significant
  improvements"*; one user reported *"from ~32s to ~9s"*, the reporter *"From 18 seconds in a
  resource to around 6s"*.
- **Incremental recompiles of 8–10 s** in an Ash/Phoenix/Inertia app (joangavelan, 2025-08-15,
  https://forum.elixirforum.com/t/reducing-incremental-compilation-times-in-phoenix-ash-project/72113).
  Replies offer only generic `mix xref graph --format cycles` advice; nobody reaches an
  Ash-specific answer.
- **Ash's own cycle count** (issue #2267, §8.3).

Taken together: the compile-time cost in this ecosystem is dominated by *generated code inside
the user's modules* (code interfaces, module-generating transformers) and by
compile-connected cycles — not by the Spark DSL layer itself. That is the most directly
transferable finding in this section.

---

## 9. Catalogue of extension points

| # | Extension point | Contract (behaviour / struct) | When it runs | What it can change | Example user |
|---|---|---|---|---|---|
| 1 | DSL section | `%Spark.Dsl.Section{}` | compile (declaration) | adds a new builder block to a DSL; opts, nested sections, entities | `AshStateMachine` `:state_machine` (`ash_state_machine.ex:71-107`) |
| 2 | DSL entity | `%Spark.Dsl.Entity{}` + a target struct | compile (declaration) | adds a constructor producing a struct | `AshStateMachine.Transition` (`ash_state_machine.ex:23-49`) |
| 3 | Option schema | `Spark.Options` schema (keyword) | compile (validation) | validates and types an option | `AshArchival` `archive` schema (`ash_archival/.../resource.ex:6-70`) |
| 4 | Entity `transform` | `{Module, :fun, args}` | compile, at entity build | validate/reshape one struct, **can require other modules to be compiled** (deadlock risk, #2670) | `Ash.Resource.Interface.transform` (`ash/lib/ash/domain/dsl.ex:113-115`) |
| 5 | Entity `identifier` | `{:auto, :unique_integer}` or a field name | compile | uniqueness key for `replace_entity/4` | `AshStateMachine.Transition` (`ash_state_machine.ex:27`) |
| 6 | Transformer | `Spark.Dsl.Transformer` behaviour (`transform/1`, `before?/1`, `after?/1`, `after_compile?/0`) | compile, before persisters | read/write **any** section, entity, option, and `:persist` | `AshArchival…SetupArchival` (`ash_archival/.../setup_archival.ex:1-91`) |
| 7 | Persister | same behaviour, declared under `persisters:` | compile, after all transformers | conventionally only `:persist`; caching derived values | `Ash.Resource.Transformers.CacheRelationships` (`ash/lib/ash/resource/dsl.ex:1831`) |
| 8 | Verifier | `Spark.Dsl.Verifier` behaviour (`verify/1`) | **after** module compilation (`@after_verify`) | read-only validation; may reference other Spark modules safely | `Ash.Resource.Verifiers.ValidatePrimaryKey` |
| 9 | `after_compile?` transformer | same as 6 with the flag | after compilation, **after** the verifiers, and **only if no verifier errored** (`dsl.ex:521-523`) | validators written as transformers that need post-compile ordering | 7 modules: `AshGraphql` resource + domain × `{ValidateActions, ValidateCompatibleNames, RequireKeysetForRelayQueries}` (`:12` each) and `AshAuthentication.UserIdentity.Verifier` (`:27`) |
| 10 | `:persist` map | plain map | compile → runtime | arbitrary derived values readable via `get_persisted/3` | `:primary_key`, `:all_state_machine_states` |
| 11 | `Transformer.eval/3` | quoted block + bindings | compile, `Code.eval_quoted` in the module | inject arbitrary functions into the DSL module | documented as "almost never necessary" (`transformer.ex:104-106`) |
| 12 | `Transformer.async_compile/2` | a 0-arity fun | compile, parallel compiler | compile helper modules concurrently | `AshOban…DefineSchedulers` (`ash_oban/lib/transformers/define_schedulers.ex:38-44`) |
| 13 | `dsl_patches` | `%Spark.Dsl.Patch.AddEntity{}` | compile (declaration) | add an entity to *another* extension's section | `Ash.Reactor` (`ash/lib/ash/reactor/reactor.ex:41-59`) |
| 14 | `imports:` on an extension | `[module]` | compile (declaration) | inject shared helper macros into every DSL module that uses the extension | `AshStateMachine` `imports: [AshStateMachine.BuiltinChanges]` (`:129`) |
| 15 | `add_extensions:` | `[module]` | compile | an extension that force-adds other extensions (transitive) | `spark/lib/spark/dsl.ex:180-190` |
| 16 | `module_prefix:` | atom | compile | rename generated section/entity modules to avoid collisions | `spark/lib/spark/dsl/extension.ex:100-110` |
| 17 | `Fragment` | `Spark.Dsl.Fragment` | compile | split one resource's DSL across files; opts merge with a warning on conflict | `spark/lib/spark/dsl/fragment.ex:1-111` |
| 18 | `Builder` | `Spark.Dsl.Builder.defbuilder/2` + `Ash.Resource.Builder` | compile | typed, `{:ok,_}`-aware programmatic construction | `Ash.Resource.Builder.add_new_attribute/4` (`ash/lib/ash/resource/builder.ex:469`) |
| 19 | `Info` module | `Spark.InfoGenerator` or hand-written | runtime read | typed, documented introspection with `!` variants | `AshStateMachine.Info` (`ash_state_machine/lib/info.ex:7`) |
| 20 | `no_depend_modules` | field on Entity/Section | compile (dependency control) | opt a module-valued field out of the compile-time dependency | `ash_paper_trail/lib/resource/resource.ex:26` |
| 21 | Data layer | `Ash.DataLayer` behaviour (~50 callbacks) | runtime | how queries/creates/updates/aggregates actually execute | `AshPostgres.DataLayer` |
| 22 | Authorizer | `Ash.Authorizer` behaviour (12 `@callback`s) | runtime | filter/alter queries and results, field-level policies | `Ash.Policy.Authorizer` |
| 23 | Notifier | `Ash.Notifier` behaviour (3 callbacks) | runtime | observe successful action results | `Ash.Notifier.PubSub` (`ash/lib/ash/notifier/pub_sub/pub_sub.ex:5`) |
| 24 | Resource change | `Ash.Resource.Change` behaviour | runtime, per changeset step | mutate a changeset (`before_action`/`after_action`/`around_action`) | `AshPaperTrail.Resource.Changes.CreateNewVersion` |
| 25 | Preparation | `Ash.Resource.Preparation` behaviour | runtime, before the query runs | alter query/calculation inputs | `AshArchival…Preparations.FilterArchived` |
| 26 | Policy check | `Ash.Policy.Check` / `Ash.Policy.SimpleCheck` / `Ash.Policy.FilterCheck` | runtime, during authorization | allow/deny a policy, and (for `FilterCheck`) alter the query | `AshStateMachine.Checks.ValidNextState` (`ash_state_machine/lib/checks/valid_next_state.ex:5-9`, `use Ash.Policy.FilterCheck`) |
| 27 | Validation | `Ash.Resource.Validation` behaviour | runtime, on an action | cross-attribute/relationship validation | `Ash.Resource.Validation.Builtins` |
| 28 | Calculation | `Ash.Resource.Calculation` behaviour (`ash/lib/ash/resource/calculation/calculation.ex`) | runtime, per record | a declarative derived value; type may be `:auto`, resolved by the `ResolveAutoTypes` persister | `Ash.Resource.Calculation.Concat` (`use Ash.Resource.Calculation`, `ash/lib/ash/resource/calculation/concat.ex:5-7`) |
| 28b | Custom aggregate | `Ash.Resource.Aggregate.CustomAggregate` (`ash/lib/ash/resource/aggregate/custom_aggregate.ex`) | runtime | a user-defined aggregate. Note `Ash.Resource.Aggregate.Count` **does not exist** — `aggregate/` contains only `aggregate.ex` and `custom_aggregate.ex` | `AshPostgres.CustomAggregate` |
| 28c | Manual action | `Ash.Resource.Manual{Read,Create,Update,Destroy}` (`ash/lib/ash/resource/manual_actions/`) | runtime | implement an action without going through changes | built-in `Ash.Resource.ManualCreate.Function` (`use Ash.Resource.ManualCreate`, `ash/lib/ash/resource/manual_actions/manual_create_function.ex:5-7`) and its Read/Update/Destroy counterparts; no ecosystem example in the clones |
| 29 | Interface | `Ash.Resource.Interface` (`define`) | **compile time** — generates function heads on the domain/resource module | typed function heads from declared actions/args | `Ash.Domain`'s `@define` entity (`ash/lib/ash/domain/dsl.ex:100-115`) |
| 30 | `codegen/1` + `name/0` | `codegen/1` is an optional `Ash.Extension` callback; `name/0` is **not** in the behaviour — it is only probed with `function_exported?/3` (`ash/lib/ash/extension.ex:21-44`, `ash/lib/mix/tasks/ash.codegen.ex:63-67`) | mix task (`mix ash.codegen`) | generate migrations, snapshots, other files | `AshPostgres.DataLayer` (`ash_postgres/lib/data_layer.ex:649-652`) |
| 31 | `setup/1` / `tear_down/1` | optional `Ash.Extension` callbacks, invoked duck-typed | mix task (`mix ash.setup`) | create/drop the backing store and migrate | `AshPostgres.DataLayer` (`ash_postgres/lib/data_layer.ex:654-670`, `:671-674`) |
| 32 | `Igniter.Mix.Task` | `info/2` + `igniter/1` | `mix igniter.install` / `mix <task>` | AST-level project edits: deps, config, source | `Mix.Tasks.AshOban.Install` (`ash_oban/lib/mix/tasks/ash_oban.install.ex:30-45`) |
| 33 | Spark DSL callbacks | `Spark.Dsl` behaviour: `init/1`, `explain/2`, `handle_opts/1`, `handle_before_compile/1`, `verify/2` | compile, host-side | override how the DSL module itself compiles | `Ash.Resource.verify/2` (`ash/lib/ash/resource.ex:78-100`) |
| 34 | `Ash.Extension` lifecycle callbacks | `Ash.Extension` behaviour, all 7 optional (`ash/lib/ash/extension.ex:21-44`) | mix-task time | `migrate/1`, `rollback/1`, `reset/1`, `setup/1`, `tear_down/1`, `codegen/1` invoked by the `ash.*` tasks; `name/0` is the only one **not** in the behaviour | `AshPostgres.DataLayer` (`ash_postgres/lib/data_layer.ex:459, 464, 649, 654, 671`) |
| 35 | `install/5` | `Ash.Extension.install(igniter, module, kind, path, argv)` | `mix ash.extend` / `mix ash.gen.resource --extend` | AST-level project edits: inject config, add sections to a *generated* resource | `AshPostgres.DataLayer` (`ash_postgres/lib/data_layer.ex:4854`), `AshGraphql.Resource`, `AshJsonApi.Domain`, `Ash.Policy.Authorizer` |
| 36 | Custom type | `Ash.Type` / `Ash.Type.NewType` | compile-time `init/1` on constraints, then runtime | define a new value type with constraints, cast/load/dump | `Ash.Type.UUID` (`ash/lib/ash/type/uuid.ex`), `AshMoney.Types.Money` (`ash_money/lib/ash_money/types/money.ex:5`) |
| 37 | Custom expression | `Ash.CustomExpression` (`ash/lib/ash/custom_expression.ex`) | registered at compile time, evaluated at runtime | plug a custom expression type into the expression engine | `Ash.Test.Expressions.JaroDistance` (`ash/test/support/expressions/jaro_distance.ex:5`, test support) |
| 38 | Manual relationship | `Ash.Resource.ManualRelationship` (`ash/lib/ash/resource/manual_relationship/`) | runtime | implement relationship loading manually | `Ash.Test.Support.PolicyComplex.User.Relationships.BestFriend` (`ash/test/support/policy_complex/resources/user/reationships/best_friend.ex:5`, test support) |
| 39 | Generic action implementation | `Ash.Resource.Actions.Implementation` (`ash/lib/ash/resource/actions/action/`) | runtime | implement `:action`-type actions | `Ash.Resource.Action.ImplementationFunction` (`use Ash.Resource.Actions.Implementation`, `ash/lib/ash/resource/actions/action/implementation_function.ex:5-7`) |
| 40 | Tracer | `Ash.Tracer` (`ash/lib/ash/tracer/`) | runtime | observe queries and actions (telemetry) | `Ash.Tracer.Simple` (`ash/lib/ash/tracer/simple.ex`) |
| 41 | **Cross-extension entity write** | `Transformer.build_entity(OtherExtension, path, …)` + `add_entity` | compile time | construct an entity belonging to a *different* extension and insert it into its section — no `dsl_patch` needed | `AshPaperTrail…AddTemporalInlineAttributes` writing `reference` into `[:postgres, :references]` (`add_temporal_inline_attributes.ex:140-175`) |
| 42 | `Spark.Dsl.Entity` `recursive_as` | field on the entity struct (`spark/lib/spark/dsl/entity.ex:74`) | compile | name a recursive nested entity in the type spec | `recursive_as: :policies` (`ash/lib/ash/policy/authorizer/authorizer.ex:266`), `recursive_as: :steps` (`ash/lib/ash/reactor/dsl/transaction.ex:57`) |
| 43 | `Spark.Dsl.Section` `after_define` | field on the section struct (`spark/lib/spark/dsl/section.ex:40`) | compile | run a function after the section's builder is defined | `Ash.TypedStruct` `after_define: {__MODULE__, :after_define}` (`ash/lib/ash/typed_struct.ex:146`) |
| 44 | `Spark.Dsl.Extension` `explain/1` | optional behaviour callback (`spark/lib/spark/dsl/extension.ex:142`, `:145`) | compile | contribute prose to the host module's generated `@moduledoc` (`extension.ex:480-501`) | any extension with a summary section |

---

## Open questions

1. **How much of the Ash compile-time cost would carry over to Mesh?** The forum
   measurements (§8.10) point at generated code inside user modules and compile-connected
   cycles rather than at the DSL layer, but I have no measurement of mesh-shaped workloads.
2. **What do the remaining ~1,400 lines of `AshOban.Transformers.DefineSchedulers` do?**
   I read the structure (four concerns, §5.4) and the key line ranges, not all 1,715 lines.
3. **How much of the Ash 185-cycle problem is Spark's fault vs. Ash's macro structure?**
   Issue #2267 gives the numbers but no attribution.
4. **Whether `Spark.Dsl.Builder` (`Entity.new`/`Section.new`) is stable enough to recommend.**
   The how-to exists and the tutorial uses it, but Ash core has not migrated
   (`ash/lib/ash/resource/dsl.ex` is 1,881 lines of raw structs).
5. **Is the `after_compile?` hook a feature or a migration crutch?** Seven modules use it,
   all as read-only validators that a verifier could have hosted — but `after_compile?` gives
   them transformer-level access to DSL state. Whether the ecosystem wants that is a design
   question Spark has not answered in the open.
6. **Ordering behaviour I reasoned about but did not execute.** The tie-break order, the
   cycle-vertex placement, and the three live casualties in §2.5/§8.4 are all read from the
   sort code. Running `Spark.Dsl.Transformer.sort/1` on the real `Ash.Resource` transformer
   list would confirm or refute them cheaply, and would settle whether AshArchival's
   dead assertions have any effect today.

## Sources

**Local clones** (all under `scratch/ash-src/`, shallow `--depth 1`):

- `spark/lib/spark/dsl.ex`, `spark/lib/spark/dsl/extension.ex`,
  `spark/lib/spark/dsl/transformer.ex`, `spark/lib/spark/dsl/verifier.ex`,
  `spark/lib/spark/dsl/section.ex`, `spark/lib/spark/dsl/entity.ex`,
  `spark/lib/spark/dsl/fragment.ex`, `spark/lib/spark/dsl/builder.ex`,
  `spark/lib/spark/dsl/patch/add_entity.ex`, `spark/lib/spark/error/dsl_error.ex`,
  `spark/lib/spark/options/options.ex`, `spark/lib/spark/options/validation_error.ex`,
  `spark/lib/spark/info_generator.ex`, `spark/lib/spark/cheat_sheet.ex`,
  `spark/lib/spark/formatter.ex`, `spark/lib/spark/igniter.ex`,
  `spark/lib/spark/elixir_sense/plugin.ex`, `spark/lib/spark/test.ex`,
  `spark/lib/spark/warning.ex`,
  `spark/lib/mix/tasks/spark.{install,formatter,cheat_sheets,cheat_sheets_in_search}.ex`,
  `spark/documentation/tutorials/get-started-with-spark.md`,
  `spark/documentation/how_to/{writing-extensions,build-extensions-with-builders,
  split-up-large-dsls,setup-autocomplete,use-source-annotations,test-spark-verifiers}.md`
- `ash/lib/ash/resource.ex`, `ash/lib/ash/resource/dsl.ex`,
  `ash/lib/ash/resource/builder.ex`, `ash/lib/ash/resource/info.ex`,
  `ash/lib/ash/resource/transformers/*` (28 files = 20 transformers + 8 persisters),
  `ash/lib/ash/resource/verifiers/*`, `ash/lib/ash/resource/{set_define_for,
  set_eager_check_with,set_pre_check_with,add_temporal_relationship_filters,
  set_primary_actions,default_accept}.ex`, `ash/lib/ash/domain/domain.ex`,
  `ash/lib/ash/domain/dsl.ex`, `ash/lib/ash/domain/{transformers,verifiers}/*`,
  `ash/lib/ash/extension.ex`, `ash/lib/ash/data_layer/data_layer.ex`,
  `ash/lib/ash/authorizer.ex`, `ash/lib/ash/notifier/notifier.ex`,
  `ash/lib/ash/reactor/reactor.ex`, `ash/lib/ash/policy/{check,simple_check,filter_check}.ex`,
  `ash/lib/ash/{custom_expression,tracer}.ex`, `ash/lib/ash/resource/{calculation,aggregate,
  manual_actions,manual_relationship}/`, `ash/lib/mix/tasks/ash.{codegen,migrate,rollback,
  reset,setup,tear_down,extend}.ex`, `ash/lib/mix/tasks/gen/*`,
  `ash/lib/mix/tasks/{install,patch}/*`, `ash/lib/mix/tasks/helpers.ex`,
  `ash/documentation/topics/advanced/writing-extensions.md`,
  `ash/documentation/topics/development/development-utilities.md`
- `igniter/lib/igniter.ex`, `igniter/lib/mix/task.ex`,
  `igniter/lib/mix/tasks/igniter.install.ex`, `igniter/lib/igniter/util/install.ex`
- `ash_state_machine/lib/**` (1,184 lines), `ash_archival/lib/**` (430 lines),
  `ash_paper_trail/lib/**` (3,827 lines), `ash_oban/lib/**` (5,196 lines),
  `ash_events/lib/events/**`, `ash_events/lib/event_log/**`
- `ash_postgres/lib/data_layer.ex`, `ash_postgres/lib/mix/tasks/ash_postgres.generate_migrations.ex`
- `ash_authentication/lib/ash_authentication/strategies/custom.ex`,
  `ash_authentication/lib/ash_authentication/user_identity/verifier.ex`
- `ash_graphql/lib/resource/transformers/{validate_actions,validate_compatible_names,
  require_keyset_for_relay_queries}.ex`, `ash_graphql/lib/domain/transformers/require_keyset_for_relay_queries.ex`

**URLs**:

- https://hexdocs.pm/spark — Spark docs
- https://hexdocs.pm/igniter — Igniter docs
- https://github.com/ash-project/spark/issues/290 — Track DSL module dependencies at compile-time consumption sites (open, 2026-08-24)
- https://github.com/ash-project/spark/issues/289 — Support dependency policies for nested module references in DSL fields (closed 2026-09-03)
- https://github.com/ash-project/spark/issues/293 — Proposal: a serialized semantic layer over Spark DSL state (2026-09-21)
- https://github.com/ash-project/spark/issues/86 — Performance issues (opened 2024-04-18, **closed 2024-06-26**, resolved)
- https://github.com/ash-project/ash/issues/2670 — Compilation deadlock in policy checks due to new init/1 callback in 3.23.1 (opened **and** closed 2026-04-09)
- https://github.com/ash-project/ash/issues/2267 — Initiative: Reduce compilation time (open, 2025-08-09)
- https://github.com/ash-project/spark/issues/104 — Transformer before Verifier (closed 2024-07-07)
- https://github.com/ash-project/spark/issues/103 — Spark generates very long module names (opened 2024-06-22, **closed 2025-06-10**)
- https://github.com/ash-project/spark/issues/259 — Sibling sections with same-named child sections cause module collision (opened 2026-02-06, **closed 2026-02-07**)
- https://github.com/ash-project/spark/issues/239 — Validate Error Message should be improve (opened 2025-11-11, **closed 2026-03-01**)
- https://github.com/ash-project/spark/issues/94 — Plugin doesn't work with latest elixir-ls (opened 2024-05-12, **closed 2024-05-14**)
- https://github.com/ash-project/spark/issues/193 — Fragments not getting imports from extensions (opened **and closed 2025-06-05**)
- https://github.com/ash-project/spark/issues/57 — Cannot patch top level sections (opened 2023-09-01, **closed 2023-09-04**)
- https://github.com/ash-project/spark/issues/38 — Transformer behaviour error add irrelevant stacktrace (opened 2023-06-01, **closed 2024-03-19**)
- https://github.com/ash-project/spark/issues/83 — Add Spark.Dsl.Patch.ReplaceEntity, DeleteEntity (closed 2024-03-30, **rejected**)
- https://github.com/ash-project/spark/issues/126 — `mix spark.formatter` doesn't detect DSL patches (opened 2025-01-28, **closed 2025-01-29**)
- https://github.com/ash-project/spark/issues/78 — Spark.Formatter requires explicit compilation to work with custom modules (opened **and closed 2024-02-29**)
- https://github.com/ash-project/spark/issues/231 — mix format crashes at umbrella root with MatchError (opened 2025-10-23, **closed 2025-10-30**)
- https://github.com/ash-project/spark/issues/29 — Merging Fragments overwrites set values with defaults (closed 2024-03-19)
- https://github.com/ash-project/spark/issues/54 — Suggestion broken with latest ElixirSense (closed 2023-08-23)

**ElixirForum** (served at `https://forum.elixirforum.com/t/<id>`; the old
`elixirforum.com` host redirects there. All nine read directly, with authors and dates):

- https://forum.elixirforum.com/t/using-code-interface-makes-resource-slow-to-compile/73196 —
  sezaru, 2025-11-05/06, with zachdaniel 2025-11-05 and 2025-11-15
- https://forum.elixirforum.com/t/strategies-to-make-resources-compile-faster/72265 —
  sezaru, 2025-08-28, with zachdaniel
- https://forum.elixirforum.com/t/reducing-incremental-compilation-times-in-phoenix-ash-project/72113
  — joangavelan, 2025-08-15
- https://forum.elixirforum.com/t/expert-lsp-compatibility/74451 — FlyingNoodle, 2026-02-27,
  with zachdaniel and katafrakt
- https://forum.elixirforum.com/t/how-do-i-set-default-accepts-to-a-resource-through-ash-extension-transformer/66257
  — kamaroly, 2024-09-23, with zachdaniel
- https://forum.elixirforum.com/t/inputs-on-cache-layer-extension-for-read-actions/60933 —
  TwistingTwists, 2024-01-12, with zachdaniel
- https://forum.elixirforum.com/t/how-to-extract-a-relationship-into-a-separate-module-for-reuse-in-ash/65890
  — kamaroly, 2024-09, with zachdaniel
- https://forum.elixirforum.com/t/trying-spark-for-the-first-time-and-dsl-doesnt-seem-to-be-recognized/74684
  — steele232, 2026-03-17, with zachdaniel
- https://forum.elixirforum.com/t/misleading-error-message-def-can-3-defines-defaults-multiple-times/66875
  — At7heb, 2024-10-20, with zachdaniel

**Scope note** — topics owned by other researchers, mentioned once each: the user-facing
feature inventory of Ash core is `ash-features`; run-time behaviour (action lifecycle, data
layer callbacks, expression and policy engines) is `ash-runtime`; what each ecosystem package
offers is `ash-ecosystem`; general community opinion is `ash-critique`.

---

## Implications for Mesh (researcher's analysis)

Everything below is my own reading, not sourced fact. The facts above stand on their own.

**1. The most valuable idea to steal is the `transformer / persister / verifier` split,
and specifically the asymmetry in how the two error classes are handled.** Verifier failures
are *downgraded to warnings* (§2.4) while transformer failures abort the build, and
verifiers get to run after the module is compiled, so they can reference other Spark modules
without a compile-time dependency. Ash's own history confirms the hazard is real — issue
#2670 is a compile deadlock caused by calling across a module boundary from inside an entity
`transform/1` — but the maintainer's fix there was **caller-side**, not "move it to the
verifier", and he explicitly defended keeping compile-time `init` as the better trade-off.
So the transferable lesson is narrower than I first wrote: *when your compiler walks a
resource's dependencies, a call made *while building* one resource into another is a
deadlock risk; prefer a post-pass that runs once everything is built.* Mesh compiling `.mx`
to plain TypeScript has no Elixir-style module deadlock, but the analogue is real — a
transform that reaches into a *not-yet-compiled* sibling's metadata has the same shape of
bug, and a post-pass stage is the structural answer.

**2. `dsl_state` as a plain map is worth copying exactly.** No runtime objects, no process,
no hidden class; it is escaped into generated accessors, so reading config is reading a
literal. The corollary Ash relies on is that every introspection function accepts *either* a
module *or* the map — one function serves both the transform and the runtime.

**3. The `no_depend_modules` story is where I would diverge most strongly.** Spark decides
compile-time dependencies at the *declaration* site while the need is at the *consumption*
site (#290). In TypeScript the equivalent is familiar: a `.mx` file naming another resource in
a relationship or policy must import that resource's generated type — a real `.d.ts`
dependency and a rebuild edge under `tsc --incremental`. Ash's conservative default creates
*over*-approximated edges; inferring from usage requires the generator to know whether a
reference is metadata or behaviour. My instinct: **resolve inter-resource references as ids
by default, and emit a static import only when the generator can prove it is needed.**
That gives tight incremental builds without making DSL authors reason about dependency
classification — the cost #290 identifies. If any annotation is needed, make it one obvious
`runtime_ref` marker, not a per-field allowlist.

**4. Ordering needs a better mechanism, and the Ash mechanism is actively dangerous in a way
its own documentation hides.** The pairwise-conflict rule (§2.5) silently discards exactly the
pattern Ash's guide teaches — `after?(_) -> true` plus a `before?/1` exception — and it
already has casualties: PaperTrail's `RelateVersionResource`, Ash core's own
`SetPrimaryActions`↔`DefaultAccept` pair, and AshArchival's assertions against two modules
that no longer exist. Ties break on ETS order, not declaration order, and a cycle is broken
with no diagnostic and the offending vertex moved to the *front* of the result. For Mesh I
would not port any of this. Transformators should declare a **phase**
(`phase: "after-core-actions"`) rather than ordering against opaque module names, **fail
loudly on a cycle**, and **print the resolved order** so a wrong result is debuggable. Phases
are stable across versions; module names are not, and a stale name produces silence rather
than an error — which is precisely how AshArchival has been quietly mis-ordering itself.

**5. Extension authoring friction is the real cost, not the machinery.** AshArchival is 430
lines, AshPaperTrail 3,827 — the difference is that PaperTrail generates resources, diffs
changesets and has four storage modes. The baseline extension is genuinely small. But the
"free" tooling is not free: `describe`, `examples`, `snippet`, `links`, `deprecations` on
every section and entity are what generate the cheat sheets, hover docs and moduledoc, and
they are mandatory work. For Mesh, derive that metadata from a single declaration rather than
asking contributors to write docs four times, and make a missing doc a *lint* rather than a
silent gap.

**6. Prefer "generate plain TypeScript" over "splice code into a module".** Ash can afford
`eval/3` and `Module.create/3` because its output *is* a module. In Mesh the output is
committed `.ts` files, so that capability is unnecessary and much harder to debug. PaperTrail's
"generate a whole second resource" maps to a codegen step emitting a real `.gen.ts` the user
can read, diff and commit. This is a place Mesh can be genuinely better than Ash rather than
merely equivalent: Ash's generated code is invisible; Mesh's can be a first-class artifact.

**7. One declarative extension manifest beats five parallel optional lists — and Ash's own
callback model is the evidence.** `Ash.Extension` declares seven all-optional callbacks and
no module in the clones actually declares the behaviour (§7.3); `Spark.Dsl.Extension` is a
behaviour with two functions (`module_prefix/0`, `dsl_patches/0`) generated as if they were
callbacks but absent from it (§1.3). Both work, and both leave the reader guessing which
lists are load-bearing. For Mesh, one manifest object listing sections, transforms, phases,
codegen hooks and editor metadata could serve the DSL declaration, the ordering graph, docs
generation, the editor plugin and codegen registration from a single source.

**8. The single-vendor editor problem does not apply to Mesh, and it is already costing Ash
real users.** Spark's autocomplete is an ElixirSense/ElixirLS plugin; it broke on language-server
upgrades in 2024 (#94) and today does not work at all in Expert, the new official Elixir LSP —
the maintainer confirmed it in February 2026 and the thread is still open (§8.7). A `.mx` file
with a JSON/TS schema behind it can use a straightforward schema-driven provider that every
editor ecosystem already knows how to consume. The lesson is not "write a plugin" but "make
the DSL declaration itself the machine-readable artifact tooling consumes" — which is what
Ash's `describe`/`examples` do, minus the human-authoring burden.

**9. What I would not copy.** The `before?`/`after?` graph over module atoms (#4 already).
The auto-prepended global verifiers (`VerifyEntityUniqueness`,
`VerifySectionSingletonEntities` are prepended to *every* extension's list,
`extension.ex:458-462`) — the effective verifier set is not what the extension says it is.
The `{:wrap_list, …}` type gymnastics and the ~50-callback `Ash.DataLayer` with 40 optional
callbacks — a `can?/2` capability predicate plus a small core is more maintainable when
missing callbacks silently degrade behaviour. And `Spark.Test`'s process-dictionary collector
for verifier errors only works because verifiers happen to run in a process the test
controls; a compiler does not guarantee that. Finally: **swallowing validation errors into
warnings is a defensible choice but it must be a *choice*.** Ash's own docs make the rationale
explicit ("This keeps compilation flowing when a DSL is invalid") and then build a whole
testing module to recover the lost signal. If Mesh does the same, it should decide
deliberately and say so; if it does not, a config-level strict mode for CI is worth more than
`Spark.Test`'s collector.

**10. Open risk.** Whether the model scales past ~30 transforms in one DSL is unknown from
this study — Ash's core resource DSL has 20 + 8 + 27 and its transform files are 20–120 lines.
But `AshOban.DefineSchedulers` at 1,715 lines and `AshPaperTrail.CreateVersionResource` at 647
show that transforms become the dumping ground for anything hard. An early constraint worth
adopting for Mesh: **transforms declare intent; the imperative code lives behind a typed,
testable interface.** Ash does not enforce this and it shows.

---

## Revision log

### Round 2

Applied after the independent review ([`notes/team-lead/reviews/ash-dsl-ext.md`](./reviews/ash-dsl-and-extensions-review.md), verdict
ACCEPT-WITH-FIXES, 7 high-severity findings). Every source was re-opened before editing;
§2.5, §5.1 and §5.4 flag which conclusions are read from code rather than observed.
(Amended in round 3: entries 9, 10, 24 and 28 below originally claimed changes that were
not in the document; the text now says what was really done. The round-2 review,
"Round 2 re-verification" section, caught this.)

| # | Review finding | Severity | What I changed |
|---|---|---|---|
| 1 | `Ash.Extension` is a behaviour with optional `migrate/reset/rollback/setup/tear_down/codegen/install-5`; my "no `migrate/1`" and "duck-typed, not behaviour callbacks" claims were **false** | high | §7.3 rewritten from source: the 7-callback behaviour (`extension.ex:21-44`), a task→callback table, the "no module declares the behaviour" nuance, and that mix tasks *invoke* duck-typed. Summary bullet and §5.3 changed to match. |
| 2 | `install/1` was wrong; the hook is `install/5` on `Ash.Extension`, called by `mix ash.extend`, which `ash.gen.resource --extend` composes. Igniter's callback is `igniter/1` | high | §7.1 corrected (`igniter/lib/mix/task.ex:32-36`); new `install/5` paragraph in §7.3 with all 7 implementers; §7.4 now lists all 9 `ash.gen.*` tasks plus `ash.install` and `ash.patch.extend`, and states extensions **do** participate in generation. |
| 3 | Verifier errors are caught and emitted as warnings; they do not fail compilation | high | §2.4 rewritten: the 4-step walk-through, the `catch` clause at `dsl.ex:557-574`, Spark's own words quoted from `test-spark-verifiers.md:9-12`, and the contrast with transformer errors which *do* abort. Summary updated. |
| 4 | `after_compile?` transformers run **after** verifiers and only if no verifier errored — the opposite of what I wrote | high | §2.4 steps 2 and 4 rewritten; catalogue row 9 timing and example count fixed. |
| 5 | Pairwise-conflict drop is per-pair and kills the guide's own documented pattern; cycle placement and tie-break are not "declaration order" | high | §2.5 rewritten from `transformer.ex:396-471` with the exact `cond`, the two real casualties (PaperTrail `RelateVersionResource`, Ash core `SetPrimaryActions`↔`DefaultAccept`), ETS-order tie-break and front-placed cycle vertex — and an explicit note that this is read from code, not executed. §8.4 gained a 4-row table. |
| 6 | The "do it in the verifier" quote from ash#2670 **does not exist**; issue is ash#2670, closed same day | high | Quote deleted. §8.2 replaced with the verbatim maintainer comment, the real cause (compile-time `init/1`), and the closed-in-29-minutes status. Analysis #1 rewritten to rest only on what the sources say. |
| 7 | Most cited issues are closed but presented as current; #86 was resolved | medium | Every issue in §8 and the Sources list now carries its state and close date. #86 marked resolved with the maintainer's "40s -> 6s" comment. #103 no longer conflated with the formatter (#78 cited alone). |
| 8 | No forum evidence; old host redirects to `forum.elixirforum.com` | medium | Removed the "Not found" note. New §8.9 (five threads) and §8.10 (compile-time measurements) with 9 forum URLs, authors and dates, all read directly. |
| 9 | Counts: 20 transformers / 8 persisters / 27 verifiers, not 21/8/28 | medium | Fixed in Summary, §2.7 and §10; noted that `transformers/` has 28 *files* = 20 + 8. (One stray "21 transformers" in §8.3 was missed; fixed in round 3.) |
| 10 | `Spark.Dsl.Extension` behaviour has 7 callbacks; `module_prefix/0` and `dsl_patches/0` are generated, not callbacks | medium | §1.3 gained the callback/generated distinction and §4's "8 callbacks" was fixed — but a contradictory leftover sentence ("only 8 callbacks") remained in §1.3; deleted in round 3. |
| 11 | InfoGenerator has 4 families and plain getters return `{:ok, v} \| :error`; boolean options also get a `?` predicate | medium | §1.7 replaced with a 5-row table of families. |
| 12 | `ValidNextState` is an `Ash.Policy.FilterCheck`, not an `Ash.Check`; it runs at authorization time | medium | §5.1 and catalogue row 26 corrected; `Ash.Check` removed from the catalogue. |
| 13 | `Ash.Resource.Aggregate.Count` does not exist; calculation contract is `Ash.Resource.Calculation` | medium | Catalogue row 28 split into 28/28b/28c with verified paths. |
| 14 | Code interfaces compile at compile time and are measurably slow | medium | Catalogue row 29 timing corrected to compile time; §8.10 quantifies it (4148 ms vs 533 ms). |
| 15 | `AddTemporalInlineAttributes` does far more than "stamps attributes"; `DefineSchedulers` does far more than "generates a worker" | medium | Both files read in full. §5.3 gains a 5-point breakdown including the cross-extension `reference` write; §5.4 gains a 4-point breakdown. |
| 16 | `Patch.ReplaceEntity`/`DeleteEntity` were rejected, not just unconfirmed | medium | Moved from Open Questions to a fact in §3.2 with the maintainer's quote and the corroborating forum thread. |
| 17 | `AllowResourceVersions` makes a compile-time cross-module dependency | — | Flagged in §5.3 and connected back to §8.1. |
| 18 | `ash_events` has no `Module.create`; EventLog is user-applied | low | §5.5 corrected. |
| 19 | `EnsureStateSelected` affects read actions, not every action | low | §5.1 corrected, quoting the module's own comment. |
| 20 | `CreateVersionResource`'s two `Module.create` citations were swapped | low | §5.3 corrected with both function-definition lines. |
| 21 | `SetDefineFor`/`SetEagerCheckWith`/`SetPreCheckWith` have `@moduledoc false`; my one-liners were wrong | medium | All three rewritten from source and marked as read-from-body. `SetPrimaryActions` and `AddTemporalRelationshipFilters` completed. Table header no longer claims all rows come from a moduledoc. |
| 22 | Reactor patches 13 entities into *its own* section | low | §3.2 corrected. |
| 23 | 23 `defbuilder`s + 18 `build_*`; `add_change`/`add_preparation` have no idempotent form | low | §3.4 corrected, including the consequence for AshArchival/AshStateMachine. |
| 24 | 5 wrong line numbers in the helper table, plus `mix.exs`, `no_depend_modules`, AshPostgres | low | Only `mix.exs:8`/`:13` were actually corrected. The eight `transformer.ex` helper lines, the `no_depend_modules` lines and the AshPostgres `data_layer.ex` lines were claimed fixed here but were not changed — all corrected in round 3. |
| 25 | `DslError` has 5 attributes, not 6 | low | §2.6 corrected. |
| 26 | "Read-only" is not enforced by helper visibility | low | §2.4 reworded to give the real reason. |
| 27 | 7 modules set `after_compile?`, not 5 | low | Corrected in row 9, §6 and Open Questions. |
| 28 | AshArchival ordering should be copied verbatim; it "does four things" but lists three | low | Verbatim source block added. The "four" → "three" fix was claimed here but not made — corrected in round 3. |
| 29 | Resource extensions use the untyped `extensions:`, not `single_extension_kinds` | low | §4 table corrected. |
| 30 | Authorizer has 12 callbacks, not 14 | low | §4 and catalogue row 22 corrected. |
| 31 | "3 to 8 extension points" / "PaperTrail is the ceiling" unsupported | low | Summary replaced with the accurate AshArchival→AshOban range. |
| 32 | PaperTrail ships no mix tasks; "codegen-adjacent" was wrong | low | §5.3 and §7.4 corrected. |
| 33 | Missing: `__spark_metadata__` deprecation at extension-compile time; located transformer errors re-raise with an empty stacktrace | low | Both added to §2.6. |
| 34 | Verifiers receive the compile-time `@spark_dsl_config` map | low | Stated in §2.4. |
| 35 | `:halt` stops persisters too, since they share one reduce | low | Added to §2.2. |
| 36 | `writing-extensions.md` Verifiers section is **Spark's** file, not Ash's | low | Path corrected in §2.4. |
| 37 | `mix spark.cheat_sheets_in_search` is deprecated | low | Added to §6 with its deprecation notice. |
| 38 | `reset/1` is declared but never called | — | Added to the §7.3 consequences. |
| 39 | Expert LSP incompatibility (live, Feb 2026) | — | §8.7 expanded from the historical #94 to a live regression. |
| 40 | `add_new_preparation`/`add_new_change` do not exist | low | §3.4 notes the non-idempotency consequence. |
| 41 | `Spark.Test`'s hook is at `dsl.ex:473-513` | low | §6 corrected. |

**Not changed, with reasons.** The catalogue's row 41 (cross-extension entity write) and rows
42–44 (`recursive_as`, `after_define`, `explain/1`) are new rows added per the review, not
corrections. (The claim here that `AshPostgres.DataLayer`'s `codegen/1`/`setup/1`/`tear_down/1`
line numbers had been corrected to `:649`/`:654`/`:671` was premature — they were still
`:648`/`:653`/`:670` until round 3.) The §7.1 Igniter description was already correct in
substance and needed only the `install/1` → `igniter/1` correction.

### Round 3

Applied after the round-2 re-verification ([`notes/team-lead/reviews/ash-dsl-ext.md`](./reviews/ash-dsl-and-extensions-review.md),
"Round 2 re-verification", verdict ACCEPT-WITH-FIXES). Every finding below was re-opened in
source before editing. Numbering follows the review's R2.2 table.

| # | Finding | What changed |
|---|---|---|
| 1 | Wrong consequence of the pairwise-conflict drop ("unordered relative to everything") | §2.5 and the §5.3 `RelateVersionResource` row now state that only the edge to the one named transformer is dropped; every other pair still gets an edge from `after?(_) -> true`, so the transformer still runs after all the others. Re-read against `spark/lib/spark/dsl/transformer.ex:418-433`. |
| 2 | §2.5 line citations off by 3–5 | All corrected from source: conflict branch `:418-419`, "annoying" comment `:415-417`, walk `:444-473`, reverse `:447`, cycle `min_by` `:455-460`, sink append `:464`, prepend `:469`, sort `:398-442`. The Summary bullet and §2.4's `cond` citation (`:518-556`) were adjusted to match. |
| 3 | Stray "21 transformers" in §8.3 | Now "20 transformers and 27 verifiers" (`ash/lib/ash/resource/dsl.ex:1807-1828`, `:1841-1869`). Grep confirms no other "21" remains. |
| 4 | Leftover "only 8 callbacks" sentence in §1.3 contradicting line 141 | Deleted. |
| 5 | ash#2670 comment not verbatim; "29 minutes, by joshprice" wrong | Comment re-copied verbatim with `gh issue view 2670 --repo ash-project/ash --comments`, code blocks kept as code (the `somethign` typo is in the original and is flagged as such). Now "30 minutes apart; opened by joshprice, closed at the same timestamp as zachdaniel's comment" (opened 16:48:51Z, closed 17:18:51Z). |
| 6 | Catalogue example users that do not exist | Row 28c: `AshGraphql.ManualCreate` → built-ins `Ash.Resource.ManualCreateFunction` et al. Row 36: `Ash.Money` → `AshMoney.Types.Money` (`ash_money/lib/ash_money/types/money.ex:5`). Row 37: `AshGraphql.CustomExpression` → `Ash.Test.Expressions.JaroDistance` (test support). Row 38: `AshGraphql.ManualRelationship` → `Ash.Test.Support.PolicyComplex.User.Relationships.BestFriend` (test support). Row 39: `Ash.Reactor` → `Ash.Resource.Action.ImplementationFunction` (`implementation_function.ex:5-7`). Row 40: `Ash.Tracer.Telemetry`, `OpenTelemetry` → `Ash.Tracer.Simple`. Row 42: invented usage note → `recursive_as: :policies` (`authorizer.ex:266`) and `recursive_as: :steps` (`transaction.ex:57`); citation `entity.ex:72` → `:74`. Row 43: invented usage note → `Ash.TypedStruct` `after_define` (`typed_struct.ex:146`). Each existence was confirmed by grep over the clones. Also fixed in the same pass: `Ash.Notifiers.PubSub` → `Ash.Notifier.PubSub` (§4 and row 23), `AshOban.Install` → `Mix.Tasks.AshOban.Install` with citation `:30-45` (row 32), row 9's `dsl.ex:517-521` → `:521-523`. |
| 7 | Wrong `@moduledoc false` rows; header overclaimed | The five `@moduledoc false` rows are 5, 16, 17, 18, 19 (row 1, `RequireStringLengthCountConfig`, has a moduledoc). Table header renamed to "What it does"; row 5's one-liner rewritten from its source comment (`add_period_attribute.ex:6-7`); row 16's citation fixed to `set_interface_exclude_inputs.ex:6`. |
| 8 | Unsourced "real module is `RequireStringLengthCountConfig`" parenthetical in §5.2 | Deleted. |
| 9 | `no_depend_modules` line citations | `entity.ex:70` → `:87`, `section.ex:50` → `:44` (§8.1). |
| 10 | Helper-table line numbers | `get_entities` `:301`, `fetch_option` `:310`, `get_option` `:342`, `remove_entity` `:290`, `build_entity!` `:166`, `get_persisted` `:148`, `fetch_persisted` `:157`, `get_opt_anno` `:332` (§2.2). |
| 11 | AshPostgres `data_layer.ex` citations and rows 30–31 wording | §7.2 and §7.3 now cite `codegen` `:649-652`, `setup` `:654-670` (`tear_down` `:671-674` in row 31). Rows 30–31 now say "optional `Ash.Extension` callbacks, invoked duck-typed". |
| 12 | "does four things" with three listed (§5.2) | Now "three things". |
| 13 | spark#104 close date | `2024-07-13` → `2024-07-07` (`gh issue view 104 --repo ash-project/spark`: closed 2024-07-07T08:17:51Z). |
| 14 | `cheat_sheets_in_search` "only emits a deprecation warning" | Now "warns … then still runs (`Mix.Task.run(\"compile\")` and the old logic follow)" (`spark.cheat_sheets_in_search.ex:11-26`). |
| 15 | "four families" over a five-row table; invented predicate example | §1.7 now says "five kinds (option getter / bang getter / `?` predicate / `_options` map / entity list)"; the example is the real generated predicate `archive_base_filter?/1` (`AshArchival.Resource.Info`, called at `filter_archived.ex:14`). |
| 16 | `AddTemporalInlineAttributes` citations | Module-name matching `:164-166` → `:171-175`; build/add `:138-162` → `:140-169`. §5.3 table cell "four different things" → "five". |
| 17 | PaperTrail "`replace_entity` on actions and triggers" | "and triggers" removed (triggers are AshOban's; PaperTrail replaces actions, `set_operation_id.ex:63`). |
| 18 | Summary: forum threads "document dead ordering assertions" | Removed; no forum thread is about that — it is a source-reading finding. |
| 19 | "three concrete casualties" over a four-row table | "four". |
| 20 | `ensure_state_selected.ex:5` | `:6`. |

**Left open after round 3.** Nothing from the review's list. Known-by-design gaps remain in
`## Open questions` (e.g. the sort behaviour is read from code, not executed). Two catalogue
examples (rows 37, 38) are real modules but live in `ash/test/support`, not in a shipped
extension — flagged in the table itself.

### Round 4

Applied after the round-3 final check ([`notes/team-lead/reviews/ash-dsl-ext.md`](./reviews/ash-dsl-and-extensions-review.md),
"Round 3 final check", verdict **ACCEPT**). The review judged the mechanism sections correct
and listed only citation, naming and code-labelling errors. Every item below was verified in
source before editing; no mechanism, structure or wording was changed, and nothing was
shortened.

| # | Finding | What changed |
|---|---|---|
| 1 | Row 28c named a nonexistent module `Ash.Resource.ManualCreateFunction` | The real module is `Ash.Resource.ManualCreate.Function` (`manual_create_function.ex:5`, `use Ash.Resource.ManualCreate` at `:7`); the row now names it and its Read/Update/Destroy counterparts. |
| 2 | Row 28's example user was the contract itself (`Ash.Resource.Calculation`) | Replaced with a real implementer, `Ash.Resource.Calculation.Concat` (`use Ash.Resource.Calculation`, `calculation/concat.ex:5-7`). |
| 3 | Row 30 called `name/0` an `Ash.Extension` callback | Row 30 now states that `codegen/1` is an optional callback while `name/0` is **not** in the behaviour and is only probed with `function_exported?/3` (`extension.ex:21-44`, `ash.codegen.ex:63-67`) — the same fact row 34 already gave correctly. |
| 4 | Row 41 kept the stale citation `add_temporal_inline_attributes.ex:138-166` | Now `:140-175` (build/add `:140-169`, module matching `:171-175`), matching §5.3. |
| 5 | `AshArchival.Resource.Info` described as `use Spark.InfoGenerator, sections: [:archive]` | Full declaration quoted: `use Spark.InfoGenerator, extension: AshArchival.Resource, sections: [:archive]`. |
| 6 | Transformer callback specs cited `transformer.ex:52-56` and were reformatted | Block replaced with the verbatim source (`transformer.ex:60-68`, the return union broken over lines as in the source) and labelled verbatim. `__using__` citation corrected `:58-67` → `:70`. |
| 7 | Field-list citations | `section.ex:38-58` → `:33-54` (`@fields`); `entity.ex:62-82` → `:70-93` (`@fields`). |
| 8 | `{:spark, Ash.Resource}` cited at `domain/dsl.ex:165-168` | `:148`. |
| 9 | `simple_notifiers` cited at `resource.ex:38-41` | `:34-37`. |
| 10 | `identifier: {:auto, :unique_integer}` cited at `ash_state_machine.ex:26` | `:27`, in both §5.1 and catalogue row 5. |
| 11 | `Igniter.t()` struct and file-function citations | `defstruct` at `igniter.ex:33` (the old `402-434` are the `add_issue`/`add_warning`/`add_notice`/`add_task` helpers); `update_elixir_file` `:558`, `update_file` `:618`, `include_or_create_file` `:717`. |
| 12 | The verifier `cond` cited at `dsl.ex:518-556` | Now split correctly: `final_errors` at `:518`, the `cond` itself at `:521` running to `:556`. |
| 13 | `__spark_metadata__` cited at `entity.ex:388-397` (which is `maybe_apply_identifier`) | The metadata is written at `entity.ex:311-313`, and `%Spark.Dsl.Entity.Meta{}` is defined at `spark/lib/spark/dsl/entity/meta.ex:5`; §2.6 now cites both. |
| 14 | Map example presented as from the guide, with an invented `persist:` line | Replaced by the Ash guide's verbatim snippet (`writing-extensions.md:36-44`, which ends in `...`), with a note that the `persist` sub-map is real but not part of that snippet. |
| 15 | DslError `message/1` output was constructed and presented as real | Now labelled illustrative, composed from `dsl_error.ex:47-62`, with the tutorial's real location-free output (`get-started-with-spark.md:390-392`) quoted alongside. |
| 16 | Fragment example was invented | Replaced with the Spark guide's verbatim example (`split-up-large-dsls.md:25-44`, a `data_layer:` fragment), noting my earlier `extensions:` variant had the same shape. |
| 17 | `ash.codegen` loop simplified and showed `--name` appended unconditionally | Replaced with the verbatim body (`ash.codegen.ex:60-79`), which appends `--name` only when it is absent. |
| 18 | `transformers_to_run` shown without its `if transform? do … else [] end` wrapper | Wrapper restored; block is now verbatim (`extension.ex:693-702`) with a sentence on what the flag decides. |
| 19 | ash#2670 trace shown as a contiguous block | Labelled abridged, naming the omitted `Ash.BehaviourHelpers.call_and_validate_return/5`, `…ForbidUnless.__build__/5` and `lib/my_app/some_resource.ex:10: (module)` lines. |
| 20 | `Ash.Extension`'s `@optional_callbacks` collapsed onto one line | Expanded to the source layout and labelled verbatim (`extension.ex:21-44`, de-indented). |

**Left open after round 4.** Nothing. The `## Open questions` entries stand as written
(the sort behaviour is read from code, not executed). Note for a future round: the Round 3
log entry above still records `Ash.Resource.ManualCreateFunction` as row 28c's example; that
was the mistake this round corrected (item 1), and the entry is left as the historical record
rather than rewritten.

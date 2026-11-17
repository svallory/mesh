---
title: "0095. Surface files are read from their own folder; `fields=` names attributes, belongs-to and computed fields"
description: "Decision record 0095: how the build finds and checks surface files (a `surfaces` folder in mesh.config.ts, one folder per surface, `MESH_SURFACE_PATH`), what a surface file may import, what `fields=` may name, which duplicates are refused, and the model node. The manifest a reader takes (`#mesh/surfaces/<name>`), and the rule that a read listed on a surface filters, sorts and loads only by what it lets leave. Status: Proposed (lead ruling D41, pending operator review)."
---

# 0095. Surface files are read from their own folder; `fields=` names attributes, belongs-to and computed fields

## Status

Proposed (lead ruling D41, pending operator review). Builds the file kind [ADR-0077](./0077-surfaces-and-file-kinds.md) decided, as its action item asks ("the surface contract, view and manifest emitter in core"), in parts. This record holds what the parts built so far decide: where the build finds a surface file, what it checks, what the model records (decisions 1 to 7), the generated manifest with its read-input rule (decisions 8 to 10), and the JSON-RPC reader (decisions 11 and 12). A later pull request of the same unit (`publishes`) adds its decisions to this record.

## Date

2026-11-17

## Deciders

lead, delegated: ruling D41 of 2026-11-17 takes every recommendation of the reviewed surfaces design (open decisions OD1 to OD13; OD3 as option (b)); it waits for the operator's review with the other rulings of that run.

## Context

ADR-0077 makes a surface a file of its own, `surface :name` with `expose` and `action` lines, under `src/surfaces/<name>/`, and says the domain never imports one. It leaves open how the build finds that folder: the project configuration names only `domain`, which may be a folder, a glob or a list, so "beside the domain" has no single meaning, and [Project structure](../../docs/project-structure.md) says Mesh prescribes nothing under `src/`. It also leaves open which members `fields=` may name (an attribute is clear; a relationship and a computed field are not), what a surface file may import, and what a repeated line means.

## Decision

1. **A configured folder (OD1 (a)).** `mesh.config.ts` takes an optional `surfaces: "src/surfaces"`: one folder inside the project, never a glob or a list. The build reads every Mesh file under it as a surface file; the folder may hold none. A project without the key has no surfaces. A file that `domain` reads and that lies under the surfaces folder is a configuration error (`MESH_CONFIG`), checked by file, so a folder or glob `domain` that reaches the surfaces folder is refused and a list `domain` whose common parent holds it is not. `ignore` applies to surface files as to entity files.
2. **One folder per surface, and a new code for a file in the wrong place (OD2 (a)).** A surface file sits directly in the folder named after its surface (`src/surfaces/admin/admin.mesh.mx` for `surface :admin`). A `surface` root in a domain file, another root in the surfaces folder, and a surface file in a folder of another name are each `MESH_SURFACE_PATH`, and the file is not built. Two roots in a surface file are `MESH_DUPLICATE_ENTITY` at the second; two surfaces of one name are `MESH_DUPLICATE_ENTITY` too.
3. **`fields=` names an attribute, a `belongs-to` or a computed field (OD3 (b)).** A `belongs-to` is named as the entity file names it (`:author`), and its key column is what will leave; a computed field leaves when it is loaded. A `has-many` (with or without `through=`) or a `has-one` is `MESH_OPTION_VALUE` (OD13 (a)): a related record does not leave through a surface, and the audience reaches it through its own entity's expose line. Any other name is `MESH_UNKNOWN_MEMBER`. `fields=:all` is exactly that set; no `fields=` lets nothing leave.
4. **Duplicates are refused (OD4 (a)).** Two expose lines of one name, one entity exposed twice in one surface, and one action line twice under an expose line are each `MESH_DUPLICATE_MEMBER`.
5. **A surface file imports the domain's Mesh files only (OD5 (a)).** It holds no function, so a helper, a package or `meshfw` is `MESH_UNKNOWN_IMPORT`. An import of another surface file is `MESH_UNKNOWN_ENTITY`, as an import of a Mesh file outside the domain is.
6. **The domain never imports a surface (OD6 (a)).** A domain file that imports a surface file is `MESH_UNKNOWN_ENTITY`, the code an import outside the domain already had, with a message that says why. This stays an ordinary build error and is not an architecture rule ([ADR-0084](./0084-architecture-rules-are-core.md)).
7. **The model.** `ModelDocument.surfaces` (`Surface`, `Exposure`, `ExposedAction` in `@meshfw/model`) is present only when the project declares a surface, so a project without one keeps its `model.json` byte for byte. An exposure records the entity's FQN, the reference as written, the label when written, the fields as written (or `"all"`) and the action names.

8. **One manifest per surface (OD10 (a)).** `mesh build` writes `<output>/surfaces/<name>/index.ts`, which a project maps once as `"#mesh/surfaces/*": "./.mesh/surfaces/*/index.ts"`. It exports `surface`, frozen by `defineSurface` from `@meshfw/runtime`: the surface's name, per expose line the entity's FQN, its label (the exposed name when none is written), the record properties that leave (in the entity's declaration order, a `belongs-to` as its key column, so reordering `fields=` changes nothing generated), one `run(input, context)` per listed action, and `publishes`, empty until the `publishes` section is built. `run` calls the entity value's method with the caller's context, so every policy and check applies, and returns its result through `project`, which keeps only those properties. A reader imports the manifest and `@meshfw/runtime`, never the model (ADR-0077 decision 3). A project without surfaces gets no file. The folder leaves room for a reader's own generated files later, and the fixed export name needs no rule for a surface named like a reserved word.
9. **A listed read filters, sorts and loads only by what leaves (OD11 (a)).** Before the action runs, `checkRead` refuses a `filter` key at any depth of `and`/`or`, a `sort` key (with or without its `-`) that is not a property the line lets leave, and a `load` name that is not one of its listed computed fields: one `InvalidInputError` with an issue per name, code `not_exposed`, path `["filter", ..., name]`, `["sort", i]` or `["load", i]`. The generated input type is narrowed the same way. Without it, a caller who sees only `id` could recover any other attribute by bisection (`{ "filter": { "body": { "gte": "m" } } }`) and its order by `sort`. A write action's input passes unchanged: `fields=` governs what leaves, the action's own input and policies what it takes.
10. **The caller loads a listed computed field (OD12 (a)).** A computed field `fields=` lists is in a read's result only when the caller's `load` names it, and a write's when its `load=` step does; through a surface `load` takes only listed computed fields, so loading a relationship whose records would be dropped is refused instead of run.
11. **The JSON-RPC reader names a method `<exposed name>.<action>` (OD9 (a)).** `surfaceMethods(surface, { name? })` in `@meshfw/jsonrpc` builds a method table from a manifest: one method per action line, `tasks.complete` unless `name` maps it otherwise, each passing the request's `params` to `run` as the input and the call's context as the context, with no `params` schema, since the action casts its own input. Two actions that get one name, and a name that starts with `rpc.`, which JSON-RPC 2.0 reserves for the protocol, are a `FrameworkError` when the table is built (`expose :rpc` would otherwise give `rpc.read`, and `serve` does not refuse it). Core emits no JSON-RPC code: the adapter reads the manifest at run time (ADR-0077 decision 3).
12. **Hyper keeps its hand-written table (OD8 (a)).** Its methods call command functions, carry a protocol envelope (`commandId`, idempotency, the committed events folded into each result) and hand-shaped views, none of which a surface expresses; ADR-0077 decision 6 already keeps that envelope as application code.

## Options considered

1. A convention instead of a key (OD1 (b), a `surfaces` folder beside the domain root): no configuration, but a glob or list `domain` has no single "beside", and it surprises a project that already has a `surfaces` folder for something else.
2. Surface files anywhere under the domain, told apart by their root (OD1 (c)): they would share the domain's root, its module rules would apply to them, and "the domain never imports a surface" would be a rule between neighbours.
3. Enforce the place but not the folder name (OD2 (b)), or reuse `MESH_TAG_NOT_ALLOWED` and `MESH_MODULE_NAME` (OD2 (c)): the first leaves services, which ADR-0078 puts under `src/surfaces/<name>/services/`, without a reliable owner; the second misdescribes the mistake, since the tag is allowed and the place is not.
4. `fields=` names attributes only (OD3 (a)), or relationships too, each projected by its entity's expose line (OD3 (c)): the first hides a record's owner id from every client; the second needs a nested projection rule no spec sentence gives.
5. One entity under two names in one surface (OD4 (b)): the one case with a use, kept out because refusing it can be relaxed later and allowing it cannot be taken back.
6. The manifest as `<output>/surfaces/<name>.ts` exporting a constant named after the surface (OD10 (b)): `surface :delete` would export `delete`, a reserved word, and need a second name rule.
7. Let a listed read filter and sort by any field and document the leak (OD11 (b)), or narrow only the types (OD11 (c)): the first makes `fields=` no confidentiality boundary for any entity with a listed read; the second protects nothing on the wire, where an adapter passes the input as it came.
8. A surface read that loads every listed computed field itself (OD12 (b)), or a refusal of a computed field no listed action can load (OD12 (c)): the first evaluates them all on every read, a query per row for a rollup, and the read's result no longer matches the entity's own; the second refuses the common case, a read that loads.
9. Fixed method names with no `name` option (OD9 (b)), or names prefixed with the surface (OD9 (c)): the first makes a project with an existing protocol fork the adapter; the second repeats what the socket already tells apart. Moving Hyper to a surface (OD8 (b)) needs per-transport options and application wrappers the language does not have, on the example the 1.0 gate rests on.

## Trade-off analysis

Every choice here is the narrow one, and each can be widened later without breaking a project: a glob or a list for `surfaces`, a relaxed folder rule, related records in `fields=`, two names for one entity, more imports. The cost is one configuration key, one new code and an error a project meets when it puts a surface file where ADR-0077 did not.

## Consequences

- A file whose root is `surface` is no longer `MESH_UNKNOWN_TAG`: in a project without the key it is `MESH_SURFACE_PATH`. An `action`, `expose` (and, later, `publishes`) line in an entity file moves from `MESH_UNKNOWN_TAG` to `MESH_TAG_NOT_ALLOWED`, which names the tags allowed there.
- `surface`, `expose` and `action` are reserved tags.
- `@meshfw/runtime` exports `project`, `checkRead`, `defineSurface` and the manifest's types (`Surface`, `SurfaceExposure`, `SurfaceAction`, `Projected`, `SurfaceReadInput`). `mesh export generators` writes one more template, `surface.ts.jig`, for every project.
- A client of a surface cannot filter or sort by a field it may not see, and loads a related entity's records through that entity's own expose line.
- `mesh build` never deletes generated files: after a surface is removed, its `.mesh/surfaces/<name>/` stays until the developer deletes it, and `mesh build --check` reports it.

## Action items

- [x] The file kind: the `surfaces` key, the contracts, the checks above and `ModelDocument.surfaces`.
- [x] The generated manifest, `project` and `checkRead` in `@meshfw/runtime`, the user page.
- [ ] The `publishes` section.
- [x] `surfaceMethods` in `@meshfw/jsonrpc`.

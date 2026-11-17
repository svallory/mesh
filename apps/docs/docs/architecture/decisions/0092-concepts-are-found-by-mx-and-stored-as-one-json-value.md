---
title: "0092. Concepts are found by MX's scan, generated as a type and a schema, and stored as one JSON value"
description: "Decision record 0092: concept files live directly in folders named concepts, which MX scans; Mesh's tagFile hook turns each into the contract of a concept use; the compiler passes the scan to lowerSource; the field parents list no children; a concept is generated as a TypeScript type and a Zod schema and stored as one JSON value. Status: Accepted (lead ruling D36, pending operator review)."
---

# 0092. Concepts are found by MX's scan, generated as a type and a schema, and stored as one JSON value

## Status

Accepted (lead ruling D36, pending operator review). Builds the concept half of [ADR-0080](./0080-aggregates-and-concepts.md) on the discovery of [ADR-0085](./0085-tag-discovery-for-dialect-tags.md), and deviates from 0085's chosen option in one place (below). Concept files are built; a concept use (`Money :total`) is not built yet and is refused as `MESH_NOT_IMPLEMENTED`.

## Date

2026-11-17

## Deciders

lead, delegated (ruling D36 rules the eleven open decisions of the concepts design as it recommends).

## Context

A concept is a value with no identity and one or more fields (ADR-0080, decision 3), declared in a concept file, `concepts/Money.mesh.mx`, whose root line is `concept :Money` and whose children are field lines written as an event's. It is used as a PascalCase line head, `Money :total`, with no import: the nearest `concepts` folder up the file's folders wins (ADR-0085's amendment of 2026-10-17).

MX ships what ADR-0085 asked for (since MX `0.1.0-alpha.18`; Mesh pins alpha.37): the manifest keys (`tagDirs`, `tagExtensions`, `sidecars`, `reservedTags`), the scan that names a tag after each file of a declared folder, the synchronous `Dialect.tagFile` hook that turns a tag file into a contract the first time a use is lowered, and `DelegatedTag.definedIn`, the tag file a use resolved to. Three facts shape how Mesh uses them:

- `lowerSource` does not scan. A use is `MESH_UNKNOWN_TAG` until the scanned map is passed as `customTags`.
- A closed parent refuses a child its `children` does not list, and a `"*"` wildcard never claims a registered name; no contract can list the concepts of a project in advance.
- MX runs the hook of the dialect the tag file routes to, the module `meshfw`'s manifest names (`dist/dialect.js`), not the dialect object the compiler passes.

## Decision

1. **Where concept files are.** Directly inside a folder named `concepts` under the domain root: `meshfw`'s manifest sets `tagDirs: ["concepts"]` and `sidecars: false` (a `.tag.ts` there would run project code in every tool), and reserves `concept`. A `concept` file elsewhere, or any other root inside a `concepts` folder, is `MESH_CONCEPT_PLACE`; a use whose concept file the build does not read (outside the domain root, or excluded by `ignore`) is `MESH_CONCEPT_PLACE` at the use (OD4). The scan is not recursive, so `concepts/finance/Deep.mesh.mx` is never a concept. A project folder named `concepts` that holds entities, events or commands must be renamed.
2. **The hook.** `MESH_DIALECT.tagFile` (`front-end/concept-file.ts`) lowers the concept file and returns the contract of a concept use (its name, `nullable`, and `optional` in a command; OD6) or the file's problems, which MX reports at the file while each use is `MESH_TAG_FILE_ERROR`. The problems the file's tree alone shows are one function, `conceptFileProblems`, which the build calls too, so the editor and the build report the same ones: a name other than the file's or not PascalCase (`MESH_CONCEPT_NAME`), two roots, no field line (`MESH_MISSING_CHILD`, OD9), two fields of one name, a `__proto__` field, a date-family field (`MESH_CONCEPT_FIELD`: JSON keeps no `Date`, OD5). A concept that holds itself is MX's `MESH_TAG_FILE_CYCLE`.
3. **The compiler passes the scan.** `parseEntitySource` runs MX's `scanCached` and passes the scanned map to `lowerSource` as `customTags` (OD10, option (a), as an interim). This deviates from ADR-0085, which rejected "Mesh scans and passes `getCustomTags` itself" for discovery inside MX: MX built the scan and the hook but not the call from `lowerSource`. `parseEntitySource` is the one place to remove it if MX's `lowerSource` comes to scan the `tagDirs` of a dialect that declares them; the lead asks the MX lead. The scan takes a target lookup, which tells a host's module file from a tag template; a Mesh file is data under no host, so the compiler passes one that answers every question empty.
4. **The field parents are open.** `attributes`, `event`, `command` and `concept` declare no `children` (OD3, option (a)), built through one helper, `fieldParent`, so a unit that changes them keeps them open. Each field kind's `parents` keeps a misplaced line an error. The lead asks the MX lead for a `children` entry that admits a dialect's tag-file tags (option (c)); with it the parents close again.
5. **Identity.** A concept's module is the folder above its `concepts` folder (group folders dropped), and its FQN is the module and its name, as written: `billing.Money`, or `Money` at the domain root (OD8). Two concepts of one FQN, which a group folder's `concepts` beside its module's gives, are `MESH_DUPLICATE_ENTITY`, an exception to silent shadowing (OD11), as is a concept sharing its FQN with an entity, event or command. A concept file is never imported (`MESH_UNKNOWN_IMPORT`), and takes no import.
6. **Generated code.** Each concept is `<output>/domain/<module>/<name>.concept.ts`: a TypeScript type whose members are `readonly` (a concept value is replaced whole) and a `z.strictObject` schema (`moneySchema`) that satisfies it, both exported by the module's barrel. No concept ships with Mesh (OD2).
7. **Storage and expressions, for concept-typed members.** A concept member is stored as one JSON column (OD1): not filterable or sortable until JSON paths are translated, and a read inside it (`&total.amount`) runs as plain code, as a read inside a `json` value does (OD7). These come with concept-typed members, the next unit of this work.

## Options considered

The concepts design (`notes/architecture/concepts-design.md`, section 11) lists each decision's options and costs: one column per field instead of one JSON column; shipping `Email`; overriding the contracts per call or waiting for MX instead of opening the field parents; reading concept files outside the domain root; reviving dates inside a concept; a concept FQN that keeps its group folder.

## Consequences

- A project with no concept is unchanged: no `concepts` key in `model.json`, no generated file, the same barrels.
- Two codes change for every project, under the field parents only: a known line in the wrong one is `MESH_PARENT_NOT_ALLOWED` instead of `MESH_TAG_NOT_ALLOWED` (and MX reports every such line, not the first), and a tagless `&title` there is `MESH_UNKNOWN_TAG` instead of `MESH_TAG_NOT_ALLOWED`. An editor no longer completes from a closed list under those parents.
- A change to the hook takes effect only after `meshfw`'s `bun run build`, and a test that uses a concept needs a project on disk that depends on `meshfw`.
- The universal checks of the contracts do not reach a concept use, whose contract comes from a tag file and carries no `analyze` hook. MX refuses a tag variable, a bound option and a name that is no atom from the use's contract; tag parameters (`Money|x| :total`) are refused by the build alone (`MESH_SYNTAX`), so the editor does not show that one.
- The placement checks that need the domain root (a concept file outside a `concepts` folder, a use of one the build does not read), the import checks and the FQN clashes are the build's; the editor does not show them.
- New codes: `MESH_CONCEPT_NAME`, `MESH_CONCEPT_PLACE`, `MESH_CONCEPT_FIELD`.

## Action items

- [x] Concept files: manifest, contracts, hook, scan, model and generator (this record).
- [ ] Concept-typed members: a concept use as an attribute, an event, command or concept field; its record, input, validator and SQLite column; `set` literals; the expression rules.
- [ ] Lead: ask the MX lead whether `lowerSource` should scan a dialect's `tagDirs` (decision 3), for a `children` entry that admits tag-file tags (decision 4), and to confirm that `checkDialectFile` passes the scan for a routed dialect file.

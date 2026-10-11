---
title: "0085. MX discovers a dialect's tags from declared folders (target design)"
description: "Decision record 0085: a dialect manifest declares tag directories, extensions, sidecars and reserved tags; MX names a tag by its file name. A target design, not built. Status: Accepted (DOM-07)."
---

# 0085. MX discovers a dialect's tags from declared folders (target design)

## Status

Accepted as a target design. Nothing is built. Row: DOM-07.

## Date

2026-10-11

## Deciders

operator (Saulo Vallory), with MX, 2026-10-11 (the directory name at 09:08). The hook's design is worked out with MX's dialect squad, for any dialect and not only Mesh.

## Context

Concepts (and later other tags) should be files the user writes, not code in the Mesh repository. MX, as of 2026-10-11:

- `lowerSource` runs no discovery; the caller passes `getCustomTags`.
- Only `tags/x.tag.ts` or `tags/x.mx` defines a tag.
- A dotted basename such as `money.mesh.mx` is skipped.
- A `tags/` entry silently replaces an `mx.contracts` tag of the same name.

## Decision

- A dialect's static `mx.dialect` manifest declares `tagDirs` (scanned in the usual upward walk; Mesh's include `concepts`, and Mesh may add others), optional `tagExtensions`, whether its tags accept `.tag.ts` sidecars, and `reservedTags`.
- Scoping is MX's usual: per file, the nearest wins.
- A tag's name is its file name minus the claimed extension: `concepts/money.mesh.mx` is `money`.
- Overriding a reserved tag gets a positioned, branded diagnostic, never a throw.
- A generic, synchronous dialect hook turns a tag file into a contract.
- In the user docs, `concepts` is a folder Mesh loads by itself: concepts are found and loaded automatically, so you do not import them.

## Options considered

Mesh scans and passes `getCustomTags` itself (rejected: every dialect would redo it); an MX feature driven by the manifest (chosen); explicit imports of concept files ([ADR-0067](./0067-members-imports-input-static-files.md)'s way, kept for entities).

## Trade-off analysis

Discovery in MX serves every dialect and gives the same scoping rules, but it depends on MX work not yet scheduled. The facts above are why Mesh cannot do it alone today.

## Consequences

Concepts ([ADR-0080](./0080-aggregates-and-concepts.md)) wait for it. No existing record changes. The user docs describe the behaviour only when it is built.

## Action items

- [ ] MX lead: the manifest keys and the hook (with the MX dialect squad).

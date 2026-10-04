---
title: "0032. Docs site in the repository, decisions as ADRs"
description: "Decision record 0032: Docs site in the repository, decisions as ADRs. Status: Accepted."
---

# 0032. Docs site in the repository, decisions as ADRs

## Status

Accepted

## Date

2026-10-04

## Deciders

operator (Saulo Vallory)

## Context

Until now Mesh's design lived in `notes/`, a directory in the project's local working space rather than in the git repository. Briefs, handoffs, research, the rulings and the plan were therefore invisible to anyone reading the repository. The roadmap calls its own text a draft for the docs site ([roadmap](../roadmap/roadmap.md), section 0).

A decision record (ADR, architecture decision record) is a short document that states a decision, its context, the options weighed and the consequences, so a later reader does not re-propose a rejected option. The format used here comes from the `engineering:architecture` skill.

## Decision

The operator ruled on 2026-10-04, in "Rulings after the decision review" ([rulings of 2026-10-04](./rulings-2026-10-04.md)):

> **Docs site.** `apps/docs` in the repo, built with docmd (docmd.io). Two top-level sections: **Docs** (for users) and **Architecture** (for contributors: roadmap, every decision, overviews, in-depth pages, research results). Rule for Architecture: document everything that cannot be understood by looking at a single code file.

> **Architecture process.** The final architecture is designed following the `engineering:architecture` skill (decision records).

> **Research.** The research documents move into the docs site under Architecture / Research. The repo docs become the source of truth; `notes/` stops being it.

> **Docs deployment.** The docs site is deployed with Coolify on netcup at mesh.saulo.tech.

Where this stands: the site exists on `main` (docmd, in `apps/docs`), is reported live and public at https://mesh.saulo.tech (reported by the lead; not checked when this record was written), and the research is published under Architecture / Research. On the site, decision records use four-digit file names (`NNNN-short-title.md`); the drafts in `notes/adr/` use three digits and are renamed when they move.

The site is public. [ADR-0042](./0042-open-source-mit.md) records that nothing in it is private, so its content must contain no secrets, private paths or personal data. Any `.mx` example in the site uses concise syntax ([ADR-0041](./0041-mx-concise-syntax.md)).

## Options considered

### Option A: Docs site in the repository, built with docmd (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low to medium. A static site with hand-declared navigation. |
| Cost | Keeping pages current; the scaffold is done. |
| Durability | Docs travel with the code and history. |
| Visibility | Public by design ([ADR-0042](./0042-open-source-mit.md)). |

**Pros:** One source of truth, reviewed in pull requests. The site installs and builds with bun and produces static HTML, and `docmd validate` checks internal links. Roadmap principle 9 ties documentation to the pull request that changes a contract.
**Cons:** Navigation is declared by hand, so a page missing from the config is built but absent from the sidebar. docmd's maturity was not compared with other site generators (not checked). Everything in the repository is public, so notes need editing before they move.

### Option B: Keep `notes/` outside git

| Dimension | Assessment |
|-----------|------------|
| Complexity | None. |
| Cost | None to set up. |
| Durability | Lost with the machine; no history. |
| Visibility | Invisible to contributors. |

**Pros:** No clean-up for publishing; free to write rough drafts.
**Cons:** Contributors cannot see why anything was decided. This is the situation the ruling ends.

### Option C: A hosted wiki or notes tool

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low to start. |
| Cost | A service and its account. |
| Durability | Separate from code history; links rot. |
| Visibility | Depends on the service. |

**Pros:** Easy editing.
**Cons:** Documentation is not reviewed with the code. Not compared further; no research covers it.

## Trade-off analysis

Option A costs discipline and a public face. It buys one reviewed source of truth, which the roadmap relies on to cite ADRs by number. The rule "document everything that cannot be understood by looking at a single code file" keeps the Architecture section from copying what code already says.

## Consequences

- Easier: contributors read the whole design in one place; decisions carry their reasons.
- Harder: notes must be edited for a public audience, and the site must be kept current or it misleads.
- Revisit: docmd's fitness once the site holds the full set of decision records.

## Action items

- [x] M0: scaffold the site in `apps/docs` (done on `main`); deployment at https://mesh.saulo.tech reported live, to be confirmed before publishing.
- [x] M0: publish the research under Architecture / Research.
- [ ] M1: move the roadmap and these decision records into Architecture, renamed to four-digit file names.
- [ ] M1: review published pages for private paths and personal data ([ADR-0042](./0042-open-source-mit.md)).
- [ ] Every milestone: update the Architecture page in the same pull request.

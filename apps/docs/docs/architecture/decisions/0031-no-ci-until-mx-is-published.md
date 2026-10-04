---
title: "0031. No continuous integration until MX is published"
description: "Decision record 0031: No continuous integration until MX is published. Status: Accepted."
---

# 0031. No continuous integration until MX is published

## Status

Accepted

## Date

2026-10-04

## Deciders

operator (Saulo Vallory)

## Context

Continuous integration (CI) runs a project's checks automatically on a hosted machine for every change. Mesh has one script, `verify`, that runs every check: tests, the type check and, later, the guard that regenerates committed files and fails on a difference ([roadmap](../roadmap/roadmap.md), section 0 and principle 6).

Mesh reads its `.mx` resource files with MX, a separate project that parses Marko-syntax files. MX's two packages, `@mxlang/data` and `@mxlang/core`, are not published to a registry. Mesh consumes them from a local checkout with `bun link @mxlang/data @mxlang/core`, which writes `link:` entries into `package.json` and symlinks `node_modules` to a link checkout the MX maintainers keep (MX project notes, getting-started, section 2). The same note says `file:` paths do not work, because core is a `workspace:*` dependency of data. A hosted CI machine has no such local checkout. Mesh also pins nothing and follows MX's `main` (getting-started, section 5).

## Decision

The operator ruled on 2026-10-04, in "Rulings after the decision review", row "CI" ([rulings of 2026-10-04](./rulings-2026-10-04.md)):

> None until the MX lead says the `@mxlang` packages are published. The operator handles publishing with the MX lead.

An earlier ruling says the same: "Build and test locally; no CI until MX packages are published" (same file, "Implementation-plan rulings", row Q8). The quotation uses the ruling's own words: "the MX lead" there means the MX maintainers. `verify` runs locally.

## Options considered

### Option A: Wait for the MX packages to be published (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | None. |
| Cost | None to build; a review burden to maintain. |
| Reversibility | Complete. CI is added when the packages are published. |
| Risk | A skipped `verify` run is invisible. |

**Pros:** No workaround to build and remove; no divergence between how CI and developers resolve MX.
**Cons:** Nothing enforces `verify` except the review protocol (roadmap, M0 risks; section 9, risk 4). A regression can merge unnoticed. Because MX is consumed unpinned from `main`, a breaking MX change stops Mesh the same day, and no automated check notices (roadmap, section 9, risk 2).

### Option B: Self-hosted runner

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: a machine with the MX link set up and a runner agent. |
| Cost | A machine to maintain and secure. |
| Reversibility | Easy to remove. |
| Risk | Depends on one person's machine state. |

**Pros:** Would give automated checks now, with the link setup MX already documents.
**Cons:** Ruled out. The plan records that "the operator ruled out a self-hosted runner (plan ruling Q8)" ([plan revision 2 (superseded)](../roadmap/plan-revision-2.md), M0). The rulings file's own row Q8 does not mention the runner, so that detail rests on the plan's account alone.

### Option C: Vendor a tarball of MX in the repository

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium: build and commit an artifact, keep it current. |
| Cost | Repository bloat; manual refresh on each MX change. |
| Reversibility | Easy to delete. |
| Risk | Drifts from MX's `main`, which Mesh is meant to follow. |

**Pros:** Hosted CI would work.
**Cons:** Duplicates MX's work, and the sources do not show that MX or the operator considered it. This option is constructed here to complete the set (not found in the research or the rulings).

## Trade-off analysis

The operator chose to accept a visible, bounded gap over building a temporary substitute. The gap is narrow now: one package of code exists. It widens with every milestone, so the cost of waiting grows. The mitigation is discipline: `verify` as the single entry point and a review protocol that requires its output.

## Consequences

- Easier: M0 needed no CI setup.
- Harder: a missed `verify` run is silent. No hosted checks on pull requests.
- Revisit: when the MX maintainers report publication; the operator handles publishing with them.

## Action items

- [x] M0: `verify` is the one command that runs every check (done, PR #6).
- [ ] M1: have the review protocol require pasted `verify` output.
- [ ] After v1, or when MX is published, whichever comes first: replace `link:` entries with pinned versions and add CI running `verify`.

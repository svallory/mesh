---
title: "0100. The lock step"
description: "Decision record 0100: `lock &version` is an optimistic lock written in an update's or destroy's `do`: it adds the input field `expectedVersion`, compares it with the stored member right after the record-reading policies and before `validate`, reports a mismatch alone as the `expected-version` issue of an `InvalidInputError`, and an update writes the member plus 1. No data-layer change. Status: Accepted (lead ruling D43, pending operator review)."
---

# 0100. The lock step

## Status

Accepted (lead ruling D43, pending operator review). The `lock` step is built. The `relate` step, the other half of the same design, is recorded here once it is built. Amends [ADR-0053](./0053-validate-then-do.md), [ADR-0050](./0050-entity-file-syntax.md) and [ADR-0072](./0072-mesh-1-0-is-the-port-gate.md), each of which listed `lock` as planned and not shown to users.

## Date

2026-11-17

## Context

Hyper and the user docs kept a version by hand: an `integer :version` attribute, an `integer :expectedVersion nullable` argument, a `check` that compares the two and a `set &version=() => &version + 1` step. Six of Hyper's entities wrote that recipe in every action that changes them. The recipe needs an argument on each action, so a mixin or an `always` block cannot carry it, and it reports a stale call among the other rules, where Hyper's protocol checks the version first (`PROTOCOL.md:111`). [ADR-0053](./0053-validate-then-do.md) planned the step as `lock="version"`, the spelling of its day; [ADR-0066](./0066-names-and-references-are-atoms.md) later made every reference an atom or a `&member`, never a string. The run of 2026-11-17 (ruling D28) put the bead in scope, and the lead ruled the design's fourteen open decisions as it recommends (D43).

## Decision

1. **The form.** `lock &version` is a step: one member reference, optionally followed by the flag `optional`, at the top level of an update's or a destroy's `do`, or of an `always` block whose `types=` or `actions=` reach updates and destroys only. A value after the member or a second member is `MESH_SYNTAX`; `lock="version"` and `lock :version` are `MESH_UNKNOWN_OPTION`.
2. **The input field (OD 1 (a), OD 2 (c)).** The lock adds a derived input field, `expected` and the member's name with its first letter upper-cased (`expectedVersion`), typed `integer`: required, or optional and nullable with `optional`. It is not stored in the model's `Action.input`, which keeps what the author wrote; every consumer of an action's input computes it from the steps (`derivedInputs` in `model/derived-input.ts`): the generated input type and validator, the command check (`MESH_COMMAND_INPUT`), the expression typer (a check reading `input.expectedVersion`, and a named check whose referrer is locked, which is then no `MESH_CHECK_INPUT`) and `mesh explain`.
3. **When and how it fails (OD 3 (a), OD 4 (a)).** After the locked read (a missing row is `NotFoundError` first) and the policies that read the record, and before any `validate` check, a sent value other than the stored one (with `optional`, a non-null one) throws `InvalidInputError` with one issue: label `lock`, code `expected-version`, path `["expectedVersion"]`, `details` `{ expectedVersion, actualVersion }`, and the lock line as its source. No check runs and nothing is written. It is not retryable. The label is not null, because a null label is what a cast's shape issue carries, and a transport that tells shape from content (Hyper's RPC mapping) must see a content failure.
4. **The write.** An update the lock reaches writes the member as the stored value plus 1, beside the `on=:update` timestamps, after every step that runs before the write; those steps see the stored value. A destroy compares and deletes; a lock makes a destroy read its row.
5. **The rules.** `MESH_LOCK_STEP`: a lock in a create, under a step `when`, in an `always` block with no scope or one that covers a create (OD 5 (b)), and a second lock reaching one action. `MESH_LOCK_MEMBER`: a member that is not a required `integer` attribute other than the key, the member as an input of a locked action, and a `set` of it in a locked update, since the lock owns that write. `MESH_DUPLICATE_INPUT`: an authored input named like the derived field.
6. **No data-layer change.** Every update already reads its row with `selectByKeyForUpdate`, which holds the write lock until the transaction ends ([ADR-0072](./0072-mesh-1-0-is-the-port-gate.md): every update is read-then-write), so the comparison is made in memory on a row no other writer can change before the commit. If the atomic one-statement update of [ADR-0054](./0054-write-strategy-is-inferred.md) is ever built, a locked update stays read-then-write or translates the lock into `WHERE version = $expected`.
7. **Mixins (OD 6 (a)).** The mixin `Versioned` keeps its `set` bump; an entity that uses it and also writes `lock &version` gets `MESH_LOCK_MEMBER` at the mixin's `set`. Whether `Versioned` becomes a lock is the mixins unit's ruling.

## Options considered

1. The member's own name as the field (`version`, OD 1 (b)): it reads as "set the version" and collides with a member input. An option naming the field (OD 1 (c)) can be added later without breaking this one.
2. Required only (OD 2 (a)): no in-repo project could adopt the lock, since every Hyper version is optional on the wire. Optional only (OD 2 (b)): a lock any caller can skip, with no way to require it.
3. Reporting the version among the checks (OD 3 (b)) or at its written place among the steps (OD 3 (c)): a stale caller is told about rules on a row it has not seen, or fixes its input before learning it was stale.
4. A new error class (OD 4 (c)): a new public class in every transport mapping, where a subclass of `InvalidInputError` can still be introduced later.
5. An unscoped `always` block whose creates skip the lock (OD 5 (a)): a silent skip; relaxing the refusal later breaks nobody.

## Consequences

- `lock` is a reserved tag of `meshfw`'s dialect manifest, the only breaking part of the change.
- The model's `Step` union gains `{ kind: "lock", member, optional? }`; a project without a lock keeps its `model.json` and generated code byte for byte.
- Hyper's Workspace, Collaborator, Membership, Machine, SessionReference and Attempt use `lock &version optional`, and so does Run's `cancel`; Run's `settle`, which takes no expected version, keeps its own `set &version` bump, a legal neighbour since no lock reaches it. Task, Claim, Submission, Review and Dependency keep the recipe (a conditional bump, or another record's version).
- On those entities a stale call is now reported alone, before the other rules, and its issue's message is the lock's ("the record changed since it was read: version is N, and the call expected M") instead of the recipe's; the code `expected-version` and the `details` are unchanged, so Hyper's `-32002` answer keeps its shape and only the `failures[].reason` text changes.
- The user docs teach the lock and keep the recipe for a version compared among the rules.

## Action items

- [x] The `lock` step: contract, model, rules, derived input, generated code, `mesh explain`.
- [x] Hyper's identity and execution entities moved to it.
- [ ] The `relate` step (design PR 2).

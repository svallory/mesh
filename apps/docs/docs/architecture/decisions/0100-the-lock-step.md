---
title: "0100. The lock step"
description: "Decision record 0100: `lock &version` is an optimistic lock written in an update's or destroy's `do`: it adds the input field `expectedVersion`, compares it with the stored member right after the record-reading policies and before `validate`, reports a mismatch alone as the `expected-version` issue of an `InvalidInputError`, and an update writes the member plus 1. No data-layer change. Amended 2026-11-17: the `relate` step makes a has-many's rows follow a list the caller sends, through the related entity's own actions. Status: Accepted (lead ruling D43, pending operator review)."
---

# 0100. The lock step

## Status

Accepted (lead ruling D43, pending operator review). The `lock` step is built, and so is the `relate` step, the other half of the same design, recorded in the amendment below. Amends [ADR-0053](./0053-validate-then-do.md), [ADR-0050](./0050-entity-file-syntax.md) and [ADR-0072](./0072-mesh-1-0-is-the-port-gate.md), each of which listed `lock` as planned and not shown to users.

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

## Amendment, 2026-11-17: the `relate` step

The second half of the design (`notes/architecture/lock-relate-design.md`, PR 2, the same ruling D43) is built.

1. **The form.** `relate &tracks create=:add update=:rename destroy=:remove` is a step at the top level of a create's or an update's own `do`: one member reference and at least one of the three options, each an atom naming an action of the related entity. A string there is `MESH_OPTION_VALUE`.
2. **The input field.** It adds an optional derived input field named like the relationship, a read-only list, computed by `derivedInputs` like the lock's field and read by the same consumers (in the expression typer it is `any`, so `input.tracks.length` types). An item is a keyed item, the target's key plus the fields the `update=` action takes less the inverse `belongs-to` (the key alone without `update=`), or a new item, the fields the `create=` action takes less the inverse (none without `create=`), each a strict object with each field's own optionality, taken from the target's own planned input.
3. **The item schemas are printed inline.** The input type writes both objects in place, and the validator dispatches an item to its schema by whether it holds the key (`$relateItem` in the validators template), so a bad field is reported at `["tracks", i, "name"]` with its line rule's code, where a plain union would report the whole item. Nothing is imported from the target's types or validators file, so no import cycle between validators files can arise and a self-referencing has-many needs no special case.
4. **What runs (OD 7 (a), OD 9 (a), OD 10 (a), OD 12 (a), OD 14 (a)).** After the action's own row is written, in written order among the after-write steps, `relateRows` (`@meshfw/runtime`) reads the current children through the parent's load with the target's read policies, reports every unknown key (`not_related`) and repeated key (`duplicate`) in one `InvalidInputError` (label `relate`) before any call, then calls `destroy=` for each child the list leaves out, `update=` for each keyed item and `create=` for each new item with the inverse filled, each through the target's entity value with the caller's context unchanged. A list left out does nothing. A failed child call rolls back the parent and reaches the caller unchanged. The action returns its row read again by key. The actions file imports the target's entity value from its actions file; the value is read when a method runs, so an import cycle between actions files is safe.
5. **The rules (OD 8 (a), OD 11 (a), OD 13 (a)).** `MESH_RELATE_STEP`: no option, under a step `when`, in an `always` block, in a destroy, one relationship related twice, a member that is not a has-many, a has-many `through=` a link entity. `MESH_UNKNOWN_ACTION`: an option naming no action of the target. `MESH_RELATE_ACTION`: an action of another kind, a create that does not take the inverse, a create or update with a `relate` of its own (no nested lists), a destroy that takes a required input besides the key (a required lock field included). `MESH_DUPLICATE_INPUT`: an authored input named like the relationship.
6. **Consequences.** `relate` is a reserved tag of `meshfw`'s dialect manifest. A project that exported its generators (`mesh export generators`) re-exports them to use `relate`, since the actions template gained the entity-value imports and the validators template the item helper. The parent's checks and policies run before the write and see the children as they were; a limit on the list is written on the input. On a server database at `READ COMMITTED` a child inserted by another transaction between the relate's read and its calls is not seen; the M9 unit decides whether that read needs a lock. No example adopts the step.

## Action items

- [x] The `lock` step: contract, model, rules, derived input, generated code, `mesh explain`.
- [x] Hyper's identity and execution entities moved to it.
- [x] The `relate` step (design PR 2).

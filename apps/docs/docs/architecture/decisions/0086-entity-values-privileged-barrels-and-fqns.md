---
title: "0086. Entity values, `privileged`, barrels and FQNs: generated code follows modules"
description: "Decision record 0086: how actions are called and bound once nothing in Mesh's syntax is project-wide, what replaces the `actions` and `tx` handles, and how names leave the files. Status: Accepted."
---

# 0086. Entity values, `privileged`, barrels and FQNs: generated code follows modules

## Status

Accepted. Amends [ADR-0047](./0047-actions-are-bound-to-a-data-layer.md) (what `bind` returns), [ADR-0058](./0058-generated-code-in-mesh-imported-as-hash-mesh.md) (what `#mesh` exports), [ADR-0068](./0068-actions-compose-through-actions-and-tx.md) (points 1 and 3; the record is amended, not superseded), [ADR-0071](./0071-system-key-on-the-action-context.md) (how a nested call gets its context), [ADR-0074](./0074-write-policies-may-read-through-tx.md) (`privileged` in place of `tx`) and [ADR-0075](./0075-seams-use-the-extension-hosts-names.md) (the context a nested call's seams see). [ADR-0067](./0067-members-imports-input-static-files.md) is amended in one sentence. Settles [finding 21](../open-questions.md#dx-findings).

## Date

2026-10-12

## Deciders

operator (Saulo Vallory). The rulings are rows of the project's decision log, all of 2026-10-12: nothing is global in Mesh's syntax (PRJ-15), the shortened name is accepted on input only (PRJ-16), output is always the fully qualified name (PRJ-17), what an FQN is (PRJ-18), the binding method is `run` (PRJ-19), folder names (PRJ-20, PRJ-21), default tables (ENT-17), where `tables` is keyed (DAT-16), actions are called on their entity (CMP-16), one barrel per domain folder (CMP-18), generated classes and events (CMP-19, CMP-20), `privileged` (TXN-16 to TXN-18), the context of a nested call (TXN-19), the application's `transaction` (TXN-20) and the policy rule (POL-21). The choices the rulings leave open are in [Lead design, for operator review](#lead-design-for-operator-review); the rows still open (CMP-05, CMP-21, TXN-02, TXN-11, TXN-14) are marked where they appear.

## Context

Generated code held the whole project's actions in flat records: `actions` and `tx` in entity files, the application's `transaction`, and the object `bind` returned. So an action function's name (`completeTask`) had to be unique across the project, and two entities with the same name in two folders could not build ([finding 21](../open-questions.md#dx-findings)).

The operator ruled that nothing is global in Mesh's syntax: what a user writes in a `.mesh.mx` file or in code that Mesh generates for them never needs a name that is unique across the project. Generated code and the run time may keep registries of their own. He also ruled that an action is called on its entity (`Task.complete(…)`), that both handles go, and that a read without policies is `privileged(Task).read(…)`.

Prior art: Ash (`Ash.read!(Post)`), TypeORM (`manager.find(User)`) and MikroORM (`em.find(Book)`) pass the entity as a value and need no project-wide record. Where a library skips authorization it is a switch on the same read function (Ash's `authorize?: false`, MikroORM's `filters: false`), not a second handle.

## Decision

An entity is a value whose methods are its actions, imported from its folder's barrel. A call runs on the binding in scope (the innermost `run` or `transaction` of a binding, else the one `connect()` opened) and joins the running transaction through async context. Every call passes its own context. `privileged(Entity)` returns the entity's reads without policies. `bind(dataLayer, options)` returns a frozen `{ run, transaction }` and nothing else. Generated code has one barrel per domain folder, which the binding walks. Every name Mesh writes out is the fully qualified name, `work.Task`.

**Entity values (CMP-16).**
- `import { Task } from "#mesh/domain/work"` brings the value and the record type. An action is called on it: `Task.complete({ id }, context)`. The composed names (`completeTask`) and the `actions` handle go, and so do the `Actions`, `Reads`, `ReadOnlyActions` and `ReadOnlyReads` types and the generated `composition.ts`.
- `can` is asked on the same value (`Task.canComplete({ id }, context)`); its spelling is an open row (CMP-21).

**Nested calls (TXN-19; amends ADR-0071).** Code in a `run` step, a check, a `set` value or the application's `transaction` calls entity values directly. A nested call carries only the context it is passed: `await Claim.end({ id }, { ...context, system: true })` acts for the system and keeps the human `actor` on it. Nothing is inherited. A required context key therefore means that a call without a context does not compile ([ADR-0059](./0059-action-context.md)). The call joins the transaction and fails it as before. An entity call's cast failure inside a transaction marks it failed, even if the calling code catches it (TXN-02, an open row). `beforeTransaction` runs only for the call that opens the transaction, never for a nested call from an entity file or a call inside `transaction` (TXN-11, an open row).

**`privileged` (TXN-16, TXN-17, TXN-18).**
- `privileged<E>(entity: E): Privileged<E>` is exported by `#mesh` and is a registered function in `.mesh.mx`, like `isSystem`.
- It returns E's read actions, generated and custom. A read through it runs no read policy, neither the entity's nor those of the records it loads. It joins the running transaction and reads the running action's `now()`.
- The `tx` handle goes. Nothing is handed in its place to `run`, to checks, to `set`, to policies or to the application's `transaction(fn)`.
- A computed field that calls `privileged` is the build error `MESH_COMPUTED_COMPOSES`. Because a helper function could hide the call, `privileged` also throws a `FrameworkError` naming the field or policy when it runs while a computed field or a read policy is being evaluated.

**Policies (POL-21; keeps ADR-0074 and POL-20).** A policy check that calls `privileged`, or any function its entity file imports, counts as reading the record: it runs inside the transaction, after the locked read. This keeps the race ADR-0074 closed. The cost is that a check calling a pure imported helper also waits for the lock.

**Bindings (PRJ-19; amends ADR-0047).** `run(fn)` puts the binding in scope; `transaction(fn)` opens a transaction on it, or joins the running one. `connect()` is unchanged and backs a call made outside `run` and `transaction`; with none connected, such a call throws a `FrameworkError`.

**The application's `transaction` (TXN-20; withdraws TXN-06, rewords TXN-14).** `transaction(fn)` takes no context and hands `fn` nothing. A function declared elsewhere takes the context as a parameter, as Hyper's `attemptStart(input, context, binding)` does. The application's `transaction(fn)` is an outermost transaction, and `afterCommit` runs once with every change made inside it (TXN-14, an open row).

**Import cycles.** Import cycles between actions files are allowed, because no generated module reads an imported value while it loads.

**`#mesh` exports.** `bind`, `connect`, `disconnect`, `transaction`, `privileged` and `tables`, and the types `Binding` and `Privileged`. An entity is imported from its folder's barrel. The exact list is a lead reading of CMP-17, for operator review.

**Barrels (CMP-18; amends ADR-0058).** Each domain folder has one `index.ts`: its entities with their types and loaders, and one namespace per subfolder, also for a folder that holds only module folders. `.mesh/binding.ts` walks `import * as domain from "./domain"`. Two exports of one barrel with the same name are the build error `MESH_EMIT_NAME` naming both, checked per barrel: an entity and a subfolder namespace, two sibling folders that normalise alike, or generated types. No name is reserved. The full rule is an open row (CMP-05).

**Names.**
- **FQN (PRJ-18).** `[<package>:][<path>.]<Declaration>[#<member>]`: `work.Task`, `sales.billing.Invoice#pay`, `billing.InvoicePaid`, `meshfw:Email`. The path is the folder path as written, with dots.
- **Input is shortened (PRJ-16).** The CLI and other places a user types a name accept the shortest unambiguous tail: `Task` while only one entity has that name. An ambiguous name is refused with "Did you mean work.project.Task or school.homework.Task?".
- **Output is the FQN (PRJ-17).** Errors, diagnostics, the `entity` field of seams and errors, labels and the load plan carry it, so code comparing `change.entity` writes `"work.Task"`.
- **Nothing global (PRJ-15).** No name a user writes is unique project-wide. Generated code and the run time may keep registries.
- **Folders (PRJ-20, PRJ-21).** Folder names are free: letters, digits, `-` and `_`. In a barrel, the namespace replaces every character that is invalid in an identifier with `_` and puts `_` in front of a leading digit: `order-management` gives `domain.order_management`, `2024-reports` gives `domain._2024_reports`. The FQN and the import path keep the folder name as written. Two sibling folders that normalise alike are a build error naming both. A folder named like a reserved word needs no rule: `domain.class` and `domain.default` work.
- **Classes (CMP-19, CMP-20).** Everything generated as a class has a PascalCase name. Events are classes, and Mesh converts the declared name (`event :invoicePaid` is the class `InvoicePaid`). The FQN carries the class's name (`billing.InvoicePaid`). An FQN is exactly what one imports: the module path as written, the export as generated.
- **Tables (ENT-17, DAT-16).** An entity's default table is `snake_case(Name)`. Two entities on one table are a build error naming both by FQN, with a tip to set `table=`. `tables`, exported by `#mesh`, is keyed by the table name exactly as stored, `table=` included (`tables.claim`, `tables.late_result`), not by FQN. How schema exports are named is not decided here.

## Lead design, for operator review

The rulings above do not settle these choices. They are the lead's design, and the operator has not ruled on them.

- **The entity value.** A frozen object without a prototype, with its internals under symbols, so no action name is reserved. It is not a class. Its type is `EntityValue`, which carries the type of the entity's policy-free reads for `privileged` to return.
- **The call frame.** The run time keeps a frame in async context (`AsyncLocalStorage`) holding the binding in scope, the running transaction, the instant, the context and a label. An entity's method looks the binding up in the frame and runs the generated action.
- **Read-only results.** Results of entity calls and `privileged` reads are read-only inside an entity file and plain in an application's `run` or `transaction`. A call made after its transaction ended is refused with a `FrameworkError`.
- **`MESH_PRIVILEGED_ENTITY`.** The build error for a `privileged` argument that is not an entity the file declares or imports.
- **Re-keyed codes.** `MESH_POLICY_ACTS` is keyed on a call to an entity's action, and `MESH_LOAD_NO_POLICY` names `privileged`.
- **`privileged`'s optional context.** Each privileged read takes an optional `context`. It reaches only the computed fields the read loads, and it is never inherited from the running action (the rule of TXN-19).
- **The `#mesh` export list**, a reading of CMP-17.

## Options considered

1. **Keyed handles** (`actions.Task.complete`, `tx.Task.read`) built from each file's imports. Rejected by the operator (CMP-16, TXN-16).
2. **Entity values with explicit context, `privileged`, a binding in scope (chosen).**
3. **Entity values with the context inherited from the running action**, as `actions` did. It would make the context optional on every call and lose the compile-time requirement of [ADR-0059](./0059-action-context.md). Rejected by TXN-19.
4. **A tree of every module's functions on the binding** (`hyper.work.createTask`). It reaches every name without an import, which PRJ-15 removes.

## Trade-off analysis

Option 2 needs no project-wide name in user scope, gives an editor an import to follow for every call, and has the shape TypeScript ORMs without a registry use. It costs an async-context frame in the run time. The frame already exists in spirit: the data layer joins transactions through async context. It also costs a context argument on nested calls, which Hyper already writes on every nested call in its entity files. Option 3 saves the argument at the price of a run-time "no actor".

POL-21 costs a wait: a check calling a pure imported helper runs after the lock too, because the build cannot read what the helper reads. The alternative, running such a check before the lock, reopens the race ADR-0074 closed.

## Consequences

- Two entities with the same name in two folders build, bind and run side by side. A same default table is still an error naming both (ENT-17).
- Helpers no longer take a handle: a helper that reads calls `privileged` itself, and one that writes takes the context as a parameter.
- `Actions`, `Reads`, `ReadOnlyActions`, `ReadOnlyReads` and the composed functions (`completeTask`) leave the generated API.
- Entity names in seams, errors and the CLI's output are FQNs.

## Action items

- [ ] FQN in the model, the run time and the CLI.
- [ ] `tables` keyed by table name as stored.
- [ ] Entity values, barrels, `run`; the composed functions go.
- [ ] `privileged`; the `actions` and `tx` handles go.
- [ ] `MESH_EMIT_NAME` per barrel; a fixture with two same-named entities in two folders.

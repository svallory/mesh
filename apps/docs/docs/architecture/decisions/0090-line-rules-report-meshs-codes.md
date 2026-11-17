---
title: "0090. Line rules report Mesh's codes, carried by a generated wrapper"
description: "Decision record 0090: a value that breaks min, max or match fails with Mesh's standard code and message and the position of the line; the generated validators keep Zod's own checks and a generated wrapper marks each rule's issue. Status: Accepted (lead ruling D38, pending operator review)."
---

# 0090. Line rules report Mesh's codes, carried by a generated wrapper

## Status

Accepted (lead ruling D38, pending operator review). Amends [ADR-0028](./0028-validation-zod-behind-standard-schema.md) (a Standard Schema issue from a validator Mesh generated may carry one extension key, `meshRule`) and [ADR-0039](./0039-run-time-error-positions.md) (a line rule's issue carries the position of its line).

## Date

2026-11-17

## Deciders

lead, delegated: ruling D38 of 2026-11-17 takes every recommendation of the reviewed design of the `small-language` unit (its open decisions OD5 to OD8 are this record's); it waits for the operator's review with the other rulings of that run.

## Context

A line rule is `min`, `max` or `match` written on an attribute, argument or event or command field line (`string :title min=1 max=80`). The lead ruled on 2026-10-04 that a line rule produces "standard ones, fixed by Mesh: for example `min=1` on a string gives code `too_short` and the message "must be at least 1 character"" ([rulings of 2026-10-04](./rulings-2026-10-04.md)), and the [tutorial](../../docs/tutorial.md) prints that output. The code did not do it: the generated validator was `z.string().min(1)`, and the run time mapped every Standard Schema issue to `code: null`, `source: null`, so a caller got Zod's text ("Too small: expected string to have >=1 characters"), no code to branch on and no position.

A Standard Schema issue promises only `message` and `path`. The code and the position have to reach `@meshfw/runtime` some other way, and ADR-0028 keeps Zod's own API out of everything but generated files, so the run time cannot read Zod's issue fields itself.

## Decision

1. **Build the standard codes now** (OD5), with the table below (OD6). N is the bound as written; a string's bound counts characters as Zod counts them (Unicode code points).

   | Rule | Type | Code | Message |
   |:--|:--|:--|:--|
   | `min=N` | `string` | `too_short` | `must be at least N character` (N = 1), `must be at least N characters` |
   | `max=N` | `string` | `too_long` | `must be at most N character` (N = 1), `must be at most N characters` |
   | `min=N` | `integer`, `float`, `decimal` | `too_small` | `must be at least N` |
   | `max=N` | `integer`, `float`, `decimal` | `too_big` | `must be at most N` |
   | `match=/p/f` | `string` | `no_match` | `must match /p/f` |

2. **The carrier** (OD7): the generated validator keeps Zod's built-in `.min(N)`, `.max(N)` and `.regex(...)` checks, each given Mesh's message as its second argument, and a helper generated into the same file, `$ruled(schema, table)`, wraps the schema's `~standard.validate` and adds `meshRule: { code, source }` to an issue picked by its one-segment path and Zod's issue code. `issueOf` in `@meshfw/runtime` reads only that key, checks its shape and copies the code and position; any other issue keeps `code: null` and `source: null`. The helper skips the safe-integer range check of `z.int()` (issue origin `int`), which is no line rule.
3. **Event and command fields get the same codes** (OD8): their classes check fields with the same expressions, and the issue keeps the declaration suffix (`must be at least 0 (event billing.InvoicePaid)`).
4. A type error, a missing required field, an unknown key and the safe-integer check keep the validator's message with no code and no position: no ruling names a code for them.

## Options considered

1. Replace the built-in checks with opaque custom checks whose issues carry `meshRule`: the bounds would stop being data, so `z.toJSONSchema` of `z.string().min(1).max(80)` would lose `minLength` and `maxLength`, and a converter (the planned OpenAPI extension, an agent tool's schema, an HTTP adapter reading the schema) would lose every line rule.
2. Let the run time read Zod's issue fields (`code`, `origin`, `minimum`): breaks ADR-0028's condition for swapping the library and cannot carry the line's position.
3. Pass a table of rules from the generated action to `castInput`, matched by path and message: ambiguous once one custom message covers two rules of a line.
4. Built-in checks with Mesh's message plus the generated `$ruled` wrapper (chosen).

## Trade-off analysis

Option 4 keeps what passes exactly Zod's own check, keeps every bound and pattern visible to a schema converter, and keeps Zod's API inside generated files, where ADR-0028 allows it. It depends on Zod details that generated code may use but that can move (the `~standard` setter Zod 4.6.5 defines, the issue fields `code`, `format` and `origin`); a Zod upgrade that changes them makes line-rule issues uncoded again, which the tests that run a generated schema catch. A schema that someone composes into another (`z.object({ inner: createPostInputSchema })`) is a new schema without the wrapper, so its issues keep Mesh's message and lose the code and position; nothing in Mesh composes them.

## Consequences

- Every project with a line rule regenerates its validators; one without any regenerates byte for byte (the helper is printed only in a file that needs it).
- A caller that matched Zod's text breaks; the message is now Mesh's, and the code is the thing to match.
- Hyper's wire mapping tells a shape failure by `label === null` instead of `code === null`, since a line rule's issue now has a code.

## Action items

- [x] Standard codes, messages and positions for line rules (`feat/line-rule-codes`).
- [x] `message=` and `code=` on a line that carries a rule, replacing the standard ones (`feat/line-rule-text`, [ADR-0094](./0093-line-rule-message-and-code.md)).

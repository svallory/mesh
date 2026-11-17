---
title: "0093. A line rule's own message and code"
description: "Decision record 0093: message= and code= on a line that carries min, max or match replace Mesh's standard message and code for every rule of that line, as text only, on attribute, argument, event-field and command-field lines. Status: Accepted (lead ruling D38, pending operator review)."
---

# 0093. A line rule's own message and code

## Status

Accepted (lead ruling D38, pending operator review). Amends [ADR-0090](./0090-line-rules-report-meshs-codes.md): the standard code and message it fixes are what a line reports unless the line gives its own.

## Date

2026-11-17

## Deciders

lead, delegated: ruling D38 of 2026-11-17 takes every recommendation of the reviewed design of the `small-language` unit; its open decisions OD9 to OD11 are this record's. It waits for the operator's review with the other rulings of that run.

## Context

A line rule is `min`, `max` or `match` on an attribute, argument, event-field or command-field line (`string :title min=1 max=80`). Since ADR-0090 a broken one fails with Mesh's standard code and message (`too_short`, "must be at least 1 character") and the line's position. The spec said a custom message or code for a line rule was planned, and the lead's ruling of 2026-10-04 ([rulings of 2026-10-04](./rulings-2026-10-04.md)) said it was not v1. Nothing in the language could say it: `string :title min=1 message="..."` was MX's `MESH_UNKNOWN_OPTION`. A `check` already takes `code=` and `message=`, so the names exist.

## Decision

1. **Syntax** (OD9): `message="text"` and `code="text"` on the line, on the types that take a line rule (`string`, `integer`, `float`, `decimal`). Text only: a function, a number or an atom is `MESH_OPTION_VALUE`, blank text is `MESH_TEXT`, and on any other type the option is `MESH_UNKNOWN_OPTION`. One value covers every rule of the line; an option left out keeps the standard value of whichever rule failed, so `code=` alone keeps "must be at least 1" and `message=` alone keeps `too_short` or `too_long`.
2. **Where** (OD10): attribute, argument, event-field and command-field lines alike, as a field line "is written as an attribute line is". A computed line refuses them with the rest of its options (`MESH_COMPUTED_OPTIONS`).
3. **A line with no rule** (OD11): `message=` or `code=` on a line with none of `min`, `max` and `match` is `MESH_ATTRIBUTE_RULE` at the option's name, once per option: there is no rule whose report it could replace. It does not replace the message of a type error or a missing field.
4. **Model and generated code**: `Attribute.ruleMessage` and `Attribute.ruleCode` (inherited by `Argument`, picked by `Field`), present only when written, so a project that uses neither keeps its `model.json` and its `.mesh/` byte for byte. The generated validator gives each of the line's Zod checks the line's message, and the `$ruled` table of ADR-0090 gives each the line's code; nothing else changes.

## Options considered

1. Per rule: `min-message=`, `max-code=` and so on. Six option names for a need one pair covers; it can be added later without breaking the pair.
2. A function form, `message=({ value }) => ...`: a new scope and a translation question for a one-field rule; it can be added later as `check`'s was.
3. Refuse the options on event fields, whose failures a developer sees: a dedicated refusal and a field line that is no longer written as an attribute line is, for little gain.
4. A warning, not an error, for an option on a line with no rule: an error can be relaxed later, a warning cannot be tightened without breaking projects.
5. One pair on the line, text only, everywhere a line rule is (chosen).

## Trade-off analysis

The chosen form costs one message for `min` and `max` together. A line whose two bounds need two texts writes a `check` instead, which is what checks are for. Every choice here is the narrow one and can be widened later without breaking a project; none of the alternatives could be narrowed later without breaking one.

## Consequences

- An entity file may now carry `message=` and `code=` on a rule's line; a caller matches the code it chose.
- A line rule's message is no longer always Mesh's: a client that shows `message` shows the author's text.

## Action items

- [x] Contract options, model fields, `MESH_ATTRIBUTE_RULE` for a line with no rule, and the validator's use of the line's text (`feat/line-rule-text`).

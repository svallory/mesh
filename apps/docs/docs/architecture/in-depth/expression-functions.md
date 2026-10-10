---
title: "Expression functions"
description: "Every function and operator a translated expression may use, with its inputs and outputs, null cases included. The written definition of ADR-0012."
---

# Expression functions

This page is generated from the test data (`EXPRESSION_TABLES` and `QUANTIFIER_TABLES` in `@meshfw/runtime/testing`); a test fails when it is out of date. It is the written definition of [ADR-0012](../decisions/0012-expression-semantics.md), option A: Mesh defines each function, follows SQL's three-valued logic where the databases agree, and the in-memory form and every SQL evaluator must give these answers. How the rules are applied is in [Expressions](./expressions.md).

`null` is both NULL and an unknown boolean. `D(n)` is the instant `n` milliseconds after the epoch. `T` stands for one class of number, string, boolean, date or enum, the same on both sides.

Anything not listed here (string ordering, truthiness, `==`, string concatenation, string methods) is not translated: it stays plain TypeScript with JavaScript's rules, and the build warns.

## `a === b` (eq)

Signature: `(T, T) -> boolean`. Null behaviour: any operand null: unknown.

| Argument 1 | Argument 2 | Result |
|:--|:--|:--|
| `1` | `1` | `true` |
| `1` | `2` | `false` |
| `0` | `-0` | `true` |
| `1` | `null` | `null` |
| `null` | `1` | `null` |
| `null` | `null` | `null` |
| `"a"` | `"a"` | `true` |
| `"a"` | `"A"` | `false` |
| `""` | `null` | `null` |
| `"a"` | `"a "` | `false` |
| `true` | `true` | `true` |
| `true` | `false` | `false` |
| `false` | `null` | `null` |
| `"open"` | `"open"` | `true` |
| `"open"` | `"done"` | `false` |
| `"open"` | `null` | `null` |
| `D(5)` | `D(5)` | `true` |
| `D(5)` | `D(6)` | `false` |
| `D(5)` | `null` | `null` |

## `a !== b` (ne)

Signature: `(T, T) -> boolean`. Null behaviour: any operand null: unknown.

| Argument 1 | Argument 2 | Result |
|:--|:--|:--|
| `1` | `1` | `false` |
| `1` | `2` | `true` |
| `0` | `-0` | `false` |
| `1` | `null` | `null` |
| `null` | `1` | `null` |
| `null` | `null` | `null` |
| `"a"` | `"a"` | `false` |
| `"a"` | `"A"` | `true` |
| `""` | `null` | `null` |
| `"a"` | `"a "` | `true` |
| `true` | `true` | `false` |
| `true` | `false` | `true` |
| `false` | `null` | `null` |
| `"open"` | `"open"` | `false` |
| `"open"` | `"done"` | `true` |
| `"open"` | `null` | `null` |
| `D(5)` | `D(5)` | `false` |
| `D(5)` | `D(6)` | `true` |
| `D(5)` | `null` | `null` |

## `a === null` (isNull)

Signature: `(any) -> boolean`. Null behaviour: never unknown.

| Argument 1 | Result |
|:--|:--|
| `null` | `true` |
| `0` | `false` |
| `""` | `false` |
| `false` | `false` |
| `D(0)` | `false` |
| `"open"` | `false` |

## `a !== null` (isNotNull)

Signature: `(any) -> boolean`. Null behaviour: never unknown.

| Argument 1 | Result |
|:--|:--|
| `null` | `false` |
| `0` | `true` |
| `""` | `true` |
| `false` | `true` |
| `D(0)` | `true` |
| `"open"` | `true` |

## `a < b` (lt)

Signature: `(number | date, same) -> boolean`. Null behaviour: any operand null: unknown.

| Argument 1 | Argument 2 | Result |
|:--|:--|:--|
| `1` | `2` | `true` |
| `2` | `2` | `false` |
| `3` | `2` | `false` |
| `-1` | `0` | `true` |
| `1` | `null` | `null` |
| `null` | `1` | `null` |
| `null` | `null` | `null` |
| `D(5)` | `D(6)` | `true` |
| `D(6)` | `D(6)` | `false` |
| `D(6)` | `null` | `null` |

## `a <= b` (lte)

Signature: `(number | date, same) -> boolean`. Null behaviour: any operand null: unknown.

| Argument 1 | Argument 2 | Result |
|:--|:--|:--|
| `1` | `2` | `true` |
| `2` | `2` | `true` |
| `3` | `2` | `false` |
| `-1` | `0` | `true` |
| `1` | `null` | `null` |
| `null` | `1` | `null` |
| `null` | `null` | `null` |
| `D(5)` | `D(6)` | `true` |
| `D(6)` | `D(6)` | `true` |
| `D(6)` | `null` | `null` |

## `a > b` (gt)

Signature: `(number | date, same) -> boolean`. Null behaviour: any operand null: unknown.

| Argument 1 | Argument 2 | Result |
|:--|:--|:--|
| `1` | `2` | `false` |
| `2` | `2` | `false` |
| `3` | `2` | `true` |
| `-1` | `0` | `false` |
| `1` | `null` | `null` |
| `null` | `1` | `null` |
| `null` | `null` | `null` |
| `D(5)` | `D(6)` | `false` |
| `D(6)` | `D(6)` | `false` |
| `D(6)` | `null` | `null` |

## `a >= b` (gte)

Signature: `(number | date, same) -> boolean`. Null behaviour: any operand null: unknown.

| Argument 1 | Argument 2 | Result |
|:--|:--|:--|
| `1` | `2` | `false` |
| `2` | `2` | `true` |
| `3` | `2` | `true` |
| `-1` | `0` | `false` |
| `1` | `null` | `null` |
| `null` | `1` | `null` |
| `null` | `null` | `null` |
| `D(5)` | `D(6)` | `false` |
| `D(6)` | `D(6)` | `true` |
| `D(6)` | `null` | `null` |

## `a && b` (and)

Signature: `(boolean, boolean) -> boolean`. Null behaviour: Kleene.

| Argument 1 | Argument 2 | Result |
|:--|:--|:--|
| `true` | `true` | `true` |
| `true` | `false` | `false` |
| `true` | `null` | `null` |
| `false` | `true` | `false` |
| `false` | `false` | `false` |
| `false` | `null` | `false` |
| `null` | `true` | `null` |
| `null` | `false` | `false` |
| `null` | `null` | `null` |

## `a || b` (or)

Signature: `(boolean, boolean) -> boolean`. Null behaviour: Kleene.

| Argument 1 | Argument 2 | Result |
|:--|:--|:--|
| `true` | `true` | `true` |
| `true` | `false` | `true` |
| `true` | `null` | `true` |
| `false` | `true` | `true` |
| `false` | `false` | `false` |
| `false` | `null` | `null` |
| `null` | `true` | `true` |
| `null` | `false` | `null` |
| `null` | `null` | `null` |

## `!a` (not)

Signature: `(boolean) -> boolean`. Null behaviour: null stays unknown.

| Argument 1 | Result |
|:--|:--|
| `true` | `false` |
| `false` | `true` |
| `null` | `null` |

## `a + b` (add)

Signature: `(number, number) -> number`. Null behaviour: any operand null: null.

| Argument 1 | Argument 2 | Result |
|:--|:--|:--|
| `1` | `2` | `3` |
| `0.5` | `0.25` | `0.75` |
| `-1` | `1` | `0` |
| `1` | `null` | `null` |
| `null` | `null` | `null` |

## `a - b` (sub)

Signature: `(number, number) -> number`. Null behaviour: any operand null: null.

| Argument 1 | Argument 2 | Result |
|:--|:--|:--|
| `5` | `3` | `2` |
| `3` | `5` | `-2` |
| `null` | `3` | `null` |

## `a * b` (mul)

Signature: `(number, number) -> number`. Null behaviour: any operand null: null.

| Argument 1 | Argument 2 | Result |
|:--|:--|:--|
| `4` | `2.5` | `10` |
| `0` | `null` | `null` |

## `a / b (a float or decimal operand)` (div)

Signature: `(number, number) -> number`. Null behaviour: exact division; any operand null, or a zero divisor: null.

| Argument 1 | Argument 2 | Result |
|:--|:--|:--|
| `7` | `2` | `3.5` |
| `-7` | `2` | `-3.5` |
| `1` | `0` | `null` |
| `0` | `0` | `null` |
| `null` | `2` | `null` |
| `2` | `null` | `null` |

## `a / b (both integers)` (idiv)

Signature: `(integer, integer) -> integer`. Null behaviour: truncates toward zero; any operand null, or a zero divisor: null.

| Argument 1 | Argument 2 | Result |
|:--|:--|:--|
| `7` | `2` | `3` |
| `-7` | `2` | `-3` |
| `7` | `-2` | `-3` |
| `-7` | `-2` | `3` |
| `6` | `3` | `2` |
| `0` | `5` | `0` |
| `1` | `0` | `null` |
| `0` | `0` | `null` |
| `null` | `2` | `null` |
| `2` | `null` | `null` |

## `-a` (neg)

Signature: `(number) -> number`. Null behaviour: null: null.

| Argument 1 | Result |
|:--|:--|
| `3` | `-3` |
| `0` | `0` |
| `null` | `null` |

## `a.length` (length)

Signature: `(string | list) -> number`. Null behaviour: null string: null; a list is never null.

| Argument 1 | Result |
|:--|:--|
| `""` | `0` |
| `"abc"` | `3` |
| `"\u{e9}"` | `1` |
| `"e\u{301}"` | `2` |
| `"\u{1f600}"` | `1` |
| `null` | `null` |
| `[]` | `0` |
| `[{…}, {…}]` | `2` |

## `now()` (now)

Signature: `() -> date`. Null behaviour: never null; one instant per scope.

| Clock | Result |
|:--|:--|
| `D(1700000123456)` | `D(1700000123456)` |

## `today()` (today)

Signature: `() -> date`. Null behaviour: never null; now() at 00:00 UTC.

| Clock | Result |
|:--|:--|
| `D(1700000123456)` | `D(1699920000000)` |

## `a ?? b` (coalesce)

Signature: `(T, T) -> T`. Null behaviour: a unless a is null, else b.

| Argument 1 | Argument 2 | Result |
|:--|:--|:--|
| `1` | `2` | `1` |
| `null` | `2` | `2` |
| `null` | `null` | `null` |
| `0` | `5` | `0` |
| `""` | `"x"` | `""` |
| `false` | `true` | `false` |
| `null` | `false` | `false` |
| `D(1)` | `D(2)` | `D(1)` |

## `c ? a : b` (cond)

Signature: `(boolean, T, T) -> T`. Null behaviour: unknown test: the else branch.

| Argument 1 | Argument 2 | Argument 3 | Result |
|:--|:--|:--|:--|
| `true` | `1` | `2` | `1` |
| `false` | `1` | `2` | `2` |
| `null` | `1` | `2` | `2` |
| `true` | `null` | `2` | `null` |
| `false` | `1` | `null` | `null` |

## Quantifiers over a loaded has-many

`some`, `every`, `find` and `filter` take a list and a predicate. The column lists the predicate's result for each element, in order (`T` true, `F` false, `N` unknown); the elements are numbered from 0. An unknown predicate never makes `some` true and always makes `every` false; M10 translates `every(p)` as `NOT EXISTS (… WHERE p IS NOT TRUE)`. A list that was not loaded throws `FrameworkError`.

### `some`

| Predicate results | Result |
|:--|:--|
| `[]` | `false` |
| `[T, F]` | `true` |
| `[F, F]` | `false` |
| `[N, F]` | `false` |
| `[N, T]` | `true` |

### `every`

| Predicate results | Result |
|:--|:--|
| `[]` | `true` |
| `[T, T]` | `true` |
| `[T, F]` | `false` |
| `[T, N]` | `false` |
| `[N]` | `false` |

### `find`

| Predicate results | Result |
|:--|:--|
| `[]` | `null` |
| `[F, T, T]` | `1` |
| `[N, F]` | `null` |

### `filter`

| Predicate results | Result |
|:--|:--|
| `[T, F, N, T]` | `[0, 3]` |
| `[]` | `[]` |

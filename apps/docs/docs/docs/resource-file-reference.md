---
title: "Resource file reference"
description: "The tags a Mesh resource file may use today. Provisional."
---

# Resource file reference

::: callout warning "Live spec, not released"
This page describes how Mesh **will** work, not how it works today. It is a live spec of the developer experience, written before the code. Mesh is not released: nothing here can be installed or run yet, and any detail may change.
:::

::: callout warning "Provisional vocabulary"
These tags are the current draft of the Mesh resource-file vocabulary. They can change, be renamed or be removed without notice. Nothing reads these files yet except the parser's contract check.
:::

A resource file is a `.mx` file in Marko syntax, parsed by MX. Mesh chooses the tag names. The contracts in `packages/compiler/src/contracts.ts` describe each tag. They take effect when a file is parsed with `parseData` from `@mxlang/data` using the options `structural: "reject"` and `unknownTags: "reject"` (`packages/compiler/test/helpers.ts` shows the call). With those options, an unknown tag or a tag in the wrong place is rejected. Every contract is closed, so an attribute or child tag that is not listed here is an error.

The names are Ash's names in kebab-case with a trailing `?` dropped (`belongs_to` is `belongs-to`, `allow_nil?` is `allow-nil`). No tag or attribute name ends in `?`, and none contains `_`. Names you choose yourself (an attribute called `authorId`) and everything inside an expression are not vocabulary and stay as written. A default attribute, such as `resource="post"`, is written on the tag itself. Values Mesh reads statically must be literals. A bare identifier is rejected. The tags `change`, `validate`, `filter`, `authorize-if` and `value` are tags whose default attribute is a function.

Each file is expected to have one `resource` at the root. The contracts cannot express that, so a later stage will enforce it. Nothing does yet.

## resource

The root tag. Parent: file root.

| Attribute | Required | Meaning |
|:--|:--|:--|
| default (`resource="post"`) | yes | Resource name |
| `table` | no | Table name |
| `domain` | no | Domain the resource belongs to |

Children: `attributes` (required); `relationships`, `actions`, `policies`, `calculations`, `aggregates` (optional). Empty names are rejected.

## attributes

Container for the data fields. Parent: `resource`. Children: `uuid-primary-key`, `attribute` (repeatable), `create-timestamp`, `update-timestamp` (each at most once). It may be empty today; whether a resource needs an attribute is a later model rule.

### uuid-primary-key

Default attribute: the field name (required).

### attribute

| Attribute | Required | Meaning |
|:--|:--|:--|
| default | yes | Field name |
| `type` | yes | One of `string`, `integer`, `float`, `boolean`, `atom`, `uuid`, `datetime` |
| `constraints` | when `type` is `atom` | An object literal with `one_of`, the list of allowed strings (`constraints={ one_of: ["draft", "published"] }`). Not allowed for other types. `one_of` is non-empty, with no blanks and no repeats. No other constraint is known yet |
| `allow-nil` | no | Boolean. Nullable unless `allow-nil=false` |
| `public` | no | Boolean flag |
| `default` | no | Literal that fits `type`: an integer for `integer`, a number for `float`, one of `one_of` for `atom` |

### create-timestamp, update-timestamp

Default attribute: the field name (required), for example `create-timestamp="insertedAt"`. No other attributes.

## relationships

Container. Parent: `resource`. Children: `belongs-to`, `has-many` (both repeatable).

### belongs-to, has-many

| Attribute | Required | Meaning |
|:--|:--|:--|
| default | yes | Relationship name |
| `destination` | yes | Name of the related resource |

## actions

Container. Parent: `resource`. Attribute: `defaults`, a list of built-in actions to generate, each one of `create`, `read`, `update`, `destroy`, no repeats, not empty (`actions defaults=["read", "destroy"]`). Children: `create`, `update`, `read`, `destroy` (each repeatable).

### create, update, destroy, read

Each takes a default attribute (the action name, required). `create`, `update` and `destroy` also take `accept`, a list of attribute names without blanks or repeats (`accept=[]` is valid).

| Tag | Child tags |
|:--|:--|
| `create`, `update`, `destroy` | `change`, `validate` (repeatable) |
| `read` | `filter`, `sort` (each at most once), `validate` (repeatable) |

### change, validate, filter, sort

- `change`: default attribute is a function. Parents: `create`, `update`, `destroy`.
- `validate`: default attribute is a function; `message` is an optional non-empty string. Parents: `create`, `update`, `destroy`, `read`.
- `filter`: default attribute is a function. Parent: `read`.
- `sort`: default attribute is a non-empty list of field names, no blanks or repeats. Parent: `read`.

## policies

Container. Parent: `resource`. Child: `policy` (repeatable).

### policy

The default attribute is the policy's condition, required: a check call, or a non-empty list of check calls. A list of checks means **all** must match: `policy=[action_type("update"), action("publish")]` applies to the `publish` action when its type is `update`, not to either check as an alternative.

The checks are `action("publish")` (an action name) and `action_type("read")` (one of `create`, `read`, `update`, `destroy`). Each takes exactly one string literal or a non-empty array of string literals, with no blanks or repeats. A list argument means **any** listed name matches: `policy=action_type(["read", "destroy"])` applies to read or destroy actions; `action(["publish", "archive"])` matches either named action. This follows [Ash 3.34.0's built-in checks](https://github.com/ash-project/ash/blob/v3.34.0/lib/ash/policy/check/built_in_checks.ex). The call names are JavaScript identifiers, so they keep Ash's underscore. Needs at least one `authorize-if` child.

### authorize-if

Default attribute is a function. Parent: `policy`.

## calculations

Container. Parent: `resource`. Child: `calculate` (repeatable).

### calculate

| Attribute | Required | Meaning |
|:--|:--|:--|
| default | yes | Calculation name |
| `type` | yes | The attribute types except `atom` |

Needs one `value` child, a tag whose default attribute is a function.

## aggregates

Container. Parent: `resource`. Child: `count` (repeatable).

### count

| Attribute | Required | Meaning |
|:--|:--|:--|
| default | yes | Aggregate name |
| `relationship-path` | yes | Name of the relationship to count |

## Source

The authoritative definition is `packages/compiler/src/contracts.ts`, with its behaviour pinned by `packages/compiler/test/contracts.test.ts`. If this page and the file disagree, the file wins; please fix the page.

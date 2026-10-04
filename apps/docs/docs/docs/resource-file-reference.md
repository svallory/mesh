---
title: "Resource file reference"
description: "The tags a Mesh resource file may use today. Provisional."
---

# Resource file reference

::: callout warning "Provisional vocabulary"
These tags are the current draft of the Mesh resource-file vocabulary. They can change, be renamed or be removed without notice. Nothing reads these files yet except the parser's contract check.
:::

A resource file is a `.mx` file in Marko syntax, parsed by MX. Mesh chooses the tag names. The contracts in `src/contracts.ts` describe each tag. They take effect when a file is parsed with `parseData` from `@mxlang/data` using the options `structural: "reject"` and `unknownTags: "reject"` (`test/helpers.ts` shows the call). With those options, an unknown tag or a tag in the wrong place is rejected. Every contract is closed, so an attribute or child tag that is not listed here is an error.

A default attribute, such as `resource="post"`, is written on the tag itself. Values Mesh reads statically must be literals. A bare identifier is rejected. The tags `change`, `validate`, `filter`, `authorize-if` and `value` are tags whose default attribute is a function.

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

Container for the data fields. Parent: `resource`. Children: `uuid-primary-key`, `attribute` (repeatable), `timestamps`. It may be empty today; whether a resource needs an attribute is a later model rule.

### uuid-primary-key

Default attribute: the field name (required).

### attribute

| Attribute | Required | Meaning |
|:--|:--|:--|
| default | yes | Field name |
| `type` | yes | One of `string`, `number`, `boolean`, `enum`, `uuid`, `datetime` |
| `values` | when `type` is `enum` | List of allowed strings. Not allowed for other types. Non-empty, no blanks, no repeats |
| `required` | no | Boolean flag |
| `public` | no | Boolean flag |
| `default` | no | Literal that fits `type`. For `enum`, one of `values` |

### timestamps

No attributes.

## relationships

Container. Parent: `resource`. Children: `belongs-to`, `has-many` (both repeatable).

### belongs-to, has-many

| Attribute | Required | Meaning |
|:--|:--|:--|
| default | yes | Relationship name |
| `resource` | yes | Name of the related resource |

## actions

Container. Parent: `resource`. Children: `defaults` (at most once); `create`, `update`, `read`, `destroy` (each repeatable).

### defaults

Default attribute: a list of built-in actions to generate, each one of `create`, `read`, `update`, `destroy`, no repeats. Not empty.

### create, update, destroy, read

Each takes a default attribute (the action name, required). `create` and `update` also take `accept`, a list of attribute names without blanks or repeats.

| Tag | Child tags |
|:--|:--|
| `create` | `change` (repeatable) |
| `update` | `change`, `validate` (repeatable) |
| `destroy` | `change`, `validate` (repeatable) |
| `read` | `filter`, `sort` |

### change, validate, filter, sort

- `change`: default attribute is a function. Parents: `create`, `update`, `destroy`.
- `validate`: default attribute is a function; `message` is an optional non-empty string. Parents: `update`, `destroy`.
- `filter`: default attribute is a function. Parent: `read`.
- `sort`: default attribute is a non-empty list of field names, no blanks or repeats. Parent: `read`.

## policies

Container. Parent: `resource`. Child: `policy` (repeatable).

### policy

Takes `action` (an action name) or `action-type` (one of `create`, `read`, `update`, `destroy`). Exactly one of the two is required. Needs at least one `authorize-if` child.

### authorize-if

Default attribute is a function. Parent: `policy`.

## calculations

Container. Parent: `resource`. Child: `calculate` (repeatable).

### calculate

| Attribute | Required | Meaning |
|:--|:--|:--|
| default | yes | Calculation name |
| `type` | yes | The attribute types except `enum` |

Needs one `value` child, a tag whose default attribute is a function.

## aggregates

Container. Parent: `resource`. Child: `count` (repeatable).

### count

| Attribute | Required | Meaning |
|:--|:--|:--|
| default | yes | Aggregate name |
| `relationship` | yes | Name of the relationship to count |

## Source

The authoritative definition is `src/contracts.ts`, with its behaviour pinned by `test/contracts.test.ts`. If this page and the file disagree, the file wins; please fix the page.

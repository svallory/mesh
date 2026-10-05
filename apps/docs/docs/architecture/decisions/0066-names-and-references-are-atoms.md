---
title: "0066. Names and references are atoms"
description: "Decision record 0066: an entity file writes every name, reference and fixed-set value as an atom (`:name`), and a string only for text. Status: Accepted."
---

# 0066. Names and references are atoms

## Status

Accepted. Amends [ADR-0050](./0050-entity-file-syntax.md) (the line shape) and [ADR-0051](./0051-mesh-mx-files-and-the-mesh-host.md) (what Mesh needs from MX). The user docs ([Entities](../open-questions.md)) and every `mx` sample on this site were rewritten to it on the same day.

## Date

2026-10-05 (evening)

## Deciders

operator (Saulo Vallory). The three points marked *the lead's choice* below were decided by the lead under the operator's delegation and may be overruled.

## Context

Three facts forced the decision.

**MX has atoms.** MX decision 156 adds an atom to the language: `:name`, a name that stands for itself and is not a string. The published packages do not parse one in a value yet (see Consequences), but the direction is MX's and Mesh writes its entity files in MX.

**The operator ruled that Mesh uses them for every name.** On 2026-10-05 evening, having read the user docs, the operator ruled that Mesh adopts MX atoms and uses them for every declaration name, every reference and every fixed-set value, and wrote the docs' approval as conditional on it.

**The name sugar Mesh already had was the wrong sigil.** [ADR-0050](./0050-entity-file-syntax.md) named a declaration with `#name`, MX's id shorthand, and ruled in the same breath that `:name` "is not used in entity files". That is now reversed. `#name` is gone; `:name` is the only way to name a thing, which is also the sigil the `check` label already used.

Why it matters: a string can be anything, so `accept=["title"]`, `accept=[title]` and `accept=[userInput]` are the same token to a reader and only one of them is right. An atom is one kind of thing, so the vocabulary can say which options take names, which take enum values and which take text, and Mesh can check a name against the declarations it has read, at that line, with a suggestion.

## Decision

An entity file writes **`:name` for a name, an atom for anything chosen from a fixed set, and a string only for text**.

| It is | Written | Examples |
|:--|:--|:--|
| The name of a declaration | `kind :name` | `entity :Invoice`, `uuid :id`, `update :pay`, `policy :staffWrites`, `check :invoiceIsSent` |
| A reference to something declared | an atom, or a list of atoms | `accept=[:number, :amount]`, `require=[:dueOn]`, `sort=[:dueOn]`, `load=[:customer]`, `actions=[:pay]`, `on:load=:visible`, `belongs-to=:Customer` |
| One of a fixed set | an atom | `auto=[:read, :destroy]`, `types=[:create, :update]`, `on=:create` |
| An enum value | an atom | `values=[:draft, :sent]`, `default=:draft`, `self.status === :sent`, `:status=:paid` |
| Text | a string | `table="invoices"`, `message="…"`, `code="invalid_state"` |
| A path through relationships | a string | `of="lines.amount"`, `of="lines"` |
| A pattern, a number, a boolean | as in TypeScript | `match=/^INV-\d+$/`, `min=0`, `default=false` |

The rules that follow, which the user docs state where each one applies:

1. **`#name` is gone.** There is one way to name a thing: `:name`.
2. **A string where a name is expected is an error** (`accept=["title"]`), and so is an atom where text is expected (`message=:oops`).
3. **A name is checked.** `accept=[:titel]` is an error at that position, with a suggestion, in the editor and in `mesh build`.
4. **Names in these positions are written out.** A variable or an expression there is an error, because Mesh reads the file without running it. Functions — a `filter`, a `that`, a `set` value — are ordinary TypeScript and may use anything.
5. **At run time an atom is its name as a string**: `todo.status === "sent"` in TypeScript, `self.status === :sent` in the entity file.
6. **A comment is a `//` line indented with the block it belongs to** (unchanged from [ADR-0050](./0050-entity-file-syntax.md)).
7. **The language is MX**, not Marko: the docs say "MX syntax" and link nothing external.

### The lead's choices inside the ruling

- **A relationship's destination is an atom too**: `belongs-to=:Customer :customer`. *(Chosen by the lead: a bare `Customer` would read as a TypeScript variable that needs an import.)*
- **`of=` stays a string**, for `count` as well as for `sum`: it is a path, and a path with one step should not be spelled differently from a path with two. *(Chosen by the lead.)*
- **Error codes stay strings**: `code="invalid_state"`. They are text the caller receives, not names declared in the file. *(Chosen by the lead.)*

## Options considered

### Option A: atoms for every name and every fixed-set value (chosen)

**Pros:** one sigil for names; the vocabulary can check a name against the declarations it has read; a string where an atom belongs is a build error rather than a lookup that quietly finds nothing; the syntax is MX's own rather than an id shorthand borrowed from a different purpose.
**Cons:** the published MX packages do not parse an atom in a value yet; a name in one of these positions cannot be computed, which removes `accept=[acceptedFields]` and similar.

### Option B: keep `#name` and strings, and check names where they appear

**Pros:** everything parses today; a name may be an expression.
**Cons:** a string and a name look the same, so the vocabulary cannot say which option holds what; this is the state the operator rejected, and it leaves the error only at build time with no language-level distinction to lean on.

### Option C: `#name` for declarations, atoms for values

**Pros:** a smaller change to the docs.
**Cons:** two sigils for one idea, which is what [ADR-0050](./0050-entity-file-syntax.md) ruled out when it wrote "one sigil only".

## Trade-off analysis

Option A costs Mesh one thing it will want anyway — an MX that parses atoms — and it buys the property the operator ranked first: an agent editing an entity file, and a person reading it, can tell a name from text without consulting the reference. Option B is cheaper today and ambiguous forever.

## Consequences

- **Easier:** a name is one kind of thing, so "does this entity have that attribute?" is a question the compiler can answer at the line where it is asked, and `mesh build` can suggest the right spelling.
- **Harder:** a variable or an expression in a name position is now an error. `accept=[acceptedFields]` cannot be written. The compiled-module design that would lift this — entity files generated into a module that can hold a computed list — is the **target**, not the v1 answer, and it is only worth designing when MX2 exists and can parse the shape it needs.
- **The published MX packages do not parse atoms yet** (`@mxlang/data` 0.1.0-alpha.2, `@mxlang/tree-sitter-mx` 0.1.0-alpha.1). Measured on the reference file: `parseData` reads `kind :name` after a tag (it arrives as the tag's `name` attribute) and rejects an atom in a value — `accept=[:number]`, `auto=[:read]`, `types=[:read]`, `load=[:customer]`, `sort=[:dueOn]`, `require=[:id]`, `values=[:draft]`, `default=:draft`, `on=:create`, `on:load=:visible`, `belongs-to=:Customer`, `:status=:sent` and an atom inside a function body (`self.status === :sent`). The tree-sitter grammar reads all of those; the one line it cannot read is the tagless `:field=value` in a `set`. The Docs checks normalise those spellings in memory before they parse, and the docs highlighter has one allowance for the tagless `set` line; both are listed on [open questions](../open-questions.md) as owed to MX and are removed when Mesh pins the alpha that parses atoms (MX decision 156).
- **What stays Mesh's own check.** MX parses the file and hands back a tree; these are Mesh's, because they need the model Mesh built from every file, and none of them is something a grammar can decide:
  - a reference to a declaration that does not exist, in any file: `accept=[:titel]`, `belongs-to=:EntityThatIsNotThere`, `load=[:missing]`;
  - `on:load=:name` naming a read the entity does not declare;
  - an `enum`'s `default=` not being one of its `values=`;
  - an attribute and a computed field sharing a name.
- **The docs' vocabulary check still has teeth.** `packages/compiler/test/repository-checks.ts` normalises the spellings MX cannot read and then really parses every Docs fence with `parseData`; `apps/docs/test/docs-mx-syntax.test.ts` requires the root of every `mx` and `mx-figure` fence to be `entity :Name`, so an old-syntax fence such as `entity #Todo` or `accept=["title"]` fails the build.

## Action items

- [ ] Realignment task: the contracts, fixtures and the model read atoms; `normaliseV3` in `packages/compiler/test/repository-checks.ts` and `withAtomSetLines` in `apps/docs/plugins/mx-highlight.js` are deleted with the pin of the MX alpha that parses atoms (MX decision 156).
- [ ] MX2: revisit the compiled-module design that would allow a name to be computed.
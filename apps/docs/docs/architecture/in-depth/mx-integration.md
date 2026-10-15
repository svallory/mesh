---
title: "The contract between Mesh and MX"
description: "What Mesh gives MX, what MX gives Mesh, who checks each rule, what is still open, and the tests that hold each side to the contract."
---

# The contract between Mesh and MX

This page is the contract between Mesh and MX, the language project that parses Mesh's entity files (DOC-13). Mesh's lead wrote Mesh's side: sections 1 and 2, Mesh's rows of section 4 and Mesh's items in section 5. MX's lead wrote MX's side: section 3, MX's rows of section 4 and MX's items in section 5, checked against MX's code. A change on either side is checked against this page, so that a broken promise is found in review rather than by a broken build. A change that alters a statement here updates the page in the same pull request.

::: callout info "Versions this page describes"
`@mxlang/core` `0.1.0-alpha.27`, IR version 4. Statements marked "planned (alpha.28)" describe the next MX release, which is planned and not shipped. Section 5 lists everything still open on either side.
:::

## Why there is a contract

MX is core to Mesh, not an adapter: nothing replaces it, and there is no front-end slot or front-end package (MX-09, [ADR-0043](../decisions/0043-mx-is-core.md)). The two projects are built by different teams on different release cycles. This page states what each side gives the other and what each may rely on.

The division is simple. MX owns the parser, the lowered tree and the dialect mechanism. Mesh owns its syntax, its vocabulary and what a file means (MX-10, [ADR-0049](../decisions/0049-vocabulary-is-meshs-own.md), [ADR-0067](../decisions/0067-members-imports-input-static-files.md)). Nothing in an entity file is evaluated to produce declarations: Mesh reads the tree MX returns.

### Terms

- **Entity file.** A `.mesh.mx` file that declares one entity, written in MX's concise syntax ([ADR-0041](../decisions/0041-mx-concise-syntax.md), [ADR-0051](../decisions/0051-mesh-mx-files-and-the-mesh-host.md)). Every line is `kind :name options` ([ADR-0050](../decisions/0050-entity-file-syntax.md)): `entity :Invoice`, `string :number unique`, `belongs-to :customer entity=Customer`.
- **Tag.** MX's unit of structure. Each line of an entity file is a tag; `kind` is the tag's name, and indentation nests tags.
- **Option and attribute.** In Mesh, an option is a `key=value` on a line (`entity=Customer`), and an attribute is an entity's data member (`string :number`). MX's API calls a `key=value` an "attribute" (`Attr`, `CustomTag.attributes`, `MX_UNKNOWN_ATTRIBUTE`). Where this page quotes MX's API, "attribute" is MX's word and means an option.
- **Tag contract.** An MX `CustomTag`: the options, children and parents a tag allows. MX checks every tag against its contract while it parses.
- **Dialect.** An MX `Dialect` value: the syntax table, the tag contracts, the hooks and the strictness settings for one kind of file. Mesh's is `MESH_DIALECT`.
- **Syntax row.** An entry of a dialect's syntax table. It tells MX's parser what a piece of text means (`&` starts a member, `:` an atom, `%.` a transaction value) and which hook lowers it. MX calls a row that fires a trigger.
- **Hook.** A function the dialect gives MX, which MX calls at a fixed point: `lowerTrigger` when a row fires, `afterLower` after the file is lowered, a contract's `analyze` for its tags.
- **Lowered tree, or IR.** What `lowerSource` returns: MX's intermediate representation of a file, a tree of tags with their options, positions and parsed expressions.
- **Span.** The start and end offsets of a node's authored text in the file.
- **Atom and member.** `:name` is an atom, a name or a fixed-set value ([ADR-0066](../decisions/0066-names-and-references-are-atoms.md)). `&name` is a member reference, a read of the entity's own member ([ADR-0067](../decisions/0067-members-imports-input-static-files.md)).
- **Diagnostic code.** The stable identifier of an error or a warning: `MX_*` in MX's catalogue, `MESH_*` in Mesh's.
- **alpha.N.** MX's pre-release `0.1.0-alpha.N` of `@mxlang/core`.
- **Citations.** Row IDs such as MX-05 and SYN-21 are rows of Mesh's decision table, cited as the decision records cite them. "MX decision N" is a decision in MX's own record, and a slug such as `dialect-tag-shorthands-off` is an item of MX's TODO list. Both appear only in section 5, where they track open work.

## 1. Versions and changes

- **Exact pins.** Mesh depends on `@mxlang/core` by exact version in [`packages/compiler/package.json`](https://github.com/svallory/mesh/blob/main/packages/compiler/package.json). The root [`bunfig.toml`](https://github.com/svallory/mesh/blob/main/bunfig.toml) resolves the `@mxlang` scope from the pre-release registry, `https://npm.saulo.tech` ([contributing](../contributing.md#dependencies-and-the-registry)). The docs site's highlighter, `@mxlang/tree-sitter-mx`, is pinned on its own. Nothing resolves a range, so an MX release reaches Mesh only when Mesh moves the pin.
- **When Mesh moves.** Mesh moves to a new alpha only when the MX lead sends its number. The move is one pull request, and `bun run verify` must pass on CI ([ADR-0031](../decisions/0031-no-ci-until-mx-is-published.md), [continuous integration](../contributing.md#continuous-integration)). Any change the move causes in a golden file or a generated tree is reported to the MX lead, not accepted silently.
- **Requests.** Mesh asks the MX lead for anything it needs that MX does not export, by name (MX-01). The request becomes an item in MX's TODO list. Mesh code that waits on an item names it in a comment, and the workaround goes when the item ships.
- **Vocabulary.** Every change to Mesh's vocabulary (a tag added, renamed or removed) is announced to the MX lead (MX-08).
- **Unpublished MX.** A contributor may link a local MX checkout to test an unpublished commit, but never commits the link ([contributing](../contributing.md#what-exists-today)).

## 2. What Mesh gives MX

### 2.1 The dialect

Mesh gives MX one deep-frozen `Dialect` value, `MESH_DIALECT`, in [`front-end/dialect.ts`](https://github.com/svallory/mesh/blob/main/packages/compiler/src/front-end/dialect.ts). Its id is `mesh` and its name is `Mesh`. MX validates a frozen dialect once and caches it, and validates an unfrozen one on every call (3.1): 3 ms against 46 ms, as measured for Mesh's test corpus ([`test/mesh-corpus.ts`](https://github.com/svallory/mesh/blob/main/packages/compiler/test/mesh-corpus.ts)).

| Field | Value | Why |
|:--|:--|:--|
| `tagRules` | `"none"` | Every tag in a Mesh file is Mesh's, so HTML's rules (`input` is void, `script` holds text) never apply. Project config cannot override it (MX-11). |
| `contracts` | `MESH_CONTRACTS`, one closed contract per tag of Mesh's vocabulary | The editor and the build check a file against the same vocabulary (MX-15). |
| `structural`, `unknownTags`, `imports` | `"reject"`, `"reject"`, `"pass"` | A Mesh file holds tags, options and imports only. Control flow, text and unknown tags are errors. |
| `diagnosticCodes` | `MX_TO_MESH_CODES` | Every MX code a Mesh file can produce reaches the user as a `MESH_*` code (2.5, MX-05). |
| `table` and `nodeTypes` | Mesh's own syntax rows, in [`front-end/syntax/`](https://github.com/svallory/mesh/tree/main/packages/compiler/src/front-end/syntax) | `kind :name`, `:name` atoms in every position, `&name` members, `%.now` and `%.today` (SYN-29), and the `atom-value` row with the `Atom` node type (MX-12). There are no `#id` or `.class` rows. The value row names its node as `{ type: "Atom", dialect: "mesh" }`, so the id must stay `mesh`. |
| `tagShorthands` (in the syntax table) | `false`, planned (alpha.28) | A dotted line head, such as `billing.InvoiceVoided`, is one name (SYN-21). |
| Hooks | `lowerTrigger`, `contractFields`, `checkContract`, `describeAttribute`, `afterLower`, `explainUnknownTag` | `lowerTrigger` builds the nodes of `&name`, `:name` and `%.name`. `contractFields`, `checkContract` and `afterLower` claim and check the atom contract keys `values`, `pattern`, `ref` and `declares` ([`syntax/atoms-sugars.ts`](https://github.com/svallory/mesh/blob/main/packages/compiler/src/front-end/syntax/atoms-sugars.ts)). `explainUnknownTag` reports a name written against its kind (`uuid:id`) as `MESH_UNSPACED_NAME`. |

The contracts are in [`front-end/contracts.ts`](https://github.com/svallory/mesh/blob/main/packages/compiler/src/front-end/contracts.ts). Every contract is closed (no option, child or option tag beyond those it lists), and every value Mesh reads statically is `literalOnly`, since a static tree has no scope in which an identifier could be evaluated. Function options (`that=`, `authorize-if=`, a `set` value) and method bodies are code, so they are the exception. Names and fixed-set values are options of type `atom`, member references options of type `member`. The attribute types a body may list come from the registry in `@meshfw/model`, so the contracts and the model cannot disagree ([ADR-0037](../decisions/0037-vocabulary-source-of-truth.md)).

Rules a declaration cannot express go in a contract's `analyze` hook, which MX runs for the contract's tags. Mesh's hooks refuse an entity reference that is anything but an identifier or one plain member of one (`MESH_ENTITY_REFERENCE`), a rollup `of=` that is not a member path (`MESH_ROLLUP_PATH`), and a check's `message=` that is blank text or neither text nor a function. One hook wraps every contract and refuses parameters, a tag variable and `:=` (`MESH_SYNTAX`) and a function option written as anything but a function (`MESH_EXPRESSION`).

A Mesh hook reports through `ctx.fail(message, { at, code })` with a `MESH_*` code, never through a message prefix. A hook that throws is a defect in Mesh, and MX reports it as `MX_DIALECT_HOOK_ERROR` (3.6).

### 2.2 Registration

`meshfw`'s [`package.json`](https://github.com/svallory/mesh/blob/main/packages/cli/package.json) declares `mx.dialect`, the manifest MX's tools read to find the dialect (MX-02, MX-11, MX-15). Only `meshfw` claims the id `mesh` and the `.mesh.mx` extension.

| Manifest field | Value |
|:--|:--|
| `id`, `name` | `mesh`, `Mesh` |
| `extensions` | `MESH_EXTENSIONS` (`.mesh.mx`), the one list in [`front-end/extensions.ts`](https://github.com/svallory/mesh/blob/main/packages/compiler/src/front-end/extensions.ts). |
| `module` | `./dist/dialect.js`: plain JavaScript that `bun run build` and `prepare` bundle from `MESH_DIALECT` ([`scripts/build-dialect.ts`](https://github.com/svallory/mesh/blob/main/packages/cli/scripts/build-dialect.ts)). MX refuses a TypeScript module, and loads the file in whatever runtime hosts it, so it must be JavaScript Node can load. The build fails when `id`, `extensions` or `module` drift. |
| `mxConfigTags` | `false`: a project's `mx.tags` and `mx.contracts` never reach a Mesh file. A contracts module named in `mx.contracts` would not reach one either. |
| `tagDirs` | `[]`: MX's generic `tags/` directory is closed to Mesh files. When concepts are built, it lists Mesh's concept directory (DOM-07, [ADR-0085](../decisions/0085-tag-discovery-for-dialect-tags.md)). |
| `reservedTags` | Every key of `MESH_CONTRACTS` (45 names), so a project definition of a Mesh tag is `MESH_RESERVED_TAG`. MX applies it to routed files only: in its tools, and in `lowerSource` called without an explicit `dialect` (3.3). The compiler passes the dialect and no `customTags`, so the list has nothing to guard on that path. |

A project that depends on `meshfw` directly has its `.mesh.mx` files routed to this dialect by MX's discovery. User projects carry no `mx` key (MX-11). `@meshfw/compiler`'s `package.json` has no `mx` key either: the contracts travel on the dialect.

### 2.3 The call

The compiler makes one MX call, `parseEntitySource` in [`front-end/build.ts`](https://github.com/svallory/mesh/blob/main/packages/compiler/src/front-end/build.ts):

```ts
lowerSource(source, file, { dialect: MESH_DIALECT })
```

- It passes the dialect and nothing else: no `customTags` (which would silently replace the dialect's contracts), no strictness option and no `tagRules`. The editor therefore checks a Mesh file exactly as the build does.
- Mesh runs no project scan, so it calls neither `checkDialectFile` nor `diagnosticCodesOf` (3.7).
- `meshDiagnostic`, in the same file, turns each MX diagnostic into a Mesh one. It keeps `severity`, `code`, `message`, `line`, `column` and `offset`, and places the diagnostic in the parsed file. It drops `end`, `fixes` and `file` (section 5).
- The test helper and the docs checks parse through the same function (section 6).

The compiler's front end, `packages/compiler/src/front-end/`, turns the tree into the model and is the only code that imports `@mxlang/*`. The TypeScript back end reads the model only, and `model`, `runtime` and generated code never import MX ([ADR-0076](../decisions/0076-compiler-front-end-and-back-end-are-separate.md)).

### 2.4 What Mesh promises

1. **Never re-parse `.mx` text** (MX-07, MX-13). The lowered tree is the semantics; two parsers would disagree about one file. Mesh never rewrites text before MX parses it, and never reads meaning from `Expr.code`. The one use of text is slicing a function's authored text at its MX span, to emit plain code ([ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md)).
2. **Match diagnostics by code**, never by message text.
3. **Never change documented syntax to route around an MX bug** (MX-06). Mesh reports the bug to the MX lead and filters the symptom until MX fixes it.
4. **List every `@unstable` MX API Mesh uses:** `lowerSource` with `LowerSourceResult`, `IrDiagnostic`, `SpannedIr` and `IR_VERSION`; `MX_DIAGNOSTIC_CODES`; `Dialect` and every field 3.3 marks as used by Mesh (`table`, `tagRules`, `structural`, `imports`, `unknownTags`, `contracts`, `nodeTypes`, `lowerTrigger`, `afterLower`, `contractFields`, `checkContract`, `describeAttribute`, `explainUnknownTag`, `diagnosticCodes`); `NodeType`, `LoweredUnit` and `UnknownTag`; `MxAtomMark`; the contract fields `CustomTagAttribute.values`, `pattern` and `ref`; and the syntax table's `tagShorthands` (planned, alpha.28). Before MX changes one of them, the MX lead tells the Mesh lead. Section 3.8 lists everything MX marks `@unstable`.
5. **Design against what MX will be** (MX-13). Mesh does not hardcode MX's current limits into its language. Where Mesh waits on MX, section 5 lists it.

### 2.5 Mesh's names for MX's codes

Mesh's dialect renames every MX code a Mesh file can produce to a `MESH_*` code (MX-05; `MX_TO_MESH_CODES` in [`front-end/diagnostic-codes.ts`](https://github.com/svallory/mesh/blob/main/packages/compiler/src/front-end/diagnostic-codes.ts)), so a Mesh user sees Mesh's codes only, in the build and in the editor alike. The rule is that `MX_X` is `MESH_X` (`MX_UNKNOWN_TAG` is `MESH_UNKNOWN_TAG`), so MX's catalogue still explains a code, with MX's "attribute" (`ATTRIBUTE`, `ATTR`) read as Mesh's "option": `MX_UNKNOWN_ATTRIBUTE` is `MESH_UNKNOWN_OPTION`, and an MX attribute tag is an option tag. An MX code for a mistake Mesh already reports under its own code takes that code, and an MX word that means something else in Mesh takes Mesh's word:

| MX code | Mesh code | Why |
|---|---|---|
| `MX_INVALID_ATTRIBUTE_VALUE` | `MESH_OPTION_VALUE` | The code of Mesh's own option value checks. |
| `MX_DUPLICATE_ATTRIBUTE` | `MESH_DUPLICATE_OPTION` | A repeated option; MX warns and keeps the last (3.5). |
| `MX_DUPLICATE_DECLARATION` | `MESH_DUPLICATE_IMPORT` | In an entity file every module binding is an import. MX does not check module scope under `tagRules: "none"` (3.5), so on a Mesh file Mesh's own check reports it. |
| `MX_INVALID_BOUND_ATTRIBUTE`, `MX_INVALID_TAG_VAR`, `MX_INVALID_TRIGGER_USE` | `MESH_SYNTAX` | Mesh's syntax rows and contracts already refuse `:=`, a tag variable and a misplaced `&x` or `%.x` as `MESH_SYNTAX`. |
| `MX_NOT_IN_DATA_FILE` | `MESH_NOT_IN_ENTITY_FILE` | Mesh calls the file an entity file. |
| `MX_INVALID_CONFIG`, `MX_IGNORED_CONFIG` | `MESH_INVALID_MX_CONFIG`, `MESH_IGNORED_MX_CONFIG` | In Mesh's codes `CONFIG` is `mesh.config.ts`; these are about `package.json#mx`. |
| `MX_FRONT_END_INTERNAL` | `MESH_PARSER_INTERNAL` | Mesh's front end is the first half of its compiler. |

Four codes stay MX's (`MX_KEPT_CODES`), since each points at a bug in MX or in Mesh's dialect, not at the file: `MX_INTERNAL_ERROR`, `MX_DIALECT_HOOK_ERROR` (a hook that threw), `MX_DIALECT_ERROR` and `MX_DIALECT_WARNING` (a hook's error or warning that gave no code). A dialect that fails to load renames nothing, and a hook's own code is never renamed. `MESH_SYNTAX` is also the fallback `meshDiagnostic` gives a diagnostic with no code, which MX never produces (3.2).

## 3. What MX gives Mesh

### 3.1 `lowerSource`

```ts
lowerSource(source: string, filename: string, options?: LowerSourceOptions): LowerSourceResult
lowerFile(path: string, options?: LowerSourceOptions): LowerSourceResult // reads the file; throws only if the read fails
```

`lowerSource` parses, lowers and checks a file, and returns core's IR. Its options (`LowerSourceOptions`, all `@unstable`):

| Option | Meaning | Default |
|---|---|---|
| `dialect` | A `Dialect`, or a bare syntax table. Omitted, the file is routed by its extension to an installed dialect. | routed |
| `customTags` | Extra contracts. With an explicit `dialect`, they override the dialect's `contracts`; only core's own names are refused. | none |
| `tagRules` | The tag-rules preset. | the call's, else the dialect's, else `"html"` |
| `structural` | `"reject"` makes text, `${}`, `<if>`/`<for>`/`<const>` and `import`/`export`/`static` positioned errors. Comments are never structural. | the call's, else the dialect's, else `"pass"` |
| `imports` | Whether a top-level `import` passes. | the call's, else the dialect's, else the effective `structural` |
| `unknownTags` | `"reject"` makes every tag with no contract an error. | the call's, else the dialect's, else `"allow"` |
| `defaultTag` | What `<#id>` and `<.class>` stand for. | `object` |
| `stripTypes` | Strip TypeScript from expressions before hooks see them. | `true` |
| `warnings` | A sink for core warnings, whose codes are not renamed. | none |

A caller's option overrides the dialect's, which is why Mesh passes none (2.3).

**Result.** `LowerSourceResult` is `{ ir: SpannedIr | undefined; diagnostics: IrDiagnostic[] }`.

- Any error means `ir: undefined`. There is no partial IR.
- Warnings come back with the IR: a duplicate option returns the IR and a `MESH_DUPLICATE_OPTION` warning.
- The IR is the caller's own copy, and every span in it is checked before it is returned.

**Every independent error is reported.** All diagnostics are positioned, sorted by position, with a cause placed before its cascade. A file with three independent mistakes gives three diagnostics in one run:

- every parse error, since the parser recovers: two broken expressions give two parse errors (`MESH_PARSE_EXPRESSION` under Mesh's dialect);
- every contract error on independent tags: a missing required option, a bad enum value and an unknown option in one file give three errors;
- every unknown tag under `unknownTags: "reject"`;
- every structural hit under `structural: "reject"`.

The one exception: a tag that fails its own lowering, such as one a closed `children` refuses, is skipped with its subtree. Errors inside that subtree are reported once the refusal is fixed; its siblings are still checked.

**It never throws.** A hook that throws, an invalid explicit dialect, malformed source and a bad `diagnosticCodes` map all come back as diagnostics, and so does a dialect that fails to resolve. An error with no position is reported at 1:0, its message prefixed `internal error: ` for a bug in MX and `unpositioned error: ` for an error in the input.

**Determinism is not promised.** Two calls with the same source, filename and dialect gave byte-identical results in one process. MX states no guarantee, across processes or across releases.

**Caching.** An explicit dialect is validated once and cached by identity only when it is deep-frozen; an unfrozen one is validated on every call. Syntax tables are interned by a content hash (`syntaxHash`). A routed dialect module is cached per file modification time, and a failed load stays cached until the module changes. The merged contracts map is memoized. MX keeps no other state between calls that its lead knows of; this is unverified beyond these caches.

### 3.2 The lowered tree

**IR version.** `IR_VERSION`, exported by `@mxlang/core`, is `4`. It is a constant, not a field of the tree. It goes up by one with every change a reader could observe: a node kind or field added, removed, renamed or given a new meaning. MX's tests pin a hash of the IR's type declarations, so a change of shape fails MX's CI until the number goes up; a change of meaning alone relies on its author to bump it. Mesh fails when the installed version is not the one it reads (section 6).

**The types Mesh reads**, all exported by `@mxlang/core`:

- `SpannedIr` (also `Spanned<T>`): `Ir` with every `span` required at every depth. `Ir` has `imports`, `body`, `hoisted`, `inputInterface`, `needsAttrTagImport`, `prelude`, `tagMetadata`, `exportName` and `returnValue`.
- In `ir.body` Mesh reads `DelegatedTag` nodes (`{ kind, tag, loc }`); in `ir.imports`, `Import` (`code`, `bindings`, `from`, `names`, `typeOnly`, `span`).
- `DelegatedTag`: `name`, `nameSpan`, `span`, `trigger` (`{ id, span, text }`, set on a tag a dialect row built, such as a tagless member line), `alias` (on a wildcard child), `attrs`, `args` (always present, `[]` without arguments), `children`, `attributeTags`, `attributeTagTree`, `attrTagProps`, `params`, `var` and `data`.
- `Attr`, MX's word for an option: `static` (`value`, `valueSpan`, `nameSpan`, and at most one of `atom`, `member` or `node`), `boolean`, `dynamic` (`value`, an `Expr`), `bound`, `event` or `spread`; each with `span`, `sugar`, `sugarValueOf` and `args`.
- `Expr`: `code`, `shape`, `node` (the Babel node), `span`, `file`, `atoms`, `unrewrittenCode`, `bodySpan` and `bodySource`. `code` is the authored text at `span`, not a reprint: spacing and comments survive. Each dialect trigger in it is replaced by what it lowered to, so `&status === :sent` has the code `self.status === "sent"`. A shorthand `id` or `class` with a placeholder has the template literal core built. An option written as a method shorthand has a printed `function` expression, with triggers lowered and spacing not kept, and `bodySource` keeps its authored block with the triggers as written. With `stripTypes` on (the default), a top-level `as`, `!`, `satisfies` or `<T>x` is not in `code`: `span` and `code` are the operand's. Two `ctx.expression` values from one trigger are spliced twice (section 5). Mesh reads `node` and the span, never `code` (2.4).

**Spans.**

- A span is a `SourceSpan { sourceStart, sourceEnd }`: file-absolute UTF-16 code-unit offsets, end exclusive.
- Under `SpannedIr` every node's `span` is present. `DelegatedTag` and `AttributeTag` carry `nameSpan`, a `DelegatedTag` carries `args`, a static option carries `valueSpan`, and an `Import` carries `from` and `names`. `bodySpan` and `paramSpans` stay optional.
- An option a contract's `default` added has an empty `span`, `nameSpan` and value span at the end of the tag name. The empty span is how a reader tells it from an authored one.
- A contract's `transform` hook may emit tags; MX returns them with their spans, but with no `nameSpan`, since they have no authored name, and they skip the unknown-tag check. Mesh uses no `transform`.
- These fields are opaque and carry no span: `node`, `paramNodes`, `declaration`, `data`, `loc`, `end` and `tagMetadata`.
- A dynamic option's `value.span` never covers a wrapper. `attr.span` already reaches past `(x)` and `<T>x`, but stops short of `x!`, `as` and `satisfies`. The fix is planned (alpha.28), 3.9.

**Diagnostics.** An `IrDiagnostic` has:

- `severity` and `message`;
- `code`, always set: an uncoded error becomes `MX_INTERNAL_ERROR`;
- `line` (1-based) and `column` (0-based);
- `offset`, in UTF-16 code units, `-1` when `file` names another file;
- `file`, set only when the diagnostic is in another file than the one lowered;
- `end`, `{ line, column, offset }`, exclusive: absent for a file-level diagnostic, equal to the start for a point;
- `fixes`, `{ title, edits: { offset, end, newText }[] }[]`.

Duplicates (same file, line, column and message) are dropped.

`LoweredUnit` is not what `lowerSource` returns. It is the view of the lowered file that an `afterLower` hook receives.

### 3.3 Dialects: fields, node types, manifest

**`Dialect` fields.** A dialect is checked against the known fields, and an unknown field is an error. Every field is `@unstable`.

| Field | What it does | Mesh uses |
|---|---|---|
| `id`, `name` | Identity. `name` is shown in messages. A loaded module must agree with its manifest. | `mesh`, `Mesh` |
| `table` | The syntax rows: expression, attribute, line and value triggers. | yes |
| `tagRules` | The tag-rules preset; `"none"` turns off every native element rule. | `"none"` |
| `structural`, `imports`, `unknownTags` | Defaults for the options of the same names. | `"reject"`, `"pass"`, `"reject"` |
| `contracts` | The tag contracts. | `MESH_CONTRACTS` |
| `nodeTypes` | Registered node types (below). | `Atom` |
| `lowerTrigger` | Lowers a fired trigger to IR or Babel nodes. | yes |
| `afterLower` | Checks after lowering, reporting with `unit.fail` and `unit.warn` (default codes `MX_DIALECT_ERROR` and `MX_DIALECT_WARNING`). | yes |
| `contractFields` | Contract keys the dialect claims; any other unknown key is an error. | yes |
| `checkContract` | Extra validation of contract entries. | yes |
| `describeAttribute` | How messages name an option. | yes |
| `explainUnknownTag` | Replaces core's unknown-tag error with the dialect's own. | yes |
| `diagnosticCodes` | Renames core's codes (3.6). | `MX_TO_MESH_CODES` |
| `lowerBlockTag`, `lowerFilter`, `tagFile`, `bindingsCallTags` | Block tags, filters, tag files, and opting tags out of binding calls. | no |

**Node types.** A dialect may register node types: `NodeType` is `{ keys, parse(text, span, ctx), print, lower(node, ctx) }`, and a node is a `DialectNode`, `{ type: "dialect:Type", span }`. One registry holds core's types (`mx:*`) and every dialect's. A syntax row names its node as data, as Mesh's value row names `{ type: "Atom", dialect: "mesh" }`. Node types in expression positions do not exist yet (3.4). The registry is `@unstable` until the Mesh dialect has moved onto it.

**The manifest.** `package.json#mx.dialect` (`DialectManifest`) has the fields `id`, `name`, `extensions`, `module`, `tagDirs`, `tagExtensions`, `sidecars`, `reservedTags` and `mxConfigTags`. They are manifest fields, not `Dialect` fields. Tools read the manifest without running code, and only from the project's direct dependencies. Mesh's values are in 2.2. `reservedTags` applies only when a file is routed to the dialect: in the tools, and in `lowerSource` without an explicit `dialect`. With an explicit `dialect`, as in Mesh's compiler, MX does not consult the manifest.

### 3.4 Atoms and members

Core has no atom or member syntax. Mesh's rows fire, and Mesh's hooks build the nodes:

- In an expression, `lowerTrigger` returns a Babel node: an atom is a `StringLiteral` marked `extra.mxAtom { span }`, a member a node marked `extra.mxMember { span, name }`. Mesh's own `extra.mxTransaction` mark, for `%.now` and `%.today`, is unknown to core.
- After lowering, core records every `extra.mxAtom` literal of an expression in `Expr.atoms`, and the literal stands in `Expr.code`.
- A whole option value that the `mesh:Atom` node type claims (`inverse=:owner`) lowers to a `static` option with `atom: { name, span }`. `Attr.node` stays unset, because Mesh's `lower` returns an expression, not a string.
- The marks' types, `MxAtomMark` and `MxMemberMark`, are public API, as stable as the IR.

Core still carries pieces only Mesh uses: the IR types `Atom` and `Member` with `Attr.atom` and `Attr.member`; the contract types `"atom"` and `"member"` and their check; `TriggerAttributeValue { kind: "atom" | "member" }`; and the claim-only contract data `CustomTagAttribute.values`, `pattern` and `ref` and `CustomTag.declares`. Members leave core when they move into the node registry; atoms may follow, pending the operator's ruling (section 5).

### 3.5 Contract semantics

A contract, `CustomTag`, has `defaultTag`, `parseOptions`, `attributes`, `attributeTags`, `children` and `parents`, and the hooks `analyze`, `transform` and `finalize`.

- **`attributes`**, the options. `type` is one of `string`, `number`, `boolean`, `expression`, `array`, `function`, `atom` or `member`, with `items`, `required`, `enum`, `default` and `literalOnly`. `array` and `function` check the written shape; an identifier, a call or a member access has no type MX can know, and is accepted. MX checks every tag against its contract.
- **`children`** are closed when present.
  - A named entry takes `{ required, repeatable }`.
  - `"#text"` permits non-whitespace text and `${}`.
  - `"*"`, the wildcard, takes items `{ pattern, contract }` or an inline contract; `pattern` is an anchored regular expression. A registered tag (any key of the contracts in force, the dialect's included), a core name, a built-in tag or a target's built-in never matches `"*"`: a registered `<field>` under a parent whose only entry is `"*"` gets `MX_TAG_NOT_ALLOWED`. Explicit entries win over `"*"`.
- **`parents`** lists the allowed direct parents; `"#root"` is the top level and `"@name"` an option tag.
- **Text tags** (`parseOptions.text: true`): the body is not parsed as tags (`<b>x</b>` stays text), but `${}` is still an interpolation. `children` cannot be combined with `parseOptions.text` or `openTagOnly` (`MX_INVALID_DIALECT_CONTRACT`). Under `structural: "reject"`, text and `${}` are refused even inside a text tag, so Mesh cannot use text tags while it rejects structure.
- **`tagRules: "none"`**: no native element rules; `script`, `input` and `title` are ordinary names.
- **Reserved core names**, which no contract can define: `if`, `else`, `else-if`, `for`, `const`, `define`, `return`, `import`, `export`, `static` and `try`.
- **A closed vocabulary.** Under `unknownTags: "reject"`, any tag without a contract is `MX_UNKNOWN_TAG`, or the error the dialect's `explainUnknownTag` gives. An unknown tag inside a closed parent reports only the unknown-tag error: the `MX_TAG_NOT_ALLOWED` for the same tag is dropped.
- **Duplicate options.** The last one wins, with an `MX_DUPLICATE_ATTRIBUTE` warning at each dropped one; never an error.
- **Module scope under `none`.** Duplicate import bindings are not checked under `tagRules: "none"` (under `"html"` they are `MX_DUPLICATE_DECLARATION`). Mesh checks imports itself.

### 3.6 Diagnostics and codes

- **The catalogue.** `MX_DIAGNOSTIC_CODES` (frozen, `@unstable`; 129 entries on alpha.27) lists every code `lowerSource` and `checkDialectFile` report, as `{ code, severity, summary }`; `MxDiagnosticCode` is their union. A code is never renamed or reused for another rule; new codes are added.
- **Where renaming happens.** A dialect's `diagnosticCodes` apply in one place: `lowerSource` renames its final, ordered list at every exit (`renameDiagnosticCodes`). Ordering keys on core's codes, so it runs first. A dialect that fails to resolve has no map, so nothing is renamed. Tools rename project-scan diagnostics with `diagnosticCodesOf(filename, options)`. Warnings sent to the `warnings` sink keep core's codes.
- **The map is validated** (`checkDiagnosticCodes`): a plain object whose keys are known MX codes and whose values are non-empty and do not start with `MX_`.
- **The four kept codes** (2.5). `MX_INTERNAL_ERROR` and `MX_DIALECT_HOOK_ERROR` cannot be renamed: a map that names them fails to load. `MX_DIALECT_ERROR` and `MX_DIALECT_WARNING` may be named, and the entries are ignored.
- **Hook codes.** A hook's own code cannot start with `MX_` (otherwise the result is `MX_DIALECT_HOOK_ERROR`), so it is never renamed. A hook that throws becomes `MX_DIALECT_HOOK_ERROR`; for `afterLower` it is placed at 1:0.
- **Positions.** `line` is 1-based, `column` 0-based, `offset` in UTF-16 code units. A file-level diagnostic is at 1:0, offset 0. An error about a whole tag ends at the end of `<name`.

### 3.7 MX's tools for `.mesh.mx` files

MX's editor tools check `.mesh.mx` files. They share `checkDialectFile(filePath, text, dependencies?)`, in MX's private `@mxlang/targets` package, which:

1. routes the file by its extension and runs MX's project scan;
2. calls `lowerSource(text, filePath, { customTags })` with the routed dialect, not an explicit one;
3. renames the scan's diagnostics with `diagnosticCodesOf`. A diagnostic in another file is placed at 1:0 with an `origin`.

On top of it:

- **mx-tsc** reports the diagnostics of dialect files. `@mxlang/tsc` is not released, and its built command fails under Bun today (section 5).
- **The language server** publishes them as you type, and watches dialect files.
- **The TypeScript plugin** is check-only: it emits virtual code carrying diagnostics, ranges, codes and fixes.
- **The Vite plugin and the Bun plugin** refuse to import a dialect file ("Mesh files cannot be imported: the dialect registers no emit"). A dialect with no emit step is check-only.

Because the tools route the file rather than pass the dialect, they apply the manifest's `reservedTags` and `tagDirs`. Because `stripTypes` is an option, not a dialect field, a build that passed `stripTypes: false` would see other nodes than the editor; Mesh passes no option (section 5).

### 3.8 Stability and release

- **Before 1.0, nothing is stable.** MX's README says its API may change in any release until 1.0.0. `@unstable` marks API expected to change in an alpha; such a change is announced in the changelog.
- **Marked `@unstable`:**
  - the entry points and their types: `lowerSource`, `lowerFile`, `LowerSourceOptions`, `LowerSourceResult`, `IrDiagnostic`, `SpannedIr`, `Spanned` and `IR_VERSION`;
  - the codes: `MX_DIAGNOSTIC_CODES` and `diagnosticCodesOf`;
  - the dialects: `Dialect` and every field, `DialectManifest` and its fields, `DialectNode`, `NodeType`, `LoweredUnit`, `UnknownTag`, `UnknownTagExplanation`, `routeDialect` and `discoverDialects`;
  - the atoms: `MxAtomMark`;
  - the contract fields `CustomTagAttribute.values`, `pattern` and `ref`.
- **Without a marker:** the IR types (`Attr`, `DelegatedTag` and the rest) are public and versioned by `IR_VERSION`. `CustomTag`, `WildcardChildEntry`, `MxDiagnosticCode`, `Trigger`, `TriggerContext`, `TriggerResult` and `SourceSpan` carry no marker, and fall under the README's note.
- **Who approves a change.** MX's lead approves an additive field that follows a precedent. A change to or removal of a public API, or a new required pattern, goes to the operator, and is announced to Mesh before the alpha that carries it.
- **How a change reaches Mesh.**
  1. Each MX pull request adds a changelog fragment, `changes/<slug>.md`, of kind Added, Changed, Fixed or Removed. MX's CI enforces it on a pull request that touches `packages/*/src` or a package's `package.json`, unless the PR body gives a `no-changelog: <reason>` line (section 6).
  2. At release the fragments are folded into each package's `CHANGELOG.md`, which ships in the `@mxlang/core` tarball.
  3. A change of the IR's shape bumps `IR_VERSION`.
  4. MX's lead tells Mesh's lead the alpha number when a release tag moves, and the link-update script appends the new commits to Mesh's `notes/mx/updates.md`.
- **Releases** are `0.1.0-alpha.N` on `https://npm.saulo.tech`, published under the `alpha` tag, after which `latest` moves to the same version. Nothing is published to npmjs before MX 2 and the framework targets. Today `alpha` and `latest` both point to `0.1.0-alpha.27`, the version Mesh pins.

### 3.9 Planned (alpha.28)

Neither change exists in alpha.27.

- **`tagShorthands: false` in a syntax table.** The default is `true`, so current files are unchanged; the flag is validated and part of the table's content hash.
  - With `false`, `.` continues a tag name: `billing.InvoiceVoided` is one tag, in concise and HTML form alike, and closes with `</billing.InvoiceVoided>`.
  - `#` anywhere in a tag head, or a head that starts with `.` or `#`, is the new code `MX_NO_TAG_SHORTHAND` (exported as `NO_TAG_SHORTHAND_CODE`).
  - A trailing `.`, `..`, or a `.` after a dynamic `${…}` name is `MX_INVALID_TAG_NAME`.
  - The wildcard matcher accepts dotted names.
- **The written span of a dynamic option.** Dynamic options gain `valueSpan`, the written value with any wrapper (`(x)`, `<T>x`, `x!`, `x as T`, `x satisfies T`); a reader finds a wrapper where `valueSpan` differs from `value.span`. `attr.span` is fixed to cover the whole written option (today `entity=List as any` ends at `List`). This adds a field to the IR, so `IR_VERSION` is expected to become 5. `<T>x` in a concise option value is also lowered to `x` today; in HTML form (`<t a=<T>x/>`) it is `MX_PARSE_EXPRESSION`.

## 4. Who checks what

"Mesh's hook, run by MX" means a rule Mesh writes in its dialect or a contract, which MX runs inside `lowerSource`. Mesh's own checks run on the tree, after `lowerSource`, for every file MX parsed. Paths without a package are in `packages/compiler/`.

| Rule | Checked by | Where |
|:--|:--|:--|
| The manifest is well formed: `id` pattern and not `mx`, `name` non-empty, `extensions` non-empty and unique, `module` inside the package, `tagDirs`, `tagExtensions`, the booleans, `reservedTags` (`MX_INVALID_DIALECT_MANIFEST` at the field) | MX, at discovery | `readDialectManifest` |
| The manifest agrees with Mesh: `id` `mesh`, `extensions` equal to `MESH_EXTENSIONS`, `module` `./dist/dialect.js` | Mesh | `packages/cli/scripts/build-dialect.ts` |
| An extension claim is not `.mx` or a case variant of it, not a JavaScript, TypeScript or `.marko` extension, and has no host segment | MX | `reservedExtensionReason` |
| No two dialects claim one extension or share one `id` (`MX_DIALECT_CONFLICT`; `mx.extensions` in MX's config settles an extension clash) | MX | dialect discovery |
| The module resolves, is JavaScript and loads; a TypeScript module is refused (`MX_MODULE_LOAD_FAILED` at `mx.dialect.module`) | MX, at load | `loadDialect` |
| The module's shape: known fields only, `table` required, hooks are functions, `id` and `name` agree with the manifest (`MX_INVALID_DIALECT_MODULE`) | MX | `checkModuleShape` |
| The syntax table is valid | MX | `validateSyntaxTable` |
| Node types are registered, and rows name only registered types | MX | `checkDialectNodeTypes`, `unregisteredNodeRow` |
| A row that calls a hook has a `lowerTrigger` (`MX_NO_LOWERING` for an explicit dialect; a routed one fails to load) | MX | `tableParseError` |
| A contract key is known or claimed by the dialect | MX | `checkContractFields` |
| The atom contract keys Mesh claims (`values`, `pattern`, `ref`, `declares`) | Mesh's hook, run by MX | `contractFields`, `checkContract`, `afterLower` in `src/front-end/syntax/atoms-sugars.ts` |
| Contract entries are valid: types, enum against type, `children` against `text`/`openTagOnly`, wildcard references, defaults (`MX_INVALID_DIALECT_CONTRACT` at the key) | MX | `checkDialectContracts` |
| The `diagnosticCodes` map is valid: unrenameable keys refused, `MX_DIALECT_ERROR` and `MX_DIALECT_WARNING` ignored | MX | `checkDiagnosticCodes` |
| Every MX code has a Mesh name, and the map names no kept code and no code outside MX's catalogue | Mesh | `test/diagnostic-codes.test.ts`; the type of `MX_TO_MESH_CODES` |
| `MESH_DIALECT` is deep-frozen | Mesh | `test/dialect-deep-freeze.test.ts` |
| Core names can never be defined as tags | MX | `RESERVED_NAMES` |
| A project definition of a tag in the dialect's `reservedTags` is refused (`MESH_RESERVED_TAG`) | MX, routed files only: not applied with an explicit `dialect` | the scan's `reservedRefusal`; `dialectCustomTags` |
| `reservedTags` equals the contracts' keys; a project's `mx.tags`, `mx.contracts` and `tags/` do not reach a `.mesh.mx` file | Mesh | `test/dialect-registration.test.ts` |
| Every tag's options: required, type, enum, unknown; every independent tag reported | MX, at lowering | `validateCustomTagCall` |
| Closed `children` and `"*"` patterns; a registered name never matches `"*"`; a refused parent skips its subtree | MX | `wildcardIneligibility` |
| `parents` | MX | lowering |
| Unknown tags under `unknownTags: "reject"`; the dialect's `explainUnknownTag` replaces core's error | MX | `checkIr` |
| A name written against its kind (`uuid:id`) is `MESH_UNSPACED_NAME` | Mesh's hook, run by MX | `explainUnknownTag` in `src/front-end/dialect.ts` |
| Structural constructs under `structural: "reject"` (`MESH_STRUCTURAL_CONSTRUCT`) | MX | `checkIr` |
| Duplicate options: the last wins, with a warning (`MESH_DUPLICATE_OPTION`) | MX | `resolveDuplicateAttrs` |
| Duplicate import bindings (`MESH_DUPLICATE_IMPORT`) | Mesh. MX: no, under `none` | `buildModel` in `src/front-end/build.ts` |
| Conditional rules: entity references (`MESH_ENTITY_REFERENCE`), rollup `of=` paths (`MESH_ROLLUP_PATH`), a check's `message=`, function options written as functions | Mesh's hook, run by MX | the `analyze` hooks in `src/front-end/contracts.ts` |
| Every diagnostic a Mesh hook raises names a `MESH_*` code | Mesh | `checkHookFailCodes`, run by `test/architecture.test.ts` |
| Claim errors in a node type's `parse`, positioned at the claim | MX | `ClaimContext.fail` |
| A hook that throws, or that uses an `MX_` code, is `MX_DIALECT_HOOK_ERROR` | MX | `isReservedHookCode` and the hook runner |
| Every span is present and in range on the returned IR | MX | `checkIr`, `finishIr` |
| Positions: 1-based line, 0-based column, UTF-16 offset; no position becomes 1:0 with a prefix | MX | MX's diagnostics module |
| Every diagnostic carries a code; an uncoded one becomes `MX_INTERNAL_ERROR` | MX | MX's diagnostics module |
| Codes are renamed per the dialect's map at every `lowerSource` exit; tools use `diagnosticCodesOf` | MX | `renameDiagnosticCodes` |
| Codes are never renamed or reused across releases | MX, by rule; the table test keeps each code listed and reachable | the rule in MX's `diagnostic-codes.ts`; `diagnostic-code-table.test.ts` |
| A change of the IR's shape bumps `IR_VERSION`; a change of meaning is its author's call | MX, by test | `ir-version.test.ts` (a hash) |
| The installed `@mxlang/core` speaks IR version 4 | Mesh | `test/ir-version.test.ts` |
| `lowerSource` never throws | MX, by design; probed on four kinds of failure | `lowerSource` |
| Determinism | Nobody: not promised, probed in one process only | none |
| MX's tools never build a dialect file | MX | the Vite and Bun plugins refuse it |
| One `entity` per file (`MESH_DUPLICATE_ENTITY`) and each `:name` unique in its scope (`MESH_DUPLICATE_MEMBER`) | Mesh | `buildModel` |
| Imports: what an entity file may import and from where, and that an imported name exists (`MESH_UNKNOWN_IMPORT`, `MESH_IMPORT_FORM`) | Mesh | `buildModel` |
| References: entity targets (`MESH_UNKNOWN_ENTITY`), relationship inverses, rollup paths, and later `on=` | Mesh | `resolveReference` in `src/front-end/references.ts`; `src/front-end/relationships.ts`; `src/front-end/rollups.ts` |
| Member semantics: an assignment to a member in an expression (`MESH_MEMBER_ASSIGN`), an unknown member (`MESH_UNKNOWN_MEMBER`); MX lowers `&a = 1` to `self.a = 1` without complaint | Mesh | `buildModel`; `src/front-end/rollups.ts`; the back end's views |
| Expressions: free variables, the translatable subset, the scope roots, `%.now` and `%.today` | Mesh | `src/front-end/expression.ts`; `checkExpressions` in `src/model/check-expressions.ts` |
| The not-implemented rule ([ADR-0018](../decisions/0018-not-implemented-is-a-build-error.md)) and the model rules: policies, checks, timing | Mesh | `src/model/lifecycle-limits.ts`, `src/model/policies.ts`, `src/front-end/rollups.ts` |
| Generated names and paths (`MESH_EMIT_NAME`, `MESH_EMIT_PATH`) | Mesh | the back end, `src/typescript/` |
| Only `packages/compiler` mentions `@mxlang` (the docs site's highlighter aside), and inside it only the front end imports it | Mesh | `checkMxImports` (M1 test 8); `test/architecture.test.ts` |
| No Mesh code imports MX core's syntax modules | Mesh | `test/no-core-syntax-import.test.ts` |

## 5. Known limits and open items

Each item names its MX TODO slug, MX decision or Mesh decision row.

- **No partial IR on error.** A file with an error gives no tree, so Mesh runs none of its own checks on that file until MX's errors are fixed. MX TODO `ir-entry-partial-ir`.
- **A refused tag hides its subtree.** A tag refused by its own lowering hides the errors inside it until the refusal is fixed (3.1). MX decision 162; no TODO.
- **Wrapped references**, planned (alpha.28). MX lowers `(x)`, `<T>x`, `x!`, `x as T` and `x satisfies T` to `x`. Mesh's `analyze` hooks see only `x`, so `entity=<T>Customer` passes with no diagnostic. Mesh refuses these forms once the written value's `valueSpan` differs from `value.span` (3.9). MX TODO `dynamic-attr-value-span`; SYN-21, SYN-26.
- **Dotted line heads**, planned (alpha.28). Until Mesh's dialect sets `tagShorthands: false`, a dotted line head lowers as MX's `.class` shorthand, so a head such as `billing.InvoiceVoided` in an owner's `events` or `commands` section waits on it. MX TODO `dialect-tag-shorthands-off`; SYN-21, DOM-17.
- **Dialect nodes inside expressions**, pending the operator's ruling. The operator has ruled that a dialect's expression output is always a clean expression in the file's own expression language. Two points are open: whether nodes are kept in a record core owns, `Expr.nodes` (each with a "forward", the plain JavaScript it lowers to; contract types could then name a node type, `type: "mesh:Atom"`), which amends MX-12; and a mandatory node schema (fields, forward, printer, and marking characters checked to be disjoint at load). If ruled yes, the `extra.*` marks stay for one alpha beside `Expr.nodes`, with a migration note to Mesh. MX TODO `research-nodes-inside-expressions`, MX decision 222; MX-12.
- **Members leave core**, and atoms may follow (pending the ruling above). The core pieces only Mesh uses (3.4) move into the node registry, with a one-alpha fallback for the marks and a migration note to Mesh. MX TODO `member-to-dialect-registry`, MX decision 218; MX-12.
- **The atom's dialect name in `afterLower`.** `afterLower` names a value atom `mx:Atom` while the IR names it `mesh:Atom`. MX TODO `lowered-unit-atom-dialect-name`.
- **Dialect files are check-only.** The Vite and Bun plugins refuse to import them. MX TODO `dialect-emit-step`, MX decision 218.
- **`stripTypes` is not a dialect field**, so the editor and a build that passed the option could see different nodes. MX TODO `strip-types-dialect-field`.
- **mx-tsc under Bun.** Its built command fails under Bun (TS18003). MX TODO `mx-tsc-bun-ts18003`.
- **Overlapping splices.** Two `ctx.expression` values from one trigger are spliced twice. MX TODO `trigger-splice-overlap`.
- **An unchecked `defaultTag`.** An invalid `defaultTag` inside `children["*"]` is not checked when the contract is registered. MX TODO `contract-default-tag-scan-children-wildcard`.
- **Reloading a dialect.** A dialect module is not reloaded in watch mode (MX TODO `sync-esm-reload-node`), and reloading is untested (MX TODO `dialect-reload-untested`).
- **No formatter for node types.** A node type's `print` has no formatter to plug into. MX TODO `dialect-print-formatter`.
- **Highlighting.** The docs site highlights `mx` fences with MX's tree-sitter highlighter, `@mxlang/tree-sitter-mx` `0.1.0-alpha.2` ([ADR-0065](../decisions/0065-mx-highlighting-on-the-docs-site.md)). It treats `input` as an HTML void tag, so the docs plugin carries one counted allowance, `MX_V4_INPUT_PENDING_SYNTAX_TABLE`, which gives nested input sections and bare member lines same-width stand-ins for highlighting only, and one render-only overlay, `MESH_V4_MEMBER_RENDER`, which colours `&name` heads and `%.now`/`%.today` where they start an operand. The rendered text is always the authored text. A line at the left margin ends the root tag's block, a comment included, so a comment inside an entity is indented with its block; the grammar reports such a line as an error and the docs build fails, naming the page and the line. Both bridges go when MX ships the syntax-table route for highlighting and `@mxlang/tree-sitter-mx` moves past alpha.2. MX's editor grammars also still colour sugars core removed. MX TODOs `mesh-syntax-highlighting-route` (MX decision 182, addendum 1) and `editor-grammars-layer-2`.
- **MX's words in messages.** MX's messages call an option an "attribute" ("unknown attribute"), print a tag in its HTML form (`<attributes>`, and `<member>` for a line the user wrote as `&title`), and call a dialect file a "data file". Planned, design not settled: a small vocabulary on `Dialect` (for example a noun for options and a tag formatter), approved by MX's lead as additive `@unstable` fields, which Mesh will set to say "option" and print tags as Mesh writes them; output for `.mx` files stays the same. MX TODO `dialect-message-vocabulary`, which absorbs `ir-entry-data-file-wording`. The indentation message's missing "not" ("does match indentation") is MX TODO `parse-invalid-indentation-typo`.
- **One read of `Expr.code`.** The rollup `of=` hook in `contracts.ts` refuses whitespace inside a member path by testing `Expr.code`, which breaks promise 2.4.1. It is to be replaced by a test of the member nodes' spans. No row yet.
- **The changelog in the tarball.** MX TODO `release-changelog-in-package` is still open, though `@mxlang/core`'s `files` already lists `CHANGELOG.md`.
- **Mesh drops `end`, `fixes` and `file`.** `meshDiagnostic` keeps only a diagnostic's start, so `mesh build` shows no range and none of the fixes MX offers, and a diagnostic in another file would be placed in the parsed one. No row yet.
- **Expression diagnostics in the editor.** An unsupported construct inside a translated expression is to be reported in a contract's `analyze` hook, so the editor shows it as the author types: an error where SQL is required (a filter, a sort, a policy), otherwise a notice that the expression runs in memory. Not built. EXP-10, [ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md).
- **Concepts.** A `tagDirs` entry for Mesh's concept directory, and the hook that turns a tag file into a contract. DOM-07, DOM-44, [ADR-0085](../decisions/0085-tag-discovery-for-dialect-tags.md).
- **Extensions.** Mesh composes its dialect from core plus the enabled extensions, which replaces [ADR-0021](../decisions/0021-composed-contracts-module.md)'s composed `mx.contracts` module. It comes with the extension host, after 1.0. MX-03.
- **HTML-form entity files.** Entity files are written in the concise form; whether the build refuses an HTML-form file, and whether the tree can tell the forms apart, is not decided. SYN-15, [ADR-0041](../decisions/0041-mx-concise-syntax.md).

## 6. How each side is held to it

### Mesh's tests

All of them run in `bun run verify`, which GitHub Actions runs on every pull request and every push to `main` ([ADR-0031](../decisions/0031-no-ci-until-mx-is-published.md)). The compiler's tests are under [`packages/compiler/test/`](https://github.com/svallory/mesh/tree/main/packages/compiler/test).

- **The MX import boundary** (M1 test 8, [ADR-0043](../decisions/0043-mx-is-core.md)). `checkMxImports` in `repository-checks.ts`, run by `repository-checks.test.ts`, reads every `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` and `.json` file under `packages/`, `apps/` and `examples/` as text, without parsing it. Any occurrence of `@mxlang` outside the allow-list, `MX_IMPORT_PACKAGES` (today `packages/compiler` only), fails, naming the file and the line of its first occurrence: comments and strings count on purpose, and so does a dependency in any `package.json` field. The one exception is the docs site's highlighter, `@mxlang/tree-sitter-mx`, by exact package name. Only paths with a `node_modules` segment, `apps/docs/site`, `apps/docs/docs` and lock files are skipped; other folders named `build`, `dist`, `site` or `coverage` are scanned. Planted sources prove it fails, while MX-free angle brackets and JSX pass. A specifier assembled at run time from pieces can evade a substring scan; the dependency rule and review are the backstop.
- **The compiler's halves.** `architecture.test.ts` scans the imports of `src/`: the TypeScript back end and `src/model/` never import `@mxlang` or the front end ([ADR-0076](../decisions/0076-compiler-front-end-and-back-end-are-separate.md)). It also runs `checkHookFailCodes`, which fails when a `ctx.fail`, `unit.fail` or `fail` call in the dialect, the syntax rows or the contracts passes no `code`.
- **`no-core-syntax-import.test.ts`** fails on any import of `@mxlang/core/syntax` in `packages/` or `examples/` (MX-01), with planted spellings proving the scan.
- **`dialect-registration.test.ts`** routes files in a temporary project. A project that depends on `meshfw` gets its `.mesh.mx` files, and only those, routed to the `mesh` dialect, and one without `meshfw` gets no dialect. With no options, MX takes the vocabulary, tag rules and strictness from the dialect, as strict as the compiler. The module is built JavaScript Node can load, with no TypeScript beside it. The build refuses a manifest whose extensions drift. `reservedTags` equals the contracts' keys. A project's `mx.tags`, `mx.contracts` and `tags/` reach a `.mx` file but not a `.mesh.mx` one, and a project definition or `customTags` entry named like a Mesh tag never replaces Mesh's contract (`MESH_RESERVED_TAG`).
- **`dialect-deep-freeze.test.ts`** fails when any object or array reachable from `MESH_DIALECT` is not frozen.
- **`diagnostic-codes.test.ts`** fails when an MX alpha adds a code `MX_TO_MESH_CODES` leaves out, or when the map names a kept code or a code outside MX's catalogue; the type of the map fails the type check too. It also checks that the build and MX give one Mesh code at one place, that a throwing hook is `MX_DIALECT_HOOK_ERROR` and that a dialect that fails to load renames nothing.
- **`ir-version.test.ts`** fails unless the installed `@mxlang/core` exports `IR_VERSION` 4.
- **`packages/cli/scripts/build-dialect.ts`**, a `verify` step, fails the build when the manifest's `id`, `extensions` or `module` drift.
- **The docs fence checks.** `checkDocsSamples` (run by `repository-checks.test.ts`) and the stricter `checkDocsSyntaxV4` (run by [`apps/docs/test/docs-mx-syntax.test.ts`](https://github.com/svallory/mesh/blob/main/apps/docs/test/docs-mx-syntax.test.ts)) walk every `mx` fence of the user pages (`apps/docs/docs/docs/*.md`) and of ADR-0050's reference. A bounded text guard first rejects obsolete spellings, undeclared member heads, unimported entity identifiers and a `self.` read without a destructured `self` in its function; a `resource` root is an error. Then each fence parses as authored through `parseEntitySource`, with no rewriting and no relaxed contracts, so misplaced member lines and assignments in `input` are parse errors. The stricter walker requires every fence to be a complete entity file, and the docs test counts the opening fences on its own, so the walker cannot lose one unnoticed. The checks print the files checked and the findings, fail on an empty set, and name the page and fence line of each finding; planted failures cover both walkers. This guard is not full contract or type checking.
- **The docs build** fails on any error node the highlighter reports, apart from the counted `input` allowance (section 5).

### MX's tests

- **The IR version hash.** `ir-entry/ir-version.test.ts` in `@mxlang/core` pins `IR_VERSION` together with a hash of the IR's type declarations, so a change of shape fails MX's CI until the version goes up.
- **The diagnostic code table.** `ir-entry/diagnostic-code-table.test.ts` keeps one row per code of `MX_DIAGNOSTIC_CODES`, each reached at a pinned position. The never-renamed rule is enforced by review, not by this test.
- **The changelog fragment check.** [`scripts/check-changelog-fragment.ts`](https://github.com/svallory/mxlang/blob/main/scripts/check-changelog-fragment.ts) fails an MX pull request that touches `packages/*/src` or a package's `package.json` and adds no `changes/<slug>.md` fragment, unless the PR body gives a `no-changelog: <reason>` line.

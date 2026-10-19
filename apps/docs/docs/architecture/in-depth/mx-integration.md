---
title: "The contract between Mesh and MX"
description: "What Mesh gives MX, what MX gives Mesh, who checks each rule, what is still open, and the tests that hold each side to the contract."
---

# The contract between Mesh and MX

This page is the contract between Mesh and MX, the language project that parses Mesh's entity files. It replaces the site's earlier MX integration page, and MX may keep a mirror of it. Mesh's lead wrote Mesh's side: sections 1 and 2, Mesh's rows of section 4 and Mesh's items in section 5. MX's lead wrote MX's side: section 3, MX's rows of section 4 and MX's items in section 5, checked against MX's code. A change on either side is checked against this page, so that a broken promise is found in review rather than by a broken build. A Mesh change that alters a statement here updates the page in the same pull request. An MX change that alters one gives a `Contract:` line in its pull request, and the Mesh pull request that moves to the MX release carrying it updates the page.

::: callout info "Versions this page describes"
`@mxlang/core` `0.1.0-alpha.36`, IR version 8. Section 5 lists everything still open on either side.
:::

## Why there is a contract

MX is core to Mesh, not an adapter: nothing replaces it, and there is no front-end slot or front-end package ([ADR-0043](../decisions/0043-mx-is-core.md)). The two projects are built by different teams on different release cycles. This page states what each side gives the other and what each may rely on.

The division is simple. MX owns the parser, the lowered tree and the dialect mechanism. Mesh owns its syntax, its vocabulary and what a file means ([ADR-0049](../decisions/0049-vocabulary-is-meshs-own.md), [ADR-0067](../decisions/0067-members-imports-input-static-files.md)). Nothing in an entity file is evaluated to produce declarations: Mesh reads the tree MX returns. Mesh consumes MX's static tree; a compiled module beside the tree becomes the target only once MX's next major version, MX2, exists.

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
- **MX's references.** "MX decision N" is a decision in MX's own record, and a slug such as `dialect-tag-shorthands-off` is an item of MX's TODO list. Both appear only in section 5, where they track open work.

## 1. Versions and changes

- **Exact pins.** Mesh depends on `@mxlang/core` by exact version in [`packages/compiler/package.json`](https://github.com/svallory/mesh/blob/main/packages/compiler/package.json). The root [`bunfig.toml`](https://github.com/svallory/mesh/blob/main/bunfig.toml) resolves the `@mxlang` scope from the pre-release registry, `https://npm.saulo.tech` ([contributing](../contributing.md#dependencies-and-the-registry)). The docs site's highlighter, `@mxlang/tree-sitter-mx`, is pinned on its own. Nothing resolves a range, so an MX release reaches Mesh only when Mesh moves the pin.
- **When Mesh moves.** Mesh moves to a new alpha only when the MX lead sends its number. The move is one pull request, and `bun run verify` must pass on CI ([ADR-0031](../decisions/0031-no-ci-until-mx-is-published.md), [continuous integration](../contributing.md#continuous-integration)). Any change the move causes in a golden file or a generated tree is reported to the MX lead, not accepted silently.
- **Requests.** Mesh asks the MX lead for anything it needs that MX does not export, by name. The request becomes an item in MX's TODO list. Mesh code that waits on an item names it in a comment, and the workaround goes when the item ships.
- **Vocabulary.** Every change to Mesh's vocabulary (a tag added, renamed or removed) is announced to the MX lead.
- **Unpublished MX.** A contributor may link a local MX checkout to test an unpublished commit, but never commits the link ([contributing](../contributing.md#what-exists-today)).

## 2. What Mesh gives MX

### 2.1 The dialect

Mesh gives MX one deep-frozen `Dialect` value, `MESH_DIALECT`, in [`front-end/dialect.ts`](https://github.com/svallory/mesh/blob/main/packages/compiler/src/front-end/dialect.ts). Its id is `mesh` and its name is `Mesh`. MX validates a frozen dialect once and caches it, and validates an unfrozen one on every call (3.1): 3 ms against 46 ms, as measured for Mesh's test corpus ([`test/mesh-corpus.ts`](https://github.com/svallory/mesh/blob/main/packages/compiler/test/mesh-corpus.ts)).

| Field | Value | Why |
|:--|:--|:--|
| `tagRules` | `"none"` | Every tag in a Mesh file is Mesh's, so HTML's rules (`input` is void, `script` holds text) never apply. Project config cannot override it. |
| `contracts` | `MESH_CONTRACTS`, one closed contract per tag of Mesh's vocabulary | The editor and the build check a file against the same vocabulary. |
| `structural`, `unknownTags`, `imports` | `"reject"`, `"reject"`, `"pass"` | A Mesh file holds tags, options and imports only. Control flow, text and unknown tags are errors. |
| `diagnosticCodes` | `MX_TO_MESH_CODES` | Every MX code a Mesh file can produce reaches the user as a `MESH_*` code (2.5). |
| `messageVocabulary` | `attribute: { one: "option", many: "options", article: "an" }`, `file: "Mesh file"`, and a `formatTag` that spells a tag as its line is written | MX's messages read in Mesh's words. A `key=value` is an option, since in Mesh an attribute is an entity's data member. A Mesh file is a "Mesh file", not a "data file". `formatTag` returns the text the user wrote for a lowered tag (`&title` for a `member`) and the name for any other (`attributes`, `belongs-to`), `@row` for an `@row` attribute tag and `${x}` for a dynamic head; for a name it cannot spell on one line without backticks it returns `undefined`, so MX's own spelling stands. Since alpha.31 it also receives MX's built-in names (`if`, `const`, `define`, ...), and spells them as written too, with no special case: a message names `if`, not `<if>`. `tree` is no longer used: no message reads it. `file` is a string, whose plural is the string plus "s" ("Mesh files are static, so they do not evaluate `if`"), or `{ one, many, article? }`; a malformed value is `MX_INVALID_DIALECT_MODULE`. |
| `table` and `nodeTypes` | Mesh's own syntax rows, in [`front-end/syntax/`](https://github.com/svallory/mesh/tree/main/packages/compiler/src/front-end/syntax) | `kind :name`, `:name` atoms in every position, `&name` members, `%.now` and `%.today`, and two node types. `Atom`, `mesh:Atom`, is every `:name`: the `atom` expression row and the `atom-value` row both name it as `{ type: "Atom", dialect: "mesh" }`, and the name sugar (`kind :name`) passes one to `ctx.attribute`. `Member`, `mesh:Member`, is every `&name`: the `member` expression row names it as `{ type: "Member", dialect: "mesh" }`, and after a kind (`sort asc &dueOn`) the `member` attribute row passes one to `ctx.attribute` with `once`, so a second member on the tag is refused (3.4). Each declares its `schema` (`{ fields: { name: "data" }, slot: ["expression", "value"] }`) and a `label` (`atom`, `member`) that core's contract messages show in place of the key. Core has no atoms since alpha.33 and no members since alpha.34 (3.4). There are no `#id` or `.class` rows. The id must stay `mesh`, since the rows and the contracts name the types `mesh:Atom` and `mesh:Member`. |
| `tagShorthands` (in the syntax table) | `false` | A dotted line head, such as `billing.InvoiceVoided`, is one name. |
| Hooks | `lowerTrigger`, `contractFields`, `checkContract`, `describeAttribute`, `afterLower`, `explainUnknownTag` | `lowerTrigger` builds the nodes of `&name` and `%.name` and the name sugar; the `Atom` type's `lower` builds the forward of `:name`, a `StringLiteral`. `contractFields`, `checkContract` and `afterLower` claim and check the atom contract keys `values`, `pattern`, `ref` and `declares` ([`syntax/atoms-sugars.ts`](https://github.com/svallory/mesh/blob/main/packages/compiler/src/front-end/syntax/atoms-sugars.ts)). `explainUnknownTag` reports a name written against its kind (`uuid:id`) as `MESH_UNSPACED_NAME`. |

The contracts are in [`front-end/contracts.ts`](https://github.com/svallory/mesh/blob/main/packages/compiler/src/front-end/contracts.ts). Every contract is closed (no option, child or option tag beyond those it lists), and every value Mesh reads statically is `literalOnly`, since a static tree has no scope in which an identifier could be evaluated. Function options (`that=`, `authorize-if=`, a `set` value) and method bodies are code, so they are the exception. Names and fixed-set values are options of type `mesh:Atom`, and a list of them is `{ type: "array", items: "mesh:Atom" }` (`values`, `types`, `auto`), so a single atom in a list slot is written `[:read]`; an option that takes a single member (`on:load=`, the `member` a kind places) is of type `mesh:Member`. An option that takes several members (`always actions=`, a policy's `actions=`, `load=`) is an array of expressions, whose elements a hook checks are members. The attribute types a body may list come from the registry in `@meshfw/model`, so the contracts and the model cannot disagree ([ADR-0037](../decisions/0037-vocabulary-source-of-truth.md)).

Rules a declaration cannot express go in a contract's `analyze` hook, which MX runs for the contract's tags. Mesh's hooks refuse an entity reference that is anything but an identifier or one plain member of one (`MESH_ENTITY_REFERENCE`), a rollup `of=` that is not a member path (`MESH_ROLLUP_PATH`), a list of members with an element that is not one (`MESH_MEMBER_REFERENCE`), and a check's `message=` that is blank text or neither text nor a function. One hook wraps every contract and refuses parameters, a tag variable and `:=` (`MESH_SYNTAX`) and a function option written as anything but a function (`MESH_EXPRESSION`). The dialect's `afterLower` refuses an expression in a `mesh:Member` option that is not exactly one member (`on:load=(&visible && x)`, `MESH_OPTION_VALUE`), which core's node-type check passes (3.5).

A Mesh hook reports through `ctx.fail(message, { at, code })` with a `MESH_*` code, never through a message prefix. A hook that throws is a defect in Mesh, and MX reports it as `MX_DIALECT_HOOK_ERROR` (3.6).

### 2.2 Registration

`meshfw`'s [`package.json`](https://github.com/svallory/mesh/blob/main/packages/cli/package.json) declares `mx.dialect`, the manifest MX's tools read to find the dialect. Only `meshfw` claims the id `mesh` and the `.mesh.mx` extension.

| Manifest field | Value |
|:--|:--|
| `id`, `name` | `mesh`, `Mesh` |
| `extensions` | `MESH_EXTENSIONS` (`.mesh.mx`), the one list in [`front-end/extensions.ts`](https://github.com/svallory/mesh/blob/main/packages/compiler/src/front-end/extensions.ts). |
| `module` | `./dist/dialect.js`: plain JavaScript that `bun run build` and `prepare` bundle from `MESH_DIALECT` ([`scripts/build-dialect.ts`](https://github.com/svallory/mesh/blob/main/packages/cli/scripts/build-dialect.ts)). MX refuses a TypeScript module, and loads the file in whatever runtime hosts it, so it must be JavaScript Node can load. The build fails when `id`, `extensions` or `module` drift. |
| `mxConfigTags` | `false`: a project's `mx.tags` and `mx.contracts` never reach a Mesh file. A contracts module named in `mx.contracts` would not reach one either. |
| `tagDirs` | `[]`: MX's generic `tags/` directory is closed to Mesh files. When concepts are built, it lists Mesh's concept directory ([ADR-0085](../decisions/0085-tag-discovery-for-dialect-tags.md)). |
| `reservedTags` | Every key of `MESH_CONTRACTS` (45 names), so a project definition of a Mesh tag is `MESH_RESERVED_TAG`. MX applies it to routed files only: in its tools, and in `lowerSource` called without an explicit `dialect` (3.3). The compiler passes the dialect and no `customTags`, so the list has nothing to guard on that path. |

A project that depends on `meshfw` directly has its `.mesh.mx` files routed to this dialect by MX's discovery. User projects carry no `mx` key. `@meshfw/compiler`'s `package.json` has no `mx` key either: the contracts travel on the dialect.

### 2.3 The call

The compiler makes one MX call, `parseEntitySource` in [`front-end/build.ts`](https://github.com/svallory/mesh/blob/main/packages/compiler/src/front-end/build.ts):

```ts
lowerSource(source, file, { dialect: MESH_DIALECT })
```

- `file` is the entity file's absolute path. Core compares the option's marks with those of every dialect the project installs only when the file name is absolute and its nearest `package.json` is found (3.14), so a project that also installs a dialect marking `&`, `:` or `%.` fails `mesh build` exactly where the editor reports the clash. A diagnostic of the lowered file carries no `file`, so Mesh's messages stay project-relative.
- It passes the dialect and nothing else: no `customTags` (which would silently replace the dialect's contracts), no strictness option and no `tagRules`. The editor therefore checks a Mesh file exactly as the build does.
- Mesh runs no project scan, so it calls neither `checkDialectFile` nor `diagnosticCodesOf` (3.7).
- `meshDiagnostic`, in the same file, turns each MX diagnostic into a Mesh one. It keeps `severity`, `code`, `message`, `line`, `column` and `offset`, and places the diagnostic in the parsed file. It drops `end`, `fixes` and `file` (section 5).
- The test helper and the docs checks parse through the same function (section 6).

The compiler's front end, `packages/compiler/src/front-end/`, turns the tree into the model and is the only code that imports `@mxlang/*`. The TypeScript back end reads the model only, and `model`, `runtime` and generated code never import MX ([ADR-0076](../decisions/0076-compiler-front-end-and-back-end-are-separate.md)).

### 2.4 What Mesh promises

1. **Never re-parse `.mx` text.** The lowered tree is the semantics; two parsers would disagree about one file. Mesh never rewrites text before MX parses it, and never reads meaning from `Expr.code`. The one use of text is slicing a function's authored text at its MX span, to emit plain code ([ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md)).
2. **Match diagnostics by code**, never by message text.
3. **Never change documented syntax to route around an MX bug**. Mesh reports the bug to the MX lead and filters the symptom until MX fixes it.
4. **List every `@unstable` MX API Mesh uses:** `lowerSource` with `LowerSourceResult`, `IrDiagnostic`, `SpannedIr` and `IR_VERSION`; `MX_DIAGNOSTIC_CODES`; `Dialect` and every field 3.3 marks as used by Mesh (`table`, `tagRules`, `structural`, `imports`, `unknownTags`, `contracts`, `nodeTypes`, `lowerTrigger`, `afterLower`, `contractFields`, `checkContract`, `describeAttribute`, `explainUnknownTag`, `diagnosticCodes`); `NodeType` (with `NodeSchema` and `label`), `DialectNode`, `ExprNode`, `LoweredUnit` and `UnknownTag`; the contract fields `CustomTagAttribute.values`, `pattern` and `ref`; and the syntax table's `tagShorthands`. Before MX changes one of them, the MX lead tells the Mesh lead. Section 3.8 lists everything MX marks `@unstable`.
5. **Design against what MX will be.** Mesh does not hardcode MX's current limits into its language. Where Mesh waits on MX, section 5 lists it.
6. **Read only data-shaped text as a value.** The front end's value parser reads only data-shaped text (literals, atoms, member references); a function option is code and is read as a function, never as a value.

### 2.5 Mesh's names for MX's codes

Mesh's dialect renames every MX code a Mesh file can produce to a `MESH_*` code (`MX_TO_MESH_CODES` in [`front-end/diagnostic-codes.ts`](https://github.com/svallory/mesh/blob/main/packages/compiler/src/front-end/diagnostic-codes.ts)), so a Mesh user sees Mesh's codes only, in the build and in the editor alike. The rule is that `MX_X` is `MESH_X` (`MX_UNKNOWN_TAG` is `MESH_UNKNOWN_TAG`), so MX's catalogue still explains a code, with MX's "attribute" (`ATTRIBUTE`, `ATTR`) read as Mesh's "option": `MX_UNKNOWN_ATTRIBUTE` is `MESH_UNKNOWN_OPTION`, and an MX attribute tag is an option tag. An MX code for a mistake Mesh already reports under its own code takes that code, and an MX word that means something else in Mesh takes Mesh's word:

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

**Result.** `LowerSourceResult` is `{ ir: SpannedIr | undefined; diagnostics: IrDiagnostic[]; partial?: true }`.

- Any error means `ir: undefined`. Since alpha.36 a caller that passes `partial: true` may get a spanned IR with the failed subtrees left out, marked `partial: true`, when recovery can build one; a parse failure with no lowered tree, an unresolved dialect or a reserved-name refusal still gives `ir: undefined`. Mesh passes no option, so it never gets a partial IR.
- Warnings come back with the IR: a duplicate option returns the IR and a `MESH_DUPLICATE_OPTION` warning.
- The IR is the caller's own copy, and every span in it is checked before it is returned.

**Every independent error is reported.** All diagnostics are positioned, sorted by position, with a cause placed before its cascade. A file with three independent mistakes gives three diagnostics in one run:

- every parse error, since the parser recovers: two broken expressions give two parse errors (`MESH_PARSE_EXPRESSION` under Mesh's dialect);
- every contract error on independent tags: a missing required option, a bad enum value and an unknown option in one file give three errors;
- every unknown tag under `unknownTags: "reject"`;
- every structural hit under `structural: "reject"`. Since alpha.31 a `for` or `if` under a tag with a contract is reported as the construct (`MESH_STRUCTURAL_CONSTRUCT`), at the construct, as it is everywhere else; since alpha.32 that holds for every authored form: `if(x)`, `for(x)`, `for|x|(y)`, `if|x|=a`, and an `if` or `for` with no condition or params, each reported once; an `else(x)` or `else-if(x)` that follows an `if` is folded into that `if`'s single error, and since alpha.36 an orphan `else` or `else-if` is `MESH_STRUCTURAL_CONSTRUCT` too, at the tag, naming the tag written ("`else` is part of `if`, and Mesh files are static, so they do not evaluate `if`"). A shape hint ("Tag does not support arguments...") stays only where the construct is legal. What it holds is not checked against the parent's `children` or its own `parents` until the construct is removed, so it gives no second error. This holds anywhere under a tag with a `transform`, too, where the construct is reported while the tag lowers.

The one exception: a tag that fails its own lowering, such as one a closed `children` refuses, is skipped with its subtree. Errors inside that subtree are reported once the refusal is fixed; its siblings are still checked.

**It never throws.** A hook that throws, an invalid explicit dialect, malformed source and a bad `diagnosticCodes` map all come back as diagnostics, and so does a dialect that fails to resolve. An error with no position is reported at 1:0, its message prefixed `internal error: ` for a bug in MX and `unpositioned error: ` for an error in the input.

**Determinism is not promised.** Two calls with the same source, filename and dialect gave byte-identical results in one process. MX states no guarantee, across processes or across releases.

**Caching.** An explicit dialect is validated once and cached by identity only when it is deep-frozen; an unfrozen one is validated on every call. Syntax tables are interned by a content hash (`syntaxHash`). A routed dialect module is cached per file modification time, and a failed load stays cached until the module changes. The merged contracts map is memoized. MX keeps no other state between calls that its lead knows of; this is unverified beyond these caches.

### 3.2 The lowered tree

**IR version.** `IR_VERSION`, exported by `@mxlang/core`, is `8`. It is a constant, not a field of the tree. It goes up by one with every change a reader could observe: a node kind or field added, removed, renamed or given a new meaning. MX's tests pin a hash of the IR's type declarations, so a change of shape fails MX's CI until the number goes up; a change of meaning alone relies on its author to bump it. Mesh fails when the installed version is not the one it reads (section 6).

**The types Mesh reads**, all exported by `@mxlang/core`:

- `SpannedIr` (also `Spanned<T>`): `Ir` with every `span` required at every depth. `Ir` has `imports`, `body`, `hoisted`, `inputInterface`, `needsAttrTagImport`, `prelude`, `tagMetadata`, `exportName` and `returnValue`.
- In `ir.body` Mesh reads `DelegatedTag` nodes (`{ kind, tag, loc }`); in `ir.imports`, `Import` (`code`, `bindings`, `from`, `names`, `typeOnly`, `span`).
- `DelegatedTag`: `name`, `nameSpan`, `span`, `trigger` (`{ id, span, text }`, set on a tag a dialect row built, such as a tagless member line), `alias` (on a wildcard child), `attrs`, `args` (always present, `[]` without arguments), `children`, `attributeTags`, `attributeTagTree`, `attrTagProps`, `params`, `var` and `data`.
- `Attr`, MX's word for an option: `static` (`value`, `valueSpan`, `nameSpan`, and at most one `node`; a whole-value atom is `node: { type: "mesh:Atom", span, name }`, and its `valueSpan` covers the `:`; a member after a kind is `node: { type: "mesh:Member", span, name }`), `boolean`, `dynamic` (`value`, an `Expr`, and `valueSpan`), `bound`, `event` or `spread`; each with `span`, `sugar`, `sugarValueOf` and `args`. A `bound`, `event` or `spread` option carries `valueSpan` too.
- `Expr`: `code`, `shape`, `node` (the Babel node), `span`, `file`, `nodes`, `unrewrittenCode`, `bodySpan` and `bodySource`. `nodes` lists the dialect nodes claimed inside the expression, in source order, each an `ExprNode` `{ type, span, node, forward, code? }`: `forward` is the very object `Expr.node` holds in the node's place, and `code` the range of `Expr.code` it is printed at (absent for an option written as a method shorthand, which is printed, not spliced; its nodes are still listed). `code` is the authored text at `span`, not a reprint: spacing and comments survive. Each dialect trigger in it is replaced by what it lowered to, so `&status === :sent` has the code `self.status === "sent"`. A shorthand `id` or `class` with a placeholder has the template literal core built. An option written as a method shorthand has a printed `function` expression, with triggers lowered and spacing not kept, and `bodySource` keeps its authored block with the triggers as written. With `stripTypes` on (the default), a top-level `as`, `!`, `satisfies` or `<T>x` is not in `code`: `span` and `code` are the operand's. Two `ctx.expression` values from one trigger are spliced twice (section 5). Mesh reads `node` and the span, never `code` (2.4).

**Spans.**

- A span is a `SourceSpan { sourceStart, sourceEnd }`: file-absolute UTF-16 code-unit offsets, end exclusive.
- Under `SpannedIr` every node's `span` is present. `DelegatedTag` and `AttributeTag` carry `nameSpan`, a `DelegatedTag` carries `args`, a static, dynamic, bound, event or spread option carries `valueSpan`, and an `Import` carries `from` and `names`. `bodySpan` and `paramSpans` stay optional.
- An option a contract's `default` added has an empty `span`, `nameSpan` and value span at the end of the tag name. The empty span is how a reader tells it from an authored one.
- A contract's `transform` hook may emit tags; MX returns them with their spans, but with no `nameSpan`, since they have no authored name, and they skip the unknown-tag check. Mesh uses no `transform`.
- These fields are opaque and carry no span: `node`, `paramNodes`, `declaration`, `data`, `loc`, `end` and `tagMetadata`.
- A dynamic option's `value.span` never covers a wrapper. Its `valueSpan` is the value as written, wrapper included, so a reader finds a wrapper where the two differ, and `attr.span` covers the whole written option (3.9). On a static option `valueSpan` stays on the literal, and a wrapper shows only as `attr.span` ending after `valueSpan` (`code=("42" as const)`). Attribute positions do not move.

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
| `nodeTypes` | Registered node types (below). | `Atom`, `Member` |
| `lowerTrigger` | Lowers a fired trigger to IR or Babel nodes. | yes |
| `afterLower` | Checks after lowering, reporting with `unit.fail` and `unit.warn` (default codes `MX_DIALECT_ERROR` and `MX_DIALECT_WARNING`). | yes |
| `contractFields` | Contract keys the dialect claims; any other unknown key is an error. | yes |
| `checkContract` | Extra validation of contract entries. | yes |
| `describeAttribute` | How messages name an option. | yes |
| `explainUnknownTag` | Replaces core's unknown-tag error with the dialect's own. | yes |
| `diagnosticCodes` | Renames core's codes (3.6). | `MX_TO_MESH_CODES` |
| `messageVocabulary` | The words core's messages use for the dialect's files: `attribute` (`one`, `many`, `article`), `file` and `formatTag` (3.10); `tree` is no longer used. | `attribute`, `file` and `formatTag` (2.1) |
| `lowerBlockTag`, `lowerFilter`, `tagFile`, `bindingsCallTags` | Block tags, filters, tag files, and opting tags out of binding calls. | no |

**Node types.** A dialect may register node types: `NodeType` is `{ keys, schema, label?, parse(text, span, ctx), print, lower(node, ctx) }`, and a node is a `DialectNode`, `{ type: "dialect:Type", span }`. Since alpha.34 `schema` (`NodeSchema`, `{ fields, slot }`) is required: `fields` names every field `parse` returns besides `type` and `span` (`"node"`, `"expression"` or `"data"`; the `"node"` ones are exactly `keys`), and `slot` the positions the type fills (`"expression"`, `"value"`, `"line"`, `"attribute"`). Core checks the schema, `print` and `lower` when the dialect loads (`MX_INVALID_DIALECT_MODULE`), refuses a row that names the type at a position outside its `slot`, and checks each parse result and lowered node against it where it is written; a forward another node already stands for is refused, so `lower` returns a fresh object each call. `label`, optional, is the word core's contract messages show for the type (`must be atom, got string`, `must be array, got atom`); messages to the dialect's author keep the key. One registry holds core's types (`mx:*`) and every dialect's. A syntax row names its node as data, as Mesh's value row names `{ type: "Atom", dialect: "mesh" }`. Since alpha.33 an expression row may name a node type too: the type claims the matched text with `ClaimContext.position` `"expression"`, and its `lower` returns the forward, a fresh Babel node per call, since core finds the node by the forward's identity. A contract option's `type` may name a node type the file's dialect registers (`mesh:Atom`, `mesh:Member`, or `{ type: "array", items: "mesh:Atom" }`); core checks the shape at the offending value, and a slot that names an unregistered type is a registration error. The registry is `@unstable`.

**The manifest.** `package.json#mx.dialect` (`DialectManifest`) has the fields `id`, `name`, `extensions`, `module`, `tagDirs`, `tagExtensions`, `sidecars`, `reservedTags` and `mxConfigTags`. They are manifest fields, not `Dialect` fields. Tools read the manifest without running code, and only from the project's direct dependencies. Mesh's values are in 2.2. `reservedTags` applies only when a file is routed to the dialect: in the tools, and in `lowerSource` without an explicit `dialect`. With an explicit `dialect`, as in Mesh's compiler, MX does not consult the manifest.

### 3.4 Atoms and members

Core has no atom or member syntax, no atom vocabulary since alpha.33 and no member vocabulary since alpha.34. Mesh's rows fire, and Mesh's node types and hooks build the nodes:

- An atom is a `mesh:Atom` node wherever it is written. In an expression its type's `lower` returns the forward, a `StringLiteral`; core lists the node in `Expr.nodes` with that forward, and the literal stands in `Expr.code` (`&status === :sent` is `self.status === "sent"`). Mesh finds an atom by the forward's identity in `Expr.nodes`, never by a mark.
- A whole option value the value row claims (`inverse=:owner`) lowers to a `static` option with `node: { type: "mesh:Atom", span, name }`, and counts as `mesh:Atom` for every contract slot.
- A member is a `mesh:Member` node wherever it is written. In an expression its type's `lower` returns the forward, `self.name` (a `MemberExpression`); core lists the node in `Expr.nodes` with that forward. A value that is exactly one member (`on:load=&visible`) is a dynamic option whose `Expr.nodes` lists it. After a kind (`sort asc &dueOn`) the `member` attribute row places a `static` option `member` with `node: { type: "mesh:Member", span, name }`, asking `ctx.attribute` for `once`: a second member on the tag is refused at the later one with Mesh's message, as `MX_INVALID_TRIGGER_USE` (Mesh's `MESH_SYNTAX`). Mesh finds a member by the forward's identity in `Expr.nodes`, as an atom.
- Core sets and reads no mark: neither `extra.mxAtom` nor `extra.mxMember`. Mesh's own `extra.mxTransaction` mark, for `%.now` and `%.today`, is unknown to core, which passes a forward's `extra` through untouched, so it still reaches Mesh's readers.

Core still carries pieces only Mesh uses: the claim-only contract data `CustomTagAttribute.values`, `pattern` and `ref` and `CustomTag.declares`, which Mesh's dialect checks (`contractFields`, `checkContract`, `afterLower`).

### 3.5 Contract semantics

A contract, `CustomTag`, has `defaultTag`, `parseOptions`, `attributes`, `attributeTags`, `children` and `parents`, and the hooks `analyze`, `transform` and `finalize`.

- **`attributes`**, the options. `type` is one of `string`, `number`, `boolean`, `expression`, `array` or `function`, or a node type key the file's dialect registers (`mesh:Atom`, `mesh:Member`), with `items`, `required`, `enum`, `default` and `literalOnly`. `array` and `function` check the written shape; an identifier, a call or a member access has no type MX can know, and is accepted. A node-type slot refuses a string, number, array, function or a node of another type, and passes an expression with no knowable type (`load=(&visible && x)`), so Mesh refuses that one in `afterLower` (2.1). MX checks every tag against its contract. Any other `type` is refused when the contract is registered: `type: "atom"`, removed in alpha.33, and `type: "member"`, removed in alpha.34, name the node type to declare in their message (`MESH_INVALID_CONTRACT` for a contract handed to one call, `MX_INVALID_DIALECT_CONTRACT` inside `Dialect.contracts`). Messages show a node type's `label`: "must be atom, got string", and for a single node in a list slot "must be array, got atom; write it as a list: `[:read]`" (`MESH_OPTION_VALUE`).
- **`children`** are closed when present.
  - A named entry takes `{ required, repeatable }`.
  - `"#text"` permits non-whitespace text and `${}`.
  - `"*"`, the wildcard, takes items `{ pattern, contract }` or an inline contract; `pattern` is an anchored regular expression. A registered tag (any key of the contracts in force, the dialect's included), a core name, a built-in tag or a target's built-in never matches `"*"`: a registered `<field>` under a parent whose only entry is `"*"` gets `MX_TAG_NOT_ALLOWED`. Explicit entries win over `"*"`.
- **`parents`** lists the allowed direct parents; `"#root"` is the top level and `"@name"` an option tag.
- **Text tags** (`parseOptions.text: true`): the body is not parsed as tags (`<b>x</b>` stays text), but `${}` is still an interpolation. `children` cannot be combined with `parseOptions.text` or `openTagOnly` (`MX_INVALID_DIALECT_CONTRACT`). Under `structural: "reject"`, text and `${}` are refused even inside a text tag, so Mesh cannot use text tags while it rejects structure.
- **`tagRules: "none"`**: no native element rules; `script`, `input` and `title` are ordinary names.
- **Reserved core names**, which no contract can define: `if`, `else`, `else-if`, `for`, `const`, `define`, `return`, `import`, `export`, `static` and `try`.
- **A `for` or `if` under a closed parent is reported as the construct**, in every authored form (3.1, 3.12): under `structural: "reject"` it is `MX_STRUCTURAL_CONSTRUCT`, at the construct, and what it holds is not checked until it is removed.
- **A closed vocabulary.** Under `unknownTags: "reject"`, any tag without a contract is `MX_UNKNOWN_TAG`, or the error the dialect's `explainUnknownTag` gives. An unknown tag inside a closed parent reports only the unknown-tag error: the `MX_TAG_NOT_ALLOWED` for the same tag is dropped.
- **Duplicate options.** The last one wins, with an `MX_DUPLICATE_ATTRIBUTE` warning at each dropped one; never an error.
- **Module scope under `none`.** Duplicate import bindings are not checked under `tagRules: "none"` (under `"html"` they are `MX_DUPLICATE_DECLARATION`). Mesh checks imports itself.

### 3.6 Diagnostics and codes

- **The catalogue.** `MX_DIAGNOSTIC_CODES` (frozen, `@unstable`; 130 entries on alpha.28) lists every code `lowerSource` and `checkDialectFile` report, as `{ code, severity, summary }`; `MxDiagnosticCode` is their union. A code is never renamed or reused for another rule; new codes are added.
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

- **mx-tsc** reports the diagnostics of dialect files. `@mxlang/tsc` is not released; since alpha.35 its built command runs under Bun.
- **The language server** publishes them as you type, and watches dialect files.
- **The TypeScript plugin** is check-only: it emits virtual code carrying diagnostics, ranges, codes and fixes.
- **The Vite plugin and the Bun plugin** refuse to import a dialect file ("Mesh files cannot be imported: the dialect registers no emit"). A dialect with no emit step is check-only.

Because the tools route the file rather than pass the dialect, they apply the manifest's `reservedTags` and `tagDirs`. Because `stripTypes` is an option, not a dialect field, a build that passed `stripTypes: false` would see other nodes than the editor; Mesh passes no option (section 5).

### 3.8 Stability and release

- **Before 1.0, nothing is stable.** MX's README says its API may change in any release until 1.0.0. `@unstable` marks API expected to change in an alpha; such a change is announced in the changelog.
- **Marked `@unstable`:**
  - the entry points and their types: `lowerSource`, `lowerFile`, `LowerSourceOptions`, `LowerSourceResult`, `IrDiagnostic`, `SpannedIr`, `Spanned` and `IR_VERSION`;
  - the codes: `MX_DIAGNOSTIC_CODES` and `diagnosticCodesOf`;
  - the dialects: `Dialect` and every field, the syntax table's `tagShorthands`, `DialectManifest` and its fields, `DialectNode`, `NodeType`, `NodeSchema`, `LoweredUnit`, `UnknownTag`, `UnknownTagExplanation`, `routeDialect` and `discoverDialects`;
  - the contract fields `CustomTagAttribute.values`, `pattern` and `ref`.
- **Without a marker:** the IR types (`Attr`, `DelegatedTag` and the rest) are public and versioned by `IR_VERSION`. `CustomTag`, `WildcardChildEntry`, `MxDiagnosticCode`, `Trigger`, `TriggerContext`, `TriggerResult` and `SourceSpan` carry no marker, and fall under the README's note.
- **Who approves a change.** MX's lead approves an additive field that follows a precedent. A change to or removal of a public API, or a new required pattern, goes to the operator, and is announced to Mesh before the alpha that carries it.
- **How a change reaches Mesh.**
  1. Each MX pull request adds a changelog fragment, `changes/<slug>.md`, of kind Added, Changed, Fixed or Removed. MX's CI enforces it on a pull request that touches `packages/*/src` or a package's `package.json`, unless the PR body gives a `no-changelog: <reason>` line (section 6).
  2. At release the fragments are folded into each package's `CHANGELOG.md`, which ships in the `@mxlang/core` tarball.
  3. A change of the IR's shape bumps `IR_VERSION`.
  4. MX's lead tells Mesh's lead the alpha number when a release tag moves, and the link-update script appends the new commits to Mesh's `notes/mx/updates.md`.
- **Releases** are `0.1.0-alpha.N` on `https://npm.saulo.tech`, published under the `alpha` tag, after which `latest` moves to the same version. Nothing is published to npmjs before MX 2 and the framework targets. Mesh pins the version named at the top of this page.

### 3.9 New in alpha.28

Both changes ship in alpha.28; neither exists in alpha.27.

- **`tagShorthands: false` in a syntax table.** The default is `true`, so other files are unchanged; the flag is validated and part of the table's content hash.
  - With `false`, `.` continues a tag name: `billing.InvoiceVoided` is one tag, in concise and HTML form alike, and closes with `</billing.InvoiceVoided>`.
  - `#` anywhere in a tag head, or a head that starts with `.` or `#`, is the new code `MX_NO_TAG_SHORTHAND`. MX exports no constant for it (`NO_TAG_SHORTHAND_CODE` is internal), so a reader matches the string `"MX_NO_TAG_SHORTHAND"`.
  - A trailing `.`, `..`, or a `.` after a dynamic `${…}` name is `MX_INVALID_TAG_NAME`.
  - The wildcard matcher accepts dotted names.
- **The written span of a dynamic option.** Dynamic, bound, event and spread options carry `valueSpan`, the written value with any wrapper (`(x)`, `<T>x`, `x!`, `x as T`, `x satisfies T`); a reader finds a wrapper where `valueSpan` differs from `value.span`. `attr.span` covers the whole written option (in alpha.27 `entity=List as any` ended at `List`). This adds a field to the IR, so `IR_VERSION` is 5. `<T>x` in a concise option value is also lowered to `x`; in HTML form (`<t a=<T>x/>`) it is `MX_PARSE_EXPRESSION`.

### 3.10 New in alpha.29

`Dialect.messageVocabulary` is new in alpha.29; no earlier release has it. `IR_VERSION` stays 5, and the release adds no diagnostic code.

- **`Dialect.messageVocabulary` (`@unstable`).** The words core's messages use for a dialect's files, with the fields `attribute { one, many, article? }`, `file` (a string, or `{ one, many, article? }`) and `formatTag(tag)`. `tree` is no longer used: no message reads it. A malformed value is `MX_INVALID_DIALECT_MODULE`. A dialect that sets none of them, and every `.mx` file, reads exactly as before. An unknown field is `MX_INVALID_DIALECT_MODULE`. A `formatTag` that throws or returns a non-string becomes `MX_DIALECT_HOOK_ERROR`, reported once, at the tag it was spelling.
- **`formatTag`'s `form` follows how the head is written, not what it resolves to.** A head written as a name, PascalCase or bound included (`Money :price`), is form `"tag"`, with `name` as written. A `<${x}/>` head is `"dynamic"`, with `name` set to the expression source. An `@name` attribute tag is `"attributeTag"`, and its `name` has no `@`.
- **A lowered child carries `trigger?` (`ChildTag.trigger`).** A `member` tag that the user wrote as `&title` can be spelled `&title` from `trigger.text`.
- **Not covered yet.** Messages of the targets and hosts (the html target, for example) ignore the vocabulary (MX TODO `target-messages-ignore-dialect-vocabulary`).
- **A `formatTag` that fails on a built-in.** Since alpha.31 a `formatTag` that throws or returns a non-string while spelling one of MX's built-in tags is `MX_DIALECT_HOOK_ERROR` too, reported once, at the tag.
- **Also in the release.** A fix for raw-HTML spreads in JSX and Solid (#596), which touches only the Preact, React, Hono and Solid hosts; Mesh uses none of them.

### 3.11 New in alpha.31

The release fixes five things Mesh asked for. `IR_VERSION` stays 5, no signature Mesh uses changes, and the release adds no diagnostic code.

- **A contract with an `analyze` hook is worded in the dialect's vocabulary.** Before, such a file lowered twice and the first walk, whose errors become the file's, ran without the dialect's words, so every contract check of Mesh's read "attribute" and `<name>`. `analyze` now also receives the lowered `code`, as `transform` does (`self.title` where it saw `&title`); Mesh does not read it yet.
- **Messages about MX's built-in tags go through `formatTag`.** `if`, `else`, `for`, `const`, `define`, `return`, `effect`, `script`, `try`, `await` and the other built-ins reach `formatTag` as form `"tag"`, and their messages use the dialect's word for "attribute".
- **`formatTag` also receives MX's built-in names.** Mesh's `formatTag` spells them as written, with no special case (2.1).
- **A failing `formatTag` on a built-in.** A `formatTag` that throws or returns a non-string while spelling a built-in is `MX_DIALECT_HOOK_ERROR`, once, at the tag.
- **No MX-syntax examples for a dialect that spells the tag otherwise.** The examples in built-in tag messages (`<const/name=value/>`, `<for|item| of=…>`, `<else if>`) are dropped when the dialect does not spell the tag as MX does, so a Mesh message states the rule alone (`const` without a variable name).
- **A `for` or `if` under a closed parent is reported as the construct.** Under `structural: "reject"` it is `MX_STRUCTURAL_CONSTRUCT` (`MESH_STRUCTURAL_CONSTRUCT` for Mesh), at the construct; what it holds is not checked against the parent's children or parents until the construct is removed (3.1). This includes a `for` or `if` anywhere under a tag with a `transform`, which before passed silently or reported only the child.
- **Also in the release.** A spaced `#a` or `.a` in a file whose table sets `tagShorthands: false` no longer gets the advice to write the shorthand on the tag name; the message says the dialect has no `#id` (or `.class`) shorthand and to write `id=` (or `class=`) as an option. MX pull requests #608, #610 and #611 need no contract change (#611 is a type-check fix for the html target only).

### 3.12 New in alpha.32

The release fixes two things Mesh asked for. `IR_VERSION` stays 5, no signature Mesh uses changes, and the release adds no diagnostic code.

- **Every authored form of `for` and `if` is the construct.** Under `structural: "reject"`, `if(x)`, `for(x)`, `for|x|(y)`, `if|x|=a`, and an `if` or `for` with no condition or params are each reported once, and an `else(x)` or `else-if(x)` that follows an `if` is folded into that `if`'s single error (an orphan one stays `MX_NOT_IN_DATA_FILE`, below) as `MX_STRUCTURAL_CONSTRUCT` (`MESH_STRUCTURAL_CONSTRUCT` for Mesh), at the construct. Before, a form with arguments or params got a shape hint instead, such as "Tag does not support arguments. Write the condition as a value option instead." (`MESH_UNSUPPORTED_CONSTRUCT`) at the argument. The shape hints stay only where the construct is legal. This closes 3.1 and 3.5 for every form. Mesh's `fix:` for `for` and `if` (`staticFileFix` in `src/front-end/build.ts`) is unchanged: it keys on the code and the construct named in the message, and MX still gives no advice on what to write instead.
- **Orphan `else`, `else-if` and `try` read in the dialect's words.** In a file whose dialect sets `messageVocabulary.attribute`, `file` or `formatTag`, an orphan `else` or `else-if` is "`else` must come right after `if` or `else-if`" (before, "`else` cannot name a data tag: it is reserved..."), and a `try` is "`try` cannot be used in a Mesh file: Mesh files are static, so they have no render errors to catch; write its content directly". The code stays `MX_NOT_IN_DATA_FILE` (`MESH_NOT_IN_ENTITY_FILE`). A later release will report an orphan `else` under `structural: "reject"` as `MX_STRUCTURAL_CONSTRUCT`; Mesh's map already covers that code.
- **Also in the release.** Core exports `flattenErrors` (`@unstable`; Mesh does not use it); a `<script>` with args, params, a tag variable or a duplicate value is refused; the Solid shorthand class merges with a static `class=`. None reaches Mesh.

### 3.13 New in alpha.33

The release takes atoms out of core and lets a dialect node stand inside an expression. `IR_VERSION` is 6.

- **Atoms leave core** (MX's change `expr-nodes-and-atoms-out`). Removed: the `Atom` and `MxAtomMark` types, `Expr.atoms`, a static `Attr`'s `atom`, the contract type `"atom"`, core's `mx:Atom` node type and its checks of `values`, `pattern` and `ref`, `ContractAtomOrMember` (now `ContractMember`), the `{ kind: "atom" }` value of `ctx.attribute`, and core's reading of `extra.mxAtom`. Added: `ExprNode` and `Expr.nodes` (3.2), node types in expression rows and contract types that name a node type (3.3). Mesh registers `mesh:Atom` in both rows, types its options `mesh:Atom` or an array of it (2.1) and reads atoms by forward identity (3.4). A slot that took one atom or a list is now one of the two, so `require=:x` became `require=[:x]` in the contract tests; no entity file, example or doc wrote a list slot with one atom.
- **The golden tree changed accordingly.** Every `atom` became `node: { type: "mesh:Atom", span, name }`, a name option's `valueSpan` now starts at the `:`, and every `Expr.atoms` became `Expr.nodes`, one entry for one entry.
- **Tag arguments** (MX #633, #635). A tag that takes no arguments blames the whole argument list, not its first argument; an empty `()` compiles as if it were absent. In a Mesh file `entity(a, b) :Todo` is `MESH_UNSUPPORTED_CONSTRUCT` "Tag does not support arguments." over `a, b`, and `entity :Todo()` stays Mesh's own `MESH_SYNTAX`. No Mesh test pinned the old ranges.
- **Also in the release.** The duplicate-export fixes and the scoping of tag variables to an element's body touch module statements and tag variables, which a Mesh file refuses, so neither reaches Mesh.

### 3.14 New in alpha.34

The release takes members out of core, makes node schemas mandatory and drops the marks. `IR_VERSION` is 7.

- **Node schemas** (MX #646). Every node type declares `schema`, a forward and a printer (3.3). Mesh's `mesh:Atom` and `mesh:Member` declare `{ fields: { name: "data" }, slot: ["expression", "value"] }`: both are claimed by an expression row, so `"expression"` is in the slot, and both are placed in value position.
- **Members leave core** (MX #651, `drop-mx-member-marks`). Removed: the `Member` and `MxMemberMark` types, a static `Attr`'s `member`, `ContractMember` (and `mx:Member` in a `LoweredUnit` view), the contract type `"member"` and its check, the `{ kind: "member" }` value of `ctx.attribute`, core's one-member-per-slot check, and core's reading of `extra.mxMember`. Mesh registers `mesh:Member` (2.1), types its member options `mesh:Member`, reads members by forward identity (3.4), and refuses in `afterLower` an expression in a member option that is not exactly one member. A second member after a kind is refused through `ctx.attribute`'s `once`, so its code moved from `MESH_INVALID_OPTION` (`MX_INVALID_ATTRIBUTE`) to `MESH_SYNTAX` (`MX_INVALID_TRIGGER_USE`), it is reported at the second member, and the message is Mesh's own: "a line takes one member reference: `&d` follows the one at 1:10".
- **No marks.** Core sets and reads neither `extra.mxAtom` nor `extra.mxMember`, and Mesh no longer sets `extra.mxAtom`. Mesh's `extra.mxTransaction` mark still reaches its readers (3.4).
- **Labels** (MX #652). Core's contract messages show a node type's `label` (3.3): "must be mesh:Atom, got string" reads "must be atom, got string", and Mesh's own message for a string where an atom belongs reads the same.
- **Marks clash only when identical** (MX #650). Two installed dialects clash when a mark is the same text, two character sets share a character, or a literal is one character of a set; a prefix (`%` against `%.`) is no clash. Mesh's marks (`:`, `&`, `%.`) are unchanged.
- **The `dialect` option is checked for clashing marks** (MX #648), against the dialects the file's project installs, when the file name is absolute and its nearest `package.json` is found. `mesh build` passes the absolute path (2.3), so a clash fails the build as it fails in the editor.
- **The golden tree changed accordingly.** Every `extra.mxAtom` and `extra.mxMember` mark left the goldens, every member expression's `Expr.nodes` lists a `mesh:Member`, a member after a kind became `node: { type: "mesh:Member", span, name }`, and the one message that named `mesh:Atom` names `atom`.
- **Also in the release.** A lone `static` line is accepted, a top-level `export default` with no `static`, `server` or `client` before it is `MX_INVALID_STATEMENT` (#649), and Angular fixes (#641, #645). A Mesh file refuses module statements, so none reaches Mesh, and no Mesh test changed.

### 3.15 New in alpha.35 and alpha.36

Mesh skipped alpha.35 and moved from alpha.34 to alpha.36. `IR_VERSION` is 8.

- **`Const.varBindings`** (alpha.35). The IR's `Const` node gains `varBindings`. Mesh does not read it.
- **Orphan `else` and `else-if`** (MX #655, #671). Under `structural: "reject"` an orphan `else` or `else-if` is `MESH_STRUCTURAL_CONSTRUCT` at the tag, as an `if` is, no longer `MESH_NOT_IN_ENTITY_FILE` (3.1). Its message names the tag written: "`else` is part of `if`, and Mesh files are static, so they do not evaluate `if`". Alpha.35's text did not name the tag written, which is why Mesh waited for alpha.36.
- **Partial IR, opt-in** (MX #669). With `partial: true`, `lowerSource` and `lowerFile` may return the IR beside the errors, failed subtrees left out and the result marked `partial: true`, when recovery can build one (3.1). Mesh passes no option (2.3), so its build is unchanged.
- **mx-tsc under Bun** (MX #665). The built command runs under Bun; the TS18003 failure is gone.
- **Attribute arguments in web-UI hosts** (MX #670). Hosts refuse attribute arguments through the opt-in `HostDeclarations.attributeArgs`. Core's default lowering keeps `Attr.args`, so Mesh is unaffected.

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
| A node-typed option holds a node of that type, or an array of them, and names a registered type | MX | contract registration and `validateCustomTagCall` |
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
| The installed `@mxlang/core` speaks IR version 8 | Mesh | `test/ir-version.test.ts` |
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

Each item names its MX TODO slug or MX decision, where it has one.

- **No partial IR on error.** A file with an error gives no tree, so Mesh runs none of its own checks on that file until MX's errors are fixed. Since alpha.36 `lowerSource` can return a partial IR when the caller passes `partial: true` and recovery succeeds (3.1); Mesh does not pass it yet.
- **A refused tag hides its subtree.** A tag refused by its own lowering hides the errors inside it until the refusal is fixed (3.1). MX decision 162; no TODO.
- **Wrapped references.** MX lowers `(x)`, `<T>x`, `x!`, `x as T` and `x satisfies T` to `x` and keeps the written value in `valueSpan` (3.2). Mesh's `entity=` hook refuses a wrapped reference, `entity=<T>Customer` or `entity=(billing.Invoice)`, as `MESH_ENTITY_REFERENCE` at the written value, wherever `valueSpan` differs from `value.span` (`isWrapped` in `src/front-end/contracts.ts`). `entity=` is the only option Mesh reads a reference from today; `on=` will take the same check when it is built. A wrapped literal (`max=(5)`, `code=("42" as const)`) is not a reference and still builds.
- **Dotted line heads.** Mesh's dialect sets `tagShorthands: false` (2.1), so a dotted line head such as `billing.InvoiceVoided` is one tag of that name, and `#x`, `.x` or a `#` inside a head is `MESH_NO_TAG_SHORTHAND`. No section that lists references by line head is built yet (an owner's `events` and `commands` sections are M6 work), so no Mesh contract takes a dotted tag and such a head is `MESH_UNKNOWN_TAG`.
- **Dialect nodes inside expressions.** Shipped in alpha.33 (3.13): MX records every dialect node inside an expression in `Expr.nodes`, with `Expr.code` staying clean JavaScript, and contract types name a node type (`mesh:Atom`). Mesh reads atoms and, since alpha.34, members that way. The mandatory node schema (fields, forward, printer, disjoint marks) shipped in alpha.34 (3.14). Mesh's `extra.mxTransaction` mark for `%.now` and `%.today` still reaches Mesh's readers, since core passes a forward's `extra` through; moving it to a `mesh:Transaction` node type is open. MX TODO `research-nodes-inside-expressions`, MX decision 222.
- **Members leave core.** Shipped in alpha.34 (3.14): a member is Mesh's `mesh:Member` node, and core has no member vocabulary. With it the marks gap of `mesh build` closed: the build passes the absolute file path, so core checks Mesh's marks against the project's installed dialects as the editor does (2.3). MX TODO `member-to-dialect-registry`, MX decision 218.
- **Dialect files are check-only.** The Vite and Bun plugins refuse to import them. MX TODO `dialect-emit-step`, MX decision 218.
- **`stripTypes` is not a dialect field**, so the editor and a build that passed the option could see different nodes. MX TODO `strip-types-dialect-field`.
- **Overlapping splices.** Two `ctx.expression` values from one trigger are spliced twice. MX TODO `trigger-splice-overlap`.
- **An unchecked `defaultTag`.** An invalid `defaultTag` inside `children["*"]` is not checked when the contract is registered. MX TODO `contract-default-tag-scan-children-wildcard`.
- **Reloading a dialect.** A dialect module is not reloaded in watch mode (MX TODO `sync-esm-reload-node`), and reloading is untested (MX TODO `dialect-reload-untested`).
- **No formatter for node types.** A node type's `print` has no formatter to plug into. MX TODO `dialect-print-formatter`.
- **Highlighting.** The docs site highlights `mx` fences with MX's tree-sitter highlighter, `@mxlang/tree-sitter-mx` `0.1.0-alpha.2` ([ADR-0065](../decisions/0065-mx-highlighting-on-the-docs-site.md)). It treats `input` as an HTML void tag, so the docs plugin carries one counted allowance, `MX_V4_INPUT_PENDING_SYNTAX_TABLE`, which gives nested input sections and bare member lines same-width stand-ins for highlighting only, and one render-only overlay, `MESH_V4_MEMBER_RENDER`, which colours `&name` heads and `%.now`/`%.today` where they start an operand. The rendered text is always the authored text. A line at the left margin ends the root tag's block, a comment included, so a comment inside an entity is indented with its block; the grammar reports such a line as an error and the docs build fails, naming the page and the line. Both bridges go when MX ships the syntax-table route for highlighting and `@mxlang/tree-sitter-mx` moves past alpha.2. MX's editor grammars also still colour sugars core removed. MX TODOs `mesh-syntax-highlighting-route` (MX decision 182, addendum 1) and `editor-grammars-layer-2`.
- **MX's words in messages.** Present since MX alpha.29. Mesh's dialect sets `messageVocabulary` (2.1, 3.10): MX's messages call a `key=value` an "option", a Mesh file a "Mesh file", and spell a tag as its line is written (`&title`, `attributes`), not as `<member>` or `<attributes>`. Mesh's own hook messages say "option" for a `key=value` too. The static-file messages read "Mesh files are static, so they do not evaluate `if`". Since alpha.31 a contract with an `analyze` hook, which is every contract of Mesh's, is worded the same way (`entity`: unknown option `module`), and so are the messages about MX's built-in tags (`const` without a variable name), which use the dialect's noun and drop an example written in MX's syntax (`<const/name=value/>`, `<for|item| of=…>`, `<else if>`). No Mesh path reaches a target or host message, since Mesh calls only `lowerSource`, so the target messages that ignore the vocabulary (MX TODO `target-messages-ignore-dialect-vocabulary`) do not affect Mesh today.
- **One read of `Expr.code`.** The rollup `of=` hook in `contracts.ts` refuses whitespace inside a member path by testing `Expr.code`, which breaks promise 2.4.1. It is to be replaced by a test of the member nodes' spans; not yet scheduled.
- **The changelog in the tarball.** MX TODO `release-changelog-in-package` is still open, though `@mxlang/core`'s `files` already lists `CHANGELOG.md`.
- **Mesh drops `end`, `fixes` and `file`.** `meshDiagnostic` keeps only a diagnostic's start, so `mesh build` shows no range and none of the fixes MX offers, and a diagnostic in another file would be placed in the parsed one. Not yet scheduled.
- **Expression diagnostics in the editor.** An unsupported construct inside a translated expression is to be reported in a contract's `analyze` hook, so the editor shows it as the author types: an error where SQL is required (a filter, a sort, a policy), otherwise a notice that the expression runs in memory. Not built ([ADR-0056](../decisions/0056-translated-expressions-are-one-expression-arrows.md)).
- **Concepts.** A `tagDirs` entry for Mesh's concept directory, and the hook that turns a tag file into a contract, designed with MX for any dialect ([ADR-0085](../decisions/0085-tag-discovery-for-dialect-tags.md)). A concept's file is named after the concept (`concepts/Money.mesh.mx` declares `concept :Money`). A project's concept never takes the name of a concept Mesh ships: such a file is `MESH_RESERVED_TAG` at the project's file, as for any reserved Mesh tag. A nearer `concepts/` folder may declare a concept with the name of one in a farther folder: the nearer one wins for the files under it, with no message, as for every tag MX discovers.
- **Extensions.** Mesh composes its dialect from core plus the enabled extensions, which replaces [ADR-0021](../decisions/0021-composed-contracts-module.md)'s composed `mx.contracts` module. It comes with the extension host, after 1.0.
- **HTML-form entity files.** Entity files are written in the concise form; whether the build refuses an HTML-form file, and whether the tree can tell the forms apart, is not decided; every entity file and example uses the concise form ([ADR-0041](../decisions/0041-mx-concise-syntax.md)).

## 6. How each side is held to it

### Mesh's tests

All of them run in `bun run verify`, which GitHub Actions runs on every pull request and every push to `main` ([ADR-0031](../decisions/0031-no-ci-until-mx-is-published.md)). The compiler's tests are under [`packages/compiler/test/`](https://github.com/svallory/mesh/tree/main/packages/compiler/test).

- **The MX import boundary** (M1 test 8, [ADR-0043](../decisions/0043-mx-is-core.md)). `checkMxImports` in `repository-checks.ts`, run by `repository-checks.test.ts`, reads every `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` and `.json` file under `packages/`, `apps/` and `examples/` as text, without parsing it. Any occurrence of `@mxlang` outside the allow-list, `MX_IMPORT_PACKAGES` (today `packages/compiler` only), fails, naming the file and the line of its first occurrence: comments and strings count on purpose, and so does a dependency in any `package.json` field. The one exception is the docs site's highlighter, `@mxlang/tree-sitter-mx`, by exact package name. Only paths with a `node_modules` segment, `apps/docs/site`, `apps/docs/docs` and lock files are skipped; other folders named `build`, `dist`, `site` or `coverage` are scanned. Planted sources prove it fails, while MX-free angle brackets and JSX pass. A specifier assembled at run time from pieces can evade a substring scan; the dependency rule and review are the backstop.
- **The compiler's halves.** `architecture.test.ts` scans the imports of `src/`: the TypeScript back end and `src/model/` never import `@mxlang` or the front end ([ADR-0076](../decisions/0076-compiler-front-end-and-back-end-are-separate.md)). It also runs `checkHookFailCodes`, which fails when a `ctx.fail`, `unit.fail` or `fail` call in the dialect, the syntax rows or the contracts passes no `code`.
- **`no-core-syntax-import.test.ts`** fails on any import of `@mxlang/core/syntax` in `packages/` or `examples/`, with planted spellings proving the scan.
- **`dialect-registration.test.ts`** routes files in a temporary project. A project that depends on `meshfw` gets its `.mesh.mx` files, and only those, routed to the `mesh` dialect, and one without `meshfw` gets no dialect. With no options, MX takes the vocabulary, tag rules and strictness from the dialect, as strict as the compiler. The module is built JavaScript Node can load, with no TypeScript beside it. The build refuses a manifest whose extensions drift. `reservedTags` equals the contracts' keys. A project's `mx.tags`, `mx.contracts` and `tags/` reach a `.mx` file but not a `.mesh.mx` one, and a project definition or `customTags` entry named like a Mesh tag never replaces Mesh's contract (`MESH_RESERVED_TAG`).
- **`dialect-deep-freeze.test.ts`** fails when any object or array reachable from `MESH_DIALECT` is not frozen.
- **`diagnostic-codes.test.ts`** fails when an MX alpha adds a code `MX_TO_MESH_CODES` leaves out, or when the map names a kept code or a code outside MX's catalogue; the type of the map fails the type check too. It also checks that the build and MX give one Mesh code at one place, that a throwing hook is `MX_DIALECT_HOOK_ERROR` and that a dialect that fails to load renames nothing.
- **`ir-version.test.ts`** fails unless the installed `@mxlang/core` exports `IR_VERSION` 8.
- **`dialect-marks.test.ts`** builds a project on disk that installs a second dialect: one whose mark is Mesh's `&` or `:` fails the build at the project-relative file, and one whose mark only shares a prefix with Mesh's builds.
- **`packages/cli/scripts/build-dialect.ts`**, a `verify` step, fails the build when the manifest's `id`, `extensions` or `module` drift.
- **The docs fence checks.** `checkDocsSamples` (run by `repository-checks.test.ts`) and the stricter `checkDocsSyntaxV4` (run by [`apps/docs/test/docs-mx-syntax.test.ts`](https://github.com/svallory/mesh/blob/main/apps/docs/test/docs-mx-syntax.test.ts)) walk every `mx` fence of the user pages (`apps/docs/docs/docs/*.md`) and of ADR-0050's reference. A bounded text guard first rejects obsolete spellings, undeclared member heads, unimported entity identifiers and a `self.` read without a destructured `self` in its function; a `resource` root is an error. Then each fence parses as authored through `parseEntitySource`, with no rewriting and no relaxed contracts, so misplaced member lines and assignments in `input` are parse errors. The stricter walker requires every fence to be a complete entity file, and the docs test counts the opening fences on its own, so the walker cannot lose one unnoticed. The checks print the files checked and the findings, fail on an empty set, and name the page and fence line of each finding; planted failures cover both walkers. This guard is not full contract or type checking.
- **The docs build** fails on any error node the highlighter reports, apart from the counted `input` allowance (section 5).

### MX's tests

- **The IR version hash.** `ir-entry/ir-version.test.ts` in `@mxlang/core` pins `IR_VERSION` together with a hash of the IR's type declarations, so a change of shape fails MX's CI until the version goes up.
- **The diagnostic code table.** `ir-entry/diagnostic-code-table.test.ts` keeps one row per code of `MX_DIAGNOSTIC_CODES`, each reached at a pinned position. The never-renamed rule is enforced by review, not by this test.
- **The changelog fragment check.** [`scripts/check-changelog-fragment.ts`](https://github.com/svallory/mxlang/blob/main/scripts/check-changelog-fragment.ts) fails an MX pull request that touches `packages/*/src` or a package's `package.json` and adds no `changes/<slug>.md` fragment, unless the PR body gives a `no-changelog: <reason>` line.

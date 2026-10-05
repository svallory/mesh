---
title: "Which validation library should Mesh generate validators with?"
description: "Research of 2026-10-05: Zod 4, Valibot, ArkType, TypeBox, Effect Schema and Typia compared for generated validators; recommends ArkType, which the lead did not adopt."
---

# 10. Which validation library should Mesh generate validators with?

> No independent fact-check of this document exists. Decision record: [ADR-0062](../decisions/0062-direct-dependencies-zod-drizzle-opentelemetry.md), which keeps Zod 4 against this document's recommendation.

Written 2026-10-05. Every number and claim below was read or measured on that date unless marked "not verified". Facts and judgement are kept apart: sections titled "Judgement" are mine.

## 1. The question

Mesh is a TypeScript framework that runs on Bun only. A developer describes an entity once; Mesh generates TypeScript types, one strict input validator per action, a Drizzle schema (drizzle-orm 0.45.x stable line, Postgres and SQLite) and handlers. Today the validators are emitted for Zod 4.6.5. Mesh's runtime only calls the Standard Schema function `~standard.validate` (spec: https://standardschema.dev), but the generated files import the library directly, so the user's project depends on it, and users read that code. The generated file also holds a compile-time assertion that the validator's output type equals the generated TypeScript input type.

Owner's request: "there are better options than zod (more readable and more typescript native). Research and pick the best as long as it pairs well with drizzle."

Criteria, in order: (1) readability and TypeScript-nativeness, (2) Drizzle pairing, (3) Standard Schema, (4) type-level fit, (5) error output, (6) runtime, (7) maturity and risk, (8) fitness as a code-generation target.

## 2. How the evidence was gathered

- npm registry JSON (`https://registry.npmjs.org/<pkg>`), npm downloads API (`https://api.npmjs.org/downloads/point/last-week/<pkg>`, week 2026-09-27 to 2026-10-03), GitHub API (`https://api.github.com/repos/<owner>/<repo>`), official docs (zod.dev, valibot.dev, arktype.io, orm.drizzle.team, standardschema.dev), package READMEs.
- Hands-on: I installed the real packages in a scratch directory outside the repo (zod 4.6.5, valibot 1.5.0, arktype 2.2.7, typebox 1.3.34, @sinclair/typebox 0.34.52, effect 4.0.1, drizzle-orm 0.45.3, drizzle-zod 0.8.3, drizzle-valibot 0.4.2, drizzle-arktype 0.1.3, drizzle-typebox 0.3.3), type-checked every example below with TypeScript 7.0.2 (and 5.9.3 for the performance runs), and ran them on Bun 1.3.14. Items marked "(measured)" come from that scratch run; they are my own synthetic tests, not vendor numbers.
- A docs-summarising tool was used for several pages; where a summary contradicted package contents I trusted the package (one case: it claimed TypeBox supports Standard Schema; the package and the maintainer say it does not, see section 5.4).

## 3. Comparison table

Terse. Versions and dates are the npm `latest` on 2026-10-05.

| Library | 1 Readability / TS-native | 2 Drizzle (stable 0.45.x line) | 3 Standard Schema | 4 Type fit | 5 Errors | 6 Runtime | 7 Maturity | 8 Codegen target |
|---|---|---|---|---|---|---|---|---|
| **Zod 4** 4.6.5 (2026-09-13) | Method chains, familiar. `z.number().min(0)`. Not TS-syntax. | `drizzle-zod` 0.8.3, last release 2025-08-06, peers `zod ^3.25 \|\| ^4`, `drizzle-orm >=0.36` | Yes, v1 (`vendor: "zod"`, measured) | `z.strictObject`; `.nullish()` infers `notes?: string \| null \| undefined`; fails equality under `exactOptionalPropertyTypes`. Check time 1x (baseline) | Issues carry `code`, `path`, `message`, plus extra fields; `params` pass through on custom checks (measured); 70+ locales | JIT with `new Function`, falls back safely, `jitless` flag. Bundle 26.6 kB gz for the example (measured); 5.91 kB gz for a trivial schema per zod.dev | 385M weekly downloads, 44k stars, MIT, 1 npm maintainer, ~1089 commits by the author; v4 released 2025-07-09 after v3 line | Very regular. Most LLM and human familiarity |
| **Zod Mini** (`zod/mini`, same package) | Functional: `z.number().check(z.gte(0))`. Slightly noisier | Same drizzle-zod (it targets `zod`; Mini compatibility not verified) | Yes, v1 (measured) | Same as Zod | Same as Zod | 6.0 kB gz for the example (measured); 2.12 kB vs 5.91 kB trivial per zod.dev | Same project | Regular; worse to read than Zod |
| **Valibot** 1.5.0 (2026-09-09) | `v.pipe(v.number(), v.minValue(0))`; pipe nesting is the cost. | `drizzle-valibot` 0.4.2, 2025-05-20, peer `valibot >=1.0.0-beta.7`; 19k downloads/week | Yes, v1 (measured) | `v.strictObject`; same `?: T \| undefined` result as Zod. Check time about 3.5x Zod on TS 7, 4.5x on TS 5.9 (measured) | Issues have `kind`, `type`, `expected`, `received`, `message`, `path` items; the Standard Schema path items include the whole parent input object (measured); `@valibot/i18n` | No `eval`. 1.9 kB gz for the example (measured); fastest import (+20 ms for 200 entities) | 25M weekly, 9k stars, MIT, one author (2346 of commits), 1.0 on 2025-03-19 | Regular; `pipe` composition is easy to emit |
| **ArkType** 2.2.7 (2026-10-01) | Strings mirror TypeScript: `amount: "number >= 0"`, `"notes?": "string \| null"`. Most TS-native. | `drizzle-arktype` 0.1.3, 2025-05-20, peer `arktype >=2.0.0`; 12.8k downloads/week | Yes, v1, with `jsonSchema` (measured) | Exact optional semantics: `"notes?"` gives `notes?: string \| null`, passes under `exactOptionalPropertyTypes` (measured). Heaviest type-check: about 8x Zod on TS 7, 7x on TS 5.9 (measured) | Rich `ArkError` (`code`, `expected`, `actual`, `problem`, `message`, `meta`); `.configure({ message })`, arbitrary `meta` keys flow through (measured); i18n is "not in scope" per docs | `new Function` precompile, `jitless` option. 48 kB gz (measured); startup +480 ms for 200 entities (measured); slow invalid path 82k ops/s | 2.5M weekly, 7.9k stars, MIT, essentially one maintainer (651 commits by the author); 2.0 on 2025-01-17 | Regular but it is string-DSL emission: escaping and quoting |
| **TypeBox** `typebox` 1.3.34 (2026-09-18); old `@sinclair/typebox` 0.34.52 | JSON Schema builder. `Type.Number({ minimum: 0 })` | `drizzle-typebox` 0.3.3 (peer is old `@sinclair/typebox >=0.34.8`); 73k/week. v1 line has `drizzle-orm/typebox` and `typebox-legacy` | **No.** Not native; maintainer says it "probably wont" (issue #1154). Copy-paste adapter only | JSON-Schema model has **no `Date`** type (`Type.Date` does not exist in 1.x, measured). Cannot assert equality with a `Date` field | AJV-like JSON Schema errors (`keyword`, `instancePath`, `message`) | Compile uses `new Function` with fallback | 15M weekly (`typebox`) + 143M (`@sinclair/typebox`), licence file says MIT, GitHub API reports `NOASSERTION`, 1 maintainer, 0.x to 1.0 on 2025-09-09 with a new package name | Not usable without a Date workaround |
| **Effect Schema** in `effect` 4.0.1 (2026-10-05; v4 stable 2026-10-01) | `Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))`; readonly by default so needs `mutableKey` and `mutable` for plain TS types | Official in the v1 RC line only (`drizzle-orm/effect-schema`). No separate stable package found | Via explicit `Schema.toStandardSchemaV1(...)` wrapper (measured) | Exact optional via `optionalKey`; readonly vs mutable mismatch (measured). 1.4x Zod on TS 7, 1.7x on TS 5.9 (measured) | Tree of `SchemaIssue`; Standard Schema issues are only `{path, message}` | No `eval` found in the Schema code I grepped. 76.5 kB gz (measured). Slowest valid path (0.49M ops/s, measured) | 52M weekly (whole Effect), 17k stars, 2 npm maintainers, several core authors; v4 is 4 days old | Verbose, drags a whole runtime ecosystem into every user project |
| **Typia** 15.1.0 (2026-10-02) | Pure TS types: `amount: number & tags.Minimum<0>`. Most TS-native of all | None found | Docs claim `createValidate` implements it (not verified by running) | Validates a real TS type; no separate schema to keep equal | `IValidation` with `path`, `expected`, `value` | Needs a compile-time transformer (`ttsc`, `@ttsc/unplugin`); Bun support not verified | 395k weekly, 5.9k stars, MIT, 1 maintainer | Conflicts with build setup; see 5.6 |
| Superstruct 2.0.2, Yup 1.7.1, io-ts | Dropped, see 5.7 | | | | | | | |

## 4. The same schema in every library

Target shape: `{ title: string; notes?: string | null; status: "draft" | "sent"; amount: number (>= 0); dueOn: Date; tags: string[] }`, strict (unknown keys rejected). Each snippet below, apart from the TypeBox and Typia ones, was type-checked with `tsc --strict` against `type Invoice = {...}` using an `Equal<A, B>` assertion (the same assertion style Mesh generates) and passed. The TypeBox snippet type-checks and runs but cannot satisfy the `Date` field. Typia was not run.

**Zod 4** (https://zod.dev/api, read 2026-10-05)
```ts
import * as z from "zod";
export const invoice = z.strictObject({
  title: z.string(),
  notes: z.string().nullish(),
  status: z.enum(["draft", "sent"]),
  amount: z.number().min(0),
  dueOn: z.date(),
  tags: z.array(z.string()),
});
```

**Zod Mini** (https://zod.dev/packages/mini)
```ts
import * as z from "zod/mini";
export const invoice = z.strictObject({
  title: z.string(),
  notes: z.nullish(z.string()),
  status: z.enum(["draft", "sent"]),
  amount: z.number().check(z.gte(0)),
  dueOn: z.date(),
  tags: z.array(z.string()),
});
```

**Valibot 1.x** (https://valibot.dev/guides/schemas/, https://valibot.dev/guides/pipelines/)
```ts
import * as v from "valibot";
export const invoice = v.strictObject({
  title: v.string(),
  notes: v.nullish(v.string()),
  status: v.picklist(["draft", "sent"]),
  amount: v.pipe(v.number(), v.minValue(0)),
  dueOn: v.date(),
  tags: v.array(v.string()),
});
```

**ArkType 2** (https://arktype.io/docs/objects: `"key?"` optional keys and `"+": "reject"`)
```ts
import { type } from "arktype";
export const invoice = type({
  "+": "reject",
  title: "string",
  "notes?": "string | null",
  status: "'draft' | 'sent'",
  amount: "number >= 0",
  dueOn: "Date",
  tags: "string[]",
});
```

**Effect Schema 4** (API names confirmed in `effect/src/Schema.ts` of the installed 4.0.1; strictness is not in the schema but in the parse options, so the Standard Schema wrapper takes `onExcessProperty: "error"`)
```ts
import { Schema } from "effect";
export const invoice = Schema.Struct({
  title: Schema.String.pipe(Schema.mutableKey),
  notes: Schema.optionalKey(Schema.NullOr(Schema.String)).pipe(Schema.mutableKey),
  status: Schema.Literals(["draft", "sent"]).pipe(Schema.mutableKey),
  amount: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.mutableKey),
  dueOn: Schema.Date.pipe(Schema.mutableKey),
  tags: Schema.mutable(Schema.Array(Schema.String)).pipe(Schema.mutableKey),
});
export const standard = Schema.toStandardSchemaV1(invoice, {
  parseOptions: { onExcessProperty: "error" },
});
```
Without the `mutableKey` and `mutable` calls the output type is readonly and the equality assertion fails (measured). The bare version is shorter but is not equal to a plain TypeScript object type.

**TypeBox 1.x** (https://github.com/sinclairzx81/typebox, readme read 2026-10-05). `Type.Date` does not exist in 1.3.34; the best honest version is a string:
```ts
import Type from "typebox";
export const invoice = Type.Object({
  title: Type.String(),
  notes: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  status: Type.Union([Type.Literal("draft"), Type.Literal("sent")]),
  amount: Type.Number({ minimum: 0 }),
  dueOn: Type.String({ format: "date-time" }), // a string, not a Date
  tags: Type.Array(Type.String()),
}, { additionalProperties: false });
```

**Typia 15** (https://typia.io/docs/validators/validate/, from docs, not run). The schema is the TypeScript type itself; a transformer generates the validator at build time:
```ts
import typia, { tags } from "typia";
interface Invoice {
  title: string; notes?: string | null; status: "draft" | "sent";
  amount: number & tags.Minimum<0>; dueOn: Date; tags: string[];
}
export const validate = typia.createValidateEquals<Invoice>(); // Equals = reject extra keys
```

## 5. Evidence per library

### 5.1 Zod 4 (baseline, including zod/mini)

- Facts. 4.6.5 published 2026-09-13; 26 stable releases in the last 12 months; Zod 4.0.0 on 2025-07-09 (registry `time`, https://registry.npmjs.org/zod). 385,061,788 downloads last week (https://api.npmjs.org/downloads/point/last-week/zod). 44,056 stars, MIT, pushed 2026-10-02 (https://api.github.com/repos/colinhacks/zod). One npm maintainer; the author has 1089 of the commits (https://api.github.com/repos/colinhacks/zod/contributors).
- Docs say Zod 3 is "functionally end-of-life" and new libraries should target Zod 4 (https://zod.dev/library-authors). Per-check messages: `z.string().min(5, "Too short!")`; `z.config({ customError })`; 70+ locales via `import { en } from "zod/locales"` (https://zod.dev/error-customization).
- Measured: `~standard` is `{ vendor: "zod", version: 1 }`, plus `jsonSchema`. Standard Schema issues come straight from Zod, so they keep `code` and extras. A refine with `params: { code: "AMOUNT_NEG" }` yields `{"code":"custom","path":["amount"],"params":{"code":"AMOUNT_NEG"},"message":"neg"}` in both `safeParse` and the Standard Schema result. This is outside the Standard Schema spec (which only guarantees `message` and `path`) but it works.
- JIT: Zod probes whether `new Function` works and `jitless` turns it off (`zod/v4/core/util.js`, `schemas.js` in the installed package).
- Bundle: https://zod.dev/packages/mini reports 5.91 kB gzip for Zod and 2.12 kB for Mini on `z.boolean().parse(true)` (vendor figure). My bundle of the invoice schema with `bun build --minify`: Zod 92 kB raw, 26.6 kB gzip; Mini 17.8 kB raw, 6.0 kB gzip.
- Speed (measured, 300k iterations, valid object through `~standard.validate`): Zod 1.43M ops/s, Mini 0.94M. Invalid object: 0.60M and 0.38M.

### 5.2 Valibot

- Facts. 1.5.0 published 2026-09-09; 1.0.0 on 2025-03-19; 7 stable releases in 12 months. 25,463,592 downloads last week; 9,029 stars; MIT; one maintainer who wrote most commits (2346; second 278) (GitHub API). Docs credit it as a bachelor-thesis project by Fabian Hiller (https://valibot.dev/guides/introduction/), which is background, not a risk assessment.
- Vendor claims (treat as vendor): "starting at less than 700 bytes", "up to 95 %" smaller than Zod (https://valibot.dev/guides/introduction/). Measured example: 5.2 kB raw, 1.9 kB gzip. It is the smallest by far.
- Strict objects: `v.strictObject`. A valid input plus one extra key returns `typed: false` with an issue of type `strict_object`.
- Issues: `kind`, `type`, `input`, `expected`, `received`, `message`, optional `requirement`, `path`, `issues` (https://valibot.dev/guides/issues/). Messages per action: `v.minValue(0, "Amount must be >= 0")` (measured). Custom checks: `v.check`, `v.rawCheck` (a raw check issue is `type: "raw_check"`, there is no user `code` field). In the Standard Schema result each `path` item is Valibot's path object and embeds the entire parent `input`, so error payloads can be large and can leak input values into logs (measured).
- Performance in my test: valid path fastest (2.93M ops/s); invalid 0.64M. Import and build of 200 entities adds about 20 ms over an empty script. Type-checking my 200-entity file: 318,826 type instantiations vs Zod's 65,116; 0.82 s vs 0.23 s on TS 7, 3.0 s vs 0.67 s on TS 5.9 (measured).
- Drizzle: `drizzle-valibot` 0.4.2, 2025-05-20 (https://registry.npmjs.org/drizzle-valibot).

### 5.3 ArkType

- Facts. 2.2.7 published 2026-10-01; 14 stable releases in 12 months; 2.0.0 on 2025-01-17. 2,536,202 downloads last week; 7,871 stars; MIT; contributors: author 651 commits, next human 39 (GitHub API). Effectively one maintainer.
- Syntax: optional key `"key?"`, undeclared keys `"+": "reject"`, defaults `"key: type = value"` (https://arktype.io/docs/objects). The `"number >= 0"` string is parsed by TypeScript's own template-literal types, so editors check it.
- Types: the generated type of `"notes?": "string | null"` is `notes?: string | null`, equal to the plain TS type even under `exactOptionalPropertyTypes` (measured). Zod and Valibot are not equal under that flag.
- Type-check cost (measured, 200 entities of about 12 fields with two nested objects, 401 lines): ArkType 1,665,473 instantiations, 1.97 s check on TS 7 and 4.5 s on TS 5.9, vs Zod 65,116 and 0.23 s / 0.67 s. This is the main weakness. For a project with about 100 validators the extrapolated cost is about 1 s on TS 7; this is an extrapolation, not measured.
- Runtime: precompiles with `new Function`; `configure({ jitless: true })` disables that (https://arktype.io/docs/configuration). Measured on Bun: valid path 1.45M ops/s (same as Zod), invalid path 82k ops/s (7x slower than Zod), 200 entities add about 480 ms at startup (Zod about 110 ms).
- Errors: `ArkError` has `code`, `expected`, `actual`, `problem`, `message`, `path`, `meta`. `.configure({ message: "..." })` sets the message; extra keys given to `configure` appear in `meta` and survive the Standard Schema conversion (measured: `meta: {message, code: "AMOUNT_NEG"}`), though TypeScript needs a declaration-merge to allow the extra key (I used a cast). Docs say i18n "falls outside the scope" of the message config and is "still a topic we're working on" (https://arktype.io/docs/configuration).
- Standard Schema: `vendor: "arktype", version: 1`, with `jsonSchema` (measured). ArkType also accepts other Standard Schema values inside a definition (`arktype/out/parser/definition.js`).
- Drizzle: `drizzle-arktype` 0.1.3, 2025-05-20 (registry); low use (12,785 downloads/week).

### 5.4 TypeBox (and its successors)

- Facts. The `typebox` package (1.x, ESM only, "developed against the TypeScript 7 native compiler", readme) is the successor to `@sinclair/typebox` 0.34.x. `typebox` 1.0.0 was published 2025-09-09; 150 stable releases in the last 12 months (very fast cadence); latest 1.3.34 on 2026-09-18. Downloads last week: `typebox` 15.2M, `@sinclair/typebox` 142.7M. Single maintainer (author 799 commits, next human 5). Licence file reads MIT; GitHub's API reports `NOASSERTION` because of the file layout.
- Standard Schema: **not implemented**. I grepped the installed `typebox` 1.3.34 and `@sinclair/typebox` 0.34.52 for `~standard`: no match. The maintainer's replies in https://github.com/sinclairzx81/typebox/issues/1154 (read 2026-10-05): "TypeBox still doesn't support Standard Schema natively, and probably wont because it considers JSON Schema to be the only viable canonical representation"; the former adapter project TypeMap "was deprecated earlier this year"; users are pointed to an example adapter they must "copy and paste into a project" (`example/standard` in the repo). The successor project named is `typedriver` (https://github.com/sinclairzx81/typedriver), not evaluated.
- Dates: 1.x has no `Date` schema type (checked in `build/type/types`). A `Date` field is expressible only as a string with a format plus a codec, so the generated schema cannot have the `Date` output type that Mesh's input type uses.
- Error shape (measured): `{keyword, schemaPath, instancePath, params, message}`.
- Drizzle: `drizzle-typebox` 0.3.3 pairs with old `@sinclair/typebox`; the v1 RC line adds `drizzle-orm/typebox` and `drizzle-orm/typebox-legacy`.
- Verdict: fails criterion 3 (required) and the Date requirement. Eliminated.

### 5.5 Effect Schema

- Facts. In Effect 4 the schema API lives in the `effect` package (`effect/Schema`); the old `@effect/schema` package stopped at 0.75.5 on 2024-10-16. `effect` 4.0.1 was published 2026-10-05 and 4.0.0 on 2026-10-01 (registry), so v4 is four days old. 52M weekly downloads of `effect`, 17k stars, MIT, 2 npm maintainers and three core authors with ~2000-2900 commits each (GitHub API). The v3-to-v4 change rewrote the Schema API (new `check`/`isGreaterThanOrEqualTo` filters, `Literals`, `optionalKey`).
- Standard Schema: not on the schema itself in the way the others are; you call `Schema.toStandardSchemaV1(schema, options)` (`effect/src/Schema.ts`). Result is `vendor: "effect", version: 1`. Issues are just `{path, message}`. Strict objects are a parse option, not part of the schema value.
- Types: readonly-by-default; matching a plain mutable TS type needs `mutableKey` and `mutable` on every field (measured). Type-check (measured): 68,280 instantiations, 0.39 s on TS 7 and 1.15 s on TS 5.9; memory was the highest of all (115 MB on TS 7).
- Runtime: slowest valid path (0.49M ops/s), 76.5 kB gzip for the example, +200 ms for 200 entities. No `new Function` found in the Schema sources grepped.
- Drizzle: in the v1 RC line, `drizzle-orm/effect-schema` exists (registry exports of `drizzle-orm@1.0.0-rc.4`); no stable package.
- Judgement: excellent library, wrong dependency to push into every Mesh user's project.

### 5.6 Typia

- Facts. 15.1.0 published 2026-10-02; 394,902 downloads last week; 5,932 stars; MIT; one main author (2291 commits). Peer dependency `ttsc >=0.19.2`.
- Docs: "You must use `ttsc` and `ttsx`. The stock `tsc`, `ts-node`, and `tsx` cannot apply the `typia` transform"; bundlers use `@ttsc/unplugin` (README read 2026-10-05). Bun support: not verified. The vendor speed claim (20,000x faster than class-validator) is a vendor claim with no stated source.
- Why it still matters: Mesh already generates the TypeScript type, so Typia can validate that type directly, with no separate schema to keep equal. That is elegant. It is also a build-time transformer that every Mesh user would have to wire into their Bun build, and the generated code is a call whose behaviour is invisible to the reader. Risk too high for a framework that wants to run on stock Bun.

### 5.7 Dropped

- Superstruct 2.0.2, last release 2024-07-06; repo last pushed 2024-10-01 (registry, GitHub API). Effectively unmaintained. Dropped.
- Yup 1.7.1 (2025-09-21), 14.6M weekly. Pre-TypeScript-era API, no strict-object equal type fidelity, Standard Schema support not checked. Dropped for fit, not for health.
- io-ts: the Effect team's `@effect/schema` replaced it; not evaluated further. `typedriver`: not evaluated.

## 6. Drizzle pairing, stated plainly

Facts:
- The official integration packages are separate npm packages on the stable line: `drizzle-zod` 0.8.3 (2025-08-06; peers `zod ^3.25.0 || ^4.0.0`, `drizzle-orm >=0.36.0`), `drizzle-valibot` 0.4.2, `drizzle-arktype` 0.1.3, `drizzle-typebox` 0.3.3 (all 2025-05-20 except zod). Maintained by the Drizzle team (same four npm maintainers as `drizzle-orm`); none is deprecated on npm. None have shipped since the dates shown, while `drizzle-orm` 0.45.3 shipped 2026-09-21.
- The current Drizzle docs (https://orm.drizzle.team/docs/zod, `/valibot`, `/arktype`, `/typebox`) document `drizzle-orm@rc` with imports such as `drizzle-orm/zod`, `drizzle-orm/valibot`, `drizzle-orm/arktype`, `drizzle-orm/typebox`. The npm `rc` tag is `1.0.0-rc.4` (2026-06-27) and `latest` is still 0.45.3. So the in-core integrations (Zod, Valibot, ArkType, TypeBox, Effect Schema) are a v1-line feature; Mesh pins the 0.45.x line.
- The integrations turn a Drizzle table into select/insert/update validators. I did not run them.

How much it matters for Mesh: almost not at all. Mesh generates the Drizzle schema and the validators from the same resource file, so it already knows each column's type and each rule. It does not need to derive validators from tables, and it must not, because action inputs differ from table rows (computed fields, auto-generated ids, rule-driven constraints). The pairing criterion is therefore satisfied by any library that does not clash with Drizzle's column types; all of the first four have official Drizzle packages and none is needed. The only real consequence: if a user wants to hand-write one extra validator from a table in their own code, Zod has the best-maintained path (drizzle-zod, 3.7M downloads/week against 19k and 13k for the Valibot and ArkType ones).

## 7. Standard Schema (criterion 3)

- The spec package `@standard-schema/spec` is at 1.1.0 (2025-12-15, https://registry.npmjs.org/@standard-schema/spec); the interface `StandardSchemaV1` has version `1`, `validate`, and issues of `{ message, path? }` (https://standardschema.dev, read 2026-10-05). 1.1 adds a JSON Schema companion interface.
- Measured on the installed packages: Zod (classic and Mini), Valibot, ArkType and Effect (via `toStandardSchemaV1`) all report `~standard.version === 1` with their vendor names. Zod and ArkType also expose `jsonSchema`. TypeBox does not. Typia: docs claim, not verified.
- Consequence: the guaranteed issue shape is only `message` and `path`. Mesh attaches a user-defined `code` to checks. Through the spec alone that code cannot travel. Options per library: Zod passes `params`/`code` through (measured); ArkType passes `meta` (measured); Valibot and Effect do not (Mesh would have to map messages to codes itself). This is a design point for Mesh, not a blocker; see section 9.

## 8. Judgement

Criterion 1 is the owner's first and decisive one. Ranked by "reads like the TypeScript it describes":
1. ArkType: `amount: "number >= 0"` and `"notes?": "string | null"` are almost the type literal. Clear win.
2. Zod: shortest of the function-style libraries.
3. Valibot: more verbose than Zod because of `pipe`. **Valibot is not more readable than Zod**, only smaller and faster to import. The owner's premise ("better than zod, more readable") holds for ArkType and for none of the others except Typia, which is out for build reasons.
4. Zod Mini, Effect: noisier.
5. TypeBox: out.

ArkType also wins the "TypeScript native" half on type-level fit: exact optional semantics (works under `exactOptionalPropertyTypes` with no extra `| undefined`), string syntax checked by the compiler, and the Standard Schema value has JSON Schema.

ArkType costs, measured: roughly 8x Zod type-check time on my synthetic file (about 2 s for 400 object schemas on TS 7, about 4.5 s on TS 5.9), about 480 ms startup for those 400 schemas, a slow failing path (82k ops/s), `new Function` JIT (fine on Bun; `jitless` exists), no built-in i18n, one maintainer. None of these blocks a Bun server. The type-check cost is the one to watch because it hits every user on every edit, but a typical Mesh app has tens, not hundreds, of action inputs.

## 9. Recommendation

**Pick: ArkType 2.x.** It is the only candidate that is both more readable and more TypeScript-native than Zod, it implements Standard Schema v1, has a maintained Drizzle package (not needed by Mesh), exact optional semantics, and a clean path for Mesh's `code` through `meta`.

**Runner-up: stay on Zod 4.** Not Valibot. Zod is the safest option on every criterion except readability: biggest ecosystem, best error payload (`code`, `params`, 70+ locales), cheapest type-check, best Drizzle package. Valibot would only be preferable if bundle size or import time mattered, which on Bun server code they do not.

**What would change the pick**
- If the type-check cost on a realistic Mesh app (re-measure with real generated validators and the TypeScript version users run) exceeds a budget the project sets, for example more than about 1 s of added check time per 100 validators: keep Zod.
- If ArkType's maintainer situation worsens (it is effectively one person) or a breaking 3.0 appears: keep Zod, which has a far larger user base to absorb a break.
- If users report the string DSL is hard to read once rules grow (regexes, `.narrow()` callbacks, cross-field rules): keep Zod.
- If Mesh needs `typeof Date` coercion from JSON strings on the input side, check that ArkType's `string.date.parse`-style morphs behave as wanted before committing (not verified here).
- If TypeBox ships native Standard Schema and a `Date` type, or Typia gains a no-transformer mode on Bun: re-evaluate those two.

## 10. What switching costs Mesh

Mesh has one emitter for validators, behind Standard Schema, so the runtime does not change. The real work:
- Rewrite the validator emitter: object, optional/nullable, enum, number/string/date/array rules, strictness (`"+": "reject"`), nested objects, unions.
- Generate string-DSL correctly: quote and escape string literals in enum values, keys that need quoting, regex rules, and keep `"key?"` for optional keys. A Zod emitter produces plain function calls; an ArkType emitter produces strings plus a few `.configure()` calls.
- Change the type assertion: use `typeof invoice.infer` instead of `z.output<typeof invoice>`. Because ArkType's optional is exact, generate the input type the same way, without adding `| undefined`.
- Carry the rule `code` and `message` through `.configure({ message, code })` (needs a one-time `ArkEnv.meta` declaration merge in the generated module, which I did not test) and read `meta.code` back from the issues in the runtime error mapper. Today with Zod the equivalent is `params`.
- Change the user's dependency from `zod` to `arktype` in generated project files and docs; update tests and fixtures; re-run the generated-import check.
- Expect the generated files to stay stable across a migration only if users never import the validator library themselves for their own schemas. Users who mix their own Zod schemas with generated ones will still work, since Mesh sees only `~standard`.
- Keep the emitter pluggable if the cost of the decision is a concern: one shared intermediate form (field, type, rules, strictness) with a Zod and an ArkType backend is a small step beyond the current single emitter and lets the choice be a config option. That is a design suggestion, not something I tested.

## 11. Not verified

- Typia: Standard Schema implementation (docs summary only), Bun support, whether the transformer can run in a Bun build, the vendor speed claims, behaviour of the example in section 4.
- `typedriver` and the TypeBox copy-paste Standard Schema adapter: not read or run.
- The `drizzle-zod`, `drizzle-valibot`, `drizzle-arktype`, `drizzle-typebox` packages and the `drizzle-orm@rc` in-core versions: package metadata read, behaviour not run. Compatibility of `drizzle-zod` with `zod/mini`: not verified. Whether a drizzle-orm 0.45.x user has any in-core validator export: not verified beyond the registry export list of the RC.
- Which libraries the standardschema.dev site lists and at which versions: the page fetched did not contain a list; my statements come from the installed packages.
- Zod, Valibot and ArkType maintainer counts beyond npm maintainer lists and top contributor counts; notable adopters for every library: not verified; sponsor and funding status: not verified.
- Valibot's "95 %" and "700 bytes" claims, Zod's 5.91/2.12 kB figures: quoted from the vendors' own pages, not re-measured in the same conditions.
- Third-party benchmark: I read the published results at https://github.com/moltar/typescript-runtime-type-benchmarks (`docs/results/bun-1.2.json`, Bun 1.2.12 data, repo last pushed 2026-10-05). Its numbers (parseStrict ops/s: typia 4.67M, TypeBox JIT 4.52M, Zod compiled 2.84M, ArkType 2.07M, Zod 1.14M, Valibot 1.03M, Effect Schema 0.16M; parseSafe: Zod 6.09M, Effect Schema 2.10M, Valibot 1.98M) were not re-validated, the library versions in that file were not checked (some labels such as "zod (compiled)" and "zod3" suggest it mixes Zod versions) and the ranking disagrees with my own run (Valibot fastest valid path). I do not rely on it.
- My performance numbers come from one machine, one synthetic schema (the invoice object, and a 200-entity generated file), single short runs, no warm/cold separation for startup. TypeScript versions used: 7.0.2 and 5.9.3. Real generated validators may differ.
- ArkType `meta.code` typing (needs declaration merging) and whether `.configure` with a custom `code` works on every kind of check (only `>=` was tested).
- ArkType Date coercion from JSON strings, and Zod `z.coerce.date()` equivalents, for HTTP input.
- Yup's and Superstruct's Standard Schema status; io-ts.
- Whether the `effect` package (not just its Schema) can be tree-shaken so a user pays only for Schema: measured 76.5 kB gzip for the example, nothing deeper.

---
title: "0048. Schema inside the process for tests"
description: "Decision record 0048: Schema inside the process for tests. Status: Accepted."
---

# 0048. Schema inside the process for tests

## Status

Accepted

## Date

2026-10-04

## Deciders

lead; reported to the operator

## Context

[ADR-0016](./0016-in-memory-data-via-sqlite.md) chooses SQLite `:memory:` for tests. A CLI in another process cannot create tables in a test's private connection. [ADR-0047](./0047-actions-are-bound-to-a-data-layer.md) provides isolated action bindings, but binding alone does not prepare the schema.

[ADR-0014](./0014-sql-adapters-on-drizzle.md) requires exact versions without naming them. The registry check and spike below supply that missing evidence. This record concerns creating the emitted schema on a fresh test connection, not a general-purpose migration or destructive-change protocol.

## Decision

Use option A: the SQLite data adapter exports its own function to create the tables of the emitted schema on a given connection, through drizzle-kit's programmatic `pushSQLiteSchema` API. The lead pins **`drizzle-orm@0.45.3` and `drizzle-kit@0.31.11`**, the stable pair tested below.

Three conditions contain the dependency:

1. The push API call and its cast live in **exactly one function** of the SQLite adapter, behind the adapter's own "create schema on this connection" function. A later move to v1 or emitted DDL changes one file. The kit declaration expects `LibSQLDatabase`, although the spike succeeds with Bun's SQLite database wrapper. The cast is a tested compatibility bridge, not proof that the types match.
2. `drizzle-kit` stays a **development dependency of the user's project**. In-process schema creation is for tests and development; production uses migrations. The function dynamically imports drizzle-kit, never imports it at the top level of run-time code, and fails with a clear message telling the user to install the pinned development dependency when it is absent.
3. A regression test must create a table, insert and select on the same Bun `:memory:` connection, so a broken push API fails visibly. There is no silent fallback to another connection or a CLI.

The original brief requested a Proposed record. After the spike, the lead accepted option A and these exact pins on 2026-10-04; this status records that later ruling.

## Options considered

### Option A: Adapter function using programmatic push (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: emitted Drizzle schema and one adapter bridge |
| Cost | One guarded compatibility point and regression test |
| In-memory support | Verified on the stable pair and Bun 1.3.14 |
| Upgrade risk | High: the v1 RC removes this API |

**Pros:** reuses the schema tools and operates on the test's own connection. **Cons:** a cast crosses a declaration mismatch; development tooling must be available when the function runs.

### Option B: Emit DDL as a guarded file, execute it in the adapter

| Dimension | Assessment |
|-----------|------------|
| Complexity | Moderate: another generated artefact and guard coverage |
| Cost | Build-time DDL generation plus adapter execution |
| In-memory support | DDL can execute on the supplied connection |
| Upgrade risk | Does not require a run-time push API |

**Pros:** test setup need not import drizzle-kit at run time. **Cons:** another artefact can drift unless guarded. This is the alternative for a version without programmatic push; the spike did not implement it.

### Option C: File database prepared by the CLI (rejected)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low: existing command |
| Cost | File creation and cleanup per test |
| In-memory support | None: a separate process cannot prepare this connection |
| Isolation | Requires distinct files rather than private in-memory databases |

**Pros:** no new in-process function. **Cons:** does not satisfy the `:memory:` requirement of ADR-0016.

## Trade-off analysis

A works on the selected stable pair with the smallest adapter surface. B becomes necessary if a later selected version lacks an in-process API; C cannot meet the requirement. Keeping the compatibility bridge in one place avoids spreading drizzle-kit details into generated handlers or core.

## Spike evidence

Run on 2026-10-04 with **Bun 1.3.14 (0d9b296a), Linux x64**. Registry queries `bun pm view drizzle-orm dist-tags` and `bun pm view drizzle-kit dist-tags` returned `latest` = `0.45.3` / `0.31.11` and `rc` = `1.0.0-rc.4` / `1.0.0-rc.4`. Each pair was installed with exact versions in a separate scratch directory, outside the repository. These are registry observations, not numeric pins previously present in the roadmap.

This is the complete script run with `bun run spike.ts` on both pairs. Bun executes it without type checking; the declaration mismatch is explicitly addressed by the adapter bridge above.

```ts "spike.ts"
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { pushSQLiteSchema } from "drizzle-kit/api";

const todos = sqliteTable("todos", {
  id: integer("id").primaryKey(),
  title: text("title").notNull(),
});
const connection = new Database(":memory:");
const db = drizzle(connection);
try {
  const push = await pushSQLiteSchema({ todos }, db);
  console.log("statements", JSON.stringify(push.statementsToExecute));
  await push.apply();
  db.insert(todos).values({ id: 1, title: "Buy milk" }).run();
  console.log("rows", JSON.stringify(db.select().from(todos).all()));
} finally {
  connection.close();
}
```

**Stable pair: works**, attempt 1, exit 0. Output below removes only the terminal cursor-control bytes before the second progress line (`ESC[2K ESC[1G`):

```text
[⣷] Pulling schema from database...
[✓] Pulling schema from database...
statements ["CREATE TABLE `todos` (\n\t`id` integer PRIMARY KEY NOT NULL,\n\t`title` text NOT NULL\n);\n"]
rows [{"id":1,"title":"Buy milk"}]
```

**v1 RC pair: does not work**, attempt 1, exit 1. Exact output:

```text
error: Cannot find module 'drizzle-kit/api' from '/Users/svallory/work/mesh/scratch/m2-spike/rc/spike.ts'

Bun v1.3.14 (Linux x64)
```

Inspection found the dialect-specific entry `drizzle-kit/api-sqlite`; attempt 2 checked its exports with this complete script:

```ts "exports.ts"
import * as sqliteApi from "drizzle-kit/api-sqlite";
console.log("api-sqlite exports", JSON.stringify(Object.keys(sqliteApi).sort()));
```

`bun run exports.ts` exited 0 and printed:

```text
api-sqlite exports ["startStudioServer"]
```

The RC's `api-sqlite.d.ts` likewise declares only `startStudioServer`, not a renamed push function. No third attempt was needed. No package code or scratch dependencies were added to the repository.

## Consequences

Tests prepare the emitted schema on their own connection before calling bound actions. Production does not ship drizzle-kit for this feature. Missing development tooling is an actionable error, not an automatic install.

**What we will need to revisit:** `drizzle-kit/api` is absent in `1.0.0-rc.4`. Moving to Drizzle v1 forces option B unless v1 restores programmatic SQLite push. Revisit when **Drizzle v1 is released or at M7 (relations API)**, whichever comes first. Success on the stable pair says nothing about schema changes, prompts on ambiguous migrations, or RC compatibility.

## Action items

- [ ] M2: pin the accepted stable pair in the SQL adapter packages.
- [ ] M2: isolate the push call and cast in one adapter function; dynamically import kit with an actionable missing-dependency error.
- [ ] M2: test schema creation, insert and select on the same `:memory:` connection, plus missing drizzle-kit.
- [ ] Drizzle v1 release or M7: repeat the spike; use guarded emitted DDL if programmatic push remains unavailable.

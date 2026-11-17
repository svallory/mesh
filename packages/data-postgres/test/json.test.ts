import { expect, test } from "bun:test";
import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { FrameworkError } from "@meshfw/runtime";
import { describeServer, testDatabase } from "./support.ts";

const docs = pgTable("docs", { id: text("id").primaryKey().notNull(), body: jsonb("body") });

// Each value, the jsonb_typeof the database must hold for it (the value itself, never its JSON text as a string).
const VALUES: readonly (readonly [string, unknown, string | null])[] = [
  ["object", { b: 1, a: [1, "two", { c: null }] }, "object"],
  ["array", [1, [2, [3]], "x"], "array"],
  ["a string that reads as a number", "123", "string"],
  ["a string that reads as a boolean", "true", "string"],
  ["a string holding JSON text", '{"a":1}', "string"],
  ["a number", 1.5, "number"],
  ["a boolean", false, "boolean"],
  ["JSON null inside", { a: null }, "object"],
  ["a __proto__ key", JSON.parse('{"__proto__":{"polluted":true},"x":1}'), "object"],
  ["SQL NULL", null, null],
];

describeServer("json attributes are stored as jsonb values and read back as written", () => {
  const database = testDatabase({ docs });
  test.each(VALUES)("%s", async (id, value, kind) => {
    const layer = await database.freshLayer();
    const inserted = await layer.transaction((tx) => tx.insert(docs, { id, body: value }));
    expect(inserted.body).toEqual(value);
    const [stored] = await database.admin.unsafe(`SELECT jsonb_typeof(body) AS kind FROM "${layer.database!.split("#")[1]}".docs WHERE id = $1`, [id]);
    expect(stored.kind).toBe(kind);
    const read = await layer.transaction((tx) => tx.selectByKey(docs, { id }));
    expect(read!.body).toEqual(value);
    if (value !== null && typeof value === "object" && Object.hasOwn(value, "__proto__")) expect(Object.getPrototypeOf(read!.body)).toBe(Object.prototype);
    const updated = await layer.transaction((tx) => tx.updateByKey(docs, { id }, { body: { replaced: value } }));
    expect(updated!.body).toEqual({ replaced: value });
    expect((await layer.transaction((tx) => tx.select(docs)))[0]!.body).toEqual({ replaced: value });
  }, 30_000);
});

describeServer("a filter on a json column", () => {
  const database = testDatabase({ docs });
  // Its operand would go through Drizzle's JSON.stringify and then Bun.SQL's own JSON encoding, so `{ eq: "x" }` would
  // compare with a JSON string and quietly match the wrong rows; it is refused instead, before anything runs.
  test.each([
    ["eq", { body: { eq: "x" } }],
    ["ne", { body: { ne: "x" } }],
    ["in", { body: { in: ["x"] } }],
    ["a range", { body: { gt: "a" } }],
    ["nil beside another operator", { body: { nil: false, eq: "x" } }],
    ["inside or", { or: [{ id: { eq: "a" } }, { body: { eq: "x" } }] }],
  ])("%s is refused with a FrameworkError, and the transaction goes on", async (_name, filter) => {
    const layer = await database.freshLayer();
    const outcome = await layer.transaction(async (tx) => {
      await tx.insert(docs, { id: "a", body: "x" });
      const refused = await tx.select(docs, { filter: filter as never }).catch((cause: unknown) => cause);
      const counted = await tx.count(docs, "id", filter as never).catch((cause: unknown) => cause);
      return { refused, counted, rows: (await tx.select(docs)).length };
    });
    for (const error of [outcome.refused, outcome.counted]) {
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toBe('Filter on "body": a json column takes only nil on Postgres, since a filter compares scalars and a jsonb value is not one');
    }
    expect(outcome.rows).toBe(1);
  }, 30_000);

  test("nil alone is allowed", async () => {
    const layer = await database.freshLayer();
    await layer.transaction(async (tx) => { await tx.insert(docs, { id: "a", body: "x" }); await tx.insert(docs, { id: "b", body: null }); });
    const rows = await layer.transaction((tx) => tx.select(docs, { filter: { body: { nil: true } } as never }));
    expect(rows.map((row) => row.id)).toEqual(["b"]);
    expect(await layer.transaction((tx) => tx.count(docs, "id", { body: { nil: false } } as never))).toBe(1);
  }, 30_000);
});

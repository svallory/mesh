import { expect, test } from "bun:test";
import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
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

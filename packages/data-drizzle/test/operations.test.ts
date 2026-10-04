import { expect, test } from "bun:test";
import { FrameworkError } from "@mesh/runtime";
import { SQLiteSyncDialect, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { drizzleOperations, keyCondition, type DrizzleCommands } from "../src/index.ts";

const table = sqliteTable("rows", { id: integer("id"), tenant: text("tenant"), title: text("title") });
const row = { id: 1, tenant: "a", title: "one" };
function fixture() {
  let updates = 0;
  const commands: DrizzleCommands<typeof table> = {
    table: () => table,
    insert: (_table, values) => values,
    select: () => [row],
    update: (_table, _condition, values) => { updates++; return [{ ...row, ...values }]; },
    delete: () => [row],
  };
  return { operations: drizzleOperations(commands, () => {}), updates: () => updates, commands };
}

test("composite keys use every column and parameterise values", () => {
  const query = new SQLiteSyncDialect().sqlToQuery(keyCondition(table, { id: 1, tenant: "a' OR 1=1" }));
  expect(query.sql).toBe('(\"rows\".\"id\" = ? and \"rows\".\"tenant\" = ?)');
  expect(query.params).toEqual([1, "a' OR 1=1"]);
});

test("empty and unknown keys fail without silently dropping fields", async () => {
  const { operations } = fixture();
  for (const key of [{}, { absent: 1 }, { toString: 1 }]) {
    await expect(operations.selectByKey(table, key)).rejects.toBeInstanceOf(FrameworkError);
    await expect(operations.updateByKey(table, key, {})).rejects.toBeInstanceOf(FrameworkError);
    await expect(operations.deleteByKey(table, key)).rejects.toBeInstanceOf(FrameworkError);
  }
});

test("unknown insert and update columns fail, including prototype names", async () => {
  const { operations } = fixture();
  for (const changes of [{ unknown: 1 }, { toString: 1 }, JSON.parse('{"__proto__":1}')]) {
    await expect(operations.insert(table, changes)).rejects.toBeInstanceOf(FrameworkError);
    await expect(operations.updateByKey(table, { id: 1 }, changes)).rejects.toBeInstanceOf(FrameworkError);
  }
});

test("empty changes reads the current row and never writes", async () => {
  const { operations, updates } = fixture();
  expect(await operations.updateByKey(table, { id: 1 }, {})).toEqual(row);
  expect(updates()).toBe(0);
});

test("driver error becomes FrameworkError with the same cause", async () => {
  const { commands } = fixture();
  const cause = new Error("driver constraint");
  commands.insert = () => { throw cause; };
  const operations = drizzleOperations(commands, () => {});
  try { await operations.insert(table, row); throw new Error("did not fail"); }
  catch (error) { expect(error).toBeInstanceOf(FrameworkError); expect((error as Error).cause).toBe(cause); }
});

test("revoked operations reject every method before touching a driver", async () => {
  const { commands } = fixture();
  let accesses = 0;
  commands.table = () => { accesses++; return table; };
  const cause = new FrameworkError("expired");
  const tx = drizzleOperations(commands, () => { throw cause; });
  for (const call of [() => tx.insert(table, row), () => tx.selectAll(table), () => tx.selectByKey(table, { id: 1 }),
    () => tx.updateByKey(table, { id: 1 }, {}), () => tx.deleteByKey(table, { id: 1 })]) {
    await expect(call()).rejects.toBe(cause);
  }
  expect(accesses).toBe(0);
});

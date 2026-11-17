import { expect, test } from "bun:test";
import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { DataLayer } from "@meshfw/runtime";
import { dataLayerConformanceV1, type DataLayerFixtureV1 } from "@meshfw/runtime/testing";
import { capabilities } from "../src/index.ts";
import { describeServer, testDatabase } from "./support.ts";

// The shapes the suite asks for, in the column types data-postgres's schema generator writes.
const records = pgTable("records", { id: text("id").primaryKey().notNull(), title: text("title").notNull() });
const uuidTable = pgTable("uuid_rows", { id: text("id").primaryKey().notNull(), label: text("label").notNull() });
const integerTable = pgTable("integer_rows", { seq: bigint("seq", { mode: "number" }).primaryKey().notNull(), label: text("label").notNull() });
const taskTable = pgTable("tasks", {
  id: text("id").primaryKey().notNull(), parentId: text("parentId"),
  createdAt: timestamp("createdAt", { mode: "date", precision: 3, withTimezone: true }).notNull(), title: text("title").notNull(),
  rank: bigint("rank", { mode: "number" }),
});
const sampleRow = { id: "00000000-0000-4000-8000-000000000001", title: "First" };
const secondRow = { id: "00000000-0000-4000-8000-000000000002", title: "Second" };

describeServer("contract v1 conformance, Postgres", () => {
  const database = testDatabase({ records, uuidTable, integerTable, taskTable });
  const make = async (): Promise<DataLayerFixtureV1> => {
    const layer = await database.freshLayer();
    return {
      layer: { transaction: layer.transaction, refuseIfFailed: layer.refuseIfFailed, close: layer.close } satisfies DataLayer,
      table: records, sampleRow, secondRow, key: { id: sampleRow.id }, secondKey: { id: secondRow.id },
      changes: { title: "Changed" },
      uuidTable, integerTable, taskTable,
    };
  };
  for (const [name, check] of Object.entries(dataLayerConformanceV1(make, capabilities))) test(name, check, 60_000);
});

test("the capability manifest declares conditions and joins and never gapless-positions", () => {
  expect(capabilities).toEqual({ adapter: "postgres", capabilities: ["aggregates", "integer-key-fill", "conditions", "joins"] });
  expect(Object.isFrozen(capabilities)).toBe(true);
});

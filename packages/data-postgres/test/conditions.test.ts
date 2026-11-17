import { expect, test } from "bun:test";
import { bigint, boolean, doublePrecision, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { dataLayerConditionConformance, expressionTablesThroughLayer, type ConditionFixture } from "@meshfw/runtime/testing";
import { capabilities } from "../src/index.ts";
import { describeServer, testDatabase } from "./support.ts";

const at = (name: string) => timestamp(name, { mode: "date", precision: 3, withTimezone: true });
const parent = pgTable("cond_parent", {
  id: text("id").primaryKey().notNull(), s: text("s"), n: bigint("n", { mode: "number" }), f: doublePrecision("f"),
  b: boolean("b"), d: at("d"), parentId: text("parentId"), label: text("db_label"),
});
const child = pgTable("cond_child", { id: text("id").primaryKey().notNull(), parentId: text("parentId"), qty: bigint("qty", { mode: "number" }), pos: bigint("pos", { mode: "number" }) });
const link = pgTable("cond_link", { id: text("id").primaryKey().notNull(), parentId: text("parentId"), childId: text("childId") });
const slot = (p: string) => ({
  [`${p}_s`]: text(`${p}_s`), [`${p}_i`]: bigint(`${p}_i`, { mode: "number" }), [`${p}_f`]: doublePrecision(`${p}_f`),
  [`${p}_b`]: boolean(`${p}_b`), [`${p}_d`]: at(`${p}_d`),
});
const values = pgTable("cond_values", { id: bigint("id", { mode: "number" }).primaryKey().notNull(), ...slot("a"), ...slot("b"), ...slot("c") });

describeServer("translated conditions on Postgres", () => {
  const database = testDatabase({ parent, child, link, values });
  const make = async (): Promise<ConditionFixture> => ({ layer: await database.freshLayer(), parent, child, link, values });
  for (const [name, check] of Object.entries(dataLayerConditionConformance(make, capabilities))) test(`condition conformance: ${name}`, check, 60_000);
  for (const [name, check] of Object.entries(expressionTablesThroughLayer(make, capabilities))) test(`expression tables: ${name}`, check, 60_000);
});

test("the manifest declares conditions and joins, so both suites run every check", () => {
  const make = async (): Promise<ConditionFixture> => { throw new Error("not called"); };
  expect(Object.keys(dataLayerConditionConformance(make, capabilities)).some((name) => name.includes("through hop"))).toBe(true);
  expect(Object.keys(expressionTablesThroughLayer(make, capabilities)).some((name) => name.startsWith("every:"))).toBe(true);
});

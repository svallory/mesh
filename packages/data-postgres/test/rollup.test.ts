import { expect, test } from "bun:test";
import { bigint, doublePrecision, pgTable, text } from "drizzle-orm/pg-core";
import { describeServer, testDatabase } from "./support.ts";

// Postgres gives `sum` and `avg` of a bigint (a Mesh integer) as `numeric`, `count` as bigint, and an int8 anchor, all
// as text; over double precision (a Mesh decimal) `sum` and `avg` stay double precision. The shared rollup decodes the
// text, so every adapter answers with numbers.
const lines = pgTable("rollup_lines", {
  id: text("id").primaryKey().notNull(),
  invoiceId: text("invoiceId"),
  orderNo: bigint("orderNo", { mode: "number" }),
  units: bigint("units", { mode: "number" }),
  amount: doublePrecision("amount"),
});

describeServer("rollup on Postgres decodes numeric results and integer anchors to numbers", () => {
  const database = testDatabase({ lines });
  const rows = [
    { id: "l1", invoiceId: "i1", orderNo: 1, units: 2, amount: 0.1 },
    { id: "l2", invoiceId: "i1", orderNo: 1, units: 3, amount: 0.2 },
    { id: "l3", invoiceId: "i1", orderNo: 1, units: 9_007_199_254_740, amount: 0.3 },
    { id: "l4", invoiceId: "i2", orderNo: 2, units: null, amount: null },
  ];
  const seeded = async () => {
    const layer = await database.freshLayer();
    await layer.transaction(async (tx) => { for (const row of rows) await tx.insert(lines, row); });
    return layer;
  };

  test("sum and avg of a bigint and of a double precision column are numbers; all nulls give null", async () => {
    const layer = await seeded();
    const run = (fn: "sum" | "avg", value: string) => layer.transaction((tx) => tx.rollup({ fn, table: lines, anchor: "invoiceId", anchors: ["i1", "i2"], value }));
    const byAnchor = (found: Awaited<ReturnType<typeof run>>) => Object.fromEntries(found.map((row) => [row.anchor, row.value]));
    expect(byAnchor(await run("sum", "units"))).toEqual({ i1: 9_007_199_254_745, i2: null });
    expect(byAnchor(await run("avg", "units"))).toEqual({ i1: expect.closeTo(9_007_199_254_745 / 3, 3), i2: null });
    expect(byAnchor(await run("sum", "amount"))).toEqual({ i1: expect.closeTo(0.6, 12), i2: null });
    expect(byAnchor(await run("avg", "amount"))).toEqual({ i1: expect.closeTo(0.2, 12), i2: null });
    for (const fn of ["sum", "avg"] as const)
      for (const value of ["units", "amount"]) expect(typeof (await run(fn, value)).find((row) => row.anchor === "i1")!.value).toBe("number");
  });

  test("an integer anchor comes back as the number the owner row holds", async () => {
    const layer = await seeded();
    const found = await layer.transaction((tx) => tx.rollup({ fn: "count", table: lines, anchor: "orderNo", anchors: [1, 2, 3], value: "id" }));
    expect(found.sort((a, b) => Number(a.anchor) - Number(b.anchor))).toEqual([{ anchor: 1, value: 3 }, { anchor: 2, value: 1 }]);
  });
});

import type { ActionContext, ContextArgument, DataLayer, Key, StandardSchemaV1, TableHandle } from "@meshfw/runtime";
import { parseInput } from "@meshfw/runtime";

const context: ActionContext = {};
void context;
// @ts-expect-error table handles are opaque objects, not SQL strings
const table: TableHandle = "posts";
function contracts(layer: DataLayer, key: Key) {
  // @ts-expect-error operations exist only inside transactions
  layer.selectAll({});
  // @ts-expect-error keys are readonly
  key.id = "other";
  const result: Promise<number> = layer.transaction(async () => 1);
  return result;
}
function inference(schema: StandardSchemaV1<unknown, { count: number }>) {
  const value: Promise<{ count: number }> = parseInput(schema, {});
  // @ts-expect-error output is inferred from the schema, not input
  const wrong: Promise<string> = parseInput(schema, "text");
  return value;
}

// With nothing merged into ActionContext, a generated action's context is optional.
declare function generated(input: { title: string }, ...[context]: ContextArgument): Promise<void>;
void generated({ title: "a" });
void generated({ title: "a" }, {});
// @ts-expect-error the input stays required
void generated();

// Contract v1: filters, sorts and queries are plain data, and the types reject what the contract rejects.
import type { Capability, Comparison, Filter, Query, Sort } from "@meshfw/runtime";
import { defineCapabilities } from "@meshfw/runtime";

const filter: Filter = { and: [{ parentId: { eq: "p1" } }, { or: [{ rank: { gte: 5 } }, { rank: { nil: true } }] }] };
const sort: Sort = ["createdAt", "-id"];
const query: Query = { filter, sort, limit: 10, offset: 0 };
void query;
const comparison: Comparison = { in: ["a", 1, new Date()], nil: false };
void comparison;
// @ts-expect-error an operator outside the contract
const unknownOperator: Filter = { rank: { like: "x" } };
// @ts-expect-error lt does not take null (use nil)
const ltNull: Filter = { rank: { lt: null } };
// @ts-expect-error a filter value is data, not a string of SQL
const sqlFilter: Filter = "rank > 1";
// @ts-expect-error sort is a list of names
const sortString: Query = { sort: "createdAt" };
void [unknownOperator, ltNull, sqlFilter, sortString];

// The manifest is a closed union: a name outside it fails type-checking.
const known: Capability = "aggregates";
void known;
defineCapabilities("fake", ["aggregates", "integer-key-fill"]);
// @ts-expect-error not a capability
defineCapabilities("fake", ["teleport"]);
// @ts-expect-error not a capability
const bad: Capability = "teleport";
void bad;

function operations(layer: DataLayer) {
  return layer.transaction(async (tx) => {
    const rows: Promise<Record<string, unknown>[]> = tx.select({}, query);
    const newest: Promise<string | number | Date | null> = tx.max({}, "createdAt", filter);
    const total: Promise<number> = tx.count({}, "id");
    const locked = tx.selectByKeyForUpdate({}, { id: "a" });
    // @ts-expect-error count is a number, never null
    const wrong: Promise<null> = tx.count({}, "id");
    return [rows, newest, total, locked, wrong];
  });
}
void operations;

import type { ActionContext, DataLayer, Key, StandardSchemaV1, TableHandle } from "@meshfw/runtime";
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

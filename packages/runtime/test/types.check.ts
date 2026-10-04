import type { Actor, DataLayer, Key, Scope, StandardSchemaV1, TableHandle } from "@mesh/runtime";
import { parseInput } from "@mesh/runtime";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type UnregisteredActor = Assert<Equal<Scope["actor"], unknown>>;
type ActorAlias = Assert<Equal<Actor, unknown>>;
const scope: Scope = { actor: null, context: { trace: "one" } };
// @ts-expect-error actor is required even when its type is unknown
const missingActor: Scope = {};
// @ts-expect-error context is a record
const invalidContext: Scope = { actor: null, context: "wrong" };
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

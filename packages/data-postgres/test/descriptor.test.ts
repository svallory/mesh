import { describe, expect, test } from "bun:test";
import { pgTable, text } from "drizzle-orm/pg-core";
import { FrameworkError } from "@meshfw/runtime";
import { capabilities, createSchema, postgres } from "../src/index.ts";
import { databaseName, postgresWith } from "../src/layer.ts";

describe("postgres({ url })", () => {
  test("is one frozen descriptor and layer, and accepts an undefined url so a project builds without DATABASE_URL", () => {
    const layer = postgres({ url: undefined });
    expect(layer).toMatchObject({ kind: "data-adapter", name: "postgres", build: "@meshfw/data-postgres/build", options: { url: undefined } });
    expect(layer.capabilities).toBe(capabilities);
    expect(layer.database).toBeUndefined();
    expect("database" in layer).toBe(false);
    expect(Object.isFrozen(layer)).toBe(true);
    expect(Object.isFrozen(layer.options)).toBe(true);
  });

  test("names the database without credentials or query, the same for every layer object over it", () => {
    expect(postgres({ url: "postgres://app:s3cret@db.example:6543/shop?sslmode=require" }).database).toBe("postgres://db.example:6543/shop");
    expect(postgres({ url: "postgresql://localhost/shop" }).database).toBe("postgres://localhost:5432/shop");
    expect(postgres({ url: "postgres://a:b@h/d" }).database).toBe(postgres({ url: "postgres://c:d@h:5432/d" }).database);
    expect(postgresWith({ url: "postgres://h/d" }, { schema: "c1" }).database).toBe("postgres://h:5432/d#c1");
    expect(databaseName("mysql://h/d")).toBeUndefined();
    expect(databaseName("not a url")).toBeUndefined();
    expect(databaseName("")).toBeUndefined();
  });

  test.each([
    [undefined, "undefined"], [null, "null"], ["postgres://h/d", '"postgres://h/d"'], [{ url: 5 }, '{"url":5}'], [{ url: null }, '{"url":null}'],
  ])("a bad option throws at once (%p)", (options, shown) => {
    expect(() => postgres(options as never)).toThrow(new FrameworkError(`postgres requires { url }: a postgres:// URL string, or undefined while it is not configured; got ${shown}`));
  });

  test("a missing or empty url fails at the first transaction, naming the option, never at construction", async () => {
    for (const url of [undefined, "", "  "]) {
      const layer = postgres({ url });
      const error = await layer.transaction(async () => 1).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(FrameworkError);
      expect((error as Error).message).toBe(`postgres needs a url, and was given ${url === undefined ? "undefined" : "an empty string"}: set data: postgres({ url: process.env.DATABASE_URL }) and define DATABASE_URL. Mesh never guesses a database`);
      await layer.close();
    }
    const table = pgTable("t", { id: text("id").primaryKey() });
    await expect(createSchema(postgres({ url: undefined }), { table })).rejects.toThrow("postgres needs a url");
  });

  test("createSchema refuses a layer it did not make, and a test schema", async () => {
    const table = pgTable("t", { id: text("id").primaryKey() });
    await expect(createSchema({ transaction: async () => undefined as never, refuseIfFailed: () => false, close: async () => {} }, { table })).rejects.toThrow("createSchema requires a data layer made by postgres()");
    await expect(createSchema(postgresWith({ url: "postgres://h/d" }, { schema: "c1" }), { table })).rejects.toThrow("createSchema prepares the public schema only; clone it into c1 in the test");
  });

  test("createSchema refuses a name Postgres would cut or the schema tool cannot quote, before connecting", async () => {
    const layer = postgres({ url: "postgres://nobody@127.0.0.1:1/none" });
    await expect(createSchema(layer, { table: pgTable("t".repeat(64), { id: text("id").primaryKey() }) })).rejects.toThrow("Postgres keeps the first 63 bytes");
    await expect(createSchema(layer, { table: pgTable("t", { 'i"d': text('i"d').primaryKey() }) })).rejects.toThrow("cannot quote safely");
  });

  test("a test schema must be a lowercase identifier", () => {
    expect(() => postgresWith({ url: undefined }, { schema: 'x"; drop' })).toThrow(FrameworkError);
  });
});

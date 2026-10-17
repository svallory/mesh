// Run by busy.test.ts as a second process: writes `count` rows to the file through its own data layer, holding each
// transaction open for a few milliseconds so that the parent's writes meet its lock.
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sqlite } from "../src/index.ts";

const [file, tag, count] = process.argv.slice(2) as [string, string, string];
const table = sqliteTable("records", { id: text("id").primaryKey().notNull(), n: integer("n").notNull() });
const layer = sqlite({ file });
for (let i = 0; i < Number(count); i++) {
  await layer.transaction(async (tx) => {
    await tx.insert(table, { id: `${tag}-${i}`, n: i });
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}
await layer.close();

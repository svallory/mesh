// Run by busy.test.ts as a second process: opens its own data layer on the file and prints READY, waits for a line
// on stdin, then writes `count` rows, holding each transaction open for a few milliseconds so that the parent's writes
// (which start on the same line) meet its lock.
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sqlite } from "../src/index.ts";

const [file, tag, count] = process.argv.slice(2) as [string, string, string];
const table = sqliteTable("records", { id: text("id").primaryKey().notNull(), n: integer("n").notNull() });
const layer = sqlite({ file });
await layer.transaction(async () => {}); // opens the connection, and switches the file to WAL
console.log("READY");
for await (const _ of console) break;
for (let i = 0; i < Number(count); i++) {
  await layer.transaction(async (tx) => {
    await tx.insert(table, { id: `${tag}-${i}`, n: i });
    // The first transaction tells the parent it holds the lock and keeps it a while, so the parent's first write meets it.
    if (i === 0) { console.log("LOCKED"); await new Promise((resolve) => setTimeout(resolve, 300)); }
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}
await layer.close();

// Run by wakeup.test.ts as a second process: commits one outbox row of `wakeups.Paid` with payload { n } on the given
// database and schema, then exits, so the test's deliverer can only hear it through LISTEN/NOTIFY or its poll.
import { outboxRow } from "@meshfw/runtime/testing";
import { postgresWith } from "../src/layer.ts";

const [url, schema, n] = process.argv.slice(2) as [string, string, string];
const layer = postgresWith({ url }, { schema });
await layer.transaction(async (tx) => { await tx.appendEvent!(outboxRow(Number(n), { name: "wakeups.Paid", payload: { n: Number(n) } })); });
await layer.close();

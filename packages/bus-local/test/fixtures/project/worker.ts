// A second process on the project's database, run by project.test.ts. `deliver`: connect() (which claims), print READY
// and wait. `publish <count>`: connect({ deliver: false }), print READY, wait for a line, then open and pay `count`
// invoices and print DONE. Either one disconnects and exits on the next line it reads.
import { connect, disconnect } from "#mesh";
import { Invoice } from "#mesh/domain/billing";

const [mode, count] = process.argv.slice(2) as [string, string | undefined];
await connect(mode === "deliver" ? {} : { deliver: false });
console.log(`READY ${process.pid}`);
const lines = console[Symbol.asyncIterator]();
await lines.next();
if (mode === "publish") {
  for (let i = 0; i < Number(count); i++) {
    const invoice = (await Invoice.open({}, {})) as { id: string };
    await Invoice.pay({ id: invoice.id }, {});
  }
  console.log("DONE");
  await lines.next();
}
await disconnect();
process.exit(0);

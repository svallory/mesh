import { expect, test } from "bun:test";
import { SITE, message } from "../src/message.ts";

test("the placeholder says Mesh is coming and points at the site", () => {
  const text = message();
  expect(text.startsWith("Mesh is coming soon.")).toBe(true);
  expect(text).toContain(SITE);
  expect(SITE).toBe("https://mesh.hyperlab.sh");
});

test("the bin prints the message and exits 0", async () => {
  const proc = Bun.spawn(["bun", new URL("../src/bin.ts", import.meta.url).pathname], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(out.trim()).toBe(message());
});

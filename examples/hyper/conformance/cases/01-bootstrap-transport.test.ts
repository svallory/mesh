/**
 * Group 01 — daemon, transport and bootstrap.
 * Enforces: PROTOCOL.md#transport, #daemon, #bootstrap; domain/core/workspace.md#rules (rule 1: a solo user never
 * names a workspace); domain/core/workspace.md#commands; domain/core/event.md#rules (rule 4: engine-emitted events).
 */
import { expect, test } from "bun:test";
import { RpcClient, RpcError } from "../harness/rpc.ts";
import { E, expectRejected, suite, until, useWorld } from "./_setup.ts";

/** Waits for a response in the connection's log. Responses may arrive in any order (PROTOCOL.md#transport). */
const waitForLogged = (c: RpcClient, pred: (m: any) => boolean) =>
  until(async () => c.log.map((l) => JSON.parse(l)).find(pred), 5000, 20);

suite("01.1 bootstrap [domain/core/workspace.md#rules, PROTOCOL.md#bootstrap]", () => {
  const w = useWorld();

  test("workspace.create on a daemon that has its workspace is rejected: rule_violation workspace.exists", async () => {
    await expectRejected(w().owner.do("workspace.create", { name: "again" }), E.ruleViolation, "workspace.exists");
  });
});

suite("01.3 transport [PROTOCOL.md#transport]", () => {
  const w = useWorld();

  test("a malformed line gets parse_error (-32700, id null) and the connection stays usable", async () => {
    const c = await w().engine.connect();
    c.writeRaw("{this is not json\n");
    const r = await c.request("workspace.get", {});
    expect(r.workspace.id).toBe(w().workspaceId);
    await waitForLogged(c, (m) => m.id === null && m.error?.code === -32700);
  });

  test("an unknown method gets method_not_found (-32601)", async () => {
    const e = await w().client.request("task.explode", {}).catch((x) => x);
    expect(e).toBeInstanceOf(RpcError);
    expect(e.code).toBe(-32601);
  });

  test("inherited object property names are not methods (-32601)", async () => {
    for (const m of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const e = await w().client.request(m, {}).catch((x) => x);
      expect([m, e.code]).toEqual([m, -32601]);
    }
  });

  test("params that do not match the schema get invalid_params (-32602)", async () => {
    const o = w().owner;
    const e = await w()
      .client.request("task.create", { commandId: "bad-1", actor: o.id, caller: "t", payload: {} })
      .catch((x) => x);
    expect(e).toBeInstanceOf(RpcError);
    expect(e.code).toBe(-32602);
    const e2 = await w().client.request("task.create", { actor: o.id, caller: "t", payload: { title: "x" } }).catch((x) => x);
    expect(e2.code).toBe(-32602); // commandId missing
  });

  test("one phase, several failures: params failing the schema in two ways report one or more schema failures (shape)", async () => {
    // commandId missing AND actor not a string: both are schema failures of the shape phase;
    // the engine may return one or both.
    const e = await w()
      .client.request("task.create", { actor: 42, caller: "t", payload: { title: "x" } })
      .catch((x) => x);
    expect(e).toBeInstanceOf(RpcError);
    expect([e.code, e.phase]).toEqual([-32602, "shape"]);
    expect(e.failures.some((f: { check?: string }) => f.check === "schema")).toBe(true);
  });

  test("a batch (JSON array) is rejected with invalid_request (-32600)", async () => {
    const c = await w().engine.connect();
    c.writeRaw(JSON.stringify([{ jsonrpc: "2.0", id: 99, method: "workspace.get", params: {} }]) + "\n");
    await c.request("workspace.get", {});
    await waitForLogged(c, (m) => m.error?.code === -32600);
  });

  test("pipelined requests on one connection are all answered and matched by id", async () => {
    const o = w().owner;
    const created = await Promise.all(Array.from({ length: 20 }, (_, i) => o.create(`pipelined ${i}`)));
    expect(new Set(created.map((t) => t.id)).size).toBe(20);
    expect(created.map((t) => t.title)).toEqual(Array.from({ length: 20 }, (_, i) => `pipelined ${i}`));
  });

  test("several connections can be open at once", async () => {
    const cs = await Promise.all([1, 2, 3].map(() => RpcClient.connect(w().engine.socket)));
    const rs = await Promise.all(cs.map((c) => c.request("workspace.get", {})));
    expect(new Set(rs.map((r) => r.workspace.id)).size).toBe(1);
    await Promise.all(cs.map((c) => c.close()));
  });
});

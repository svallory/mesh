// surfaceMethods: a method table from a surface's manifest. The manifest is built by hand here: its shape
// (`Surface` from `@meshfw/runtime`) is the contract between core and this reader, so no compiler is needed.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkRead, defineSurface, FrameworkError, InvalidInputError, type ActionContext, type Surface } from "@meshfw/runtime";
import { codes, RpcError, serve, surfaceMethods, type Server } from "../src/index.ts";
import { Client, socketDir } from "./client.ts";

type Seen = { action: string; input: unknown; context: unknown[] };
let seen: Seen[];

/** A run that records what it receives and answers with it. */
function recording(action: string) {
  return async (input: unknown, ...context: unknown[]) => {
    seen.push({ action, input, context });
    return { action, input };
  };
}

function tasksAndLists(): Surface {
  return defineSurface({
    name: "work",
    expose: {
      tasks: {
        entity: "work.Task",
        label: "Tasks",
        fields: ["id", "title"],
        actions: {
          read: { kind: "read", run: recording("tasks.read") },
          complete: { kind: "update", run: recording("tasks.complete") },
        },
      },
      lists: {
        entity: "work.List",
        label: "Lists",
        fields: ["id"],
        actions: { complete: { kind: "update", run: recording("lists.complete") } },
      },
    },
    publishes: [],
  });
}

beforeEach(() => {
  seen = [];
});

describe("the method table", () => {
  test("one method per action line, named <exposed name>.<action>, in declaration order", () => {
    expect(Object.keys(surfaceMethods(tasksAndLists()))).toEqual(["tasks.read", "tasks.complete", "lists.complete"]);
  });

  test("an expose line with no action line gives no method, and a surface with no expose line an empty table", () => {
    const surface = defineSurface({
      name: "quiet",
      expose: { tags: { entity: "work.Tag", label: "tags", fields: [], actions: {} } },
      publishes: [],
    });
    expect(surfaceMethods(surface)).toEqual({});
    expect(surfaceMethods(defineSurface({ name: "empty", expose: {}, publishes: [] }))).toEqual({});
  });

  test("no params schema is set: the action's own cast validates", () => {
    for (const method of Object.values(surfaceMethods(tasksAndLists()))) expect(method.params).toBeUndefined();
  });

  test("a method passes params as the action's input and the call's context as its context", async () => {
    const methods = surfaceMethods(tasksAndLists());
    const context = { actor: "ana" } as ActionContext;
    const call = { method: "tasks.complete", id: 1, params: { id: "t1" }, connection: undefined as never };
    expect(await methods["tasks.complete"]!.run({ id: "t1" }, context, call)).toEqual({ action: "tasks.complete", input: { id: "t1" } });
    expect(seen).toEqual([{ action: "tasks.complete", input: { id: "t1" }, context: [context] }]);
  });

  test("a custom name gives each method its name", () => {
    const methods = surfaceMethods(tasksAndLists(), { name: (exposed, action) => `${action}_${exposed}` });
    expect(Object.keys(methods)).toEqual(["read_tasks", "complete_tasks", "complete_lists"]);
  });

  test("an exposed name or method name that is an Object.prototype key is still an own method", () => {
    const surface = defineSurface({
      name: "odd",
      expose: {
        constructor: { entity: "work.Task", label: "x", fields: [], actions: { toString: { kind: "read", run: recording("x") } } },
      },
      publishes: [],
    });
    expect(Object.keys(surfaceMethods(surface))).toEqual(["constructor.toString"]);
    const proto = surfaceMethods(surface, { name: () => "__proto__" });
    expect(Object.keys(proto)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
  });

  test("two actions that name maps to one method name are refused when the table is built", () => {
    expect(() => surfaceMethods(tasksAndLists(), { name: (_exposed, action) => action })).toThrow(
      new FrameworkError("surfaceMethods: `name` gives tasks.complete and lists.complete the one method name `complete`; method names must differ"),
    );
  });

  test("a method name that starts with rpc. is refused, from an expose line or from name", () => {
    const rpc = defineSurface({
      name: "odd",
      expose: { rpc: { entity: "work.Task", label: "rpc", fields: [], actions: { read: { kind: "read", run: recording("rpc.read") } } } },
      publishes: [],
    });
    const message = (method: string) =>
      `surfaceMethods: method name ${method} starts with \`rpc.\`, which JSON-RPC 2.0 reserves for the protocol; rename the expose line or pass \`name\``;
    expect(() => surfaceMethods(rpc)).toThrow(new FrameworkError(message("rpc.read")));
    expect(() => surfaceMethods(tasksAndLists(), { name: (exposed, action) => `rpc.${exposed}.${action}` })).toThrow(
      new FrameworkError(message("rpc.tasks.read")),
    );
    // Legal neighbours: `rpc` without the dot, and a name that only contains `rpc.`.
    expect(Object.keys(surfaceMethods(rpc, { name: (exposed, action) => `${exposed}_${action}` }))).toEqual(["rpc_read"]);
    expect(Object.keys(surfaceMethods(tasksAndLists(), { name: (exposed, action) => `x.rpc.${exposed}.${action}` }))).toHaveLength(3);
  });

  test("a name that returns anything but a non-empty string is refused", () => {
    for (const bad of ["", 7, undefined]) {
      expect(() => surfaceMethods(tasksAndLists(), { name: () => bad as string })).toThrow(
        new FrameworkError(`surfaceMethods: \`name\` must return a non-empty string; it returned ${bad === "" ? '""' : String(bad)} for tasks.read`),
      );
    }
  });

  test("something that is not a manifest is refused", () => {
    for (const bad of [undefined, null, {}, { expose: null }]) {
      expect(() => surfaceMethods(bad as unknown as Surface)).toThrow(
        new FrameworkError("surfaceMethods needs a surface's manifest, the `surface` a `#mesh/surfaces/<name>` module exports"),
      );
    }
  });
});

describe("served", () => {
  let dir: Awaited<ReturnType<typeof socketDir>>;
  let server: Server | undefined;
  let client: Client | undefined;

  beforeEach(async () => {
    dir = await socketDir();
  });

  afterEach(async () => {
    client?.end();
    await server?.close();
    client = server = undefined;
    await dir.remove();
  });

  async function ask(method: string, params?: unknown): Promise<any> {
    client!.send(params === undefined ? { jsonrpc: "2.0", id: 1, method } : { jsonrpc: "2.0", id: 1, method, params });
    return client!.next();
  }

  async function start(surface: Surface): Promise<void> {
    server = await serve({
      socket: dir.path(),
      methods: surfaceMethods(surface),
      context: () => ({ actor: "ana" }) as ActionContext,
      error(error) {
        if (error instanceof RpcError) return { code: error.code, message: error.message };
        if (error instanceof InvalidInputError) return { code: codes.invalidParams, message: error.code, data: { issues: error.issues } };
        throw error;
      },
      log: () => {},
    });
    client = await Client.open(server.socket);
  }

  test("params reach run with the context the factory built, and its result is the answer", async () => {
    await start(tasksAndLists());
    expect(await ask("tasks.read", { filter: { title: { eq: "a" } } })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { action: "tasks.read", input: { filter: { title: { eq: "a" } } } },
    });
    // A request without params runs the action with `{}`.
    expect((await ask("lists.complete")).result).toEqual({ action: "lists.complete", input: {} });
    expect(seen.map(({ context }) => context)).toEqual([[{ actor: "ana" }], [{ actor: "ana" }]]);
  });

  test("an InvalidInputError with code not_exposed thrown by run reaches the wire through the error option", async () => {
    // The run does what a generated read does first: checkRead refuses a filter on a field the line does not list.
    const surface = defineSurface({
      name: "work",
      expose: {
        tasks: {
          entity: "work.Task",
          label: "Tasks",
          fields: ["id", "title"],
          actions: {
            read: {
              kind: "read",
              run: async (input: unknown) => {
                checkRead(input, ["id", "title"], []);
                return recording("tasks.read")(input);
              },
            },
          },
        },
      },
      publishes: [],
    });
    await start(surface);
    const { error } = await ask("tasks.read", { filter: { body: { eq: "x" } } });
    expect(error.code).toBe(codes.invalidParams);
    expect(error.message).toBe("invalid_input");
    expect(error.data.issues.map(({ code, path }: { code: string; path: unknown }) => ({ code, path }))).toEqual([
      { code: "not_exposed", path: ["filter", "body"] },
    ]);
    expect(seen).toEqual([]);
    // A listed field passes and reaches the action.
    expect((await ask("tasks.read", { filter: { title: { eq: "x" } } })).result.action).toBe("tasks.read");
  });

  test("an action the surface does not list answers -32601", async () => {
    await start(tasksAndLists());
    expect((await ask("lists.read", {})).error).toEqual({ code: -32601, message: "Method not found" });
    expect((await ask("tasks", {})).error.code).toBe(-32601);
    expect(seen).toEqual([]);
  });
});

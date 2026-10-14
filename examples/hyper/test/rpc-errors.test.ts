// How the port's errors reach the wire (`src/rpc/errors.ts`): each kind of Mesh error to the spec's code, phase and
// failures, the server's own -32601 and -32602 given the same shape, and everything else left to be answered -32603.
import { describe, expect, test } from "bun:test";
import { type Call, codes, RpcError } from "@meshfw/jsonrpc";
import { type ActionContext, ForbiddenError, FrameworkError, InvalidInputError, type Issue, NotFoundError } from "@meshfw/runtime";
import { contentChecks, messages, recordTypeOf, rpcErrorOf, specCodes, wireError } from "../src/rpc/errors";

const issue = (code: string | null, message: string, extra: Partial<Issue> = {}): Issue =>
  ({ label: code === null ? null : code.replace(/\W/g, ""), code, path: [], message, source: null, details: null, ...extra });

const denial = (policies: readonly string[], reason?: "failed" | "not-covered" | "not-applied") =>
  new ForbiddenError({ entity: "identity.Membership", action: "grant", policies, breakdown: [], ...(reason ? { reason } : {}) });

const asRole = (role: "owner" | "member" | "guest" | null): ActionContext => ({ actor: { id: "a", role } });

const call = (method: string): Call => ({ method, id: 1, params: {}, connection: {} as Call["connection"] });

/** The error object `rpcErrorOf` gives, as the client reads it. */
function wire(error: unknown, context?: ActionContext) {
  const mapped = rpcErrorOf(error, context);
  return mapped && { code: mapped.code, message: mapped.message, data: mapped.data };
}

describe("rpcErrorOf: InvalidInputError", () => {
  test("a content check on the spec's list is -32003 rule_violation in the content phase, with its details", () => {
    const error = new InvalidInputError([issue("membership.last-owner", "the workspace needs an owner", { details: { collaboratorId: "c" } })]);
    expect(wire(error)).toEqual({
      code: -32003,
      message: "rule_violation",
      data: { phase: "content", failures: [{ check: "membership.last-owner", reason: "the workspace needs an owner", details: { collaboratorId: "c" } }] },
    });
  });

  test("details that are not an object are left out, as the spec's Failure takes only an object", () => {
    for (const details of [null, "text", 3, ["a"]]) {
      const mapped = wire(new InvalidInputError([issue("task.open", "the task is settled", { details })]));
      expect(mapped?.data).toEqual({ phase: "content", failures: [{ check: "task.open", reason: "the task is settled" }] });
    }
  });

  test("an expected-version failure makes it -32002 version_conflict, listing every content failure", () => {
    const error = new InvalidInputError([issue("task.open", "the task is settled"), issue("expected-version", "the task is at version 3, not 2")]);
    expect(wire(error)).toEqual({
      code: -32002,
      message: "version_conflict",
      data: {
        phase: "content",
        failures: [{ check: "task.open", reason: "the task is settled" }, { check: "expected-version", reason: "the task is at version 3, not 2" }],
      },
    });
  });

  test("an issue with no code is a schema failure, -32602 in the shape phase, and the coded ones are not reported with it", () => {
    const error = new InvalidInputError([issue(null, "Invalid UUID", { path: ["collaborator"] }), issue("task.open", "the task is settled")]);
    expect(wire(error)).toEqual({
      code: -32602,
      message: "invalid_params",
      data: { phase: "shape", failures: [{ check: "schema", reason: "collaborator: Invalid UUID", details: { path: ["collaborator"] } }] },
    });
  });

  test("a schema failure with no path or message still has a reason", () => {
    const mapped = wire(new InvalidInputError([issue(null, "")]));
    expect(mapped?.data).toEqual({ phase: "shape", failures: [{ check: "schema", reason: "does not match the schema", details: { path: [] } }] });
  });

  test("evidence.exists is the spec's exists in the permission phase, -32005, one failure per missing id", () => {
    const error = new InvalidInputError([issue("evidence.exists", "evidence is missing", { details: { missing: ["e1", "e2"] } })]);
    const mapped = wire(error);
    expect(mapped?.code).toBe(-32005);
    expect(mapped?.message).toBe("not_found");
    expect(mapped?.data).toMatchObject({
      phase: "permission",
      failures: [
        { check: "exists", details: { recordType: "evidence-reference", id: "e1" } },
        { check: "exists", details: { recordType: "evidence-reference", id: "e2" } },
      ],
    });
  });

  test("evidence.exists that names no missing id has no wire error", () => {
    expect(rpcErrorOf(new InvalidInputError([issue("evidence.exists", "evidence is missing")]))).toBeUndefined();
  });

  test("a rule of the port alone has no wire error, even beside one of the spec's", () => {
    for (const code of ["claim.stale-fence", "machine.retired", "attempt.open"]) {
      expect(contentChecks.has(code)).toBe(false);
      expect(rpcErrorOf(new InvalidInputError([issue(code, "port rule")]))).toBeUndefined();
      expect(rpcErrorOf(new InvalidInputError([issue("task.open", "the task is settled"), issue(code, "port rule")]))).toBeUndefined();
    }
  });

  test("workspace.exists, which only the port's workspace.create check gives, is on the spec's list", () => {
    expect(wire(new InvalidInputError([issue("workspace.exists", "this engine already hosts a workspace")]))?.code).toBe(-32003);
  });
});

describe("rpcErrorOf: ForbiddenError", () => {
  const rows: readonly [string, string][] = [
    ["membersRead", "membership"],
    ["isMember", "membership"],
    ["claimAssignee", "claim.assignee"],
    ["claimHolder", "claim.holder"],
    ["claimRevoker", "claim.revoker"],
    ["taskManager", "task.manager"],
    ["taskUnassigner", "task.manager"],
    ["reviewReviewer", "review.reviewer"],
    ["submissionSubmitter", "submission.submitter"],
    ["collaboratorSelfOrOwner", "collaborator.self-or-owner"],
  ];

  for (const [policy, check] of rows) {
    test(`policy ${policy} is the permission check ${check}, -32001`, () => {
      const mapped = wire(denial([policy]), asRole("member"));
      expect(mapped?.code).toBe(-32001);
      expect(mapped?.message).toBe("permission_denied");
      const data = mapped?.data as { phase: string; failures: { check: string; reason: string; details?: unknown }[] };
      expect(data.phase).toBe("permission");
      expect(data.failures).toHaveLength(1);
      expect(data.failures[0]!.check).toBe(check);
      expect(data.failures[0]!.reason.length).toBeGreaterThan(0);
      expect(data.failures[0]!.details).toBeUndefined();
    });
  }

  test("ownerOnly is the role check, with the actor's role and the roles that would pass", () => {
    expect(wire(denial(["ownerOnly"]), asRole("member"))?.data).toMatchObject({
      phase: "permission",
      failures: [{ check: "role", details: { role: "member", required: ["owner"] } }],
    });
  });

  test("ownerOrMember is the role check, and a guest's role is named", () => {
    expect(wire(denial(["ownerOrMember"]), asRole("guest"))?.data).toMatchObject({
      failures: [{ check: "role", details: { role: "guest", required: ["owner", "member"] } }],
    });
  });

  test("the role is null when the call has no context", () => {
    expect(wire(denial(["ownerOnly"]))?.data).toMatchObject({ failures: [{ check: "role", details: { role: null, required: ["owner"] } }] });
  });

  test("two policies that stand for one check give one failure", () => {
    const data = wire(denial(["taskManager", "taskUnassigner"]), asRole("member"))?.data as { failures: unknown[] };
    expect(data.failures).toEqual([{ check: "task.manager", reason: expect.any(String) }]);
  });

  test("two policies that stand for two checks give both, in order", () => {
    const data = wire(denial(["isMember", "claimAssignee"]), asRole("member"))?.data as { failures: { check: string }[] };
    expect(data.failures.map((failure) => failure.check)).toEqual(["membership", "claim.assignee"]);
  });

  test("a policy no v0 method should reach has no wire error, alone or beside a mapped one", () => {
    for (const policy of ["internal", "reviewCompletion", "attemptPerformer", "runCanceler"]) {
      expect(rpcErrorOf(denial([policy]), asRole("owner"))).toBeUndefined();
      expect(rpcErrorOf(denial(["isMember", policy]), asRole("owner"))).toBeUndefined();
    }
  });

  test("a denial that is not a failed policy (not covered, not applied) has no wire error", () => {
    expect(rpcErrorOf(denial([]), asRole("owner"))).toBeUndefined();
    expect(rpcErrorOf(denial(["isMember"], "not-applied"), asRole("owner"))).toBeUndefined();
    expect(rpcErrorOf(denial(["isMember"], "not-covered"), asRole("owner"))).toBeUndefined();
  });
});

describe("rpcErrorOf: NotFoundError and the rest", () => {
  test("a missing record is -32005 not_found, check exists, naming the record type and the id", () => {
    expect(wire(new NotFoundError("work.Task", { id: "t-1" }))).toEqual({
      code: -32005,
      message: "not_found",
      data: { phase: "permission", failures: [{ check: "exists", reason: "no task with id t-1", details: { recordType: "task", id: "t-1" } }] },
    });
  });

  test("a key given as the id itself names that id", () => {
    expect(wire(new NotFoundError("identity.Collaborator", "c-1"))?.data).toMatchObject({ failures: [{ details: { recordType: "collaborator", id: "c-1" } }] });
  });

  test("the record type is the entity's name in kebab case", () => {
    expect(recordTypeOf("work.EvidenceReference")).toBe("evidence-reference");
    expect(recordTypeOf("identity.Membership")).toBe("membership");
    expect(recordTypeOf("Task")).toBe("task");
  });

  test("an RpcError passes through as it is", () => {
    const error = new RpcError(specCodes.notImplemented, "not_implemented", { phase: "shape", failures: [] });
    expect(rpcErrorOf(error)).toBe(error);
  });

  test("a framework error or any other error has no wire error", () => {
    expect(rpcErrorOf(new FrameworkError("bug"))).toBeUndefined();
    expect(rpcErrorOf(new Error("bug"))).toBeUndefined();
    expect(rpcErrorOf("bug")).toBeUndefined();
  });
});

describe("wireError", () => {
  test("the server's -32601 gets the method check in the shape phase", () => {
    expect(wireError(new RpcError(codes.methodNotFound, "method_not_found"), call("task.fly"))).toEqual({
      code: -32601,
      message: "method_not_found",
      data: { phase: "shape", failures: [{ check: "method", reason: 'unknown method "task.fly"; see the protocol\'s method list' }] },
    });
  });

  test("the server's -32602 turns each schema issue into a schema failure", () => {
    const error = new RpcError(codes.invalidParams, "invalid_params", { issues: [{ message: "Required", path: ["payload", "title"] }, { message: "Too small", path: ["commandId"] }] });
    expect(wireError(error, call("task.create"))).toEqual({
      code: -32602,
      message: "invalid_params",
      data: {
        phase: "shape",
        failures: [
          { check: "schema", reason: "payload.title: Required", details: { path: ["payload", "title"] } },
          { check: "schema", reason: "commandId: Too small", details: { path: ["commandId"] } },
        ],
      },
    });
  });

  test("a -32602 with an empty issue list still has a failure", () => {
    const object = wireError(new RpcError(codes.invalidParams, "invalid_params", { issues: [] }), call("task.create"));
    expect((object.data as { failures: unknown[] }).failures).toHaveLength(1);
  });

  test("any other RpcError passes through, its data kept", () => {
    const data = { phase: "permission", failures: [{ check: "membership", reason: "no membership" }] };
    expect(wireError(new RpcError(-32001, "permission_denied", data), call("task.create"))).toEqual({ code: -32001, message: "permission_denied", data });
    expect(wireError(new RpcError(codes.parseError, "parse_error"), call(""))).toEqual({ code: -32700, message: "parse_error" });
  });

  test("an error that is not an RpcError is rethrown, so the server answers -32603 and logs it", () => {
    const bug = new Error("bug");
    expect(() => wireError(bug, call("task.create"))).toThrow(bug);
  });
});

test("the reserved codes are sent with the spec's short names", () => {
  expect(messages).toEqual({
    [-32700]: "parse_error",
    [-32600]: "invalid_request",
    [-32601]: "method_not_found",
    [-32602]: "invalid_params",
    [-32603]: "internal_error",
  });
});

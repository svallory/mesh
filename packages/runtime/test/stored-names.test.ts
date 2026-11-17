import { describe, expect, test } from "bun:test";
import { renamedMap, renamedProblems, renamedShapeProblems, resolveEventName, storedToDeclared } from "@meshfw/runtime";
import { storedNamesOf } from "../src/stored-names.ts";

const FQNS = ["finance.InvoicePaid", "billing.v2.InvoiceVoided", "audit.InvoiceVoided", "audit.Viewed"];

describe("resolveEventName", () => {
  test.each([
    ["an exact FQN", "finance.InvoicePaid", { kind: "found", fqn: "finance.InvoicePaid" }],
    ["the last segment alone, when one event has it", "InvoicePaid", { kind: "found", fqn: "finance.InvoicePaid" }],
    ["trailing segments that pick one", "v2.InvoiceVoided", { kind: "found", fqn: "billing.v2.InvoiceVoided" }],
    ["a last segment two events share", "InvoiceVoided", { kind: "ambiguous", candidates: ["audit.InvoiceVoided", "billing.v2.InvoiceVoided"] }],
    ["a name no event has", "InvoicePayed", { kind: "unknown" }],
    ["more segments than any FQN", "x.finance.InvoicePaid", { kind: "unknown" }],
    ["a partial segment", "Paid", { kind: "unknown" }],
    ["a different case", "invoicepaid", { kind: "unknown" }],
    ["the empty string", "", { kind: "unknown" }],
  ])("%s", (_label, input, expected) => {
    expect(resolveEventName(input, FQNS)).toEqual(expected as never);
  });
});

describe("renamedMap", () => {
  test("a valid map resolves each value to its full FQN; {} is legal and empty; two former names may map to one event", () => {
    const result = renamedMap({ "billing.InvoicePaid": "InvoicePaid", "old.InvoicePaid": "finance.InvoicePaid", "x.Seen": "Viewed" }, FQNS);
    expect("map" in result && [...result.map]).toEqual([
      ["billing.InvoicePaid", "finance.InvoicePaid"], ["old.InvoicePaid", "finance.InvoicePaid"], ["x.Seen", "audit.Viewed"],
    ]);
    const empty = renamedMap({}, []);
    expect("map" in empty && empty.map.size).toBe(0);
  });

  test.each([
    ["not an object", "billing.InvoicePaid", "`events.renamed` must be an object from a former event FQN to the event it now is"],
    ["an array", [["a.B", "c.D"]], "`events.renamed` must be an object"],
    ["null", null, "`events.renamed` must be an object"],
    ["a class instance", new Map([["a", "b"]]), "`events.renamed` must be an object"],
    ["a number value", { "billing.InvoicePaid": 3 }, "`events.renamed` maps \"billing.InvoicePaid\" to a number: each value names a declared event"],
    ["an empty value", { "billing.InvoicePaid": "" }, "`events.renamed` maps \"billing.InvoicePaid\" to an empty string: each value names a declared event"],
    ["an empty key", { "": "finance.InvoicePaid" }, "`events.renamed` has an empty key: each key is a former event FQN"],
    ["a declared key", { "finance.InvoicePaid": "audit.Viewed" }, "`events.renamed` maps \"finance.InvoicePaid\", which is a declared event: each key is a former FQN that no event declares now"],
    ["an unknown value", { "billing.InvoicePaid": "finance.InvoicePayed" }, "`events.renamed` maps \"billing.InvoicePaid\" to \"finance.InvoicePayed\", which is no declared event; the project declares audit.InvoiceVoided, audit.Viewed, billing.v2.InvoiceVoided, finance.InvoicePaid"],
    ["an ambiguous value", { "billing.InvoiceVoided": "InvoiceVoided" }, "`events.renamed` maps \"billing.InvoiceVoided\" to \"InvoiceVoided\", which is ambiguous: audit.InvoiceVoided or billing.v2.InvoiceVoided"],
    ["a chain", { "a.InvoicePaid": "b.InvoicePaid", "b.InvoicePaid": "finance.InvoicePaid" }, "`events.renamed` maps \"a.InvoicePaid\" to \"b.InvoicePaid\", which is no declared event; it is itself a key of events.renamed"],
  ])("refuses %s", (_label, renamed, message) => {
    const result = renamedMap(renamed, FQNS);
    expect("problem" in result && result.problem).toStartWith(message);
  });

  test("a non-empty map in a project that declares no event is refused; every problem is listed, the first is the map's", () => {
    const none = renamedMap({ "billing.InvoicePaid": "finance.InvoicePaid" }, []);
    expect("problem" in none && none.problem).toBe("`events.renamed` maps \"billing.InvoicePaid\", and the project declares no event: the map renames stored events to declared ones");
    const problems = renamedProblems({ "finance.InvoicePaid": "audit.Viewed", "x.Y": "Nope" }, FQNS);
    expect(problems.map((problem) => problem.fix)).toEqual(["Remove the entry, or correct the key", "Correct the name"]);
    expect(renamedShapeProblems({ a: 1, b: "", c: "ok" }).map((problem) => problem.message)).toHaveLength(2);
  });
});

describe("storedToDeclared and storedNamesOf", () => {
  const map = new Map([["billing.InvoicePaid", "finance.InvoicePaid"], ["old.InvoicePaid", "finance.InvoicePaid"]]);
  test("a former name is read as the event it now is; any other name, a declared one included, is itself; applying it twice changes nothing", () => {
    expect(storedToDeclared(map, "billing.InvoicePaid")).toBe("finance.InvoicePaid");
    expect(storedToDeclared(map, "finance.InvoicePaid")).toBe("finance.InvoicePaid");
    expect(storedToDeclared(map, "audit.Viewed")).toBe("audit.Viewed");
    expect(storedToDeclared(map, storedToDeclared(map, "old.InvoicePaid"))).toBe("finance.InvoicePaid");
  });
  test("the stored names of a list add every former name of each event, and nothing for an empty map", () => {
    expect(storedNamesOf(map, ["finance.InvoicePaid", "audit.Viewed"]).sort()).toEqual(["audit.Viewed", "billing.InvoicePaid", "finance.InvoicePaid", "old.InvoicePaid"]);
    expect(storedNamesOf(map, ["audit.Viewed"])).toEqual(["audit.Viewed"]);
    expect(storedNamesOf(new Map(), ["a.B"])).toEqual(["a.B"]);
  });
});

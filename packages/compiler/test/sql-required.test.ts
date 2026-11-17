import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Diagnostic } from "@meshfw/model";
import { capabilityDiagnostics } from "../src/capabilities.ts";
import { FILES, invoice, project } from "./sql-fixture.ts";

// Where SQL is required (a read's filter, a sort key, a read policy), what has no SQL form is a build error at the
// construct (M10, design section 6), never evaluated over loaded rows. The plain-function cases of a filter and of a
// policy are in actions.test.ts and policies.test.ts; these are the ones lowering finds.

let fixture: Awaited<ReturnType<typeof project>>;
beforeAll(async () => { fixture = await project(); });
afterAll(() => fixture.close());

const errors = (diagnostics: readonly Diagnostic[]) => diagnostics.filter((d) => d.severity === "error");
const brief = (d: Diagnostic) => ({ code: d.code, message: d.message, at: `${d.position.file}:${d.position.offset}`, fix: d.fix });
const build = (filters: readonly string[], extra = "", more: Record<string, string> = {}) => fixture.build(invoice(filters, extra), more);
const FIX_COMPUTED = "rewrite computed :label as one expression Mesh translates, or write the condition over the members it reads";

describe("MESH_EXPR_NOT_SQL", () => {
  test("a filter that reads a computed field Mesh runs in memory, directly or through another, names the field and why", () => {
    const built = build(['() => &customer.label === "a!"', '() => &shout === "a!"']);
    expect(errors(built.diagnostics).map(brief)).toEqual([
      { code: "MESH_EXPR_NOT_SQL", message: "the filter of read :r0 of billing.Invoice must run as SQL, and &customer.label is a computed field Mesh runs in memory (arithmetic on values that are not numbers)",
        at: `billing/invoice.mesh.mx:${built.source.indexOf("&customer.label ===")}`, fix: FIX_COMPUTED },
      { code: "MESH_EXPR_NOT_SQL", message: "the filter of read :r1 of billing.Invoice must run as SQL, and &shout reads computed :label of billing.Customer, which Mesh runs in memory (arithmetic on values that are not numbers)",
        at: `billing/invoice.mesh.mx:${built.source.indexOf("&shout ===")}`, fix: FIX_COMPUTED },
    ]);
  });

  test("a sort key that is a computed field Mesh runs in memory is refused at the key", () => {
    const built = build([], "    read :sorted\n      sort\n        asc &dueOn\n        desc &shout\n");
    expect(errors(built.diagnostics).map(brief)).toEqual([
      { code: "MESH_EXPR_NOT_SQL", message: "the sort of read :sorted of billing.Invoice must run as SQL, and &shout reads computed :label of billing.Customer, which Mesh runs in memory (arithmetic on values that are not numbers)",
        at: `billing/invoice.mesh.mx:${built.source.indexOf("&shout\n")}`, fix: FIX_COMPUTED },
    ]);
  });

  test("a quantifier over a list that is not a relationship of the record, when it reads the record", () => {
    const built = build(["({ actor }) => actor.ids.some((i) => i === &id)"]);
    expect(errors(built.diagnostics).map(brief)).toEqual([
      { code: "MESH_EXPR_NOT_SQL", message: "the filter of read :r0 of billing.Invoice must run as SQL, and `some` here goes over a list that is not a relationship of the record, which a query cannot do",
        at: `billing/invoice.mesh.mx:${built.source.indexOf("actor.ids.some")}`, fix: "go over a has-many of the record, or test the list in a helper that does not read the record" },
    ]);
  });

  test("a computed field that reaches itself again through a relationship", () => {
    const node = FILES["billing/node.mesh.mx"]!.replace("  actions auto=[:read]\n", "  actions auto=[:read]\n    read :deep filter=() => &depth > 2\n");
    const built = build([], "", { "billing/node.mesh.mx": node });
    expect(errors(built.diagnostics).map(brief)).toEqual([
      { code: "MESH_EXPR_NOT_SQL", message: "the filter of read :deep of billing.Node must run as SQL, and computed :depth reaches itself again through a relationship, which a query cannot unfold",
        at: `billing/node.mesh.mx:${node.indexOf("&depth > 2")}`, fix: "store the value in an attribute, or write the condition over a fixed number of steps" },
    ]);
  });

  test("one function with two problems reports both; one that holds an error gets no second", () => {
    const both = build(['() => &customer.label === "a" && &nLines > 1']);
    expect(errors(both.diagnostics).map((d) => d.code)).toEqual(["MESH_EXPR_NOT_SQL", "MESH_NOT_IMPLEMENTED"]);
    const unknown = build(['() => &nope === "a" && &customer.label === "a"']);
    expect(errors(unknown.diagnostics).map((d) => d.code)).toEqual(["MESH_UNKNOWN_MEMBER"]);
  });
});

describe("a rollup where SQL is required waits for SQL rollups (MESH_NOT_IMPLEMENTED)", () => {
  const fix = "write the condition over the relationship itself, which translates: `&lines.length > 2`, `&lines.some((x) => x.n > 2)`";
  test("in a filter and as a sort key", () => {
    const built = build(["() => &nLines > 2"], "    read :sorted\n      sort\n        asc &nLines\n");
    expect(errors(built.diagnostics).map(brief)).toEqual([
      { code: "MESH_NOT_IMPLEMENTED", message: "the filter of read :r0 of billing.Invoice reads &nLines, a count rollup, and filtering, sorting or authorizing by a rollup arrives with SQL rollups (M10)",
        at: `billing/invoice.mesh.mx:${built.source.indexOf("&nLines > 2")}`, fix },
      { code: "MESH_NOT_IMPLEMENTED", message: "the sort of read :sorted of billing.Invoice reads &nLines, a count rollup, and filtering, sorting or authorizing by a rollup arrives with SQL rollups (M10)",
        at: `billing/invoice.mesh.mx:${built.source.lastIndexOf("&nLines")}`, fix },
    ]);
  });
});

describe("a json member read inside an inlined computed body (MESH_FILTER_TYPE)", () => {
  test("is refused at the read inside the body", () => {
    const customer = FILES["billing/customer.mesh.mx"]!.replace("    string :label()", "    boolean :described() { return &meta !== null }\n    string :label()");
    const built = build(["() => &customer.described"], "", { "billing/customer.mesh.mx": customer });
    expect(errors(built.diagnostics).map(brief)).toEqual([
      { code: "MESH_FILTER_TYPE", message: "&meta is :json, which a filter cannot use: the database does not look inside it", at: `billing/customer.mesh.mx:${customer.indexOf("&meta !== null")}`, fix: null },
    ]);
  });
});

describe("legal neighbours build clean", () => {
  test("translated filters across relationships, parameters of every kind, and the plain field read where SQL is not required", () => {
    const built = build([
      "() => &customer.bigCustomer && &isLate",
      "({ actor }) => &customer.ownerId === actor.id",
      '({ actor }) => actor.roles.some((r) => r === "admin") || &paid',
      "() => &total > cutoff(2)",
      "() => &late",
    ], `    read :sorted
      sort
        desc &dueOn
        asc &isLate
    update :check
      validate
        check :named that=() => &shout !== "x" && &nLines >= 0 code="c" message="c"
`);
    expect(errors(built.diagnostics)).toEqual([]);
  });

  test("a write policy that reads the record, and an actor-only read policy, are unchanged", () => {
    const source = invoice(["() => &paid"]).replace("    policy :open\n      authorize-if=() => true\n",
      "    policy :open types=[:read]\n      authorize-if=({ actor }) => actor.id !== null\n    policy :mine types=[:update]\n      authorize-if=({ actor }) => &customer.ownerId === actor.id\n");
    expect(errors(fixture.build(source).diagnostics)).toEqual([]);
  });
});

describe("the capabilities a condition needs (MESH_CAPABILITY)", () => {
  const adapter = (capabilities: string[]) => ({ kind: "data-adapter" as const, name: "test", build: "x", options: {}, capabilities: { adapter: "test", capabilities } }) as never;
  const lines = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => `${d.position.offset} ${d.message} | ${d.fix}`);
  test("a condition needs conditions; one that crosses a relationship needs joins, at each crossing", () => {
    const built = build(["({ actor }) => &customer.ownerId === actor.id && &lines.length > 1", "({ input }) => &customer.id === input.customerId"], "    read :sorted\n      sort\n        asc &dueOn\n");
    expect(errors(built.diagnostics)).toEqual([]);
    const full = ["aggregates", "conditions", "joins"];
    expect(capabilityDiagnostics(built.document!, adapter(full))).toEqual([]);
    expect(lines(capabilityDiagnostics(built.document!, adapter(["aggregates", "conditions"])))).toEqual([
      `${built.source.indexOf("&customer.ownerId")} the filter of read :r0 of billing.Invoice reads &customer.ownerId through a relationship, which runs as a subquery, and the data adapter "test" does not declare the joins capability | Use a data adapter that declares joins, or compare the related record's key (\`&customer.id\`), which needs no join`,
      `${built.source.indexOf("&lines.length")} the filter of read :r0 of billing.Invoice reads &lines through a relationship, which runs as a subquery, and the data adapter "test" does not declare the joins capability | Use a data adapter that declares joins`,
    ]);
    // `&customer.id` reads the stored key: it needs no join.
    expect(lines(capabilityDiagnostics(built.document!, adapter(["aggregates"])))).toEqual([
      `${built.source.indexOf("({ actor }) => &customer.ownerId")} the filter of read :r0 of billing.Invoice runs as SQL, and the data adapter "test" does not declare the conditions capability, so it would ignore the condition | Use a data adapter that declares conditions`,
      `${built.source.indexOf("({ input }) => &customer.id")} the filter of read :r1 of billing.Invoice runs as SQL, and the data adapter "test" does not declare the conditions capability, so it would ignore the condition | Use a data adapter that declares conditions`,
      `${built.source.indexOf("&dueOn\n")} the sort of read :sorted of billing.Invoice runs as SQL, and the data adapter "test" does not declare the conditions capability, so it would ignore the order | Use a data adapter that declares conditions`,
    ]);
  });
});

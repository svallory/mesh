import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Diagnostic } from "@meshfw/model";
import { capabilityDiagnostics } from "../src/capabilities.ts";
import { explainAction } from "../src/typescript/explain.ts";
import { actionsView } from "../src/typescript/views/actions.ts";
import { expressionsView } from "../src/typescript/views/expressions.ts";
import { loadView } from "../src/typescript/views/load.ts";
import { configOf } from "./generated.ts";
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

  test("a path read from a quantifier's element is named from that element, as written", () => {
    const built = build(['() => &lines.some((l) => l.invoice.customer.label === "x")', "() => &customer.invoices.some((i) => i.nLines > 1)"]);
    expect(errors(built.diagnostics).map((d) => [d.code, d.message, d.fix])).toEqual([
      ["MESH_EXPR_NOT_SQL", "the filter of read :r0 of billing.Invoice must run as SQL, and l.invoice.customer.label is a computed field Mesh runs in memory (arithmetic on values that are not numbers)", FIX_COMPUTED],
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
    const both = build(['() => &customer.label === "a" && &customer.meta !== null']);
    expect(errors(both.diagnostics).map((d) => d.code)).toEqual(["MESH_EXPR_NOT_SQL", "MESH_FILTER_TYPE"]);
    const unknown = build(['() => &nope === "a" && &customer.label === "a"']);
    expect(errors(unknown.diagnostics).map((d) => d.code)).toEqual(["MESH_UNKNOWN_MEMBER"]);
    // An error inside a computed body the filter or a sort key inlines is the one reported, not a second at the read.
    const customer = FILES["billing/customer.mesh.mx"]!.replace("    string :label()", "    boolean :bad() { return &nope === 1 }\n    string :label()");
    const inlined = fixture.build(invoice(["() => &customer.bad"], "    read :sorted\n      sort\n        asc &cb\n", "    boolean :cb() { return &customer.bad }\n"), { "billing/customer.mesh.mx": customer });
    expect(errors(inlined.diagnostics).map((d) => [d.code, d.position.file])).toEqual([["MESH_UNKNOWN_MEMBER", "billing/customer.mesh.mx"]]);
  });
});

describe("a rollup where SQL is required (m10-rollups, R22)", () => {
  const adapter = (capabilities: string[]) => ({ kind: "data-adapter" as const, name: "test", build: "x", options: {}, capabilities: { adapter: "test", capabilities } }) as never;
  const rollups = "    sum :qtyTotal of=&lines.qty\n    count :bigLines of=&lines filter=(l) => l.qty > 2\n";
  test("builds in a filter, as a sort key and in a read policy, and needs joins at each read, even over one relationship", () => {
    const source = invoice(["() => &nLines > 2 && &bigLines > 0"], "    read :sorted\n      sort\n        desc &qtyTotal\n", rollups)
      .replace("    policy :open\n      authorize-if=() => true\n", "    policy :open types=[:read]\n      authorize-if=() => &nLines < 100\n    policy :writes types=[:create, :update, :destroy]\n      authorize-if=() => true\n");
    const built = fixture.build(source);
    expect(errors(built.diagnostics)).toEqual([]);
    expect(capabilityDiagnostics(built.document!, adapter(["aggregates", "conditions", "joins"]))).toEqual([]);
    const at = (needle: string, from = 0) => source.indexOf(needle, from);
    const joins = "which runs as a subquery, and the data adapter \"test\" does not declare the joins capability | Use a data adapter that declares joins";
    expect(capabilityDiagnostics(built.document!, adapter(["aggregates", "conditions"])).map((d) => `${d.position.offset} ${d.message} | ${d.fix}`)).toEqual([
      `${at("&nLines > 2")} the filter of read :r0 of billing.Invoice reads &nLines through a relationship, ${joins}`,
      `${at("&bigLines > 0")} the filter of read :r0 of billing.Invoice reads &bigLines through a relationship, ${joins}`,
      `${at("&qtyTotal\n")} the sort of read :sorted of billing.Invoice reads &qtyTotal through a relationship, ${joins}`,
      `${at("&nLines < 100")} policy :open authorize-if of billing.Invoice reads &nLines through a relationship, ${joins}`,
    ]);
  });

  test("a rollup whose filter holds an error gets no second error at the read", () => {
    const built = fixture.build(invoice(["() => &badLines > 0"], "", "    count :badLines of=&lines filter=(l) => l.qty > &total\n"));
    expect(errors(built.diagnostics).map((d) => [d.code, d.position.offset])).toEqual([["MESH_ROLLUP_FILTER", built.source.indexOf("&total\n")]]);
  });
});

describe("a json member read inside an inlined computed body (MESH_FILTER_TYPE, MESH_SORT_TYPE)", () => {
  test("is refused at the read inside the body", () => {
    const customer = FILES["billing/customer.mesh.mx"]!.replace("    string :label()", "    boolean :described() { return &meta !== null }\n    string :label()");
    const built = build(["() => &customer.described"], "", { "billing/customer.mesh.mx": customer });
    expect(errors(built.diagnostics).map(brief)).toEqual([
      { code: "MESH_FILTER_TYPE", message: "&meta is :json, which a filter cannot use: the database does not look inside it", at: `billing/customer.mesh.mx:${customer.indexOf("&meta !== null")}`, fix: null },
    ]);
  });

  test("in a sort key, through another computed field, is the sort's code", () => {
    const customer = FILES["billing/customer.mesh.mx"]!.replace("    string :label()", "    boolean :described() { return &meta !== null }\n    string :label()");
    const built = fixture.build(invoice([], "    read :sorted\n      sort\n        asc &cd\n", "    boolean :cd() { return &customer.described }\n"), { "billing/customer.mesh.mx": customer });
    expect(errors(built.diagnostics).map(brief)).toEqual([
      { code: "MESH_SORT_TYPE", message: "&meta is :json, which a sort cannot use: the database does not look inside it", at: `billing/customer.mesh.mx:${customer.indexOf("&meta !== null")}`, fix: null },
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

describe("the joins fix names the related record's own key", () => {
  test("a belongs-to whose target key is not `id`", () => {
    const adapter = { kind: "data-adapter" as const, name: "test", build: "x", options: {}, capabilities: { adapter: "test", capabilities: ["aggregates", "conditions"] } } as never;
    const customer = FILES["billing/customer.mesh.mx"]!.replace("uuid :id primary-key", "uuid :code primary-key");
    const built = build(["({ actor }) => &customer.ownerId === actor.id"], "", { "billing/customer.mesh.mx": customer });
    expect(errors(built.diagnostics)).toEqual([]);
    expect(capabilityDiagnostics(built.document!, adapter).map((d) => d.fix)).toEqual([
      "Use a data adapter that declares joins, or compare the related record's key (`&customer.code`), which needs no join",
    ]);
  });
});

describe("mesh explain of a read with its own filter and sort", () => {
  test("names what the one query carries and each relationship it crosses", () => {
    const built = build(["({ actor }) => &customer.ownerId === actor.id && &lines.length > 1"], "    read :sorted\n      sort\n        desc &dueOn\n        asc &isLate\n");
    const entity = built.entity("Invoice");
    expect(explainAction(entity, "r0", built.document!)!.slice(1, 5)).toEqual([
      "  strategy     one query: the read's filter and the caller's, the caller's sort, limit and offset over the table",
      "               filter ({ actor }) => &customer.ownerId === actor.id && &lines.length > 1: runs as SQL, with the caller's filter and the policies",
      "               a subquery per row through &customer.ownerId",
      "               a subquery per row through &lines",
    ]);
    expect(explainAction(entity, "sorted", built.document!)!.slice(1, 4)).toEqual([
      "  strategy     one query: the caller's filter, the caller's sort then the read's, limit and offset over the table",
      "               sort desc &dueOn: runs as SQL, after the caller's sort keys; rows that tie on every key come in primary-key order",
      "               sort asc &isLate: runs as SQL, after the caller's sort keys; rows that tie on every key come in primary-key order",
    ]);
    // Its policies run before the query, as any read's do.
    expect(explainAction(entity, "r0", built.document!)).toContain("  policies     :open");
    // A read with neither keeps its one line.
    expect(explainAction(entity, "read", built.document!)![1]).toBe("  strategy     one query: the caller's filter, sort, limit and offset over the table");
  });
});

describe("a read policy that reads the record is lowered as a filter is (M10)", () => {
  /** The invoice file with its open policy replaced by `policy :mine types=[:read]` holding `lines`, and the writes open. */
  const withPolicy = (lines: string) => invoice([]).replace("    policy :open\n      authorize-if=() => true\n",
    `    policy :mine types=[:read]\n${lines}    policy :writes types=[:create, :update, :destroy]\n      authorize-if=() => true\n`);
  const head = "policy :mine authorize-if must run as SQL, since the policy covers read :read, the loads of it (a relationship or a rollup that reaches it) of billing.Invoice";

  test("each problem lowering finds is reported at the construct, with the policy's subject", () => {
    const built = fixture.build(withPolicy('      authorize-if=() => &shout === "x" || &nLines > 2 || &customer.meta !== null\n'));
    expect(errors(built.diagnostics).map(brief)).toEqual([
      { code: "MESH_EXPR_NOT_SQL", message: `${head}, and &shout reads computed :label of billing.Customer, which Mesh runs in memory (arithmetic on values that are not numbers)`,
        at: `billing/invoice.mesh.mx:${built.source.indexOf("&shout ===")}`, fix: FIX_COMPUTED },
      { code: "MESH_FILTER_TYPE", message: "&customer.meta is :json, which a read policy cannot use: it is a filter on the query, and the database does not look inside it",
        at: `billing/invoice.mesh.mx:${built.source.indexOf("&customer.meta")}`, fix: null },
    ]);
  });

  test("its legal neighbours build: across relationships, in a when, beside actor-only checks, a quantifier over the actor's list", () => {
    for (const lines of [
      "      authorize-if=({ actor }) => &customer.ownerId === actor.id\n",
      "      authorize-if=() => &lines.some((l) => l.qty > 2) && &customer.bigCustomer\n      forbid-if=() => &isLate\n",
      "      authorize-if=({ actor }) => actor.roles.some((r) => r === \"admin\") || &paid\n",
      "      authorize-if=({ actor }) => actor.id !== null\n      forbid-if=() => &late\n",
    ]) expect(errors(fixture.build(withPolicy(lines)).diagnostics), lines).toEqual([]);
    const when = invoice([]).replace("    policy :open\n      authorize-if=() => true\n",
      "    policy :mine types=[:read] when=() => &status === :sent\n      authorize-if=({ actor }) => actor.id !== null\n    policy :writes types=[:create, :update, :destroy]\n      authorize-if=() => true\n");
    expect(errors(fixture.build(when).diagnostics)).toEqual([]);
  });

  test("it needs conditions, and joins at each relationship it crosses", () => {
    const adapter = (capabilities: string[]) => ({ kind: "data-adapter" as const, name: "test", build: "x", options: {}, capabilities: { adapter: "test", capabilities } }) as never;
    const built = fixture.build(withPolicy("      authorize-if=({ actor }) => &customer.ownerId === actor.id\n"));
    expect(errors(built.diagnostics)).toEqual([]);
    const at = built.source.indexOf("({ actor }) => &customer.ownerId");
    expect(capabilityDiagnostics(built.document!, adapter(["aggregates", "conditions", "joins"]))).toEqual([]);
    expect(capabilityDiagnostics(built.document!, adapter(["aggregates", "conditions"])).map((d) => `${d.position.offset} ${d.message}`)).toEqual([
      `${built.source.indexOf("&customer.ownerId")} policy :mine authorize-if of billing.Invoice reads &customer.ownerId through a relationship, which runs as a subquery, and the data adapter "test" does not declare the joins capability`,
    ]);
    expect(capabilityDiagnostics(built.document!, adapter(["aggregates"])).map((d) => `${d.position.offset} ${d.message}`)).toEqual([
      `${at} policy :mine authorize-if of billing.Invoice runs as SQL, and the data adapter "test" does not declare the conditions capability, so it would ignore the condition`,
    ]);
  });

  test("mesh explain says the policy is folded into the query and names what it crosses", () => {
    const built = fixture.build(withPolicy("      authorize-if=({ actor }) => &customer.ownerId === actor.id\n"));
    const lines = explainAction(built.entity("Invoice"), "read", built.document!)!;
    expect(lines.slice(1, 3)).toEqual([
      "  strategy     one query: the caller's filter, the caller's sort, limit and offset over the table, with the policies that read the record folded in",
      "               a subquery per row through &customer.ownerId",
    ]);
    expect(lines).toContain("                 authorize-if ({ actor }) => &customer.ownerId === actor.id: folded into the query: a row is returned only when it holds");
  });
});

describe("the generated read of a policy that reads the record", () => {
  const withPolicy = (lines: string) => invoice(["({ input }) => &customer.id === input.customerId"]).replace("    policy :open\n      authorize-if=() => true\n",
    `    policy :mine types=[:read]\n${lines}    policy :writes types=[:create, :update, :destroy]\n      authorize-if=() => true\n`);
  const emitted = (lines: string) => {
    const built = fixture.build(withPolicy(lines));
    expect(errors(built.diagnostics)).toEqual([]);
    const input = { document: built.document!, config: configOf("/project", "generated") };
    return { built, input, view: actionsView(input, built.entity("Invoice")) };
  };

  test("the read action folds the policies with rows, and every read body it covers takes and applies them", () => {
    const { view } = emitted("      authorize-if=({ actor }) => &customer.ownerId === actor.id\n");
    const read = view.methods.find((m) => m.name === "read")!;
    expect(read.preCheck.at(-2)).toContain('checks: [{ kind: "authorize-if", check: "({ actor }) => &customer.ownerId === actor.id", record: true, run: $expressions["policy.mine.authorize-if.0"], sql: () => $conditions["policy.mine.authorize-if.0"] }]');
    expect(read.preCheck.at(-2)).toMatch(/^const \$rows = await \$authorizer\("billing\.Invoice", "read", .*\.rows\(layer, \$scope\(.*\), \$tableOf\);$/);
    expect(read.preCheck.at(-1)).toBe("if ($rows === false) return [] as unknown as (L extends unknown ? InvoiceWith<InvoiceLoadNames<L>>[] : never);");
    expect(read.readsCall).toContain("$reads.read(input, context, $clock, true, $parsed, $rows)");
    // The auto read has no filter of its own: its body applies the policies' condition alone.
    const body = view.reads.find((m) => m.name === "read")!;
    expect(body.contextParam.endsWith(", rows?: $Where")).toBe(true);
    expect(body.statements).toContain("const $where = $allOf([rows ?? true]);");
    expect(body.statements.find((line) => line.includes("tx.select"))).toContain("where: $whereFor(layer, $where)");
    // A declared filter is combined with them.
    expect(view.reads.find((m) => m.name === "r0")!.statements).toContain('const $where = $allOf([$bindCondition($tableOf, $conditions["read.r0.filter"], $s as never), rows ?? true]);');
    // The table map lists what the policy's hop reaches.
    expect(view.moduleLines.find((line) => line.startsWith("const $tableOf"))).toContain('"billing.Customer": tables.customer }');
    expect(view.runtimeTypes).toContain("Where as $Where");
  });

  test("the expressions file holds the policy's literal, typed by the scope its in-memory form has", () => {
    const { built, input } = emitted("      authorize-if=({ actor }) => &customer.ownerId === actor.id\n");
    const conditions = expressionsView(input, built.entity("Invoice"), "generated/domain/billing/invoice.expressions.ts").conditions;
    expect(conditions.map((entry) => entry.key)).toEqual(['"read.r0.filter"', '"policy.mine.authorize-if.0"']);
    expect(conditions[1]!.code).toContain('what: "policy :mine authorize-if of billing.Invoice"');
    expect(conditions[1]!.code.replace(/\s+/g, "")).toContain('"hop":{"column":"id","key":"id","outer":"customerId","table":"billing.Customer"}');
    expect(conditions[1]!.code).toMatch(/params: \(\$s: \$billing\$Invoice\$\w*Scope<unknown>\) => \[\$s\.actor/);
  });

  test("the load plan reads each literal lazily and imports $conditions only where a load needs it", () => {
    const { input } = emitted("      authorize-if=({ actor }) => &customer.ownerId === actor.id\n");
    const view = loadView(input, "generated/load.ts");
    expect(view.expressionImports.find((source) => source.local === "$billing$Invoice$expressions")!.conditions).toBe("$billing$Invoice$conditions");
    expect(view.expressionImports.filter((source) => source.conditions !== null)).toHaveLength(1);
    expect(view.entities.find((entity) => entity.nameLiteral === '"billing.Invoice"')!.reads).toContain('sql: () => $billing$Invoice$conditions["policy.mine.authorize-if.0"]');
  });

  test("an actor-only read policy keeps today's pre-check and body", () => {
    const { view } = emitted("      authorize-if=({ actor }) => actor.id !== null\n");
    expect(view.methods.find((m) => m.name === "read")!.preCheck.at(-1)).toContain(".filter(layer, ");
    expect(view.reads.find((m) => m.name === "read")!.contextParam).not.toContain("rows");
  });
});

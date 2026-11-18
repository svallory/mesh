import { afterAll, describe, expect, test } from "bun:test";
import type { BuildResult } from "../src/model/project.ts";
import { buildModel, parseEntitySource } from "../src/front-end/build.ts";
import { checksOf } from "../src/model/action-expressions.ts";
import { generateFiles } from "../src/typescript/emit.ts";
import { configOf } from "./generated.ts";
import { buildDialect, conceptProject } from "./helpers.ts";

// Mixins (`notes/architecture/mixins-design.md`, ruling D37): a project's mixin file, `use mixin=Name` under an entity,
// and the merge that makes a mixin's declarations members of each entity that uses it, as if written there.

const build = (files: Record<string, string>): BuildResult =>
  buildModel({ root: "/p", files: Object.entries(files).map(([file, source]) => ({ file, source })) });
/** Each diagnostic as `[code, file:line:column, message]`. */
const found = (result: BuildResult) => result.diagnostics.map((d) => [d.code, `${d.position.file}:${d.position.line}:${d.position.column}`, d.message]);
const errors = (result: BuildResult) => found(result).filter((_, index) => result.diagnostics[index]!.severity === "error");
const entityOf = (result: BuildResult, name: string) => result.document!.entities.find((entity) => entity.name === name)!;

const AUDITED = "mixin :Audited\n  attributes\n    uuid :createdBy\n    uuid :updatedBy nullable\n";
const IMPORT = 'import { Audited } from "../shared/audited.mesh.mx"\n';
/** An entity of `billing` that uses Audited: the spec's example without `Timestamps`. */
const invoice = (body = "", use = "  use mixin=Audited\n", imports = IMPORT) =>
  `${imports}entity :Invoice\n${use}  attributes\n    uuid :id primary-key\n    decimal :amount min=0\n  actions auto=[:read]\n${body}`;
const AUDITED_PROJECT = { "shared/audited.mesh.mx": AUDITED, "billing/invoice.mesh.mx": invoice() };

describe("the contracts", () => {
  const mx = (source: string) => parseEntitySource(source, "/p/x.mesh.mx").diagnostics.map((d) => [d.code, d.line, d.column, d.message]);
  const SECTIONS = "  attributes\n    uuid :x\n  relationships\n  computed\n  checks\n  actions auto=[:read]\n  policies\n  handlers\n";
  test("a mixin holds every section an entity holds but `events` and `commands`, each once", () => {
    expect(mx(`mixin :Audited\n${SECTIONS}`)).toEqual([]);
    expect(mx("mixin :Audited\n  attributes\n  attributes\n").map((d) => d[0])).toEqual(["MESH_REPEATED_CHILD"]);
  });
  const ALLOWED = "allowed children: `attributes`, `relationships`, `computed`, `checks`, `actions`, `policies`, `handlers`";
  test.each([
    ["`events` under `mixin` (R4)", "mixin :A\n  events\n", "MESH_TAG_NOT_ALLOWED", 2, 2, `\`mixin\`: \`events\` is not allowed here; ${ALLOWED}`],
    ["`commands` under `mixin` (R4)", "mixin :A\n  commands\n", "MESH_TAG_NOT_ALLOWED", 2, 2, `\`mixin\`: \`commands\` is not allowed here; ${ALLOWED}`],
    ["`use` under `mixin` (R5)", "mixin :A\n  use mixin=B\n", "MESH_TAG_NOT_ALLOWED", 2, 2, `\`mixin\`: \`use\` is not allowed here; ${ALLOWED}`],
    ["`table=` on `mixin` (R2)", 'mixin :A table="a"\n', "MESH_UNKNOWN_OPTION", 1, 9, "`mixin`: unknown option `table`"],
    ["`mixin` with no name", "mixin\n  attributes\n", "MESH_MISSING_OPTION", 1, 0, "`mixin`: missing required option `name`"],
    ["the atom form of `use` (R7)", "entity :E\n  use :timestamps\n", "MESH_UNKNOWN_OPTION", 2, 6, "`use`: unknown option `:timestamps` (`name`)"],
    ["`use` alone", "entity :E\n  use\n", "MESH_MISSING_OPTION", 2, 2, "`use` names what it includes: `use mixin=Timestamps`"],
    ["`mixin=` as a string (R8)", 'entity :E\n  use mixin="Audited"\n', "MESH_OPTION_VALUE", 2, 6, "`use`: option `mixin` must be an expression"],
    ["`mixin=` no reference (R8)", "entity :E\n  use mixin=foo()\n", "MESH_OPTION_VALUE", 2, 6, "`use`: mixin must be an imported mixin (`mixin=Timestamps`) or a member of a namespace import (`mixin=shared.Audited`)"],
    ["`mixin=` wrapped (R8)", "entity :E\n  use mixin=(Audited)\n", "MESH_OPTION_VALUE", 2, 12, "`use`: mixin must be the reference alone, with no parentheses, `!`, `as`, `satisfies` or `<T>` around it (`mixin=Timestamps`, `mixin=shared.Audited`)"],
    ["a line under `use`", "entity :E\n  use mixin=Audited\n    attributes\n", "MESH_TAG_NOT_ALLOWED", 3, 4, "`use`: `attributes` is not allowed here; allowed children: none"],
    ["`use` under a section", "entity :E\n  attributes\n    use mixin=Audited\n", "MESH_PARENT_NOT_ALLOWED", 3, 4, "`use` must be inside `architecture`, `entity`; found inside `attributes`"],
  ])("%s", (_, source, code, line, column, message) => expect(mx(source)).toEqual([[code, line, column, message]]));
  test("legal neighbours: `use` anywhere among an entity's lines, repeated, by name or through a namespace", () => {
    expect(mx("entity :E\n  attributes\n    uuid :id primary-key\n  use mixin=Audited\n  use mixin=shared.Audited\n  use mixin=Owned\n")).toEqual([]);
  });
});

describe("the merge (R13, R16)", () => {
  test("a mixin's members join the entity after its own, with their positions in the mixin's file", () => {
    const result = build(AUDITED_PROJECT);
    expect(found(result)).toEqual([]);
    const attributes = entityOf(result, "Invoice").attributes.map((a) => [a.name, `${a.position.file}:${a.position.line}`]);
    expect(attributes).toEqual([["id", "billing/invoice.mesh.mx:5"], ["amount", "billing/invoice.mesh.mx:6"], ["createdBy", "shared/audited.mesh.mx:3"], ["updatedBy", "shared/audited.mesh.mx:4"]]);
  });
  test("the order is the same with `use` below the sections; two mixins come in the order of their `use` lines", () => {
    const below = build({ ...AUDITED_PROJECT, "billing/invoice.mesh.mx": `${invoice("", "")}  use mixin=Audited\n` });
    expect(found(below)).toEqual([]);
    expect(entityOf(below, "Invoice").attributes.map((a) => a.name)).toEqual(["id", "amount", "createdBy", "updatedBy"]);
    const OWNED = "mixin :Owned\n  attributes\n    uuid :ownerId\n";
    const both = (uses: string) => build({ ...AUDITED_PROJECT, "shared/owned.mesh.mx": OWNED,
      "billing/invoice.mesh.mx": invoice("", uses, `${IMPORT}import { Owned } from "../shared/owned.mesh.mx"\n`) });
    expect(entityOf(both("  use mixin=Audited\n  use mixin=Owned\n"), "Invoice").attributes.map((a) => a.name)).toEqual(["id", "amount", "createdBy", "updatedBy", "ownerId"]);
    expect(entityOf(both("  use mixin=Owned\n  use mixin=Audited\n"), "Invoice").attributes.map((a) => a.name)).toEqual(["id", "amount", "ownerId", "createdBy", "updatedBy"]);
  });
  test("the model records the import as a mixin's, with no `helper`; the document holds no mixin", () => {
    const result = build(AUDITED_PROJECT);
    expect(entityOf(result, "Invoice").imports).toEqual([{ identifiers: ["Audited"], from: "../shared/audited.mesh.mx", mixin: true, position: { file: "billing/invoice.mesh.mx", line: 1, column: 0, offset: 0 } }]);
    expect(result.document!.entities.map((entity) => entity.name)).toEqual(["Invoice"]);
    expect(Object.keys(result.document!)).toEqual(["entities"]);
  });
  test("an aliased import and a namespace import read the same mixin", () => {
    const aliased = build({ ...AUDITED_PROJECT, "billing/invoice.mesh.mx": invoice("", "  use mixin=A\n", 'import { Audited as A } from "../shared/audited.mesh.mx"\n') });
    expect(found(aliased)).toEqual([]);
    expect(entityOf(aliased, "Invoice").attributes.map((a) => a.name)).toEqual(["id", "amount", "createdBy", "updatedBy"]);
    expect(entityOf(aliased, "Invoice").imports[0]).toMatchObject({ identifiers: ["A"], imported: ["Audited"], mixin: true });
    const namespaced = build({ ...AUDITED_PROJECT, "billing/invoice.mesh.mx": invoice("", "  use mixin=shared.Audited\n", 'import * as shared from "../shared/audited.mesh.mx"\n') });
    expect(found(namespaced)).toEqual([]);
    expect(entityOf(namespaced, "Invoice").attributes.map((a) => a.name)).toEqual(["id", "amount", "createdBy", "updatedBy"]);
  });
  test("`&name` in a mixin reads the includer's members, one it alone declares included; an includer without it is told, naming itself", () => {
    const CHECKED = 'mixin :Checked\n  checks\n    check :positive that=() => &amount > 0 code="amount.positive" message="the amount must be positive"\n';
    const user = (name: string, amount: string) => `import { Checked } from "../shared/checked.mesh.mx"\nentity :${name}\n  use mixin=Checked\n  attributes\n    uuid :id primary-key\n${amount}  actions auto=[:read]\n    update :pay\n      validate\n        check &positive\n`;
    const ok = build({ "shared/checked.mesh.mx": CHECKED, "billing/invoice.mesh.mx": user("Invoice", "    decimal :amount\n") });
    expect(found(ok)).toEqual([]);
    expect(checksOf(entityOf(ok, "Invoice").actions[0]!.validate).map((check) => [check.label, check.reference?.file])).toEqual([["positive", "billing/invoice.mesh.mx"]]);
    const missing = build({ "shared/checked.mesh.mx": CHECKED, "billing/invoice.mesh.mx": user("Invoice", "    decimal :amount\n"), "billing/quote.mesh.mx": user("Quote", ""), "billing/order.mesh.mx": user("Order", "") });
    expect(errors(missing)).toEqual([
      ["MESH_UNKNOWN_MEMBER", "shared/checked.mesh.mx:3:31", "&amount is not a member of billing.Quote."],
      ["MESH_UNKNOWN_MEMBER", "shared/checked.mesh.mx:3:31", "&amount is not a member of billing.Order."],
    ]);
  });
});

describe("one report per mistake in a mixin's lines (R19)", () => {
  const two = (mixin: string, invoiceBody = "", quoteBody = "", quoteAttributes = "    decimal :amount\n") => build({
    "shared/audited.mesh.mx": mixin,
    "billing/invoice.mesh.mx": `${IMPORT}entity :Invoice\n  use mixin=Audited\n  attributes\n    uuid :id primary-key\n    decimal :amount\n  actions auto=[:read]\n${invoiceBody}`,
    "billing/quote.mesh.mx": `${IMPORT}entity :Quote\n  use mixin=Audited\n  attributes\n    uuid :id primary-key\n${quoteAttributes}  actions auto=[:read]\n${quoteBody}`,
  });
  test("a form error that every includer has is reported once, unprefixed", () => {
    const result = two('mixin :Audited\n  checks\n    check :positive that=() => true message="x"\n');
    expect(errors(result)).toEqual([["MESH_MISSING_OPTION", "shared/audited.mesh.mx:3:4", "`check`: missing required option `code`"]]);
  });
  test("a mistake only some includers have is reported once, naming them", () => {
    // Quote's `amount` is a string: `&amount * 2` is arithmetic on a string there, and plain code (a warning), in Quote only.
    const result = two("mixin :Audited\n  computed\n    integer :twice() { return &amount * 2 }\n", "", "", "    string :amount\n");
    expect(found(result)).toEqual([["MESH_EXPR_PLAIN", "shared/audited.mesh.mx:3:30",
      "in billing.Quote, which uses this mixin, this expression runs as plain TypeScript with JavaScript's rules for null, not Mesh's, because of arithmetic on values that are not numbers"]]);
  });
  test("a relationship, an `on=` and a `publish` in a mixin name what only an import gives: each one error, whatever the includers", () => {
    expect(errors(two("mixin :Audited\n  relationships\n    belongs-to :owner entity=User\n"))).toEqual([["MESH_UNKNOWN_ENTITY", "shared/audited.mesh.mx:3:29", "User is not an imported entity."]]);
    expect(errors(two("mixin :Audited\n  actions\n    update on=Pay\n")).map((d) => d.slice(0, 2))).toEqual([["MESH_UNKNOWN_COMMAND", "shared/audited.mesh.mx:3:14"]]);
    expect(errors(two("mixin :Audited\n  actions\n    update :touch\n      do\n        publish=() => new Paid({})\n")).map((d) => d.slice(0, 2))).toEqual([["MESH_PUBLISH", "shared/audited.mesh.mx:5:26"]]);
  });
  test("a handler in a mixin names an event, which only an import gives: one `MESH_UNKNOWN_EVENT`", () => {
    expect(errors(two("mixin :Audited\n  handlers\n    listen :seen [on=Paid] ({ event }) {}\n")).map((d) => d.slice(0, 2))).toEqual([["MESH_UNKNOWN_EVENT", "shared/audited.mesh.mx:3:21"]]);
  });
  const CHECKS = 'mixin :Audited\n  checks\n    check :positive that=() => &amount > 0 code="amount.positive" message="the amount must be positive"\n';
  const USES = "    update :pay\n      validate\n        check &positive\n";
  test("`MESH_CHECK_UNUSED` for a mixin's check: once unprefixed when no includer uses it, prefixed when some do", () => {
    const unused = (result: BuildResult) => found(result).filter((d) => d[0] === "MESH_CHECK_UNUSED");
    expect(unused(two(CHECKS))).toEqual([["MESH_CHECK_UNUSED", "shared/audited.mesh.mx:3:4", "check :positive is declared and no `validate` uses it, so it never runs"]]);
    expect(unused(two(CHECKS, USES))).toEqual([["MESH_CHECK_UNUSED", "shared/audited.mesh.mx:3:4", "in billing.Quote, which uses this mixin, check :positive is declared and no `validate` uses it, so it never runs"]]);
    expect(unused(two(CHECKS, USES, USES))).toEqual([]);
  });
  test("a named check of a mixin used by a create of each includer: one warning for one name, one per includer otherwise", () => {
    const create = (name: string) => `    create :${name}\n      input\n        &amount\n      validate\n        check &positive\n`;
    const notApplied = (result: BuildResult) => found(result).filter((d) => d[0] === "MESH_VALIDATE_NOT_APPLIED").map((d) => d[2]!.split(", `&amount`")[0]);
    expect(notApplied(two(CHECKS, create("open"), create("open")))).toEqual(["in create :open, which uses this check"]);
    expect(notApplied(two(CHECKS, create("open"), create("draft")))).toEqual([
      "in billing.Invoice, which uses this mixin, in create :open, which uses this check",
      "in billing.Quote, which uses this mixin, in create :draft, which uses this check",
    ]);
  });
  test("`MESH_VALIDATE_NOT_APPLIED` from a mixin create's check in two includers: one warning, unprefixed", () => {
    const result = two('mixin :Audited\n  actions\n    create :open\n      input\n        &amount\n      validate\n        check :positive that=() => &amount > 0 code="p" message="p"\n');
    const warnings = found(result).filter((d) => d[0] === "MESH_VALIDATE_NOT_APPLIED");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.slice(0, 2)).toEqual(["MESH_VALIDATE_NOT_APPLIED", "shared/audited.mesh.mx:7:35"]);
    expect(warnings[0]![2]).toStartWith("on a create, ");
  });
  test("a mistake in a mixin's check that two includers both have, through different referrers, is one warning, unprefixed", () => {
    // Invoice lists the check from two updates and Quote from one: each entity's referrers are kept apart, so the two
    // includers agree, and the one report names neither.
    const uses = (name: string) => `    update :${name}\n      validate\n        check &positive\n`;
    const invoiceString = build({
      "shared/audited.mesh.mx": 'mixin :Audited\n  checks\n    check :positive that=() => &amount * 2 > 0 code="p" message="p"\n',
      "billing/invoice.mesh.mx": `${IMPORT}entity :Invoice\n  use mixin=Audited\n  attributes\n    uuid :id primary-key\n    string :amount\n  actions auto=[:read]\n${uses("pay")}${uses("refund")}`,
      "billing/quote.mesh.mx": `${IMPORT}entity :Quote\n  use mixin=Audited\n  attributes\n    uuid :id primary-key\n    string :amount\n  actions auto=[:read]\n${uses("settle")}`,
    });
    expect(found(invoiceString).filter((d) => d[0] === "MESH_EXPR_PLAIN").map((d) => [...d.slice(0, 2), d[2]!.split(" runs as")[0]])).toEqual([
      ["MESH_EXPR_PLAIN", "shared/audited.mesh.mx:3:31", "this expression"],
    ]);
  });
});

describe("a mixin's actions, policies and computed fields cover the includer (R13, R17, R18)", () => {
  const SHARED = [
    "mixin :Shared",
    "  computed",
    "    count :n of=&items",
    "  actions auto=[:read]",
    "    always actions=[&publish]",
    "      do",
    "        set",
    "          &published=true",
    "  policies",
    "    policy :anyone authorize-if=() => true",
    "",
  ].join("\n");
  const ITEM = 'import { Post } from "./post.mesh.mx"\nimport { Page } from "./page.mesh.mx"\nentity :Item\n  attributes\n    uuid :id primary-key\n  relationships\n    belongs-to :post entity=Post nullable\n    belongs-to :page entity=Page nullable\n  actions auto=[:read]\n  policies\n    policy :anyone authorize-if=() => true\n';
  const owner = (name: string, extra = "", onLoad = "") => `import { Shared } from "../shared/shared.mesh.mx"\nimport { Item } from "./item.mesh.mx"\nentity :${name}\n  use mixin=Shared\n  attributes\n    uuid :id primary-key\n    boolean :published default=false\n  relationships\n    has-many :items entity=Item\n  actions${onLoad}\n${extra}`;
  const project = (post: string, page: string) => build({ "shared/shared.mesh.mx": SHARED, "blog/item.mesh.mx": ITEM, "blog/post.mesh.mx": post, "blog/page.mesh.mx": page });
  test("the policy covers the includer's actions, the count reads its `&items`, the block covers its `publish`, `on:load` names the mixin's read", () => {
    const result = project(owner("Post", "    update :publish\n", " on:load=&read"), owner("Page", "    update :publish\n"));
    expect(errors(result)).toEqual([]);
    const post = entityOf(result, "Post");
    expect(post.policies.map((policy) => [policy.name, policy.position.file])).toEqual([["anyone", "shared/shared.mesh.mx"]]);
    expect(post.computed.map((field) => [field.name, field.rollup?.of])).toEqual([["n", "items"]]);
    expect(post.auto).toEqual(["read"]);
    expect(post.always[0]!.actions!.map((ref) => ref.name)).toEqual(["publish"]);
    expect(post.onLoad?.name).toBe("read");
  });
  test("an includer without the action an `always` block names is told, by name", () => {
    const result = project(owner("Post", "    update :publish\n"), owner("Page"));
    expect(errors(result)).toEqual([["MESH_UNKNOWN_ACTION", "shared/shared.mesh.mx:5:20", "in blog.Page, which uses this mixin, &publish is not an action of blog.Page: `actions=` names the entity's own actions (&read)."]]);
  });
  test("`on:load` and `max-limit` on a mixin's `actions` are the includer's to choose", () => {
    const result = build({ "shared/audited.mesh.mx": "mixin :Audited\n  actions auto=[:read] on:load=&read max-limit=10\n", "billing/invoice.mesh.mx": invoice() });
    expect(errors(result)).toEqual([
      ["MESH_DUPLICATE_MEMBER", "billing/invoice.mesh.mx:3:2", "Duplicate member :read: the mixin Audited generates it with auto=, and Invoice generates or declares it too"],
      ["MESH_UNKNOWN_OPTION", "shared/audited.mesh.mx:2:23", "`on:load` is not an option of a mixin's `actions`: the entity that uses the mixin chooses the read that loads it"],
      ["MESH_UNKNOWN_OPTION", "shared/audited.mesh.mx:2:37", "`max-limit` is not an option of a mixin's `actions`: the entity that uses the mixin caps its own reads"],
    ]);
    expect(build({ "shared/audited.mesh.mx": "mixin :Audited\n  actions auto=[:update]\n", "billing/invoice.mesh.mx": invoice() }).diagnostics).toEqual([]);
  });
  test("a primary key declared only in a mixin builds; one on both sides is a duplicate and two keys", () => {
    const keyed = build({ "shared/keyed.mesh.mx": "mixin :Keyed\n  attributes\n    uuid :id primary-key\n", "billing/invoice.mesh.mx": 'import { Keyed } from "../shared/keyed.mesh.mx"\nentity :Invoice\n  use mixin=Keyed\n  attributes\n    decimal :amount\n' });
    expect(found(keyed)).toEqual([]);
    expect(entityOf(keyed, "Invoice").attributes.map((a) => a.name)).toEqual(["amount", "id"]);
    const twice = build({ "shared/keyed.mesh.mx": "mixin :Keyed\n  attributes\n    uuid :id primary-key\n", "billing/invoice.mesh.mx": 'import { Keyed } from "../shared/keyed.mesh.mx"\nentity :Invoice\n  use mixin=Keyed\n  attributes\n    uuid :id primary-key\n' });
    expect(errors(twice).map((d) => d.slice(0, 2))).toEqual([["MESH_PRIMARY_KEY", "billing/invoice.mesh.mx:2:0"], ["MESH_DUPLICATE_MEMBER", "billing/invoice.mesh.mx:3:2"]]);
  });
  test("a referrer reached through a mixin's `always` block is cited by the block's file", () => {
    const result = build({
      "shared/audited.mesh.mx": "mixin :Audited\n  actions\n    always types=[:update]\n      validate\n        check &positive\n",
      "billing/invoice.mesh.mx": invoice('  checks\n    check :positive that=({ input }) => input.amount !== null code="p" message="p"\n    update :pay\n      input\n        &amount\n    update :touch\n')
        .replace("  actions auto=[:read]\n", "").replace("    update :pay\n", "  actions auto=[:read]\n    update :pay\n"),
    });
    expect(errors(result)).toEqual([["MESH_CHECK_INPUT", "billing/invoice.mesh.mx:8:40",
      "`input.amount` is read by a check that update :touch uses through the `always` block at shared/audited.mesh.mx:3, and update :touch takes no `amount`"]]);
  });
  test("a named check reached through a mixin's `always` block and the includer's own `validate` (D25(1)) cites the block's file", () => {
    const result = build({
      "shared/audited.mesh.mx": 'mixin :Audited\n  checks\n    check :positive that=() => &amount > 0 code="p" message="p"\n  actions\n    always types=[:update]\n      validate\n        check &positive\n',
      "billing/invoice.mesh.mx": invoice("    update :pay\n      validate\n        check &positive\n"),
    });
    expect(errors(result)).toEqual([["MESH_DUPLICATE_MEMBER", "billing/invoice.mesh.mx:10:14",
      "Duplicate check &positive: update :pay already runs it through the `always` block at shared/audited.mesh.mx:5, and a check runs once"]]);
  });
});

describe("a name the mixin shares (R14, R15, R25, R26; ruling D37 OD6: at the `use` line)", () => {
  const OWNED = "mixin :Owned\n  attributes\n    uuid :createdBy\n";
  const report = (result: BuildResult) => result.diagnostics.map((d) => [d.code, `${d.position.file}:${d.position.line}:${d.position.column}`, d.message, d.fix]);
  test("with the entity's own member, a check on either side included", () => {
    const own = build({ ...AUDITED_PROJECT, "billing/invoice.mesh.mx": invoice().replace("    decimal :amount min=0\n", "    decimal :amount min=0\n    uuid :createdBy\n") });
    expect(report(own)).toEqual([["MESH_DUPLICATE_MEMBER", "billing/invoice.mesh.mx:3:2", "Duplicate member :createdBy: the mixin Audited declares it, and so does Invoice", "remove or rename the entity's own :createdBy, or stop using Audited"]]);
    const mixinCheck = build({ "shared/audited.mesh.mx": 'mixin :Audited\n  checks\n    check :amount that=() => true code="a" message="a"\n', "billing/invoice.mesh.mx": invoice() });
    expect(report(mixinCheck).filter((d) => d[0] === "MESH_DUPLICATE_MEMBER")).toEqual([["MESH_DUPLICATE_MEMBER", "billing/invoice.mesh.mx:3:2", "Duplicate member :amount: the mixin Audited declares it, and so does Invoice", "remove or rename the entity's own :amount, or stop using Audited"]]);
    const ownCheck = build({ ...AUDITED_PROJECT, "billing/invoice.mesh.mx": invoice('  checks\n    check :createdBy that=() => true code="a" message="a"\n    update :x\n'.replace("    update :x\n", "")) });
    expect(report(ownCheck).filter((d) => d[0] === "MESH_DUPLICATE_MEMBER")).toEqual([["MESH_DUPLICATE_MEMBER", "billing/invoice.mesh.mx:3:2", "Duplicate member :createdBy: the mixin Audited declares it, and so does Invoice", "remove or rename the entity's own :createdBy, or stop using Audited"]]);
  });
  test("a mixin policy and an entity policy of one name: at the `use` line", () => {
    const result = build({ "shared/audited.mesh.mx": "mixin :Audited\n  policies\n    policy :anyone authorize-if=() => true\n",
      "billing/invoice.mesh.mx": invoice("  policies\n    policy :anyone authorize-if=() => true\n") });
    expect(report(result)).toEqual([["MESH_DUPLICATE_MEMBER", "billing/invoice.mesh.mx:3:2", "Duplicate member :anyone: the mixin Audited declares it, and so does Invoice", "remove or rename the entity's own :anyone, or stop using Audited"]]);
  });
  test("with another mixin: at the later `use` line", () => {
    const result = build({ ...AUDITED_PROJECT, "shared/owned.mesh.mx": OWNED,
      "billing/invoice.mesh.mx": invoice("", "  use mixin=Audited\n  use mixin=Owned\n", `${IMPORT}import { Owned } from "../shared/owned.mesh.mx"\n`) });
    expect(report(result)).toEqual([["MESH_DUPLICATE_MEMBER", "billing/invoice.mesh.mx:5:2", "Duplicate member :createdBy: the mixins Audited and Owned both declare it", "rename it in one of the mixins, or use only one of them"]]);
  });
  test("the same mixin twice is one error at the second line, by one name, two aliases, or a name and a namespace", () => {
    const twice = (imports: string, uses: string) => report(build({ ...AUDITED_PROJECT, "billing/invoice.mesh.mx": invoice("", uses, imports) }));
    const once = [["MESH_DUPLICATE_MEMBER", "billing/invoice.mesh.mx:4:2", "Duplicate use of the mixin Audited: this entity already uses it", "remove this line"]];
    expect(twice(IMPORT, "  use mixin=Audited\n  use mixin=Audited\n")).toEqual([["MESH_DUPLICATE_MEMBER", "billing/invoice.mesh.mx:4:2", "Duplicate use of the mixin Audited: this entity already uses it", "remove this line"]]);
    expect(twice('import { Audited as A, Audited as B } from "../shared/audited.mesh.mx"\n', "  use mixin=A\n  use mixin=B\n")).toEqual(once);
    expect(twice(`${IMPORT}import * as shared from "../shared/audited.mesh.mx"\n`, "  use mixin=Audited\n  use mixin=shared.Audited\n").map((d) => d.slice(0, 2))).toEqual([["MESH_DUPLICATE_MEMBER", "billing/invoice.mesh.mx:5:2"]]);
  });
  test("an `auto=` type both lists give is one error, R26's; different types are legal", () => {
    const both = build({ "shared/audited.mesh.mx": "mixin :Audited\n  actions auto=[:read]\n", "billing/invoice.mesh.mx": invoice() });
    expect(report(both)).toEqual([["MESH_DUPLICATE_MEMBER", "billing/invoice.mesh.mx:3:2", "Duplicate member :read: the mixin Audited generates it with auto=, and Invoice generates or declares it too", "remove :read from one of the two `auto=` lists"]]);
    const declared = build({ "shared/audited.mesh.mx": "mixin :Audited\n  actions auto=[:update]\n", "billing/invoice.mesh.mx": invoice("    update :update\n") });
    expect(report(declared)).toEqual([["MESH_DUPLICATE_MEMBER", "billing/invoice.mesh.mx:3:2", "Duplicate member :update: the mixin Audited generates it with auto=, and Invoice generates or declares it too", "rename the entity's own :update, or stop using Audited"]]);
    const generated = build({ "shared/audited.mesh.mx": "mixin :Audited\n  actions\n    read :read\n", "billing/invoice.mesh.mx": invoice() });
    expect(report(generated)).toEqual([["MESH_DUPLICATE_MEMBER", "billing/invoice.mesh.mx:3:2", "Duplicate member :read: the mixin Audited declares it, and Invoice generates it with auto=", "remove :read from the entity's `auto=` list, or stop using Audited"]]);
  });
  test("two members of one name inside one mixin are reported in its file, once for every includer (R25)", () => {
    const result = build({ "shared/audited.mesh.mx": "mixin :Audited\n  attributes\n    uuid :x\n    uuid :x\n", "billing/invoice.mesh.mx": invoice(),
      "billing/quote.mesh.mx": invoice().replace("entity :Invoice", "entity :Quote") });
    expect(report(result)).toEqual([["MESH_DUPLICATE_MEMBER", "shared/audited.mesh.mx:4:4", "Duplicate member :x", null]]);
  });
  test("a mixin's belongs-to key column clashing with the entity's member: at the `use` line", () => {
    const result = build({ "shared/audited.mesh.mx": "mixin :Audited\n  relationships\n    belongs-to :owner entity=Invoice\n", "billing/invoice.mesh.mx": invoice().replace("    decimal :amount min=0\n", "    uuid :ownerId\n") });
    expect(report(result).filter((d) => d[2] !== "Invoice is not an imported entity.")).toEqual([["MESH_DUPLICATE_MEMBER", "billing/invoice.mesh.mx:3:2", "Generated key column ownerId conflicts with a declared member", null]]);
  });
  test("legal neighbour: two entities that use one mixin each have its names", () => {
    expect(found(build({ ...AUDITED_PROJECT, "billing/quote.mesh.mx": invoice().replace("entity :Invoice", "entity :Quote") }))).toEqual([]);
  });
});

describe("imports of a mixin (R9, R11, R12, R21, R22)", () => {
  test("a name no import binds to a mixin is `MESH_UNKNOWN_IMPORT` at the name, with the nearest imported mixin", () => {
    expect(errors(build({ ...AUDITED_PROJECT, "billing/invoice.mesh.mx": invoice("", "  use mixin=Audit\n") }))).toEqual([["MESH_UNKNOWN_IMPORT", "billing/invoice.mesh.mx:3:12", "Audit is not an imported mixin. Did you mean Audited?"]]);
    const entity = build({ ...AUDITED_PROJECT, "billing/customer.mesh.mx": "entity :Customer\n  attributes\n    uuid :id primary-key\n",
      "billing/invoice.mesh.mx": invoice("", "  use mixin=Customer\n", `${IMPORT}import { Customer } from "./customer.mesh.mx"\n`) });
    expect(errors(entity)).toEqual([["MESH_UNKNOWN_IMPORT", "billing/invoice.mesh.mx:4:12", "Customer is not an imported mixin."]]);
    // A refused import is reported once, at the import (a package path no file answers).
    const refused = build({ "billing/invoice.mesh.mx": invoice("", "  use mixin=Timestamps\n", 'import { Timestamps } from "mixins"\n') });
    expect(errors(refused).map((d) => d.slice(0, 2))).toEqual([["MESH_UNKNOWN_IMPORT", "billing/invoice.mesh.mx:1:0"]]);
    expect(errors(build({ ...AUDITED_PROJECT, "billing/invoice.mesh.mx": invoice("", "  use mixin=Invoice\n") }))).toEqual([["MESH_UNKNOWN_IMPORT", "billing/invoice.mesh.mx:3:12", "Invoice is not an imported mixin: the file declares Invoice as an entity."]]);
  });
  test("a namespace alias alone names the file, not its mixin", () => {
    const result = build({ ...AUDITED_PROJECT, "billing/invoice.mesh.mx": invoice("", "  use mixin=shared\n", 'import * as shared from "../shared/audited.mesh.mx"\n') });
    expect(result.diagnostics.map((d) => [d.code, d.message, d.fix])).toEqual([["MESH_UNKNOWN_IMPORT", "shared is a namespace import of ../shared/audited.mesh.mx, not a mixin: name the mixin it declares, `shared.Audited`", "write `shared.Audited`"]]);
  });
  test("a named import must bind the name the mixin file declares (R11)", () => {
    const result = build({ ...AUDITED_PROJECT, "billing/invoice.mesh.mx": invoice("", "  use mixin=Audit\n", 'import { Audit } from "../shared/audited.mesh.mx"\n') });
    expect(errors(result)).toEqual([["MESH_UNKNOWN_IMPORT", "billing/invoice.mesh.mx:1:9", "`Audit` is not what ../shared/audited.mesh.mx declares; it declares `Audited`"]]);
  });
  test("a mixin file takes no import (R12), and its one root is a mixin", () => {
    const imports = build({ ...AUDITED_PROJECT, "shared/audited.mesh.mx": `import { Mesh } from "meshfw"\n${AUDITED}` });
    expect(found(imports)).toEqual([["MESH_UNKNOWN_IMPORT", "shared/audited.mesh.mx:1:0", "A mixin file takes no import: its lines are read in each entity that uses it, and what they name must be the entity's own members"]]);
    const two = build({ ...AUDITED_PROJECT, "shared/audited.mesh.mx": `${AUDITED}mixin :Other\n  attributes\n    uuid :z\n` });
    expect(found(two)).toEqual([["MESH_DUPLICATE_ENTITY", "shared/audited.mesh.mx:5:0", "A mixin file must contain exactly one mixin"]]);
  });
  test("an import of a mixin and of an entity under one name is the duplicate import; a path no file answers, or a mixin that did not parse, reports only that", () => {
    const duplicate = build({ ...AUDITED_PROJECT, "billing/audited.mesh.mx": "entity :Audited\n  attributes\n    uuid :id primary-key\n",
      "billing/invoice.mesh.mx": invoice("", "  use mixin=Audited\n", `${IMPORT}import { Audited } from "./audited.mesh.mx"\n`) });
    expect(errors(duplicate)).toEqual([["MESH_DUPLICATE_IMPORT", "billing/invoice.mesh.mx:2:9", "Duplicate import identifier Audited"]]);
    expect(errors(build({ "billing/invoice.mesh.mx": invoice() }))).toEqual([["MESH_UNKNOWN_IMPORT", "billing/invoice.mesh.mx:1:0", 'Cannot resolve import "../shared/audited.mesh.mx" inside the project']]);
    const broken = build({ ...AUDITED_PROJECT, "shared/audited.mesh.mx": "mixin :Audited\n  attributes\n    uuid :createdBy nope=1\n" });
    expect(errors(broken).map((d) => d.slice(0, 2))).toEqual([["MESH_UNKNOWN_OPTION", "shared/audited.mesh.mx:3:20"]]);
  });
  test("a mixin no entity uses, or imported and never used, is silent beyond its contracts (R21)", () => {
    expect(found(build({ "shared/audited.mesh.mx": "mixin :Audited\n  attributes\n    uuid :x\n    uuid :x\n  actions\n    update :y\n      validate\n        check &nope\n" }))).toEqual([]);
    expect(found(build({ ...AUDITED_PROJECT, "billing/invoice.mesh.mx": invoice("", "") }))).toEqual([]);
  });
  test("a mixin's name read in a function is a free variable (R22), in the entity and in a mixin", () => {
    const result = build({ ...AUDITED_PROJECT, "billing/invoice.mesh.mx": invoice("  computed\n    string :label() { return String(Audited) }\n") });
    expect(errors(result).map((d) => d.slice(0, 2))).toEqual([["MESH_EXPR_FREE_VARIABLE", "billing/invoice.mesh.mx:9:36"]]);
    // Two includers have the same mistake: one report, naming neither.
    const inside = build({ ...AUDITED_PROJECT, "shared/audited.mesh.mx": "mixin :Audited\n  computed\n    boolean :staff() { return isStaff() }\n",
      "billing/quote.mesh.mx": invoice().replace("entity :Invoice", "entity :Quote") });
    expect(inside.diagnostics.map((d) => [d.code, `${d.position.file}:${d.position.line}:${d.position.column}`, d.message, d.fix])).toEqual([["MESH_EXPR_FREE_VARIABLE", "shared/audited.mesh.mx:3:30",
      "`isStaff` is not defined here: a function in a mixin file may use its parameters, `&members`, the transaction's `%.now` and `%.today` and JavaScript's globals, and a mixin file takes no import",
      "write this function in the entity that uses the mixin, which can import it"]]);
    // `Mesh` in a mixin: the fix does not tell the author to import it, which R12 refuses.
    const mesh = build({ ...AUDITED_PROJECT, "shared/audited.mesh.mx": "mixin :Audited\n  computed\n    integer :len() { const x = Mesh; return 1 }\n" });
    expect(mesh.diagnostics.map((d) => [d.code, d.fix])).toEqual([["MESH_EXPR_FREE_VARIABLE", "a mixin file cannot import `Mesh`: write this function in the entity that uses the mixin, which can"]]);
  });
});

describe("a lock step in a mixin's `always` block (ADR-0100, design 5.6: a line in another file is cited by file)", () => {
  const LOCKED = "mixin :Audited\n  actions\n    always types=[:update]\n      do\n        lock &version\n";
  const lockProject = (body: string) => build({ "shared/audited.mesh.mx": LOCKED,
    "billing/invoice.mesh.mx": invoice(body).replace("    decimal :amount min=0\n", "    integer :version default=1\n") });
  test("a second lock in the includer's update cites the mixin's lines by file", () => {
    expect(errors(lockProject("    update :pay\n      do\n        lock &version\n"))).toEqual([["MESH_LOCK_STEP", "billing/invoice.mesh.mx:10:8",
      "update :pay of billing.Invoice has two `lock` steps (shared/audited.mesh.mx:5 through the `always` block at shared/audited.mesh.mx:3 and line 10): an action compares one version"]]);
  });
  test("a `set` of the locked member in the includer's update cites the mixin's lock by file", () => {
    expect(errors(lockProject("    update :pay\n      do\n        set\n          &version=() => 3\n"))).toEqual([["MESH_LOCK_MEMBER", "billing/invoice.mesh.mx:11:10",
      "`set &version` in update :pay of billing.Invoice writes the version that `lock &version` (shared/audited.mesh.mx:5) owns: the lock adds 1 on every write"]]);
  });
});

describe("a project mixin's `set` of the member an includer's lock owns", () => {
  test("MESH_LOCK_MEMBER in the mixin's file names the mixin, and the fix removes the `set` line", () => {
    const result = build({
      "shared/bumped.mesh.mx": "mixin :Bumped\n  actions\n    always types=[:update]\n      do\n        set\n          &version=() => &version + 1\n",
      "billing/invoice.mesh.mx": invoice("    update :pay\n      do\n        lock &version\n", "  use mixin=Bumped\n", 'import { Bumped } from "../shared/bumped.mesh.mx"\n')
        .replace("    decimal :amount min=0\n", "    integer :version default=1\n"),
    });
    expect(result.diagnostics.map((d) => [d.code, `${d.position.file}:${d.position.line}:${d.position.column}`, d.message, d.fix])).toEqual([["MESH_LOCK_MEMBER", "shared/bumped.mesh.mx:6:10",
      "`set &version` of the mixin Bumped, in update :pay of billing.Invoice, writes the version that `lock &version` (billing/invoice.mesh.mx:10) owns: the lock adds 1 on every write",
      "remove the `set` line"]]);
  });
});

describe("generated code", () => {
  test("a mixin function's comment in the expressions file names the mixin's file", async () => {
    const result = build({ "shared/audited.mesh.mx": "mixin :Audited\n  computed\n    integer :twice() { return &amount * 2 }\n", "billing/invoice.mesh.mx": invoice() });
    expect(errors(result)).toEqual([]);
    const files = await generateFiles({ document: result.document!, config: configOf("/p") });
    const expressions = files.find((file) => file.path.endsWith("invoice.expressions.ts"))!;
    expect(expressions.contents).toContain("(shared/audited.mesh.mx:3:5)");
    expect(expressions.contents).not.toContain("(billing/invoice.mesh.mx:3:5)");
  });
});

describe("a concept line in a mixin (R29, ruling D37 OD12)", () => {
  const disposers: (() => void)[] = [];
  afterAll(() => disposers.forEach((dispose) => dispose()));
  test("resolves against the `concepts` folder nearest the mixin's file, the same for every includer", () => {
    buildDialect();
    const money = (field: string) => `concept :Money\n  ${field}\n`;
    const made = conceptProject({
      "src/domain/shared/concepts/Money.mesh.mx": money("decimal :amount"),
      "src/domain/billing/concepts/Money.mesh.mx": money("string :label"),
      "src/domain/shared/priced.mesh.mx": "mixin :Priced\n  attributes\n    Money :price\n",
      "src/domain/billing/invoice.mesh.mx": 'import { Priced } from "../shared/priced.mesh.mx"\nentity :Invoice\n  use mixin=Priced\n  attributes\n    uuid :id primary-key\n    Money :total\n',
      "src/domain/sales/quote.mesh.mx": 'import { Priced } from "../shared/priced.mesh.mx"\nentity :Quote\n  use mixin=Priced\n  attributes\n    uuid :id primary-key\n',
    });
    disposers.push(made.dispose);
    const result = buildModel(made.project);
    expect(errors(result)).toEqual([]);
    const typeOf = (entity: string, member: string) => entityOf(result, entity).attributes.find((a) => a.name === member)?.concept;
    expect(typeOf("Invoice", "price")).toBe("shared.Money");
    expect(typeOf("Invoice", "total")).toBe("billing.Money");
    expect(typeOf("Quote", "price")).toBe("shared.Money");
  });
  test("a mixin outside the domain root is the existing `MESH_UNKNOWN_ENTITY` at the import, and the `use` line adds nothing", () => {
    const made = conceptProject({
      "src/shared/audited.mesh.mx": AUDITED,
      "src/domain/billing/invoice.mesh.mx": invoice("", "  use mixin=Audited\n", 'import { Audited } from "../../shared/audited.mesh.mx"\n'),
    });
    disposers.push(made.dispose);
    expect(found(buildModel(made.project))).toEqual([["MESH_UNKNOWN_ENTITY", "src/domain/billing/invoice.mesh.mx:1:0", "../../shared/audited.mesh.mx exists but is not under the configured entity directories"]]);
  });
});

import { readFileSync } from "node:fs";
import type {
  Action,
  Attribute,
  AttributeType,
  Check,
  Expression,
  MemberRef,
  ModelDocument,
  Step,
} from "../src/index.ts";
import { positionOf } from "./source.ts";
export const postFile = "src/domain/billing/invoice.mesh.mx";
export const postSource = readFileSync(
  // One authored reference file; the model oracle below remains hand-built.
  new URL("../../compiler/test/fixtures/post.mesh.mx", import.meta.url),
  "utf8",
);
const at = (needle: string, nth = 0) =>
  positionOf(postSource, postFile, needle, nth);
const ref = (name: string, needle = `&${name}`, nth = 0): MemberRef => ({
  name,
  position: at(needle, nth),
});
const expr = (source: string, params: string[] = [], nth = 0): Expression => ({
  source,
  params,
  position: at(source, nth),
});
const field = (
  name: string,
  type: AttributeType,
  extra: Partial<Attribute> = {},
): Attribute => ({
  name,
  type,
  nullable: false,
  primaryKey: false,
  unique: false,
  ...extra,
  position: at(`${type} :${name}`),
});
const check = (
  label: string,
  that: string,
  message: string,
  nth = 0,
): Check => ({
  label,
  that: expr(that, [], nth),
  code: "invalid_state",
  message,
  position: at(`check :${label}`, nth),
});
const action = (
  kind: Action["kind"],
  name: string,
  extra: Partial<Action> = {},
): Action => ({
  kind,
  name,
  input: [],
  validate: [],
  do: [],
  ...extra,
  position: at(`${kind} :${name}`),
});
const assignment = (
  name: string,
  value: Step extends never ? never : boolean | { value: string } | Expression,
  needle: string,
) => ({ member: ref(name, needle), value });
/** Hand-built oracle for the syntax-v4 Invoice reference; never calls the compiler. */
export const postDocument: ModelDocument = {
  entities: [
    {
      name: "Invoice",
      table: "invoices",
      file: postFile,
      module: "billing",
      position: at("entity :Invoice"),
      imports: [
        {
          identifiers: ["Customer"],
          from: "./customer.mesh.mx",
          position: at("import { Customer }"),
        },
        {
          identifiers: ["InvoiceLine"],
          from: "./invoice-line.mesh.mx",
          position: at("import { InvoiceLine }"),
        },
        {
          identifiers: ["Payment"],
          from: "./payment.mesh.mx",
          position: at("import { Payment }"),
        },
        {
          identifiers: ["formatMoney", "isStaff"],
          from: "./invoice.helpers",
          position: at("import { formatMoney"),
        },
      ],
      attributes: [
        field("id", "uuid", { primaryKey: true }),
        field("number", "string", {
          unique: true,
          match: { pattern: "^INV-\\d+$", flags: "" },
        }),
        field("status", "enum", {
          values: ["draft", "sent", "paid", "cancelled"].map((value) => ({
            value,
          })),
          default: { value: "draft" },
        }),
        field("amount", "decimal", { min: 0 }),
        field("issuedOn", "date"),
        field("dueOn", "date"),
        field("paidAt", "datetime", { nullable: true }),
        field("notes", "string", { nullable: true, max: 2000 }),
        field("needsReview", "boolean", { default: false }),
        field("paidById", "uuid", { nullable: true }),
        field("insertedAt", "timestamp", { on: "create" }),
        field("updatedAt", "timestamp", { on: "update" }),
      ],
      relationships: [
        {
          kind: "belongs-to",
          name: "customer",
          entity: { identifier: "Customer", from: "./customer.mesh.mx" },
          nullable: false,
          keyColumn: "customerId",
          position: at("belongs-to"),
        },
        {
          kind: "has-many",
          name: "lines",
          entity: { identifier: "InvoiceLine", from: "./invoice-line.mesh.mx" },
          nullable: false,
          position: at("has-many"),
        },
        {
          kind: "has-one",
          name: "payment",
          entity: { identifier: "Payment", from: "./payment.mesh.mx" },
          nullable: false,
          position: at("has-one"),
        },
      ],
      computed: [
        {
          name: "isOverdue",
          type: "boolean",
          body: expr(
            "() {\n      return &status === :sent && &dueOn < today()\n    }",
          ),
          position: at("boolean :isOverdue"),
        },
        {
          name: "label",
          type: "string",
          body: expr(
            '() {\n      return &number + " · " + formatMoney(&total)\n    }',
          ),
          position: at("string :label"),
        },
        {
          name: "lineCount",
          type: "integer",
          nullable: false,
          rollup: { fn: "count", of: "lines" },
          position: at("count :lineCount"),
        },
        {
          name: "total",
          type: "decimal",
          nullable: true,
          rollup: { fn: "sum", of: "lines.amount" },
          position: at("sum :total"),
        },
      ],
      auto: ["read", "destroy"],
      onLoad: ref("visible"),
      always: [
        {
          types: ["create", "update"],
          validate: [
            {
              label: "dueAfterIssue",
              that: expr("() => &dueOn >= &issuedOn"),
              code: "invalid_dates",
              message: "the due date cannot be before the issue date",
              position: at("check :dueAfterIssue"),
            },
          ],
          do: [],
          position: at("always types"),
        },
      ],
      actions: [
        action("create", "create", {
          input: [
            "number",
            "customer",
            "amount",
            "issuedOn",
            "dueOn",
            "notes",
          // `&issuedOn\n` also ends the always check's `that` line, above the input.
          ].map((name) => ({ kind: "member", ref: ref(name, `&${name}\n`, name === "issuedOn" ? 1 : 0) })),
        }),
        action("update", "send", {
          validate: [
            check(
              "invoiceHasLines",
              "() => &lineCount > 0",
              "an invoice needs at least one line",
            ),
          ],
          do: [
            {
              kind: "set",
              assignments: [
                assignment("status", { value: "sent" }, "&status=:sent"),
              ],
              position: at("set\n"),
            },
          ],
        }),
        action("update", "pay", {
          input: [{ kind: "member", ref: ref("paidAt") }],
          validate: [
            check(
              "invoiceIsSent",
              "() => &status === :sent",
              "only a sent invoice can be paid",
            ),
            check(
              "invoiceHasLines",
              "() => &lineCount > 0",
              "an invoice needs at least one line",
              1,
            ),
          ],
          do: [
            {
              kind: "set",
              assignments: [
                assignment("status", { value: "paid" }, "&status=:paid"),
                assignment(
                  "paidById",
                  expr("({ actor }) => actor.id", ["actor"]),
                  "&paidById=",
                ),
              ],
              position: at("set\n", 1),
            },
            {
              kind: "when",
              condition: expr("() => &amount > 10000"),
              steps: [
                {
                  kind: "set",
                  assignments: [
                    assignment("needsReview", true, "&needsReview=true"),
                  ],
                  position: at("set\n", 2),
                },
              ],
              position: at("when="),
            },
            {
              kind: "load",
              members: [ref("customer", "&customer]", 0)],
              position: at("load=["),
            },
          ],
        }),
        action("update", "applyDiscount", {
          input: [
            {
              kind: "argument",
              name: "percent",
              type: "decimal",
              nullable: false,
              min: 0,
              max: 100,
              position: at("decimal :percent"),
            },
          ],
          do: [
            {
              kind: "set",
              assignments: [
                assignment(
                  "amount",
                  expr("({ input }) => &amount * (1 - input.percent / 100)", [
                    "input",
                  ]),
                  "&amount=",
                ),
              ],
              position: at("set\n", 3),
            },
          ],
        }),
        action("read", "visible", {
          filter: expr("() => &status !== :cancelled"),
        }),
        action("read", "overdue", {
          filter: expr("() => &isOverdue"),
          sort: [{ direction: "asc", member: ref("dueOn", "&dueOn\n", 1) }],
        }),
        action("read", "forCustomer", {
          input: [
            {
              kind: "argument",
              name: "customerId",
              type: "uuid",
              nullable: false,
              position: at("uuid :customerId"),
            },
          ],
          filter: expr("({ input }) => &customer.id === input.customerId", [
            "input",
          ]),
        }),
      ],
      policies: [
        {
          name: "staffOrOwnerReads",
          types: ["read"],
          authorizeIf: [
            expr(
              "({ actor }) => isStaff(actor) || &customer.userId === actor.id",
              ["actor"],
            ),
          ],
          forbidIf: [],
          position: at("policy :staffOrOwnerReads"),
        },
        {
          name: "staffWrites",
          types: ["create", "update", "destroy"],
          authorizeIf: [expr("({ actor }) => isStaff(actor)", ["actor"], 1)],
          forbidIf: [],
          position: at("policy :staffWrites"),
        },
        {
          name: "neverDestroyPaid",
          types: ["destroy"],
          authorizeIf: [],
          forbidIf: [expr("() => &status === :paid")],
          position: at("policy :neverDestroyPaid"),
        },
      ],
    },
  ],
};
export const bareDocument: ModelDocument = { entities: [] };

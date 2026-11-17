import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Entity, ModelDocument } from "@meshfw/model";
import { buildModel } from "../src/front-end/build.ts";

/**
 * A billing project for the SQL lowering tests (M10): every relationship kind a condition can cross. `Invoice` belongs to
 * a `Customer` (which belongs to a nullable `Region` and has one `Profile`), has many `Line`s and many `Tag`s through
 * `InvoiceTag`. Computed fields: translated ones that read across relationships (`isLate`, `bigCustomer`, `late`
 * reading a helper), a plain one (`label`), one that reads it (`shout`), and a rollup (`nLines`). `Node` reaches itself
 * through `parent` (`depth`). `helpers.ts` holds `cutoff`, imported by the invoice file.
 */
export const FILES: Record<string, string> = {
  "billing/helpers.ts": "export const cutoff = (n: number) => n * 2;\nexport const flag = (on: boolean | null) => on === true;\n",
  "billing/region.mesh.mx": `entity :Region
  attributes
    uuid :id primary-key
    string :name
  actions auto=[:read]
  policies
    policy :open
      authorize-if=() => true
`,
  "billing/profile.mesh.mx": `import { Customer } from "./customer.mesh.mx"
entity :Profile
  attributes
    uuid :id primary-key
    boolean :verified
  relationships
    belongs-to :customer entity=Customer
  actions auto=[:read]
  policies
    policy :open
      authorize-if=() => true
`,
  "billing/customer.mesh.mx": `import { Invoice } from "./invoice.mesh.mx"
import { Region } from "./region.mesh.mx"
import { Profile } from "./profile.mesh.mx"
entity :Customer
  attributes
    uuid :id primary-key
    uuid :ownerId
    string :name
    json :meta
  relationships
    belongs-to :region entity=Region nullable
    has-many :invoices entity=Invoice
    has-one :profile entity=Profile
  computed
    boolean :bigCustomer() { return &invoices.length > 2 }
    string :label() { return &name + "!" }
  actions auto=[:read]
  policies
    policy :open
      authorize-if=() => true
`,
  "billing/line.mesh.mx": `import { Invoice } from "./invoice.mesh.mx"
entity :Line
  attributes
    uuid :id primary-key
    integer :qty
  relationships
    belongs-to :invoice entity=Invoice
  actions auto=[:read]
  policies
    policy :open
      authorize-if=() => true
`,
  "billing/tag.mesh.mx": `entity :Tag
  attributes
    uuid :id primary-key
    string :name
  actions auto=[:read]
  policies
    policy :open
      authorize-if=() => true
`,
  "billing/invoice-tag.mesh.mx": `import { Invoice } from "./invoice.mesh.mx"
import { Tag } from "./tag.mesh.mx"
entity :InvoiceTag
  attributes
    uuid :id primary-key
  relationships
    belongs-to :invoice entity=Invoice
    belongs-to :tag entity=Tag
  actions auto=[:read]
  policies
    policy :open
      authorize-if=() => true
`,
  "billing/node.mesh.mx": `entity :Node
  attributes
    uuid :id primary-key
  relationships
    belongs-to :parent entity=Node nullable
  computed
    integer :depth() { return (&parent?.depth ?? -1) + 1 }
  actions auto=[:read]
  policies
    policy :open
      authorize-if=() => true
`,
};

/** The invoice file, with one read `r<i>` per filter given (each takes `customerId`, `n` and `f`), extra actions and computed lines. */
export function invoice(filters: readonly string[], extra = "", computed = ""): string {
  const reads = filters.map((filter, i) => `    read :r${i}
      input
        uuid :customerId
        integer :n
        float :f
      filter=${filter}
`).join("");
  return `import { Customer } from "./customer.mesh.mx"
import { Line } from "./line.mesh.mx"
import { Tag } from "./tag.mesh.mx"
import { InvoiceTag } from "./invoice-tag.mesh.mx"
import { cutoff, flag } from "./helpers"
import { Mesh } from "meshfw"
entity :Invoice
  attributes
    uuid :id primary-key
    integer :total
    float :rate nullable
    boolean :paid default=false
    date :dueOn nullable
    enum :status values=[:draft, :sent] default=:draft
  relationships
    belongs-to :customer entity=Customer
    has-many :lines entity=Line
    has-many :tags entity=Tag through=InvoiceTag
  computed
    boolean :isLate() { return &dueOn < %.today }
    boolean :late() { return &total > cutoff(3) }
    string :shout() { return &customer.label }
    count :nLines of=&lines
${computed}  actions auto=[:read]
${reads}${extra}  policies
    policy :open
      authorize-if=() => true
`;
}

export interface Built {
  document: ModelDocument | null;
  diagnostics: ReturnType<typeof buildModel>["diagnostics"];
  source: string;
  entity: (name: string) => Entity;
}

/** A temporary project directory holding `FILES` (helpers must exist on disk); removed by `close`. */
export async function project(): Promise<{ build: (invoiceSource: string, more?: Record<string, string>) => Built; close: () => Promise<void> }> {
  const root = await mkdtemp(resolve(import.meta.dir, "../.scratch-mesh-sql-"));
  await mkdir(resolve(root, "billing"));
  for (const [file, source] of Object.entries(FILES)) if (file.endsWith(".ts")) await writeFile(resolve(root, file), source);
  return {
    build(invoiceSource, more = {}) {
      const all = { ...FILES, ...more, "billing/invoice.mesh.mx": invoiceSource };
      const files = Object.entries(all).filter(([file]) => !file.endsWith(".ts")).map(([file, source]) => ({ file, source }));
      const built = buildModel({ root, files });
      return { ...built, source: invoiceSource, entity: (name) => built.document!.entities.find((e) => e.name === name)! };
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

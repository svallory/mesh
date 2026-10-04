import contracts from "./contracts.ts";

/** Attributes consumed in M1; a new contract option cannot silently disappear. */
export const IMPLEMENTED = {
  resource: ["value", "table", "domain"],
  attributes: [],
  "uuid-primary-key": ["value"],
  attribute: ["value", "type", "constraints", "allow-nil", "public", "default"],
  "create-timestamp": ["value"],
  "update-timestamp": ["value"],
  actions: ["defaults"],
  create: ["value", "accept"],
  update: ["value", "accept"],
  destroy: ["value", "accept"],
  read: ["value"],
} satisfies Partial<Record<keyof typeof contracts, readonly string[]>>;

/** Removing an entry requires implementing its semantics, not merely accepting it. */
export const NOT_IMPLEMENTED: Partial<Record<keyof typeof contracts, string>> = {
  relationships: "M7", "belongs-to": "M7", "has-many": "M7",
  change: "M4", validate: "M4", filter: "M4", sort: "M3",
  policies: "M8", policy: "M8", "authorize-if": "M8",
  calculations: "M7", calculate: "M7", value: "M7",
  aggregates: "M7", count: "M7",
};

export function unsupportedMilestone(tag: string, attribute?: string): string | null {
  const implemented = (IMPLEMENTED as Record<string, readonly string[]>)[tag];
  if (implemented && (attribute === undefined || implemented.includes(attribute))) return null;
  const milestone = (NOT_IMPLEMENTED as Record<string, string>)[tag];
  if (milestone) return milestone;
  // A contract addition must deliberately declare its implementation milestone.
  throw new Error(`Contract coverage missing for ${tag}${attribute ? `.${attribute}` : ""}; update support.ts`);
}

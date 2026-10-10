import type { CapabilityManifest } from "./capabilities.ts";

/** The data adapter a project selects in `mesh.config.ts`. An adapter's factory may
 * return an object that is also its run-time data layer; the build reads only these fields.
 */
export interface DataAdapter {
  readonly kind: "data-adapter";
  readonly name: string;
  /**
   * Module specifier of the adapter's build half, for example `"@meshfw/data-sqlite/build"`.
   * The compiler resolves it from the project root and imports it at build time only;
   * its default export must be an `AdapterBuild` (a type the compiler declares): the adapter's
   * generators and its commands, such as `db push`. The run-time half never imports it.
   */
  readonly build: string;
  /**
   * What this adapter supports beyond the mandatory set: static data, read without
   * starting the adapter (ADR-0013). Optional until M3b makes the build require it.
   */
  readonly capabilities?: CapabilityManifest;
  readonly options: Readonly<Record<string, unknown>>;
}

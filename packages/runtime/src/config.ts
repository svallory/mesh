import type { DataAdapter } from "./data-adapter.ts";

/** Only the extension's identity is understood before M6. */
export interface ExtensionDescriptor { readonly name: string }

/**
 * What `mesh.config.ts` default-exports. It lives in the runtime, not the compiler,
 * so that a program importing its configuration at run time loads no build code (ADR-0033).
 */
export interface MeshConfig {
  /** Entity folder (recursive entity file discovery), glob or file list. */
  domain: string | string[];
  /** Output folder relative to mesh.config.ts, conventionally .mesh. */
  output: string;
  data: DataAdapter;
  /** Kept opaque beyond identity; extensions are not activated here. */
  extensions?: readonly ExtensionDescriptor[];
}

/** Type the configuration object; returns it unchanged. */
export function defineConfig(config: MeshConfig): MeshConfig { return config; }

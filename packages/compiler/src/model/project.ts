import type { Diagnostic, ModelDocument } from "@meshfw/model";

export interface EntityFile {
  file: string;
  source: string;
}
export interface ProjectDescription {
  root: string;
  /** Defaults to the project root for callers building virtual files. */
  domainRoot?: string;
  files: readonly EntityFile[];
}
export interface BuildResult {
  document: ModelDocument | null;
  diagnostics: Diagnostic[];
}

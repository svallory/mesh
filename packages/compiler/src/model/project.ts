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
  /** The surfaces root and its surface files; absent when the project has no `surfaces` folder. */
  surfaces?: { root: string; files: readonly EntityFile[] };
  /** Entity files the project's `ignore` excluded (project-relative path, matching pattern). */
  ignored?: readonly { file: string; pattern: string }[];
}
export interface BuildResult {
  document: ModelDocument | null;
  diagnostics: Diagnostic[];
}

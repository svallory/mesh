/**
 * Since M8a an action no policy covers is forbidden. These fixtures test the data layer and the action lifecycle, not the
 * policies, so each entity file that declares no `policies` gets one that lets every caller run every action
 * (`policies.test.ts` tests the policies themselves).
 */
export function withOpenPolicy(source: string): string {
  if (!/^entity :/m.test(source) || /^ {2}policies$/m.test(source)) return source;
  return `${source.endsWith("\n") ? source : `${source}\n`}  policies\n    policy :anyCaller\n      authorize-if=() => true\n`;
}

/** `withOpenPolicy` over the files handed to `buildModel`. */
export function openPolicies<T extends { file: string; source: string }>(files: readonly T[]): T[] {
  return files.map((file) => ({ ...file, source: withOpenPolicy(file.source) }));
}

// Compare matching Bun lock package keys, including nested/version-specific keys.
export function sharedLockProblems(imagePackages, rootPackages) {
  const problems = [];
  for (const [name, record] of Object.entries(imagePackages)) {
    const rootRecord = rootPackages[name];
    if (rootRecord && record[0] !== rootRecord[0]) {
      problems.push(`docker/bun.lock resolves ${name} as ${record[0]}, root bun.lock has ${rootRecord[0]}`);
    }
  }
  return problems;
}

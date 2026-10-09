// Bun may move a package between hoisted and nested keys when an unrelated
// workspace adds another version. Compare resolved identities, not those keys.
function versionsByPackage(packages) {
  const versions = new Map();
  for (const [identity] of Object.values(packages)) {
    // The delimiter follows the name, including the scope for @scope/package.
    const delimiter = identity.indexOf('@', 1);
    if (delimiter === -1) throw new Error(`Invalid Bun lock package identity: ${identity}`);
    const name = identity.slice(0, delimiter);
    const version = identity.slice(delimiter + 1);
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(version);
  }
  return versions;
}

// Every Docker version of a shared package must exist somewhere in the root
// lock. Workspace-only and image-only packages do not take part in this check.
export function sharedLockProblems(imagePackages, rootPackages) {
  const problems = [];
  const image = versionsByPackage(imagePackages);
  const root = versionsByPackage(rootPackages);
  for (const name of [...image.keys()].sort()) {
    const rootVersions = root.get(name);
    if (!rootVersions) continue;
    for (const version of [...image.get(name)].sort()) {
      if (!rootVersions.has(version)) {
        const available = [...rootVersions].sort().map((value) => `${name}@${value}`).join(', ');
        problems.push(`docker/bun.lock resolves ${name} as ${name}@${version}, root bun.lock has ${available}`);
      }
    }
  }
  return problems;
}

/** Unique closest name within two edits; ties and distant names give no advice. */
export function nearestName(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let distance = 3;
  let tied = false;
  for (const candidate of new Set(candidates)) {
    let row = Array.from({ length: candidate.length + 1 }, (_, i) => i);
    for (let i = 1; i <= name.length; i++) {
      const next = [i];
      for (let j = 1; j <= candidate.length; j++) {
        next[j] = Math.min(next[j - 1]! + 1, row[j]! + 1, row[j - 1]! + (name[i - 1] === candidate[j - 1] ? 0 : 1));
      }
      row = next;
    }
    const current = row[candidate.length]!;
    if (current < distance) { distance = current; best = candidate; tied = false; }
    else if (current === distance) tied = true;
  }
  return tied ? undefined : best;
}

import { expect, test } from 'bun:test';
import { sharedLockProblems } from '../shared-lock-check.js';

test('shared lock packages reject an unrelated Docker version upgrade', () => {
  expect(sharedLockProblems(
    { 'lucide-static': ['lucide-static@1.52.0'] },
    { 'lucide-static': ['lucide-static@1.51.0'] },
  )).toEqual(['docker/bun.lock resolves lucide-static as lucide-static@1.52.0, root bun.lock has lucide-static@1.51.0']);
});

test('matching shared lock packages allow workspace-only and image-only entries', () => {
  expect(sharedLockProblems(
    { 'lucide-static': ['lucide-static@1.51.0'], 'image-only': ['image-only@1.0.0'] },
    { 'lucide-static': ['lucide-static@1.51.0'], '@mesh/compiler': ['@mesh/compiler@workspace:packages/compiler'] },
  )).toEqual([]);
});

import { expect, test } from 'bun:test';
import { sharedLockProblems } from '../shared-lock-check.js';

test('shared lock packages reject an unrelated Docker version upgrade', () => {
  expect(sharedLockProblems(
    { 'lucide-static': ['lucide-static@1.52.0'] },
    { 'lucide-static': ['lucide-static@1.51.0'] },
  )).toEqual(['docker/bun.lock resolves lucide-static as lucide-static@1.52.0, root bun.lock has lucide-static@1.51.0']);
});

test('hoisted and nested esbuild versions agree when Docker uses a root-resolved version', () => {
  expect(sharedLockProblems(
    { esbuild: ['esbuild@0.28.2'], '@esbuild/linux-x64': ['@esbuild/linux-x64@0.28.2'] },
    {
      esbuild: ['esbuild@0.25.12'],
      '@docmd/core/esbuild': ['esbuild@0.28.2'],
      '@docmd/live/esbuild': ['esbuild@0.28.2'],
      '@esbuild/linux-x64': ['@esbuild/linux-x64@0.25.12'],
      '@docmd/core/esbuild/@esbuild/linux-x64': ['@esbuild/linux-x64@0.28.2'],
    },
  )).toEqual([]);
});

test('all Docker versions must occur in the root set even under different keys', () => {
  expect(sharedLockProblems(
    { 'one/lib': ['lib@1.0.0'], 'two/lib': ['lib@2.0.0'], 'three/lib': ['lib@3.0.0'], 'four/lib': ['lib@3.0.0'] },
    { lib: ['lib@1.0.0'], 'other/lib': ['lib@2.0.0'] },
  )).toEqual(['docker/bun.lock resolves lib as lib@3.0.0, root bun.lock has lib@1.0.0, lib@2.0.0']);
});

test('nested scoped package drift is detected by resolved name, not lock key', () => {
  expect(sharedLockProblems(
    { 'parent/@scope/icons': ['@scope/icons@1.52.0'] },
    { '@scope/icons': ['@scope/icons@1.51.0'] },
  )).toEqual(['docker/bun.lock resolves @scope/icons as @scope/icons@1.52.0, root bun.lock has @scope/icons@1.51.0']);
});

test('malformed package identities fail rather than silently skipping validation', () => {
  expect(() => sharedLockProblems({ broken: ['no-version-delimiter'] }, {})).toThrow('Invalid Bun lock package identity');
});

test('matching shared lock packages allow workspace-only and image-only entries', () => {
  expect(sharedLockProblems(
    { 'lucide-static': ['lucide-static@1.51.0'], 'image-only': ['image-only@1.0.0'] },
    { 'lucide-static': ['lucide-static@1.51.0'], '@meshfw/compiler': ['@meshfw/compiler@workspace:packages/compiler'] },
  )).toEqual([]);
});

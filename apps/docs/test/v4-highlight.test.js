import { expect, test } from 'bun:test';
import { highlightMx, mxParseProblems, withV4InputLines } from '../plugins/mx-highlight.js';

const input = 'entity :Todo\n  actions\n    create :create\n      input\n        string :reason\n        &title\n';
const textOf = (html) => html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

test('MX_V4_INPUT_PENDING_SYNTAX_TABLE bridges void input and bare members only', () => {
  const bridge = withV4InputLines(input);
  expect(bridge).toContain('      inPut\n');
  expect(bridge).toContain('        _title\n');
  expect(bridge.length).toBe(input.length);
  expect(mxParseProblems(input)).toEqual([]);
  const html = highlightMx(input);
  expect(textOf(html)).toBe(input.trimEnd());
  expect(html).toContain('        &amp;title');
  expect(html).not.toContain('_title');
  expect(html).not.toContain('inPut');
  // Existing forms, including imports and assignment lines, need no bridge.
  const other = 'import { List } from "./list.mesh.mx"\nentity :Todo\n  actions\n    update :send\n      do\n        set\n          &status=:sent\n';
  expect(withV4InputLines(other)).toBe(other);
  expect(mxParseProblems(other)).toEqual([]);
});

test('v4 allowance does not hide other grammar failures or broaden to root input', () => {
  expect(withV4InputLines('input\n  &title\n')).toBe('input\n  &title\n');
  expect(withV4InputLines('entity :Todo\n  &title\n')).toBe('entity :Todo\n  &title\n');
  expect(mxParseProblems(input + '  attributes\n    string :title min=\n')).not.toEqual([]);
  expect(mxParseProblems(input + '// misplaced comment\n  policies\n    policy :owner\n')).not.toEqual([]);
});

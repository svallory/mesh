import { expect, test } from 'bun:test';
import { highlightMx, mxHighlighter, memberSpans, themeStyles, mxParseProblems, withV4InputLines } from '../plugins/mx-highlight.js';

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
  expect(html).toContain('        <span class="ts-member">&amp;title</span>');
  expect(html).not.toContain('_title');
  expect(html).not.toContain('inPut');
  // Existing forms, including imports and assignment lines, need no bridge.
  const other = 'import { List } from "./list.mesh.mx"\nentity :Todo\n  actions\n    update :send\n      do\n        set\n          &status=:sent\n';
  expect(withV4InputLines(other)).toBe(other);
  expect(mxParseProblems(other)).toEqual([]);
});

test('members have their own colour in whole fences and figure slices, with unchanged text', () => {
  const source = 'entity :Todo\n  actions\n    create :create\n      input\n        &title\n    read :pending\n      filter=() => &list.ownerId === &title\n      sort\n        asc &insertedAt\n';
  const html = highlightMx(source);
  expect(textOf(html)).toBe(source.trimEnd());
  expect([...html.matchAll(/class="ts-member">([^<]*)/g)].map((m) => textOf(m[1])))
    .toEqual(['&title', '&list', '&title', '&insertedAt']);
  expect(html).not.toContain('class="ts-member">&amp;list.ownerId');
  const from = source.indexOf('      filter');
  const to = source.indexOf('\n', from);
  const slice = mxHighlighter(source)(from, to);
  expect(textOf(slice)).toBe(source.slice(from, to));
  expect(slice).toContain('<span class="ts-member">&amp;list</span>');
  expect(themeStyles).toContain('.mx-hl .ts-member{color:#b42350}');
  expect(themeStyles).toContain(':root[data-theme="dark"] .mx-hl .ts-member{color:#f08ca8}');
});

test('member lexer leaves strings, templates, regexes, comments and infix operators alone', () => {
  const source = [
    'string :note default="a & b and &title"',
    "string :other default='&title'",
    'string :template default=`first',
    '  &title',
    'last`',
    'string :pattern match=/[&/]title\\\\/x/',
    '// &title',
    '/* &title',
    '   &title */',
    'filter=() => a && b || a &b || a & b',
    'filter=() => &title && &list.ownerId',
    'filter=() => &a / &b / &c',
    'filter=() => !&done',
    'return /* &ignored */ &title',
    'asc &insertedAt',
    '&status=:sent',
  ].join('\n');
  expect(memberSpans(source).map(([a, b]) => source.slice(a, b)))
    .toEqual(['&title', '&list', '&a', '&b', '&c', '&done', '&title', '&insertedAt', '&status']);
  const literal = 'entity :Todo\n  attributes\n    string :note default="a & b"\n  actions\n    read :pending\n      filter=() => a && b\n';
  const html = highlightMx(literal);
  expect(html).not.toContain('class="ts-member"');
  expect(textOf(html)).toBe(literal.trimEnd());
});

test('v4 allowance does not hide other grammar failures or broaden to root input', () => {
  expect(withV4InputLines('input\n  &title\n')).toBe('input\n  &title\n');
  expect(withV4InputLines('entity :Todo\n  &title\n')).toBe('entity :Todo\n  &title\n');
  expect(mxParseProblems(input + '  attributes\n    string :title min=\n')).not.toEqual([]);
  expect(mxParseProblems(input + '// misplaced comment\n  policies\n    policy :owner\n')).not.toEqual([]);
});

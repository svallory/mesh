// Home-only annotations of the fixed Todo excerpt, not a language parser.
// All prose and highlighting are built here; the browser only clones the notes.
import { escapeHtml } from '@mxlang/tree-sitter-mx/docmd';
import { mxHighlighter } from './mx-highlight.js';

export const HOME_FAMILIES = {
  kind: 'Every line is `kind :name options`. The first word says what the line declares.',
  declaration: '`:name` is a name. The colon says so: not a string, not a variable, the name itself.',
  'value-atom': '`:value` picks one option from a fixed list that Mesh defines.',
  member: '`&name` points at something declared in this file: an attribute, a relationship, an action.',
  'imported-entity': '`List` is another entity, imported at the top like any TypeScript module.',
  section: 'A section header. Everything indented under it belongs to it.',
  option: "An option on its line. Rules about a field live on that field's line, so one line tells the whole story.",
  string: 'Plain text, in quotes.',
  literal: 'A number or a boolean, exactly as in TypeScript.',
  function: 'Plain TypeScript. Mesh turns it into SQL when it can and runs it otherwise.',
  import: 'A regular TypeScript import. Entity files import each other by path.',
  direction: 'Sort order: `asc` or `desc`, one field per line.',
};

export const HOME_CONTEXTS = {
  entity: 'Declares the entity this file is about: one file, one entity.',
  'entity-name': "The entity's name. It shows up in everything Mesh builds: the `Todo` type, the `createTodo` function.",
  table: 'The database table. Mesh writes its schema and its migrations.',
  attributes: 'What a `Todo` stores: one line per column.',
  uuid: "The attribute's type: `uuid`, which becomes `string` in TypeScript.",
  string: "The attribute's type: `string`, which becomes `string` in TypeScript.",
  boolean: "The attribute's type: `boolean`, which becomes `boolean` in TypeScript.",
  timestamp: "The attribute's type: `timestamp`, which becomes `Date` in TypeScript.",
  id: "The record's id.",
  'primary-key': 'This field identifies the record.',
  'title-name': "The todo's text.",
  min: 'At least one character. An empty title is rejected before your code runs.',
  'done-name': 'Whether the todo is complete.',
  default: 'A new todo starts not done.',
  'insertedAt-name': 'When the record was created.',
  on: 'Filled in when the record is created, never by the caller.',
  'on-create': 'On the `create` action.',
  relationships: 'How a `Todo` connects to other entities.',
  relationship: 'A `Todo` belongs to one `List`. Mesh adds a `listId` column to `todos` for you.',
  'list-name': "The relationship's name. Load it as `todo.list`; refer to it here as `&list`.",
  'entity-option': 'The entity on the other side.',
  'entity-list': 'Imported at the top of the file.',
  'import-list': 'Lives in `list.mesh.mx`, next to this file.',
  actions: 'Everything you can do with a `Todo`. Each action becomes one function.',
  auto: 'Two actions Mesh writes for you: `readTodo` and `destroyTodo`.',
  'auto-read': 'The generated `readTodo`.',
  'auto-destroy': 'The generated `destroyTodo`.',
  create: 'An action that creates one record.',
  'create-name': "The action's name. Call it as `createTodo(input, context)`.",
  input: 'What the caller must send, one line per field. Nothing else gets in.',
  title: 'Takes `title` exactly as declared above: a string, at least one character.',
  // Lead correction: relationships precede actions in the unchanged excerpt.
  list: 'The relationship declared by `belongs-to` above. The caller sends the id of a `List`; Mesh stores it in `listId`.',
  update: 'An action that changes one existing record.',
  'rename-name': "The action's name. Call it as `renameTodo({ id, title }, context)`.",
  read: 'A query with a name.',
  'pending-name': "The action's name. Call it as `pendingTodo(input, context)`; it returns the matching records.",
  filter: 'Which records come back. Mesh turns this into the SQL `WHERE`.',
  done: 'Reads `done` on each record.',
  sort: 'The order of the results.',
  insertedAt: 'Oldest first.',
  policies: 'Who may do what. An action no policy covers is forbidden: Mesh fails closed.',
  policy: 'One rule.',
  'owner-name': "The rule's name. It shows in the breakdown when a call is refused.",
  types: 'The action types this rule applies to.',
  'types-create': 'Actions with type `create`: here, `createTodo`.',
  'types-read': 'Actions with type `read`: here, `readTodo` and `pendingTodo`.',
  'types-update': 'Actions with type `update`: here, `renameTodo`.',
  'types-destroy': 'Actions with type `destroy`: here, `destroyTodo`.',
  authorize: 'Allowed when this returns true. For a read it becomes part of the query, so a caller only ever sees their own lists.',
  actor: 'Whoever is calling. Your app passes it on every call; Mesh never guesses.',
  'list-owner': 'Follows the `list` relationship to its `ownerId`. Mesh writes the join.',
};

// Explicit token/family/context/target tuples keep declarations distinct from
// atoms in values. Array punctuation belongs to the option; function punctuation
// and ordinary body tokens belong to the function (lead-confirmed).
const t = (text, family, context = '', to = '') => ({ text, family, key: context || `family-${family}`, to });
const kind = (text, context = text) => t(text, 'kind', context);
const name = (text, context) => t(text, 'declaration', context);
const option = (text, context) => t(text, 'option', context);
const member = (text, context, to) => t(text, 'member', context, to);
const atom = (text, context = '', to = '') => t(text, 'value-atom', context, to);
const section = (text) => t(text, 'section', text);
const fn = (text, context = '') => t(text, 'function', context);
const array = (entries) => [option('['), ...entries.flatMap((entry, i) => i ? [option(','), entry] : [entry]), option(']')];
const ROW_HINTS = new Map([
  ['import { List } from "./list.mesh.mx"', [t('import', 'import'), t('{', 'import'), t('List', 'imported-entity', 'import-list', 'entity-option'), t('}', 'import'), t('from', 'import'), t('"./list.mesh.mx"', 'string')]],
  ['entity :Todo table="todos"', [kind('entity'), name(':Todo', 'entity-name'), option('table=', 'table'), t('"todos"', 'string')]],
  ['attributes', [section('attributes')]],
  ['uuid :id primary-key', [kind('uuid'), name(':id', 'id'), option('primary-key', 'primary-key')]],
  ['string :title min=1', [kind('string'), name(':title', 'title-name'), option('min=', 'min'), t('1', 'literal')]],
  ['boolean :done default=false', [kind('boolean'), name(':done', 'done-name'), option('default=', 'default'), t('false', 'literal')]],
  ['timestamp :insertedAt on=:create', [kind('timestamp'), name(':insertedAt', 'insertedAt-name'), option('on=', 'on'), atom(':create', 'on-create', 'action-create')]],
  ['relationships', [section('relationships')]],
  ['belongs-to :list entity=List', [kind('belongs-to', 'relationship'), name(':list', 'list-name'), option('entity=', 'entity-option'), t('List', 'imported-entity', 'entity-list', 'import')]],
  ['actions auto=[:read, :destroy]', [section('actions'), option('auto=', 'auto'), ...array([atom(':read', 'auto-read', 'actions'), atom(':destroy', 'auto-destroy', 'actions')])]],
  ['create :create', [kind('create'), name(':create', 'create-name')]],
  ['input', [section('input')]],
  ['&title', [member('&title', 'title', 'attribute-title')]],
  ['&list', [member('&list', 'list', 'relationship')]],
  ['update :rename', [kind('update'), name(':rename', 'rename-name')]],
  ['read :pending', [kind('read'), name(':pending', 'pending-name')]],
  ['filter=() => &done === false', [option('filter=', 'filter'), fn('('), fn(')'), fn('=>'), member('&done', 'done', 'attribute-done'), fn('==='), t('false', 'literal')]],
  ['sort', [section('sort')]],
  ['asc &insertedAt', [t('asc', 'direction'), member('&insertedAt', 'insertedAt', 'attribute-insertedAt')]],
  ['policies', [section('policies')]],
  ['policy :owner types=[:create, :read, :update, :destroy]', [kind('policy'), name(':owner', 'owner-name'), option('types=', 'types'), ...array(['create', 'read', 'update', 'destroy'].map((type) => atom(`:${type}`, `types-${type}`, type === 'create' || type === 'update' ? `action-${type}` : 'actions')))]],
  ['authorize-if=({ actor }) => &list.ownerId === actor.id', [option('authorize-if=', 'authorize'), fn('('), fn('{'), fn('actor', 'actor'), fn('}'), fn(')'), fn('=>'), member('&list', 'list-owner', 'relationship'), fn('.'), fn('ownerId'), fn('==='), fn('actor', 'actor'), fn('.'), fn('id')]],
]);

const LINE_ANCHORS = new Map([
  ['import { List } from "./list.mesh.mx"', 'import'],
  ['string :title min=1', 'attribute-title'],
  ['boolean :done default=false', 'attribute-done'],
  ['timestamp :insertedAt on=:create', 'attribute-insertedAt'],
  ['belongs-to :list entity=List', 'relationship'],
  ['actions auto=[:read, :destroy]', 'actions'],
  ['create :create', 'action-create'],
  ['update :rename', 'action-update'],
]);

export const HOME_HINTS = Object.fromEntries([...ROW_HINTS.values()].flat().map(({ key, family }) =>
  [key, { family, context: HOME_CONTEXTS[key] || '' }]));

export function homeHintTokens(line) {
  const row = ROW_HINTS.get(line.trim());
  if (!row) return [];
  let at = line.length - line.trimStart().length;
  return row.map((token) => {
    const start = line.indexOf(token.text, at);
    if (start < at || line.slice(at, start).trim()) throw new Error(`Home hint token drift: ${line}`);
    at = start + token.text.length;
    return { ...token, start, end: at };
  });
}

const noteId = (key) => `mh-hint-${key}`;
export function renderHintLine(line, offset, render) {
  const tokens = homeHintTokens(line);
  if (!tokens.length) return render(offset, offset + line.length);
  let at = tokens[0].start;
  const anchor = LINE_ANCHORS.get(line.trim());
  let html = render(offset, offset + at) + `<span class="mh-line-content"${anchor ? ` data-hint-anchor="${anchor}"` : ''}>`;
  tokens.forEach((token, i) => {
    html += render(offset + at, offset + token.start);
    // The imported name points back to the complete entity=List option.
    if (token.key === 'entity-option') html += '<span data-hint-anchor="entity-option">';
    html += `<span class="mh-hint" tabindex="${i === 0 ? 0 : -1}" role="button" aria-expanded="false" aria-describedby="${noteId(token.key)}" data-hint="${token.key}" data-family="${token.family}"${token.to ? ` data-hint-to="${token.to}"` : ''}>` +
      render(offset + token.start, offset + token.end) + '</span>';
    if (token.to === 'import') html += '</span>';
    at = token.end;
  });
  return html + render(offset + at, offset + line.length) + '</span>';
}

// A fragment needs its syntactic surroundings to retain the file's colours:
// :name is a declaration, :value an option value, Name an imported binding.
// TypeScript fragments use MX's *same TypeScript injection highlighter*, with
// a type, call or expression wrapper. Only the authored fragment is emitted.
// This is not a new grammar/colour pass and never relaxes parse failures.
const TS_NAMES = new Set(['Todo', 'createTodo', 'renameTodo', 'pendingTodo', 'readTodo', 'destroyTodo', 'listId', 'title', 'list', 'done', 'insertedAt', 'ownerId', 'false']);
export function highlightHintFragment(fragment, typescript = false) {
  let prefix = '', suffix = '';
  if (typescript || TS_NAMES.has(fragment) || fragment.includes('(') || fragment === 'todo.list') {
    if (['string', 'boolean', 'Date', 'Todo'].includes(fragment)) {
      prefix = 'hint value=({ x }: { x: '; suffix = ' }) => x';
    } else if (/Todo$/.test(fragment)) {
      prefix = 'hint value=() => '; suffix = '()';
    } else { prefix = 'hint value=() => '; }
  } else if (fragment === ':name') { prefix = 'kind '; }
  else if (fragment.startsWith(':') || fragment.startsWith('&')) { prefix = 'hint value='; }
  else if (fragment === 'List' || fragment === 'Name') { prefix = 'import { '; suffix = ' } from "./entity.mesh.mx"'; }
  else if (fragment === 'list.mesh.mx') { prefix = 'import { List } from "'; suffix = '"'; }
  else if (fragment === 'todos') { prefix = 'entity :Todo table="'; suffix = '"'; }
  else if (fragment === 'asc' || fragment === 'desc') { suffix = ' &field'; }
  const source = prefix + fragment + suffix;
  return mxHighlighter(source, '<home hint fragment>')(prefix.length, prefix.length + fragment.length);
}

export function renderHintText(text, contextKey = '') {
  let html = '', at = 0, index = 0;
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    html += escapeHtml(text.slice(at, match.index));
    // Attribute wording names MX's kind first, then its generated TS type.
    const ts = ['uuid', 'string', 'boolean', 'timestamp'].includes(contextKey) && index === 1;
    html += `<code class="mx-hl">${highlightHintFragment(match[1], ts)}</code>`;
    at = match.index + match[0].length;
    index++;
  }
  return html + escapeHtml(text.slice(at));
}

export function renderHintNotes() {
  return '<div class="mh-hint-notes" hidden>' + Object.entries(HOME_HINTS).map(([key, { family, context }]) =>
    `<span id="${noteId(key)}"><span class="mh-hint-family">${renderHintText(HOME_FAMILIES[family])}</span>` +
    (context ? `<span class="mh-hint-context">${renderHintText(context, key)}</span>` : '') + '</span>').join('') + '</div>';
}

// Dependency-free delegated events survive docmd SPA navigation. Accessible
// descriptions stay in static HTML outside copy text; one visual panel is cloned.
export function installHomeHints(d, w) {
  if (d.documentElement.dataset.meshHomeHints) return;
  d.documentElement.dataset.meshHomeHints = 'true';
  let open = null, pinned = false, panel = null, timer = 0, raf = 0, pointerAt = -Infinity;
  let overlay = null, outlined = null;
  const target = (node) => node?.closest?.('.mh-file-code .mh-hint');
  const mutations = new w.MutationObserver(() => {
    if (open && (!open.isConnected || !panel?.isConnected)) close();
  });
  const sizes = new w.ResizeObserver(() => again());
  function clearConnector() {
    overlay?.remove(); overlay = null;
    outlined?.classList.remove('mh-hint-destination'); outlined = null;
  }
  function close() {
    w.clearTimeout(timer);
    w.cancelAnimationFrame(raf);
    mutations.disconnect();
    sizes.disconnect();
    if (open) open.setAttribute('aria-expanded', 'false');
    open = null;
    pinned = false;
    if (panel) panel.hidden = true;
    clearConnector();
  }
  function draw() {
    const pre = open.closest('.mh-file-code');
    const destination = pre.querySelector(`[data-hint-anchor="${open.dataset.hintTo}"]`);
    if (!destination) { clearConnector(); return; }
    if (outlined !== destination) {
      outlined?.classList.remove('mh-hint-destination');
      outlined = destination;
      outlined.classList.add('mh-hint-destination');
    }
    // Generated auto actions already sit on their destination line. Keep its
    // outline, but remove any previous path instead of looping back onto it.
    if (destination.closest('.mh-l') === open.closest('.mh-l')) {
      overlay?.remove(); overlay = null; return;
    }
    const host = pre.closest('.grid-item');
    if (!host) return;
    const a = open.getClientRects()[0], b = destination.getBoundingClientRect();
    const clip = pre.getBoundingClientRect(), h = host.getBoundingClientRect();
    // On phones in particular, don't draw toward an invisible/clipped target.
    // The outline stays, so scrolling the declaration into view reveals it.
    const visible = b.top >= Math.max(0, clip.top) && b.bottom <= Math.min(w.innerHeight, clip.bottom) &&
      b.left >= Math.max(0, clip.left) && b.right <= Math.min(d.documentElement.clientWidth, clip.right);
    if (!visible) { overlay?.remove(); overlay = null; return; }
    if (!overlay) {
      overlay = d.createElementNS('http://www.w3.org/2000/svg', 'svg');
      overlay.classList.add('mh-hint-connector');
      // The phone stage enables pointer events on each direct child. This
      // noninteractive overlay must win over that more-specific CSS rule.
      overlay.style.pointerEvents = 'none';
      overlay.setAttribute('aria-hidden', 'true');
      overlay.append(d.createElementNS('http://www.w3.org/2000/svg', 'path'));
      host.append(overlay);
    }
    overlay.setAttribute('width', String(h.width));
    overlay.setAttribute('height', String(h.height));
    // The vertical leg runs in the file's empty left gutter. Horizontal legs
    // run just above glyphs, never straight through intervening source text.
    const sx = (a.left + a.right) / 2 - h.left, sy = a.top - h.top;
    const tx = b.left + Math.min(12, b.width / 2) - h.left, ty = b.top - h.top;
    const gutter = clip.left - h.left + 5;
    overlay.firstChild.setAttribute('d', `M ${sx} ${sy} V ${sy - 4} H ${gutter} V ${ty - 4} H ${tx} V ${ty}`);
  }
  function place() {
    if (!open) return;
    if (!open.isConnected || !panel?.isConnected) { close(); return; }
    const r = open.getBoundingClientRect();
    const width = d.documentElement.clientWidth, height = w.innerHeight;
    if (r.bottom < 0 || r.top > height || r.right < 0 || r.left > width) { close(); return; }
    const box = panel.getBoundingClientRect(), gap = 8;
    let left = r.right + gap, top = r.top;
    if (left + box.width > width - gap) {
      if (r.left - box.width - gap >= gap) left = r.left - box.width - gap;
      else { left = r.left; top = r.bottom + gap; }
    }
    if (top + box.height > height - gap) top = r.top - box.height - gap;
    panel.style.left = Math.max(gap, Math.min(left, width - box.width - gap)) + 'px';
    panel.style.top = Math.max(gap, Math.min(top, height - box.height - gap)) + 'px';
    draw();
  }
  function rove(token) {
    token.closest('.mh-l').querySelectorAll('.mh-hint').forEach((item) => { item.tabIndex = item === token ? 0 : -1; });
  }
  function show(token, pin) {
    const note = d.getElementById(token.getAttribute('aria-describedby'));
    if (!note) return;
    w.clearTimeout(timer);
    mutations.disconnect();
    sizes.disconnect();
    if (open && open !== token) open.setAttribute('aria-expanded', 'false');
    if (!panel?.isConnected) {
      panel = d.createElement('div');
      panel.className = 'mh-hint-panel';
      panel.setAttribute('aria-hidden', 'true');
      d.body.append(panel);
    }
    open = token;
    pinned = pin;
    rove(token);
    token.setAttribute('aria-expanded', 'true');
    panel.replaceChildren(...[...note.childNodes].map((node) => node.cloneNode(true)));
    panel.hidden = false;
    place();
    if (open) {
      mutations.observe(d.documentElement, { childList: true, subtree: true });
      sizes.observe(token.closest('.mh-file-code'));
    }
  }
  function later() {
    w.clearTimeout(timer);
    if (open && !pinned && d.activeElement !== open) timer = w.setTimeout(close, 140);
  }
  d.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    if (panel?.contains(e.target)) { w.clearTimeout(timer); return; }
    const token = target(e.target);
    if (token && !pinned) show(token, false);
  });
  d.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'mouse' || !open) return;
    if (open.contains(e.relatedTarget) || panel?.contains(e.relatedTarget)) return;
    if (open.contains(e.target) || panel?.contains(e.target)) later();
  });
  d.addEventListener('pointerdown', () => { pointerAt = Date.now(); }, true);
  d.addEventListener('focusin', (e) => {
    const token = target(e.target);
    if (token) { rove(token); if (Date.now() - pointerAt > 600) show(token, false); }
  });
  d.addEventListener('focusout', (e) => { if (e.target === open && !pinned) close(); });
  function toggle(token) { if (open === token && pinned) close(); else show(token, true); }
  d.addEventListener('click', (e) => {
    const token = target(e.target);
    if (token) { toggle(token); return; }
    if (!panel?.contains(e.target)) close();
  });
  d.addEventListener('keydown', (e) => {
    pointerAt = -Infinity;
    if (e.key === 'Escape' && open) { e.preventDefault(); close(); return; }
    const token = target(e.target);
    if (!token) return;
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const row = [...token.closest('.mh-l').querySelectorAll('.mh-hint')];
      const i = row.indexOf(token);
      let next = (i + (e.key === 'ArrowRight' ? 1 : -1) + row.length) % row.length;
      if (e.key === 'Home') next = 0;
      if (e.key === 'End') next = row.length - 1;
      rove(row[next]); row[next].focus();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(token); }
  });
  function again() {
    if (!open) return;
    w.cancelAnimationFrame(raf);
    raf = w.requestAnimationFrame(place);
  }
  w.addEventListener('resize', again);
  d.addEventListener('scroll', again, { passive: true, capture: true });
}

// Introduction note surface, with a quiet second layer. Inline code deliberately
// carries mx-hl so the file's shared light/dark palette reaches the body panel.
export const homeHintStyles = `<style>
.mh-hint{cursor:help;border-radius:2px}
.mh-hint:is(:hover,:focus-visible,[aria-expanded=true]){background:color-mix(in srgb,var(--link-color,#068ad5) 14%,transparent);outline:1px solid color-mix(in srgb,var(--link-color,#068ad5) 65%,transparent);outline-offset:1px}
.mh-hint-panel{position:fixed;z-index:100;box-sizing:border-box;width:320px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);overflow:auto;padding:.7rem .95rem .8rem;border:1px solid var(--border-color,#e4e4e7);border-radius:12px;background:var(--bg-color,#fff);color:var(--text-color,#27272a);box-shadow:0 1px 2px rgb(0 0 0/.06),0 14px 36px -10px rgb(0 0 0/.28);font-family:var(--font-family-sans,system-ui,sans-serif);font-size:.875rem;line-height:1.55;overflow-wrap:anywhere}
.mh-hint-panel[hidden]{display:none}
.mh-hint-family,.mh-hint-context{display:block}
.mh-hint-context{margin-top:.5rem;padding-top:.5rem;border-top:1px solid var(--border-color,#e4e4e7);font-size:.94em;color:var(--text-muted,#6b6b75)}
.mh-hint-panel code{font-size:.9em;padding:0;background:none;border:0}
.mh-hint-destination{outline:1px dashed var(--link-color,#068ad5);outline-offset:2px;border-radius:2px}
.mh-hint-connector{position:absolute;top:0;left:0;pointer-events:none;overflow:visible;z-index:2;fill:none;stroke:var(--link-color,#068ad5);stroke-width:1.25;stroke-dasharray:4 3;stroke-linejoin:round}
:root[data-theme=dark] .mh-hint-panel{background:#1a1a1f;border-color:#34343a;box-shadow:0 14px 36px -10px rgb(0 0 0/.75)}
@media print{.mh-hint-panel,.mh-hint-connector{display:none}.mh-hint,.mh-hint-destination{outline:none!important;background:none!important}}
</style>`;
export const homeHintScript = `<script>(${installHomeHints.toString()})(document,window);</script>`;

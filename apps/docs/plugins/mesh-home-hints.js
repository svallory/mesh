// Home-only teaching notes. These are annotations of the fixed Todo excerpt,
// not a parser: source offsets are handed back to the shared MX highlighter.
import { escapeHtml } from '@mxlang/tree-sitter-mx/docmd';

export const HOME_HINTS = {
  import: 'Another entity is imported like any TypeScript module. `List` lives in `list.mesh.mx`, next to this file.',
  entity: 'Declares the entity. `:Todo` is its name: an atom, a name that stands for itself.',
  table: 'Text is a string. The table this entity is stored in.',
  attributes: 'A section. Indentation nests; a line is `kind :name options`.',
  uuid: 'An attribute: its type, its name, its rules. `primary-key` is a flag.',
  string: 'A rule about one field goes on its line. `min=1`: at least one character.',
  boolean: 'A default, written as in TypeScript.',
  timestamp: '`:create` is one of a fixed set, so it is an atom. Set when the record is created.',
  relationships: 'Where this entity connects to others.',
  relationship: "`:list` is the relationship's name; `List` the imported entity. Creates the `listId` column; `&list` in `input` is how the caller sets it.",
  actions: 'What can be done. `auto` asks Mesh to generate these two actions.',
  create: 'An action: its type and its name. Mesh builds the function `createTodo` from it.',
  input: 'Everything this action takes, one line per field.',
  title: '`&name` refers to a member of this entity. Takes `title` as declared above: same type, same rules.',
  list: 'Takes the related `List`: the caller sends its id.',
  update: 'An update action; it changes one existing record.',
  read: 'A read action: a query with a name.',
  filter: 'A function, ordinary TypeScript. Mesh translates it to SQL when it can.',
  sort: 'Order, one field per line.',
  policies: 'Who may call what. An action no policy covers is forbidden.',
  policy: 'A rule for these action types.',
  authorize: 'Allowed when the caller owns the list. `actor` is whoever calls.',
};

// One row can teach several tokens; each token remains independently targetable.
// Matching exact rows makes an edited example fail coverage tests, rather than
// silently explaining new syntax with the old wording. No blank/indent target.
const ROW_HINTS = new Map([
  ['import { List } from "./list.mesh.mx"', 'import'],
  ['entity :Todo table="todos"', 'entity'],
  ['attributes', 'attributes'],
  ['uuid :id primary-key', 'uuid'],
  ['string :title min=1', 'string'],
  ['boolean :done default=false', 'boolean'],
  ['timestamp :insertedAt on=:create', 'timestamp'],
  ['relationships', 'relationships'],
  ['belongs-to :list entity=List', 'relationship'],
  ['actions auto=[:read, :destroy]', 'actions'],
  ['create :create', 'create'],
  ['input', 'input'],
  ['&title', 'title'],
  ['&list', 'list'],
  ['update :rename', 'update'],
  ['read :pending', 'read'],
  ['filter=() => &done === false', 'filter'],
  ['sort', 'sort'],
  ['asc &insertedAt', 'sort'],
  ['policies', 'policies'],
  ['policy :owner types=[:create, :read, :update, :destroy]', 'policy'],
  ['authorize-if=({ actor }) => &list.ownerId === actor.id', 'authorize'],
]);

export function homeHintTokens(line) {
  const key = ROW_HINTS.get(line.trim());
  if (!key) return [];
  return [...line.matchAll(/"(?:\\.|[^"\\])*"|[&:]?[A-Za-z_]\w*(?:-[A-Za-z_]\w*)*|\d+|===|=>|[^\s\w]/g)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    key: key === 'entity' && m.index >= line.indexOf('table=') ? 'table' : key,
  }));
}

const noteId = (key) => `mh-hint-${key}`;
export function renderHintLine(line, offset, render) {
  let html = '', at = 0;
  for (const token of homeHintTokens(line)) {
    html += render(offset + at, offset + token.start);
    html += `<span class="mh-hint" tabindex="0" role="button" aria-expanded="false" aria-describedby="${noteId(token.key)}" data-hint="${token.key}">` +
      render(offset + token.start, offset + token.end) + '</span>';
    at = token.end;
  }
  return html + render(offset + at, offset + line.length);
}

export function renderHintNotes() {
  return '<div class="mh-hint-notes" hidden>' + Object.entries(HOME_HINTS).map(([key, text]) =>
    `<span id="${noteId(key)}">${escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>')}</span>`).join('') + '</div>';
}

// Dependency-free, delegated events also work after docmd SPA navigation. The
// singleton floats under body, outside the code's overflow and sticky stage.
// Descriptions stay in static HTML for assistive technology, outside copy text.
export function installHomeHints(d, w) {
  if (d.documentElement.dataset.meshHomeHints) return;
  d.documentElement.dataset.meshHomeHints = 'true';
  let open = null, pinned = false, panel = null, timer = 0, raf = 0, pointerAt = -Infinity;
  const target = (node) => node?.closest?.('.mh-file-code .mh-hint');
  function close() {
    w.clearTimeout(timer);
    if (open) open.setAttribute('aria-expanded', 'false');
    open = null;
    pinned = false;
    if (panel) panel.hidden = true;
  }
  function place() {
    if (!open) return;
    if (!open.isConnected) { close(); return; }
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
  }
  function show(token, pin) {
    const note = d.getElementById(token.getAttribute('aria-describedby'));
    if (!note) return;
    w.clearTimeout(timer);
    if (open && open !== token) open.setAttribute('aria-expanded', 'false');
    if (!panel) {
      panel = d.createElement('div');
      panel.className = 'mh-hint-panel';
      // The static aria-describedby note is the accessible copy; don't read twice.
      panel.setAttribute('aria-hidden', 'true');
      d.body.appendChild(panel);
    }
    open = token;
    pinned = pin;
    token.setAttribute('aria-expanded', 'true');
    panel.replaceChildren(...[...note.childNodes].map((node) => node.cloneNode(true)));
    panel.hidden = false;
    place();
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
  // Pointer focus happens before click. Let click perform the single toggle;
  // keyboard focus, with no preceding pointerdown, opens immediately.
  d.addEventListener('pointerdown', () => { pointerAt = Date.now(); }, true);
  d.addEventListener('focusin', (e) => {
    const token = target(e.target);
    if (token && Date.now() - pointerAt > 600) show(token, false);
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
    if (token && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(token); }
  });
  function again() {
    w.cancelAnimationFrame(raf);
    raf = w.requestAnimationFrame(place);
  }
  w.addEventListener('resize', again);
  d.addEventListener('scroll', again, { passive: true, capture: true });
  new w.MutationObserver(() => { if (open && !open.isConnected) close(); })
    .observe(d.documentElement, { childList: true, subtree: true });
}

// Same surface tokens, radius, shadow and typography as the Introduction's
// mx-panel, without its numbered gutter. No animation/reduced-motion exception
// is necessary; the box simply appears. Code widths and line text never change.
export const homeHintStyles = `<style>
.mh-hint{cursor:help;border-radius:2px}
.mh-hint:is(:hover,:focus-visible,[aria-expanded=true]){background:color-mix(in srgb,var(--link-color,#068ad5) 14%,transparent);outline:1px solid color-mix(in srgb,var(--link-color,#068ad5) 65%,transparent);outline-offset:1px}
.mh-hint-panel{position:fixed;z-index:100;box-sizing:border-box;width:320px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);overflow:auto;padding:.7rem .95rem .8rem;border:1px solid var(--border-color,#e4e4e7);border-radius:12px;background:var(--bg-color,#fff);color:var(--text-color,#27272a);box-shadow:0 1px 2px rgb(0 0 0/.06),0 14px 36px -10px rgb(0 0 0/.28);font-family:var(--font-family-sans,system-ui,sans-serif);font-size:.875rem;line-height:1.55;overflow-wrap:anywhere}
.mh-hint-panel[hidden]{display:none}
.mh-hint-panel code{font-size:.85em}
:root[data-theme=dark] .mh-hint-panel{background:#1a1a1f;border-color:#34343a;box-shadow:0 14px 36px -10px rgb(0 0 0/.75)}
@media print{.mh-hint-panel{display:none}.mh-hint{outline:none!important;background:none!important}}
</style>`;
export const homeHintScript = `<script>(${installHomeHints.toString()})(document,window);</script>`;

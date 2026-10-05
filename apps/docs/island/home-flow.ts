// The home page's island: it takes the static build diagram over after first
// paint and draws its wires with Svelte Flow, one from each part of the entity
// file to `mesh build`, and one from the build to each box. The boxes, the file
// and the build chip stay the page's own HTML; the island lays invisible nodes
// over them and draws only the edges, so nothing moves when it arrives.
//
// Hovering a box lights its edge and the edges of the parts it comes from (the
// page's CSS already tints those parts' lines). Built by island/build.ts into
// site/assets/home-flow.js; the page loads it with a dynamic import and calls
// `mount` every time docmd swaps the home page in.
import { mount as mountSvelte, unmount } from 'svelte';
import type { Edge, Node } from '@xyflow/svelte';
import baseCss from '@xyflow/svelte/dist/base.css' with { type: 'text' };
import Flow from './Flow.svelte';

// The components' own styles, put into this module by island/build.ts.
declare const __mhComponentCss: string;

const CSS = `${baseCss}
${typeof __mhComponentCss === 'string' ? __mhComponentCss : ''}
.mh-flow-layer .svelte-flow{background:transparent;--xy-background-color:transparent}
.mh-flow-layer .svelte-flow__pane,.mh-flow-layer .svelte-flow__renderer{cursor:default}
.mh-flow-layer .svelte-flow__handle{opacity:0;width:1px;height:1px;min-width:0;min-height:0;border:0}
.mh-flow-layer .mh-ghost{visibility:hidden}
.mh-flow-layer .svelte-flow__edge-path{stroke:var(--mh-wire);stroke-width:1.5;transition:stroke .15s ease,stroke-width .15s ease}
.mh-flow-layer .mh-e-via .svelte-flow__edge-path{stroke-dasharray:5 4}
.mh-flow-layer .is-hot .svelte-flow__edge-path{stroke:var(--mh-accent);stroke-width:2.25;stroke-dasharray:6 5;animation:mh-flow 0.6s linear infinite}
@keyframes mh-flow{to{stroke-dashoffset:-11}}
`;

type Rect = { x: number; y: number; w: number; h: number };

function within(el: Element, root: DOMRect): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left - root.left, y: r.top - root.top, w: r.width, h: r.height };
}

function ghost(id: string, r: Rect): Node {
  return { id, type: 'ghost', position: { x: r.x, y: r.y }, data: { w: r.w, h: r.h }, width: r.w, height: r.h, draggable: false, selectable: false };
}

/** Nodes and edges, measured from the page as it is laid out now. */
function measure(root: HTMLElement) {
  const box = root.getBoundingClientRect();
  const file = root.querySelector('.grid-item > .docmd-code-block-wrapper');
  const build = root.querySelector('.mh-build');
  if (!file || !build) return null;
  // One column (a narrow screen): the page's own vertical flow, file, build,
  // then the boxes on a trunk, is the clearest form there, so the island draws
  // nothing and leaves the static wires in place.
  if (getComputedStyle(root).gridTemplateColumns.split(' ').length < 2) return null;
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const f = within(file, box);
  nodes.push(ghost('build', within(build, box)));
  // One wire from each part of the file, leaving the file's right edge level
  // with the part's first line.
  for (const part of root.querySelectorAll<HTMLElement>('.mh-sec[data-section]')) {
    const line = part.querySelector('.mh-l') ?? part;
    const r = within(line, box);
    const id = `sec-${part.dataset.section}`;
    nodes.push(ghost(id, { x: f.x + f.w - 1, y: r.y + r.h / 2, w: 1, h: 1 }));
    edges.push({ id, source: id, sourceHandle: 'right', target: 'build', targetHandle: 'left', class: 'mh-e mh-e-sec' });
  }
  for (const el of root.querySelectorAll<HTMLElement>('.mh-box[data-box]')) {
    const id = `box-${el.dataset.box}`;
    nodes.push(ghost(id, within(el, box)));
    edges.push({ id, source: 'build', sourceHandle: 'right', target: id, targetHandle: 'left', class: `mh-e${el.dataset.via ? ' mh-e-via' : ''}` });
  }
  return { nodes, edges, width: box.width, height: box.height };
}

function light(root: HTMLElement, el: HTMLElement | null) {
  const hot = new Set<string>();
  if (el) {
    hot.add(`box-${el.dataset.box}`);
    for (const part of (el.dataset.from ?? '').split(/\s+/)) if (part) hot.add(`sec-${part}`);
  }
  for (const edge of root.querySelectorAll<SVGGElement>('.mh-flow-layer .svelte-flow__edge')) {
    edge.classList.toggle('is-hot', hot.has(edge.dataset.id ?? ''));
  }
}

const mounted = new WeakSet<HTMLElement>();

export function mount(root: HTMLElement) {
  if (mounted.has(root)) return;
  mounted.add(root);
  if (!document.getElementById('mh-flow-css')) {
    const style = document.createElement('style');
    style.id = 'mh-flow-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const layer = document.createElement('div');
  layer.className = 'mh-flow-layer';
  layer.setAttribute('aria-hidden', 'true');
  root.prepend(layer);
  let app: Record<string, unknown> | null = null;
  let size = '';
  const draw = () => {
    if (!root.isConnected) { observer.disconnect(); return; }
    const m = measure(root);
    if (!m) {
      if (app) { unmount(app); app = null; size = ''; }
      root.classList.remove('is-flow-live');
      return;
    }
    const key = `${Math.round(m.width)}x${Math.round(m.height)}`;
    if (key === size && app) return;
    size = key;
    if (app) unmount(app);
    app = mountSvelte(Flow, { target: layer, props: m });
    requestAnimationFrame(() => root.classList.add('is-flow-live'));
  };
  let timer = 0;
  const observer = new ResizeObserver(() => { clearTimeout(timer); timer = window.setTimeout(draw, 80); });
  observer.observe(root);
  draw();
  root.addEventListener('pointerover', (e) => light(root, (e.target as Element).closest<HTMLElement>('.mh-box')));
  root.addEventListener('pointerleave', () => light(root, null));
}

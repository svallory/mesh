<script lang="ts">
  import { SvelteFlow, type Edge, type Node } from '@xyflow/svelte';
  import Ghost from './Ghost.svelte';

  let { nodes: initialNodes, edges: initialEdges, width, height }:
    { nodes: Node[]; edges: Edge[]; width: number; height: number } = $props();
  // The diagram is fixed: nothing moves, zooms or pans, and the page scrolls
  // through it as if it were an image.
  let nodes = $state.raw(initialNodes);
  let edges = $state.raw(initialEdges);
  const nodeTypes = { ghost: Ghost };
</script>

<div style:width="{width}px" style:height="{height}px">
  <SvelteFlow
    bind:nodes
    bind:edges
    {nodeTypes}
    initialViewport={{ x: 0, y: 0, zoom: 1 }}
    minZoom={1}
    maxZoom={1}
    nodesDraggable={false}
    nodesConnectable={false}
    elementsSelectable={false}
    panOnDrag={false}
    panOnScroll={false}
    zoomOnScroll={false}
    zoomOnPinch={false}
    zoomOnDoubleClick={false}
    preventScrolling={false}
    proOptions={{ hideAttribution: true }}
  />
</div>

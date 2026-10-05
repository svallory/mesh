<script lang="ts">
  // An invisible node laid exactly over a box the page already renders: the
  // island draws only the wires, never a second copy of the boxes.
  import { Handle, Position } from '@xyflow/svelte';
  let { data }: { data: { w: number; h: number } } = $props();
</script>

<div class="mh-ghost" style:width="{data.w}px" style:height="{data.h}px">
  <Handle type="target" position={Position.Left} id="left" isConnectable={false} />
  <Handle type="source" position={Position.Right} id="right" isConnectable={false} />
</div>

import { useMemo } from 'react';
import { Background, Controls, MarkerType, ReactFlow } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import Box from '@mui/material/Box';
import { StageNode } from './StageNode';
import { StepNode } from './StepNode';

const nodeTypes = { step: StepNode, stage: StageNode };

/**
 * A read-only diagram. It follows the app's light or dark setting, fits itself to the box it is in, and does not move
 * when the page is scrolled over it (the mouse wheel stays with the page; the buttons and a drag still pan and zoom).
 */
export function FlowCanvas({
  nodes,
  edges,
  height = 340,
  label,
  testId,
  controls = false,
}: {
  nodes: Node[];
  edges: Edge[];
  height?: number;
  label: string;
  testId?: string;
  /** Zoom buttons, for graphs too big to read at a glance. */
  controls?: boolean;
}) {
  const shown = useMemo(
    () => edges.map((e) => ({ ...e, markerEnd: e.markerEnd ?? { type: MarkerType.ArrowClosed } })),
    [edges],
  );
  return (
    <Box
      role="group"
      aria-label={label}
      data-testid={testId}
      sx={{
        height,
        border: 1,
        borderColor: 'divider',
        borderRadius: 2,
        overflow: 'hidden',
        // Nodes are not selectable or draggable, which switches off pointer events on them; their links and buttons still work.
        '& .react-flow__node a, & .react-flow__node button': { pointerEvents: 'auto' },
      }}
    >
      <ReactFlow
        key={nodes.map((n) => n.id).join('|')}
        nodes={nodes}
        edges={shown}
        nodeTypes={nodeTypes}
        colorMode="system"
        fitView
        fitViewOptions={{ padding: 0.06, maxZoom: 1 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        preventScrolling={false}
      >
        <Background gap={20} />
        {controls && <Controls showInteractive={false} />}
      </ReactFlow>
    </Box>
  );
}

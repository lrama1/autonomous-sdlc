import { useMemo } from 'react';
import type { Edge } from '@xyflow/react';
import { FlowCanvas } from './LazyFlow';
import type { StageNodeType, StageView } from './StageNode';

/** The stages of one initiative in order, with the arrows between them. Rebuilt only when a stage changes. */
export function PipelineFlow({ stages }: { stages: StageView[] }) {
  const key = JSON.stringify(stages);
  const { nodes, edges } = useMemo(() => {
    const list: StageView[] = JSON.parse(key);
    const nodes: StageNodeType[] = list.map((stage, n) => ({
      id: stage.id,
      type: 'stage',
      position: { x: n * 380, y: 0 },
      data: { stage },
    }));
    const edges: Edge[] = list.slice(1).map((stage, n) => ({
      id: `${list[n]!.id}-${stage.id}`,
      source: list[n]!.id,
      target: stage.id,
      animated: stage.status === 'working',
    }));
    return { nodes, edges };
  }, [key]);
  return (
    <FlowCanvas
      nodes={nodes}
      edges={edges}
      height={340}
      label="The stages of this initiative, in order"
      testId="flow"
    />
  );
}

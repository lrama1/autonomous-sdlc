import { useMemo } from 'react';
import type { Edge } from '@xyflow/react';
import type { BuildPlanDto } from '@sdlc/schemas';
import { FlowCanvas } from './LazyFlow';
import { layerLayout } from './layout';
import type { StepNodeType, StepState } from './StepNode';

type Task = BuildPlanDto['tasks'][number];

const STATE: Record<Task['state'], [StepState, string]> = {
  waiting: ['idle', 'Waiting'],
  running: ['working', 'Running'],
  review: ['waiting', 'In review'],
  merged: ['done', 'Merged'],
  failed: ['blocked', 'Failed'],
  skipped: ['idle', 'Skipped'],
  cancelled: ['idle', 'Cancelled'],
};

/** The plan's tasks with an arrow from each task to the ones that wait for it. Colour is the task's state. */
export function PlanGraph({ tasks }: { tasks: Task[] }) {
  const key = JSON.stringify(
    tasks.map((t) => [t.key, t.title, t.state, t.dependsOn, t.prNumber, t.attempt]),
  );
  const { nodes, edges, rows } = useMemo(() => {
    const list: Array<[string, string, Task['state'], string[], number | null, number]> =
      JSON.parse(key);
    const edges: Edge[] = list.flatMap(([id, , , deps]) =>
      deps.map((d) => ({ id: `${d}-${id}`, source: d, target: id })),
    );
    const at = layerLayout(
      list.map((t) => t[0]),
      edges,
      { w: 210, h: 84, gx: 60, gy: 24 },
    );
    const nodes: StepNodeType[] = list.map(([id, title, state, , pr, attempt]) => {
      const [stepState, word] = STATE[state];
      return {
        id,
        type: 'step',
        position: at[id]!,
        data: {
          label: `${id} \u00b7 ${title}`,
          sub: `${word}${pr !== null ? ` \u00b7 PR #${pr}` : ''}${attempt > 1 ? ` \u00b7 attempt ${attempt}` : ''}`,
          kind: 'agent',
          state: stepState,
        },
      };
    });
    const rows = Math.max(1, ...Object.values(at).map((p) => Math.round(p.y / 108) + 1));
    return { nodes, edges, rows };
  }, [key]);
  return (
    <FlowCanvas
      nodes={nodes}
      edges={edges}
      height={Math.min(460, Math.max(150, rows * 110 + 30))}
      controls={tasks.length > 8}
      label="The build plan: each task, and which tasks it waits for"
      testId="plan-graph"
    />
  );
}

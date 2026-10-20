import type { Edge } from '@xyflow/react';
import { FlowCanvas } from './LazyFlow';
import type { StepNodeType } from './StepNode';

const n = (
  id: string,
  x: number,
  y: number,
  label: string,
  sub: string,
  kind: StepNodeType['data']['kind'],
): StepNodeType => ({ id, type: 'step', position: { x, y }, data: { label, sub, kind } });

const NODES: StepNodeType[] = [
  n('goal', 0, 0, 'A goal', 'One line from a person', 'person'),
  n('spec', 270, 0, 'Product agent', 'Drafts the spec', 'agent'),
  n('g1', 540, 0, 'Spec and design review', 'A person approves each', 'person'),
  n('design', 810, 0, 'Architect agent', 'Designs it and plans the tasks', 'agent'),
  n('eng', 0, 150, 'Engineer agents', 'One task each, in parallel', 'agent'),
  n('pr', 270, 150, 'Pull request', 'CI, smoke test, security review', 'check'),
  n('review', 540, 150, 'Review', 'A person approves or sends back', 'person'),
  n('gate', 810, 150, 'Gate', 'Merges when CI passes', 'system'),
  n('release', 1080, 150, 'Release', 'A person approves the release', 'person'),
  n('bug', 270, 300, 'Bug agent', 'Reproduces and fixes a reported bug', 'agent'),
];

const link = (source: string, target: string, extra: Partial<Edge> = {}): Edge => ({
  id: `${source}-${target}`,
  source,
  target,
  ...extra,
});

const EDGES: Edge[] = [
  link('goal', 'spec'),
  link('spec', 'g1'),
  link('g1', 'design'),
  link('design', 'eng', { type: 'smoothstep', sourceHandle: 'bottom', targetHandle: 'top' }),
  link('eng', 'pr'),
  link('pr', 'review'),
  link('review', 'gate', { label: 'approved' }),
  link('review', 'eng', {
    label: 'changes requested',
    type: 'smoothstep',
    sourceHandle: 'bottom',
    targetHandle: 'bottom-in',
    style: { strokeDasharray: '5 4' },
  }),
  link('gate', 'release'),
  link('bug', 'pr', { type: 'smoothstep' }),
];

/** How a goal becomes released software, and where people and agents hand work to each other. The same on every deployment. */
export function AgentFlow() {
  return (
    <FlowCanvas
      nodes={NODES}
      edges={EDGES}
      height={420}
      label="How work moves between people, agents and the platform, from a goal to a release"
      testId="agent-flow"
    />
  );
}

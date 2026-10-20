import { useMemo } from 'react';
import type { Edge } from '@xyflow/react';
import type { SecurityDto, SmokeDto } from '@sdlc/schemas';
import { FlowCanvas } from '../flow/FlowCanvas';
import type { StepNodeType, StepState } from '../flow/StepNode';

interface Props {
  /** Whether the agent's own checks passed before the pull request opened, or null when nobody says. */
  verified: boolean | null;
  smoke: SmokeDto | null;
  security: SecurityDto | null;
}

const smokeState = (s: SmokeDto): [StepState, string] => {
  const r = s.run;
  if (!r) return ['waiting', 'Not run yet'];
  if (r.state === 'passed') return ['done', 'Passed'];
  if (r.state === 'overridden') return ['done', 'Overridden'];
  if (r.state === 'running') return ['working', 'Running'];
  return ['blocked', r.state === 'failed' ? 'Failed' : 'Could not run'];
};

const securityState = (s: SecurityDto): [StepState, string] => {
  const r = s.run;
  if (!r) return ['waiting', 'Not run yet'];
  if (r.state === 'running') return ['working', 'Reading the change'];
  if (r.state === 'error') return ['blocked', 'Could not finish'];
  if (s.blocks) return ['blocked', 'Findings to settle'];
  return ['done', r.findings.length === 0 ? 'No findings' : 'Nothing blocking'];
};

/**
 * What stands between this pull request and a merge, in order. Only the checks this repository has are drawn. The colour
 * of each box is where it stands; the panels below hold the buttons.
 */
export function ReviewFlow({ verified, smoke, security }: Props) {
  const steps: Array<{
    id: string;
    label: string;
    kind: 'agent' | 'check' | 'person' | 'system';
    state: StepState;
    sub: string;
  }> = [];
  steps.push({
    id: 'verify',
    label: 'Agent checks',
    kind: 'agent',
    state: verified === null ? 'idle' : verified ? 'done' : 'blocked',
    sub: verified === null ? '' : verified ? 'Passed' : 'Did not pass',
  });
  if (smoke?.available && smoke.required !== 'none') {
    const [state, sub] = smokeState(smoke);
    steps.push({ id: 'smoke', label: 'Smoke test', kind: 'check', state, sub });
  }
  if (security?.available && security.required) {
    const [state, sub] = securityState(security);
    steps.push({ id: 'security', label: 'Security review', kind: 'check', state, sub });
  }
  const held = Boolean(smoke?.blocks || security?.blocks);
  steps.push({
    id: 'approve',
    label: 'Your decision',
    kind: 'person',
    state: held ? 'idle' : 'waiting',
    sub: held ? 'Held by a check' : 'Waiting for you',
  });
  steps.push({ id: 'ci', label: 'CI', kind: 'check', state: 'idle', sub: 'Checked at approval' });
  steps.push({
    id: 'merge',
    label: 'Merge',
    kind: 'system',
    state: 'idle',
    sub: 'The Gate merges',
  });

  // The diagram keeps what it measured only while it is given the same nodes, so they are rebuilt only when a step changes.
  const key = JSON.stringify(steps);
  const { nodes, edges } = useMemo(() => {
    const list: typeof steps = JSON.parse(key);
    const nodes: StepNodeType[] = list.map((st, n) => ({
      id: st.id,
      type: 'step',
      position: { x: n * 190, y: 0 },
      data: { label: st.label, sub: st.sub, kind: st.kind, state: st.state, compact: true },
    }));
    const edges: Edge[] = list.slice(1).map((st, n) => ({
      id: `${list[n]!.id}-${st.id}`,
      source: list[n]!.id,
      target: st.id,
    }));
    return { nodes, edges };
  }, [key]);
  return (
    <FlowCanvas
      nodes={nodes}
      edges={edges}
      height={120}
      label="What stands between this pull request and a merge"
      testId="review-flow"
    />
  );
}

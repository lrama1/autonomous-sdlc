import { Handle, Position } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { roleLabel } from '../labels';

export interface StageView {
  id: string;
  title: string;
  checkpoint: string;
  status: 'not_started' | 'working' | 'waiting_human' | 'blocked' | 'done';
  waitingOn: string[];
  detail: string;
  items: Array<{ kind: 'run' | 'ask'; id: string; title: string; state: string }>;
}
export type StageNodeType = Node<{ stage: StageView; [key: string]: unknown }, 'stage'>;

const WORDS: Record<StageView['status'], string> = {
  not_started: 'Not started',
  working: 'In progress',
  waiting_human: 'Waiting on a person',
  blocked: 'Blocked',
  done: 'Done',
};
const COLOR = {
  not_started: 'default',
  working: 'info',
  waiting_human: 'warning',
  blocked: 'error',
  done: 'success',
} as const;

/** One stage of an initiative (spec and design, build and review, release) with what it is waiting on. */
export function StageNode({ data }: NodeProps<StageNodeType>) {
  const s = data.stage;
  const p = useTheme().palette;
  const accent =
    s.status === 'done'
      ? p.success.main
      : s.status === 'working'
        ? p.primary.main
        : s.status === 'waiting_human'
          ? p.warning.main
          : s.status === 'blocked'
            ? p.error.main
            : p.divider;
  const hidden = { opacity: 0, pointerEvents: 'none' } as const;
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} style={hidden} />
      <Box
        data-testid={`stage-${s.id}`}
        data-status={s.status}
        sx={{
          width: 300,
          p: 1.5,
          bgcolor: 'background.paper',
          border: 1,
          borderColor: 'divider',
          borderTop: 4,
          borderTopColor: accent,
          borderRadius: 2,
          color: 'text.primary',
        }}
      >
        <Typography variant="caption" color="text.secondary">
          {s.checkpoint}
        </Typography>
        <Typography component="h3" variant="h3" sx={{ mb: 0.75 }}>
          {s.title}
        </Typography>
        <Chip
          label={WORDS[s.status]}
          color={COLOR[s.status]}
          variant={s.status === 'not_started' ? 'outlined' : 'filled'}
        />
        {s.waitingOn.length > 0 && (
          <Typography variant="body2" sx={{ mt: 0.75 }}>
            Waiting on <b>{s.waitingOn.map(roleLabel).join(', ')}</b>
          </Typography>
        )}
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
          {s.detail}
        </Typography>
        <Box
          component="ul"
          sx={{ listStyle: 'none', m: 0, mt: 0.75, p: 0, display: 'grid', gap: 0.5 }}
        >
          {s.items.slice(0, 4).map((i) => (
            <Typography component="li" variant="body2" key={i.id}>
              {i.kind === 'ask' ? (
                <Link href={`#/queue/${i.id}`}>{i.title}</Link>
              ) : (
                <span>
                  {roleLabel(i.title)} run: {i.state}
                </span>
              )}
            </Typography>
          ))}
        </Box>
      </Box>
      <Handle type="source" position={Position.Right} isConnectable={false} style={hidden} />
    </>
  );
}

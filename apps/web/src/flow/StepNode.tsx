import { Handle, Position } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import PersonOutlinedIcon from '@mui/icons-material/PersonOutlined';
import SettingsSuggestIcon from '@mui/icons-material/SettingsSuggest';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';

export type StepKind = 'person' | 'agent' | 'system' | 'check';
export type StepState = 'idle' | 'working' | 'waiting' | 'done' | 'blocked';

export type StepData = {
  label: string;
  sub?: string;
  kind: StepKind;
  state?: StepState;
  /** A link target, such as "#/queue/123". The whole node is the link. */
  href?: string;
  /** Marks where the arrows enter and leave. Both are on by default. */
  noTarget?: boolean;
  noSource?: boolean;
  [key: string]: unknown;
};
export type StepNodeType = Node<StepData, 'step'>;

/** The arrows attach here; nobody drags from them, so they are not drawn. */
const HIDDEN = { opacity: 0, pointerEvents: 'none' } as const;

const ICON = {
  person: PersonOutlinedIcon,
  agent: AutoAwesomeIcon,
  system: SettingsSuggestIcon,
  check: CheckCircleOutlinedIcon,
} as const;

/** One box in a diagram: who or what does it, and where it stands. Colour carries the state, text carries the rest. */
export function StepNode({ data }: NodeProps<StepNodeType>) {
  const theme = useTheme();
  const p = theme.palette;
  const state = data.state ?? 'idle';
  const accent =
    state === 'done'
      ? p.success.main
      : state === 'working'
        ? p.primary.main
        : state === 'waiting'
          ? p.warning.main
          : state === 'blocked'
            ? p.error.main
            : p.divider;
  const Icon = ICON[data.kind];
  const body = (
    <Box
      sx={{
        width: 210,
        px: 1.5,
        py: 1,
        bgcolor: 'background.paper',
        border: 1,
        borderColor: accent,
        borderLeftWidth: 5,
        borderRadius: 2,
        boxShadow: state === 'working' ? `0 0 0 2px ${p.primary.main}33` : 'none',
        color: 'text.primary',
      }}
      data-state={state}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <Icon
          fontSize="small"
          sx={{ color: data.kind === 'person' ? 'warning.main' : 'text.secondary' }}
        />
        <Typography variant="subtitle2" sx={{ lineHeight: 1.25 }}>
          {data.label}
        </Typography>
      </Box>
      {data.sub && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
          {data.sub}
        </Typography>
      )}
    </Box>
  );
  return (
    <>
      {!data.noTarget && (
        <Handle type="target" position={Position.Left} isConnectable={false} style={HIDDEN} />
      )}
      <Handle id="top" type="target" position={Position.Top} isConnectable={false} style={HIDDEN} />
      <Handle
        id="bottom-in"
        type="target"
        position={Position.Bottom}
        isConnectable={false}
        style={{ ...HIDDEN, left: '65%' }}
      />
      {data.href ? (
        <a href={data.href} style={{ color: 'inherit', textDecoration: 'none' }}>
          {body}
        </a>
      ) : (
        body
      )}
      {!data.noSource && (
        <Handle type="source" position={Position.Right} isConnectable={false} style={HIDDEN} />
      )}
      <Handle
        id="bottom"
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        style={{ ...HIDDEN, left: '35%' }}
      />
    </>
  );
}

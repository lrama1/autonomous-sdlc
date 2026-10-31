import { useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { getInitiatives } from './api';
import { roleLabel } from './labels';
import { KIND_GROUPS, describeEvent } from './logFormat';
import type { LogKind } from './logFormat';
import { useLog } from './useLog';
import { PageHeader } from './ui';

const KIND_COLOR: Record<LogKind, string> = {
  message: 'text.primary',
  tool: 'info.main',
  result: 'text.secondary',
  file: 'secondary.main',
  run: 'success.main',
  ask: 'warning.main',
  error: 'error.main',
  other: 'text.secondary',
};

// A colour for each run, from its id, so one agent's lines can be followed among the others.
const RUN_COLORS = [
  '#5aa0ff',
  '#ffb000',
  '#7bd88f',
  '#ff7eb6',
  '#b69bff',
  '#4dd0e1',
  '#ffa07a',
  '#c3d86b',
];
const runColor = (id: string) => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return RUN_COLORS[h % RUN_COLORS.length]!;
};

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** What the agents are doing right now: every step of every run, newest at the bottom, as it happens. */
export function LogPage({ initiativeId }: { initiativeId: string | null }) {
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [shown, setShown] = useState<string[]>(KIND_GROUPS.map((g) => g.id));
  const [search, setSearch] = useState('');
  const [initiatives, setInitiatives] = useState<Array<{ id: string; title: string }>>([]);
  const { events, runs, problem, loaded } = useLog(initiativeId, !paused);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getInitiatives().then(
      (all) => setInitiatives(all.map((i) => ({ id: i.id, title: i.title }))),
      () => {},
    );
  }, []);

  const lines = useMemo(() => {
    const kinds = new Set(KIND_GROUPS.filter((g) => shown.includes(g.id)).flatMap((g) => g.kinds));
    const q = search.trim().toLowerCase();
    return events
      .map((e) => ({ e, line: describeEvent(e) }))
      .filter(({ line }) => kinds.has(line.kind))
      .filter(({ e, line }) => {
        if (!q) return true;
        const run = runs.get(e.runId);
        return `${line.label} ${line.text} ${run?.taskKey ?? ''} ${run?.role ?? ''}`
          .toLowerCase()
          .includes(q);
      });
  }, [events, runs, shown, search]);

  // Following: the newest line stays in view, until the person scrolls up to read.
  useEffect(() => {
    const el = box.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [lines.length, follow]);

  const live = !paused && !problem;
  return (
    <Stack spacing={1.5} data-testid="log-page">
      <PageHeader
        title="Live log"
        subtitle="Every step of every agent, as it happens: what it says, which tools it calls, and which files it changes. Secrets are removed."
        actions={
          <TextField
            select
            size="small"
            label="Initiative"
            value={initiativeId ?? ''}
            onChange={(e) =>
              (window.location.hash = e.target.value ? `#/log/${e.target.value}` : '#/log')
            }
            sx={{ minWidth: 260 }}
            slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
            data-testid="log-initiative"
          >
            <option value="">All initiatives</option>
            {initiatives.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title}
              </option>
            ))}
          </TextField>
        }
      />
      <Stack
        direction="row"
        spacing={1.5}
        sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
      >
        <Chip
          size="small"
          color={live ? 'success' : problem ? 'error' : 'default'}
          label={problem ? 'Cannot reach the platform' : paused ? 'Paused' : 'Live'}
          data-testid="log-live"
          data-live={live}
        />
        <Button
          size="small"
          variant="outlined"
          onClick={() => setPaused((p) => !p)}
          data-testid="log-pause"
        >
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <ToggleButtonGroup
          size="small"
          value={shown}
          onChange={(_e, v: string[]) => setShown(v)}
          aria-label="What to show"
          data-testid="log-kinds"
        >
          {KIND_GROUPS.map((g) => (
            <ToggleButton
              key={g.id}
              value={g.id}
              aria-label={g.label}
              sx={{ textTransform: 'none', px: 1.5, '&:not(.Mui-selected)': { opacity: 0.45 } }}
            >
              {g.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <TextField
          size="small"
          placeholder="Search the log"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          slotProps={{ htmlInput: { 'aria-label': 'Search the log' } }}
          sx={{ minWidth: 220 }}
        />
        <Typography variant="body2" color="text.secondary">
          {lines.length} of {events.length} shown
        </Typography>
      </Stack>
      {problem && (
        <Alert severity="warning">{problem} The log keeps what it has and tries again.</Alert>
      )}
      <Paper
        variant="outlined"
        sx={{
          position: 'relative',
          height: 'calc(100vh - 330px)',
          minHeight: 320,
          overflow: 'hidden',
        }}
      >
        <Box
          ref={box}
          data-testid="log-view"
          onScroll={(e) => {
            const el = e.currentTarget;
            setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
          }}
          sx={{
            height: '100%',
            overflowY: 'auto',
            p: 1.5,
            fontFamily: 'ui-monospace, Consolas, monospace',
            fontSize: 13,
          }}
        >
          {!loaded && <Typography color="text.secondary">Loading.</Typography>}
          {loaded && events.length === 0 && (
            <Typography color="text.secondary" data-testid="log-empty">
              Nothing yet. When an agent runs, its steps appear here.
            </Typography>
          )}
          {lines.map(({ e, line }) => {
            const run = runs.get(e.runId);
            const who = run
              ? `${run.taskKey ? `${run.taskKey} ` : ''}${roleLabel(run.role)}`
              : e.runId.slice(0, 8);
            return (
              <Box
                key={e.id}
                data-testid="log-line"
                data-kind={line.kind}
                data-ok={line.ok}
                sx={{
                  display: 'flex',
                  gap: 1.25,
                  py: 0.25,
                  alignItems: 'baseline',
                  lineHeight: 1.45,
                }}
              >
                <Box component="span" sx={{ color: 'text.disabled', flexShrink: 0 }}>
                  {time(e.ts)}
                </Box>
                <Box
                  component="span"
                  title={
                    run ? `${run.initiativeTitle}: ${roleLabel(run.role)} (${run.state})` : e.runId
                  }
                  sx={{
                    flexShrink: 0,
                    px: 0.75,
                    borderRadius: 1,
                    borderLeft: 3,
                    borderColor: runColor(e.runId),
                    bgcolor: 'action.hover',
                    maxWidth: 190,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {who}
                </Box>
                <Box
                  component="span"
                  sx={{
                    color: line.ok === false ? 'error.main' : KIND_COLOR[line.kind],
                    fontWeight: line.kind === 'tool' ? 700 : 400,
                    minWidth: 0,
                  }}
                >
                  {line.kind !== 'message' && (
                    <Box component="span" sx={{ opacity: 0.85, mr: line.text ? 1 : 0 }}>
                      {line.label}
                    </Box>
                  )}
                  <Box
                    component="span"
                    sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontWeight: 400 }}
                  >
                    {line.text}
                  </Box>
                </Box>
              </Box>
            );
          })}
        </Box>
        {!follow && (
          <Button
            size="small"
            variant="contained"
            onClick={() => setFollow(true)}
            data-testid="log-follow"
            sx={{ position: 'absolute', right: 16, bottom: 12 }}
          >
            Jump to the latest
          </Button>
        )}
      </Paper>
    </Stack>
  );
}

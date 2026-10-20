import { useEffect, useState } from 'react';
import type { SecurityDto } from '@sdlc/schemas';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { dismissFinding, getSecurity, sendFindingsBack, startSecurity } from '../api';
import { CheckPanel } from './shared';

const SECURITY_WORDS: Record<NonNullable<SecurityDto['run']>['state'], string> = {
  running: 'Reading the change',
  done: 'Finished',
  error: 'Could not finish',
};

const SEVERITY_COLOR = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'default',
  info: 'default',
} as const;

/**
 * The security review of the commit under review. A person starts it; the Security agent reads the change; a high or
 * critical finding holds the approval until it is sent back to the engineer or dismissed with a reason.
 */
export function SecurityPanel({
  id,
  onSentBack,
  onData,
}: {
  id: string;
  onSentBack: (note: string) => void;
  onData?: (s: SecurityDto | null) => void;
}) {
  const [s, setS] = useState<SecurityDto | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = await getSecurity(id);
        if (stop) return;
        setS(next);
        onData?.(next);
        if (next.run?.state === 'running') timer = setTimeout(load, 3_000);
      } catch {
        // The other lines already say GitHub could not be asked. Nothing to add here.
      }
    };
    void load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [id, tick, onData]);

  const act = async (what: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await what();
      setDismissing(null);
      setReason('');
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
      setTick((t) => t + 1);
    }
  };

  if (!s || !s.available || !s.required) return null;
  const run = s.run;
  const state = run?.state ?? 'none';
  const findings = run?.findings ?? [];
  const open = findings.filter((f) => !f.dismissed);
  const sendable = open.filter((f) => f.severity !== 'low' && f.severity !== 'info');
  const word = run
    ? `${SECURITY_WORDS[run.state]}${run.state === 'done' ? ` (${findings.length === 0 ? 'no findings' : `${findings.length} finding${findings.length === 1 ? '' : 's'}`})` : ''}`
    : 'Not run on this commit';
  return (
    <CheckPanel
      title="Security review"
      testId="security"
      state={state}
      status={
        <Chip
          data-testid="security-state"
          label={word}
          variant={run ? 'filled' : 'outlined'}
          color={
            run?.state === 'error'
              ? 'error'
              : run?.state === 'done'
                ? open.some((f) => f.severity === 'high' || f.severity === 'critical')
                  ? 'error'
                  : 'success'
                : run
                  ? 'info'
                  : 'default'
          }
        />
      }
    >
      <Stack spacing={1}>
        {run?.state === 'done' && run.summary && (
          <Typography variant="body2" color="text.secondary">
            {run.summary}
          </Typography>
        )}
        {run?.state === 'error' && run.detail && <Alert severity="warning">{run.detail}</Alert>}
        {findings.length > 0 && (
          <Stack spacing={1} data-testid="security-findings">
            {findings.map((f) => (
              <Paper
                key={f.id}
                data-severity={f.severity}
                data-dismissed={Boolean(f.dismissed)}
                sx={{ p: 1.25, opacity: f.dismissed ? 0.7 : 1 }}
              >
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <Chip
                    label={f.severity}
                    color={SEVERITY_COLOR[f.severity]}
                    variant={f.severity === 'low' || f.severity === 'info' ? 'outlined' : 'filled'}
                    sx={{ textTransform: 'uppercase', fontWeight: 700 }}
                  />
                  <Typography variant="subtitle2" component="span">
                    {f.id}: {f.title}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    <code>
                      {f.file}
                      {f.line ? `:${f.line}` : ''}
                    </code>
                  </Typography>
                </Stack>
                <Typography variant="body2" sx={{ mt: 0.75 }}>
                  {f.why}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  Fix: {f.fix}
                </Typography>
                {f.dismissed ? (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ mt: 0.5 }}
                    data-testid="security-dismissed"
                  >
                    Dismissed by {f.dismissed.byName ?? 'a person'}: {f.dismissed.reason}
                  </Typography>
                ) : (
                  dismissing !== f.id && (
                    <Button
                      size="small"
                      sx={{ mt: 0.5 }}
                      disabled={busy}
                      onClick={() => {
                        setDismissing(f.id);
                        setReason('');
                      }}
                    >
                      Dismiss {f.id} with a reason
                    </Button>
                  )
                )}
                {dismissing === f.id && (
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{ mt: 1, alignItems: 'flex-start', flexWrap: 'wrap' }}
                  >
                    <TextField
                      multiline
                      minRows={2}
                      placeholder="Why does this need no fix? (10 characters or more)"
                      slotProps={{ htmlInput: { 'aria-label': `Why ${f.id} is dismissed` } }}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                    <Button
                      size="small"
                      variant="contained"
                      disabled={busy || reason.trim().length < 10}
                      onClick={() => void act(() => dismissFinding(id, f.id, reason.trim()))}
                    >
                      Dismiss
                    </Button>
                    <Button size="small" disabled={busy} onClick={() => setDismissing(null)}>
                      Cancel
                    </Button>
                  </Stack>
                )}
              </Paper>
            ))}
          </Stack>
        )}
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
        >
          <Button
            size="small"
            variant="outlined"
            disabled={busy || run?.state === 'running'}
            onClick={() => void act(() => startSecurity(id))}
          >
            {run ? 'Run the security review again' : 'Run the security review'}
          </Button>
          {sendable.length > 0 && run?.state === 'done' && (
            <Button
              size="small"
              variant="outlined"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await sendFindingsBack(id);
                  onSentBack('Sent the security findings back to the engineer.');
                })
              }
            >
              Send findings back to the engineer
            </Button>
          )}
          {s.blocks && (
            <Box component="span" data-testid="security-blocks">
              <Typography variant="body2" color="text.secondary" component="span">
                {s.blocks}
              </Typography>
            </Box>
          )}
        </Stack>
        {problem && <Alert severity="warning">{problem}</Alert>}
      </Stack>
    </CheckPanel>
  );
}

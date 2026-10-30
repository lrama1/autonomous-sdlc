import { useEffect, useState } from 'react';
import type { SmokeDto } from '@sdlc/schemas';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { diagnoseSmoke, getSmoke, overrideSmoke, sendSmokeBack, startSmoke } from '../api';
import { CheckPanel } from './shared';

const SMOKE_WORDS: Record<NonNullable<SmokeDto['run']>['state'], string> = {
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  error: 'Could not run',
  overridden: 'Overridden',
};

const COLOR = {
  passed: 'success',
  overridden: 'warning',
  failed: 'error',
  error: 'error',
  running: 'info',
  none: 'default',
} as const;

const VERDICT: Record<
  NonNullable<NonNullable<SmokeDto['run']>['diagnosis']>['verdict'],
  { label: string; color: 'error' | 'warning' | 'info' | 'default'; action: string | null }
> = {
  code: {
    label: 'Likely a bug in the code',
    color: 'error',
    action: 'Ask the engineer to fix the code',
  },
  checks: {
    label: 'Likely out-of-date smoke checks',
    color: 'warning',
    action: 'Ask the engineer to update the smoke checks',
  },
  environment: {
    label: 'Likely a problem with the preview, not the code',
    color: 'info',
    action: null,
  },
  unclear: { label: 'Not clear from what the platform can see', color: 'default', action: null },
};

/** An AI's reading of why the smoke test failed, and the one next step it suggests. It advises. A person decides. */
function Diagnosis({
  diagnosis,
  busy,
  sendBackBlocked,
  onExplain,
  onSendBack,
}: {
  diagnosis: NonNullable<SmokeDto['run']>['diagnosis'] | null;
  busy: boolean;
  sendBackBlocked: boolean;
  onExplain: () => void;
  onSendBack: () => void;
}) {
  if (!diagnosis)
    return (
      <Box>
        <Button size="small" variant="outlined" disabled={busy} onClick={onExplain}>
          Explain why it failed
        </Button>
        <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
          An AI reads the failure and says what to do. It costs a few cents.
        </Typography>
      </Box>
    );
  const v = VERDICT[diagnosis.verdict];
  return (
    <Alert
      severity="info"
      variant="outlined"
      icon={false}
      data-testid="smoke-diagnosis"
      data-verdict={diagnosis.verdict}
      sx={{ '& .MuiAlert-message': { width: '100%' } }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 0.5 }}>
        <Typography variant="overline" color="text.secondary">
          AI reading, not verified
        </Typography>
        <Chip size="small" color={v.color} label={v.label} />
      </Stack>
      <Typography variant="body2">{diagnosis.summary}</Typography>
      <Typography variant="body2" sx={{ mt: 0.75 }}>
        <b>Suggested next step:</b> {diagnosis.recommendation}
      </Typography>
      {v.action && (
        <Box sx={{ mt: 1 }}>
          <Button
            size="small"
            variant="contained"
            disabled={busy || sendBackBlocked}
            onClick={onSendBack}
          >
            {v.action}
          </Button>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {diagnosis.verdict === 'checks'
              ? 'The engineer redoes the task and edits .sdlc/preview.yaml. You are asked to allow that protected file before anything is pushed.'
              : 'This is the same as Request changes, with the failed checks and the reading in the message.'}
          </Typography>
        </Box>
      )}
    </Alert>
  );
}

/**
 * The smoke test of the commit under review. The repository lists the checks; a person starts them; the review cannot be
 * approved until they pass or a person overrides them with a reason that stays with the pull request.
 */
export function SmokePanel({
  id,
  onData,
  required = false,
  onSentBack,
  sendBackBlocked = false,
}: {
  id: string;
  onData?: (s: SmokeDto | null) => void;
  /** Approving waits for this test. */
  required?: boolean;
  /** Called after the failure was sent to the engineer as a change request. */
  onSentBack?: (note: string) => void;
  /** This person may not decide this review (their own work), so they cannot send it back either. */
  sendBackBlocked?: boolean;
}) {
  const [s, setS] = useState<SmokeDto | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [overriding, setOverriding] = useState(false);
  const [reason, setReason] = useState('');

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = await getSmoke(id);
        if (stop) return;
        setS(next);
        onData?.(next);
        if (next.run?.state === 'running') timer = setTimeout(load, 2_000);
      } catch {
        // The preview line already says GitHub could not be asked. Nothing to add here.
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
      setOverriding(false);
      setReason('');
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
      setTick((t) => t + 1);
    }
  };

  if (!s || !s.available || s.required === 'none') return null;
  // The repository's checks belong to the other app, so a result would say nothing about this one.
  if (s.required === 'shared')
    return (
      <CheckPanel
        title="No smoke test"
        testId="smoke"
        state="shared"
        status={
          <Typography
            variant="body2"
            color="text.secondary"
            component="span"
            data-testid="smoke-shared"
          >
            This app shares a repository with another app, so the smoke checks would run the other
            app. They are not run, and they do not count toward approving this change.
          </Typography>
        }
      />
    );
  const run = s.run;
  const state = run?.state ?? 'none';
  const done = run?.results.filter((r) => r.ok).length ?? 0;
  const letThrough = state === 'passed' || state === 'overridden';
  return (
    <CheckPanel
      title="Smoke test"
      testId="smoke"
      state={state}
      required={required}
      status={
        <Chip
          data-testid="smoke-state"
          color={COLOR[state]}
          variant={state === 'none' ? 'outlined' : 'filled'}
          label={
            run
              ? `${SMOKE_WORDS[run.state]}${run.results.length > 0 ? ` (${done} of ${run.results.length})` : ''}`
              : 'Not run on this commit'
          }
        />
      }
    >
      <Stack spacing={1}>
        {run?.state === 'overridden' && (
          <Typography variant="body2" color="text.secondary" data-testid="smoke-override">
            {run.by ? `${run.by}: ` : ''}
            {run.detail}
          </Typography>
        )}
        {run?.state === 'error' && run.detail && <Alert severity="warning">{run.detail}</Alert>}
        {s.required === 'invalid' && s.detail && (
          <Alert severity="warning">The smoke checks cannot be read: {s.detail}</Alert>
        )}
        {run && run.results.length > 0 && (
          <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }} data-testid="smoke-results">
            {run.results.map((r, n) => (
              <Box component="li" key={n} data-ok={r.ok} sx={{ py: 0.25, fontSize: 13 }}>
                <Box
                  component="span"
                  sx={{ color: r.ok ? 'success.main' : 'error.main', fontWeight: 700, mr: 0.75 }}
                >
                  {r.ok ? '\u2713' : '\u2717'}
                </Box>
                <code>{r.label}</code>{' '}
                <Typography component="span" variant="caption" color="text.secondary">
                  {r.detail}
                </Typography>
              </Box>
            ))}
          </Box>
        )}
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
        >
          {s.required === 'required' && (
            <Button
              size="small"
              variant={required && (!run || run.state === 'error') ? 'contained' : 'outlined'}
              disabled={busy || run?.state === 'running'}
              onClick={() => void act(() => startSmoke(id))}
            >
              {run ? 'Run the smoke test again' : 'Run the smoke test'}
            </Button>
          )}
          {!letThrough && run?.state !== 'running' && !overriding && (
            <Button
              size="small"
              variant="outlined"
              disabled={busy}
              onClick={() => setOverriding(true)}
            >
              Override with a reason
            </Button>
          )}
          {s.blocks && !letThrough && (
            <Typography variant="body2" color="text.secondary" data-testid="smoke-blocks">
              {s.blocks}
            </Typography>
          )}
        </Stack>
        {run && (run.state === 'failed' || run.state === 'error') && (
          <Diagnosis
            diagnosis={run.diagnosis ?? null}
            busy={busy}
            sendBackBlocked={sendBackBlocked}
            onExplain={() => void act(() => diagnoseSmoke(id))}
            onSendBack={() =>
              void act(async () => {
                await sendSmokeBack(id);
                onSentBack?.('Sent the smoke test failure to the engineer.');
              })
            }
          />
        )}
        {overriding && (
          <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <TextField
              multiline
              minRows={2}
              placeholder="Why can this merge without a passing smoke test? (10 characters or more)"
              slotProps={{ htmlInput: { 'aria-label': 'Why the smoke test is overridden' } }}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <Button
              size="small"
              variant="contained"
              disabled={busy || reason.trim().length < 10}
              onClick={() => void act(() => overrideSmoke(id, reason.trim()))}
            >
              Override
            </Button>
            <Button size="small" disabled={busy} onClick={() => setOverriding(false)}>
              Cancel
            </Button>
          </Stack>
        )}
        {problem && <Alert severity="warning">{problem}</Alert>}
      </Stack>
    </CheckPanel>
  );
}

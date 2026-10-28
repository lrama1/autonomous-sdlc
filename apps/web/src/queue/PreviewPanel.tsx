import { useEffect, useState } from 'react';
import type { PreviewDto } from '@sdlc/schemas';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { getPreview, startPlatformPreview, stopPlatformPreview } from '../api';
import { CheckPanel } from './shared';

const PREVIEW_WORDS: Record<PreviewDto['state'], string> = {
  ready: 'Preview',
  building: 'Preview (building)',
  failed: 'Preview (failed)',
  stale: 'Preview (out of date)',
  none: 'No preview',
  not_permitted: 'No preview',
};

/**
 * The preview of this pull request: what the repository's pipeline published, or one the platform runs in a sandbox
 * when a person asks. The platform runs the pull request's own code only on that click (or in autopilot).
 */
export function PreviewPanel({ id }: { id: string }) {
  const [p, setP] = useState<PreviewDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = await getPreview(id);
        if (stop) return;
        setP(next);
        setFailed(false);
        // Keep looking while a preview may still appear or finish starting. The platform's own is asked for more often.
        if (next.docsOnly) return;
        if (next.platform.state === 'starting') timer = setTimeout(load, 2_000);
        else if (next.state === 'building' || next.state === 'none' || next.state === 'stale')
          timer = setTimeout(load, 20_000);
      } catch {
        if (!stop) setFailed(true);
      }
    };
    void load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [id, tick]);

  const act = async (what: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await what();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
      setTick((t) => t + 1);
    }
  };

  if (failed && !p) {
    return (
      <CheckPanel title="Preview" testId="preview" state="unknown">
        <Typography variant="body2">Could not ask GitHub just now.</Typography>
      </CheckPanel>
    );
  }
  if (!p) return null;
  if (p.docsOnly)
    return (
      <CheckPanel
        title="No preview"
        testId="preview"
        state="none"
        status={
          <Typography variant="body2" color="text.secondary" component="span">
            {p.detail}
          </Typography>
        }
      />
    );
  const running =
    (p.platform.state === 'starting' || p.platform.state === 'ready') && p.platform.id;
  return (
    <CheckPanel
      title={PREVIEW_WORDS[p.state]}
      testId="preview"
      state={p.state}
      status={
        <>
          {p.url && (
            <Link href={p.url} target="_blank" rel="noreferrer noopener">
              {p.label ?? 'Open the preview'}
            </Link>
          )}
          <Typography variant="body2" color="text.secondary" component="span">
            {p.detail}
          </Typography>
        </>
      }
    >
      {p.platform.available && (
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
          data-testid="platform-preview"
          data-state={p.platform.state}
        >
          {running ? (
            <Button
              size="small"
              variant="outlined"
              disabled={busy}
              onClick={() => void act(() => stopPlatformPreview(p.platform.id!))}
            >
              Stop the preview
            </Button>
          ) : (
            <Button
              size="small"
              variant="outlined"
              disabled={busy}
              onClick={() => void act(() => startPlatformPreview(id))}
            >
              {p.platform.state === 'none' || p.platform.state === 'unavailable'
                ? 'Run it here'
                : 'Run it again'}
            </Button>
          )}
          {p.platform.state === 'ready' && p.platform.expiresAt && (
            <Typography variant="body2" color="text.secondary">
              The platform stops it at{' '}
              {new Date(p.platform.expiresAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
              .
            </Typography>
          )}
          {p.platform.state === 'none' && (
            <Typography variant="body2" color="text.secondary">
              Runs this pull request's own code in a sandbox for {p.platform.ttlMinutes} minutes. It
              has no secrets and almost no network.
            </Typography>
          )}
          {(p.platform.state === 'failed' || p.platform.state === 'unavailable') &&
            p.platform.detail && (
              <Alert severity="warning" data-testid="platform-preview-error" sx={{ py: 0 }}>
                {p.platform.detail}
              </Alert>
            )}
        </Stack>
      )}
      {problem && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          {problem}
        </Alert>
      )}
    </CheckPanel>
  );
}

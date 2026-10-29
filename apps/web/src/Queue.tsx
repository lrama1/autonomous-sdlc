import { useCallback, useEffect, useState } from 'react';
import type {
  AssumptionDto,
  AttentionProfile,
  InteractionDto,
  ReadyPreviewDto,
} from '@sdlc/schemas';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { decideAssumption, getAssumptions, getProfile, getQueue, makeStanding } from './api';
import { formatSpan, roleLabel } from './labels';
import { Ask } from './queue/Ask';
import { previewName } from './PreviewReadyBanner';
import { clearReadyPreview, useReadyPreviews } from './usePreviewReady';
import { PageHeader } from './ui';

function AssumptionRow({ a, onChanged }: { a: AssumptionDto; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const decide = async (verb: 'accept' | 'reject') => {
    setBusy(true);
    try {
      await decideAssumption(a.id, verb);
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card data-testid="assumption">
      <CardContent>
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}
        >
          <Chip label="Notice" />
          <Chip color="secondary" variant="outlined" label={roleLabel(a.agentRole)} />
          <Typography variant="subtitle2" component="b">
            Assumption declared: {a.text}
          </Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ my: 1 }}>
          {a.initiativeTitle}. Accepting records that you agree, and later runs on this initiative
          are told. Rejecting asks the person who started the run what to redo.
        </Typography>
        <Stack direction="row" spacing={1}>
          <Button size="small" variant="outlined" disabled={busy} onClick={() => decide('accept')}>
            Accept
          </Button>
          <Button size="small" variant="outlined" disabled={busy} onClick={() => decide('reject')}>
            Reject
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}

/** A preview the person started is ready. A quiet notice: it does not count as an ask, and it goes when it is opened or dismissed. */
function PreviewReadyRow({ p }: { p: ReadyPreviewDto }) {
  return (
    <Card data-testid="preview-ready">
      <CardContent>
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}
        >
          <Chip label="Notice" />
          <Typography variant="subtitle2" component="b">
            Preview is ready: {previewName(p)}
          </Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ my: 1 }}>
          You started this preview. It opens in its own browser tab, on its own address, and the
          platform stops it
          {p.expiresAt
            ? `at ${new Date(p.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            : 'after a while'}
          .
        </Typography>
        <Stack direction="row" spacing={1}>
          <Button
            size="small"
            variant="contained"
            href={p.url}
            target="_blank"
            rel="noreferrer noopener"
            onClick={() => {
              void clearReadyPreview(p.id);
            }}
          >
            Open the preview
          </Button>
          {p.interactionId && (
            <Button size="small" variant="outlined" href={`#/queue/${p.interactionId}`}>
              Go to the review
            </Button>
          )}
          {p.initiativeId && !p.interactionId && (
            <Button size="small" variant="outlined" href={`#/map/${p.initiativeId}`}>
              Go to the map
            </Button>
          )}
          <Button size="small" onClick={() => void clearReadyPreview(p.id)}>
            Dismiss
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}

function StandingOffer({
  id,
  suggest,
}: {
  id: string;
  suggest: NonNullable<InteractionDto['suggestStanding']>;
}) {
  const [state, setState] = useState<'offer' | 'saved' | 'dismissed' | 'failed'>('offer');
  if (state === 'dismissed') return null;
  if (state === 'saved')
    return (
      <Alert severity="success" sx={{ mt: 1 }} data-testid="standing-saved">
        Saved. Agents will use this answer for this repository without asking. You can review or end
        it on the Assumptions page.
      </Alert>
    );
  return (
    <Alert
      severity="info"
      sx={{ mt: 1 }}
      data-testid="standing-offer"
      action={
        <Stack direction="row" spacing={1}>
          <Button
            size="small"
            onClick={() =>
              void makeStanding(id).then(
                () => setState('saved'),
                () => setState('failed'),
              )
            }
          >
            Make it standing
          </Button>
          <Button size="small" color="inherit" onClick={() => setState('dismissed')}>
            No
          </Button>
        </Stack>
      }
    >
      You have given this answer {suggest.count} times to the same question ({suggest.topic}). Make
      it a standing decision for this repository?
      {state === 'failed' && ' That did not save. Try again.'}
    </Alert>
  );
}

export function Queue({ openId }: { openId: string | null }) {
  const [items, setItems] = useState<InteractionDto[] | null>(null);
  const [assumptions, setAssumptions] = useState<AssumptionDto[]>([]);
  const [profile, setProfile] = useState<AttentionProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  // An answered ask leaves the open list at once. Keep what the person was told, until they leave the page.
  const [settled, setSettled] = useState<
    Array<{ i: InteractionDto; note: string; suggest?: InteractionDto['suggestStanding'] }>
  >([]);

  const ready = useReadyPreviews(true);
  const load = useCallback(async () => {
    try {
      const [q, a] = await Promise.all([getQueue(), getAssumptions()]);
      setItems(q);
      setAssumptions(a);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    getProfile().then(setProfile, () => {});
    const poll = setInterval(() => void load(), 5000);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  const visible = (items ?? []).filter(
    (i) => !i.snoozedUntil || new Date(i.snoozedUntil).getTime() <= now,
  );
  const snoozed = (items ?? []).length - visible.length;
  const blocking = visible.filter((i) => i.blocks.length > 0 || i.type === 'review');

  return (
    <>
      <PageHeader
        title="Attention queue"
        chip={
          items && (
            <Chip
              data-testid="count"
              color={visible.length ? 'warning' : 'success'}
              label={visible.length ? `${visible.length} waiting on you` : 'All clear'}
            />
          )
        }
        subtitle="Ranked by what each ask blocks, then by deadline. No agent is idle while you read."
      />
      {error && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) 340px' },
          gap: 2,
          alignItems: 'start',
        }}
      >
        <Stack spacing={2}>
          {items && visible.length === 0 && (
            <Card data-testid="empty">
              <CardContent>
                Nothing is waiting on you.
                {snoozed > 0 && ` ${snoozed} snoozed.`}
              </CardContent>
            </Card>
          )}
          {visible.map((i, n) => (
            <Ask
              key={i.id}
              i={i}
              rank={n + 1}
              now={now}
              highlight={openId === i.id}
              assumptions={assumptions}
              onChanged={load}
              onAnswered={(note, suggest) => {
                setSettled((s) => [...s, { i, note, suggest }]);
                void load();
              }}
            />
          ))}
          {settled
            .filter((s) => !visible.some((v) => v.id === s.i.id))
            .map((s) => (
              <Card key={s.i.id} data-testid="settled">
                <CardContent>
                  <Typography component="h3" variant="h3" gutterBottom>
                    {s.i.title}
                  </Typography>
                  <Alert severity="success" data-testid="answered">
                    <b>Done.</b> {s.note}
                  </Alert>
                  {s.suggest && <StandingOffer id={s.i.id} suggest={s.suggest} />}
                </CardContent>
              </Card>
            ))}
          {ready.length > 0 && (
            <>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Typography component="h2" variant="h2">
                  Ready to open
                </Typography>
                <Chip label={ready.length} className="count" />
              </Stack>
              {ready.map((p) => (
                <PreviewReadyRow key={p.id} p={p} />
              ))}
            </>
          )}
          {assumptions.length > 0 && (
            <>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Typography component="h2" variant="h2">
                  Assumptions to review
                </Typography>
                <Chip label={assumptions.length} className="count" />
              </Stack>
              {assumptions.slice(0, 5).map((a) => (
                <AssumptionRow key={a.id} a={a} onChanged={load} />
              ))}
              <Link href="#/assumptions" variant="body2">
                See all assumptions and standing decisions
              </Link>
            </>
          )}
        </Stack>
        <Stack spacing={2} component="aside">
          <Card>
            <CardContent>
              <Typography component="h3" variant="h3" gutterBottom>
                Blocked work
              </Typography>
              {blocking.length === 0 ? (
                <Typography variant="body2">No agent is waiting on you.</Typography>
              ) : (
                <Stack component="ul" spacing={0.75} sx={{ listStyle: 'none', m: 0, p: 0 }}>
                  {blocking.map((i) => (
                    <Typography component="li" variant="body2" key={i.id}>
                      <Box component="span" sx={{ color: 'warning.main', mr: 0.75 }}>
                        {'\u25cf'}
                      </Box>
                      {i.title}
                    </Typography>
                  ))}
                </Stack>
              )}
            </CardContent>
          </Card>
          <Card data-testid="reached">
            <CardContent>
              <Typography component="h3" variant="h3" gutterBottom>
                How you are reached
              </Typography>
              {profile ? (
                <Box
                  component="dl"
                  sx={{
                    m: 0,
                    display: 'grid',
                    gridTemplateColumns: '90px 1fr',
                    gap: 0.75,
                    fontSize: 13,
                  }}
                >
                  <Typography component="dt" variant="body2" color="text.secondary">
                    Chat
                  </Typography>
                  <Typography component="dd" variant="body2" sx={{ m: 0 }}>
                    {profile.chatConfigured
                      ? profile.slackLinked
                        ? 'Slack. Answer simple asks in chat.'
                        : 'Slack is set up, but your account is not linked. Ask an admin.'
                      : 'Not set up. You see asks here.'}
                  </Typography>
                  <Typography component="dt" variant="body2" color="text.secondary">
                    Digest
                  </Typography>
                  <Typography component="dd" variant="body2" sx={{ m: 0 }}>
                    {profile.digestAt
                      ? `${profile.digestAt} for low-priority items`
                      : 'Sent as they come'}
                  </Typography>
                  <Typography component="dt" variant="body2" color="text.secondary">
                    Reminders
                  </Typography>
                  <Typography component="dd" variant="body2" sx={{ m: 0 }}>
                    After {formatSpan(profile.reminderAfterMin * 60_000)}, then the next person
                    after {formatSpan(profile.escalateAfterMin * 60_000)}
                  </Typography>
                  {profile.hats.map((h) => (
                    <Box key={h.role} sx={{ display: 'contents' }}>
                      <Typography component="dt" variant="body2" color="text.secondary">
                        {roleLabel(h.role)}
                      </Typography>
                      <Typography component="dd" variant="body2" sx={{ m: 0 }}>
                        {h.deputyName ? `Deputy: ${h.deputyName}` : 'No deputy. Admins are next.'}
                      </Typography>
                    </Box>
                  ))}
                </Box>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  Loading{'\u2026'}
                </Typography>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <Typography component="h3" variant="h3" gutterBottom>
                What makes a good ask
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Each card says what the agent was doing, why it needs a person, what is waiting, the
                options, a recommendation, and what happens if nobody answers.
              </Typography>
            </CardContent>
          </Card>
        </Stack>
      </Box>
    </>
  );
}

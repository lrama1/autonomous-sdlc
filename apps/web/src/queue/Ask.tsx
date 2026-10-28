import { useEffect, useRef, useState } from 'react';
import type { AssumptionDto, InteractionDto, SecurityDto, SmokeDto } from '@sdlc/schemas';
import Alert from '@mui/material/Alert';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Link from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { ApiProblem, answerInteraction, didntNeedToAsk, snoozeInteraction } from '../api';
import { TYPE_LABEL, formatSpan, roleLabel } from '../labels';
import { PreviewPanel } from './PreviewPanel';
import { ReviewAssumptions, undecidedNote } from './ReviewAssumptions';
import { blockersOf, stopsApprove, stopsSendingBack } from './blockers';
import { ReviewFlow } from './ReviewFlow';
import { SecurityPanel } from './SecurityPanel';
import { SmokePanel } from './SmokePanel';
import { card, checksPassed, optionsOf } from './shared';

function Waiting({ i }: { i: InteractionDto }) {
  const n = i.blocks.length;
  if (i.type === 'review')
    return <Chip color="warning" variant="outlined" label="Blocks the merge" />;
  if (i.hardStop) return <Chip color="error" label="Hard stop" />;
  return n > 0 ? (
    <Chip color="warning" variant="outlined" label={`Blocks ${n} run${n === 1 ? '' : 's'}`} />
  ) : (
    <Chip variant="outlined" label="Not blocking" />
  );
}

function Due({ i, now }: { i: InteractionDto; now: number }) {
  if (!i.dueAt || i.defaultValue === null) return null;
  const left = new Date(i.dueAt).getTime() - now;
  return (
    <Chip
      variant="outlined"
      data-testid="due"
      sx={{ ml: 'auto' }}
      label={left > 0 ? `Default in ${formatSpan(left)}` : 'Default being applied'}
    />
  );
}

/** What the person is being asked: a question or decision with options, or a review of a pull request. */
export function Ask({
  i,
  rank,
  now,
  highlight,
  assumptions = [],
  onChanged,
  onAnswered,
}: {
  i: InteractionDto;
  rank: number;
  now: number;
  highlight: boolean;
  /** Every undecided assumption. The ones the run behind this ask made are shown with it. */
  assumptions?: AssumptionDto[];
  onChanged: () => void;
  onAnswered: (note: string) => void;
}) {
  const options = optionsOf(i);
  const c = card(i);
  const [picked, setPicked] = useState<string>(i.recommendation ?? options[0]?.id ?? '');
  const [text, setText] = useState('');
  const [standing, setStanding] = useState(false);
  const [scope, setScope] = useState<'initiative' | 'repository' | 'global'>('initiative');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [marked, setMarked] = useState(i.didntNeedToAsk);
  const [smoke, setSmoke] = useState<SmokeDto | null>(null);
  const [security, setSecurity] = useState<SecurityDto | null>(null);
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: 'center' });
  }, [highlight]);

  const send = async (body: Parameters<typeof answerInteraction>[1], note: string) => {
    setBusy(true);
    setProblem(null);
    try {
      await answerInteraction(i.id, body);
      onAnswered(note);
    } catch (e) {
      setProblem(e instanceof ApiProblem ? e.message : 'Could not send your answer.');
    } finally {
      setBusy(false);
    }
  };

  const snooze = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await snoozeInteraction(i.id, 120);
      onChanged();
    } catch (e) {
      setProblem(e instanceof ApiProblem ? e.message : 'Could not snooze.');
    } finally {
      setBusy(false);
    }
  };

  const isDecision = i.type === 'review' || i.type === 'checkpoint';
  const blockers = isDecision
    ? blockersOf({ smoke, security, youMayNotDecide: i.youMayNotDecide })
    : [];
  const approveBlocked = stopsApprove(blockers);
  const sendBackBlocked = stopsSendingBack(blockers);
  // Takes the person to the check that clears a blocker, and puts the cursor on its button.
  const goTo = (panel: 'smoke' | 'security') => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-testid="${panel}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  };
  const mine = isDecision && i.runId ? assumptions.filter((a) => a.runId === i.runId) : [];
  const recommended = options.find((o) => o.id === i.recommendation);
  const snoozeButton = !i.hardStop && (
    <Button disabled={busy} onClick={() => snooze()} sx={{ ml: 'auto' }}>
      Snooze 2 h
    </Button>
  );

  const facts: Array<[string, React.ReactNode]> = isDecision
    ? [
        ...(c.summary
          ? ([
              [
                'What happened',
                <Box key="s" sx={{ whiteSpace: 'pre-wrap' }}>
                  {c.summary}
                </Box>,
              ],
            ] as Array<[string, React.ReactNode]>)
          : []),
        ...(c.triggers && c.triggers.length > 0
          ? ([
              ['Why it needs you', c.triggers.map((t) => t.description ?? t.id).join('; ')],
            ] as Array<[string, React.ReactNode]>)
          : []),
        ...(c.autoMerge && !c.autoMerge.auto
          ? ([['Why a person reviews it', c.autoMerge.reason]] as Array<[string, React.ReactNode]>)
          : []),
        ...(c.verify
          ? ([
              [
                'Checks',
                `${checksPassed(c.verify) ? 'The checks passed before the pull request opened.' : 'The checks did not pass.'}${c.diff?.changedPaths ? ` ${c.diff.changedPaths.length} file${c.diff.changedPaths.length === 1 ? '' : 's'} changed, ${c.diff.linesChanged ?? 0} lines.` : ''}`,
              ],
            ] as Array<[string, React.ReactNode]>)
          : []),
        ...(c.prUrl
          ? ([
              [
                'Pull request',
                <Link key="pr" href={c.prUrl} target="_blank" rel="noreferrer">
                  #{c.prNumber} on GitHub
                </Link>,
              ],
            ] as Array<[string, React.ReactNode]>)
          : []),
      ]
    : [
        ...((c.context ?? c.summary)
          ? ([['What it was doing', c.context ?? c.summary]] as Array<[string, React.ReactNode]>)
          : []),
        ...(c.whyNow ? ([['Why it needs you', c.whyNow]] as Array<[string, React.ReactNode]>) : []),
        ...(c.kind === 'integration_proposal'
          ? ([
              [
                'Documentation',
                c.docs && c.docs.length > 0
                  ? c.docs.map((u) => (
                      <Link
                        key={u}
                        href={u}
                        target="_blank"
                        rel="noreferrer"
                        sx={{ display: 'block' }}
                      >
                        {u}
                      </Link>
                    ))
                  : 'None yet. The agent had no link it was sure of.',
              ],
            ] as Array<[string, React.ReactNode]>)
          : []),
        ...(c.kind === 'task_failed'
          ? ([
              [
                'Why it failed',
                <Stack key="f" component="ul" spacing={0.5} sx={{ m: 0, pl: 2.5 }}>
                  {(c.failures ?? []).map((f) => (
                    <li key={f.attempt}>
                      <b>Attempt {f.attempt}:</b> {f.why}
                    </li>
                  ))}
                </Stack>,
              ],
            ] as Array<[string, React.ReactNode]>)
          : []),
        [
          'What is waiting',
          i.blocks.length > 0
            ? `${i.blocks.length} run${i.blocks.length === 1 ? ' is' : 's are'} waiting for this.`
            : c.kind === 'task_failed'
              ? 'The task, and every task that needs it.'
              : 'Nothing. The agent continues without it.',
        ],
      ];

  return (
    <Card
      component="article"
      ref={ref}
      data-testid="ask"
      data-id={i.id}
      sx={{
        ...(i.hardStop ? { borderLeft: 4, borderLeftColor: 'error.main' } : {}),
        boxShadow: highlight ? (t) => `0 0 0 2px ${t.palette.primary.main}` : undefined,
      }}
    >
      <CardContent>
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
        >
          <Avatar
            sx={{
              width: 24,
              height: 24,
              fontSize: 12,
              bgcolor: 'text.primary',
              color: 'background.paper',
            }}
          >
            {rank}
          </Avatar>
          <Chip color="warning" label={TYPE_LABEL[i.type] ?? i.type} />
          <Chip
            color="secondary"
            variant="outlined"
            label={`${roleLabel(i.agentRole)}${i.runId ? ` \u00b7 RUN-${i.runId.slice(-4).toUpperCase()}` : ''}`}
          />
          <Waiting i={i} />
          {i.escalationLevel > 0 && (
            <Chip color="error" data-testid="escalated" label="Escalated to you" />
          )}
          {i.snoozedUntil && new Date(i.snoozedUntil).getTime() > now && (
            <Chip
              variant="outlined"
              label={`Snoozed for ${formatSpan(new Date(i.snoozedUntil).getTime() - now)}`}
            />
          )}
          <Due i={i} now={now} />
        </Stack>
        <Typography component="h3" variant="h3" sx={{ mt: 1.5 }}>
          {i.title}
        </Typography>
        {i.initiativeTitle && (
          <Typography variant="body2" color="text.secondary">
            {i.initiativeTitle}
          </Typography>
        )}

        <Stack spacing={1.25} sx={{ my: 1.5 }}>
          {facts.map(([label, value]) => (
            <Box key={label}>
              <Typography
                variant="overline"
                color="text.secondary"
                sx={{ display: 'block', lineHeight: 1.6 }}
              >
                {label}
              </Typography>
              <Typography variant="body2" component="div">
                {value}
              </Typography>
            </Box>
          ))}
          {mine.length > 0 && <ReviewAssumptions assumptions={mine} onChanged={onChanged} />}
          {isDecision && c.prUrl && (
            <>
              <ReviewFlow verified={checksPassed(c.verify)} smoke={smoke} security={security} />
              <PreviewPanel id={i.id} />
              <SmokePanel
                id={i.id}
                onData={setSmoke}
                onSentBack={onAnswered}
                sendBackBlocked={sendBackBlocked}
                required={blockers.some((b) => b.id === 'smoke')}
              />
              <SecurityPanel
                id={i.id}
                onSentBack={onAnswered}
                onData={setSecurity}
                required={blockers.some((b) => b.id === 'security')}
              />
            </>
          )}
        </Stack>

        {isDecision ? (
          <>
            <TextField
              multiline
              minRows={2}
              placeholder="Comment (optional)"
              slotProps={{ htmlInput: { 'aria-label': 'Comment' } }}
              value={text}
              onChange={(e) => setText(e.target.value)}
              sx={{ my: 1 }}
            />
            <Stack
              direction="row"
              spacing={1}
              sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
            >
              <Tooltip title={approveBlocked ? blockers[0]!.reason : ''}>
                <span>
                  <Button
                    variant="contained"
                    disabled={busy || approveBlocked}
                    onClick={() =>
                      send(
                        { decision: 'approved', answer: text },
                        'Approved. The change can merge once the checks are green.',
                      )
                    }
                  >
                    Approve
                  </Button>
                </span>
              </Tooltip>
              <Button
                variant="outlined"
                disabled={busy || sendBackBlocked}
                onClick={() =>
                  send(
                    { decision: 'changes_requested', answer: text },
                    'Changes requested. The agent will be told.',
                  )
                }
              >
                Request changes
              </Button>
              <Button
                variant="outlined"
                color="error"
                disabled={busy || sendBackBlocked}
                onClick={() => send({ decision: 'rejected', answer: text }, 'Rejected.')}
              >
                Reject
              </Button>
              {snoozeButton}
            </Stack>
            {blockers.length > 0 && (
              <Alert
                severity="warning"
                variant="outlined"
                data-testid="approve-blocked"
                sx={{ mt: 1.25 }}
              >
                <Typography variant="subtitle2" component="div" sx={{ mb: 0.25 }}>
                  {sendBackBlocked ? 'You cannot decide this one' : 'Approve is waiting on'}
                </Typography>
                <Box component="ul" sx={{ m: 0, pl: 2 }}>
                  {blockers.map((b) => (
                    <li key={b.id} data-testid={`blocker-${b.id}`}>
                      {b.reason}
                      {b.panel && (
                        <>
                          {' '}
                          <Link
                            component="button"
                            type="button"
                            variant="body2"
                            onClick={() => goTo(b.panel!)}
                          >
                            Go to it
                          </Link>
                        </>
                      )}
                    </li>
                  ))}
                </Box>
              </Alert>
            )}
            {undecidedNote(mine.length) && (
              <Typography
                variant="caption"
                color="warning.main"
                data-testid="undecided-note"
                sx={{ display: 'block', mt: 0.75 }}
              >
                {undecidedNote(mine.length)}
              </Typography>
            )}
          </>
        ) : (
          <>
            {options.length > 0 ? (
              <RadioGroup
                name={`q-${i.id}`}
                value={picked}
                onChange={(_, v) => setPicked(v)}
                sx={{ gap: 0.75, my: 1 }}
              >
                {options.map((o) => (
                  <FormControlLabel
                    key={o.id}
                    value={o.id}
                    disabled={busy}
                    control={<Radio size="small" />}
                    sx={{
                      m: 0,
                      alignItems: 'flex-start',
                      border: 1,
                      borderColor: picked === o.id ? 'primary.main' : 'divider',
                      borderRadius: 2,
                      px: 1,
                      py: 0.5,
                    }}
                    label={
                      <Box sx={{ pt: 0.75 }}>
                        <Typography variant="body2" component="b" sx={{ fontWeight: 600 }}>
                          {o.id} {'\u00b7'} {o.label}
                        </Typography>{' '}
                        {o.id === i.recommendation && <Chip color="success" label="recommended" />}
                        {o.impact && (
                          <Typography variant="body2" color="text.secondary">
                            {o.impact}
                          </Typography>
                        )}
                      </Box>
                    }
                  />
                ))}
              </RadioGroup>
            ) : (
              <TextField
                multiline
                minRows={2}
                placeholder="Your answer"
                slotProps={{ htmlInput: { 'aria-label': 'Your answer' } }}
                value={text}
                onChange={(e) => setText(e.target.value)}
                sx={{ my: 1 }}
              />
            )}
            {c.kind === 'integration_proposal' && (
              <TextField
                multiline
                minRows={2}
                label="Documentation links to add (https, one per line)"
                slotProps={{ htmlInput: { 'aria-label': 'Documentation links' } }}
                value={text}
                onChange={(e) => setText(e.target.value)}
                sx={{ mb: 1 }}
              />
            )}
            {c.kind === 'task_failed' && picked === 'retry' && (
              <TextField
                multiline
                minRows={2}
                label="What the next attempt should do differently (optional)"
                slotProps={{ htmlInput: { 'aria-label': 'Guidance for the next attempt' } }}
                value={text}
                onChange={(e) => setText(e.target.value)}
                sx={{ mb: 1 }}
              />
            )}
            <Stack
              direction="row"
              spacing={1.5}
              sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
            >
              <Button
                variant="contained"
                disabled={busy || (options.length > 0 ? !picked : !text.trim())}
                onClick={() =>
                  send(
                    options.length > 0
                      ? {
                          optionId: picked,
                          ...(c.kind === 'integration_proposal' ||
                          (c.kind === 'task_failed' && picked === 'retry')
                            ? { answer: text }
                            : {}),
                          makeStanding: standing,
                          standingScope: scope,
                        }
                      : { answer: text, makeStanding: standing, standingScope: scope },
                    standing
                      ? 'Saved as a standing decision. Agents will stop asking about this.'
                      : 'The agent has your answer.',
                  )
                }
              >
                Answer
              </Button>
              {recommended && i.defaultValue !== null && (
                <Typography variant="body2" color="text.secondary">
                  If nobody answers, <b>{recommended.label}</b> is applied.
                </Typography>
              )}
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={standing}
                    onChange={(e) => setStanding(e.target.checked)}
                  />
                }
                label={<Typography variant="body2">Use this answer from now on</Typography>}
              />
              {standing && (
                <TextField
                  select
                  value={scope}
                  onChange={(e) => setScope(e.target.value as typeof scope)}
                  sx={{ width: 200 }}
                  slotProps={{
                    select: { native: true },
                    htmlInput: { 'aria-label': 'Applies to' },
                  }}
                >
                  <option value="initiative">for this initiative</option>
                  <option value="repository">for this repository</option>
                  <option value="global">everywhere</option>
                </TextField>
              )}
              {snoozeButton}
            </Stack>
          </>
        )}
        <Box sx={{ mt: 1 }}>
          <Button
            size="small"
            color="inherit"
            disabled={marked}
            sx={{ color: 'text.secondary', textDecoration: 'underline', px: 0 }}
            onClick={async () => {
              await didntNeedToAsk(i.id);
              setMarked(true);
            }}
          >
            {marked ? "Marked: didn't need to ask" : "Didn't need to ask"}
          </Button>
        </Box>
        {problem && (
          <Alert severity="warning" data-testid="ask-error" sx={{ mt: 1 }}>
            {problem}
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

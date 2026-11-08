import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  InitiativeKindDto,
  Me,
  RepositoryStartCheckDto,
  RepositorySetupDto,
} from '@sdlc/schemas';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  ApiProblem,
  createFirstCommit,
  createInitiative,
  getPortfolio,
  getRepositories,
  getRepositorySetup,
  getRepositoryStartCheck,
} from './api';
import {
  GOAL_MAX,
  composeGoal,
  describeEstimate,
  describeProblems,
  estimateNewAppCost,
} from './newApp';
import type { GoalAnswers } from './newApp';
import { StatusChip } from './ui';

type Mode = 'guided' | 'balanced' | 'autopilot';

const MODES: Array<{ id: Mode; title: string; plain: string }> = [
  {
    id: 'guided',
    title: 'Guided (recommended for a new app)',
    plain:
      'You approve each stage and review every pull request. Nothing merges without your click. The most to do, and the most control.',
  },
  {
    id: 'balanced',
    title: 'Balanced',
    plain:
      'Kinds of change you have pre-approved merge by themselves once the checks pass. Everything else waits for you. The Autopilot page shows what is pre-approved.',
  },
  {
    id: 'autopilot',
    title: 'Autopilot',
    plain:
      'Pull requests merge by themselves once the checks pass, with no review. Specs and designs still wait for a person. Choose it for work you can easily undo.',
  },
];
const MODE_NAME: Record<Mode, string> = {
  guided: 'Guided',
  balanced: 'Balanced',
  autopilot: 'Autopilot',
};

const STEPS = ['Where it lives', 'Describe it', 'How it runs', 'Review and create'];

interface WizardState {
  step: number;
  repositoryId: string;
  /** Its name, for the summary. */
  repositoryName: string;
  title: string;
  answers: GoalAnswers;
  links: string;
  autonomyMode: Mode;
  autoStages: boolean;
  /** The goal as the person edited it on the last step. Null: use what the answers compose. */
  goalEdit: string | null;
  /** Read and accepted: this repository already has an app. */
  ack: boolean;
}

const FRESH: WizardState = {
  step: 0,
  repositoryId: '',
  repositoryName: '',
  title: '',
  answers: { what: '', mustDo: '', mustNot: '', feel: '' },
  links: '',
  autonomyMode: 'guided',
  autoStages: true,
  goalEdit: null,
  ack: false,
};

// What the person has entered so far. It outlives the wizard, so looking at another initiative does not lose it.
let saved: WizardState | null = null;

/** What the wizard hands to the plain form when a person chooses to skip it. */
export interface WizardValues {
  title: string;
  goal: string;
  repositoryId: string;
  autonomyMode: Mode;
  autoStages: boolean;
  referenceLinks: string;
}

const problemText = (e: unknown) => (e instanceof ApiProblem ? e.message : String(e));

function RepositoryStep({
  me,
  worked,
  state,
  set,
  onOtherType,
  check,
  setCheck,
}: {
  me: Me;
  worked: Set<string>;
  state: WizardState;
  set: (patch: Partial<WizardState>) => void;
  onOtherType: (kind: InitiativeKindDto) => void;
  check: RepositoryStartCheckDto | null;
  setCheck: (c: RepositoryStartCheckDto | null) => void;
}) {
  const admin = me.roles.includes('platform_admin');
  const [repos, setRepos] = useState<Array<{ id: string; fullName: string }> | null>(null);
  const [asking, setAsking] = useState(false);
  const [setup, setSetup] = useState<RepositorySetupDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const chosen = useRef(false);

  const loadRepos = useCallback(() => {
    getRepositories().then(
      (r) => {
        setRepos(r.map((x) => ({ id: x.id, fullName: x.fullName })));
        // Unless the person has chosen, start from a repository nobody has built an app in.
        const keep =
          r.some((x) => x.id === state.repositoryId) &&
          (chosen.current || !worked.has(state.repositoryId));
        if (!keep) set({ repositoryId: (r.find((x) => !worked.has(x.id)) ?? r[0])?.id ?? '' });
      },
      (e) => setError(problemText(e)),
    );
  }, [state.repositoryId, worked, set]);

  useEffect(() => {
    loadRepos();
    // Only on first showing; the refresh button asks again.
  }, []);
  useEffect(() => {
    if (admin) getRepositorySetup().then(setSetup, () => setSetup(null));
  }, [admin]);

  const ask = useCallback(
    (id: string) => {
      setCheck(null);
      if (!id) return;
      setAsking(true);
      getRepositoryStartCheck(id)
        .then(setCheck, () => setCheck(null))
        .finally(() => setAsking(false));
    },
    [setCheck],
  );
  useEffect(() => {
    const name = repos?.find((x) => x.id === state.repositoryId)?.fullName;
    if (name && name !== state.repositoryName) set({ repositoryName: name });
  }, [repos, state.repositoryId, state.repositoryName, set]);

  const firstShowing = useRef(true);
  useEffect(() => {
    // A different repository has to be read about again; coming back to the step does not.
    if (!firstShowing.current) set({ ack: false });
    firstShowing.current = false;
    ask(state.repositoryId);
  }, [state.repositoryId, ask, set]);

  const github = (name: string, installUrl: string | null) =>
    installUrl ? (
      <Button
        size="small"
        variant="outlined"
        component="a"
        href={installUrl}
        target="_blank"
        rel="noreferrer"
      >
        {name}
      </Button>
    ) : null;

  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" color="text.secondary">
        Pick the repository the app will be built in. Each app should have a repository of its own.
      </Typography>
      {error && <Alert severity="warning">{error}</Alert>}
      {repos?.length === 0 && (
        <Alert severity="info" data-testid="wizard-no-repository">
          No repository is registered yet.{' '}
          {admin
            ? 'Make one with the steps below, then choose Refresh the list.'
            : 'A Platform Admin adds one on the Repositories page.'}
        </Alert>
      )}
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={1.5}
        useFlexGap
        sx={{ alignItems: 'center' }}
      >
        <TextField
          select
          label="Repository"
          value={state.repositoryId}
          onChange={(e) => {
            chosen.current = true;
            set({ repositoryId: e.target.value });
          }}
          disabled={!repos?.length}
          slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
          sx={{ minWidth: 320 }}
        >
          {(repos ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.fullName}
            </option>
          ))}
        </TextField>
        <Button variant="outlined" onClick={loadRepos}>
          Refresh the list
        </Button>
      </Stack>

      {state.repositoryId && (
        <Box data-testid="wizard-repo-status">
          {asking && (
            <Typography variant="body2" color="text.secondary">
              Checking the repository…
            </Typography>
          )}
          {!asking && check?.branch === 'exists' && (
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              <StatusChip label="Ready" tone="done" />
              <Typography variant="body2">
                The branch {check.integrationBranch} exists, so agents have somewhere to start from.
              </Typography>
            </Stack>
          )}
          {!asking && check?.branch === 'missing' && (
            <Alert severity="warning" data-testid="wizard-branch-missing">
              {check.empty
                ? `This repository is empty, so agents have no ${check.integrationBranch} branch to start from.`
                : `There is no branch called ${check.integrationBranch} in this repository, so agents have nothing to start from.`}
              {check.empty && admin && (
                <Box sx={{ mt: 1 }}>
                  <Typography variant="body2" sx={{ mb: 1 }}>
                    The platform can make the first commit for you: it adds a README.md and creates{' '}
                    {check.integrationBranch}.
                  </Typography>
                  <Button
                    size="small"
                    variant="contained"
                    disabled={making}
                    data-testid="wizard-first-commit"
                    onClick={async () => {
                      setMaking(true);
                      setError(null);
                      try {
                        await createFirstCommit(state.repositoryId);
                        ask(state.repositoryId);
                      } catch (e) {
                        setError(problemText(e));
                      } finally {
                        setMaking(false);
                      }
                    }}
                  >
                    Create the first commit
                  </Button>
                </Box>
              )}
              {!(check.empty && admin) && (
                <Typography variant="body2" sx={{ mt: 0.5 }}>
                  A Platform Admin can fix this on the <a href="#/repositories">Repositories</a>{' '}
                  page (Check readiness).
                </Typography>
              )}
            </Alert>
          )}
          {!asking && !check && (
            <Alert severity="info" data-testid="wizard-branch-unknown">
              Could not check the repository just now. You can go on: the platform checks again when
              you create the initiative.
            </Alert>
          )}
        </Box>
      )}

      {check?.hasWork && (
        <Alert severity="warning" data-testid="wizard-alongside">
          This repository already has an app. A new app here is built next to it, in its own folder,
          but the platform previews and smoke-tests what the repository root starts, which is the
          other app. So its previews and smoke checks cannot vouch for this one. For a separate app,
          use another repository, or{' '}
          <Button size="small" onClick={() => onOtherType('feature')}>
            add a feature to the existing app instead
          </Button>
          .
          <FormControlLabel
            sx={{ display: 'flex', mt: 0.5 }}
            control={
              <Checkbox
                size="small"
                checked={state.ack}
                onChange={(e) => set({ ack: e.target.checked })}
                slotProps={{ input: { 'aria-label': 'I understand' } }}
              />
            }
            label={
              <Typography variant="body2">
                I understand the platform cannot preview or smoke-test this app, and I will check it
                myself.
              </Typography>
            }
          />
        </Alert>
      )}

      {admin && (
        <Accordion disableGutters variant="outlined">
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="body2">Need a new repository for this app?</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <List dense disablePadding sx={{ listStyleType: 'decimal', pl: 2.5 }}>
              <ListItem disableGutters sx={{ display: 'list-item' }}>
                <Typography variant="body2">
                  Create an empty repository on GitHub (do not add files).{' '}
                  {setup && (
                    <Button
                      size="small"
                      variant="outlined"
                      component="a"
                      href={setup.newRepositoryUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open GitHub’s new repository page
                    </Button>
                  )}
                </Typography>
              </ListItem>
              <ListItem disableGutters sx={{ display: 'list-item' }}>
                <Typography variant="body2">
                  Add it to both GitHub Apps:{' '}
                  {github(
                    'Agent App',
                    setup?.apps.find((a) => a.kind === 'agent')?.installUrl ?? null,
                  )}{' '}
                  {github(
                    'Gate App',
                    setup?.apps.find((a) => a.kind === 'gate')?.installUrl ?? null,
                  )}
                </Typography>
              </ListItem>
              <ListItem disableGutters sx={{ display: 'list-item' }}>
                <Typography variant="body2">
                  Register it on the <a href="#/repositories">Repositories</a> page. What you have
                  entered here is kept. Then come back and choose Refresh the list.
                </Typography>
              </ListItem>
            </List>
          </AccordionDetails>
        </Accordion>
      )}
    </Stack>
  );
}

export function NewAppWizard({
  me,
  worked,
  cancelHref,
  initial,
  onCreated,
  onSkip,
  onOtherType,
}: {
  me: Me;
  /** Repositories that already have an initiative. */
  worked: Set<string>;
  cancelHref: string | null;
  /** From the plain form, when a person switches to the wizard part-way. */
  initial: { repositoryId: string; title: string };
  onCreated: (id: string) => void;
  onSkip: (v: WizardValues) => void;
  onOtherType: (kind: InitiativeKindDto) => void;
}) {
  const [s, setS] = useState<WizardState>(
    () =>
      saved ?? {
        ...FRESH,
        repositoryId: initial.repositoryId,
        title: initial.title,
      },
  );
  const [check, setCheck] = useState<RepositoryStartCheckDto | null>(null);
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [estimate, setEstimate] = useState<string | null>(null);

  const set = useCallback((patch: Partial<WizardState>) => setS((x) => ({ ...x, ...patch })), []);
  useEffect(() => {
    saved = s;
  }, [s]);
  useEffect(() => {
    getPortfolio().then(
      (p) => setEstimate(describeEstimate(estimateNewAppCost(p.initiatives))),
      () => setEstimate(null),
    );
  }, []);

  const composed = composeGoal(s.answers);
  const goal = s.goalEdit ?? composed;
  const problems = describeProblems(s.title, s.answers, s.links);
  const repoBlocked =
    !s.repositoryId || check?.branch === 'missing' || (Boolean(check?.hasWork) && !s.ack);

  const go = (step: number) => {
    setTried(false);
    setProblem(null);
    set({ step });
  };
  const next = () => {
    if (s.step === 1 && problems.length > 0) return setTried(true);
    go(s.step + 1);
  };
  const answer = (patch: Partial<GoalAnswers>) =>
    set({ answers: { ...s.answers, ...patch }, goalEdit: null });
  const fieldProblem = (field: string) =>
    tried ? problems.find((p) => p.field === field)?.message : undefined;
  const linkList = s.links.split(/\s+/).filter(Boolean);

  const create = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const made = await createInitiative({
        title: s.title.trim(),
        goal,
        repositoryId: s.repositoryId,
        autonomyMode: s.autonomyMode,
        kind: 'new_app',
        autoStages: s.autoStages,
        referenceLinks: linkList,
        ...(check?.hasWork ? { acknowledgeSharedRepository: true } : {}),
      });
      saved = null;
      onCreated(made.id);
    } catch (e) {
      setProblem(problemText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card sx={{ mt: 2 }} data-testid="wizard">
      <CardContent>
        <Typography component="h3" variant="h3" gutterBottom>
          New app
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          A few questions, then the agents start on the spec. You can go back at any step, and what
          you type is kept.
        </Typography>
        <Stepper activeStep={s.step} alternativeLabel sx={{ mb: 3 }}>
          {STEPS.map((label) => (
            <Step key={label}>
              <StepLabel>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>

        <Box data-testid={`wizard-step-${s.step}`}>
          {s.step === 0 && (
            <RepositoryStep
              me={me}
              worked={worked}
              state={s}
              set={set}
              onOtherType={onOtherType}
              check={check}
              setCheck={setCheck}
            />
          )}

          {s.step === 1 && (
            <Stack spacing={1.5}>
              <TextField
                label="Name"
                value={s.title}
                onChange={(e) => set({ title: e.target.value })}
                required
                error={Boolean(fieldProblem('title'))}
                helperText={fieldProblem('title') ?? 'What you will call it.'}
              />
              <TextField
                label="What is it, and who is it for?"
                value={s.answers.what}
                onChange={(e) => answer({ what: e.target.value })}
                multiline
                minRows={2}
                required
                error={Boolean(fieldProblem('what'))}
                helperText={
                  fieldProblem('what') ??
                  'For example: a booking site for a dog groomer and her clients.'
                }
              />
              <TextField
                label="What must it do? One thing per line"
                value={s.answers.mustDo}
                onChange={(e) => answer({ mustDo: e.target.value })}
                multiline
                minRows={4}
                required
                error={Boolean(fieldProblem('mustDo'))}
                helperText={
                  fieldProblem('mustDo') ??
                  'Three to five things is plenty. Clients pick a time slot. The groomer sees tomorrow’s bookings.'
                }
              />
              <TextField
                label="What must it not do, or leave out? (optional)"
                value={s.answers.mustNot}
                onChange={(e) => answer({ mustNot: e.target.value })}
                multiline
                minRows={2}
                helperText="One thing per line. Saying what is out of scope keeps the first version small."
              />
              <TextField
                label="Look, feel and where it runs (optional)"
                value={s.answers.feel}
                onChange={(e) => answer({ feel: e.target.value })}
                multiline
                minRows={2}
                helperText="For example: simple and friendly, works on a phone, English only. Leave the technology to the architect unless you must choose it."
              />
              <TextField
                label="Outside systems it talks to (optional)"
                value={s.links}
                onChange={(e) => set({ links: e.target.value })}
                placeholder="https://docs.vendor.com/api"
                multiline
                minRows={2}
                error={Boolean(fieldProblem('links'))}
                helperText={
                  fieldProblem('links') ??
                  'Paste each system’s documentation link, one https link per line. Agents ask you for it if it is missing.'
                }
              />
              {tried && problems.length > 0 && (
                <Alert severity="warning" data-testid="wizard-problems">
                  Fill these in to go on: {problems.map((p) => p.message).join(' ')}
                </Alert>
              )}
            </Stack>
          )}

          {s.step === 2 && (
            <Stack spacing={1}>
              <Typography variant="body2" color="text.secondary">
                How much should the platform do without asking you? You can change it later.
              </Typography>
              <RadioGroup
                value={s.autonomyMode}
                onChange={(e) => set({ autonomyMode: e.target.value as Mode })}
                aria-label="How much runs on its own"
              >
                {MODES.map((m) => (
                  <FormControlLabel
                    key={m.id}
                    value={m.id}
                    control={<Radio />}
                    sx={{ alignItems: 'flex-start', mb: 1 }}
                    label={
                      <Box sx={{ pt: 0.75 }}>
                        <Typography variant="body1">
                          <b>{m.title}</b>
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          {m.plain}
                        </Typography>
                      </Box>
                    }
                  />
                ))}
              </RadioGroup>
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={s.autoStages}
                    onChange={(e) => set({ autoStages: e.target.checked })}
                  />
                }
                label={
                  <Typography variant="body2">
                    Start the spec as soon as I create it, and go on to design and build after each
                    approval (Guided still waits for your click on each).
                  </Typography>
                }
              />
            </Stack>
          )}

          {s.step === 3 && (
            <Stack spacing={2}>
              <Box
                component="dl"
                sx={{ display: 'grid', gridTemplateColumns: '170px 1fr', gap: 0.75, m: 0 }}
                data-testid="wizard-summary"
              >
                <Typography component="dt" variant="body2" color="text.secondary">
                  Name
                </Typography>
                <Typography component="dd" variant="body2" sx={{ m: 0 }}>
                  {s.title}
                </Typography>
                <Typography component="dt" variant="body2" color="text.secondary">
                  Built in
                </Typography>
                <Typography component="dd" variant="body2" sx={{ m: 0 }}>
                  {s.repositoryName || 'the repository you chose'}
                  {check?.integrationBranch ? `, on the ${check.integrationBranch} branch` : ''}
                </Typography>
                <Typography component="dt" variant="body2" color="text.secondary">
                  How it runs
                </Typography>
                <Typography component="dd" variant="body2" sx={{ m: 0 }}>
                  {MODE_NAME[s.autonomyMode]}
                  {s.autoStages ? ', starting the spec now' : ', you start each stage'}
                </Typography>
                <Typography component="dt" variant="body2" color="text.secondary">
                  Links
                </Typography>
                <Typography component="dd" variant="body2" sx={{ m: 0 }}>
                  {linkList.length ? linkList.join(', ') : 'none'}
                </Typography>
              </Box>
              <TextField
                label="Goal the agents will read"
                value={goal}
                onChange={(e) => set({ goalEdit: e.target.value })}
                multiline
                minRows={6}
                error={goal.length > GOAL_MAX}
                helperText={
                  goal.length > GOAL_MAX
                    ? `Too long: ${goal.length} of ${GOAL_MAX} characters.`
                    : 'Written from your answers. Change it here if you like.'
                }
                slotProps={{ htmlInput: { 'data-testid': 'wizard-goal' } }}
              />
              {s.goalEdit !== null && (
                <Box>
                  <Button size="small" onClick={() => set({ goalEdit: null })}>
                    Rewrite it from my answers
                  </Button>
                </Box>
              )}
              <Box>
                <Typography variant="body2" sx={{ mb: 0.5 }}>
                  <b>What happens next</b>
                </Typography>
                <List dense disablePadding sx={{ listStyleType: 'decimal', pl: 2.5 }}>
                  {[
                    s.autoStages
                      ? 'The Product agent drafts the spec from your goal now. It may ask you questions in the Attention queue.'
                      : 'You start the Product agent on the Map. It drafts the spec and may ask you questions in the Attention queue.',
                    'You approve the spec, or send it back. Then the Architect designs the app and plans its tasks.',
                    'You approve the design. Engineers build each task and open pull requests.',
                    'Checks, a security review and, where they apply, a preview run on every pull request. A person approves, and the Gate merges when CI passes.',
                  ].map((t) => (
                    <ListItem key={t} disableGutters sx={{ display: 'list-item', py: 0.25 }}>
                      <Typography variant="body2">{t}</Typography>
                    </ListItem>
                  ))}
                </List>
              </Box>
              {estimate && (
                <Alert severity="info" data-testid="wizard-estimate">
                  <b>What it may cost.</b> {estimate}
                </Alert>
              )}
              {problem && <Alert severity="warning">{problem}</Alert>}
            </Stack>
          )}
        </Box>

        <Stack
          direction="row"
          spacing={1}
          sx={{ mt: 3, alignItems: 'center', flexWrap: 'wrap' }}
          useFlexGap
        >
          {s.step > 0 && (
            <Button onClick={() => go(s.step - 1)} data-testid="wizard-back">
              Back
            </Button>
          )}
          {s.step < 3 ? (
            <Button
              variant="contained"
              onClick={next}
              disabled={s.step === 0 && repoBlocked}
              data-testid="wizard-next"
            >
              Next
            </Button>
          ) : (
            <Button
              variant="contained"
              onClick={() => void create()}
              disabled={busy || goal.length > GOAL_MAX || goal.trim() === ''}
              data-testid="wizard-create"
            >
              Create
            </Button>
          )}
          {cancelHref && (
            <Button href={cancelHref} data-testid="new-initiative-cancel">
              Cancel
            </Button>
          )}
          <Box sx={{ flexGrow: 1 }} />
          <Button
            size="small"
            data-testid="wizard-skip"
            onClick={() =>
              onSkip({
                title: s.title,
                goal,
                repositoryId: s.repositoryId,
                autonomyMode: s.autonomyMode,
                autoStages: s.autoStages,
                referenceLinks: s.links,
              })
            }
          >
            Skip the wizard
          </Button>
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Adding to an existing app, or fixing something?{' '}
          <Button size="small" onClick={() => onOtherType('feature')} data-testid="wizard-feature">
            Add a feature
          </Button>
          <Button size="small" onClick={() => onOtherType('change')} data-testid="wizard-fix">
            Change or fix
          </Button>
        </Typography>
      </CardContent>
    </Card>
  );
}

/** Forget what the wizard has kept: after an initiative is created from the plain form. */
export function clearWizardDraft(): void {
  saved = null;
}

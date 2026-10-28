import { useCallback, useEffect, useState } from 'react';
import type { BuildPlanDto, Me, StageStartDto } from '@sdlc/schemas';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  ApiProblem,
  cancelBuildPlan,
  createInitiative,
  getBuildPlan,
  getInitiatives,
  getMap,
  getReleases,
  getRepositories,
  getStageStarts,
  prepareRelease,
  retryRun,
  retryBuildTask,
  sendBackBuildPlan,
  skipStageStep,
  skipBuildTask,
  startBuildPlan,
  startStageStep,
  startRun,
} from './api';
import type { InitiativeMap } from './api';
import { PipelineFlow } from './flow/PipelineFlow';
import { StageActionContext } from './flow/StageNode';
import { pickInitiative } from './pickInitiative';
import { stageActions } from './stageActions';
import type { StageAction } from './stageActions';
import { PlanGraph } from './flow/PlanGraph';
import { PageHeader, StatusChip } from './ui';
import type { Tone } from './ui';

const RUN_ROLES: Array<{ id: string; label: string }> = [
  { id: 'product', label: 'Product agent: draft the spec (checkpoint G1)' },
  { id: 'architect', label: 'Architect agent: design it and list the tasks (checkpoint G1)' },
  { id: 'backend_engineer', label: 'Backend Engineer agent: build and open a PR' },
  {
    id: 'frontend_engineer',
    label: 'Frontend Engineer agent: build a page or component and open a PR',
  },
];

type Act = (fn: () => Promise<unknown>, done: string) => Promise<void>;

const LAST_VIEWED = 'sdlc.map.initiative';

const TASK_STATE: Record<BuildPlanDto['tasks'][number]['state'], { label: string; tone: Tone }> = {
  waiting: { label: 'Waiting', tone: 'none' },
  running: { label: 'Running', tone: 'info' },
  review: { label: 'In review', tone: 'wait' },
  merged: { label: 'Merged', tone: 'done' },
  failed: { label: 'Failed', tone: 'stop' },
  skipped: { label: 'Skipped', tone: 'none' },
  cancelled: { label: 'Cancelled', tone: 'none' },
};

/** The approved design's tasks, and where each one is. People start it, retry, skip, or cancel here. */
function BuildPlan({
  plan,
  mayControl,
  act,
}: {
  plan: BuildPlanDto;
  mayControl: boolean;
  act: Act;
}) {
  const live = plan.state === 'active' || plan.state === 'awaiting_start';
  return (
    <Card data-testid="build-plan" data-state={plan.state}>
      <CardContent>
        <Typography component="h3" variant="h3">
          Build plan
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          From <code>{plan.designPath}</code>. {plan.detail}
        </Typography>
        {plan.errors.length > 0 && (
          <Alert severity="warning" sx={{ mb: 1 }}>
            <Box component="ul" data-testid="plan-errors" sx={{ m: 0, pl: 2 }}>
              {plan.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </Box>
          </Alert>
        )}
        {plan.tasks.length > 0 && (
          <Box sx={{ mb: 1.5 }}>
            <PlanGraph tasks={plan.tasks} />
          </Box>
        )}
        <Stack component="ul" spacing={1.25} sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {plan.tasks.map((t) => (
            <Box component="li" key={t.key} data-testid={`task-${t.key}`} data-state={t.state}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Typography variant="body2" component="span">
                  <b>{t.key}</b> {t.title}
                </Typography>
                <StatusChip tone={TASK_STATE[t.state].tone} label={TASK_STATE[t.state].label} />
                {t.dependsOn.length > 0 && (
                  <Typography variant="caption" color="text.secondary">
                    after {t.dependsOn.join(', ')}
                  </Typography>
                )}
                {t.prNumber !== null && (
                  <Typography variant="caption" color="text.secondary">
                    {'\u00b7'} PR #{t.prNumber}
                  </Typography>
                )}
                {t.attempt > 1 && (
                  <Typography variant="caption" color="text.secondary">
                    {'\u00b7'} attempt {t.attempt}
                  </Typography>
                )}
              </Stack>
              {t.detail && (
                <Typography variant="body2" color="text.secondary">
                  {t.detail}
                </Typography>
              )}
              {t.stuckBehind.length > 0 && (
                <Typography variant="body2" color="text.secondary">
                  Stuck behind {t.stuckBehind.join(', ')}.
                </Typography>
              )}
              {mayControl && live && (t.state === 'failed' || t.state === 'waiting') && (
                <Stack direction="row" spacing={1} sx={{ mt: 0.75 }}>
                  {t.state === 'failed' && (
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() =>
                        void act(() => retryBuildTask(plan.id, t.key), `${t.key} will run again.`)
                      }
                    >
                      Retry
                    </Button>
                  )}
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() =>
                      void act(
                        () => skipBuildTask(plan.id, t.key),
                        `${t.key} is skipped. What waits for it can start.`,
                      )
                    }
                  >
                    Skip
                  </Button>
                </Stack>
              )}
            </Box>
          ))}
        </Stack>
        <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: 'wrap', rowGap: 1 }}>
          {mayControl && plan.state === 'invalid' && (
            <Button
              variant="contained"
              onClick={() =>
                void act(
                  () => sendBackBuildPlan(plan.id),
                  'Sent back to the Architect. A revised design is coming.',
                )
              }
            >
              Send back to the Architect
            </Button>
          )}
          {mayControl && live && (
            <Button
              variant="outlined"
              onClick={() =>
                void act(() => cancelBuildPlan(plan.id), 'The build plan is cancelled.')
              }
            >
              Cancel the plan
            </Button>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

function NewInitiative({ onCreated }: { onCreated: (id: string) => void }) {
  const [repos, setRepos] = useState<Array<{ id: string; fullName: string }>>([]);
  const [f, setF] = useState({
    title: '',
    goal: '',
    repositoryId: '',
    autonomyMode: 'balanced' as 'guided' | 'balanced' | 'autopilot',
    autoStages: true,
    referenceLinks: '',
  });
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    getRepositories().then(
      (r) => {
        setRepos(r.map((x) => ({ id: x.id, fullName: x.fullName })));
        setF((x) => ({ ...x, repositoryId: x.repositoryId || r[0]?.id || '' }));
      },
      () => {},
    );
  }, []);

  return (
    <Card
      component="form"
      sx={{ mt: 2 }}
      onSubmit={async (e: React.FormEvent) => {
        e.preventDefault();
        setProblem(null);
        try {
          const made = await createInitiative({
            ...f,
            referenceLinks: f.referenceLinks.split(/\s+/).filter(Boolean),
          });
          setF({ ...f, title: '', goal: '', referenceLinks: '' });
          onCreated(made.id);
        } catch (err) {
          setProblem(err instanceof ApiProblem ? err.message : 'Could not create it.');
        }
      }}
    >
      <CardContent>
        <Typography component="h3" variant="h3" gutterBottom>
          New initiative
        </Typography>
        <Stack spacing={1.5}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
            <TextField
              label="Title"
              value={f.title}
              onChange={(e) => setF({ ...f, title: e.target.value })}
              required
            />
            <TextField
              select
              label="Repository"
              value={f.repositoryId}
              onChange={(e) => setF({ ...f, repositoryId: e.target.value })}
              required
              slotProps={{ select: { native: true } }}
            >
              {repos.length === 0 && <option value="">No repository is registered</option>}
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.fullName}
                </option>
              ))}
            </TextField>
            {repos.length === 0 && (
              <Typography variant="body2" color="text.secondary" data-testid="no-repository">
                A Platform Admin adds one on the <a href="#/repositories">Repositories</a> page.
              </Typography>
            )}
            <TextField
              select
              label="How much runs on its own"
              value={f.autonomyMode}
              onChange={(e) =>
                setF({ ...f, autonomyMode: e.target.value as typeof f.autonomyMode })
              }
              slotProps={{ select: { native: true } }}
            >
              <option value="guided">Guided: a person reviews every PR</option>
              <option value="balanced">Balanced: pre-approved types merge</option>
              <option value="autopilot">Autopilot: no trigger, no review</option>
            </TextField>
          </Stack>
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={f.autoStages}
                onChange={(e) => setF({ ...f, autoStages: e.target.checked })}
              />
            }
            label={
              <Typography variant="body2">
                Draft the spec now, then design and build after each approval (guided mode waits for
                a click)
              </Typography>
            }
          />
          <TextField
            label="Goal"
            placeholder="The goal, in a few sentences"
            multiline
            minRows={3}
            value={f.goal}
            onChange={(e) => setF({ ...f, goal: e.target.value })}
            required
          />
          <TextField
            label="Reference links (optional)"
            placeholder="https://docs.vendor.com/api"
            helperText="Documentation for any outside system the work must call, one https link per line. Agents ask you for it if it is missing."
            multiline
            minRows={2}
            value={f.referenceLinks}
            onChange={(e) => setF({ ...f, referenceLinks: e.target.value })}
            slotProps={{ htmlInput: { 'aria-label': 'Reference links' } }}
          />
          <Box>
            <Button variant="contained" type="submit" disabled={!f.repositoryId}>
              Create
            </Button>
          </Box>
          {problem && <Alert severity="warning">{problem}</Alert>}
        </Stack>
      </CardContent>
    </Card>
  );
}

export function MapPage({ initiativeId, me }: { initiativeId: string | null; me: Me }) {
  const [list, setList] = useState<Array<{ id: string; title: string; state: string }>>([]);
  const [listed, setListed] = useState(false);
  const [map, setMap] = useState<InitiativeMap | null>(null);
  const [releases, setReleases] = useState<Awaited<ReturnType<typeof getReleases>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [role, setRole] = useState(RUN_ROLES[0]!.id);
  const [task, setTask] = useState('');
  const [version, setVersion] = useState('0.1.0');
  const [plan, setPlan] = useState<BuildPlanDto | null>(null);
  const [steps, setSteps] = useState<StageStartDto[]>([]);

  const loadList = useCallback(async () => {
    try {
      setList(
        (await getInitiatives()).map((i) => ({
          id: i.id,
          title: i.title,
          state: String((i as { state?: unknown }).state ?? ''),
        })),
      );
      setListed(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadMap = useCallback(async () => {
    if (!initiativeId) return setMap(null);
    try {
      const [m, r, p, st] = await Promise.all([
        getMap(initiativeId),
        getReleases(initiativeId),
        getBuildPlan(initiativeId),
        getStageStarts(initiativeId),
      ]);
      setMap(m);
      setReleases(r);
      setPlan(p);
      setSteps(st);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [initiativeId]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // Landing on the Map with nothing chosen opens the initiative that is in progress, or the one last looked at.
  useEffect(() => {
    if (initiativeId || !listed) return;
    const pick = pickInitiative(list, sessionStorage.getItem(LAST_VIEWED));
    if (pick) window.location.replace(`#/map/${pick}`);
  }, [initiativeId, listed, list]);
  useEffect(() => {
    if (initiativeId) sessionStorage.setItem(LAST_VIEWED, initiativeId);
  }, [initiativeId]);
  useEffect(() => {
    void loadMap();
    const poll = setInterval(() => void loadMap(), 5000);
    return () => clearInterval(poll);
  }, [loadMap]);

  const act: Act = async (fn, done) => {
    setNote(null);
    setError(null);
    try {
      await fn();
      setNote(done);
      await loadMap();
    } catch (e) {
      setError(e instanceof ApiProblem ? e.message : String(e));
    }
  };
  const mayControlBuild = me.roles.some((r) =>
    ['product_owner', 'architect', 'platform_admin'].includes(r),
  );
  const extras = map ? stageActions(map.stages, steps, plan, mayControlBuild) : {};
  const stageViews = map
    ? map.stages.map((s) => ({ ...s, actions: extras[s.id]?.actions, notes: extras[s.id]?.notes }))
    : [];
  const onStageAction = (a: StageAction) => {
    if (a.kind === 'start_step')
      void act(
        () => startStageStep(a.targetId),
        'The step is starting. It appears below when it runs.',
      );
    else if (a.kind === 'skip_step')
      void act(() => skipStageStep(a.targetId), 'Skipped. You can still start that run by hand.');
    else if (a.kind === 'retry_run')
      void act(
        () => retryRun(a.targetId),
        'Running it again. Questions and reviews will arrive in the attention queue.',
      );
    else
      void act(
        () => startBuildPlan(a.targetId),
        'The build has started. Tasks start as their dependencies merge.',
      );
  };
  const mayRelease = me.roles.some((r) =>
    ['product_owner', 'devops_release', 'platform_admin'].includes(r),
  );

  return (
    <>
      <PageHeader
        title="Map"
        subtitle="Where each initiative is, and who it is waiting on. Spec and design, build and review, then release."
        actions={
          <TextField
            select
            label="Initiative"
            value={initiativeId ?? ''}
            onChange={(e) =>
              (window.location.hash = e.target.value ? `#/map/${e.target.value}` : '#/map')
            }
            sx={{ minWidth: 260, maxWidth: 360 }}
            slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
          >
            {list.length === 0 && <option value="">No initiatives yet</option>}
            {list.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title}
              </option>
            ))}
          </TextField>
        }
      />
      {error && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {note && (
        <Alert severity="success" data-testid="note" sx={{ mb: 2 }}>
          {note}
        </Alert>
      )}

      {map ? (
        <>
          <Box sx={{ mb: 1.5 }}>
            <Typography
              component="p"
              sx={{ display: 'flex', alignItems: 'center', gap: 1, m: 0, fontSize: '1.05rem' }}
            >
              <b>{map.initiative.title}</b>
              <Chip component="span" variant="outlined" label={map.initiative.autonomyMode} />
            </Typography>
            <Typography color="text.secondary">{map.initiative.goal}</Typography>
            {map.initiative.referenceLinks.length > 0 && (
              <Typography variant="body2" color="text.secondary">
                Reference links:{' '}
                {map.initiative.referenceLinks.map((u) => (
                  <Link key={u} href={u} target="_blank" rel="noreferrer" sx={{ mr: 1 }}>
                    {u}
                  </Link>
                ))}
              </Typography>
            )}
          </Box>
          <StageActionContext.Provider value={onStageAction}>
            <PipelineFlow stages={stageViews} />
          </StageActionContext.Provider>

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) 420px' },
              gap: 2,
              alignItems: 'start',
              mt: 2,
            }}
          >
            <Stack spacing={2}>
              {plan && <BuildPlan plan={plan} mayControl={mayControlBuild} act={act} />}
              <Accordion disableGutters variant="outlined" data-testid="manual-run">
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography component="h3" variant="h3">
                    Start a run by hand
                  </Typography>
                </AccordionSummary>
                <AccordionDetails>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                    The buttons on the stages above start, skip and repeat the steps for you. Use
                    this only for something they do not cover, such as a one-off task for an agent.
                  </Typography>
                  <Stack
                    component="form"
                    spacing={1.5}
                    onSubmit={async (e: React.FormEvent) => {
                      e.preventDefault();
                      await act(
                        () => startRun(map.initiative.id, { role, task, budgetUsd: 1 }),
                        'The run is queued. Questions and reviews will arrive in the attention queue.',
                      );
                      setTask('');
                    }}
                  >
                    <TextField
                      select
                      label="Agent"
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                      slotProps={{ select: { native: true } }}
                    >
                      {RUN_ROLES.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </TextField>
                    <TextField
                      label="Task"
                      placeholder="What should it do?"
                      multiline
                      minRows={3}
                      value={task}
                      onChange={(e) => setTask(e.target.value)}
                      required
                    />
                    <Box>
                      <Button variant="contained" type="submit">
                        Start
                      </Button>
                    </Box>
                  </Stack>
                </AccordionDetails>
              </Accordion>{' '}
            </Stack>
            <Stack spacing={2}>
              <Card data-testid="releases">
                <CardContent>
                  <Typography component="h3" variant="h3" gutterBottom>
                    Releases
                  </Typography>
                  {releases.length === 0 && (
                    <Typography variant="body2" color="text.secondary">
                      None yet.
                    </Typography>
                  )}
                  <Stack component="ul" spacing={1} sx={{ listStyle: 'none', m: 0, p: 0 }}>
                    {releases.map((r) => (
                      <Box component="li" key={r.interactionId}>
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                          <Typography variant="body2" component="b" sx={{ fontWeight: 700 }}>
                            {r.version}
                          </Typography>
                          {r.state === 'released' && r.url ? (
                            <Link href={r.url} target="_blank" rel="noreferrer">
                              published
                            </Link>
                          ) : (
                            <Chip variant="outlined" label={r.state} />
                          )}
                          {r.state === 'waiting' && (
                            <Link href={`#/queue/${r.interactionId}`}>decide</Link>
                          )}
                        </Stack>
                        {r.detail && (
                          <Typography variant="body2" color="text.secondary">
                            {r.detail}
                          </Typography>
                        )}
                      </Box>
                    ))}
                  </Stack>
                  {mayRelease && (
                    <Stack
                      component="form"
                      direction="row"
                      spacing={1}
                      sx={{ mt: 1.5, alignItems: 'flex-start' }}
                      onSubmit={async (e: React.FormEvent) => {
                        e.preventDefault();
                        await act(
                          () => prepareRelease(map.initiative.id, version),
                          `Release ${version} is waiting for the approver in the attention queue.`,
                        );
                      }}
                    >
                      <TextField
                        label="Version"
                        value={version}
                        onChange={(e) => setVersion(e.target.value)}
                        slotProps={{ htmlInput: { pattern: '\\d+\\.\\d+\\.\\d+' } }}
                        required
                      />
                      <Button
                        type="submit"
                        variant="outlined"
                        sx={{ whiteSpace: 'nowrap', mt: 0.25 }}
                      >
                        Prepare a release
                      </Button>
                    </Stack>
                  )}
                </CardContent>
              </Card>
            </Stack>
          </Box>
        </>
      ) : (
        !initiativeId && (
          <Typography color="text.secondary">
            {list.length === 0
              ? 'No initiatives yet. Create the first one below.'
              : 'Choose an initiative.'}
          </Typography>
        )
      )}
      <NewInitiative
        onCreated={(id) => {
          void loadList();
          window.location.hash = `#/map/${id}`;
        }}
      />
    </>
  );
}

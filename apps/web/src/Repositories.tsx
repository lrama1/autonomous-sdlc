import { useCallback, useEffect, useState } from 'react';
import type { Me, RepositoryDto, RepositoryReadinessDto } from '@sdlc/schemas';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  ApiProblem,
  createFirstCommit,
  getAvailableRepositories,
  getRepositoryReadiness,
  listRegistry,
  registerRepository,
  removeRepository,
  updateRepository,
} from './api';
import { PageHeader, StatusChip } from './ui';
import type { Tone } from './ui';

const WRITE_MODE = {
  branch_pr: 'Agents work on a branch and open a pull request',
  direct: 'Agents push straight to the integration branch',
} as const;
const ACCESS = { read_write: 'Read and write', read_only: 'Read only' } as const;
const MODEL_POLICY = {
  any: 'Any model account',
  own_account: 'Only the owner’s model account',
} as const;

const READINESS_TONE: Record<RepositoryReadinessDto['checks'][number]['status'], Tone> = {
  ok: 'done',
  problem: 'stop',
  unknown: 'wait',
};
const READINESS_WORD = { ok: 'Ready', problem: 'Needs attention', unknown: 'Could not tell' };

const problemText = (e: unknown) => (e instanceof ApiProblem ? e.message : String(e));

function AddCard({ onAdded }: { onAdded: (fullName: string) => void }) {
  const [available, setAvailable] = useState<string[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [choice, setChoice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const look = useCallback(async (refresh: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await getAvailableRepositories(refresh);
      setAvailable(r.available);
      setProblem(r.problem);
      setChoice((c) => (r.available.includes(c) ? c : (r.available[0] ?? '')));
    } catch (e) {
      setError(problemText(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void look(false);
  }, [look]);

  return (
    <Card
      component="form"
      sx={{ mb: 2 }}
      onSubmit={async (e: React.FormEvent) => {
        e.preventDefault();
        if (!choice) return;
        setBusy(true);
        setError(null);
        try {
          await registerRepository(choice);
          onAdded(choice);
        } catch (err) {
          setError(problemText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <CardContent>
        <Typography component="h2" variant="h3" gutterBottom>
          Add a repository
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          The list holds the repositories both GitHub Apps are installed on. To offer another one,
          add it to both Apps on GitHub, then choose Check GitHub again.
        </Typography>
        {problem && (
          <Alert severity="warning" sx={{ mb: 1.5 }}>
            {problem}{' '}
            <Link href="/admin/github" data-testid="open-github-setup">
              Open GitHub setup
            </Link>
          </Alert>
        )}
        {error && (
          <Alert severity="warning" sx={{ mb: 1.5 }} data-testid="add-error">
            {error}
          </Alert>
        )}
        {!problem && available?.length === 0 && (
          <Typography variant="body2" sx={{ mb: 1.5 }} data-testid="none-left">
            No repository is waiting to be added.
          </Typography>
        )}
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ alignItems: 'center' }}>
          <TextField
            select
            label="Repository"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            disabled={!available?.length}
            slotProps={{ select: { native: true }, htmlInput: { 'aria-label': 'Repository' } }}
            sx={{ minWidth: 320 }}
          >
            {(available ?? []).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </TextField>
          <Button
            variant="contained"
            type="submit"
            disabled={busy || !choice}
            sx={{ whiteSpace: 'nowrap' }}
          >
            Add repository
          </Button>
          <Button
            variant="outlined"
            disabled={busy}
            onClick={() => void look(true)}
            sx={{ whiteSpace: 'nowrap' }}
          >
            Check GitHub again
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}

function EditForm({
  repo,
  onSaved,
  onCancel,
}: {
  repo: RepositoryDto;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState({
    integrationBranch: repo.integrationBranch,
    verifyCommand: repo.verifyCommand,
    requiredCheck: repo.requiredCheck,
    protectedPaths: repo.protectedPaths.join('\n'),
    writeMode: repo.writeMode,
    access: repo.access,
    modelPolicy: repo.modelPolicy,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const native = { select: { native: true } } as const;

  return (
    <Box
      component="form"
      data-testid="edit-form"
      sx={{ mt: 2 }}
      onSubmit={async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await updateRepository(repo.id, {
            integrationBranch: f.integrationBranch.trim(),
            verifyCommand: f.verifyCommand.trim(),
            requiredCheck: f.requiredCheck.trim(),
            protectedPaths: f.protectedPaths
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
            writeMode: f.writeMode,
            access: f.access,
            modelPolicy: f.modelPolicy,
          });
          onSaved();
        } catch (err) {
          setError(problemText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Stack spacing={1.5}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
          <TextField
            label="Integration branch"
            value={f.integrationBranch}
            onChange={(e) => set('integrationBranch', e.target.value)}
            helperText="Finished work is merged here."
          />
          <TextField
            label="Verify command"
            value={f.verifyCommand}
            onChange={(e) => set('verifyCommand', e.target.value)}
            helperText="Agents run it before they open a pull request."
          />
          <TextField
            label="Required CI check"
            value={f.requiredCheck}
            onChange={(e) => set('requiredCheck', e.target.value)}
            helperText="Must be green before the Gate merges."
          />
        </Stack>
        <TextField
          label="Protected paths"
          multiline
          minRows={3}
          value={f.protectedPaths}
          onChange={(e) => set('protectedPaths', e.target.value)}
          helperText="One per line. An agent may not change these without a person saying yes."
          slotProps={{ htmlInput: { 'aria-label': 'Protected paths' } }}
        />
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
          <TextField
            select
            label="How agents deliver"
            value={f.writeMode}
            onChange={(e) => set('writeMode', e.target.value as typeof f.writeMode)}
            slotProps={native}
          >
            {Object.entries(WRITE_MODE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </TextField>
          <TextField
            select
            label="Access"
            value={f.access}
            onChange={(e) => set('access', e.target.value as typeof f.access)}
            slotProps={native}
          >
            {Object.entries(ACCESS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </TextField>
          <TextField
            select
            label="Model policy"
            value={f.modelPolicy}
            onChange={(e) => set('modelPolicy', e.target.value as typeof f.modelPolicy)}
            slotProps={native}
          >
            {Object.entries(MODEL_POLICY).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </TextField>
        </Stack>
        {error && <Alert severity="warning">{error}</Alert>}
        <Stack direction="row" spacing={1}>
          <Button variant="contained" type="submit" disabled={busy}>
            Save changes
          </Button>
          <Button variant="outlined" onClick={onCancel}>
            Cancel
          </Button>
        </Stack>
      </Stack>
    </Box>
  );
}

type Check = RepositoryReadinessDto['checks'][number];

/** Offers a fix the platform can make itself, after showing exactly what it will write. */
function FirstCommit({
  repoId,
  fix,
  onDone,
}: {
  repoId: string;
  fix: NonNullable<Check['fix']>;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <Button size="small" variant="contained" sx={{ mt: 1 }} onClick={() => setOpen(true)}>
        Create the first commit
      </Button>
    );
  return (
    <Box sx={{ mt: 1 }} data-testid="first-commit">
      <Typography variant="body2" sx={{ mb: 0.5 }}>
        The Agent App will add one file, <code>{fix.path}</code>, to the integration branch with the
        message “{fix.message}”:
      </Typography>
      <Box
        component="pre"
        sx={{
          m: 0,
          p: 1.5,
          borderRadius: 1,
          bgcolor: 'action.hover',
          fontSize: 13,
          whiteSpace: 'pre-wrap',
        }}
      >
        {fix.content}
      </Box>
      {error && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
      <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
        <Button
          size="small"
          variant="contained"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await createFirstCommit(repoId);
              onDone();
            } catch (e) {
              setError(problemText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Make the commit
        </Button>
        <Button size="small" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </Stack>
    </Box>
  );
}

function Readiness({
  repoId,
  checks,
  onFixed,
}: {
  repoId: string;
  checks: RepositoryReadinessDto['checks'];
  onFixed: () => void;
}) {
  return (
    <Stack spacing={1} sx={{ mt: 2 }} data-testid="readiness">
      {checks.map((c) => (
        <Stack
          key={c.id}
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1.5}
          sx={{ alignItems: { sm: 'flex-start' } }}
          data-testid={`check-${c.id}`}
        >
          <Box sx={{ minWidth: 140 }}>
            <StatusChip label={READINESS_WORD[c.status]} tone={READINESS_TONE[c.status]} />
          </Box>
          <Box>
            <Typography variant="body2">
              <b>{c.label}</b>
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {c.detail}
            </Typography>
            {c.fix && <FirstCommit repoId={repoId} fix={c.fix} onDone={onFixed} />}
            {c.howTo && (
              <Box sx={{ mt: 1 }} data-testid="how-to">
                <List dense disablePadding sx={{ listStyleType: 'decimal', pl: 2.5 }}>
                  {c.howTo.steps.map((s) => (
                    <ListItem key={s} disableGutters sx={{ display: 'list-item', py: 0.25 }}>
                      <Typography variant="body2">{s}</Typography>
                    </ListItem>
                  ))}
                </List>
                {c.howTo.link && (
                  <Button
                    size="small"
                    variant="outlined"
                    component="a"
                    href={c.howTo.link}
                    target="_blank"
                    rel="noreferrer"
                    sx={{ mt: 0.5 }}
                  >
                    Open the rule form on GitHub
                  </Button>
                )}
              </Box>
            )}
          </Box>
        </Stack>
      ))}
    </Stack>
  );
}
function RepoCard({
  repo,
  onChanged,
  onNote,
}: {
  repo: RepositoryDto;
  onChanged: () => void;
  onNote: (s: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [checks, setChecks] = useState<RepositoryReadinessDto['checks'] | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      setChecks((await getRepositoryReadiness(repo.id)).checks);
    } catch (e) {
      setError(problemText(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <Card sx={{ mb: 2 }} data-testid="repo-card" aria-label={repo.fullName}>
      <CardContent>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          sx={{ justifyContent: 'space-between' }}
        >
          <Box>
            <Typography component="h2" variant="h3">
              {repo.fullName}
            </Typography>
            <Stack direction="row" spacing={1} sx={{ mt: 0.5, flexWrap: 'wrap', gap: 0.5 }}>
              <Chip size="small" variant="outlined" label={`branch ${repo.integrationBranch}`} />
              <Chip size="small" variant="outlined" label={ACCESS[repo.access]} />
              <Chip
                size="small"
                variant="outlined"
                label={repo.writeMode === 'branch_pr' ? 'pull requests' : 'direct push'}
              />
            </Stack>
          </Box>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
            <Button
              size="small"
              variant="outlined"
              disabled={checking}
              onClick={() => void check()}
            >
              Check readiness
            </Button>
            <Button size="small" variant="outlined" onClick={() => setEditing((x) => !x)}>
              {editing ? 'Close' : 'Edit'}
            </Button>
            {!confirmRemove ? (
              <Button
                size="small"
                variant="outlined"
                color="error"
                onClick={() => setConfirmRemove(true)}
              >
                Remove
              </Button>
            ) : (
              <>
                <Button
                  size="small"
                  variant="contained"
                  color="error"
                  onClick={async () => {
                    try {
                      await removeRepository(repo.id);
                      onNote(`${repo.fullName} is no longer in the registry.`);
                      onChanged();
                    } catch (e) {
                      setConfirmRemove(false);
                      setError(problemText(e));
                    }
                  }}
                >
                  Yes, remove it
                </Button>
                <Button size="small" onClick={() => setConfirmRemove(false)}>
                  Keep
                </Button>
              </>
            )}
          </Stack>
        </Stack>

        <Box
          component="dl"
          sx={{ display: 'grid', gridTemplateColumns: '170px 1fr', gap: 0.5, m: 0, mt: 2 }}
        >
          <Typography component="dt" variant="body2" color="text.secondary">
            Verify command
          </Typography>
          <Typography component="dd" variant="body2" sx={{ m: 0 }}>
            <Box component="code">{repo.verifyCommand}</Box>
          </Typography>
          <Typography component="dt" variant="body2" color="text.secondary">
            Required CI check
          </Typography>
          <Typography component="dd" variant="body2" sx={{ m: 0 }}>
            <Box component="code">{repo.requiredCheck}</Box>
          </Typography>
          <Typography component="dt" variant="body2" color="text.secondary">
            Protected paths
          </Typography>
          <Typography component="dd" variant="body2" sx={{ m: 0 }}>
            {repo.protectedPaths.length
              ? repo.protectedPaths.map((p) => (
                  <Box component="code" key={p} sx={{ mr: 1 }}>
                    {p}
                  </Box>
                ))
              : 'none'}
          </Typography>
          <Typography component="dt" variant="body2" color="text.secondary">
            Model policy
          </Typography>
          <Typography component="dd" variant="body2" sx={{ m: 0 }}>
            {MODEL_POLICY[repo.modelPolicy]}
          </Typography>
        </Box>

        {error && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
        {checks && <Readiness repoId={repo.id} checks={checks} onFixed={() => void check()} />}
        {editing && (
          <EditForm
            repo={repo}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              setChecks(null);
              onNote(`Saved the settings for ${repo.fullName}.`);
              onChanged();
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

export function Repositories({ me }: { me: Me }) {
  const [rows, setRows] = useState<RepositoryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [addedCount, setAddedCount] = useState(0);
  const admin = me.roles.includes('platform_admin');

  const load = useCallback(async () => {
    try {
      setRows(await listRegistry());
      setError(null);
    } catch (e) {
      setError(problemText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader
        title="Repositories"
        subtitle="The repositories agents may work on. A new initiative picks one of these. Agents deliver only through a pull request that the platform’s checks and a person approve."
      />
      {!admin && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Only a Platform Admin adds or changes repositories. You can see the list below.
        </Alert>
      )}
      {error && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {note && (
        <Alert severity="success" sx={{ mb: 2 }} data-testid="note">
          {note}
        </Alert>
      )}
      {admin && (
        <AddCard
          key={addedCount}
          onAdded={(n) => {
            setNote(`${n} is registered. Use Check readiness to see what it still needs.`);
            setAddedCount((c) => c + 1);
            void load();
          }}
        />
      )}
      {rows?.length === 0 && (
        <Typography color="text.secondary" data-testid="empty">
          No repository is registered yet. Add one above to start an initiative.
        </Typography>
      )}
      {rows?.map((r) =>
        admin ? (
          <RepoCard key={r.id} repo={r} onChanged={() => void load()} onNote={setNote} />
        ) : (
          <Card key={r.id} sx={{ mb: 2 }}>
            <CardContent>
              <Typography component="h2" variant="h3">
                {r.fullName}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                branch {r.integrationBranch} · verify <code>{r.verifyCommand}</code>
              </Typography>
            </CardContent>
          </Card>
        ),
      )}
    </>
  );
}

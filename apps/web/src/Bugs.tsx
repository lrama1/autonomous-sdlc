import { useCallback, useEffect, useState } from 'react';
import type { BugDto, Me } from '@sdlc/schemas';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  ApiProblem,
  getBugs,
  getInitiatives,
  reportBug,
  skipStageStep,
  startStageStep,
} from './api';
import { PageHeader, StatusChip } from './ui';
import type { Tone } from './ui';

const STATE: Record<BugDto['state'], { label: string; tone: Tone }> = {
  open: { label: 'Reported', tone: 'none' },
  fixing: { label: 'Being fixed', tone: 'wait' },
  fixed: { label: 'Fixed', tone: 'done' },
  needs_attention: { label: 'Needs a person', tone: 'stop' },
};

const SEVERITY: Record<BugDto['severity'], string> = { low: 'Low', medium: 'Medium', high: 'High' };

/** Reporting bugs, and following each fix from the report to the merged pull request. */
export function Bugs({ me }: { me: Me }) {
  const [bugs, setBugs] = useState<BugDto[]>([]);
  const [initiatives, setInitiatives] = useState<Array<{ id: string; title: string }>>([]);
  const [f, setF] = useState({
    initiativeId: '',
    title: '',
    description: '',
    steps: '',
    severity: 'medium' as BugDto['severity'],
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBugs(await getBugs());
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 5000);
    return () => clearInterval(poll);
  }, [load]);
  useEffect(() => {
    getInitiatives().then(
      (list) => {
        setInitiatives(list.map((i) => ({ id: i.id, title: i.title })));
        setF((x) => ({ ...x, initiativeId: x.initiativeId || list[0]?.id || '' }));
      },
      () => {},
    );
  }, []);

  const mayStart = me.roles.some((r) =>
    ['backend_engineer', 'frontend_engineer', 'platform_admin'].includes(r),
  );
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setProblem(null);
    setNote(null);
    try {
      await fn();
      setNote(done);
      await load();
    } catch (e) {
      setProblem(e instanceof ApiProblem ? e.message : String(e));
    }
  };

  return (
    <>
      <PageHeader
        title="Bugs"
        subtitle="Report what is wrong. The Bug Agent reproduces it with a failing test, finds the cause, and opens a fix for an engineer to review."
      />
      {problem && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {problem}
        </Alert>
      )}
      {note && (
        <Alert severity="success" data-testid="note" sx={{ mb: 2 }}>
          {note}
        </Alert>
      )}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) minmax(0, 1fr)' },
          gap: 2,
          alignItems: 'start',
        }}
      >
        <Card
          component="form"
          data-testid="bug-form"
          onSubmit={async (e: React.FormEvent) => {
            e.preventDefault();
            await act(async () => {
              await reportBug(f.initiativeId, {
                title: f.title,
                description: f.description,
                steps: f.steps || undefined,
                severity: f.severity,
              });
              setF({ ...f, title: '', description: '', steps: '' });
            }, 'Thank you. The report is recorded.');
          }}
        >
          <CardContent>
            <Typography component="h3" variant="h3" gutterBottom>
              Report a bug
            </Typography>
            <Stack spacing={1.5}>
              <TextField
                select
                label="Initiative"
                value={f.initiativeId}
                onChange={(e) => setF({ ...f, initiativeId: e.target.value })}
                required
                slotProps={{ select: { native: true } }}
              >
                {initiatives.length === 0 && <option value="">No initiative yet</option>}
                {initiatives.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.title}
                  </option>
                ))}
              </TextField>
              <TextField
                label="Title"
                placeholder="What is wrong, in a line"
                value={f.title}
                onChange={(e) => setF({ ...f, title: e.target.value })}
                required
                slotProps={{ htmlInput: { minLength: 3 } }}
              />
              <TextField
                label="What happens, and what should happen"
                multiline
                minRows={3}
                value={f.description}
                onChange={(e) => setF({ ...f, description: e.target.value })}
                required
                slotProps={{ htmlInput: { minLength: 10 } }}
              />
              <TextField
                label="Steps to reproduce (optional)"
                multiline
                minRows={2}
                value={f.steps}
                onChange={(e) => setF({ ...f, steps: e.target.value })}
              />
              <TextField
                select
                label="Severity"
                value={f.severity}
                onChange={(e) => setF({ ...f, severity: e.target.value as BugDto['severity'] })}
                slotProps={{ select: { native: true } }}
              >
                <option value="low">Low: a nuisance</option>
                <option value="medium">Medium: something does not work</option>
                <option value="high">High: users are blocked or data is wrong</option>
              </TextField>
              <Box>
                <Button variant="contained" type="submit" disabled={!f.initiativeId}>
                  Report
                </Button>
              </Box>
            </Stack>
          </CardContent>
        </Card>
        <Card data-testid="bug-list">
          <CardContent>
            <Typography component="h3" variant="h3" gutterBottom>
              Reported bugs
            </Typography>
            {bugs.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                None yet.
              </Typography>
            )}
            <Stack component="ul" spacing={2} sx={{ listStyle: 'none', m: 0, p: 0 }}>
              {bugs.map((b) => (
                <Box component="li" key={b.id} data-testid="bug" data-state={b.state}>
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{ alignItems: 'center', flexWrap: 'wrap' }}
                  >
                    <Typography variant="subtitle2" component="b">
                      {b.title}
                    </Typography>
                    <StatusChip tone={STATE[b.state].tone} label={STATE[b.state].label} />
                    <Chip variant="outlined" label={SEVERITY[b.severity]} />
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    {b.initiativeTitle} {'\u00b7'} reported by {b.reportedBy}
                    {b.prNumber !== null && ` \u00b7 PR #${b.prNumber}`}
                  </Typography>
                  {b.detail && (
                    <Typography variant="body2" color="text.secondary">
                      {b.detail}
                    </Typography>
                  )}
                  {mayStart && b.stageStartId && b.stageState === 'awaiting_start' && (
                    <Stack direction="row" spacing={1} sx={{ mt: 0.75 }}>
                      <Button
                        size="small"
                        variant="contained"
                        onClick={() =>
                          void act(() => startStageStep(b.stageStartId!), 'The fix is starting.')
                        }
                      >
                        Start the fix
                      </Button>
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() =>
                          void act(() => skipStageStep(b.stageStartId!), 'The fix was dropped.')
                        }
                      >
                        Drop
                      </Button>
                    </Stack>
                  )}
                </Box>
              ))}
            </Stack>
          </CardContent>
        </Card>
      </Box>
    </>
  );
}

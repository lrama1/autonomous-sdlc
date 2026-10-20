import { useCallback, useEffect, useState } from 'react';
import type { AssumptionDto, StandingDecisionDto } from '@sdlc/schemas';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import {
  ApiProblem,
  createStandingDecision,
  decideAssumption,
  getAssumptions,
  getInitiatives,
  getStandingDecisions,
  retireStandingDecision,
} from './api';
import { roleLabel } from './labels';
import { PageHeader, StatusChip } from './ui';

const SCOPE_LABEL: Record<string, string> = {
  global: 'Everywhere',
  repository: 'A repository',
  initiative: 'An initiative',
};

function AddStanding({ onAdded }: { onAdded: () => void }) {
  const [initiatives, setInitiatives] = useState<Array<{ id: string; title: string }>>([]);
  const [topic, setTopic] = useState('');
  const [text, setText] = useState('');
  const [scopeId, setScopeId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    getInitiatives().then(
      (r) => setInitiatives(r.map((i) => ({ id: i.id, title: i.title }))),
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
          await createStandingDecision(
            scopeId
              ? { scope: 'initiative', scopeId, topic, text }
              : { scope: 'global', topic, text },
          );
          setTopic('');
          setText('');
          onAdded();
        } catch (err) {
          setProblem(err instanceof ApiProblem ? err.message : 'Could not save it.');
        }
      }}
    >
      <CardContent>
        <Typography component="h3" variant="h3" gutterBottom>
          Add a standing decision
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Agents search these before they ask. The topic is the key an agent uses when it asks, for
          example <code>date-library</code>.
        </Typography>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={1.5}
          sx={{ alignItems: 'flex-start' }}
        >
          <TextField
            label="Topic"
            placeholder="Topic, for example date-library"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            required
          />
          <TextField
            label="Decision"
            placeholder="Use date-fns for dates and times"
            value={text}
            onChange={(e) => setText(e.target.value)}
            required
            sx={{ minWidth: 280 }}
          />
          <TextField
            select
            label="Applies to"
            value={scopeId}
            onChange={(e) => setScopeId(e.target.value)}
            slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
          >
            <option value="">Everywhere</option>
            {initiatives.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title}
              </option>
            ))}
          </TextField>
          <Button variant="contained" type="submit" sx={{ mt: 0.25 }}>
            Save
          </Button>
        </Stack>
        {problem && (
          <Alert severity="warning" sx={{ mt: 1.5 }}>
            {problem}
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

export function Assumptions() {
  const [tab, setTab] = useState<'assumptions' | 'standing'>('assumptions');
  const [assumptions, setAssumptions] = useState<AssumptionDto[] | null>(null);
  const [standing, setStanding] = useState<StandingDecisionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([getAssumptions(), getStandingDecisions()]);
      setAssumptions(a);
      setStanding(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (a: AssumptionDto, verb: 'accept' | 'reject') => {
    await decideAssumption(a.id, verb);
    setResult(
      verb === 'accept'
        ? `\u201c${a.text}\u201d is accepted.`
        : `\u201c${a.text}\u201d is rejected. The person who started the run has been asked what to redo.`,
    );
    await load();
  };

  return (
    <>
      <PageHeader
        title="Assumptions and decisions"
        chip={
          assumptions &&
          assumptions.length > 0 && (
            <StatusChip tone="wait" label={`${assumptions.length} to review`} />
          )
        }
        subtitle="Agents make small calls and say so. You can accept or reject them any time, and agents stop asking about things you have already settled."
      />
      {error && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}
      >
        <Tab
          value="assumptions"
          label={
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <span>Assumptions</span>
              <Chip className="count" label={assumptions?.length ?? 0} />
            </Stack>
          }
        />
        <Tab
          value="standing"
          label={
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <span>Standing decisions</span>
              <Chip className="count" label={standing?.length ?? 0} />
            </Stack>
          }
        />
      </Tabs>

      {tab === 'assumptions' && (
        <>
          <Card>
            <TableContainer>
              <Table size="small" data-testid="assumptions">
                <TableHead>
                  <TableRow>
                    <TableCell>Assumption</TableCell>
                    <TableCell>Declared by</TableCell>
                    <TableCell>Initiative</TableCell>
                    <TableCell>Your call</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {assumptions?.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} sx={{ color: 'text.secondary' }}>
                        Nothing to review.
                      </TableCell>
                    </TableRow>
                  )}
                  {assumptions?.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>{a.text}</TableCell>
                      <TableCell>
                        <Chip color="secondary" variant="outlined" label={roleLabel(a.agentRole)} />
                      </TableCell>
                      <TableCell>{a.initiativeTitle}</TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        <Button size="small" variant="outlined" onClick={() => decide(a, 'accept')}>
                          Accept
                        </Button>{' '}
                        <Button size="small" variant="outlined" onClick={() => decide(a, 'reject')}>
                          Reject
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Card>
          {result && (
            <Alert severity="success" data-testid="result" sx={{ mt: 2 }}>
              {result}
            </Alert>
          )}
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
            Accepting records the call. Rejecting asks the person who started the run what to redo,
            so nothing is forgotten.
          </Typography>
        </>
      )}

      {tab === 'standing' && (
        <>
          <Card>
            <TableContainer>
              <Table size="small" data-testid="standing">
                <TableHead>
                  <TableRow>
                    <TableCell>Topic</TableCell>
                    <TableCell>Decision</TableCell>
                    <TableCell>Applies to</TableCell>
                    <TableCell>Set by</TableCell>
                    <TableCell>Answered since</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {standing?.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} sx={{ color: 'text.secondary' }}>
                        None yet. Answer an ask and tick {'\u201c'}Use this answer from now on
                        {'\u201d'}.
                      </TableCell>
                    </TableRow>
                  )}
                  {standing?.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <Box component="code">{s.topic}</Box>
                      </TableCell>
                      <TableCell>{s.text}</TableCell>
                      <TableCell>{SCOPE_LABEL[s.scope] ?? s.scope}</TableCell>
                      <TableCell>{s.createdByName ?? 'n/a'}</TableCell>
                      <TableCell>{s.answeredSince}</TableCell>
                      <TableCell>
                        <Button
                          size="small"
                          variant="outlined"
                          onClick={async () => {
                            await retireStandingDecision(s.id);
                            await load();
                          }}
                        >
                          Retire
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Card>
          <AddStanding onAdded={load} />
        </>
      )}
    </>
  );
}

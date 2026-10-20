import { useCallback, useEffect, useState } from 'react';
import type { AutopilotDto } from '@sdlc/schemas';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { ApiProblem, getAutopilot, setAutonomyMode } from './api';
import { PageHeader } from './ui';

type Mode = 'guided' | 'balanced' | 'autopilot';

const MODE_HELP: Record<Mode, string> = {
  guided: 'A person reviews every pull request.',
  balanced: 'Pre-approved change types merge when the checks are green. A person reviews the rest.',
  autopilot: 'Anything no trigger fired on merges when the checks are green.',
};

const DECIDED = {
  rule: { color: 'success', label: 'Approved by rule' },
  person: { color: 'default', label: 'Reviewed by a person' },
  waiting: { color: 'warning', label: 'Held for a person' },
} as const;

function Tile({ n, label, testId }: { n: number; label: string; testId: string }) {
  return (
    <Card>
      <CardContent>
        <Typography variant="h1" component="div" sx={{ fontSize: '1.9rem' }} data-testid={testId}>
          {n}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
      </CardContent>
    </Card>
  );
}

export function Autopilot() {
  const [data, setData] = useState<AutopilotDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getAutopilot());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader
        title="Autopilot"
        subtitle="What may merge without a review, what did, and what was held for a person. A trigger always sends a change to a person, in every mode. Hard stops are never automatic."
      />
      {error && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {!data && !error && <Typography color="text.secondary">Loading{'\u2026'}</Typography>}
      {data && (
        <Stack spacing={2}>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 2 }}>
            <Tile n={data.counts.byRule} label="Approved by rule" testId="by-rule" />
            <Tile n={data.counts.byPerson} label="Reviewed by a person" testId="by-person" />
            <Tile n={data.counts.waiting} label="Held for a person" testId="waiting" />
          </Box>

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) 380px' },
              gap: 2,
              alignItems: 'start',
            }}
          >
            <Card>
              <CardContent sx={{ pb: 0 }}>
                <Typography component="h2" variant="h2">
                  Recent pull requests
                </Typography>
              </CardContent>
              <TableContainer>
                <Table size="small" data-testid="recent">
                  <TableHead>
                    <TableRow>
                      <TableCell>Pull request</TableCell>
                      <TableCell>Decision</TableCell>
                      <TableCell>Why</TableCell>
                      <TableCell>Outcome</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {data.recent.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} sx={{ color: 'text.secondary' }}>
                          No pull requests in this period.
                        </TableCell>
                      </TableRow>
                    )}
                    {data.recent.map((r) => (
                      <TableRow key={r.interactionId}>
                        <TableCell>
                          {r.prUrl ? (
                            <Link href={r.prUrl} target="_blank" rel="noreferrer">
                              #{r.prNumber}
                            </Link>
                          ) : (
                            `#${r.prNumber ?? '?'}`
                          )}{' '}
                          {r.title.replace(/^Review PR #\d+: /, '')}
                          <Typography variant="body2" color="text.secondary">
                            {r.initiativeTitle}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Chip
                            color={DECIDED[r.decidedBy]!.color}
                            variant={r.decidedBy === 'person' ? 'outlined' : 'filled'}
                            label={DECIDED[r.decidedBy]!.label}
                          />
                        </TableCell>
                        <TableCell>{r.reason}</TableCell>
                        <TableCell>{r.outcome.replace(/_/g, ' ')}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>

            <Stack spacing={2}>
              <Card>
                <CardContent>
                  <Typography component="h3" variant="h3" gutterBottom>
                    Pre-approved change types
                  </Typography>
                  {data.rules.length === 0 && (
                    <Typography variant="body2" color="text.secondary">
                      None.
                    </Typography>
                  )}
                  <Stack
                    component="ul"
                    spacing={1.25}
                    sx={{ listStyle: 'none', m: 0, p: 0 }}
                    data-testid="rules"
                  >
                    {data.rules.map((r) => (
                      <Box component="li" key={r.id}>
                        <Typography variant="subtitle2" component="b">
                          {r.id}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          {r.paths}
                        </Typography>
                        <Typography variant="body2" component="div">
                          Owner {r.owner ?? 'n/a'}.{' '}
                          {r.reviewBy ? (
                            r.expired ? (
                              <Chip
                                color="warning"
                                label={`review date ${r.reviewBy} has passed: not applied`}
                              />
                            ) : (
                              `Review by ${r.reviewBy}.`
                            )
                          ) : (
                            'No review date.'
                          )}
                        </Typography>
                      </Box>
                    ))}
                  </Stack>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                    Rules are edited by hand in <code>rules/triggers.yaml</code>.
                  </Typography>
                </CardContent>
              </Card>
              <Card>
                <CardContent>
                  <Typography component="h3" variant="h3" gutterBottom>
                    How each initiative runs
                  </Typography>
                  {data.initiatives.length === 0 && (
                    <Typography variant="body2" color="text.secondary">
                      No initiatives yet.
                    </Typography>
                  )}
                  <Stack spacing={2}>
                    {data.initiatives.map((i) => (
                      <Box key={i.id}>
                        <Typography
                          variant="subtitle2"
                          component="b"
                          sx={{ display: 'block', mb: 0.75 }}
                        >
                          {i.title}
                        </Typography>
                        <TextField
                          select
                          label="Autonomy mode"
                          value={i.autonomyMode}
                          slotProps={{
                            select: { native: true },
                            htmlInput: { 'aria-label': `Autonomy mode for ${i.title}` },
                          }}
                          onChange={async (e) => {
                            setProblem(null);
                            try {
                              await setAutonomyMode(i.id, e.target.value as Mode);
                              await load();
                            } catch (err) {
                              setProblem(
                                err instanceof ApiProblem ? err.message : 'Could not change it.',
                              );
                            }
                          }}
                        >
                          <option value="guided">Guided</option>
                          <option value="balanced">Balanced</option>
                          <option value="autopilot">Autopilot</option>
                        </TextField>
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                          {MODE_HELP[i.autonomyMode]}
                        </Typography>
                      </Box>
                    ))}
                  </Stack>
                  {problem && (
                    <Alert severity="warning" sx={{ mt: 1.5 }}>
                      {problem}
                    </Alert>
                  )}
                </CardContent>
              </Card>
            </Stack>
          </Box>
        </Stack>
      )}
    </>
  );
}

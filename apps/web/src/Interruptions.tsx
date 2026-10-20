import { useEffect, useState } from 'react';
import type { InterruptionMetricsDto } from '@sdlc/schemas';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { getInterruptions } from './api';
import { formatSpan, percent, roleLabel } from './labels';
import { PageHeader } from './ui';

const SUGGESTION = {
  covered: { color: 'success', text: 'Covered by a standing decision' },
  make_standing: {
    color: 'success',
    text: 'Always answered with the recommendation. Make it a standing decision.',
  },
  ask_less: {
    color: 'warning',
    text: 'Often marked \u201cdidn\u2019t need to ask\u201d. Consider a rule or a prompt change.',
  },
  keep: { color: 'default', text: 'Keep asking' },
} as const;

const num = (n: number | null, d = 1) => (n === null ? 'n/a' : n.toFixed(d));

function Tile({
  n,
  testId,
  children,
  note,
}: {
  n: React.ReactNode;
  testId: string;
  children: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent>
        <Typography variant="h1" component="div" sx={{ fontSize: '1.8rem' }} data-testid={testId}>
          {n}
        </Typography>
        <Typography variant="body2" color="text.secondary" component="div">
          {children}
        </Typography>
        {note && (
          <Typography variant="caption" color="text.secondary" component="div">
            {note}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

export function Interruptions() {
  const [days, setDays] = useState(30);
  const [m, setM] = useState<InterruptionMetricsDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setM(null);
    getInterruptions(days).then(
      (r) => {
        setM(r);
        setError(null);
      },
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [days]);

  const peak = m ? Math.max(0.0001, ...m.weekly.map((w) => w.perPr ?? 0)) : 1;
  const trend =
    m && m.weekly.length >= 2 && m.weekly.at(-1)!.perPr !== null && m.weekly[0]!.perPr !== null
      ? m.weekly.at(-1)!.perPr! < m.weekly[0]!.perPr!
        ? 'falling'
        : 'not falling'
      : null;

  return (
    <>
      <PageHeader
        title="Interruptions"
        subtitle="How often agents ask, how useful the asks were, and what to tune. You change the rules by hand. Nothing changes on its own."
        actions={
          <ToggleButtonGroup
            exclusive
            size="small"
            value={days}
            onChange={(_, v) => v && setDays(v)}
          >
            {[7, 30, 90].map((d) => (
              <ToggleButton key={d} value={d}>
                Last {d} days
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        }
      />
      {error && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {!m && !error && <Typography color="text.secondary">Loading{'\u2026'}</Typography>}
      {m && (
        <Stack spacing={2}>
          <Box
            data-testid="tiles"
            sx={{
              display: 'grid',
              gridTemplateColumns: {
                xs: 'repeat(2, minmax(0, 1fr))',
                md: 'repeat(4, minmax(0, 1fr))',
              },
              gap: 2,
            }}
          >
            <Tile
              n={num(m.questionsPerMergedPr)}
              testId="per-pr"
              note={`${m.asks} asks, ${m.mergedPrs} merged`}
            >
              Questions per merged PR{' '}
              {trend && <Chip color={trend === 'falling' ? 'success' : 'warning'} label={trend} />}
            </Tile>
            <Tile n={percent(m.unchangedShare)} testId="unchanged">
              Answered with the recommendation unchanged
            </Tile>
            <Tile n={percent(m.didntNeedShare)} testId="didnt-need">
              Marked {'\u201c'}didn{'\u2019'}t need to ask{'\u201d'}
            </Tile>
            <Tile
              n={m.medianAnswerMs === null ? 'n/a' : formatSpan(m.medianAnswerMs)}
              testId="median"
            >
              Median time to answer {'\u00b7'} agent time blocked {percent(m.blockedShare)}
            </Tile>
          </Box>
          <Typography variant="body2" color="text.secondary">
            {m.defaulted} answered by a default after the deadline. {m.avoidedByStanding} never
            reached a person because a standing decision answered them.
          </Typography>

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
                  Where asks come from
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  Suggestions only. Nothing is applied for you.
                </Typography>
              </CardContent>
              <TableContainer>
                <Table size="small" data-testid="situations">
                  <TableHead>
                    <TableRow>
                      <TableCell>Situation</TableCell>
                      <TableCell>Asked</TableCell>
                      <TableCell>Unchanged</TableCell>
                      <TableCell>Didn{'\u2019'}t need to ask</TableCell>
                      <TableCell>Suggestion</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {m.situations.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} sx={{ color: 'text.secondary' }}>
                          No asks in this period.
                        </TableCell>
                      </TableRow>
                    )}
                    {m.situations.map((s) => (
                      <TableRow key={s.situation}>
                        <TableCell>{s.situation}</TableCell>
                        <TableCell>{s.asked}</TableCell>
                        <TableCell>{s.unchanged}</TableCell>
                        <TableCell>{s.didntNeed}</TableCell>
                        <TableCell>
                          <Chip
                            color={SUGGESTION[s.suggestion]!.color}
                            variant={s.suggestion === 'keep' ? 'outlined' : 'filled'}
                            sx={{
                              height: 'auto',
                              '& .MuiChip-label': { whiteSpace: 'normal', py: 0.25 },
                            }}
                            label={SUGGESTION[s.suggestion]!.text}
                          />
                        </TableCell>
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
                    Questions per merged PR
                  </Typography>
                  <Stack spacing={1}>
                    {m.weekly.map((w) => (
                      <Box
                        key={w.weekStart}
                        sx={{
                          display: 'grid',
                          gridTemplateColumns: '110px 1fr 36px',
                          gap: 1,
                          alignItems: 'center',
                        }}
                      >
                        <Typography variant="body2">Week of {w.weekStart.slice(5)}</Typography>
                        <LinearProgress
                          variant="determinate"
                          value={((w.perPr ?? 0) / peak) * 100}
                          sx={{ height: 10, borderRadius: 5 }}
                        />
                        <Typography variant="body2" color="text.secondary" align="right">
                          {num(w.perPr)}
                        </Typography>
                      </Box>
                    ))}
                  </Stack>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                    Falls as standing decisions pile up. If this line stops falling, the rules need
                    work.
                  </Typography>
                </CardContent>
              </Card>
              <Card>
                <CardContent>
                  <Typography component="h3" variant="h3" gutterBottom>
                    By agent
                  </Typography>
                  {m.byAgent.length === 0 && (
                    <Typography variant="body2" color="text.secondary">
                      No data yet.
                    </Typography>
                  )}
                  <Stack component="ul" spacing={0.75} sx={{ listStyle: 'none', m: 0, p: 0 }}>
                    {m.byAgent.map((a) => (
                      <Typography component="li" variant="body2" key={a.agentRole}>
                        <b>{roleLabel(a.agentRole)}</b>: {num(a.perPr)} per PR ({a.asks} asks,{' '}
                        {a.merged} merged), {percent(a.unchangedShare)} unchanged
                      </Typography>
                    ))}
                  </Stack>
                </CardContent>
              </Card>
            </Stack>
          </Box>
        </Stack>
      )}
    </>
  );
}

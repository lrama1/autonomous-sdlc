import { useEffect, useState } from 'react';
import type { CostsDto, MonthlyBudgetDto } from '@sdlc/schemas';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Link from '@mui/material/Link';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { getBudget, getCosts, getInitiatives } from './api';
import { PageHeader, StatusChip } from './ui';
import type { Tone } from './ui';

const LEVEL: Record<MonthlyBudgetDto['level'], { label: string; tone: Tone }> = {
  none: { label: 'No budget set', tone: 'none' },
  ok: { label: 'Within budget', tone: 'done' },
  warning: { label: 'Close to the budget', tone: 'wait' },
  exceeded: { label: 'Over the budget', tone: 'stop' },
};

/** Dollars, with more places for small amounts. */
const formatUsd = (usd: number) => {
  const abs = Math.abs(usd);
  return `$${usd.toFixed(abs === 0 ? 2 : abs < 0.01 ? 4 : abs < 1 ? 3 : 2)}`;
};
const pct = (n: number) => `${Math.round(n)}%`;
const tokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(n);

/** Tells a Platform Admin, on every page, when this month's spend nears or passes the monthly budget. */
export function BudgetBanner() {
  const [b, setB] = useState<MonthlyBudgetDto | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () =>
      getBudget().then(
        (x) => !stop && setB(x),
        () => {},
      );
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);
  if (!b || (b.level !== 'warning' && b.level !== 'exceeded')) return null;
  return (
    <Alert
      severity={b.level === 'exceeded' ? 'error' : 'warning'}
      sx={{ mb: 2 }}
      data-testid="budget-banner"
      data-level={b.level}
    >
      {b.level === 'exceeded'
        ? 'The monthly model budget is used up: '
        : 'Close to the monthly model budget: '}
      {formatUsd(b.spentUsd)} of {formatUsd(b.budgetUsd ?? 0)} ({Math.round(b.percent ?? 0)}%).{' '}
      <Link href="#/costs">See the costs</Link>
    </Alert>
  );
}

function Bars({ days }: { days: CostsDto['byDay'] }) {
  const max = Math.max(0.0001, ...days.map((d) => d.costUsd));
  if (days.length === 0)
    return (
      <Typography variant="body2" color="text.secondary">
        No spend in this period.
      </Typography>
    );
  return (
    <Box
      role="img"
      aria-label="Spend by day"
      data-testid="by-day"
      sx={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: '9rem', pt: 1 }}
    >
      {days.map((d) => (
        <Tooltip key={d.day} title={`${d.day}: ${formatUsd(d.costUsd)} (${d.calls} calls)`}>
          <Box
            sx={{
              flex: 1,
              minWidth: 6,
              maxWidth: '3rem',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'flex-end',
              alignItems: 'center',
            }}
          >
            <Box
              className="bar"
              sx={{
                width: '100%',
                bgcolor: 'primary.main',
                borderRadius: '3px 3px 0 0',
                height: `${Math.max(2, (d.costUsd / max) * 100)}%`,
              }}
            />
            <Typography sx={{ fontSize: '0.65rem', mt: '2px' }} color="text.secondary">
              {d.day.slice(5)}
            </Typography>
          </Box>
        </Tooltip>
      ))}
    </Box>
  );
}

function Tile({ n, label }: { n: React.ReactNode; label: string }) {
  return (
    <Card>
      <CardContent>
        <Typography variant="h1" component="div" sx={{ fontSize: '1.7rem' }}>
          {n}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
      </CardContent>
    </Card>
  );
}

function Panel({
  title,
  testId,
  children,
}: {
  title: string;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent>
        <Typography component="h3" variant="h3" gutterBottom>
          {title}
        </Typography>
        {children}
      </CardContent>
    </Card>
  );
}

const grid2 = {
  display: 'grid',
  gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' },
  gap: 2,
} as const;

/** What the models cost: this month against the budget, and where the spend goes. */
export function Costs() {
  const [days, setDays] = useState(30);
  const [initiativeId, setInitiativeId] = useState<string>('');
  const [list, setList] = useState<Array<{ id: string; title: string }>>([]);
  const [r, setR] = useState<CostsDto | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    getInitiatives().then(
      (l) => setList(l.map((i) => ({ id: i.id, title: i.title }))),
      () => {},
    );
  }, []);
  useEffect(() => {
    let stop = false;
    const load = () =>
      getCosts(days, initiativeId || null).then(
        (x) => {
          if (stop) return;
          setR(x);
          setProblem(null);
        },
        (e) => !stop && setProblem(e instanceof Error ? e.message : String(e)),
      );
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [days, initiativeId]);

  const m = r?.monthly;
  return (
    <>
      <PageHeader
        title="Costs"
        subtitle="What the models cost, from the gateway's records of every call."
        actions={
          <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', rowGap: 1.5 }}>
            <TextField
              select
              label="Initiative"
              value={initiativeId}
              onChange={(e) => setInitiativeId(e.target.value)}
              sx={{ minWidth: 220 }}
              slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
            >
              <option value="">All initiatives</option>
              {list.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.title}
                </option>
              ))}
            </TextField>
            <TextField
              select
              label="Period"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              sx={{ minWidth: 150 }}
              slotProps={{ select: { native: true } }}
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </TextField>
          </Stack>
        }
      />
      {problem && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {problem}
        </Alert>
      )}
      {r && m && (
        <Stack spacing={2}>
          <Card data-testid="monthly" data-level={m.level}>
            <CardContent>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
                <Typography component="h3" variant="h3">
                  This month
                </Typography>
                <StatusChip tone={LEVEL[m.level].tone} label={LEVEL[m.level].label} />
              </Stack>
              {m.budgetUsd === null ? (
                <Typography>
                  <b>{formatUsd(m.spentUsd)}</b> spent in {m.month.slice(0, 7)}. No monthly budget
                  is set (the platform setting MONTHLY_BUDGET_USD).
                </Typography>
              ) : (
                <>
                  <Typography>
                    <b>{formatUsd(m.spentUsd)}</b> of {formatUsd(m.budgetUsd)} (
                    {pct(m.percent ?? 0)}
                    ). Admins are warned at {m.alertPercent}%. Nothing stops at the budget: it is a
                    warning, not a limit.
                  </Typography>
                  <LinearProgress
                    aria-hidden
                    variant="determinate"
                    value={Math.min(100, m.percent ?? 0)}
                    color={
                      m.level === 'exceeded'
                        ? 'error'
                        : m.level === 'warning'
                          ? 'warning'
                          : 'primary'
                    }
                    sx={{ mt: 1.5, height: 10, borderRadius: 5 }}
                  />
                </>
              )}
            </CardContent>
          </Card>

          <Box
            data-testid="totals"
            sx={{
              display: 'grid',
              gridTemplateColumns: {
                xs: 'repeat(2, minmax(0, 1fr))',
                md: 'repeat(5, minmax(0, 1fr))',
              },
              gap: 2,
            }}
          >
            <Tile n={formatUsd(r.totals.costUsd)} label="spent in the period" />
            <Tile n={r.totals.runs} label="runs" />
            <Tile n={r.totals.calls} label="model calls" />
            <Tile n={pct(r.totals.cacheReadShare * 100)} label="of the prompt read from cache" />
            <Tile
              n={`${tokens(r.totals.inputTokens + r.totals.cachedTokens + r.totals.cacheWriteTokens)} / ${tokens(r.totals.outputTokens)}`}
              label="tokens in / out"
            />
          </Box>

          <Panel title="By day">
            <Bars days={r.byDay} />
          </Panel>

          <Box sx={grid2}>
            <Panel title="By initiative" testId="by-initiative">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Initiative</TableCell>
                    <TableCell>Period</TableCell>
                    <TableCell>All time</TableCell>
                    <TableCell>Of budget</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {r.byInitiative.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell>
                        <Link href={`#/map/${i.id}`}>{i.title}</Link>
                      </TableCell>
                      <TableCell>{formatUsd(i.costUsd)}</TableCell>
                      <TableCell>{formatUsd(i.allTimeUsd)}</TableCell>
                      <TableCell>
                        {i.percentOfBudget === null ? '-' : pct(i.percentOfBudget)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {r.byInitiative.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} sx={{ color: 'text.secondary' }}>
                        Nothing yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Panel>
            <Panel title="By agent" testId="by-role">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Agent</TableCell>
                    <TableCell>Spent</TableCell>
                    <TableCell>Runs</TableCell>
                    <TableCell>Per run</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {r.byRole.map((x) => (
                    <TableRow key={x.role}>
                      <TableCell>{x.role}</TableCell>
                      <TableCell>{formatUsd(x.costUsd)}</TableCell>
                      <TableCell>{x.runs}</TableCell>
                      <TableCell>{formatUsd(x.avgPerRunUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Panel>
          </Box>

          <Box sx={grid2}>
            <Panel title="By model" testId="by-model">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Alias</TableCell>
                    <TableCell>Model</TableCell>
                    <TableCell>Spent</TableCell>
                    <TableCell>Calls</TableCell>
                    <TableCell>Cached</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {r.byModel.map((x) => (
                    <TableRow key={`${x.alias}/${x.providerModel}`}>
                      <TableCell>{x.alias}</TableCell>
                      <TableCell>{x.providerModel}</TableCell>
                      <TableCell>{formatUsd(x.costUsd)}</TableCell>
                      <TableCell>{x.calls}</TableCell>
                      <TableCell>{tokens(x.cachedTokens)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Panel>
            <Panel title="Most expensive runs" testId="top-runs">
              <Stack component="ul" spacing={1} sx={{ listStyle: 'none', m: 0, p: 0 }}>
                {r.topRuns.map((x) => (
                  <Typography component="li" variant="body2" key={x.id}>
                    <b>{formatUsd(x.costUsd)}</b> {x.role} {'\u00b7'} {x.title || '(no title)'}
                    <Typography variant="body2" color="text.secondary" component="div">
                      <Link href={`#/map/${x.initiativeId}`}>{x.initiativeTitle}</Link> {'\u00b7'}{' '}
                      {x.state}
                    </Typography>
                  </Typography>
                ))}
              </Stack>
            </Panel>
          </Box>
        </Stack>
      )}
    </>
  );
}

import { useEffect, useState } from 'react';
import type { PortfolioDto } from '@sdlc/schemas';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { KIND_LABEL } from '@sdlc/schemas';
import type { InitiativeKindDto } from '@sdlc/schemas';
import TextField from '@mui/material/TextField';
import Chip from '@mui/material/Chip';
import { getPortfolio } from './api';
import { formatSpan, roleLabel } from './labels';
import { PageHeader, StatusChip } from './ui';
import type { Tone } from './ui';

type Row = PortfolioDto['initiatives'][number];

const STATUS: Record<NonNullable<Row['stage']>['status'], { label: string; tone: Tone }> = {
  not_started: { label: 'Not started', tone: 'none' },
  working: { label: 'In progress', tone: 'info' },
  waiting_human: { label: 'Waiting on a person', tone: 'wait' },
  blocked: { label: 'Blocked', tone: 'stop' },
  done: { label: 'Done', tone: 'done' },
};

const usd = (n: number) => `$${n.toFixed(n === 0 ? 2 : n < 1 ? 3 : 2)}`;
const ago = (iso: string) => `${formatSpan(Date.now() - new Date(iso).getTime())} ago`;
const month = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

function Tile({ n, label, testId }: { n: React.ReactNode; label: string; testId?: string }) {
  return (
    <Card data-testid={testId}>
      <CardContent>
        <Typography variant="h1" component="div" sx={{ fontSize: '1.9rem' }}>
          {n}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
      </CardContent>
    </Card>
  );
}

/** Every initiative in one list, and the releases that went out, newest month first. */
export function Portfolio() {
  const [p, setP] = useState<PortfolioDto | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [kind, setKind] = useState<'all' | InitiativeKindDto | 'unset'>('all');

  useEffect(() => {
    let stop = false;
    const load = () =>
      getPortfolio().then(
        (x) => !stop && setP(x),
        (e) =>
          !stop && setProblem(e instanceof Error ? e.message : 'Could not load the portfolio.'),
      );
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  if (problem) return <Alert severity="warning">{problem}</Alert>;
  if (!p) return <Typography color="text.secondary">Loading.</Typography>;

  const shown = p.initiatives.filter((i) =>
    kind === 'all' ? true : kind === 'unset' ? i.kind === null : i.kind === kind,
  );
  const waiting = p.initiatives.filter(
    (i) => i.stage?.status === 'waiting_human' || i.stage?.status === 'blocked',
  ).length;
  const byMonth = new Map<string, PortfolioDto['releases']>();
  for (const r of p.releases) byMonth.set(month(r.at), [...(byMonth.get(month(r.at)) ?? []), r]);

  return (
    <Stack spacing={2} data-testid="portfolio">
      <PageHeader title="Portfolio" />
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' },
          gap: 2,
        }}
      >
        <Tile n={p.initiatives.length} label="initiatives" />
        <Tile n={waiting} label="need a person" testId="tile-waiting" />
        <Tile n={usd(p.initiatives.reduce((s, i) => s + i.spentUsd, 0))} label="spent in all" />
        <Tile n={p.initiatives.reduce((s, i) => s + i.openBugs, 0)} label="open bugs" />
      </Box>

      <TextField
        select
        size="small"
        label="Type"
        value={kind}
        onChange={(e) => setKind(e.target.value as typeof kind)}
        sx={{ maxWidth: 220 }}
        slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
        data-testid="kind-filter"
      >
        <option value="all">All types</option>
        {(Object.keys(KIND_LABEL) as InitiativeKindDto[]).map((k) => (
          <option key={k} value={k}>
            {KIND_LABEL[k]}
          </option>
        ))}
        <option value="unset">Not set</option>
      </TextField>
      <Card data-testid="initiatives">
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Initiative</TableCell>
                <TableCell>Where it is</TableCell>
                <TableCell>Build</TableCell>
                <TableCell>Spent</TableCell>
                <TableCell>Bugs</TableCell>
                <TableCell>Last activity</TableCell>
                <TableCell>Released</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {shown.map((i) => (
                <TableRow key={i.id} data-testid={`row-${i.id}`} hover>
                  <TableCell>
                    <Link href={`#/map/${i.id}`}>{i.title}</Link>{' '}
                    {i.kind && (
                      <Chip
                        size="small"
                        variant="outlined"
                        label={KIND_LABEL[i.kind as InitiativeKindDto] ?? i.kind}
                        data-testid="kind-chip"
                      />
                    )}
                    <Typography variant="body2" color="text.secondary">
                      {i.repository}, {i.autonomyMode}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    {i.stage ? (
                      <>
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                          <StatusChip
                            tone={STATUS[i.stage.status].tone}
                            label={STATUS[i.stage.status].label}
                          />
                          <span>{i.stage.title}</span>
                        </Stack>
                        {i.stage.waitingOn.length > 0 && (
                          <Typography variant="body2" color="text.secondary">
                            Waiting on {i.stage.waitingOn.map((r) => roleLabel(r)).join(', ')}
                          </Typography>
                        )}
                      </>
                    ) : (
                      <StatusChip tone="done" label="Released" />
                    )}
                  </TableCell>
                  <TableCell>
                    {i.plan
                      ? `${i.plan.merged} of ${i.plan.total}${i.plan.failed ? `, ${i.plan.failed} failed` : ''}`
                      : '-'}
                  </TableCell>
                  <TableCell>
                    {usd(i.spentUsd)}
                    {i.budgetUsd !== null && (
                      <Typography variant="body2" color="text.secondary">
                        of {usd(i.budgetUsd)}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>{i.openBugs || '-'}</TableCell>
                  <TableCell>{ago(i.lastActivityAt)}</TableCell>
                  <TableCell>{i.lastRelease ? i.lastRelease.version : '-'}</TableCell>
                </TableRow>
              ))}
              {p.initiatives.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} sx={{ color: 'text.secondary' }}>
                    No initiatives yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>

      <Card data-testid="releases">
        <CardContent>
          <Typography component="h3" variant="h3" gutterBottom>
            Releases
          </Typography>
          {p.releases.length === 0 && (
            <Typography color="text.secondary">Nothing has been released yet.</Typography>
          )}
          {[...byMonth.entries()].map(([m, items]) => (
            <Box key={m} sx={{ mb: 1.5 }}>
              <Typography component="h4" variant="subtitle2" gutterBottom>
                {m}
              </Typography>
              <Stack component="ul" spacing={0.5} sx={{ listStyle: 'none', m: 0, p: 0 }}>
                {items.map((r) => (
                  <Typography
                    component="li"
                    variant="body2"
                    key={`${r.initiativeId}-${r.tag}-${r.at}`}
                  >
                    <b>{day(r.at)}</b> {r.initiativeTitle} <b>{r.version}</b>{' '}
                    {r.url && (
                      <Link href={r.url} target="_blank" rel="noreferrer">
                        release notes
                      </Link>
                    )}
                  </Typography>
                ))}
              </Stack>
            </Box>
          ))}
        </CardContent>
      </Card>
    </Stack>
  );
}

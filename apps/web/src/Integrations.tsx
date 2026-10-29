import { useCallback, useEffect, useState } from 'react';
import type { IntegrationDto } from '@sdlc/schemas';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import {
  ApiProblem,
  createIntegration,
  getIntegrations,
  refreshIntegrationDocs,
  retireIntegration,
} from './api';
import type { NewIntegration } from './api';
import { PageHeader } from './ui';

const STATUS = {
  confirmed: { color: 'success', label: 'Confirmed' },
  proposed: { color: 'warning', label: 'Waiting for confirmation' },
  rejected: { color: 'default', label: 'Rejected' },
  retired: { color: 'default', label: 'Retired' },
} as const;

const TEST: Record<string, string> = {
  vendor_sandbox: 'Vendor sandbox',
  mock: 'Mock',
  recorded: 'Recorded responses',
  none: 'None (a trigger)',
};

function AddForm({ onAdded }: { onAdded: () => void }) {
  const [f, setF] = useState({
    name: '',
    hosts: '',
    docs: '',
    kind: 'third_party' as NewIntegration['kind'],
    authType: 'none' as NewIntegration['authType'],
    credentialRef: '',
    testStrategy: 'mock' as NewIntegration['testStrategy'],
    owner: '',
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const lines = (s: string) =>
    s
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  const native = { select: { native: true } } as const;

  return (
    <Card
      component="form"
      sx={{ mt: 2 }}
      onSubmit={async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setProblem(null);
        try {
          await createIntegration({
            name: f.name,
            kind: f.kind,
            hosts: lines(f.hosts),
            docs: lines(f.docs),
            authType: f.authType,
            credentialRef: f.credentialRef || undefined,
            testStrategy: f.testStrategy,
            owner: f.owner || undefined,
          });
          setF({ ...f, name: '', hosts: '', docs: '', credentialRef: '' });
          onAdded();
        } catch (err) {
          setProblem(err instanceof ApiProblem ? err.message : 'Could not add it.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <CardContent>
        <Typography component="h3" variant="h3" gutterBottom>
          Add an external system
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Adding it confirms it: agents may then open connections to these hosts, and nothing else
          outside GitHub and the package registries. Use a plain hostname, with no wildcard or path.
        </Typography>
        <Stack spacing={1.5}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
            <TextField
              label="Name"
              placeholder="Name, for example Weather API"
              value={f.name}
              onChange={(e) => set('name', e.target.value)}
              slotProps={{ htmlInput: { required: true, 'aria-label': 'Name' } }}
            />
            <TextField
              label="Hosts"
              placeholder="Hosts, for example api.weather.example.com"
              value={f.hosts}
              onChange={(e) => set('hosts', e.target.value)}
              slotProps={{ htmlInput: { 'aria-label': 'Hosts' } }}
            />
          </Stack>
          <TextField
            label="Documentation links"
            placeholder="Documentation links (https), separated by spaces"
            value={f.docs}
            onChange={(e) => set('docs', e.target.value)}
          />
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
            <TextField
              select
              label="Kind"
              value={f.kind}
              onChange={(e) => set('kind', e.target.value as typeof f.kind)}
              slotProps={native}
            >
              <option value="third_party">Third party (a vendor or public API)</option>
              <option value="second_party">Second party (another team's system)</option>
            </TextField>
            <TextField
              select
              label="How to test"
              value={f.testStrategy}
              onChange={(e) => set('testStrategy', e.target.value as typeof f.testStrategy)}
              slotProps={native}
            >
              {Object.entries(TEST).map(([k, v]) => (
                <option key={k} value={k}>
                  Test with: {v}
                </option>
              ))}
            </TextField>
            <TextField
              select
              label="Authentication"
              value={f.authType}
              onChange={(e) => set('authType', e.target.value as typeof f.authType)}
              slotProps={native}
            >
              <option value="none">No authentication</option>
              <option value="api_key">API key</option>
              <option value="oauth">OAuth</option>
              <option value="basic">Basic</option>
            </TextField>
          </Stack>
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            spacing={1.5}
            sx={{ alignItems: 'flex-start' }}
          >
            <TextField
              label="Credential name"
              placeholder="Test credential name in the secrets store"
              value={f.credentialRef}
              onChange={(e) => set('credentialRef', e.target.value)}
            />
            <TextField
              label="Owner"
              value={f.owner}
              onChange={(e) => set('owner', e.target.value)}
            />
          </Stack>
          <Box>
            <Button variant="contained" type="submit" disabled={busy}>
              Add and confirm
            </Button>
          </Box>
          {problem && <Alert severity="warning">{problem}</Alert>}
        </Stack>
      </CardContent>
    </Card>
  );
}

export function Integrations() {
  const [rows, setRows] = useState<IntegrationDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await getIntegrations());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setNote(null);
    try {
      await fn();
      setNote(done);
      await load();
    } catch (e) {
      setError(e instanceof ApiProblem ? e.message : String(e));
    }
  };

  return (
    <>
      <PageHeader
        title="Integrations"
        subtitle="The external systems agents may call, where to learn them, and how to test them. A sandbox can reach only the hosts of confirmed entries. A new system an agent needs arrives in the attention queue as a hard stop."
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
      <Card>
        <TableContainer>
          <Table size="small" data-testid="integrations">
            <TableHead>
              <TableRow>
                <TableCell>System</TableCell>
                <TableCell>Hosts</TableCell>
                <TableCell>Test with</TableCell>
                <TableCell>Documentation</TableCell>
                <TableCell>Status</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} sx={{ color: 'text.secondary' }}>
                    None yet. Agents may reach GitHub and the package registries only.
                  </TableCell>
                </TableRow>
              )}
              {rows?.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <b>{r.name}</b>
                    <Typography variant="body2" color="text.secondary">
                      {r.kind === 'second_party' ? 'Second party' : 'Third party'}
                      {r.owner ? `, owner ${r.owner}` : ''}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Box component="code">{r.hosts.join(', ') || 'none'}</Box>
                  </TableCell>
                  <TableCell>
                    {TEST[r.testStrategy]}
                    {r.testStrategy === 'none' && r.status === 'confirmed' && (
                      <Box sx={{ mt: 0.5 }}>
                        <Chip color="warning" label="no way to test it safely" />
                      </Box>
                    )}
                  </TableCell>
                  <TableCell>
                    {r.docs.length === 0 && (
                      <Typography variant="body2" color="text.secondary">
                        no links
                      </Typography>
                    )}
                    {r.docs.map((u) => {
                      const s = r.snapshots.find((x) => x.url === u);
                      return (
                        <Box key={u} sx={{ mb: 0.5 }}>
                          {s?.ok ? (
                            <Chip color="success" label={`saved ${s.fetchedAt.slice(0, 10)}`} />
                          ) : s ? (
                            <Tooltip title={s.error ?? ''}>
                              <Chip color="warning" label="could not read" />
                            </Tooltip>
                          ) : (
                            <Chip variant="outlined" label="not fetched" />
                          )}{' '}
                          {u.replace(/^https?:\/\//, '').slice(0, 40)}
                        </Box>
                      );
                    })}
                  </TableCell>
                  <TableCell>
                    <Chip
                      color={STATUS[r.status]!.color}
                      variant={STATUS[r.status]!.color === 'default' ? 'outlined' : 'filled'}
                      label={STATUS[r.status]!.label}
                    />
                  </TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    {r.status === 'confirmed' && (
                      <>
                        <Button
                          size="small"
                          variant="outlined"
                          onClick={() =>
                            act(
                              () => refreshIntegrationDocs(r.id),
                              `Read the documentation for ${r.name} again.`,
                            )
                          }
                        >
                          Refresh docs
                        </Button>{' '}
                        <Button
                          size="small"
                          variant="outlined"
                          onClick={() =>
                            act(
                              () => retireIntegration(r.id),
                              `${r.name} is retired. Its hosts are closed.`,
                            )
                          }
                        >
                          Retire
                        </Button>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>
      <AddForm onAdded={load} />
    </>
  );
}

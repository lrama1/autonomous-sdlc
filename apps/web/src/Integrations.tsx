import { useCallback, useEffect, useState } from 'react';
import type { IntegrationDto } from '@sdlc/schemas';
import {
  ApiProblem,
  createIntegration,
  getIntegrations,
  refreshIntegrationDocs,
  retireIntegration,
} from './api';
import type { NewIntegration } from './api';

const STATUS: Record<string, { chip: string; label: string }> = {
  confirmed: { chip: 'ok', label: 'Confirmed' },
  proposed: { chip: 'warn', label: 'Waiting for confirmation' },
  rejected: { chip: '', label: 'Rejected' },
  retired: { chip: '', label: 'Retired' },
};

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

  return (
    <form
      className="card form"
      onSubmit={async (e) => {
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
      <h3>Add an external system</h3>
      <p className="small muted">
        Adding it confirms it: agents may then open connections to these hosts, and nothing else
        outside GitHub and the package registries. Use a plain hostname, with no wildcard or path.
      </p>
      <div className="row wrap">
        <input
          aria-label="Name"
          placeholder="Name, for example Weather API"
          value={f.name}
          onChange={(e) => set('name', e.target.value)}
          required
        />
        <input
          aria-label="Hosts"
          className="wide"
          placeholder="Hosts, for example api.weather.example.com"
          value={f.hosts}
          onChange={(e) => set('hosts', e.target.value)}
        />
      </div>
      <div className="row wrap">
        <input
          aria-label="Documentation links"
          className="wide"
          placeholder="Documentation links (https), separated by spaces"
          value={f.docs}
          onChange={(e) => set('docs', e.target.value)}
        />
      </div>
      <div className="row wrap">
        <select
          aria-label="Kind"
          value={f.kind}
          onChange={(e) => set('kind', e.target.value as typeof f.kind)}
        >
          <option value="third_party">Third party (a vendor or public API)</option>
          <option value="second_party">Second party (another team's system)</option>
        </select>
        <select
          aria-label="How to test"
          value={f.testStrategy}
          onChange={(e) => set('testStrategy', e.target.value as typeof f.testStrategy)}
        >
          {Object.entries(TEST).map(([k, v]) => (
            <option key={k} value={k}>
              Test with: {v}
            </option>
          ))}
        </select>
        <select
          aria-label="Authentication"
          value={f.authType}
          onChange={(e) => set('authType', e.target.value as typeof f.authType)}
        >
          <option value="none">No authentication</option>
          <option value="api_key">API key</option>
          <option value="oauth">OAuth</option>
          <option value="basic">Basic</option>
        </select>
        <input
          aria-label="Credential name"
          placeholder="Test credential name in the secrets store"
          value={f.credentialRef}
          onChange={(e) => set('credentialRef', e.target.value)}
        />
        <input
          aria-label="Owner"
          placeholder="Owner"
          value={f.owner}
          onChange={(e) => set('owner', e.target.value)}
        />
        <button className="primary" type="submit" disabled={busy}>
          Add and confirm
        </button>
      </div>
      {problem && (
        <p role="alert" className="callout warn">
          {problem}
        </p>
      )}
    </form>
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
      <div className="page-head">
        <div>
          <h1>Integrations</h1>
          <p className="muted">
            The external systems agents may call, where to learn them, and how to test them. A
            sandbox can reach only the hosts of confirmed entries. A new system an agent needs
            arrives in the attention queue as a hard stop.
          </p>
        </div>
      </div>
      {error && (
        <p role="alert" className="callout warn">
          {error}
        </p>
      )}
      {note && (
        <p className="callout ok" data-testid="note">
          {note}
        </p>
      )}
      <table className="t" data-testid="integrations">
        <thead>
          <tr>
            <th>System</th>
            <th>Hosts</th>
            <th>Test with</th>
            <th>Documentation</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows?.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                None yet. Agents may reach GitHub and the package registries only.
              </td>
            </tr>
          )}
          {rows?.map((r) => (
            <tr key={r.id}>
              <td>
                <b>{r.name}</b>
                <div className="small muted">
                  {r.kind === 'second_party' ? 'Second party' : 'Third party'}
                  {r.owner ? `, owner ${r.owner}` : ''}
                </div>
              </td>
              <td className="mono">{r.hosts.join(', ') || 'none'}</td>
              <td className="small">
                {TEST[r.testStrategy]}
                {r.testStrategy === 'none' && r.status === 'confirmed' && (
                  <div className="chip warn">no way to test it safely</div>
                )}
              </td>
              <td className="small">
                {r.docs.length === 0 && <span className="muted">no links</span>}
                {r.docs.map((u) => {
                  const s = r.snapshots.find((x) => x.url === u);
                  return (
                    <div key={u}>
                      {s?.ok ? (
                        <span className="chip ok">saved {s.fetchedAt.slice(0, 10)}</span>
                      ) : s ? (
                        <span className="chip warn" title={s.error ?? ''}>
                          could not read
                        </span>
                      ) : (
                        <span className="chip">not fetched</span>
                      )}{' '}
                      {u.replace(/^https?:\/\//, '').slice(0, 40)}
                    </div>
                  );
                })}
              </td>
              <td>
                <span className={`chip ${STATUS[r.status]!.chip}`}>{STATUS[r.status]!.label}</span>
              </td>
              <td>
                {r.status === 'confirmed' && (
                  <>
                    <button
                      onClick={() =>
                        act(
                          () => refreshIntegrationDocs(r.id),
                          `Read the documentation for ${r.name} again.`,
                        )
                      }
                    >
                      Refresh docs
                    </button>{' '}
                    <button
                      onClick={() =>
                        act(
                          () => retireIntegration(r.id),
                          `${r.name} is retired. Its hosts are closed.`,
                        )
                      }
                    >
                      Retire
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <AddForm onAdded={load} />
    </>
  );
}

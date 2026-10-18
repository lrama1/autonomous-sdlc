import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createServer as createVite } from 'vite';
import { createDb, hat, person, runMigrations } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import { PERSONAS, startDevIdp } from '@sdlc/dev-idp';
import type { Role } from '@sdlc/schemas';

const execFileP = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export interface StackOptions {
  dataDir?: string;
  /** Extra environment for the API process, for example BLOCKING_MAX_S. */
  apiEnv?: Record<string, string>;
  ports?: { web?: number; api?: number; gateway?: number; idp?: number; db?: number };
  log?: (line: string) => void;
}

export interface Stack {
  publicUrl: string;
  apiUrl: string;
  gatewayUrl: string;
  idpUrl: string;
  databaseUrl: string;
  stop: () => Promise<void>;
}

// Roles ("hats") for the dev personas. People and hats live in the platform database.
const DEV_HATS: Record<string, Role[]> = {
  'dev-alice': ['product_owner'],
  'dev-bob': ['backend_engineer', 'frontend_engineer'],
  'dev-cara': ['architect'],
  'dev-admin': ['platform_admin'],
};

async function seedDevPeople(databaseUrl: string): Promise<void> {
  const { db, pool } = createDb(databaseUrl);
  try {
    for (const p of PERSONAS) {
      const [row] = await db
        .insert(person)
        .values({ oidcSubject: p.sub, displayName: p.name, email: p.email })
        .onConflictDoUpdate({
          target: person.oidcSubject,
          set: { displayName: p.name, email: p.email },
        })
        .returning();
      for (const role of DEV_HATS[p.sub] ?? []) {
        await db.insert(hat).values({ personId: row!.id, role }).onConflictDoNothing();
      }
    }
  } finally {
    await pool.end();
  }
}

function spawnNode(
  name: string,
  cwd: string,
  env: Record<string, string>,
  log: (l: string) => void,
): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const forward = (buf: Buffer) => {
    for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) log(`[${name}] ${line}`);
  };
  child.stdout?.on('data', forward);
  child.stderr?.on('data', forward);
  return child;
}

async function waitFor(url: string, what: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - start > timeoutMs) throw new Error(`${what} did not become ready at ${url}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Starts the whole local stack without Docker: PostgreSQL, dev IdP, API, gateway, and the web dev server. */
export async function startStack(opts: StackOptions = {}): Promise<Stack> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const ports = { web: 5173, api: 8080, gateway: 8787, idp: 9000, db: 54329, ...opts.ports };
  const dataDir = opts.dataDir ?? path.join(repoRoot, '.dev-data');
  const publicUrl = `http://localhost:${ports.web}`;
  const idpUrl = `http://localhost:${ports.idp}`;
  const apiUrl = `http://localhost:${ports.api}`;
  const gatewayUrl = `http://localhost:${ports.gateway}`;

  const stoppers: Array<() => Promise<void>> = [];
  const stop = async () => {
    for (const s of stoppers.reverse()) await s().catch(() => {});
  };

  try {
    const dbh = await startDevDb({ dataDir: path.join(dataDir, 'postgres'), port: ports.db });
    stoppers.push(dbh.stop);
    log(`[db] PostgreSQL ready on port ${ports.db}`);

    await runMigrations(dbh.url);
    await seedDevPeople(dbh.url);
    log('[db] migrated and seeded dev people');

    const clientSecret = 'dev-client-secret';
    const idp = await startDevIdp({
      port: ports.idp,
      issuer: idpUrl,
      clientId: 'sdlc-web',
      clientSecret,
      redirectUris: [`${publicUrl}/auth/callback`],
    });
    stoppers.push(idp.stop);
    log(`[idp] dev identity provider on ${idpUrl}`);

    const api = spawnNode(
      'api',
      path.join(repoRoot, 'apps/api'),
      {
        SDLC_ENV: 'local',
        API_PORT: String(ports.api),
        PUBLIC_URL: publicUrl,
        DATABASE_URL: dbh.url,
        OIDC_ISSUER: idpUrl,
        OIDC_CLIENT_ID: 'sdlc-web',
        OIDC_CLIENT_SECRET: clientSecret,
        SESSION_SECRET: 'dev-session-secret-0123456789abcdef0123',
        SECRETS_FILE: path.join(dataDir, 'secrets.json'),
        AGENTS_DIR: path.join(repoRoot, 'agents'),
        RULES_FILE: path.join(repoRoot, 'rules', 'triggers.yaml'),
        GATEWAY_URL: gatewayUrl,
        RUNNER_ADAPTER: 'process',
        RUNS_DIR: path.join(dataDir, 'runs'),
        RUNNER_ENTRY: path.join(repoRoot, 'apps', 'runner', 'src', 'main.ts'),
        ...opts.apiEnv,
      },
      log,
    );
    stoppers.push(async () => void api.kill());
    if (opts.apiEnv?.RUNNER_ADAPTER === 'docker') {
      // The API is stopped hard on Windows, so it cannot tidy up. Remove its sandboxes and proxy here.
      stoppers.push(async () => {
        const { stdout } = await execFileP('docker', [
          'ps',
          '-aq',
          '--filter',
          'label=sdlc.managed=true',
        ]);
        const ids = stdout.split(/\s+/).filter(Boolean);
        if (ids.length) await execFileP('docker', ['rm', '-f', ...ids]);
      });
    }

    const agentsKey = process.env.OPENROUTER_API_KEY ?? '';
    if (!agentsKey)
      log('[gateway] OPENROUTER_API_KEY is not set: model calls will fail until it is');
    const gateway = spawnNode(
      'gateway',
      path.join(repoRoot, 'apps/gateway'),
      {
        GATEWAY_PORT: String(ports.gateway),
        DATABASE_URL: dbh.url,
        OPENROUTER_KEY_AGENTS: agentsKey || 'not-set',
      },
      log,
    );
    stoppers.push(async () => void gateway.kill());

    await waitFor(`${apiUrl}/readyz`, 'api');
    await waitFor(`${gatewayUrl}/healthz`, 'gateway');
    log(`[api] ready on ${apiUrl}`);
    log(`[gateway] ready on ${gatewayUrl}`);

    process.env.WEB_PORT = String(ports.web);
    process.env.API_ORIGIN = apiUrl;
    const vite = await createVite({ root: path.join(repoRoot, 'apps/web'), logLevel: 'warn' });
    await vite.listen();
    stoppers.push(() => vite.close());
    log(`[web] ${publicUrl}`);

    return { publicUrl, apiUrl, gatewayUrl, idpUrl, databaseUrl: dbh.url, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

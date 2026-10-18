import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { agentRun, costRecord, createDb, createRunFixture, runMigrations } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import { gatewayConfigSchema, parseEnv } from '@sdlc/schemas';
import { createGatewayServer } from '@sdlc/gateway';

// Live check, run by hand: real Claude Code, through the real gateway, to the real provider.
// It spends a few cents from the agents key. Not part of `pnpm verify`.
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY is not set');

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-live-'));
const work = await mkdtemp(path.join(os.tmpdir(), 'sdlc-live-work-'));
const dbh = await startDevDb({ dataDir, port: 56340 });
await runMigrations(dbh.url);
const { db, pool } = createDb(dbh.url);
const fixture = await createRunFixture(db, { budgetMicros: 500_000 });

const config = parseEnv(gatewayConfigSchema, { DATABASE_URL: dbh.url, OPENROUTER_KEY_AGENTS: key });
const calls: Array<Record<string, unknown>> = [];
const server = createGatewayServer({ db, config, log: (e) => e.msg === 'call' && calls.push(e) });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const gwUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

let ok: boolean;
try {
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      'claude',
      [
        '-p',
        'Use the Write tool to create hello.txt containing the word hello, then reply DONE.',
        '--setting-sources',
        'project',
        '--strict-mcp-config',
        '--model',
        'agent-default',
        '--permission-mode',
        'bypassPermissions',
        '--max-turns',
        '5',
        '--output-format',
        'json',
      ],
      {
        cwd: work,
        shell: false,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: gwUrl,
          ANTHROPIC_AUTH_TOKEN: fixture.token,
          ANTHROPIC_API_KEY: '',
          ANTHROPIC_MODEL: 'agent-default',
        },
      },
    );
    let buf = '';
    child.stdout.on('data', (d) => (buf += d));
    child.stderr.on('data', (d) => (buf += d));
    child.on('error', reject);
    child.on('exit', () => resolve(buf));
  });

  const file = await readFile(path.join(work, 'hello.txt'), 'utf8').catch(() => null);
  const rows = await db.select().from(costRecord).where(eq(costRecord.runId, fixture.runId));
  const [run] = await db.select().from(agentRun).where(eq(agentRun.id, fixture.runId));
  const sum = rows.reduce((a, r) => a + r.costMicros, 0);
  const tokens = rows.reduce((a, r) => a + r.inputTokens + r.cacheWriteTokens + r.cachedTokens, 0);

  console.log(`claude said: ${out.slice(0, 160).replace(/\s+/g, ' ')}`);
  console.log(`hello.txt: ${JSON.stringify(file)}`);
  console.log(
    `model calls: ${rows.length}, input tokens: ${tokens}, cost: $${(sum / 1e6).toFixed(4)}`,
  );
  console.log(
    `agent_run.cost_micros: ${run!.costMicros} (must equal the sum of cost records: ${sum})`,
  );
  console.log(
    `providers seen in gateway log: ${[...new Set(calls.map((c) => c.model))].join(', ')}`,
  );
  ok = file?.trim() === 'hello' && rows.length >= 2 && run!.costMicros === sum && sum > 0;
} finally {
  await new Promise((r) => server.close(r));
  await pool.end();
  await dbh.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
console.log(ok ? 'LIVE CHECK PASSED' : 'LIVE CHECK FAILED');
process.exit(ok ? 0 : 1);

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerPreviewHost, PreviewStartError, previewNames } from './docker-preview.js';
import { runSmoke } from './smoke.js';

// Real containers. Needs Docker and the image from `pnpm --filter @sdlc/runner image`. Skipped otherwise.
const IMAGE = 'sdlc-runner:dev';
function dockerReady(): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const haveDocker = dockerReady();
const d = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const dTry = (...args: string[]) => {
  try {
    return d(...args);
  } catch {
    return '';
  }
};

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

let dir: string;
let host: DockerPreviewHost;
const ids: string[] = [];
const newId = () => {
  const id = randomUUID();
  ids.push(id);
  return id;
};

/** A gzipped tar the way GitHub makes one: everything inside a single top folder. */
async function archive(files: Record<string, string>): Promise<Buffer> {
  const work = await mkdtemp(path.join(dir, 'src-'));
  const top = path.join(work, 'owner-repo-abc1234');
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(top, name)), { recursive: true });
    await writeFile(path.join(top, name), text);
  }
  const out = path.join(work, 'a.tgz');
  execFileSync('tar', ['-czf', out, '-C', work, 'owner-repo-abc1234']);
  return readFile(out);
}

const SERVER = `
const http = require('http'), fs = require('fs');
http.createServer((req, res) => {
  if (req.url === '/probe') {
    const get = async (url) => {
      try { const r = await fetch(url, { signal: AbortSignal.timeout(4000) }); return 'HTTP ' + r.status; }
      catch (e) { return 'FAIL ' + ((e.cause && e.cause.code) || e.name); }
    };
    const connect = (h) => new Promise((ok) => {
      const px = new URL(process.env.HTTPS_PROXY);
      const q = http.request({ host: px.hostname, port: Number(px.port), method: 'CONNECT', path: h + ':443', timeout: 8000 });
      q.on('connect', (r) => { ok('HTTP ' + r.statusCode); q.destroy(); });
      q.on('timeout', () => { ok('FAIL timeout'); q.destroy(); });
      q.on('error', (e) => ok('FAIL ' + e.code));
      q.end();
    });
    const attempt = (f) => { try { f(); return 'ALLOWED'; } catch (e) { return e.code; } };
    (async () => {
      const out = {
        env: Object.keys(process.env).filter((k) => /^SDLC|TOKEN|SECRET|KEY/i.test(k)),
        uid: process.getuid(),
        internet: await get('https://example.com'),
        hostDirect: await get('http://host.docker.internal:9/'),
        connectDenied: await connect('example.com'),
        connectAllowed: await connect('registry.npmjs.org'),
        writeEtc: attempt(() => fs.writeFileSync('/etc/pwned', '1')),
        writeWork: attempt(() => fs.writeFileSync('/work/ok', '1')),
      };
      res.end(JSON.stringify(out));
    })();
    return;
  }
  res.end('hello from preview: ' + (fs.existsSync('/work/installed.txt') ? fs.readFileSync('/work/installed.txt', 'utf8').trim() : 'no install'));
}).listen(Number(process.env.PORT), process.env.HOST);
`;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-prev-'));
  host = new DockerPreviewHost({
    image: IMAGE,
    memory: '256m',
    allowHosts: ['registry.npmjs.org'],
    startTimeoutMs: 60_000,
    egressName: `sdlc-prevegress-test-${randomUUID().slice(0, 8)}`,
    log: () => {},
  });
});

afterAll(async () => {
  for (const id of ids) await host?.stop(id);
  await host?.close?.();
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const leftovers = (id: string) => {
  const n = previewNames(id);
  return [
    dTry('ps', '-aq', '--filter', `name=${n.container}`),
    dTry('ps', '-aq', '--filter', `name=${n.forwarder}`),
    dTry('network', 'ls', '-q', '--filter', `name=${n.network}`),
    dTry('volume', 'ls', '-q', '--filter', `name=${n.volume}`),
  ].filter(Boolean);
};

describe.skipIf(!haveDocker)('the Docker preview host', () => {
  it('runs a pull request in a sandbox, answers on a local port, and cleans up', async () => {
    const id = newId();
    const port = await freePort();
    const { url } = await host.start({
      id,
      hostPort: port,
      archive: await archive({ 'server.js': SERVER }),
      config: {
        install: 'echo installed-ok > /work/installed.txt',
        start: 'node server.js',
        port: 3000,
        readyPath: '/',
      },
    });
    expect(url).toBe(`http://127.0.0.1:${port}/`);
    expect(await (await fetch(url)).text()).toBe('hello from preview: installed-ok');

    const probe = (await (await fetch(`http://127.0.0.1:${port}/probe`)).json()) as Record<
      string,
      unknown
    >;
    expect(probe.env).toEqual([]);
    expect(probe.uid).not.toBe(0);
    expect(probe.internet).toMatch(/^FAIL/);
    expect(probe.hostDirect).toMatch(/^FAIL/);
    expect(probe.connectDenied).toBe('HTTP 403');
    expect(probe.connectAllowed).toBe('HTTP 200');
    expect(probe.writeEtc).not.toBe('ALLOWED');
    expect(probe.writeWork).toBe('ALLOWED');
    expect(leftovers(id).length).toBe(4);

    await host.stop(id);
    expect(leftovers(id)).toEqual([]);
    await host.stop(id);
    await expect(fetch(url, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
  }, 120_000);

  it('lets the install and the start each change folder, as people write them', async () => {
    const id = newId();
    const port = await freePort();
    const { url } = await host.start({
      id,
      hostPort: port,
      archive: await archive({ 'app/server.js': SERVER }),
      config: {
        install: 'cd app && echo from-app > /work/installed.txt',
        start: 'cd app && node server.js',
        port: 3000,
        readyPath: '/',
      },
    });
    expect(await (await fetch(url)).text()).toBe('hello from preview: from-app');
    await host.stop(id);
  }, 120_000);

  it('says what the preview printed when it stops before it answers, and leaves nothing behind', async () => {
    const id = newId();
    const err = await host
      .start({
        id,
        hostPort: await freePort(),
        archive: await archive({ 'server.js': 'console.log("boot")' }),
        config: { install: null, start: 'node missing.js', port: 3000, readyPath: '/' },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreviewStartError);
    expect((err as Error).message).toMatch(/stopped before it answered/);
    expect((err as Error).message).toMatch(/Cannot find module/);
    expect(leftovers(id)).toEqual([]);
  }, 120_000);

  it('reports a busy host port, and reconcile removes what an earlier process left', async () => {
    const first = newId();
    const port = await freePort();
    await host.start({
      id: first,
      hostPort: port,
      archive: await archive({ 'server.js': SERVER }),
      config: { install: null, start: 'node server.js', port: 3000, readyPath: '/' },
    });
    const second = newId();
    const err = await host
      .start({
        id: second,
        hostPort: port,
        archive: await archive({ 'server.js': SERVER }),
        config: { install: null, start: 'node server.js', port: 3000, readyPath: '/' },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreviewStartError);
    expect((err as PreviewStartError).portBusy).toBe(true);
    expect(leftovers(second)).toEqual([]);

    await host.reconcile();
    expect(leftovers(first)).toEqual([]);
  }, 180_000);
});

// The smoke test, against a real preview in a real sandbox: HTTP checks from outside, commands from inside.
const APP = `
const http = require('http');
http.createServer((req, res) => {
  if (req.url === '/health') return res.end('ok');
  if (req.url === '/items') return res.end(JSON.stringify({ items: [{ id: 1 }] }));
  if (req.url === '/broken') { res.statusCode = 500; return res.end('database is down'); }
  res.statusCode = 404; res.end('nothing here');
}).listen(Number(process.env.PORT), process.env.HOST);
`;
// A check written by the repository: it asks the running app, from inside the sandbox, and exits 1 when it is wrong.
const SMOKE_SCRIPT = `
fetch('http://127.0.0.1:' + process.env.PORT + '/items')
  .then((r) => r.json())
  .then((b) => { if (!b.items.length) { console.error('no items'); process.exit(1); } console.log('items ok: ' + b.items.length); })
  .catch((e) => { console.error(String(e)); process.exit(1); });
`;

describe.skipIf(!haveDocker)('a smoke test against a real preview', () => {
  it('runs HTTP checks and commands, tells a good app from a broken one, and leaves nothing behind', async () => {
    const id = newId();
    const port = await freePort();
    const { url } = await host.start({
      id,
      hostPort: port,
      archive: await archive({ 'server.js': APP, 'smoke.js': SMOKE_SCRIPT }),
      config: { install: null, start: 'node server.js', port: 3000, readyPath: '/health' },
    });
    const base = url.replace(/\/$/, '');
    const exec = (command: string, ms: number) => host.exec!(id, command, ms);

    const good = await runSmoke({
      baseUrl: base,
      exec,
      checks: [
        { kind: 'get', path: '/health', status: 200, contains: null },
        { kind: 'get', path: '/items', status: 200, contains: '"items"' },
        { kind: 'run', command: 'node smoke.js' },
        { kind: 'run', command: 'pwd' },
      ],
    });
    expect(good.results.map((r) => [r.label, r.ok, r.detail])).toEqual([
      ['GET /health', true, '200'],
      ['GET /items', true, '200'],
      ['run node smoke.js', true, 'items ok: 1'],
      ['run pwd', true, '/work'],
    ]);
    expect(good.passed).toBe(true);

    const bad = await runSmoke({
      baseUrl: base,
      exec,
      checks: [
        { kind: 'get', path: '/broken', status: 200, contains: null },
        { kind: 'get', path: '/health', status: 200, contains: 'fine' },
        { kind: 'get', path: '/nope', status: 200, contains: null },
        { kind: 'run', command: 'echo no items >&2; exit 1' },
      ],
    });
    expect(bad.passed).toBe(false);
    expect(bad.results.map((r) => r.ok)).toEqual([false, false, false, false]);
    expect(bad.results[0]!.detail).toBe('expected 200, got 500: database is down');
    expect(bad.results[3]!.detail).toBe('exit 1: no items');

    // A command that runs too long is stopped and reported, not waited for.
    const slow = await host.exec!(id, 'sleep 30', 1500);
    expect(slow.exitCode).toBe(-1);
    expect(slow.output).toContain('stopped after');

    await host.stop(id);
    expect(leftovers(id)).toEqual([]);
  }, 180_000);
});

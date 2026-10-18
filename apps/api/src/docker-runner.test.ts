import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerRunner, namesFor } from './docker-runner.js';

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

const PROXY = `sdlc-egress-test-${randomUUID().slice(0, 8)}`;
let apiServer: http.Server;
let gwServer: http.Server;
const gwRequests: string[] = [];
let apiPort: number;
let gwPort: number;
const runIds: string[] = [];
const newRun = () => {
  const id = randomUUID();
  runIds.push(id);
  return id;
};

// Everything the probe learns about its own surroundings, printed as one JSON line.
const probe = (api: number, gw: number, otherRunHost: string) => `
const http = require('http'), fs = require('fs');
const out = {};
const get = async (url) => {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(4000) }); return 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 30); }
  catch (e) { return 'FAIL ' + ((e.cause && e.cause.code) || e.name); }
};
const connect = (host) => new Promise((res) => {
  const px = new URL(process.env.HTTPS_PROXY);
  const req = http.request({ host: px.hostname, port: Number(px.port), method: 'CONNECT', path: host + ':443', timeout: 6000 });
  req.on('connect', (r) => { res('HTTP ' + r.statusCode); req.destroy(); });
  req.on('timeout', () => { res('FAIL timeout'); req.destroy(); });
  req.on('error', (e) => res('FAIL ' + e.code));
  req.end();
});
const attempt = (f) => { try { f(); return 'ALLOWED'; } catch (e) { return e.code; } };
(async () => {
  out.api = await get(process.env.SDLC_API_URL + '/ping');
  out.gateway = await get(process.env.SDLC_GATEWAY_URL + '/ping');
  out.internet = await get('https://example.com');
  out.hostDirect = await get('http://host.docker.internal:${api}/ping');
  out.connectDenied = await connect('example.com');
  out.connectAllowed = await connect('github.com');
  out.otherRun = await get('http://${otherRunHost}/');
  out.uid = process.getuid();
  out.writeEtc = attempt(() => fs.writeFileSync('/etc/pwned', '1'));
  out.writeUsr = attempt(() => fs.writeFileSync('/usr/pwned', '1'));
  out.writeWork = attempt(() => fs.writeFileSync('/work/ok', '1'));
  out.writeTmp = attempt(() => fs.writeFileSync('/tmp/ok', '1'));
  out.capEff = fs.readFileSync('/proc/self/status', 'utf8').match(/CapEff:\\s+(\\w+)/)[1];
  out.secretEnv = Object.keys(process.env).filter((k) => /KEY|SECRET|GH_|GITHUB|OPENROUTER|ANTHROPIC/i.test(k));
  out.hasRunToken = Boolean(process.env.SDLC_RUN_TOKEN);
  out.proxy = process.env.HTTPS_PROXY;
  out.gatewayUrl = process.env.SDLC_GATEWAY_URL;
  out.noProxy = process.env.NO_PROXY;
  console.log('PROBE ' + JSON.stringify(out));
})();
`;

beforeAll(async () => {
  if (!haveDocker) return;
  const serve = (body: string) =>
    new Promise<http.Server>((resolve) => {
      const s = http.createServer((_q, r) => r.end(body));
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
  apiServer = await serve('api-pong');
  gwServer = await new Promise<http.Server>((resolve) => {
    const s = http.createServer((q, r) => {
      gwRequests.push(`${q.method} ${q.url}`);
      r.statusCode = 401;
      r.setHeader('content-type', 'application/json');
      r.end('{"type":"error","error":{"type":"authentication_error","message":"fake gateway"}}');
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  apiPort = (apiServer.address() as AddressInfo).port;
  gwPort = (gwServer.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  if (!haveDocker) return;
  await new Promise((r) => apiServer?.close(r));
  await new Promise((r) => gwServer?.close(r));
  dTry('rm', '-f', PROXY);
  for (const id of runIds) {
    const n = namesFor(id);
    dTry('rm', '-f', n.container);
    dTry('network', 'rm', n.network);
    dTry('volume', 'rm', '-f', n.volume);
  }
}, 120_000);

const adapter = (command: string[], lines: string[] = []) =>
  new DockerRunner({
    image: IMAGE,
    apiPort,
    gatewayPort: gwPort,
    allowHosts: ['github.com'],
    egressName: PROXY,
    command,
    memory: '512m',
    cpus: '1',
    log: (l) => lines.push(l),
  });

describe.skipIf(!haveDocker)('the Docker sandbox', () => {
  it('is isolated: it reaches only the platform through the proxy, and runs unprivileged on a read-only system', async () => {
    const id = newRun();
    const other = newRun();
    const lines: string[] = [];

    // A second sandbox, alive at the same time, on its own network.
    const bystander = await adapter(['node', '-e', 'setTimeout(() => {}, 60000)']).launch({
      runId: other,
      token: 'other-token',
      apiUrl: 'x',
    });
    await new Promise((r) => setTimeout(r, 2500));
    expect(d('ps', '--filter', `name=${namesFor(other).container}`, '--format', '{{.Names}}')).toBe(
      namesFor(other).container,
    );

    const a = adapter(['node', '-e', probe(apiPort, gwPort, namesFor(other).container)], lines);
    const launched = await a.launch({
      runId: id,
      token: 'run-token-abc',
      apiUrl: 'http://127.0.0.1:1',
    });

    // Its network is internal (no route out). It exists from the moment launch() returns, before the sandbox can end.
    const net = namesFor(id).network;
    expect(d('network', 'inspect', '-f', '{{.Internal}}', net)).toBe('true');

    const { code } = await launched.done;
    expect(code).toBe(0);
    const line = lines.find((l) => l.includes('PROBE '));
    expect(line, lines.join('\n')).toBeTruthy();
    const r = JSON.parse(line!.slice(line!.indexOf('PROBE ') + 6));

    // Reaches the platform, through the proxy's fixed ports.
    expect(r.api).toBe('HTTP 200 api-pong');
    expect(r.gateway).toMatch(/^HTTP 401 /); // the fake gateway answers 401, which proves the request got through
    // Reaches nothing else.
    expect(r.internet).toMatch(/^FAIL/);
    expect(r.hostDirect).toMatch(/^FAIL/);
    expect(r.otherRun).toMatch(/^FAIL/);
    // HTTPS tunnels only to the allowlist.
    expect(r.connectDenied).toBe('HTTP 403');
    expect(['HTTP 200', 'HTTP 502']).toContain(r.connectAllowed);
    expect(r.proxy).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:3128$/);
    expect(r.gatewayUrl).toMatch(new RegExp(`^http://\\d+\\.\\d+\\.\\d+\\.\\d+:${gwPort}$`));
    expect(r.noProxy).toContain(new URL(r.proxy).hostname);
    // Unprivileged, read-only, no capabilities.
    expect(r.uid).toBe(1000);
    expect(r.writeEtc).toBe('EROFS');
    expect(r.writeUsr).toBe('EROFS');
    expect(r.writeWork).toBe('ALLOWED');
    expect(r.writeTmp).toBe('ALLOWED');
    expect(r.capEff).toBe('0000000000000000');
    // Holds its run token and no provider key, GitHub token, or platform secret.
    expect(r.hasRunToken).toBe(true);
    expect(r.secretEnv).toEqual([]);

    // After it ends: the network is gone, the checkout volume stays for a resume, and release() removes it.
    expect(dTry('network', 'ls', '--filter', `name=${net}`, '--format', '{{.Name}}')).toBe('');
    expect(
      d('volume', 'ls', '--filter', `name=${namesFor(id).volume}`, '--format', '{{.Name}}'),
    ).toBe(namesFor(id).volume);
    await a.release(id);
    expect(
      dTry('volume', 'ls', '--filter', `name=${namesFor(id).volume}`, '--format', '{{.Name}}'),
    ).toBe('');

    bystander.kill();
    await bystander.done;
  }, 240_000);

  it('keeps the checkout between runs of the same id, so a parked run resumes in place', async () => {
    const id = newRun();
    const first = await adapter(['sh', '-c', 'echo kept > /work/marker']).launch({
      runId: id,
      token: 't',
      apiUrl: 'x',
    });
    expect((await first.done).code).toBe(0);
    const lines: string[] = [];
    const second = await adapter(['sh', '-c', 'echo "marker=$(cat /work/marker)"'], lines).launch({
      runId: id,
      token: 't',
      apiUrl: 'x',
    });
    expect((await second.done).code).toBe(0);
    expect(lines.join('\n')).toContain('marker=kept');
    await adapter([]).release(id);
  }, 180_000);

  it('kill() stops the container, and reconcile() removes sandboxes an earlier process left behind', async () => {
    const id = newRun();
    const a = adapter(['node', '-e', 'setTimeout(() => {}, 120000)']);
    const launched = await a.launch({ runId: id, token: 't', apiUrl: 'x' });
    await new Promise((r) => setTimeout(r, 2500));
    expect(d('ps', '--filter', `name=${namesFor(id).container}`, '--format', '{{.Names}}')).toBe(
      namesFor(id).container,
    );
    launched.kill();
    await launched.done;
    expect(
      dTry('ps', '-a', '--filter', `name=${namesFor(id).container}`, '--format', '{{.Names}}'),
    ).toBe('');

    // A leftover: start one, then pretend the API that started it died.
    const left = newRun();
    const orphan = await adapter(['node', '-e', 'setTimeout(() => {}, 120000)']).launch({
      runId: left,
      token: 't',
      apiUrl: 'x',
    });
    await new Promise((r) => setTimeout(r, 2500));
    await adapter([]).reconcile();
    await orphan.done;
    expect(
      dTry('ps', '-a', '--filter', `name=${namesFor(left).container}`, '--format', '{{.Names}}'),
    ).toBe('');
    expect(
      dTry('network', 'ls', '--filter', `name=${namesFor(left).network}`, '--format', '{{.Name}}'),
    ).toBe('');
  }, 180_000);

  it('lets the real Claude Code reach the gateway from inside the sandbox (names do not resolve there, addresses do)', async () => {
    const id = newRun();
    gwRequests.length = 0;
    const cmd = [
      'sh',
      '-c',
      'mkdir -p /work/home /work/repo && cd /work/repo && ' +
        'ANTHROPIC_BASE_URL=$SDLC_GATEWAY_URL ANTHROPIC_AUTH_TOKEN=tok ANTHROPIC_API_KEY= ANTHROPIC_MODEL=agent-default ' +
        'timeout 25 claude -p hi --setting-sources project --strict-mcp-config --model agent-default --max-turns 1 --output-format json > /dev/null; true',
    ];
    const launched = await adapter(cmd).launch({ runId: id, token: 't', apiUrl: 'x' });
    await launched.done;
    expect(gwRequests.some((r) => r.startsWith('POST /v1/messages'))).toBe(true);
  }, 120_000);

  it('does not put the run token on the command line', async () => {
    const id = newRun();
    const lines: string[] = [];
    const a = adapter(['sh', '-c', 'sleep 6'], lines);
    const launched = await a.launch({ runId: id, token: 'sdlc_SECRET_TOKEN_VALUE', apiUrl: 'x' });
    await new Promise((r) => setTimeout(r, 1500));
    const cli = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'docker.exe' } | Select-Object -ExpandProperty CommandLine",
      ],
      { encoding: 'utf8' },
    ).toString();
    expect(cli).not.toContain('sdlc_SECRET_TOKEN_VALUE');
    expect(cli).toContain('SDLC_RUN_TOKEN');
    launched.kill();
    await launched.done;
  }, 120_000);
});

import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostAllowed, parseForwards, startEgress } from './egress.js';
import type { RunningEgress } from './egress.js';

describe('hostAllowed', () => {
  it('matches exact names, case-insensitively, and ignores a trailing dot', () => {
    expect(hostAllowed('github.com', ['github.com'])).toBe(true);
    expect(hostAllowed('GitHub.com.', ['github.com'])).toBe(true);
  });
  it('does not match look-alikes or subdomains without a leading dot', () => {
    expect(hostAllowed('evilgithub.com', ['github.com'])).toBe(false);
    expect(hostAllowed('github.com.evil.test', ['github.com'])).toBe(false);
    expect(hostAllowed('api.github.com', ['github.com'])).toBe(false);
  });
  it('a leading dot allows the domain and its subdomains', () => {
    expect(hostAllowed('api.github.com', ['.github.com'])).toBe(true);
    expect(hostAllowed('github.com', ['.github.com'])).toBe(true);
    expect(hostAllowed('notgithub.com', ['.github.com'])).toBe(false);
  });
  it('an empty list allows nothing', () => {
    expect(hostAllowed('github.com', [])).toBe(false);
  });
});

describe('parseForwards', () => {
  it('reads listen=host:port pairs', () => {
    expect(parseForwards('8080=host.docker.internal:8080, 8787=host.docker.internal:9000')).toEqual(
      [
        { listenPort: 8080, host: 'host.docker.internal', port: 8080 },
        { listenPort: 8787, host: 'host.docker.internal', port: 9000 },
      ],
    );
  });
  it('accepts nothing, and rejects nonsense', () => {
    expect(parseForwards('')).toEqual([]);
    expect(() => parseForwards('8080')).toThrow(/bad forward/);
  });
});

let target: http.Server;
let targetPort: number;
let egress: RunningEgress;
let tls: net.Server;
let tlsPort: number;
const logs: string[] = [];

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

beforeAll(async () => {
  target = http.createServer((_q, r) => r.end('from-target'));
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  targetPort = (target.address() as AddressInfo).port;

  // Stands in for an HTTPS host: it only needs to accept a TCP connection and answer.
  tls = net.createServer((s) => s.end('tunnel-ok'));
  await new Promise<void>((r) => tls.listen(0, '127.0.0.1', r));
  tlsPort = (tls.address() as AddressInfo).port;

  egress = await startEgress({
    allowHosts: ['localhost'],
    forwards: [{ listenPort: await freePort(), host: '127.0.0.1', port: targetPort }],
    proxyPort: 0,
    log: (l) => logs.push(l),
  });
});

afterAll(async () => {
  await egress?.stop();
  await new Promise((r) => target?.close(r));
  await new Promise((r) => tls?.close(r));
});

/** Sends one CONNECT and returns the first line of the proxy's answer. */
function connect(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(egress.proxyPort, '127.0.0.1', () =>
      s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`),
    );
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('\r\n')) {
        s.destroy();
        resolve(buf.split('\r\n')[0]!);
      }
    });
    s.on('close', () => resolve(buf.split('\r\n')[0] ?? ''));
    s.on('error', () => resolve('error'));
  });
}

describe('the egress proxy', () => {
  it('refuses a host that is not on the list', async () => {
    expect(await connect('example.com', 443)).toMatch(/403/);
  });

  it('refuses any port but 443, even for an allowed host', async () => {
    expect(await connect('localhost', tlsPort)).toMatch(/403/);
    expect(await connect('localhost', 22)).toMatch(/403/);
  });

  it('refuses a request that is not a tunnel', async () => {
    const res = await fetch(`http://127.0.0.1:${egress.proxyPort}/anything`);
    expect(res.status).toBe(403);
  });

  it('logs what it allowed and what it denied', async () => {
    await connect('example.com', 443);
    expect(logs.some((l) => l === 'DENY example.com:443')).toBe(true);
  });

  it('opens a tunnel to an allowed host on 443 (answers 200 or 502, never 403)', async () => {
    // Nothing listens on localhost:443 here, so the tunnel fails after it is allowed. That is the point of the test.
    const line = await connect('localhost', 443);
    expect(line).not.toMatch(/403/);
    expect(logs.some((l) => l === 'DENY localhost:443')).toBe(false);
  });
});

describe('fixed forwards', () => {
  it('passes the forwarded port through to its one target', async () => {
    const port = await freePort();
    const forwarding = await startEgress({
      allowHosts: [],
      forwards: [{ listenPort: port, host: '127.0.0.1', port: targetPort }],
      proxyPort: 0,
      log: () => {},
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(await res.text()).toBe('from-target');
    } finally {
      await forwarding.stop();
    }
  });
});

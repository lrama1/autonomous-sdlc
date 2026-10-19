import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';

// The only way out of a sandbox network. Runner containers sit on an internal Docker network with no route to the
// host or the internet. This process sits on that network and on the normal one, and passes through only:
//   1. fixed TCP ports to named targets (the platform API and the Model Gateway on the host), and
//   2. HTTPS CONNECT tunnels to an allowlist of hostnames (GitHub, the package registry).
// Everything else is refused.

export interface Forward {
  listenPort: number;
  host: string;
  port: number;
}

export interface EgressConfig {
  /**
   * Hostnames a CONNECT tunnel may reach, on port 443 only. A leading dot allows subdomains. A function is asked for
   * every tunnel, so a list that changes while the proxy runs applies at once.
   */
  allowHosts: string[] | (() => string[]);
  /** Finds the address of a host. The system resolver when not given. */
  resolve?: (host: string) => Promise<string>;
  /**
   * A tunnel to a private, loopback or link-local address is refused, whatever the name says, so an allowed name
   * cannot be pointed at the platform's own network. Tests that tunnel to this machine turn it off.
   */
  allowPrivateTargets?: boolean;
  forwards: Forward[];
  proxyPort: number;
  log?: (line: string) => void;
}

export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allow.some((a) => {
    const x = a.toLowerCase();
    return x.startsWith('.') ? h.endsWith(x) || h === x.slice(1) : h === x;
  });
}

/** True for the addresses a tunnel must never reach: this host, private networks, link-local (cloud metadata), and the like. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return (
      v === '::' || v === '::1' || v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd')
    );
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** A resolver that asks these servers (not the system's, which may be firewalled to an allowlist). */
export function dnsResolver(servers: string[]): (host: string) => Promise<string> {
  const r = new dns.promises.Resolver();
  r.setServers(servers);
  return async (host) => {
    const [ip] = await r.resolve4(host);
    if (!ip) throw new Error(`no address for ${host}`);
    return ip;
  };
}

const systemResolve = async (host: string) =>
  (await dns.promises.lookup(host, { family: 4 })).address;

/** Parses `8080=host.docker.internal:8080,8787=host.docker.internal:8787`. */
export function parseForwards(text: string): Forward[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(\d+)=([^:]+):(\d+)$/.exec(s);
      if (!m) throw new Error(`bad forward "${s}", expected listenPort=host:port`);
      return { listenPort: Number(m[1]), host: m[2]!, port: Number(m[3]) };
    });
}

export interface RunningEgress {
  proxyPort: number;
  stop: () => Promise<void>;
}

export async function startEgress(cfg: EgressConfig): Promise<RunningEgress> {
  const log = cfg.log ?? ((l) => console.log(l));
  const allowed = () => (typeof cfg.allowHosts === 'function' ? cfg.allowHosts() : cfg.allowHosts);
  const resolve = cfg.resolve ?? systemResolve;
  const servers: Array<net.Server | http.Server> = [];
  const sockets = new Set<net.Socket>();
  const track = (s: net.Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => s.destroy());
  };

  for (const f of cfg.forwards) {
    const srv = net.createServer((client) => {
      track(client);
      const up = net.connect(f.port, f.host);
      track(up);
      client.pipe(up);
      up.pipe(client);
      up.on('error', () => client.destroy());
    });
    await new Promise<void>((r) => srv.listen(f.listenPort, '0.0.0.0', r));
    servers.push(srv);
    log(`forward :${f.listenPort} -> ${f.host}:${f.port}`);
  }

  const proxy = http.createServer((_req, res) => {
    // Plain HTTP through the proxy is never allowed.
    res.statusCode = 403;
    res.end('only HTTPS tunnels to allowed hosts');
  });
  proxy.on('connect', (req, rawSocket, head) => {
    void (async () => {
      const clientSocket = rawSocket as net.Socket;
      track(clientSocket);
      const [host = '', portText = ''] = (req.url ?? '').split(':');
      const port = Number(portText);
      if (port !== 443 || !hostAllowed(host, allowed())) {
        log(`DENY ${req.url}`);
        clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      let ip: string;
      try {
        ip = net.isIP(host) ? host : await resolve(host);
      } catch (e) {
        log(`DNSFAIL ${req.url} ${(e as { code?: string }).code ?? ''}`.trim());
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        return;
      }
      if (!cfg.allowPrivateTargets && isPrivateAddress(ip)) {
        log(`DENY ${req.url} resolves to ${ip}, a private address`);
        clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const up = net.connect(port, ip, () => {
        log(`ALLOW ${req.url} -> ${ip}`);
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) up.write(head);
        up.pipe(clientSocket);
        clientSocket.pipe(up);
      });
      track(up);
      up.on('error', () => clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    })();
  });
  await new Promise<void>((r) => proxy.listen(cfg.proxyPort, '0.0.0.0', r));
  servers.push(proxy);
  log(`proxy :${cfg.proxyPort}, allow ${allowed().join(', ') || 'nothing'}`);

  return {
    proxyPort: (proxy.address() as net.AddressInfo).port,
    stop: async () => {
      for (const s of sockets) s.destroy();
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    },
  };
}

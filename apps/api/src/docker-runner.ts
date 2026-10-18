import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { LaunchInput, Launched, RunnerAdapter } from './launcher.js';

const run = promisify(execFile);

export interface DockerRunnerOptions {
  image: string;
  /** Host port of the platform API and of the Model Gateway. The sandbox reaches them only through the egress proxy. */
  apiPort: number;
  gatewayPort: number;
  /**
   * Hostnames the sandbox may open HTTPS tunnels to. A function is asked at every launch, so hosts of newly confirmed
   * integrations apply to the next run (the shared proxy is restarted when the list changes).
   */
  allowHosts: string[] | (() => Promise<string[]>);
  memory?: string;
  cpus?: string;
  /** Name of the shared proxy container. Tests use their own so they do not disturb a running dev stack. */
  egressName?: string;
  /** Replaces the image's command. For tests only. */
  command?: string[];
  log?: (line: string) => void;
}

/** The name sandboxes use for the proxy, on their own network. The container behind it may be named anything. */
export const EGRESS_ALIAS = 'sdlc-egress';
const MANAGED = 'sdlc.managed=true';
const PROXY_PORT = 3128;

/** The container, network, and volume names for one run. */
export const namesFor = (runId: string) => ({
  container: `sdlc-run-${runId}`,
  network: `sdlc-net-${runId}`,
  volume: `sdlc-work-${runId}`,
});

async function docker(
  args: string[],
  opts: { allowFail?: boolean } = {},
): Promise<{ out: string; ok: boolean }> {
  try {
    const { stdout } = await run('docker', args, { maxBuffer: 16 * 1024 * 1024 });
    return { out: stdout.trim(), ok: true };
  } catch (e) {
    if (opts.allowFail) return { out: String((e as { stderr?: string }).stderr ?? ''), ok: false };
    const err = e as { stderr?: string; message: string };
    throw new Error(
      `docker ${args[0]} ${args[1] ?? ''} failed: ${(err.stderr || err.message).trim().slice(0, 400)}`,
      { cause: e },
    );
  }
}

interface Inspected {
  State?: { Running?: boolean };
  Config?: { Labels?: Record<string, string> };
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
}

/**
 * `docker inspect` as JSON. Go templates need quotes, and quotes inside arguments do not survive Windows, so the
 * output is parsed here instead. Null when the container does not exist.
 */
async function inspect(container: string): Promise<Inspected | null> {
  const r = await docker(['inspect', container], { allowFail: true });
  if (!r.ok) return null;
  try {
    return (JSON.parse(r.out) as Inspected[])[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Each run gets its own container on its own **internal** Docker network: no route to the host, to the internet, or to
 * another run. The only neighbour is the shared egress proxy (apps/runner/src/egress.ts), which forwards two fixed
 * ports to the platform and tunnels HTTPS to an allowlist. The container runs as an unprivileged user with a read-only
 * root file system, no capabilities, and limits on memory, CPU, and processes. Its checkout lives in a named volume so
 * a parked run resumes in the same place.
 */
export class DockerRunner implements RunnerAdapter {
  private egressReady: Promise<void> | null = null;

  private get egress(): string {
    return this.opts.egressName ?? EGRESS_ALIAS;
  }

  constructor(private readonly opts: DockerRunnerOptions) {}

  private log(line: string) {
    (this.opts.log ?? ((l) => console.log(l)))(line);
  }

  private egressConfig(hosts: string[]) {
    const forwards = `${this.opts.apiPort}=host.docker.internal:${this.opts.apiPort},${this.opts.gatewayPort}=host.docker.internal:${this.opts.gatewayPort}`;
    const allow = [...new Set(hosts)].sort().join(',');
    // A change to the allowlist or ports replaces the proxy, which is found by this label.
    const hash = createHash('sha256')
      .update(`${this.opts.image}|${forwards}|${allow}`)
      .digest('hex')
      .slice(0, 16);
    return { forwards, allow, hash };
  }

  /** Starts the shared egress proxy if it is not running with the current settings. One start at a time. */
  private ensureEgress(): Promise<void> {
    this.egressReady ??= (async () => {
      const hosts =
        typeof this.opts.allowHosts === 'function'
          ? await this.opts.allowHosts()
          : this.opts.allowHosts;
      const cfg = this.egressConfig(hosts);
      const cur = await inspect(this.egress);
      if (cur?.State?.Running && cur.Config?.Labels?.['sdlc.egress'] === cfg.hash) return;
      await docker(['rm', '-f', this.egress], { allowFail: true });
      await docker([
        'run',
        '-d',
        '--name',
        this.egress,
        '--label',
        MANAGED,
        '--label',
        `sdlc.egress=${cfg.hash}`,
        '--add-host',
        'host.docker.internal:host-gateway',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--memory',
        '256m',
        '--pids-limit',
        '256',
        '-e',
        `EGRESS_ALLOW=${cfg.allow}`,
        '-e',
        `EGRESS_FORWARDS=${cfg.forwards}`,
        '-e',
        `EGRESS_PROXY_PORT=${PROXY_PORT}`,
        this.opts.image,
        'node',
        '/app/egress.mjs',
      ]);
      this.log(`[docker] started ${this.egress} (allow ${cfg.allow || 'nothing'})`);
    })().finally(() => {
      this.egressReady = null;
    });
    return this.egressReady;
  }

  /** The proxy's address on a run's network. Docker can take a moment to assign it after 
etwork connect. */
  private async addressOn(network: string): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const info = await inspect(this.egress);
      const ip = info?.NetworkSettings?.Networks?.[network]?.IPAddress ?? '';
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`no address for ${this.egress} on ${network}`);
  }

  async launch(input: LaunchInput): Promise<Launched> {
    const n = namesFor(input.runId);
    await this.ensureEgress();
    await docker([
      'network',
      'create',
      '--internal',
      '--label',
      MANAGED,
      '--label',
      `sdlc.run=${input.runId}`,
      n.network,
    ]);
    let proxyHost: string;
    try {
      await docker(['network', 'connect', '--alias', EGRESS_ALIAS, n.network, this.egress]);
      // The sandbox is given the proxy's address, not its name. Claude Code's DNS resolver fails on container names
      // on an internal network (getaddrinfo ENOTIMP), so with a name it never reached the gateway.
      proxyHost = await this.addressOn(n.network);
    } catch (e) {
      await docker(['network', 'rm', n.network], { allowFail: true });
      throw e;
    }

    const base = `http://${proxyHost}`;
    const args = [
      'run',
      '--rm',
      '--init',
      '--name',
      n.container,
      '--label',
      MANAGED,
      '--label',
      `sdlc.run=${input.runId}`,
      '--network',
      n.network,
      '-v',
      `${n.volume}:/work`,
      '--read-only',
      '--tmpfs',
      '/tmp:rw,size=512m',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--memory',
      this.opts.memory ?? '3g',
      '--cpus',
      this.opts.cpus ?? '2',
      '--pids-limit',
      '1024',
      // The token is passed by name so it never appears in a process list. Docker reads it from its own environment.
      '-e',
      'SDLC_RUN_TOKEN',
      '-e',
      `SDLC_API_URL=${base}:${this.opts.apiPort}`,
      '-e',
      `SDLC_GATEWAY_URL=${base}:${this.opts.gatewayPort}`,
      '-e',
      `SDLC_MCP_URL=${base}:${this.opts.apiPort}/mcp`,
      '-e',
      'SDLC_WORK_DIR=/work',
      '-e',
      `HTTPS_PROXY=${base}:${PROXY_PORT}`,
      '-e',
      `https_proxy=${base}:${PROXY_PORT}`,
      '-e',
      `NO_PROXY=${proxyHost},localhost,127.0.0.1`,
      '-e',
      `no_proxy=${proxyHost},localhost,127.0.0.1`,
      this.opts.image,
      ...(this.opts.command ?? []),
    ];
    const child = spawn('docker', args, {
      env: { ...process.env, SDLC_RUN_TOKEN: input.token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const prefix = `[runner ${input.runId.slice(0, 8)}]`;
    const forward = (buf: Buffer) => {
      for (const line of buf.toString().split(/\r?\n/))
        if (line.trim()) this.log(`${prefix} ${line}`);
    };
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);

    const done = new Promise<{ code: number | null }>((resolve) => {
      const end = (code: number | null) => {
        // The run's network goes with the container. The volume stays until release().
        void (async () => {
          await docker(['network', 'disconnect', '-f', n.network, this.egress], {
            allowFail: true,
          });
          await docker(['network', 'rm', n.network], { allowFail: true });
          resolve({ code });
        })();
      };
      child.on('error', () => end(null));
      child.on('exit', (code) => end(code));
    });
    return { done, kill: () => void docker(['kill', n.container], { allowFail: true }) };
  }

  /** The shared proxy is not needed while nothing runs. It is started again by the next launch. */
  async close(): Promise<void> {
    await docker(['rm', '-f', this.egress], { allowFail: true });
  }

  async release(runId: string): Promise<void> {
    await docker(['volume', 'rm', '-f', namesFor(runId).volume], { allowFail: true });
  }

  /** Removes run containers and networks that outlived the API process. Volumes are kept, since a run may resume. */
  async reconcile(): Promise<void> {
    const list = async (kind: 'ps' | 'network ls') =>
      (
        await docker(
          [
            ...kind.split(' '),
            kind === 'ps' ? '-aq' : '-q',
            '--filter',
            `label=${MANAGED}`,
            '--filter',
            'label=sdlc.run',
          ],
          { allowFail: true },
        )
      ).out
        .split(/\s+/)
        .filter(Boolean);
    const containers = await list('ps');
    if (containers.length) await docker(['rm', '-f', ...containers], { allowFail: true });
    for (const net of await list('network ls')) {
      await docker(['network', 'disconnect', '-f', net, this.egress], { allowFail: true });
      await docker(['network', 'rm', net], { allowFail: true });
    }
    if (containers.length)
      this.log(
        `[docker] removed ${containers.length} sandbox container(s) from an earlier session`,
      );
  }
}

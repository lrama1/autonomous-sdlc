import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type { PreviewStartConfig } from '@sdlc/core';
import { MANAGED, docker, inspect } from './docker-runner.js';

/**
 * Where a preview runs. Docker on this machine today; a Fargate task later would implement the same three calls, so
 * nothing above this interface changes.
 */
export interface PreviewHost {
  /** Starts the pull request's code and returns once it answers. Throws PreviewStartError with what went wrong. */
  start(spec: {
    id: string;
    archive: Buffer;
    config: PreviewStartConfig;
    hostPort: number;
  }): Promise<{ url: string; target?: string }>;
  // `target` is where the platform itself reaches the preview, when a reviewer cannot (Fargate).
  /**
   * Runs one command inside a running preview's sandbox, in the folder the code is in, and returns its exit code and
   * output. Left out by a host that cannot. A command that runs past `timeoutMs` is stopped and reported as exit -1.
   */
  exec?(
    id: string,
    command: string,
    timeoutMs: number,
  ): Promise<{ exitCode: number; output: string }>;
  /** Removes everything one preview created. Safe to call twice. */
  stop(id: string): Promise<void>;
  /** Removes previews left by an earlier API process. */
  reconcile(): Promise<void>;
  close?(): Promise<void>;
}

export class PreviewStartError extends Error {
  constructor(
    message: string,
    readonly portBusy = false,
  ) {
    super(message);
  }
}

export interface DockerPreviewOptions {
  image: string;
  memory: string;
  /** Hosts the install step may reach over HTTPS. */
  allowHosts: string[];
  /** How long to wait for the preview to answer, install included. */
  startTimeoutMs?: number;
  /** Name of the shared proxy. Tests use their own. */
  egressName?: string;
  log?: (line: string) => void;
}

const run = promisify(execFile);

/** What a container printed, both streams (a program's error output is on stderr, which `docker()` does not return). */
async function logsOf(container: string): Promise<string> {
  try {
    const { stdout, stderr } = await run('docker', ['logs', '--tail', '40', container], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return `${stdout}\n${stderr}`;
  } catch {
    return '';
  }
}

const LABEL = 'sdlc.preview';
const PROXY_PORT = 3128;
const FORWARD_PORT = 8080;

export const previewNames = (id: string) => ({
  container: `sdlc-preview-${id}`,
  forwarder: `sdlc-prevfwd-${id}`,
  network: `sdlc-prevnet-${id}`,
  volume: `sdlc-prevwork-${id}`,
});

/** The last lines of a log, trimmed to a size that fits in a message. */
const tail = (text: string, lines = 25, chars = 1500) =>
  text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n').slice(-chars);

/**
 * Runs a pull request's code for a reviewer, in Docker, with the same care as an agent sandbox and a little more: the
 * code is unreviewed and nobody trusts it yet.
 *
 * - It runs on its own **internal** network, as the unprivileged image user, with a read-only root file system, no
 *   capabilities, and limits on memory, CPU, and processes. It is given no environment from the platform: no token, no
 *   key, no address of the API or the gateway.
 * - The only way out is a proxy of its own (not the agents' one) that tunnels HTTPS to a short list of hosts, so the
 *   install can reach the package registry and nothing else.
 * - The only way in is a forwarder container that publishes one port on 127.0.0.1 and passes it to the preview.
 * - The code is fetched here, by the platform, and copied in. The sandbox never holds a GitHub credential.
 */
export class DockerPreviewHost implements PreviewHost {
  private egressReady: Promise<void> | null = null;

  constructor(private readonly opts: DockerPreviewOptions) {}

  private get egress() {
    return this.opts.egressName ?? 'sdlc-preview-egress';
  }

  private log(line: string) {
    (this.opts.log ?? ((l) => console.log(l)))(line);
  }

  private ensureEgress(): Promise<void> {
    this.egressReady ??= (async () => {
      const allow = [...new Set(this.opts.allowHosts)].sort().join(',');
      const hash = createHash('sha256')
        .update(`${this.opts.image}|${allow}`)
        .digest('hex')
        .slice(0, 16);
      const cur = await inspect(this.egress);
      if (cur?.State?.Running && cur.Config?.Labels?.['sdlc.egress'] === hash) return;
      await docker(['rm', '-f', this.egress], { allowFail: true });
      await docker([
        'run',
        '-d',
        '--name',
        this.egress,
        '--label',
        MANAGED,
        '--label',
        `sdlc.egress=${hash}`,
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--memory',
        '128m',
        '--pids-limit',
        '128',
        '-e',
        `EGRESS_ALLOW=${allow}`,
        '-e',
        'EGRESS_FORWARDS=',
        '-e',
        `EGRESS_PROXY_PORT=${PROXY_PORT}`,
        this.opts.image,
        'node',
        '/app/egress.mjs',
      ]);
      this.log(`[preview] started ${this.egress} (allow ${allow || 'nothing'})`);
    })().finally(() => {
      this.egressReady = null;
    });
    return this.egressReady;
  }

  private async addressOn(network: string): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const ip =
        (await inspect(this.egress))?.NetworkSettings?.Networks?.[network]?.IPAddress ?? '';
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new PreviewStartError(`no address for the proxy on ${network}`);
  }

  /** Unpacks the pull request's archive into the volume, in a container with no network at all. */
  private async extract(volume: string, archive: Buffer, id: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'docker',
        [
          'run',
          '-i',
          '--rm',
          '--label',
          MANAGED,
          '--label',
          `${LABEL}=${id}`,
          '--network',
          'none',
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--memory',
          '256m',
          '--pids-limit',
          '64',
          '-v',
          `${volume}:/work`,
          this.opts.image,
          'tar',
          'xzf',
          '-',
          '--strip-components=1',
          '--no-same-owner',
          '-C',
          '/work',
        ],
        { stdio: ['pipe', 'ignore', 'pipe'] },
      );
      let err = '';
      child.stderr?.on('data', (b: Buffer) => (err += b.toString()));
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0
          ? resolve()
          : reject(new PreviewStartError(`could not unpack the code: ${tail(err, 5, 400)}`)),
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end(archive);
    });
  }

  async start(spec: {
    id: string;
    archive: Buffer;
    config: PreviewStartConfig;
    hostPort: number;
  }): Promise<{ url: string }> {
    const n = previewNames(spec.id);
    const label = ['--label', MANAGED, '--label', `${LABEL}=${spec.id}`];
    try {
      await docker(['volume', 'create', ...label, n.volume]);
      await this.extract(n.volume, spec.archive, spec.id);
      await this.ensureEgress();
      await docker(['network', 'create', '--internal', ...label, n.network]);
      await docker(['network', 'connect', n.network, this.egress]);
      const proxy = await this.addressOn(n.network);
      const base = `http://${proxy}:${PROXY_PORT}`;
      // Each command runs in its own subshell, so a `cd` in the install does not change where start runs.
      const script = `${spec.config.install ? `(${spec.config.install}) && ` : ''}(${spec.config.start})`;
      await docker([
        'run',
        '-d',
        '--init',
        '--name',
        n.container,
        ...label,
        '--network',
        n.network,
        '--network-alias',
        'preview',
        '-v',
        `${n.volume}:/work`,
        '--read-only',
        '--tmpfs',
        '/tmp:rw,size=256m',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--memory',
        this.opts.memory,
        '--cpus',
        '1',
        '--pids-limit',
        '256',
        '-e',
        `PORT=${spec.config.port}`,
        '-e',
        'HOST=0.0.0.0',
        '-e',
        'CI=true',
        '-e',
        'HOME=/tmp',
        '-e',
        'npm_config_cache=/tmp/npm',
        '-e',
        `HTTPS_PROXY=${base}`,
        '-e',
        `https_proxy=${base}`,
        '-e',
        `NO_PROXY=${proxy},localhost,127.0.0.1`,
        '-e',
        `no_proxy=${proxy},localhost,127.0.0.1`,
        this.opts.image,
        'sh',
        '-c',
        script,
      ]);
      // The forwarder is the egress program with one forward and an empty allowlist, so it passes one port and no tunnels.
      const fwd = await docker(
        [
          'run',
          '-d',
          '--name',
          n.forwarder,
          ...label,
          '-p',
          `127.0.0.1:${spec.hostPort}:${FORWARD_PORT}`,
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--memory',
          '64m',
          '--pids-limit',
          '64',
          '-e',
          'EGRESS_ALLOW=',
          '-e',
          `EGRESS_FORWARDS=${FORWARD_PORT}=preview:${spec.config.port}`,
          '-e',
          'EGRESS_PROXY_PORT=3129',
          this.opts.image,
          'node',
          '/app/egress.mjs',
        ],
        { allowFail: true },
      );
      if (!fwd.ok) {
        throw new PreviewStartError(
          `could not publish port ${spec.hostPort}: ${tail(fwd.out, 3, 300)}`,
          /port is already allocated|address already in use|ports are not available/i.test(fwd.out),
        );
      }
      await docker(['network', 'connect', n.network, n.forwarder]);

      const url = `http://127.0.0.1:${spec.hostPort}`;
      const deadline = Date.now() + (this.opts.startTimeoutMs ?? 240_000);
      for (;;) {
        const info = await inspect(n.container);
        if (!info?.State?.Running) {
          const logs = await logsOf(n.container);
          throw new PreviewStartError(
            `the preview stopped before it answered. Its output ended: ${tail(logs, 12, 900) || '(nothing)'}`,
          );
        }
        try {
          const r = await fetch(`${url}${spec.config.readyPath}`, {
            signal: AbortSignal.timeout(3000),
            redirect: 'manual',
          });
          await r.arrayBuffer().catch(() => {});
          if (r.status < 500) return { url: `${url}/` };
        } catch {
          // not listening yet
        }
        if (Date.now() > deadline) {
          const logs = await logsOf(n.container);
          throw new PreviewStartError(
            `the preview did not answer on port ${spec.config.port} in time. Its output ended: ${tail(logs, 12, 900) || '(nothing)'}`,
          );
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (e) {
      await this.stop(spec.id);
      throw e;
    }
  }

  async exec(
    id: string,
    command: string,
    timeoutMs: number,
  ): Promise<{ exitCode: number; output: string }> {
    const n = previewNames(id);
    return await new Promise((resolve) => {
      const child = spawn('docker', ['exec', '-w', '/work', n.container, 'sh', '-c', command], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      const keep = (b: Buffer) => (output = (output + b.toString()).slice(-16_000));
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ exitCode: -1, output: `could not run the command: ${e.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(
          timedOut
            ? { exitCode: -1, output: `${output}\nstopped after ${Math.round(timeoutMs / 1000)} s` }
            : { exitCode: code ?? -1, output },
        );
      });
    });
  }

  async stop(id: string): Promise<void> {
    const n = previewNames(id);
    await docker(['rm', '-f', n.forwarder, n.container], { allowFail: true });
    await docker(['network', 'disconnect', '-f', n.network, this.egress], { allowFail: true });
    await docker(['network', 'rm', n.network], { allowFail: true });
    await docker(['volume', 'rm', '-f', n.volume], { allowFail: true });
  }

  async reconcile(): Promise<void> {
    const ids = async (kind: string[], q: string[]) =>
      (await docker([...kind, ...q, '--filter', `label=${LABEL}`], { allowFail: true })).out
        .split(/\s+/)
        .filter(Boolean);
    const containers = await ids(['ps'], ['-aq']);
    if (containers.length) await docker(['rm', '-f', ...containers], { allowFail: true });
    for (const net of await ids(['network', 'ls'], ['-q'])) {
      await docker(['network', 'disconnect', '-f', net, this.egress], { allowFail: true });
      await docker(['network', 'rm', net], { allowFail: true });
    }
    const vols = await ids(['volume', 'ls'], ['-q']);
    if (vols.length) await docker(['volume', 'rm', '-f', ...vols], { allowFail: true });
    if (containers.length)
      this.log(`[preview] removed ${containers.length} container(s) from an earlier session`);
  }

  async close(): Promise<void> {
    await docker(['rm', '-f', this.egress], { allowFail: true });
  }
}

import {
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';
import type { Task } from '@aws-sdk/client-ecs';
import { GetLogEventsCommand, CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { PreviewConfig } from '@sdlc/core';
import { PreviewStartError } from './docker-preview.js';
import type { PreviewHost } from './docker-preview.js';
import type { EcsLike } from './fargate-runner.js';

/** Where a preview's code waits for its task. The task has no credentials, so it gets an address that works once and for a while. */
export interface CodeStore {
  put(id: string, archive: Buffer): Promise<string>;
  remove(id: string): Promise<void>;
}

export class S3CodeStore implements CodeStore {
  constructor(
    private readonly bucket: string,
    private readonly s3: S3Client = new S3Client({}),
  ) {}

  private key(id: string) {
    return `previews/${id}/code.tgz`;
  }

  async put(id: string, archive: Buffer) {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: this.key(id), Body: archive }),
    );
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: this.key(id) }), {
      expiresIn: 3600,
    });
  }

  async remove(id: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(id) }));
  }
}

/** What a task printed, newest lines, for the message when it does not come up. */
export interface TaskLogs {
  tail(taskId: string): Promise<string>;
}

export class CloudWatchTaskLogs implements TaskLogs {
  constructor(
    private readonly group: string,
    private readonly prefix = 'preview/preview',
    private readonly client: CloudWatchLogsClient = new CloudWatchLogsClient({}),
  ) {}

  async tail(taskId: string) {
    try {
      const r = await this.client.send(
        new GetLogEventsCommand({
          logGroupName: this.group,
          logStreamName: `${this.prefix}/${taskId}`,
          limit: 40,
        }),
      );
      return (r.events ?? []).map((e) => e.message ?? '').join('\n');
    } catch {
      return '';
    }
  }
}

export interface FargatePreviewOptions {
  cluster: string;
  /** The task definition's family. */
  taskDefinition: string;
  subnets: string[];
  securityGroups: string[];
  code: CodeStore;
  /** The address a reviewer opens: the platform's signed-in door to the preview, not the preview itself. */
  openUrl: (id: string) => string;
  container?: string;
  ecs?: EcsLike;
  logs?: TaskLogs;
  /** Asks the preview's address for its ready path. Returns the status, or null when nothing answers. */
  probe?: (url: string) => Promise<number | null>;
  pollMs?: number;
  startTimeoutMs?: number;
  log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tail = (text: string, lines = 12, chars = 900) =>
  text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n').slice(-chars);

const defaultProbe = async (url: string): Promise<number | null> => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
    await r.arrayBuffer().catch(() => {});
    return r.status;
  } catch {
    return null;
  }
};

/**
 * Runs a pull request's code for a reviewer as one Fargate task (spec 12.4, previews), the way the Docker host does on a
 * developer's machine. The task is in the same isolated subnet as agent runs, with no task role: its only ways out are
 * the allowlist proxy, and its only way in is the platform's own proxy, which reaches it by its private address.
 */
export class FargatePreviewHost implements PreviewHost {
  private readonly ecs: EcsLike;
  private readonly container: string;
  private readonly tasks = new Map<string, string>();

  constructor(private readonly opts: FargatePreviewOptions) {
    this.ecs = opts.ecs ?? (new ECSClient({}) as unknown as EcsLike);
    this.container = opts.container ?? 'preview';
  }

  private log(line: string) {
    (this.opts.log ?? ((l) => console.log(l)))(line);
  }

  private async describe(arn: string): Promise<Task | null> {
    const r = (await this.ecs.send(
      new DescribeTasksCommand({ cluster: this.opts.cluster, tasks: [arn] }),
    )) as { tasks?: Task[] };
    return r.tasks?.[0] ?? null;
  }

  async start(spec: {
    id: string;
    archive: Buffer;
    config: PreviewConfig;
    hostPort: number;
  }): Promise<{ url: string; target: string }> {
    const codeUrl = await this.opts.code.put(spec.id, spec.archive);
    try {
      const r = (await this.ecs.send(
        new RunTaskCommand({
          cluster: this.opts.cluster,
          taskDefinition: this.opts.taskDefinition,
          launchType: 'FARGATE',
          count: 1,
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: this.opts.subnets,
              securityGroups: this.opts.securityGroups,
              assignPublicIp: 'DISABLED',
            },
          },
          tags: [{ key: 'sdlc-preview', value: spec.id }],
          overrides: {
            containerOverrides: [
              {
                name: this.container,
                environment: [
                  { name: 'PREVIEW_CODE_URL', value: codeUrl },
                  { name: 'PREVIEW_INSTALL', value: spec.config.install ?? '' },
                  { name: 'PREVIEW_START', value: spec.config.start },
                  { name: 'PORT', value: String(spec.config.port) },
                  { name: 'HOST', value: '0.0.0.0' },
                  { name: 'HOME', value: '/tmp' },
                  { name: 'CI', value: 'true' },
                  { name: 'npm_config_cache', value: '/tmp/npm' },
                ],
              },
            ],
          },
        }),
      )) as { tasks?: Task[]; failures?: Array<{ reason?: string; detail?: string }> };
      const arn = r.tasks?.[0]?.taskArn;
      if (!arn) {
        const why = (r.failures ?? [])
          .map((f) => `${f.reason ?? ''} ${f.detail ?? ''}`.trim())
          .join('; ');
        throw new PreviewStartError(
          `ECS did not start the preview task: ${why || 'no reason given'}`,
        );
      }
      this.tasks.set(spec.id, arn);
      const taskId = arn.split('/').pop()!;
      this.log(`[preview] ${spec.id.slice(0, 8)} started task ${taskId}`);

      const deadline = Date.now() + (this.opts.startTimeoutMs ?? 300_000);
      const probe = this.opts.probe ?? defaultProbe;
      for (;;) {
        await sleep(this.opts.pollMs ?? 2000);
        const task = await this.describe(arn);
        if (!task || task.lastStatus === 'STOPPED') {
          const printed = tail(await (this.opts.logs?.tail(taskId) ?? Promise.resolve('')));
          const reason = task?.stoppedReason ? ` (${task.stoppedReason})` : '';
          throw new PreviewStartError(
            `the preview stopped before it answered${reason}. Its output ended: ${printed || '(nothing)'}`,
          );
        }
        const ip = task.attachments
          ?.flatMap((a) => a.details ?? [])
          .find((d) => d.name === 'privateIPv4Address')?.value;
        if (task.lastStatus === 'RUNNING' && ip) {
          const status = await probe(`http://${ip}:${spec.config.port}${spec.config.readyPath}`);
          if (status !== null && status < 500)
            return { url: this.opts.openUrl(spec.id), target: `http://${ip}:${spec.config.port}` };
        }
        if (Date.now() > deadline) {
          const printed = tail(await (this.opts.logs?.tail(taskId) ?? Promise.resolve('')));
          throw new PreviewStartError(
            `the preview did not answer on port ${spec.config.port} in time. Its output ended: ${printed || '(nothing)'}`,
          );
        }
      }
    } catch (e) {
      await this.stop(spec.id);
      throw e;
    }
  }

  async stop(id: string): Promise<void> {
    const arn = this.tasks.get(id);
    this.tasks.delete(id);
    if (arn)
      await this.ecs
        .send(
          new StopTaskCommand({
            cluster: this.opts.cluster,
            task: arn,
            reason: 'the preview ended',
          }),
        )
        .catch(() => {});
    await this.opts.code.remove(id).catch(() => {});
  }

  /** Stops every preview task of the family, whichever process started it. */
  async reconcile(): Promise<void> {
    let stopped = 0;
    let next: string | undefined;
    do {
      const r = (await this.ecs.send(
        new ListTasksCommand({
          cluster: this.opts.cluster,
          family: this.opts.taskDefinition,
          desiredStatus: 'RUNNING',
          nextToken: next,
        }),
      )) as { taskArns?: string[]; nextToken?: string };
      for (const arn of r.taskArns ?? []) {
        await this.ecs
          .send(
            new StopTaskCommand({
              cluster: this.opts.cluster,
              task: arn,
              reason: 'left over from an earlier API process',
            }),
          )
          .catch(() => {});
        stopped++;
      }
      next = r.nextToken;
    } while (next);
    this.tasks.clear();
    if (stopped) this.log(`[preview] stopped ${stopped} preview task(s) from an earlier session`);
  }
}

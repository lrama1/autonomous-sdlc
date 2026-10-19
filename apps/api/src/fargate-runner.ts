import {
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';
import type { Task } from '@aws-sdk/client-ecs';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { LaunchInput, Launched, RunnerAdapter } from './launcher.js';

/** The two calls the adapter makes to AWS, so tests can stand in for them. */
export interface EcsLike {
  send(command: unknown): Promise<unknown>;
}

/**
 * Where a run keeps its files while it waits for a person, between one task and the next. The runner downloads them
 * when it starts and uploads them when it parks, using addresses it is given, so the task needs no AWS credentials.
 */
export interface StateStore {
  urls(runId: string): Promise<{ get: string; put: string }>;
  remove(runId: string): Promise<void>;
}

export class S3StateStore implements StateStore {
  constructor(
    private readonly bucket: string,
    private readonly s3: S3Client = new S3Client({}),
    /** How long the addresses work. The API's own credentials set an upper limit. */
    private readonly expiresInSeconds = 6 * 3600,
  ) {}

  private key(runId: string) {
    return `runs/${runId}/state.tgz`;
  }

  async urls(runId: string) {
    const Key = this.key(runId);
    const opts = { expiresIn: this.expiresInSeconds };
    return {
      get: await getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key }), opts),
      put: await getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key }), opts),
    };
  }

  async remove(runId: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(runId) }));
  }
}

export interface FargateRunnerOptions {
  cluster: string;
  /** The task definition's family. The newest active revision runs. */
  taskDefinition: string;
  subnets: string[];
  securityGroups: string[];
  state: StateStore;
  /** The container in the task definition that holds the runner. */
  container?: string;
  ecs?: EcsLike;
  /** How often a running task is looked at. */
  pollMs?: number;
  /** How many times a start that failed to pull its image is tried again, and how long to wait between. */
  startAttempts?: number;
  retryDelayMs?: number;
  log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when the task never started because the image could not be pulled. Seen once after new endpoints (spike 6). */
export function failedToPull(task: Task): boolean {
  const reason = `${task.stoppedReason ?? ''} ${task.containers?.map((c) => c.reason ?? '').join(' ')}`;
  return task.stopCode === 'TaskFailedToStart' && /CannotPullContainerError/i.test(reason);
}

/**
 * Each run is one ECS Fargate task in an isolated subnet (infra/aws/runner.tf): no route to the internet, no task role.
 * What it can reach is set by the network, not by the program in it. The run token and the addresses of its parked
 * state are the only things passed in at start; everything else is in the task definition.
 *
 * Like the Docker adapter this keeps its bookkeeping in one API process: at start-up every task of the family that is
 * still running is a leftover and is stopped.
 */
export class FargateRunner implements RunnerAdapter {
  private readonly ecs: EcsLike;
  private readonly container: string;

  constructor(private readonly opts: FargateRunnerOptions) {
    this.ecs = opts.ecs ?? (new ECSClient({}) as unknown as EcsLike);
    this.container = opts.container ?? 'runner';
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

  private async start(input: LaunchInput, urls: { get: string; put: string }): Promise<string> {
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
        tags: [{ key: 'sdlc-run', value: input.runId }],
        overrides: {
          containerOverrides: [
            {
              name: this.container,
              environment: [
                { name: 'SDLC_RUN_TOKEN', value: input.token },
                { name: 'SDLC_STATE_GET_URL', value: urls.get },
                { name: 'SDLC_STATE_PUT_URL', value: urls.put },
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
      throw new Error(`ECS did not start the task: ${why || 'no reason given'}`);
    }
    return arn;
  }

  async launch(input: LaunchInput): Promise<Launched> {
    const urls = await this.opts.state.urls(input.runId);
    const prefix = `[fargate ${input.runId.slice(0, 8)}]`;
    const attempts = this.opts.startAttempts ?? 4;
    let killed = false;
    // The first start is awaited here, so a refusal from ECS is a failed launch the worker reports at once.
    let current = await this.start(input, urls);
    this.log(`${prefix} started ${current.split('/').pop()}`);

    const watch = async (): Promise<{ code: number | null }> => {
      for (let attempt = 1; ; attempt++) {
        const arn = current;
        let last = '';
        let failures = 0;
        for (;;) {
          await sleep(this.opts.pollMs ?? 5000);
          let task: Task | null;
          try {
            task = await this.describe(arn);
            failures = 0;
          } catch (e) {
            // A throttled or dropped call must not end a run that is going fine.
            if (++failures >= 6) throw e;
            continue;
          }
          if (!task) {
            this.log(`${prefix} the task is gone`);
            return { code: null };
          }
          if (task.lastStatus !== last) {
            last = task.lastStatus ?? '';
            this.log(`${prefix} ${last.toLowerCase()}`);
          }
          if (task.lastStatus !== 'STOPPED') continue;

          if (!killed && attempt < attempts && failedToPull(task)) {
            this.log(
              `${prefix} could not pull the image, trying again (${attempt}/${attempts - 1})`,
            );
            await sleep(this.opts.retryDelayMs ?? 15_000);
            current = await this.start(input, urls);
            this.log(`${prefix} started ${current.split('/').pop()}`);
            break;
          }
          const code = task.containers?.find((c) => c.name === this.container)?.exitCode;
          this.log(
            `${prefix} stopped: ${task.stopCode ?? ''} ${task.stoppedReason ?? ''} (exit ${code ?? 'none'})`.trim(),
          );
          return { code: code ?? null };
        }
      }
    };

    // Never rejects: the worker treats the end of this promise as the end of the run.
    const done = watch().catch((e: unknown) => {
      this.log(`${prefix} lost track of the task: ${e instanceof Error ? e.message : String(e)}`);
      return { code: null };
    });

    return {
      done,
      kill: () => {
        killed = true;
        void this.ecs
          .send(
            new StopTaskCommand({
              cluster: this.opts.cluster,
              task: current,
              reason: 'cancelled by the platform',
            }),
          )
          .catch(() => {});
      },
    };
  }

  async release(runId: string): Promise<void> {
    await this.opts.state.remove(runId);
  }

  /** Stops every task of the family that is still running. None can belong to this process. */
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
    if (stopped) this.log(`[fargate] stopped ${stopped} run(s) left over from an earlier session`);
  }
}

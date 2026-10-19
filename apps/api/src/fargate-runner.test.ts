import { describe, expect, it } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import {
  DescribeTasksCommand,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';
import type { Task } from '@aws-sdk/client-ecs';
import { FargateRunner, S3StateStore, failedToPull } from './fargate-runner.js';
import type { EcsLike, StateStore } from './fargate-runner.js';

const ARN = (n: number) => `arn:aws:ecs:us-east-1:1:task/sdlc-dev/task${n}`;
const stopped = (o: Partial<Task> = {}): Task => ({
  lastStatus: 'STOPPED',
  stopCode: 'EssentialContainerExited',
  containers: [{ name: 'runner', exitCode: 0 }],
  ...o,
});

/** An ECS that answers from scripts. Each RunTask starts the next numbered task, and each task has a script of statuses. */
class FakeEcs implements EcsLike {
  sent: unknown[] = [];
  started = 0;
  scripts: Task[][] = [];
  runFailures: unknown[] | null = null;
  listPages: Array<{ taskArns: string[]; nextToken?: string }> = [];
  describeErrors = 0;
  async send(command: unknown): Promise<unknown> {
    this.sent.push(command);
    if (command instanceof RunTaskCommand) {
      if (this.runFailures) return { tasks: [], failures: this.runFailures };
      this.started++;
      return { tasks: [{ taskArn: ARN(this.started) }] };
    }
    if (command instanceof DescribeTasksCommand) {
      if (this.describeErrors > 0) {
        this.describeErrors--;
        throw new Error('ThrottlingException');
      }
      const arn = (command.input.tasks ?? [])[0]!;
      const n = Number(arn.replace(/\D/g, '').slice(-1));
      const script = this.scripts[n - 1] ?? [stopped()];
      return { tasks: [script.length > 1 ? script.shift() : script[0]] };
    }
    if (command instanceof ListTasksCommand) return this.listPages.shift() ?? { taskArns: [] };
    return {};
  }
  of<T>(type: new (...a: never[]) => T): T[] {
    return this.sent.filter((c): c is T => c instanceof type);
  }
}

class FakeState implements StateStore {
  removed: string[] = [];
  async urls(runId: string) {
    return { get: `https://s3.test/${runId}?get`, put: `https://s3.test/${runId}?put` };
  }
  async remove(runId: string) {
    this.removed.push(runId);
  }
}

const make = (ecs: FakeEcs, state = new FakeState(), o: object = {}) => {
  const lines: string[] = [];
  const runner = new FargateRunner({
    cluster: 'sdlc-dev',
    taskDefinition: 'sdlc-dev-runner',
    subnets: ['subnet-1'],
    securityGroups: ['sg-1'],
    state,
    ecs,
    pollMs: 1,
    retryDelayMs: 1,
    log: (l) => lines.push(l),
    ...o,
  });
  return { runner, state, lines };
};
const input = { runId: '0198a9d0-1111-7000-8000-000000000000', token: 'tok-1', apiUrl: 'http://x' };

describe('the Fargate runner', () => {
  it('starts one isolated task with the run token and its state addresses, and reports the exit code', async () => {
    const ecs = new FakeEcs();
    ecs.scripts = [
      [
        { lastStatus: 'PENDING' },
        { lastStatus: 'RUNNING' },
        stopped({ containers: [{ name: 'runner', exitCode: 3 }] }),
      ],
    ];
    const { runner, lines } = make(ecs);
    const launched = await runner.launch(input);
    expect(await launched.done).toEqual({ code: 3 });

    const [run] = ecs.of(RunTaskCommand);
    expect(run!.input).toMatchObject({
      cluster: 'sdlc-dev',
      taskDefinition: 'sdlc-dev-runner',
      launchType: 'FARGATE',
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: ['subnet-1'],
          securityGroups: ['sg-1'],
          assignPublicIp: 'DISABLED',
        },
      },
      tags: [{ key: 'sdlc-run', value: input.runId }],
    });
    const env = run!.input.overrides!.containerOverrides![0]!;
    expect(env.name).toBe('runner');
    expect(Object.fromEntries(env.environment!.map((e) => [e.name, e.value]))).toEqual({
      SDLC_RUN_TOKEN: 'tok-1',
      SDLC_STATE_GET_URL: `https://s3.test/${input.runId}?get`,
      SDLC_STATE_PUT_URL: `https://s3.test/${input.runId}?put`,
    });
    expect(lines.join('\n')).toContain('running');
    expect(lines.join('\n')).toContain('exit 3');
    // The token is never written to the log.
    expect(lines.join('\n')).not.toContain('tok-1');
  });

  it('refuses to launch when ECS will not start the task, so the worker reports it at once', async () => {
    const ecs = new FakeEcs();
    ecs.runFailures = [{ reason: 'RESOURCE:CPU', detail: 'no capacity' }];
    const { runner } = make(ecs);
    await expect(runner.launch(input)).rejects.toThrow('RESOURCE:CPU no capacity');
  });

  it('starts again when the image could not be pulled, a few times, and no more', async () => {
    const pull = stopped({
      stopCode: 'TaskFailedToStart',
      stoppedReason: 'CannotPullContainerError: dial tcp 10.0.1.5:443: i/o timeout',
      containers: [{ name: 'runner' }],
    });
    const ecs = new FakeEcs();
    ecs.scripts = [[pull], [pull], [stopped()]];
    const { runner, lines } = make(ecs);
    expect(await (await runner.launch(input)).done).toEqual({ code: 0 });
    expect(ecs.started).toBe(3);
    expect(lines.join('\n')).toContain('could not pull the image, trying again (1/3)');

    const always = new FakeEcs();
    always.scripts = [[pull], [pull], [pull], [pull], [pull]];
    const second = make(always);
    expect(await (await second.runner.launch(input)).done).toEqual({ code: null });
    expect(always.started).toBe(4);
  });

  it('does not start again for any other way a task can stop', async () => {
    const ecs = new FakeEcs();
    ecs.scripts = [
      [
        stopped({
          stopCode: 'TaskFailedToStart',
          stoppedReason: 'ResourceInitializationError',
          containers: [{ name: 'runner' }],
        }),
      ],
    ];
    const { runner } = make(ecs);
    expect(await (await runner.launch(input)).done).toEqual({ code: null });
    expect(ecs.started).toBe(1);
    expect(failedToPull(stopped())).toBe(false);
  });

  it('keeps watching through a throttled call, and ends the run if the answers keep failing', async () => {
    const ecs = new FakeEcs();
    ecs.describeErrors = 3;
    ecs.scripts = [[stopped()]];
    expect(await (await make(ecs).runner.launch(input)).done).toEqual({ code: 0 });

    const bad = new FakeEcs();
    bad.describeErrors = 100;
    const b = make(bad);
    expect(await (await b.runner.launch(input)).done).toEqual({ code: null });
    expect(b.lines.join('\n')).toContain('lost track of the task: ThrottlingException');
  });

  it('stops the task when the run is cancelled', async () => {
    const ecs = new FakeEcs();
    ecs.scripts = [[{ lastStatus: 'RUNNING' }]];
    const { runner } = make(ecs);
    const launched = await runner.launch(input);
    launched.kill();
    await new Promise((r) => setTimeout(r, 5));
    const [stop] = ecs.of(StopTaskCommand);
    expect(stop!.input).toMatchObject({ cluster: 'sdlc-dev', task: ARN(1) });
  });

  it("removes a finished run's parked state", async () => {
    const { runner, state } = make(new FakeEcs());
    await runner.release(input.runId);
    expect(state.removed).toEqual([input.runId]);
  });

  it('stops every task of its family left running by an earlier process', async () => {
    const ecs = new FakeEcs();
    ecs.listPages = [{ taskArns: [ARN(1), ARN(2)], nextToken: 'n' }, { taskArns: [ARN(3)] }];
    const { runner, lines } = make(ecs);
    await runner.reconcile();
    expect(ecs.of(StopTaskCommand).map((c) => c.input.task)).toEqual([ARN(1), ARN(2), ARN(3)]);
    expect(ecs.of(ListTasksCommand)[0]!.input).toMatchObject({
      family: 'sdlc-dev-runner',
      desiredStatus: 'RUNNING',
    });
    expect(lines.join('\n')).toContain('stopped 3 run(s)');
  });
});

describe('the S3 state store', () => {
  it('signs a download and an upload address for one run, and nothing wider', async () => {
    const s3 = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
    });
    const store = new S3StateStore('sdlc-dev-runner-state-1', s3);
    const urls = await store.urls('run-1');
    for (const u of [urls.get, urls.put]) {
      const url = new URL(u);
      expect(url.hostname).toBe('sdlc-dev-runner-state-1.s3.us-east-1.amazonaws.com');
      expect(url.pathname).toBe('/runs/run-1/state.tgz');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('21600');
      expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(urls.get).not.toBe(urls.put);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DescribeTasksCommand,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';
import type { Task } from '@aws-sdk/client-ecs';
import { PreviewStartError } from './docker-preview.js';
import { FargatePreviewHost } from './fargate-preview.js';
import type { CodeStore } from './fargate-preview.js';
import type { EcsLike } from './fargate-runner.js';

const ARN = (n: number) => `arn:aws:ecs:us-east-1:1:task/sdlc-dev/prev${n}`;
const running = (ip = '10.60.20.9'): Task => ({
  lastStatus: 'RUNNING',
  attachments: [{ details: [{ name: 'privateIPv4Address', value: ip }] }],
});

class FakeEcs implements EcsLike {
  sent: unknown[] = [];
  started = 0;
  script: Task[] = [];
  failures: unknown[] | null = null;
  listed: string[] = [];
  async send(command: unknown): Promise<unknown> {
    this.sent.push(command);
    if (command instanceof RunTaskCommand) {
      if (this.failures) return { tasks: [], failures: this.failures };
      this.started++;
      return { tasks: [{ taskArn: ARN(this.started) }] };
    }
    if (command instanceof DescribeTasksCommand)
      return { tasks: [this.script.length > 1 ? this.script.shift() : this.script[0]] };
    if (command instanceof ListTasksCommand) return { taskArns: this.listed };
    return {};
  }
  of<T>(type: new (...a: never[]) => T): T[] {
    return this.sent.filter((c): c is T => c instanceof type);
  }
}

class FakeCode implements CodeStore {
  put_: Array<{ id: string; bytes: number }> = [];
  removed: string[] = [];
  async put(id: string, archive: Buffer) {
    this.put_.push({ id, bytes: archive.length });
    return `https://s3.test/previews/${id}/code.tgz?sig=1`;
  }
  async remove(id: string) {
    this.removed.push(id);
  }
}

const spec = {
  id: '0198a9d0-2222-7000-8000-000000000000',
  archive: Buffer.from('fake-archive'),
  hostPort: 9100,
  config: { install: 'npm ci', start: 'npm start', port: 4000, readyPath: '/health' },
};

function make(ecs: FakeEcs, probe: (url: string) => Promise<number | null>, o: object = {}) {
  const code = new FakeCode();
  const lines: string[] = [];
  const host = new FargatePreviewHost({
    cluster: 'sdlc-dev',
    taskDefinition: 'sdlc-dev-preview',
    subnets: ['subnet-1'],
    securityGroups: ['sg-1'],
    code,
    openUrl: (id) => `https://platform.test/api/previews/${id}/open`,
    ecs,
    probe,
    pollMs: 1,
    startTimeoutMs: 400,
    log: (l) => lines.push(l),
    ...o,
  });
  return { host, code, lines };
}

describe('the Fargate preview host', () => {
  it("uploads the code, runs one task with the commands, waits until it answers, and gives the platform's door", async () => {
    const ecs = new FakeEcs();
    ecs.script = [{ lastStatus: 'PROVISIONING' }, running(), running()];
    const probed: string[] = [];
    let calls = 0;
    const { host, code } = make(ecs, async (u) => {
      probed.push(u);
      return ++calls < 2 ? null : 200;
    });
    const out = await host.start(spec);
    expect(out).toEqual({
      url: `https://platform.test/api/previews/${spec.id}/open`,
      target: 'http://10.60.20.9:4000',
    });
    expect(code.put_).toEqual([{ id: spec.id, bytes: 'fake-archive'.length }]);
    expect(probed.every((u) => u === 'http://10.60.20.9:4000/health')).toBe(true);

    const [run] = ecs.of(RunTaskCommand);
    expect(run!.input).toMatchObject({
      cluster: 'sdlc-dev',
      taskDefinition: 'sdlc-dev-preview',
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: ['subnet-1'],
          securityGroups: ['sg-1'],
          assignPublicIp: 'DISABLED',
        },
      },
      tags: [{ key: 'sdlc-preview', value: spec.id }],
    });
    const env = Object.fromEntries(
      run!.input.overrides!.containerOverrides![0]!.environment!.map((e) => [e.name, e.value]),
    );
    expect(env).toMatchObject({
      PREVIEW_CODE_URL: `https://s3.test/previews/${spec.id}/code.tgz?sig=1`,
      PREVIEW_INSTALL: 'npm ci',
      PREVIEW_START: 'npm start',
      PORT: '4000',
      HOST: '0.0.0.0',
    });
  });

  it('says what the preview printed when its task stops before it answers, and cleans up', async () => {
    const ecs = new FakeEcs();
    ecs.script = [{ lastStatus: 'STOPPED', stoppedReason: 'Essential container in task exited' }];
    const { host, code } = make(ecs, async () => null, {
      logs: {
        tail: async (id: string) =>
          `[preview] unpacked the code\nError: cannot find module x (${id})`,
      },
    });
    const err = await host.start(spec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreviewStartError);
    expect((err as Error).message).toContain(
      'stopped before it answered (Essential container in task exited)',
    );
    expect((err as Error).message).toContain('cannot find module x (prev1)');
    expect(code.removed).toEqual([spec.id]);
    expect(ecs.of(StopTaskCommand)).toHaveLength(1);
  });

  it('gives up when nothing answers in time', async () => {
    const ecs = new FakeEcs();
    ecs.script = [running()];
    const { host } = make(ecs, async () => null, { startTimeoutMs: 20 });
    const err = await host.start(spec).catch((e: unknown) => e);
    expect((err as Error).message).toContain('did not answer on port 4000 in time');
  });

  it('reports ECS refusing to start the task', async () => {
    const ecs = new FakeEcs();
    ecs.failures = [{ reason: 'RESOURCE:MEMORY', detail: 'no capacity' }];
    const { host, code } = make(ecs, async () => 200);
    const err = await host.start(spec).catch((e: unknown) => e);
    expect((err as Error).message).toContain('RESOURCE:MEMORY no capacity');
    expect(code.removed).toEqual([spec.id]);
  });

  it('stops its task and removes the code, and does so only once', async () => {
    const ecs = new FakeEcs();
    ecs.script = [running()];
    const { host, code } = make(ecs, async () => 200);
    await host.start(spec);
    await host.stop(spec.id);
    await host.stop(spec.id);
    expect(ecs.of(StopTaskCommand).map((c) => c.input.task)).toEqual([ARN(1)]);
    expect(code.removed).toEqual([spec.id, spec.id]);
  });

  it('stops every preview task of its family at start-up', async () => {
    const ecs = new FakeEcs();
    ecs.listed = [ARN(7), ARN(8)];
    const { host, lines } = make(ecs, async () => 200);
    await host.reconcile();
    expect(ecs.of(StopTaskCommand).map((c) => c.input.task)).toEqual([ARN(7), ARN(8)]);
    expect(ecs.of(ListTasksCommand)[0]!.input).toMatchObject({
      family: 'sdlc-dev-preview',
      desiredStatus: 'RUNNING',
    });
    expect(lines.join('\n')).toContain('stopped 2 preview task(s)');
  });
});

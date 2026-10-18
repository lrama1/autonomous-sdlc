import { runSpecSchema } from '@sdlc/schemas';
import type { ExitReason, RunSpec } from '@sdlc/schemas';

/** The API says this run is over (cancelled, out of budget, finished). The runner must stop. */
export class RunInactiveError extends Error {
  constructor(message = 'the run is no longer active') {
    super(message);
  }
}

export interface PullRequestRequest {
  title: string;
  body: string;
  diff: {
    changedPaths: string[];
    linesChanged: number;
    dependencyAdded: boolean;
    testsDeletedOrSkipped: boolean;
    protectedPathsTouched: string[];
  };
  verify: { ok: boolean; command: string; attempts: number; durationMs: number; summary: string };
  summary: string;
}

export class RunnerApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (res.status === 403) throw new RunInactiveError();
    if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async spec(): Promise<RunSpec> {
    return runSpecSchema.parse(await this.call('GET', '/runner/spec'));
  }

  async status(): Promise<string> {
    return (await this.call<{ state: string }>('GET', '/runner/status')).state;
  }

  async events(events: Array<{ type: string; payload: Record<string, unknown> }>): Promise<void> {
    if (events.length === 0) return;
    await this.call('POST', '/runner/events', { events });
  }

  async running(): Promise<void> {
    await this.call('POST', '/runner/state', { state: 'running' });
  }

  async finished(exitReason: ExitReason, summary?: string): Promise<void> {
    await this.call('POST', '/runner/state', {
      state: 'finished',
      exitReason,
      ...(summary ? { summary } : {}),
    });
  }

  async trigger(
    kind: 'protected_path' | 'verify_failed',
    summary: string,
    paths: string[] = [],
  ): Promise<{ interactionId: string }> {
    return this.call('POST', '/runner/trigger', { kind, summary, paths });
  }

  async pullRequest(
    req: PullRequestRequest,
  ): Promise<{ number: number; url: string; interactionId: string }> {
    return this.call('POST', '/runner/pull-request', req);
  }
}

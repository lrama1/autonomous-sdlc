import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  assistantMessage,
  buildPlan,
  buildTask,
  createDb,
  createRunFixture,
  hat,
  interaction,
  person,
  runMigrations,
} from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { startDevDb } from '@sdlc/dev-db';
import type { DevDb } from '@sdlc/dev-db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { MemorySecrets } from './secrets.js';
import { sectionsOf, searchSections } from './assistant/docs.js';
import type { AssistantModel, Block, ChatMessage, ModelAnswer } from './assistant/model.js';
import { AssistantTools } from './assistant/tools.js';

/** A model that says what it is told to, and keeps what it was asked. */
const model = {
  replies: [] as ModelAnswer[],
  asked: [] as Array<{ system: string; messages: ChatMessage[]; tools: number }>,
};
const fakeModel: AssistantModel = {
  async complete(req) {
    model.asked.push({
      system: req.system,
      messages: structuredClone(req.messages),
      tools: req.tools.length,
    });
    const next = model.replies.shift();
    if (!next) throw new Error('the fake model has nothing to say');
    return next;
  },
};
const say = (text: string, cost = 1000): ModelAnswer => ({
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  costMicros: cost,
});
const use = (
  name: string,
  input: Record<string, unknown>,
  id = 'tu1',
  cost = 1000,
): ModelAnswer => ({
  content: [{ type: 'tool_use', id, name, input } as Block],
  stopReason: 'tool_use',
  costMicros: cost,
});

let devDb: DevDb;
let dataDir: string;
let db: Db;
let closeDb: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let off: Awaited<ReturnType<typeof buildApp>>;
let n = 0;

async function newPerson(roles: string[] = ['backend_engineer'], a = app) {
  const k = `${Date.now()}-${++n}`;
  const [p] = await db
    .insert(person)
    .values({ displayName: `Person ${k}`, email: `a${k}@example.test`, oidcSubject: `a${k}` })
    .returning();
  for (const role of roles) await db.insert(hat).values({ personId: p!.id, role });
  return {
    id: p!.id,
    headers: {
      cookie: `sdlc_session=${a.signCookie(`${p!.id}.${Math.floor(Date.now() / 1000) + 3600}`)}`,
    },
  };
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-assistant-'));
  devDb = await startDevDb({ dataDir, port: 56361 });
  await runMigrations(devDb.url);
  const made = createDb(devDb.url);
  db = made.db;
  closeDb = () => made.pool.end();
  const make = (extra: Record<string, string> = {}, withModel = true) =>
    buildApp({
      config: loadConfig({
        DATABASE_URL: devDb.url,
        OIDC_ISSUER: 'http://localhost:9000',
        OIDC_CLIENT_ID: 'x',
        OIDC_CLIENT_SECRET: 'x',
        SESSION_SECRET: 'unit-test-session-secret-0123456789abcdef',
        ASSISTANT_DAILY_CAP_USD: '0.01',
        ...extra,
      }),
      deps: made,
      workers: false,
      secrets: new MemorySecrets(),
      ...(withModel ? { assistantModel: fakeModel } : {}),
    });
  app = await make();
  await app.ready();
  off = await make({ ASSISTANT: 'off' }, false);
  await off.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await off?.close();
  await closeDb?.();
  await devDb?.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

beforeEach(() => {
  model.replies = [];
  model.asked = [];
});

type Headers = Record<string, string>;
const create = async (h: Headers) =>
  (
    await app.inject({ method: 'POST', url: '/api/assistant/conversations', headers: h })
  ).json() as {
    id: string;
  };
const ask = (h: Headers, id: string, text: string, context: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url: `/api/assistant/conversations/${id}/messages`,
    headers: h,
    payload: { text, context },
  });

describe('searching the platform documents', () => {
  const docs = [
    ...sectionsOf(
      'a.md',
      '# Smoke test\nThe smoke test starts the app in a sandbox and runs its checks.\n# Costs\nCosts are tracked per run.',
    ),
    ...sectionsOf('b.md', '# Releases\nA release tags the integration branch.'),
  ];
  it('ranks the section that holds the question’s words, and finds nothing for words nobody wrote', () => {
    expect(searchSections(docs, 'what does the smoke test do')[0]).toMatchObject({
      heading: 'Smoke test',
    });
    expect(searchSections(docs, 'how are costs tracked')[0]).toMatchObject({ heading: 'Costs' });
    expect(searchSections(docs, 'zebra giraffe')).toEqual([]);
    expect(searchSections(docs, 'the and for')).toEqual([]);
  });
});

describe('a conversation', () => {
  it('looks things up, answers, keeps the exchange for its owner, and tells the model where the person is', async () => {
    const f = await createRunFixture(db);
    const who = await newPerson();
    const c = await create(who.headers);
    model.replies = [
      use('platform_api', { path: '/api/initiatives' }),
      say('You have one initiative.'),
    ];
    const res = await ask(who.headers, c.id, 'What do I have?', {
      page: 'queue',
      hash: '#/queue',
      initiativeId: f.initiativeId,
      pageText: 'Attention queue 1 waiting on you',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.assistant.content).toBe('You have one initiative.');
    expect(body.assistant.steps).toEqual([
      { tool: 'platform_api', summary: 'read /api/initiatives' },
    ]);
    expect(body.conversation.title).toBe('What do I have?');
    expect(body.usage).toMatchObject({ available: true, spentMicros: 2000 });

    // The model saw the screen guide for where the person is, the page text, and the tool's answer.
    expect(model.asked[0]!.system).toContain('Attention queue');
    expect(model.asked[0]!.system).toContain('The screen they are on');
    expect(String(model.asked[0]!.messages.at(-1)!.content)).toContain(
      'Attention queue 1 waiting on you',
    );
    const second = model.asked[1]!.messages.at(-1)!.content as Block[];
    expect(second[0]).toMatchObject({ type: 'tool_result' });
    expect(JSON.stringify(second[0])).toContain(f.initiativeId);

    // Only the owner sees it, and a later question carries the earlier ones.
    const other = await newPerson();
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/assistant/conversations/${c.id}`,
          headers: other.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect((await ask(other.headers, c.id, 'hi')).statusCode).toBe(404);
    model.replies = [say('Same one.')];
    await ask(who.headers, c.id, 'And now?');
    expect(
      model.asked
        .at(-1)!
        .messages.map((m) => (typeof m.content === 'string' ? m.content.slice(-20) : ''))[0],
    ).toContain('What do I have?'.slice(-20));
    const saved = await app.inject({
      method: 'GET',
      url: `/api/assistant/conversations/${c.id}`,
      headers: who.headers,
    });
    expect(saved.json().messages.map((m: { role: string }) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    const list = await app.inject({
      method: 'GET',
      url: '/api/assistant/conversations',
      headers: who.headers,
    });
    expect(list.json()).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/assistant/conversations/${c.id}`,
          headers: who.headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      await db.select().from(assistantMessage).where(eq(assistantMessage.conversationId, c.id)),
    ).toHaveLength(0);
  });

  it('refuses a page of data it was not given, and tells the model so', async () => {
    const who = await newPerson();
    const c = await create(who.headers);
    model.replies = [
      use('platform_api', { path: '/api/admin/github' }),
      say('I cannot read that.'),
    ];
    const res = await ask(who.headers, c.id, 'Show me the admin settings');
    expect(res.statusCode).toBe(201);
    const result = model.asked[1]!.messages.at(-1)!.content as Block[];
    expect(result[0]).toMatchObject({ type: 'tool_result', is_error: true });
    expect(JSON.stringify(result[0])).toContain('not one of the pages of data you may read');
  });

  it('stops at the daily limit, and says so before it asks the model anything', async () => {
    const who = await newPerson();
    const c = await create(who.headers);
    model.replies = [say('A long answer.', 20_000)];
    expect((await ask(who.headers, c.id, 'one')).statusCode).toBe(201);
    const again = await ask(who.headers, c.id, 'two');
    expect(again.statusCode).toBe(429);
    expect(again.json().error.code).toBe('daily_limit');
    expect(model.asked).toHaveLength(1);
    expect(
      (
        await app.inject({ method: 'GET', url: '/api/assistant/usage', headers: who.headers })
      ).json(),
    ).toMatchObject({
      spentMicros: 20_000,
      capMicros: 10_000,
    });
  });

  it('gives up with what it has when the cost runs out in the middle of looking things up', async () => {
    const who = await newPerson();
    const c = await create(who.headers);
    model.replies = [
      use('search_platform_docs', { query: 'smoke test' }, 'a', 9_000),
      use('search_platform_docs', { query: 'smoke' }, 'b', 9_000),
    ];
    const res = await ask(who.headers, c.id, 'Explain the smoke test');
    expect(res.statusCode).toBe(201);
    expect(res.json().assistant.content).toContain('used up what you may spend');
  });

  it('is off when switched off, needs a signed-in person, and rejects an empty question', async () => {
    const who = await newPerson(['backend_engineer'], off);
    const made = await off.inject({
      method: 'POST',
      url: '/api/assistant/conversations',
      headers: who.headers,
    });
    const res = await off.inject({
      method: 'POST',
      url: `/api/assistant/conversations/${made.json().id}/messages`,
      headers: who.headers,
      payload: { text: 'hello', context: {} },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('assistant_off');
    expect(
      (
        await off.inject({ method: 'GET', url: '/api/assistant/usage', headers: who.headers })
      ).json().available,
    ).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/assistant/usage' })).statusCode).toBe(401);
    const mine = await newPerson();
    const own = await create(mine.headers);
    expect((await ask(mine.headers, own.id, '   ')).statusCode).toBe(400);
  });
});

describe('suggested actions', () => {
  async function failedTask() {
    const f = await createRunFixture(db);
    const [design] = await db
      .insert(interaction)
      .values({
        initiativeId: f.initiativeId,
        runId: f.runId,
        type: 'review',
        checkpointId: 'G1',
        state: 'answered',
        title: `Design ${++n}`,
        roleNeeded: 'architect',
        contextCard: { kind: 'pull_request', prNumber: 1 },
      })
      .returning();
    const [plan] = await db
      .insert(buildPlan)
      .values({
        initiativeId: f.initiativeId,
        designInteractionId: design!.id,
        designPath: 'docs/design/x.md',
        designSha: 'abc',
        state: 'active',
        detail: 'Building.',
        startedBy: f.personId,
      })
      .returning();
    await db.insert(buildTask).values([
      {
        planId: plan!.id,
        key: 'T1',
        position: 0,
        title: 'One',
        role: 'backend_engineer',
        state: 'failed',
        paths: [],
        doneWhen: [],
      },
      {
        planId: plan!.id,
        key: 'T2',
        position: 1,
        title: 'Two',
        role: 'backend_engineer',
        state: 'merged',
        paths: [],
        doneWhen: [],
      },
    ]);
    return { f, plan: plan! };
  }

  it('offers a button for a failed task, remembers what became of it, and refuses one that cannot work', async () => {
    const { f, plan } = await failedTask();
    const who = await newPerson();
    const c = await create(who.headers);
    model.replies = [
      use('propose_action', {
        kind: 'retry_task',
        label: 'Retry T1',
        why: 'It failed twice.',
        params: { planId: plan.id, key: 'T1' },
      }),
      use(
        'propose_action',
        { kind: 'retry_task', label: 'Retry T2', why: 'x', params: { planId: plan.id, key: 'T2' } },
        'tu2',
      ),
      use(
        'propose_action',
        {
          kind: 'file_bug',
          label: 'File',
          why: 'x',
          params: { initiativeId: f.initiativeId, title: 'x' },
        },
        'tu3',
      ),
      say('I suggest retrying T1.'),
    ];
    const res = await ask(who.headers, c.id, 'T1 keeps failing');
    const a = res.json().assistant;
    expect(a.proposals).toHaveLength(1);
    expect(a.proposals[0]).toMatchObject({
      kind: 'retry_task',
      label: 'Retry T1',
      state: 'proposed',
      params: { key: 'T1' },
    });
    // The two it could not stand behind went back to the model as errors.
    const sent = JSON.stringify(model.asked.slice(1).map((m) => m.messages.at(-1)));
    expect(sent).toContain('only a failed task can be retried');
    expect(sent).toContain('the bug report is not complete');

    const set = (state: string) =>
      app.inject({
        method: 'POST',
        url: `/api/assistant/messages/${a.id}/proposals/${a.proposals[0].id}`,
        headers: who.headers,
        payload: { state },
      });
    expect((await set('done')).statusCode).toBe(200);
    const got = await app.inject({
      method: 'GET',
      url: `/api/assistant/conversations/${c.id}`,
      headers: who.headers,
    });
    expect(got.json().messages[1].proposals[0].state).toBe('done');
    const other = await newPerson();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/assistant/messages/${a.id}/proposals/${a.proposals[0].id}`,
          headers: other.headers,
          payload: { state: 'dismissed' },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('the app-troubleshooting tools', () => {
  const tools = (extra: Partial<ConstructorParameters<typeof AssistantTools>[0]> = {}) =>
    new AssistantTools({
      db,
      github: {
        readFile: async () => null,
        listFiles: async () => [],
        pullRequestFiles: async () => [],
      },
      previews: () => null,
      api: async () => ({ status: 200, body: {} }),
      docs: async () => [],
      ...extra,
    });

  it('reads a repository file at the integration branch, and a pull request’s patches', async () => {
    const f = await createRunFixture(db);
    const seen: string[] = [];
    const t = tools({
      github: {
        readFile: async (repo, p, ref) => {
          seen.push(`${repo}:${p}@${ref}`);
          return p === 'README.md' ? '# Hello' : null;
        },
        listFiles: async () => ['a.ts', 'b.ts'],
        pullRequestFiles: async () => [{ path: 'a.ts', status: 'modified', patch: '+x' }],
      },
    });
    expect(
      (await t.run('read_repo_file', { initiative_id: f.initiativeId, path: 'README.md' })).text,
    ).toBe('# Hello');
    expect(seen[0]).toMatch(/@main$/);
    expect(
      (await t.run('read_repo_file', { initiative_id: f.initiativeId, path: 'nope.md' })).text,
    ).toContain('There is no file');
    expect(
      (await t.run('read_repo_file', { initiative_id: f.initiativeId, path: '../etc/passwd' }))
        .error,
    ).toBe(true);
    expect((await t.run('list_repo_files', { initiative_id: f.initiativeId, dir: '' })).text).toBe(
      'a.ts\nb.ts',
    );
    expect(
      (await t.run('pull_request_files', { initiative_id: f.initiativeId, pr_number: 3 })).text,
    ).toContain('### a.ts (modified)\n+x');
  });

  it('only reaches a preview that is running, and only the way it was told it may', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const row = { id: 'p1', state: 'ready', target: 'http://10.0.0.5:3000', url: 'https://x/' };
    const execs: string[] = [];
    const svc = {
      get: async (id: string) =>
        id === 'p1' ? row : id === 'p2' ? { ...row, id: 'p2', state: 'stopped' } : null,
      logs: async () => 'server listening on 3000',
      exec: async (_id: string, cmd: string) => {
        execs.push(cmd);
        return { exitCode: 0, output: 'ok' };
      },
    };
    const t = tools({
      previews: () => svc as never,
      doFetch: (async (url: string, init: { method: string }) => {
        calls.push({ url: String(url), method: init.method });
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as never,
    });
    expect((await t.run('preview_logs', { preview_id: 'p1' })).text).toContain('listening');
    expect((await t.run('preview_logs', { preview_id: 'p2' })).error).toBe(true);
    expect((await t.run('preview_logs', { preview_id: 'nope' })).error).toBe(true);

    const get = await t.run('preview_request', { preview_id: 'p1', path: '/api/health' });
    expect(get.text).toContain('HTTP 200');
    expect(calls[0]).toEqual({ url: 'http://10.0.0.5:3000/api/health', method: 'GET' });
    for (const bad of [
      { path: '//evil.test/x' },
      { path: 'api/x' },
      { path: '/a b' },
      { path: '/api/accounts', method: 'POST' },
      { path: '/api/x', method: 'DELETE' },
    ])
      expect((await t.run('preview_request', { preview_id: 'p1', ...bad })).error).toBe(true);
    expect(
      (
        await t.run('preview_request', {
          preview_id: 'p1',
          path: '/api/login',
          method: 'POST',
          body: '{}',
        })
      ).error,
    ).toBe(false);
    expect(calls).toHaveLength(2);

    expect((await t.run('preview_exec', { preview_id: 'p1', command: 'ls' })).text).toContain(
      'exit 0',
    );
    expect(
      (await t.run('preview_exec', { preview_id: 'p1', command: 'x'.repeat(401) })).error,
    ).toBe(true);
    for (let i = 0; i < 6; i++) await t.run('preview_exec', { preview_id: 'p1', command: 'ls' });
    expect((await t.run('preview_exec', { preview_id: 'p1', command: 'ls' })).text).toContain(
      'at most 6 commands',
    );
    expect(execs.length).toBe(6);
  });
});

import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EngineEvent, EngineOptions } from './claude.js';
import { CopilotMapper, copilotArgs, copilotEnv, runCopilot } from './copilot.js';

const L = (o: unknown) => JSON.stringify(o);

describe('CopilotMapper', () => {
  const m = () => new CopilotMapper('sess-1', 'agent-default', 3);

  it('announces the engine once, with the session id it was given', () => {
    const mapper = m();
    const first = mapper.map(L({ type: 'session.mcp_servers_loaded', data: {} }));
    expect(first.sessionId).toBe('sess-1');
    expect(first.events).toEqual([
      {
        type: 'engine.started',
        payload: { engine: 'copilot-cli', model: 'agent-default', sessionId: 'sess-1' },
      },
    ]);
    expect(mapper.map(L({ type: 'session.info', data: {} })).events).toEqual([]);
  });

  it('turns messages, tool calls and results into platform events', () => {
    const mapper = m();
    mapper.map(L({ type: 'session.info', data: {} }));
    expect(
      mapper.map(L({ type: 'assistant.message', data: { content: 'On it.' } })).events,
    ).toEqual([{ type: 'message', payload: { role: 'assistant', text: 'On it.' } }]);
    expect(mapper.map(L({ type: 'assistant.message', data: { content: '  ' } })).events).toEqual(
      [],
    );
    expect(
      mapper.map(
        L({
          type: 'tool.execution_start',
          data: { toolCallId: 't1', toolName: 'create', arguments: { path: 'a.txt' } },
        }),
      ).events,
    ).toEqual([
      {
        type: 'tool.call',
        payload: { toolCallId: 't1', name: 'create', input: '{"path":"a.txt"}' },
      },
    ]);
    expect(
      mapper.map(
        L({
          type: 'tool.execution_complete',
          data: {
            toolCallId: 't1',
            success: true,
            result: { content: 'Created a.txt' },
            fileEdits: [{ path: '/work/repo/a.txt', kind: 'create' }],
          },
        }),
      ).events,
    ).toEqual([
      { type: 'tool.result', payload: { toolCallId: 't1', ok: true, summary: 'Created a.txt' } },
      { type: 'file.changed', payload: { path: '/work/repo/a.txt', tool: 'create' } },
    ]);
    expect(
      mapper.map(L({ type: 'tool.execution_complete', data: { toolCallId: 't2', success: false } }))
        .events[0]?.payload,
    ).toMatchObject({ ok: false });
  });

  it('reports the last thing the agent said as the final text', () => {
    const mapper = m();
    mapper.map(L({ type: 'assistant.message', data: { content: 'first' } }));
    mapper.map(L({ type: 'assistant.message', data: { content: 'All done.' } }));
    const r = mapper.map(L({ type: 'result', sessionId: 'sess-9', exitCode: 0 }));
    expect(r.result).toEqual({ text: 'All done.', isError: false, subtype: 'success' });
    expect(r.sessionId).toBe('sess-9');
    expect(mapper.map(L({ type: 'result', exitCode: 1 })).result).toMatchObject({
      isError: true,
      subtype: 'error_exit_1',
    });
  });

  it('flags the turn after the limit, and not before', () => {
    const mapper = m();
    const flags = [1, 2, 3, 4].map((i) => {
      void i;
      return mapper.map(L({ type: 'assistant.turn_start', data: {} })).exceeded;
    });
    expect(flags).toEqual([undefined, undefined, undefined, 'max_turns']);
  });

  it('survives garbage', () => {
    expect(m().map('not json').events).toEqual([]);
  });
});

const opts: EngineOptions = {
  bin: 'copilot',
  cwd: '/work/repo',
  homeDir: '/work/home',
  prompt: 'do it',
  systemPrompt: 'be careful',
  modelAlias: 'agent-default',
  gatewayUrl: 'http://10.0.0.2:8787',
  runToken: 'sdlc_token',
  mcpConfigPath: '/work/mcp.json',
  maxTurns: 60,
  maxWallSeconds: 1800,
  deniedTools: ['web_fetch'],
  onEvents: () => {},
};

describe('copilotArgs', () => {
  it('starts a session with an id of our choosing and puts the system prompt in front of the task', () => {
    const a = copilotArgs(opts, 'sess-1');
    expect(a[0]).toBe('-p');
    expect(a[1]).toContain('be careful');
    expect(a[1]).toContain('do it');
    expect(a).toContain('--session-id=sess-1');
    expect(a.some((x) => x.startsWith('--resume'))).toBe(false);
    expect(a[a.indexOf('--additional-mcp-config') + 1]).toBe('@/work/mcp.json');
    expect(a).toContain('--disable-builtin-mcps');
    expect(a).toContain('--no-ask-user');
    expect(a).toContain('--deny-tool=shell(git push)');
  });
  it('resumes with only the new message', () => {
    const a = copilotArgs({ ...opts, resumeSessionId: 'sess-1' }, 'sess-1');
    expect(a[1]).toBe('do it');
    expect(a).toContain('--resume=sess-1');
    expect(a.some((x) => x.startsWith('--session-id'))).toBe(false);
  });
  it('puts the variadic excluded-tools flag last and removes web access', () => {
    const a = copilotArgs(opts, 'sess-1');
    expect(a.slice(a.indexOf('--excluded-tools'))).toEqual([
      '--excluded-tools',
      'web_fetch',
      'web_search',
    ]);
  });
});

describe('copilotEnv', () => {
  it('uses the gateway as the model provider and keeps every GitHub login out', () => {
    const saved = { ...process.env };
    process.env.GH_TOKEN = 'ghp_secret';
    process.env.OPENROUTER_API_KEY = 'sk-or-secret';
    try {
      const env = copilotEnv(opts);
      expect(env).toMatchObject({
        COPILOT_PROVIDER_TYPE: 'anthropic',
        COPILOT_PROVIDER_BASE_URL: 'http://10.0.0.2:8787',
        COPILOT_PROVIDER_BEARER_TOKEN: 'sdlc_token',
        COPILOT_MODEL: 'agent-default',
        GH_TOKEN: '',
        GITHUB_TOKEN: '',
        COPILOT_GITHUB_TOKEN: '',
      });
      expect(env.COPILOT_HOME).toBe(path.join('/work/home', '.copilot'));
      expect(JSON.stringify(env)).not.toContain('ghp_secret');
      expect(JSON.stringify(env)).not.toContain('sk-or-secret');
    } finally {
      process.env = saved;
    }
  });
});

describe('runCopilot', () => {
  it('stops an engine that goes past the turn limit', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'copilot-limit-'));
    const script = path.join(dir, 'chatty.mjs');
    await writeFile(
      script,
      `for (let i = 0; i < 50; i++) { console.log(JSON.stringify({ type: 'assistant.turn_start', data: {} })); }
       setInterval(() => {}, 1000);`,
    );
    const seen: EngineEvent[] = [];
    const sessions: string[] = [];
    const run = runCopilot({
      ...opts,
      bin: process.execPath,
      binArgs: [script],
      cwd: dir,
      maxTurns: 2,
      maxWallSeconds: 30,
      onEvents: (e) => seen.push(...e),
      onSession: (s) => sessions.push(s),
    });
    const r = await run.done;
    expect(r.isError).toBe(true);
    expect(r.subtype).toBe('error_max_turns');
    expect(r.killedBy).toBeNull();
    expect(sessions).toHaveLength(1);
    expect(seen[0]?.type).toBe('engine.started');
  });
});

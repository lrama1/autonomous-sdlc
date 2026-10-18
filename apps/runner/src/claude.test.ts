import { describe, expect, it } from 'vitest';
import { engineArgs, engineEnv, mapStreamLine } from './claude.js';
import type { EngineOptions } from './claude.js';

const L = (o: object) => JSON.stringify(o);

describe('mapStreamLine', () => {
  it('reads the session from the init line', () => {
    const m = mapStreamLine(
      L({
        type: 'system',
        subtype: 'init',
        session_id: 'abc',
        model: 'anthropic/claude-haiku-4.5',
        tools: ['Bash'],
      }),
    );
    expect(m.sessionId).toBe('abc');
    expect(m.events).toEqual([
      {
        type: 'engine.started',
        payload: { engine: 'claude-code', model: 'anthropic/claude-haiku-4.5', sessionId: 'abc' },
      },
    ]);
  });

  it('ignores other system lines such as thinking progress', () => {
    expect(
      mapStreamLine(L({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 4 })).events,
    ).toEqual([]);
    expect(
      mapStreamLine(L({ type: 'system', subtype: 'status', status: 'requesting' })).events,
    ).toEqual([]);
  });

  it('maps assistant text and tool calls, and notes a file change for a write', () => {
    const m = mapStreamLine(
      L({
        type: 'assistant',
        session_id: 's1',
        message: {
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'I will add the endpoint.' },
            {
              type: 'tool_use',
              id: 't1',
              name: 'Write',
              input: { file_path: 'src/server.js', content: 'x' },
            },
            {
              type: 'tool_use',
              id: 't2',
              name: 'mcp__platform__ask_human',
              input: { question: 'q' },
            },
          ],
        },
      }),
    );
    expect(m.events.map((e) => e.type)).toEqual([
      'message',
      'tool.call',
      'file.changed',
      'tool.call',
    ]);
    expect(m.events[0]!.payload).toEqual({ role: 'assistant', text: 'I will add the endpoint.' });
    expect(m.events[1]!.payload).toMatchObject({ toolCallId: 't1', name: 'Write' });
    expect(m.events[2]!.payload).toEqual({ path: 'src/server.js', tool: 'Write' });
    expect(m.events[3]!.payload).toMatchObject({ name: 'mcp__platform__ask_human' });
  });

  it('does not call a read a file change', () => {
    const m = mapStreamLine(
      L({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'a' } }],
        },
      }),
    );
    expect(m.events.map((e) => e.type)).toEqual(['tool.call']);
  });

  it('maps tool results, ok or failed, with a short summary', () => {
    const ok = mapStreamLine(
      L({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'File created' }] },
      }),
    );
    expect(ok.events).toEqual([
      { type: 'tool.result', payload: { toolCallId: 't1', ok: true, summary: 'File created' } },
    ]);
    const bad = mapStreamLine(
      L({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't2',
              is_error: true,
              content: [{ type: 'text', text: 'boom' }],
            },
          ],
        },
      }),
    );
    expect(bad.events[0]!.payload).toEqual({ toolCallId: 't2', ok: false, summary: 'boom' });
  });

  it('shortens long output', () => {
    const m = mapStreamLine(
      L({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(1000) }],
        },
      }),
    );
    expect((m.events[0]!.payload.summary as string).length).toBeLessThanOrEqual(301);
  });

  it('reads the final result', () => {
    const m = mapStreamLine(
      L({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', session_id: 's9' }),
    );
    expect(m.result).toEqual({ text: 'DONE', isError: false, subtype: 'success' });
    expect(m.sessionId).toBe('s9');
    expect(
      mapStreamLine(L({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' }))
        .result,
    ).toMatchObject({ isError: true, subtype: 'error_max_turns' });
  });

  it('survives garbage and plain user messages', () => {
    expect(mapStreamLine('not json').events).toEqual([]);
    expect(mapStreamLine(L({ type: 'user', message: { content: 'hello' } })).events).toEqual([]);
  });
});

const opts: EngineOptions = {
  bin: 'claude',
  cwd: '/work/repo',
  homeDir: '/work/home',
  prompt: 'do it',
  systemPrompt: 'be careful',
  modelAlias: 'agent-default',
  gatewayUrl: 'http://127.0.0.1:8787',
  runToken: 'sdlc_token',
  mcpConfigPath: '/work/mcp.json',
  maxTurns: 60,
  maxWallSeconds: 1800,
  deniedTools: ['web_fetch'],
  onEvents: () => {},
};

describe('engineArgs', () => {
  it('uses only project settings and only the platform MCP config', () => {
    const a = engineArgs(opts);
    expect(a.slice(0, 2)).toEqual(['-p', 'do it']);
    expect(a).toContain('--strict-mcp-config');
    expect(a[a.indexOf('--setting-sources') + 1]).toBe('project');
    expect(a[a.indexOf('--mcp-config') + 1]).toBe('/work/mcp.json');
    expect(a[a.indexOf('--model') + 1]).toBe('agent-default');
    expect(a[a.indexOf('--max-turns') + 1]).toBe('60');
    expect(a[a.indexOf('--append-system-prompt') + 1]).toBe('be careful');
  });
  it('puts the variadic denied-tools flag last and denies web access', () => {
    const a = engineArgs(opts);
    expect(a.slice(a.indexOf('--disallowedTools'))).toEqual([
      '--disallowedTools',
      'WebFetch',
      'WebSearch',
    ]);
  });
  it('resumes a session when given one', () => {
    const a = engineArgs({ ...opts, resumeSessionId: 'sess-1' });
    expect(a[a.indexOf('--resume') + 1]).toBe('sess-1');
    expect(a.indexOf('--resume')).toBeLessThan(a.indexOf('--disallowedTools'));
    expect(engineArgs(opts)).not.toContain('--resume');
  });
});

describe('engineEnv', () => {
  it('points the engine at the gateway with the run token and no provider key', () => {
    const env = engineEnv(opts);
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787',
      ANTHROPIC_AUTH_TOKEN: 'sdlc_token',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: 'agent-default',
      HOME: '/work/home',
      GIT_TERMINAL_PROMPT: '0',
    });
  });
  it('does not pass the platform or provider secrets through', () => {
    const saved = { ...process.env };
    process.env.OPENROUTER_API_KEY = 'sk-or-secret';
    process.env.GH_TOKEN = 'ghp_secret';
    process.env.SDLC_RUN_TOKEN = 'run-secret-should-not-leak-except-as-anthropic-token';
    try {
      const text = JSON.stringify(engineEnv(opts));
      expect(text).not.toContain('sk-or-secret');
      expect(text).not.toContain('ghp_secret');
      expect(text).not.toContain('SDLC_RUN_TOKEN');
    } finally {
      process.env = saved;
    }
  });
});

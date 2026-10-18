/* eslint-disable @typescript-eslint/no-explicit-any -- the bodies are free-form JSON */
import { describe, expect, it } from 'vitest';
import { addCacheBreakpoints } from './cache.js';

const E = { type: 'ephemeral' };

describe('addCacheBreakpoints', () => {
  it('marks the last tool, the last system block, and the last block of the last message', () => {
    const body: any = {
      tools: [{ name: 'a' }, { name: 'b' }],
      system: [
        { type: 'text', text: 's1' },
        { type: 'text', text: 's2' },
      ],
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't', content: 'x' },
            { type: 'text', text: 'and more' },
          ],
        },
      ],
    };
    expect(addCacheBreakpoints(body)).toBe(true);
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[1].cache_control).toEqual(E);
    expect(body.system[0].cache_control).toBeUndefined();
    expect(body.system[1].cache_control).toEqual(E);
    expect(body.messages[0].content).toBe('first');
    expect(body.messages[2].content[0].cache_control).toBeUndefined();
    expect(body.messages[2].content[1].cache_control).toEqual(E);
  });

  it('uses at most three markers, so it stays under the limit of four', () => {
    const body: any = { tools: [{}], system: 'x', messages: [{ role: 'user', content: 'y' }] };
    addCacheBreakpoints(body);
    expect(JSON.stringify(body).match(/cache_control/g)).toHaveLength(3);
  });

  it('does nothing when the client marked any part of the prompt', () => {
    const body: any = {
      system: [{ type: 'text', text: 's', cache_control: E }],
      messages: [{ role: 'user', content: 'y' }],
    };
    expect(addCacheBreakpoints(body)).toBe(false);
    expect(body.messages[0].content).toBe('y');
    const inMessage: any = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'y', cache_control: E }] }],
    };
    expect(addCacheBreakpoints(inMessage)).toBe(false);
  });

  it('skips a thinking block and copes with empty or missing parts', () => {
    const body: any = {
      messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 't' }] }],
    };
    addCacheBreakpoints(body);
    expect(body.messages[0].content[0].cache_control).toBeUndefined();
    expect(addCacheBreakpoints({})).toBe(false);
    expect(addCacheBreakpoints({ tools: [], system: '', messages: [] })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { parseAllowlist, startAllowlist } from './allowlist.js';

const answer = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));
const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('parseAllowlist', () => {
  it('reads hosts, lowercased, and accepts a leading dot', () => {
    expect(parseAllowlist({ hosts: ['GitHub.com', '.npmjs.org', 'a-b.example.com'] })).toEqual([
      'github.com',
      '.npmjs.org',
      'a-b.example.com',
    ]);
    expect(parseAllowlist({ hosts: [] })).toEqual([]);
  });

  it('refuses anything else, so a bad answer cannot widen or empty the list', () => {
    for (const bad of [
      null,
      {},
      { hosts: 'github.com' },
      { hosts: [1] },
      { hosts: ['bad host'] },
      { hosts: ['evil.com/path'] },
      { hosts: ['*'] },
      { hosts: ['a'.repeat(300)] },
      { hosts: Array.from({ length: 1001 }, () => 'a.com') },
    ])
      expect(parseAllowlist(bad), JSON.stringify(bad).slice(0, 40)).toBeNull();
  });
});

describe('startAllowlist', () => {
  it("starts with the fixed list and takes the platform's once it answers, sending the token", async () => {
    const seen: Array<Record<string, string>> = [];
    const logs: string[] = [];
    const list = startAllowlist({
      initial: ['github.com'],
      url: 'http://api/allow',
      token: 'tok',
      intervalMs: 1_000_000,
      log: (l) => logs.push(l),
      fetchImpl: ((_u: string, init: RequestInit) => {
        seen.push(init.headers as Record<string, string>);
        return answer({ hosts: ['github.com', 'registry.npmjs.org'] });
      }) as never,
    });
    expect(list.current()).toEqual(['github.com']);
    await wait();
    expect(list.current()).toEqual(['github.com', 'registry.npmjs.org']);
    expect(seen[0]).toEqual({ authorization: 'Bearer tok' });
    expect(logs.join('\n')).toContain('ALLOWLIST 2 hosts');
    list.stop();
  });

  it('keeps the last list when the platform cannot be asked, says so once, and says when it is back', async () => {
    let mode: 'ok' | 'down' | 'bad' = 'ok';
    const logs: string[] = [];
    const list = startAllowlist({
      initial: ['github.com'],
      url: 'http://api/allow',
      intervalMs: 1_000_000,
      log: (l) => logs.push(l),
      fetchImpl: (() =>
        mode === 'down'
          ? Promise.reject(new Error('connect ECONNREFUSED'))
          : mode === 'bad'
            ? answer({ nope: true })
            : answer({ hosts: ['github.com', 'a.test'] })) as never,
    });
    await wait();
    expect(list.current()).toEqual(['github.com', 'a.test']);
    mode = 'down';
    await list.refresh();
    await list.refresh();
    mode = 'bad';
    await list.refresh();
    expect(list.current()).toEqual(['github.com', 'a.test']);
    expect(logs.filter((l) => l.includes('cannot read it from the platform'))).toHaveLength(1);
    mode = 'ok';
    await list.refresh();
    expect(logs.join('\n')).toContain('the platform answers again');
    list.stop();
  });

  it('refuses an answer of 401 or an error status, and does nothing without an address', async () => {
    const list = startAllowlist({
      initial: ['github.com'],
      url: 'http://api/allow',
      intervalMs: 1_000_000,
      fetchImpl: (() => answer({ error: 'no' }, 401)) as never,
    });
    await wait();
    expect(list.current()).toEqual(['github.com']);
    list.stop();

    const fixed = startAllowlist({ initial: ['x.com'] });
    await fixed.refresh();
    expect(fixed.current()).toEqual(['x.com']);
  });
});

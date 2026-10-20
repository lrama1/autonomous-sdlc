import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  describeSmokeCheck,
  missingChecks,
  isTestPath,
  parseDesignSmoke,
  parseDesignTasks,
  validateDesignTasks,
} from './design.js';

const task = (o: Record<string, unknown> = {}) => ({
  id: 'T1',
  title: 'Add the route',
  role: 'backend_engineer',
  stories: ['US-1'],
  depends_on: [],
  // Each task writes a file of its own unless a test says otherwise.
  paths: [`src/${String(o.id ?? 'T1').toLowerCase()}.js`],
  done_when: ['GET /x answers 200'],
  ...o,
});

const errorsOf = (raw: unknown) => {
  const r = validateDesignTasks(raw);
  if (r.ok) throw new Error('expected errors');
  return r.errors.join(' | ');
};

describe('validateDesignTasks', () => {
  it('accepts a well-formed list and orders it by dependency', () => {
    const r = validateDesignTasks([
      task({ id: 'T2', title: 'Use it', depends_on: ['T1'] }),
      task({ id: 'T1' }),
      task({ id: 'T3', role: 'frontend_engineer', stories: [], depends_on: [] }),
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.order).toEqual(['T1', 'T2', 'T3']);
      expect(r.tasks.find((t) => t.id === 'T2')).toMatchObject({
        dependsOn: ['T1'],
        doneWhen: ['GET /x answers 200'],
      });
    }
  });

  it('keeps the written order when nothing forces another', () => {
    const r = validateDesignTasks([task({ id: 'T1' }), task({ id: 'T2' }), task({ id: 'T3' })]);
    expect(r.ok && r.order).toEqual(['T1', 'T2', 'T3']);
  });

  it('refuses an empty list, a list that is not a list, and too many tasks', () => {
    expect(validateDesignTasks([]).ok).toBe(false);
    expect(validateDesignTasks({ id: 'T1' }).ok).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => task({ id: `T${i + 1}` }));
    expect(errorsOf(many)).toContain('at most 20');
  });

  it('refuses a task whose code files another task already writes, and says which to merge', () => {
    const err = errorsOf([
      task({ id: 'T1', paths: ['public/index.html', 'public/client.js', 'test/ui.test.js'] }),
      task({ id: 'T2', depends_on: ['T1'], paths: ['public/client.js', 'test/ui.test.js'] }),
    ]);
    expect(err).toContain('T2: every code file it lists (public/client.js) is also listed by T1');
    expect(err).toContain('Merge T2 into it');
    // The same files in both tasks: only the later one is sent back.
    expect(
      errorsOf([task({ id: 'T1', paths: ['src/a.js'] }), task({ id: 'T2', paths: ['src/a.js'] })]),
    ).not.toContain('T1:');
  });

  it('does not count tests, the preview config or documents as a code file of its own', () => {
    const err = errorsOf([
      task({ id: 'T1', paths: ['src/main.js', 'test/main.test.js'] }),
      task({ id: 'T2', paths: ['src/main.js', '.sdlc/preview.yaml'] }),
    ]);
    expect(err).toContain('T2: every code file it lists (src/main.js)');
    // A task with a file of its own may also touch a shared one.
    expect(
      validateDesignTasks([
        task({ id: 'T1', paths: ['src/main.js'] }),
        task({ id: 'T2', paths: ['src/main.js', 'src/extra.js'] }),
      ]).ok,
    ).toBe(true);
  });

  it('names what is wrong with a task', () => {
    expect(errorsOf([task({ id: 'one' })])).toContain('id must look like T1');
    expect(errorsOf([task(), task()])).toContain('used twice');
    expect(errorsOf([task({ title: '' })])).toContain('a title is required');
    expect(errorsOf([task({ role: 'architect' })])).toContain('role must be one of');
    expect(errorsOf([task({ stories: ['story 1'] })])).toContain('stories must be');
    expect(errorsOf([task({ paths: 'src/x.js' })])).toContain('paths must be');
    expect(errorsOf([task({ done_when: [] })])).toContain('done_when needs');
    expect(errorsOf([task({ done_when: [{ 'GET /x answers {"ok"': 'true}' }] })])).toContain(
      'Put quotes around a line',
    );
    expect(errorsOf(['text'])).toContain('must be a mapping');
  });

  it('refuses a dependency that does not exist, one on itself, and a circle', () => {
    expect(errorsOf([task({ depends_on: ['T9'] })])).toContain('T9, which is not a task');
    expect(errorsOf([task({ depends_on: ['T1'] })])).toContain('cannot depend on itself');
    expect(
      errorsOf([task({ id: 'T1', depends_on: ['T2'] }), task({ id: 'T2', depends_on: ['T1'] })]),
    ).toContain('in a circle');
  });
});

describe('test-only tasks', () => {
  it('recognises test files by their usual names', () => {
    for (const p of [
      'test/server.test.js',
      'tests/api.py',
      'src/__tests__/a.ts',
      'e2e/login.spec.ts',
      'src/user.spec.ts',
      'pkg/user_test.go',
      'app/test_user.py',
      'src\\a.test.ts',
    ])
      expect(isTestPath(p), p).toBe(true);
    for (const p of ['src/server.js', 'src/latest.js', 'docs/testing.md', 'src/contest/a.ts'])
      expect(isTestPath(p), p).toBe(false);
  });

  it('refuses a task that only adds tests when other tasks write the code', () => {
    const msg = errorsOf([
      task({ id: 'T1', paths: ['src/server.js', 'test/server.test.js'] }),
      task({ id: 'T2', title: 'Add tests', paths: ['test/server.test.js'], depends_on: ['T1'] }),
    ]);
    expect(msg).toContain('T2: touches only test files (test/server.test.js)');
    expect(msg).toContain('Put these tests in the task that writes the code');
    expect(msg).not.toContain('T1:');
  });

  it('accepts a plan that is only about tests, and tasks that mix code and tests', () => {
    expect(
      validateDesignTasks([
        task({ id: 'T1', paths: ['test/a.test.js'] }),
        task({ id: 'T2', paths: ['test/b.test.js'] }),
      ]).ok,
    ).toBe(true);
    expect(
      validateDesignTasks([
        task({ id: 'T1', paths: ['src/a.js', 'test/a.test.js'] }),
        task({ id: 'T2', paths: ['src/b.js', 'test/b.test.js'] }),
      ]).ok,
    ).toBe(true);
  });
});

describe('parseDesignTasks', () => {
  const doc = (block: string) =>
    `# Design\n\nSome text.\n\n## Tasks\n\n\`\`\`sdlc-tasks\n${block}\`\`\`\n\nMore text.\n`;

  it('reads the block from a design document', () => {
    const r = parseDesignTasks(
      doc(
        '- id: T1\n  title: Add the route\n  role: backend_engineer\n  stories: [US-1]\n  paths: [src/server.js]\n  done_when:\n    - GET /x answers 200\n',
      ),
    );
    expect(r.ok && r.tasks).toEqual([
      {
        id: 'T1',
        title: 'Add the route',
        role: 'backend_engineer',
        stories: ['US-1'],
        dependsOn: [],
        paths: ['src/server.js'],
        doneWhen: ['GET /x answers 200'],
      },
    ]);
  });

  it('copes with Windows line endings', () => {
    const text = doc(
      '- id: T1\n  title: A\n  role: backend_engineer\n  paths: [a.js]\n  done_when: [ok]\n',
    ).replace(/\n/g, '\r\n');
    expect(parseDesignTasks(text).ok).toBe(true);
  });

  it('says so when the block is missing, repeated, or not YAML', () => {
    const none = parseDesignTasks('# Design\n\n```yaml\n- id: T1\n```\n');
    expect(none.ok === false && none.errors[0]).toContain('no ```sdlc-tasks block');
    const block =
      '- id: T1\n  title: A\n  role: backend_engineer\n  paths: [a.js]\n  done_when: [ok]\n';
    const twice = parseDesignTasks(doc(block) + doc(block));
    expect(twice.ok === false && twice.errors[0]).toContain('more than one');
    const bad = parseDesignTasks(doc('- id: [T1\n  title\n'));
    expect(bad.ok === false && bad.errors[0]).toContain('not valid YAML');
  });
});

describe('the Architect agent prompt', () => {
  it('shows an example that the platform accepts', () => {
    const prompt = readFileSync(
      new URL('../../../agents/architect-agent/prompt.md', import.meta.url),
      'utf8',
    );
    const r = parseDesignTasks(prompt);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tasks[0]!.doneWhen[0]).toContain('{"version"');
  });

  it('shows a smoke example that the platform accepts, with the quoting it asks for', () => {
    const prompt = readFileSync(
      new URL('../../../agents/architect-agent/prompt.md', import.meta.url),
      'utf8',
    );
    const r = parseDesignSmoke(prompt);
    expect(r.ok).toBe(true);
    if (r.ok && r.smoke.kind === 'checks')
      expect(r.smoke.checks.some((c) => c.kind === 'run' && c.command === 'npm run smoke')).toBe(
        true,
      );
  });
});

describe('missingChecks', () => {
  const get = (path: string, over: Record<string, unknown> = {}) =>
    ({ kind: 'get', path, status: 200, contains: null, ...over }) as const;
  it('finds what the design requires and the list lacks', () => {
    const listed = [
      get('/health', { contains: 'ok' }),
      { kind: 'run', command: 'npm test' } as const,
    ];
    expect(missingChecks([get('/health'), get('/api/items')], listed)).toEqual([get('/api/items')]);
    expect(missingChecks([{ kind: 'run', command: ' npm test ' }], listed)).toEqual([]);
    expect(missingChecks([{ kind: 'run', command: 'npm run smoke' }], listed)).toHaveLength(1);
  });
  it('takes a listed check that asks the same and at least as much', () => {
    expect(missingChecks([get('/health', { contains: 'ok' })], [get('/health/')])).toHaveLength(1);
    expect(
      missingChecks(
        [get('/health', { contains: 'ok' })],
        [get('/health/', { contains: 'all ok' })],
      ),
    ).toEqual([]);
    expect(missingChecks([get('/x')], [get('/x', { status: 201 })])).toHaveLength(1);
  });
});

describe('parseDesignSmoke', () => {
  const doc = (body: string) => `# Design\n\n\`\`\`sdlc-smoke\n${body}\`\`\`\n`;
  const errors = (md: string) => {
    const r = parseDesignSmoke(md);
    if (r.ok) throw new Error('expected errors');
    return r.errors.join(' | ');
  };

  it('reads the checks the running app must pass', () => {
    const r = parseDesignSmoke(
      doc('- get: /health\n- get: /items\n  status: 200\n  contains: id\n- run: npm run smoke\n'),
    );
    expect(r).toEqual({
      ok: true,
      smoke: {
        kind: 'checks',
        checks: [
          { kind: 'get', path: '/health', status: 200, contains: null },
          { kind: 'get', path: '/items', status: 200, contains: 'id' },
          { kind: 'run', command: 'npm run smoke' },
        ],
      },
    });
  });

  it('reads an explicit none with its reason', () => {
    expect(parseDesignSmoke(doc('none: A library with no server to start.\n'))).toEqual({
      ok: true,
      smoke: { kind: 'none', reason: 'A library with no server to start.' },
    });
  });

  it('refuses a design that does not say', () => {
    expect(errors('# Design\n\nNothing about it.\n')).toContain('no ```sdlc-smoke block');
    expect(errors(`${doc('- get: /a\n')}\n${doc('- get: /b\n')}`)).toContain('more than one');
  });

  it('refuses a block that is neither a list of checks nor a reasoned none', () => {
    expect(errors(doc('[]\n'))).toContain('at least one check');
    expect(errors(doc('\n'))).toContain('at least one check');
    expect(errors(doc('none: n/a\n'))).toContain('a reason of at least 10');
    expect(errors(doc('none: ok\nextra: 1\n'))).toContain('single line: none');
    expect(errors(doc('checks: []\n'))).toContain('single line: none');
    expect(errors(doc('- get: nope\n'))).toContain('smoke check 1 get must be a path');
    expect(errors(doc('- [unclosed\n'))).toContain('not valid YAML');
  });

  it('describes a check as one line', () => {
    expect(describeSmokeCheck({ kind: 'get', path: '/a', status: 200, contains: null })).toBe(
      'get: /a (status 200)',
    );
    expect(describeSmokeCheck({ kind: 'get', path: '/a', status: 404, contains: 'gone' })).toBe(
      'get: /a (status 404, body contains "gone")',
    );
    expect(describeSmokeCheck({ kind: 'run', command: 'npm test' })).toBe('run: npm test');
  });
});

describe('a smoke block that reads as something else', () => {
  it('names an unquoted command with a colon and braces, which is what an Architect wrote', () => {
    const md =
      '# Design\n\n```sdlc-smoke\n- get: /\n- run: node -e "const o = {a: 1}; process.exit(0)"\n```\n';
    const r = parseDesignSmoke(md);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('not valid YAML');
  });
});

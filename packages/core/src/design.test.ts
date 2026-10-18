import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDesignTasks, validateDesignTasks } from './design.js';

const task = (o: Record<string, unknown> = {}) => ({
  id: 'T1',
  title: 'Add the route',
  role: 'backend_engineer',
  stories: ['US-1'],
  depends_on: [],
  paths: ['src/server.js'],
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
});

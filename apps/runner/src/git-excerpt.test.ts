import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffExcerpt } from './git.js';

let dir: string;
const git = (...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, stdio: 'pipe' },
  );

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-excerpt-'));
  git('init', '-q', '-b', 'main');
  await mkdir(path.join(dir, '.sdlc'));
  await writeFile(
    path.join(dir, '.sdlc', 'preview.yaml'),
    'start: npm start\nsmoke:\n  - get: /a\n',
  );
  await writeFile(path.join(dir, 'other.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-q', '-b', 'work');
  await writeFile(
    path.join(dir, '.sdlc', 'preview.yaml'),
    'start: npm start\nsmoke:\n  - get: /a\n    status: 401\n',
  );
  await writeFile(path.join(dir, 'other.txt'), 'two\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('diffExcerpt', () => {
  it('shows what the work changed in the given paths and nothing else', async () => {
    const patch = await diffExcerpt(dir, 'main', ['.sdlc/preview.yaml']);
    expect(patch).toContain('+    status: 401');
    expect(patch).not.toContain('other.txt');
  });

  it('is cut to a length a card can show, and empty when there is nothing to show', async () => {
    const cut = await diffExcerpt(dir, 'main', ['.sdlc/preview.yaml'], 40);
    expect(cut.endsWith('[cut]')).toBe(true);
    expect(await diffExcerpt(dir, 'main', [])).toBe('');
    expect(await diffExcerpt(dir, 'nonexistent', ['.sdlc/preview.yaml'])).toBe('');
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { summarizeDiff } from './diff.js';

let dir: string;
const git = (...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, stdio: 'pipe' },
  );

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-diff-'));
  git('init', '-q', '-b', 'main');
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src', 'a.js'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-q', '-b', 'work');
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const commit = async (file: string, text: string) => {
  await writeFile(path.join(dir, file), text);
  git('add', '-A');
  git('commit', '-q', '-m', file);
};

describe('summarizeDiff and unescaped HTML', () => {
  it('does not flag a change that only shows text', async () => {
    await commit('src/page.js', "list.textContent = name;\nempty.innerHTML = '<p>None yet</p>';\n");
    const d = await summarizeDiff(dir, 'main', []);
    expect(d.changedPaths).toEqual(['src/page.js']);
    expect(d.unsafeHtml).toBe(false);
  });

  it('flags a change that puts a variable into innerHTML, as the expense splitter did', async () => {
    await commit(
      'src/page2.js',
      'people.innerHTML = list.map((p) => `<li>${p.name}</li>`).join("");\n',
    );
    const d = await summarizeDiff(dir, 'main', []);
    expect(d.changedPaths).toEqual(['src/page.js', 'src/page2.js']);
    expect(d.unsafeHtml).toBe(true);
  });

  it('looks only at what the branch adds, not at what was already there', async () => {
    // A line the base already had (and the branch leaves alone) is not this change's doing.
    git('checkout', '-q', 'main');
    await commit('src/old.js', 'old.innerHTML = markup;\n');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-q', '-b', 'work2');
    await commit('src/ok.js', 'export const b = 2;\n');
    expect((await summarizeDiff(dir, 'main', [])).unsafeHtml).toBe(false);
  });
});

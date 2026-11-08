import { describe, expect, it } from 'vitest';
import { describeRepository } from './repo-inspection.js';
import type { RepositoryFacts } from './repo-inspection.js';

const facts = (paths: string[], more: Partial<RepositoryFacts> = {}): RepositoryFacts => ({
  empty: false,
  defaultBranch: 'main',
  archived: false,
  paths,
  truncated: false,
  lastCommitAt: '2026-11-03T12:00:00Z',
  ...more,
});

describe('describeRepository', () => {
  it('says an empty repository has nothing to overwrite', () => {
    const r = describeRepository(facts([], { empty: true, defaultBranch: null }));
    expect(r.shape).toBe('empty');
    expect(r.needsAcknowledgement).toBe(false);
    expect(r.details.join(' ')).toContain('nothing in it to overwrite');
  });

  it('treats a README, licence and .gitignore as a fresh repository', () => {
    const r = describeRepository(facts(['README.md', 'LICENSE', '.gitignore']));
    expect(r.shape).toBe('starter');
    expect(r.needsAcknowledgement).toBe(false);
  });

  it('informs, without blocking, about an ordinary project', () => {
    const r = describeRepository(
      facts(['package.json', 'src/index.ts', 'src/a.ts', '.github/workflows/ci.yml', 'README.md']),
    );
    expect(r.shape).toBe('project');
    expect(r.needsAcknowledgement).toBe(false);
    expect(r.stacks).toEqual(['Node.js']);
    expect(r.fileCount).toBe(5);
    expect(r.headline).toContain('Node.js');
    expect(r.headline).toContain('Nov 3, 2026');
    expect(r.details[0]).toContain('Nothing is overwritten');
  });

  it('treats a monorepo with a workspace file as one project', () => {
    const r = describeRepository(
      facts([
        'package.json',
        'pnpm-workspace.yaml',
        'apps/web/package.json',
        'apps/api/package.json',
        'packages/core/package.json',
      ]),
    );
    expect(r.shape).toBe('project');
    expect(r.needsAcknowledgement).toBe(false);
  });

  it('treats a Maven project with modules as one project', () => {
    const r = describeRepository(facts(['pom.xml', 'core/pom.xml', 'web/pom.xml']));
    expect(r.shape).toBe('project');
  });

  it('asks for an acknowledgement when it looks like several apps', () => {
    const r = describeRepository(
      facts(['apps/blog/package.json', 'apps/shop/package.json', 'README.md']),
    );
    expect(r.shape).toBe('multi_app');
    expect(r.needsAcknowledgement).toBe(true);
    expect(r.appFolders).toEqual(['apps/blog', 'apps/shop']);
    expect(r.headline).toContain('more than one app');
    expect(r.details.join(' ')).toContain('step 8');
  });

  it('also flags a root project with two further apps beside it and no workspace file', () => {
    const r = describeRepository(
      facts(['package.json', 'client/package.json', 'server/package.json']),
    );
    expect(r.needsAcknowledgement).toBe(true);
  });

  it('ignores manifests in support folders and vendored code', () => {
    const r = describeRepository(
      facts([
        'package.json',
        'docs/requirements.txt',
        'examples/a/package.json',
        'node_modules/x/package.json',
        'vendor/y/composer.json',
        'src/a.ts',
      ]),
    );
    expect(r.shape).toBe('project');
    expect(r.appFolders).toEqual([]);
    expect(r.stacks).toEqual(['Node.js']);
  });

  it('notes that the platform runs from the root when the only project is in a folder', () => {
    const r = describeRepository(facts(['app/package.json', 'app/src/a.ts']));
    expect(r.shape).toBe('project');
    expect(r.details.join(' ')).toContain('app/');
  });

  it('notes a project it does not recognise', () => {
    const r = describeRepository(facts(['index.html', 'style.css']));
    expect(r.shape).toBe('project');
    expect(r.headline).toContain('no recognised project file');
    expect(r.details.join(' ')).toContain('verify command');
  });

  it('names a default branch other than main, an archive, and a cut-short listing', () => {
    const r = describeRepository(
      facts(['package.json', 'a.ts'], { defaultBranch: 'master', archived: true, truncated: true }),
    );
    const text = r.details.join(' ');
    expect(text).toContain('master');
    expect(text).toContain('archived');
    expect(text).toContain('only part');
    expect(r.headline).toContain('2+ files');
  });
});

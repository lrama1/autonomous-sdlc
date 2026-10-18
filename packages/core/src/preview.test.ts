import { describe, expect, it } from 'vitest';
import { choosePreview, normalizePreviewState, safeUrl } from './preview.js';
import type { PreviewCandidate } from './preview.js';

const HEAD = 'aaaaaaa1111111';
const OLD = 'bbbbbbb2222222';
const c = (o: Partial<PreviewCandidate>): PreviewCandidate => ({
  source: 'deployment',
  sha: HEAD,
  state: 'success',
  url: 'https://pr-7.example.test',
  at: '2026-10-18T10:00:00Z',
  ...o,
});

describe('choosePreview', () => {
  it('shows a successful preview of the current commit', () => {
    const p = choosePreview(HEAD, [c({ label: 'preview/pr-7' })], true);
    expect(p).toMatchObject({
      state: 'ready',
      url: 'https://pr-7.example.test',
      label: 'preview/pr-7',
      source: 'deployment',
      sha: HEAD,
    });
  });

  it('never calls a preview of an older commit ready', () => {
    const p = choosePreview(HEAD, [c({ sha: OLD })], true);
    expect(p.state).toBe('stale');
    expect(p.url).toBe('https://pr-7.example.test');
    expect(p.detail).toContain('bbbbbbb');
    expect(p.detail).toContain('aaaaaaa');
  });

  it('says building while the pipeline is working on the current commit', () => {
    const p = choosePreview(HEAD, [c({ state: 'pending', url: undefined })], true);
    expect(p).toMatchObject({ state: 'building', url: null });
  });

  it('prefers an earlier success for the same commit over nothing, but a newer failure wins', () => {
    const ok = c({ at: '2026-10-18T10:00:00Z' });
    expect(
      choosePreview(HEAD, [ok, c({ state: 'pending', at: '2026-10-18T10:05:00Z' })], true).state,
    ).toBe('building');
    expect(
      choosePreview(HEAD, [ok, c({ state: 'failure', at: '2026-10-18T10:05:00Z' })], true).state,
    ).toBe('failed');
    expect(
      choosePreview(HEAD, [c({ state: 'failure', at: '2026-10-18T09:00:00Z' }), ok], true).state,
    ).toBe('ready');
  });

  it('reports a failure, and keeps the link to its log when there is one', () => {
    const p = choosePreview(
      HEAD,
      [c({ state: 'failure', url: 'https://ci.example.test/log/1' })],
      true,
    );
    expect(p).toMatchObject({ state: 'failed', url: 'https://ci.example.test/log/1' });
  });

  it('says none when nothing was reported, and explains a missing permission', () => {
    expect(choosePreview(HEAD, [], true).state).toBe('none');
    const p = choosePreview(HEAD, [], false);
    expect(p.state).toBe('not_permitted');
    expect(p.detail).toContain('Deployments');
  });

  it('still shows a commit-status preview when Deployments cannot be read', () => {
    expect(choosePreview(HEAD, [c({ source: 'status' })], false)).toMatchObject({
      state: 'ready',
      source: 'status',
    });
  });

  it('a success without a link is not a preview', () => {
    expect(choosePreview(HEAD, [c({ url: undefined })], true).state).toBe('none');
  });
});

describe('a preview the platform runs', () => {
  const run = (o: Partial<PreviewCandidate>): PreviewCandidate => ({
    source: 'platform',
    sha: HEAD,
    state: 'success',
    url: 'http://127.0.0.1:9100/',
    at: '2026-10-18T10:00:00Z',
    ...o,
  });

  it('is described as run by the platform, not by a pipeline', () => {
    expect(choosePreview(HEAD, [run({})], true)).toMatchObject({
      state: 'ready',
      source: 'platform',
      url: 'http://127.0.0.1:9100/',
    });
    expect(choosePreview(HEAD, [run({})], true).detail).toContain('Run by the platform');
    expect(choosePreview(HEAD, [run({ state: 'pending', url: undefined })], true).detail).toContain(
      'The platform is starting',
    );
    expect(choosePreview(HEAD, [run({ state: 'failure', url: undefined })], true)).toMatchObject({
      state: 'failed',
      detail: 'The platform could not start the preview.',
    });
  });

  it('is out of date once the pull request has a new commit', () => {
    expect(choosePreview('f'.repeat(40), [run({})], true).state).toBe('stale');
  });

  it('loses to a newer report from the pipeline, and wins over an older one', () => {
    const pipeline: PreviewCandidate = {
      source: 'deployment',
      sha: HEAD,
      state: 'success',
      url: 'https://pr.example.test/',
      at: '2026-10-18T11:00:00Z',
    };
    expect(choosePreview(HEAD, [run({}), pipeline], true).source).toBe('deployment');
    expect(choosePreview(HEAD, [run({ at: '2026-10-18T12:00:00Z' }), pipeline], true).source).toBe(
      'platform',
    );
  });
});

describe('safeUrl and normalizePreviewState', () => {
  it('lets only web addresses through', () => {
    expect(safeUrl('https://a.example.test/x')).toBe('https://a.example.test/x');
    expect(safeUrl('http://localhost:3000')).toBe('http://localhost:3000/');
    expect(safeUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeUrl('data:text/html,hi')).toBeUndefined();
    expect(safeUrl('not a url')).toBeUndefined();
    expect(safeUrl(42)).toBeUndefined();
  });
  it('maps both GitHub vocabularies and ignores inactive', () => {
    expect(
      ['success', 'queued', 'in_progress', 'pending', 'error', 'failure', 'inactive'].map(
        normalizePreviewState,
      ),
    ).toEqual(['success', 'pending', 'pending', 'pending', 'failure', 'failure', null]);
  });
});

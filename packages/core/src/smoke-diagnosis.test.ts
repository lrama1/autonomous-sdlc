import { describe, expect, it } from 'vitest';
import { buildDiagnosisPacket, parseDiagnosisReply } from './smoke-diagnosis.js';

const good = {
  verdict: 'checks',
  summary: 'The checks predate the login.',
  recommendation: 'Update them.',
  instruction: 'Edit .sdlc/preview.yaml.',
};

describe('parseDiagnosisReply', () => {
  it('reads a bare object and one inside a fence or after some talk', () => {
    const json = JSON.stringify(good);
    for (const reply of [json, '```json\n' + json + '\n```', `Here you go: ${json} Done.`])
      expect(parseDiagnosisReply(reply)).toMatchObject({
        ok: true,
        diagnosis: { verdict: 'checks', instruction: 'Edit .sdlc/preview.yaml.' },
      });
  });

  it('asks again for what a person acts on: a verdict, words, and an instruction when the fix is the engineer’s', () => {
    expect(parseDiagnosisReply('no json here')).toMatchObject({ ok: false });
    expect(
      parseDiagnosisReply('{"verdict":"maybe","summary":"x","recommendation":"y"}'),
    ).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('verdict')],
    });
    expect(
      parseDiagnosisReply(JSON.stringify({ ...good, verdict: 'code', instruction: '' })),
    ).toMatchObject({ ok: false, errors: [expect.stringContaining('instruction')] });
    expect(parseDiagnosisReply(JSON.stringify({ ...good, summary: '' }))).toMatchObject({
      ok: false,
    });
  });

  it('drops an instruction the verdict has no use for', () => {
    const r = parseDiagnosisReply(JSON.stringify({ ...good, verdict: 'environment' }));
    expect(r).toMatchObject({ ok: true, diagnosis: { verdict: 'environment', instruction: '' } });
  });
});

describe('buildDiagnosisPacket', () => {
  it('lists each check with its outcome, the smoke file and the changed files', () => {
    const packet = buildDiagnosisPacket({
      title: 'T3: sessions',
      summary: 'Added auth.',
      changedPaths: ['apps/api/src/app.ts'],
      previewFile: 'smoke:\n  - get: /api/accounts',
      results: [
        { label: 'GET /health', ok: true, detail: '200' },
        { label: 'GET /api/accounts', ok: false, detail: 'expected 200, got 401' },
      ],
    });
    expect(packet).toContain('PASSED GET /health');
    expect(packet).toContain('FAILED GET /api/accounts: expected 200, got 401');
    expect(packet).toContain('- get: /api/accounts');
    expect(packet).toContain('apps/api/src/app.ts');
  });

  it('says so when there is no smoke file or no check ran', () => {
    const packet = buildDiagnosisPacket({
      title: 't',
      summary: '',
      changedPaths: [],
      previewFile: null,
      results: [],
      note: 'The preview did not start.',
    });
    expect(packet).toContain('(there is no such file)');
    expect(packet).toContain('(no check ran)');
    expect(packet).toContain('Platform note: The preview did not start.');
  });
});

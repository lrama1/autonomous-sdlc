import { describe, expect, it } from 'vitest';
import {
  blockingFindings,
  buildReviewPacket,
  findingsAsChangeRequest,
  needsSecurityReview,
  onlyDocuments,
  parseSecurityReply,
  relativeImports,
  severityCounts,
} from './security.js';
import type { SecurityFinding } from './security.js';

const finding = (o: Partial<SecurityFinding> = {}): SecurityFinding => ({
  id: 'F1',
  severity: 'high',
  category: 'xss',
  file: 'src/app.js',
  line: 12,
  title: 'Name breaks out of an attribute',
  why: 'A quote in a name ends the attribute and adds a handler.',
  fix: 'Escape quotes, or attach the handler with addEventListener.',
  ...o,
});

const reply = (findings: unknown[], summary = 'One high finding.') =>
  JSON.stringify({ summary, findings });

describe('parseSecurityReply', () => {
  it('reads findings from a fenced block or from bare JSON, and numbers them', () => {
    const body = reply([
      {
        severity: 'High',
        category: 'XSS',
        file: 'src/app.js',
        line: 12,
        title: 'T',
        why: 'W',
        fix: 'F',
      },
      {
        severity: 'low',
        category: 'headers',
        file: 'src/main.js',
        line: null,
        title: 'T2',
        why: 'W2',
        fix: 'F2',
      },
    ]);
    for (const text of [
      `Here is my review.\n\`\`\`json\n${body}\n\`\`\`\nDone.`,
      `Review: ${body}`,
    ]) {
      const r = parseSecurityReply(text);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.summary).toBe('One high finding.');
        expect(r.findings.map((f) => [f.id, f.severity, f.category, f.line])).toEqual([
          ['F1', 'high', 'xss', 12],
          ['F2', 'low', 'headers', null],
        ]);
      }
    }
  });

  it('accepts a clean review: a summary and no findings', () => {
    const r = parseSecurityReply(reply([], 'Nothing to report.'));
    expect(r).toEqual({ ok: true, summary: 'Nothing to report.', findings: [] });
  });

  it('says what is wrong, so the agent can be asked again', () => {
    const errors = (t: string) => {
      const r = parseSecurityReply(t);
      if (r.ok) throw new Error('expected errors');
      return r.errors.join(' | ');
    };
    expect(errors('no json here')).toContain('no JSON object');
    expect(errors('{ "a": }')).toContain('does not parse');
    expect(errors('[1]')).toContain('no JSON object');
    expect(errors(JSON.stringify({ findings: [] }))).toContain('summary is required');
    expect(errors(JSON.stringify({ summary: 'x' }))).toContain('findings must be a list');
    expect(
      errors(
        reply([{ severity: 'scary', category: 'c', file: 'f', title: 't', why: 'w', fix: 'x' }]),
      ),
    ).toContain('severity must be one of');
    expect(
      errors(reply([{ severity: 'high', category: 'c', file: 'f', title: 't', why: 'w' }])),
    ).toContain('finding 1: fix is required');
    expect(errors(reply(['x']))).toContain('finding 1 must be an object');
    expect(errors(reply(Array.from({ length: 31 }, () => ({}))))).toContain('31 findings');
  });
});

describe('what findings mean for approving', () => {
  it('blocks on critical and high that nobody dismissed, and on nothing else', () => {
    const list = [
      finding({ id: 'F1', severity: 'critical' }),
      finding({ id: 'F2', severity: 'high' }),
      finding({ id: 'F3', severity: 'medium' }),
      finding({ id: 'F4', severity: 'low' }),
      finding({
        id: 'F5',
        severity: 'high',
        dismissed: {
          by: 'p1',
          byName: 'Bob',
          reason: 'Internal tool, no untrusted input.',
          at: 'now',
        },
      }),
    ];
    expect(blockingFindings(list).map((f) => f.id)).toEqual(['F1', 'F2']);
    expect(blockingFindings([])).toEqual([]);
  });

  it('counts by severity, highest first', () => {
    expect(severityCounts([finding(), finding({ severity: 'low' }), finding()])).toBe(
      '2 high, 1 low',
    );
    expect(severityCounts([])).toBe('no findings');
  });

  it('needs a review for anything that is not only documents', () => {
    expect(needsSecurityReview(['README.md', 'docs/spec/x.md'])).toBe(false);
    expect(needsSecurityReview(['docs/design/x.md'])).toBe(false);
    expect(needsSecurityReview(['README.md', 'src/app.js'])).toBe(true);
    expect(needsSecurityReview(['.github/workflows/ci.yml'])).toBe(true);
    expect(needsSecurityReview(['package.json'])).toBe(true);
    expect(needsSecurityReview([])).toBe(false);
  });

  it('writes a change request from the findings that are still open', () => {
    const text = findingsAsChangeRequest([
      finding({ id: 'F1' }),
      finding({ id: 'F2', severity: 'info', title: 'Note' }),
      finding({
        id: 'F3',
        dismissed: { by: 'p', byName: null, reason: 'fine here, it is a test', at: 'now' },
      }),
      finding({
        id: 'F4',
        severity: 'medium',
        line: null,
        file: 'src/main.js',
        title: 'No size limit',
      }),
    ]);
    expect(text).toContain('F1 [high] Name breaks out of an attribute (src/app.js:12)');
    expect(text).toContain('F4 [medium] No size limit (src/main.js)');
    expect(text).not.toContain('F2');
    expect(text).not.toContain('F3');
    expect(text).toContain('add a test that would have caught it');
  });
});

describe('what the agent is shown', () => {
  it('finds the relative files a source file imports', () => {
    const src =
      "import a from './a.js';\nimport b from '../lib/b.js';\nconst c = require('./c');\nimport x from 'express';\nawait import('./d.js');";
    expect(relativeImports('src/app.js', src).sort()).toEqual([
      'lib/b.js',
      'src/a.js',
      'src/c',
      'src/d.js',
    ]);
    expect(relativeImports('main.js', "import a from './src/a.js'")).toEqual(['src/a.js']);
  });

  it('puts the diff and the numbered files in one text, and cuts what is too big', () => {
    const packet = buildReviewPacket({
      title: 'Add a list',
      body: '',
      files: [
        { path: 'src/app.js', status: 'added', patch: '@@ -0,0 +1 @@\n+el.innerHTML = name;' },
        { path: 'logo.png', status: 'added', patch: null },
      ],
      contents: [
        { path: 'src/app.js', text: 'el.innerHTML = name;\nrender();', imported: false },
        { path: 'src/util.js', text: 'export const x = 1;', imported: true },
        { path: 'src/big.js', text: 'x'.repeat(50_000), imported: false },
      ],
    });
    expect(packet).toContain('# Pull request: Add a list');
    expect(packet).toContain('(no description)');
    expect(packet).toContain('### src/app.js (added)');
    expect(packet).toContain('+el.innerHTML = name;');
    expect(packet).toContain('(no text diff: binary or too large)');
    expect(packet).toContain('   1  el.innerHTML = name;');
    expect(packet).toContain('   2  render();');
    expect(packet).toContain('### src/util.js (imported by a changed file, not itself changed)');
    expect(packet).toContain('(file cut here)');
  });
});

describe('onlyDocuments', () => {
  it('is true only for a known change made of documents', () => {
    expect(onlyDocuments(['docs/spec/x.md', 'README.md'])).toBe(true);
    expect(onlyDocuments(['docs/design/x.md', 'src/app.ts'])).toBe(false);
    expect(onlyDocuments(['.github/workflows/ci.yml'])).toBe(false);
    // No file list means nobody knows, so it is not treated as documents.
    expect(onlyDocuments([])).toBe(false);
  });
});

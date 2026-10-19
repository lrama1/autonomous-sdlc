// The Security agent's work, as pure functions (mvp-contract section 16, security review): what it is shown, how its answer
// is read, and what its findings mean for approving a pull request. Nothing here calls a model or GitHub.

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Dismissal {
  by: string;
  byName: string | null;
  reason: string;
  at: string;
}

export interface SecurityFinding {
  /** F1, F2, ... in the order the agent listed them. */
  id: string;
  severity: Severity;
  /** Short kind, for example "xss", "injection", "authorization", "secret", "path-traversal". */
  category: string;
  file: string;
  line: number | null;
  title: string;
  /** Why it matters, and how it could be abused. */
  why: string;
  /** What to change. */
  fix: string;
  dismissed?: Dismissal;
}

export type SecurityReplyResult =
  { ok: true; summary: string; findings: SecurityFinding[] } | { ok: false; errors: string[] };

const MAX_FINDINGS = 30;
const MAX_TEXT = 1500;
const SEVERITY_SET = new Set<string>(SEVERITIES);

const text = (v: unknown, max = MAX_TEXT): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null;

/** The first JSON object in a reply: a ```json fence if there is one, otherwise the outermost braces. */
function jsonOf(reply: string): string | null {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(reply);
  if (fenced && fenced[1]!.trim().startsWith('{')) return fenced[1]!.trim();
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  return start >= 0 && end > start ? reply.slice(start, end + 1) : null;
}

/**
 * Reads the agent's reply: `{ "summary": "...", "findings": [{ severity, category, file, line, title, why, fix }] }`.
 * Strict about the fields a person acts on, so a malformed answer is asked for again and not guessed at.
 */
export function parseSecurityReply(reply: string): SecurityReplyResult {
  const raw = jsonOf(reply);
  if (raw === null) return { ok: false, errors: ['the reply holds no JSON object'] };
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      errors: [
        `the JSON does not parse: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`,
      ],
    };
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj))
    return { ok: false, errors: ['the JSON must be an object with summary and findings'] };
  const o = obj as Record<string, unknown>;
  const summary = text(o.summary, 600);
  if (summary === null) return { ok: false, errors: ['summary is required: one or two sentences'] };
  if (!Array.isArray(o.findings))
    return { ok: false, errors: ['findings must be a list (an empty list when there is nothing)'] };
  if (o.findings.length > MAX_FINDINGS)
    return {
      ok: false,
      errors: [
        `there are ${o.findings.length} findings: report the ${MAX_FINDINGS} that matter most`,
      ],
    };
  const errors: string[] = [];
  const findings: SecurityFinding[] = [];
  o.findings.forEach((f, i) => {
    const at = `finding ${i + 1}`;
    if (f === null || typeof f !== 'object' || Array.isArray(f)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const r = f as Record<string, unknown>;
    const before = errors.length;
    const severity = typeof r.severity === 'string' ? r.severity.toLowerCase() : '';
    if (!SEVERITY_SET.has(severity))
      errors.push(`${at}: severity must be one of ${SEVERITIES.join(', ')}`);
    const title = text(r.title, 160);
    const why = text(r.why);
    const fix = text(r.fix);
    const file = text(r.file, 300);
    const category = text(r.category, 60);
    if (!title) errors.push(`${at}: title is required`);
    if (!why) errors.push(`${at}: why is required`);
    if (!fix) errors.push(`${at}: fix is required`);
    if (!file) errors.push(`${at}: file is required`);
    if (!category) errors.push(`${at}: category is required`);
    const line =
      typeof r.line === 'number' && Number.isInteger(r.line) && r.line > 0 ? r.line : null;
    if (errors.length === before)
      findings.push({
        id: `F${i + 1}`,
        severity: severity as Severity,
        category: category!.toLowerCase(),
        file: file!,
        line,
        title: title!,
        why: why!,
        fix: fix!,
      });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, summary, findings };
}

const BLOCKING = new Set<Severity>(['critical', 'high']);

/** Findings that stop an approval: critical or high, that no person has dismissed with a reason. */
export function blockingFindings(findings: SecurityFinding[]): SecurityFinding[] {
  return findings.filter((f) => BLOCKING.has(f.severity) && !f.dismissed);
}

/** Counts by severity, highest first, for one line on the review. */
export function severityCounts(findings: SecurityFinding[]): string {
  const parts = SEVERITIES.flatMap((s) => {
    const n = findings.filter((f) => f.severity === s).length;
    return n > 0 ? [`${n} ${s}`] : [];
  });
  return parts.length > 0 ? parts.join(', ') : 'no findings';
}

const DOCS_ONLY = (p: string) => /\.md$/i.test(p) || p.startsWith('docs/');

/**
 * A change that only touches documents has nothing for a security review to read. Anything else, including a
 * configuration file or a workflow, does.
 */
export function needsSecurityReview(changedPaths: string[]): boolean {
  return changedPaths.length === 0 ? false : !changedPaths.every(DOCS_ONLY);
}

/** The text of a change request that sends the findings back to the engineer. */
export function findingsAsChangeRequest(findings: SecurityFinding[]): string {
  const open = findings.filter((f) => !f.dismissed && f.severity !== 'info');
  const lines = open.map(
    (f) =>
      `- ${f.id} [${f.severity}] ${f.title} (${f.file}${f.line ? `:${f.line}` : ''}): ${f.why} Fix: ${f.fix}`,
  );
  return [
    'The security review found problems that need to be fixed before this can merge:',
    ...lines,
    '',
    'Fix each one, add a test that would have caught it, and run the verification again.',
  ].join('\n');
}

const IMPORT = /(?:from\s+|require\(\s*|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** Relative files a source file imports, resolved against its own folder. One level; the caller decides what to read. */
export function relativeImports(file: string, source: string): string[] {
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  const out = new Set<string>();
  for (const m of source.matchAll(IMPORT)) {
    const parts = (dir ? `${dir}/${m[1]}` : m[1]!).split('/');
    const stack: string[] = [];
    for (const part of parts) {
      if (part === '.' || part === '') continue;
      if (part === '..') stack.pop();
      else stack.push(part);
    }
    out.add(stack.join('/'));
  }
  return [...out];
}

export interface ReviewPacketInput {
  title: string;
  body: string;
  files: Array<{ path: string; status: string; patch: string | null }>;
  /** Full text at the head commit: the changed files first, then what they import. */
  contents: Array<{ path: string; text: string; imported: boolean }>;
}

export const PACKET_LIMITS = { patch: 120_000, file: 40_000, total: 260_000 } as const;

/** Everything the agent is shown, in one text, cut at fixed limits with a note where it was cut. */
export function buildReviewPacket(input: ReviewPacketInput): string {
  const out: string[] = [
    `# Pull request: ${input.title}`,
    '',
    input.body.trim() || '(no description)',
    '',
  ];
  out.push('## Changes (unified diff per file)', '');
  let patchBudget: number = PACKET_LIMITS.patch;
  for (const f of input.files) {
    out.push(`### ${f.path} (${f.status})`);
    if (f.patch === null) out.push('(no text diff: binary or too large)');
    else if (patchBudget <= 0) out.push('(diff left out: the change is too large to show in full)');
    else {
      const cut = f.patch.length > patchBudget;
      out.push('```diff', f.patch.slice(0, patchBudget), '```');
      if (cut) out.push('(diff cut here)');
      patchBudget -= f.patch.length;
    }
    out.push('');
  }
  out.push('## Files as they are after the change', '');
  let total: number = PACKET_LIMITS.total;
  for (const c of input.contents) {
    if (total <= 0) {
      out.push(`### ${c.path}`, '(left out: the packet is full)', '');
      continue;
    }
    const body = c.text.length > PACKET_LIMITS.file ? c.text.slice(0, PACKET_LIMITS.file) : c.text;
    const numbered = body
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(4)}  ${l}`)
      .join('\n');
    out.push(
      `### ${c.path}${c.imported ? ' (imported by a changed file, not itself changed)' : ''}`,
      '```',
      numbered,
      '```',
      body.length < c.text.length ? '(file cut here)' : '',
      '',
    );
    total -= body.length;
  }
  return out.join('\n');
}

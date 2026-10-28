// An AI's reading of why a smoke test failed (mvp-contract, smoke diagnosis). It advises a person. It cannot approve,
// override or merge anything.

export const DIAGNOSIS_VERDICTS = ['code', 'checks', 'environment', 'unclear'] as const;
export type DiagnosisVerdict = (typeof DIAGNOSIS_VERDICTS)[number];

export interface SmokeDiagnosis {
  verdict: DiagnosisVerdict;
  summary: string;
  recommendation: string;
  /** What to tell the engineer, when the fix is theirs to make. Empty for an environment problem. */
  instruction: string;
}

export type DiagnosisReplyResult =
  { ok: true; diagnosis: SmokeDiagnosis } | { ok: false; errors: string[] };

export const SMOKE_DIAGNOSIS_SYSTEM = `You read one failed smoke test of a pull request for a person who must decide what to do. You see the failed checks, the repository's smoke file (.sdlc/preview.yaml), the pull request's summary and the files it changed. You have no tools and cannot run anything, so say what you can see and what you are guessing.

Decide which of these is the most likely cause:
- "code": the application is wrong. The check asks for something the pull request or the design promised, and the app does not do it.
- "checks": the smoke checks are out of date or wrong. A check expects behaviour that this change, or an earlier one, deliberately replaced (for example an endpoint that now needs a login), or it tests something a later task builds. The application is behaving as intended.
- "environment": the preview or the network failed, not the app or the checks (it did not start, timed out, a port or install problem). Running the test again may be enough.
- "unclear": you cannot tell from what you were given.

Answer with one JSON object and nothing else:
{
  "verdict": "code" | "checks" | "environment" | "unclear",
  "summary": "two or three sentences: what failed and why you think so, citing the check and the file or line you relied on",
  "recommendation": "one sentence: what the person should do next",
  "instruction": "for code or checks: the exact instruction to give the engineer, written to the engineer, naming the checks or files. For checks, say that the engineer may edit .sdlc/preview.yaml (a protected file, so a person will be asked to allow it), which checks to remove, change or add, and to keep every check that still holds. Empty string for environment or unclear."
}

Never tell the person to override the test to get past a real failure. Do not invent files or lines you were not shown.`;

export interface DiagnosisInput {
  title: string;
  /** What the engineer wrote about the change, if anything. */
  summary: string;
  changedPaths: string[];
  /** The text of .sdlc/preview.yaml at this commit, or null when there is none. */
  previewFile: string | null;
  results: Array<{ label: string; ok: boolean; detail: string }>;
  /** What the preview printed before the checks ran. */
  note?: string | null;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n[cut]` : s);

export function buildDiagnosisPacket(i: DiagnosisInput): string {
  const lines = [
    `Pull request: ${i.title}`,
    '',
    'What the engineer said about it:',
    clip(i.summary.trim() || '(nothing)', 3500),
    '',
    `Files changed (${i.changedPaths.length}): ${i.changedPaths.slice(0, 40).join(', ') || '(none listed)'}`,
    '',
    '.sdlc/preview.yaml at this commit:',
    '```yaml',
    clip(i.previewFile ?? '(there is no such file)', 3500),
    '```',
    '',
    'The smoke test:',
    ...(i.results.length > 0
      ? i.results.map((r) => `- ${r.ok ? 'PASSED' : 'FAILED'} ${r.label}: ${clip(r.detail, 500)}`)
      : ['(no check ran)']),
  ];
  if (i.note) lines.push('', `Platform note: ${clip(i.note, 800)}`);
  lines.push('', 'Say why it failed now. Answer with the JSON object only.');
  return lines.join('\n');
}

function jsonOf(reply: string): string | null {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(reply);
  if (fenced && fenced[1]!.trim().startsWith('{')) return fenced[1]!.trim();
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  return start >= 0 && end > start ? reply.slice(start, end + 1) : null;
}

const text = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

export function parseDiagnosisReply(reply: string): DiagnosisReplyResult {
  const raw = jsonOf(reply);
  if (raw === null) return { ok: false, errors: ['the reply holds no JSON object'] };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    return {
      ok: false,
      errors: [
        `the JSON does not parse: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`,
      ],
    };
  }
  const verdict = DIAGNOSIS_VERDICTS.find((v) => v === obj.verdict);
  const summary = text(obj.summary, 1200);
  const recommendation = text(obj.recommendation, 400);
  const errors: string[] = [];
  if (!verdict) errors.push('"verdict" must be code, checks, environment or unclear');
  if (!summary) errors.push('"summary" is missing');
  if (!recommendation) errors.push('"recommendation" is missing');
  if (errors.length > 0 || !verdict) return { ok: false, errors };
  const instruction = verdict === 'code' || verdict === 'checks' ? text(obj.instruction, 2000) : '';
  if ((verdict === 'code' || verdict === 'checks') && !instruction)
    return { ok: false, errors: ['"instruction" is missing for a code or checks verdict'] };
  return { ok: true, diagnosis: { verdict, summary, recommendation, instruction } };
}

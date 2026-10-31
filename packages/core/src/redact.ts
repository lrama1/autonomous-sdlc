// Takes secrets out of text before it is stored or shown. The live log and every other reader of run events get the
// redacted version, because the events are redacted when they are written (packages/db/src/run-events.ts).

export const REDACTED = '[redacted]';

// Each pattern keeps what makes the line readable (the name of the variable, the scheme) and drops the secret.
const PATTERNS: Array<[RegExp, string | ((m: string, ...g: string[]) => string)]> = [
  // A private key block, whole.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  // Authorization headers and bearer tokens.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_m, scheme) => `${scheme} ${REDACTED}`],
  // A password or token in a URL: https://user:secret@host
  [
    /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi,
    (_m, scheme, user) => `${scheme}${user}:${REDACTED}@`,
  ],
  // Names of the keys the platform and its vendors hand out.
  [/\bsdlc_[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bsk-(?:or-v1|ant-[a-z0-9]+|proj|live|test)?-?[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  // A JSON web token.
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // NAME=value and "name": "value" where the name says it is secret.
  [
    /\b([A-Za-z0-9_.-]*(?:secret|password|passwd|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;&}"']+)/gi,
    (m, name, sep, value) => {
      // "Authorization: Bearer x": the scheme word is not the secret, and the bearer rule already took the token.
      if (/^(Bearer|Basic)$/i.test(value)) return m;
      const q = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
      return `${name}${sep}${q}${REDACTED}${q}`;
    },
  ],
  // A quoted JSON key: "password":"value"
  [
    /("[A-Za-z0-9_.-]*(?:secret|password|passwd|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization)[A-Za-z0-9_.-]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    (_m, key) => `${key}"${REDACTED}"`,
  ],
];

/** The text with secrets replaced by [redacted]. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, to] of PATTERNS) out = out.replace(re, to as never);
  return out;
}

/** The same for every string inside a value (an event payload), however deeply it is nested. */
export function redactDeep<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    out[k] = redactDeep(v, depth + 1);
  return out as T;
}

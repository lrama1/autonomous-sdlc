import { describe, expect, it } from 'vitest';
import { REDACTED, redactDeep, redactSecrets } from './redact.js';

describe('redacting secrets', () => {
  const gone = (s: string, secret: string) => {
    const out = redactSecrets(s);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
    return out;
  };

  it('removes the keys the platform and its vendors hand out', () => {
    gone(
      'key sk-or-v1-0123456789abcdef0123456789abcdef',
      'sk-or-v1-0123456789abcdef0123456789abcdef',
    );
    gone('ANTHROPIC sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv', 'AbCdEfGhIjKlMnOpQrStUv');
    gone(
      'token ghs_abcdefghijklmnopqrstuvwxyz0123456789',
      'ghs_abcdefghijklmnopqrstuvwxyz0123456789',
    );
    gone(
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
    );
    gone(
      'run sdlc_0123456789abcdefghijklmnopqrstuvwxyz-_',
      'sdlc_0123456789abcdefghijklmnopqrstuvwxyz-_',
    );
    gone('aws AKIAIOSFODNN7EXAMPLE here', 'AKIAIOSFODNN7EXAMPLE');
    gone('slack xoxb-123456789012-abcdefghijkl', 'xoxb-123456789012-abcdefghijkl');
  });

  it('removes bearer tokens, JWTs, passwords in URLs, and private keys, and keeps the rest readable', () => {
    expect(redactSecrets('curl -H "Authorization: Bearer abcdef1234567890" https://x')).toBe(
      `curl -H "Authorization: Bearer ${REDACTED}" https://x`,
    );
    gone(
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    );
    expect(redactSecrets('git clone https://bot:hunter2secret@github.com/o/r.git')).toBe(
      `git clone https://bot:${REDACTED}@github.com/o/r.git`,
    );
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(`before\n${key}\nafter`)).toBe(`before\n${REDACTED}\nafter`);
  });

  it('removes the value of a variable or key that says it is secret, and keeps its name', () => {
    expect(redactSecrets('export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG')).toBe(
      `export AWS_SECRET_ACCESS_KEY=${REDACTED}`,
    );
    expect(redactSecrets('DB_PASSWORD: "p@ss w0rd"')).toBe(`DB_PASSWORD: "${REDACTED}"`);
    expect(redactSecrets('{"api_key":"abc123","name":"shop"}')).toBe(
      `{"api_key":"${REDACTED}","name":"shop"}`,
    );
    expect(redactSecrets('--token=abcdef --verbose')).toBe(`--token=${REDACTED} --verbose`);
  });

  it('leaves ordinary text alone', () => {
    for (const s of [
      'Read src/server.js and ran npm test: 12 passed',
      'the token count is 4000',
      'Added GET /api/plants with query light=low',
      'sk-learn is not a key',
      'Wrote test/auth.test.js',
    ])
      expect(redactSecrets(s)).toBe(s);
  });

  it('cleans every string in a nested value, and nothing else', () => {
    const v = {
      name: 'Bash',
      input: { command: 'curl -H "Authorization: Bearer abcdef1234567890" x', n: 3, ok: true },
      list: ['fine', 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123'],
      none: null,
    };
    const out = redactDeep(v);
    expect(JSON.stringify(out)).not.toContain('abcdef1234567890');
    expect(JSON.stringify(out)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(out.input.n).toBe(3);
    expect(out.input.ok).toBe(true);
    expect(out.none).toBeNull();
    expect(out.list[0]).toBe('fine');
  });
});

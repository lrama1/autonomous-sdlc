import { describe, expect, it } from 'vitest';
import { apiConfigSchema, parseEnv } from './config.js';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  OIDC_ISSUER: 'http://localhost:9000',
  OIDC_CLIENT_ID: 'sdlc-web',
  OIDC_CLIENT_SECRET: 'secret',
  SESSION_SECRET: 'x'.repeat(32),
};

describe('parseEnv', () => {
  it('applies defaults', () => {
    const cfg = parseEnv(apiConfigSchema, valid);
    expect(cfg.SDLC_ENV).toBe('local');
    expect(cfg.API_PORT).toBe(8080);
    expect(cfg.PUBLIC_URL).toBe('http://localhost:5173');
  });

  it('coerces numeric strings', () => {
    expect(parseEnv(apiConfigSchema, { ...valid, API_PORT: '9090' }).API_PORT).toBe(9090);
  });

  it('lists every problem at once', () => {
    expect(() => parseEnv(apiConfigSchema, { SESSION_SECRET: 'short' })).toThrow(
      /DATABASE_URL[\s\S]*OIDC_ISSUER[\s\S]*SESSION_SECRET/,
    );
  });

  it('rejects an unknown environment name', () => {
    expect(() => parseEnv(apiConfigSchema, { ...valid, SDLC_ENV: 'prod' })).toThrow(/SDLC_ENV/);
  });
});

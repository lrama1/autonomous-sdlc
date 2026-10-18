import { describe, expect, it } from 'vitest';
import { parsePreviewConfig } from './preview-config.js';

const errors = (text: string) => {
  const r = parsePreviewConfig(text);
  if (r.ok) throw new Error('expected errors');
  return r.errors.join(' | ');
};

describe('parsePreviewConfig', () => {
  it('reads a full file', () => {
    const r = parsePreviewConfig(
      'install: npm ci\nstart: npm run preview\nport: 4173\nready_path: /health\n',
    );
    expect(r).toEqual({
      ok: true,
      config: { install: 'npm ci', start: 'npm run preview', port: 4173, readyPath: '/health' },
    });
  });

  it('needs only a start command, and defaults the rest', () => {
    expect(parsePreviewConfig('start: node server.js')).toEqual({
      ok: true,
      config: { install: null, start: 'node server.js', port: 3000, readyPath: '/' },
    });
  });

  it('says what is wrong', () => {
    expect(errors('install: npm ci')).toContain('start is required');
    expect(errors('start: a\nport: 80')).toContain('port must be a whole number from 1024');
    expect(errors('start: a\nport: "3000"')).toContain('port must be');
    expect(errors('start: a\nready_path: health')).toContain('ready_path must be a path');
    expect(errors('start: a\nenv: {A: b}')).toContain('unknown key "env"');
    expect(errors('start: "a\\nb"')).toContain('start must be one line');
    expect(errors(`start: ${'x'.repeat(501)}`)).toContain('longer than 500');
    expect(errors('- a\n- b')).toContain('must be a mapping');
    expect(errors('start: [unclosed')).toContain('not valid YAML');
    expect(errors('')).toContain('must be a mapping');
  });
});

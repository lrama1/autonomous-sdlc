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
      config: {
        install: 'npm ci',
        start: 'npm run preview',
        port: 4173,
        readyPath: '/health',
        smoke: [],
      },
    });
  });

  it('needs only a start command, and defaults the rest', () => {
    expect(parsePreviewConfig('start: node server.js')).toEqual({
      ok: true,
      config: { install: null, start: 'node server.js', port: 3000, readyPath: '/', smoke: [] },
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

  describe('smoke', () => {
    const base = 'start: node server.js\n';
    const smoke = (text: string) => {
      const r = parsePreviewConfig(base + text);
      if (!r.ok) throw new Error(r.errors.join(' | '));
      return r.config.smoke;
    };

    it('reads get and run checks, with defaults', () => {
      expect(
        smoke(
          'smoke:\n  - get: /health\n  - get: /api/items\n    status: 201\n    contains: items\n  - run: npm run smoke\n',
        ),
      ).toEqual([
        { kind: 'get', path: '/health', status: 200, contains: null },
        { kind: 'get', path: '/api/items', status: 201, contains: 'items' },
        { kind: 'run', command: 'npm run smoke' },
      ]);
    });

    it('is optional', () => {
      expect(smoke('')).toEqual([]);
      expect(smoke('smoke:\n')).toEqual([]);
    });

    it('says what is wrong with a check', () => {
      expect(errors(`${base}smoke: /health`)).toContain('smoke must be a list');
      expect(errors(`${base}smoke:\n  - /health`)).toContain('smoke check 1 must be a mapping');
      expect(errors(`${base}smoke:\n  - status: 200`)).toContain('exactly one of get');
      expect(errors(`${base}smoke:\n  - get: /a\n    run: b`)).toContain('exactly one of get');
      expect(errors(`${base}smoke:\n  - get: health`)).toContain('get must be a path');
      expect(errors(`${base}smoke:\n  - get: "/a b"`)).toContain('get must be a path');
      expect(errors(`${base}smoke:\n  - get: /a\n    status: 99`)).toContain('status must be');
      expect(errors(`${base}smoke:\n  - get: /a\n    contains: ""`)).toContain('contains must be');
      expect(errors(`${base}smoke:\n  - get: /a\n    run: x`)).toContain('exactly one');
      expect(errors(`${base}smoke:\n  - get: /a\n    timeout: 5`)).toContain(
        'unknown key "timeout"',
      );
      expect(errors(`${base}smoke:\n  - run: x\n    status: 200`)).toContain(
        'unknown key "status"',
      );
      expect(errors(`${base}smoke:\n  - run: "a\\nb"`)).toContain('run must be one line');
    });

    it('limits how many checks there are', () => {
      const many = Array.from({ length: 21 }, () => '  - get: /').join('\n');
      expect(errors(`${base}smoke:\n${many}`)).toContain('The most allowed is 20');
    });
  });
});

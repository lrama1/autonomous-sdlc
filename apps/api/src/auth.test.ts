import { describe, expect, it } from 'vitest';
import { safeNext } from './auth.js';

describe('safeNext', () => {
  it('keeps a path on this site', () => {
    expect(safeNext('/admin/github')).toBe('/admin/github');
    expect(safeNext('/')).toBe('/');
  });
  it('drops anything that could lead to another address', () => {
    for (const bad of [
      undefined,
      '',
      'admin',
      '//evil.test',
      '/\\evil.test',
      'https://evil.test/',
      '/a//b',
      '/a?x=1',
      '/a b',
      `/${'a'.repeat(250)}`,
    ])
      expect(safeNext(bad), String(bad)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { HELP_GUIDE, HELP_PAGES, SHELL_HELP, helpAsText, helpFor } from './help-guide.js';

describe('help guide', () => {
  it.each(HELP_PAGES)('has a full entry for %s', (page) => {
    const s = HELP_GUIDE[page];
    expect(s.page).toBe(page);
    expect(s.title.length).toBeGreaterThan(0);
    expect(s.purpose.length).toBeGreaterThanOrEqual(60);
    expect(s.elements.length).toBeGreaterThanOrEqual(6);
    for (const e of s.elements) {
      expect(e.name.trim()).not.toBe('');
      expect(e.what.trim()).not.toBe('');
    }
  });

  it('describes the shell', () => {
    expect(SHELL_HELP.length).toBeGreaterThan(0);
    for (const e of SHELL_HELP) {
      expect(e.name.trim()).not.toBe('');
      expect(e.what.trim()).not.toBe('');
    }
  });

  it('finds a page by name and nothing else', () => {
    expect(helpFor('queue')?.title).toBe('Attention queue');
    expect(helpFor('nonsense')).toBeUndefined();
    expect(helpFor('toString')).toBeUndefined();
    expect(helpAsText('nonsense')).toBe('');
  });

  it('renders a page as text with its title and elements', () => {
    const text = helpAsText('queue');
    const queue = HELP_GUIDE.queue;
    expect(text).toContain(queue.title);
    expect(text).toContain(queue.elements[0]!.name);
  });
});

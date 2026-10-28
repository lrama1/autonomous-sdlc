import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HELP_PAGES } from './help-guide.js';

// The web app is not a dependency of this package, so its source is read as text. The guide is what the assistant
// explains screens from, so a screen added to the app without one fails here.
const app = readFileSync(new URL('../../../apps/web/src/App.tsx', import.meta.url), 'utf8');

describe('the help guide against the app', () => {
  it('has a guide for every screen the app routes to, and none for a screen it does not', () => {
    const routeType = /type Route =([\s\S]*?);\r?\n/.exec(app)![1]!;
    const pages = [...routeType.matchAll(/page: '(\w+)'/g)].map((m) => m[1]!).sort();
    expect(pages.length).toBeGreaterThan(8);
    expect([...HELP_PAGES].sort()).toEqual(pages);
  });

  it('has a guide for every screen in the navigation', () => {
    const nav = /const NAV[\s\S]*?\n\];/.exec(app)![0];
    const pages = [...nav.matchAll(/page: '(\w+)'/g)].map((m) => m[1]!).sort();
    expect([...HELP_PAGES].sort()).toEqual(pages);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contextFromHash } from './context';

describe('where the assistant thinks a person is', () => {
  const id = '0192a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b';
  it('reads the screen, the initiative on the Map and the review in the queue from the address', () => {
    expect(contextFromHash('#/map/' + id)).toMatchObject({ page: 'map', initiativeId: id });
    expect(contextFromHash('#/queue/' + id)).toMatchObject({ page: 'queue', interactionId: id });
    expect(contextFromHash('#/bugs')).toMatchObject({ page: 'bugs' });
    expect(contextFromHash('#/bugs')).not.toHaveProperty('initiativeId');
    expect(contextFromHash('#/map/not-an-id')).not.toHaveProperty('initiativeId');
    expect(contextFromHash('')).toMatchObject({ page: 'home' });
    expect(contextFromHash('#/somewhere-else')).toMatchObject({ page: 'home' });
  });

  it('knows every screen the app routes to', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    const routeType = /type Route =([\s\S]*?);\r?\n/.exec(app)![1]!;
    const pages = [...routeType.matchAll(/page: '(\w+)'/g)]
      .map((m) => m[1]!)
      .filter((p) => p !== 'home');
    for (const p of pages) expect(contextFromHash(`#/${p}`).page).toBe(p);
  });
});

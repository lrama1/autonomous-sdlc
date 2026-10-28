const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGES = new Set([
  'portfolio',
  'map',
  'queue',
  'assumptions',
  'autopilot',
  'interruptions',
  'bugs',
  'costs',
  'integrations',
  'repositories',
  'settings',
]);

export interface AssistantContext {
  page: string;
  hash: string;
  initiativeId?: string;
  interactionId?: string;
  pageText?: string;
}

/** Where a person is, from the address in the browser: the screen, and the initiative or review it has open. */
export function contextFromHash(hash: string): Omit<AssistantContext, 'pageText'> {
  const [page = '', id = ''] = hash.replace(/^#\/?/, '').split('/');
  const known = PAGES.has(page) ? page : 'home';
  return {
    page: known,
    hash: hash.replace(/^#/, '').slice(0, 300),
    ...(known === 'map' && UUID.test(id) ? { initiativeId: id } : {}),
    ...(known === 'queue' && UUID.test(id) ? { interactionId: id } : {}),
  };
}

/** What the screen shows, as text: the main area only, so the assistant's own panel is not read back to it. */
export function pageTextNow(): string {
  const main = document.querySelector('main');
  return (main?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 9000);
}

export function contextOf(): AssistantContext {
  return { ...contextFromHash(window.location.hash), pageText: pageTextNow() };
}

// What kind of work an initiative is (the web app's copy of the list and labels is in packages/schemas/src/work.ts). The agents are told, so a feature is not designed as if the repository were empty,
// and a first app is not squeezed into code that is not there.

export const INITIATIVE_KINDS = ['new_app', 'feature', 'change'] as const;
export type InitiativeKind = (typeof INITIATIVE_KINDS)[number];

export const KIND_LABEL: Record<InitiativeKind, string> = {
  new_app: 'New app',
  feature: 'Feature',
  change: 'Change or fix',
};

export const KIND_HELP: Record<InitiativeKind, string> = {
  new_app: 'A first build: the repository is empty or holds only scaffolding.',
  feature: 'Adds something to an app that already exists.',
  change: 'Changes or fixes behaviour that already exists, as small as it can be.',
};

export const isKind = (v: unknown): v is InitiativeKind =>
  typeof v === 'string' && (INITIATIVE_KINDS as readonly string[]).includes(v);

/** What to pick when nobody chose: a repository that already has work in it is being added to. */
export const suggestKind = (repositoryHasInitiatives: boolean): InitiativeKind =>
  repositoryHasInitiatives ? 'feature' : 'new_app';

export type KindAudience = 'product' | 'architect' | 'engineer';

const EXISTING =
  'The repository already holds a working app. Read what is there before you write anything: the README, the existing specs in docs/spec and designs in docs/design, and the code this work touches.';

/**
 * The paragraph that goes into an agent's task for this kind of work, or null when the kind is not known (older
 * initiatives), so their tasks read as they always did.
 */
export function kindGuidance(
  kind: string | null | undefined,
  audience: KindAudience,
): string | null {
  if (!isKind(kind)) return null;
  const head = `Kind of work: ${KIND_LABEL[kind]}.`;
  if (kind === 'new_app') {
    return audience === 'engineer'
      ? `${head} This is part of a new app. Other tasks build the rest, so keep to your task and to the structure the design gives.`
      : `${head} This is a first build. The repository may be empty or hold only scaffolding, so the ${audience === 'product' ? 'spec' : 'design'} covers the whole app, with the journeys a first release needs.`;
  }
  if (kind === 'feature') {
    if (audience === 'product')
      return `${head} ${EXISTING} The spec covers only this feature. Say how it fits into what exists, which existing screens, routes and data it touches, and which existing behaviour must not change. Do not re-specify what already works.`;
    if (audience === 'architect')
      return `${head} ${EXISTING} Design only this feature, on top of the existing structure, stack, naming and tests. Reuse what exists. Do not restructure, rename or replace working code. The tasks list what to add or change, and says where it connects to existing code.`;
    return `${head} This adds to an existing app. Follow its conventions, stack and tests. Reuse what exists. Keep your change to what the task says, and leave working code alone.`;
  }
  if (audience === 'product')
    return `${head} ${EXISTING} The spec says what behaviour is wrong or to be different, what it should be, and what must stay the same. Keep it as small as it can be.`;
  if (audience === 'architect')
    return `${head} ${EXISTING} Find where the current behaviour comes from, and plan the smallest change that gives the new behaviour. Name what is changed and what is not, and the tests that show it.`;
  return `${head} This changes existing behaviour. Find the current behaviour first. Make the smallest change that does what the task says, and add or update a test that shows it.`;
}

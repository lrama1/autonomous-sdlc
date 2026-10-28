// Which initiative the Map opens on when no one has chosen one. Pure.

export interface InitiativeChoice {
  id: string;
  state: string;
}

const FINISHED = ['done', 'cancelled'];

/**
 * The initiative the person was last looking at, if it is still unfinished. Otherwise the first one in progress
 * (`active`), then the first one not yet started or paused. The list is newest first. Finished ones are never picked
 * for the person, though they can still choose one by hand.
 */
export function pickInitiative(list: InitiativeChoice[], lastViewed: string | null): string | null {
  const open = list.filter((i) => !FINISHED.includes(i.state));
  const last = open.find((i) => i.id === lastViewed);
  if (last) return last.id;
  return (open.find((i) => i.state === 'active') ?? open[0])?.id ?? null;
}

import type { SecurityDto, SmokeDto } from '@sdlc/schemas';

/** Something that stops a person deciding a review right now, and where to go to clear it. */
export interface Blocker {
  id: 'own' | 'smoke' | 'security';
  reason: string;
  /** The panel that holds the fix, or null when nothing on the page can clear it. */
  panel: 'smoke' | 'security' | null;
  /** Whether it stops every decision or only approving. Sending work back never needs a check to have run. */
  stops: 'all' | 'approve';
}

/**
 * What stands between the person and the Approve button, from what the page already knows. The server enforces the same
 * rules when a decision arrives, so a check the page has not heard about yet is still caught, just later.
 */
export function blockersOf(s: {
  smoke: SmokeDto | null;
  security: SecurityDto | null;
  youMayNotDecide?: string | null;
}): Blocker[] {
  const out: Blocker[] = [];
  if (s.youMayNotDecide)
    out.push({ id: 'own', reason: s.youMayNotDecide, panel: null, stops: 'all' });
  if (s.security?.blocks)
    out.push({ id: 'security', reason: s.security.blocks, panel: 'security', stops: 'approve' });
  if (s.smoke?.blocks)
    out.push({ id: 'smoke', reason: s.smoke.blocks, panel: 'smoke', stops: 'approve' });
  return out;
}

export const stopsApprove = (b: Blocker[]) => b.length > 0;
export const stopsSendingBack = (b: Blocker[]) => b.some((x) => x.stops === 'all');

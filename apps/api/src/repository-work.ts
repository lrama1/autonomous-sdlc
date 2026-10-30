import { and, eq, lt, ne } from 'drizzle-orm';
import { initiative } from '@sdlc/db';
import type { Db } from '@sdlc/db';

/**
 * Whether anyone has started work on this repository before. A new initiative there is adding to something, and a
 * "new app" there would sit next to another app. For an initiative that already exists, only those made before it
 * count: the first app owns the repository root, and what came after sits beside it.
 */
export async function repositoryHasWork(
  db: Db,
  repositoryId: string,
  existing?: { id: string; createdAt: Date },
): Promise<boolean> {
  const [row] = await db
    .select({ id: initiative.id })
    .from(initiative)
    .where(
      and(
        eq(initiative.repositoryId, repositoryId),
        existing ? ne(initiative.id, existing.id) : undefined,
        existing ? lt(initiative.createdAt, existing.createdAt) : undefined,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** What to tell whoever makes a new app in a repository that already has work in it. */
export const ALONGSIDE_WARNING =
  'This repository already has work in it. A new app here is built next to the existing one, in its own folder, but the platform previews and smoke-tests whatever the repository root starts, which is the other app. Its preview and smoke checks cannot vouch for this app. For a separate app, register another repository.';

/** What a review, a preview or a smoke test says about an app that shares its repository with another. */
export const SHARED_REPOSITORY_NOTE =
  'This app shares a repository with another app. The platform previews and smoke-tests what the repository root starts, which is the other app, so those results would say nothing about this one. Read the diff and try the app yourself, or move it to its own repository.';

/** Whether this initiative is a new app built next to another app in its repository. */
export async function isAlongside(
  db: Db,
  initiativeId: string | null | undefined,
): Promise<boolean> {
  if (!initiativeId) return false;
  const [row] = await db
    .select({ a: initiative.alongside })
    .from(initiative)
    .where(eq(initiative.id, initiativeId));
  return row?.a ?? false;
}

import { and, eq, ne } from 'drizzle-orm';
import { initiative } from '@sdlc/db';
import type { Db } from '@sdlc/db';

/**
 * Whether anyone has started work on this repository before (another initiative than `except`). A new initiative there
 * is adding to something, and a "new app" there would sit next to another app.
 */
export async function repositoryHasWork(
  db: Db,
  repositoryId: string,
  except?: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: initiative.id })
    .from(initiative)
    .where(
      and(
        eq(initiative.repositoryId, repositoryId),
        except ? ne(initiative.id, except) : undefined,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** What to tell whoever makes a new app in a repository that already has work in it. */
export const ALONGSIDE_WARNING =
  'This repository already has work in it. A new app here is built next to the existing one, in its own folder, but the platform previews and tests one app from a repository root. For a separate app, register another repository.';

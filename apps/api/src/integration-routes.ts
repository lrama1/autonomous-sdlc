import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { integrationEntry } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { integrationCreateSchema, integrationPatchSchema, integrationSchema } from '@sdlc/schemas';
import { z } from 'zod';
import { recordActivity } from './activity.js';
import { latestSnapshots, raiseDocsChanged, refreshDocs } from './integrations.js';
import type { DocFetcher, IntegrationRow } from './integrations.js';
import { requirePerson } from './people.js';
import type { Signed } from './people.js';

// The Architect or an Engineer confirms entries (spec 6.7). Anyone signed in can read them.
const CONFIRMING: Signed['roles'] = [
  'architect',
  'backend_engineer',
  'frontend_engineer',
  'platform_admin',
];
const mayConfirm = (me: Signed) => me.roles.some((r) => CONFIRMING.includes(r));

const notFound = { error: { code: 'not_found', message: 'No such integration.' } };
const forbidden = {
  error: {
    code: 'wrong_role',
    message: 'An Architect, an Engineer, or a Platform Admin confirms what agents may call.',
  },
};

async function toDto(db: Db, rows: IntegrationRow[]) {
  const snaps = await latestSnapshots(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) =>
    integrationSchema.parse({
      id: r.id,
      name: r.name,
      kind: r.kind,
      owner: r.owner,
      initiativeId: r.initiativeId,
      docs: r.docs,
      hosts: r.hosts,
      authType: r.authType,
      credentialRef: r.credentialRef,
      dataSent: r.dataSent,
      dataReceived: r.dataReceived,
      testStrategy: r.testStrategy,
      limitsAndCost: r.limitsAndCost,
      terms: r.terms,
      failureBehavior: r.failureBehavior,
      status: r.status,
      proposedBy: r.proposedBy,
      confirmedAt: r.confirmedAt?.toISOString() ?? null,
      snapshots: snaps
        .filter((s) => s.integrationId === r.id)
        .map((s) => ({
          url: s.url,
          fetchedAt: s.fetchedAt.toISOString(),
          ok: s.content !== null,
          error: s.error,
          sha256: s.sha256.slice(0, 12),
        })),
    }),
  );
}

export function registerIntegrationRoutes(app: FastifyInstance, db: Db, fetcher: DocFetcher): void {
  async function refresh(entry: IntegrationRow) {
    const result = await refreshDocs(db, entry, fetcher);
    if (result.changed.length > 0 && entry.status === 'confirmed')
      await raiseDocsChanged(db, entry, result.changed);
    return result;
  }

  app.get('/api/integrations', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const rows = await db.select().from(integrationEntry).orderBy(desc(integrationEntry.createdAt));
    return toDto(db, rows);
  });

  app.post('/api/integrations', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    if (!mayConfirm(me)) return reply.code(403).send(forbidden);
    const body = integrationCreateSchema.parse(request.body ?? {});
    const [taken] = await db
      .select({ id: integrationEntry.id })
      .from(integrationEntry)
      .where(eq(integrationEntry.name, body.name));
    if (taken)
      return reply.code(409).send({
        error: { code: 'name_taken', message: `There is already an entry named "${body.name}".` },
      });
    const [row] = await db
      .insert(integrationEntry)
      .values({
        ...body,
        hosts: [...new Set(body.hosts.map((h) => h.toLowerCase()))],
        initiativeId: body.initiativeId ?? null,
        owner: body.owner ?? null,
        credentialRef: body.credentialRef ?? null,
        dataSent: body.dataSent ?? null,
        dataReceived: body.dataReceived ?? null,
        limitsAndCost: body.limitsAndCost ?? null,
        terms: body.terms ?? null,
        failureBehavior: body.failureBehavior ?? null,
        // A person with the right hat adding an entry is the confirmation.
        status: 'confirmed',
        proposedBy: me.id,
        confirmedBy: me.id,
        confirmedAt: new Date(),
      })
      .returning();
    await recordActivity(db, {
      actorType: 'person',
      actorId: me.id,
      initiativeId: row!.initiativeId,
      action: 'integration.confirmed',
      detail: { name: row!.name, hosts: row!.hosts, testStrategy: row!.testStrategy },
    });
    await refresh(row!).catch(() => {});
    return reply.code(201).send((await toDto(db, [row!]))[0]);
  });

  app.patch('/api/integrations/:id', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    if (!mayConfirm(me)) return reply.code(403).send(forbidden);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = integrationPatchSchema.parse(request.body ?? {});
    const [before] = await db.select().from(integrationEntry).where(eq(integrationEntry.id, id));
    if (!before) return reply.code(404).send(notFound);
    const [row] = await db
      .update(integrationEntry)
      .set({
        ...body,
        ...(body.hosts ? { hosts: [...new Set(body.hosts.map((h) => h.toLowerCase()))] } : {}),
        ...(body.initiativeId !== undefined ? { initiativeId: body.initiativeId } : {}),
      })
      .where(eq(integrationEntry.id, id))
      .returning();
    await recordActivity(db, {
      actorType: 'person',
      actorId: me.id,
      initiativeId: row!.initiativeId,
      action: 'integration.updated',
      detail: {
        name: row!.name,
        fields: Object.keys(body),
        hostsBefore: before.hosts,
        hostsAfter: row!.hosts,
      },
    });
    if (body.docs) await refresh(row!).catch(() => {});
    return (await toDto(db, [row!]))[0];
  });

  app.post('/api/integrations/:id/retire', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    if (!mayConfirm(me)) return reply.code(403).send(forbidden);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const [row] = await db
      .update(integrationEntry)
      .set({ status: 'retired' })
      .where(eq(integrationEntry.id, id))
      .returning();
    if (!row) return reply.code(404).send(notFound);
    await recordActivity(db, {
      actorType: 'person',
      actorId: me.id,
      initiativeId: row.initiativeId,
      action: 'integration.retired',
      detail: { name: row.name },
    });
    return { ok: true };
  });

  app.post('/api/integrations/:id/refresh-docs', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    if (!mayConfirm(me)) return reply.code(403).send(forbidden);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const [row] = await db.select().from(integrationEntry).where(eq(integrationEntry.id, id));
    if (!row) return reply.code(404).send(notFound);
    return refresh(row);
  });

  // What agents read: the newest good copy of each link, with the text cut for display.
  app.get('/api/integrations/:id/docs', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const snaps = await latestSnapshots(db, [id], { goodOnly: true });
    return snaps.map((s) => ({
      url: s.url,
      fetchedAt: s.fetchedAt.toISOString(),
      sha256: s.sha256,
      content: (s.content ?? '').slice(0, 20_000),
    }));
  });
}

/** Re-reads the documentation of every confirmed entry. Run by the worker once a day. */
export async function refreshAllDocs(db: Db, fetcher: DocFetcher): Promise<number> {
  const rows = await db
    .select()
    .from(integrationEntry)
    .where(eq(integrationEntry.status, 'confirmed'));
  let changed = 0;
  for (const entry of rows) {
    const r = await refreshDocs(db, entry, fetcher).catch(() => null);
    if (r && r.changed.length > 0) {
      changed++;
      await raiseDocsChanged(db, entry, r.changed);
    }
  }
  return changed;
}

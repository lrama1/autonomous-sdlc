import { createHash } from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { and, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { docSnapshot, initiative, integrationEntry } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { recordActivity } from './activity.js';
import { createInteraction } from './interactions.js';
import type { InteractionRow } from './interactions.js';

export type IntegrationRow = typeof integrationEntry.$inferSelect;

const MAX_BYTES = 512 * 1024;
const MAX_TEXT = 100 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;

/** Addresses a documentation fetch must never reach: this machine, the private network, link-local (cloud metadata). */
export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe8') ||
    v6.startsWith('fe9') ||
    v6.startsWith('fea') ||
    v6.startsWith('feb')
  );
}

/** A hostname an agent may be allowed to tunnel to: a plain name, no wildcard, no address, no path. */
export function validHostname(host: string): boolean {
  const h = host.trim().toLowerCase();
  return (
    h.length <= 253 &&
    !net.isIP(h) &&
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)
  );
}

export interface Fetched {
  sha256: string;
  text: string;
}
export type DocFetcher = (url: string) => Promise<Fetched>;

const stripHtml = (s: string) =>
  s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Fetches a documentation link on behalf of the platform. Only HTTPS, never a private or loopback address (checked on
 * the address actually connected to, so a name that points inside the network is refused), a few redirects, a size
 * limit, and a time limit. What comes back is untrusted text.
 */
export function createDocFetcher(opts: { allowLoopbackHttp?: boolean } = {}): DocFetcher {
  const get = (target: URL, redirects: number): Promise<Fetched> =>
    new Promise((resolve, reject) => {
      const secure = target.protocol === 'https:';
      const loopbackOk = opts.allowLoopbackHttp && target.protocol === 'http:';
      if (!secure && !loopbackOk) return reject(new Error('only https links can be fetched'));
      // Node does not look up an address that is already a literal, so the lookup guard below never sees it.
      const literal = target.hostname.replace(/^\[|\]$/g, '');
      if (net.isIP(literal) && isPrivateAddress(literal) && !loopbackOk)
        return reject(new Error(`${literal} is a private address`));
      const lib = secure ? https : http;
      const req = lib.request(
        target,
        {
          method: 'GET',
          timeout: TIMEOUT_MS,
          headers: {
            'user-agent': 'autonomous-sdlc-docs-snapshot',
            accept: 'text/*,application/json,application/yaml',
          },
          lookup: (host, options, cb) => {
            dns.lookup(host, options, (err, address, family) => {
              if (err) return cb(err, address as never, family);
              const list = Array.isArray(address) ? address : [{ address, family }];
              const bad = list.find((a) => isPrivateAddress(a.address) && !loopbackOk);
              if (bad) return cb(new Error(`${host} resolves to a private address`), '', 4);
              return options.all
                ? cb(null, address as never, family)
                : cb(null, list[0]!.address, list[0]!.family);
            });
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (redirects <= 0) return reject(new Error('too many redirects'));
            try {
              return resolve(get(new URL(res.headers.location, target), redirects - 1));
            } catch (e) {
              return reject(e);
            }
          }
          if (status < 200 || status >= 300) {
            res.resume();
            return reject(new Error(`the server answered ${status}`));
          }
          const type = String(res.headers['content-type'] ?? '');
          if (!/^(text\/|application\/(json|yaml|x-yaml|xml|vnd\.oai\.openapi))/i.test(type)) {
            res.resume();
            return reject(new Error(`not a text document (${type || 'no content type'})`));
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_BYTES) {
              req.destroy(new Error('the document is larger than 512 KB'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const raw = Buffer.concat(chunks);
            const text = raw.toString('utf8');
            resolve({
              sha256: createHash('sha256').update(raw).digest('hex'),
              text: (/html/i.test(type) ? stripHtml(text) : text).slice(0, MAX_TEXT),
            });
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      req.end();
    });
  return (url) => get(new URL(url), MAX_REDIRECTS);
}

/** Hostnames of every confirmed entry. The shared egress proxy allows these in addition to its fixed list. */
export async function confirmedHosts(db: Db): Promise<string[]> {
  const rows = await db
    .select({ hosts: integrationEntry.hosts })
    .from(integrationEntry)
    .where(eq(integrationEntry.status, 'confirmed'));
  return [...new Set(rows.flatMap((r) => r.hosts.map((h) => h.toLowerCase())))];
}

/** Confirmed entries an initiative may use: the global ones and its own. */
export async function entriesForInitiative(
  db: Db,
  initiativeId: string,
): Promise<IntegrationRow[]> {
  return db
    .select()
    .from(integrationEntry)
    .where(
      and(
        eq(integrationEntry.status, 'confirmed'),
        or(isNull(integrationEntry.initiativeId), eq(integrationEntry.initiativeId, initiativeId)),
      ),
    )
    .orderBy(integrationEntry.name);
}

export interface RefreshResult {
  fetched: number;
  changed: string[];
  failed: Array<{ url: string; error: string }>;
}

/**
 * Fetches each documentation link and keeps a new snapshot when the content changed. When a confirmed entry's docs
 * change, someone is asked to check the impact. A failed fetch is recorded and does not replace the last good copy.
 */
export async function refreshDocs(
  db: Db,
  entry: IntegrationRow,
  fetcher: DocFetcher,
): Promise<RefreshResult> {
  const out: RefreshResult = { fetched: 0, changed: [], failed: [] };
  for (const url of entry.docs) {
    const [last] = await db
      .select()
      .from(docSnapshot)
      .where(and(eq(docSnapshot.integrationId, entry.id), eq(docSnapshot.url, url)))
      .orderBy(desc(docSnapshot.fetchedAt))
      .limit(1);
    try {
      const got = await fetcher(url);
      out.fetched++;
      if (last?.sha256 === got.sha256) continue;
      await db.insert(docSnapshot).values({
        integrationId: entry.id,
        url,
        sha256: got.sha256,
        content: got.text,
      });
      if (last && last.content !== null) {
        out.changed.push(url);
        await recordActivity(db, {
          actorType: 'system',
          action: 'integration.docs_changed',
          detail: { integration: entry.name, url, from: last.sha256, to: got.sha256 },
        });
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      out.failed.push({ url, error });
      // Keep the history of failures, but only once per error so a broken link does not fill the table.
      if (last?.error !== error)
        await db.insert(docSnapshot).values({
          integrationId: entry.id,
          url,
          sha256: last?.sha256 ?? 'none',
          content: null,
          error,
        });
    }
  }
  return out;
}

/** Asks the Architect whether changed documentation affects the work (spec 6.7). */
export async function raiseDocsChanged(
  db: Db,
  entry: IntegrationRow,
  urls: string[],
): Promise<void> {
  // A shared entry has no initiative of its own, so the question goes to the newest one.
  const initiativeId =
    entry.initiativeId ??
    (
      await db
        .select({ id: initiative.id })
        .from(initiative)
        .orderBy(desc(initiative.createdAt))
        .limit(1)
    )[0]?.id;
  if (!initiativeId) return;
  await createInteraction(db, {
    initiativeId,
    runId: null,
    type: 'decision',
    title: `The documentation for ${entry.name} changed`,
    contextCard: {
      kind: 'integration_docs_changed',
      integrationId: entry.id,
      context: `These links now have different content: ${urls.join(', ')}.`,
      whyNow: 'Agents read this documentation. A change may affect code that is already written.',
    },
    options: [
      { id: 'no_impact', label: 'No impact' },
      { id: 'check', label: 'Check the impact on the work' },
    ],
    recommendation: 'check',
    blocks: [],
    topicKey: `docs-changed:${entry.name}`,
    roleNeeded: 'architect',
  });
}

/** The proposal an agent makes, and the hard stop that asks a person to confirm it (spec 6.3: a new external host). */
export async function proposeIntegration(
  db: Db,
  input: {
    name: string;
    kind: 'second_party' | 'third_party';
    hosts: string[];
    docs: string[];
    testStrategy: 'vendor_sandbox' | 'mock' | 'recorded' | 'none';
    dataSent?: string;
    why: string;
    initiativeId: string;
    runId: string;
  },
): Promise<{ entry: IntegrationRow; interaction: InteractionRow } | { error: string }> {
  const hosts = [...new Set(input.hosts.map((h) => h.trim().toLowerCase()))];
  const bad = hosts.find((h) => !validHostname(h));
  if (bad)
    return { error: `"${bad}" is not a plain hostname (no wildcards, addresses, or paths).` };
  const [existing] = await db
    .select()
    .from(integrationEntry)
    .where(eq(integrationEntry.name, input.name));
  if (existing)
    return {
      error: `There is already an entry named "${input.name}" (${existing.status}). Use list_integrations.`,
    };
  const [entry] = await db
    .insert(integrationEntry)
    .values({
      name: input.name,
      kind: input.kind,
      hosts,
      docs: input.docs,
      testStrategy: input.testStrategy,
      dataSent: input.dataSent ?? null,
      status: 'proposed',
      proposedBy: `agent:${input.runId}`,
      initiativeId: input.initiativeId,
    })
    .returning();
  const { interaction } = await createInteraction(db, {
    initiativeId: input.initiativeId,
    runId: input.runId,
    type: 'decision',
    title: `New external system: ${input.name} (${hosts.join(', ') || 'no hosts'})`,
    contextCard: {
      kind: 'integration_proposal',
      integrationId: entry!.id,
      context: input.why,
      whyNow: `Agents may open connections to ${hosts.join(', ')} only after a person confirms this. Test strategy: ${input.testStrategy}.`,
      docs: input.docs,
    },
    options: [
      { id: 'confirm', label: 'Confirm: allow these hosts for agents' },
      { id: 'reject', label: 'Reject' },
    ],
    blocks: [{ runId: input.runId }],
    roleNeeded: 'architect',
    hardStop: true,
  });
  await recordActivity(db, {
    actorType: 'agent',
    actorId: input.runId,
    initiativeId: input.initiativeId,
    runId: input.runId,
    interactionId: interaction.id,
    action: 'integration.proposed',
    detail: { name: input.name, hosts },
  });
  return { entry: entry!, interaction };
}

/** Applies the person's answer on a proposal. Called after any answer, and ignores everything else. */
export async function applyIntegrationDecision(
  db: Db,
  row: InteractionRow,
  fetcher?: DocFetcher,
): Promise<void> {
  const card = row.contextCard as { kind?: string; integrationId?: string };
  if (card.kind !== 'integration_proposal' || !card.integrationId) return;
  const choice = (row.answer as { choice?: string | null } | null)?.choice;
  if (choice !== 'confirm' && choice !== 'reject') return;
  const [entry] = await db
    .update(integrationEntry)
    .set(
      choice === 'confirm'
        ? { status: 'confirmed', confirmedBy: row.answeredBy, confirmedAt: new Date() }
        : { status: 'rejected' },
    )
    .where(
      and(eq(integrationEntry.id, card.integrationId), eq(integrationEntry.status, 'proposed')),
    )
    .returning();
  if (!entry) return;
  await recordActivity(db, {
    actorType: 'person',
    actorId: row.answeredBy,
    initiativeId: row.initiativeId,
    runId: row.runId,
    interactionId: row.id,
    action: choice === 'confirm' ? 'integration.confirmed' : 'integration.rejected',
    detail: { name: entry.name, hosts: entry.hosts },
  });
  if (choice === 'confirm' && fetcher) await refreshDocs(db, entry, fetcher).catch(() => {});
}

/**
 * The newest snapshot for each link of the entries. With `goodOnly`, a failed fetch does not hide the last copy that
 * worked (this is what agents read). Without it, the newest row shows whether the link is working now.
 */
export async function latestSnapshots(db: Db, ids: string[], opts: { goodOnly?: boolean } = {}) {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(docSnapshot)
    .where(
      and(
        inArray(docSnapshot.integrationId, ids),
        opts.goodOnly ? isNotNull(docSnapshot.content) : undefined,
      ),
    )
    .orderBy(desc(docSnapshot.fetchedAt));
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.integrationId}|${r.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

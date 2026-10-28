import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { assistantConversation, assistantMessage } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { assistantAskSchema } from '@sdlc/schemas';
import type {
  AssistantConversationDto,
  AssistantMessageDto,
  AssistantReplyDto,
  AssistantUsageDto,
} from '@sdlc/schemas';
import { recordActivity } from '../activity.js';
import type { GitHubService } from '../github-service.js';
import { requirePerson } from '../people.js';
import type { PreviewService } from '../previews.js';
import { answerQuestion } from './chat.js';
import { loadDocs } from './docs.js';
import type { AssistantModel, ChatMessage } from './model.js';
import { AssistantTools } from './tools.js';
import type { Proposal } from './tools.js';

type MessageRow = typeof assistantMessage.$inferSelect;

const toMessage = (m: MessageRow): AssistantMessageDto => ({
  id: m.id,
  role: m.role === 'user' ? 'user' : 'assistant',
  content: m.content,
  steps: m.steps,
  proposals: m.proposals as AssistantMessageDto['proposals'],
  createdAt: m.createdAt.toISOString(),
});

const toConversation = (
  c: typeof assistantConversation.$inferSelect,
): AssistantConversationDto => ({
  id: c.id,
  title: c.title,
  updatedAt: c.updatedAt.toISOString(),
});

/** A conversation is its owner's alone: nobody else lists it, reads it or adds to it. */
export function registerAssistantRoutes(
  app: FastifyInstance,
  db: Db,
  deps: {
    model: AssistantModel | null;
    alias: string;
    dailyCapUsd: number;
    github: Pick<GitHubService, 'readFile' | 'listFiles' | 'pullRequestFiles'>;
    previews: () => PreviewService | null;
    docsRoot?: string;
    now?: () => Date;
    doFetch?: typeof fetch;
  },
): void {
  const capMicros = Math.round(deps.dailyCapUsd * 1_000_000);
  const now = () => deps.now?.() ?? new Date();

  /** What a person has spent today (UTC), over every conversation of theirs. */
  async function spentToday(personId: string): Promise<number> {
    const start = new Date(now());
    start.setUTCHours(0, 0, 0, 0);
    const [r] = await db
      .select({ s: sql<string>`coalesce(sum(${assistantMessage.costMicros}), 0)` })
      .from(assistantMessage)
      .innerJoin(
        assistantConversation,
        eq(assistantConversation.id, assistantMessage.conversationId),
      )
      .where(
        and(eq(assistantConversation.personId, personId), gte(assistantMessage.createdAt, start)),
      );
    return Number(r?.s ?? 0);
  }

  const usage = async (personId: string): Promise<AssistantUsageDto> => ({
    available: deps.model !== null,
    spentMicros: await spentToday(personId),
    capMicros,
  });

  async function owned(id: string, personId: string) {
    const [c] = await db
      .select()
      .from(assistantConversation)
      .where(and(eq(assistantConversation.id, id), eq(assistantConversation.personId, personId)));
    return c ?? null;
  }
  const notFound = { error: { code: 'not_found', message: 'No such conversation.' } };

  app.get('/api/assistant/usage', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    return usage(me.id);
  });

  app.get('/api/assistant/conversations', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const rows = await db
      .select()
      .from(assistantConversation)
      .where(eq(assistantConversation.personId, me.id))
      .orderBy(desc(assistantConversation.updatedAt))
      .limit(30);
    return rows.map(toConversation);
  });

  app.get('/api/assistant/conversations/:id', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const c = await owned(id, me.id);
    if (!c) return reply.code(404).send(notFound);
    const rows = await db
      .select()
      .from(assistantMessage)
      .where(eq(assistantMessage.conversationId, id))
      .orderBy(asc(assistantMessage.createdAt));
    return { conversation: toConversation(c), messages: rows.map(toMessage) };
  });

  app.delete('/api/assistant/conversations/:id', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!(await owned(id, me.id))) return reply.code(404).send(notFound);
    await db.delete(assistantConversation).where(eq(assistantConversation.id, id));
    return { deleted: true };
  });

  // A person says what happened to a suggestion (they clicked it, or put it away). The click itself calls the platform's
  // own route as them, so the usual role checks apply. This only keeps the button from coming back.
  app.post('/api/assistant/messages/:id/proposals/:proposalId', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const { id, proposalId } = z
      .object({ id: z.string().uuid(), proposalId: z.string().uuid() })
      .parse(request.params);
    const { state } = z.object({ state: z.enum(['done', 'dismissed']) }).parse(request.body ?? {});
    const [m] = await db.select().from(assistantMessage).where(eq(assistantMessage.id, id));
    const c = m ? await owned(m.conversationId, me.id) : null;
    if (!m || !c) return reply.code(404).send(notFound);
    const proposals = (m.proposals as Proposal[]).map((p) =>
      p.id === proposalId ? { ...p, state } : p,
    );
    await db.update(assistantMessage).set({ proposals }).where(eq(assistantMessage.id, id));
    return { ok: true };
  });

  app.post('/api/assistant/conversations/:id/messages', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    if (!deps.model)
      return reply.code(409).send({
        error: {
          code: 'assistant_off',
          message: 'The assistant is switched off on this platform.',
        },
      });
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = assistantAskSchema.safeParse(request.body ?? {});
    if (!body.success)
      return reply.code(400).send({
        error: { code: 'bad_request', message: 'Write a question of up to 4,000 characters.' },
      });
    const conversation = await owned(id, me.id);
    if (!conversation) return reply.code(404).send(notFound);

    const spent = await spentToday(me.id);
    if (spent >= capMicros)
      return reply.code(429).send({
        error: {
          code: 'daily_limit',
          message: `You have used your $${deps.dailyCapUsd.toFixed(2)} for the assistant today. It starts again tomorrow (UTC).`,
        },
      });

    const earlier = await db
      .select()
      .from(assistantMessage)
      .where(eq(assistantMessage.conversationId, id))
      .orderBy(asc(assistantMessage.createdAt));
    const history: ChatMessage[] = earlier.map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    }));

    // Reads go through the platform's own routes as this person, so they see what they may see and nothing more.
    const cookie = request.headers.cookie ?? '';
    const tools = new AssistantTools({
      db,
      github: deps.github,
      previews: deps.previews,
      docs: () => loadDocs(deps.docsRoot),
      doFetch: deps.doFetch,
      api: async (path) => {
        const res = await app.inject({ method: 'GET', url: path, headers: { cookie } });
        let parsed: unknown = res.body;
        try {
          parsed = JSON.parse(res.body);
        } catch {
          // not JSON: keep the text
        }
        return { status: res.statusCode, body: parsed };
      },
    });

    let answer;
    try {
      answer = await answerQuestion({
        model: deps.model,
        alias: deps.alias,
        tools,
        history,
        text: body.data.text,
        ctx: body.data.context,
        who: { name: me.displayName, roles: me.roles },
        room: capMicros - spent,
        now: now(),
      });
    } catch (e) {
      request.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'assistant failed');
      return reply.code(502).send({
        error: {
          code: 'model_failed',
          message: `The assistant could not answer just now (${e instanceof Error ? e.message.slice(0, 160) : 'unknown error'}). Try again.`,
        },
      });
    }

    const [userRow] = await db
      .insert(assistantMessage)
      .values({
        conversationId: id,
        role: 'user',
        content: body.data.text,
        context: body.data.context,
        createdAt: now(),
      })
      .returning();
    const [assistantRow] = await db
      .insert(assistantMessage)
      .values({
        conversationId: id,
        role: 'assistant',
        content: answer.text,
        steps: answer.steps,
        proposals: answer.proposals,
        costMicros: answer.costMicros,
        createdAt: new Date(now().getTime() + 1),
      })
      .returning();
    const title =
      conversation.title === 'New chat'
        ? body.data.text.replace(/\s+/g, ' ').slice(0, 60)
        : conversation.title;
    const [updated] = await db
      .update(assistantConversation)
      .set({ title, updatedAt: now() })
      .where(eq(assistantConversation.id, id))
      .returning();
    await recordActivity(db, {
      actorType: 'person',
      actorId: me.id,
      action: 'assistant.answered',
      detail: {
        conversationId: id,
        costMicros: answer.costMicros,
        tools: answer.steps.map((s) => s.tool),
        proposed: answer.proposals.map((p) => p.kind),
        stopped: answer.stopped,
      },
    });
    const out: AssistantReplyDto = {
      conversation: toConversation(updated!),
      user: toMessage(userRow!),
      assistant: toMessage(assistantRow!),
      usage: await usage(me.id),
    };
    return reply.code(201).send(out);
  });

  app.post('/api/assistant/conversations', async (request, reply) => {
    const me = await requirePerson(db, request, reply);
    if (!me) return;
    const [c] = await db.insert(assistantConversation).values({ personId: me.id }).returning();
    return reply.code(201).send(toConversation(c!));
  });
}

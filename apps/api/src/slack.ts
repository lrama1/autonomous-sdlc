import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { hat, interaction, person } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import { chatAnswerable } from '@sdlc/core';
import type { AttentionPolicy } from '@sdlc/core';
import { roleSchema } from '@sdlc/schemas';
import type { Role } from '@sdlc/schemas';
import { z } from 'zod';
import { recordActivity } from './activity.js';
import { answerAsPerson } from './answering.js';
import type { Gate } from './gate.js';
import { getInteraction, saveStandingDecision } from './interactions.js';
import type { Delivered, NotificationBody, Notifier, Recipient } from './notifier.js';

const MAX_AGE_S = 5 * 60;

function parseJson(s: string | null): unknown {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

/** Slack signs every request: v0=HMAC-SHA256("v0:<timestamp>:<raw body>"). Reject old or forged requests. */
export function verifySlackSignature(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: string,
  nowMs = Date.now(),
): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > MAX_AGE_S) return false;
  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface SlackMessage {
  text: string;
  blocks: unknown[];
}

const TYPE_LABEL: Record<string, string> = {
  question: 'Question',
  decision: 'Decision request',
  review: 'Review',
  checkpoint: 'Checkpoint',
  notice: 'Notice',
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Block Kit for one notification. Buttons carry the interaction id, and the server checks everything again on click. */
export function renderSlack(b: NotificationBody): SlackMessage {
  if (b.kind === 'digest') {
    const lines = (b.items ?? []).map((i) => `• <${i.link}|${clip(i.title, 120)}>`);
    return {
      text: `${lines.length} low-priority item${lines.length === 1 ? '' : 's'} for you`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Digest* · ${lines.length} low-priority item${lines.length === 1 ? '' : 's'}\n${lines.join('\n')}`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Open the attention queue' },
              url: b.link,
            },
          ],
        },
      ],
    };
  }

  const head =
    b.kind === 'reminder'
      ? 'Reminder'
      : b.kind === 'escalation'
        ? 'Escalated to you'
        : b.kind === 'default_applied'
          ? 'Default applied'
          : (TYPE_LABEL[b.type ?? ''] ?? 'Ask');
  const lines = [`*${head}* · ${clip(b.title, 200)}`];
  if (b.summary) lines.push(b.summary);
  if (b.kind === 'default_applied' && b.appliedDefault)
    lines.push(
      `Nobody answered in time, so *${clip(b.appliedDefault, 200)}* was applied. You can override it in the Workspace.`,
    );
  if (b.hardStop)
    lines.push(':octagonal_sign: Hard stop: this will not continue until a person decides.');
  const facts: string[] = [];
  if (b.blocksCount) facts.push(`Blocks ${b.blocksCount} run${b.blocksCount === 1 ? '' : 's'}`);
  if (b.dueAt && b.kind !== 'default_applied' && b.recommendation)
    facts.push(
      `Default *${clip(b.recommendation, 60)}* at <!date^${Math.floor(new Date(b.dueAt).getTime() / 1000)}^{date_short_pretty} {time}|${b.dueAt}>`,
    );
  if (!b.chat) facts.push('Open the Workspace to answer');

  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }];
  if (facts.length)
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: facts.join(' · ') }] });

  const buttons: unknown[] = [];
  if (b.chat && b.interactionId && b.kind !== 'default_applied') {
    if (b.type === 'review') {
      buttons.push(
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Approve' },
          action_id: 'ask.decide.approved',
          value: JSON.stringify({ i: b.interactionId, d: 'approved' }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Request changes' },
          action_id: 'ask.decide.changes_requested',
          value: JSON.stringify({ i: b.interactionId, d: 'changes_requested' }),
        },
      );
    } else {
      for (const [n, o] of (b.options ?? []).slice(0, 8).entries()) {
        buttons.push({
          type: 'button',
          ...(o.id === b.recommendation ? { style: 'primary' } : {}),
          text: {
            type: 'plain_text',
            text: clip(`${o.id === b.recommendation ? '★ ' : ''}${o.label}`, 70),
          },
          action_id: `ask.answer.${n}`,
          value: JSON.stringify({ i: b.interactionId, o: o.id }),
        });
      }
    }
  }
  buttons.push({
    type: 'button',
    text: { type: 'plain_text', text: 'Open in Workspace' },
    url: b.link,
    action_id: 'ask.open',
  });
  if (b.interactionId && !b.hardStop && b.kind !== 'default_applied') {
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Snooze 2 h' },
      action_id: 'ask.snooze',
      value: JSON.stringify({ i: b.interactionId }),
    });
  }
  // Slack allows 25 elements in an actions block; keep each row short.
  for (let k = 0; k < buttons.length; k += 5)
    blocks.push({ type: 'actions', elements: buttons.slice(k, k + 5) });

  return { text: `${head}: ${b.title}`, blocks };
}

const slackReply = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  ts: z.string().optional(),
  channel: z.string().optional(),
});

export class SlackClient {
  constructor(
    private readonly token: string,
    private readonly apiUrl = 'https://slack.com/api',
    /** Hosts a response_url may point to. Anything else is refused. */
    private readonly responseHosts: string[] = ['hooks.slack.com'],
  ) {}

  async postMessage(channel: string, msg: SlackMessage): Promise<{ channel: string; ts: string }> {
    const r = await fetch(`${this.apiUrl}/chat.postMessage`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, text: msg.text, blocks: msg.blocks }),
    });
    const body = slackReply.parse(await r.json());
    if (!r.ok || !body.ok || !body.ts)
      throw new Error(`Slack chat.postMessage failed: ${body.error ?? r.status}`);
    return { channel: body.channel ?? channel, ts: body.ts };
  }

  /** Answers a button click through the one-time response_url Slack sent. Only Slack's own hosts are allowed. */
  async respond(
    responseUrl: string,
    msg: SlackMessage & { replace?: boolean; ephemeral?: boolean },
  ): Promise<void> {
    const url = new URL(responseUrl);
    const allowed =
      this.responseHosts.includes(url.host) || this.responseHosts.includes(url.hostname);
    if (!allowed || (url.protocol !== 'https:' && url.hostname !== '127.0.0.1')) {
      throw new Error(`Refusing to post to ${url.host}`);
    }
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: msg.text,
        blocks: msg.blocks,
        replace_original: msg.replace ?? false,
        response_type: msg.ephemeral ? 'ephemeral' : 'in_channel',
      }),
    });
    if (!r.ok) throw new Error(`Slack response_url failed: ${r.status}`);
  }
}

export class SlackNotifier implements Notifier {
  readonly channel = 'slack';
  constructor(private readonly client: SlackClient) {}
  async deliver(to: Recipient, body: NotificationBody): Promise<Delivered> {
    if (!to.slackUserId) return { skipped: 'no Slack account is linked to this person' };
    // Posting to a user id opens (or reuses) the direct message with that person.
    const ref = await this.client.postMessage(to.slackUserId, renderSlack(body));
    return { ref };
  }
}

const payloadSchema = z.object({
  type: z.string(),
  user: z.object({ id: z.string() }),
  response_url: z.string().url().optional(),
  actions: z.array(z.object({ action_id: z.string(), value: z.string().optional() })).default([]),
});

const valueSchema = z.object({
  i: z.string().uuid(),
  o: z.string().optional(),
  d: z.enum(['approved', 'changes_requested', 'rejected']).optional(),
});

export interface SlackRouteDeps {
  db: Db;
  signingSecret: string;
  client: SlackClient | null;
  policy: AttentionPolicy;
  rules: { independentReview: boolean };
  gate?: Gate;
  publicUrl: string;
  now?: () => number;
}

/**
 * Slack's interactivity endpoint. A click is accepted only from a signed request, from a Slack user linked to
 * a person, and only for what chat may settle. Everything else opens the Workspace.
 */
export function registerSlackRoutes(app: FastifyInstance, deps: SlackRouteDeps): void {
  const { db, policy } = deps;
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => done(null, body),
    );

    scope.post('/slack/interactions', async (request, reply) => {
      const raw = typeof request.body === 'string' ? request.body : '';
      const ok = verifySlackSignature(
        deps.signingSecret,
        request.headers['x-slack-request-timestamp'] as string | undefined,
        request.headers['x-slack-signature'] as string | undefined,
        raw,
        deps.now?.(),
      );
      if (!ok) {
        return reply
          .code(401)
          .send({ error: { code: 'bad_signature', message: 'Not signed by Slack.' } });
      }

      const form = new URLSearchParams(raw).get('payload');
      const payload = payloadSchema.safeParse(parseJson(form));
      if (!payload.success || payload.data.type !== 'block_actions' || !payload.data.actions[0]) {
        return reply.code(200).send();
      }
      const { user, response_url: responseUrl } = payload.data;
      const action = payload.data.actions[0];

      const say = async (text: string, o: { replace?: boolean; blocks?: unknown[] } = {}) => {
        if (!responseUrl || !deps.client) return;
        await deps.client
          .respond(responseUrl, {
            text,
            blocks: o.blocks ?? [{ type: 'section', text: { type: 'mrkdwn', text } }],
            replace: o.replace,
            ephemeral: !o.replace,
          })
          .catch((e) => request.log.warn({ err: e }, 'slack response failed'));
      };

      // The link between a Slack user and a person is set by an admin. Without it nobody can answer.
      const [who] = await db.select().from(person).where(eq(person.slackUserId, user.id));
      if (!who || !who.active) {
        await say(
          'Your Slack account is not linked to a person on the platform. Ask a platform admin to link it.',
        );
        return reply.code(200).send();
      }
      const hats = await db.select({ role: hat.role }).from(hat).where(eq(hat.personId, who.id));
      const me = { id: who.id, roles: hats.map((h) => roleSchema.parse(h.role)) as Role[] };

      if (action.action_id === 'ask.open' || !action.value) return reply.code(200).send();
      const v = valueSchema.safeParse(parseJson(action.value));
      if (!v.success) return reply.code(200).send();
      const row = await getInteraction(db, v.data.i);
      if (!row) {
        await say('That ask no longer exists.');
        return reply.code(200).send();
      }
      const link = `${deps.publicUrl}/#/queue`;

      if (action.action_id === 'ask.snooze') {
        const entitled =
          row.assignedPersonId === me.id || me.roles.includes(row.roleNeeded as Role);
        if (!entitled || row.state !== 'open' || row.hardStop) {
          await say('This cannot be snoozed from chat. Open the Workspace.');
          return reply.code(200).send();
        }
        const until = new Date((deps.now?.() ?? Date.now()) + 2 * 3600_000);
        await db.update(interaction).set({ snoozedUntil: until }).where(eq(interaction.id, row.id));
        await recordActivity(db, {
          actorType: 'person',
          actorId: me.id,
          initiativeId: row.initiativeId,
          runId: row.runId,
          interactionId: row.id,
          action: 'interaction.snoozed',
          detail: { until: until.toISOString(), via: 'slack' },
        });
        await say(`Snoozed for 2 hours: ${clip(row.title, 120)}`);
        return reply.code(200).send();
      }

      if (action.action_id === 'ask.standing') {
        if (row.state !== 'answered' || row.answeredBy !== me.id || row.standingDecisionId) {
          await say('Only the person who answered can save it as a standing decision.');
          return reply.code(200).send();
        }
        const text = (row.answer as { text?: string } | null)?.text ?? '';
        await saveStandingDecision(db, row, text, me.id);
        await say(`Saved as a standing decision: ${clip(text, 120)}`);
        return reply.code(200).send();
      }

      if (
        !action.action_id.startsWith('ask.answer.') &&
        !action.action_id.startsWith('ask.decide.')
      ) {
        return reply.code(200).send();
      }
      if (
        !chatAnswerable(
          {
            type: row.type,
            hardStop: row.hardStop,
            triggered:
              Array.isArray((row.contextCard as { triggers?: unknown }).triggers) &&
              ((row.contextCard as { triggers?: unknown[] }).triggers?.length ?? 0) > 0,
          },
          policy,
        )
      ) {
        await say(`This one needs the Workspace: ${link}`);
        return reply.code(200).send();
      }

      const out = await answerAsPerson(
        {
          db,
          rules: deps.rules,
          gate: deps.gate,
          onGateError: (e) => request.log.error({ err: e }, 'gate failed'),
        },
        row.id,
        me,
        'slack',
        {
          answer: '',
          optionId: v.data.o,
          decision: v.data.d,
          makeStanding: false,
          standingScope: 'initiative',
          didntNeedToAsk: false,
        },
      );
      if (!out.ok) {
        await say(out.message);
        return reply.code(200).send();
      }
      const text = (out.row.answer as { text?: string } | null)?.text ?? v.data.d ?? '';
      const done = `:white_check_mark: *${who.displayName}* answered: ${clip(text || v.data.d || '', 200)}\n${clip(row.title, 200)}`;
      await say(done, {
        replace: true,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: done } },
          ...(row.type === 'question' || row.type === 'decision'
            ? [
                {
                  type: 'actions',
                  elements: [
                    {
                      type: 'button',
                      text: { type: 'plain_text', text: 'Save as a standing decision' },
                      action_id: 'ask.standing',
                      value: JSON.stringify({ i: row.id }),
                    },
                  ],
                },
              ]
            : []),
        ],
      });
      return reply.code(200).send();
    });
  });
}

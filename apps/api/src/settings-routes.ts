import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { modelSetting, person } from '@sdlc/db';
import type { Db } from '@sdlc/db';
import {
  ALIAS_PURPOSE,
  DEFAULT_MODEL_ALIASES,
  MODEL_ALIASES,
  VETTED_MODELS,
  internalKey,
  isVettedModel,
} from '@sdlc/core';
import { modelChangeSchema } from '@sdlc/schemas';
import type { ModelTestDto } from '@sdlc/schemas';
import { recordActivity } from './activity.js';
import type { LoadedAgent } from './agents.js';
import { requirePerson } from './people.js';
import type { Signed } from './people.js';

const aliasParam = z.object({ alias: z.enum(MODEL_ALIASES) });

/** The Settings page: which model each alias means. The gateway reads the same table, so a change reaches the next model call. */
export function registerSettingsRoutes(
  app: FastifyInstance,
  db: Db,
  deps: {
    agents: Map<string, LoadedAgent>;
    gatewayUrl: string;
    databaseUrl: string;
    fetchImpl?: typeof fetch;
  },
): void {
  const doFetch = deps.fetchImpl ?? fetch;

  async function admin(request: FastifyRequest, reply: FastifyReply): Promise<Signed | null> {
    const me = await requirePerson(db, request, reply);
    if (!me) return null;
    if (!me.roles.includes('platform_admin')) {
      await reply.code(403).send({
        error: { code: 'forbidden', message: 'Only a Platform Admin changes the settings.' },
      });
      return null;
    }
    return me;
  }

  async function view() {
    const rows = await db
      .select({
        alias: modelSetting.alias,
        model: modelSetting.model,
        at: modelSetting.updatedAt,
        by: person.displayName,
      })
      .from(modelSetting)
      .leftJoin(person, eq(person.id, modelSetting.updatedBy));
    const saved = new Map(rows.map((r) => [r.alias, r]));
    return {
      aliases: MODEL_ALIASES.map((alias) => {
        const s = saved.get(alias);
        return {
          alias,
          purpose: ALIAS_PURPOSE[alias],
          model: s && isVettedModel(s.model) ? s.model : DEFAULT_MODEL_ALIASES[alias]!,
          defaultModel: DEFAULT_MODEL_ALIASES[alias]!,
          usedBy: [...deps.agents.values()]
            .filter((a) => a.definition.model_alias === alias)
            .map((a) => a.definition.id)
            .sort(),
          changedAt: s ? s.at.toISOString() : null,
          changedBy: s ? s.by : null,
        };
      }),
      models: VETTED_MODELS,
    };
  }

  app.get('/api/settings/models', async (request, reply) => {
    if (!(await requirePerson(db, request, reply))) return;
    return view();
  });

  app.put('/api/settings/models/:alias', async (request, reply) => {
    const me = await admin(request, reply);
    if (!me) return;
    const { alias } = aliasParam.parse(request.params);
    const { model } = modelChangeSchema.parse(request.body ?? {});
    if (!isVettedModel(model))
      return reply.code(400).send({
        error: {
          code: 'unsupported_model',
          message: `${model} is not on the list of models that work with Claude Code here.`,
        },
      });
    const before = (await view()).aliases.find((a) => a.alias === alias)!.model;
    await db
      .insert(modelSetting)
      .values({ alias, model, updatedBy: me.id })
      .onConflictDoUpdate({
        target: modelSetting.alias,
        set: { model, updatedBy: me.id, updatedAt: new Date() },
      });
    await recordActivity(db, {
      actorType: 'person',
      actorId: me.id,
      action: 'settings.model_changed',
      detail: { alias, from: before, to: model },
    });
    return view();
  });

  // A tiny real request to the model, through the gateway, so a person sees it work before they rely on it.
  app.post('/api/settings/models/test', async (request, reply) => {
    const me = await admin(request, reply);
    if (!me) return;
    const { model } = modelChangeSchema.parse(request.body ?? {});
    if (!isVettedModel(model))
      return reply.code(400).send({
        error: { code: 'unsupported_model', message: `${model} is not on the list.` },
      });
    let result: ModelTestDto;
    try {
      const res = await doFetch(`${deps.gatewayUrl}/internal/model-test`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sdlc-internal': internalKey(deps.databaseUrl),
        },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(45_000),
      });
      result = (await res.json()) as ModelTestDto;
    } catch {
      result = { ok: false, error: 'The gateway could not be reached.' };
    }
    await recordActivity(db, {
      actorType: 'person',
      actorId: me.id,
      action: 'settings.model_tested',
      detail: {
        model,
        ok: result.ok,
        costMicros: result.costMicros ?? 0,
        error: result.error ?? null,
      },
    });
    return result;
  });
}

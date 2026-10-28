import { asc, desc, eq } from 'drizzle-orm';
import { agentRun, buildPlan, buildTask, interaction, stageStart } from '@sdlc/db';
import type { Db, initiative } from '@sdlc/db';
import { buildMap } from '@sdlc/core';
import type { MapAsk, MapPlan, MapStage, MapStageStart } from '@sdlc/core';

type InitiativeRow = typeof initiative.$inferSelect;

/** The stages of one initiative's SDLC map, from its runs, asks, build plan and step starts. */
export async function loadStages(
  db: Db,
  init: InitiativeRow,
): Promise<{ stages: MapStage[]; plan: MapPlan | undefined }> {
  const id = init.id;
  // Oldest first: a stage shows its runs in order, and its newest run is the last.
  const runs = await db
    .select()
    .from(agentRun)
    .where(eq(agentRun.initiativeId, id))
    .orderBy(asc(agentRun.createdAt));
  const asks = await db
    .select({ i: interaction, role: agentRun.agentRole })
    .from(interaction)
    .leftJoin(agentRun, eq(agentRun.id, interaction.runId))
    .where(eq(interaction.initiativeId, id))
    .orderBy(desc(interaction.createdAt));
  const mapAsks: MapAsk[] = asks.map(({ i, role }) => {
    const card = i.contextCard as { gate?: { state?: string }; release?: { state?: string } };
    return {
      id: i.id,
      type: i.type,
      checkpointId: i.checkpointId,
      state: i.state,
      title: i.title,
      roleNeeded: i.roleNeeded,
      hardStop: i.hardStop,
      decision: (i.answer as { decision?: string | null } | null)?.decision ?? null,
      runRole: role,
      gate: card.gate?.state ?? null,
      released: card.release?.state === 'released',
    };
  });
  const [planRow] = await db
    .select()
    .from(buildPlan)
    .where(eq(buildPlan.initiativeId, id))
    .orderBy(desc(buildPlan.createdAt))
    .limit(1);
  const starts = await db
    .select({ stage: stageStart.stage, state: stageStart.state })
    .from(stageStart)
    .where(eq(stageStart.initiativeId, id));
  // Bug fixes are not part of the spec and design stage.
  const specAndDesign = starts.filter((s) => s.stage === 'spec' || s.stage === 'design');
  let plan: MapPlan | undefined;
  if (planRow) {
    const tasks = await db.select().from(buildTask).where(eq(buildTask.planId, planRow.id));
    plan = {
      state: planRow.state as MapPlan['state'],
      total: tasks.length,
      merged: tasks.filter((t) => t.state === 'merged' || t.state === 'skipped').length,
      failed: tasks.filter((t) => t.state === 'failed').length,
    };
  }
  return {
    plan,
    stages: buildMap({
      runs: runs.map((r) => ({ id: r.id, agentRole: r.agentRole, state: r.state })),
      asks: mapAsks,
      plan,
      starts: specAndDesign as MapStageStart[],
    }),
  };
}

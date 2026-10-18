import { eq } from 'drizzle-orm';
import {
  activityEvent,
  agentRun,
  assumption,
  createDb,
  initiative,
  interaction,
  person,
  repositoryEntry,
  standingDecision,
} from '@sdlc/db';

const DAY = 86_400_000;
const HOUR = 3_600_000;
export const DEMO_REPO = 'demo/trailmates';

/**
 * Fills a development database with what a team would see after a few weeks: open asks of each kind,
 * assumptions, a standing decision, and a month of answered asks for the interruption metrics.
 * Nothing here talks to GitHub or starts an agent. Safe to run twice.
 */
export async function seedDemo(databaseUrl: string): Promise<{ seeded: boolean }> {
  const { db, pool } = createDb(databaseUrl);
  try {
    const [existing] = await db
      .select({ id: repositoryEntry.id })
      .from(repositoryEntry)
      .where(eq(repositoryEntry.fullName, DEMO_REPO));
    if (existing) return { seeded: false };

    const people = await db.select().from(person);
    const who = (email: string) => {
      const p = people.find((x) => x.email === email);
      if (!p) throw new Error(`Start the dev stack first: ${email} is not in the database.`);
      return p.id;
    };
    const alice = who('alice@example.test');
    const bob = who('bob@example.test');

    const now = Date.now();
    const ago = (ms: number) => new Date(now - ms);
    const [repo] = await db
      .insert(repositoryEntry)
      .values({ fullName: DEMO_REPO, access: 'read_write' })
      .returning();
    const [init] = await db
      .insert(initiative)
      .values({
        title: 'Trailmates: group trip planner',
        goal: 'Plan a group hike: trips, invites, a forecast, and a packing list.',
        repositoryId: repo!.id,
        createdBy: alice,
      })
      .returning();

    const mkRun = async (role: string) => {
      const [r] = await db
        .insert(agentRun)
        .values({
          initiativeId: init!.id,
          agentRole: role,
          agentDefinitionId: role.replace(/_/g, '-'),
          agentDefinitionVersion: 1,
          engine: 'claude-code',
          modelAlias: 'agent-default',
          // Inert on purpose: nothing may try to resume a demo run.
          state: 'succeeded',
          sponsorPersonId: alice,
          repositoryId: repo!.id,
          budgetMicros: 2_000_000,
          startedAt: ago(30 * DAY),
        })
        .returning();
      return r!;
    };
    const backend = await mkRun('backend_engineer');
    const frontend = await mkRun('frontend_engineer');

    const base = { initiativeId: init!.id, contextCard: {} as Record<string, unknown> };

    // ---- open asks
    await db.insert(interaction).values([
      {
        ...base,
        runId: backend.id,
        type: 'decision',
        title: 'Which weather provider should the forecast use?',
        contextCard: {
          context: 'Building the forecast service for US-3 and found three providers that fit.',
          whyNow: 'Hard to switch later: it adds a new external host and a monthly cost.',
        },
        options: [
          { id: 'A', label: 'Free tier, 3-day forecast', impact: '$0. Enough for a weekend hike.' },
          {
            id: 'B',
            label: 'Paid tier, 7-day forecast',
            impact: '$29 a month. Useful for longer trips.',
          },
          { id: 'C', label: 'Self-hosted open data', impact: '$0, but about two days more work.' },
        ],
        recommendation: 'A',
        defaultValue: 'A',
        dueAt: new Date(now + 5 * HOUR + 40 * 60_000),
        blocks: [{ runId: backend.id }],
        topicKey: 'weather-provider',
        roleNeeded: 'backend_engineer',
      },
      {
        ...base,
        runId: frontend.id,
        type: 'review',
        checkpointId: 'G3',
        title: 'Review PR #44: Weather alerts',
        contextCard: {
          kind: 'pull_request',
          repository: DEMO_REPO,
          prNumber: 44,
          prUrl: `https://github.com/${DEMO_REPO}/pull/44`,
          summary:
            'Alerts are built, tests pass, and the app ran in a browser before the PR opened.',
          verify: { passed: true, attempts: 1 },
          diff: { files: 7, additions: 212, deletions: 18 },
          triggers: [{ id: 'new-dependency', description: 'A new dependency: @weather/sdk' }],
        },
        blocks: [],
        roleNeeded: 'frontend_engineer',
      },
      {
        ...base,
        runId: frontend.id,
        type: 'question',
        title: 'Difficulty labels: Easy / Moderate / Hard, or Beginner / Intermediate / Expert?',
        contextCard: {
          context: 'Writing the trip card.',
          whyNow: 'The stories do not say. It is using Easy / Moderate / Hard for now.',
        },
        options: [
          { id: 'easy', label: 'Easy / Moderate / Hard' },
          { id: 'bie', label: 'Beginner / Intermediate / Expert' },
        ],
        recommendation: 'easy',
        defaultValue: 'easy',
        dueAt: new Date(now + 4 * HOUR),
        blocks: [],
        topicKey: 'difficulty-labels',
        roleNeeded: 'frontend_engineer',
      },
      {
        ...base,
        runId: backend.id,
        type: 'decision',
        title: 'Protected path changed: .github/workflows/ci.yml',
        contextCard: {
          kind: 'protected_path',
          summary: 'The change adds a step to the CI workflow.',
          paths: ['.github/workflows/ci.yml'],
        },
        options: [
          { id: 'allow', label: 'Allow this change to the protected path' },
          { id: 'discard', label: 'Discard the edits to protected paths' },
        ],
        recommendation: 'discard',
        blocks: [{ runId: backend.id }],
        hardStop: true,
        roleNeeded: 'backend_engineer',
      },
    ]);

    // ---- assumptions
    await db.insert(assumption).values([
      {
        initiativeId: init!.id,
        runId: backend.id,
        text: 'Invite links expire after 7 days',
        impact: 'low',
      },
      {
        initiativeId: init!.id,
        runId: frontend.id,
        text: 'Show temperatures in °C only',
        impact: 'medium',
      },
      {
        initiativeId: init!.id,
        runId: backend.id,
        text: 'Trips are public to anyone with the invite link',
        impact: 'medium',
      },
    ]);

    // ---- a month of history for the interruption metrics
    const [sd] = await db
      .insert(standingDecision)
      .values({
        scope: 'initiative',
        scopeId: init!.id,
        topic: 'date-library',
        text: 'Use date-fns for dates and times',
        createdBy: bob,
        createdAt: ago(10 * DAY),
      })
      .returning();

    const past = async (
      run: typeof backend,
      daysAgo: number,
      o: {
        title: string;
        topic: string;
        pick?: string;
        took?: boolean;
        didntNeed?: boolean;
        waitMin?: number;
        via?: string;
      },
    ) => {
      const created = ago(daysAgo * DAY);
      const options = [
        { id: 'A', label: 'The recommended choice' },
        { id: 'B', label: 'The other choice' },
      ];
      const viaStanding = o.via === 'standing';
      await db.insert(interaction).values({
        ...base,
        runId: run.id,
        type: 'question',
        state: 'answered',
        title: o.title,
        options,
        recommendation: 'A',
        topicKey: o.topic,
        roleNeeded: run.agentRole,
        blocks: [{ runId: run.id }],
        createdAt: created,
        answeredAt: new Date(created.getTime() + (o.waitMin ?? 30) * 60_000),
        answeredBy: viaStanding ? null : bob,
        answeredVia: o.via ?? 'workspace',
        answer: viaStanding
          ? { text: sd!.text, source: 'standing' }
          : {
              text: o.took === false ? 'B: The other choice' : 'A: The recommended choice',
              choice: o.took === false ? 'B' : 'A',
              source: 'human',
            },
        didntNeedToAsk: o.didntNeed ?? false,
        standingDecisionId: viaStanding ? sd!.id : null,
      });
    };

    // Four weeks, with fewer asks per merged PR as the standing decision and the prompts settle in.
    const plan: Array<[number, typeof backend, string, string, boolean?, boolean?, number?]> = [
      [27, backend, 'Which date library?', 'date-library', true, false, 95],
      [26, frontend, 'Button copy: Save or Done?', 'copy', true, true, 60],
      [24, backend, 'Where do trips live?', 'storage', false, false, 120],
      [22, frontend, 'Empty-state wording', 'copy', true, true, 45],
      [20, backend, 'Retry policy for the forecast call?', 'retries', true, false, 80],
      [18, backend, 'Date library again?', 'date-library', true, false, 50],
      [15, frontend, 'Icon set?', 'icons', true, false, 40],
      [12, backend, 'Date library once more?', 'date-library', true, false, 25],
      [6, backend, 'Pagination size?', 'pagination', true, false, 20],
      [3, frontend, 'Toast position?', 'copy', true, false, 15],
    ];
    for (const [d, run, title, topic, took, didntNeed, wait] of plan) {
      await past(run, d, { title, topic, took, didntNeed, waitMin: wait });
    }
    for (const d of [8, 5, 2]) {
      await past(backend, d, { title: 'Date library?', topic: 'date-library', via: 'standing' });
    }
    // Merged pull requests, more of them in the later weeks.
    for (const [d, run] of [
      [25, backend],
      [21, frontend],
      [19, backend],
      [14, backend],
      [13, frontend],
      [9, backend],
      [7, frontend],
      [6, backend],
      [4, backend],
      [2, frontend],
      [1, backend],
    ] as Array<[number, typeof backend]>) {
      await db.insert(activityEvent).values({
        ts: ago(d * DAY),
        actorType: 'system',
        initiativeId: init!.id,
        runId: run.id,
        action: 'pull_request.merged',
        detail: {},
      });
    }
    return { seeded: true };
  } finally {
    await pool.end();
  }
}

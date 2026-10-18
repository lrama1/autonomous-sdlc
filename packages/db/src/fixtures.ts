import { generateToken, hashToken } from '@sdlc/core';
import type { Db } from './client.js';
import { person } from './schema.js';
import { agentRun, initiative, repositoryEntry, runToken } from './schema-work.js';

export interface RunFixtureOptions {
  state?: string;
  modelAlias?: string;
  budgetMicros?: number;
  costMicros?: number;
  scopes?: string[];
  tokenTtlMs?: number;
  revoked?: boolean;
}

export interface RunFixture {
  runId: string;
  initiativeId: string;
  personId: string;
  repositoryId: string;
  token: string;
}

let counter = 0;

/** Creates a person, repository, initiative, run, and run token. For tests and local scripts. */
export async function createRunFixture(db: Db, o: RunFixtureOptions = {}): Promise<RunFixture> {
  const n = `${Date.now()}-${++counter}`;
  const [p] = await db
    .insert(person)
    .values({
      displayName: `Fixture ${n}`,
      email: `fixture-${n}@example.test`,
      oidcSubject: `fixture-${n}`,
    })
    .returning();
  const [repo] = await db
    .insert(repositoryEntry)
    .values({ fullName: `fixture/repo-${n}` })
    .returning();
  const [init] = await db
    .insert(initiative)
    .values({
      title: `Initiative ${n}`,
      goal: 'fixture goal',
      repositoryId: repo!.id,
      createdBy: p!.id,
    })
    .returning();
  const alias = o.modelAlias ?? 'agent-default';
  const [run] = await db
    .insert(agentRun)
    .values({
      initiativeId: init!.id,
      agentRole: 'backend_engineer',
      agentDefinitionId: 'backend-engineer',
      agentDefinitionVersion: 1,
      engine: 'claude-code',
      modelAlias: alias,
      state: o.state ?? 'running',
      sponsorPersonId: p!.id,
      repositoryId: repo!.id,
      budgetMicros: o.budgetMicros ?? 2_000_000,
      costMicros: o.costMicros ?? 0,
    })
    .returning();
  const token = generateToken();
  await db.insert(runToken).values({
    tokenHash: hashToken(token),
    runId: run!.id,
    scopes: o.scopes ?? ['gateway', 'mcp', `alias:${alias}`, 'alias:agent-fast'],
    expiresAt: new Date(Date.now() + (o.tokenTtlMs ?? 3_600_000)),
    revokedAt: o.revoked ? new Date() : null,
  });
  return { runId: run!.id, initiativeId: init!.id, personId: p!.id, repositoryId: repo!.id, token };
}

/** Another run in the same initiative (for de-duplication and review tests). */
export async function addRunToFixture(
  db: Db,
  base: RunFixture,
  o: RunFixtureOptions & { sponsorPersonId?: string; agentRole?: string } = {},
): Promise<{ runId: string; token: string }> {
  const alias = o.modelAlias ?? 'agent-default';
  const [run] = await db
    .insert(agentRun)
    .values({
      initiativeId: base.initiativeId,
      agentRole: o.agentRole ?? 'backend_engineer',
      agentDefinitionId: 'backend-engineer',
      agentDefinitionVersion: 1,
      engine: 'claude-code',
      modelAlias: alias,
      state: o.state ?? 'running',
      sponsorPersonId: o.sponsorPersonId ?? base.personId,
      repositoryId: base.repositoryId,
      budgetMicros: o.budgetMicros ?? 2_000_000,
    })
    .returning();
  const token = generateToken();
  await db.insert(runToken).values({
    tokenHash: hashToken(token),
    runId: run!.id,
    scopes: o.scopes ?? ['gateway', 'mcp', `alias:${alias}`],
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return { runId: run!.id, token };
}

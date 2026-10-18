import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '@sdlc/db';
import { costsSchema, monthlyBudgetSchema } from '@sdlc/schemas';
import { costReport, monthlyStatus } from './costs.js';
import type { BudgetConfig } from './costs.js';
import { requirePerson } from './people.js';

export function registerCostRoutes(app: FastifyInstance, db: Db, budget: BudgetConfig): void {
  app.get('/api/costs', async (request, reply) => {
    if (!(await requirePerson(db, request, reply))) return;
    const q = z
      .object({
        days: z.coerce.number().int().min(1).max(365).default(30),
        initiativeId: z.string().uuid().optional(),
      })
      .parse(request.query);
    return costsSchema.parse(
      await costReport(db, { days: q.days, initiativeId: q.initiativeId ?? null, budget }),
    );
  });

  // Light enough for every page to ask, so an admin sees the warning wherever they are.
  app.get('/api/costs/budget', async (request, reply) => {
    if (!(await requirePerson(db, request, reply))) return;
    return monthlyBudgetSchema.parse(await monthlyStatus(db, budget));
  });
}

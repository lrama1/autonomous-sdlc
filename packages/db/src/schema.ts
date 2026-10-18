import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '@sdlc/core';

const id = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdateFn(() => new Date());

export const person = pgTable('person', {
  id: id(),
  displayName: text('display_name').notNull(),
  email: text('email').notNull().unique(),
  oidcSubject: text('oidc_subject').notNull().unique(),
  githubUserId: bigint('github_user_id', { mode: 'number' }),
  // Set by a platform admin. A chat reply is accepted only from the Slack user linked here.
  slackUserId: text('slack_user_id').unique(),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const hat = pgTable(
  'hat',
  {
    id: id(),
    personId: uuid('person_id')
      .notNull()
      .references(() => person.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    deputyPersonId: uuid('deputy_person_id').references(() => person.id),
    hours: jsonb('hours'),
    outOfOffice: jsonb('out_of_office'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('hat_person_role_uq').on(t.personId, t.role)],
);

// Append-only. Every state change in the platform writes one row (spec section 10.6).
export const activityEvent = pgTable(
  'activity_event',
  {
    id: id(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    actorType: text('actor_type').notNull(), // person | agent | system
    actorId: uuid('actor_id'),
    initiativeId: uuid('initiative_id'),
    runId: uuid('run_id'),
    interactionId: uuid('interaction_id'),
    action: text('action').notNull(),
    detail: jsonb('detail').notNull().default({}),
  },
  (t) => [
    index('activity_event_ts_idx').on(t.ts),
    index('activity_event_initiative_idx').on(t.initiativeId),
  ],
);

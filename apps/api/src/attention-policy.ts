import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import { DEFAULT_ATTENTION_POLICY } from '@sdlc/core';
import type { AttentionPolicy } from '@sdlc/core';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM');

// The team's rules for how people are reached. Edited by hand, like the trigger rules.
const fileSchema = z.object({
  version: z.literal(1).default(1),
  reminder_after_minutes: z.number().int().positive().default(120),
  escalate_after_minutes: z.number().int().positive().default(240),
  max_reminders_per_level: z.number().int().min(0).max(20).default(3),
  timezone: z.string().default('UTC'),
  // Low-priority asks wait for this time. Leave it out to send them at once.
  digest_at: hhmm.optional(),
  // Used for people whose own hat has no hours. Leave it out and everyone is reachable at any time.
  working_hours: z
    .object({
      days: z.array(z.number().int().min(1).max(7)).optional(),
      start: hhmm,
      end: hhmm,
    })
    .optional(),
  chat_approve: z
    .array(z.enum(['question', 'decision', 'review']))
    .default(['question', 'decision']),
});

export async function loadAttentionPolicy(file: string): Promise<AttentionPolicy> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_ATTENTION_POLICY };
    throw e;
  }
  const parsed = fileSchema.safeParse(parse(raw) ?? {});
  if (!parsed.success) {
    throw new Error(
      `${file} is not a valid attention policy: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    );
  }
  const f = parsed.data;
  if (f.escalate_after_minutes <= f.reminder_after_minutes) {
    throw new Error(`${file}: escalate_after_minutes must be longer than reminder_after_minutes`);
  }
  return {
    reminderAfterMs: f.reminder_after_minutes * 60_000,
    escalateAfterMs: f.escalate_after_minutes * 60_000,
    maxRemindersPerLevel: f.max_reminders_per_level,
    digestAt: f.digest_at ?? null,
    tz: f.timezone,
    defaultHours: f.working_hours ? { tz: f.timezone, ...f.working_hours } : null,
    chatApprove: f.chat_approve,
  };
}

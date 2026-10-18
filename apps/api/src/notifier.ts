// The notifier port (mvp-contract section 12.4). The Workspace is always the full record. A notifier reaches
// a person where they already are, with a deep link back.

export type NotificationKind = 'ask' | 'reminder' | 'escalation' | 'default_applied' | 'digest';

export interface NotificationBody {
  kind: NotificationKind;
  /** 'digest' asks may wait for the daily digest. */
  urgency: 'now' | 'digest';
  interactionId?: string;
  title: string;
  type?: string;
  hardStop?: boolean;
  /** Who raised it and what it is about, in one line. */
  summary?: string;
  options?: Array<{ id: string; label: string }>;
  recommendation?: string | null;
  dueAt?: string | null;
  blocksCount?: number;
  /** May be settled from chat. */
  chat: boolean;
  /** Where the full context is, in the Workspace. */
  link: string;
  level?: number;
  /** What was applied when nobody answered in time. */
  appliedDefault?: string;
  /** The items in a digest. */
  items?: Array<{ title: string; link: string }>;
}

export interface Recipient {
  personId: string;
  displayName: string;
  slackUserId: string | null;
}

export type Delivered = { ref?: unknown } | { skipped: string };

export interface Notifier {
  readonly channel: string;
  deliver(to: Recipient, body: NotificationBody): Promise<Delivered>;
}

/** Local development: nothing leaves the machine. The message is in the log and the outbox table. */
export class LogNotifier implements Notifier {
  readonly channel = 'log';
  constructor(private readonly log: (line: string) => void = () => {}) {}
  async deliver(to: Recipient, body: NotificationBody): Promise<Delivered> {
    this.log(`notify ${to.displayName}: ${body.kind} "${body.title}" ${body.link}`);
    return {};
  }
}

// Interruption metrics (spec 5.7). Pure: the caller loads the rows and passes the clock.

export interface AskRow {
  type: string;
  state: string;
  agentRole: string | null;
  createdAt: Date;
  answeredAt: Date | null;
  answeredVia: string | null;
  recommendation: string | null;
  /** What the person chose (an option id) or wrote. */
  choice: string | null;
  text: string | null;
  didntNeedToAsk: boolean;
  /** An agent was waiting on it. */
  blocking: boolean;
  /** What the ask was about, for grouping. */
  situation: string;
  standingDecisionId: string | null;
}

export interface MergeRow {
  at: Date;
  agentRole: string | null;
}

export interface RunSpan {
  startedAt: Date;
  endedAt: Date | null;
}

export interface StandingRef {
  id: string;
  topic: string;
}

export type Suggestion = 'covered' | 'make_standing' | 'ask_less' | 'keep';

export interface InterruptionMetrics {
  windowDays: number;
  asks: number;
  answeredByPerson: number;
  mergedPrs: number;
  questionsPerMergedPr: number | null;
  /** Share of person-answered questions where the recommendation was taken unchanged. */
  unchangedShare: number | null;
  didntNeedShare: number | null;
  medianAnswerMs: number | null;
  /** Time agents spent waiting on a person, as a share of all run time in the window. */
  blockedShare: number | null;
  defaulted: number;
  avoidedByStanding: number;
  weekly: Array<{ weekStart: string; asks: number; merged: number; perPr: number | null }>;
  byAgent: Array<{
    agentRole: string;
    asks: number;
    merged: number;
    perPr: number | null;
    unchangedShare: number | null;
  }>;
  situations: Array<{
    situation: string;
    asked: number;
    unchanged: number;
    didntNeed: number;
    suggestion: Suggestion;
    standingDecisionId: string | null;
  }>;
}

const DAY = 86_400_000;
const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);
const round = (n: number | null, d = 2): number | null =>
  n === null ? null : Math.round(n * 10 ** d) / 10 ** d;

/** Questions and decision requests count as asks. Reviews and checkpoints are planned work, not interruptions. */
const isAsk = (a: AskRow): boolean => a.type === 'question' || a.type === 'decision';

export function tookRecommendation(a: Pick<AskRow, 'recommendation' | 'choice' | 'text'>): boolean {
  if (!a.recommendation) return false;
  const rec = a.recommendation.trim().toLowerCase();
  return (
    (a.choice !== null && a.choice.trim().toLowerCase() === rec) ||
    (a.text !== null && a.text.trim().toLowerCase() === rec)
  );
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function computeInterruptionMetrics(
  input: {
    asks: AskRow[];
    merges: MergeRow[];
    runs: RunSpan[];
    standing: StandingRef[];
  },
  now: Date,
  windowDays = 30,
): InterruptionMetrics {
  const from = new Date(now.getTime() - windowDays * DAY);
  const inWindow = (d: Date) => d >= from && d <= now;

  const all = input.asks.filter((a) => isAsk(a) && inWindow(a.createdAt));
  const avoided = all.filter((a) => a.answeredVia === 'standing');
  // An ask a standing decision answered never reached a person, so it is not an interruption.
  const asks = all.filter((a) => a.answeredVia !== 'standing');
  const person = asks.filter((a) => a.state === 'answered' && a.answeredVia !== 'default');
  const merges = input.merges.filter((m) => inWindow(m.at));

  const withRec = person.filter((a) => a.recommendation);
  const unchanged = withRec.filter(tookRecommendation);

  const waits = person
    .filter((a) => a.answeredAt)
    .map((a) => a.answeredAt!.getTime() - a.createdAt.getTime());

  // Blocked time: how long blocking asks were open inside the window, against all run time inside it.
  let blockedMs = 0;
  for (const a of asks.filter((x) => x.blocking)) {
    const end = a.answeredAt ?? now;
    blockedMs += Math.max(0, end.getTime() - Math.max(a.createdAt.getTime(), from.getTime()));
  }
  let runMs = 0;
  for (const r of input.runs) {
    const end = r.endedAt ?? now;
    runMs += Math.max(0, end.getTime() - Math.max(r.startedAt.getTime(), from.getTime()));
  }

  const weekly: InterruptionMetrics['weekly'] = [];
  const weeks = Math.max(1, Math.round(windowDays / 7));
  for (let w = weeks - 1; w >= 0; w--) {
    const end = now.getTime() - w * 7 * DAY;
    const start = end - 7 * DAY;
    const inWeek = (d: Date) => d.getTime() > start && d.getTime() <= end;
    const a = asks.filter((x) => inWeek(x.createdAt)).length;
    const m = merges.filter((x) => inWeek(x.at)).length;
    weekly.push({
      weekStart: new Date(start).toISOString().slice(0, 10),
      asks: a,
      merged: m,
      perPr: round(ratio(a, m)),
    });
  }

  const roles = new Set<string>();
  for (const a of asks) if (a.agentRole) roles.add(a.agentRole);
  for (const m of merges) if (m.agentRole) roles.add(m.agentRole);
  const byAgent = [...roles].sort().map((role) => {
    const mine = asks.filter((a) => a.agentRole === role);
    const done = mine.filter(
      (a) => a.state === 'answered' && a.answeredVia !== 'default' && a.recommendation,
    );
    const merged = merges.filter((m) => m.agentRole === role).length;
    return {
      agentRole: role,
      asks: mine.length,
      merged,
      perPr: round(ratio(mine.length, merged)),
      unchangedShare: round(ratio(done.filter(tookRecommendation).length, done.length)),
    };
  });

  const standingByTopic = new Map(input.standing.map((s) => [s.topic.trim().toLowerCase(), s.id]));
  const groups = new Map<string, AskRow[]>();
  for (const a of input.asks.filter((x) => inWindow(x.createdAt))) {
    if (a.answeredVia === 'standing') continue;
    groups.set(a.situation, [...(groups.get(a.situation) ?? []), a]);
  }
  const situations = [...groups.entries()]
    .map(([situation, rows]) => {
      const answered = rows.filter(
        (a) => a.state === 'answered' && a.answeredVia !== 'default' && a.recommendation,
      );
      const same = answered.filter(tookRecommendation).length;
      const didntNeed = rows.filter((a) => a.didntNeedToAsk).length;
      const standingId = standingByTopic.get(situation.trim().toLowerCase()) ?? null;
      let suggestion: Suggestion = 'keep';
      if (standingId) suggestion = 'covered';
      // Asks people call unnecessary come first: a standing decision would only hide a question nobody needed.
      else if (rows.length >= 2 && didntNeed / rows.length >= 0.5) suggestion = 'ask_less';
      else if (answered.length >= 3 && same === answered.length) suggestion = 'make_standing';
      return {
        situation,
        asked: rows.length,
        unchanged: same,
        didntNeed,
        suggestion,
        standingDecisionId: standingId,
      };
    })
    .sort((a, b) => b.asked - a.asked || a.situation.localeCompare(b.situation));

  return {
    windowDays,
    asks: asks.length,
    answeredByPerson: person.length,
    mergedPrs: merges.length,
    questionsPerMergedPr: round(ratio(asks.filter((a) => isAsk(a)).length, merges.length)),
    unchangedShare: round(ratio(unchanged.length, withRec.length)),
    didntNeedShare: round(
      ratio(
        asks.filter((a) => a.didntNeedToAsk).length,
        asks.filter((a) => a.state !== 'open').length,
      ),
    ),
    medianAnswerMs: median(waits),
    blockedShare: round(ratio(Math.min(blockedMs, runMs), runMs), 3),
    defaulted: asks.filter((a) => a.state === 'defaulted').length,
    avoidedByStanding: avoided.length,
    weekly,
    byAgent,
    situations,
  };
}

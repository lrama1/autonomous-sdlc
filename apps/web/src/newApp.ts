/** Pure helpers for the New app wizard: composing the goal, and what earlier new apps cost. */

/** The goal is stored with the initiative and has this limit. */
export const GOAL_MAX = 4000;

export interface GoalAnswers {
  /** What it is and who it is for. */
  what: string;
  /** What it must do, one thing per line. */
  mustDo: string;
  /** What it must not do, or leaves out, one thing per line. */
  mustNot: string;
  /** Anything about look, feel, devices, language or where it runs. */
  feel: string;
}

/** One entry per non-empty line, without a leading bullet or number. */
export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
}

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join('\n');

/** The goal the agents read, written from the wizard's answers. Empty sections are left out. */
export function composeGoal(a: GoalAnswers): string {
  const parts = [a.what.trim()];
  const must = splitLines(a.mustDo);
  if (must.length) parts.push(`It must:\n${bullets(must)}`);
  const mustNot = splitLines(a.mustNot);
  if (mustNot.length) parts.push(`It must not, or leaves out:\n${bullets(mustNot)}`);
  if (a.feel.trim()) parts.push(`Look, feel and where it runs:\n${a.feel.trim()}`);
  return parts.filter(Boolean).join('\n\n');
}

export interface StepProblem {
  field: string;
  message: string;
}

/** What is missing before the person may leave the "Describe it" step. */
export function describeProblems(
  title: string,
  a: GoalAnswers,
  referenceLinks: string,
): StepProblem[] {
  const out: StepProblem[] = [];
  if (!title.trim()) out.push({ field: 'title', message: 'Give it a name.' });
  if (!a.what.trim())
    out.push({ field: 'what', message: 'Say what it is and who it is for, in a sentence or two.' });
  if (splitLines(a.mustDo).length === 0)
    out.push({ field: 'mustDo', message: 'List at least one thing it must do.' });
  for (const l of referenceLinks.split(/\s+/).filter(Boolean)) {
    if (!/^https:\/\/\S+$/.test(l))
      out.push({ field: 'links', message: `“${l}” is not an https link.` });
  }
  if (composeGoal(a).length > GOAL_MAX)
    out.push({
      field: 'what',
      message: `That is longer than the ${GOAL_MAX} characters a goal may have. Shorten it.`,
    });
  return out;
}

export interface BuiltApp {
  kind: string | null;
  spentUsd: number;
  plan: { merged: number } | null;
}

export interface CostEstimate {
  count: number;
  low: number;
  high: number;
  median: number;
}

/** What earlier new apps cost, counting only those that got as far as merging build tasks. Null if there are none. */
export function estimateNewAppCost(all: BuiltApp[]): CostEstimate | null {
  const costs = all
    .filter((i) => i.kind === 'new_app' && i.spentUsd > 0 && (i.plan?.merged ?? 0) > 0)
    .map((i) => i.spentUsd)
    .sort((x, y) => x - y);
  if (costs.length === 0) return null;
  const mid = Math.floor(costs.length / 2);
  const median = costs.length % 2 ? costs[mid]! : (costs[mid - 1]! + costs[mid]!) / 2;
  return { count: costs.length, low: costs[0]!, high: costs[costs.length - 1]!, median };
}

const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : Math.round(n).toString()}`;

/** A sentence about cost that does not claim more than the history supports. */
export function describeEstimate(e: CostEstimate | null): string {
  if (!e)
    return 'No new app has been built here yet, so there is nothing to compare with. Each agent run is charged as it happens, and the Costs page shows where it goes.';
  if (e.count === 1)
    return `One earlier new app that reached the build cost ${usd(e.median)}. One example is not a trend: treat it as a rough guide.`;
  if (e.count === 2)
    return `Two earlier new apps that reached the build cost ${usd(e.low)} and ${usd(e.high)}. Two examples are not a trend: treat them as a rough guide.`;
  return `${e.count} earlier new apps that reached the build cost between ${usd(e.low)} and ${usd(e.high)}, typically about ${usd(e.median)}. Yours may differ with its size.`;
}

import { HELP_GUIDE, SHELL_HELP, helpAsText } from '@sdlc/core';
import type { AssistantModel, Block, ChatMessage } from './model.js';
import { TOOL_SPECS, clip } from './tools.js';
import type { Proposal, Step, AssistantTools } from './tools.js';

export interface ChatContext {
  /** The screen, as the navigation names it: queue, map, bugs... */
  page?: string;
  /** The address in the browser, after the #. */
  hash?: string;
  initiativeId?: string;
  interactionId?: string;
  /** What the screen shows, as text. Cut. */
  pageText?: string;
}

export interface Asker {
  name: string;
  roles: string[];
}

export interface Answer {
  text: string;
  steps: Step[];
  proposals: Proposal[];
  costMicros: number;
  /** Set when it stopped before it could finish. */
  stopped: 'cap' | 'turns' | null;
}

const MAX_TURNS = 8;
const HISTORY = 16;

const OVERVIEW = `You are the assistant built into the Autonomous SDLC platform: a place where AI agents build software and people decide. You help the person using it right now.

How the platform works, in short:
- An initiative is one goal on one repository. It goes through three stages on the Map: spec and design (agents draft a spec, then an Architect designs it, a person approves each), build and review (the design becomes a build plan of tasks T1, T2... that engineer agents build, each as a pull request), and release.
- Each pull request is a review in the Attention queue. A person approves, requests changes or rejects it. Checks guard the approval: the agent's own verification, a security review, a smoke test (the app is started in a sandbox and its checks run), and a preview. A hard stop is an ask that cannot be skipped or defaulted.
- Agents ask questions (asks) and note assumptions. The Attention queue ranks what needs a person. Autonomy mode (guided, balanced, autopilot) sets how much starts and merges without a person.
- Roles decide who may do what: product_owner, architect, engineers, devops, platform_admin.
- Bugs are reported on the Bugs page and a Bug Agent reproduces and fixes them. Costs are tracked per run and per initiative.`;

const RULES = `How to answer:
- Look before you answer. Use the tools for anything about a specific initiative, run, review, task, check or file, and to look at the built app. Do not guess a fact you could read. If a tool shows nothing, say so.
- Explain a screen from the screen guide below: say what it is for, then what each element does, using the real labels. Use the page text to point at what is on screen right now. If a control is disabled, say why.
- You can only read. You cannot click anything. When an action would help (retry a failed task, run the built app, file a bug, open a screen), call propose_action: the person gets a button and decides. Never say you did something.
- To troubleshoot the built app, find the running preview (/api/initiatives/{id}/preview, or a review's /preview), read its logs, request its pages, and read its code. Say what you saw and what you think is wrong, and how sure you are. If no preview is running, say so and propose starting one.
- Be short and concrete. Use the person's own words and the platform's labels. Use short lists when there are several things. Do not repeat the question.
- You do not make decisions for the person. Say what you recommend and why.
- If something is outside the platform, say so briefly.`;

export function systemPrompt(ctx: ChatContext, who: Asker, now: Date): string {
  const page = ctx.page && ctx.page in HELP_GUIDE ? ctx.page : null;
  return [
    OVERVIEW,
    RULES,
    `The person: ${who.name} (roles: ${who.roles.join(', ') || 'none'}). Today is ${now.toISOString().slice(0, 10)}.`,
    page
      ? `The screen they are on:\n${helpAsText(page)}`
      : 'They are on a screen with no guide. Use the page text.',
    `The shell on every screen:\n${SHELL_HELP.map((e) => `- ${e.name}: ${e.what}`).join('\n')}`,
  ].join('\n\n');
}

/** The person's question, with where they are. */
export function userTurn(text: string, ctx: ChatContext): string {
  const lines = ['<context>'];
  if (ctx.page)
    lines.push(`Screen: ${ctx.page}${ctx.hash ? ` (address #${ctx.hash.replace(/^#/, '')})` : ''}`);
  if (ctx.initiativeId) lines.push(`Initiative on screen: ${ctx.initiativeId}`);
  if (ctx.interactionId) lines.push(`Item open: ${ctx.interactionId}`);
  if (ctx.pageText) lines.push(`What the screen shows (cut):\n${clip(ctx.pageText, 5000)}`);
  lines.push('</context>', '', text);
  return lines.join('\n');
}

const textOf = (blocks: Block[]) =>
  blocks
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('\n')
    .trim();

/**
 * One answer: the model may look things up (up to a few rounds) before it replies. `room` is what the person may still
 * spend today, in millionths of a dollar, and the answer stops when it is used up.
 */
export async function answerQuestion(deps: {
  model: AssistantModel;
  alias: string;
  tools: AssistantTools;
  history: ChatMessage[];
  text: string;
  ctx: ChatContext;
  who: Asker;
  room: number;
  now?: Date;
}): Promise<Answer> {
  const { model, alias, tools } = deps;
  const system = systemPrompt(deps.ctx, deps.who, deps.now ?? new Date());
  const messages: ChatMessage[] = [
    ...deps.history.slice(-HISTORY),
    { role: 'user', content: userTurn(deps.text, deps.ctx) },
  ];
  let cost = 0;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (cost >= deps.room)
      return finish(
        tools,
        cost,
        'cap',
        'I have used up what you may spend on the assistant today.',
      );
    const last = turn === MAX_TURNS - 1;
    const ans = await model.complete({
      alias,
      system: last
        ? `${system}\n\nYou have looked enough. Answer now with what you found, and say what you could not check.`
        : system,
      messages,
      tools: last ? [] : TOOL_SPECS,
    });
    cost += ans.costMicros;
    const uses = ans.content.flatMap((b) => (b.type === 'tool_use' ? [b] : []));
    if (uses.length === 0 || last) {
      const text = textOf(ans.content);
      return finish(
        tools,
        cost,
        null,
        text || 'I could not put an answer together. Try asking again.',
      );
    }
    messages.push({ role: 'assistant', content: ans.content });
    const results: Block[] = [];
    for (const u of uses) {
      const r = await tools.run(u.name, u.input ?? {});
      results.push({
        type: 'tool_result',
        tool_use_id: u.id,
        content: r.text,
        ...(r.error ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: results });
  }
  return finish(tools, cost, 'turns', 'I ran out of steps before I could finish.');
}

function finish(
  tools: AssistantTools,
  costMicros: number,
  stopped: Answer['stopped'],
  text: string,
): Answer {
  return { text, steps: tools.steps, proposals: tools.proposals, costMicros, stopped };
}

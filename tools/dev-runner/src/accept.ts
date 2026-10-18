/* eslint-disable @typescript-eslint/no-explicit-any */
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { parseDesignTasks } from '@sdlc/core';
import type { CookieJar } from './signin.js';
import { signInAs } from './signin.js';
import { startStack } from './stack.js';

// Step 1 acceptance (mvp-contract section 16), live: real Claude Code, real gateway and OpenRouter, real GitHub.
// It spends a few cents and merges a small change into the scratch repository.
//   node --import tsx src/accept.ts [happy|resume|both|standing|autopilot|release|compare|preview|design|build|bigbuild|mixedbuild|overlap|pipeline|catchup|all] [docker]
// Set ACCEPT_ENGINE=copilot-cli to run the same phases with the agents switched to another engine.
const REPO = 'lrama1/sdlc-scratch';
const phase = process.argv[2] ?? 'both';
const docker = process.argv.includes('docker');
const stamp = Date.now().toString(36);
const t0 = Date.now();
const say = (m: string) =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const checks: Array<[boolean, string]> = [];
const check = (ok: boolean, what: string) => {
  checks.push([ok, what]);
  say(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
};

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  everyMs = 1500,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(everyMs);
  }
}

const engine = process.env.ACCEPT_ENGINE;
let agentsDir: string | undefined;
if (engine) {
  agentsDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-agents-'));
  await cp(path.resolve(import.meta.dirname, '..', '..', '..', 'agents'), agentsDir, {
    recursive: true,
  });
  for (const id of await readdir(agentsDir)) {
    const file = path.join(agentsDir, id, 'agent.yaml');
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace(/^engine: .*$/m, `engine: ${engine}`));
  }
}

const stack = await startStack({
  log: (l) =>
    l.startsWith('[api]')
      ? l.includes('"level":50') && say(l.slice(0, 1500))
      : !l.startsWith('[gateway]') && say(l),
  apiEnv: {
    BLOCKING_MAX_S: '600',
    ...(docker ? { RUNNER_ADAPTER: 'docker' } : {}),
    ...(agentsDir ? { AGENTS_DIR: agentsDir } : {}),
  },
});
const db = new pg.Client(stack.databaseUrl);
await db.connect();
const ghToken = process.env.GH_TOKEN;

async function call(jar: CookieJar, method: string, path: string, body?: unknown): Promise<any> {
  const r = await jar.fetch(`${stack.publicUrl}${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
  let json: any = r.text;
  try {
    json = JSON.parse(r.text);
  } catch {
    // keep text
  }
  if (r.status >= 400) throw new Error(`${method} ${path} -> ${r.status}: ${r.text.slice(0, 300)}`);
  return json;
}

async function gh(path: string): Promise<any> {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${ghToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'sdlc-accept',
    },
  });
  if (!r.ok) throw new Error(`GitHub ${path} -> ${r.status}`);
  return r.json();
}

const exec = promisify(execFile);
async function killRunners(): Promise<number> {
  if (docker) {
    const { stdout } = await exec('docker', ['ps', '-q', '--filter', 'label=sdlc.run']);
    const ids = stdout.split(/\s+/).filter(Boolean);
    for (const id of ids) await exec('docker', ['kill', id]).catch(() => {});
    return ids.length;
  }
  const { stdout } = await exec('powershell', [
    '-NoProfile',
    '-Command',
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'apps.runner.src.main\\.ts' } | Select-Object -ExpandProperty ProcessId",
  ]);
  const pids = stdout.split(/\s+/).filter(Boolean);
  for (const pid of pids) await exec('taskkill', ['/PID', pid, '/T', '/F']).catch(() => {});
  return pids.length;
}

/** Names of live sandbox containers for a run (empty when not running in Docker). */
async function sandboxFor(runId: string): Promise<string[]> {
  const { stdout } = await exec('docker', [
    'ps',
    '--filter',
    `label=sdlc.run=${runId}`,
    '--format',
    '{{.Names}}',
  ]);
  return stdout.split(/\s+/).filter(Boolean);
}

async function sandboxLeftovers(runId: string): Promise<string> {
  const v = (
    await exec('docker', ['volume', 'ls', '-q', '--filter', `name=sdlc-work-${runId}`])
  ).stdout.trim();
  const n = (
    await exec('docker', ['network', 'ls', '-q', '--filter', `name=sdlc-net-${runId}`])
  ).stdout.trim();
  const c = (
    await exec('docker', ['ps', '-aq', '--filter', `label=sdlc.run=${runId}`])
  ).stdout.trim();
  return [v && 'volume', n && 'network', c && 'container'].filter(Boolean).join(', ');
}
try {
  const admin = await signInAs(stack.publicUrl, 'dev-admin');
  const alice = await signInAs(stack.publicUrl, 'dev-alice'); // Product Owner: starts the work
  const bob = await signInAs(stack.publicUrl, 'dev-bob'); // Backend Engineer: answers and reviews

  // 1. The repository is in the registry.
  const repos: any[] = await call(admin, 'GET', '/api/repositories');
  let repo = repos.find((r) => r.fullName === REPO);
  if (!repo) {
    repo = await call(admin, 'POST', '/api/repositories', {
      fullName: REPO,
      protectedPaths: ['.github/workflows/**', 'scripts/**', 'package.json'],
    });
  }
  check(Boolean(repo?.id), `1  ${REPO} is in the registry (branch_pr, ${repo.verifyCommand})`);

  async function startRun(title: string, task: string, autonomyMode?: 'guided') {
    const init = await call(alice, 'POST', '/api/initiatives', {
      title,
      goal: title,
      repositoryId: repo.id,
      // These phases start every run themselves.
      autoStages: false,
      ...(autonomyMode ? { autonomyMode } : {}),
    });
    const run = await call(alice, 'POST', `/api/initiatives/${init.id}/runs`, {
      task,
      budgetUsd: 1,
    });
    say(`run ${run.id} queued (${run.definition}, budget $${run.budgetUsd})`);
    return { init, run };
  }
  /**
   * Plays the people around a build plan until it ends: approves the engineers' pull requests, answers their
   * questions with the agent's own recommendation, and records when each task changed state.
   */
  const drivePlan = async (
    initiativeId: string,
    handled: string[],
    startedAt: number,
    /** Return when the plan is stuck on a failed task, instead of stopping the script with an error. */
    allowFailed = false,
  ) => {
    const getPlan = async () =>
      (await call(bob, 'GET', `/api/initiatives/${initiativeId}/plan`)).plan as any;
    let maxRunning = 0;
    const seen = new Map<string, string>();
    const timeline: string[] = [];
    const done = new Set<string>(handled);
    const final = await waitFor(
      'the plan ends',
      async () => {
        const p = await getPlan();
        const running = p.tasks.filter((t: any) => t.state === 'running').length;
        maxRunning = Math.max(maxRunning, running);
        for (const t of p.tasks) {
          if (seen.get(t.key) !== t.state) {
            seen.set(t.key, t.state);
            timeline.push(`${Math.round((Date.now() - startedAt) / 1000)}s ${t.key}:${t.state}`);
          }
        }
        const failed = p.tasks.some((t: any) => t.state === 'failed');
        if (failed && allowFailed) {
          const live = p.tasks.some((t: any) => t.state === 'running' || t.state === 'review');
          if (!live) return p;
        } else if (failed)
          throw new Error(
            `a task failed: ${JSON.stringify(p.tasks.map((t: any) => [t.key, t.state, t.detail]))}`,
          );
        const queue: any[] = await call(bob, 'GET', '/api/interactions');
        for (const q of queue) {
          if (q.initiativeId !== initiativeId || done.has(q.id)) continue;
          if (q.type === 'review') {
            done.add(q.id);
            await call(bob, 'POST', `/api/interactions/${q.id}/answer`, {
              decision: 'approved',
              answer: 'Fine.',
            }).catch(() => done.delete(q.id));
          } else if (['question', 'decision'].includes(q.type)) {
            const options = Array.isArray(q.options) ? q.options : [];
            const choice = q.recommendation ?? options[0]?.id;
            if (choice) {
              done.add(q.id);
              say(`answering "${q.title}" with "${choice}"`);
              await call(bob, 'POST', `/api/interactions/${q.id}/answer`, { answer: choice }).catch(
                () => done.delete(q.id),
              );
            }
          }
        }
        return p.state === 'done' || p.state === 'invalid' || p.state === 'cancelled' ? p : null;
      },
      1_500_000,
      2500,
    );
    return { final, maxRunning, timeline };
  };

  const runState = async (id: string) => (await call(alice, 'GET', `/api/runs/${id}`)) as any;
  const openFor = async (jar: CookieJar, runId: string, types: string[]) => {
    const queue: any[] = await call(jar, 'GET', '/api/interactions');
    return queue.find((i) => i.runId === runId && types.includes(i.type)) ?? null;
  };
  const events = async (runId: string): Promise<any[]> =>
    call(alice, 'GET', `/api/runs/${runId}/events?limit=500`);
  const dumpRun = async (runId: string) => {
    const r = await runState(runId);
    const ev = await events(runId);
    say(`run state ${r.state} (${r.exitReason}), events: ${ev.map((e) => e.type).join(', ')}`);
  };

  // ---------------- Phase A: the full loop ----------------
  if (phase === 'happy' || phase === 'both' || phase === 'all') {
    say('--- phase A: goal to merged pull request ---');
    const route = `/health-${stamp}`;
    const task =
      `Add a GET endpoint at ${route} to src/server.js that answers HTTP 200 with the JSON body {"status":"ok"}, and add a test for it in test/server.test.js. ` +
      `Work in this order. First call search_standing_decisions with the query "health endpoint". ` +
      `Second call ask_human with blocking set to false, asking "Should the ${route} response also include a version field?", options [{id:"yes",label:"Yes"},{id:"no",label:"No"}], recommendation "no", topicKey "health-version". ` +
      `Third call declare_assumption stating the exact JSON body you chose. Then write the code and the test and commit them. ` +
      `Last, call check_answers and, if a person answered, follow the answer and commit again if you need to.`;
    const { run } = await startRun(`Health endpoint ${stamp}`, task);

    const question = await waitFor(
      'the agent asks a question',
      () => openFor(bob, run.id, ['question', 'decision']),
      240_000,
    );
    if (docker) {
      const boxes = await sandboxFor(run.id);
      check(
        boxes.length === 1 && boxes[0] === `sdlc-run-${run.id}`,
        `D  the agent is running in a Docker sandbox: ${boxes.join(', ') || 'none found'}`,
      );
    }
    if (engine) {
      const started = (await events(run.id)).find((e) => e.type === 'engine.started');
      check(
        started?.payload.engine === engine,
        `E  the run used the ${engine} engine (${String(started?.payload.engine)})`,
      );
    }
    check(
      true,
      `4  the agent asked: "${question.title}" (recommendation: ${question.recommendation ?? 'none'})`,
    );
    const bobId = ((await call(bob, 'GET', '/api/me')) as { id: string }).id;
    const handed = await waitFor(
      'the ask is handed to the holder of the hat',
      async () => {
        const r = await db.query('select assigned_person_id from interaction where id = $1', [
          question.id,
        ]);
        return r.rows[0]?.assigned_person_id ? r.rows[0] : null;
      },
      30_000,
      1000,
    );
    const told = await db.query(
      "select count(*)::int as n from notification where interaction_id = $1 and kind = 'ask' and person_id = $2",
      [question.id, bobId],
    );
    check(
      handed.assigned_person_id === bobId && told.rows[0].n === 1,
      'S  the ask was handed to Bob (Backend Engineer hat) and he was notified once',
    );
    await call(bob, 'POST', `/api/interactions/${question.id}/answer`, {
      answer: 'no',
      makeStanding: false,
    });
    say('Bob answered "no"');

    const finished = await waitFor(
      'the run finishes',
      async () => {
        const r = await runState(run.id);
        if (['failed', 'cancelled', 'budget_exceeded', 'timed_out'].includes(r.state)) {
          await dumpRun(run.id);
          throw new Error(`run ended as ${r.state}`);
        }
        return r.state === 'succeeded' ? r : null;
      },
      420_000,
      3000,
    );
    check(
      finished.state === 'succeeded',
      `3  the run succeeded (cost $${finished.costUsd.toFixed(4)})`,
    );
    if (docker) {
      await sleep(2000);
      const left = await sandboxLeftovers(run.id);
      check(
        left === '',
        `D  nothing is left of the sandbox after a finished run${left ? `: ${left}` : ''}`,
      );
    }

    const ev = await events(run.id);
    const types = ev.map((e) => e.type);
    check(types.includes('assumption.declared'), '4  the agent declared an assumption');
    const verify = ev.filter((e) => e.type === 'verify.finished').at(-1);
    check(
      verify?.payload.ok === true,
      `6  verification ran before the PR and passed (attempt ${verify?.payload.attempt}, ${verify?.payload.durationMs} ms)`,
    );
    check(
      types.indexOf('verify.finished') < types.indexOf('branch.pushed') &&
        types.indexOf('branch.pushed') < types.indexOf('pull_request.opened'),
      '6  order: verify, then push, then pull request',
    );

    const review = await waitFor(
      'the review request',
      () => openFor(bob, run.id, ['review']),
      60_000,
    );
    const card = review.contextCard;
    check(
      card?.kind === 'pull_request',
      `5  review requested for PR #${card?.prNumber} (${card?.prUrl}), triggers fired: ${(card?.triggers ?? []).map((t: any) => t.id).join(', ') || 'none'}`,
    );

    // The sponsor may not review their own run (independent review).
    let blocked = false;
    try {
      await call(alice, 'POST', `/api/interactions/${review.id}/answer`, { decision: 'approved' });
    } catch (e) {
      blocked = /403/.test(String(e));
    }
    check(blocked, '5  the person who started the run cannot approve its pull request');

    await call(bob, 'POST', `/api/interactions/${review.id}/answer`, {
      decision: 'approved',
      answer: 'Looks good.',
    });
    say('Bob approved the pull request. Waiting for CI and the Gate...');

    const merged = await waitFor(
      'the Gate merges',
      async () => {
        const row = await db.query(
          "select context_card -> 'gate' as gate from interaction where id = $1",
          [review.id],
        );
        const gate = row.rows[0]?.gate;
        if (gate && !['waiting_ci', 'merged'].includes(gate.state))
          throw new Error(`gate ended as ${gate.state}: ${gate.detail}`);
        return gate?.state === 'merged' ? gate : null;
      },
      300_000,
      4000,
    );
    check(
      Boolean(merged.mergedSha),
      `7  the Gate merged the pull request (${String(merged.mergedSha).slice(0, 7)})`,
    );

    if (ghToken) {
      const pr = await gh(`/repos/${REPO}/pulls/${card.prNumber}`);
      check(pr.merged === true, `7  GitHub shows PR #${card.prNumber} merged`);
      const reviews: any[] = await gh(`/repos/${REPO}/pulls/${card.prNumber}/reviews`);
      check(
        reviews.some((r) => r.state === 'APPROVED' && /\[bot\]$/.test(r.user.login)),
        `7  approved by the Gate App (${reviews.map((r) => r.user.login).join(', ')})`,
      );
      const file = await gh(`/repos/${REPO}/contents/src/server.js?ref=main`);
      check(
        Buffer.from(file.content, 'base64').toString().includes(route),
        `7  main now serves ${route}`,
      );
    }

    const cost = await db.query(
      'select coalesce(sum(cost_micros),0)::bigint as s, count(*)::int as n from cost_record where run_id = $1',
      [run.id],
    );
    const runRow = await db.query('select cost_micros from agent_run where id = $1', [run.id]);
    check(
      Number(cost.rows[0].s) === Number(runRow.rows[0].cost_micros) && cost.rows[0].n > 0,
      `8  ${cost.rows[0].n} model calls recorded, cost records add up to the run cost ($${(Number(cost.rows[0].s) / 1e6).toFixed(4)})`,
    );
    const log = await db.query(
      'select action from activity_event where run_id = $1 or interaction_id = $2 order by ts, id',
      [run.id, review.id],
    );
    const actions: string[] = log.rows.map((r) => r.action);
    // The agent keeps working while the question is open, so its assumption and the person's answer can come in either order.
    const at = (a: string) => actions.indexOf(a);
    const middle = ['interaction.answered', 'assumption.declared'].map(at);
    const ordered =
      at('run.created') >= 0 &&
      at('run.created') < at('interaction.raised') &&
      middle.every((p) => p > at('interaction.raised') && p < at('pull_request.opened')) &&
      at('pull_request.opened') < at('interaction.approved') &&
      at('interaction.approved') < at('pull_request.merged');
    check(ordered, `8  the activity log shows every step in order: ${actions.join(' > ')}`);
  }

  // ---------------- Phase B: kill the runner while a question is open, answer later ----------------
  if (phase === 'resume' || phase === 'both' || phase === 'all') {
    say('--- phase B: kill the runner mid-question, answer later, resume ---');
    const task =
      `Create the file docs/greeting-${stamp}.md. Its content must be the greeting that a person chooses. ` +
      `Before writing anything, call ask_human with blocking set to true, question "Which greeting should docs/greeting-${stamp}.md contain?", ` +
      `options [{id:"hello",label:"Hello"},{id:"howdy",label:"Howdy"}], recommendation "hello", topicKey "greeting-${stamp}". ` +
      `Wait for the answer, then write the file with exactly the chosen greeting word and commit. Remember the codename ZEBRA-${stamp} and mention it in your final summary.`;
    const { run } = await startRun(`Greeting ${stamp}`, task, 'guided');

    const q = await waitFor(
      'the blocking question',
      () => openFor(bob, run.id, ['question', 'decision']),
      240_000,
    );
    say(`question open: "${q.title}". Killing the runner...`);
    await sleep(1500);
    const killed = await killRunners();
    check(killed > 0, `9  killed ${killed} runner process(es) while the question was open`);

    const parked = await waitFor(
      'the run parks',
      async () => {
        const r = await runState(run.id);
        return r.state === 'parked' ? r : null;
      },
      60_000,
      1000,
    );
    check(
      parked.state === 'parked' && parked.parkReason === q.id,
      '9  the run is parked on the open question, not failed',
    );
    if (docker) {
      const kept = (
        await exec('docker', ['volume', 'ls', '-q', '--filter', `name=sdlc-work-${run.id}`])
      ).stdout.trim();
      check(
        kept === `sdlc-work-${run.id}`,
        'D  the sandbox checkout volume survived the kill, so the resume finds the same files',
      );
    }

    say('...time passes. Bob answers "howdy".');
    await sleep(4000);
    await call(bob, 'POST', `/api/interactions/${q.id}/answer`, { answer: 'howdy' });

    const done = await waitFor(
      'the run resumes and finishes',
      async () => {
        const r = await runState(run.id);
        if (['failed', 'cancelled', 'budget_exceeded', 'timed_out'].includes(r.state)) {
          await dumpRun(run.id);
          throw new Error(`run ended as ${r.state}`);
        }
        return r.state === 'succeeded' ? r : null;
      },
      420_000,
      3000,
    );
    const ev = await events(run.id);
    const starts = ev.filter((e) => e.type === 'engine.started');
    check(
      starts.length >= 2,
      `9  the engine started ${starts.length} times for one run (a resume)`,
    );
    check(
      starts.length >= 2 && starts[0].payload.sessionId === starts[1].payload.sessionId,
      `9  both starts used the same session (${String(starts[0]?.payload.sessionId).slice(0, 8)}), so context was kept`,
    );
    const summary = ev.filter((e) => e.type === 'run.summary').at(-1)?.payload.text ?? '';
    check(
      summary.includes(`ZEBRA-${stamp}`),
      `9  after the resume the agent still remembered the codename from before the kill ("${summary.slice(0, 90).replace(/\s+/g, ' ')}...")`,
    );

    const review = await waitFor(
      'the review request',
      () => openFor(bob, run.id, ['review']),
      60_000,
    );
    const diffPaths: string[] = review.contextCard.diff.changedPaths;
    check(
      diffPaths.length === 1 && diffPaths[0] === `docs/greeting-${stamp}.md`,
      `9  the change is only docs/greeting-${stamp}.md`,
    );
    check(
      review.contextCard.preApprovedType === 'docs-only',
      '9  recognised as a pre-approved documentation-only change type',
    );
    await call(bob, 'POST', `/api/interactions/${review.id}/answer`, {
      decision: 'approved',
      answer: 'Fine.',
    });
    const merged = await waitFor(
      'the Gate merges',
      async () => {
        const row = await db.query(
          "select context_card -> 'gate' as gate from interaction where id = $1",
          [review.id],
        );
        const gate = row.rows[0]?.gate;
        if (gate && !['waiting_ci', 'merged'].includes(gate.state))
          throw new Error(`gate ended as ${gate.state}: ${gate.detail}`);
        return gate?.state === 'merged' ? gate : null;
      },
      300_000,
      4000,
    );
    check(Boolean(merged.mergedSha), '9  merged by the Gate');
    if (ghToken) {
      const file = await gh(`/repos/${REPO}/contents/docs/greeting-${stamp}.md?ref=main`);
      const text = Buffer.from(file.content, 'base64').toString();
      check(
        /howdy/i.test(text),
        `9  the file contains the person's answer: ${JSON.stringify(text.trim())}`,
      );
    }
    say(`run cost $${done.costUsd.toFixed(4)}`);
  }

  // ---------------- Phase C: a standing decision answers the agent, and nobody is asked ----------------
  if (phase === 'standing' || phase === 'all') {
    say('--- phase C: a standing decision stops a repeated question ---');
    const topic = `closing-${stamp}`;
    const made = await call(bob, 'POST', '/api/standing-decisions', {
      scope: 'global',
      topic,
      text: 'Namaste',
    });
    check(Boolean(made?.id), `S  Bob saved a standing decision for the topic "${topic}"`);

    const task =
      `Create the file docs/closing-${stamp}.md. Its content must be the closing word the team has settled on. ` +
      `Before writing anything, call ask_human with blocking set to true, question "Which closing word should docs/closing-${stamp}.md contain?", ` +
      `options [{id:"goodbye",label:"Goodbye"},{id:"cheers",label:"Cheers"}], recommendation "goodbye", topicKey "${topic}". ` +
      `Do not search standing decisions yourself: the platform checks them when you ask. If the answer comes from a standing decision, use its text exactly. Write the file with only that word and commit.`;
    const { run } = await startRun(`Closing ${stamp}`, task, 'guided');

    const finished = await waitFor(
      'the run finishes without anyone being asked',
      async () => {
        const r = await runState(run.id);
        if (['failed', 'cancelled', 'budget_exceeded', 'timed_out'].includes(r.state)) {
          await dumpRun(run.id);
          throw new Error(`run ended as ${r.state}`);
        }
        const open = await openFor(bob, run.id, ['question', 'decision']);
        if (open) throw new Error(`the agent asked a person: "${open.title}"`);
        return r.state === 'succeeded' ? r : null;
      },
      420_000,
      3000,
    );
    check(finished.state === 'succeeded', `S  the run succeeded without a person answering`);

    const asked = await db.query(
      "select id, state, answered_via, answered_by, answer from interaction where run_id = $1 and type in ('question','decision')",
      [run.id],
    );
    check(
      asked.rows.length === 1 &&
        asked.rows[0].state === 'answered' &&
        asked.rows[0].answered_via === 'standing' &&
        asked.rows[0].answered_by === null,
      `S  the agent's question was answered by the standing decision, not a person (${asked.rows[0]?.answered_via})`,
    );
    const notified = await db.query(
      'select count(*)::int as n from notification where interaction_id = $1',
      [asked.rows[0]?.id],
    );
    check(notified.rows[0].n === 0, 'S  nobody was notified about it');
    const log = await db.query(
      "select action from activity_event where interaction_id = $1 and action = 'interaction.answered_by_standing_decision'",
      [asked.rows[0]?.id],
    );
    check(log.rows.length === 1, 'S  the activity log says a standing decision answered it');

    const review = await waitFor(
      'the review request',
      () => openFor(bob, run.id, ['review']),
      60_000,
    );
    const paths: string[] = review.contextCard.diff.changedPaths;
    check(
      paths.length === 1 && paths[0] === `docs/closing-${stamp}.md`,
      `S  the change is only docs/closing-${stamp}.md`,
    );
    await call(bob, 'POST', `/api/interactions/${review.id}/answer`, {
      decision: 'approved',
      answer: 'Fine.',
    });
    await waitFor(
      'the Gate merges',
      async () => {
        const row = await db.query(
          "select context_card -> 'gate' as gate from interaction where id = $1",
          [review.id],
        );
        const gate = row.rows[0]?.gate;
        if (gate && !['waiting_ci', 'merged'].includes(gate.state))
          throw new Error(`gate ended as ${gate.state}: ${gate.detail}`);
        return gate?.state === 'merged' ? gate : null;
      },
      300_000,
      4000,
    );
    if (ghToken) {
      const file = await gh(`/repos/${REPO}/contents/docs/closing-${stamp}.md?ref=main`);
      const text = Buffer.from(file.content, 'base64').toString();
      check(
        /namaste/i.test(text) && !/goodbye|cheers/i.test(text),
        `S  the file holds the standing decision's text: ${JSON.stringify(text.trim())}`,
      );
    }
    const metrics = await call(bob, 'GET', '/api/metrics/interruptions?days=7');
    check(
      metrics.avoidedByStanding >= 1,
      `S  the interruption metrics count it as an ask that never reached a person (${metrics.avoidedByStanding})`,
    );
    say(`run cost $${finished.costUsd.toFixed(4)}`);
  }

  // ---------------- Phase D: pre-approved change types merge by rule, and guided mode holds them ----------------
  if (phase === 'autopilot' || phase === 'all') {
    say('--- phase D: a pre-approved change merges by rule; guided mode holds the same change ---');
    const docTask = (file: string, text: string) =>
      `Create the file ${file} containing exactly the single line "${text}" and commit it. Do not change anything else and do not ask any questions.`;

    // D1. Balanced mode (the default): a documentation-only change is approved by the platform's rules.
    const file1 = `docs/auto-${stamp}.md`;
    const first = await startRun(`Automatic ${stamp}`, docTask(file1, `automatic ${stamp}`));
    await waitFor(
      'the run finishes',
      async () => {
        const r = await runState(first.run.id);
        if (['failed', 'cancelled', 'budget_exceeded', 'timed_out'].includes(r.state))
          throw new Error(`run ended as ${r.state}`);
        return r.state === 'succeeded' ? r : null;
      },
      420_000,
      3000,
    );
    const rev1 = await waitFor(
      'the review is settled by rule',
      async () => {
        const r = await db.query(
          "select id, state, answered_via, answered_by, answer, context_card from interaction where run_id = $1 and type = 'review'",
          [first.run.id],
        );
        return r.rows[0]?.state === 'answered' ? r.rows[0] : null;
      },
      60_000,
      2000,
    );
    check(
      rev1.answered_via === 'auto' &&
        rev1.answered_by === null &&
        rev1.answer.source === 'policy' &&
        rev1.answer.rule === 'docs-only',
      `A  no person was asked: approved by the rule "${rev1.answer.rule}" (${rev1.context_card.autoMerge.reason})`,
    );
    const merged1 = await waitFor(
      'the Gate merges it',
      async () => {
        const row = await db.query(
          "select context_card -> 'gate' as gate from interaction where id = $1",
          [rev1.id],
        );
        const gate = row.rows[0]?.gate;
        if (gate && !['waiting_ci', 'merged'].includes(gate.state))
          throw new Error(`gate ended as ${gate.state}: ${gate.detail}`);
        return gate?.state === 'merged' ? gate : null;
      },
      300_000,
      4000,
    );
    check(Boolean(merged1.mergedSha), 'A  the Gate merged it once the checks were green');
    if (ghToken) {
      const pr = await gh(`/repos/${REPO}/pulls/${rev1.context_card.prNumber}`);
      const reviews: any[] = await gh(`/repos/${REPO}/pulls/${rev1.context_card.prNumber}/reviews`);
      check(
        pr.merged === true && reviews.some((r) => /not by a person/.test(r.body ?? '')),
        'A  GitHub shows it merged, and the approval says it was by rule and not by a person',
      );
    }
    const events1 = await db.query(
      'select action from activity_event where interaction_id = $1 order by ts',
      [rev1.id],
    );
    check(
      events1.rows.some((r) => r.action === 'pull_request.auto_approved') &&
        events1.rows.some((r) => r.action === 'pull_request.merged'),
      'A  the activity log records the approval by rule and the merge',
    );

    // D2. Guided mode: the same kind of change waits for a person.
    const guidedInit = await call(alice, 'POST', '/api/initiatives', {
      title: `Guided ${stamp}`,
      goal: `Guided ${stamp}`,
      repositoryId: repo.id,
      // These phases start every run themselves.
      autoStages: false,
      autonomyMode: 'guided',
    });
    const file2 = `docs/guided-${stamp}.md`;
    const second = await call(alice, 'POST', `/api/initiatives/${guidedInit.id}/runs`, {
      task: docTask(file2, `guided ${stamp}`),
      budgetUsd: 1,
    });
    const held = await waitFor(
      'the review waits for a person',
      () => openFor(bob, second.id, ['review']),
      420_000,
    );
    check(
      held.state === 'open' && held.contextCard.autoMerge?.auto === false,
      `A  guided mode held the same kind of change for a person: "${held.contextCard.autoMerge?.reason}"`,
    );
    const page: any = await call(bob, 'GET', '/api/autopilot');
    check(
      page.recent.some((r: any) => r.interactionId === rev1.id && r.decidedBy === 'rule') &&
        page.recent.some((r: any) => r.interactionId === held.id && r.decidedBy === 'waiting'),
      'A  the Autopilot page lists both, with the reason',
    );
    await call(bob, 'POST', `/api/interactions/${held.id}/answer`, {
      decision: 'approved',
      answer: 'Fine.',
    });
    await waitFor(
      'the Gate merges the held change',
      async () => {
        const row = await db.query(
          "select context_card -> 'gate' as gate from interaction where id = $1",
          [held.id],
        );
        const gate = row.rows[0]?.gate;
        if (gate && !['waiting_ci', 'merged'].includes(gate.state))
          throw new Error(`gate ended as ${gate.state}: ${gate.detail}`);
        return gate?.state === 'merged' ? gate : null;
      },
      300_000,
      4000,
    );
    check(true, 'A  after a person approved, the Gate merged the held change');
  }

  // ---------------- Phase E: a spec is decided by a person even in autopilot, then a release is approved and published ----------------
  if (phase === 'release' || phase === 'all') {
    say('--- phase E: spec checkpoint (G1), map, and release (G6) ---');
    const init = await call(alice, 'POST', '/api/initiatives', {
      title: `Version endpoint ${stamp}`,
      goal: 'Let operators see which version is running.',
      repositoryId: repo.id,
      // These phases start every run themselves.
      autoStages: false,
      autonomyMode: 'autopilot',
    });
    const slug = `version-${stamp}`;
    // Bob starts the run, so Alice (a Product Owner) may decide on it.
    const specRun = await call(bob, 'POST', `/api/initiatives/${init.id}/runs`, {
      role: 'product',
      budgetUsd: 1,
      task:
        `Draft the spec for this goal: add a GET /version endpoint to the small web app in this repository that answers {"version": <the version in package.json>}. ` +
        `Write it to docs/spec/${slug}.md following your instructions, with at most 3 stories. Do not ask any questions. Commit it and do not change any other file.`,
    });
    const g1 = await waitFor(
      'the spec review',
      () => openFor(alice, specRun.id, ['review']),
      420_000,
    );
    check(
      g1.contextCard.kind === 'pull_request' &&
        g1.state === 'open' &&
        g1.contextCard.autoMerge?.auto === false,
      `G  the spec was NOT approved by rule although the initiative is in autopilot: "${g1.contextCard.autoMerge?.reason}"`,
    );
    const g1row = await db.query(
      'select checkpoint_id, role_needed from interaction where id = $1',
      [g1.id],
    );
    check(
      g1row.rows[0].checkpoint_id === 'G1' && g1row.rows[0].role_needed === 'product_owner',
      'G  it is checkpoint G1, for the Product Owner',
    );
    check(
      /docs\/spec\/.+\.md$/.test(g1.contextCard.diff.changedPaths[0]) &&
        g1.contextCard.diff.changedPaths.length === 1,
      `G  the change is only the spec file (${g1.contextCard.diff.changedPaths.join(', ')})`,
    );
    let map: any = await call(bob, 'GET', `/api/initiatives/${init.id}/map`);
    const spec = map.stages.find((s: any) => s.id === 'spec');
    check(
      spec.status === 'waiting_human' && spec.waitingOn.includes('product_owner'),
      `G  the map shows spec and design waiting on the Product Owner (${spec.status})`,
    );

    await call(alice, 'POST', `/api/interactions/${g1.id}/answer`, {
      decision: 'approved',
      answer: 'Good enough.',
    });
    await waitFor(
      'the Gate merges the spec',
      async () => {
        const row = await db.query(
          "select context_card -> 'gate' as gate from interaction where id = $1",
          [g1.id],
        );
        const gate = row.rows[0]?.gate;
        if (gate && !['waiting_ci', 'merged'].includes(gate.state))
          throw new Error(`gate ended as ${gate.state}: ${gate.detail}`);
        return gate?.state === 'merged' ? gate : null;
      },
      300_000,
      4000,
    );
    map = await call(bob, 'GET', `/api/initiatives/${init.id}/map`);
    check(
      map.stages.find((s: any) => s.id === 'spec').status === 'done',
      'G  after approval and merge, the map shows spec and design done',
    );

    // G6. Main must be green before a release can be prepared, and CI on the merge commit takes a minute.
    const version = `0.${Math.floor(Date.now() / 1000) % 900000}.0`;
    const prepared = await waitFor(
      'a release can be prepared (main is green)',
      async () => {
        try {
          return await call(alice, 'POST', `/api/initiatives/${init.id}/releases`, { version });
        } catch (e) {
          if (/not_green|is not finished|pending/.test(String(e))) return null;
          throw e;
        }
      },
      300_000,
      6000,
    );
    const rel = await call(alice, 'GET', `/api/interactions/${prepared.interactionId}`);
    check(
      rel.type === 'checkpoint' && rel.checkpointId === 'G6' && rel.hardStop === true,
      `G  release ${version} is checkpoint G6 and a hard stop: "${rel.title}"`,
    );
    check(
      rel.contextCard.notes.includes('spec') || rel.contextCard.prs.length >= 1,
      `G  the notes list what merged: ${rel.contextCard.prs
        .map((p: any) => p.title)
        .join('; ')
        .slice(0, 100)}`,
    );
    map = await call(bob, 'GET', `/api/initiatives/${init.id}/map`);
    check(
      map.stages.find((s: any) => s.id === 'release').status === 'waiting_human',
      'G  the map shows the release waiting for approval',
    );
    if (ghToken) {
      let tagBefore = 0;
      try {
        await gh(`/repos/${REPO}/git/ref/tags/release-${version}`);
        tagBefore = 1;
      } catch {
        tagBefore = 0;
      }
      check(tagBefore === 0, 'G  nothing is published before the approval');
    }
    await call(alice, 'POST', `/api/interactions/${prepared.interactionId}/answer`, {
      decision: 'approved',
      answer: 'Ship it.',
    });
    const published = await waitFor(
      'the release is published',
      async () => {
        const list: any[] = await call(alice, 'GET', `/api/initiatives/${init.id}/releases`);
        const r = list.find((x) => x.version === version);
        if (r && ['failed', 'stale', 'declined'].includes(r.state))
          throw new Error(`release ${r.state}: ${r.detail}`);
        return r?.state === 'released' ? r : null;
      },
      60_000,
      2000,
    );
    check(Boolean(published.url), `G  published by the Gate App: ${published.url}`);
    if (ghToken) {
      const ghRel = await gh(`/repos/${REPO}/releases/tags/release-${version}`);
      check(
        ghRel.name === version && String(ghRel.body).includes(`## ${version}`),
        'G  GitHub has the release with the notes',
      );
      // Leave the scratch repository tidy: the release and its tag were only for this check.
      const ghDelete = async (p: string) =>
        fetch(`https://api.github.com${p}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${ghToken}`, 'user-agent': 'sdlc-accept' },
        });
      await ghDelete(`/repos/${REPO}/releases/${ghRel.id}`);
      await ghDelete(`/repos/${REPO}/git/refs/tags/release-${version}`);
    }
    map = await call(bob, 'GET', `/api/initiatives/${init.id}/map`);
    check(
      map.stages.find((s: any) => s.id === 'release').status === 'done',
      'G  the map shows the release done',
    );
  }

  // ---------------- Compare: one realistic task, measured and never merged ----------------
  if (phase === 'compare') {
    say(`--- compare: one realistic task with ${engine ?? 'the default engine'} ---`);
    const task =
      'Add a bookmarks API to this small web app. Keep the storage in memory, in a new file src/bookmarks.js, and wire the routes into src/server.js. ' +
      'POST /bookmarks takes JSON {url, title}. The url must be an absolute http or https URL, and the title must be a non-empty string of at most 100 characters. A bad request answers 400 with {"error": "<reason>"}. A good one answers 201 with the stored bookmark {id, url, title}. ' +
      'GET /bookmarks lists them. GET /bookmarks/:id answers 404 with {"error": "not found"} when the id does not exist. DELETE /bookmarks/:id answers 204, or 404 when it does not exist. ' +
      'Add tests under test/ that cover validation, creation, listing, lookup, deletion and both 404 cases. Commit your work. Do not ask any questions.';
    const { run } = await startRun(`Bookmarks ${stamp}`, task, 'guided');
    const ended = await waitFor(
      'the run ends',
      async () => {
        const r = await runState(run.id);
        return ['succeeded', 'failed', 'cancelled', 'budget_exceeded', 'timed_out'].includes(
          r.state,
        )
          ? r
          : null;
      },
      900_000,
      3000,
    );
    const ev = await events(run.id);
    const count = (type: string) => ev.filter((e) => e.type === type).length;
    const usage = (
      await db.query(
        'select count(*)::int calls, coalesce(sum(input_tokens),0)::int tin, coalesce(sum(output_tokens),0)::int tout, coalesce(sum(cost_micros),0)::int cost from cost_record where run_id = $1',
        [run.id],
      )
    ).rows[0];
    const row = (
      await db.query(
        'select extract(epoch from (finished_at - started_at))::int seconds, branch, pr_number from agent_run where id = $1',
        [run.id],
      )
    ).rows[0];
    const verifies = ev.filter((e) => e.type === 'verify.finished').map((e) => e.payload.ok);
    say(
      `RESULT engine=${engine ?? 'claude-code'} state=${ended.state} seconds=${row.seconds} model_calls=${usage.calls} tokens_in=${usage.tin} tokens_out=${usage.tout} cost_usd=${(usage.cost / 1e6).toFixed(4)} tool_calls=${count('tool.call')} verify=${JSON.stringify(verifies)} pr=${row.pr_number}`,
    );
    check(ended.state === 'succeeded', 'C  the run succeeded');
    if (row.pr_number && ghToken) {
      const auth = { authorization: `Bearer ${ghToken}`, 'user-agent': 'sdlc-accept' };
      const diff = await fetch(`https://api.github.com/repos/${REPO}/pulls/${row.pr_number}`, {
        headers: { ...auth, accept: 'application/vnd.github.v3.diff' },
      }).then((r) => r.text());
      const file = path.join(os.tmpdir(), `compare-${engine ?? 'claude-code'}.diff`);
      await writeFile(file, diff);
      say(`the pull request diff is in ${file} (${diff.split('\n').length} lines)`);
      // Leave the scratch repository tidy: nothing from this comparison is merged.
      await fetch(`https://api.github.com/repos/${REPO}/pulls/${row.pr_number}`, {
        method: 'PATCH',
        headers: auth,
        body: JSON.stringify({ state: 'closed' }),
      });
      await fetch(`https://api.github.com/repos/${REPO}/git/refs/heads/${row.branch}`, {
        method: 'DELETE',
        headers: auth,
      });
    }
  }

  // ---------------- Design: the Architect agent designs an approved spec, and only an Architect decides it ----------------
  if (phase === 'design') {
    say(
      '--- design: the Architect agent turns a spec into a design and a task list (checkpoint G1) ---',
    );
    if (!ghToken)
      throw new Error('GH_TOKEN is needed to read the spec from the scratch repository');
    const cara = await signInAs(stack.publicUrl, 'dev-cara'); // Architect
    const specs: any[] = await gh(`/repos/${REPO}/contents/docs/spec`);
    const specFile: string = specs
      .map((s) => s.name as string)
      .sort()
      .at(-1)!;
    const slug = specFile.replace(/\.md$/, '');
    const specText = Buffer.from(
      (await gh(`/repos/${REPO}/contents/docs/spec/${specFile}`)).content,
      'base64',
    ).toString('utf8');
    const stories = [...new Set(specText.match(/US-\d+/g) ?? [])];
    say(`designing docs/spec/${specFile} (${stories.join(', ')})`);

    const init = await call(alice, 'POST', '/api/initiatives', {
      title: `Design ${stamp}`,
      goal: `Design the ${slug} spec.`,
      repositoryId: repo.id,
      // These phases start every run themselves.
      autoStages: false,
      autonomyMode: 'autopilot',
    });
    const run = await call(bob, 'POST', `/api/initiatives/${init.id}/runs`, {
      role: 'architect',
      budgetUsd: 1.5,
      task:
        `Design the approved spec docs/spec/${specFile}. Write the design to docs/design/${slug}.md following your instructions. ` +
        `Do not ask any questions. Commit it and do not change any other file.`,
    });
    const g1 = await waitFor('the design review', () => openFor(cara, run.id, ['review']), 600_000);
    const row = await db.query('select checkpoint_id, role_needed from interaction where id = $1', [
      g1.id,
    ]);
    check(
      row.rows[0].checkpoint_id === 'G1' && row.rows[0].role_needed === 'architect',
      'D  the design is checkpoint G1, for the Architect',
    );
    check(
      g1.contextCard.autoMerge?.auto === false,
      `D  it was NOT approved by rule although the initiative is in autopilot: "${g1.contextCard.autoMerge?.reason}"`,
    );
    check(
      g1.contextCard.diff.changedPaths.length === 1 &&
        g1.contextCard.diff.changedPaths[0] === `docs/design/${slug}.md`,
      `D  the change is only docs/design/${slug}.md (${g1.contextCard.diff.changedPaths.join(', ')})`,
    );
    let blocked = false;
    try {
      await call(bob, 'POST', `/api/interactions/${g1.id}/answer`, {
        decision: 'approved',
        answer: 'Not mine to decide.',
      });
    } catch (e) {
      blocked = /403/.test(String(e));
    }
    check(blocked, 'D  an engineer cannot decide the design: it needs an Architect');

    const branch: string = (await runState(run.id)).branch;
    const design = Buffer.from(
      (await gh(`/repos/${REPO}/contents/docs/design/${slug}.md?ref=${encodeURIComponent(branch)}`))
        .content,
      'base64',
    ).toString('utf8');
    const headings = [...design.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.toLowerCase());
    const wanted = [
      'spec',
      'approach',
      'changes',
      'interfaces',
      'external systems',
      'risks',
      'test strategy',
      'assumptions',
      'open questions',
      'tasks',
    ];
    const missing = wanted.filter((w) => !headings.some((h) => h.includes(w)));
    check(
      missing.length === 0,
      `D  the design has every section (${missing.length ? `missing: ${missing.join(', ')}` : 'all 10'})`,
    );
    const parsed = parseDesignTasks(design);
    check(
      parsed.ok,
      `D  the task list reads and validates (${parsed.ok ? parsed.tasks.length + ' tasks, order ' + parsed.order.join(' > ') : parsed.errors.join('; ')})`,
    );
    if (parsed.ok) {
      const covered = new Set(parsed.tasks.flatMap((t) => t.stories));
      const uncovered = stories.filter((s) => !covered.has(s));
      check(
        uncovered.length === 0,
        `D  every story in the spec is served by a task (${uncovered.length ? `not covered: ${uncovered.join(', ')}` : stories.join(', ')})`,
      );
      say(`tasks: ${parsed.tasks.map((t) => `${t.id} ${t.role} "${t.title}"`).join(' | ')}`);
    }
    const map: any = await call(bob, 'GET', `/api/initiatives/${init.id}/map`);
    const spec = map.stages.find((s: any) => s.id === 'spec');
    check(
      spec.status === 'waiting_human' && spec.waitingOn.includes('architect'),
      `D  the map shows spec and design waiting on the Architect (${spec.status}: ${spec.waitingOn.join(', ')})`,
    );

    await call(cara, 'POST', `/api/interactions/${g1.id}/answer`, {
      decision: 'approved',
      answer: 'Design accepted.',
    });
    const merged = await waitFor(
      'the Gate merges the design',
      async () => {
        const r = await db.query(
          "select context_card -> 'gate' as gate from interaction where id = $1",
          [g1.id],
        );
        const gate = r.rows[0]?.gate;
        if (gate && !['waiting_ci', 'merged'].includes(gate.state))
          throw new Error(`gate ended as ${gate.state}: ${gate.detail}`);
        return gate?.state === 'merged' ? gate : null;
      },
      300_000,
      4000,
    );
    check(
      Boolean(merged.mergedSha),
      'D  after the Architect approved it, the Gate merged the design',
    );
    const cost = await db.query('select cost_micros from agent_run where id = $1', [run.id]);
    say(`the design run cost $${(Number(cost.rows[0].cost_micros) / 1e6).toFixed(4)}`);
  }

  // ---------------- Build: an approved design becomes a plan, and its tasks run in order ----------------
  if (phase === 'build') {
    say(
      '--- build: approving a design starts its tasks in dependency order, with nobody clicking ---',
    );
    const cara = await signInAs(stack.publicUrl, 'dev-cara'); // Architect
    const specs: any[] = await gh(`/repos/${REPO}/contents/docs/spec`);
    const specFile: string = specs
      .map((s) => s.name as string)
      .sort()
      .at(-1)!;
    const path = `ver-${stamp}`;
    const init = await call(alice, 'POST', '/api/initiatives', {
      title: `Build ${stamp}`,
      goal: `Build /${path}.`,
      repositoryId: repo.id,
      // These phases start every run themselves.
      autoStages: false,
      autonomyMode: 'balanced',
    });
    const designRun = await call(bob, 'POST', `/api/initiatives/${init.id}/runs`, {
      role: 'architect',
      budgetUsd: 1.5,
      task:
        `Design the approved spec docs/spec/${specFile}, but use the path /${path} in place of /version everywhere. ` +
        `Write the design to docs/design/${path}.md following your instructions. ` +
        `Make the task list exactly two tasks, both backend_engineer. T1 adds the route to src/server.js with its test in test/server.test.js. ` +
        `T2 depends on T1 and only adds a short section to README.md that documents the route. ` +
        `Do not ask any questions. Commit it and do not change any other file.`,
    });
    const g1 = await waitFor(
      'the design review',
      () => openFor(cara, designRun.id, ['review']),
      600_000,
    );
    await call(cara, 'POST', `/api/interactions/${g1.id}/answer`, {
      decision: 'approved',
      answer: 'Build it.',
    });
    say(
      'the Architect approved the design; waiting for the Gate to merge it and the plan to appear',
    );

    const getPlan = async () =>
      (await call(bob, 'GET', `/api/initiatives/${init.id}/plan`)).plan as any;
    const plan0 = await waitFor(
      'the build plan',
      async () => (await getPlan()) ?? null,
      420_000,
      3000,
    );
    check(
      plan0.tasks.length === 2 && plan0.tasks[1].dependsOn.includes('T1'),
      `B  the merged design became a plan with ${plan0.tasks.length} tasks: ${plan0.tasks.map((t: any) => `${t.key}${t.dependsOn.length ? ' after ' + t.dependsOn.join(',') : ''}`).join('; ')}`,
    );
    check(
      plan0.state === 'active',
      `B  the plan is active in a balanced initiative, with no one clicking (${plan0.state})`,
    );

    // Answer anything an engineer agent asks, with its own recommendation, so the build can go on.
    const answerQuestions = async () => {
      const queue: any[] = await call(bob, 'GET', '/api/interactions');
      for (const q of queue) {
        if (q.initiativeId !== init.id || !['question', 'decision'].includes(q.type)) continue;
        const options = Array.isArray(q.options) ? q.options : [];
        const choice = q.recommendation ?? options[0]?.id;
        if (!choice) continue;
        say(`answering the agent's question "${q.title}" with "${choice}"`);
        await call(bob, 'POST', `/api/interactions/${q.id}/answer`, { answer: choice }).catch(
          () => {},
        );
      }
    };

    const t1 = await waitFor(
      'T1 starts',
      async () => {
        const p = await getPlan();
        return p.tasks[0].runId ? p.tasks[0] : null;
      },
      120_000,
      2000,
    );
    const afterStart = await getPlan();
    check(
      afterStart.tasks[1].state === 'waiting' && afterStart.tasks[1].runId === null,
      'B  T2 waits while T1 is not merged',
    );
    const r1 = await waitFor(
      'the T1 review',
      async () => {
        await answerQuestions();
        return openFor(bob, t1.runId, ['review']);
      },
      600_000,
      4000,
    );
    check(
      r1.title.includes('T1:') || r1.title.includes('Add'),
      `B  T1's pull request is titled from the task: "${r1.title}"`,
    );
    const midway = await getPlan();
    check(
      midway.tasks[0].state === 'review' && midway.tasks[1].state === 'waiting',
      `B  while T1 is in review, T2 still waits (${midway.tasks.map((t: any) => t.key + ':' + t.state).join(' ')})`,
    );
    await call(bob, 'POST', `/api/interactions/${r1.id}/answer`, {
      decision: 'approved',
      answer: 'Good.',
    });

    const t2 = await waitFor(
      'T2 starts after T1 merges',
      async () => {
        const p = await getPlan();
        return p.tasks[1].runId ? p : null;
      },
      420_000,
      3000,
    );
    check(
      t2.tasks[0].state === 'merged',
      `B  T2 started only after T1 was merged by the Gate (${t2.tasks[0].state})`,
    );
    const done = await waitFor(
      'the plan is done',
      async () => {
        await answerQuestions();
        const p = await getPlan();
        if (p.tasks.some((t: any) => t.state === 'failed'))
          throw new Error(
            `a task failed: ${JSON.stringify(p.tasks.map((t: any) => [t.key, t.state, t.detail]))}`,
          );
        return p.state === 'done' ? p : null;
      },
      600_000,
      4000,
    );
    check(
      done.tasks.every((t: any) => t.state === 'merged'),
      `B  every task is merged and the plan is done (${done.tasks.map((t: any) => t.key + ':' + t.state).join(' ')})`,
    );
    const runs = await db.query(
      "select r.sponsor_person_id, p.display_name from agent_run r join person p on p.id = r.sponsor_person_id where r.initiative_id = $1 and r.agent_role = 'backend_engineer'",
      [init.id],
    );
    check(
      runs.rows.length === 2 && runs.rows.every((r: any) => /Okafor/.test(r.display_name)),
      `B  both build runs are sponsored by the person who approved the design (${runs.rows.map((r: any) => r.display_name).join(', ')})`,
    );
    const m: any = await call(bob, 'GET', `/api/initiatives/${init.id}/map`);
    const build = m.stages.find((s: any) => s.id === 'build');
    check(build.status === 'done', `B  the map shows build and review done: "${build.detail}"`);
    const served = await gh(`/repos/${REPO}/contents/src/server.js`);
    check(
      Buffer.from(served.content, 'base64').toString('utf8').includes(`/${path}`),
      `B  main now serves /${path}`,
    );
    const total = await db.query(
      'select coalesce(sum(cost_micros),0) c from agent_run where initiative_id = $1',
      [init.id],
    );
    say(
      `the whole chain (design and two builds) cost $${(Number(total.rows[0].c) / 1e6).toFixed(4)}`,
    );
  }

  // ---------------- Big build: five tasks, three of them in parallel, then one that needs all three, then docs ----------------
  if (phase === 'bigbuild') {
    say('--- bigbuild: a five-task plan with three tasks that can run at the same time ---');
    const cara = await signInAs(stack.publicUrl, 'dev-cara'); // Architect
    const specs: any[] = await gh(`/repos/${REPO}/contents/docs/spec`);
    const specFile: string = specs
      .map((s) => s.name as string)
      .sort()
      .at(-1)!;
    const s = stamp;
    const init = await call(alice, 'POST', '/api/initiatives', {
      title: `Big build ${s}`,
      goal: 'Three small modules, a route that uses them, and a README note.',
      repositoryId: repo.id,
      // These phases start every run themselves.
      autoStages: false,
      autonomyMode: 'balanced',
    });
    const designRun = await call(bob, 'POST', `/api/initiatives/${init.id}/runs`, {
      role: 'architect',
      budgetUsd: 1.5,
      task:
        `Treat docs/spec/${specFile} as background only. Design this work instead, and write the design to docs/design/big-${s}.md following your instructions. ` +
        `The task list is exactly five tasks, all backend_engineer. ` +
        `T1 adds src/greet-${s}.js exporting greet(name), which returns "Hello, <name>!" and "Hello, world!" for an empty name, with a test in test/greet-${s}.test.js (paths: those two files). ` +
        `T2 adds src/slug-${s}.js exporting slugify(text), which lowercases, turns every run of non-alphanumeric characters into one "-", and trims "-" from both ends, with a test in test/slug-${s}.test.js (paths: those two files). ` +
        `T3 adds src/clamp-${s}.js exporting clamp(n, min, max), with a test in test/clamp-${s}.test.js (paths: those two files). ` +
        `T4 depends on T1, T2 and T3: add GET /utils-${s} to src/server.js, answering JSON {"greeting": greet("team"), "slug": slugify("Hello World"), "clamped": clamp(15, 0, 10)}, with a test in test/server.test.js. ` +
        `T5 depends on T4 and only adds a short section to README.md documenting that route. ` +
        `T1, T2 and T3 must have no dependency on each other. Do not ask any questions. Commit it and change no other file.`,
    });
    const g1 = await waitFor(
      'the design review',
      () => openFor(cara, designRun.id, ['review']),
      600_000,
    );
    await call(cara, 'POST', `/api/interactions/${g1.id}/answer`, {
      decision: 'approved',
      answer: 'Build it.',
    });
    const started = Date.now();
    const getPlan = async () =>
      (await call(bob, 'GET', `/api/initiatives/${init.id}/plan`)).plan as any;
    const plan0 = await waitFor(
      'the build plan',
      async () => (await getPlan()) ?? null,
      420_000,
      3000,
    );
    const shape = plan0.tasks.map(
      (t: any) => `${t.key}${t.dependsOn.length ? '<-' + t.dependsOn.join('+') : ''}`,
    );
    say(`the plan: ${shape.join('  ')}`);
    check(
      plan0.tasks.length === 5 &&
        plan0.tasks.filter((t: any) => t.dependsOn.length === 0).length >= 3,
      `P  the design became a plan with five tasks, three of them free to run together (${shape.join(' ')})`,
    );

    const { final, maxRunning, timeline } = await drivePlan(init.id, [g1.id], started);
    let caught = 0;
    caught = (
      await db.query(
        "select count(*)::int n from activity_event where action = 'gate.caught_up' and initiative_id = $1",
        [init.id],
      )
    ).rows[0].n;
    say(`timeline: ${timeline.join(' | ')}`);
    check(final.state === 'done', `P  the plan finished (${final.state})`);
    check(
      final.tasks.every((t: any) => t.state === 'merged'),
      `P  every task merged (${final.tasks.map((t: any) => t.key + ':' + t.state).join(' ')})`,
    );
    check(maxRunning >= 2, `P  tasks ran at the same time (most at once: ${maxRunning})`);
    check(maxRunning <= 4, `P  never more than the limit of 4 at once (${maxRunning})`);
    const times = (key: string, state: string) =>
      Number(timeline.find((l) => l.includes(` ${key}:${state}`))?.split('s ')[0] ?? NaN);
    check(
      times('T4', 'running') >=
        Math.max(times('T1', 'merged'), times('T2', 'merged'), times('T3', 'merged')),
      'P  T4 started only after T1, T2 and T3 were all merged',
    );
    check(
      times('T5', 'running') >= times('T4', 'merged'),
      'P  T5 started only after T4 was merged',
    );
    say(`gate catch-ups during the plan: ${caught}`);
    const served = Buffer.from(
      (await gh(`/repos/${REPO}/contents/src/server.js`)).content,
      'base64',
    ).toString('utf8');
    check(served.includes(`/utils-${s}`), `P  main now serves /utils-${s}`);
    const cost = await db.query(
      'select agent_role, count(*)::int n, coalesce(sum(cost_micros),0)::int c from agent_run where initiative_id = $1 group by agent_role',
      [init.id],
    );
    const total = cost.rows.reduce((a: number, r: any) => a + r.c, 0);
    say(
      `cost: ${cost.rows.map((r: any) => `${r.agent_role} x${r.n} $${(r.c / 1e6).toFixed(3)}`).join(', ')}; total $${(total / 1e6).toFixed(3)}; wall ${Math.round((Date.now() - started) / 1000)}s after approval`,
    );
  }

  // ---------------- Mixed build: a backend task, then a frontend task that uses it ----------------
  if (phase === 'mixedbuild') {
    say('--- mixedbuild: the backend agent builds T1, then the frontend agent builds T2 ---');
    const cara = await signInAs(stack.publicUrl, 'dev-cara'); // Architect
    const specs: any[] = await gh(`/repos/${REPO}/contents/docs/spec`);
    const specFile: string = specs
      .map((x) => x.name as string)
      .sort()
      .at(-1)!;
    const s = stamp;
    const init = await call(alice, 'POST', '/api/initiatives', {
      title: `Mixed build ${s}`,
      goal: 'A small info module and a page that shows it.',
      repositoryId: repo.id,
      // These phases start every run themselves.
      autoStages: false,
      autonomyMode: 'balanced',
    });
    const designRun = await call(bob, 'POST', `/api/initiatives/${init.id}/runs`, {
      role: 'architect',
      budgetUsd: 1.5,
      task:
        `Treat docs/spec/${specFile} as background only. Design this work instead, and write the design to docs/design/mixed-${s}.md following your instructions. ` +
        `The task list is exactly two tasks. ` +
        `T1 (backend_engineer) adds src/info-${s}.js exporting getInfo(), which returns {"name": "sdlc-scratch", "version": <the version in package.json>}, with a test in test/info-${s}.test.js. ` +
        `T2 (frontend_engineer, depends on T1) adds GET /page-${s} to src/server.js. It answers an HTML page (content type text/html; charset=utf-8) that shows the name and version from getInfo(), with a test in test/server.test.js. ` +
        `Do not ask any questions. Commit it and change no other file.`,
    });
    const g1 = await waitFor(
      'the design review',
      () => openFor(cara, designRun.id, ['review']),
      600_000,
    );
    await call(cara, 'POST', `/api/interactions/${g1.id}/answer`, {
      decision: 'approved',
      answer: 'Build it.',
    });
    const started = Date.now();
    const plan0 = await waitFor(
      'the build plan',
      async () => (await call(bob, 'GET', `/api/initiatives/${init.id}/plan`)).plan ?? null,
      420_000,
      3000,
    );
    check(
      plan0.state === 'active' &&
        plan0.tasks.map((t: any) => t.role).join(',') === 'backend_engineer,frontend_engineer',
      `F  the plan has a backend task and a frontend task after it (${plan0.state}: ${plan0.tasks.map((t: any) => t.key + ' ' + t.role).join('; ')})`,
    );
    const { final, timeline } = await drivePlan(init.id, [g1.id], started);
    say(`timeline: ${timeline.join(' | ')}`);
    check(final.state === 'done', `F  the plan finished (${final.state})`);
    const runs = await db.query(
      "select r.agent_role, r.agent_definition_id, r.engine, r.state, r.cost_micros, i.role_needed from agent_run r left join interaction i on i.run_id = r.id and i.type = 'review' where r.initiative_id = $1 and r.agent_role in ('backend_engineer','frontend_engineer') order by r.created_at",
      [init.id],
    );
    check(
      runs.rows.length === 2 &&
        runs.rows[0].agent_definition_id === 'backend-engineer' &&
        runs.rows[1].agent_definition_id === 'frontend-engineer',
      `F  each task ran with its own agent (${runs.rows.map((r: any) => r.agent_definition_id).join(', ')})`,
    );
    check(
      runs.rows[1]?.role_needed === 'frontend_engineer',
      `F  the frontend pull request went to a Frontend Engineer to review (${runs.rows[1]?.role_needed})`,
    );
    const server = Buffer.from(
      (await gh(`/repos/${REPO}/contents/src/server.js`)).content,
      'base64',
    ).toString('utf8');
    check(server.includes(`/page-${s}`), `F  main now serves /page-${s}`);
    // What the Frontend Engineer's prompt asks for, read from the merged page.
    const at = server.indexOf(`/page-${s}`);
    const block = server.slice(at, at + 2500);
    for (const [what, re] of [
      ['a page language', /lang=["']en["']/],
      ['a title', /<title>/],
      ['a main landmark', /<main/],
      ['one h1', /<h1/],
      ['HTML content type', /text\/html/],
    ] as Array<[string, RegExp]>)
      check(re.test(block), `F  the page has ${what}`);
    const test = Buffer.from(
      (await gh(`/repos/${REPO}/contents/test/server.test.js`)).content,
      'base64',
    ).toString('utf8');
    check(test.includes(`/page-${s}`), 'F  and a test for it');
    say(
      `cost: ${runs.rows.map((r: any) => `${r.agent_role} $${(r.cost_micros / 1e6).toFixed(3)}`).join(', ')}`,
    );
  }

  // ---------------- Pipeline: a goal becomes a spec, a design, a plan and merged code, with people deciding at each checkpoint ----------------
  if (phase === 'pipeline') {
    say(
      '--- pipeline: creating the initiative starts the spec, and each approval starts the next step ---',
    );
    const cara = await signInAs(stack.publicUrl, 'dev-cara'); // Architect
    const s = stamp;
    // Bob creates it, so he sponsors the spec run and Alice (a Product Owner) may decide it.
    const init = await call(bob, 'POST', '/api/initiatives', {
      title: `Pipeline ${s}`,
      goal:
        `Add GET /ver-${s} to the small web app in this repository. It answers HTTP 200 with JSON {"version": <the version in package.json>}, and has a test. ` +
        `Keep the spec to at most two stories and the design to at most two tasks, both backend. Do not ask any questions.`,
      repositoryId: repo.id,
      autonomyMode: 'balanced',
      autoStages: true,
    });
    const t0 = Date.now();
    const stages = async () =>
      (await call(bob, 'GET', `/api/initiatives/${init.id}/stages`)) as any[];
    const first = await waitFor(
      'the spec step is started',
      async () => {
        const x = (await stages()).find((y) => y.stage === 'spec');
        return x?.state === 'started' ? x : null;
      },
      60_000,
      2000,
    );
    const specRun = await call(bob, 'GET', `/api/runs/${first.runId}`);
    check(
      specRun.role === 'product' &&
        specRun.sponsorPersonId === (await call(bob, 'GET', '/api/me')).id,
      `S  creating the initiative started the spec run by itself (${specRun.role}, ${Math.round((Date.now() - t0) / 1000)}s, sponsor Bob)`,
    );

    const reviewFor = (jar: CookieJar, role: string) =>
      waitFor(
        `a ${role} review`,
        async () => {
          const q: any[] = await call(jar, 'GET', '/api/interactions');
          return (
            q.find(
              (i) => i.initiativeId === init.id && i.type === 'review' && i.roleNeeded === role,
            ) ?? null
          );
        },
        600_000,
        3000,
      );
    const specReview = await reviewFor(alice, 'product_owner');
    check(
      specReview.checkpointId === 'G1' && specReview.contextCard.autoMerge?.auto === false,
      'S  the spec is checkpoint G1 and waits for a Product Owner',
    );
    check(
      !(await stages()).some((y) => y.stage === 'design'),
      'S  no design has started while the spec is unapproved',
    );
    const approvedAt = Date.now();
    await call(alice, 'POST', `/api/interactions/${specReview.id}/answer`, {
      decision: 'approved',
      answer: 'Good.',
    });

    const designReview = await reviewFor(cara, 'architect');
    const steps = await stages();
    const design = steps.find((y) => y.stage === 'design');
    check(
      design?.state === 'started' && design.title.startsWith('Design:'),
      `S  approving and merging the spec started the design by itself (${design?.title}, ${Math.round((Date.now() - approvedAt) / 1000)}s after approval)`,
    );
    const designRun = await call(bob, 'GET', `/api/runs/${design.runId}`);
    check(
      designRun.role === 'architect' && designRun.task.includes('docs/spec/'),
      'S  and it designs the spec that was approved',
    );
    await call(cara, 'POST', `/api/interactions/${designReview.id}/answer`, {
      decision: 'approved',
      answer: 'Build it.',
    });

    const plan = await waitFor(
      'the build plan',
      async () => (await call(bob, 'GET', `/api/initiatives/${init.id}/plan`)).plan ?? null,
      420_000,
      3000,
    );
    check(
      plan.state === 'active',
      `S  approving the design started the build (${plan.tasks.length} tasks)`,
    );
    const { final, timeline } = await drivePlan(
      init.id,
      [specReview.id, designReview.id],
      Date.now(),
    );
    say(`build timeline: ${timeline.join(' | ')}`);
    check(final.state === 'done', `S  the plan finished (${final.state})`);
    const served = Buffer.from(
      (await gh(`/repos/${REPO}/contents/src/server.js`)).content,
      'base64',
    ).toString('utf8');
    check(served.includes(`/ver-${s}`), `S  main serves /ver-${s}`);
    const cost = await db.query(
      'select agent_role, count(*)::int n, coalesce(sum(cost_micros),0)::int c from agent_run where initiative_id = $1 group by agent_role order by agent_role',
      [init.id],
    );
    say(
      `cost: ${cost.rows.map((r: any) => `${r.agent_role} x${r.n} $${(r.c / 1e6).toFixed(3)}`).join(', ')}; total $${(cost.rows.reduce((a: number, r: any) => a + r.c, 0) / 1e6).toFixed(3)}; wall ${Math.round((Date.now() - t0) / 1000)}s`,
    );
    const clicks = await db.query(
      "select count(*)::int n from activity_event where initiative_id = $1 and action = 'stage.started_by_person'",
      [init.id],
    );
    check(clicks.rows[0].n === 0, 'S  nobody clicked Start on any step');
  }

  // ---------------- Overlap: three parallel tasks that all edit the same file ----------------
  if (phase === 'overlap') {
    // OVERLAP_PATHS=hidden: the design does not say that the tasks share a file, so only the Gate can notice.
    const hidden = process.env.OVERLAP_PATHS === 'hidden';
    say(
      `--- overlap (${hidden ? 'the design hides the shared file' : 'the design declares the shared file'}): three tasks that can run together all add a route to src/server.js ---`,
    );
    const cara = await signInAs(stack.publicUrl, 'dev-cara'); // Architect
    const specs: any[] = await gh(`/repos/${REPO}/contents/docs/spec`);
    const specFile: string = specs
      .map((x) => x.name as string)
      .sort()
      .at(-1)!;
    const s = stamp;
    const init = await call(alice, 'POST', '/api/initiatives', {
      title: `Overlap ${s}`,
      goal: 'Three routes in one file.',
      repositoryId: repo.id,
      // These phases start every run themselves.
      autoStages: false,
      autonomyMode: 'balanced',
    });
    const route = (k: string) => `/${k}-${s}`;
    const designRun = await call(bob, 'POST', `/api/initiatives/${init.id}/runs`, {
      role: 'architect',
      budgetUsd: 1.5,
      task:
        `Treat docs/spec/${specFile} as background only. Design this work instead, and write the design to docs/design/overlap-${s}.md following your instructions. ` +
        `The task list is exactly three tasks, all backend_engineer, with no dependency between them. ` +
        `T1 adds GET ${route('red')} to src/server.js answering JSON {"colour": "red"}, with a test in test/server.test.js. ` +
        `T2 adds GET ${route('green')} to src/server.js answering JSON {"colour": "green"}, with a test in test/server.test.js. ` +
        `T3 adds GET ${route('blue')} to src/server.js answering JSON {"colour": "blue"}, with a test in test/server.test.js. ` +
        (hidden
          ? `Give the tasks different paths, and list no other file for them: T1 has only docs/red-${s}.md, T2 only docs/green-${s}.md, T3 only docs/blue-${s}.md. `
          : `The paths of every task are src/server.js and test/server.test.js. `) +
        `Do not ask any questions. Commit it and change no other file.`,
    });
    const g1 = await waitFor(
      'the design review',
      () => openFor(cara, designRun.id, ['review']),
      600_000,
    );
    await call(cara, 'POST', `/api/interactions/${g1.id}/answer`, {
      decision: 'approved',
      answer: 'Build it.',
    });
    const started = Date.now();
    await waitFor(
      'the build plan',
      async () => (await call(bob, 'GET', `/api/initiatives/${init.id}/plan`)).plan ?? null,
      420_000,
      3000,
    );
    const { final, maxRunning, timeline } = await drivePlan(init.id, [g1.id], started, true);
    say(`timeline: ${timeline.join(' | ')}`);
    say(`most tasks running at once: ${maxRunning}`);
    for (const t of final.tasks)
      say(
        `  ${t.key} ${t.state}${t.attempt > 1 ? ` (attempt ${t.attempt})` : ''}${t.detail ? `: ${t.detail}` : ''}`,
      );
    check(
      final.state === 'done',
      `O  the plan finished without a person stepping in (${final.state})`,
    );
    if (!hidden)
      check(
        maxRunning === 1,
        `O  tasks that declare the same file ran one at a time (most at once: ${maxRunning})`,
      );
    const redone = final.tasks.filter((x: any) => x.attempt > 1).length;
    const conflicts = (
      await db.query(
        "select count(*)::int n from activity_event where action = 'gate.conflict' and initiative_id = $1",
        [init.id],
      )
    ).rows[0].n;
    say(`conflicts the Gate found: ${conflicts}; tasks that were redone: ${redone}`);
    if (hidden)
      check(
        conflicts === redone,
        `O  every conflict led to a redo (${conflicts} conflicts, ${redone} tasks redone)`,
      );
    check(
      final.tasks.every((t: any) => t.state === 'merged'),
      `O  every task merged (${final.tasks.map((t: any) => t.key + ':' + t.state + (t.attempt > 1 ? '#' + t.attempt : '')).join(' ')})`,
    );
    const server = Buffer.from(
      (await gh(`/repos/${REPO}/contents/src/server.js`)).content,
      'base64',
    ).toString('utf8');
    for (const k of ['red', 'green', 'blue'])
      check(server.includes(route(k)), `O  main serves ${route(k)}`);
    const cost = await db.query(
      'select count(*)::int n, coalesce(sum(cost_micros),0)::int c from agent_run where initiative_id = $1 and agent_role = $2',
      [init.id, 'backend_engineer'],
    );
    say(
      `build runs: ${cost.rows[0].n}, cost $${(cost.rows[0].c / 1e6).toFixed(3)}; wall ${Math.round((Date.now() - started) / 1000)}s`,
    );
  }

  // ---------------- Catch-up: two pull requests at once, so one is behind when its turn to merge comes ----------------
  if (phase === 'catchup') {
    say(
      '--- catchup: the second of two pull requests is behind main, and the Gate brings it up to date ---',
    );
    const docTask = (file: string, text: string) =>
      `Create the file ${file} containing exactly the single line "${text}" and commit it. Do not change anything else and do not ask any questions.`;
    const init = await call(alice, 'POST', '/api/initiatives', {
      title: `Catch-up ${stamp}`,
      goal: 'Two changes at once.',
      repositoryId: repo.id,
      // These phases start every run themselves.
      autoStages: false,
      autonomyMode: 'guided',
    });
    const files = [`docs/catch-a-${stamp}.md`, `docs/catch-b-${stamp}.md`];
    const runs = await Promise.all(
      files.map((f, i) =>
        call(alice, 'POST', `/api/initiatives/${init.id}/runs`, {
          task: docTask(f, `catch ${i} ${stamp}`),
          budgetUsd: 1,
        }),
      ),
    );
    const reviews = await Promise.all(
      runs.map((r) =>
        waitFor(`the review of ${r.id}`, () => openFor(bob, r.id, ['review']), 420_000),
      ),
    );
    for (const r of reviews)
      await call(bob, 'POST', `/api/interactions/${r.id}/answer`, {
        decision: 'approved',
        answer: 'Fine.',
      });
    say('both approved at once; waiting for the Gate');
    const gates = await waitFor(
      'both are merged',
      async () => {
        const rows = await Promise.all(
          reviews.map((r) =>
            db.query("select context_card -> 'gate' as gate from interaction where id = $1", [
              r.id,
            ]),
          ),
        );
        const g = rows.map((x) => x.rows[0]?.gate);
        const bad = g.find((x) => x && !['waiting_ci', 'merged'].includes(x.state));
        if (bad) throw new Error(`gate ended as ${bad.state}: ${bad.detail}`);
        return g.every((x) => x?.state === 'merged') ? g : null;
      },
      600_000,
      4000,
    );
    check(
      gates.every((g: any) => g.mergedSha),
      'U  both pull requests were merged by the Gate',
    );
    const caught = await db.query(
      "select count(*)::int n from activity_event where action = 'gate.caught_up' and interaction_id = any($1)",
      [reviews.map((r) => r.id)],
    );
    check(
      caught.rows[0].n >= 1,
      `U  the Gate brought a branch up to date with main (${caught.rows[0].n} time${caught.rows[0].n === 1 ? '' : 's'}) instead of failing`,
    );
    for (const f of files) {
      const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${f}`, {
        headers: { authorization: `Bearer ${ghToken}`, 'user-agent': 'sdlc-accept' },
      });
      check(r.status === 200, `U  main has ${f}`);
    }
  }

  // ---------------- Preview: the review pack shows what the repository's pipeline reported ----------------
  if (phase === 'preview') {
    say(
      '--- preview: a review shows the preview the repository reported, and calls an old one stale ---',
    );
    if (!ghToken)
      throw new Error('GH_TOKEN is needed to report a preview on the scratch repository');
    const file = `docs/preview-${stamp}.md`;
    const { run } = await startRun(
      `Preview ${stamp}`,
      `Create the file ${file} containing exactly the single line "preview ${stamp}" and commit it. Do not change anything else and do not ask any questions.`,
      'guided',
    );
    const review = await waitFor(
      'the review request',
      () => openFor(bob, run.id, ['review']),
      420_000,
    );
    const sha: string = review.contextCard.headSha;
    const prNumber: number = review.contextCard.prNumber;
    const auth = { authorization: `Bearer ${ghToken}`, 'user-agent': 'sdlc-accept' };
    const preview = () => call(bob, 'GET', `/api/interactions/${review.id}/preview`);
    const report = (onSha: string, state: string, url: string) =>
      fetch(`https://api.github.com/repos/${REPO}/statuses/${onSha}`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          state,
          context: 'ci/preview',
          target_url: url,
          description: 'accept',
        }),
      });

    const first = await preview();
    check(
      ['none', 'not_permitted'].includes(first.state),
      `P  before the pipeline reports anything, the review says so (${first.state}: ${first.detail.slice(0, 80)}...)`,
    );

    await report(sha, 'pending', 'https://example.test/building');
    await sleep(16_000); // the answer is cached for 15 seconds
    const building = await preview();
    check(
      building.state === 'building',
      `P  a pending report shows as building (${building.state})`,
    );

    await report(sha, 'success', `https://pr-${prNumber}.preview.example.test`);
    await sleep(16_000);
    const ready = await preview();
    check(
      ready.state === 'ready' &&
        ready.url === `https://pr-${prNumber}.preview.example.test/` &&
        ready.sha === sha,
      `P  a successful report for the current commit shows as ready: ${ready.url} (${ready.source})`,
    );

    // The pull request moves to a new commit: the old preview must not read as current.
    const branch: string = (await gh(`/repos/${REPO}/pulls/${prNumber}`)).head.ref;
    const fileInfo = await gh(`/repos/${REPO}/contents/${file}?ref=${branch}`);
    await fetch(`https://api.github.com/repos/${REPO}/contents/${file}`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({
        message: 'another commit on the branch',
        content: Buffer.from(`preview ${stamp}\nmore\n`).toString('base64'),
        sha: fileInfo.sha,
        branch,
      }),
    });
    await sleep(16_000);
    const moved = await preview();
    check(
      moved.sha !== sha && moved.headSha !== sha && moved.state !== 'ready',
      `P  after a new commit the old preview does not read as ready (${moved.state})`,
    );

    // Leave the scratch repository tidy: nothing from this check is merged.
    await fetch(`https://api.github.com/repos/${REPO}/pulls/${prNumber}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ state: 'closed' }),
    });
    await fetch(`https://api.github.com/repos/${REPO}/git/refs/heads/${branch}`, {
      method: 'DELETE',
      headers: auth,
    });
  }
} catch (e) {
  say(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  checks.push([false, 'the script finished without an error']);
} finally {
  await db.end().catch(() => {});
  await stack.stop();
}

const failed = checks.filter(([ok]) => !ok);
console.log(`\n${checks.length - failed.length} passed, ${failed.length} failed`);
for (const [, what] of failed) console.log(`  FAILED: ${what}`);
process.exit(failed.length === 0 ? 0 : 1);

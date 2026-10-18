/* eslint-disable @typescript-eslint/no-explicit-any */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import type { CookieJar } from './signin.js';
import { signInAs } from './signin.js';
import { startStack } from './stack.js';

// Step 1 acceptance (mvp-contract section 16), live: real Claude Code, real gateway and OpenRouter, real GitHub.
// It spends a few cents and merges a small change into the scratch repository.
//   node --import tsx src/accept.ts [happy|resume|both|standing|all] [docker]
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

const stack = await startStack({
  log: (l) =>
    l.startsWith('[api]')
      ? l.includes('"level":50') && say(l.slice(0, 1500))
      : !l.startsWith('[gateway]') && say(l),
  apiEnv: { BLOCKING_MAX_S: '600', ...(docker ? { RUNNER_ADAPTER: 'docker' } : {}) },
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

  async function startRun(title: string, task: string) {
    const init = await call(alice, 'POST', '/api/initiatives', {
      title,
      goal: title,
      repositoryId: repo.id,
    });
    const run = await call(alice, 'POST', `/api/initiatives/${init.id}/runs`, {
      task,
      budgetUsd: 1,
    });
    say(`run ${run.id} queued (${run.definition}, budget $${run.budgetUsd})`);
    return { init, run };
  }
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
    const { run } = await startRun(`Greeting ${stamp}`, task);

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
    const { run } = await startRun(`Closing ${stamp}`, task);

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

/* eslint-disable @typescript-eslint/no-explicit-any */
// Acceptance against a platform deployed on AWS (infra/aws): the same questions as accept.ts, but nothing runs on this
// machine. Agent runs are Fargate tasks. Needs the deploy's outputs in the environment:
//   SDLC_URL (the CloudFront address), SDLC_USER and SDLC_PASSWORD (a Cognito user with the platform admin role),
//   GH_TOKEN (to look at and tidy the scratch repository), and AWS credentials for the stack's account.
//   node --import tsx src/aws-accept.ts [smoke|resume|pipeline|previewrun|all]
// The pipeline phase runs on whichever engine the stack is set to (terraform apply -var agent_engine=copilot-cli).
// The stack is expected to run with INDEPENDENT_REVIEW=false, since one person plays every part.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { signInCognito } from './cognito.js';
import { CookieJar } from './signin.js';

const exec = promisify(execFile);
const REPO = 'lrama1/sdlc-scratch';
const NAME = process.env.SDLC_STACK ?? 'sdlc-dev';
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const phase = process.argv[2] ?? 'all';
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
  everyMs = 2000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(everyMs);
  }
}

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};
const base = need('SDLC_URL');
const ghToken = need('GH_TOKEN');

async function aws<T = any>(...args: string[]): Promise<T> {
  const { stdout } = await exec('aws', [...args, '--region', REGION, '--output', 'json'], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return (stdout.trim() ? JSON.parse(stdout) : {}) as T;
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

let me: CookieJar;
async function call(method: string, path: string, body?: unknown): Promise<any> {
  const r = await me.fetch(`${base}${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
  let json: any = r.text;
  try {
    json = JSON.parse(r.text);
  } catch {
    // not JSON
  }
  if (r.status >= 400) throw new Error(`${method} ${path} -> ${r.status} ${r.text.slice(0, 300)}`);
  return json;
}

/** The Fargate task that belongs to a run, if one is live (or, with `any`, the latest that ended). */
async function taskFor(runId: string, desired: 'RUNNING' | 'STOPPED' = 'RUNNING') {
  const list = await aws<{ taskArns: string[] }>(
    'ecs',
    'list-tasks',
    '--cluster',
    NAME,
    '--family',
    `${NAME}-runner`,
    '--desired-status',
    desired,
  );
  if (list.taskArns.length === 0) return null;
  const d = await aws<{ tasks: any[] }>(
    'ecs',
    'describe-tasks',
    '--cluster',
    NAME,
    '--tasks',
    ...list.taskArns.slice(0, 100),
    '--include',
    'TAGS',
  );
  return (
    d.tasks.find((t) => t.tags?.some((x: any) => x.key === 'sdlc-run' && x.value === runId)) ?? null
  );
}

const bucket = `${NAME}-runner-state-${need('AWS_ACCOUNT_ID')}`;
const stateObject = async (runId: string) => {
  try {
    await exec('aws', [
      's3api',
      'head-object',
      '--bucket',
      bucket,
      '--key',
      `runs/${runId}/state.tgz`,
      '--region',
      REGION,
    ]);
    return true;
  } catch {
    return false;
  }
};

async function main() {
  me = await signInCognito(base, need('SDLC_USER'), need('SDLC_PASSWORD'));
  const who = await call('GET', '/api/me');
  check(
    who.roles.includes('platform_admin'),
    `1  signed in through Cognito as ${who.email} (${who.roles.join(', ')})`,
  );
  const ready = await call('GET', '/readyz');
  check(ready.status === 'ready', '1  the platform answers and its database is ready');

  const apps = await call('GET', '/api/admin/github');
  check(
    Array.isArray(apps) && apps.every((a: any) => a.registered && a.installationId),
    `1  both GitHub Apps are registered and installed (${(apps as any[]).map((a) => a.slug).join(', ')})`,
  );
  const repos: any[] = await call('GET', '/api/repositories');
  let repo = repos.find((r) => r.fullName === REPO);
  if (!repo)
    repo = await call('POST', '/api/repositories', {
      fullName: REPO,
      protectedPaths: ['.github/workflows/**', 'scripts/**', 'package.json'],
    });
  check(Boolean(repo?.id), `1  ${REPO} is in the registry`);

  async function startRun(title: string, task: string) {
    const init = await call('POST', '/api/initiatives', {
      title,
      goal: title,
      repositoryId: repo.id,
      autoStages: false,
      autonomyMode: 'guided',
    });
    const run = await call('POST', `/api/initiatives/${init.id}/runs`, { task, budgetUsd: 1 });
    say(`run ${run.id} queued (${run.definition})`);
    return { init, run, queuedAt: Date.now() };
  }
  const runState = (id: string) => call('GET', `/api/runs/${id}`);
  const events = (id: string): Promise<any[]> => call('GET', `/api/runs/${id}/events?limit=500`);
  const open = async (runId: string, types: string[]) =>
    ((await call('GET', '/api/interactions')) as any[]).find(
      (i) => i.runId === runId && types.includes(i.type),
    ) ?? null;
  const failed = ['failed', 'cancelled', 'budget_exceeded', 'timed_out'];

  async function approveAndMerge(runId: string, file: string) {
    const review = await waitFor('the review request', () => open(runId, ['review']), 300_000);
    const paths: string[] = review.contextCard.diff.changedPaths;
    check(
      paths.length === 1 && paths[0] === file,
      `3  the pull request changes only ${file} (${paths.join(', ')})`,
    );
    await call('POST', `/api/interactions/${review.id}/answer`, {
      decision: 'approved',
      answer: 'Fine.',
    });
    const merged = await waitFor(
      'the Gate merges',
      async () => {
        const r = await call('GET', `/api/interactions/${review.id}`);
        const g = r?.contextCard?.gate?.state;
        if (g && ['ci_failed', 'failed', 'stale', 'closed', 'timed_out', 'conflict'].includes(g))
          throw new Error(`the Gate stopped: ${g}`);
        return g === 'merged' ? r : null;
      },
      420_000,
      4000,
    );
    check(merged.contextCard.gate.state === 'merged', '3  the Gate merged it after CI passed');
    const onMain = await gh(`/repos/${REPO}/contents/${file}`).then(
      () => true,
      () => false,
    );
    check(onMain, `3  ${file} is on main`);
    return review;
  }

  if (phase === 'smoke' || phase === 'all') {
    say('--- smoke: one agent run, as a Fargate task, to a merged pull request ---');
    const file = `docs/aws-${stamp}.md`;
    const { run, queuedAt } = await startRun(
      `AWS smoke ${stamp}`,
      `Create the file ${file} containing exactly the single line "hello from AWS ${stamp}" and commit it. Do not change anything else and do not ask any questions.`,
    );
    const task = await waitFor('a Fargate task for the run', () => taskFor(run.id), 240_000, 3000);
    say(
      `task ${task.taskArn.split('/').pop()} is ${task.lastStatus}, ${Math.round((Date.now() - queuedAt) / 1000)} s after the run was queued`,
    );
    const eni = task.attachments?.flatMap((a: any) => a.details ?? []) ?? [];
    const subnet = eni.find((d: any) => d.name === 'subnetId')?.value;
    const subnets = await aws<{ Subnets: any[] }>(
      'ec2',
      'describe-subnets',
      '--subnet-ids',
      subnet,
    );
    check(
      subnets.Subnets[0]?.Tags?.some((t: any) => t.Value === `${NAME}-runner`),
      `2  the task runs in the isolated runner subnet (${subnet})`,
    );
    const def = await aws<{ taskDefinition: any }>(
      'ecs',
      'describe-task-definition',
      '--task-definition',
      task.taskDefinitionArn,
    );
    check(!def.taskDefinition.taskRoleArn, '2  the task has no task role, so no AWS credentials');
    check(
      task.launchType === 'FARGATE' && task.cpu === '2048',
      `2  Fargate, ${task.cpu} CPU units, ${task.memory} MB`,
    );

    const review = await approveAndMerge(run.id, file);
    const done = await waitFor(
      'the run finishes',
      async () => {
        const r = await runState(run.id);
        if (failed.includes(r.state)) throw new Error(`run ended as ${r.state} (${r.exitReason})`);
        return r.state === 'succeeded' ? r : null;
      },
      300_000,
      3000,
    );
    check(
      done.state === 'succeeded',
      `3  the run succeeded (${Math.round((Date.now() - queuedAt) / 1000)} s from queued to merged)`,
    );

    const ended = await waitFor(
      'the task stops',
      async () => {
        const t = await taskFor(run.id, 'STOPPED');
        return t?.lastStatus === 'STOPPED' ? t : null;
      },
      120_000,
      3000,
    );
    const exit = ended.containers.find((c: any) => c.name === 'runner')?.exitCode;
    check(exit === 0, `2  the task ended with exit code ${exit}`);
    const taskId = ended.taskArn.split('/').pop();
    const logs = await aws<{ events: Array<{ message: string }> }>(
      'logs',
      'get-log-events',
      '--log-group-name',
      `/${NAME}`,
      '--log-stream-name',
      `runner/runner/${taskId}`,
    );
    const text = logs.events.map((e) => e.message).join('\n');
    check(
      text.includes('this is a fresh run'),
      '2  the runner started fresh and its output is in CloudWatch',
    );
    const costs = await call('GET', `/api/costs?days=1&initiativeId=${review.initiativeId}`);
    check(
      costs.totals.costUsd > 0,
      `3  the model cost was recorded: $${costs.totals.costUsd.toFixed(3)} (${costs.totals.calls} calls)`,
    );
    check(!(await stateObject(run.id)), '3  no saved state is left for a run that never parked');
  }

  if (phase === 'resume' || phase === 'all') {
    say(
      '--- resume: stop the task while a question is open, answer later, resume in a new task ---',
    );
    const file = `docs/greeting-${stamp}.md`;
    const { run } = await startRun(
      `AWS greeting ${stamp}`,
      `Create the file ${file}. Its content must be the greeting that a person chooses. ` +
        `Before writing anything, call ask_human with blocking set to true, question "Which greeting should ${file} contain?", ` +
        `options [{id:"hello",label:"Hello"},{id:"howdy",label:"Howdy"}], recommendation "hello", topicKey "greeting-${stamp}". ` +
        `Wait for the answer, then write the file with exactly the chosen greeting word and commit. Remember the codename ZEBRA-${stamp} and mention it in your final summary.`,
    );
    const q = await waitFor(
      'the blocking question',
      () => open(run.id, ['question', 'decision']),
      360_000,
      3000,
    );
    const first = await taskFor(run.id);
    say(`question open: "${q.title}". Stopping task ${first?.taskArn.split('/').pop()}...`);
    await sleep(3000);
    await aws(
      'ecs',
      'stop-task',
      '--cluster',
      NAME,
      '--task',
      first.taskArn,
      '--reason',
      'acceptance: stop while a question is open',
    );

    const parked = await waitFor(
      'the run parks',
      async () => {
        const r = await runState(run.id);
        return r.state === 'parked' ? r : null;
      },
      240_000,
      3000,
    );
    check(parked.parkReason === q.id, '4  the run is parked on the open question, not failed');
    const saved = await waitFor(
      'the saved state',
      async () => ((await stateObject(run.id)) ? true : null),
      60_000,
      3000,
    ).catch(() => false);
    check(saved === true, "4  the stopped task saved the run's files to S3 before it went");

    say('...time passes. The question is answered with "howdy".');
    await sleep(5000);
    await call('POST', `/api/interactions/${q.id}/answer`, { answer: 'howdy' });
    const second = await waitFor(
      'a second task',
      async () => {
        const t = await taskFor(run.id);
        return t && t.taskArn !== first.taskArn ? t : null;
      },
      240_000,
      3000,
    );
    check(
      second.taskArn !== first.taskArn,
      `4  a new task took over (${second.taskArn.split('/').pop()})`,
    );

    await waitFor(
      'the run resumes and finishes',
      async () => {
        const r = await runState(run.id);
        if (failed.includes(r.state)) throw new Error(`run ended as ${r.state} (${r.exitReason})`);
        return r.state === 'succeeded' ? r : null;
      },
      420_000,
      3000,
    );
    const ev = await events(run.id);
    const starts = ev.filter((e) => e.type === 'engine.started');
    check(
      starts.length >= 2,
      `4  the engine started ${starts.length} times for one run (a resume)`,
    );
    check(
      starts.length >= 2 && starts[0].payload.sessionId === starts[1].payload.sessionId,
      `4  both starts used the same session (${String(starts[0]?.payload.sessionId).slice(0, 8)}), so the conversation came back with the files`,
    );
    const summary = ev.filter((e) => e.type === 'run.summary').at(-1)?.payload.text ?? '';
    check(
      summary.includes(`ZEBRA-${stamp}`),
      `4  the agent still remembered the codename after the new task ("${summary.slice(0, 80).replace(/\s+/g, ' ')}...")`,
    );
    await approveAndMerge(run.id, file);
    const content = Buffer.from(
      (await gh(`/repos/${REPO}/contents/${file}`)).content,
      'base64',
    ).toString('utf8');
    check(
      /howdy/i.test(content) && !/hello/i.test(content),
      `4  the file holds the chosen greeting ("${content.trim()}")`,
    );
    await waitFor(
      'the saved state is removed',
      async () => ((await stateObject(run.id)) ? null : true),
      90_000,
      3000,
    ).then(
      () => check(true, '4  the saved state was deleted once the run was over'),
      () => check(false, '4  the saved state was deleted once the run was over'),
    );
  }

  if (phase === 'pipeline' || phase === 'all') {
    say(
      '--- pipeline: a goal becomes a spec, a design, and three tasks built in parallel by Fargate tasks ---',
    );
    const s = stamp;
    const mods = [
      ['slug', 'slugify(text), which lowercases text and joins its words with dashes'],
      ['clamp', 'clamp(n, min, max), which limits a number to a range'],
      ['pad', 'leftPad(text, width, fill), which pads text on the left to a width'],
    ] as const;
    const init = await call('POST', '/api/initiatives', {
      title: `AWS pipeline ${s}`,
      goal:
        `Add three small independent modules to this repository: ` +
        mods
          .map(
            ([m, d]) => `src/${m}-${s}.js exporting ${d}, with its test in test/${m}-${s}.test.js`,
          )
          .join('; ') +
        `. They share no files and do not depend on each other. Keep the spec to at most three stories. ` +
        `Make the design exactly three tasks T1, T2 and T3, all backend_engineer, with no dependencies, each listing in paths only its own source file and its own test file. Do not ask any questions.`,
      repositoryId: repo.id,
      autonomyMode: 'balanced',
      autoStages: true,
    });
    const started = Date.now();
    const done = new Set<string>();
    const answerOpen = async () => {
      for (const q of (await call('GET', '/api/interactions')) as any[]) {
        if (q.initiativeId !== init.id || done.has(q.id)) continue;
        done.add(q.id);
        if (q.type === 'review') {
          say(`approving "${q.title.slice(0, 70)}" (${q.checkpointId})`);
          await call('POST', `/api/interactions/${q.id}/answer`, {
            decision: 'approved',
            answer: 'Fine.',
          }).catch(() => done.delete(q.id));
        } else {
          const choice =
            q.recommendation ?? (Array.isArray(q.options) ? q.options[0]?.id : undefined);
          say(`answering "${q.title.slice(0, 70)}" with "${choice}"`);
          if (choice)
            await call('POST', `/api/interactions/${q.id}/answer`, { answer: choice }).catch(() =>
              done.delete(q.id),
            );
          else done.delete(q.id);
        }
      }
    };
    let maxTasks = 0;
    let maxRunning = 0;
    const timeline: string[] = [];
    const seen = new Map<string, string>();
    const plan = await waitFor(
      'the plan ends',
      async () => {
        await answerOpen();
        const live = await aws<{ taskArns: string[] }>(
          'ecs',
          'list-tasks',
          '--cluster',
          NAME,
          '--family',
          `${NAME}-runner`,
          '--desired-status',
          'RUNNING',
        );
        maxTasks = Math.max(maxTasks, live.taskArns.length);
        const p = (await call('GET', `/api/initiatives/${init.id}/plan`)).plan as any;
        if (!p) return null;
        maxRunning = Math.max(maxRunning, p.tasks.filter((x: any) => x.state === 'running').length);
        for (const x of p.tasks)
          if (seen.get(x.key) !== x.state) {
            seen.set(x.key, x.state);
            timeline.push(`${Math.round((Date.now() - started) / 1000)}s ${x.key}:${x.state}`);
          }
        if (p.tasks.some((x: any) => x.state === 'failed'))
          throw new Error(
            `a task failed: ${JSON.stringify(p.tasks.map((x: any) => [x.key, x.state, x.detail]))}`,
          );
        return ['done', 'invalid', 'cancelled'].includes(p.state) ? p : null;
      },
      1_500_000,
      4000,
    );
    say(`build timeline: ${timeline.join(' | ')}`);
    check(
      plan.state === 'done',
      `5  the plan finished (${plan.state}, ${plan.tasks.length} tasks)`,
    );
    check(maxRunning >= 2, `5  tasks of the plan ran at the same time (${maxRunning} at once)`);
    check(maxTasks >= 2, `5  and as separate Fargate tasks (${maxTasks} at once)`);
    for (const [m] of mods) {
      const ok = await gh(`/repos/${REPO}/contents/src/${m}-${s}.js`).then(
        () => true,
        () => false,
      );
      const ok2 = await gh(`/repos/${REPO}/contents/test/${m}-${s}.test.js`).then(
        () => true,
        () => false,
      );
      check(ok && ok2, `5  main has src/${m}-${s}.js and its test`);
    }
    const costs = await call('GET', `/api/costs?days=1&initiativeId=${init.id}`);
    say(
      `cost: $${costs.totals.costUsd.toFixed(3)} over ${costs.totals.runs} runs and ${costs.totals.calls} model calls; ${costs.byRole.map((r: any) => `${r.role} x${r.runs} $${r.costUsd.toFixed(3)}`).join(', ')}; wall ${Math.round((Date.now() - started) / 1000)} s`,
    );
    check(costs.totals.costUsd > 0, '5  the cost of every run was recorded');
  }

  if (phase === 'previewrun' || phase === 'all') {
    say(
      '--- previewrun: a reviewer runs the pull request as a Fargate task and opens it from another address ---',
    );
    const s = stamp;
    const { run } = await startRun(
      `AWS preview ${s}`,
      [
        'Create two files and commit them. Do not change anything else and do not ask any questions.',
        '',
        `1. The file preview-${s}.mjs with exactly this content:`,
        '```js',
        "import http from 'node:http';",
        'http.createServer(async (req, res) => {',
        "  if (req.url === '/echo') return res.end(JSON.stringify({ headers: req.headers }));",
        "  if (req.url === '/env') return res.end(JSON.stringify(Object.keys(process.env).filter((k) => /sdlc|token|secret|password|credential|preview_/i.test(k))));",
        "  if (req.url === '/net') {",
        '    const t = async (u) => fetch(u, { signal: AbortSignal.timeout(4000) }).then((r) => "HTTP " + r.status, (e) => "FAIL " + ((e.cause && e.cause.code) || e.name));',
        "    return res.end(JSON.stringify({ internet: await t('https://example.com'), platform: await t('http://api.sdlc-dev.local:8080/healthz') }));",
        '  }',
        `  res.setHeader('set-cookie', 'seen=1; Path=/');`,
        `  res.end('preview ${s}');`,
        '}).listen(Number(process.env.PORT), process.env.HOST);',
        '```',
        '',
        '2. The file .sdlc/preview.yaml with exactly this content:',
        '```yaml',
        `start: node preview-${s}.mjs`,
        'port: 4000',
        '```',
      ].join('\n'),
    );
    const review = await waitFor(
      'the review request',
      () => open(run.id, ['review']),
      420_000,
      3000,
    );
    const before = await call('GET', `/api/interactions/${review.id}/preview`);
    check(
      before.platform.available === true && before.platform.state === 'none',
      `6  the review offers to run it, and nothing runs yet (${before.platform.state})`,
    );

    const t1 = Date.now();
    const started = await call('POST', `/api/interactions/${review.id}/preview/start`, {});
    const ready = await waitFor(
      'the preview is ready',
      async () => {
        const p = await call('GET', `/api/interactions/${review.id}/preview`);
        if (p.platform.state === 'failed') throw new Error(`failed: ${p.platform.detail}`);
        return p.platform.state === 'ready' ? p : null;
      },
      420_000,
      4000,
    );
    check(
      ready.state === 'ready' && ready.source === 'platform',
      `6  the review pack shows it as ready, ${Math.round((Date.now() - t1) / 1000)} s after the click`,
    );
    check(
      ready.url === `${base}/api/previews/${started.id}/open`,
      `6  its link is the platform's door, not the preview's own address (${ready.url})`,
    );

    // The task: where it runs, and what it is.
    const task = await (async () => {
      const list = await aws<{ taskArns: string[] }>(
        'ecs',
        'list-tasks',
        '--cluster',
        NAME,
        '--family',
        `${NAME}-preview`,
        '--desired-status',
        'RUNNING',
      );
      const d = await aws<{ tasks: any[] }>(
        'ecs',
        'describe-tasks',
        '--cluster',
        NAME,
        '--tasks',
        ...list.taskArns,
        '--include',
        'TAGS',
      );
      return d.tasks.find((x) =>
        x.tags?.some((g: any) => g.key === 'sdlc-preview' && g.value === started.id),
      );
    })();
    check(Boolean(task), '6  a Fargate task runs the preview');
    const eni = task.attachments
      .flatMap((a: any) => a.details)
      .find((d: any) => d.name === 'networkInterfaceId')?.value;
    const ni = await aws<{ NetworkInterfaces: any[] }>(
      'ec2',
      'describe-network-interfaces',
      '--network-interface-ids',
      eni,
    );
    const groups = ni.NetworkInterfaces[0].Groups.map((g: any) => g.GroupName);
    check(
      groups.length === 1 && groups[0] === `${NAME}-preview`,
      `6  it is in its own security group, not the runs' (${groups.join(', ')})`,
    );
    check(!ni.NetworkInterfaces[0].Association, '6  and has no public address');
    const def = await aws<{ taskDefinition: any }>(
      'ecs',
      'describe-task-definition',
      '--task-definition',
      task.taskDefinitionArn,
    );
    check(!def.taskDefinition.taskRoleArn, '6  with no task role');

    // Opening it: the link goes to another address, and the platform's cookie does not go with it.
    const platformHost = new URL(base).host;
    const door = await me.fetch(ready.url);
    const finalUrl = new URL(door.url);
    check(
      finalUrl.host !== platformHost && finalUrl.pathname === `/${started.id}/`,
      `6  the link ends on a different address (${finalUrl.host}) at the preview's own path`,
    );
    check(
      door.status === 200 && door.text === `preview ${s}`,
      `6  and shows the pull request's own code ("${door.text.slice(0, 40)}")`,
    );
    const origin = finalUrl.origin;
    const stranger = new CookieJar();
    check(
      (await stranger.fetch(`${origin}/${started.id}/`)).status === 401,
      '6  someone without the link is refused',
    );
    check(
      (await stranger.fetch(`${origin}/${started.id}/?t=forged`)).status === 401,
      '6  and so is a made-up link',
    );
    const echo = JSON.parse((await me.fetch(`${origin}/${started.id}/echo`)).text);
    check(
      !JSON.stringify(echo.headers).includes('sdlc_session'),
      "6  the platform's session cookie never reaches the preview",
    );
    check(
      echo.headers['x-forwarded-prefix'] === `/${started.id}`,
      '6  the preview is told its folder',
    );
    check(
      !('x-origin-verify' in echo.headers) && !('x-sdlc-surface' in echo.headers),
      "6  and none of the platform's own headers",
    );
    check(
      (await me.fetch(`${origin}/api/me`)).status === 404,
      "6  the preview address does not serve the platform's API",
    );
    check(
      (await me.fetch(`${base}/${started.id}/`)).status === 404,
      '6  and the platform address does not serve previews',
    );

    // What the previewed code can see and reach.
    const env = JSON.parse((await me.fetch(`${origin}/${started.id}/env`)).text);
    check(
      env.length === 0,
      `6  its environment holds no token, key or address from the platform (${JSON.stringify(env)})`,
    );
    const net = JSON.parse((await me.fetch(`${origin}/${started.id}/net`)).text);
    check(net.internet.startsWith('FAIL'), `6  it cannot reach the internet (${net.internet})`);
    check(net.platform.startsWith('FAIL'), `6  or the platform's API (${net.platform})`);

    // Stopping it.
    await call('POST', `/api/previews/${started.id}/stop`, {});
    const gone = await waitFor(
      'the task stops',
      async () => {
        const t2 = await aws<{ tasks: any[] }>(
          'ecs',
          'describe-tasks',
          '--cluster',
          NAME,
          '--tasks',
          task.taskArn,
        );
        return t2.tasks[0]?.lastStatus === 'STOPPED' ? t2.tasks[0] : null;
      },
      120_000,
      3000,
    );
    check(gone.lastStatus === 'STOPPED', '6  stopping the preview stops its task');
    check(
      (await me.fetch(`${origin}/${started.id}/`)).status === 404,
      '6  and the link no longer opens anything',
    );
    const kept = await exec('aws', [
      's3api',
      'head-object',
      '--bucket',
      bucket,
      '--key',
      `previews/${started.id}/code.tgz`,
      '--region',
      REGION,
    ]).then(
      () => true,
      () => false,
    );
    check(!kept, '6  the copy of the code is deleted');

    await call('POST', `/api/interactions/${review.id}/answer`, {
      decision: 'rejected',
      answer: 'Only a preview check.',
    });
    const pr = review.contextCard.prNumber;
    const branch = (await gh(`/repos/${REPO}/pulls/${pr}`)).head.ref;
    for (const [m, u] of [
      ['PATCH', `/repos/${REPO}/pulls/${pr}`],
      ['DELETE', `/repos/${REPO}/git/refs/heads/${branch}`],
    ] as const)
      await fetch(`https://api.github.com${u}`, {
        method: m,
        headers: { authorization: `Bearer ${ghToken}`, 'user-agent': 'sdlc-accept' },
        body: m === 'PATCH' ? JSON.stringify({ state: 'closed' }) : undefined,
      });
  }
}

try {
  await main();
} catch (e) {
  say(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  checks.push([false, 'the script finished without an error']);
}
const bad = checks.filter(([ok]) => !ok);
say(`\n${checks.length - bad.length} passed, ${bad.length} failed`);
for (const [, w] of bad) say(`  FAILED: ${w}`);
process.exit(bad.length ? 1 : 0);

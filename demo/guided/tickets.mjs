// The two-stage demo: a support ticket tracker on DynamoDB, then a second initiative that adds features to it.
// Run with:  DEMO_WORK=tickets DEMO_SCENES=./tickets.mjs node demo/guided/tickets.mjs <scene ids>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, BASE } from './record.mjs';
import { scenes as base, setTitle, act, pickInitiative, interactions } from './scenes.mjs';

export const TITLE1 = 'Support ticket tracker';
export const TITLE2 = 'Priorities, SLA timers and filters';

export const GOAL1 = [
  'Build a support ticket tracker for a small help desk: a web page plus a JSON API, with all data kept in Amazon DynamoDB.',
  'People and things: support agents work the tickets. A ticket has a title, a description, the requester\u2019s email, a status, an optional assignee and the time it was created. Every ticket has a thread of comments, each with an author and text.',
  'Rules: a ticket moves open, then in_progress, then resolved, then closed. A resolved ticket can be reopened to in_progress, but a closed ticket never changes and takes no more comments. Moving a ticket to in_progress needs an assignee.',
  'What I must be able to do: create a ticket, list tickets filtered by status, open one ticket and read its comments, add a comment, change its status, and assign it.',
  'Data: use one DynamoDB table. Take its name from the TABLE_NAME environment variable and the region from AWS_REGION, with the default AWS credential chain and no keys in code. Use a single-table design: partition key PK and sort key SK, with TICKET#id and META for a ticket and COMMENT# plus a timestamp for its comments, and a global secondary index on status. If the table does not exist when the app starts, create it with on-demand billing and wait until it is ACTIVE before reporting ready. Use the AWS SDK for JavaScript v3. Unit tests must not call AWS, so mock the client.',
  'Keep it plain: Node, one HTML page, at most three tasks.',
].join('\n\n');
export const LINKS1 = [
  'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-general-nosql-design.html',
  'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-gsi.html',
].join('\n');

export const GOAL2 = [
  'Add three things to the support ticket tracker that is already in this repository.',
  'Priority: every ticket gets a priority of low, normal, high or urgent. New tickets default to normal, and a person can change the priority of an open ticket.',
  'SLA timers: each priority has a response deadline counted from when the ticket was created: urgent 1 hour, high 4 hours, normal 24 hours, low 72 hours. A ticket that is not yet in_progress and is past its deadline is marked breached, and the list shows time remaining or breached for each open ticket.',
  'Filters: the list can be filtered by priority, by assignee, and by breached, together with the existing status filter. Use the existing DynamoDB table and its TABLE_NAME setting. Add new attributes to existing items, and old tickets without a priority count as normal.',
  'Keep the existing tests passing and add tests for the new rules. At most three tasks.',
].join('\n\n');

const T1 = () => setNow(TITLE1);
const T2 = () => setNow(TITLE2);
/** The same scene as in the habit tracker demo, run for the given stage. */
const via = (set, id, extra = {}) => ({
  ...base[id],
  ...extra,
  async run(h) {
    set();
    return (extra.run ?? base[id].run)(h);
  },
});

/** A lapse scene that waits until something needs a person. */
const waitFor = (id, title, say, test, ms = 1_500_000) => ({
  url: '/#/map',
  lapse: true,
  title,
  async run(h) {
    const p = h.page;
    h.say(say);
    setTitle(cur());
    await pickInitiative(h);
    await h.waitUntil(id, async () => (await interactions(p)).some((i) => i.initiativeTitle === cur() && test(i)), ms, 5000);
  },
});
const cur = () => TITLE_NOW;
let TITLE_NOW = process.env.DEMO_STAGE === '2' ? TITLE2 : TITLE1;
const setNow = (t) => {
  TITLE_NOW = t;
  setTitle(t);
};
const askFor = (p, text) => p.getByTestId('ask').filter({ hasText: text });
/** Allow the protected preview file, with the reason said aloud. */
const allowProtected = (title, first) => ({
  url: '/#/map',
  title,
  async run(h) {
    const p = h.page;
    await act(
      h,
      first
        ? 'The engineer has stopped, and the map says why. I switch to the Attention queue tab, because a run that is waiting for a person lands there, and this one is blocked until I answer.'
        : 'The engineer has stopped at the protected preview file again. I switch to the Attention queue tab, because that is where it waits for me.',
      () => h.tab('Attention queue', 'An agent is stopped and waiting for me.'),
    );
    const ask = askFor(p, 'Protected path changed');
    await ask.waitFor({ timeout: 30000 });
    await act(
      h,
      first
        ? 'The agent edited a protected path: dot sdlc slash preview dot yaml. Protected paths are files an agent may never change on its own, so the platform stops it. That file tells the platform how to start the app and which smoke checks to run, so it is also what makes the live preview possible. The design asks for it, so I choose Allow.'
        : 'It is the same file, and the design still needs it. I choose Allow again.',
      () => h.click(ask.getByLabel(/Allow this change/), { label: 'Choose: Allow this change', why: 'The design needs this file to start the app.' }),
    );
    await act(h, 'And I click Answer, to send my decision to the agent. It wakes up in a fresh container with my answer and carries on.', () =>
      h.click(ask.getByRole('button', { name: 'Answer' }), { label: 'Answer', why: 'Send the decision to the agent.' }),
    );
    await h.sleep(2500);
  },
});
/** Open a task's pull request, run the security review and the smoke test, and wait for both. */
const checks = (key, title, intro) => ({
  url: '/#/queue',
  title,
  async run(h) {
    const p = h.page;
    const ask = askFor(p, key);
    await ask.waitFor({ timeout: 30000 });
    await act(h, intro, async () => {
      await h.point(ask.getByRole('heading', { level: 3 }), 'The pull request', 'Built by an engineer agent.', 3500);
      await h.scrollBy(450, 5000);
    });
    await act(
      h,
      'I click Run the security review, so a model reads the diff.',
      () => h.click(ask.getByRole('button', { name: 'Run the security review' }), { label: 'Run the security review', why: 'A model reads the diff and reports findings.' }),
    );
    await act(
      h,
      'And I click Run the smoke test, so the platform starts the real app from this pull request, with its own DynamoDB table, and calls it.',
      () => h.click(ask.getByRole('button', { name: 'Run the smoke test' }), { label: 'Run the smoke test', why: 'Start the real app and call it.' }),
    );
    await h.waitUntil(
      'the checks',
      async () => {
        const st = async (id) => (await ask.getByTestId(id).getAttribute('data-state')) ?? 'none';
        const [a, b] = [await st('security'), await st('smoke')];
        console.log('  states', a, b);
        const done = (s) => !['none', 'running', 'pending', 'starting', 'queued', 'unknown'].includes(s);
        return done(a) && done(b);
      },
      900000,
      4000,
    );
    await h.point(ask.getByTestId('smoke'), 'The smoke test', 'The real app, started and called.', 3000);
  },
});

export const scenes = {
  intro: {
    anon: true,
    url: '/',
    title: 'Autonomous SDLC',
    async run(h) {
      const talk = h.say(
        'This is Autonomous SDLC, a platform where AI agents build software and people stay in charge. ' +
          'Agents write the spec, design the solution, build each task in a sandbox, and open pull requests. People decide at clear checkpoints. ' +
          'Everything you see is running live in an AWS account. In this video I build a real app that stores its data in Amazon DynamoDB, in two stages. ' +
          'First the initial app. Then a second initiative that adds features to it. For every click, and every change of tab, I will say what I do and why. ' +
          'And whenever the agents propose a change, the platform runs it as a live, isolated, testable version of the application, so I can try it before I approve it.',
      );
      await h.sleep(3000);
      await h.scrollBy(1500, 14000);
      await talk;
    },
  },
  signin: base.signin,
  home: base.home,
  tour: {
    url: '/',
    title: '3 \u00b7 A quick tour of the tabs',
    async run(h) {
      await h.say('Before I start, a quick tour of the other tabs, because I will use them later. The left menu is the tab bar, and each tab is a different view of the same work.');
      await act(
        h,
        'First, the Portfolio tab. I switch to it because it lists every initiative with its stage and its cost. It is empty, because this is a fresh deployment.',
        () => h.tab('Portfolio', 'See every initiative, its stage and its cost, in one place.'),
      );
      await h.sleep(1500);
      await act(
        h,
        'Next, the Integrations tab. I switch here because this is the register of outside systems agents are allowed to call, each with documentation links that the platform hands to the agents. If an agent needs a system that is not listed, it asks me to approve it. Amazon DynamoDB is not here yet, so we will see that happen.',
        () => h.tab('Integrations', 'The outside systems agents may call, and where their documentation is.'),
      );
      await h.sleep(1500);
      await act(
        h,
        'Then the Costs tab. I switch to it because every agent run spends real money on model calls, and this is where I watch that against a budget. I will check it again at the end.',
        () => h.tab('Costs', 'Spend by day, by agent and by model, against a budget.'),
      );
      await h.sleep(1500);
      await act(
        h,
        'And finally the Map tab. I switch to it because this is where I hand the platform a goal and drive it through each stage.',
        () => h.tab('Map', 'Give the platform a goal and drive it, stage by stage.'),
      );
      await h.sleep(1500);
    },
  },

  newinitiative: {
    url: '/#/map',
    title: '4 \u00b7 Stage 1: give the platform a goal',
    async run(h) {
      T1();
      const form = h.page.locator('form', { hasText: 'New initiative' });
      await act(h, 'At the bottom of the Map tab is the form for a new initiative. An initiative is one goal, with its own spec, design, tasks and cost.', async () => {
        await form.waitFor({ timeout: 30000 });
        await h.scrollBy(2000, 3500);
      });
      await act(h, 'I click the Title box and name it, so I can find this initiative in lists and in the queue.', () =>
        h.type(form.getByLabel('Title'), TITLE1, { label: 'Type a title', why: 'The name I will look for later.' }),
      );
      await act(
        h,
        'The repository is where the agents are allowed to work. Only registered repositories appear. I leave the scratch repository selected.',
        () => h.point(form.getByLabel('Repository'), 'Repository the agents may change', 'Only registered repositories can be picked.', 3200),
      );
      await act(
        h,
        'Then how much runs on its own. I choose Guided, so a person starts every stage, because I want you to see each decision.',
        async () => {
          await h.point(form.getByLabel('How much runs on its own'), 'Autonomy: Guided', 'A person starts and reviews every step.', 1800);
          await form.getByLabel('How much runs on its own').selectOption('guided');
          await h.sleep(1200);
        },
      );
      await act(
        h,
        'Now the goal itself, written the way a product owner would brief a team. It names the people and things involved, the rules of the ticket workflow, what I must be able to do, and how the data is stored: one DynamoDB table, named from an environment variable, created if it is missing.',
        () => h.type(form.getByLabel('Goal'), GOAL1, { label: 'Type the goal', why: 'A real brief, not a one-liner.', delay: 4 }),
      );
      await act(
        h,
        'Then the reference links. This app has to call Amazon DynamoDB, an outside system, so I paste two pages of its documentation. Every agent is told about these links, and the platform fetches them for the agents to read.',
        () => h.type(form.getByLabel('Reference links'), LINKS1, { label: 'Paste the documentation links', why: 'The agents read these before using DynamoDB.', delay: 8 }),
      );
      await act(
        h,
        'I click Create, because that records the goal. In guided mode nothing starts yet.',
        () => h.click(form.getByRole('button', { name: 'Create' }), { label: 'Create', why: 'Record the goal. Nothing starts yet.' }),
      );
      await h.sleep(2500);
    },
  },

  startspec: via(T1, 'startspec'),
  specwait: via(T1, 'specwait'),
  reviewspec: via(T1, 'reviewspec'),
  startdesign: via(T1, 'startdesign'),
  designwait: via(T1, 'designwait'),
  reviewdesign: via(T1, 'reviewdesign'),
  startbuild: via(T1, 'startbuild'),

  buildwait1: waitFor(
    'a decision',
    '12 \u00b7 The agents start, and ask about DynamoDB',
    'The plan has three tasks, one after another: the data layer, the API server, and the web page. The first engineer agent runs in an isolated Fargate container with only this repository checked out. Before it writes any code that talks to DynamoDB, it stops and asks me something. I am speeding up the wait.',
    (i) => i.type === 'decision' && /external system|region/i.test(i.title),
  ),

  integration: {
    url: '/#/map',
    title: '13 \u00b7 A hard stop: a new outside system',
    async run(h) {
      const p = h.page;
      await act(
        h,
        'An agent has stopped. I switch to the Attention queue tab, because that is where anything waiting for a person lands.',
        () => h.tab('Attention queue', 'An agent is stopped and waiting for me.'),
      );
      const ask = askFor(p, 'New external system');
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The agent wants to call Amazon DynamoDB, and it is not in the Integration Register, so the platform will not let it open that connection until a person confirms. This is a hard stop. The card says which host, why, and which documentation the agent is relying on: the two links I gave when I created the initiative.',
        () => h.point(ask.getByRole('heading', { level: 3 }), 'New external system: Amazon DynamoDB', 'Agents may call it only after a person confirms.', 9000),
      );
      await act(
        h,
        'I choose Confirm, because DynamoDB is exactly the data store I asked for. Confirming adds the host to the register and to the sandbox network allow-list, and the documentation links are saved with it.',
        () => h.click(ask.getByRole('radio', { name: /confirm/i }), { label: 'Choose: Confirm', why: 'DynamoDB is the store I asked for.' }),
      );
      await act(h, 'And I click Answer.', () => h.click(ask.getByRole('button', { name: 'Answer' }), { label: 'Answer', why: 'Add DynamoDB to the register.' }));
      await h.sleep(2500);
    },
  },

  t1a: {
    url: '/#/queue',
    title: '15 \u00b7 Review the first task: the data layer',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T1:');
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The first task is done, and its pull request is waiting in the Attention queue, the tab I am already on. The card shows the agent\u2019s own summary: the rules of the ticket workflow, the code that creates the DynamoDB table if it is missing and waits until it is active, and the data layer. Its tests use a fake client, so none of them touches AWS, and the repository\u2019s verify command passed.',
        async () => {
          await h.point(ask.getByRole('heading', { level: 3 }), 'The first task, as a pull request', 'Built by the backend engineer agent.', 4500);
          await h.scrollBy(450, 7000);
        },
      );
      await act(
        h,
        'This diagram shows what stands between the change and the merge: the agent\u2019s own checks, a smoke test, a security review, my decision, repository CI, and then the gate. Only the first step has run.',
        () => h.point(ask.getByTestId('review-flow'), 'What stands between this change and the merge', 'The merge happens only when every step is green.', 7000),
      );
      await act(
        h,
        'Note that this change adds two dependencies, the AWS SDK packages for DynamoDB. The platform flags a new dependency, because a package is code nobody on the team wrote. I click Run the security review, so that a model reads the diff and reports findings. A high or critical finding would block the merge.',
        () => h.click(ask.getByRole('button', { name: 'Run the security review' }), { label: 'Run the security review', why: 'A model reads the diff and reports findings.' }),
      );
      await h.waitUntil(
        'the security review',
        async () => {
          const s = await ask.getByTestId('security').getAttribute('data-state');
          return s && !['none', 'running', 'pending'].includes(s);
        },
        240000,
        1500,
      );
      await h.point(ask.getByTestId('security'), 'The security review', 'Findings by severity. Only high or critical block.', 6000);
    },
  },

  t1b: {
    url: '/#/queue',
    title: '16 \u00b7 A real finding: send it back',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T1:');
      await ask.waitFor({ timeout: 30000 });
      const sec = ask.getByTestId('security');
      await act(
        h,
        'The review is back with one finding, rated medium. It read the data layer and found a real bug: when a ticket collects very many comments, the single query that loads a ticket can run past the one megabyte page limit of DynamoDB, and the ticket itself gets cut off, so it would look as if it did not exist. No injection, nothing high or critical, so this would not block the merge on its own.',
        () => h.point(sec, 'The security review: one medium finding', 'Only high or critical findings block the merge.', 14000),
      );
      await act(
        h,
        'But I do not want to merge a bug I already know about, and the later tasks build on this code. The panel offers three choices: dismiss the finding with a reason, run the review again, or send the findings back to the engineer. I click Send findings back to the engineer, so the same agent fixes it in a fresh container, with the finding as its instructions.',
        () =>
          h.click(sec.getByRole('button', { name: 'Send findings back to the engineer' }), {
            label: 'Send findings back to the engineer',
            why: 'Fix the bug before anything builds on it.',
          }),
      );
      await h.sleep(3500);
    },
  },

  t1wait: waitFor(
    'the T1 review again',
    '17 \u00b7 The engineer fixes it',
    'The engineer starts again from the finding, in a fresh container. It reads the code, fixes the query, adds a test for it, and opens the pull request again. This takes a few minutes, so I am speeding it up.',
    (i) => i.type === 'review' && /T1:/.test(i.title),
  ),

  t1c: {
    url: '/#/queue',
    title: '18 \u00b7 Check the fix',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T1:');
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The new pull request is in the Attention queue, the tab I am on. It is a new commit, so every check starts again from nothing: the earlier review does not count for it. I look at what the agent says it changed.',
        async () => {
          await h.point(ask.getByRole('heading', { level: 3 }), 'The first task, fixed', 'A new commit, so every check starts again.', 3500);
          await h.scrollBy(450, 6000);
        },
      );
      await act(
        h,
        'I click Run the security review again, because the same reader should check its own finding.',
        () => h.click(ask.getByRole('button', { name: 'Run the security review' }), { label: 'Run the security review', why: 'Checks reset on a new commit.' }),
      );
      await h.waitUntil(
        'the security review',
        async () => {
          const s = await ask.getByTestId('security').getAttribute('data-state');
          return s && !['none', 'running', 'pending'].includes(s);
        },
        240000,
        1500,
      );
      await h.point(ask.getByTestId('security'), 'The security review', 'Only high or critical findings block.', 5000);
    },
  },

  t1d: {
    url: '/#/queue',
    title: '19 \u00b7 Approve the first task',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T1:');
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The review is back with no findings. The agent\u2019s summary explains the fix: the ticket is now read with its own request, the comments are read separately, and a ticket can hold at most one hundred of them. It also wrote a test with a hundred and fifty comments that the old code would have failed.',
        () => h.point(ask.getByTestId('security'), 'The security review: no findings', 'The medium finding is fixed.', 9000),
      );
      await act(
        h,
        'This task has no web page or server yet, so there is nothing to run, and the preview panel has nothing to start. The live preview comes with the next tasks. I add a comment for the record.',
        () => h.type(ask.getByLabel('Comment'), 'Good catch by the security review. The comment cap is a sensible limit.', { label: 'Type a comment', why: 'It stays with the decision.', delay: 30 }),
      );
      await act(
        h,
        'Then I click Approve, because the finding is fixed and the code does what the task asked. The gate now waits for the repository checks and merges the pull request. The second task, which was waiting for it, can then start.',
        () => h.click(ask.getByRole('button', { name: 'Approve' }), { label: 'Approve the first task', why: 'The finding is fixed and the code is right.' }),
      );
      await h.sleep(3500);
    },
  },

  t1ci: {
    url: '/#/queue',
    title: '20 \u00b7 The merge stops: the repository\u2019s CI fails',
    async run(h) {
      const p = h.page;
      await act(
        h,
        'I approved, and the gate should have merged. But nothing arrived in my queue, so I switch to the Map tab, because the state of every task is shown there.',
        () => h.tab('Map', 'The state of each task is shown on the map.'),
      );
      setTitle(TITLE1);
      await pickInitiative(h);
      const task = p.getByTestId('task-T1');
      await task.waitFor({ timeout: 30000 });
      await act(
        h,
        'The first task is marked failed, and the reason is not the agent: the merge stopped because the repository\u2019s own check, called verify, failed on GitHub. The platform never merges over a red check. The cause is that the repository\u2019s CI workflow runs the tests but never installs packages, and this is the first change that has any.',
        () => h.point(task, 'Task T1: the merge stopped', 'The repository\u2019s own CI check failed.', 11000),
      );
      await act(
        h,
        'The workflow file is a protected path, so no agent may change it. That fix is mine. I added one line to it by hand, a step that installs the packages before the tests run.',
        () =>
          p.evaluate(() =>
            window.__demo.banner('FIXED BY A PERSON', 'The repository\u2019s CI workflow', 'A step that installs packages before verify runs. Agents may not edit this file.', '#8be35a', 9000),
          ),
      );
      await act(
        h,
        'Now I click Retry, because with a working CI a fresh attempt at the task can be merged. The engineer starts from the corrected main branch.',
        () => h.click(task.getByRole('button', { name: 'Retry' }), { label: 'Retry the first task', why: 'The repository\u2019s CI is fixed.' }),
      );
      await h.sleep(3000);
    },
  },

  t1wait2: waitFor(
    'the T1 review',
    '21 \u00b7 The first task is built again',
    'The engineer starts the first task again in a fresh container, on the corrected main branch. It writes the data layer and its tests, and opens a new pull request. A few minutes, sped up.',
    (i) => i.type === 'review' && /T1:/.test(i.title),
  ),

  t1e: {
    url: '/#/queue',
    title: '22 \u00b7 Review and approve the first task again',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T1:');
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The new pull request is in the Attention queue, the tab I am on. It is a new commit, so the checks start again. I click Run the security review.',
        async () => {
          await h.point(ask.getByRole('heading', { level: 3 }), 'The first task, built again', 'A new commit, so every check starts again.', 3000);
          await h.scrollBy(450, 3000);
          await h.click(ask.getByRole('button', { name: 'Run the security review' }), { label: 'Run the security review', why: 'Checks reset on a new commit.' });
        },
      );
      await h.waitUntil(
        'the security review',
        async () => {
          const s = await ask.getByTestId('security').getAttribute('data-state');
          return s && !['none', 'running', 'pending'].includes(s);
        },
        240000,
        1500,
      );
      const clean = /no findings/i.test(await ask.getByTestId('security').innerText());
      await act(
        h,
        clean
          ? 'The review is back with no findings.'
          : 'The review is back. It has findings, but none is high or critical, so nothing blocks the merge, and they stay on the record.',
        () => h.point(ask.getByTestId('security'), 'The security review', 'Only high or critical findings block.', 6000),
      );
      await act(
        h,
        'I click Approve. This time the repository\u2019s CI installs the packages, so when the gate waits for it, the check should go green and the pull request should merge.',
        async () => {
          await h.type(ask.getByLabel('Comment'), 'Data layer looks right. Approved.', { label: 'Type a comment', why: 'It stays with the decision.', delay: 30 });
          await h.click(ask.getByRole('button', { name: 'Approve' }), { label: 'Approve the first task', why: 'The code is right and the checks are green.' });
        },
      );
      await h.sleep(3500);
    },
  },

  t2wait: waitFor(
    'a protected path',
    '23 \u00b7 The second task starts',
    'The gate waited for the repository\u2019s CI, which is green now, and merged the first task. The second task, the JSON API server, depended on it, so it starts on top of the merged code. Again this is a real agent run, so I am speeding it up.',
    (i) => i.type === 'decision' && /Protected path/.test(i.title),
  ),
  protected1: allowProtected('24 \u00b7 A hard stop: a protected file', true),

  t2a: {
    url: '/#/queue',
    title: '25 \u00b7 Review the second task: the API server',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T2:');
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The second task, the JSON API server, is done, and its pull request is waiting in the Attention queue, the tab I am on. This one has what the first lacked: a server that can run, and the preview file I allowed, which tells the platform how to start it.',
        async () => {
          await h.point(ask.getByRole('heading', { level: 3 }), 'The second task, as a pull request', 'Built by the backend engineer agent.', 4000);
          await h.scrollBy(450, 6000);
        },
      );
      await act(
        h,
        'So this time two more checks can run. First I click Run the security review, so a model reads the diff.',
        () => h.click(ask.getByRole('button', { name: 'Run the security review' }), { label: 'Run the security review', why: 'A model reads the diff and reports findings.' }),
      );
      await act(
        h,
        'Then I click Run the smoke test. The platform starts the real app from this pull request in a fresh container, and calls it with the checks the design listed. It is not a unit test with mocks: it is the server answering requests.',
        () => h.click(ask.getByRole('button', { name: 'Run the smoke test' }), { label: 'Run the smoke test', why: 'Start the real app and call it.' }),
      );
      await h.waitUntil(
        'the checks',
        async () => {
          const st = async (id) => (await ask.getByTestId(id).getAttribute('data-state')) ?? 'none';
          const [a, b] = [await st('security'), await st('smoke')];
          console.log('  states', a, b);
          const done = (s) => !['none', 'running', 'pending', 'starting', 'queued', 'unknown'].includes(s);
          return done(a) && done(b);
        },
        600000,
        4000,
      );
      await h.point(ask.getByTestId('security'), 'The security review', 'Only high or critical findings block.', 2500);
    },
  },

  t2b: {
    url: '/#/queue',
    title: '26 \u00b7 Smoke test, two findings, one dismissed, one sent back',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T2:');
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'Both checks have finished. First the smoke test. It says it could not run: the app stopped at start, because the AWS SDK packages were not installed. The agent\u2019s preview file had no install step, and the platform did not install packages on its own. That is a gap in the platform, not in the agent\u2019s work. This recording found it, so I fixed the platform to install packages by default, and redeployed it while this pull request waited.',
        async () => {
          await h.scrollBy(500, 2500);
          await h.point(ask.getByTestId('smoke'), 'Smoke test: could not run', 'The packages were not installed. A platform gap, now fixed.', 15000);
        },
      );
      const sec = ask.getByTestId('security');
      await act(
        h,
        'Now the security review, which has two medium findings. The first says that every ticket route is open to anyone who can reach the server. That is true, and the review itself says it may be deliberate. This is an internal help desk tool in a demo, and sign-in is not part of the brief, so I accept the risk, and I dismiss the finding with a reason.',
        () => h.point(sec, 'Security review: two medium findings', 'Only high or critical findings block the merge.', 13000),
      );
      await act(
        h,
        'I click Dismiss with a reason, on the first finding.',
        () => h.click(sec.getByRole('button', { name: /Dismiss F1 with a reason/ }), { label: 'Dismiss F1 with a reason', why: 'A risk I accept, on the record.' }),
      );
      await act(
        h,
        'I type the reason. It is saved with the pull request, so anyone reading it later can see who accepted the risk and why.',
        () =>
          h.type(sec.getByLabel('Why F1 is dismissed'), 'Internal tool for this demo. Sign-in is out of scope for this brief and will be a separate initiative.', {
            label: 'Type the reason',
            why: 'It stays with the pull request.',
            delay: 24,
          }),
      );
      await act(
        h,
        'And I click Dismiss to record it.',
        () => h.click(sec.getByRole('button', { name: 'Dismiss', exact: true }), { label: 'Dismiss', why: 'Record the reason.' }),
      );
      await h.sleep(1500);
      await act(
        h,
        'The second finding is different. It is a real bug: a ticket with a great many comments can become unreadable, because one query that loads it can hit the one megabyte page limit of DynamoDB. The first task had the same finding, and this code still has it. That I do not accept, so I click Send findings back to the engineer.',
        () =>
          h.click(sec.getByRole('button', { name: 'Send findings back to the engineer' }), {
            label: 'Send findings back to the engineer',
            why: 'Fix the real bug before the page is built on top of it.',
          }),
      );
      await h.sleep(3500);
    },
  },

  t2wait2: waitFor(
    'the T2 review again',
    '27 \u00b7 The engineer fixes the finding',
    'The engineer starts the second task again in a fresh container, with the finding as its instructions. It fixes how a ticket is loaded, adds a test, and opens a new pull request. A few minutes, sped up.',
    (i) => (i.type === 'review' && /T2:/.test(i.title)) || /Protected path/.test(i.title),
  ),

  protected2: allowProtected('28 \u00b7 The protected file again', false),
  t2wait3: waitFor(
    'the T2 review again',
    '29 \u00b7 The second task is rebuilt',
    'The agent keeps the file, finishes the fix and opens the pull request. A few minutes, sped up.',
    (i) => i.type === 'review' && /T2:/.test(i.title),
  ),

  t2c: {
    url: '/#/queue',
    title: '30 \u00b7 Run every check on the new commit',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T2:');
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The new pull request is in the Attention queue, the tab I am on. It is a new commit, so nothing has run on it yet. I look at what the engineer says it changed.',
        async () => {
          await h.point(ask.getByRole('heading', { level: 3 }), 'The second task, fixed', 'A new commit: every check starts again.', 3000);
          await h.scrollBy(450, 5000);
        },
      );
      await act(
        h,
        'I click Run the security review, because the old review does not apply to a new commit.',
        () => h.click(ask.getByRole('button', { name: 'Run the security review' }), { label: 'Run the security review', why: 'The old review does not apply to a new commit.' }),
      );
      await act(
        h,
        'And I click Run the smoke test, to start the real app again and call it. This time the platform installs the packages itself.',
        () => h.click(ask.getByRole('button', { name: 'Run the smoke test' }), { label: 'Run the smoke test', why: 'Start the real app and call it again.' }),
      );
      await h.waitUntil(
        'the checks',
        async () => {
          const st = async (id) => (await ask.getByTestId(id).getAttribute('data-state')) ?? 'none';
          const [a, b] = [await st('security'), await st('smoke')];
          console.log('  states', a, b);
          const done = (s) => !['none', 'running', 'pending', 'starting', 'queued', 'unknown'].includes(s);
          return done(a) && done(b);
        },
        900000,
        4000,
      );
      await h.point(ask.getByTestId('smoke'), 'The smoke test', 'The real app, started and called.', 3000);
    },
  },

  t2d: {
    url: '/#/queue',
    title: '31 \u00b7 Smoke test results, and an override with a reason',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T2:');
      await ask.waitFor({ timeout: 30000 });
      const smoke = ask.getByTestId('smoke');
      await act(
        h,
        'The checks are back. The smoke test started the real server in a fresh container, with its own DynamoDB table, and three of its four checks passed: the health check, listing tickets from DynamoDB, and the project\u2019s own smoke script. That proves the app starts, creates its table, and talks to DynamoDB. The one failure is the home page, which answers not found.',
        async () => {
          await h.scrollBy(450, 2500);
          await h.point(smoke, 'Smoke test: 3 of 4 passed', 'The real server, with a real DynamoDB table.', 12000);
        },
      );
      await act(
        h,
        'That failure is expected. The home page is the job of the third task, the web page, which does not exist yet, and the design lists it as a check for the finished app. So I do not send this task back. I click Override with a reason, so the decision is on the record.',
        () => h.click(smoke.getByRole('button', { name: 'Override with a reason' }), { label: 'Override with a reason', why: 'The page belongs to the next task.' }),
      );
      await act(
        h,
        'I type the reason. It is saved with the pull request.',
        () =>
          h.type(smoke.getByLabel('Why the smoke test is overridden'), 'The home page is built by task T3. The API checks pass. T3 must pass every check.', {
            label: 'Type the reason',
            why: 'It stays with the pull request.',
            delay: 24,
          }),
      );
      await act(
        h,
        'And I confirm the override.',
        () => h.click(smoke.getByRole('button', { name: 'Override', exact: true }), { label: 'Override', why: 'Record the reason and unblock the approval.' }),
      );
      await h.sleep(2000);
      await act(
        h,
        'The security review shows the same finding as before, that no route requires sign-in, which I accepted, and a low finding about the rate limit. Nothing high or critical, so nothing blocks.',
        () => h.point(ask.getByTestId('security'), 'The security review', 'Only high or critical findings block.', 7000),
      );
    },
  },

  t2e: {
    url: '/#/queue',
    title: '32 \u00b7 A live, isolated version of the API',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T2:');
      await ask.waitFor({ timeout: 30000 });
      const prev = ask.getByTestId('preview');
      await act(
        h,
        'Reading checks is one thing, trying the change is another. The platform can run this pull request as a live, isolated, testable version of the application. It is its own container, on its own network, reachable only by me, and it gets its own DynamoDB table that is deleted when the preview stops, so nothing real is touched. I click Run it.',
        () => h.click(prev.getByRole('button', { name: /Run it (again|here)/ }), { label: 'Run the preview', why: 'A live, isolated copy of this change.' }),
      );
      await h.waitUntil('the preview', async () => (await prev.getAttribute('data-state')) === 'ready', 420000, 2000);
      await h.sleep(1500);
      const href = await prev.getByRole('link').first().getAttribute('href');
      await act(
        h,
        'The preview is running. I open it in its own browser tab, because it is a different web address from the platform, and I want to call the API myself.',
        () => h.browserTab('The preview of the second task', 'A live version of the API, with its own empty DynamoDB table.', href),
      );
      await h.sleep(2500);
      await p.goto(new URL('/api/tickets?status=open', p.url()).toString());
      await act(
        h,
        'This is the list of open tickets, straight from DynamoDB. It is empty, because this preview has a table of its own. Nothing in it came from anywhere else, and nothing I do here will outlive the preview.',
        () => h.sleep(6000),
      );
      await h.backToPlatform('/#/queue', 'The decision is made here, not in the preview.');
    },
  },

  t2f: {
    url: '/#/queue',
    title: '33 \u00b7 Approve the second task',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T2:');
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'Back in the platform tab, the diagram shows every step accounted for: the agent\u2019s checks, the smoke test with my recorded override, and the security review with nothing blocking. I have also used the API in its own live version.',
        () => h.point(ask.getByTestId('review-flow'), 'Every step is accounted for', 'Nothing is blocking my approval.', 8000),
      );
      await act(
        h,
        'I add a comment, and then click Approve, because the API does what the task asked and the finding I cared about is fixed. The gate waits for the repository\u2019s CI and merges, and the third task can start.',
        async () => {
          await h.type(ask.getByLabel('Comment'), 'The API works against DynamoDB. The page comes next.', { label: 'Type a comment', why: 'It stays with the decision.', delay: 28 });
          await h.click(ask.getByRole('button', { name: 'Approve' }), { label: 'Approve the second task', why: 'The API works and the checks are accounted for.' });
        },
      );
      await h.sleep(3500);
    },
  },
  t3wait: waitFor(
    'T3 needs a person',
    '34 \u00b7 The third task: the web page',
    'The gate merges the second task, and the third starts on top of it: the web page, served by the same server. Again this is a real agent run, so I am speeding it up.',
    (i) => (i.type === 'review' && /T3:/.test(i.title)) || /Protected path/.test(i.title) || i.type === 'decision',
  ),

  t3a: {
    url: '/#/queue',
    title: '35 \u00b7 Review the third task: the web page',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T3:');
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The third and last task, the web page, is ready, and its pull request is in the Attention queue, the tab I am on. This is the last task of the plan, so every smoke check from the design applies to it, including the home page.',
        async () => {
          await h.point(ask.getByRole('heading', { level: 3 }), 'The third task, as a pull request', 'The last task of the plan.', 3500);
          await h.scrollBy(450, 5000);
        },
      );
      await act(
        h,
        'I click Run the security review first, because this page shows text that people type, and that is where cross-site scripting happens.',
        () => h.click(ask.getByRole('button', { name: 'Run the security review' }), { label: 'Run the security review', why: 'This page shows text people typed.' }),
      );
      await act(
        h,
        'And I click Run the smoke test, to start the whole app, page and API, against its own DynamoDB table, and call it.',
        () => h.click(ask.getByRole('button', { name: 'Run the smoke test' }), { label: 'Run the smoke test', why: 'Start the whole app and call it.' }),
      );
      await h.waitUntil(
        'the checks',
        async () => {
          const st = async (id) => (await ask.getByTestId(id).getAttribute('data-state')) ?? 'none';
          const [a, b] = [await st('security'), await st('smoke')];
          console.log('  states', a, b);
          const done = (s) => !['none', 'running', 'pending', 'starting', 'queued', 'unknown'].includes(s);
          return done(a) && done(b);
        },
        900000,
        4000,
      );
      await h.point(ask.getByTestId('smoke'), 'The smoke test', 'The whole app, started and called.', 3000);
    },
  },

  t3b: {
    url: '/#/queue',
    title: '36 \u00b7 All checks green: start the live preview',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T3:');
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'All four smoke checks passed, including the home page, and the security review found no cross-site scripting: the page puts everything it receives in as plain text. It repeats the finding that no route requires sign-in, and a low one about page headers. Neither is high or critical, so nothing blocks the merge.',
        async () => {
          await h.scrollBy(500, 2500);
          await h.point(ask.getByTestId('smoke'), 'Smoke test: 4 of 4 passed', 'The whole app, with its own DynamoDB table.', 6000);
          await h.point(ask.getByTestId('security'), 'The security review', 'No high or critical findings.', 5000);
        },
      );
      const prev = ask.getByTestId('preview');
      await act(
        h,
        'Now the most important step. I do not approve what I have only read. I click Run it, and the platform starts this pull request as a live, isolated, testable version of the application, in its own container on Fargate, with its own DynamoDB table that is deleted when the preview stops.',
        () => h.click(prev.getByRole('button', { name: /Run it (again|here)/ }), { label: 'Run the preview', why: 'A live, isolated version I can use.' }),
      );
      await h.waitUntil('the preview', async () => (await prev.getAttribute('data-state')) === 'ready', 420000, 2000);
      await h.sleep(1500);
    },
  },

  t3c: {
    url: '/#/queue',
    title: '37 \u00b7 Use the live version of the app',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T3:');
      await ask.waitFor({ timeout: 30000 });
      const link = ask.getByTestId('preview').getByRole('link').first();
      const href = await link.getAttribute('href');
      await act(
        h,
        'The preview is ready, and the card has a link to it. I open it in its own browser tab, because it is a separate address from the platform: it is the application itself, running in its own container, and only I can reach it.',
        () => h.browserTab('The live preview of the ticket tracker', 'The real app, isolated, with its own DynamoDB table.', href),
      );
      await p.locator('#new-title').waitFor({ timeout: 60000 });
      await act(
        h,
        'This is the support ticket tracker. The list is empty, because this preview has a DynamoDB table that was created for it alone, a moment ago. I will try the rules from the brief, and nothing I do here touches anything real.',
        () => h.point(p.locator('#ticket-list'), 'The ticket list', 'Empty: this preview has its own table.', 6000),
      );
      await act(
        h,
        'First I create a ticket. I click the Title box and type a title.',
        () => h.type(p.locator('#new-title'), 'Cannot sign in after password reset', { label: 'Type the ticket title', why: 'A new support ticket.', delay: 45 }),
      );
      await act(
        h,
        'Then a description, and the requester\u2019s email address.',
        async () => {
          await h.type(p.locator('#new-description'), 'The reset email arrives, but the new password is refused.', { label: 'Type a description', why: 'What the customer reports.', delay: 30 });
          await h.type(p.locator('#new-email'), 'sam@example.com', { label: 'Type the requester\u2019s email', why: 'Who asked for help.', delay: 45 });
        },
      );
      await act(
        h,
        'I click Create ticket. The page sends it to the API, and the API writes it to DynamoDB.',
        () => h.click(p.getByRole('button', { name: 'Create ticket' }), { label: 'Create ticket', why: 'Save it in DynamoDB.' }),
      );
      await h.sleep(2000);
      const item = p.locator('#ticket-list li button').first();
      await act(
        h,
        'The ticket is in the list with the status open. I click it, to see its details, because that is where the status, the assignee and the comments are.',
        () => h.click(item, { label: 'Open the ticket', why: 'See its details, status and comments.' }),
      );
      await h.sleep(1500);
      await act(
        h,
        'Now a rule from the brief: moving a ticket to in progress needs an assignee. This ticket has none. I click Move to in progress anyway, to see whether the app enforces it.',
        () => h.click(p.getByRole('button', { name: 'Move to in_progress' }), { label: 'Move to in_progress', why: 'Test the rule: it needs an assignee.' }),
      );
      await h.sleep(1500);
      await act(
        h,
        'It refuses, and says why. The rule is enforced on the server, inside the DynamoDB write, not only on the page.',
        () => h.point(p.locator('#status-msg'), 'The rule is enforced', 'In progress needs an assignee.', 5500),
      );
      await act(
        h,
        'So I assign the ticket. I type a name in the Assignee box and click Assign.',
        async () => {
          await h.type(p.locator('#assignee-name'), 'Dana Reyes', { label: 'Type an assignee', why: 'The agent who will work it.', delay: 45 });
          await h.click(p.getByRole('button', { name: 'Assign', exact: true }), { label: 'Assign', why: 'Save the assignee.' });
        },
      );
      await h.sleep(1800);
      await act(
        h,
        'Now I click Move to in progress again, and this time it works.',
        () => h.click(p.getByRole('button', { name: 'Move to in_progress' }), { label: 'Move to in_progress', why: 'The ticket has an assignee now.' }),
      );
      await h.sleep(1800);
      await act(
        h,
        'Next a comment. I type my name and a message, and click Add comment. Comments are stored as their own items in the same DynamoDB partition, so they load together with the ticket.',
        async () => {
          await h.type(p.locator('#comment-author'), 'Dana Reyes', { label: 'Type my name', why: 'Who wrote the comment.', delay: 45 });
          await h.type(p.locator('#comment-text'), 'Reproduced it. Resetting the password again from my side.', { label: 'Type a comment', why: 'A note for the thread.', delay: 28 });
          await h.click(p.getByRole('button', { name: 'Add comment' }), { label: 'Add comment', why: 'Save the comment.' });
        },
      );
      await h.sleep(2000);
      await act(
        h,
        'The comment appears under the ticket. Now I move the ticket on to resolved, and then to closed.',
        async () => {
          await h.click(p.getByRole('button', { name: 'Move to resolved' }), { label: 'Move to resolved', why: 'The problem is fixed.' });
          await h.sleep(1500);
          await h.click(p.getByRole('button', { name: 'Move to closed' }), { label: 'Move to closed', why: 'The customer confirmed.' });
        },
      );
      await h.sleep(2000);
      await act(
        h,
        'The ticket is closed, and the forms are gone. A closed ticket cannot change and takes no comments, which is another rule from the brief.',
        () => h.point(p.locator('#closed-note'), 'A closed ticket is read-only', 'Another rule from the brief.', 5500),
      );
      await act(
        h,
        'Last, the status filter. I create a second ticket, and then pick closed in the list filter, and the list is read from DynamoDB through the index on status.',
        async () => {
          await h.type(p.locator('#new-title'), 'Invoice shows the wrong total', { label: 'Type a title', why: 'A second ticket.', delay: 40 });
          await h.type(p.locator('#new-description'), 'The March invoice is 40 dollars too high.', { label: 'Type a description', why: 'What the customer reports.', delay: 28 });
          await h.type(p.locator('#new-email'), 'lee@example.com', { label: 'Type the email', why: 'Who asked for help.', delay: 40 });
          await h.click(p.getByRole('button', { name: 'Create ticket' }), { label: 'Create ticket', why: 'Save the second ticket.' });
          await h.sleep(1800);
          await h.point(p.locator('#status-filter'), 'Filter by status', 'Open shows the new ticket.', 3500);
          await p.locator('#status-filter').selectOption('closed');
          await h.sleep(3500);
        },
      );
      await act(
        h,
        'Closed shows the first ticket. And open shows the second. The app works as described, against a real DynamoDB table, in an environment that exists only for this review.',
        async () => {
          await h.sleep(3500);
          await p.locator('#status-filter').selectOption('open');
          await h.sleep(3500);
        },
      );
    },
  },

  t3d: {
    url: '/#/queue',
    title: '38 \u00b7 Approve the third task',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T3:');
      await ask.waitFor({ timeout: 30000 });
      await p.evaluate(() => window.__demo.banner('BACK TO THE PLATFORM TAB', 'The platform', 'The decision is made here, not in the preview.', '#ff6fb5', 4500));
      await act(
        h,
        'Back in the platform tab. The card shows every check accounted for on this commit: the agent\u2019s checks, the smoke test, and the security review, with nothing blocking. And I have used the app myself, in its live version, and it works. That is why I approve with confidence.',
        () => h.point(ask.getByTestId('review-flow'), 'Every check is accounted for', 'Nothing blocks the approval.', 8000),
      );
      await act(
        h,
        'I add a comment, with the follow-up I noticed, and click Approve.',
        async () => {
          await h.type(ask.getByLabel('Comment'), 'Works end to end on DynamoDB. Follow-ups: priorities and SLA timers, and sign-in.', { label: 'Type a comment', why: 'It stays with the decision.', delay: 26 });
          await h.click(ask.getByRole('button', { name: 'Approve' }), { label: 'Approve the third task', why: 'It works, and every check is green.' });
        },
      );
      await h.sleep(3500);
    },
  },
  mergewait: {
    url: '/#/queue',
    lapse: true,
    title: '39 \u00b7 The gate merges',
    async run(h) {
      const p = h.page;
      h.say('The gate waits for the repository\u2019s CI, which now installs packages and passes, merges the pull request, and the plan is complete.');
      await h.sleep(1500);
      await h.tab('Map', 'The map shows when the build is complete.');
      setTitle(cur());
      await pickInitiative(h);
      const init = (await (await p.request.get(BASE + '/api/initiatives')).json()).find((x) => x.title === cur());
      await h.waitUntil(
        'the plan is done',
        async () => (await (await p.request.get(BASE + `/api/initiatives/${init.id}/plan`)).json()).plan?.state === 'done',
        900000,
        5000,
      );
      await h.sleep(3000);
    },
  },
  stage1done: {
    url: '/#/map',
    title: '40 \u00b7 Stage 1 is done',
    async run(h) {
      const p = h.page;
      setTitle(cur());
      await pickInitiative(h);
      await act(
        h,
        'All three tasks are merged, and the build stage is done. The repository now holds a working app: the spec, the design, the DynamoDB data layer, the API, the page, and the tests, each reviewed by a person at every step.',
        () => h.point(p.getByTestId('build-plan'), 'The build plan: every task merged', 'The plan is complete.', 8000),
      );
      await act(
        h,
        'Now the Costs tab. I switch to it because I want to know what this stage cost. Every agent run is metered through the model gateway.',
        () => h.tab('Costs', 'What the first stage cost, by agent and by model.'),
      );
      await h.sleep(6000);
    },
  },

  s2_intro: {
    url: '/#/costs',
    title: 'Stage 2 \u00b7 Add features to the app that exists',
    async run(h) {
      const p = h.page;
      T2();
      await h.say(
        'Stage one is done: a working ticket tracker, built and merged. Now stage two. A real product keeps changing, so I give the platform a second initiative on the same repository, to add features to the app that is already there. It goes through the same flow: spec, design, build, and every change is again proposed as a live, isolated, testable version before I approve it.',
      );
      await h.tab('Map', 'A new initiative is created on the Map tab.');
      void p;
    },
  },
  s2_new: {
    url: '/#/map',
    title: '41 \u00b7 Stage 2: a second initiative',
    async run(h) {
      T2();
      const form = h.page.locator('form', { hasText: 'New initiative' });
      await act(h, 'At the bottom of the Map tab is the same form again.', async () => {
        await form.waitFor({ timeout: 30000 });
        await h.scrollBy(2000, 3000);
      });
      await act(h, 'I give this initiative its own title, because it has its own spec, design, tasks and cost.', () =>
        h.type(form.getByLabel('Title'), TITLE2, { label: 'Type a title', why: 'A second, separate initiative.' }),
      );
      await act(
        h,
        'The repository is the same one. Agents will read the code that stage one merged, and build on top of it.',
        () => h.point(form.getByLabel('Repository'), 'The same repository', 'Agents will build on the merged code.', 3500),
      );
      await act(
        h,
        'I choose Guided again, so a person starts each stage.',
        async () => {
          await form.getByLabel('How much runs on its own').selectOption('guided');
          await h.point(form.getByLabel('How much runs on its own'), 'Autonomy: Guided', 'A person starts and reviews every step.', 2200);
        },
      );
      await act(
        h,
        'The goal is a change request. Priorities for every ticket, with a deadline for a first response that depends on the priority, a marker for tickets that have passed it, and filters by priority, assignee and breached. It says to keep the existing table, to treat old tickets as normal priority, and to keep the existing tests passing.',
        () => h.type(form.getByLabel('Goal'), GOAL2, { label: 'Type the goal', why: 'A change to an existing app.', delay: 4 }),
      );
      await act(
        h,
        'There are no new outside systems this time. DynamoDB is already in the Integration Register, so the agents will not have to ask me about it again. I leave the reference links empty, and click Create.',
        () => h.click(form.getByRole('button', { name: 'Create' }), { label: 'Create', why: 'Record the goal. Nothing starts yet.' }),
      );
      await h.sleep(2500);
    },
  },
  s2_startspec: via(T2, 'startspec', { title: '42 \u00b7 Start the spec' }),
  s2_specwait: via(T2, 'specwait', { title: '43 \u00b7 The product agent works' }),
  s2_reviewspec: via(T2, 'reviewspec', { title: '44 \u00b7 Review and approve the spec' }),
  s2_startdesign: via(T2, 'startdesign', { title: '45 \u00b7 Start the design' }),
  s2_designwait: via(T2, 'designwait', { title: '46 \u00b7 The architect agent works' }),
  s2_reviewdesign: via(T2, 'reviewdesign', { title: '47 \u00b7 Review and approve the design' }),
  s2_startbuild: via(T2, 'startbuild', { title: '48 \u00b7 Start the build' }),

  s2_wait1: waitFor(
    'a person is needed',
    '49 \u00b7 The engineers build the feature',
    'The plan again has three tasks. The first engineer agent reads the code that stage one merged, and builds the rules for priorities and deadlines on top of it. This time it did not ask about DynamoDB, because DynamoDB is already in the register. A few minutes, sped up.',
    (i) => i.type === 'review' || /Protected path/.test(i.title) || i.type === 'decision',
  ),
  s2_t1a: checks('T1:', '50 \u00b7 Review the first task of stage 2', 'The first task of the new initiative is ready, and its pull request is in the Attention queue, the tab I am on. It changes the code stage one built, rather than writing it from nothing, and it adds tests next to the existing ones.'),

  s2_t1b: {
    url: '/#/queue',
    title: '51 \u00b7 Results, a dismissal with a reason, and approval',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T1:');
      await ask.waitFor({ timeout: 30000 });
      const sec = ask.getByTestId('security');
      await act(
        h,
        'All four smoke checks of the existing app still pass. That matters in a second initiative: the platform proves that the new code did not break what stage one delivered. The security review has one medium finding: a filtered list can read through a whole status partition for one small request, which could cost money if someone calls it in a loop.',
        async () => {
          await h.scrollBy(500, 2500);
          await h.point(ask.getByTestId('smoke'), 'Smoke test: 4 of 4 still pass', 'The existing app is not broken.', 6000);
          await h.point(sec, 'Security review: one medium finding', 'Only high or critical findings block the merge.', 7000);
        },
      );
      await act(
        h,
        'The list is already capped at one hundred results, and this is a small help desk, so I accept the cost risk and note it for later. I click Dismiss with a reason.',
        () => h.click(sec.getByRole('button', { name: /Dismiss F1 with a reason/ }), { label: 'Dismiss F1 with a reason', why: 'A risk I accept, on the record.' }),
      );
      await act(
        h,
        'I type the reason, and confirm.',
        async () => {
          await h.type(sec.getByLabel('Why F1 is dismissed'), 'The list is capped at 100 results and this is a small help desk. Revisit if ticket volume grows.', {
            label: 'Type the reason',
            why: 'It stays with the pull request.',
            delay: 24,
          });
          await h.click(sec.getByRole('button', { name: 'Dismiss', exact: true }), { label: 'Dismiss', why: 'Record the reason.' });
        },
      );
      await h.sleep(1500);
      await act(
        h,
        'This task changes the rules and the data code only, with no page yet, so there is nothing new to click through in a live version. The next tasks will have one. I add a comment and click Approve.',
        async () => {
          await h.type(ask.getByLabel('Comment'), 'Old tickets without a priority count as normal. Good.', { label: 'Type a comment', why: 'It stays with the decision.', delay: 28 });
          await h.click(ask.getByRole('button', { name: 'Approve' }), { label: 'Approve the first task', why: 'Rules and data code are right; the checks pass.' });
        },
      );
      await h.sleep(3500);
    },
  },
  s2_wait2: waitFor(
    'T2 needs a person',
    '52 \u00b7 The second task starts',
    'The gate waits for CI and merges the first task, and the second task starts on top of it. A few minutes, sped up.',
    (i) => (i.type === 'review' && /T2:/.test(i.title)) || /Protected path/.test(i.title) || i.type === 'decision',
  ),

  s2_ask: {
    url: '/#/map',
    title: '53 \u00b7 The agent asks before touching a protected file',
    async run(h) {
      const p = h.page;
      await act(
        h,
        'An engineer has stopped with a question. I switch to the Attention queue tab, because that is where anything waiting for a person lands.',
        () => h.tab('Attention queue', 'An agent is waiting for my answer.'),
      );
      const ask = askFor(p, 'May I add the three new');
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'This time the agent did not edit the protected preview file and wait to be stopped. It asked first: may it add three new checks for the priority filter to the smoke list? Those checks are how the platform will prove, in the live version, that the new filters work. It recommends yes, adding only the three checks and weakening nothing.',
        () => h.point(ask.getByRole('heading', { level: 3 }), 'May I add three smoke checks?', 'The preview file is a protected path.', 10000),
      );
      await act(
        h,
        'I choose yes, because new checks make the safety net stronger, not weaker.',
        () => h.click(ask.getByRole('radio', { name: /Yes, edit/ }), { label: 'Choose: Yes, edit the file', why: 'More checks, nothing removed.' }),
      );
      await act(h, 'And I click Answer.', () => h.click(ask.getByRole('button', { name: 'Answer' }), { label: 'Answer', why: 'Send the decision to the agent.' }));
      await h.sleep(2500);
    },
  },

  s2_t2a: checks('T2:', '54 \u00b7 Two pull requests at once', 'Two pull requests are waiting now: the second and the third task ran in parallel, because neither depends on the other. I start with the second, the API route and the filters. It is in the Attention queue, the tab I am on.'),

  s2_t2b: {
    url: '/#/queue',
    title: '55 \u00b7 Approve the API change first',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T2:');
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The security review found nothing, and all four smoke checks pass, so the API change is safe to take. The page, the other pull request, calls this API, so I approve the API change first. Taking them in this order means the page is tested against the real filters, not against a guess.',
        async () => {
          await h.scrollBy(500, 2500);
          await h.point(ask.getByTestId('smoke'), 'Smoke test: 4 of 4 passed', 'The existing app still works.', 6000);
          await h.point(ask.getByTestId('security'), 'Security review: no findings', 'Nothing to report.', 4500);
        },
      );
      await act(
        h,
        'I add a comment and click Approve.',
        async () => {
          await h.type(ask.getByLabel('Comment'), 'The route and the filters are clean. Approved.', { label: 'Type a comment', why: 'It stays with the decision.', delay: 28 });
          await h.click(ask.getByRole('button', { name: 'Approve' }), { label: 'Approve the second task', why: 'Checks are green and the API is right.' });
        },
      );
      await h.sleep(3500);
    },
  },

  s2_t3a: checks('T3:', '56 \u00b7 The page change: run the checks', 'The API change is merged, and the second pull request, the page controls for priority, timers and filters, is waiting in the same tab. The gate brought it up to date with the merged API, so it is now a new commit, and the checks start again.'),

  s2_t3b: {
    url: '/#/queue',
    title: '57 \u00b7 The design\u2019s own checks are missing: send it back',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T3:');
      await ask.waitFor({ timeout: 30000 });
      const smoke = ask.getByTestId('smoke');
      await act(
        h,
        'The security review found nothing. But look at the smoke test: four of seven checks pass, and three fail. They do not fail because the app is broken. They fail because the approved design requires three checks for the new filters, and the preview file does not list them. This is the last task of the plan, so the platform holds it to the whole list from the design, and a person cannot approve until they are there.',
        async () => {
          await h.scrollBy(500, 2500);
          await h.point(smoke, 'Smoke test: 4 of 7, three checks are missing', 'The design requires them; the preview file lacks them.', 15000);
        },
      );
      await act(
        h,
        'I could override the check, but the whole point of the list is that it protects the filters later. So I send the task back. In the Comment box I tell the engineer exactly what is missing.',
        () =>
          h.type(ask.getByLabel('Comment'), 'Add the three smoke checks the design requires to .sdlc/preview.yaml (the filter checks listed in the smoke test). Do not change the other checks.', {
            label: 'Type a comment',
            why: 'It goes to the engineer agent with the task.',
            delay: 24,
          }),
      );
      await act(
        h,
        'Then I click Request changes. The task starts again in a fresh container with my words added to its instructions, and nothing merges meanwhile.',
        () => h.click(ask.getByRole('button', { name: 'Request changes' }), { label: 'Request changes', why: 'Send it back with my comment.' }),
      );
      await h.sleep(3000);
    },
  },
  s2_wait3: waitFor(
    'a protected path',
    '58 \u00b7 The engineer edits the preview file',
    'The engineer starts the page task again, and goes to edit the preview file. That file is protected, so the platform stops it. A few minutes, sped up.',
    (i) => /Protected path|May I/.test(i.title) || (i.type === 'review' && /T3:/.test(i.title) && i.createdAt > new Date(Date.now() - 600000).toISOString()),
  ),

  s2_ask2: {
    url: '/#/map',
    title: '59 \u00b7 The engineer asks about the preview file',
    async run(h) {
      const p = h.page;
      await act(
        h,
        'The engineer is waiting for me. I switch to the Attention queue tab, because that is where it asks.',
        () => h.tab('Attention queue', 'An agent is waiting for my answer.'),
      );
      const ask = askFor(p, 'May I edit the protected');
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'It asks permission to edit the protected preview file, to add exactly the three filter checks I mentioned. That is the edit I asked for, so I choose yes.',
        async () => {
          await h.point(ask.getByRole('heading', { level: 3 }), 'May I edit the protected preview file?', 'Exactly the edit I asked for.', 6000);
          await h.click(ask.getByRole('radio', { name: /Yes/ }), { label: 'Choose: Yes', why: 'It is the edit I asked for.' });
        },
      );
      await act(h, 'And I click Answer.', () => h.click(ask.getByRole('button', { name: 'Answer' }), { label: 'Answer', why: 'Send the decision to the agent.' }));
      await h.sleep(2500);
    },
  },
  s2_wait4: waitFor(
    'the T3 review',
    '60 \u00b7 The page task is rebuilt',
    'The agent adds the three checks, runs them against the app, and opens the pull request again. A few minutes, sped up.',
    (i) => i.type === 'review' && /T3:/.test(i.title),
  ),

  s2_prot: allowProtected('60 \u00b7 The platform\u2019s own hard stop on the same file', false),

  s2_retry3: {
    url: '/#/queue',
    title: '61 \u00b7 A real platform gap, found by the recording',
    async run(h) {
      const p = h.page;
      await act(
        h,
        'Something went wrong with the page task, so I switch to the Map tab, because the state of every task is shown there.',
        () => h.tab('Map', 'The state of each task is shown on the map.'),
      );
      setTitle(TITLE2);
      await pickInitiative(h);
      const task = p.getByTestId('task-T3');
      await task.waitFor({ timeout: 30000 });
      await act(
        h,
        'The page task is marked failed. The engineer agent stopped and asked for help, because its tests could not run: the sandbox for the page engineer did not install the packages, and its instructions told it there was no internet. That was wrong, the package registry is reachable, and it is a gap in the platform, found by this recording. I fixed the engineers\u2019 instructions and redeployed the platform while this was waiting.',
        () => h.point(task, 'Task T3: stopped', 'A gap in the engineer\u2019s instructions, now fixed.', 14000),
      );
      await act(
        h,
        'Now I click Retry, so the engineer starts the page task again, from the same description, with the corrected instructions.',
        () => h.click(task.getByRole('button', { name: 'Retry' }), { label: 'Retry the third task', why: 'The instructions are fixed.' }),
      );
      await h.sleep(3000);
    },
  },

  s2_wait5: waitFor(
    'T3 needs a person',
    '62 \u00b7 The page task runs again',
    'The engineer starts the page task again in a fresh container. This time it installs the packages first, so its tests run. A few minutes, sped up.',
    (i) => /Protected path|May I/.test(i.title) || (i.type === 'review' && /T3:/.test(i.title)),
  ),

  s2_t3c: checks('T3:', '63 \u00b7 The page task again: run the checks', 'The page task is back, and its pull request is in the Attention queue, the tab I am on. It is a new commit, so every check starts again. The old question card about missing packages is still there from the failed run, and I will ignore it, because the retry no longer needs an answer.'),

  s2_t3d: {
    url: '/#/queue',
    title: '64 \u00b7 Override with a reason, then start the live preview',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T3:');
      await ask.waitFor({ timeout: 30000 });
      const smoke = ask.getByTestId('smoke');
      await act(
        h,
        'The security review found nothing. The smoke test shows the same gap as before: the four existing checks pass, and the three filter checks that the design requires are still not in the preview file. This task has been sent back and retried, and the limit on redoing a task has been reached, so asking again would only hand it to me.',
        async () => {
          await h.scrollBy(500, 2500);
          await h.point(smoke, 'Smoke test: 4 of 7', 'Three required checks are not listed.', 11000);
        },
      );
      await act(
        h,
        'The app itself is fine, and I will try the filters in the live version myself in a moment. So I take over the missing piece. I click Override with a reason, and after the merge I add those three checks to the preview file myself.',
        () => h.click(smoke.getByRole('button', { name: 'Override with a reason' }), { label: 'Override with a reason', why: 'I will add the three checks by hand.' }),
      );
      await act(
        h,
        'I type the reason, so it is on the record.',
        () =>
          h.type(smoke.getByLabel('Why the smoke test is overridden'), 'The three required filter checks are missing from the preview file. I add them by hand after the merge, and I test the filters in the live preview first.', {
            label: 'Type the reason',
            why: 'It stays with the pull request.',
            delay: 22,
          }),
      );
      await act(
        h,
        'And I confirm the override.',
        () => h.click(smoke.getByRole('button', { name: 'Override', exact: true }), { label: 'Override', why: 'Record the reason and unblock the approval.' }),
      );
      await h.sleep(2000);
      const prev = ask.getByTestId('preview');
      await act(
        h,
        'Now the important step, because I do not approve what I have only read. I click Run it, and the platform starts this pull request as a live, isolated, testable version of the application: its own container, its own network, and its own DynamoDB table that is deleted when the preview stops.',
        () => h.click(prev.getByRole('button', { name: /Run it (again|here)/ }), { label: 'Run the preview', why: 'A live, isolated version I can use.' }),
      );
      await h.waitUntil('the preview', async () => (await prev.getAttribute('data-state')) === 'ready', 420000, 2000);
      await h.sleep(1500);
    },
  },

  s2_t3e: {
    url: '/#/queue',
    title: '65 \u00b7 Try the new features in the live version',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T3:');
      await ask.waitFor({ timeout: 30000 });
      const href = await ask.getByTestId('preview').getByRole('link').first().getAttribute('href');
      await act(
        h,
        'The preview is ready. I open it in its own browser tab, because it is the application itself, on its own address, in its own container, with a DynamoDB table of its own, and I want to try the new priorities, timers and filters.',
        () => h.browserTab('The live preview of the new version', 'The real app with the new features, isolated.', href),
      );
      await p.locator('#new-title').waitFor({ timeout: 60000 });
      await act(
        h,
        'This is the same ticket tracker as before, and the new ticket form already has a Priority box. The list is empty, because this preview has a fresh table. Nothing here touches the first version, or anything real.',
        () => h.point(p.locator('#new-priority'), 'The new Priority field', 'Part of the change under review.', 5500),
      );
      const make = async (title, desc, email, prio, say) => {
        await act(h, say, async () => {
          await h.type(p.locator('#new-title'), title, { label: 'Type the title', why: 'A new ticket.', delay: 35 });
          await h.type(p.locator('#new-description'), desc, { label: 'Type a description', why: 'What is reported.', delay: 22 });
          await h.type(p.locator('#new-email'), email, { label: 'Type the email', why: 'Who asked.', delay: 35 });
          if (prio) {
            await h.point(p.locator('#new-priority'), `Priority: ${prio}`, 'Sets the response deadline.', 1800);
            await p.locator('#new-priority').selectOption(prio);
          }
          await h.click(p.getByRole('button', { name: 'Create ticket' }), { label: 'Create ticket', why: 'Save it in DynamoDB.' });
          await h.sleep(1800);
        });
      };
      await make(
        'The whole team cannot sign in',
        'Nobody on the sales team can sign in since this morning.',
        'ops@example.com',
        'urgent',
        'I create a ticket for an outage. I fill in the title, the description and the email, and I choose the priority urgent, then click Create ticket.',
      );
      await act(
        h,
        'The ticket appears with its priority and a timer: one hour left, because an urgent ticket must get its first response within one hour.',
        () => h.point(p.locator('#ticket-list li').first(), 'Urgent, with an SLA timer', 'One hour to respond.', 6500),
      );
      await make(
        'Change my profile photo',
        'I would like to update my profile photo.',
        'kim@example.com',
        'low',
        'Now a minor request, with the priority low.',
      );
      await make(
        'Question about the March invoice',
        'Why was I charged twice in March?',
        'lee@example.com',
        null,
        'And a third ticket, where I leave the priority at its default, normal.',
      );
      await act(
        h,
        'Three tickets, three priorities, and each shows its own time left: seventy-two hours for the low one, twenty-four for the normal one.',
        () => h.point(p.locator('#ticket-list'), 'Three tickets, three timers', 'Each priority has its own deadline.', 6500),
      );
      await act(
        h,
        'Now the filters. I pick urgent in the priority filter, and the list shrinks to the outage.',
        async () => {
          await h.point(p.locator('#priority-filter'), 'Filter by priority', 'Show only urgent tickets.', 2500);
          await p.locator('#priority-filter').selectOption('urgent');
          await h.sleep(3500);
        },
      );
      await act(
        h,
        'I set the priority filter back to any, and open the not breached filter. All three tickets are still within their deadlines. Choosing breached shows an empty list, because nothing has passed its deadline yet. To see a breach on the live version I would have to wait an hour.',
        async () => {
          await p.locator('#priority-filter').selectOption('any');
          await h.point(p.locator('#breached-filter'), 'Filter: not breached', 'Tickets still within their deadline.', 2200);
          await p.locator('#breached-filter').selectOption('false');
          await h.sleep(3000);
          await p.locator('#breached-filter').selectOption('true');
          await h.sleep(3000);
          await p.locator('#breached-filter').selectOption('any');
          await h.sleep(1000);
        },
      );
      await act(
        h,
        'Last, the assignee. I open the outage ticket, assign it to Dana, then type her full name in the assignee filter, and press Enter. The filter matches the name exactly, and the list shows only her tickets.',
        async () => {
          await h.click(p.locator('#ticket-list li button').filter({ hasText: 'cannot sign in' }), { label: 'Open the outage ticket', why: 'Assign it.' });
          await h.sleep(1200);
          await h.type(p.locator('#assignee-name'), 'Dana Reyes', { label: 'Type an assignee', why: 'The agent who will work it.', delay: 45 });
          await h.click(p.getByRole('button', { name: 'Assign', exact: true }), { label: 'Assign', why: 'Save the assignee.' });
          await h.sleep(1800);
          await h.type(p.locator('#assignee-filter'), 'Dana Reyes', { label: 'Filter by assignee', why: 'Show only Dana\u2019s tickets.', delay: 60 });
          await p.locator('#assignee-filter').press('Enter');
          await h.sleep(3500);
        },
      );
      await act(
        h,
        'The new features work as described, on a real DynamoDB table, in an environment that exists only for this review, and the old features are still there. Now I go back to the platform to decide.',
        () => h.sleep(4000),
      );
    },
  },

  s2_t3f: {
    url: '/#/queue',
    title: '66 \u00b7 Approve the page change',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T3:');
      await ask.waitFor({ timeout: 30000 });
      await p.evaluate(() => window.__demo.banner('BACK TO THE PLATFORM TAB', 'The platform', 'The decision is made here, not in the preview.', '#ff6fb5', 4500));
      await act(
        h,
        'Back in the platform tab. The card shows every step accounted for: the agent\u2019s checks, the smoke test with my recorded override, and the security review with nothing blocking. And I have used the new version myself, in its live, isolated copy, and it works. That is why I can approve.',
        () => h.point(ask.getByTestId('review-flow'), 'Every step is accounted for', 'Nothing blocks the approval.', 8000),
      );
      await act(
        h,
        'I add a comment and click Approve.',
        async () => {
          await h.type(ask.getByLabel('Comment'), 'Priorities, timers and filters all work in the live version. I will add the three missing smoke checks by hand.', {
            label: 'Type a comment',
            why: 'It stays with the decision.',
            delay: 24,
          });
          await h.click(ask.getByRole('button', { name: 'Approve' }), { label: 'Approve the page change', why: 'It works, and every step is accounted for.' });
        },
      );
      await h.sleep(3500);
    },
  },

  s2_done: {
    url: '/#/queue',
    title: '67 \u00b7 Stage 2 is done',
    async run(h) {
      const p = h.page;
      await act(
        h,
        'The gate has merged the page change. I switch to the Map tab, because that is where the plan shows whether every task is done.',
        () => h.tab('Map', 'The map shows when the build is complete.'),
      );
      setTitle(TITLE2);
      await pickInitiative(h);
      await act(
        h,
        'All three tasks of the second initiative are merged, on top of the app from the first. The repository now holds one product, built in two stages, each reviewed by a person, and each change tried in its own live, isolated copy before it was approved.',
        () => h.point(p.getByTestId('build-plan'), 'Stage 2: every task merged', 'The plan is complete.', 8000),
      );
      await act(
        h,
        'One loose end remains, and it is mine. I overrode the missing smoke checks, so I added the three filter checks to the preview file by hand, on the main branch. It is a protected path, so a person making that edit is the right way.',
        () =>
          p.evaluate(() =>
            window.__demo.banner('FIXED BY A PERSON', 'The preview file on main', 'Three filter smoke checks, as the design requires.', '#8be35a', 9000),
          ),
      );
      await act(
        h,
        'Finally, the Costs tab. I switch to it, because I want to know what two stages cost. Every agent run is metered through the model gateway.',
        () => h.tab('Costs', 'What both stages cost, by agent and by model.'),
      );
      await h.sleep(7000);
    },
  },
  outro: {
    url: '/#/costs',
    title: 'The end',
    async run(h) {
      const talk = h.say(
        'That was a real application with a DynamoDB database, built in two stages on a platform running in AWS, with a person at every decision that mattered. Along the way the platform stopped an agent at a new outside system, held a merge until the repository\u2019s CI passed, caught a real bug in a security review, enforced the design\u2019s own checks, and, before every approval, gave me a live, isolated, testable copy of the change to try. Every one of those steps was a person clicking a button, and I said why. Thanks for watching.',
      );
      await h.tab('Portfolio', 'Where every initiative stands, in one place.');
      await talk;
    },
  },

  region: {
    url: '/#/queue',
    title: '14 \u00b7 A smaller question: which region',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'Which AWS region');
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'There is a second card in the same queue. The agent asks which AWS region the app will run in. This one is not a hard stop: it recommends us-east-1, and if nobody answers within a day it uses that. I answer anyway, because I would rather decide than let a default decide.',
        () => h.point(ask.getByRole('heading', { level: 3 }), 'Which AWS region?', 'A question with a recommended answer.', 6500),
      );
      await act(
        h,
        'I choose us-east-1, which is where this platform and its data live.',
        () => h.click(ask.getByRole('radio', { name: /us-east-1/ }), { label: 'Choose: us-east-1', why: 'The same region as the platform.' }),
      );
      await act(h, 'And I click Answer.', () => h.click(ask.getByRole('button', { name: 'Answer' }), { label: 'Answer', why: 'Send the region to the agent.' }));
      await h.sleep(2500);
    },
  },
};

export const ORDER = ['intro', 'signin', 'home', 'tour', 'newinitiative', 'startspec', 'specwait', 'reviewspec', 'startdesign', 'designwait', 'reviewdesign', 'startbuild', 'buildwait1', 'integration', 'region', 't1a', 't1b', 't1wait', 't1c', 't1d', 't1ci', 't1wait2', 't1e', 't2wait', 'protected1', 't2a', 't2b', 't2wait2', 'protected2', 't2wait3', 't2c', 't2d', 't2f', 't3wait', 't3a', 't3b', 't3c', 't3d', 'mergewait', 'stage1done', 's2_intro', 's2_new', 's2_startspec', 's2_specwait', 's2_reviewspec', 's2_startdesign', 's2_designwait', 's2_reviewdesign', 's2_startbuild', 's2_wait1', 's2_t1a', 's2_t1b', 's2_wait2', 's2_ask', 's2_t2a', 's2_t2b', 's2_t3a', 's2_t3b', 's2_wait3', 's2_ask2', 's2_prot', 's2_retry3', 's2_wait5', 's2_t3c', 's2_t3d', 's2_t3e', 's2_t3f', 's2_done', 'outro'];

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) await main(scenes);
void BASE;
void T2;
void pickInitiative;
void interactions;

// The guided demo: a habit tracker built from one sentence on the live platform. In every scene each click says what
// is clicked and why, and each switch of tab says where we go and why. Narration is spoken while it happens.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, BASE, login } from './record.mjs';

export let TITLE = 'Habit tracker';
export const setTitle = (t) => {
  TITLE = t;
};
export const GOAL =
  'A small habit tracker as a web page with a small JSON API: add habits, tick a habit off for today, and see each habit\u2019s current streak of days in a row. ' +
  'Keep it small: Node only, no dependencies, data kept in memory. Design it as at most two tasks.';

/** Say something while an action happens, and wait for both. */
export const act = (h, text, fn) => Promise.all([h.say(text), fn()]);
export const pickInitiative = async (h) => {
  const sel = h.page.getByLabel('Initiative');
  await sel.waitFor({ timeout: 30000 });
  await sel.selectOption({ label: TITLE });
};
export const interactions = async (p) => (await p.request.get(BASE + '/api/interactions')).json();

export const scenes = {
  intro: {
    anon: true,
    url: '/',
    title: 'Autonomous SDLC',
    async run(h) {
      const talk = h.say(
        'This is Autonomous SDLC, a platform where AI agents build software and people stay in charge. ' +
          'Agents write the spec, design the solution, build each task in a sandbox, and open pull requests. ' +
          'People decide at clear checkpoints. Everything you see is running live in an AWS account. ' +
          'In this video I build a real app from one sentence, and for every click and every change of tab, I will say what I am doing and why.',
      );
      await h.sleep(3000);
      await h.scrollBy(1500, 14000);
      await talk;
    },
  },

  signin: {
    anon: true,
    keepAuth: true,
    url: '/',
    title: '1 \u00b7 Sign in',
    async run(h) {
      const p = h.page;
      await act(
        h,
        'To start, I click Sign in. I do this first because access is by invitation only, and sign-in goes through Amazon Cognito.',
        () => h.click(p.getByTestId('sign-in'), { label: 'Sign in', why: 'Only invited people get in.' }),
      );
      const user = await login(p);
      await act(
        h,
        'I type my email address and password. Who I am decides which hats I wear, such as product owner or engineer, and the hats decide which decisions I am allowed to make.',
        async () => {
          await h.type(user, process.env.SDLC_USER, { label: 'Type my email', why: 'My invitation was sent to this address.' });
          await h.type(p.locator('input[name="password"]:visible'), process.env.SDLC_PASSWORD, {
            label: 'Type my password',
            why: 'Cognito checks it. The platform never sees it.',
            delay: 55,
          });
        },
      );
      await act(h, 'Now I click Sign in to send them.', () =>
        h.click(p.locator('input[name="signInSubmitButton"]:visible'), { label: 'Sign in', why: 'Submit my email and password.' }),
      );
      await p.getByTestId('signed-in').waitFor({ timeout: 30000 });
      await h.sleep(1500);
    },
  },

  home: {
    url: '/',
    title: '2 \u00b7 How work flows',
    async run(h) {
      const talk = h.say(
        'I am in. The home page shows how work flows. A person gives a goal, and the product agent drafts the spec, which a person approves. ' +
          'The architect agent designs the solution and splits it into tasks. Engineer agents build one task each. ' +
          'Every pull request gets checks, a person reviews it, and a gate merges it only when the checks pass. People hold every decision that matters.',
      );
      await h.sleep(2500);
      await h.scrollBy(700, 16000);
      await talk;
    },
  },

  tour: {
    url: '/',
    title: '3 \u00b7 A quick tour of the tabs',
    async run(h) {
      const p = h.page;
      await h.say('Before I start, a quick tour of the other tabs, because I will use them later. The left menu is the tab bar, and each tab is a different view of the same work.');
      await act(
        h,
        'First, the Portfolio tab. I switch to it because it lists every initiative with its stage and its cost. It is empty, because this is a fresh deployment.',
        () => h.tab('Portfolio', 'See every initiative, its stage and its cost, in one place.'),
      );
      await h.sleep(1500);
      await act(
        h,
        'Next, the Integrations tab. I switch here because this is the register of outside systems that agents are allowed to call. Each entry has documentation links that the platform fetches and hands to the agents. If an agent needs a system that is not listed, it asks a person to approve it here, and to supply the documentation.',
        () => h.tab('Integrations', 'The outside systems agents may call, and where their documentation is.'),
      );
      await h.sleep(1500);
      await act(
        h,
        'Then the Costs tab. I switch to it because every agent run spends real money on model calls, and this is where I watch that against a monthly budget. It starts at zero, and I will check it again at the end.',
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
    title: '4 \u00b7 Give the platform a goal',
    async run(h) {
      const p = h.page;
      const form = p.locator('form', { hasText: 'New initiative' });
      await act(h, 'At the bottom of the Map tab is the form for a new initiative. An initiative is one goal, with its own spec, design, tasks and cost.', async () => {
        await form.waitFor({ timeout: 30000 });
        await h.scrollBy(2000, 3500);
      });
      await act(h, 'I click the Title box and name it. A short name is how I will find this initiative in lists and in the queue.', () =>
        h.type(form.getByLabel('Title'), TITLE, { label: 'Type a title', why: 'The name I will look for later.' }),
      );
      await act(
        h,
        'The repository is where the agents are allowed to work. Only registered repositories appear, and this one is a scratch repository for the demo. I leave it selected.',
        () => h.point(form.getByLabel('Repository'), 'Repository the agents may change', 'Only registered repositories can be picked.', 3500),
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
        'Now the goal itself, in plain words. A habit tracker as a web page with a small JSON API: add habits, tick them off for today, and see each streak. Node only, no dependencies, at most two tasks.',
        () => h.type(form.getByLabel('Goal'), GOAL, { label: 'Type the goal', why: 'One sentence is all the platform needs.', delay: 14 }),
      );
      await act(
        h,
        'This last field takes reference links. If the work had to call an outside API, I would paste its documentation link here, and every agent would be told about it. This app needs none, so I leave it empty.',
        () => h.point(form.getByLabel('Reference links'), 'Reference links (optional)', 'API documentation for outside systems.', 3500),
      );
      await act(
        h,
        'I click Create, because that records the goal. In guided mode nothing starts yet.',
        () => h.click(form.getByRole('button', { name: 'Create' }), { label: 'Create', why: 'Record the goal. Nothing starts yet.' }),
      );
      await h.sleep(2500);
    },
  },

  startspec: {
    url: '/#/map',
    title: '5 \u00b7 Start the spec',
    async run(h) {
      const p = h.page;
      await act(h, 'The map shows the initiative in three stages. I pick it from the list at the top, so the map is about this goal.', async () => {
        await h.sleep(1200);
        await pickInitiative(h);
        await h.sleep(1500);
      });
      const step = p.getByTestId('stage-spec');
      await act(
        h,
        'The spec stage says it is waiting for a person to start it. I click Start, because in guided mode nothing begins until I say so. The product agent then starts drafting the spec in its own container on AWS Fargate.',
        () => h.click(step.getByRole('button', { name: 'Start the spec' }), { label: 'Start the spec', why: 'Guided mode waits for me.' }),
      );
      await h.sleep(2500);
    },
  },

  specwait: {
    url: '/#/map',
    lapse: true,
    title: '6 \u00b7 The product agent works',
    async run(h) {
      const p = h.page;
      h.say(
        'While the agent works, the map stays current. Nothing here is faked: this is a real agent run in its own container, reading the goal, writing user stories with acceptance criteria, and opening a pull request with the spec. It takes a few minutes, so I am speeding it up.',
      );
      await pickInitiative(h);
      await h.waitUntil(
        'a review is waiting',
        async () => (await interactions(p)).some((i) => i.initiativeTitle === TITLE && i.type === 'review'),
        1_200_000,
        5000,
      );
    },
  },

  reviewspec: {
    url: '/#/map',
    title: '7 \u00b7 Review and approve the spec',
    async run(h) {
      const p = h.page;
      await act(
        h,
        'The spec is ready. I switch to the Attention queue tab, because that is where everything waiting for a person lands, ranked by what is most urgent.',
        () => h.tab('Attention queue', 'The spec is waiting for me to decide.'),
      );
      const ask = p.getByTestId('ask').filter({ hasText: 'Draft the spec' });
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The card says what changed, that the build is green, and which hat has to decide: the product owner. The spec itself is a pull request, so I can read what the agent wrote.',
        async () => {
          await h.point(ask.getByRole('heading', { level: 3 }), 'The spec, as a pull request', 'Written by the product agent.', 4500);
          await h.scrollBy(380, 5000);
        },
      );
      await act(
        h,
        'I leave a short comment for the record, in the Comment box, because a comment travels with the decision and the agent can read it.',
        () => h.type(ask.getByLabel('Comment'), 'Small and clear. Good to go.', { label: 'Type a comment', why: 'It stays with the decision.', delay: 35 }),
      );
      await act(
        h,
        'And I click Approve. A spec is always decided by a person, never by a rule, and approving it unlocks the design stage.',
        () => h.click(ask.getByRole('button', { name: 'Approve' }), { label: 'Approve the spec', why: 'Specs never merge on their own.' }),
      );
      await h.sleep(3000);
    },
  },

  startdesign: {
    url: '/#/queue',
    title: '8 \u00b7 Start the design',
    async run(h) {
      const p = h.page;
      await act(
        h,
        'After my approval the gate waited for the repository checks and merged the spec by itself. Now I switch back to the Map tab, because the next stage, the design, has to be started from there.',
        () => h.tab('Map', 'The design stage starts from the map.'),
      );
      await pickInitiative(h);
      const start = p.getByTestId('stage-spec').getByRole('button', { name: 'Start the design' });
      await start.waitFor({ timeout: 240000 });
      await act(
        h,
        'I click Start on the design. The architect agent will read the approved spec, design the solution, and split it into tasks that can be built in parallel.',
        () => h.click(start, { label: 'Start the design', why: 'The spec is merged, so design comes next.' }),
      );
      await h.sleep(2500);
    },
  },

  designwait: {
    url: '/#/map',
    lapse: true,
    title: '9 \u00b7 The architect agent works',
    async run(h) {
      const p = h.page;
      h.say(
        'The architect agent is running in its own container. It writes a design and a build plan: the list of tasks, the files each one owns, and which ones depend on others. This takes a few minutes, so I am speeding it up.',
      );
      await pickInitiative(h);
      await h.waitUntil(
        'the design review',
        async () => (await interactions(p)).some((i) => i.initiativeTitle === TITLE && i.type === 'review' && /design/i.test(i.title)),
        1_500_000,
        5000,
      );
    },
  },

  reviewdesign: {
    url: '/#/map',
    title: '10 \u00b7 Review and approve the design',
    async run(h) {
      const p = h.page;
      await act(
        h,
        'The design is done. I switch to the Attention queue tab again, because the design is waiting there for my decision, just as the spec was.',
        () => h.tab('Attention queue', 'The design is waiting for my decision.'),
      );
      const ask = p.getByTestId('ask').filter({ hasText: 'Design:' });
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The platform checks a design before I ever see it: tasks must not overlap in the files they touch, and every smoke check must be valid. I read the plan the agent proposes.',
        async () => {
          await h.point(ask.getByRole('heading', { level: 3 }), 'The design, as a pull request', 'Checked by the platform before I see it.', 4500);
          await h.scrollBy(420, 5000);
        },
      );
      await act(
        h,
        'I add a comment, then click Approve, because the design decides what gets built and I agree with the split into tasks.',
        async () => {
          await h.type(ask.getByLabel('Comment'), 'Clean split. Approved.', { label: 'Type a comment', why: 'It stays with the decision.', delay: 35 });
          await h.click(ask.getByRole('button', { name: 'Approve' }), { label: 'Approve the design', why: 'Agree with the tasks and the files.' });
        },
      );
      await h.sleep(3000);
    },
  },

  startbuild: {
    url: '/#/queue',
    title: '11 \u00b7 Start the build',
    async run(h) {
      const p = h.page;
      await act(
        h,
        'The approved design has become a build plan. I switch back to the Map tab, because the plan and the button that starts the build live there.',
        () => h.tab('Map', 'The build plan is shown on the map.'),
      );
      await pickInitiative(h);
      const plan = p.getByTestId('build-plan');
      await plan.waitFor({ timeout: 240000 });
      const start = p.getByTestId('stage-build').getByRole('button', { name: 'Start the build' });
      await start.waitFor({ timeout: 60000 });
      await act(
        h,
        'Each box is a task, with the files it owns and what it waits for. Independent tasks run in parallel, and dependent ones wait until their parents are merged.',
        async () => {
          await h.point(plan.getByRole('heading').first(), 'The build plan', 'Tasks, their files, and their order.', 4500);
          await h.scrollBy(300, 3500);
        },
      );
      await act(
        h,
        'I click Start the build. This is the moment engineer agents begin writing code.',
        () => h.click(start, { label: 'Start the build', why: 'Engineer agents start writing code.' }),
      );
      await h.sleep(3000);
    },
  },

  buildwait1: {
    url: '/#/map',
    lapse: true,
    title: '12 \u00b7 The engineer agents build',
    async run(h) {
      const p = h.page;
      h.say(
        'The plan has two tasks. The first, the server and its API, has no dependencies, so it starts at once. The second, the web page, depends on the first, so it waits. ' +
          'The engineer agent for the first task runs in an isolated Fargate container with only this repository checked out. It writes the code and the tests, and then it stops and asks me something.',
      );
      await pickInitiative(h);
      await h.waitUntil(
        'a protected path decision',
        async () => (await interactions(p)).some((i) => i.initiativeTitle === TITLE && i.type === 'decision' && /Protected path/.test(i.title)),
        900_000,
        5000,
      );
    },
  },

  protectedpath: {
    url: '/#/map',
    title: '13 \u00b7 A hard stop: a protected file',
    async run(h) {
      const p = h.page;
      await act(
        h,
        'The engineer has stopped, and the map says why. I switch to the Attention queue tab, because a run that is waiting for a person shows up there, and this one is blocked until I answer.',
        () => h.tab('Attention queue', 'An agent is stopped and waiting for me.'),
      );
      const ask = p.getByTestId('ask').filter({ hasText: 'Protected path changed' });
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The agent edited a protected path: dot sdlc slash preview dot yaml. Protected paths are files an agent may never change on its own, so the platform stops it and makes this a hard stop. The platform recommends discarding the edit, which is the safe default.',
        () => h.point(ask.getByRole('heading', { level: 3 }), 'Protected path: .sdlc/preview.yaml', 'The agent cannot continue until a person decides.', 7000),
      );
      await act(
        h,
        'That file tells the platform how to start the app and which smoke checks to run. The approved design requires those checks, so without it the platform could neither preview nor test this app. I choose Allow, because this one edit is exactly what the design asks for.',
        () => h.click(ask.getByLabel(/Allow this change/), { label: 'Choose: Allow this change', why: 'The design needs this file to start the app.' }),
      );
      await act(
        h,
        'And I click Answer, to send my decision to the agent. It wakes up in a fresh container with my answer and carries on.',
        () => h.click(ask.getByRole('button', { name: 'Answer' }), { label: 'Answer', why: 'Send the decision to the agent.' }),
      );
      await h.sleep(2500);
    },
  },

  buildwait1b: {
    url: '/#/queue',
    lapse: true,
    title: '14 \u00b7 The first task is built',
    async run(h) {
      const p = h.page;
      h.say('The agent continues the first task, finishes the code and the tests, runs the checks, and opens a pull request. This takes a few minutes, so I am speeding it up.');
      await h.waitUntil(
        'the T1 review',
        async () => (await interactions(p)).some((i) => i.initiativeTitle === TITLE && /T1:/.test(i.title)),
        2_400_000,
        5000,
      );
    },
  },

  reviewpr1a: {
    url: '/#/queue',
    title: '15 \u00b7 The first pull request: send it back',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'T1:' });
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The first task is done, and its pull request is in my queue. I am already on the Attention queue tab, because that is where it lands. The card shows what the agent did, and its own summary. Read this part carefully: the agent says it could not create the preview configuration file.',
        async () => {
          await h.point(ask.getByRole('heading', { level: 3 }), 'The first task, as a pull request', 'Built by the backend engineer agent.', 4000);
          await h.scrollBy(300, 4500);
        },
      );
      await act(
        h,
        'I chose Allow a moment ago, but the platform understood my answer as a refusal. That is a real bug, and this recording found it. I fixed it, and redeployed the platform while this pull request waited.',
        () => h.sleep(14000),
      );
      await act(
        h,
        'Without that file the platform cannot start the app, so there could be no smoke test and no preview. So I do not approve. In the Comment box I say what is missing.',
        () =>
          h.type(
            ask.getByLabel('Comment'),
            'The design requires smoke checks, so please add .sdlc/preview.yaml. The protected-path answer is fixed now.',
            { label: 'Type a comment', why: 'It goes to the engineer agent with the task.', delay: 28 },
          ),
      );
      await act(
        h,
        'Then I click Request changes. That sends the task back to the same engineer agent in a fresh container, with my words added to its instructions. Nothing merges while it works.',
        () => h.click(ask.getByRole('button', { name: 'Request changes' }), { label: 'Request changes', why: 'Send it back with my comment.' }),
      );
      await h.sleep(3000);
    },
  },




  reviewpr1: {
    url: '/#/queue',
    title: '15 \u00b7 Review the first pull request',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'T1:' });
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The first task is done, and its pull request is waiting in the Attention queue, the tab I am already on. The card shows the agent\u2019s own summary: the server, the tests, and the preview file I allowed.',
        async () => {
          await h.point(ask.getByRole('heading', { level: 3 }), 'The first task, as a pull request', 'Built by the backend engineer agent.', 4500);
          await h.scrollBy(450, 4500);
        },
      );
      await act(
        h,
        'This diagram shows what stands between the change and the merge: the agent\u2019s own checks, a smoke test, a security review, my decision, repository CI, and then the gate. Only the first step has run.',
        () => h.point(ask.getByTestId('review-flow'), 'What stands between this change and the merge', 'The merge happens only when every step is green.', 7000),
      );
      await act(
        h,
        'I click Run the security review first. I do it because a person reading a diff can miss things a second reader might see, so a model reads the change and reports findings. A high or critical finding would block the merge.',
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
      await act(
        h,
        'The review is back with two findings: no limit on the size of a request, which is medium, and no limit on the length of a habit name, which is low. Neither blocks the merge, but they stay on the record.',
        () => h.point(ask.getByTestId('security'), 'The security review', 'Findings by severity. Only high or critical block.', 8000),
      );
      await act(
        h,
        'Now the smoke test. It would normally start the real app and call it, but the panel says it cannot run at all: the preview file the agent wrote is not valid YAML. A check that cannot be read cannot protect anyone.',
        () => h.point(ask.getByTestId('smoke'), 'Smoke test: cannot run', 'The preview file is not valid YAML.', 9000),
      );
      await act(
        h,
        'I could override the check with a reason, but that would leave a broken file in the repository. The better choice is to send the work back. In the Comment box I tell the engineer what to fix, including the request size limit.',
        () =>
          h.type(
            ask.getByLabel('Comment'),
            'The smoke checks in .sdlc/preview.yaml are not valid YAML. Quote the command strings. Also cap the request body size.',
            { label: 'Type a comment', why: 'It goes to the engineer agent with the task.', delay: 24 },
          ),
      );
      await act(
        h,
        'Then I click Request changes. That starts the task again in a fresh container with my words added. Nothing merges, and every check will run again on the new commit.',
        () => h.click(ask.getByRole('button', { name: 'Request changes' }), { label: 'Request changes', why: 'Send it back with my comment.' }),
      );
      await h.sleep(3000);
    },
  },

  takeover: {
    url: '/#/queue',
    title: '16 \u00b7 The platform hands the task to a person',
    async run(h) {
      const p = h.page;
      await act(
        h,
        'My request went to the engineer, and the platform now reports that this task has been sent back so many times that it stops retrying and hands it to a person. To see that, I switch to the Map tab, because the build plan and the state of each task are shown there.',
        () => h.tab('Map', 'The state of each task is shown on the map.'),
      );
      await pickInitiative(h);
      const task = p.getByTestId('task-T1');
      await task.waitFor({ timeout: 30000 });
      await act(
        h,
        'The first task is marked failed, and the reason is a limit, not a crash: changes were requested on every attempt, so a person takes over. It protects the budget from an endless loop of redoing the same work.',
        () => h.point(task, 'Task T1: failed', 'Changes were requested on every attempt.', 8000),
      );
      await act(
        h,
        'I am that person. I click Retry, because the problems are small and known: a fresh attempt starts from the task description and the agent can write a valid preview file.',
        () => h.click(task.getByRole('button', { name: 'Retry' }), { label: 'Retry the first task', why: 'A person decides to try again.' }),
      );
      await h.sleep(3000);
    },
  },

  buildwait1c: {
    url: '/#/map',
    lapse: true,
    title: '17 \u00b7 The agent tries again',
    async run(h) {
      const p = h.page;
      h.say('The engineer agent starts the task again in a fresh container. It writes the preview file once more, and because that is a protected path, it stops and asks me again.');
      await pickInitiative(h);
      await h.waitUntil(
        'a protected path decision',
        async () => (await interactions(p)).some((i) => i.initiativeTitle === TITLE && i.type === 'decision' && /Protected path/.test(i.title)),
        900_000,
        5000,
      );
    },
  },

  protectedpath2: {
    url: '/#/map',
    title: '18 \u00b7 Allow the protected file again',
    async run(h) {
      const p = h.page;
      await act(
        h,
        'The same hard stop is back. I switch to the Attention queue tab, because that is where the agent waits for me.',
        () => h.tab('Attention queue', 'The agent is stopped and waiting for me.'),
      );
      const ask = p.getByTestId('ask').filter({ hasText: 'Protected path changed' });
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'It is the same file, dot sdlc slash preview dot yaml, and the same reason. I answer the same way, because this is still the file the design asks for.',
        () => h.click(ask.getByLabel(/Allow this change/), { label: 'Choose: Allow this change', why: 'The design needs this file.' }),
      );
      await act(
        h,
        'And I click Answer.',
        () => h.click(ask.getByRole('button', { name: 'Answer' }), { label: 'Answer', why: 'Send the decision to the agent.' }),
      );
      await h.sleep(2500);
    },
  },

  buildwait1d: {
    url: '/#/queue',
    lapse: true,
    title: '19 \u00b7 The first task is rebuilt',
    async run(h) {
      const p = h.page;
      h.say('The agent keeps the file, finishes the work, and opens a new pull request. A few minutes, sped up.');
      await h.waitUntil(
        'the new T1 review',
        async () => (await interactions(p)).some((i) => i.initiativeTitle === TITLE && /T1:/.test(i.title) && !/Protected/.test(i.title)),
        2_400_000,
        5000,
      );
    },
  },

  reviewpr1b: {
    url: '/#/queue',
    title: '20 \u00b7 Review the rebuilt first task',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'T1:' });
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The new pull request is in the Attention queue, the tab I am on. The checks are reset, because the code is a new commit. I run the security review again, so I click Run the security review.',
        async () => {
          await h.point(ask.getByRole('heading', { level: 3 }), 'The first task, rebuilt', 'A new commit, so every check starts again.', 3500);
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
      await act(
        h,
        'The review is back. The same kind of medium and low findings are on record, and none is high or critical, so nothing blocks.',
        () => h.point(ask.getByTestId('security'), 'The security review', 'Only high or critical findings block.', 6000),
      );
      const smoke = ask.getByTestId('smoke');
      await act(
        h,
        'The smoke test still cannot run, because the preview file still has an unquoted command, and I have already sent this task back once. The final task of the plan is held to the whole list of smoke checks, so the file has to be right before the build can finish, and I will insist on it there. For this library-like step, I override the check, and the platform makes me say why.',
        () => h.point(smoke, 'Smoke test: cannot run', 'The preview file has an unquoted command.', 12000),
      );
      await act(
        h,
        'I click Override with a reason.',
        () => h.click(smoke.getByRole('button', { name: 'Override with a reason' }), { label: 'Override with a reason', why: 'Skip this check, on the record.' }),
      );
      await act(
        h,
        'I type the reason. It is saved with the pull request, so anyone reviewing later can see what I decided and why.',
        () =>
          h.type(
            smoke.getByLabel('Why the smoke test is overridden'),
            'The preview file has an unquoted command. The final task must fix it, and its smoke checks are enforced.',
            { label: 'Type the reason', why: 'It stays with the pull request.', delay: 22 },
          ),
      );
      await act(
        h,
        'And I confirm the override.',
        () => h.click(smoke.getByRole('button', { name: 'Override', exact: true }), { label: 'Override', why: 'Record the reason and unblock the approval.' }),
      );
      await h.sleep(2500);
    },
  },

  approvepr1: {
    url: '/#/queue',
    title: '21 \u00b7 Approve the first task',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'T1:' });
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'With the override recorded, the approval is no longer held. The diagram shows the agent\u2019s checks passed, and the smoke test and the security review are accounted for.',
        () => h.point(ask.getByTestId('review-flow'), 'Every step is accounted for', 'Nothing is blocking my approval now.', 7000),
      );
      await act(
        h,
        'I add a comment for the engineer, because the next task builds on this code.',
        () => h.type(ask.getByLabel('Comment'), 'Server and tests look right. Fix the preview file in the next task.', { label: 'Type a comment', why: 'It stays with the decision.', delay: 26 }),
      );
      await act(
        h,
        'Then I click Approve, because the code does what the task asked. The gate now waits for the repository checks and merges the pull request, and the second task, which was waiting for it, can start.',
        () => h.click(ask.getByRole('button', { name: 'Approve' }), { label: 'Approve the first task', why: 'The code does what the task asked.' }),
      );
      await h.sleep(3500);
    },
  },

  buildwait2: {
    url: '/#/map',
    lapse: true,
    title: '22 \u00b7 The second task starts',
    async run(h) {
      const p = h.page;
      h.say(
        'The gate waits for the repository\u2019s own CI, merges the first task, and the second task starts. It depends on the first, so it builds on the merged code. Again this is a real agent run, so I am speeding it up.',
      );
      await pickInitiative(h);
      await h.waitUntil(
        'T2 needs a person',
        async () => (await interactions(p)).some((i) => i.initiativeTitle === TITLE && (/T2:/.test(i.title) || /Protected path/.test(i.title))),
        2_400_000,
        5000,
      );
    },
  },

  reviewpr2: {
    url: '/#/map',
    title: '23 \u00b7 Review the second task',
    async run(h) {
      const p = h.page;
      await act(
        h,
        'The second task, the web page, is ready. I switch to the Attention queue tab, because its pull request is waiting for me there.',
        () => h.tab('Attention queue', 'The second pull request is waiting for me.'),
      );
      const ask = p.getByTestId('ask').filter({ hasText: 'T2:' });
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'This is the last task of the plan, so every smoke check from the design applies to it. The card lists the files it changed. Next to the page and its test, the agent also left a file called verify output dot text, which does not belong in the repository.',
        async () => {
          await h.point(ask.getByRole('heading', { level: 3 }), 'The second task, as a pull request', 'The last task of the plan.', 3500);
          await h.scrollBy(450, 3500);
        },
      );
      await act(
        h,
        'I click Run the security review, because this task puts text people type onto a web page, and that is where cross-site scripting happens.',
        () => h.click(ask.getByRole('button', { name: 'Run the security review' }), { label: 'Run the security review', why: 'This page shows text people typed.' }),
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
      await act(
        h,
        'The review is back.',
        () => h.point(ask.getByTestId('security'), 'The security review', 'Only high or critical findings block.', 7000),
      );
      await act(
        h,
        'The smoke test panel still says it cannot read the preview file. This is the final task, so the whole list of smoke checks from the design is required, and I will not override it this time. I send the task back.',
        () => h.point(ask.getByTestId('smoke'), 'Smoke test: cannot run', 'The final task needs the smoke checks.', 7000),
      );
      await act(
        h,
        'In the Comment box I tell the engineer exactly what to fix: the quoting in the preview file, and the stray file.',
        () =>
          h.type(
            ask.getByLabel('Comment'),
            'Fix .sdlc/preview.yaml: put the curl command in single quotes so it is valid YAML. Also delete verify-output.txt.',
            { label: 'Type a comment', why: 'It goes to the engineer agent with the task.', delay: 24 },
          ),
      );
      await act(
        h,
        'And I click Request changes.',
        () => h.click(ask.getByRole('button', { name: 'Request changes' }), { label: 'Request changes', why: 'Send it back with my comment.' }),
      );
      await h.sleep(3000);
    },
  },

  protectedpath3: {
    url: '/#/queue',
    title: '24 \u00b7 The engineer fixes the file, and asks again',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'Protected path changed' });
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The engineer did what I asked and fixed the preview file, and because that file is protected, it stopped and asked for my permission again. It appeared in the Attention queue, where I already am.',
        () => h.point(ask.getByRole('heading', { level: 3 }), 'Protected path: .sdlc/preview.yaml', 'The agent waits for a person.', 6500),
      );
      await act(
        h,
        'This is exactly the edit I requested, so I choose Allow.',
        () => h.click(ask.getByLabel(/Allow this change/), { label: 'Choose: Allow this change', why: 'It is the fix I asked for.' }),
      );
      await act(
        h,
        'And I click Answer.',
        () => h.click(ask.getByRole('button', { name: 'Answer' }), { label: 'Answer', why: 'Send the decision to the agent.' }),
      );
      await h.sleep(2500);
    },
  },

  buildwait2b: {
    url: '/#/queue',
    lapse: true,
    title: '25 \u00b7 The second task is rebuilt',
    async run(h) {
      const p = h.page;
      h.say('The agent keeps the fixed file, finishes the work, and opens the pull request again. A few minutes, sped up.');
      await h.waitUntil(
        'the new T2 review',
        async () => (await interactions(p)).some((i) => i.initiativeTitle === TITLE && /T2:/.test(i.title) && !/Protected/.test(i.title)),
        2_400_000,
        5000,
      );
    },
  },

  reviewpr2b: {
    url: '/#/queue',
    title: '26 \u00b7 Run every check on the new commit',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'T2:' });
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The pull request is back in the queue, and because the code changed, the earlier results no longer count. This time the preview file is valid: the card says the repository has three smoke checks. I run all three checks at once.',
        async () => {
          await h.point(ask.getByRole('heading', { level: 3 }), 'The second task, rebuilt', 'A new commit, so every check starts again.', 3500);
          await h.scrollBy(520, 3500);
        },
      );
      await act(
        h,
        'First, I click Run the security review, because the commit is new and the old review does not apply.',
        () => h.click(ask.getByRole('button', { name: 'Run the security review' }), { label: 'Run the security review', why: 'The old review does not apply to a new commit.' }),
      );
      await act(
        h,
        'Second, I click Run the smoke test, to start the real app in a fresh container on AWS and call it with the checks from the design.',
        () => h.click(ask.getByRole('button', { name: 'Run the smoke test' }), { label: 'Run the smoke test', why: 'Start the real app and call it.' }),
      );
      await act(
        h,
        'Third, I click Run it here. That starts a live preview of this pull request, so I can use the app myself before I approve it.',
        () => h.click(ask.getByRole('button', { name: 'Run it here' }), { label: 'Run it here', why: 'Start a live preview to try the app.' }),
      );
      await h.sleep(2500);
    },
  },

  checkswait: {
    url: '/#/queue',
    lapse: true,
    title: '27 \u00b7 The checks run',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'T2:' });
      await ask.waitFor({ timeout: 30000 });
      h.say('While those run, the card keeps updating. The smoke test and the preview each take a minute or two, because each one is a fresh container that has to start, check out the code, and run it.');
      await h.move(ask.getByTestId('smoke'));
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
        5000,
      );
    },
  },

  reviewchecks2: {
    url: '/#/queue',
    title: '28 \u00b7 Read the results',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'T2:' });
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The smoke test passed all three checks: it called the home page and the habits endpoint, and posted a new habit with curl. This time the preview file was valid and the sandbox had curl, so the check could actually run.',
        () => h.point(ask.getByTestId('smoke'), 'Smoke test: 3 of 3 passed', 'The real app answered every check.', 9000),
      );
      await act(
        h,
        'The security review has four findings, and none is high or critical: no limit on request size, no limit on a habit name\u2019s length, the server listening on every interface, and a file path in an error message. They stay on the record, and none blocks the merge.',
        () => h.point(ask.getByTestId('security'), 'Security review: 4 findings, none blocking', 'Medium and low only.', 11000),
      );
    },
  },

  previewstart: {
    url: '/#/queue',
    title: '29 \u00b7 Start the live preview',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'T2:' });
      await ask.waitFor({ timeout: 30000 });
      const prev = ask.getByTestId('preview');
      await act(
        h,
        'Now the preview. The checks are done, so I click Run it again, because I want to use the app myself before I approve it. The platform starts this pull request\u2019s own code in a sandbox on AWS, with no secrets and almost no network, for thirty minutes.',
        () => h.click(prev.getByRole('button', { name: /Run it (again|here)/ }), { label: 'Run it again', why: 'Start the app to try it myself.' }),
      );
      await h.waitUntil('the preview', async () => (await prev.getAttribute('data-state')) === 'ready', 300000, 2000);
      await act(h, 'The preview is ready, and the card now has a link to it.', () => h.point(prev, 'The preview is ready', 'Opens the pull request\u2019s own code.', 4000));
    },
  },

  tryapp: {
    url: '/#/queue',
    title: '30 \u00b7 Try the app myself',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'T2:' });
      await ask.waitFor({ timeout: 30000 });
      const link = ask.getByTestId('preview').getByRole('link').first();
      const href = await link.getAttribute('href');
      await act(
        h,
        'I open the preview link, because the checks only show that the app starts and answers. I want to see it work as a person would use it. It opens as its own browser tab, on a separate address, so the code under review cannot act as me on the platform.',
        async () => {
          await h.point(link, 'The preview link', 'Opens the app in its own browser tab.', 2500);
          await h.browserTab('The habit tracker preview', 'The pull request\u2019s own code, running in a sandbox.', href);
        },
      );
      await p.locator('#habit-name').waitFor({ timeout: 30000 });
      await act(
        h,
        'This is the habit tracker. I click the box and type a habit, Read twenty pages, because adding a habit is the first thing a user does.',
        () => h.type(p.locator('#habit-name'), 'Read 20 pages', { label: 'Type a habit', why: 'The first thing a user does.', delay: 60 }),
      );
      await act(
        h,
        'And I click Add Habit.',
        () => h.click(p.getByRole('button', { name: 'Add Habit' }), { label: 'Add Habit', why: 'Save the habit and show it in the list.' }),
      );
      await act(
        h,
        'Nothing appears. The list stays empty. The page asks the server for slash api slash habits with a leading slash, but a preview lives under its own path, so the request never reaches the app. A reviewer would never see that by reading the code, and the smoke test could not see it either, because it calls the app directly.',
        async () => {
          await h.point(p.locator('#habits-list'), 'The list stays empty', 'The request never reaches the app.', 11000);
        },
      );
      await act(
        h,
        'So I go back to the platform tab, because the decision is made there, and send the task back with a note about exactly this.',
        () => h.backToPlatform('/#/queue', 'The review decision is made on the platform.'),
      );
      const ask2 = p.getByTestId('ask').filter({ hasText: 'T2:' });
      await ask2.waitFor({ timeout: 30000 });
      await act(
        h,
        'In the Comment box I say what I saw, and what to change: use relative addresses for every request, so the page also works under a path.',
        () =>
          h.type(
            ask2.getByLabel('Comment'),
            'In the preview, adding a habit fails: the page calls /api/habits with a leading slash, and a preview is served under its own path. Use relative URLs (api/habits) for every fetch.',
            { label: 'Type a comment', why: 'It goes to the engineer agent with the task.', delay: 22 },
          ),
      );
      await act(
        h,
        'Then I click Request changes.',
        () => h.click(ask2.getByRole('button', { name: 'Request changes' }), { label: 'Request changes', why: 'Send it back with what I saw.' }),
      );
      await h.sleep(3000);
    },
  },

  redowait: {
    url: '/#/queue',
    lapse: true,
    title: '31 \u00b7 The engineer fixes the page',
    async run(h) {
      const p = h.page;
      h.say(
        'My comment goes straight back to the engineer agent. The platform starts the task again in a fresh container, with my words added to its instructions, and the agent changes the page to use relative addresses. Nothing merges while it works, and the same checks will run again on the new commit.',
      );
      await h.waitUntil(
        'the redone T2 review',
        async () => (await interactions(p)).some((i) => i.initiativeTitle === TITLE && /T2:/.test(i.title)),
        2_400_000,
        5000,
      );
    },
  },

  rejectredo: {
    url: '/#/queue',
    title: '32 \u00b7 The same mistake came back',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'T2:' });
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The redone pull request is in my queue, on the same tab. The engineer fixed the page\u2019s addresses, but the smoke test panel says the preview file cannot be read again. The engineer started from a copy that lacked the quoting fix, so the old mistake came back.',
        async () => {
          await h.point(ask.getByRole('heading', { level: 3 }), 'The second task, redone', 'The addresses are fixed.', 3000);
          await h.scrollBy(520, 2500);
          await h.point(ask.getByTestId('smoke'), 'Smoke test: cannot run', 'The preview file is invalid YAML again.', 6500);
        },
      );
      await act(
        h,
        'This task has been sent back twice, which is the most the platform allows before a person takes over, so asking again would only hand it to me. Instead I fix the causes. I corrected the preview file on the main branch myself, and I added a rule to the engineers\u2019 instructions to use relative addresses, since the same two mistakes have now happened more than once.',
        () =>
          p.evaluate(() =>
            window.__demo.banner('FIXED BY A PERSON', 'The causes, outside this pull request', 'The preview file is valid on main, and the engineer instructions now say: use relative addresses.', '#8be35a', 13000),
          ),
      );
      await act(
        h,
        'Then I type a short comment and click Reject, because this pull request is not worth patching. The platform will let me start the task again from a clean state.',
        async () => {
          await h.type(ask.getByLabel('Comment'), 'The preview file is invalid again. Starting this task over after fixing main and the engineer instructions.', {
            label: 'Type a comment',
            why: 'It stays with the decision.',
            delay: 24,
          });
          await h.click(ask.getByRole('button', { name: 'Reject' }), { label: 'Reject this pull request', why: 'Start the task again from a clean state.' });
        },
      );
      await h.sleep(3000);
    },
  },

  retryt2: {
    url: '/#/queue',
    title: '33 \u00b7 Start the second task again',
    async run(h) {
      const p = h.page;
      await act(
        h,
        'I switch to the Map tab, because that is where a task that has stopped can be started again.',
        () => h.tab('Map', 'A stopped task is restarted from the map.'),
      );
      await pickInitiative(h);
      const task = p.getByTestId('task-T2');
      await task.waitFor({ timeout: 30000 });
      await act(
        h,
        'The second task is marked failed, because I rejected its pull request. The first task is merged. I click Retry on the second task, and an engineer agent starts it again on the corrected main branch, with the new instructions.',
        async () => {
          await h.point(task, 'Task T2: stopped by my decision', 'The first task is merged.', 4500);
          await h.click(task.getByRole('button', { name: 'Retry' }), { label: 'Retry the second task', why: 'Start it again from a clean state.' });
        },
      );
      await h.sleep(3000);
    },
  },

  redowait2: {
    url: '/#/map',
    lapse: true,
    title: '34 \u00b7 The second task is built again',
    async run(h) {
      const p = h.page;
      h.say('A fresh container checks out the corrected main branch, builds the page with relative addresses, and opens a new pull request. A few minutes, sped up.');
      await pickInitiative(h);
      await h.waitUntil(
        'T2 needs a person',
        async () => (await interactions(p)).some((i) => i.initiativeTitle === TITLE && (/T2:/.test(i.title) || /Protected path/.test(i.title))),
        2_400_000,
        5000,
      );
    },
  },

  protectedpath4: {
    url: '/#/map',
    title: '35 \u00b7 The engineer asks about the preview file',
    async run(h) {
      const p = h.page;
      await act(
        h,
        'The engineer has stopped again at the protected preview file. I switch to the Attention queue tab, because that is where it waits for me.',
        () => h.tab('Attention queue', 'The agent is stopped and waiting for me.'),
      );
      const ask = p.getByTestId('ask').filter({ hasText: 'Protected path changed' });
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'It wants to edit the preview file on the new branch, which is the same protected path as before. The design needs its smoke checks, so I choose Allow.',
        () => h.click(ask.getByLabel(/Allow this change/), { label: 'Choose: Allow this change', why: 'The design needs the smoke checks.' }),
      );
      await act(
        h,
        'And I click Answer.',
        () => h.click(ask.getByRole('button', { name: 'Answer' }), { label: 'Answer', why: 'Send the decision to the agent.' }),
      );
      await h.sleep(2500);
    },
  },

  buildwait2d: {
    url: '/#/queue',
    lapse: true,
    title: '36 \u00b7 The second task is built again',
    async run(h) {
      const p = h.page;
      h.say('The agent keeps the file, finishes the page, and opens a new pull request. A few minutes, sped up.');
      await h.waitUntil(
        'the new T2 review',
        async () => (await interactions(p)).some((i) => i.initiativeTitle === TITLE && /T2:/.test(i.title) && !/Protected/.test(i.title)),
        2_400_000,
        5000,
      );
    },
  },

  rejectredo2: {
    url: '/#/queue',
    title: '37 \u00b7 My own mistake, and a clean restart',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'T2:' });
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The new pull request is in my queue, and the smoke test cannot read the preview file once more. This time the cause is mine: the correction I pushed to the main branch by hand was saved in the wrong text encoding, and the agent built on top of it.',
        async () => {
          await h.point(ask.getByRole('heading', { level: 3 }), 'The second task, started again', 'It inherited my file.', 3000);
          await h.scrollBy(520, 2500);
          await h.point(ask.getByTestId('smoke'), 'Smoke test: cannot run', 'The preview file is unreadable.', 6500);
        },
      );
      await act(
        h,
        'I have fixed the file on main, so this is the last time. I type a short comment and click Reject, because this pull request carries my broken file, and the cleanest thing is to start the task again.',
        async () => {
          await h.type(ask.getByLabel('Comment'), 'My hand-made fix of the preview file had the wrong encoding. Fixed on main; starting this task over.', {
            label: 'Type a comment',
            why: 'It stays with the decision.',
            delay: 24,
          });
          await h.click(ask.getByRole('button', { name: 'Reject' }), { label: 'Reject this pull request', why: 'Start the task again on the fixed main.' });
        },
      );
      await h.sleep(3000);
    },
  },

  retryt2b: {
    url: '/#/queue',
    title: '38 \u00b7 Start the second task again',
    async run(h) {
      const p = h.page;
      await act(
        h,
        'Back to the Map tab, because that is where a stopped task is started again.',
        () => h.tab('Map', 'A stopped task is restarted from the map.'),
      );
      await pickInitiative(h);
      const task = p.getByTestId('task-T2');
      await task.waitFor({ timeout: 30000 });
      await act(
        h,
        'I click Retry on the second task, and the engineer agent starts it again, this time on a main branch with a valid preview file.',
        () => h.click(task.getByRole('button', { name: 'Retry' }), { label: 'Retry the second task', why: 'Start it again on the fixed main.' }),
      );
      await h.sleep(3000);
    },
  },

  buildwait2e: {
    url: '/#/map',
    lapse: true,
    title: '39 \u00b7 The second task is built once more',
    async run(h) {
      const p = h.page;
      h.say('A fresh container checks out the fixed main branch, builds the page, and opens a new pull request. A few minutes, sped up.');
      await pickInitiative(h);
      await h.waitUntil(
        'T2 review or protected path',
        async () => (await interactions(p)).some((i) => i.initiativeTitle === TITLE && (/T2:/.test(i.title) || /Protected path/.test(i.title))),
        2_400_000,
        5000,
      );
    },
  },

  recheck: {
    url: '/#/queue',
    title: '40 \u00b7 Run the checks again',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'T2:' });
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The new pull request is in my queue, and because the code is new, nothing has run on it yet. The card says the checks have not run on this commit, so I run them.',
        async () => {
          await h.point(ask.getByRole('heading', { level: 3 }), 'The second task, started again', 'A new commit: every check starts again.', 3000);
          await h.scrollBy(520, 2000);
        },
      );
      await act(
        h,
        'I click Run the security review, because the commit is new.',
        () => h.click(ask.getByRole('button', { name: 'Run the security review' }), { label: 'Run the security review', why: 'The old review does not apply to a new commit.' }),
      );
      await act(
        h,
        'And I click Run the smoke test, to start the app again and call it.',
        () => h.click(ask.getByRole('button', { name: 'Run the smoke test' }), { label: 'Run the smoke test', why: 'Start the app and call it again.' }),
      );
      await h.sleep(2500);
    },
  },

  checkswait2: {
    url: '/#/queue',
    lapse: true,
    title: '41 \u00b7 The checks run again',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'T2:' });
      await ask.waitFor({ timeout: 30000 });
      h.say('The smoke test is a fresh container that checks out the new commit, starts the app, and calls it. It takes a minute or two, so I am speeding it up.');
      await h.move(ask.getByTestId('smoke'));
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
    },
  },

  previewstart2: {
    url: '/#/queue',
    title: '42 \u00b7 Start the preview again',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'T2:' });
      await ask.waitFor({ timeout: 30000 });
      const prev = ask.getByTestId('preview');
      await act(
        h,
        'The smoke test and the security review are done. Now I click Run it, to start the preview of the new commit, because I want to try the same thing again and see whether the fix worked.',
        () => h.click(prev.getByRole('button', { name: /Run it (again|here)/ }), { label: 'Run the preview', why: 'Try the fix myself.' }),
      );
      await h.waitUntil('the preview', async () => (await prev.getAttribute('data-state')) === 'ready', 300000, 2000);
      await h.sleep(1500);
    },
  },

  tryapp2: {
    url: '/#/queue',
    title: '43 \u00b7 Try the fixed app',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'T2:' });
      await ask.waitFor({ timeout: 30000 });
      const link = ask.getByTestId('preview').getByRole('link').first();
      const href = await link.getAttribute('href');
      await act(
        h,
        'The preview is running the redone code. I open it in its own browser tab, to repeat exactly what failed before.',
        () => h.browserTab('The habit tracker preview', 'The fixed code, running in a sandbox.', href),
      );
      await p.locator('#habit-name').waitFor({ timeout: 30000 });
      await act(
        h,
        'I type the same habit, Read twenty pages, and click Add Habit.',
        async () => {
          await h.type(p.locator('#habit-name'), 'Read 20 pages', { label: 'Type a habit', why: 'The same step that failed before.', delay: 60 });
          await h.click(p.getByRole('button', { name: 'Add Habit' }), { label: 'Add Habit', why: 'Save the habit.' });
        },
      );
      await h.sleep(1500);
      await act(
        h,
        'This time the habit appears in the list, with a streak of zero. I add a second one, Stretch, so there is more than one to track.',
        async () => {
          await h.type(p.locator('#habit-name'), 'Stretch', { label: 'Type another habit', why: 'A second habit to track.', delay: 60 });
          await h.click(p.getByRole('button', { name: 'Add Habit' }), { label: 'Add Habit', why: 'Save the second habit.' });
        },
      );
      await h.sleep(1200);
      await act(
        h,
        'Now I click Done today on the first habit, because the point of the app is the streak. The streak goes from zero to one, and the page shows today as the last day it was done.',
        () => h.click(p.getByRole('button', { name: 'Done today' }).first(), { label: 'Done today', why: 'Tick the habit off and start its streak.' }),
      );
      await h.sleep(1500);
      await act(
        h,
        'Pressing it again on the same day does not raise the streak a second time, which is what the design asked for. The app works as described.',
        async () => {
          await h.click(p.getByRole('button', { name: 'Done today' }).first(), { label: 'Done today again', why: 'The streak must not go up twice in a day.' });
          await h.point(p.locator('#habits-list'), 'The streak is still 1', 'One tick per day.', 3500);
        },
      );
    },
  },

  approvepr2: {
    url: '/#/queue',
    title: '44 \u00b7 Approve the second task',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'T2:' });
      await ask.waitFor({ timeout: 30000 });
      await p.evaluate(() => window.__demo.banner('BACK TO THE PLATFORM TAB', 'The platform', 'The decision is made here, not in the preview.', '#ff6fb5', 4500));
      await act(
        h,
        'Back in the platform tab, the card shows every check accounted for on this commit: the agent\u2019s checks, the smoke test, and the security review, with nothing blocking. I have also used the app myself, and it works.',
        async () => {
          await h.point(ask.getByTestId('review-flow'), 'Every check is accounted for', 'Nothing blocks the approval.', 8000);
        },
      );
      await act(
        h,
        'I add a comment with the follow-up I noticed: the last done date is a day early in my time zone, because the app counts days in UTC.',
        () => h.type(ask.getByLabel('Comment'), 'Works. Follow-up: show the last-done date in the viewer\u2019s time zone, not UTC.', { label: 'Type a comment', why: 'It stays with the decision.', delay: 26 }),
      );
      await act(
        h,
        'Then I click Approve, because the code does what the task asked and I have seen it work. The gate waits for the repository\u2019s own CI, and merges the pull request.',
        () => h.click(ask.getByRole('button', { name: 'Approve' }), { label: 'Approve the second task', why: 'It works, and every check is green.' }),
      );
      await h.sleep(3500);
    },
  },

  mergewait: {
    url: '/#/queue',
    lapse: true,
    title: '45 \u00b7 The gate merges',
    async run(h) {
      const p = h.page;
      h.say('The gate is waiting for CI on the repository. When it is green, the gate merges the pull request and the plan is complete.');
      await h.sleep(1500);
      await h.tab('Map', 'The map shows when the build is complete.');
      await pickInitiative(h);
      const init = (await (await p.request.get(BASE + '/api/initiatives')).json()).find((x) => x.title === TITLE);
      await h.waitUntil(
        'the plan is done',
        async () => (await (await p.request.get(BASE + `/api/initiatives/${init.id}/plan`)).json()).plan?.state === 'done',
        900000,
        5000,
      );
      await h.sleep(3000);
    },
  },

  finish: {
    url: '/#/map',
    title: '46 \u00b7 The build is done',
    async run(h) {
      const p = h.page;
      await pickInitiative(h);
      await act(
        h,
        'Both tasks are merged, and the build stage is done. In the repository there is now a working app: the spec and the design, the server, the page, the tests, and the smoke checks, all reviewed by a person at each step.',
        async () => {
          await h.point(p.getByTestId('build-plan'), 'The build plan: every task merged', 'The plan is complete.', 8000);
        },
      );
      await act(
        h,
        'Finally, the Costs tab. I switch to it because I want to know what this cost. Every agent run is metered through the model gateway.',
        () => h.tab('Costs', 'What the whole build cost, by agent and by model.'),
      );
      await h.sleep(6000);
    },
  },

  outro: {
    url: '/#/costs',
    title: 'The end',
    async run(h) {
      const talk = h.say(
        'That was a real app, built from one sentence on a platform running in AWS, with a person at every decision that mattered. Along the way the platform stopped an agent at a protected file, held a merge until checks passed, and let me find a bug by trying the app. Every one of those steps was a person clicking a button, and I said why. Thanks for watching.',
      );
      await h.tab('Portfolio', 'Where every initiative stands, in one place.');
      await talk;
    },
  },
};

export const ORDER = ['intro', 'signin', 'home', 'tour', 'newinitiative', 'startspec', 'specwait', 'reviewspec', 'startdesign', 'designwait', 'reviewdesign', 'startbuild', 'buildwait1', 'protectedpath', 'buildwait1b', 'reviewpr1', 'takeover', 'buildwait1c', 'protectedpath2', 'buildwait1d', 'reviewpr1b', 'approvepr1', 'buildwait2', 'reviewpr2', 'protectedpath3', 'buildwait2b', 'reviewpr2b', 'checkswait', 'reviewchecks2', 'previewstart', 'tryapp', 'redowait', 'rejectredo', 'retryt2', 'redowait2', 'protectedpath4', 'buildwait2d', 'rejectredo2', 'retryt2b', 'buildwait2e', 'recheck', 'checkswait2', 'previewstart2', 'tryapp2', 'approvepr2', 'mergewait', 'finish', 'outro'];

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) await main(scenes);

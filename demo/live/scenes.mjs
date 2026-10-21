import { main, BASE } from './record.mjs';
import { login } from './record.mjs';

export const GOAL =
  'A small expense splitter as a web page with a small JSON API: add people and expenses, and see who owes whom. ' +
  'Keep it small: Node only, no dependencies, data kept in memory. Design it as at most three tasks.';

const scenes = {
  intro: {
    anon: true,
    url: '/',
    say:
      'This is Autonomous SDLC, a platform where AI agents build software and people stay in charge. ' +
      'Agents write the spec, design the solution, build each task in a sandbox, and open pull requests. ' +
      'People decide at clear checkpoints. Everything here is running live, in an AWS account, and this video shows a real app being built from a single sentence.',
    async run(h) {
      await h.sleep(3000);
      await h.scrollBy(1500, Math.max(4000, h.audioSec * 1000 - 8000));
    },
  },
  signin: {
    anon: true,
    keepAuth: true,
    url: null,
    say: 'I sign in through Amazon Cognito. Access is by invitation, and each person has one or more hats, such as product owner or engineer.',
    async run(h) {
      const user = await login(h.page);
      await h.type(user, process.env.SDLC_USER);
      await h.type(h.page.locator('input[name="password"]:visible'), process.env.SDLC_PASSWORD, 60);
      await h.click(h.page.locator('input[name="signInSubmitButton"]:visible'));
      await h.page.getByTestId('signed-in').waitFor({ timeout: 30000 });
    },
  },
  home: {
    url: '/',
    say:
      'The home page shows how work flows. A person gives a goal, the product agent drafts the spec, and a person approves it. ' +
      'The architect agent designs the solution and splits it into tasks. Engineer agents build one task each, in parallel. ' +
      'Every pull request gets checks, a person reviews it, and a gate merges it only when the build passes.',
    async run(h) {
      await h.sleep(4000);
      await h.scrollBy(500, 8000);
    },
  },
  startspec: {
    url: '/#/map',
    say:
      'In guided mode nothing starts by itself. The map shows where the initiative is and who it is waiting on: the spec needs a person to start it. ' +
      'I click Start, and the product agent begins drafting the spec in its own container on AWS Fargate.',
    async run(h) {
      const p = h.page;
      await h.sleep(1200);
      await p.getByLabel('Initiative').selectOption({ label: 'Expense splitter app' });
      await h.sleep(3000);
      await h.click(p.getByTestId('step-spec').getByRole('button', { name: 'Start' }));
      await h.sleep(2500);
    },
  },
  specwait: {
    url: '/#/map',
    lapse: true,
    say:
      'While the agent works, the map stays current. Nothing is faked here: this is a real agent run, so I will speed this part up. ' +
      'It reads the goal, writes user stories with acceptance criteria, and opens a pull request with the spec.',
    async run(h) {
      const p = h.page;
      await p.getByLabel('Initiative').selectOption({ label: 'Expense splitter app' });
      await h.waitUntil('a review is waiting', async () => {
        const list = await (await p.request.get(BASE + '/api/interactions')).json();
        return list.some((i) => i.initiativeTitle === 'Expense splitter app' && i.type === 'review');
      }, 1_200_000, 5000);
    },
  },  reviewspec: {
    url: '/#/queue',
    say:
      'The spec arrives in my attention queue as a pull request. The card says what changed, that the build is green, and which hat has to decide: product owner. ' +
      'The agent wrote three user stories, kept to Node with no dependencies, and listed what is out of scope. I read it, add a comment, and approve. ' +
      'Specs and designs never merge on their own.',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'Draft the spec' });
      await ask.waitFor({ timeout: 30000 });
      await h.move(ask.getByRole('heading', { level: 3 }));
      await h.sleep(5000);
      await h.scrollBy(380, 5000);
      await h.sleep(5000);
      await h.type(ask.getByLabel('Comment'), 'Three small stories, Node only. Good to go.', 35);
      await h.sleep(800);
      await h.click(ask.getByRole('button', { name: 'Approve' }));
      await h.sleep(3000);
    },
  },  startdesign: {
    url: '/#/map',
    say:
      'Once I approved, the gate waited for the repository checks and merged the spec on its own. ' +
      'The next step is the design. Again it waits for a person to start it. ' +
      'The architect agent will read the approved spec, design the solution, and split it into tasks that can be built in parallel.',
    async run(h) {
      const p = h.page;
      await p.getByLabel('Initiative').selectOption({ label: 'Expense splitter app' });
      const start = p.getByTestId('next-steps').getByRole('button', { name: 'Start' });
      await start.waitFor({ timeout: 240000 });
      await h.sleep(4000);
      await h.click(start);
      await h.sleep(2500);
    },
  },
  designwait: {
    url: '/#/map',
    lapse: true,
    say:
      'The architect agent is now running in its own container. It produces a design, and a build plan: the list of tasks, which files each one touches, and which ones depend on others. ' +
      'This takes a few minutes, so I am speeding it up.',
    async run(h) {
      const p = h.page;
      await p.getByLabel('Initiative').selectOption({ label: 'Expense splitter app' });
      await h.waitUntil('the design review', async () => {
        const list = await (await p.request.get(BASE + '/api/interactions')).json();
        return list.some((i) => i.initiativeTitle === 'Expense splitter app' && i.type === 'review' && /design/i.test(i.title));
      }, 1_500_000, 5000);
    },
  },  reviewdesign: {
    url: '/#/queue',
    say:
      'The design arrives for review, this time for the architect hat. The platform checks a design before I ever see it: tasks must not overlap in the files they touch, and every smoke check has to be valid. ' +
      'Here the first draft had three tasks, two of them editing the same file, so the agent merged them into two. I can read the design, comment, and approve.',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'Design:' });
      await ask.waitFor({ timeout: 30000 });
      await h.move(ask.getByRole('heading', { level: 3 }));
      await h.sleep(6000);
      await h.scrollBy(420, 5000);
      await h.sleep(5000);
      await h.type(ask.getByLabel('Comment'), 'Two tasks, clean split. Approved.', 35);
      await h.sleep(800);
      await h.click(ask.getByRole('button', { name: 'Approve' }));
      await h.sleep(3000);
    },
  },  startbuild: {
    url: '/#/map',
    say:
      'The approved design has become a build plan. Each box is a task, with the files it owns and what it waits for. ' +
      'The platform runs independent tasks in parallel and holds dependent ones until their parents are merged. ' +
      'I check the plan, and start the build.',
    async run(h) {
      const p = h.page;
      await p.getByLabel('Initiative').selectOption({ label: 'Expense splitter app' });
      const plan = p.getByTestId('build-plan');
      await plan.waitFor({ timeout: 240000 });
      const start = plan.getByRole('button', { name: 'Start the build' });
      await start.waitFor({ timeout: 60000 });
      await h.move(plan.getByRole('heading').first());
      await h.sleep(5000);
      await h.scrollBy(300, 4000);
      await h.sleep(4000);
      await h.click(start);
      await h.sleep(3000);
    },
  },
  buildwait1: {
    url: '/#/map',
    lapse: true,
    say:
      'Each task now runs as its own engineer agent, in an isolated Fargate container with only the repository checked out. It writes the code and the tests, runs the checks, and opens a pull request.',
    async run(h) {
      const p = h.page;
      await p.getByLabel('Initiative').selectOption({ label: 'Expense splitter app' });
      await h.waitUntil('a code review', async () => {
        const list = await (await p.request.get(BASE + '/api/interactions')).json();
        return list.some((i) => i.initiativeTitle === 'Expense splitter app' && i.type === 'review' && /PR/.test(i.title) && !/Design|spec/i.test(i.title));
      }, 2_400_000, 5000);
    },
  },  reviewpr1: {
    url: '/#/queue',
    say:
      'The first task is done and its pull request is waiting for me. The card shows the agent\u2019s own summary, and a diagram of what stands between this change and the merge: the agent\u2019s checks, my decision, repository CI, and then the gate. ' +
      'This platform also holds an approval until two more checks have run. First, a security review: a model reads the change and reports findings. I run it now.',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'T1:' });
      await ask.waitFor({ timeout: 30000 });
      await h.move(ask.getByRole('heading', { level: 3 }));
      await h.sleep(5000);
      await h.scrollBy(520, 5000);
      await h.sleep(3000);
      await h.click(ask.getByRole('button', { name: 'Run the security review' }));
      await h.waitUntil('the security review', async () => {
        const s = await ask.getByTestId('security').getAttribute('data-state');
        return s && !['none', 'running', 'pending'].includes(s);
      }, 180000, 1500);
      await h.sleep(5000);
    },
  },  smoke1: {
    url: '/#/queue',
    say:
      'The findings are medium, so they do not block the merge, but the second task will put this code behind an HTTP server, and I will want it to enforce length limits. ' +
      'The second check is the smoke test, which starts the real app and calls it. This task is only a library, with no server yet, so there is nothing to start. ' +
      'I override the check, and I have to write down why. The reason stays with the pull request.',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'T1:' });
      await ask.waitFor({ timeout: 30000 });
      await h.move(ask.getByTestId('security'));
      await h.sleep(5000);
      await h.scrollBy(-250, 2000);
      const smoke = ask.getByTestId('smoke');
      await h.move(smoke);
      await h.sleep(5000);
      await h.click(smoke.getByRole('button', { name: 'Override with a reason' }));
      await h.type(
        smoke.getByLabel('Why the smoke test is overridden'),
        'Library only: there is no server to start until task T2.',
        30,
      );
      await h.sleep(1000);
      await h.click(smoke.getByRole('button', { name: 'Override', exact: true }));
      await h.sleep(3000);
    },
  },
  approvepr1: {
    url: '/#/queue',
    say:
      'Now the approval is unblocked. The diagram shows the agent checks passed, and the smoke test and security review are accounted for. ' +
      'I add a comment for the engineer, and approve. The gate will wait for the repository checks, then merge the pull request.',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'T1:' });
      await ask.waitFor({ timeout: 30000 });
      await h.move(ask.getByTestId('review-flow'));
      await h.sleep(5000);
      await h.type(ask.getByLabel('Comment'), 'Looks right. Add length limits when the server lands.', 30);
      await h.sleep(800);
      await h.click(ask.getByRole('button', { name: 'Approve' }));
      await h.sleep(4000);
    },
  },
  buildwait2: {
    url: '/#/map',
    lapse: true,
    say:
      'The gate merges the first task once the checks pass, and the second task starts. It depends on the first, so it builds on the merged code. ' +
      'Again this is a real agent run, so I am speeding it up.',
    async run(h) {
      const p = h.page;
      await p.getByLabel('Initiative').selectOption({ label: 'Expense splitter app' });
      await h.waitUntil('the T2 review', async () => {
        const list = await (await p.request.get(BASE + '/api/interactions')).json();
        return list.some((i) => i.initiativeTitle === 'Expense splitter app' && /T2:/.test(i.title));
      }, 2_400_000, 5000);
    },
  },  reviewpr2: {
    url: '/#/queue',
    say:
      'The second task is the server and the web page, and its pull request is ready. This is the final task of the plan, so every smoke check from the design applies to it. ' +
      'I start all three checks. The security review runs right away. The smoke test starts the real app in its own container on AWS and calls it. ' +
      'And the platform can run the pull request as a live preview, so I can try the app myself before I approve.',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'T2:' });
      await ask.waitFor({ timeout: 30000 });
      await h.move(ask.getByRole('heading', { level: 3 }));
      await h.sleep(5000);
      await h.scrollBy(520, 3000);
      await h.click(ask.getByRole('button', { name: 'Run the security review' }));
      await h.sleep(1500);
      await h.click(ask.getByRole('button', { name: 'Run the smoke test' }));
      await h.sleep(1500);
      await h.click(ask.getByRole('button', { name: 'Run it here' }));
      await h.sleep(3000);
    },
  },
  checkswait: {
    url: '/#/queue',
    lapse: true,
    say:
      'While those run, the card keeps updating. The smoke test and the preview each take a minute or two, because each one is a fresh container that has to start, check out the code, and run it.',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'T2:' });
      await ask.waitFor({ timeout: 30000 });
      await h.move(ask.getByTestId('security'));
      await h.waitUntil('the checks', async () => {
        const st = async (id) => (await ask.getByTestId(id).getAttribute('data-state')) ?? 'none';
        const [a, b, c] = [await st('security'), await st('smoke'), await st('preview')];
        console.log('  states', a, b, c);
        const done = (s) => !['none', 'running', 'pending', 'starting', 'queued', 'unknown'].includes(s);
        return done(a) && done(b) && done(c);
      }, 900000, 5000);
    },
  },  reviewchecks2: {
    url: '/#/queue',
    say:
      'The smoke test passed all four checks: it called the home page and both API endpoints, and ran the test suite. ' +
      'The security review reports four medium findings, such as numbers written into the page without escaping, and no limit on the size of a request. None is high or critical, so none blocks the merge, but they stay on the record. ' +
      'Now I start the preview, so I can try the app myself.',
    async run(h) {
      const p = h.page;
      const ask = p.getByTestId('ask').filter({ hasText: 'T2:' });
      await ask.waitFor({ timeout: 30000 });
      await h.move(ask.getByTestId('smoke'));
      await h.sleep(7000);
      await h.move(ask.getByTestId('security'));
      await h.sleep(2000);
      await h.scrollBy(300, 6000);
      await h.sleep(2000);
      const prev = ask.getByTestId('preview');
      await h.move(prev);
      await h.click(prev.getByRole('button', { name: /Run it (again|here)/ }));
      await h.waitUntil('the preview', async () => (await ask.getByTestId('preview').getAttribute('data-state')) === 'ready', 240000, 2000);
      await h.sleep(2500);
    },
  },  newinitiative: {
    url: '/#/map',
    say:
      'Now the idea. I create an initiative: a title, the repository, and a goal in plain words. ' +
      'I choose guided mode, so a person reviews every pull request. The goal is a small expense splitter: a web page and a small JSON API.',
    async run(h) {
      const p = h.page;
      const card = p.locator('form').filter({ has: p.getByRole('heading', { name: 'New initiative' }) });
      await h.type(card.getByLabel('Title'), 'Expense splitter app');
      await p.getByLabel('How much runs on its own').selectOption('guided');
      await h.type(card.getByLabel('Goal'), GOAL, 12);
      await h.sleep(1500);
      await h.click(card.getByRole('button', { name: 'Create' }));
      await h.sleep(2500);
    },
  },
};

await main(scenes);
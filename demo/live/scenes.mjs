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
      await p.getByLabel('Initiative').selectOption({ label: 'Expense splitter' });
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
      await p.getByLabel('Initiative').selectOption({ label: 'Expense splitter' });
      await h.waitUntil('a review is waiting', async () => {
        const list = await (await p.request.get(BASE + '/api/interactions')).json();
        return list.some((i) => i.initiativeTitle === 'Expense splitter' && i.type === 'review');
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
  },  newinitiative: {
    url: '/#/map',
    say:
      'Now the idea. I create an initiative: a title, the repository, and a goal in plain words. ' +
      'I choose guided mode, so a person reviews every pull request. The goal is a small expense splitter: a web page and a small JSON API.',
    async run(h) {
      const p = h.page;
      const card = p.locator('form').filter({ has: p.getByRole('heading', { name: 'New initiative' }) });
      await h.type(card.getByLabel('Title'), 'Expense splitter');
      await p.getByLabel('How much runs on its own').selectOption('guided');
      await h.type(card.getByLabel('Goal'), GOAL, 12);
      await h.sleep(1500);
      await h.click(card.getByRole('button', { name: 'Create' }));
      await h.sleep(2500);
    },
  },
};

await main(scenes);
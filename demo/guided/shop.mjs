// The e-commerce demo: an online shop on DynamoDB, built in two stages (the second adds features to the first).
// Run with:  DEMO_WORK=shop DEMO_SCENES=./shop.mjs node demo/guided/shop.mjs <scene ids>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './record.mjs';
import { scenes as base, setTitle, act, pickInitiative } from './scenes.mjs';
import { via, waitFor, askFor, allowProtected, setNow, checks } from './tickets.mjs';

export const TITLE1 = 'Harbor Goods online shop';
export const TITLE2 = 'Discounts, stock limits and order history';

export const GOAL1 = [
  'Build a small online shop called Harbor Goods: a web page plus a JSON API, with all data kept in Amazon DynamoDB.',
  'Who and what: shoppers are anonymous, identified only by a cart id that the page keeps. They browse products, add them to a cart, change quantities, and check out with an email address and a card number. Shop staff and an admin area are out of scope for this first version. A product has a sku, a name, a description, a price in cents and a number of units in stock. A cart belongs to a cart id and holds lines of sku and quantity. An order has an id, the customer\u2019s email, its lines (sku, name, unit price, quantity), a total in cents, a status and a created time.',
  'Rules: a line holds 1 to 10 units, and never more than are in stock. The prices always come from the product at checkout, never from the page. Checkout is all or nothing: it takes the units off every product and writes the order in one DynamoDB transaction, and answers 409 with a clear message if any product no longer has enough stock. Payment is simulated and calls no outside service: a card number ending in 0000 is declined with 402, any other number is approved. An approved order has the status paid.',
  'What I must be able to do: list the products, open one product, put items in a cart, see the cart with line totals and a grand total, check out, and look an order up by its id.',
  'Data: use one DynamoDB table. Take its name from the TABLE_NAME environment variable and the region from AWS_REGION, with the default AWS credential chain and no keys in code. Use a single-table design with partition key PK and sort key SK. If the table does not exist when the app starts, create it with on-demand billing and wait until it is ACTIVE before reporting ready. On the first start, if the table holds no products, seed eight sample products, so the shop is never empty. Use the AWS SDK for JavaScript v3. Unit tests must not call AWS, so mock the client.',
  'Portability: this shop is intentionally built for AWS, but I want it to be easy to move to another cloud later. Put all data access behind one small interface in src/data (list and get products, cart operations, place an order, get an order). The DynamoDB version lives in a single file, and that file is the only one that imports the AWS SDK. Moving to another provider then means writing one new adapter.',
  'Keep it plain: Node, one HTML page, relative URLs, at most four tasks.',
].join('\n\n');
export const LINKS1 = [
  'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html',
  'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-general-nosql-design.html',
].join('\n');

export const GOAL2 = [
  'Add three things to the Harbor Goods shop that is already in this repository.',
  'Discount codes: a code has a name, a percent off from 1 to 90, an optional expiry date and a maximum number of uses. The cart accepts one code and shows the discount and the new total. Checkout applies the code and counts the use inside the same DynamoDB transaction as the order. An unknown, expired or used-up code gets a clear 400. Seed two codes: WELCOME10 (10 percent, no expiry, 100 uses) and SUMMER25 (25 percent, expires 2026-12-31, 5 uses).',
  'Stock labels: the product list shows "Only N left" when 5 or fewer units remain, and "Sold out" with the add button disabled at 0.',
  'Order history: look up all the orders for an email address, newest first, in a section of the page. A paid order can be cancelled, which puts its units back in stock in one transaction. A cancelled order cannot be cancelled again.',
  'Use the existing DynamoDB table and the existing data interface, and add the new access to it. Keep the existing tests passing and add tests for the new rules. At most three tasks.',
].join('\n\n');

/** Open a task's pull request and run the security review, and the smoke test when the repository has one. */
const checks2 = (key, title, intro, smokeSay) => ({
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
      'I click Run the security review, so a model reads the diff. It is not Claude Code: the reviewer is a model read through the platform gateway, so a second reader looks at the work of the first.',
      () => h.click(ask.getByRole('button', { name: 'Run the security review' }), { label: 'Run the security review', why: 'A model reads the diff and reports findings.' }),
    );
    const smokeBtn = ask.getByRole('button', { name: 'Run the smoke test' });
    const hasSmoke = (await smokeBtn.count()) > 0;
    if (hasSmoke)
      await act(h, smokeSay ?? 'And I click Run the smoke test, so the platform starts the real app from this pull request, with its own DynamoDB table, and calls it.', () =>
        h.click(smokeBtn, { label: 'Run the smoke test', why: 'Start the real app and call it.' }),
      );
    await h.sleep(4000);
    await h.waitUntil(
      'the checks',
      async () => {
        const st = async (id) => ((await ask.getByTestId(id).count()) ? ((await ask.getByTestId(id).getAttribute('data-state')) ?? 'none') : 'absent');
        const [a, b] = [await st('security'), hasSmoke ? await st('smoke') : 'absent'];
        console.log('  states', a, b);
        const done = (s) => !['none', 'running', 'pending', 'starting', 'queued', 'unknown'].includes(s);
        return done(a) && done(b);
      },
      900000,
      4000,
    );
    await h.point(ask.getByTestId('security'), 'The security review', 'Only high or critical findings block.', 3000);
  },
});
const T1 = () => setNow(TITLE1);
const T2 = () => setNow(TITLE2);
setNow(process.env.DEMO_STAGE === '2' ? TITLE2 : TITLE1);

export const scenes = {
  intro: {
    anon: true,
    url: '/',
    title: 'Autonomous SDLC',
    async run(h) {
      const talk = h.say(
        'This is Autonomous SDLC, a platform where AI agents build software and people stay in charge. ' +
          'Agents write the spec, design the solution, build each task in a sandbox, and open pull requests. Each of those agents is driven by Claude Code, Anthropic\u2019s coding agent, running inside its own isolated container, with every model call going through the platform\u2019s gateway so that it is metered and capped. People decide at clear checkpoints. ' +
          'In this video I build an online shop, in two stages: first the shop itself, then a second initiative that adds features to it. ' +
          'One thing to say up front. This platform, and the apps it builds here, are intentionally made for Amazon Web Services, so that adoption is as easy as possible: one cloud account, one set of services, a few clicks. ' +
          'It is not locked in. The agents, the model gateway and GitHub are cloud neutral, and I will ask the agents to keep every call to AWS in a single file, so that moving the shop to another cloud later is a refactor, not a rewrite. ' +
          'For every click, and every change of tab, I will say what I do and why. And whenever the agents propose a change, the platform runs it as a live, isolated, testable version of the application, so I can try it before I approve it.',
      );
      await h.sleep(3000);
      await h.scrollBy(1500, 14000);
      await talk;
    },
  },
  signin: base.signin,
  tour: {
    url: '/',
    title: '1 \u00b7 A quick tour of the tabs',
    async run(h) {
      await h.say('Before I start, a quick tour of the tabs I will use. The left menu is the tab bar, and each tab is a different view of the same work.');
      await act(
        h,
        'The Portfolio tab lists every initiative with its stage and its cost. It is empty, because this is a fresh deployment.',
        () => h.tab('Portfolio', 'Every initiative, its stage and its cost, in one place.'),
      );
      await h.sleep(1200);
      await act(
        h,
        'The Integrations tab is the register of outside systems that agents may call, with documentation links that the platform hands to the agents. Amazon DynamoDB is not in it yet, so we will see an agent ask for it.',
        () => h.tab('Integrations', 'The outside systems agents may call, and their documentation.'),
      );
      await h.sleep(1200);
      await act(
        h,
        'The Costs tab shows what every agent run costs, against a budget. I will come back to it at the end.',
        () => h.tab('Costs', 'Spend by day, by agent and by model.'),
      );
      await h.sleep(1200);
      await act(
        h,
        'And the Map tab is where I give the platform a goal and drive it through each stage.',
        () => h.tab('Map', 'Give the platform a goal, and drive it stage by stage.'),
      );
      await h.sleep(1200);
    },
  },

  newinitiative: {
    url: '/#/map',
    title: '2 \u00b7 Stage 1: give the platform a goal',
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
        'Now the goal, written the way a product owner briefs a team. It says who the shoppers are, what a product, a cart and an order are, the rules of checkout, and how the data is stored: one DynamoDB table. And near the end, one sentence about the cloud. The shop is intentionally built for AWS, and I ask that every call to AWS live in a single file behind a small interface, so that moving to another cloud later means writing one new adapter.',
        () => h.type(form.getByLabel('Goal'), GOAL1, { label: 'Type the goal', why: 'A real brief, not a one-liner.', delay: 3 }),
      );
      await act(
        h,
        'Then the reference links. The shop has to call Amazon DynamoDB, an outside system, so I paste two pages of its documentation, one about transactions and one about table design. Every agent is told about these links.',
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
  specwait: {
    url: '/#/map',
    lapse: true,
    title: '4 \u00b7 The product agent works',
    async run(h) {
      const p = h.page;
      T1();
      h.say(
        'While the agent works, the map stays current. Nothing here is faked. The product agent is Claude Code, running in its own container on AWS Fargate. It reads the goal, writes user stories with acceptance criteria, and opens a pull request with the spec. Every model call goes through the platform\u2019s gateway, which meters it. This takes a few minutes, so I am speeding it up.',
      );
      await pickInitiative(h);
      await h.waitUntil(
        'a review is waiting',
        async () => (await (await p.request.get('https://app.agentonomous.com/api/interactions')).json()).some((i) => i.initiativeTitle === TITLE1 && i.type === 'review'),
        1_200_000,
        5000,
      );
    },
  },
  reviewspec: via(T1, 'reviewspec'),
  startdesign: via(T1, 'startdesign'),
  designwait: via(T1, 'designwait'),
  reviewdesign: via(T1, 'reviewdesign'),
  startbuild: via(T1, 'startbuild'),
  buildwait1: waitFor(
    'a decision',
    '10 \u00b7 The agents start, and ask about DynamoDB',
    'The plan has four tasks, built one after another where they depend on each other. The first engineer agent is Claude Code, running in an isolated Fargate container with only this repository checked out. Before it writes any code that talks to DynamoDB, it stops and asks me something. I am speeding up the wait.',
    (i) => i.type === 'decision' && /external system|region/i.test(i.title),
  ),

  integration: {
    url: '/#/map',
    title: '11 \u00b7 A hard stop: a new outside system, on AWS',
    async run(h) {
      const p = h.page;
      T1();
      await act(
        h,
        'An agent has stopped. I switch to the Attention queue tab, because that is where anything waiting for a person lands.',
        () => h.tab('Attention queue', 'An agent is stopped and waiting for me.'),
      );
      const ask = askFor(p, 'New external system');
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The agent wants to call Amazon DynamoDB, and it is not in the Integration Register, so the platform will not let it open that connection until a person confirms. This is a hard stop. The card says which host, why, and which documentation the agent relies on: the two links I gave when I created the initiative.',
        () => h.point(ask.getByRole('heading', { level: 3 }), 'New external system: Amazon DynamoDB', 'Agents may call it only after a person confirms.', 9000),
      );
      await act(
        h,
        'This is the AWS part of the platform being intentional. The apps it builds here default to AWS services, which are already in the same account as the platform, so adopting it takes no extra accounts or credentials. Another provider would be one more entry in this register, plus a new adapter in the app.',
        () => h.sleep(500),
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
    title: '12 \u00b7 Review the first task: rules and the data interface',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T1:');
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The first task is done, and its pull request is waiting in the Attention queue, the tab I am on. It holds the shop rules and the small data interface I asked for, which is the one place the rest of the app talks to its data. So far its tests run without any cloud at all. The card shows what changed, and the agent\u2019s own summary.',
        async () => {
          await h.point(ask.getByRole('heading', { level: 3 }), 'The first task, as a pull request', 'Built by the backend engineer agent.', 4500);
          await h.scrollBy(450, 6000);
        },
      );
      await act(
        h,
        'This diagram shows what stands between a change and the merge: the agent\u2019s own checks, a smoke test, a security review, my decision, repository CI, and then the gate. This task has no running server yet, so there is no smoke test for it. I click Run the security review, so a model reads the diff.',
        () => h.click(ask.getByRole('button', { name: 'Run the security review' }), { label: 'Run the security review', why: 'A model reads the diff and reports findings.' }),
      );
      await h.sleep(4000);
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
        'The review is back with one low finding: the lower layers trust quantities, and the server, which comes in a later task, must validate them first. It does not block the merge, and I will make sure the server task covers it.',
        () => h.point(ask.getByTestId('security'), 'The security review: one low finding', 'Only high or critical findings block.', 9000),
      );
      await act(
        h,
        'I add a comment so the next engineer sees it, and click Approve, because the rules and the interface are what I asked for.',
        async () => {
          await h.type(ask.getByLabel('Comment'), 'Good. The server task must validate quantities before they reach the data layer.', { label: 'Type a comment', why: 'It stays with the decision.', delay: 28 });
          await h.click(ask.getByRole('button', { name: 'Approve' }), { label: 'Approve the first task', why: 'Rules and interface are what I asked for.' });
        },
      );
      await h.sleep(3500);
    },
  },
  t2wait: waitFor(
    'T2 needs a person',
    '13 \u00b7 The second task starts',
    'The gate waits for the repository\u2019s CI, merges the first task, and the second task starts on top of it: the DynamoDB adapter, the one file that talks to AWS. A few minutes, sped up.',
    (i) => (i.type === 'review' && /T2:/.test(i.title)) || /Protected path|May I/.test(i.title) || i.type === 'decision',
  ),
  protected1: allowProtected('14 \u00b7 A hard stop: a protected file', true),
  p2wait: waitFor(
    'the next review',
    '15 \u00b7 Two tasks build in parallel',
    'Two engineer agents are now working at the same time, because neither task depends on the other: the DynamoDB adapter and the server. Each runs Claude Code in its own container. A few minutes, sped up.',
    (i) => i.type === 'review' || /Protected path|May I/.test(i.title),
  ),
  t2a: checks2(
    'T2:',
    '16 \u00b7 Review the DynamoDB adapter',
    'The DynamoDB adapter is ready, and its pull request is in the Attention queue, the tab I am on. This is the one file that talks to AWS, behind the interface I asked for. Everything else in the shop stays cloud neutral. This is also where the checkout transaction lives: take the stock off every product and write the order, all or nothing.',
    'And I click Run the smoke test, so the platform starts the app from this pull request and calls it.',
  ),
  t2b: {
    url: '/#/queue',
    title: '17 \u00b7 Approve the DynamoDB adapter',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T2:');
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The security review found nothing. It read the adapter and noted that every call to DynamoDB goes through the SDK with parameters, never through strings put together by hand. This is the only file that imports the AWS SDK, as I asked, so this is the file someone would replace to move the shop to another cloud. There is nothing running to try yet, because the server is a different task, so I add a comment and approve.',
        async () => {
          await h.point(ask.getByTestId('security'), 'Security review: no findings', 'Nothing to report.', 9000);
        },
      );
      await act(
        h,
        'I type a short comment, and click Approve, because the adapter is what I asked for and the review is clean.',
        async () => {
          await h.type(ask.getByLabel('Comment'), 'Adapter is what I asked for. AWS stays in this one file.', { label: 'Type a comment', why: 'It stays with the decision.', delay: 28 });
          await h.click(ask.getByRole('button', { name: 'Approve' }), { label: 'Approve the adapter', why: 'The adapter is right and the review is clean.' });
        },
      );
      await h.sleep(3500);
    },
  },
  t3a: checks2(
    'T3:',
    '18 \u00b7 Review the server',
    'The third task, the HTTP server with the product, cart, checkout and order routes, is ready, and its pull request is in the Attention queue, the tab I am on. This is the first change with a program that can actually start, so this time the platform can run more than a model reading the diff.',
    'And I click Run the smoke test. The platform starts the real server from this pull request in a fresh container, with a DynamoDB table of its own, and calls it with the checks the design listed. It is the server answering requests, not a unit test with a mock.',
  ),
  t3b: {
    url: '/#/queue',
    title: '19 \u00b7 Results: two low findings, dismissed with reasons',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T3:');
      await ask.waitFor({ timeout: 30000 });
      const sec = ask.getByTestId('security');
      await act(
        h,
        'Both checks are back. The smoke test started the real server and passed all six checks: the health check, the home page, the product list from the data layer, one product, and an unknown product that correctly answers not found. The security review found two low findings, and the first says what the review is for: a cart is protected only by its id, and anyone who guesses an id could use that cart.',
        async () => {
          await h.scrollBy(500, 2500);
          await h.point(ask.getByTestId('smoke'), 'Smoke test: 6 of 6 passed', 'The real server, started and called.', 6500);
          await h.point(sec, 'Security review: two low findings', 'Only high or critical findings block the merge.', 8000);
        },
      );
      await act(
        h,
        'This shop has no accounts, and a cart holds only product ids and quantities, nothing personal. So I accept the first finding, and dismiss it with a reason, so that the decision stays on the record. I click Dismiss with a reason.',
        () => h.click(sec.getByRole('button', { name: /Dismiss F1 with a reason/ }), { label: 'Dismiss F1 with a reason', why: 'A risk I accept, on the record.' }),
      );
      await act(
        h,
        'I type the reason, and confirm with Dismiss.',
        async () => {
          await h.type(sec.getByLabel('Why F1 is dismissed'), 'Anonymous carts hold only sku and quantity. Accounts are out of scope for this version.', { label: 'Type the reason', why: 'It stays with the pull request.', delay: 24 });
          await h.click(sec.getByRole('button', { name: 'Dismiss', exact: true }), { label: 'Dismiss', why: 'Record the reason.' });
        },
      );
      await h.sleep(1500);
      await act(
        h,
        'The second finding says nothing limits how many carts a client can create. That is a fair point for a real shop, but it is a hardening task for later, so I dismiss it with a reason as well.',
        () => h.click(sec.getByRole('button', { name: /Dismiss F2 with a reason/ }), { label: 'Dismiss F2 with a reason', why: 'Later hardening, on the record.' }),
      );
      await act(
        h,
        'Again a reason, and Dismiss.',
        async () => {
          await h.type(sec.getByLabel('Why F2 is dismissed'), 'Rate limits and cart expiry are a hardening task for after this demo.', { label: 'Type the reason', why: 'It stays with the pull request.', delay: 24 });
          await h.click(sec.getByRole('button', { name: 'Dismiss', exact: true }), { label: 'Dismiss', why: 'Record the reason.' });
        },
      );
      await h.sleep(1500);
      await act(
        h,
        'Now I add a comment and click Approve, because the server does what the task asked, and every check is accounted for.',
        async () => {
          await h.type(ask.getByLabel('Comment'), 'Server works against the interface. Approved.', { label: 'Type a comment', why: 'It stays with the decision.', delay: 28 });
          await h.click(ask.getByRole('button', { name: 'Approve' }), { label: 'Approve the server', why: 'The server works and the checks are accounted for.' });
        },
      );
      await h.sleep(3500);
    },
  },
  t4wait: waitFor(
    'T4 needs a person',
    '20 \u00b7 The last task: the web page',
    'The gate merges the server, and the last task starts: the web page that shoppers use. A few minutes, sped up.',
    (i) => (i.type === 'review' && /T4:/.test(i.title)) || /Protected path|May I/.test(i.title) || i.type === 'decision',
  ),
  t4a: checks2(
    'T4:',
    '21 \u00b7 Review the last task: the shop page',
    'The last task of the plan, the web page that shoppers use, is ready, in the Attention queue, the tab I am on. Because it is the last task, every smoke check the approved design listed applies to it. And because it is a page, I can do something better than reading the diff.',
    'And I click Run the smoke test, so the platform starts the whole shop, page and API, with a DynamoDB table of its own, and calls it.',
  ),
  t4b: {
    url: '/#/queue',
    title: '22 \u00b7 All checks green: start the live preview',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T4:');
      await ask.waitFor({ timeout: 30000 });
      const sec = ask.getByTestId('security');
      await act(
        h,
        'All six smoke checks passed on the whole shop, and the security review found no cross-site scripting: the page puts everything in as plain text. It has one low finding, about browser headers on the checkout page. That is hardening for later, so I dismiss it with a reason.',
        async () => {
          await h.scrollBy(500, 2500);
          await h.point(ask.getByTestId('smoke'), 'Smoke test: 6 of 6 passed', 'The whole shop, started and called.', 5000);
          await h.point(sec, 'Security review: one low finding', 'Only high or critical findings block the merge.', 6000);
        },
      );
      await act(
        h,
        'I click Dismiss with a reason, type it, and confirm.',
        async () => {
          await h.click(sec.getByRole('button', { name: /Dismiss F1 with a reason/ }), { label: 'Dismiss F1 with a reason', why: 'Hardening for later, on the record.' });
          await h.type(sec.getByLabel('Why F1 is dismissed'), 'Browser security headers are a hardening task for after this demo.', { label: 'Type the reason', why: 'It stays with the pull request.', delay: 24 });
          await h.click(sec.getByRole('button', { name: 'Dismiss', exact: true }), { label: 'Dismiss', why: 'Record the reason.' });
        },
      );
      await h.sleep(1500);
      const prev = ask.getByTestId('preview');
      await act(
        h,
        'Now the most important step. I do not approve a shop I have only read. I click Run it, and the platform starts this pull request as a live, isolated, testable version of the application: its own container, its own network, and its own DynamoDB table, created for this preview alone and deleted when the preview stops.',
        () => h.click(prev.getByRole('button', { name: /Run it (again|here)/ }), { label: 'Run the preview', why: 'A live, isolated version I can use.' }),
      );
      await h.waitUntil('the preview', async () => (await prev.getAttribute('data-state')) === 'ready', 420000, 2000);
      await h.sleep(1500);
    },
  },
  t4c: {
    url: '/#/queue',
    title: '23 \u00b7 I check where the data lives: send it back',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T4:');
      await ask.waitFor({ timeout: 30000 });
      const prev = ask.getByTestId('preview');
      await act(
        h,
        'The preview is running, and before I click around in it, I check one thing: where does its data live? The platform gives every preview its own DynamoDB table, and I asked for a shop that stores everything in DynamoDB. But when I read the preview file that the agent wrote, its start command says data backend equals memory. The app would use a list in memory, and the table the platform made for it would sit unused. The smoke tests would pass either way, and so would my click-through, without proving that the shop works on DynamoDB.',
        async () => {
          await h.point(prev, 'The preview is running', 'But on which data store?', 9000);
          await h.scrollBy(-300, 1500);
        },
      );
      await act(
        h,
        'That is exactly the kind of thing a green check does not tell you. So I do not approve. In the Comment box, I say what is wrong, and what I want instead.',
        () =>
          h.type(
            ask.getByLabel('Comment'),
            'The preview file starts the app with DATA_BACKEND=memory, so the live preview never uses DynamoDB. Remove that setting so the app uses the DynamoDB adapter with the TABLE_NAME and AWS_REGION of the preview, and make sure the smoke checks pass against it.',
            { label: 'Type a comment', why: 'It goes to the engineer agent with the task.', delay: 14 },
          ),
      );
      await act(
        h,
        'Then I click Request changes. That sends the task back to the same engineer in a fresh container, with my words added to its instructions. Nothing merges while it works.',
        () => h.click(ask.getByRole('button', { name: 'Request changes' }), { label: 'Request changes', why: 'Send it back with my comment.' }),
      );
      await h.sleep(3000);
    },
  },
  t4wait2: waitFor(
    'a protected path',
    '24 \u00b7 The engineer fixes the preview file',
    'The engineer starts the page task again in a fresh container. It goes to change the preview file, which is protected, so the platform stops it. A few minutes, sped up.',
    (i) => /Protected path|May I/.test(i.title) || (i.type === 'review' && /T4:/.test(i.title)),
  ),
  t4ask: {
    url: '/#/map',
    title: '25 \u00b7 The agent asks before touching a protected file',
    async run(h) {
      const p = h.page;
      await act(
        h,
        'The engineer has a question, so I switch to the Attention queue tab, because that is where an agent waits for me.',
        () => h.tab('Attention queue', 'An agent is waiting for my answer.'),
      );
      const ask = askFor(p, 'The reviewer wants DATA_BACKEND');
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'It understood my comment, and it asks for permission before it acts: the preview file is protected, so may it edit that one line? It even warns me that the preview then needs the table name, the region and credentials in its environment. That is exactly what the platform provides. I choose yes, because this is the one edit I asked for.',
        async () => {
          await h.point(ask.getByRole('heading', { level: 3 }), 'May I edit the protected preview file?', 'Exactly the edit I asked for.', 8000);
          await h.click(ask.getByRole('radio', { name: /Yes, edit/ }), { label: 'Choose: Yes, edit the start line only', why: 'It is the edit I asked for.' });
        },
      );
      await act(h, 'And I click Answer.', () => h.click(ask.getByRole('button', { name: 'Answer' }), { label: 'Answer', why: 'Send the decision to the agent.' }));
      await h.sleep(2500);
    },
  },
  t4prot: allowProtected('26 \u00b7 The platform\u2019s own hard stop on the same file', false),
  t4wait3: waitFor(
    'the T4 review',
    '27 \u00b7 The page task is rebuilt',
    'The agent keeps the edit, runs the checks, and opens the pull request again. A few minutes, sped up.',
    (i) => i.type === 'review' && /T4:/.test(i.title),
  ),
  t4d: checks2(
    'T4:',
    '28 \u00b7 Run every check on the new commit',
    'The new pull request is in the Attention queue, the tab I am on. It is a new commit, so nothing has run on it yet: the old results do not count. I run the checks again, and this time the smoke test starts the shop on its DynamoDB table.',
    'And I click Run the smoke test, to start the whole shop again, now on DynamoDB, and call it.',
  ),
  t4e: {
    url: '/#/queue',
    title: '29 \u00b7 The reviewer asks the right question',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T4:');
      await ask.waitFor({ timeout: 30000 });
      const sec = ask.getByTestId('security');
      await act(
        h,
        'The smoke test passes again, six of six, this time with the shop running on DynamoDB. And look at the security review. It noticed what I noticed: the preview now runs unreviewed code against DynamoDB, and it asks the right question: is that table isolated? It is a medium finding, but it is a question, and I know the answer.',
        async () => {
          await h.scrollBy(500, 2500);
          await h.point(ask.getByTestId('smoke'), 'Smoke test: 6 of 6 passed', 'Now on DynamoDB.', 5000);
          await h.point(sec, 'Security review: a fair question about the preview', 'Is the preview\u2019s table isolated?', 11000);
        },
      );
      await act(
        h,
        'It is isolated. The platform gives each preview its own table, named for that preview alone, and a role that can only touch tables with that prefix, through an endpoint that allows only those tables. When the preview stops, the table is deleted. So I dismiss the finding with that reason, and the answer stays on the record. I click Dismiss with a reason.',
        () => h.click(sec.getByRole('button', { name: /Dismiss F1 with a reason/ }), { label: 'Dismiss F1 with a reason', why: 'I know the answer, on the record.' }),
      );
      await act(
        h,
        'I type the reason and confirm.',
        async () => {
          await h.type(sec.getByLabel('Why F1 is dismissed'), 'Each preview gets its own DynamoDB table and a role limited to that table prefix. The table is deleted when the preview stops.', {
            label: 'Type the reason',
            why: 'It stays with the pull request.',
            delay: 22,
          });
          await h.click(sec.getByRole('button', { name: 'Dismiss', exact: true }), { label: 'Dismiss', why: 'Record the reason.' });
        },
      );
      await h.sleep(1500);
      await act(
        h,
        'The second finding is the same low note about browser headers that I dismissed before, so I dismiss it again.',
        async () => {
          await h.click(sec.getByRole('button', { name: /Dismiss F2 with a reason/ }), { label: 'Dismiss F2 with a reason', why: 'Hardening for later.' });
          await h.type(sec.getByLabel('Why F2 is dismissed'), 'Browser security headers are a hardening task for after this demo.', { label: 'Type the reason', why: 'It stays with the pull request.', delay: 24 });
          await h.click(sec.getByRole('button', { name: 'Dismiss', exact: true }), { label: 'Dismiss', why: 'Record the reason.' });
        },
      );
      await h.sleep(1500);
      const prev = ask.getByTestId('preview');
      await act(
        h,
        'Now the step that matters. I click Run it, and the platform starts this pull request as a live, isolated, testable version of the shop, with its own DynamoDB table.',
        () => h.click(prev.getByRole('button', { name: /Run it (again|here)/ }), { label: 'Run the preview', why: 'A live, isolated version I can use.' }),
      );
      await h.waitUntil('the preview', async () => (await prev.getAttribute('data-state')) === 'ready', 420000, 2000);
      await h.sleep(1500);
    },
  },
  t4f: {
    url: '/#/queue',
    title: '30 \u00b7 Use the shop in its live, isolated version',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T4:');
      await ask.waitFor({ timeout: 30000 });
      const href = await ask.getByTestId('preview').getByRole('link').first().getAttribute('href');
      await act(
        h,
        'The preview is ready, and the card has a link to it. I open it in its own browser tab, because it is a separate address from the platform: it is the shop itself, running in its own container, with a DynamoDB table that nobody else can see, and only I can reach it.',
        () => h.browserTab('The live preview of the shop', 'The real shop, isolated, on its own DynamoDB table.', href),
      );
      await p.locator('#product-list li').first().waitFor({ timeout: 90000 });
      await act(
        h,
        'This is Harbor Goods. The app found its table empty, so it created the table, and it seeded eight sample products into it. Everything on this page is read from DynamoDB, in this one preview, and nothing I do here touches anything real.',
        () => h.point(p.locator('#product-list'), 'Eight products, read from DynamoDB', 'Seeded by the app on its first start.', 7000),
      );
      await act(
        h,
        'I add two mugs and the brass ship bell to my cart. I click Add to cart on the mug, twice, and then on the bell.',
        async () => {
          const mug = p.getByRole('button', { name: 'Add Enamel Camp Mug to cart' });
          await h.click(mug, { label: 'Add the mug to the cart', why: 'First of two mugs.' });
          await h.sleep(900);
          await h.click(mug, { label: 'Add the mug again', why: 'A second mug.' });
          await h.sleep(900);
          await h.click(p.getByRole('button', { name: 'Add Brass Ship Bell to cart' }), { label: 'Add the bell to the cart', why: 'A third item.' });
          await h.sleep(900);
        },
      );
      await act(
        h,
        'I open the cart, because that is where the totals and the checkout form are.',
        () => h.click(p.locator('#nav-cart'), { label: 'Open the cart', why: 'See totals, then check out.' }),
      );
      await p.locator('#cart-contents').waitFor({ timeout: 15000 });
      await h.sleep(1200);
      await act(
        h,
        'The cart shows each line and the grand total. The prices are not taken from this page: the server reads them from the product table when I check out.',
        () => h.point(p.locator('#cart-contents'), 'The cart, with totals', 'Prices come from the server at checkout.', 6000),
      );
      await act(
        h,
        'First I try a card that the simulated payment declines, a number that ends in four zeros. I type my email, and the card number.',
        async () => {
          await h.type(p.locator('#checkout-email'), 'sam@example.com', { label: 'Type the email', why: 'Who the order is for.', delay: 40 });
          await h.type(p.locator('#checkout-card'), '4242424242420000', { label: 'Type a card ending in 0000', why: 'The simulated payment declines it.', delay: 40 });
        },
      );
      await act(
        h,
        'I click Place order.',
        () => h.click(p.locator('#checkout-submit'), { label: 'Place order', why: 'Try the declined card.' }),
      );
      await h.sleep(2000);
      await act(
        h,
        'The payment is declined, and the page says so. Nothing was written and no stock was taken, because checkout is all or nothing.',
        () => h.point(p.locator('#error'), 'Payment declined', 'No order. No stock taken.', 5500),
      );
      await act(
        h,
        'Now a card that is approved. I replace the number, and click Place order again.',
        async () => {
          await p.locator('#checkout-card').fill('');
          await h.type(p.locator('#checkout-card'), '4242424242421111', { label: 'Type an approved card', why: 'Any number not ending in 0000 is approved.', delay: 40 });
          await h.click(p.locator('#checkout-submit'), { label: 'Place order', why: 'Check out with the approved card.' });
        },
      );
      await p.locator('#view-confirmation:not([hidden])').waitFor({ timeout: 20000 });
      await h.sleep(1200);
      await act(
        h,
        'The order is confirmed, with an order number. The server took the stock off the three products and wrote the order, in one DynamoDB transaction.',
        () => h.point(p.locator('#confirmation-detail'), 'Order confirmed', 'Stock and order written in one transaction.', 6500),
      );
      const text = await p.locator('#confirmation-detail').innerText();
      const orderId = (text.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i) ?? [''])[0];
      await act(
        h,
        'I go back to the products, to check the stock. The mug had forty in stock, and now it shows thirty-eight.',
        async () => {
          await h.click(p.locator('#nav-products'), { label: 'Open the products', why: 'See the stock after my order.' });
          await h.sleep(1500);
          await h.point(p.locator('#product-list li').first(), 'Stock went down', '40 mugs became 38.', 5500);
        },
      );
      if (orderId)
        await act(
          h,
          'Last, I look the order up by its number. I open Find an order, paste the number, and click Look up order, and the page reads the order back from DynamoDB.',
          async () => {
            await h.click(p.locator('#nav-lookup'), { label: 'Open Find an order', why: 'Look the order up by its number.' });
            await h.type(p.locator('#lookup-id'), orderId, { label: 'Type the order number', why: 'Read it back from DynamoDB.', delay: 25 });
            await h.click(p.getByRole('button', { name: 'Look up order' }), { label: 'Look up order', why: 'Read the order from the table.' });
            await h.sleep(2200);
            await h.point(p.locator('#lookup-result'), 'The order, read back', 'Stored in DynamoDB.', 5500);
          },
        );
      await act(
        h,
        'The shop works as described, on a real DynamoDB table, in an environment that exists only for this review. Now I go back to the platform tab to decide.',
        () => h.sleep(3500),
      );
    },
  },
  t4g: {
    url: '/#/queue',
    title: '31 \u00b7 Approve the shop page',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T4:');
      await ask.waitFor({ timeout: 30000 });
      await p.evaluate(() => window.__demo.banner('BACK TO THE PLATFORM TAB', 'The platform', 'The decision is made here, not in the preview.', '#ff6fb5', 4500));
      await act(
        h,
        'Back in the platform tab. The card shows every step accounted for on this commit: the agent\u2019s checks, the smoke test, and the security review with my recorded reasons, and nothing blocking. And I have used the shop myself, in its live copy, with its own table, and I saw the declined card, the approved order, and the stock go down. That is why I approve.',
        () => h.point(ask.getByTestId('review-flow'), 'Every step is accounted for', 'Nothing blocks the approval.', 8500),
      );
      await act(
        h,
        'I add a comment, and click Approve.',
        async () => {
          await h.type(ask.getByLabel('Comment'), 'Works end to end on DynamoDB. Next stage: discount codes, stock labels and order history.', { label: 'Type a comment', why: 'It stays with the decision.', delay: 26 });
          await h.click(ask.getByRole('button', { name: 'Approve' }), { label: 'Approve the shop page', why: 'It works on DynamoDB and every step is accounted for.' });
        },
      );
      await h.sleep(3500);
    },
  },
  mergewait: {
    url: '/#/queue',
    lapse: true,
    title: '32 \u00b7 The gate merges',
    async run(h) {
      const p = h.page;
      h.say('The gate waits for the repository\u2019s CI, which installs the packages and passes, merges the pull request, and the plan is complete.');
      await h.sleep(1500);
      await h.tab('Map', 'The map shows when the build is complete.');
      await pickInitiative(h);
      const init = (await (await p.request.get('https://app.agentonomous.com/api/initiatives')).json()).find((x) => x.title === TITLE1);
      await h.waitUntil(
        'the plan is done',
        async () => (await (await p.request.get(`https://app.agentonomous.com/api/initiatives/${init.id}/plan`)).json()).plan?.state === 'done',
        900000,
        5000,
      );
      await h.sleep(3000);
    },
  },
  stage1done: {
    url: '/#/map',
    title: '33 \u00b7 Stage 1 is done',
    async run(h) {
      const p = h.page;
      await pickInitiative(h);
      await act(
        h,
        'All four tasks are merged, and the build stage is done. The repository now holds a working shop: the spec and the design, the rules, the data interface, the one DynamoDB adapter, the server, the page, and the tests, each reviewed by a person at every step.',
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
    title: 'Stage 2 \u00b7 Add features to the shop that exists',
    async run(h) {
      T2();
      await h.say(
        'Stage one is done: a working shop on DynamoDB, built and merged. Now stage two. A real product keeps changing, so I give the platform a second initiative on the same repository, to add features to the shop that is already there. It goes through the same flow: spec, design, build, and every change is again proposed as a live, isolated, testable version of the shop before I approve it.',
      );
      await h.tab('Map', 'A new initiative is created on the Map tab.');
    },
  },
  s2_new: {
    url: '/#/map',
    title: '34 \u00b7 Stage 2: a second initiative',
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
        'The repository is the same one. The agents will read the code that stage one merged, and build on top of it.',
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
        'The goal is a change request: discount codes that the cart accepts and that checkout counts inside the same transaction as the order, labels that say when stock is low or sold out, and an order history with a cancel that puts the stock back. It says to use the existing table and the existing data interface, so that the new access to AWS lands in the same single file, and to keep the existing tests passing.',
        () => h.type(form.getByLabel('Goal'), GOAL2, { label: 'Type the goal', why: 'A change to an existing app.', delay: 3 }),
      );
      await act(
        h,
        'There are no new outside systems this time. DynamoDB is already in the Integration Register, so the agents will not have to ask me about it again. I leave the reference links empty, and click Create.',
        () => h.click(form.getByRole('button', { name: 'Create' }), { label: 'Create', why: 'Record the goal. Nothing starts yet.' }),
      );
      await h.sleep(2500);
    },
  },
  s2_startspec: via(T2, 'startspec', { title: '35 \u00b7 Start the spec' }),
  s2_specwait: via(T2, 'specwait', { title: '36 \u00b7 The product agent works' }),
  s2_reviewspec: via(T2, 'reviewspec', { title: '37 \u00b7 Review and approve the spec' }),
  s2_startdesign: via(T2, 'startdesign', { title: '38 \u00b7 Start the design' }),
  s2_designwait: via(T2, 'designwait', { title: '39 \u00b7 The architect agent works' }),
  s2_reviewdesign: via(T2, 'reviewdesign', { title: '40 \u00b7 Review and approve the design' }),
  s2_startbuild: via(T2, 'startbuild', { title: '41 \u00b7 Start the build' }),
  s2_wait1: waitFor(
    'a person is needed',
    '42 \u00b7 The engineers build the features',
    'The plan again has three tasks. The first engineer agent, Claude Code in a fresh container, reads the code that stage one merged, and builds the rules for discount codes, the order history and the cancel on top of it. This time it did not ask about DynamoDB, because DynamoDB is already in the register. A few minutes, sped up.',
    (i) => i.type === 'review' || /Protected path|May I/.test(i.title) || i.type === 'decision',
  ),
  s2_t1a: checks2(
    'T1:',
    '43 \u00b7 Review the first task of stage 2',
    'The first task of the new initiative is ready, and its pull request is in the Attention queue, the tab I am on. It changes the code that stage one built, rather than writing it from nothing: the rules, the data interface and the test adapter, and it adds tests next to the existing ones.',
    'And I click Run the smoke test, so the platform starts the existing shop from this pull request and calls it, to prove that the new code did not break what stage one delivered.',
  ),
  s2_t1b: {
    url: '/#/queue',
    title: '44 \u00b7 Existing checks still pass: approve',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T1:');
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'All six smoke checks of the existing shop still pass. That matters in a second initiative: the platform proves that the new code did not break what stage one delivered. The security review has one note, only informational: the new calls to cancel an order or list orders trust whoever calls them, so the routes that come in a later task must check who is asking. I keep that in mind for the review of that task.',
        async () => {
          await h.scrollBy(500, 2500);
          await h.point(ask.getByTestId('smoke'), 'Smoke test: 6 of 6 still pass', 'The existing shop is not broken.', 6000);
          await h.point(ask.getByTestId('security'), 'Security review: an informational note', 'Not a blocker.', 8000);
        },
      );
      await act(
        h,
        'This task changes rules and data code only, with no page yet, so there is nothing new to try in a live version. The next tasks will have one. I add a comment, and click Approve.',
        async () => {
          await h.type(ask.getByLabel('Comment'), 'Routes must check who is cancelling or listing orders. Rules look right.', { label: 'Type a comment', why: 'It stays with the decision.', delay: 28 });
          await h.click(ask.getByRole('button', { name: 'Approve' }), { label: 'Approve the first task', why: 'Rules and data code are right; the checks pass.' });
        },
      );
      await h.sleep(3500);
    },
  },
  s2_wait2: waitFor(
    'T2 needs a person',
    '45 \u00b7 The second task starts',
    'The gate waits for CI and merges the first task, and the second task starts on top of it: the DynamoDB side of discount codes, order history and cancel, in the one AWS file. A few minutes, sped up.',
    (i) => (i.type === 'review' && /T2:/.test(i.title)) || /Protected path|May I/.test(i.title) || i.type === 'decision',
  ),
  s2_t2a: checks2(
    'T2:',
    '46 \u00b7 Review the DynamoDB side and the routes',
    'The second task is ready: the DynamoDB side of the new features, in the same single AWS file, together with the routes. It is in the Attention queue, the tab I am on. This is where a discount is counted inside the same transaction as the order, and where a cancel puts the units back in stock.',
    'And I click Run the smoke test, so the platform starts the shop from this pull request on a DynamoDB table of its own, and calls it.',
  ),
  s2_t2b: {
    url: '/#/queue',
    title: '47 \u00b7 A high finding blocks the merge',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T2:');
      await ask.waitFor({ timeout: 30000 });
      const sec = ask.getByTestId('security');
      await act(
        h,
        'The smoke test passes, six of six. But the security review has found something serious, rated high, and this time it blocks. It is the very note from the first task, now that routes exist: anyone who knows an email address can list that customer\u2019s orders, and then cancel them, because nothing checks who is asking. Read what the card says at the bottom: the finding must be fixed or dismissed with a reason before anyone can approve. The platform enforces that.',
        async () => {
          await h.scrollBy(500, 2500);
          await h.point(ask.getByTestId('smoke'), 'Smoke test: 6 of 6 passed', 'The shop still starts and answers.', 4500);
          await h.point(sec, 'Security review: one HIGH finding', 'A high finding blocks the approval.', 13000);
        },
      );
      await act(
        h,
        'I will not dismiss this one. A shop where a stranger can cancel your order is not acceptable, even in a demo. So I click Send findings back to the engineer. The same agent starts again in a fresh container, with the finding as its instructions, and nothing merges meanwhile.',
        () =>
          h.click(sec.getByRole('button', { name: 'Send findings back to the engineer' }), {
            label: 'Send findings back to the engineer',
            why: 'Fix the real flaw. A high finding blocks the merge.',
          }),
      );
      await h.sleep(3500);
    },
  },
  s2_wait3: waitFor(
    'the T2 review again',
    '48 \u00b7 The engineer fixes it',
    'The engineer starts again from the finding, in a fresh container. It adds a proof of ownership: a secret token that checkout returns with the order, which the cancel and the history must present. It changes the routes, the adapter and the tests. A few minutes, sped up.',
    (i) => (i.type === 'review' && /T2:/.test(i.title)) || /Protected path|May I/.test(i.title) || i.type === 'decision',
  ),
  s2_ask: {
    url: '/#/map',
    title: '49 \u00b7 The agent asks how to fix it',
    async run(h) {
      const p = h.page;
      await act(
        h,
        'The engineer has stopped with a question, so I switch to the Attention queue tab, because that is where an agent waits for me.',
        () => h.tab('Attention queue', 'An agent is waiting for my answer.'),
      );
      const ask = askFor(p, 'How should I fix review finding');
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'It did not just patch the code. Fixing this changes how the shop works, so it asks me, and it lays out three options. A: keep the open lookup and say so, which leaves the concern. B: a secret token that checkout returns once with the order, which the cancel must present, so an outsider can no longer cancel anything. And C: full proof of the email address, with emailed links, which is much larger and needs email. It recommends B.',
        () => h.point(ask.getByRole('heading', { level: 3 }), 'How should I fix the finding?', 'Three options, and a recommendation.', 17000),
      );
      await act(
        h,
        'I choose B. It closes the hole that matters, the cancel, and it fits this stage. History stays readable by email, which I accept for this demo, and the reasons for that are on the record.',
        () => h.click(ask.getByRole('radio', { name: /B . Per-order cancel token/ }), { label: 'Choose B: a per-order cancel token', why: 'It closes the real hole, and fits this stage.' }),
      );
      await act(h, 'And I click Answer.', () => h.click(ask.getByRole('button', { name: 'Answer' }), { label: 'Answer', why: 'Send the decision to the agent.' }));
      await h.sleep(2500);
    },
  },
  s2_wait4: waitFor(
    'the T2 review again',
    '50 \u00b7 The engineer builds the fix',
    'With my answer, the engineer builds the token: checkout returns it once, only its hash is stored, and the cancel needs it. It changes the routes, the adapter and the tests. A few minutes, sped up.',
    (i) => (i.type === 'review' && /T2:/.test(i.title)) || /Protected path|May I/.test(i.title),
  ),
  s2_t2c: checks2(
    'T2:',
    '51 \u00b7 Check the fix',
    'The new pull request is in the Attention queue, the tab I am on. It is a new commit, so every check starts again from nothing: the earlier review does not count for it. I run both checks.',
    'And I click Run the smoke test, on the new commit, with its own DynamoDB table.',
  ),
  s2_t2d: {
    url: '/#/queue',
    title: '52 \u00b7 The high finding is gone: dismiss the rest, approve',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T2:');
      await ask.waitFor({ timeout: 30000 });
      const sec = ask.getByTestId('security');
      await act(
        h,
        'The review runs again on the new commit, and the high finding is gone. It checked the token: built from a keyed hash, compared safely, and returned only by checkout. What is left is a medium finding that I chose to leave in option B, history readable by anyone who knows an email address, and a low one about the strength of the secret. The smoke test passes, six of six.',
        async () => {
          await h.scrollBy(500, 2500);
          await h.point(ask.getByTestId('smoke'), 'Smoke test: 6 of 6 passed', 'On a DynamoDB table of its own.', 4500);
          await h.point(sec, 'Security review: no high finding', 'A medium and a low, to decide.', 11000);
        },
      );
      await act(
        h,
        'I dismiss the first with a reason: I accepted open history in my answer, and this is a demo shop with no customers. I click Dismiss with a reason, type it, and confirm.',
        async () => {
          await h.click(sec.getByRole('button', { name: /Dismiss F1 with a reason/ }), { label: 'Dismiss F1 with a reason', why: 'A risk I accepted, on the record.' });
          await h.type(sec.getByLabel('Why F1 is dismissed'), 'I chose option B: open history is accepted for this demo shop with no real customers. Proof of email ownership is a later initiative.', {
            label: 'Type the reason',
            why: 'It stays with the pull request.',
            delay: 20,
          });
          await h.click(sec.getByRole('button', { name: 'Dismiss', exact: true }), { label: 'Dismiss', why: 'Record the reason.' });
        },
      );
      await h.sleep(1500);
      await act(
        h,
        'The second is hardening for later, so I dismiss it with a reason too.',
        async () => {
          await h.click(sec.getByRole('button', { name: /Dismiss F2 with a reason/ }), { label: 'Dismiss F2 with a reason', why: 'Hardening for later.' });
          await h.type(sec.getByLabel('Why F2 is dismissed'), 'A minimum secret length and token expiry are hardening tasks for after this demo.', { label: 'Type the reason', why: 'It stays with the pull request.', delay: 22 });
          await h.click(sec.getByRole('button', { name: 'Dismiss', exact: true }), { label: 'Dismiss', why: 'Record the reason.' });
        },
      );
      await h.sleep(1500);
      await act(
        h,
        'There is no page in this task, so nothing new to click through yet. I add a comment, and click Approve. The page task is next, and it will have a live version to try.',
        async () => {
          await h.type(ask.getByLabel('Comment'), 'The cancel token is what I wanted. Page task next.', { label: 'Type a comment', why: 'It stays with the decision.', delay: 28 });
          await h.click(ask.getByRole('button', { name: 'Approve' }), { label: 'Approve the second task', why: 'The high finding is fixed; the rest is on the record.' });
        },
      );
      await h.sleep(3500);
    },
  },
  s2_wait5: waitFor(
    'T3 needs a person',
    '53 \u00b7 The last task: the page',
    'The gate merges the second task, and the last task starts: the page controls for discount codes, stock labels, order history and cancel. A few minutes, sped up.',
    (i) => (i.type === 'review' && /T3:/.test(i.title)) || /Protected path|May I/.test(i.title) || i.type === 'decision',
  ),
  s2_ask2: {
    url: '/#/map',
    title: '54 \u00b7 The agent asks before touching a protected file',
    async run(h) {
      const p = h.page;
      await act(
        h,
        'The page engineer has a question, so I switch to the Attention queue tab, because that is where an agent waits for me.',
        () => h.tab('Attention queue', 'An agent is waiting for my answer.'),
      );
      const ask = askFor(p, 'T3 lists .sdlc/preview.yaml');
      await ask.waitFor({ timeout: 30000 });
      await act(
        h,
        'The agent noticed that its task lists the preview file, which is protected, and that the approved design requires new smoke checks for the new features. It does not edit it on its own. It asks me. Those checks are how the platform will prove, in the live version, that the discount codes and the history work. I choose yes, because more checks make the safety net stronger, not weaker.',
        async () => {
          await h.point(ask.getByRole('heading', { level: 3 }), 'May I add the design\u2019s smoke checks?', 'The preview file is a protected path.', 9000);
          await h.click(ask.getByRole('radio', { name: /Yes, add the checks/ }), { label: 'Choose: Yes, add the checks', why: 'More checks, nothing removed.' });
        },
      );
      await act(h, 'And I click Answer.', () => h.click(ask.getByRole('button', { name: 'Answer' }), { label: 'Answer', why: 'Send the decision to the agent.' }));
      await h.sleep(2500);
    },
  },
  s2_wait6: waitFor(
    'a protected path or the review',
    '55 \u00b7 The platform\u2019s own hard stop, then the page is built',
    'The agent now goes to change the preview file, and the platform stops it at the protected path. I will allow it, and then it finishes the page. A few minutes, sped up.',
    (i) => /Protected path changed/.test(i.title) || (i.type === 'review' && /T3:/.test(i.title)),
  ),
  s2_prot: allowProtected('56 \u00b7 The platform\u2019s hard stop on the preview file', true),
  s2_wait7: waitFor(
    'the T3 review',
    '57 \u00b7 The page is built',
    'The agent keeps the edit, finishes the page, and opens the pull request. A few minutes, sped up.',
    (i) => i.type === 'review' && /T3:/.test(i.title),
  ),
  s2_t3a: checks2(
    'T3:',
    '58 \u00b7 The page change: run the checks',
    'The last task of the second initiative, the page controls for discount codes, stock labels, order history and cancel, is ready, and its pull request is in the Attention queue, the tab I am on. As the last task, every smoke check from the design applies to it. I run both checks.',
    'And I click Run the smoke test, so the platform starts the whole shop on a DynamoDB table of its own, and calls it with every check the design lists, old and new.',
  ),
  s2_t3b: {
    url: '/#/queue',
    title: '59 \u00b7 Nine of nine checks: start the live preview',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T3:');
      await ask.waitFor({ timeout: 30000 });
      const sec = ask.getByTestId('security');
      await act(
        h,
        'Nine of nine smoke checks pass: the six from stage one, still green, and the new ones for the cart and the order history. The security review finds no cross-site scripting, and it checked the cancel token again. It raises the same medium finding as before, open history, which I accepted when I chose option B, so I dismiss it with that reason.',
        async () => {
          await h.scrollBy(500, 2500);
          await h.point(ask.getByTestId('smoke'), 'Smoke test: 9 of 9 passed', 'Old checks and new ones.', 6000);
          await h.point(sec, 'Security review: the decision I already made', 'Open history, accepted for the demo.', 7000);
        },
      );
      await act(
        h,
        'I click Dismiss with a reason, type it, and confirm.',
        async () => {
          await h.click(sec.getByRole('button', { name: /Dismiss F1 with a reason/ }), { label: 'Dismiss F1 with a reason', why: 'A decision already on the record.' });
          await h.type(sec.getByLabel('Why F1 is dismissed'), 'Open history was accepted in option B for this demo shop. Proof of email ownership is a later initiative.', { label: 'Type the reason', why: 'It stays with the pull request.', delay: 22 });
          await h.click(sec.getByRole('button', { name: 'Dismiss', exact: true }), { label: 'Dismiss', why: 'Record the reason.' });
        },
      );
      await h.sleep(1500);
      const prev = ask.getByTestId('preview');
      await act(
        h,
        'Now the step that matters, again. I click Run it, and the platform starts this change as a live, isolated, testable version of the shop, with its own fresh DynamoDB table. The shop from stage one is untouched, and so is anything real.',
        () => h.click(prev.getByRole('button', { name: /Run it (again|here)/ }), { label: 'Run the preview', why: 'A live, isolated version I can use.' }),
      );
      await h.waitUntil('the preview', async () => (await prev.getAttribute('data-state')) === 'ready', 420000, 2000);
      await h.sleep(1500);
    },
  },
  s2_t3c: {
    url: '/#/queue',
    title: '60 \u00b7 Try the new features in the live version',
    async run(h) {
      const p = h.page;
      const email = process.env.SHOP_EMAIL ?? 'sam@example.com';
      const ask = askFor(p, 'T3:');
      await ask.waitFor({ timeout: 30000 });
      const href = await ask.getByTestId('preview').getByRole('link').first().getAttribute('href');
      await act(
        h,
        'The preview is ready. I open it in its own browser tab, because it is the shop itself, with the new features, on its own address, in its own container, with a DynamoDB table of its own. The shop from stage one, and anything real, is not touched.',
        () => h.browserTab('The live preview of the new version', 'The real shop with the new features, isolated.', href),
      );
      await p.locator('#product-list li').first().waitFor({ timeout: 90000 });
      await act(
        h,
        'Same shop as before, and a new My orders tab in the menu. The new table was created and seeded when this preview started, with the same eight products, and now also two discount codes. I add the Pocket Tide Clock, and open the cart.',
        async () => {
          await h.point(p.locator('#nav-orders'), 'New: My orders', 'Order history and cancel.', 3500);
          await h.click(p.getByRole('button', { name: 'Add Pocket Tide Clock to cart' }), { label: 'Add the tide clock to the cart', why: 'The item I will buy.' });
          await h.sleep(900);
          await h.click(p.locator('#nav-cart'), { label: 'Open the cart', why: 'Quantity, discount code and checkout are here.' });
        },
      );
      await p.locator('#code-input').waitFor({ timeout: 15000 });
      await act(
        h,
        'There is a new Discount code box in the cart. First I set the quantity to four clocks, and click Update, because I want to see the stock label later.',
        async () => {
          const qty = p.locator('input[aria-label="Quantity for Pocket Tide Clock"]');
          await qty.fill('');
          await h.type(qty, '4', { label: 'Type a quantity of 4', why: 'Four of the eight in stock.', delay: 60 });
          await h.click(p.getByRole('button', { name: 'Update quantity for Pocket Tide Clock' }), { label: 'Update', why: 'Save the new quantity.' });
          await h.sleep(1500);
        },
      );
      await act(
        h,
        'Now a code. I type a code that does not exist, and click Apply, to see the rule: an unknown code gets a clear error.',
        async () => {
          await h.type(p.locator('#code-input'), 'BOGUS', { label: 'Type an unknown code', why: 'It does not exist.', delay: 70 });
          await h.click(p.getByRole('button', { name: 'Apply discount code' }), { label: 'Apply', why: 'See the error for an unknown code.' });
          await h.sleep(1800);
          await h.point(p.locator('#error'), 'An unknown code is refused', 'A clear message, no discount.', 4500);
        },
      );
      await act(
        h,
        'Then the real one. I replace it with WELCOME10, a ten percent code, and click Apply.',
        async () => {
          await p.locator('#code-input').fill('');
          await h.type(p.locator('#code-input'), 'WELCOME10', { label: 'Type WELCOME10', why: 'A seeded code, ten percent off.', delay: 70 });
          await h.click(p.getByRole('button', { name: 'Apply discount code' }), { label: 'Apply', why: 'Apply the discount.' });
          await h.sleep(2000);
          await h.point(p.locator('#cart-contents'), 'Discount applied', 'The cart shows the discount and the new total.', 6500);
        },
      );
      await act(
        h,
        'The cart shows the discount, and the new total. Checkout will apply this code and count its use inside the same DynamoDB transaction as the order. I enter my email and an approved card, and click Place order.',
        async () => {
          await h.type(p.locator('#checkout-email'), email, { label: 'Type the email', why: 'Who the order is for.', delay: 40 });
          await h.type(p.locator('#checkout-card'), '4242424242421111', { label: 'Type an approved card', why: 'Any number not ending in 0000 is approved.', delay: 40 });
          await h.click(p.locator('#checkout-submit'), { label: 'Place order', why: 'Check out with the discount.' });
        },
      );
      await p.locator('#view-confirmation:not([hidden])').waitFor({ timeout: 20000 });
      await h.sleep(1200);
      await act(
        h,
        'The order is confirmed, with the discounted total. The server took the four clocks off the stock, and counted one use of the code, in one transaction.',
        () => h.point(p.locator('#confirmation-detail'), 'Order confirmed, with the discount', 'Stock, code use and order in one transaction.', 7000),
      );
      await act(
        h,
        'Back to the products. The clock had eight in stock, and now four are left, so the new stock label appears: Only four left. At zero, it would say Sold out, and the add button would be disabled.',
        async () => {
          await h.click(p.locator('#nav-products'), { label: 'Open the products', why: 'See the stock label.' });
          await h.sleep(1800);
          await h.point(p.locator('#product-list li').last(), 'The stock label', 'Only 4 left.', 6500);
        },
      );
      await act(
        h,
        'Now the order history. I open My orders, type my email, and click Show my orders.',
        async () => {
          await h.click(p.locator('#nav-orders'), { label: 'Open My orders', why: 'See the history for an email.' });
          await h.type(p.locator('#orders-email'), email, { label: 'Type the email', why: 'Which customer\u2019s orders to list.', delay: 40 });
          await h.click(p.getByRole('button', { name: 'Show my orders' }), { label: 'Show my orders', why: 'Read the orders for this email.' });
          await h.sleep(2200);
          await h.point(p.locator('#orders-result'), 'The order history', 'Newest first. Cancel is offered in this browser only.', 6000);
        },
      );
      await act(
        h,
        'Finally the cancel. This browser placed the order, so it holds the secret token, and the page offers Cancel. Someone who only knows the email address could read the list, but could not cancel, which is the fix that the security review asked for. I click Cancel order.',
        async () => {
          await h.click(p.getByRole('button', { name: /^Cancel/ }).first(), { label: 'Cancel the order', why: 'Put the stock back.' });
          await h.sleep(2500);
          await h.point(p.locator('#orders-result'), 'The order is cancelled', 'And the stock goes back.', 5000);
        },
      );
      await act(
        h,
        'And back in the products, the clock is back to eight in stock, so the label is gone. The cancel put the units back in the same transaction that marked the order cancelled.',
        async () => {
          await h.click(p.locator('#nav-products'), { label: 'Open the products', why: 'Check the stock after the cancel.' });
          await h.sleep(2200);
          await h.point(p.locator('#product-list li').last(), 'Stock is back', 'Eight again; the label is gone.', 5500);
        },
      );
      await act(
        h,
        'The new features work as described, on a real DynamoDB table, in an environment that exists only for this review, and the old features are still there. Now I go back to the platform to decide.',
        () => h.sleep(3500),
      );
    },
  },
  s2_t3d: {
    url: '/#/queue',
    title: '61 \u00b7 Approve the page change',
    async run(h) {
      const p = h.page;
      const ask = askFor(p, 'T3:');
      await ask.waitFor({ timeout: 30000 });
      await p.evaluate(() => window.__demo.banner('BACK TO THE PLATFORM TAB', 'The platform', 'The decision is made here, not in the preview.', '#ff6fb5', 4500));
      await act(
        h,
        'Back in the platform tab. The card shows every step accounted for: the agent\u2019s checks, the smoke test, nine of nine, and the security review with my recorded reasons. And I have used the new version myself, in its live, isolated copy: a discount, a stock label, an order history and a cancel, all on DynamoDB, and I saw the old features still work. That is why I can approve.',
        () => h.point(ask.getByTestId('review-flow'), 'Every step is accounted for', 'Nothing blocks the approval.', 9000),
      );
      await act(
        h,
        'I add a comment, and click Approve.',
        async () => {
          await h.type(ask.getByLabel('Comment'), 'Codes, stock labels, history and cancel all work in the live version. Approved.', { label: 'Type a comment', why: 'It stays with the decision.', delay: 24 });
          await h.click(ask.getByRole('button', { name: 'Approve' }), { label: 'Approve the page change', why: 'It works, and every step is accounted for.' });
        },
      );
      await h.sleep(3500);
    },
  },
  s2_mergewait: {
    url: '/#/queue',
    lapse: true,
    title: '62 \u00b7 The gate merges',
    async run(h) {
      const p = h.page;
      setNow(TITLE2);
      h.say('The gate waits for the repository\u2019s CI, merges the pull request, and the plan is complete.');
      await h.sleep(1500);
      await h.tab('Map', 'The map shows when the build is complete.');
      await pickInitiative(h);
      const init = (await (await p.request.get('https://app.agentonomous.com/api/initiatives')).json()).find((x) => x.title === TITLE2);
      await h.waitUntil(
        'the plan is done',
        async () => (await (await p.request.get(`https://app.agentonomous.com/api/initiatives/${init.id}/plan`)).json()).plan?.state === 'done',
        900000,
        5000,
      );
      await h.sleep(3000);
    },
  },
  s2_done: {
    url: '/#/map',
    title: '63 \u00b7 Stage 2 is done',
    async run(h) {
      const p = h.page;
      setNow(TITLE2);
      await pickInitiative(h);
      await act(
        h,
        'All three tasks of the second initiative are merged, on top of the shop from the first. The repository now holds one product, built in two stages, each reviewed by a person, and each change tried in its own live, isolated copy before it was approved.',
        () => h.point(p.getByTestId('build-plan'), 'Stage 2: every task merged', 'The plan is complete.', 8000),
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
        'That was a real online shop on DynamoDB, built in two stages on a platform running in AWS, with a person at every decision that mattered. The agents were Claude Code, each in its own sandbox. Along the way the platform stopped an agent at a new outside system, held a merge on a high security finding, asked me how to fix it, and, before every approval, gave me a live, isolated, testable copy of the change to try. And I caught a preview that was quietly not using DynamoDB. One last word on the cloud. The platform and the shop are intentionally built for AWS, to make adopting them as easy as possible, and all of the shop\u2019s calls to AWS live in a single file, so refactoring it for another cloud is a matter of writing one new adapter. Every step I showed was a person clicking a button, and I said why. Thanks for watching.',
      );
      await h.tab('Portfolio', 'Where every initiative stands, in one place.');
      await talk;
    },
  },
};

export const ORDER = ['intro','signin','tour','newinitiative','startspec','specwait','reviewspec','startdesign','designwait','reviewdesign','startbuild','buildwait1','integration','t1a','t2wait','protected1','p2wait','t2a','t2b','t3a','t3b','t4wait','t4a','t4b','t4c','t4wait2','t4ask','t4prot','t4wait3','t4d','t4e','t4f','t4g','mergewait','stage1done','s2_intro','s2_new','s2_startspec','s2_specwait','s2_reviewspec','s2_startdesign','s2_designwait','s2_reviewdesign','s2_startbuild','s2_wait1','s2_t1a','s2_t1b','s2_wait2','s2_t2a','s2_t2b','s2_wait3','s2_ask','s2_wait4','s2_t2c','s2_t2d','s2_wait5','s2_ask2','s2_wait6','s2_prot','s2_wait7','s2_t3a','s2_t3b','s2_t3c','s2_t3d','s2_mergewait','s2_done','outro'];

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) await main(scenes);
void setTitle;
void pickInitiative;
void waitFor;
void askFor;
void allowProtected;
void checks;
void T2;
void TITLE2;
void GOAL2;

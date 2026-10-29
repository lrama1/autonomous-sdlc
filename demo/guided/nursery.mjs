// The e-commerce demo, third edition: a plant shop on DynamoDB, built in three stages with the same flow.
//   Stage 1 (New app, Guided): the storefront.  Stage 2 (Feature, Balanced): filters, care sheets, cancellations.
//   Stage 3 (Feature, Autopilot): a plant-care subscription box.
// Run with:  DEMO_WORK=nursery DEMO_SCENES=./nursery.mjs node demo/guided/nursery.mjs <scene ids>
// Scenes w1, w2 ... wait for the next thing that needs a person; h1, h2 ... handle it. They are made for every number.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { main, BASE } from './record.mjs';
import { scenes as base, act, pickInitiative, interactions } from './scenes.mjs';
import { via, askFor, setNow, cur } from './tickets.mjs';

export const TITLES = {
  1: 'Fernleaf plant shop',
  2: 'Plant filters, care sheets and cancellations',
  3: 'Plant-care subscription box',
};
export const MODES = { 1: 'guided', 2: 'balanced', 3: 'autopilot' };
export const KINDS = { 1: 'new_app', 2: 'feature', 3: 'feature' };
const T = (n) => () => setNow(TITLES[n]);
setNow(TITLES[process.env.DEMO_STAGE ?? 1]);

const PAGE1 = [
  'Page contract, so that automated checks and people can find things: the product list is an element with id product-list holding one li per plant, and each li has a button whose accessible name is "Add <plant name> to cart". The page has navigation buttons with ids nav-products, nav-cart and nav-lookup. The cart view has an element with id cart-contents (the lines and the grand total), an input checkout-email, an input checkout-card, a button checkout-submit and an element error that shows messages. After an approved order the page shows a view with id view-confirmation (hidden until then) containing an element confirmation-detail with the order id and total. The lookup view has an input lookup-id, a button named "Look up order", and an element lookup-result.',
].join(' ');

export const GOAL1 = [
  'Build a small online plant shop called Fernleaf: a web page plus a JSON API, with all data kept in Amazon DynamoDB.',
  'Who and what: shoppers are anonymous, identified only by a cart id that the page keeps. They browse plants, add them to a cart, change quantities, and check out with an email address and a card number. Shop staff and an admin area are out of scope for this first version. A plant has a sku, a name, a description, a light need (low, medium or bright), a pet-safe flag, a price in cents and a number of units in stock. A cart belongs to a cart id and holds lines of sku and quantity. An order has an id, the customer\u2019s email, its lines (sku, name, unit price, quantity), a total in cents, a status and a created time.',
  'Rules: a line holds 1 to 10 units, and never more than are in stock. The prices always come from the plant at checkout, never from the page. Checkout is all or nothing: it takes the units off every plant and writes the order in one DynamoDB transaction, and answers 409 with a clear message if any plant no longer has enough stock. Payment is simulated and calls no outside service: a card number ending in 0000 is declined with 402, any other number is approved. An approved order has the status paid.',
  'What I must be able to do: list the plants, open one plant, put plants in a cart, see the cart with line totals and a grand total, check out, and look an order up by its id.',
  'Data: use one DynamoDB table. Take its name from the TABLE_NAME environment variable and the region from AWS_REGION, with the default AWS credential chain and no keys in code. Use a single-table design with partition key PK and sort key SK. If the table does not exist when the app starts, create it with on-demand billing and wait until it is ACTIVE before reporting ready. On the first start, if the table holds no plants, seed eight sample houseplants, so the shop is never empty. Include these three exactly: Monstera Deliciosa (2800 cents, bright light, 12 in stock), Snake Plant (1800 cents, low light, pet-safe no, 20 in stock) and Golden Pothos (1200 cents, medium light, 25 in stock). Also seed one plant with only 3 in stock (Fiddle Leaf Fig) and one with 0 in stock (Calathea Orbifolia). Use the AWS SDK for JavaScript v3. Unit tests must not call AWS, so mock the client.',
  'Portability: this shop is intentionally built for AWS, but I want it to be easy to move to another cloud later. Put all data access behind one small interface in src/data (list and get plants, cart operations, place an order, get an order). The DynamoDB version lives in a single file, and that file is the only one that imports the AWS SDK. Moving to another provider then means writing one new adapter.',
  PAGE1,
  'Keep it plain: Node, one HTML page, relative URLs, at most four tasks.',
].join('\n\n');
export const LINKS1 = [
  'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html',
  'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-general-nosql-design.html',
].join('\n');

export const GOAL2 = [
  'Add three things to the Fernleaf plant shop that is already in this repository.',
  'Filters and care sheets: the plant list can be filtered by light need and by pet-safe, both through query parameters on the list route (light and petSafe) and with page controls: a select with id filter-light (options All, Low, Medium, Bright) and a checkbox with id filter-petsafe. Each plant has a care sheet with a watering interval in days and a one-sentence care tip; seed them for every plant. Each plant in the list has a button whose accessible name is "Care sheet for <plant name>", which shows the care sheet in an element with id care-sheet.',
  'Stock labels: the list shows "Only N left" next to a plant when 5 or fewer units remain, and "Sold out" with the add button disabled at 0.',
  'Cancelling: a paid order can be cancelled, which puts its units back in stock in one DynamoDB transaction. The order lookup result shows the status, and a paid order has a button with id cancel-order. A cancelled order cannot be cancelled again and answers 409.',
  'Use the existing DynamoDB table and the existing data interface, and add the new access to it. Keep the existing tests and the page contract working, and add tests for the new rules. At most three tasks.',
].join('\n\n');

export const GOAL3 = [
  'Add a plant-care subscription box to the Fernleaf plant shop that is already in this repository.',
  'Plans: seed two plans in the existing DynamoDB table: Starter (1 plant a month, 1900 cents) and Collector (3 plants a month, 4900 cents). A route lists the plans.',
  'Subscribing: a shopper subscribes with an email address, a plan and a card number. A card number ending in 0000 is declined with 402, any other is approved. An approved subscription is active and its next shipment is one month from today. One email can hold one active subscription per plan.',
  'Managing: a shopper looks up their subscriptions by email, and can pause, resume or cancel one. A cancelled subscription cannot be resumed. Pausing keeps the next shipment date.',
  'Renewals: a route runs the renewals due on or before a given date (default today). Each active subscription that is due creates an order (status paid, lines named after the plan, total the plan price) and moves its next shipment one month forward. It answers how many were renewed.',
  'Page: a new view with the subscription box. Contract: a navigation button with id nav-subscribe; an input sub-email, a select sub-plan with the plan names as option labels, an input sub-card and a button sub-submit; an element sub-result for the outcome; an input sub-lookup-email and a button named "Show my subscriptions"; an element sub-list that shows each subscription with buttons named Pause, Resume and Cancel; an input renew-date, a button renew-run and an element renew-result that says how many were renewed.',
  'Use the existing DynamoDB table and the existing data interface, and add the new access to it. Keep the existing tests and the page contract working, and add tests for the new rules. At most three tasks.',
].join('\n\n');

const pickRec = async (ask, ix) => {
  const options = ix.options ?? [];
  const idx = Math.max(0, options.findIndex((o) => o.id === ix.recommendation));
  const radios = ask.getByRole('radio');
  return { idx, label: options[idx]?.label ?? 'the recommended choice', radio: radios.nth(idx), count: await radios.count() };
};

/** The first open ask of the initiative this stage is about. */
const nextAsk = async (p) => (await interactions(p)).find((i) => i.initiativeTitle === cur());
const isTask = (i) => i.type === 'review' && /\bT\d+:/.test(i.title);
const isSpec = (i) => i.type === 'review' && /spec/i.test(i.title) && !isTask(i);
const isDesign = (i) => i.type === 'review' && /design/i.test(i.title) && !isTask(i);

const stateOf = async (ask, id) => ((await ask.getByTestId(id).count()) ? ((await ask.getByTestId(id).first().getAttribute('data-state')) ?? 'none') : 'absent');
const settled = (s) => !['none', 'running', 'pending', 'starting', 'queued', 'unknown'].includes(s);

const buildDone = async (p) => {
  const list = await (await p.request.get(`${BASE}/api/initiatives`)).json();
  const it = list.find((i) => i.title === cur());
  if (!it) return false;
  const m = await (await p.request.get(`${BASE}/api/initiatives/${it.id}/map`)).json();
  return m.stages.find((s) => s.id === 'build')?.status === 'done';
};

/** Scenes that wait (sped up) until something needs a person, or the build is done. */
const waitNext = (n, say, stage) => ({
  url: '/#/map',
  lapse: true,
  title: `${n} \u00b7 The agents work`,
  async run(h) {
    const p = h.page;
    T(stage)();
    h.say(say);
    await pickInitiative(h);
    await h.waitUntil('an ask for a person', async () => Boolean(await nextAsk(p)) || (await buildDone(p)), 1_800_000, 5000);
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------
// What each stage's preview is used for. Every step is best effort: a step whose page element is missing is skipped,
// so the narration only describes what the page really offers.
const has = async (p, sel) => (await p.locator(sel).count()) > 0;

async function tryShop(h, p) {
  await p.locator('#product-list li').first().waitFor({ timeout: 90000 });
  await act(
    h,
    'This is Fernleaf. The app found its table empty, so it created the table, and it seeded the plants into it. Everything on this page is read from DynamoDB, in this one preview, and nothing I do here touches anything real.',
    () => h.point(p.locator('#product-list'), 'The plants, read from DynamoDB', 'Seeded by the app on its first start.', 6500),
  );
  const monstera = p.getByRole('button', { name: 'Add Monstera Deliciosa to cart' });
  const snake = p.getByRole('button', { name: 'Add Snake Plant to cart' });
  await act(h, 'I add two monsteras and a snake plant to my cart. I click Add to cart on the monstera, twice, and then on the snake plant.', async () => {
    await h.click(monstera, { label: 'Add the monstera', why: 'First of two.' });
    await h.sleep(900);
    await h.click(monstera, { label: 'Add the monstera again', why: 'A second one.' });
    await h.sleep(900);
    await h.click(snake, { label: 'Add the snake plant', why: 'A third line.' });
    await h.sleep(900);
  });
  await act(h, 'I open the cart, because that is where the totals and the checkout form are.', () =>
    h.click(p.locator('#nav-cart'), { label: 'Open the cart', why: 'See totals, then check out.' }),
  );
  await p.locator('#cart-contents').waitFor({ timeout: 15000 });
  await h.sleep(1200);
  await act(h, 'The cart shows each line and the grand total. The prices are not taken from this page: the server reads them from the plant table when I check out.', () =>
    h.point(p.locator('#cart-contents'), 'The cart, with totals', 'Prices come from the server at checkout.', 5500),
  );
  await act(h, 'First I try a card that the simulated payment declines, a number that ends in four zeros. I type my email, and then the card number.', async () => {
    await h.type(p.locator('#checkout-email'), 'sam@example.com', { label: 'Type the email', why: 'Who the order is for.', delay: 40 });
    await h.type(p.locator('#checkout-card'), '4242424242420000', { label: 'Type a card ending in 0000', why: 'The simulated payment declines it.', delay: 40 });
  });
  await act(h, 'I click Place order.', () => h.click(p.locator('#checkout-submit'), { label: 'Place order', why: 'Try the declined card.' }));
  await h.sleep(2000);
  await act(h, 'The payment is declined, and the page says so. Nothing was written and no stock was taken, because checkout is all or nothing.', () =>
    h.point(p.locator('#error'), 'Payment declined', 'No order. No stock taken.', 5000),
  );
  await act(h, 'Now a card that is approved. I replace the number, and click Place order again.', async () => {
    await p.locator('#checkout-card').fill('');
    await h.type(p.locator('#checkout-card'), '4242424242421111', { label: 'Type an approved card', why: 'Any number not ending in 0000 is approved.', delay: 40 });
    await h.click(p.locator('#checkout-submit'), { label: 'Place order', why: 'Check out with the approved card.' });
  });
  await p.locator('#view-confirmation:not([hidden])').waitFor({ timeout: 20000 });
  await h.sleep(1200);
  await act(h, 'The order is confirmed, with an order number. The server took the stock off the plants and wrote the order, in one DynamoDB transaction.', () =>
    h.point(p.locator('#confirmation-detail'), 'Order confirmed', 'Stock and order written in one transaction.', 5500),
  );
  const text = await p.locator('#confirmation-detail').innerText();
  const orderId = (text.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i) ?? [''])[0];
  await act(h, 'I go back to the plants, to check the stock. The monstera had twelve in stock, and now it shows ten.', async () => {
    await h.click(p.locator('#nav-products'), { label: 'Open the plants', why: 'See the stock after my order.' });
    await h.sleep(1500);
    await h.point(p.locator('#product-list li', { hasText: 'Monstera Deliciosa' }).first(), 'Stock went down', '12 monsteras became 10.', 5000);
  });
  if (orderId && (await has(p, '#lookup-id')))
    await act(h, 'Last, I look the order up by its number. I open Find an order, paste the number, and click Look up order, and the page reads the order back from DynamoDB.', async () => {
      await h.click(p.locator('#nav-lookup'), { label: 'Open Find an order', why: 'Look the order up by its number.' });
      await h.type(p.locator('#lookup-id'), orderId, { label: 'Type the order number', why: 'Read it back from DynamoDB.', delay: 25 });
      await h.click(p.getByRole('button', { name: 'Look up order' }), { label: 'Look up order', why: 'Read the order from the table.' });
      await h.sleep(2200);
      await h.point(p.locator('#lookup-result'), 'The order, read back', 'Stored in DynamoDB.', 5000);
    });
  return orderId;
}

async function tryFilters(h, p) {
  await p.locator('#product-list li').first().waitFor({ timeout: 90000 });
  if (await has(p, '#filter-light')) {
    await act(h, 'The list now has filters. I pick Low in the light box, because I want a plant for a dim room, and the list is narrowed by the server, from DynamoDB.', async () => {
      await h.point(p.locator('#filter-light'), 'The new light filter', 'Narrows the list by light need.', 2500);
      await p.locator('#filter-light').selectOption({ label: 'Low' });
      await h.sleep(2500);
    });
    if (await has(p, '#filter-petsafe'))
      await act(h, 'And I tick Pet safe, because I have a cat. What is left is only plants that are safe for pets and happy in low light.', async () => {
        await h.click(p.locator('#filter-petsafe'), { label: 'Tick Pet safe', why: 'Only plants safe for pets.' });
        await h.sleep(2500);
        await h.point(p.locator('#product-list'), 'Filtered list', 'Low light and pet safe.', 4500);
      });
    await p.locator('#filter-light').selectOption({ label: 'All' });
    if (await has(p, '#filter-petsafe') && (await p.locator('#filter-petsafe').isChecked())) await p.locator('#filter-petsafe').uncheck();
    await h.sleep(1500);
  }
  const sold = p.locator('#product-list li', { hasText: /Sold out/i }).first();
  if (await sold.count())
    await act(h, 'The stock labels work too. The Calathea has none left, so it says Sold out, and its add button is disabled, which stops anyone from ordering what the shop cannot send.', () =>
      h.point(sold, 'Sold out', 'The add button is disabled.', 6000),
    );
  const few = p.locator('#product-list li', { hasText: /Only \d+ left/i }).first();
  if (await few.count())
    await act(h, 'And the fiddle leaf fig has three left, so the page says Only three left.', () => h.point(few, 'Only 3 left', 'A label from the stock count.', 4500));
  const care = p.getByRole('button', { name: 'Care sheet for Snake Plant' });
  if (await care.count())
    await act(h, 'I open the care sheet for the snake plant, because each plant now carries how often to water it and a tip.', async () => {
      await h.click(care, { label: 'Care sheet for the snake plant', why: 'See how to look after it.' });
      await h.sleep(1500);
      await h.point(p.locator('#care-sheet'), 'The care sheet', 'Watering interval and a tip, from DynamoDB.', 6000);
    });
}

async function tryCancel(h, p) {
  // An order is made through the page, then cancelled, to see the stock come back.
  if (!(await has(p, '#nav-cart'))) return;
  const mug = p.getByRole('button', { name: 'Add Golden Pothos to cart' });
  if (!(await mug.count())) return;
  await act(h, 'To try cancelling, I place a small order first. I add one golden pothos, which has twenty five in stock, open the cart and pay with an approved card.', async () => {
    await h.click(mug, { label: 'Add the pothos', why: 'A small order to cancel.' });
    await h.click(p.locator('#nav-cart'), { label: 'Open the cart', why: 'Check out.' });
    await h.type(p.locator('#checkout-email'), 'sam@example.com', { label: 'Type the email', why: 'Who the order is for.', delay: 30 });
    await h.type(p.locator('#checkout-card'), '4242424242421111', { label: 'Type an approved card', why: 'Approved.', delay: 30 });
    await h.click(p.locator('#checkout-submit'), { label: 'Place order', why: 'Make an order to cancel.' });
  });
  await p.locator('#view-confirmation:not([hidden])').waitFor({ timeout: 20000 });
  const text = await p.locator('#confirmation-detail').innerText();
  const orderId = (text.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i) ?? [''])[0];
  await act(h, 'The order is paid. Now I look it up by its number, because that is where the new Cancel button lives.', async () => {
    await h.click(p.locator('#nav-lookup'), { label: 'Open Find an order', why: 'The cancel button is on the order.' });
    await h.type(p.locator('#lookup-id'), orderId, { label: 'Type the order number', why: 'Find the paid order.', delay: 25 });
    await h.click(p.getByRole('button', { name: 'Look up order' }), { label: 'Look up order', why: 'Show the order.' });
    await h.sleep(2000);
  });
  if (await has(p, '#cancel-order')) {
    await act(h, 'I click Cancel order. The units go back on the shelf in one DynamoDB transaction, together with the new status.', async () => {
      await h.click(p.locator('#cancel-order'), { label: 'Cancel the order', why: 'Put the stock back.' });
      await h.sleep(2500);
      await h.point(p.locator('#lookup-result'), 'The order is now cancelled', 'The stock was put back.', 5000);
    });
  }
}

async function trySubscriptions(h, p) {
  await p.locator('#nav-subscribe').waitFor({ timeout: 90000 });
  await act(h, 'The page has a new view for the subscription box. I open it, because that is the feature this stage adds.', () =>
    h.click(p.locator('#nav-subscribe'), { label: 'Open the subscription box', why: 'The feature this stage adds.' }),
  );
  await act(h, 'I give my email, choose the Collector plan, and type an approved card.', async () => {
    await h.type(p.locator('#sub-email'), 'sam@example.com', { label: 'Type the email', why: 'Who subscribes.', delay: 35 });
    await p.locator('#sub-plan').selectOption({ label: /Collector/ }).catch(async () => p.locator('#sub-plan').selectOption({ index: 1 }));
    await h.point(p.locator('#sub-plan'), 'The Collector plan', 'Three plants a month, from DynamoDB.', 2500);
    await h.type(p.locator('#sub-card'), '4242424242421111', { label: 'Type an approved card', why: 'Approved.', delay: 35 });
  });
  await act(h, 'And I click Subscribe.', () => h.click(p.locator('#sub-submit'), { label: 'Subscribe', why: 'Start the subscription.' }));
  await h.sleep(2500);
  await act(h, 'The subscription is active, with its next shipment one month from today.', () =>
    h.point(p.locator('#sub-result'), 'Subscription active', 'Next shipment one month away.', 5000),
  );
  await act(h, 'I look my subscriptions up by email, because that is where I can pause, resume or cancel them.', async () => {
    await p.locator('#sub-lookup-email').fill('');
    await h.type(p.locator('#sub-lookup-email'), 'sam@example.com', { label: 'Type the email', why: 'Find my subscriptions.', delay: 30 });
    await h.click(p.getByRole('button', { name: 'Show my subscriptions' }), { label: 'Show my subscriptions', why: 'Read them from DynamoDB.' });
    await h.sleep(2200);
    await h.point(p.locator('#sub-list'), 'My subscription', 'Read back from DynamoDB.', 4000);
  });
  const pause = p.locator('#sub-list').getByRole('button', { name: /^Pause/ }).first();
  if (await pause.count())
    await act(h, 'I click Pause, because I am away next month. The status changes, and the shipment date is kept.', async () => {
      await h.click(pause, { label: 'Pause', why: 'Skip while I am away.' });
      await h.sleep(2200);
      await h.point(p.locator('#sub-list'), 'Paused', 'The date is kept.', 4000);
    });
  const resume = p.locator('#sub-list').getByRole('button', { name: /^Resume/ }).first();
  if (await resume.count())
    await act(h, 'And Resume, because I am back.', async () => {
      await h.click(resume, { label: 'Resume', why: 'Back to monthly boxes.' });
      await h.sleep(2200);
    });
  if (await has(p, '#renew-run')) {
    await act(h, 'Last, the renewals. A box is due when its date arrives, so I type a date a little over a month ahead, and click Run renewals. Each due subscription becomes an order, and its next shipment moves forward a month.', async () => {
      const d = new Date(Date.now() + 35 * 86400000).toISOString().slice(0, 10);
      await h.click(p.locator('#renew-date'), { label: 'Set a date 35 days ahead', why: 'Make the box due.' });
      await p.locator('#renew-date').fill(d);
      await h.click(p.locator('#renew-run'), { label: 'Run renewals', why: 'Turn due boxes into orders.' });
      await h.sleep(2500);
      const out = (await p.locator('#renew-result').innerText()).trim();
      await h.point(p.locator('#renew-result'), out.slice(0, 60), 'Due boxes became orders.', 5000);
    });
  }
}

const TRY = { 1: tryShop, 2: async (h, p) => { await tryFilters(h, p); await tryCancel(h, p); }, 3: trySubscriptions };

// ---------------------------------------------------------------------------------------------------------------------------------
/** Review a task's pull request: checks, the live version of the change, a decision. Everything is idempotent. */
async function reviewTask(h, p, ix, stage, n) {
  const key = ix.title.match(/\bT\d+/)[0];
  const ask = askFor(p, `${key}:`);
  await ask.waitFor({ timeout: 30000 });
  const mode = MODES[stage];
  await act(
    h,
    `${key} is ready, and its pull request is waiting in the Attention queue, the tab I am on. The title says what it does: ${ix.title.replace(/^.*\bT\d+:\s*/, '')}. The card shows what changed, and the agent\u2019s own summary.`,
    async () => {
      await h.point(ask.getByRole('heading', { level: 3 }), 'A task, as a pull request', 'Built by an engineer agent.', 4000);
      await h.scrollBy(450, 4500);
    },
  );
  const secBtn = ask.getByRole('button', { name: /^Run the security review( again)?$/ });
  const smokeBtn = ask.getByRole('button', { name: /^Run the smoke test( again)?$/ });
  if (mode === 'guided') {
    if (await secBtn.count())
      await act(h, 'This is guided mode, so the checks wait for me. I click Run the security review, so a model reads the diff. The reviewer is a model read through the platform gateway, a second reader for the work of the first.', () =>
        h.click(secBtn, { label: 'Run the security review', why: 'A model reads the diff and reports findings.' }),
      );
    if (await smokeBtn.count())
      await act(h, 'And I click Run the smoke test, so the platform starts the real app from this pull request, with its own DynamoDB table, and calls it with the checks the design listed.', () =>
        h.click(smokeBtn, { label: 'Run the smoke test', why: 'Start the real app and call it.' }),
      );
  } else {
    await act(
      h,
      n === 1
        ? `This is ${mode} mode, so I did not have to click anything: the platform started the security review on its own, and the smoke test too, as soon as a preview slot was free. Fewer clicks for me, the same checks.`
        : 'Again the platform started both checks on its own.',
      () => h.sleep(600),
    );
  }
  await h.sleep(4000);
  await h.waitUntil(
    'the checks',
    async () => {
      const [a, b] = [await stateOf(ask, 'security'), await stateOf(ask, 'smoke')];
      console.log('  states', a, b);
      return settled(a) && (b === 'absent' ? true : settled(b));
    },
    900000,
    4000,
  );
  const sec = (await ask.getByTestId('security').count()) ? await ask.getByTestId('security').innerText() : '';
  const smoke = (await ask.getByTestId('smoke').count()) ? await ask.getByTestId('smoke').innerText() : '';
  console.log('  SECURITY:', sec.replace(/\s+/g, ' ').slice(0, 400));
  console.log('  SMOKE:', smoke.replace(/\s+/g, ' ').slice(0, 400));
  if (smoke) {
    const m = smoke.match(/(\d+)\s*(?:of|\/)\s*(\d+)/);
    await act(
      h,
      m ? `The smoke test started the real app and called it. ${m[1]} of ${m[2]} checks passed.` : 'The smoke test is back.',
      () => h.point(ask.getByTestId('smoke'), 'The smoke test', 'The real app, started and called.', 6000),
    );
  }
  await act(
    h,
    /no findings/i.test(sec)
      ? 'The security review is back, and it found nothing. A model read the change, and said what it looked at. Only high or critical findings would block a merge.'
      : 'The security review is back with findings. Only high or critical findings block a merge, and the rest stay on the record.',
    () => h.point(ask.getByTestId('security'), 'The security review', 'Only high or critical findings block.', 6500),
  );
  return { ask, key, sec, smoke };
}

/** A pull request can be run when it adds the preview file, or the main branch already has one. */
function canPreview(ix, stage) {
  const gh = (apiPath) => {
    try {
      return execFileSync('gh', ['api', apiPath], { stdio: 'pipe' }).toString();
    } catch {
      return null;
    }
  };
  const num = ix.title.match(/PR #(\d+)/)?.[1];
  const files = num ? gh(`repos/lrama1/sdlc-scratch/pulls/${num}/files?per_page=100`) : null;
  if (stage > 1) return Boolean(files?.includes('index.html'));
  if (files?.includes('.sdlc/preview.yaml')) return true;
  return gh('repos/lrama1/sdlc-scratch/contents/.sdlc/preview.yaml?ref=main') !== null;
}

async function previewAndTry(h, p, ask, stage, key, ix) {
  const prev = ask.getByTestId('preview');
  if (!(await prev.count()) || !canPreview(ix, stage)) return false;
  const run = prev.getByRole('button', { name: /Run it (again|here)/ });
  if (await run.count())
    await act(
      h,
      'Now the part that matters most. The platform can run this pull request as a live, isolated, testable version of the application, so I can use the change before I approve it. I click Run it here, and the platform starts this pull request\u2019s own code in a sandbox on AWS, with no secrets and almost no network, and with a DynamoDB table of its own, for thirty minutes.',
      () => h.click(run.first(), { label: 'Run it here', why: 'Start the proposed change as a live copy.' }),
    );
  await h.waitUntil('the preview', async () => (await prev.getAttribute('data-state')) === 'ready', 420000, 2000);
  const link = prev.getByRole('link').first();
  const href = await link.getAttribute('href');
  await act(
    h,
    'The preview is ready, and the card has a link to it. I open it in its own browser tab, because it is a separate address from the platform: the code under review cannot act as me on the platform, and only I can reach it.',
    async () => {
      await h.point(link, 'The preview link', 'Opens the proposed change, running.', 2500);
      await h.browserTab('The live preview of the shop', 'A live, isolated copy of the change, on its own DynamoDB table.', href);
    },
  );
  await TRY[stage](h, p);
  await act(h, 'The change works as described, in an environment that exists only for this review. Now I go back to the platform tab to decide.', () =>
    h.backToPlatform('/#/queue', 'The decision is made on the platform, not in the preview.'),
  );
  return true;
}

const handle = (n, stage) => ({
  url: '/#/map',
  title: `${n} \u00b7 A decision is waiting`,
  async run(h) {
    const p = h.page;
    T(stage)();
    const ix = await h.waitUntil('an ask', async () => nextAsk(p), 600000, 3000);
    await h.chapter(`${n} \u00b7 ${ix.title.slice(0, 70)}`);
    await act(
      h,
      n === 1 || stage === 1
        ? 'An agent needs me. I switch to the Attention queue tab, because that is where anything waiting for a person lands.'
        : 'Something is waiting. I switch to the Attention queue tab.',
      () => h.tab('Attention queue', 'Something is waiting for a person.'),
    );
    const ask = askFor(p, ix.title.slice(0, 40));
    await ask.waitFor({ timeout: 30000 });
    if (isTask(ix)) {
      const { key } = await reviewTask(h, p, ix, stage, n);
      const hadPreview = await previewAndTry(h, p, askFor(p, `${key}:`), stage, key, ix);
      const a2 = askFor(p, `${key}:`);
      await a2.waitFor({ timeout: 30000 });
      await act(
        h,
        hadPreview
          ? 'Back in the platform tab. The card shows every step accounted for on this commit, and I have used the change myself, in its own live copy. That is why I approve.'
          : stage === 1
            ? 'This change has nothing to run on its own yet, so I decide from the checks and the diff.'
            : 'This task changes the rules and the data layer, which no route and no page use yet, so there is nothing new to run. The live copy comes with the task that exposes it, and I decide this one from the checks and the diff.',
        () => h.point(a2.getByTestId('review-flow'), 'Every step is accounted for', 'Nothing blocks the approval.', 6000),
      );
      await act(h, 'I add a comment, and click Approve.', async () => {
        await h.type(a2.getByLabel('Comment'), 'Works as described. Approved.', { label: 'Type a comment', why: 'It stays with the decision.', delay: 28 });
        await h.click(a2.getByRole('button', { name: 'Approve' }), { label: `Approve ${key}`, why: 'The checks are clean and I used the change.' });
      });
      await h.sleep(3500);
      return;
    }
    if (/external system/i.test(ix.title)) {
      await act(
        h,
        'The agent wants to call Amazon DynamoDB, and it is not in the Integration Register, so the platform will not let it open that connection until a person confirms. This is a hard stop. The card says which host and why, and which documentation the agent relies on: the two links I gave when I created the initiative. This is the AWS part of the platform being intentional: the apps it builds default to AWS services, in the same account as the platform, so adopting it takes no extra accounts or credentials. Another provider would be one more entry in this register, plus a new adapter in the app.',
        () => h.point(ask.getByRole('heading', { level: 3 }), 'A new outside system: Amazon DynamoDB', 'Agents may call it only after a person confirms.', 12000),
      );
      await act(h, 'I choose Confirm, because DynamoDB is exactly the data store I asked for, and then I click Answer.', async () => {
        await h.click(ask.getByRole('radio', { name: /confirm/i }), { label: 'Choose: Confirm', why: 'DynamoDB is the store I asked for.' });
        await h.click(ask.getByRole('button', { name: 'Answer' }), { label: 'Answer', why: 'Add DynamoDB to the register.' });
      });
      await h.sleep(2500);
      return;
    }
    if (/Leave preview\.yaml/i.test((ix.options ?? []).map((o) => o.label).join(' '))) {
      await act(
        h,
        'The engineer cannot edit the protected preview file itself, so it asks me to add one more smoke check by hand, or to leave the file as it is. I do not want to edit files by hand in the middle of a build, and the existing smoke checks and the page tests already cover this change, so I choose to leave the file as it is. That is my call, and the agent carries on.',
        async () => {
          await h.point(ask.getByRole('heading', { level: 3 }), 'A question from the engineer', 'It cannot edit a protected file.', 4000);
          await h.click(ask.getByRole('radio', { name: /Leave preview\.yaml/i }), { label: 'Choose: leave the file as it is', why: 'Existing checks already cover this.' });
        },
      );
      await act(h, 'And I click Answer.', () => h.click(ask.getByRole('button', { name: 'Answer' }), { label: 'Answer', why: 'Send the decision to the agent.' }));
      await h.sleep(2500);
      return;
    }
    if (/Protected path|preview\.yaml/i.test(ix.title)) {
      await act(
        h,
        'The agent edited a protected path: dot sdlc slash preview dot yaml. Protected paths are files an agent may never change on its own, so the platform stops it. That file tells the platform how to start the app and which smoke checks to run, so it is also what makes the live preview possible. The design asks for it, so I choose Allow.',
        async () => {
          await h.point(ask.getByRole('heading', { level: 3 }), 'A protected file', 'An agent may never change these on its own.', 4000);
          await h.click(ask.getByRole('radio', { name: /^Allow/i }).first(), { label: 'Choose: Allow', why: 'The design needs this file to start the app.' });
        },
      );
      await act(h, 'And I click Answer.', () => h.click(ask.getByRole('button', { name: 'Answer' }), { label: 'Answer', why: 'Send the decision to the agent.' }));
      await h.sleep(2500);
      return;
    }
    // Any other question: take the recommendation, and say so.
    const rec = await pickRec(ask, ix);
    await act(
      h,
      `The agent asks: ${ix.title}. The card carries a recommendation, and I agree with it.`,
      async () => {
        await h.point(ask.getByRole('heading', { level: 3 }), 'A question from an agent', 'It blocks the run until answered.', 5000);
        if (rec.count) await h.click(rec.radio, { label: `Choose: ${rec.label}`, why: 'It is the recommended choice.' });
      },
    );
    await act(h, 'And I click Answer.', () => h.click(ask.getByRole('button', { name: 'Answer' }), { label: 'Answer', why: 'Send the decision to the agent.' }));
    await h.sleep(2500);
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------
const form = (p) => p.locator('form', { hasText: 'New initiative' });

const newInitiative = (stage) => ({
  url: '/#/map',
  title: stage === 1 ? 'Stage 1 \u00b7 Give the platform a goal' : `Stage ${stage} \u00b7 Add features to the shop that exists`,
  async run(h) {
    T(stage)();
    const f = form(h.page);
    const goal = { 1: GOAL1, 2: GOAL2, 3: GOAL3 }[stage];
    await act(h, 'At the bottom of the Map tab is the form for a new initiative. An initiative is one goal, with its own spec, design, tasks and cost.', async () => {
      await f.waitFor({ timeout: 30000 });
      await h.scrollBy(2000, 3000);
    });
    await act(h, 'I click the Title box and name it, so I can find this initiative in lists and in the queue.', () =>
      h.type(f.getByLabel('Title'), TITLES[stage], { label: 'Type a title', why: 'The name I will look for later.' }),
    );
    await act(
      h,
      stage === 1
        ? 'The repository is where the agents are allowed to work. Only registered repositories appear. I leave the scratch repository selected.'
        : 'The repository is the same one. The agents will read the code that the earlier stages merged, and build on top of it.',
      () => h.point(f.getByLabel('Repository'), 'Repository the agents may change', 'Only registered repositories can be picked.', 3000),
    );
    await act(
      h,
      stage === 1
        ? 'This is the new Type box. The repository is empty, so this is a New app, and the platform knows to expect a first build. For later work on the same repository it suggests Feature, and the agents are told to build on the code that exists.'
        : 'This is a Feature, work on an app that already exists. The platform suggested it by itself, because the repository already has an initiative, and it tells the agents to read the existing code and keep the existing tests passing.',
      async () => {
        await h.point(f.getByLabel('Type'), `Type: ${KINDS[stage] === 'new_app' ? 'New app' : 'Feature'}`, 'Suggested from what the repository holds.', 3500);
        await f.getByLabel('Type').selectOption(KINDS[stage]);
      },
    );
    const say = {
      guided: 'Then how much runs on its own. I choose Guided, so a person starts every stage and reviews every pull request, because I want you to see each decision.',
      balanced: 'Then how much runs on its own. This time I choose Balanced. Pre-approved kinds of change merge by themselves, the checks start on their own, and I still review the code. The stages follow each other without my clicks.',
      autopilot: 'And now how much runs on its own: Autopilot. The spec and the design still wait for me, because a person always decides what gets built. After that, any pull request that fires no trigger and passes its checks merges without me.',
    }[MODES[stage]];
    await act(h, say, async () => {
      await h.point(f.getByLabel('How much runs on its own'), `Autonomy: ${MODES[stage]}`, 'How much runs without a person.', 1800);
      await f.getByLabel('How much runs on its own').selectOption(MODES[stage]);
      await h.sleep(1200);
    });
    await act(
      h,
      {
        1: 'Now the goal, written the way a product owner briefs a team: who the shoppers are, what a plant, a cart and an order are, the rules of checkout, and how the data is stored: one DynamoDB table. It names the ids that the page must carry, so that checks and people can find things. And near the end, a sentence about the cloud. The shop is intentionally built for AWS, and I ask that every call to AWS live in a single file behind a small interface, so that moving to another cloud later means writing one new adapter.',
        2: 'The goal is a change request: filters for light and for pet safety, a care sheet for every plant, stock labels, and a cancel that puts the stock back. It says to use the existing table and the existing data interface, so that the new access to AWS lands in the same single file, and to keep the existing tests passing.',
        3: 'The goal is a bigger feature: a monthly plant-care subscription box. Plans, subscribing with a card, pausing, resuming and cancelling, and renewals that turn due subscriptions into orders. Again it says to use the existing table and the existing interface, so everything that talks to AWS stays in one file.',
      }[stage],
      () => h.type(f.getByLabel('Goal'), goal, { label: 'Type the goal', why: 'A real brief, not a one-liner.', delay: 2 }),
    );
    if (stage === 1)
      await act(
        h,
        'Then the reference links. The shop has to call Amazon DynamoDB, an outside system, so I paste two pages of its documentation, one about transactions and one about table design. Every agent is told about these links.',
        () => h.type(f.getByLabel('Reference links'), LINKS1, { label: 'Paste the documentation links', why: 'The agents read these before using DynamoDB.', delay: 6 }),
      );
    else
      await act(
        h,
        'There is no new outside system this time. DynamoDB is already in the Integration Register, so the agents will not have to ask me about it again. I leave the reference links empty.',
        () => h.sleep(500),
      );
    await act(
      h,
      stage === 1
        ? 'I click Create, because that records the goal. In guided mode nothing starts yet.'
        : 'I click Create. Because the stages are set to follow each other, the product agent starts drafting the spec right away.',
      () => h.click(f.getByRole('button', { name: 'Create' }), { label: 'Create', why: stage === 1 ? 'Record the goal. Nothing starts yet.' : 'Record the goal and start the spec.' }),
    );
    await h.sleep(2500);
  },
});

const assistant = (id, title, question, say, after) => ({
  url: '/#/map',
  title,
  async run(h) {
    const p = h.page;
    await act(h, say, async () => {
      await h.click(p.getByTestId('assistant-fab'), { label: 'Open the assistant', why: 'It knows this screen and can answer questions.' });
      await h.sleep(800);
    });
    const box = p.getByLabel('Ask the assistant');
    await act(h, `I type my question: ${question}`, () => h.type(box, question, { label: 'Type a question', why: 'Ask in plain words.', delay: 38 }));
    await act(h, 'And I press Enter, to send it.', async () => {
      await h.click(p.getByRole('button', { name: 'Send' }), { label: 'Send', why: 'Ask the assistant.' });
    });
    await p.getByTestId('assistant-working').waitFor({ timeout: 15000 }).catch(() => {});
    await p.getByTestId('assistant-working').waitFor({ state: 'detached', timeout: 120000 }).catch(() => {});
    await h.sleep(1500);
    await act(h, after, async () => {
      await h.point(p.getByTestId('assistant-messages'), 'The assistant\u2019s answer', 'It knows this screen and the platform.', 9000);
    });
    await p.keyboard.press('Escape');
    await h.sleep(800);
  },
});

/** The page task, whose preview file starts the app on the in-memory store: ask the assistant, then send it back. */
const catchMemoryStore = {
  url: '/#/map',
  title: 'A reviewer\u2019s catch: the preview would not use DynamoDB',
  async run(h) {
    const p = h.page;
    T(1)();
    const ix = await h.waitUntil('T4', async () => (await interactions(p)).find((i) => i.initiativeTitle === cur() && /\bT4:/.test(i.title)), 60000, 2000);
    await act(h, 'The last task, the shop page, is ready. I switch to the Attention queue tab, because that is where it waits for me.', () =>
      h.tab('Attention queue', 'The page task is waiting for a decision.'),
    );
    const { ask } = await reviewTask(h, p, ix, 1, 4);
    await act(
      h,
      'Both checks passed, but a pass is not the same as right. This task adds the file that tells the platform how to start the app for a live preview, and I want that preview to run on DynamoDB, not on something fake. I do not want to leave the platform to read the diff, so I ask the assistant. It can read the pull request.',
      async () => {
        await h.click(p.getByTestId('assistant-fab'), { label: 'Open the assistant', why: 'It can read this pull request for me.' });
        await h.sleep(800);
      },
    );
    const q = 'Look at the preview file this pull request adds. Will the live preview of this change use DynamoDB or something else?';
    await act(h, 'I type my question, and send it.', async () => {
      await h.type(p.getByLabel('Ask the assistant'), q, { label: 'Type a question', why: 'Ask in plain words.', delay: 30 });
      await h.click(p.getByRole('button', { name: 'Send' }), { label: 'Send', why: 'Ask the assistant.' });
    });
    await p.getByTestId('assistant-working').waitFor({ timeout: 15000 }).catch(() => {});
    await p.getByTestId('assistant-working').waitFor({ state: 'detached', timeout: 150000 }).catch(() => {});
    await h.sleep(1500);
    await act(
      h,
      'It read the files of the pull request, the steps are listed, and it found the line: the preview starts the app with STORE equals memory. So the live copy would run on an in-memory store, and it would never touch DynamoDB, the one thing I most want to try before approving.',
      () => h.point(p.getByTestId('assistant-messages'), 'The assistant read the pull request', 'It found STORE=memory in the preview file.', 12000),
    );
    await p.keyboard.press('Escape');
    await h.sleep(800);
    const a2 = askFor(p, 'T4:');
    await act(h, 'So I do not approve. In the Comment box I say what to change: the platform gives every preview its own DynamoDB table, in the environment variable TABLE_NAME, so the preview file should start the app without the memory setting.', () =>
      h.type(
        a2.getByLabel('Comment'),
        'The live preview must run on DynamoDB, not the in-memory store. The platform gives every preview its own table through TABLE_NAME and AWS_REGION, so start the app with node src/main.js and no STORE=memory. Keep STORE=memory for unit tests only, and keep the smoke checks.',
        { label: 'Type a comment', why: 'It goes to the engineer agent with the task.', delay: 14 },
      ),
    );
    await act(h, 'And I click Request changes, which sends the task back to an engineer agent, with my words.', () =>
      h.click(a2.getByRole('button', { name: 'Request changes' }), { label: 'Request changes', why: 'Send it back with what I found.' }),
    );
    await h.sleep(3000);
  },
};

/** Wait (sped up) until every task of the stage's plan is merged, and say what it means. */
const stageDone = (stage, say) => ({
  url: '/#/map',
  lapse: true,
  title: `Stage ${stage} \u00b7 The build is complete`,
  async run(h) {
    const p = h.page;
    T(stage)();
    h.say(say);
    await pickInitiative(h);
    await h.waitUntil(
      'the build to be done',
      async () => {
        const list = await (await p.request.get(`${BASE}/api/initiatives`)).json();
        const it = list.find((i) => i.title === cur());
        if (!it) return false;
        const m = await (await p.request.get(`${BASE}/api/initiatives/${it.id}/map`)).json();
        const b = m.stages.find((s) => s.id === 'build');
        console.log('  build:', b?.status);
        return b?.status === 'done';
      },
      1_500_000,
      6000,
    );
    await h.point(p.getByTestId('build-plan'), `Stage ${stage}: every task merged`, 'The plan is complete.', 5000);
  },
});

const bridge = (stage, say) => ({
  url: '/#/costs',
  title: `Stage ${stage} \u00b7 ${stage === 2 ? 'Add features to the shop that exists' : 'A bigger feature, with fewer clicks'}`,
  async run(h) {
    T(stage)();
    await h.say(say);
    await h.tab('Map', 'A new initiative is created on the Map tab.');
  },
});

/** Preview the finished app from the Build box: the main branch, run live in its own sandbox. */
const previewBuilt = (stage) => ({
  url: '/#/map',
  title: `Stage ${stage} \u00b7 Preview the built app`,
  async run(h) {
    const p = h.page;
    T(stage)();
    await pickInitiative(h);
    const box = p.getByTestId('stage-build');
    await act(
      h,
      'In this stage nobody reviewed a pull request, so I never got a live copy of each change. But the finished app is just as testable. The Build box on the Map has a button, Preview the built app, and I click it, because I want to use the whole shop, as it is on the main branch, before I call this stage done.',
      () => h.click(box.getByRole('button', { name: /Preview the built app/ }), { label: 'Preview the built app', why: 'Run the finished app, live, in its own sandbox.' }),
    );
    const open = box.getByRole('link', { name: /Open the preview|Open the built app|Open/ }).first();
    await open.waitFor({ timeout: 420000 });
    const href = await open.getAttribute('href');
    await act(
      h,
      'The platform started the main branch in an isolated sandbox with its own DynamoDB table. It opens as a separate browser tab, and I use it like a shopper.',
      async () => {
        await h.point(open, 'The built app is running', 'A live, isolated copy of the main branch.', 3000);
        await h.browserTab('The live, built shop', 'The finished app on its own DynamoDB table.', href);
      },
    );
    await TRY[stage](h, p);
    await act(h, 'Now back to the platform tab.', () => h.backToPlatform('/#/map', 'Where the stage is decided.'));
  },
});

const interruptions = (stage) => ({
  url: '/#/map',
  title: `Stage ${stage} \u00b7 How often did the agents interrupt me?`,
  async run(h) {
    const p = h.page;
    T(stage)();
    await act(
      h,
      'Before the next stage, I switch to the Interruptions tab, because I want to know how often the agents asked me for something, and whether those questions were worth asking.',
      () => h.tab('Interruptions', 'How often agents ask, and what to tune.'),
    );
    await act(
      h,
      'It shows questions per merged pull request, how often I just accepted the recommendation, and which kinds of ask could be a standing decision. For example, the protected file question was answered with the recommendation every time, so the platform suggests making it a standing decision. It only suggests. I change the rules by hand. And in balanced mode, the platform answered one of those questions by itself, because a rule pre-approves that one file when the task names it.',
      async () => {
        await h.point(p.getByRole('heading', { name: 'Interruptions' }).first(), 'Interruptions', 'Measures how often agents ask, and how useful it was.', 3000);
        await h.scrollBy(500, 4000);
        await h.sleep(5000);
      },
    );
  },
});

/** Autopilot holds a change that has high findings. A person decides, and autopilot carries on. */
const autopilotHeld = {
  url: '/#/map',
  title: 'Autopilot stops at a high finding',
  async run(h) {
    const p = h.page;
    T(3)();
    const ix = await h.waitUntil('T2', async () => (await interactions(p)).find((i) => i.initiativeTitle === cur() && /\bT2:/.test(i.title)), 60000, 2000);
    await act(h, 'The platform has something for me, even in autopilot. I switch to the Attention queue tab.', () =>
      h.tab('Attention queue', 'Autopilot held a pull request for a person.'),
    );
    const ask = askFor(p, 'T2:');
    await ask.waitFor({ timeout: 30000 });
    await act(
      h,
      'This is the second task, the rules and the routes for subscriptions. In autopilot, a pull request that fires no trigger and passes its checks merges on its own. The checks ran by themselves, and the smoke test passed all nine checks. But the security review found two high findings, and Approve is waiting on them. Autopilot does not override a high finding: it hands the change to a person.',
      async () => {
        await h.point(ask.getByRole('heading', { level: 3 }), 'Held by a high finding', 'Autopilot never overrides a high finding.', 3500);
        await h.scrollBy(900, 6000);
        await h.point(ask.getByTestId('approve-blocked'), 'Approve is waiting on the security review', 'Two high findings nobody has fixed or dismissed.', 8000);
      },
    );
    const sec = ask.getByTestId('security');
    await act(
      h,
      'The findings are fair. Anyone who knows the address could trigger a renewal run, and a subscription is read and cancelled by email address alone. The goal said the shop has no accounts or staff area in this version, so both come from what I asked for. Before I decide, I want to see the routes alive, so I open the live preview of this pull request. It is a separate, isolated copy, on its own DynamoDB table, and the plans are read from there.',
      async () => {
        await h.point(sec, 'Two high findings', 'Read from the pull request.', 3500);
        const prev = ask.getByTestId('preview');
        const link = prev.getByRole('link').first();
        if (await link.count()) {
          const href = await link.getAttribute('href');
          await h.point(link, 'The live preview of this change', 'Already running, started by the platform.', 2500);
          await h.browserTab('The live preview: the plans route', 'The proposed change, running on its own DynamoDB table.', href + (href.endsWith('/') ? '' : '/') + 'api/plans');
          await h.sleep(5000);
        }
      },
    );
    await act(h, 'Back to the platform tab, because the decision is made here.', () =>
      h.backToPlatform('/#/queue', 'The decision is made on the platform.'),
    );
    const a2 = askFor(p, 'T2:');
    await a2.waitFor({ timeout: 30000 });
    const s2 = a2.getByTestId('security');
    await act(
      h,
      'This is a demonstration with simulated payments, and accounts and staff are out of scope, so I accept both risks, on the record. In a real shop I would send the change back for authentication instead. I click Dismiss the first finding with a reason.',
      () => h.click(s2.getByRole('button', { name: /Dismiss F1 with a reason/ }), { label: 'Dismiss F1 with a reason', why: 'A risk I accept, on the record.' }),
    );
    await act(h, 'I type the reason, and confirm.', async () => {
      await h.type(s2.getByLabel('Why F1 is dismissed'), 'Simulated billing in a demo. Staff accounts are out of scope for this version.', { label: 'Type the reason', why: 'It stays with the pull request.', delay: 22 });
      await h.click(s2.getByRole('button', { name: 'Dismiss', exact: true }), { label: 'Dismiss', why: 'Record the reason.' });
    });
    await h.sleep(1500);
    await act(h, 'And the second one, the same way.', async () => {
      await h.click(s2.getByRole('button', { name: /Dismiss F2 with a reason/ }), { label: 'Dismiss F2 with a reason', why: 'A risk I accept, on the record.' });
      await h.type(s2.getByLabel('Why F2 is dismissed'), 'No accounts in this version: an email address is the only identity, by design.', { label: 'Type the reason', why: 'It stays with the pull request.', delay: 22 });
      await h.click(s2.getByRole('button', { name: 'Dismiss', exact: true }), { label: 'Dismiss', why: 'Record the reason.' });
    });
    await h.sleep(2000);
    await act(
      h,
      'Nothing is blocking now, and I do not click Approve. This is autopilot: once the findings are decided and the checks are green, the platform approves the pull request by rule, and the gate merges it. I wait for it.',
      async () => {
        await h.waitUntil('autopilot to approve', async () => !(await interactions(p)).some((i) => i.id === ix.id), 400000, 4000);
      },
    );
  },
};

/** A smoke test that failed: an AI explains why, and the engineer is sent the fix. */
const smokeFailed = {
  url: '/#/map',
  title: 'A failed smoke test: explain it, then send it back',
  async run(h) {
    const p = h.page;
    T(3)();
    await h.waitUntil('T3', async () => (await interactions(p)).find((i) => i.initiativeTitle === cur() && /\bT3:/.test(i.title)), 60000, 2000);
    await act(h, 'Autopilot has stopped again, so I switch to the Attention queue tab.', () =>
      h.tab('Attention queue', 'Autopilot held another pull request.'),
    );
    const ask = askFor(p, 'T3:');
    await ask.waitFor({ timeout: 30000 });
    const smoke = ask.getByTestId('smoke');
    await act(
      h,
      'This is the page task, the subscribe view. This time the smoke test failed. It passed nine of ten checks. The checks run by themselves in autopilot, and a failed check always goes to a person. One line has a cross. But what does it mean? I click Explain why it failed, because an AI can read the failure together with the design and the preview file, for a few cents, and say what to do.',
      async () => {
        await h.scrollBy(800, 4000);
        await h.point(smoke, 'A smoke test failed: 9 of 10', 'A failed check always goes to a person.', 5000);
        await h.click(smoke.getByRole('button', { name: 'Explain why it failed' }), { label: 'Explain why it failed', why: 'An AI reads the failure and says what to do.' });
      },
    );
    const dx = ask.getByTestId('smoke-diagnosis');
    await dx.waitFor({ timeout: 180000 });
    const verdict = await dx.getAttribute('data-verdict');
    const text = (await dx.innerText()).replace(/\s+/g, ' ');
    console.log('  DIAGNOSIS:', verdict, text.slice(0, 500));
    await act(
      h,
      verdict === 'checks'
        ? 'The reading says the smoke checks are out of date, not the code. The design requires one more check, for the new subscribe page, and the preview file does not list it, because earlier I told the engineer to leave that file alone. It is marked as an AI reading, not verified, and it suggests asking the engineer to update the smoke checks.'
        : 'The reading is marked as an AI reading, not verified. It says what it thinks went wrong, and what to do next.',
      () => h.point(dx, 'An AI reading, not verified', 'It advises. A person decides.', 14000),
    );
    const action = dx.getByRole('button', { name: /Ask the engineer to/ });
    await act(
      h,
      'I agree, so I click the button it offers. It sends the task back to the engineer, with the failed check and the reading in the message, and the engineer will edit the preview file. I will be asked to allow that protected file before anything is pushed.',
      () => h.click(action, { label: 'Ask the engineer to fix it', why: 'Send it back with the failed check and the reading.' }),
    );
    await h.sleep(3000);
  },
};

/** The fixed page task: checks pass, the live copy is used, the one finding is decided, and autopilot merges it. */
const pageAfterFix = {
  url: '/#/map',
  title: 'The fixed page: use it live, decide the finding',
  async run(h) {
    const p = h.page;
    T(3)();
    const ix = await h.waitUntil('T3', async () => (await interactions(p)).find((i) => i.initiativeTitle === cur() && /\bT3:/.test(i.title)), 60000, 2000);
    await act(h, 'The engineer is done, and the new pull request is waiting. I switch to the Attention queue tab.', () =>
      h.tab('Attention queue', 'The reworked page task is waiting.'),
    );
    const { ask } = await reviewTask(h, p, ix, 3, 3);
    await previewAndTry(h, p, askFor(p, 'T3:'), 3, 'T3', ix);
    const a2 = askFor(p, 'T3:');
    await a2.waitFor({ timeout: 30000 });
    const s2 = a2.getByTestId('security');
    await act(
      h,
      'The smoke test passes now, all ten checks. One high finding is left, the same one as before: anyone can run the renewals, and this page makes the button easy to reach. I accept it for this demo, with the reason on the record, so I click Dismiss with a reason.',
      async () => {
        await h.point(a2.getByTestId('smoke'), 'Smoke test: all checks pass', 'The missing check was added.', 4000);
        await h.click(s2.getByRole('button', { name: /Dismiss F1 with a reason/ }), { label: 'Dismiss F1 with a reason', why: 'A risk I accept, on the record.' });
      },
    );
    await act(h, 'I type the reason, and confirm.', async () => {
      await h.type(s2.getByLabel('Why F1 is dismissed'), 'Simulated billing in a demo. Staff accounts are out of scope for this version.', { label: 'Type the reason', why: 'It stays with the pull request.', delay: 22 });
      await h.click(s2.getByRole('button', { name: 'Dismiss', exact: true }), { label: 'Dismiss', why: 'Record the reason.' });
    });
    await act(h, 'And again I do not click Approve. Autopilot approves it by rule now that the checks are green and the findings are decided.', async () => {
      await h.waitUntil('autopilot to approve', async () => !(await interactions(p)).some((i) => i.id === ix.id), 400000, 4000);
    });
  },
};

const autopilotPage = {
  url: '/#/map',
  title: 'What autopilot did',
  async run(h) {
    const p = h.page;
    T(3)();
    await act(
      h,
      'To see what autopilot did on its own, I switch to the Autopilot tab. It is the record of what merged by rule, what a person reviewed, and what was held.',
      () => h.tab('Autopilot', 'What merged by rule, and what was held for a person.'),
    );
    await h.sleep(1500);
    const txt = await p.locator('main, body').first().innerText();
    const num = (label) => txt.match(new RegExp(`(\\d+)\\s*\\n?\\s*${label}`, 'i'))?.[1];
    const [rule, person, held] = [num('Approved by rule'), num('Reviewed by a person'), num('Held for a person')];
    console.log('  autopilot counts:', rule, person, held);
    await act(
      h,
      `Across the stages, ${rule ?? 'some'} pull requests were approved by rule, ${person ?? 'some'} were reviewed by a person, and ${held ?? 'none'} are still held. Each row says why. In autopilot, a pull request merged by rule only after its checks were green. The two that autopilot held, a high finding and a failed smoke test, came to me, and I decided.`,
      async () => {
        await h.point(p.getByRole('heading', { name: 'Autopilot' }).first(), 'Autopilot', 'What may merge without a review, what did, and what was held.', 3000);
        await h.scrollBy(500, 5000);
        await h.sleep(5000);
      },
    );
  },
};

const costsPage = {
  url: '/#/map',
  title: 'What three stages cost',
  async run(h) {
    await act(
      h,
      'Finally, the Costs tab. I switch to it, because I want to know what three stages cost. Every agent run is metered through the model gateway, against a budget, so the cost of what I just watched is on the record, by day, by agent and by model.',
      () => h.tab('Costs', 'What the three stages cost, by agent and by model.'),
    );
    await h.sleep(9000);
  },
};

const outroScene = {
  url: '/#/costs',
  title: 'The end',
  async run(h) {
    const talk = h.say(
      'That was an online plant shop on DynamoDB, built in three stages on a platform running in AWS, with a person at every decision that mattered. The agents were Claude Code, each in its own sandbox. Along the way the platform stopped an agent at a new outside system, and before every approval it gave me a live, isolated, testable copy of the change to try. An assistant read a pull request and caught a preview that would not have used DynamoDB. In the last stage, autopilot merged what was clean, held a pull request at a high finding, and explained a failed smoke test. One last word on the cloud. The platform and the shop are intentionally built for AWS, to make adopting them as easy as possible, and every call to AWS lives in a single file behind a small interface, so refactoring for another cloud is a matter of writing one new adapter. Every step I showed was a person clicking a button, and I said why. Thanks for watching.',
    );
    await h.tab('Portfolio', 'Three initiatives on one repository: a new app, and two features.');
    await talk;
  },
};

export const scenes = {
  s3_autopilot: autopilotPage,
  costs: costsPage,
  outro: outroScene,
  assist2: assistant(
    'assist2',
    'Ask the assistant about an initiative',
    'What did autopilot merge by itself in the subscription box initiative, and what did it hold for me?',
    'One more use of the assistant. It can also answer questions about any initiative I can see. I open it again.',
    'It read the initiative and the pull requests, and answers in plain words. I can ask about anything on the platform without hunting through pages.',
  ),
  s3_page: pageAfterFix,
  s3_smoke: smokeFailed,
  s3_held: autopilotHeld,
  t4a: catchMemoryStore,
  s2_interruptions: interruptions(2),
  s2_intro: bridge(2, 'Stage one is done: a working shop on DynamoDB, built and merged. Now stage two. A real product keeps changing, so I give the platform a second initiative on the same repository, to add features to the shop that is already there. It goes through the same flow: spec, design, build, and every change is again proposed as a live, isolated, testable version of the shop before I approve it. This time I choose a different level of autonomy, to show what changes.'),
  s3_intro: bridge(3, 'Two stages are done. For the third, I add a bigger feature, a monthly plant care subscription, and I let the platform run with the least supervision it offers. I will still decide what gets built, but I want to see how many clicks it takes.'),
  s3_preview: previewBuilt(3),
  s1_done: stageDone(1, 'The gate waits for the repository\u2019s CI, which installs the packages and passes, merges the last pull request, and the plan is complete. Four tasks, each reviewed by a person, and each proposed as a pull request.'),
  s2_done: stageDone(2, 'The gate merges the last pull request of the second stage. The plan is complete.'),
  s3_done: stageDone(3, 'The gate merges the last pull request of the third stage, and the plan is complete.'),
  intro: {
    anon: true,
    url: '/',
    title: 'Autonomous SDLC',
    async run(h) {
      const talk = h.say(
        'This is Autonomous SDLC, a platform where AI agents build software and people stay in charge. ' +
          'Agents write the spec, design the solution, build each task in a sandbox, and open pull requests. Each of them is driven by Claude Code, running in its own isolated container, and every model call goes through the platform\u2019s gateway, so that it is metered and capped. People decide at clear checkpoints. ' +
          'In this video I build an online plant shop, in three stages: first the shop itself, then two initiatives that add features to it, using the same flow every time. ' +
          'One thing to say up front. The platform, and the apps it builds here, are intentionally made for Amazon Web Services, so that adoption is as easy as possible: one cloud account, one set of services, a few clicks. ' +
          'It is not locked in. The agents, the model gateway and GitHub are cloud neutral, and I ask the agents to keep every call to AWS in a single file, so that moving the shop to another cloud later is a refactor, not a rewrite. ' +
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
      await act(h, 'The Portfolio tab lists every initiative with its stage, its type and its cost. It is empty, because this is a fresh deployment.', () =>
        h.tab('Portfolio', 'Every initiative, its stage, its type and its cost, in one place.'),
      );
      await h.sleep(1200);
      await act(
        h,
        'The Integrations tab is the register of outside systems that agents may call, with documentation links that the platform hands to the agents. Amazon DynamoDB is not in it yet, so we will see an agent ask for it.',
        () => h.tab('Integrations', 'The outside systems agents may call, and their documentation.'),
      );
      await h.sleep(1200);
      await act(h, 'The Costs tab shows what every agent run costs, against a budget. I will come back to it at the end.', () =>
        h.tab('Costs', 'Spend by day, by agent and by model.'),
      );
      await h.sleep(1200);
      await act(h, 'And the Map tab is where I give the platform a goal and drive it through each stage.', () =>
        h.tab('Map', 'Give the platform a goal, and drive it stage by stage.'),
      );
      await h.sleep(1200);
    },
  },
  assist1: assistant(
    'assist1',
    '2 \u00b7 The assistant explains a screen',
    'What is this screen for, and what do the Type and How much runs on its own boxes do?',
    'On every page there is also an assistant, a button at the bottom right. I click it, because I am new to this screen, and it knows which screen I am on.',
    'It explains the Map screen and the form at the bottom, in plain words. It can also answer questions about any initiative I can see, and it can look into a built app when something goes wrong. I close it, and carry on.',
  ),
  new1: newInitiative(1),
  startspec: via(T(1), 'startspec'),
  specwait: via(T(1), 'specwait'),
  reviewspec: via(T(1), 'reviewspec'),
  startdesign: via(T(1), 'startdesign'),
  designwait: via(T(1), 'designwait'),
  reviewdesign: via(T(1), 'reviewdesign'),
  startbuild: via(T(1), 'startbuild'),
  // Stage 2 and 3 follow on by themselves, so there is no click to start the design or the build.
  s2_new: newInitiative(2),
  s2_specwait: via(T(2), 'specwait'),
  s2_reviewspec: via(T(2), 'reviewspec'),
  s2_designwait: via(T(2), 'designwait'),
  s2_reviewdesign: via(T(2), 'reviewdesign'),
  s3_new: newInitiative(3),
  s3_specwait: via(T(3), 'specwait'),
  s3_reviewspec: via(T(3), 'reviewspec'),
  s3_designwait: via(T(3), 'designwait'),
  s3_reviewdesign: via(T(3), 'reviewdesign'),
};

for (let n = 1; n <= 30; n++) {
  for (const stage of [1, 2, 3]) {
    scenes[`w${stage}_${n}`] = waitNext(`${n}`, 'The agents are working, and the map stays current. Each engineer agent is Claude Code in its own container on AWS Fargate, with only this repository checked out. A few minutes, sped up.', stage);
    scenes[`h${stage}_${n}`] = handle(n, stage);
  }
}

scenes.w3_1 = waitNext('1', 'I approved the design, and now I do nothing. In autopilot, the engineer agents build the tasks, the platform starts the security review and the smoke test on its own, and a pull request that fires no trigger and passes its checks merges without asking me. I only hear from the platform when something needs a person. The time is sped up.', 3);

export const ORDER = Object.keys(scenes);

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) await main(scenes);
void BASE;

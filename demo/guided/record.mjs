// Records the platform's real web page for a guided demo: every click is announced on screen (what is clicked and
// why) and every switch of tab is called out, with narration (edge-tts) spoken at the moment it happens.
//   node demo/guided/record.mjs <scene> [<scene> ...]      (needs SDLC_URL, SDLC_USER, SDLC_PASSWORD)
// demo/guided/assemble.mjs joins the scenes into one MP4 with burned-in captions.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');
const here = path.dirname(fileURLToPath(import.meta.url));
export const WORK = path.resolve(here, '..', '_work', process.env.DEMO_WORK ?? 'guided');
fs.mkdirSync(path.join(WORK, 'scenes'), { recursive: true });
fs.mkdirSync(path.join(WORK, 'audio'), { recursive: true });

export const BASE = process.env.SDLC_URL ?? 'https://app.agentonomous.com';
const VOICE = process.env.DEMO_VOICE ?? 'en-US-AriaNeural';
const SIZE = { width: 1280, height: 720 };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function narrate(id, text) {
  const hash = crypto.createHash('sha1').update(VOICE + text).digest('hex').slice(0, 8);
  const mp3 = path.join(WORK, 'audio', `${id}-${hash}.mp3`);
  if (!fs.existsSync(mp3) || fs.statSync(mp3).size < 1000) {
    const txt = mp3.replace('.mp3', '.txt');
    fs.writeFileSync(txt, text, 'utf8');
    execFileSync('edge-tts', ['--voice', VOICE, '--file', txt, '--write-media', mp3], { stdio: 'pipe' });
  }
  const sec = Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp3])
      .toString()
      .trim(),
  );
  return { mp3, sec };
}

/** Runs in every page: the cursor, the click ripple, the highlight and its label, the tab banner, the "you are on" chip. */
const OVERLAY = () => {
  const css = (el, s) => {
    el.style.cssText = s;
    return el;
  };
  const add = (el) => {
    (document.body ?? document.documentElement).appendChild(el);
    return el;
  };
  const FONT = 'font-family:Roboto,Arial,sans-serif;';
  const style = document.createElement('style');
  style.textContent =
    '@keyframes demoPulse{0%,100%{box-shadow:0 0 0 3px #ff7a00,0 0 18px 6px #ff7a0099}50%{box-shadow:0 0 0 5px #ffd000,0 0 28px 12px #ffd00077}}' +
    '@keyframes demoRipple{from{transform:translate(-50%,-50%) scale(.3);opacity:.9}to{transform:translate(-50%,-50%) scale(2.6);opacity:0}}' +
    '@keyframes demoIn{from{opacity:0}to{opacity:1}}';
  addEventListener('DOMContentLoaded', () => document.documentElement.appendChild(style));

  const cursor = css(
    document.createElement('div'),
    'position:fixed;z-index:2147483647;width:22px;height:22px;border-radius:50%;background:rgba(255,122,0,.75);border:2px solid #fff;box-shadow:0 0 8px #000a;pointer-events:none;left:-40px;top:-40px;transform:translate(-50%,-50%)',
  );
  addEventListener('DOMContentLoaded', () => document.documentElement.appendChild(cursor));
  addEventListener(
    'mousemove',
    (e) => {
      cursor.style.left = e.clientX + 'px';
      cursor.style.top = e.clientY + 'px';
    },
    true,
  );

  const spots = [];
  const chip = css(
    document.createElement('div'),
    FONT +
      'position:fixed;z-index:2147483646;left:50%;top:16px;transform:translateX(-50%);background:#0b1b33;color:#fff;border:1px solid #5aa0ff;border-radius:999px;padding:5px 16px;font-size:14px;pointer-events:none;display:none',
  );
  setInterval(() => {
    if (!document.documentElement) return;
    const sel = document.querySelector('[aria-current=page]');
    const t = window.__demo.where || (sel ? 'Tab: ' + sel.textContent.trim() : '');
    if (!t) return;
    chip.textContent = t;
    chip.style.display = 'block';
    if (!chip.isConnected) add(chip);
  }, 250);

  window.__demo = {
    where: '',
    spot(r, tag, label, why, color) {
      const ring = css(
        document.createElement('div'),
        `position:fixed;z-index:2147483645;left:${r.x - 6}px;top:${r.y - 6}px;width:${r.width + 12}px;height:${r.height + 12}px;border-radius:10px;pointer-events:none;animation:demoPulse 1s infinite`,
      );
      const above = r.y > 120;
      const beside = r.x + r.width < 270; // the tab bar: the note goes to its right
      const place = beside
        ? `left:${r.x + r.width + 16}px;top:${r.y}px`
        : `left:${Math.max(10, Math.min(r.x, innerWidth - 450))}px;${above ? `bottom:${innerHeight - r.y + 14}px` : `top:${r.y + r.height + 14}px`}`;
      const note = css(
        document.createElement('div'),
        FONT +
          `position:fixed;z-index:2147483646;max-width:430px;${place};background:#101828f2;color:#fff;border-radius:10px;padding:8px 12px;box-shadow:0 4px 18px #000b;pointer-events:none`,
      );
      const head = document.createElement('div');
      head.style.cssText = 'font-size:15px;font-weight:700;line-height:1.3';
      const t = document.createElement('span');
      t.textContent = tag;
      t.style.cssText = `background:${color};color:#101828;border-radius:5px;padding:1px 7px;margin-right:8px;font-size:12px;letter-spacing:.6px`;
      head.appendChild(t);
      head.appendChild(document.createTextNode(label));
      note.appendChild(head);
      if (why) {
        const w = document.createElement('div');
        w.style.cssText = 'font-size:13.5px;margin-top:3px;opacity:.92;line-height:1.35';
        w.textContent = why;
        note.appendChild(w);
      }
      add(ring);
      add(note);
      spots.push(ring, note);
    },
    clear() {
      while (spots.length) spots.pop().remove();
    },
    ripple(x, y) {
      const d = css(
        document.createElement('div'),
        `position:fixed;z-index:2147483647;left:${x}px;top:${y}px;width:46px;height:46px;border-radius:50%;border:4px solid #ffd000;pointer-events:none;animation:demoRipple .7s ease-out forwards`,
      );
      add(d);
      setTimeout(() => d.remove(), 800);
    },
    banner(tag, title, why, color, ms) {
      const b = css(
        document.createElement('div'),
        FONT +
          `position:fixed;z-index:2147483646;left:50%;bottom:92px;transform:translateX(-50%);max-width:760px;background:#0b1b33f5;color:#fff;border:2px solid ${color};border-radius:12px;padding:10px 18px;box-shadow:0 6px 24px #000c;pointer-events:none;text-align:center;animation:demoIn .35s ease-out`,
      );
      const h = document.createElement('div');
      h.style.cssText = 'font-size:18px;font-weight:700';
      const t = document.createElement('span');
      t.textContent = tag;
      t.style.cssText = `background:${color};color:#0b1b33;border-radius:5px;padding:1px 8px;margin-right:10px;font-size:13px;letter-spacing:.8px`;
      h.appendChild(t);
      h.appendChild(document.createTextNode(title));
      b.appendChild(h);
      if (why) {
        const w = document.createElement('div');
        w.style.cssText = 'font-size:15px;margin-top:4px;opacity:.95';
        w.textContent = why;
        b.appendChild(w);
      }
      add(b);
      setTimeout(() => b.remove(), ms);
    },
    chapter(text) {
      const c = css(
        document.createElement('div'),
        FONT +
          'position:fixed;z-index:2147483646;left:268px;top:76px;background:#ffd000;color:#101828;border-radius:8px;padding:6px 14px;font-size:16px;font-weight:700;box-shadow:0 3px 12px #0009;pointer-events:none',
      );
      c.textContent = text;
      add(c);
      setTimeout(() => c.remove(), 5000);
    },
  };
};

export async function login(page) {
  await page.goto(BASE + '/auth/login');
  const user = page.locator('input[name="username"]:visible');
  await user.waitFor({ timeout: 30000 });
  return user;
}

/** A signed-in browser state, made without recording. */
export async function freshAuth(browser) {
  const cached = path.join(WORK, 'auth.json');
  if (fs.existsSync(cached) && Date.now() - fs.statSync(cached).mtimeMs < 20 * 60 * 1000) return cached;
  const ctx = await browser.newContext({ viewport: SIZE });
  const page = await ctx.newPage();
  const user = await login(page);
  await user.fill(process.env.SDLC_USER);
  await page.locator('input[name="password"]:visible').fill(process.env.SDLC_PASSWORD);
  await page.locator('input[name="signInSubmitButton"]:visible').click();
  await page.getByTestId('signed-in').waitFor({ timeout: 30000 });
  await ctx.storageState({ path: cached });
  await ctx.close();
  return cached;
}

export function helpers(page, clips, t0, sceneId) {
  let audioFree = 0; // seconds since the page opened
  let spoken = 0;
  const h = {
    page,
    sleep,
    /** Narration starts as soon as the previous clip has ended. Await it to wait for the end, or carry on. */
    say(text) {
      const { mp3, sec } = narrate(`${sceneId}-${++spoken}`, text);
      const now = (Date.now() - t0) / 1000;
      const at = Math.max(now, audioFree);
      clips.push({ at, mp3, sec, text });
      audioFree = at + sec + 0.35;
      return sleep(Math.max(0, (audioFree - now) * 1000));
    },
    async sayDone() {
      await sleep(Math.max(0, (audioFree - (Date.now() - t0) / 1000) * 1000));
    },
    async chapter(text) {
      await page.evaluate((t) => window.__demo?.chapter(t), text).catch(() => {});
    },
    async mouseTo(box) {
      await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 24), { steps: 30 });
      await sleep(250);
    },
    /** Move over something and look at it. */
    async move(loc) {
      await loc.scrollIntoViewIfNeeded();
      const box = await loc.boundingBox();
      if (box) await h.mouseTo(box);
    },
    /** Point at something without clicking: a ring and a note. */
    async point(loc, label, why, ms = 2500) {
      await loc.scrollIntoViewIfNeeded();
      const box = await loc.boundingBox();
      if (!box) return;
      await page.evaluate(([b, l, w]) => window.__demo.spot(b, 'LOOK', l, w, '#5aa0ff'), [box, label, why]);
      await h.mouseTo(box);
      await sleep(ms);
      await page.evaluate(() => window.__demo.clear());
    },
    /** A click the viewer can follow: ring, a note saying what and why, the cursor travelling, a ripple. */
    async click(loc, o = {}) {
      await loc.scrollIntoViewIfNeeded();
      const box = await loc.boundingBox();
      if (!box) throw new Error('nothing to click: ' + (o.label ?? ''));
      if (o.label) await page.evaluate(([b, l, w]) => window.__demo.spot(b, 'CLICK', l, w, '#ffb000'), [box, o.label, o.why ?? '']);
      await h.mouseTo(box);
      await sleep(o.hold ?? 1100);
      await page.evaluate(([x, y]) => window.__demo.ripple(x, y), [box.x + box.width / 2, box.y + Math.min(box.height / 2, 24)]);
      await loc.click();
      await sleep(450);
      await page.evaluate(() => window.__demo.clear());
    },
    /** Switch to another tab of the platform, and say why. */
    async tab(name, why) {
      const id = { Home: 'home', Portfolio: 'portfolio', Map: 'map', 'Attention queue': 'queue', Costs: 'costs', Integrations: 'integrations', Bugs: 'bugs', Autopilot: 'autopilot' }[name];
      const nav = page.getByTestId(`nav-${id}`);
      await page.evaluate(([n, w]) => window.__demo.banner('SWITCHING TAB', n, w, '#4da3ff', 4200), [name, why]);
      await sleep(1300);
      await h.click(nav, { label: `Open the ${name} tab`, why, hold: 900 });
      await sleep(900);
    },
    /** A different browser tab (the app under review). It is shown as its own tab until `backToPlatform`. */
    async browserTab(name, why, href) {
      await page.evaluate(([n, w]) => window.__demo.banner('NEW BROWSER TAB', n, w, '#ff6fb5', 4500), [name, why]);
      await sleep(1800);
      await page.goto(href);
      await page.evaluate((n) => (window.__demo.where = 'Browser tab: ' + n), name).catch(() => {});
    },
    async backToPlatform(route, why) {
      await page.evaluate((w) => window.__demo.banner('BACK TO THE PLATFORM TAB', 'The platform', w, '#ff6fb5', 3800), why).catch(() => {});
      await sleep(1800);
      await page.goto(BASE + route);
    },
    async type(loc, text, o = {}) {
      await h.click(loc, { label: o.label ?? 'Click the box to type', why: o.why, hold: o.hold ?? 700 });
      await loc.pressSequentially(text, { delay: o.delay ?? 32, timeout: 180000 });
      await sleep(400);
    },
    async scrollBy(total, ms) {
      const steps = Math.max(1, Math.round(ms / 80));
      for (let i = 0; i < steps; i++) {
        await page.mouse.wheel(0, total / steps);
        await sleep(80);
      }
    },
    async waitUntil(label, fn, timeoutMs, everyMs = 4000) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out: ${label}`);
        await sleep(everyMs);
      }
    },
  };
  return h;
}

/** scene = { url, title?, lapse?, anon?, keepAuth?, run(h) }. Narration is spoken from inside run with h.say. */
export async function runScene(id, scene, browser) {
  const dir = path.join(WORK, 'rec', id);
  fs.rmSync(dir, { recursive: true, force: true });
  const state = scene.anon ? undefined : await freshAuth(browser);
  const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir, size: SIZE }, storageState: state });
  await ctx.addInitScript(OVERLAY);
  const t0 = Date.now();
  const page = await ctx.newPage();
  const clips = [];
  const h = helpers(page, clips, t0, id);
  if (scene.url !== null) await page.goto(BASE + (scene.url ?? '/'));
  await sleep(700);
  if (scene.title) await h.chapter(scene.title);
  let failure;
  try {
    if (scene.run) await scene.run(h);
    await h.sayDone();
  } catch (e) {
    failure = e;
    await page.screenshot({ path: path.join(WORK, `fail-${id}.png`) }).catch(() => {});
  }
  await sleep(900);
  const real = (Date.now() - t0) / 1000;
  if (scene.keepAuth) await ctx.storageState({ path: path.join(WORK, 'auth.json') });
  const video = page.video();
  await ctx.close();
  if (failure) throw failure;
  fs.copyFileSync(await video.path(), path.join(WORK, 'scenes', `${id}.webm`));
  fs.writeFileSync(
    path.join(WORK, 'scenes', `${id}.json`),
    JSON.stringify({ id, clips, realSec: real, lapse: Boolean(scene.lapse), title: scene.title ?? '' }),
  );
  console.log(`scene ${id}: ${real.toFixed(0)} s recorded, ${clips.length} narration clip(s)`);
}

export async function main(scenes) {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.log('scenes: ' + Object.keys(scenes).join(', '));
    return;
  }
  const browser = await chromium.launch();
  try {
    for (const id of ids) {
      if (!scenes[id]) throw new Error(`no scene ${id}`);
      await runScene(id, scenes[id], browser);
    }
  } finally {
    await browser.close();
  }
}

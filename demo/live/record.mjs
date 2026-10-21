// Records the platform's real web page, step by step, with a narration (edge-tts) per scene. One video file per scene.
//   node demo/live/record.mjs <scene> [<scene> ...]      (needs SDLC_URL, SDLC_USER, SDLC_PASSWORD)
// demo/live/assemble.mjs joins the scenes into one MP4 with burned-in captions.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');
const here = path.dirname(fileURLToPath(import.meta.url));
export const WORK = path.resolve(here, '..', '_work', 'live');
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

const CURSOR = () => {
  const c = document.createElement('div');
  c.style.cssText =
    'position:fixed;z-index:2147483647;width:20px;height:20px;border-radius:50%;background:rgba(255,90,0,.6);border:2px solid #fff;box-shadow:0 0 6px #0009;pointer-events:none;left:-40px;top:-40px;transform:translate(-50%,-50%)';
  addEventListener('DOMContentLoaded', () => document.documentElement.appendChild(c));
  addEventListener('mousemove', (e) => {
    c.style.left = e.clientX + 'px';
    c.style.top = e.clientY + 'px';
  }, true);
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
  const file = path.join(WORK, 'auth.json');
  await ctx.storageState({ path: file });
  await ctx.close();
  return file;
}

export function helpers(page, audioSec) {
  const h = {
    page,
    audioSec,
    sleep,
    async move(loc) {
      await loc.scrollIntoViewIfNeeded();
      const box = await loc.boundingBox();
      if (!box) return;
      await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 24), { steps: 28 });
      await sleep(250);
    },
    async click(loc) {
      await h.move(loc);
      await loc.click();
    },
    async type(loc, text, delay = 28) {
      await h.click(loc);
      await loc.pressSequentially(text, { delay });
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

/** scene = { say, url?, lapse?, anon?, run(h) }. */
export async function runScene(id, scene, browser) {
  const { mp3, sec } = narrate(id, scene.say);
  const dir = path.join(WORK, 'rec', id);
  fs.rmSync(dir, { recursive: true, force: true });
  const state = scene.anon ? undefined : await freshAuth(browser);
  const ctx = await browser.newContext({
    viewport: SIZE,
    recordVideo: { dir, size: SIZE },
    storageState: state,
  });
  await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  const t0 = Date.now();
  if (scene.url !== null) await page.goto(BASE + (scene.url ?? '/'));
  await sleep(600);
  const h = helpers(page, sec);
  const floor = sleep(sec * 1000 + 700);
  let failure;
  try {
    await Promise.all([scene.run ? scene.run(h) : Promise.resolve(), floor]);
  } catch (e) {
    failure = e;
    await page.screenshot({ path: path.join(WORK, `fail-${id}.png`) }).catch(() => {});
  }
  const real = (Date.now() - t0) / 1000;
  await sleep(500);
  if (scene.keepAuth) await ctx.storageState({ path: path.join(WORK, 'auth.json') });
  const video = page.video();
  await ctx.close();
  if (failure) throw failure;
  const out = path.join(WORK, 'scenes', `${id}.webm`);
  fs.copyFileSync(await video.path(), out);
  fs.writeFileSync(
    path.join(WORK, 'scenes', `${id}.json`),
    JSON.stringify({ id, mp3, audioSec: sec, realSec: real, lapse: Boolean(scene.lapse), say: scene.say, label: scene.label ?? '' }),
  );
  console.log(`scene ${id}: ${real.toFixed(0)} s recorded, narration ${sec.toFixed(1)} s`);
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
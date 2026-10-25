// The promo of the online shop demo (about 2 minutes): a problem-and-answer opening, big on-screen headlines over slowly pushing-in
// footage, a number counter, sound hits, and a generated music bed. Live pages come from the running platform and the
// clips from the guided demo.   DEMO_WORK=tickets node demo/promo/make4.mjs [out.mp4]   (needs SDLC_USER and SDLC_PASSWORD)
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, WORK as GUIDED, freshAuth, sleep } from '../guided/record.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');
const here = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.resolve(here, '..', '_work', 'promo4');
fs.mkdirSync(path.join(WORK, 'audio'), { recursive: true });
const SIZE = { width: 1280, height: 720 };
const VOICE = process.env.PROMO_VOICE ?? 'en-US-GuyNeural';
const run = (cmd, a, o = {}) => execFileSync(cmd, a, { stdio: 'pipe', ...o });
const TITLE = 'Discounts, stock limits and order history';

function narrate(id, text) {
  const hash = crypto.createHash('sha1').update(VOICE + text).digest('hex').slice(0, 8);
  const mp3 = path.join(WORK, 'audio', `${id}-${hash}.mp3`);
  if (!fs.existsSync(mp3) || fs.statSync(mp3).size < 1000) {
    const txt = mp3.replace('.mp3', '.txt');
    fs.writeFileSync(txt, text, 'utf8');
    run('edge-tts', ['--voice', VOICE, '--rate=+6%', '--pitch=-3Hz', '--file', txt, '--write-media', mp3]);
  }
  const sec = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp3]).toString().trim());
  return { mp3, sec };
}

const FONT = "font-family:Roboto,'Segoe UI',Arial,sans-serif;";
const BG = 'background:radial-gradient(1100px 650px at 78% 12%,#17366b 0%,#0a1020 52%,#05070d 100%);';

/** Full-screen HTML scenes, recorded as they animate. */
const scenes = {
  problem: `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;${BG}color:#fff;${FONT}overflow:hidden}
.w{height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 110px;gap:8px}
.l{font-size:92px;font-weight:800;letter-spacing:-1px;opacity:0;transform:translateX(-70px);animation:in .45s forwards}
.l b{color:#ff5a4d}
.l:nth-child(1){animation-delay:.2s}.l:nth-child(2){animation-delay:1.6s}.l:nth-child(3){animation-delay:3s}
@keyframes in{to{opacity:1;transform:none}}
</style><div class="w"><div class="l">Software takes <b>weeks.</b></div><div class="l">Reviews pile <b>up.</b></div><div class="l">Bugs ship <b>anyway.</b></div></div>`,

  answer: `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;${BG}color:#fff;${FONT}overflow:hidden}
.w{height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 110px}
.a{font-size:60px;font-weight:500;color:#b8c7e6;opacity:0;animation:in .6s .2s forwards}
.b{font-size:112px;font-weight:900;line-height:1.02;margin-top:12px;opacity:0;transform:scale(.92);animation:pop .7s 1.2s forwards}
.b em{font-style:normal;color:#ffb000}
@keyframes in{to{opacity:1}}@keyframes pop{to{opacity:1;transform:none}}
</style><div class="w"><div class="a">What if the agents did the work…</div><div class="b">and <em>you</em> made<br>the calls?</div></div>`,

  title: `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;${BG}color:#fff;${FONT}overflow:hidden}
.w{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center}
.k{letter-spacing:12px;color:#ffb000;font-weight:700;font-size:24px;opacity:0;animation:in .8s .2s forwards}
h1{font-size:132px;font-weight:900;margin:10px 0 0;letter-spacing:-2px;opacity:0;transform:scale(1.18);animation:slam .55s .5s cubic-bezier(.2,1.4,.4,1) forwards;text-shadow:0 0 60px #3f8cff88}
.s{font-size:34px;color:#b8c7e6;margin-top:14px;opacity:0;animation:in .8s 1.3s forwards}
.line{width:0;height:6px;background:#ffb000;border-radius:3px;margin-top:30px;animation:grow .9s 1.1s forwards}
@keyframes in{to{opacity:1}}@keyframes slam{to{opacity:1;transform:none}}@keyframes grow{to{width:260px}}
</style><div class="w"><div class="k">INTRODUCING</div><h1>Autonomous SDLC</h1><div class="s">AI agents build. People decide.</div><div class="line"></div></div>`,

  sentence: `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;${BG}color:#fff;${FONT}overflow:hidden}
.w{height:100%;padding:0 110px;display:flex;flex-direction:column;justify-content:center}
.k{letter-spacing:6px;color:#ffb000;font-weight:700;font-size:22px}
h2{font-size:84px;margin:6px 0 30px;font-weight:900;letter-spacing:-1px}
.box{border:3px solid #3f8cff;border-radius:16px;background:#0d1730;padding:28px 34px;font-size:36px;line-height:1.45;min-height:150px;box-shadow:0 0 50px #3f8cff44}
.caret{display:inline-block;width:3px;height:1em;background:#fff;vertical-align:-6px;animation:b .8s steps(1) infinite}
.chips{display:flex;gap:16px;margin-top:34px}
.c{font-size:34px;font-weight:800;padding:14px 28px;border-radius:12px;background:#17366b;opacity:0;transform:translateY(20px);animation:up .5s forwards}
.c:nth-child(1){animation-delay:3.4s}.c:nth-child(2){animation-delay:3.9s;background:#1f5a3a}.c:nth-child(3){animation-delay:4.4s;background:#6a3fa0}.c:nth-child(4){animation-delay:4.9s;background:#a05a14}
@keyframes b{50%{opacity:0}}@keyframes up{to{opacity:1;transform:none}}
</style><div class="w"><div class="k">STEP 1</div><h2>One sentence in.</h2>
<div class="box"><span id="t"></span><span class="caret"></span></div>
<div class="chips"><div class="c">Spec</div><div class="c">Design</div><div class="c">Tasks</div><div class="c">Pull requests</div></div></div>
<script>const s='An online shop with a catalog, a cart and checkout, all stored in Amazon DynamoDB, and built to move to another cloud later.';let i=0;const el=document.getElementById('t');setTimeout(function tick(){if(i<=s.length){el.textContent=s.slice(0,i++);setTimeout(tick,26)}},350)</script>`,

  numbers: `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;${BG}color:#fff;${FONT}overflow:hidden}
.w{height:100%;padding:0 110px;display:flex;flex-direction:column;justify-content:center}
.k{letter-spacing:6px;color:#ffb000;font-weight:700;font-size:22px}
h2{font-size:84px;margin:6px 0 40px;font-weight:900;letter-spacing:-1px}
.row{display:flex;gap:30px}
.n{flex:1;background:#0d1730;border:2px solid #24407a;border-radius:18px;padding:30px 26px;opacity:0;transform:translateY(24px);animation:up .5s forwards}
.n:nth-child(1){animation-delay:.3s}.n:nth-child(2){animation-delay:.7s}.n:nth-child(3){animation-delay:1.1s}
.v{font-size:104px;font-weight:900;color:#7db4ff;line-height:1}
.d{font-size:28px;color:#b8c7e6;margin-top:10px}
.f{font-size:30px;color:#ffb000;margin-top:34px;opacity:0;animation:in .8s 2.4s forwards}
@keyframes up{to{opacity:1;transform:none}}@keyframes in{to{opacity:1}}
</style><div class="w"><div class="k">EVERY RUN, METERED</div><h2>Know what it cost.</h2>
<div class="row"><div class="n"><div class="v" data-to="23" data-p="" data-d="0">0</div><div class="d">agent runs</div></div>
<div class="n"><div class="v" data-to="161" data-p="" data-d="0">0</div><div class="d">model calls</div></div>
<div class="n"><div class="v" data-to="6.91" data-p="$" data-d="2">$0</div><div class="d">for two stages</div></div></div>
<div class="f">By agent. By model. Against a budget.</div></div>
<script>const t0=performance.now();const els=[...document.querySelectorAll('.v')];(function f(){const k=Math.min(1,(performance.now()-t0-500)/1700);const e=1-Math.pow(1-Math.max(0,k),3);for(const el of els){const to=+el.dataset.to;el.textContent=el.dataset.p+(to*e).toFixed(+el.dataset.d)}if(k<1)requestAnimationFrame(f)})()</script>`,

  stages: `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;${BG}color:#fff;${FONT}overflow:hidden}
.w{height:100%;padding:0 110px;display:flex;flex-direction:column;justify-content:center}
.k{letter-spacing:6px;color:#ffb000;font-weight:700;font-size:22px}
h2{font-size:84px;margin:6px 0 36px;font-weight:900;letter-spacing:-1px}
.row{display:flex;gap:34px;align-items:stretch}
.s{flex:1;background:#0d1730;border:2px solid #24407a;border-radius:18px;padding:26px 30px;opacity:0;transform:translateY(24px);animation:up .5s forwards}
.s:nth-child(1){animation-delay:.3s}.s:nth-child(3){animation-delay:1.5s;border-color:#ffb000}
.h{font-size:26px;color:#7db4ff;font-weight:800;letter-spacing:2px}
.t{font-size:40px;font-weight:800;margin:6px 0 14px}
.c{display:inline-block;font-size:26px;font-weight:700;padding:8px 16px;border-radius:10px;background:#17366b;margin:0 10px 10px 0}
.s:nth-child(3) .c{background:#7a4a08}
.ar{align-self:center;font-size:90px;color:#ffb000;opacity:0;animation:in .5s 1s forwards}
@keyframes up{to{opacity:1;transform:none}}@keyframes in{to{opacity:1}}
</style><div class="w"><div class="k">COMPOUNDING FEATURES</div><h2>Build on what shipped.</h2>
<div class="row"><div class="s"><div class="h">STAGE 1</div><div class="t">Online shop</div><span class="c">Catalog</span><span class="c">Cart</span><span class="c">Checkout</span><span class="c">DynamoDB</span></div>
<div class="ar">&#10142;</div>
<div class="s"><div class="h">STAGE 2</div><div class="t">Same repo, new initiative</div><span class="c">Discount codes</span><span class="c">Stock labels</span><span class="c">Order history</span></div></div></div>`,
  closing: `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;${BG}color:#fff;${FONT}overflow:hidden}
.w{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 90px}
.a{font-size:100px;font-weight:900;line-height:1.04;letter-spacing:-1px;opacity:0;transform:scale(.94);animation:pop .7s .2s forwards}
.b{font-size:100px;font-weight:900;line-height:1.04;letter-spacing:-1px;color:#ffb000;opacity:0;transform:scale(.94);animation:pop .7s 1.3s forwards}
.s{font-size:32px;color:#b8c7e6;margin-top:34px;opacity:0;animation:in .8s 2.4s forwards}
.k{letter-spacing:10px;color:#fff;font-weight:700;font-size:22px;margin-top:46px;opacity:0;animation:in .8s 3s forwards}
@keyframes pop{to{opacity:1;transform:none}}@keyframes in{to{opacity:1}}
</style><div class="w"><div class="a">Agents do the work.</div><div class="b">You make the calls.</div><div class="s">Semi-autonomous delivery, with a person at every decision that matters.</div><div class="k">AUTONOMOUS SDLC</div></div>`,
};

/** A headline over footage: a dark gradient behind it, a small label, the headline, and one line under it. */
const headline = (kicker, head, sub, tone = '#ffb000') => `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:1280px;height:720px;background:transparent;${FONT}overflow:hidden}
.g{position:absolute;inset:0;background:linear-gradient(0deg,rgba(5,7,13,.92) 0%,rgba(5,7,13,.78) 26%,rgba(5,7,13,0) 56%)}
.t{position:absolute;left:64px;bottom:58px;right:64px;color:#fff}
.k{display:inline-block;background:${tone};color:#0a1020;font-weight:800;letter-spacing:3px;font-size:19px;padding:4px 12px;border-radius:6px}
h2{font-size:76px;line-height:1.02;font-weight:900;letter-spacing:-1px;margin:12px 0 8px;text-shadow:0 4px 24px #000a}
p{font-size:29px;color:#d6e2ff;margin:0;text-shadow:0 2px 12px #000a}
</style><div class="g"></div><div class="t"><div class="k">${kicker}</div><h2>${head}</h2><p>${sub}</p></div>`;

const beats = [
  { id: 'problem', say: 'Software takes weeks. Reviews pile up. Bugs ship anyway.', v: { html: 'problem' }, sfx: 'hit' },
  { id: 'answer', say: 'What if the agents did the work, and you made the calls?', v: { html: 'answer' }, sfx: 'whoosh' },
  { id: 'title', say: 'Autonomous S D L C.', v: { html: 'title' }, sfx: 'hit' },
  { id: 'sentence', say: 'Start with an idea. Write a brief in plain words, paste the documentation links, and click create. Agents draft the spec, design the solution, and split the work into tasks.', v: { html: 'sentence' }, sfx: 'whoosh', min: 8 },
  {
    id: 'claude',
    say: 'Every agent is Claude Code, running in its own isolated container in your own AWS account, with every model call metered by the platform.',
    v: { clip: 'buildwait1', from: 6, zoom: [0.2, 0.3] },
    over: ['CLAUDE CODE INSIDE', 'Every agent. Its own container.', 'Every model call metered and capped.'],
    sfx: 'whoosh',
  },
  {
    id: 'progress',
    say: 'Track every initiative on one map. Each stage, each task, and who it is waiting on. No stand-ups. No status reports.',
    v: { live: '/#/map', zoom: [0.2, 0.3] },
    over: ['TRACK PROGRESS', 'One map. Every task.', 'Always know what is built, and what is waiting on you.'],
    sfx: 'whoosh',
  },
  {
    id: 'stop',
    say: 'People stay in the loop at hard stops. A new outside system, a protected file, a risky change. The agent stops, and only you can let it through.',
    v: { clip: 'integration', from: 25, zoom: [0.2, 0.3] },
    over: ['HARD STOPS', 'Agents stop. You decide.', 'Here, a new outside system: Amazon DynamoDB.'],
    tone: '#ff5a4d',
    sfx: 'hit',
  },
  {
    id: 'beyond',
    say: 'Reviewing is far more than reading a diff. A security review reads the change, and a high finding blocks the merge. A smoke test starts the real app. And the design\u2019s own checks must pass.',
    v: { clip: 's2_t2b', from: 22, zoom: [0.4, 0.4] },
    over: ['BEYOND THE DIFF', 'A high finding blocks the merge.', 'Security review, smoke test, and the design\u2019s checks.'],
    tone: '#59d98e',
    sfx: 'whoosh',
  },
  {
    id: 'decide',
    say: 'The agent does not just patch it. It asks you how to fix it, with options and a recommendation. Every answer is recorded with who and why.',
    v: { clip: 's2_ask', from: 20, zoom: [0.5, 0.3] },
    over: ['YOU DECIDE', 'It asks. You choose.', 'Every answer is recorded with who and why.'],
    sfx: 'whoosh',
  },
  {
    id: 'preview',
    say: 'Then try it, live. Every change runs as an isolated copy of the shop, with its own database table, deleted when you are done.',
    v: { clip: 's2_t3c', from: 70, zoom: [0.3, 0.3] },
    over: ['LIVE PREVIEW', 'Use it before you approve it.', 'Isolated. Its own DynamoDB table. Gone when you stop.'],
    sfx: 'whoosh',
  },
  { id: 'stages', say: 'And features compound. A second initiative builds on the first, through the same flow, with a fresh live preview of the new version.', v: { html: 'stages' }, sfx: 'whoosh', min: 7 },
  {
    id: 'newversion',
    say: 'Discount codes, stock labels, order history and cancel, running live on top of the shop you already shipped.',
    v: { clip: 's2_t3c', from: 122, zoom: [0.3, 0.4] },
    over: ['STAGE TWO, LIVE', 'New features, same shop.', 'Try the change before it merges.'],
    sfx: 'whoosh',
  },
  { id: 'numbers', say: 'Every run is metered, so you know what it cost. Two stages, a working shop on a database, under seven dollars in model costs.', v: { html: 'numbers' }, sfx: 'whoosh', min: 6.5 },
  {
    id: 'aws',
    say: 'It is built for AWS on purpose, so adoption takes one account and a few clicks. And the shops it builds keep every call to AWS in a single file, so moving to another cloud means writing one new adapter.',
    v: { image: path.resolve(here, '..', '..', 'infra', 'aws', 'architecture.png'), zoom: [0.5, 0.35] },
    over: ['BUILT FOR AWS. PORTABLE BY DESIGN.', 'One account. A few clicks.', 'All AWS calls in one file. Swap one adapter.'],
    sfx: 'whoosh',
  },
  { id: 'closing', say: 'Agents do the work. You make the calls.', v: { html: 'closing' }, sfx: 'hit', min: 6.2 },
];
async function record(browser, id, seconds, setup, state) {
  const dir = path.join(WORK, 'rec', id);
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir, size: SIZE }, storageState: state });
  const page = await ctx.newPage();
  const t0 = Date.now();
  await setup(page);
  const left = seconds * 1000 - (Date.now() - t0);
  if (left > 0) await sleep(left);
  const video = page.video();
  await ctx.close();
  const out = path.join(WORK, `${id}.webm`);
  fs.copyFileSync(await video.path(), out);
  return out;
}
const scrollSlowly = async (page, total, ms) => {
  const steps = Math.max(1, Math.round(ms / 80));
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, total / steps);
    await sleep(80);
  }
};

async function overlayPng(browser, id, [kicker, head, sub], tone) {
  const ctx = await browser.newContext({ viewport: SIZE });
  const page = await ctx.newPage();
  await page.setContent(headline(kicker, head, sub, tone));
  const file = path.join(WORK, `${id}-over.png`);
  await page.screenshot({ path: file, omitBackground: true });
  await ctx.close();
  return file;
}

const sfxInput = (kind) =>
  kind === 'hit'
    ? ['-f', 'lavfi', '-t', '1.2', '-i', "aevalsrc='0.9*sin(2*PI*(46+90*exp(-14*t))*t)*exp(-3.2*t)+0.25*sin(2*PI*1200*t)*exp(-40*t)':s=44100"]
    : ['-f', 'lavfi', '-t', '0.9', '-i', "anoisesrc=d=0.9:c=pink:a=0.6,highpass=f=500,lowpass=f=6500,afade=t=in:d=0.35,afade=t=out:st=0.35:d=0.55"];

async function main() {
  const outName = process.argv[2] ?? 'promo4.mp4';
  const browser = await chromium.launch();
  const state = await freshAuth(browser);
  const parts = [];
  let total = 0;
  for (const b of beats) {
    const { mp3, sec } = narrate(`p2-${b.id}`, b.say);
    const D = Math.max(sec + 0.7, b.min ?? 0);
    const v = b.v;
    const seg = path.join(WORK, `${b.id}.mp4`);
    const input = [];
    let vf;
    const zoom = v.zoom
      ? `zoompan=z='1+0.00085*on':x='(iw-iw/zoom)*${v.zoom[0]}':y='(ih-ih/zoom)*${v.zoom[1]}':d=1:s=1280x720:fps=25`
      : '';
    if (v.html) {
      input.push('-i', await record(browser, b.id, D + 1, async (p) => p.setContent(scenes[v.html])));
      vf = 'fps=25,scale=1280:720';
    } else if (v.live) {
      input.push(
        '-i',
        await record(browser, b.id, D + 1.5, async (p) => {
          await p.goto(BASE + v.live);
          const sel = p.getByLabel('Initiative');
          await sel.waitFor({ timeout: 30000 });
          await sel.selectOption({ label: TITLE });
          await sleep(1200);
          await scrollSlowly(p, 330, Math.max(2000, D * 500));
        }, state),
      );
      vf = `fps=25,scale=1280:720,${zoom}`;
    } else if (v.clip) {
      input.push('-ss', String(v.from), '-i', path.join(GUIDED, 'scenes', `${v.clip}.webm`));
      vf = `fps=25,scale=1280:720,${zoom}`;
    } else {
      input.push('-loop', '1', '-framerate', '25', '-i', v.image);
      vf = `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=#05070d,fps=25,${zoom}`;
    }
    let filter;
    if (b.over) {
      const png = await overlayPng(browser, b.id, b.over, b.tone ?? '#ffb000');
      input.push('-loop', '1', '-framerate', '25', '-i', png);
      filter =
        `[0:v]${vf},eq=brightness=-0.06:saturation=1.1[b];` +
        `[1:v]format=rgba,fade=t=in:st=0.15:d=0.45:alpha=1,fade=t=out:st=${(D - 0.3).toFixed(2)}:d=0.25:alpha=1[o];` +
        `[b][o]overlay=x=0:y='if(lt(t,0.6),36*(1-t/0.6)^2,0)',fade=t=in:st=0:d=0.2,fade=t=out:st=${(D - 0.2).toFixed(2)}:d=0.2[v];`;
      input.push('-i', mp3, ...sfxInput(b.sfx));
      filter += `[2:a]adelay=350|350[n];[3:a]volume=0.55[w];[n][w]amix=inputs=2:normalize=0,apad[a]`;
    } else {
      filter = `[0:v]${vf},fade=t=in:st=0:d=0.15,fade=t=out:st=${(D - 0.2).toFixed(2)}:d=0.2[v];`;
      input.push('-i', mp3, ...sfxInput(b.sfx));
      filter += `[1:a]adelay=350|350[n];[2:a]volume=0.55[w];[n][w]amix=inputs=2:normalize=0,apad[a]`;
    }
    run('ffmpeg', ['-y', '-loglevel', 'error', ...input, '-filter_complex', filter, '-map', '[v]', '-map', '[a]', '-t', D.toFixed(2),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', seg], { cwd: WORK });
    console.log(`${b.id}: ${D.toFixed(1)} s`);
    parts.push(seg);
    total += D;
  }
  await browser.close();

  // A music bed: a slow two-chord pad and a soft pulse, kept well under the voice.
  const music = path.join(WORK, 'music.m4a');
  const chord = (f) => `(sin(2*PI*${f}*t)+0.5*sin(2*PI*${f * 2}*t))`;
  const sel = 'lt(mod(floor(t/4.8),2),1)';
  const pad =
    `0.05*(${sel}*(${chord(110)}+${chord(130.81)}+${chord(164.81)})+(1-${sel})*(${chord(87.31)}+${chord(110)}+${chord(130.81)}))*(0.65+0.35*sin(2*PI*0.2*t))`;
  const pulse = '0.16*sin(2*PI*52*t)*exp(-9*mod(t,0.6))';
  const hat = '0.02*sin(2*PI*7000*t)*exp(-60*mod(t+0.3,0.6))';
  run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `aevalsrc='${pad}+${pulse}+${hat}':s=44100:d=${(total + 2).toFixed(1)}`,
    '-af', `afade=t=in:d=1.5,afade=t=out:st=${(total - 1.2).toFixed(1)}:d=1.6,volume=0.9`, '-c:a', 'aac', '-b:a', '160k', music]);

  const list = path.join(WORK, 'list.txt');
  fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  const joined = path.join(WORK, 'joined.mp4');
  run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
  const final = path.join(WORK, outName);
  run('ffmpeg', ['-y', '-loglevel', 'error', '-i', joined, '-i', music, '-filter_complex', '[1:a]volume=0.55[m];[0:a][m]amix=inputs=2:normalize=0:duration=first[a]',
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', final]);
  console.log(`${final}: ${total.toFixed(0)} s, ${(fs.statSync(final).size / 1e6).toFixed(1)} MB`);
}

await main();

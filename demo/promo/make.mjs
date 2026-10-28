// A short promo video of the platform: title cards, live pages of the running platform, and clips cut from the guided demo.
//   node demo/promo/make.mjs [out.mp4]      (needs SDLC_USER and SDLC_PASSWORD for the live pages, and the guided scenes)
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, WORK as GUIDED, freshAuth, narrate, sleep } from '../guided/record.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');
const here = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.resolve(here, '..', '_work', 'promo');
fs.mkdirSync(WORK, { recursive: true });
const SIZE = { width: 1280, height: 720 };
const run = (cmd, a, o = {}) => execFileSync(cmd, a, { stdio: 'pipe', ...o });
const TITLE = 'Habit tracker';

const card = (title, sub, tag = '') => `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:radial-gradient(1200px 700px at 20% 10%,#16305c 0%,#0b1220 55%,#070b14 100%);color:#fff;font-family:Roboto,Segoe UI,Arial,sans-serif;overflow:hidden}
.wrap{height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 120px}
.tag{color:#ffb000;letter-spacing:3px;font-weight:700;font-size:20px;opacity:0;animation:in .7s .1s forwards}
h1{font-size:76px;line-height:1.08;margin:14px 0 18px;font-weight:800;opacity:0;animation:in .8s .3s forwards;max-width:1050px}
p{font-size:30px;line-height:1.4;color:#b8c7e6;margin:0;max-width:960px;opacity:0;animation:in .8s .7s forwards}
.bar{width:110px;height:6px;background:#ffb000;border-radius:3px;margin-top:34px;opacity:0;animation:in .8s 1s forwards}
@keyframes in{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:none}}
</style><div class="wrap"><div class="tag">${tag}</div><h1>${title}</h1><p>${sub}</p><div class="bar"></div></div>`;

/** Each beat: a line of narration, a short label for the corner, and what is on screen. */
const beats = [
  {
    id: 'hook',
    say: 'What if you could describe software in one sentence, and have it built, tested, and ready to merge, with you in charge of every decision that matters?',
    tag: '',
    visual: { type: 'card', title: 'From one sentence to merged software', sub: 'Autonomous SDLC: AI agents build. People decide.', tag: 'AUTONOMOUS SDLC' },
  },
  {
    id: 'flow',
    say: 'Autonomous SDLC is a platform where specialist agents write the spec, design the solution, and build each task, in parallel, in isolated sandboxes.',
    tag: 'AGENTS DO THE WORK',
    visual: { type: 'live', url: '/#/', act: 'home' },
  },
  {
    id: 'map',
    say: 'You see the whole plan on one map: the stages, the tasks, which files each one owns, and who each step is waiting on.',
    tag: 'ONE MAP OF THE WORK',
    visual: { type: 'live', url: '/#/map', act: 'map' },
  },
  {
    id: 'queue',
    say: 'Anything that needs a person lands in one attention queue, ranked by what it blocks, with the context to decide in a minute.',
    tag: 'PEOPLE DECIDE',
    visual: { type: 'clip', file: 'reviewspec', from: 14 },
  },
  {
    id: 'hardstop',
    say: 'Agents can be stopped. Protected files, new outside systems, and risky changes are hard stops that only a person can release.',
    tag: 'HARD STOPS',
    visual: { type: 'clip', file: 'protectedpath', from: 17 },
  },
  {
    id: 'checks',
    say: 'Nothing merges on a green build alone. A security review reads the change, a smoke test runs the real app, and a gate merges only what a person approved.',
    tag: 'CHECKS BEFORE MERGE',
    visual: { type: 'clip', file: 'reviewchecks2', from: 3 },
  },
  {
    id: 'preview',
    say: 'Try it before you approve it. One click starts a live preview of the pull request, in its own sandbox, so you use the app, not just read the diff.',
    tag: 'LIVE PREVIEWS',
    visual: { type: 'clip', file: 'tryapp2', from: 22 },
  },
  {
    id: 'integrations',
    say: 'Agents may only reach outside systems you approve, with the documentation they should read. Everything else is blocked.',
    tag: 'CONTROLLED INTEGRATIONS',
    visual: { type: 'live', url: '/#/integrations', act: 'scroll' },
  },
  {
    id: 'costs',
    say: 'Every model call is metered, by agent and by model, against a budget, so you always know what a feature cost.',
    tag: 'COST YOU CAN SEE',
    visual: { type: 'live', url: '/#/costs', act: 'scroll' },
  },
  {
    id: 'aws',
    say: 'It runs in your own AWS account: private by default, sign-in by invitation, deployed and removed with one workflow.',
    tag: 'YOUR AWS ACCOUNT',
    visual: { type: 'image', file: path.resolve(here, '..', '..', 'infra', 'aws', 'architecture.png') },
  },
  {
    id: 'close',
    say: 'Autonomous SDLC. Agents do the work. You make the calls.',
    tag: '',
    visual: { type: 'card', title: 'Agents do the work. You make the calls.', sub: 'Semi-autonomous software delivery, with a person at every decision that matters.', tag: 'AUTONOMOUS SDLC' },
  },
];

const ts = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s - h * 3600 - m * 60;
  return `${h}:${String(m).padStart(2, '0')}:${x.toFixed(2).padStart(5, '0')}`;
};
function chunks(text) {
  const out = [];
  for (const sentence of text.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [text]) {
    let cur = '';
    for (const w of sentence.trim().split(/\s+/)) {
      if ((cur + ' ' + w).trim().length > 80 && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
    }
    if (cur) out.push(cur);
  }
  return out;
}
const HEAD = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Cap,Arial,26,&H00FFFFFF,&H000000FF,&H99000000,&H99000000,0,0,0,0,100,100,0,0,3,6,0,2,60,60,26,1
Style: Tag,Arial,24,&H00101828,&H000000FF,&H0000B0FF,&H0000B0FF,1,0,0,0,100,100,0,0,3,7,0,7,28,20,24,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;

async function recordPage(browser, id, seconds, setup, state) {
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

async function liveClip(browser, state, b, seconds) {
  return recordPage(
    browser,
    b.id,
    seconds + 1,
    async (page) => {
      await page.goto(BASE + b.visual.url);
      await sleep(1500);
      if (b.visual.act === 'home') {
        await scrollSlowly(page, 520, Math.max(2000, seconds * 700));
      } else if (b.visual.act === 'map') {
        const sel = page.getByLabel('Initiative', { exact: true });
        await sel.waitFor({ timeout: 30000 });
        await sel.selectOption({ label: TITLE });
        await sleep(1500);
        await scrollSlowly(page, 480, Math.max(2000, seconds * 600));
      } else {
        await scrollSlowly(page, 300, Math.max(2000, seconds * 500));
      }
    },
    state,
  );
}

async function main() {
  const outName = process.argv[2] ?? 'promo.mp4';
  const browser = await chromium.launch();
  const state = await freshAuth(browser);
  const parts = [];
  let t = 0;
  for (const b of beats) {
    const { mp3, sec } = narrate(`promo-${b.id}`, b.say);
    const D = sec + 0.9;
    const v = b.visual;
    const seg = path.join(WORK, `${b.id}.mp4`);
    const ass = path.join(WORK, `${b.id}.ass`);
    let vf = 'fps=25,scale=1280:720';
    const input = [];
    if (v.type === 'card') {
      const src = await recordPage(browser, b.id, D + 1, async (page) => {
        await page.setContent(card(v.title, v.sub, v.tag));
      });
      input.push('-i', src);
    } else if (v.type === 'live') {
      input.push('-i', await liveClip(browser, state, b, D));
    } else if (v.type === 'clip') {
      input.push('-ss', String(v.from), '-i', path.join(GUIDED, 'scenes', `${v.file}.webm`));
    } else if (v.type === 'image') {
      input.push('-loop', '1', '-framerate', '25', '-i', v.file);
      vf = `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=#070b14,zoompan=z='min(zoom+0.0006,1.12)':d=1:s=1280x720:fps=25`;
    }
    let text = '';
    const list = chunks(b.say);
    const total = list.reduce((n, x) => n + x.length, 0);
    let c = 0.3;
    for (const x of list) {
      const d = (x.length / total) * sec;
      text += `Dialogue: 0,${ts(c)},${ts(c + d)},Cap,,0,0,0,,${x}\n`;
      c += d;
    }
    if (b.tag) text += `Dialogue: 1,${ts(0.2)},${ts(D)},Tag,,0,0,0,,${b.tag}\n`;
    fs.writeFileSync(ass, HEAD + text, 'utf8');
    const filter = `[0:v]${vf},subtitles=${path.basename(ass)},fade=t=in:st=0:d=0.25,fade=t=out:st=${(D - 0.3).toFixed(2)}:d=0.3[v];[1:a]adelay=300|300,apad[a]`;
    run('ffmpeg', ['-y', '-loglevel', 'error', ...input, '-i', mp3, '-filter_complex', filter, '-map', '[v]', '-map', '[a]', '-t', D.toFixed(2),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', seg], { cwd: WORK });
    console.log(`${b.id}: ${D.toFixed(1)} s`);
    parts.push(seg);
    t += D;
  }
  await browser.close();
  const list = path.join(WORK, 'list.txt');
  fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  const final = path.join(WORK, outName);
  run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', final]);
  console.log(`${final}: ${t.toFixed(0)} s, ${(fs.statSync(final).size / 1e6).toFixed(1)} MB`);
}

await main();

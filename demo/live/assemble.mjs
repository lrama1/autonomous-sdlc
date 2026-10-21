// Joins the recorded scenes into one MP4: narration (edge-tts) from each scene's start, burned-in captions, and the
// waiting stretches sped up with a label. node demo/live/assemble.mjs [out.mp4] [scene ...]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WORK, narrate } from './record.mjs';
import { scenes } from './scenes.mjs';

const ORDER = [
  'intro', 'signin', 'home', 'newinitiative', 'startspec', 'specwait', 'reviewspec', 'startdesign', 'designwait',
  'reviewdesign', 'startbuild', 'buildwait1', 'reviewpr1', 'smoke1', 'approvepr1', 'buildwait2', 'reviewpr2',
  'checkswait', 'reviewchecks2', 'tryapp', 'redowait', 'recheck', 'checkswait2', 'previewstart', 'tryapp2', 'approvepr2', 'mergewait',
  'finish', 'costs', 'outro',
];
// One recording that holds two scenes: the waiting for the preview, then the app.
const SPLIT = {
  previewstart: { file: 'tryapp2', from: 0, to: 38 },
  tryapp2: { file: 'tryapp2', from: 38 },
};
const args = process.argv.slice(2);
const outName = args[0] && args[0].endsWith('.mp4') ? args.shift() : 'expense-splitter-demo.mp4';
const ids = args.length ? args : ORDER;
const dir = path.join(WORK, 'out');
fs.mkdirSync(dir, { recursive: true });
const run = (cmd, a, opts = {}) => execFileSync(cmd, a, { stdio: 'pipe', ...opts });
const dur = (f) => Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
const ts = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s - h * 3600 - m * 60;
  return `${h}:${String(m).padStart(2, '0')}:${x.toFixed(2).padStart(5, '0')}`;
};

function chunks(text) {
  const out = [];
  for (const sentence of text.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [text]) {
    let cur = '';
    for (const w of sentence.trim().split(/\s+/)) {
      if ((cur + ' ' + w).trim().length > 84 && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
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
Style: Cap,Arial,25,&H00FFFFFF,&H000000FF,&H99000000,&H99000000,0,0,0,0,100,100,0,0,3,6,0,2,60,60,28,1
Style: Tag,Arial,24,&H00FFFFFF,&H000000FF,&H000066EE,&H000066EE,1,0,0,0,100,100,0,0,3,6,0,9,20,20,80,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;

const parts = [];
for (const id of ids) {
  const { mp3, sec } = narrate(id, scenes[id].say);
  let src = `${id}.webm`;
  const cut = SPLIT[id];
  if (cut) {
    src = `cut-${id}.webm`;
    const a = ['-y', '-loglevel', 'error', '-ss', String(cut.from), ...(cut.to ? ['-to', String(cut.to)] : []), '-i', `${cut.file}.webm`, '-c:v', 'libvpx', '-b:v', '2M', src];
    run('ffmpeg', a, { cwd: path.join(WORK, 'scenes') });
  }
  const real = dur(path.join(WORK, 'scenes', src));
  const lapse = Boolean(scenes[id].lapse);
  let target = real;
  if (lapse) target = Math.max(sec + 1.5, Math.min(30, real / 10));
  target = Math.max(target, sec + 1.2);
  const speed = real > target ? real / target : 1;
  const T = real / speed;
  const lead = 0.5;
  const list = chunks(scenes[id].say);
  const total = list.reduce((n, c) => n + c.length, 0);
  let t = lead;
  let ass = HEAD;
  for (const c of list) {
    const d = (c.length / total) * sec;
    ass += `Dialogue: 0,${ts(t)},${ts(t + d)},Cap,,0,0,0,,${c.replace(/,/g, ',')}\n`;
    t += d;
  }
  if (speed > 1.5) ass += `Dialogue: 1,${ts(0)},${ts(T)},Tag,,0,0,0,,Time-lapse x${Math.round(speed)}\n`;
  const assFile = `${id}.ass`;
  fs.writeFileSync(path.join(WORK, 'scenes', assFile), ass, 'utf8');
  const out = path.join(dir, `${id}.mp4`);
  const sf = speed > 1.01 ? `setpts=PTS/${speed.toFixed(4)},` : '';
  run('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', src, '-i', mp3,
    '-filter_complex',
    `[0:v]${sf}fps=25,scale=1280:720,subtitles=${assFile}[v];[1:a]adelay=${lead * 1000}|${lead * 1000},apad[a]`,
    '-map', '[v]', '-map', '[a]', '-t', T.toFixed(2), '-c:v', 'libx264', '-preset', 'fast', '-crf', '21',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', out,
  ], { cwd: path.join(WORK, 'scenes') });
  console.log(`${id}: ${real.toFixed(0)} s -> ${T.toFixed(0)} s${speed > 1.5 ? ` (x${speed.toFixed(0)})` : ''}`);
  parts.push(out);
}
const listFile = path.join(dir, 'list.txt');
fs.writeFileSync(listFile, parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
const final = path.join(WORK, outName);
run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', final]);
console.log(`${final}: ${dur(final).toFixed(0)} s, ${(fs.statSync(final).size / 1e6).toFixed(1)} MB`);
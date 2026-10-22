// Joins the recorded scenes into one MP4: each narration clip at the moment it was spoken, burned-in captions, and the
// waiting stretches sped up with a label.   node demo/guided/assemble.mjs [out.mp4] [scene ...]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WORK } from './record.mjs';
import { ORDER } from './scenes.mjs';

const args = process.argv.slice(2);
const outName = args[0] && args[0].endsWith('.mp4') ? args.shift() : 'guided-demo.mp4';
const ids = args.length ? args : ORDER.filter((id) => fs.existsSync(path.join(WORK, 'scenes', `${id}.json`)));
const dir = path.join(WORK, 'out');
fs.mkdirSync(dir, { recursive: true });
const run = (cmd, a, opts = {}) => execFileSync(cmd, a, { stdio: 'pipe', ...opts });
const dur = (f) => Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
const ts = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s - h * 3600 - m * 60;
  return `${h}:${String(m).padStart(2, '0')}:${x.toFixed(2).padStart(5, '0')}`;
};
const LEAD = 0.2; // the page opens a moment after the recording starts

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
  const meta = JSON.parse(fs.readFileSync(path.join(WORK, 'scenes', `${id}.json`), 'utf8'));
  const src = `${id}.webm`;
  const real = dur(path.join(WORK, 'scenes', src));
  const clips = meta.clips;
  const lastEnd = clips.reduce((m, c) => Math.max(m, c.at + c.sec), 0);
  let target = real;
  if (meta.lapse) target = Math.max(lastEnd + 1.5, Math.min(30, real / 10));
  target = Math.max(target, lastEnd + 1.2);
  const speed = real > target ? real / target : 1;
  const T = real / speed;
  // In a sped-up scene the narration sits at the start; everything else moves with the video.
  const at = (c) => (speed > 1.01 && meta.lapse ? LEAD + c.at / speed : LEAD + c.at);
  let ass = HEAD;
  for (const c of clips) {
    const list = chunks(c.text);
    const total = list.reduce((n, x) => n + x.length, 0);
    let t = at(c);
    for (const x of list) {
      const d = (x.length / total) * c.sec;
      ass += `Dialogue: 0,${ts(t)},${ts(t + d)},Cap,,0,0,0,,${x}\n`;
      t += d;
    }
  }
  if (speed > 1.5) ass += `Dialogue: 1,${ts(0)},${ts(T)},Tag,,0,0,0,,Time-lapse x${Math.round(speed)}\n`;
  fs.writeFileSync(path.join(WORK, 'scenes', `${id}.ass`), ass, 'utf8');
  const out = path.join(dir, `${id}.mp4`);
  const sf = speed > 1.01 ? `setpts=PTS/${speed.toFixed(4)},` : '';
  const inputs = ['-i', src];
  const extra = Math.max(0, T - real / speed) + 0.3; // the narration may run past the last frame
  let fc = `[0:v]${sf}fps=25,scale=1280:720,tpad=stop_mode=clone:stop_duration=${extra.toFixed(2)},subtitles=${id}.ass[v];`;
  const labels = [];
  clips.forEach((c, i) => {
    inputs.push('-i', c.mp3);
    const ms = Math.round(at(c) * 1000);
    fc += `[${i + 1}:a]adelay=${ms}|${ms}[a${i}];`;
    labels.push(`[a${i}]`);
  });
  if (clips.length === 0) {
    inputs.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
    fc += '[1:a]anull[a]';
  } else if (clips.length === 1) fc += `${labels[0]}apad[a]`;
  else fc += `${labels.join('')}amix=inputs=${clips.length}:normalize=0:duration=longest,apad[a]`;
  run('ffmpeg', [
    '-y', '-loglevel', 'error', ...inputs, '-filter_complex', fc,
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

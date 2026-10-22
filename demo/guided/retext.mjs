// Changes the words of one narration clip of a recorded scene without recording it again (a recording can change the
// platform's state, so some cannot be repeated).   node demo/guided/retext.mjs <scene> <clip number from 1> "<new text>"
import fs from 'node:fs';
import path from 'node:path';
import { WORK, narrate } from './record.mjs';

const [id, n, text] = process.argv.slice(2);
const file = path.join(WORK, 'scenes', `${id}.json`);
const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
const clip = meta.clips[Number(n) - 1];
if (!clip || !text) throw new Error('usage: retext.mjs <scene> <clip> "<text>"');
const { mp3, sec } = narrate(`${id}-r${n}`, text);
const next = meta.clips[Number(n)];
if (next && clip.at + sec + 0.35 > next.at) console.warn(`warning: the new clip overruns the next one by ${(clip.at + sec + 0.35 - next.at).toFixed(1)} s`);
Object.assign(clip, { mp3, sec, text });
fs.writeFileSync(file, JSON.stringify(meta));
console.log(`${id} clip ${n}: ${sec.toFixed(1)} s`);

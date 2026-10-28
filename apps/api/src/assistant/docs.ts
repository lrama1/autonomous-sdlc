import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The platform's own documents, searched by the assistant to answer questions about how the platform works. The files
// are read once, cut at their headings, and ranked by how many of the question's words they hold.

export interface DocSection {
  source: string;
  heading: string;
  text: string;
}

const FILES = ['README.md', 'docs/ADOPTING.md', 'mvp-contract.md'];
const MAX_SECTION = 3000;
const STOP = new Set([
  'the',
  'and',
  'for',
  'how',
  'what',
  'does',
  'this',
  'that',
  'with',
  'why',
  'can',
  'are',
]);

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));

/** Cuts a markdown file into sections at its headings, and long sections into pieces. */
export function sectionsOf(source: string, text: string): DocSection[] {
  const out: DocSection[] = [];
  let heading = source;
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join('\n').trim();
    buf = [];
    for (let i = 0; i < body.length; i += MAX_SECTION)
      if (body.slice(i, i + MAX_SECTION).trim())
        out.push({ source, heading, text: body.slice(i, i + MAX_SECTION) });
  };
  for (const line of text.split(/\r?\n/)) {
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      heading = h[2]!.trim();
    }
    buf.push(line);
  }
  flush();
  return out;
}

/** The sections that best answer a question, best first. */
export function searchSections(sections: DocSection[], query: string, limit = 4): DocSection[] {
  const terms = [...new Set(words(query))];
  if (terms.length === 0) return [];
  const scored = sections.map((s) => {
    const body = words(s.text);
    const head = words(s.heading);
    let score = 0;
    for (const t of terms) {
      score += body.filter((w) => w === t).length;
      if (head.includes(t)) score += 6;
    }
    // A section that holds many of the different words beats one that repeats a single word.
    const distinct = terms.filter((t) => body.includes(t) || head.includes(t)).length;
    return { s, score: score * (1 + distinct / terms.length) };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.s);
}

let cache: Promise<DocSection[]> | null = null;

/** The documents the platform ships with. A file that is not there is skipped, so a slim image still starts. */
export function loadDocs(root?: string): Promise<DocSection[]> {
  if (root === undefined && cache) return cache;
  const base = root ?? fileURLToPath(new URL('../../../../', import.meta.url));
  const loading = (async () => {
    const all: DocSection[] = [];
    for (const f of FILES) {
      const text = await readFile(path.join(base, f), 'utf8').catch(() => null);
      if (text) all.push(...sectionsOf(f, text));
    }
    return all;
  })();
  if (root === undefined) cache = loading;
  return loading;
}

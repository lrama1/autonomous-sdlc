import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDesigns } from './design-check.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-design-check-'));
  await mkdir(path.join(dir, 'docs', 'design'), { recursive: true });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const TASKS =
  "```sdlc-tasks\n- id: T1\n  title: One\n  role: backend_engineer\n  stories: [US-1]\n  depends_on: []\n  paths: [src/a.js]\n  done_when:\n    - 'it works'\n```\n";
const write = (name: string, body: string) =>
  writeFile(path.join(dir, 'docs', 'design', name), `# Design\n\n${body}`);

describe('checkDesigns', () => {
  it('accepts a design with a task list and either smoke checks or a reasoned none', async () => {
    await write('a.md', `${TASKS}\n\`\`\`sdlc-smoke\n- get: /health\n\`\`\`\n`);
    await write(
      'b.md',
      `${TASKS}\n\`\`\`sdlc-smoke\nnone: A library with no server to start.\n\`\`\`\n`,
    );
    expect(await checkDesigns(dir, ['docs/design/a.md'])).toBeNull();
    expect(await checkDesigns(dir, ['docs/design/b.md'])).toBeNull();
  });

  it('sends back a design with no smoke block, and says what to write', async () => {
    await write('c.md', TASKS);
    const problem = await checkDesigns(dir, ['docs/design/c.md']);
    expect(problem).toContain('docs/design/c.md');
    expect(problem).toContain('no ```sdlc-smoke block');
  });

  it('sends back a smoke block that is not valid YAML, as an unquoted command is', async () => {
    await write(
      'd.md',
      `${TASKS}\n\`\`\`sdlc-smoke\n- run: node -e "const o = {a: 1}; process.exit(0)"\n\`\`\`\n`,
    );
    const problem = await checkDesigns(dir, ['docs/design/d.md']);
    expect(problem).toContain('not valid YAML');
  });

  it('sends back a check the platform does not have, and a task list that does not read, together', async () => {
    await write(
      'e.md',
      '```sdlc-tasks\n- id: nope\n```\n\n```sdlc-smoke\n- post: /api/people\n```\n',
    );
    const problem = await checkDesigns(dir, ['docs/design/e.md']);
    expect(problem).toContain('id must look like T1');
    expect(problem).toContain('exactly one of get');
  });

  it('wants a design file, and ignores a deleted one', async () => {
    expect(await checkDesigns(dir, ['src/a.js'])).toContain('no design file');
    expect(await checkDesigns(dir, ['docs/design/gone.md'])).toBeNull();
  });
});

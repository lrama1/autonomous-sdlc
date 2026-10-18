// A stand-in for Claude Code in tests. It speaks the same stream-json and edits files the way an agent would.
// The scenario is read from ../scenario.json (the runner's work directory is the parent of the repo).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] ?? '';
const resumed = args.includes('--resume');
const work = path.resolve(process.cwd(), '..');
const scenario = JSON.parse(readFileSync(path.join(work, 'scenario.json'), 'utf8'));
const calls = existsSync(path.join(work, 'calls.json'))
  ? JSON.parse(readFileSync(path.join(work, 'calls.json'), 'utf8'))
  : [];
calls.push({
  prompt,
  resumed,
  env: {
    base: process.env.ANTHROPIC_BASE_URL,
    token: process.env.ANTHROPIC_AUTH_TOKEN,
    home: process.env.HOME,
    ghToken: process.env.GH_TOKEN ?? null,
  },
});
writeFileSync(path.join(work, 'calls.json'), JSON.stringify(calls));

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sid = 'fake-session-1';
const git = (...a) => execFileSync('git', a, { cwd: process.cwd(), stdio: 'pipe' });
const write = (file, text) => {
  mkdirSync(path.dirname(path.join(process.cwd(), file)), { recursive: true });
  writeFileSync(path.join(process.cwd(), file), text);
};
const commit = (msg) => {
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', msg);
};
const finish = (text, extra = {}) => {
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    session_id: sid,
    ...extra,
  });
  process.exit(0);
};

out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake', tools: [] });
out({
  type: 'assistant',
  session_id: sid,
  message: { content: [{ type: 'text', text: `working on: ${prompt.slice(0, 40)}` }] },
});

const step = scenario.steps?.[Math.min(calls.length - 1, scenario.steps.length - 1)] ?? scenario;

switch (step.do) {
  case 'write-good':
    write('src/value.txt', 'good\n');
    out({
      type: 'assistant',
      session_id: sid,
      message: {
        content: [
          { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'src/value.txt' } },
        ],
      },
    });
    out({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'File created' }] },
    });
    commit('add value');
    finish('Added the value.');
    break;
  case 'write-bad':
    write('src/value.txt', 'bad\n');
    commit('add value (wrong)');
    finish('Added the value.');
    break;
  case 'write-design-bad':
  case 'write-design-good': {
    // The unquoted line holds a colon and braces, which is not valid YAML. The quoted one is.
    const line =
      step.do === 'write-design-bad'
        ? '    - GET /x answers {"version": "1"}'
        : '    - \'GET /x answers {"ok": true}\'';
    write(
      'docs/design/thing.md',
      [
        '# Design',
        '',
        '```sdlc-tasks',
        '- id: T1',
        '  title: Add the route',
        '  role: backend_engineer',
        '  stories: [US-1]',
        '  paths: [src/server.js]',
        '  done_when:',
        line,
        '```',
        '',
      ].join('\n'),
    );
    write('src/value.txt', 'good\n');
    commit('add design');
    finish('Designed it.');
    break;
  }
  case 'edit-workflow':
    write('.github/workflows/ci.yml', 'name: changed\n');
    write('src/value.txt', 'good\n');
    commit('touch workflow');
    finish('Changed CI too.');
    break;
  case 'leave-uncommitted':
    write('src/value.txt', 'good\n');
    finish('Wrote the file but did not commit.');
    break;
  case 'no-change':
    finish('Nothing to do.');
    break;
  case 'max-turns':
    out({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      result: '',
      session_id: sid,
    });
    process.exit(0);
    break;
  case 'hang':
    // Waits like a blocked ask_human call until the runner stops it.
    setInterval(() => {}, 1000);
    break;
  default:
    finish('unknown scenario');
}

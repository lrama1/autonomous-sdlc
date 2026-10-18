// Spike 2 / T5: inject guidance into a running headless Claude Code session over stream-json stdin.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's';

const p = spawn('claude', [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--setting-sources', 'project', '--strict-mcp-config', '--model', 'agent-default',
  '--permission-mode', 'bypassPermissions',
], {
  cwd: path.join(here, 'work'),
  env: { ...process.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787', ANTHROPIC_AUTH_TOKEN: 'run-tok-1', ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: 'agent-default' },
  shell: false,
});

const send = (text) => {
  console.log(ts(), 'SEND', text);
  p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
};

let buf = '';
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'assistant') {
        for (const c of ev.message.content) {
          if (c.type === 'tool_use') console.log(ts(), 'TOOL', c.name, JSON.stringify(c.input).slice(0, 120));
          if (c.type === 'text') console.log(ts(), 'TEXT', c.text.slice(0, 160).replace(/\n/g, ' '));
        }
      } else if (ev.type === 'result') {
        console.log(ts(), 'RESULT', ev.result?.slice(0, 160).replace(/\n/g, ' '));
        p.stdin.end();
      }
    } catch { /* ignore */ }
  }
});
p.stderr.on('data', (d) => console.log('ERR', String(d).slice(0, 200)));
p.on('exit', (c) => console.log(ts(), 'exit', c));

send("Run the shell command 'sleep 25' (use the Bash tool), then create file a.txt containing 'A'. Say DONE.");
setTimeout(() => send("GUIDANCE from a human: change of plan. Do not create a.txt. Create b.txt containing 'B' instead."), 8000);

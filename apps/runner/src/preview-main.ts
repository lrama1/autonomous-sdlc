import { fetchCode, previewEnvFrom, startProgram } from './preview.js';

// The command of a Fargate preview task (see infra/aws/runner.tf). It ends when the previewed program ends.
const parsed = previewEnvFrom(process.env);
if ('error' in parsed) {
  console.error(parsed.error);
  process.exit(2);
}
const log = (l: string) => console.log(`[preview] ${l}`);
try {
  await fetchCode(parsed.env, log);
} catch (e) {
  console.error(
    `[preview] could not fetch the code: ${e instanceof Error ? e.message : String(e)}`,
  );
  process.exit(1);
}
const { child, done } = startProgram(parsed.env, parsed.childEnv);
// A stopped task tells this program, which tells the one it started.
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => child.kill(sig));
process.exit(await done);

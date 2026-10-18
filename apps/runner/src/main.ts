import { runnerEnvFrom } from './env.js';
import { runOnce } from './run.js';

// Started by the platform. Everything else comes from the run spec (see env.ts for what is read here).
const env = runnerEnvFrom(process.env);
if ('error' in env) {
  console.error(env.error);
  process.exit(2);
}

const reason = await runOnce(env);
console.log(`runner finished: ${reason}`);
process.exit(0);

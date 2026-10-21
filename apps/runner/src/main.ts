import { runnerEnvFrom } from './env.js';
import { runOnce } from './run.js';
import { saveOnTerminate } from './shutdown.js';
import { keepsFiles, restoreState, saveState } from './state.js';

// Started by the platform. Everything else comes from the run spec (see env.ts for what is read here).
const env = runnerEnvFrom(process.env);
if ('error' in env) {
  console.error(env.error);
  process.exit(2);
}

const stateLog = { log: (l: string) => console.log(`[state] ${l}`) };

// On Fargate nothing survives a task, so a resumed run first gets its files back.
if (env.stateGetUrl) {
  try {
    await restoreState(env.workDir, env.stateGetUrl, stateLog);
  } catch (e) {
    console.error(
      `could not restore the saved state: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }
}

// A stopped task (a cancel, a restart of the cluster) saves its files before it goes, if it can.
if (env.statePutUrl) {
  const putUrl = env.statePutUrl;
  saveOnTerminate(
    () => saveState(env.workDir, putUrl, { ...stateLog, attempts: 2 }),
    (code) => process.exit(code),
    stateLog.log,
  );
}

const reason = await runOnce(env);
console.log(`runner finished: ${reason}`);

// A run that parked or is blocked will be resumed by a new task, which needs this one's files.
if (keepsFiles(reason) && env.statePutUrl) {
  try {
    await saveState(env.workDir, env.statePutUrl, stateLog);
  } catch (e) {
    console.error(`could not save the state: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
process.exit(0);

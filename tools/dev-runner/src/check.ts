import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { meSchema } from '@sdlc/schemas';
import { signInAs } from './signin.js';
import { startStack } from './stack.js';

// Smoke check: starts the whole stack on spare ports with a throwaway database, signs in through the
// real OIDC flow, and checks /api/me. Exit code 0 means the local stack works end to end.
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sdlc-check-'));
const stack = await startStack({
  dataDir,
  ports: { web: 15173, api: 18080, gateway: 18787, idp: 19000, db: 55329 },
  log: () => {},
});

let ok: boolean;
try {
  const jar = await signInAs(stack.publicUrl, 'dev-bob');
  const me = await jar.fetch(`${stack.publicUrl}/api/me`);
  if (me.status !== 200) throw new Error(`/api/me returned ${me.status}`);
  const parsed = meSchema.parse(JSON.parse(me.text));
  console.log(`signed in as ${parsed.displayName} with hats: ${parsed.roles.join(', ')}`);
  const gateway = await fetch(`${stack.gatewayUrl}/healthz`);
  console.log(`gateway health: ${gateway.status}`);
  ok = gateway.ok && parsed.roles.includes('backend_engineer');
} finally {
  await stack.stop();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
console.log(ok ? 'CHECK PASSED' : 'CHECK FAILED');
process.exit(ok ? 0 : 1);

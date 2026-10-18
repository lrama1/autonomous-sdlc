import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedDemo } from './demo.js';
import { startStack } from './stack.js';

const demo = process.argv.includes('--demo') || process.env.SDLC_DEMO === '1';
// Demo data never goes into the real development database.
const dataDir =
  process.env.DEV_DATA_DIR ??
  (demo
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.dev-demo')
    : undefined);
const stack = await startStack({ dataDir });
if (demo) {
  const r = await seedDemo(stack.databaseUrl);
  console.log(
    r.seeded
      ? 'Demo data added: sign in as Bob to see the attention queue.'
      : 'Demo data is already there.',
  );
}

console.log(
  `\nAutonomous SDLC is running.\n  Web:      ${stack.publicUrl}\n  API:      ${stack.apiUrl}\n  Gateway:  ${stack.gatewayUrl}\n  Dev IdP:  ${stack.idpUrl}\n\nPress Ctrl+C to stop.`,
);

const shutdown = async () => {
  console.log('\nStopping...');
  await stack.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

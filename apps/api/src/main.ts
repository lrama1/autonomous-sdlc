import { runMigrations } from '@sdlc/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
await runMigrations(config.DATABASE_URL, { caFile: config.DATABASE_CA_FILE });
const app = await buildApp({ config, logger: true });

const stop = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// Local mode listens on loopback only. Behind a load balancer the container must listen on all interfaces.
await app.listen({
  port: config.API_PORT,
  host: config.API_HOST ?? (config.SDLC_ENV === 'local' ? '127.0.0.1' : '0.0.0.0'),
});

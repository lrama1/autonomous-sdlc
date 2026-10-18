import path from 'node:path';
import { startDevDb } from './index.js';

const dataDir = path.resolve(process.env.DEV_DATA_DIR ?? '.dev-data', 'postgres');
const db = await startDevDb({ dataDir });
console.log(`dev database ready: ${db.url}`);

const shutdown = async () => {
  await db.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

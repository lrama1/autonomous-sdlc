import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.js';
import type { DbOptions } from './client.js';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

export async function runMigrations(connectionString: string, opts: DbOptions = {}): Promise<void> {
  const { db, pool } = createDb(connectionString, opts);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}

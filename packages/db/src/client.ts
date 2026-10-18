import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>['db'];

export interface DbOptions {
  /** CA bundle that signed the server certificate. When given, TLS is on and the certificate is verified. */
  caFile?: string;
}

export function createDb(connectionString: string, opts: DbOptions = {}) {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    ssl: opts.caFile
      ? { ca: readFileSync(opts.caFile, 'utf8'), rejectUnauthorized: true }
      : undefined,
  });
  // A pooled connection that the database drops while idle (a restart, a shutdown) must not crash the process.
  // The pool discards it and the next query opens a new one.
  pool.on('error', (e) => console.error(`database connection dropped: ${e.message}`));
  const db = drizzle(pool, { schema });
  return { db, pool };
}

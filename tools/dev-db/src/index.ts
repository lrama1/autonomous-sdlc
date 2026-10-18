import { existsSync } from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

export interface DevDbOptions {
  dataDir: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

export interface DevDb {
  url: string;
  stop: () => Promise<void>;
}

/** Real PostgreSQL 16 binaries started as a child process. Used when Docker is not available. */
export async function startDevDb(opts: DevDbOptions): Promise<DevDb> {
  const port = opts.port ?? 54329;
  const database = opts.database ?? 'sdlc';
  const user = opts.user ?? 'sdlc';
  const password = opts.password ?? 'sdlc';

  const server = new EmbeddedPostgres({
    databaseDir: opts.dataDir,
    user,
    password,
    port,
    persistent: true,
    // A Windows machine defaults to WIN1252, which cannot store the characters test runners print. RDS is UTF8.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
    onError: (e) => console.error('[dev-db]', String(e)),
  });

  if (!existsSync(path.join(opts.dataDir, 'PG_VERSION'))) await server.initialise();
  await server.start();

  const admin = new pg.Client({ host: 'localhost', port, user, password, database: 'postgres' });
  await admin.connect();
  try {
    const found = await admin.query('select 1 from pg_database where datname = $1', [database]);
    if (found.rowCount === 0) {
      await admin.query(
        `create database "${database.replace(/"/g, '')}" encoding 'UTF8' template template0`,
      );
    }
    const enc = await admin.query(
      'select pg_encoding_to_char(encoding) as e from pg_database where datname = $1',
      [database],
    );
    if (enc.rows[0]?.e !== 'UTF8') {
      throw new Error(
        `The development database "${database}" uses ${enc.rows[0]?.e}, not UTF8. Stop the dev stack and delete ${opts.dataDir} to create it again.`,
      );
    }
  } catch (e) {
    await server.stop().catch(() => {});
    throw e;
  } finally {
    await admin.end();
  }

  return {
    url: `postgres://${user}:${password}@localhost:${port}/${database}`,
    stop: () => server.stop(),
  };
}

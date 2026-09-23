import 'dotenv/config';
import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const db = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
});
await db.connect();
try {
  await db.query('SELECT pg_advisory_lock(7843121)');
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, hash text NOT NULL, applied_at timestamptz DEFAULT now())',
  );
  for (const name of (await readdir('db/migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = await readFile(`db/migrations/${name}`, 'utf8'),
      hash = createHash('sha256').update(sql).digest('hex');
    const old = (await db.query('SELECT hash FROM schema_migrations WHERE name=$1', [name]))
      .rows[0];
    if (old) {
      if (old.hash !== hash) throw new Error(`Applied migration changed: ${name}`);
      continue;
    }
    await db.query('BEGIN');
    try {
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations(name,hash) VALUES($1,$2)', [name, hash]);
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
    console.log(`Applied ${name}`);
  }
} finally {
  await db.query('SELECT pg_advisory_unlock(7843121)').catch(() => {});
  await db.end();
}

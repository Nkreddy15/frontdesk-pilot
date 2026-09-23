import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { wasmDb, closeWasm } from '../packages/core/src/local-harness.js';
import { DEMO } from '../packages/core/src/demo.js';
if (process.env.NODE_ENV === 'production') throw new Error('Development only.');
await mkdir('.local', { recursive: true });
let env = await readFile('.env', 'utf8').catch(() => readFile('.env.example', 'utf8'));
for (const [k, v] of Object.entries({
  USE_PGLITE: 'true',
  DEV_AUTH_ENABLED: 'true',
  DEV_AUTH_TOKEN: process.env.DEV_AUTH_TOKEN || randomBytes(24).toString('hex'),
  SESSION_SECRET: process.env.SESSION_SECRET || randomBytes(48).toString('hex'),
  TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY || randomBytes(32).toString('hex'),
  WORKER_TENANT_IDS: DEMO.tenant,
})) {
  env = new RegExp(`^${k}=.*$`, 'm').test(env)
    ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`)
    : env + `\n${k}=${v}\n`;
  if (k === 'DEV_AUTH_TOKEN')
    await writeFile('.local/owner-access-code.txt', v + '\n', { mode: 0o600 });
}
await writeFile('.env', env, { mode: 0o600 });
const db = await wasmDb();
await db.exec(
  "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='receptionist_app') THEN CREATE ROLE receptionist_app NOSUPERUSER NOBYPASSRLS; END IF; END $$;",
);
await db.exec(
  'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,hash text NOT NULL,applied_at timestamptz DEFAULT now())',
);
const { readdir } = await import('node:fs/promises');
for (const name of (await readdir('db/migrations')).filter((n) => n.endsWith('.sql')).sort()) {
  const sql = await readFile(`db/migrations/${name}`, 'utf8'),
    hash = createHash('sha256').update(sql).digest('hex');
  const old = await db.query<{ hash: string }>('SELECT hash FROM schema_migrations WHERE name=$1', [
    name,
  ]);
  if (old.rows[0]) {
    if (old.rows[0].hash !== hash) throw new Error('Applied migration hash changed');
    continue;
  }
  await db.exec('BEGIN');
  try {
    await db.exec(sql);
    await db.query('INSERT INTO schema_migrations(name,hash) VALUES($1,$2)', [name, hash]);
    await db.exec('COMMIT');
  } catch (e) {
    await db.exec('ROLLBACK');
    throw e;
  }
  console.log(`WASM applied ${name}`);
}
// Seed through the same SQL as the native seed, with a deliberately different driver.
await closeWasm();
console.log(
  'WASM harness initialized. Run npm run db:seed. Native concurrency verification is still required.',
);

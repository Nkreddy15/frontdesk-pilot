import pg from 'pg';
import { config } from './config.js';
export type Context = {
  tenantId: string;
  userId: string;
  role: 'OWNER' | 'STAFF' | 'VIEWER' | 'VOICE' | 'WORKER';
  traceId: string;
  resourceId?: string;
};
const nativePool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 20,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  ssl: config.databaseSSL ? { rejectUnauthorized: true } : undefined,
});
nativePool.on('error', () => process.stderr.write('Database pool connection error\n'));
export const usingWasm = process.env.USE_PGLITE === 'true';
if (usingWasm && config.production)
  throw new Error('Development database harness prohibited in production.');
export const pool = usingWasm
  ? {
      connect: async () =>
        (await (await import('./local-harness.js')).wasmConnect()) as unknown as pg.PoolClient,
      end: async () => {
        await (await import('./local-harness.js')).closeWasm();
        await nativePool.end();
      },
    }
  : nativePool;
export type Tx = pg.PoolClient;
export async function verifyRuntimeDatabase() {
  if (usingWasm) return;
  const tx = await pool.connect();
  try {
    const role = (
      await tx.query(
        'SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
      )
    ).rows[0];
    const owner = (
      await tx.query(
        "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tableowner=current_user",
      )
    ).rows[0];
    if (role.rolsuper || role.rolbypassrls || owner.n > 0)
      throw new Error(
        'Runtime database credentials must not own tables or bypass row-level security.',
      );
    if (
      !(await tx.query("SELECT 1 FROM pg_constraint WHERE conname='no_resource_overlap'")).rowCount
    )
      throw new Error('Required booking exclusion constraint is missing. Apply migrations first.');
  } finally {
    tx.release();
  }
}
export async function withTenant<T>(ctx: Context, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    if (usingWasm) await tx.query('SET LOCAL ROLE receptionist_app');
    await tx.query(
      "SELECT set_config('app.tenant_id',$1,true),set_config('app.actor',$2,true),set_config('app.trace',$3,true),set_config('statement_timeout','15000',true),set_config('lock_timeout','10000',true)",
      [ctx.tenantId, ctx.userId, ctx.traceId],
    );
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (e) {
    await tx.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    tx.release();
  }
}
export async function schedulingLock(tx: Tx, locationId: string) {
  const result = await tx.query('SELECT id FROM locations WHERE id=$1 FOR UPDATE', [locationId]);
  if (!result.rowCount) throw new Error('LOCATION_NOT_FOUND');
}
export async function expireHolds(tx: Tx, locationId: string) {
  await tx.query(
    "UPDATE appointments SET state='EXPIRED',reason='hold_expired' WHERE location_id=$1 AND state='HELD' AND hold_expires_at<=clock_timestamp()",
    [locationId],
  );
}

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DateTime } from 'luxon';
import { SignJWT } from 'jose';
import { pool, usingWasm, type Context, type Tx } from '../packages/core/src/db.js';
import { config } from '../packages/core/src/config.js';
if (usingWasm) {
  const { wasmDb } = await import('../packages/core/src/local-harness.js');
  const db = await wasmDb();
  const { readdir, readFile } = await import('node:fs/promises');
  await db.exec('CREATE ROLE receptionist_app NOSUPERUSER NOBYPASSRLS');
  await db.exec('CREATE TABLE schema_migrations(name text PRIMARY KEY,hash text NOT NULL)');
  for (const name of (await readdir('db/migrations')).filter((n) => n.endsWith('.sql')).sort())
    await db.exec(await readFile('db/migrations/' + name, 'utf8'));
}
export async function admin<T>(fn: (db: Tx) => Promise<T>) {
  const db = usingWasm
    ? await pool.connect()
    : new pg.Client({
        connectionString: process.env.MIGRATION_DATABASE_URL,
        ssl: config.databaseSSL ? { rejectUnauthorized: true } : undefined,
      });
  if (!usingWasm) await (db as pg.Client).connect();
  try {
    return await fn(db as Tx);
  } finally {
    if (usingWasm) (db as Tx).release();
    else await (db as pg.Client).end();
  }
}
export async function fixture() {
  const tenantId = randomUUID(),
    locationId = randomUUID(),
    staffId = randomUUID(),
    bayId = randomUUID(),
    serviceId = randomUUID(),
    userId = randomUUID();
  await admin(async (tx) => {
    await tx.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [
      tenantId,
      'Automated test ' + tenantId.slice(0, 8),
    ]);
    await tx.query(
      "INSERT INTO locations(id,tenant_id,name,timezone,hours) VALUES($1,$2,'Test','America/New_York',$3)",
      [
        locationId,
        tenantId,
        Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [n, ['08:00', '20:00']])),
      ],
    );
    await tx.query(
      "INSERT INTO resources(id,tenant_id,location_id,name,kind) VALUES($1,$3,$4,'Test staff','STAFF'),($2,$3,$4,'Test bay','BAY')",
      [staffId, bayId, tenantId, locationId],
    );
    await tx.query(
      "INSERT INTO services(id,tenant_id,location_id,name,duration_minutes,buffer_before,buffer_after,price_cents) VALUES($1,$2,$3,'Test service',60,15,15,10000)",
      [serviceId, tenantId, locationId],
    );
    await tx.query('INSERT INTO service_staff VALUES($1,$2,$3)', [tenantId, serviceId, staffId]);
    await tx.query('INSERT INTO business_settings(tenant_id) VALUES($1)', [tenantId]);
    await tx.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [
      tenantId,
      userId,
    ]);
  });
  const ctx: Context = { tenantId, userId, role: 'OWNER', traceId: randomUUID() };
  const startsAt = DateTime.now()
    .setZone('America/New_York')
    .plus({ days: 3 })
    .startOf('day')
    .set({ hour: 10 })
    .toUTC()
    .toISO()!;
  const input = {
    locationId,
    serviceId,
    staffId,
    startsAt,
    customer: { name: 'Synthetic Customer', phone: '+15085550101', notes: '' },
    notes: '',
  };
  const csrf = randomUUID();
  const cookie =
    'receptionist_session=' +
    (await new SignJWT({ tenantId, csrf })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer('receptionist')
      .setAudience('dashboard')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(config.sessionSecret)));
  return {
    ctx,
    input,
    tenantId,
    locationId,
    staffId,
    bayId,
    serviceId,
    userId,
    csrf,
    cookie,
    headers: { cookie, origin: config.dashboardOrigin, 'x-csrf-token': csrf },
  };
}

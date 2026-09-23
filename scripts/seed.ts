import 'dotenv/config';
import pg from 'pg';
import { DEMO } from '../packages/core/src/demo.js';
if (process.env.NODE_ENV === 'production')
  throw new Error('Demo seed is prohibited in production.');
const native = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
const wasm = process.env.USE_PGLITE === 'true';
const db = wasm
  ? {
      query: async (sql: string, args?: unknown[]) => {
        const p = await import('../packages/core/src/local-harness.js');
        const d = await p.wasmDb();
        return args ? d.query(sql, args) : d.exec(sql);
      },
      end: async () => {
        await (await import('../packages/core/src/local-harness.js')).closeWasm();
      },
    }
  : native;
if (!wasm) await native.connect();
try {
  await db.query('BEGIN');
  await db.query('INSERT INTO tenants(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING', [
    DEMO.tenant,
    'Harbor Detail · Demo',
  ]);
  await db.query(
    'INSERT INTO locations(id,tenant_id,name,timezone,address) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    [
      DEMO.location,
      DEMO.tenant,
      'Worcester studio',
      'America/New_York',
      'Demo location — replace before launch',
    ],
  );
  await db.query(
    "INSERT INTO resources(id,tenant_id,location_id,name,kind) VALUES($1,$3,$4,'Alex Morgan','STAFF'),($2,$3,$4,'Detailing bay 1','BAY') ON CONFLICT DO NOTHING",
    [DEMO.staff, DEMO.bay, DEMO.tenant, DEMO.location],
  );
  for (const [i, name, duration, price, after] of [
    [0, 'Express detail', 60, 7900, 15],
    [1, 'Interior refresh', 90, 14900, 15],
    [2, 'Full detail', 180, 24900, 30],
  ] as const) {
    await db.query(
      'INSERT INTO services(id,tenant_id,location_id,name,duration_minutes,price_cents,buffer_after,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
      [
        DEMO.services[i],
        DEMO.tenant,
        DEMO.location,
        name,
        duration,
        price,
        after,
        'Sample catalog for local testing. Owner approval required before launch.',
      ],
    );
    await db.query('INSERT INTO service_staff VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [
      DEMO.tenant,
      DEMO.services[i],
      DEMO.staff,
    ]);
  }
  await db.query("INSERT INTO memberships VALUES($1,$2,'OWNER',NULL) ON CONFLICT DO NOTHING", [
    DEMO.tenant,
    DEMO.owner,
  ]);
  await db.query('INSERT INTO business_settings(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [
    DEMO.tenant,
  ]);
  await db.query(
    "INSERT INTO knowledge(tenant_id,topic,question,answer,published) VALUES($1,'parking','Where can I park?','This is a demonstration business. Parking information has not been approved.',false) ON CONFLICT DO NOTHING",
    [DEMO.tenant],
  );
  await db.query('COMMIT');
  console.log('Seeded a clearly labeled demonstration business. No real customer data.');
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  throw e;
} finally {
  await db.end();
}

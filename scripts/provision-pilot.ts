import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { IANAZone } from 'luxon';
if (!process.argv[2] || !process.env.MIGRATION_DATABASE_URL)
  throw new Error(
    'Usage: npm run provision:pilot -- path/to/approved-private-pilot.json; configure migration credentials securely.',
  );
const text = await readFile(process.argv[2], 'utf8');
if (text.includes('REPLACE WITH') || text.includes('00000000-0000-4000-8000-000000000000'))
  throw new Error('Replace every placeholder with owner-approved business data.');
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
const input = z
  .object({
    businessName: z.string().min(2).max(100),
    ownerUserId: z.string().uuid(),
    locationName: z.string().min(1).max(100),
    timezone: z.string().refine((v) => IANAZone.isValidZone(v)),
    address: z.string().min(5).max(500),
    phone,
    transferNumber: phone,
    hours: z.record(
      z.string().regex(/^[1-7]$/),
      z
        .tuple([
          z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
          z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        ])
        .refine((v) => v[0] < v[1]),
    ),
    staff: z.array(z.string().min(1).max(100)).min(1).max(10),
    bays: z.array(z.string().min(1).max(100)).min(1).max(10),
    services: z
      .array(
        z
          .object({
            name: z.string().min(1).max(100),
            description: z.string().max(1000),
            durationMinutes: z.number().int().min(5).max(480),
            bufferBefore: z.number().int().min(0).max(120),
            bufferAfter: z.number().int().min(0).max(120),
            priceCents: z.number().int().min(0).max(10000000),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict()
  .parse(JSON.parse(text));
const db = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
});
await db.connect();
try {
  await db.query('BEGIN');
  if ((await db.query('SELECT 1 FROM memberships WHERE user_id=$1', [input.ownerUserId])).rowCount)
    throw new Error(
      'Owner already provisioned. This command creates a new pilot only; use dashboard edits thereafter.',
    );
  const tenantId = randomUUID(),
    locationId = randomUUID();
  // Tenant settings also support a migration role subject to FORCE RLS.
  await db.query(
    "SELECT set_config('app.tenant_id',$1,true),set_config('app.actor','provisioning',true)",
    [tenantId],
  );
  await db.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, input.businessName]);
  await db.query(
    'INSERT INTO locations(id,tenant_id,name,timezone,address,phone,hours) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      locationId,
      tenantId,
      input.locationName,
      input.timezone,
      input.address,
      input.phone,
      input.hours,
    ],
  );
  const staffIds: string[] = [];
  for (const [kind, names] of [
    ['STAFF', input.staff],
    ['BAY', input.bays],
  ] as const)
    for (const name of names) {
      const id = randomUUID();
      await db.query(
        'INSERT INTO resources(id,tenant_id,location_id,name,kind) VALUES($1,$2,$3,$4,$5)',
        [id, tenantId, locationId, name, kind],
      );
      if (kind === 'STAFF') staffIds.push(id);
    }
  for (const s of input.services) {
    const id = randomUUID();
    await db.query(
      'INSERT INTO services(id,tenant_id,location_id,name,description,duration_minutes,buffer_before,buffer_after,price_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        id,
        tenantId,
        locationId,
        s.name,
        s.description,
        s.durationMinutes,
        s.bufferBefore,
        s.bufferAfter,
        s.priceCents,
      ],
    );
    for (const staff of staffIds)
      await db.query('INSERT INTO service_staff VALUES($1,$2,$3)', [tenantId, id, staff]);
  }
  await db.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [
    tenantId,
    input.ownerUserId,
  ]);
  await db.query(
    'INSERT INTO business_settings(tenant_id,transfer_enabled,transfer_number,approved_for_live) VALUES($1,true,$2,false)',
    [tenantId, input.transferNumber],
  );
  await db.query('INSERT INTO phone_routes(phone,tenant_id,location_id) VALUES($1,$2,$3)', [
    input.phone,
    tenantId,
    locationId,
  ]);
  await db.query("SELECT record_audit('tenant',$1,'pilot_provisioned','{}')", [tenantId]);
  await db.query('COMMIT');
  console.log(
    JSON.stringify(
      {
        tenantId,
        locationId,
        ownerUserId: input.ownerUserId,
        next: 'Set trusted Supabase app_metadata.tenant_id to this tenant UUID using the Supabase admin interface/API, add WORKER_TENANT_IDS, then sign in and review the catalog. Live approval remains false.',
      },
      null,
      2,
    ),
  );
} catch (e) {
  await db.query('ROLLBACK');
  throw e;
} finally {
  await db.end();
}

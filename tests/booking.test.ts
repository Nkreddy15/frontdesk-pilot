import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, withTenant, usingWasm } from '../packages/core/src/db.js';
import {
  createBooking,
  confirmHold,
  reschedule,
  changeState,
  createBlock,
  availability,
} from '../packages/core/src/booking.js';
import { fixture, admin } from './helpers.js';
import { buildApp } from '../apps/api/src/app.js';
after(() => pool.end());
test('committed booking has exactly two resource claims, audit, and outbox', async () => {
  const f = await fixture(),
    r = await createBooking(f.ctx, f.input, randomUUID());
  assert.equal(r.status, 201);
  assert.equal(r.body.committed, true);
  assert.equal(r.body.appointment.state, 'CONFIRMED');
  await withTenant(f.ctx, async (tx) => {
    assert.equal((await tx.query('SELECT * FROM resource_reservations')).rowCount, 2);
    assert.equal((await tx.query('SELECT * FROM audit_events')).rowCount, 1);
    assert.equal((await tx.query('SELECT * FROM outbox_jobs')).rowCount, 3);
  });
});
test('50 simultaneous API requests: one commit and 49 conflicts with three alternatives (harness behavior only when WASM)', async (t) => {
  const f = await fixture(),
    app = await buildApp({ logger: false });
  const responses = await Promise.all(
    Array.from({ length: 50 }, () =>
      app.inject({
        method: 'POST',
        url: '/v1/appointments',
        headers: { ...f.headers, 'idempotency-key': randomUUID() },
        payload: f.input,
      }),
    ),
  );
  assert.equal(
    responses.filter((r) => r.statusCode === 201).length,
    1,
    responses.map((r) => r.body).join('\n'),
  );
  assert.equal(responses.filter((r) => r.statusCode === 409).length, 49);
  for (const r of responses.filter((r) => r.statusCode === 409)) {
    assert.equal(r.json().error, 'SLOT_CONFLICT');
    assert.equal(r.json().alternatives.length, 3);
    assert.equal(r.json().committed, false);
  }
  await withTenant(f.ctx, async (tx) =>
    assert.equal(
      (await tx.query("SELECT id FROM appointments WHERE state='CONFIRMED'")).rowCount,
      1,
    ),
  );
  t.diagnostic(
    usingWasm
      ? '50-request application test uses serialized PostgreSQL-WASM. Native multi-process gate NOT satisfied.'
      : 'Native PostgreSQL application race passed.',
  );
  await app.close();
});
test('replayed requests have one appointment and reject changed payload', async () => {
  const f = await fixture(),
    key = randomUUID();
  const a = await createBooking(f.ctx, f.input, key),
    b = await createBooking(f.ctx, f.input, key);
  assert.equal(b.replayed, true);
  assert.equal(a.body.appointment.id, b.body.appointment.id);
  await assert.rejects(
    createBooking(f.ctx, { ...f.input, notes: 'changed' }, key),
    /IDEMPOTENCY_KEY_REUSED/,
  );
});
test('held slot blocks owner; no messages before confirmation; receipt follows commit', async () => {
  const f = await fixture(),
    held = await createBooking({ ...f.ctx, role: 'VOICE' }, f.input, randomUUID(), true);
  assert.equal(held.body.appointment.state, 'HELD');
  await withTenant(f.ctx, async (tx) =>
    assert.equal((await tx.query('SELECT * FROM outbox_jobs')).rowCount, 0),
  );
  const loser = await createBooking(f.ctx, f.input, randomUUID());
  assert.equal(loser.status, 409);
  const confirm = await confirmHold(
    f.ctx,
    held.body.appointment.id,
    {
      locationId: f.locationId,
      holdToken: held.body.holdToken,
      expectedVersion: 1,
      readbackAccepted: true,
    },
    randomUUID(),
  );
  assert.equal(confirm.body.appointment.state, 'CONFIRMED');
  await withTenant(f.ctx, async (tx) =>
    assert.equal((await tx.query('SELECT * FROM outbox_jobs')).rowCount, 3),
  );
});
test('expired hold is released inside booking transaction', async () => {
  const f = await fixture(),
    held = await createBooking(f.ctx, f.input, randomUUID(), true);
  await admin((tx) =>
    tx.query(
      "UPDATE appointments SET hold_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [held.body.appointment.id],
    ),
  );
  const newBooking = await createBooking(f.ctx, f.input, randomUUID());
  assert.equal(newBooking.status, 201);
  const expired = await confirmHold(
    f.ctx,
    held.body.appointment.id,
    {
      locationId: f.locationId,
      holdToken: held.body.holdToken,
      expectedVersion: 1,
      readbackAccepted: true,
    },
    randomUUID(),
  );
  assert.equal(expired.status, 410);
});
test('buffers overlap; touching endpoints permitted; failed reschedule preserves original', async () => {
  const f = await fixture(),
    first = await createBooking(f.ctx, f.input, randomUUID());
  const at = (mins: number) =>
    new Date(new Date(f.input.startsAt).getTime() + mins * 60000).toISOString();
  assert.equal(
    (await createBooking(f.ctx, { ...f.input, startsAt: at(75) }, randomUUID())).status,
    409,
  );
  const second = await createBooking(f.ctx, { ...f.input, startsAt: at(90) }, randomUUID());
  assert.equal(second.status, 201);
  const conflict = await reschedule(
    f.ctx,
    first.body.appointment.id,
    { locationId: f.locationId, startsAt: at(90), staffId: f.staffId, expectedVersion: 1 },
    randomUUID(),
  );
  assert.equal(conflict.status, 409);
  await withTenant(f.ctx, async (tx) => {
    const a = (
      await tx.query('SELECT starts_at,version FROM appointments WHERE id=$1', [
        first.body.appointment.id,
      ])
    ).rows[0];
    assert.equal(new Date(a.starts_at).toISOString(), f.input.startsAt);
    assert.equal(a.version, 1);
  });
});
test('database exclusion independently rejects a direct insert that skips availability code', async () => {
  const f = await fixture(),
    a = await createBooking(f.ctx, f.input, randomUUID());
  await assert.rejects(
    withTenant(f.ctx, (tx) =>
      tx.query(
        `INSERT INTO appointments(tenant_id,location_id,customer_id,service_id,staff_id,bay_id,starts_at,ends_at,duration_minutes,buffer_before,buffer_after,price_cents,service_name,state,source)
 SELECT tenant_id,location_id,customer_id,service_id,staff_id,bay_id,starts_at,ends_at,duration_minutes,buffer_before,buffer_after,price_cents,service_name,state,source FROM appointments WHERE id=$1`,
        [a.body.appointment.id],
      ),
    ),
    (e: any) => e.code === '23P01',
  );
});
test('different staff cannot double book the same bay; time off rejects overlap', async () => {
  const f = await fixture();
  await createBooking(f.ctx, f.input, randomUUID());
  const staff2 = randomUUID();
  await admin(async (tx) => {
    await tx.query(
      "INSERT INTO resources(id,tenant_id,location_id,name,kind) VALUES($1,$2,$3,'Second staff','STAFF')",
      [staff2, f.tenantId, f.locationId],
    );
    await tx.query('INSERT INTO service_staff VALUES($1,$2,$3)', [f.tenantId, f.serviceId, staff2]);
  });
  assert.equal(
    (await createBooking(f.ctx, { ...f.input, staffId: staff2 }, randomUUID())).status,
    409,
  );
  const blocked = await createBlock(
    f.ctx,
    {
      locationId: f.locationId,
      resourceId: f.staffId,
      startsAt: f.input.startsAt,
      endsAt: new Date(new Date(f.input.startsAt).getTime() + 3600000).toISOString(),
      reason: 'Time off',
    },
    randomUUID(),
  );
  assert.equal(blocked.status, 409);
});
test('cancel releases claims, retains audit, and stale writes fail', async () => {
  const f = await fixture(),
    a = await createBooking(f.ctx, f.input, randomUUID());
  const result = await changeState(
    f.ctx,
    a.body.appointment.id,
    {
      locationId: f.locationId,
      expectedVersion: 1,
      state: 'CANCELLED',
      reason: 'customer_request',
    },
    randomUUID(),
  );
  assert.equal(result.status, 200);
  assert.equal((await createBooking(f.ctx, f.input, randomUUID())).status, 201);
  assert.equal(
    (
      await changeState(
        f.ctx,
        a.body.appointment.id,
        { locationId: f.locationId, expectedVersion: 1, state: 'COMPLETED', reason: 'stale' },
        randomUUID(),
      )
    ).status,
    409,
  );
});
test('tenant isolation is enforced by RLS and protected projections cannot be written', async () => {
  const a = await fixture(),
    b = await fixture();
  const booked = await createBooking(a.ctx, a.input, randomUUID());
  await withTenant(b.ctx, async (tx) => {
    assert.equal(
      (await tx.query('SELECT * FROM appointments WHERE id=$1', [booked.body.appointment.id]))
        .rowCount,
      0,
    );
    assert.equal((await tx.query('SELECT * FROM customers')).rowCount, 0);
  });
  await assert.rejects(
    withTenant(a.ctx, (tx) => tx.query('UPDATE resource_reservations SET active=false')),
    (e: any) => e.code === '42501',
  );
});
test('API rejects unauthenticated, forged origin, missing CSRF, and unknown input fields', async () => {
  const f = await fixture(),
    app = await buildApp({ logger: false });
  assert.equal((await app.inject({ url: '/v1/bootstrap' })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/appointments',
        headers: { ...f.headers, origin: 'https://evil.example', 'idempotency-key': randomUUID() },
        payload: f.input,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/appointments',
        headers: {
          cookie: f.cookie,
          origin: 'http://localhost:3000',
          'idempotency-key': randomUUID(),
        },
        payload: f.input,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/appointments',
        headers: { ...f.headers, 'idempotency-key': randomUUID() },
        payload: { ...f.input, tenantId: f.tenantId },
      })
    ).statusCode,
    400,
  );
  await app.close();
});

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, withTenant } from '../packages/core/src/db.js';
import { createBooking, changeState } from '../packages/core/src/booking.js';
import { startCall, command } from '../packages/core/src/conversation.js';
import { recordExternalEvent } from '../packages/providers/src/google.js';
import { runOne } from '../apps/worker/src/jobs.js';
import { buildApp } from '../apps/api/src/app.js';
import { fixture } from './helpers.js';
after(() => pool.end());

test('deletion refuses active bookings, then redacts terminal notes and cached receipts', async () => {
  const f = await fixture(),
    app = await buildApp({ logger: false });
  try {
    const key = randomUUID(),
      input = { ...f.input, notes: 'Private synthetic note' },
      b = await createBooking(f.ctx, input, key),
      a = b.body.appointment;
    const request = {
      method: 'POST' as const,
      url: `/v1/customers/${a.customer_id}/delete`,
      headers: f.headers,
      payload: { confirm: 'DELETE_CUSTOMER_DATA' },
    };
    assert.equal((await app.inject(request)).statusCode, 409);
    await changeState(
      f.ctx,
      a.id,
      { locationId: f.locationId, expectedVersion: a.version, state: 'CANCELLED', reason: 'test' },
      randomUUID(),
    );
    const r = await app.inject(request);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(
      (await createBooking(f.ctx, input, key)).status,
      410,
      'Redaction retains a deduplication tombstone',
    );
    await withTenant(f.ctx, async (tx) => {
      const row = (
        await tx.query('SELECT notes,state,reason FROM appointments WHERE id=$1', [a.id])
      ).rows[0];
      assert.deepEqual(row, { notes: '', state: 'CANCELLED', reason: 'privacy_redaction' });
      assert.equal(
        (
          await tx.query(
            "SELECT 1 FROM idempotency_requests WHERE result::text LIKE '%Private synthetic note%'",
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (await tx.query("SELECT 1 FROM audit_events WHERE action='personal_data_deleted'"))
          .rowCount,
        1,
      );
    });
    await assert.rejects(
      withTenant(f.ctx, (tx) =>
        tx.query("UPDATE appointments SET starts_at=starts_at+interval '1 day' WHERE id=$1", [
          a.id,
        ]),
      ),
      /TERMINAL_STATE/,
    );
  } finally {
    await app.close();
  }
});

test('unresolved Google conflict prevents unpause; observed deletion resolves it without cancelling a booking', async () => {
  const f = await fixture(),
    app = await buildApp({ logger: false });
  try {
    const b = await createBooking(f.ctx, f.input, randomUUID());
    await recordExternalEvent(f.ctx, f.locationId, {
      id: 'foreign-event',
      start: { dateTime: b.body.appointment.starts_at },
      end: { dateTime: b.body.appointment.ends_at },
    });
    const settings = {
      greeting: 'I am the AI receptionist. How can I help?',
      transfer_enabled: false,
      transfer_number: '',
      booking_paused: false,
      transcript_retention_days: 30,
      lead_retention_days: 90,
    };
    const r = await app.inject({
      method: 'PATCH',
      url: '/v1/settings',
      headers: f.headers,
      payload: settings,
    });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error, 'UNRESOLVED_CALENDAR_CONFLICT');
    await recordExternalEvent(f.ctx, f.locationId, { id: 'foreign-event', status: 'cancelled' });
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: '/v1/settings',
          headers: f.headers,
          payload: settings,
        })
      ).statusCode,
      200,
    );
    await withTenant(f.ctx, async (tx) =>
      assert.equal(
        (await tx.query("SELECT 1 FROM appointments WHERE state='CONFIRMED'")).rowCount,
        1,
      ),
    );
  } finally {
    await app.close();
  }
});

test('workers cannot claim another version of an entity while its job is running', async () => {
  const f = await fixture();
  await createBooking(f.ctx, f.input, randomUUID());
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((r) => (release = r)),
    begun = new Promise<void>((r) => (started = r));
  const first = runOne(f.ctx, {
    'sms.confirm': async () => {
      started();
      await waiting;
      return { providerId: 'synthetic-receipt' };
    },
  });
  await begun;
  try {
    assert.equal(
      await runOne(f.ctx, {
        'calendar.sync': async () => {
          throw new Error('Must not overlap');
        },
      }),
      false,
    );
  } finally {
    release();
    await first;
  }
});

test('ended conversations cannot perform new booking actions but replay their completed action', async () => {
  const f = await fixture(),
    c = await startCall(f.ctx, f.locationId),
    key = randomUUID();
  const ended = await command(f.ctx, c.callId, key, { type: 'END' });
  assert.deepEqual(await command(f.ctx, c.callId, key, { type: 'END' }), ended);
  await assert.rejects(
    command(f.ctx, c.callId, randomUUID(), { type: 'DETAILS', name: 'Cannot modify' }),
    /CALL_BUSY_OR_NOT_FOUND/,
  );
});

test('viewer cannot mutate appointments or owner settings', async () => {
  const f = await fixture(),
    app = await buildApp({ logger: false });
  try {
    await withTenant(f.ctx, (tx) =>
      tx.query("UPDATE memberships SET role='VIEWER' WHERE user_id=$1", [f.userId]),
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/appointments',
          headers: { ...f.headers, 'idempotency-key': randomUUID() },
          payload: f.input,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ method: 'PATCH', url: '/v1/settings', headers: f.headers, payload: {} }))
        .statusCode,
      403,
    );
    await withTenant(f.ctx, (tx) =>
      tx.query("UPDATE memberships SET role='STAFF',resource_id=NULL WHERE user_id=$1", [f.userId]),
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url:
            '/v1/appointments?from=' +
            encodeURIComponent(f.input.startsAt) +
            '&to=' +
            encodeURIComponent(f.input.startsAt),
          headers: f.headers,
        })
      ).statusCode,
      403,
      'Misconfigured staff scope must fail closed',
    );
  } finally {
    await app.close();
  }
});

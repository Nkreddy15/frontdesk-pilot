import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, withTenant } from '../packages/core/src/db.js';
import { startCall, command, markReadbackPlayed } from '../packages/core/src/conversation.js';
import { createBooking } from '../packages/core/src/booking.js';
import { fixture } from './helpers.js';
after(() => pool.end());
async function prepared(mode: 'SIMULATOR' | 'TELEPHONE' = 'SIMULATOR') {
  const f = await fixture(),
    call = await startCall(f.ctx, f.locationId, mode);
  const act = (cmd: any, key = randomUUID()) => command(f.ctx, call.callId, key, cmd);
  await act({
    type: 'DETAILS',
    name: f.input.customer.name,
    phone: f.input.customer.phone,
    serviceId: f.serviceId,
    staffId: f.staffId,
    from: f.input.startsAt,
  });
  const options = await act({ type: 'AVAILABILITY' });
  return { ...f, call, act, options };
}
test('receptionist never confirms during availability or hold; confirmation follows committed receipt', async () => {
  const f = await prepared();
  assert.equal(f.options.confirmed, undefined);
  const review = await f.act({ type: 'SELECT_SLOT', index: 0 });
  assert.equal(review.phase, 'REVIEW');
  assert.equal(review.confirmed, undefined);
  assert.match(review.say, /America\/New York/);
  assert.match(review.say, /Synthetic Customer/);
  assert.match(review.say, /Test staff/);
  const confirmed = await f.act({ type: 'CONFIRM' });
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.appointment.state, 'CONFIRMED');
  await withTenant(f.ctx, async (tx) => {
    assert.equal(
      (await tx.query("SELECT * FROM appointments WHERE state='CONFIRMED'")).rowCount,
      1,
    );
    assert.equal((await tx.query('SELECT * FROM outbox_jobs')).rowCount, 3);
  });
});
test('telephone confirmation requires completed readback playback, not a cleared mark', async () => {
  const f = await prepared('TELEPHONE');
  await f.act({ type: 'SELECT_SLOT', index: 0 });
  const early = await f.act({ type: 'CONFIRM' });
  assert.equal(early.confirmed, undefined);
  assert.match(early.say, /finish reviewing/);
  await markReadbackPlayed(f.ctx, f.call.callId);
  const r = await f.act({ type: 'CONFIRM' });
  assert.equal(r.confirmed, true);
});
test('owner wins offered slot; receptionist reports conflict and three fresh choices', async () => {
  const f = await prepared(),
    slot = f.options.slots![0];
  await createBooking(f.ctx, { ...f.input, startsAt: slot.startsAt }, randomUUID());
  const conflict = await f.act({ type: 'SELECT_SLOT', index: 0 });
  assert.equal(conflict.confirmed, undefined);
  assert.match(conflict.say, /just taken/);
  assert.equal(conflict.slots?.length, 3);
  assert.notEqual(conflict.slots?.[0].startsAt, slot.startsAt);
});
test('correction releases the old hold and duplicate actions do not create a second booking', async () => {
  const f = await prepared();
  await f.act({ type: 'SELECT_SLOT', index: 0 });
  await f.act({ type: 'CORRECT' });
  await withTenant(f.ctx, async (tx) => {
    assert.equal((await tx.query('SELECT * FROM resource_reservations WHERE active')).rowCount, 0);
    assert.equal((await tx.query('SELECT * FROM outbox_jobs')).rowCount, 0);
  });
  await f.act({ type: 'AVAILABILITY' });
  const key = randomUUID();
  const a = await f.act({ type: 'SELECT_SLOT', index: 0 }, key),
    b = await f.act({ type: 'SELECT_SLOT', index: 0 }, key);
  assert.deepEqual(a, b);
  await assert.rejects(f.act({ type: 'SELECT_SLOT', index: 1 }, key), /ACTION_ID_REUSED/);
});
test('dropped call saves a follow-up and releases unconfirmed inventory', async () => {
  const f = await prepared();
  await f.act({ type: 'SELECT_SLOT', index: 0 });
  const dropped = await f.act({ type: 'DISCONNECT' });
  assert.equal(dropped.ended, true);
  await withTenant(f.ctx, async (tx) => {
    assert.equal((await tx.query('SELECT * FROM resource_reservations WHERE active')).rowCount, 0);
    assert.equal((await tx.query("SELECT * FROM leads WHERE reason='CALL_DROPPED'")).rowCount, 1);
  });
});
test('reference and callback verification are required for caller cancellation', async () => {
  const f = await prepared(),
    b = await createBooking(f.ctx, f.input, randomUUID());
  const denied = await f.act({ type: 'CANCEL_APPOINTMENT' });
  assert.match(denied.say, /verify/);
  assert.equal(denied.confirmed, undefined);
  await f.act({ type: 'LOOKUP', phone: f.input.customer.phone, reference: b.body.manageCode });
  const review = await f.act({ type: 'CANCEL_APPOINTMENT' });
  assert.equal(review.phase, 'CANCEL_REVIEW');
  const done = await f.act({ type: 'CONFIRM' });
  assert.equal(done.appointment.state, 'CANCELLED');
});
test('unpublished knowledge is never returned; unsupported request creates a lead', async () => {
  const f = await prepared();
  await withTenant(f.ctx, (tx) =>
    tx.query(
      "INSERT INTO knowledge(tenant_id,topic,question,answer,published) VALUES($1,'unapproved','Secret?','UNAPPROVED_INFORMATION',false)",
      [f.tenantId],
    ),
  );
  const a = await f.act({ type: 'QUESTION', topic: 'unapproved' });
  assert.doesNotMatch(a.say, /UNAPPROVED_INFORMATION/);
  await f.act({ type: 'UNSUPPORTED' });
  await withTenant(f.ctx, async (tx) =>
    assert.equal((await tx.query('SELECT * FROM leads')).rowCount, 1),
  );
});

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import twilio from 'twilio';
import { pool, withTenant } from '../packages/core/src/db.js';
import { createBooking } from '../packages/core/src/booking.js';
import { config } from '../packages/core/src/config.js';
import { runOne } from '../apps/worker/src/jobs.js';
import { ProviderError } from '../packages/providers/src/types.js';
import {
  AudioInput,
  encodeMuLaw,
  decodeMuLaw,
  pcm24ToMuLaw8,
  TranscriptOrder,
} from '../packages/providers/src/audio.js';
import { encrypt, decrypt } from '../packages/providers/src/crypto.js';
import { recordExternalEvent, pullCalendar } from '../packages/providers/src/google.js';
import { fixture, admin } from './helpers.js';
import { buildApp } from '../apps/api/src/app.js';
after(() => pool.end());
test('audio codec preserves sample count, silence, sign, and bounded speech error', () => {
  assert.equal(decodeMuLaw(255), 0);
  assert.equal(encodeMuLaw(0), 255);
  for (const sample of [-24000, -10000, -1000, 1000, 10000, 24000])
    assert.ok(Math.abs(decodeMuLaw(encodeMuLaw(sample)) - sample) < Math.abs(sample) * 0.05 + 16);
  const pcm = new AudioInput().convert(Buffer.alloc(160, 255));
  assert.equal(pcm.length, 960);
  assert.ok(pcm.every((b) => b === 0));
  assert.deepEqual(pcm24ToMuLaw8(pcm), Buffer.alloc(160, 255));
});
test('out-of-order transcription completion is processed in committed turn order', () => {
  const queue = new TranscriptOrder();
  queue.commit('first');
  queue.commit('second');
  queue.complete('second', 'correction');
  assert.equal(queue.drain().length, 0);
  queue.complete('first', 'request');
  assert.deepEqual(
    queue.drain().map((i) => i.text),
    ['request', 'correction'],
  );
  queue.commit('first');
  assert.equal(queue.drain().length, 0);
});
test('OAuth tokens use authenticated encryption and reject tampering', () => {
  const text = encrypt({ refresh_token: 'test-only-secret' });
  assert.ok(!text.includes('test-only-secret'));
  assert.equal(decrypt(text).refresh_token, 'test-only-secret');
  const parts = text.split('.');
  parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => decrypt(parts.join('.')));
});
test('simulated ambiguous SMS timeout becomes UNKNOWN and is never automatically sent again', async () => {
  const f = await fixture();
  await createBooking(f.ctx, f.input, randomUUID());
  let calls = 0;
  await runOne(f.ctx, {
    'sms.confirm': async () => {
      calls++;
      throw new ProviderError('TEST_TIMEOUT', 'UNKNOWN');
    },
  });
  const job = await withTenant(
    f.ctx,
    async (tx) => (await tx.query("SELECT * FROM outbox_jobs WHERE kind='sms.confirm'")).rows[0],
  );
  assert.equal(job.status, 'UNKNOWN');
  await runOne(f.ctx, { 'calendar.sync': async () => ({ providerId: 'test-calendar-id' }) });
  assert.equal(calls, 1);
});
test('disabled providers are blocked honestly without a fabricated delivery receipt', async () => {
  const f = await fixture();
  await createBooking(f.ctx, f.input, randomUUID());
  await runOne(f.ctx);
  const j = await withTenant(
    f.ctx,
    async (tx) => (await tx.query("SELECT * FROM outbox_jobs WHERE kind='sms.confirm'")).rows[0],
  );
  assert.equal(j.status, 'BLOCKED');
  assert.equal(j.provider_id, null);
  assert.equal(j.last_error, 'SMS_DISABLED');
});
test('signed duplicate message callbacks are deduplicated and delivery does not regress', async () => {
  const f = await fixture();
  await createBooking(f.ctx, f.input, randomUUID());
  const job = await withTenant(
    f.ctx,
    async (tx) => (await tx.query("SELECT id FROM outbox_jobs WHERE kind='sms.confirm'")).rows[0],
  );
  const token = config.twilioToken,
    url = config.publicApiUrl;
  config.twilioToken = 'test-signing-secret';
  config.publicApiUrl = 'https://test.example';
  const app = await buildApp({ logger: false });
  let failure = '';
  app.addHook('onError', async (_req, _reply, e) => {
    failure = e.message;
  });
  try {
    const path = `/webhooks/twilio/messages?tenant=${f.tenantId}&job=${job.id}`,
      body = { MessageSid: 'SM' + '1'.repeat(32), MessageStatus: 'delivered' },
      signature = twilio.getExpectedTwilioSignature(
        config.twilioToken,
        config.publicApiUrl + path,
        body,
      );
    const headers = {
      'x-twilio-signature': signature,
      'content-type': 'application/x-www-form-urlencoded',
    };
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: path,
            headers,
            payload: new URLSearchParams(body).toString(),
          })
        ).statusCode,
        204,
        failure,
      );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: { ...headers, 'x-twilio-signature': 'forged' },
          payload: new URLSearchParams(body).toString(),
        })
      ).statusCode,
      403,
    );
    const older = { ...body, MessageStatus: 'sent' };
    headers['x-twilio-signature'] = twilio.getExpectedTwilioSignature(
      config.twilioToken,
      config.publicApiUrl + path,
      older,
    );
    await app.inject({
      method: 'POST',
      url: path,
      headers,
      payload: new URLSearchParams(older).toString(),
    });
    await withTenant(f.ctx, async (tx) => {
      assert.equal((await tx.query('SELECT * FROM webhook_inbox')).rowCount, 2);
      assert.equal(
        (await tx.query('SELECT delivery_status FROM outbox_jobs WHERE id=$1', [job.id])).rows[0]
          .delivery_status,
        'delivered',
      );
    });
  } finally {
    config.twilioToken = token;
    config.publicApiUrl = url;
    await app.close();
  }
});
test('external Google overlap pauses new bookings without cancelling the authoritative appointment', async () => {
  const f = await fixture(),
    booked = await createBooking(f.ctx, f.input, randomUUID());
  await recordExternalEvent(f.ctx, f.locationId, {
    id: 'external-test',
    start: { dateTime: f.input.startsAt },
    end: { dateTime: new Date(new Date(f.input.startsAt).getTime() + 3600000).toISOString() },
  });
  await withTenant(f.ctx, async (tx) => {
    assert.equal(
      (await tx.query('SELECT state FROM appointments WHERE id=$1', [booked.body.appointment.id]))
        .rows[0].state,
      'CONFIRMED',
    );
    assert.equal(
      (await tx.query('SELECT booking_paused FROM business_settings')).rows[0].booking_paused,
      true,
    );
    assert.equal((await tx.query('SELECT * FROM sync_exceptions')).rowCount, 1);
  });
});
test('signed ended call without an AI session creates one follow-up despite duplicate callbacks', async () => {
  const f = await fixture(),
    old = { sid: config.twilioSid, token: config.twilioToken, url: config.publicApiUrl };
  config.twilioSid = 'AC' + '2'.repeat(32);
  config.twilioToken = 'synthetic-signing-key';
  config.publicApiUrl = 'https://test.example';
  await admin((tx) =>
    tx.query('INSERT INTO phone_routes(phone,tenant_id,location_id) VALUES($1,$2,$3)', [
      '+15085550188',
      f.tenantId,
      f.locationId,
    ]),
  );
  const app = await buildApp({ logger: false });
  let failure = '';
  app.addHook('onError', async (_r, _p, e) => {
    failure = e.message;
  });
  try {
    const path = '/webhooks/twilio/call-status',
      b = {
        AccountSid: config.twilioSid,
        CallSid: 'CA' + '3'.repeat(32),
        To: '+15085550188',
        From: '+15085550189',
        CallStatus: 'no-answer',
        CallDuration: '0',
      };
    const headers = {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': twilio.getExpectedTwilioSignature(
        config.twilioToken,
        config.publicApiUrl + path,
        b,
      ),
    };
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: path,
            headers,
            payload: new URLSearchParams(b).toString(),
          })
        ).statusCode,
        204,
        failure,
      );
    await withTenant(f.ctx, async (tx) => {
      assert.equal((await tx.query('SELECT * FROM calls')).rowCount, 1);
      assert.equal((await tx.query('SELECT * FROM leads')).rowCount, 1);
      assert.equal((await tx.query('SELECT * FROM call_events')).rowCount, 0);
    });
  } finally {
    config.twilioSid = old.sid;
    config.twilioToken = old.token;
    config.publicApiUrl = old.url;
    await app.close();
  }
});
test('deleted app-managed Google event raises an exception; database booking survives', async () => {
  const f = await fixture(),
    b = await createBooking(f.ctx, f.input, randomUUID());
  await withTenant(f.ctx, (tx) =>
    tx.query(
      'INSERT INTO calendar_projections(tenant_id,appointment_id,event_id) VALUES($1,$2,$3)',
      [f.tenantId, b.body.appointment.id, 'owned-event'],
    ),
  );
  await recordExternalEvent(f.ctx, f.locationId, { id: 'owned-event', status: 'cancelled' });
  await withTenant(f.ctx, async (tx) =>
    assert.equal((await tx.query('SELECT state FROM appointments')).rows[0].state, 'CONFIRMED'),
  );
});
test('simulated Google 410 resets sync token and completes a full reconciliation', async () => {
  const f = await fixture();
  await withTenant(f.ctx, (tx) =>
    tx.query(
      'INSERT INTO calendar_connections(tenant_id,location_id,calendar_id,encrypted_tokens,sync_token,channel_expires_at) VALUES($1,$2,$3,$4,$5,$6)',
      [
        f.tenantId,
        f.locationId,
        'test-calendar',
        encrypt({ access_token: 'test-token', expires_at: Date.now() + 3600000 }),
        'expired',
        new Date(Date.now() + 86400000).toISOString(),
      ],
    ),
  );
  const original = globalThis.fetch,
    flag = config.calendar;
  config.calendar = true;
  const urls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    urls.push(String(input));
    return urls.length === 1
      ? new Response('{}', { status: 410 })
      : Response.json({ items: [], nextSyncToken: 'fresh' });
  }) as typeof fetch;
  try {
    await pullCalendar(f.ctx);
    assert.equal(urls.length, 2);
    assert.match(urls[0], /syncToken=expired/);
    assert.doesNotMatch(urls[1], /syncToken/);
    await withTenant(f.ctx, async (tx) =>
      assert.equal(
        (await tx.query('SELECT sync_token FROM calendar_connections')).rows[0].sync_token,
        'fresh',
      ),
    );
  } finally {
    globalThis.fetch = original;
    config.calendar = flag;
  }
});

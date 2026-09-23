import 'dotenv/config';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
if (process.env.NODE_ENV === 'production' || !process.env.DEV_AUTH_TOKEN)
  throw new Error('Synthetic local smoke test only.');
await mkdir('evidence', { recursive: true });
await mkdir('.local', { recursive: true });
const log = createWriteStream('.local/http-smoke-services.log', { mode: 0o600 });
const child = spawn(process.execPath, ['scripts/dev.mjs'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});
child.stdout.pipe(log);
child.stderr.pipe(log);
const base = 'http://localhost:3000',
  checks = [];
let cookie = '',
  csrf = '';
async function api(path, method = 'GET', payload, extra = {}) {
  const r = await fetch(base + '/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: base,
      ...(cookie ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}),
      ...extra,
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  return { r, body: await r.json() };
}
let failure;
try {
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      const { r } = await api('/auth/config');
      if (r.ok) {
        up = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(up, 'Application did not start');
  const html = await fetch(base);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Opening your workspace|frontdesk/i);
  checks.push('Next.js renders the dashboard document over HTTP');
  assert.equal((await api('/v1/bootstrap')).r.status, 401);
  checks.push('Proxy rejects unauthenticated business access');
  const login = await api('/auth/login', 'POST', { accessCode: process.env.DEV_AUTH_TOKEN });
  assert.equal(login.r.status, 200);
  cookie = login.r.headers.getSetCookie()[0].split(';')[0];
  csrf = login.body.csrf;
  assert.ok(cookie && csrf);
  checks.push('Local owner authentication sets a session cookie through the Next.js proxy');
  const b = (await api('/v1/bootstrap')).body;
  assert.ok(b.services.length && b.locations.length);
  const service = b.services.find((s) => s.active),
    location = b.locations[0];
  const params = new URLSearchParams({
    locationId: location.id,
    serviceId: service.id,
    from: new Date(Date.now() + 2 * 86400000).toISOString(),
    limit: '3',
  });
  const slots = (await api('/v1/availability?' + params)).body.slots;
  assert.equal(slots.length, 3);
  const slot = slots[0],
    key = randomUUID(),
    payload = {
      locationId: location.id,
      serviceId: service.id,
      staffId: slot.staffId,
      startsAt: slot.startsAt,
      customer: { name: 'Synthetic HTTP Smoke', phone: '+15085550198', notes: '' },
      notes: 'Automated synthetic smoke test',
    };
  const a = await api('/v1/appointments', 'POST', payload, { 'Idempotency-Key': key });
  assert.equal(a.r.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.appointment.state, 'CONFIRMED');
  const replay = await api('/v1/appointments', 'POST', payload, { 'Idempotency-Key': key });
  assert.equal(replay.body.appointment.id, a.body.appointment.id);
  checks.push(
    'Manual booking commits once and retries return the same appointment through the proxy',
  );
  const conflict = await api('/v1/appointments', 'POST', payload, {
    'Idempotency-Key': randomUUID(),
  });
  assert.equal(conflict.r.status, 409);
  assert.equal(conflict.body.alternatives.length, 3);
  checks.push('Conflicts preserve HTTP 409 and three fresh alternatives through the proxy');
  const cancelled = await api(
    '/v1/appointments/' + a.body.appointment.id + '/state',
    'POST',
    {
      locationId: location.id,
      expectedVersion: a.body.appointment.version,
      state: 'CANCELLED',
      reason: 'synthetic_smoke_cleanup',
    },
    { 'Idempotency-Key': randomUUID() },
  );
  assert.equal(cancelled.r.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.appointment.state, 'CANCELLED');
  checks.push('Cancellation commits through the same API');
  const metrics = await api('/v1/metrics');
  assert.equal(metrics.r.status, 200);
  assert.ok(
    Number.isFinite(metrics.body.answered_calls) && Number.isFinite(metrics.body.cost_cents),
  );
  checks.push('Owner metrics include answered calls and explicit estimated costs');
  const ops = await api('/v1/operations');
  assert.equal(ops.r.status, 200);
  assert.ok(ops.body.audit.length);
  checks.push('Operations and database audit records are readable by the owner');
} catch (e) {
  failure = e;
} finally {
  await writeFile(
    'evidence/http-smoke.json',
    JSON.stringify(
      {
        at: new Date().toISOString(),
        passed: !failure,
        mode: process.env.USE_PGLITE === 'true' ? 'PostgreSQL-WASM' : 'native PostgreSQL',
        checks,
        liveProvidersExercised: false,
        browserRendered: false,
        ...(failure ? { error: failure.message } : {}),
      },
      null,
      2,
    ),
  );
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await exited;
  log.end();
}
if (failure) throw failure;
console.log(
  `${checks.length} HTTP application smoke checks passed. No browser or live provider validation is implied.`,
);

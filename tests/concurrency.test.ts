import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pool, usingWasm, withTenant } from '../packages/core/src/db.js';
import { changeState } from '../packages/core/src/booking.js';
import { fixture } from './helpers.js';
after(() => pool.end());
test(
  'NATIVE RELEASE GATE: 100 rounds x 50 requests across two API processes',
  {
    skip: usingWasm
      ? 'Requires native PostgreSQL. WASM serialization is not a native concurrency proof.'
      : false,
    timeout: 240000,
  },
  async (t) => {
    const f = await fixture();
    const ports = [4141, 4142];
    const children = ports.map((port) =>
      spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/server.ts'], {
        env: {
          ...process.env,
          USE_PGLITE: 'false',
          NODE_ENV: 'test',
          API_PORT: String(port),
          TEST_CONCURRENCY: 'true',
        },
        stdio: ['ignore', 'ignore', 'inherit'],
      }),
    );
    try {
      for (const port of ports) {
        let ready = false;
        for (let i = 0; i < 100; i++) {
          try {
            const r = await fetch(`http://127.0.0.1:${port}/health/ready`);
            if (r.ok) {
              ready = true;
              break;
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(ready, 'API process failed to start');
      }
      const rounds = Number(process.env.CONCURRENCY_ROUNDS || 100);
      for (let round = 0; round < rounds; round++) {
        const responses = await Promise.all(
          Array.from({ length: 50 }, (_, i) =>
            fetch(`http://127.0.0.1:${ports[i % 2]}/v1/appointments`, {
              method: 'POST',
              headers: {
                ...f.headers,
                'Content-Type': 'application/json',
                'idempotency-key': randomUUID(),
              },
              body: JSON.stringify(f.input),
            }).then(async (r) => ({ status: r.status, body: await r.json() })),
          ),
        );
        assert.equal(
          responses.filter((r) => r.status === 201).length,
          1,
          `round ${round}: ${JSON.stringify(responses.map((r) => r.status))}`,
        );
        assert.equal(
          responses.filter(
            (r) =>
              r.status === 409 &&
              r.body.error === 'SLOT_CONFLICT' &&
              r.body.alternatives.length === 3,
          ).length,
          49,
        );
        const winner = responses.find((r) => r.status === 201)!.body.appointment;
        await withTenant(f.ctx, async (tx) =>
          assert.equal(
            (await tx.query("SELECT * FROM appointments WHERE state='CONFIRMED'")).rowCount,
            1,
          ),
        );
        assert.equal(
          (
            await changeState(
              f.ctx,
              winner.id,
              {
                locationId: f.locationId,
                expectedVersion: winner.version,
                state: 'CANCELLED',
                reason: 'concurrency_test_cleanup',
              },
              randomUUID(),
            )
          ).status,
          200,
        );
      }
      t.diagnostic(`${rounds * 50} native requests verified across two persistent API processes.`);
    } finally {
      const exits = children.map((p) =>
        p.exitCode !== null || p.signalCode !== null
          ? Promise.resolve()
          : new Promise<void>((r) => p.once('exit', () => r())),
      );
      for (const p of children) p.kill('SIGTERM');
      await Promise.all(exits);
    }
  },
);

test(
  'NATIVE RELEASE GATE: another connection cannot read notification jobs before commit',
  {
    skip: usingWasm
      ? 'Requires two native PostgreSQL connections; the WASM harness serializes transactions.'
      : false,
  },
  async () => {
    const f = await fixture(),
      owner = await pool.connect();
    try {
      await owner.query('BEGIN');
      await owner.query(
        "SELECT set_config('app.tenant_id',$1,true),set_config('app.actor','commit-visibility-test',true)",
        [f.tenantId],
      );
      const c = (
        await owner.query(
          'INSERT INTO customers(tenant_id,name,phone) VALUES($1,$2,$3) RETURNING id',
          [f.tenantId, 'Synthetic visibility', f.input.customer.phone],
        )
      ).rows[0];
      await owner.query(
        "INSERT INTO appointments(tenant_id,location_id,customer_id,service_id,staff_id,bay_id,starts_at,ends_at,duration_minutes,buffer_before,buffer_after,price_cents,service_name,state,source) VALUES($1,$2,$3,$4,$5,$6,$7,$7::timestamptz+interval '1 hour',60,15,15,10000,'Test service','CONFIRMED','OWNER')",
        [f.tenantId, f.locationId, c.id, f.serviceId, f.staffId, f.bayId, f.input.startsAt],
      );
      await withTenant(f.ctx, async (tx) =>
        assert.equal((await tx.query('SELECT * FROM outbox_jobs')).rowCount, 0),
      );
      await owner.query('COMMIT');
      await withTenant(f.ctx, async (tx) =>
        assert.equal((await tx.query('SELECT * FROM outbox_jobs')).rowCount, 3),
      );
    } catch (e) {
      await owner.query('ROLLBACK');
      throw e;
    } finally {
      owner.release();
    }
  },
);

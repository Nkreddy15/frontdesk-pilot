import { randomUUID } from 'node:crypto';
import {
  withTenant,
  schedulingLock,
  expireHolds,
  type Context,
} from '../../../packages/core/src/db.js';
import { ProviderError, type Delivery } from '../../../packages/providers/src/types.js';
import { sendSms } from '../../../packages/providers/src/twilio.js';
import {
  calendarWrite,
  pullCalendar,
  reconcileException,
} from '../../../packages/providers/src/google.js';
import { config } from '../../../packages/core/src/config.js';
export type Handler = (ctx: Context, job: any) => Promise<Delivery>;
export const handlers: Record<string, Handler> = {
  'sms.confirm': sendSms,
  'sms.reschedule': sendSms,
  'sms.cancel': sendSms,
  'sms.reminder': sendSms,
  'calendar.sync': calendarWrite,
  'calendar.pull': pullCalendar,
  'calendar.reconcile': reconcileException,
};
export async function runOne(ctx: Context, overrides?: Record<string, Handler>) {
  const job = await withTenant(ctx, async (tx) => {
    await tx.query('SELECT id FROM tenants FOR UPDATE');
    // Once a send may have reached the provider, a crashed SMS job is never blindly resent.
    await tx.query(
      "UPDATE outbox_jobs SET status=CASE WHEN kind LIKE 'sms.%' THEN 'UNKNOWN' ELSE 'PENDING' END,last_error='WORKER_LEASE_EXPIRED',lease_until=NULL,lease_owner=NULL WHERE status='RUNNING' AND lease_until<clock_timestamp()",
    );
    const j = (
      await tx.query(
        "SELECT j.* FROM outbox_jobs j WHERE j.status='PENDING' AND j.available_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM outbox_jobs r WHERE r.status='RUNNING' AND (r.entity_id=j.entity_id OR (r.kind LIKE 'calendar.%' AND j.kind LIKE 'calendar.%'))) ORDER BY j.available_at,j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1",
      )
    ).rows[0];
    if (!j) return null;
    return (
      await tx.query(
        "UPDATE outbox_jobs SET status='RUNNING',attempts=attempts+1,lease_until=clock_timestamp()+interval '90 seconds',lease_owner=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
        [j.id, randomUUID()],
      )
    ).rows[0];
  });
  if (!job) return false;
  const heartbeat = setInterval(() => {
    void withTenant(ctx, (tx) =>
      tx.query(
        "UPDATE outbox_jobs SET lease_until=clock_timestamp()+interval '90 seconds' WHERE id=$1 AND lease_owner=$2 AND status='RUNNING'",
        [job.id, job.lease_owner],
      ),
    ).catch(() => {});
  }, 20000);
  try {
    const handler = (overrides || handlers)[job.kind];
    if (!handler) throw new ProviderError('UNKNOWN_JOB_TYPE', 'FAILED');
    const result = await handler(ctx, job);
    await withTenant(ctx, (tx) =>
      tx.query(
        "UPDATE outbox_jobs SET status='SUCCEEDED',provider_id=COALESCE($2,provider_id),delivery_status=COALESCE(delivery_status,$3),sent_at=clock_timestamp(),lease_until=NULL,last_error=NULL,updated_at=clock_timestamp() WHERE id=$1 AND status='RUNNING' AND lease_owner=$4",
        [job.id, result.providerId || null, result.deliveryStatus || null, job.lease_owner],
      ),
    );
  } catch (e) {
    const error =
      e instanceof ProviderError
        ? e
        : new ProviderError(
            'UNEXPECTED_PROVIDER_ERROR',
            job.kind.startsWith('sms.') ? 'UNKNOWN' : 'RETRY',
          );
    const retry = error.disposition === 'RETRY' && job.attempts < 6;
    const status = retry ? 'PENDING' : error.disposition === 'RETRY' ? 'FAILED' : error.disposition;
    const delay = Math.min(3600, 2 ** job.attempts * 5) + Math.floor(Math.random() * 10);
    await withTenant(ctx, (tx) =>
      tx.query(
        "UPDATE outbox_jobs SET status=$2,available_at=clock_timestamp()+make_interval(secs=>$3),lease_until=NULL,last_error=$4,updated_at=clock_timestamp() WHERE id=$1 AND status='RUNNING' AND lease_owner=$5",
        [job.id, status, delay, error.code, job.lease_owner],
      ),
    );
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
export async function maintenance(ctx: Context) {
  await withTenant(ctx, async (tx) => {
    const locations = (await tx.query('SELECT id FROM locations ORDER BY id')).rows;
    for (const l of locations) {
      await schedulingLock(tx, l.id);
      await expireHolds(tx, l.id);
    }
    const settings = (await tx.query('SELECT * FROM business_settings')).rows[0];
    if (!settings) return;
    const ids = (
      await tx.query(
        'SELECT id FROM calls WHERE ended_at<clock_timestamp()-make_interval(days=>$1) AND transcript_purged_at IS NULL',
        [settings.transcript_retention_days],
      )
    ).rows.map((r) => r.id);
    if (ids.length) {
      await tx.query('DELETE FROM call_events WHERE call_id=ANY($1::uuid[])', [ids]);
      await tx.query('DELETE FROM tool_executions WHERE call_id=ANY($1::uuid[])', [ids]);
      await tx.query(
        "UPDATE calls SET workflow='{}',summary='Transcript retention period elapsed',caller_phone=NULL,transcript_purged_at=clock_timestamp() WHERE id=ANY($1::uuid[])",
        [ids],
      );
    }
    await tx.query(
      "DELETE FROM leads WHERE status IN ('CLOSED','CONVERTED') AND updated_at<clock_timestamp()-make_interval(days=>$1)",
      [settings.lead_retention_days],
    );
    await tx.query("DELETE FROM oauth_states WHERE expires_at<clock_timestamp()-interval '1 day'");
    // Retain request hashes as tombstones so an old retry can never become a new booking.
    await tx.query(
      'UPDATE idempotency_requests SET http_status=410,result=\'{"error":"REQUEST_RESULT_EXPIRED","committed":false}\' WHERE created_at<clock_timestamp()-interval \'90 days\' AND http_status<>410',
    );
    if (config.calendar && (await tx.query('SELECT 1 FROM calendar_connections')).rowCount) {
      await tx.query(
        "INSERT INTO outbox_jobs(tenant_id,kind,entity_id,version,dedup_key) VALUES($1,'calendar.pull',$1,0,$2) ON CONFLICT DO NOTHING",
        [ctx.tenantId, `calendar.pull:${Math.floor(Date.now() / 60000)}`],
      );
    }
  });
}
export function startWorker() {
  let stopped = false,
    busy = false,
    lastMaintenance = 0;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      for (const tenantId of config.workerTenants) {
        const ctx: Context = { tenantId, userId: 'worker', role: 'WORKER', traceId: randomUUID() };
        if (Date.now() - lastMaintenance > 60000) await maintenance(ctx);
        for (let i = 0; i < 10; i++) if (!(await runOne(ctx))) break;
      }
      if (Date.now() - lastMaintenance > 60000) lastMaintenance = Date.now();
    } catch {
      process.stderr.write(JSON.stringify({ level: 'error', event: 'worker_tick_failed' }) + '\n');
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, 2000);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

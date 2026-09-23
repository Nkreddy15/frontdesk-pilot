import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { withTenant, type Context, pool } from '../../../packages/core/src/db.js';
import { config } from '../../../packages/core/src/config.js';
import { DomainError } from '../../../packages/core/src/errors.js';
import { authenticate, owner, equals } from './auth.js';
import { uuid } from '../../../packages/core/src/contracts.js';
import { audit, hash } from '../../../packages/core/src/booking.js';
import { validateSignature } from '../../../packages/providers/src/twilio.js';
import { oauthStart, oauthCallback } from '../../../packages/providers/src/google.js';
import { ProviderError } from '../../../packages/providers/src/types.js';
export function signedTwilio(req: FastifyRequest) {
  if (
    !config.publicApiUrl ||
    !validateSignature(
      String(req.headers['x-twilio-signature'] || ''),
      config.publicApiUrl + req.raw.url,
      req.body as any,
    )
  )
    throw new DomainError('INVALID_WEBHOOK_SIGNATURE', 403);
}
export function webhookContext(req: FastifyRequest, tenant: string): Context {
  return { tenantId: uuid.parse(tenant), userId: 'webhook', role: 'WORKER', traceId: req.id };
}
export async function dedup(
  ctx: Context,
  provider: string,
  key: string,
  event: string,
  payload: unknown,
  fn: (tx: any) => Promise<void>,
) {
  return withTenant(ctx, async (tx) => {
    const r = await tx.query(
      'INSERT INTO webhook_inbox(tenant_id,provider,dedup_key,event_type,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',
      [ctx.tenantId, provider, key, event, payload],
    );
    if (!r.rowCount) return { duplicate: true };
    await fn(tx);
    await tx.query('UPDATE webhook_inbox SET processed_at=clock_timestamp() WHERE id=$1', [
      r.rows[0].id,
    ]);
    return { duplicate: false };
  });
}
export async function integrationRoutes(app: FastifyInstance) {
  app.post('/v1/integrations/google/exceptions/:id/reconcile', async (req) => {
    const ctx = await authenticate(req);
    owner(ctx);
    const id = uuid.parse((req.params as any).id),
      b = z
        .object({ action: z.enum(['RECHECK_GOOGLE', 'RESTORE_DATABASE_VERSION']) })
        .strict()
        .parse(req.body);
    return withTenant(ctx, async (tx) => {
      const x = (
        await tx.query(
          'SELECT x.*,p.appointment_id FROM sync_exceptions x LEFT JOIN calendar_projections p ON p.event_id=x.event_id WHERE x.id=$1 AND NOT x.resolved',
          [id],
        )
      ).rows[0];
      if (!x) throw new DomainError('EXCEPTION_NOT_FOUND', 404);
      if (b.action === 'RESTORE_DATABASE_VERSION' && !x.appointment_id)
        throw new DomainError('ONLY_APP_MANAGED_EVENTS_CAN_BE_RESTORED', 409);
      const job = (
        await tx.query(
          "INSERT INTO outbox_jobs(tenant_id,kind,entity_id,version,dedup_key,payload) VALUES($1,'calendar.reconcile',$2,0,$3,$4) ON CONFLICT(tenant_id,dedup_key) DO UPDATE SET status=CASE WHEN outbox_jobs.status IN ('BLOCKED','FAILED') THEN 'PENDING' ELSE outbox_jobs.status END,available_at=clock_timestamp() RETURNING id,status",
          [
            ctx.tenantId,
            x.appointment_id || ctx.tenantId,
            `reconcile:${id}:${b.action}`,
            { exceptionId: id, action: b.action },
          ],
        )
      ).rows[0];
      await audit(tx, ctx, 'calendar_exception', id, 'reconciliation_requested', b);
      return {
        job,
        notice:
          'Reconciliation queued. Bookings remain paused until conflicts are verified resolved and the owner resumes booking.',
      };
    });
  });
  app.post('/v1/integrations/google/start', async (req) => {
    const ctx = await authenticate(req);
    owner(ctx);
    try {
      return { url: await oauthStart(ctx) };
    } catch (e) {
      if (e instanceof ProviderError) throw new DomainError(e.code, 503);
      throw e;
    }
  });
  app.get('/integrations/google/callback', async (req, reply) => {
    const q = z
      .object({ code: z.string().min(1).max(2000), state: z.string().min(1).max(4000) })
      .parse(req.query);
    await oauthCallback(q.code, q.state);
    return reply.redirect(config.dashboardOrigin + '/?calendar=connected');
  });
  app.post('/webhooks/google/calendar', async (req, reply) => {
    const q = z.object({ tenant: uuid }).parse(req.query),
      ctx = webhookContext(req, q.tenant);
    const c = await withTenant(
      ctx,
      async (tx) =>
        (await tx.query('SELECT channel_id,channel_token,resource_id FROM calendar_connections'))
          .rows[0],
    );
    if (
      !c ||
      !equals(String(req.headers['x-goog-channel-token'] || ''), c.channel_token || '') ||
      req.headers['x-goog-channel-id'] !== c.channel_id ||
      req.headers['x-goog-resource-id'] !== c.resource_id
    )
      throw new DomainError('INVALID_WEBHOOK_SIGNATURE', 403);
    const number = z
      .string()
      .regex(/^\d{1,30}$/)
      .parse(req.headers['x-goog-message-number']);
    await dedup(ctx, 'google', c.channel_id + ':' + number, 'calendar.changed', {}, async (tx) => {
      await tx.query(
        "INSERT INTO outbox_jobs(tenant_id,kind,entity_id,version,dedup_key) VALUES($1,'calendar.pull',$1,0,$2) ON CONFLICT DO NOTHING",
        [ctx.tenantId, 'google:' + c.channel_id + ':' + number],
      );
    });
    return reply.code(204).send();
  });
  app.post('/webhooks/twilio/messages', async (req, reply) => {
    signedTwilio(req);
    const q = z.object({ tenant: uuid, job: uuid }).parse(req.query),
      b = z
        .object({
          MessageSid: z.string().regex(/^SM[a-fA-F0-9]{32}$/),
          MessageStatus: z.string().max(40),
          ErrorCode: z.string().max(20).optional(),
        })
        .passthrough()
        .parse(req.body),
      ctx = webhookContext(req, q.tenant);
    await dedup(
      ctx,
      'twilio',
      `${b.MessageSid}:${b.MessageStatus}:${b.ErrorCode || ''}`,
      'message.status',
      { job: q.job, status: b.MessageStatus },
      async (tx) => {
        const current = (
          await tx.query('SELECT delivery_status,provider_id FROM outbox_jobs WHERE id=$1', [q.job])
        ).rows[0];
        if (!current) throw new DomainError('JOB_NOT_FOUND', 404);
        if (current.provider_id && current.provider_id !== b.MessageSid)
          throw new DomainError('PROVIDER_ID_MISMATCH', 409);
        const rank: Record<string, number> = {
          accepted: 0,
          scheduled: 0,
          queued: 1,
          sending: 2,
          sent: 3,
          delivered: 4,
          undelivered: 4,
          failed: 4,
          read: 5,
        };
        if ((rank[b.MessageStatus] ?? -1) >= (rank[current.delivery_status] ?? -1))
          await tx.query(
            "UPDATE outbox_jobs SET provider_id=$2,delivery_status=$3,status=CASE WHEN $3 IN ('failed','undelivered') THEN 'FAILED' WHEN status='UNKNOWN' THEN 'SUCCEEDED' ELSE status END,last_error=CASE WHEN $4::text IS NOT NULL THEN 'TWILIO_DELIVERY_'||$4 ELSE last_error END WHERE id=$1",
            [q.job, b.MessageSid, b.MessageStatus, b.ErrorCode || null],
          );
      },
    );
    return reply.code(204).send();
  });
  app.post('/webhooks/twilio/inbound-sms', async (req, reply) => {
    signedTwilio(req);
    const b = z
      .object({
        MessageSid: z.string(),
        To: z.string(),
        From: z.string(),
        Body: z.string().max(1600),
        OptOutType: z.string().optional(),
      })
      .passthrough()
      .parse(req.body);
    const db = await pool.connect();
    let route;
    try {
      route = (await db.query('SELECT tenant_id FROM phone_routes WHERE phone=$1', [b.To])).rows[0];
    } finally {
      db.release();
    }
    if (!route) throw new DomainError('PHONE_NOT_CONFIGURED', 404);
    const ctx = webhookContext(req, route.tenant_id),
      stop =
        b.OptOutType === 'STOP' ||
        /^(stop|stopall|unsubscribe|cancel|end|quit)$/i.test(b.Body.trim());
    await dedup(ctx, 'twilio', b.MessageSid, 'sms.inbound', { optOut: stop }, async (tx) => {
      if (stop)
        await tx.query(
          "INSERT INTO sms_suppressions(tenant_id,phone,reason) VALUES($1,$2,'STOP') ON CONFLICT DO NOTHING",
          [ctx.tenantId, b.From],
        );
    });
    return reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  });
  app.get('/v1/customers/:id/export', async (req) => {
    const ctx = await authenticate(req);
    owner(ctx);
    const id = uuid.parse((req.params as any).id);
    return withTenant(ctx, async (tx) => {
      const customer = (await tx.query('SELECT * FROM customers WHERE id=$1', [id])).rows[0];
      if (!customer) throw new DomainError('NOT_FOUND', 404);
      const appointments = (
        await tx.query(
          'SELECT id,starts_at,ends_at,service_name,state,price_cents,notes FROM appointments WHERE customer_id=$1',
          [id],
        )
      ).rows;
      await audit(tx, ctx, 'customer', id, 'exported', {});
      return {
        exportedAt: new Date().toISOString(),
        customer,
        appointments,
        consents: (await tx.query('SELECT * FROM consents WHERE customer_id=$1', [id])).rows,
      };
    });
  });
  app.post('/v1/customers/:id/delete', async (req) => {
    const ctx = await authenticate(req);
    owner(ctx);
    const id = uuid.parse((req.params as any).id);
    z.object({ confirm: z.literal('DELETE_CUSTOMER_DATA') })
      .strict()
      .parse(req.body);
    return withTenant(ctx, async (tx) => {
      const c = (await tx.query('SELECT * FROM customers WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!c) throw new DomainError('NOT_FOUND', 404);
      if (
        (
          await tx.query(
            "SELECT 1 FROM appointments WHERE customer_id=$1 AND state IN ('HELD','CONFIRMED')",
            [id],
          )
        ).rowCount
      )
        throw new DomainError('RESOLVE_ACTIVE_APPOINTMENTS_FIRST', 409);
      const calls = (
        await tx.query(
          "SELECT id FROM calls WHERE caller_phone=$1 OR workflow->'draft'->>'phone'=$1",
          [c.phone],
        )
      ).rows.map((r) => r.id);
      await tx.query('DELETE FROM call_events WHERE call_id=ANY($1::uuid[])', [calls]);
      await tx.query('DELETE FROM tool_executions WHERE call_id=ANY($1::uuid[])', [calls]);
      await tx.query(
        "UPDATE calls SET caller_phone=NULL,workflow='{}',summary='Customer data deleted',transcript_purged_at=clock_timestamp() WHERE id=ANY($1::uuid[])",
        [calls],
      );
      await tx.query("UPDATE appointments SET notes='' WHERE customer_id=$1 AND notes<>''", [id]);
      await tx.query('DELETE FROM leads WHERE phone=$1', [c.phone]);
      await tx.query('DELETE FROM consents WHERE customer_id=$1', [id]);
      await tx.query(
        "UPDATE customers SET name='Deleted customer',phone='+10000000000',notes='',deleted_at=clock_timestamp() WHERE id=$1",
        [id],
      );
      // Confirmation responses can contain the customer name/number and must be purged too.
      await tx.query(
        'UPDATE idempotency_requests SET http_status=410,result=\'{"error":"PERSONAL_DATA_REDACTED","committed":false}\' WHERE result->\'appointment\'->>\'customer_id\'=$1 OR result::text LIKE $2',
        [id, '%' + c.phone + '%'],
      );
      await tx.query(
        "INSERT INTO sms_suppressions(tenant_id,phone,reason) VALUES($1,$2,'DELETION_REQUEST') ON CONFLICT DO NOTHING",
        [ctx.tenantId, c.phone],
      );
      await audit(tx, ctx, 'customer', id, 'personal_data_deleted', {
        backup_expiry_required: true,
      });
      return {
        ok: true,
        notice:
          'Customer profile, appointment notes, linked conversations, and cached receipts have been redacted. Booking metadata, a minimal opt-out suppression record, and audit history remain. External providers and backup expiration require the deletion runbook.',
      };
    });
  });
}

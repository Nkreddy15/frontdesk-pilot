import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config, validateConfig } from '../../../packages/core/src/config.js';
import { withTenant, usingWasm, type Context } from '../../../packages/core/src/db.js';
import { DomainError, databaseError } from '../../../packages/core/src/errors.js';
import {
  availability,
  createBooking,
  confirmHold,
  reschedule,
  changeState,
  createBlock,
  audit,
  mutation,
} from '../../../packages/core/src/booking.js';
import * as schema from '../../../packages/core/src/contracts.js';
import { authenticate, owner, writeAccess, signIn } from './auth.js';
import { conversationRoutes } from './conversation-routes.js';
import { integrationRoutes } from './integration-routes.js';
import { voiceRoutes } from './voice.js';
export async function buildApp(options: { logger?: boolean } = {}) {
  validateConfig();
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: 'info',
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
            ],
            serializers: {
              req: (r) => ({ method: r.method, url: r.url?.split('?')[0], id: r.id }),
              err: (e) => ({ type: e.name, code: e.code, message: 'Request failed', stack: '' }),
            },
          },
    genReqId: () => randomUUID(),
    bodyLimit: 32768,
    trustProxy: config.production ? (_address: string, hop: number) => hop < 1 : false,
  });
  await app.register(cookie);
  await app.register(cors, { origin: config.dashboardOrigin, credentials: true });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, {
    max: process.env.NODE_ENV === 'test' && process.env.TEST_CONCURRENCY === 'true' ? 20000 : 180,
    timeWindow: '1 minute',
  });
  await app.register(formbody);
  await app.register(websocket, { options: { maxPayload: 262144 } });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: 'INVALID_INPUT',
        fields: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        traceId: req.id,
      });
    try {
      const domain = databaseError(error);
      return reply
        .code(domain.status)
        .send({ error: domain.code, ...domain.details, traceId: req.id });
    } catch {}
    if ((error as any).statusCode === 429)
      return reply.code(429).send({ error: 'RATE_LIMITED', traceId: req.id });
    req.log.error({ code: (error as any).code, name: (error as any).name }, 'Request failed');
    return reply.code(500).send({ error: 'INTERNAL_ERROR', traceId: req.id });
  });
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Request-Id', req.id);
    reply.header('Cache-Control', 'no-store');
  });
  const key = (req: any) => schemaKey(req.headers['idempotency-key']);
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_, reply) => {
    try {
      const { pool } = await import('../../../packages/core/src/db.js');
      const tx = await pool.connect();
      try {
        await tx.query('SELECT 1');
      } finally {
        tx.release();
      }
      return { status: 'ok', database: usingWasm ? 'development-wasm' : 'postgresql' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) =>
      signIn(
        req,
        reply,
        z
          .object({
            accessCode: z.string().max(200).optional(),
            email: z.string().email().optional(),
            password: z.string().max(200).optional(),
          })
          .strict()
          .parse(req.body),
      ),
  );
  app.get('/auth/config', async () => ({
    development: config.devAuth,
    configured: config.devAuth || !!config.supabaseUrl,
  }));
  app.get('/auth/me', async (req) => {
    const ctx = await authenticate(req);
    return { role: ctx.role, csrf: ctx.csrf, userId: ctx.userId, development: config.devAuth };
  });
  app.post('/auth/logout', async (req, reply) => {
    await authenticate(req);
    reply.clearCookie('receptionist_session', { path: '/' });
    return { ok: true };
  });
  app.get('/v1/bootstrap', async (req) => {
    const ctx = await authenticate(req);
    return withTenant(ctx, async (tx) => {
      const tenant = (await tx.query('SELECT id,name FROM tenants')).rows[0],
        locations = (await tx.query('SELECT * FROM locations ORDER BY name')).rows;
      const services = (await tx.query('SELECT * FROM services ORDER BY duration_minutes')).rows,
        resources = (await tx.query('SELECT * FROM resources ORDER BY kind DESC,name')).rows;
      const settings = (await tx.query('SELECT * FROM business_settings')).rows[0];
      return {
        tenant,
        locations,
        services,
        resources,
        settings,
        role: ctx.role,
        databaseMode: usingWasm ? 'development-wasm' : 'postgresql',
        providerStatus: {
          voice: config.liveVoice && !!config.openaiKey && !!config.twilioSid,
          sms: config.sms && !!config.twilioSid,
          calendar: config.calendar && !!config.googleClientId,
        },
        version: '0.1.0',
      };
    });
  });
  app.get('/v1/availability', async (req) => ({
    slots: await availability(await authenticate(req), schema.availabilityInput.parse(req.query)),
  }));
  app.get('/v1/appointments', async (req) => {
    const ctx = await authenticate(req);
    const q = z.object({ from: schema.instant, to: schema.instant }).parse(req.query);
    if (new Date(q.to).getTime() - new Date(q.from).getTime() > 93 * 86400000)
      throw new DomainError('DATE_RANGE_TOO_LARGE', 400);
    return withTenant(ctx, async (tx) => ({
      appointments: (
        await tx.query(
          `SELECT a.id,a.state,a.version,a.location_id,a.service_id,a.staff_id,a.starts_at,a.ends_at,a.service_name,a.price_cents,a.notes,a.source,c.id AS customer_id,c.name AS customer_name,c.phone,r.name AS staff_name FROM appointments a JOIN customers c ON c.id=a.customer_id JOIN resources r ON r.id=a.staff_id WHERE a.starts_at >= $1 AND a.starts_at < $2 AND ($3::uuid IS NULL OR a.staff_id=$3) ORDER BY a.starts_at`,
          [q.from, q.to, ctx.role === 'STAFF' ? ctx.resourceId : null],
        )
      ).rows,
      blocks: (
        await tx.query(
          'SELECT b.*,r.name AS resource_name FROM resource_blocks b JOIN resources r ON b.resource_id=r.id WHERE b.active AND b.starts_at<$2 AND b.ends_at>$1 ORDER BY b.starts_at',
          [q.from, q.to],
        )
      ).rows,
    }));
  });
  const send = (reply: any, result: schema.Result) =>
    reply
      .code(result.status)
      .header('Idempotency-Replayed', String(!!result.replayed))
      .send(result.body);
  app.post('/v1/appointments', async (req, reply) => {
    const ctx = await authenticate(req);
    writeAccess(ctx);
    const body = schema.bookingInput.parse(req.body);
    staffScope(ctx, body.staffId);
    return send(reply, await createBooking(ctx, body, key(req)));
  });
  app.post('/v1/holds', async (req, reply) => {
    const ctx = await authenticate(req);
    writeAccess(ctx);
    const body = schema.bookingInput.parse(req.body);
    staffScope(ctx, body.staffId);
    return send(reply, await createBooking(ctx, body, key(req), true));
  });
  app.post('/v1/holds/:id/confirm', async (req, reply) => {
    const ctx = await authenticate(req);
    owner(ctx);
    const id = idParam(req);
    return send(reply, await confirmHold(ctx, id, schema.confirmInput.parse(req.body), key(req)));
  });
  app.patch('/v1/appointments/:id', async (req, reply) => {
    const ctx = await authenticate(req);
    owner(ctx);
    return send(
      reply,
      await reschedule(ctx, idParam(req), schema.rescheduleInput.parse(req.body), key(req)),
    );
  });
  app.post('/v1/appointments/:id/state', async (req, reply) => {
    const ctx = await authenticate(req);
    owner(ctx);
    return send(
      reply,
      await changeState(ctx, idParam(req), schema.stateInput.parse(req.body), key(req)),
    );
  });
  app.post('/v1/blocks', async (req, reply) => {
    const ctx = await authenticate(req);
    owner(ctx);
    return send(reply, await createBlock(ctx, schema.blockInput.parse(req.body), key(req)));
  });
  app.delete('/v1/blocks/:id', async (req, reply) => {
    const ctx = await authenticate(req);
    owner(ctx);
    const id = idParam(req),
      b = z.object({ locationId: schema.uuid }).parse(req.body);
    return send(
      reply,
      await mutation(ctx, b.locationId, `unblock:${id}`, key(req), b, async (tx) => {
        const result = await tx.query(
          'UPDATE resource_blocks SET active=false WHERE id=$1 AND location_id=$2 RETURNING id',
          [id, b.locationId],
        );
        if (!result.rowCount) throw new DomainError('NOT_FOUND', 404);
        return { status: 200, body: { ok: true } };
      }),
    );
  });
  app.get('/v1/customers', async (req) => {
    const ctx = await authenticate(req);
    owner(ctx);
    const q = z.object({ search: z.string().max(120).default('') }).parse(req.query);
    return withTenant(ctx, async (tx) => ({
      customers: (
        await tx.query(
          `SELECT c.*,count(a.id)::int AS appointments,max(a.starts_at) AS last_appointment FROM customers c LEFT JOIN appointments a ON a.customer_id=c.id WHERE c.deleted_at IS NULL AND (c.name ILIKE $1 OR c.phone ILIKE $1) GROUP BY c.id ORDER BY c.created_at DESC LIMIT 200`,
          ['%' + q.search.replace(/[%_]/g, '') + '%'],
        )
      ).rows,
    }));
  });
  app.get('/v1/customers/:id', async (req) => {
    const ctx = await authenticate(req);
    owner(ctx);
    return withTenant(ctx, async (tx) => ({
      customer: (await tx.query('SELECT * FROM customers WHERE id=$1', [idParam(req)])).rows[0],
      appointments: (
        await tx.query(
          'SELECT id,starts_at,service_name,state,price_cents FROM appointments WHERE customer_id=$1 ORDER BY starts_at DESC',
          [idParam(req)],
        )
      ).rows,
      consents: (
        await tx.query('SELECT * FROM consents WHERE customer_id=$1 ORDER BY created_at DESC', [
          idParam(req),
        ])
      ).rows,
    }));
  });
  app.post('/v1/customers/:id/consent', async (req) => {
    const ctx = await authenticate(req);
    owner(ctx);
    const id = idParam(req),
      b = z
        .object({
          granted: z.boolean(),
          method: z.enum(['WEB_FORM', 'WRITTEN_IMPORT', 'REVOKED']),
          noticeVersion: z.string().min(1).max(50),
          evidence: z.string().min(10).max(500),
        })
        .strict()
        .parse(req.body);
    return withTenant(ctx, async (tx) => {
      await tx.query(
        "INSERT INTO consents(tenant_id,customer_id,purpose,granted,method,notice_version,evidence) VALUES($1,$2,'SMS_APPOINTMENT',$3,$4,$5,$6)",
        [ctx.tenantId, id, b.granted, b.method, b.noticeVersion, b.evidence],
      );
      await audit(tx, ctx, 'customer', id, 'sms_consent', { granted: b.granted, method: b.method });
      return { ok: true };
    });
  });
  app.get('/v1/calls', async (req) => {
    const ctx = await authenticate(req);
    owner(ctx);
    return withTenant(ctx, async (tx) => ({
      calls: (
        await tx.query(
          'SELECT id,mode,caller_phone,state,outcome,summary,follow_up,started_at,ended_at,duration_seconds,estimated_cost_cents FROM calls ORDER BY started_at DESC LIMIT 100',
        )
      ).rows,
    }));
  });
  app.get('/v1/calls/:id', async (req) => {
    const ctx = await authenticate(req);
    owner(ctx);
    return withTenant(ctx, async (tx) => ({
      call: (
        await tx.query(
          'SELECT id,mode,outcome,summary,follow_up,started_at,ended_at,duration_seconds,transcription_consented FROM calls WHERE id=$1',
          [idParam(req)],
        )
      ).rows[0],
      events: (
        await tx.query(
          'SELECT id,kind,content,created_at FROM call_events WHERE call_id=$1 ORDER BY id',
          [idParam(req)],
        )
      ).rows,
      tools: (
        await tx.query(
          'SELECT action_id,tool,result,duration_ms,created_at FROM tool_executions WHERE call_id=$1 ORDER BY created_at',
          [idParam(req)],
        )
      ).rows,
    }));
  });
  app.get('/v1/leads', async (req) => {
    const ctx = await authenticate(req);
    owner(ctx);
    return withTenant(ctx, async (tx) => ({
      leads: (await tx.query('SELECT * FROM leads ORDER BY created_at DESC LIMIT 200')).rows,
    }));
  });
  app.patch('/v1/leads/:id', async (req) => {
    const ctx = await authenticate(req);
    owner(ctx);
    const b = z
      .object({ status: z.enum(['OPEN', 'CONTACTED', 'CONVERTED', 'CLOSED']) })
      .strict()
      .parse(req.body);
    return withTenant(ctx, async (tx) => {
      const row = await tx.query(
        'UPDATE leads SET status=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING id',
        [idParam(req), b.status],
      );
      if (!row.rowCount) throw new DomainError('NOT_FOUND', 404);
      await audit(tx, ctx, 'lead', idParam(req), 'lead_status', b);
      return { ok: true };
    });
  });
  app.get('/v1/operations', async (req) => {
    const ctx = await authenticate(req);
    owner(ctx);
    return withTenant(ctx, async (tx) => ({
      jobs: (
        await tx.query(
          'SELECT id,kind,entity_id,status,attempts,last_error,provider_id,delivery_status,available_at,created_at FROM outbox_jobs ORDER BY created_at DESC LIMIT 100',
        )
      ).rows,
      calendar:
        (
          await tx.query(
            'SELECT calendar_id,status,last_synced_at,last_error FROM calendar_connections',
          )
        ).rows[0] || null,
      exceptions: (
        await tx.query(
          'SELECT * FROM sync_exceptions WHERE NOT resolved ORDER BY created_at DESC LIMIT 100',
        )
      ).rows,
      audit: (await tx.query('SELECT * FROM audit_events ORDER BY id DESC LIMIT 100')).rows,
    }));
  });
  app.post('/v1/jobs/:id/retry', async (req) => {
    const ctx = await authenticate(req);
    owner(ctx);
    return withTenant(ctx, async (tx) => {
      const row = await tx.query(
        "UPDATE outbox_jobs SET status='PENDING',available_at=clock_timestamp(),last_error=NULL WHERE id=$1 AND status IN ('FAILED','BLOCKED') RETURNING id",
        [idParam(req)],
      );
      if (!row.rowCount) throw new DomainError('JOB_NOT_RETRYABLE', 409);
      await audit(tx, ctx, 'job', idParam(req), 'retry_requested', {});
      return { ok: true };
    });
  });
  app.get('/v1/metrics', async (req) => {
    const ctx = await authenticate(req);
    owner(ctx);
    return withTenant(ctx, async (tx) => ({
      ...(
        await tx.query(
          `SELECT count(*)::int AS calls,count(*) FILTER(WHERE mode='TELEPHONE')::int AS telephone_calls,count(*) FILTER(WHERE mode='TELEPHONE' AND (duration_seconds>0 OR transcription_consented))::int AS answered_calls,count(*) FILTER(WHERE mode='TELEPHONE' AND outcome='BOOKED')::int AS telephone_bookings,count(*) FILTER(WHERE outcome='BOOKED')::int AS call_bookings,count(*) FILTER(WHERE outcome='TRANSFERRED')::int AS transfers,coalesce(avg(duration_seconds) FILTER(WHERE mode='TELEPHONE'),0)::float AS average_duration,coalesce(sum(estimated_cost_cents),0)::float AS cost_cents FROM calls WHERE started_at>now()-interval '30 days'`,
        )
      ).rows[0],
      ...(
        await tx.query(
          "SELECT count(*) FILTER(WHERE state='CONFIRMED')::int AS bookings,count(*) FILTER(WHERE state='CONFIRMED' AND starts_at::date=current_date)::int AS today_bookings FROM appointments",
        )
      ).rows[0],
      ...(
        await tx.query(
          "SELECT count(*) FILTER(WHERE status='OPEN')::int AS open_leads,count(*) FILTER(WHERE status='CLOSED')::int AS lost_leads FROM leads",
        )
      ).rows[0],
      ...(
        await tx.query(
          "SELECT count(*) FILTER(WHERE status IN ('FAILED','UNKNOWN'))::int AS failures FROM outbox_jobs",
        )
      ).rows[0],
      ...(
        await tx.query(
          "SELECT count(*)::int AS conflicts FROM idempotency_requests WHERE result->>'error'='SLOT_CONFLICT'",
        )
      ).rows[0],
    }));
  });
  await settingsRoutes(app);
  await conversationRoutes(app);
  await integrationRoutes(app);
  await voiceRoutes(app);
  return app;
}
function schemaKey(value: unknown) {
  return z
    .string()
    .regex(/^[A-Za-z0-9:_-]{8,120}$/)
    .parse(value);
}
function idParam(req: any) {
  return schema.uuid.parse(req.params.id);
}
function staffScope(ctx: Context, staffId: string) {
  if (ctx.role === 'STAFF' && ctx.resourceId !== staffId)
    throw new DomainError('STAFF_SCOPE_REQUIRED', 403);
}
const hours = z.record(
  z.string().regex(/^[1-7]$/),
  z
    .tuple([
      z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    ])
    .refine((x) => x[0] < x[1], 'Closing time must be after opening.'),
);
async function settingsRoutes(app: FastifyInstance) {
  app.get('/v1/knowledge', async (req) => {
    const ctx = await authenticate(req);
    owner(ctx);
    return withTenant(ctx, async (tx) => ({
      items: (await tx.query('SELECT * FROM knowledge ORDER BY topic')).rows,
    }));
  });
  app.put('/v1/knowledge/:id', async (req) => {
    const ctx = await authenticate(req);
    owner(ctx);
    const id = idParam(req),
      b = z
        .object({
          topic: z.string().min(1).max(80),
          question: z.string().min(1).max(300),
          answer: z.string().min(1).max(2000),
          published: z.boolean(),
        })
        .strict()
        .parse(req.body);
    return withTenant(ctx, async (tx) => {
      await tx.query(
        'INSERT INTO knowledge(id,tenant_id,topic,question,answer,published) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,id) DO UPDATE SET topic=$3,question=$4,answer=$5,published=$6,version=knowledge.version+1,updated_at=clock_timestamp()',
        [id, ctx.tenantId, b.topic, b.question, b.answer, b.published],
      );
      await audit(tx, ctx, 'knowledge', id, 'knowledge_updated', {
        topic: b.topic,
        published: b.published,
      });
      return { ok: true };
    });
  });
  app.patch('/v1/settings', async (req) => {
    const ctx = await authenticate(req);
    owner(ctx);
    const b = z
      .object({
        greeting: z
          .string()
          .min(10)
          .max(500)
          .refine((s) => /AI receptionist/i.test(s), 'Greeting must disclose AI receptionist.'),
        transfer_enabled: z.boolean(),
        transfer_number: z.union([schema.phone, z.literal('')]),
        booking_paused: z.boolean(),
        transcript_retention_days: z.number().int().min(1).max(90),
        lead_retention_days: z.number().int().min(1).max(365),
      })
      .strict()
      .parse(req.body);
    return withTenant(ctx, async (tx) => {
      await tx.query('SELECT tenant_id FROM business_settings FOR UPDATE');
      if (
        !b.booking_paused &&
        (await tx.query('SELECT 1 FROM sync_exceptions WHERE NOT resolved LIMIT 1')).rowCount
      )
        throw new DomainError('UNRESOLVED_CALENDAR_CONFLICT', 409);
      await tx.query(
        'UPDATE business_settings SET greeting=$1,transfer_enabled=$2,transfer_number=$3,booking_paused=$4,transcript_retention_days=$5,lead_retention_days=$6,updated_at=clock_timestamp()',
        [
          b.greeting,
          b.transfer_enabled,
          b.transfer_number,
          b.booking_paused,
          b.transcript_retention_days,
          b.lead_retention_days,
        ],
      );
      await audit(tx, ctx, 'settings', ctx.tenantId, 'settings_updated', {
        booking_paused: b.booking_paused,
        transfer_enabled: b.transfer_enabled,
      });
      return { ok: true };
    });
  });
  app.patch('/v1/locations/:id', async (req, reply) => {
    const ctx = await authenticate(req);
    owner(ctx);
    const id = idParam(req),
      b = z
        .object({
          name: z.string().min(1).max(100),
          address: z.string().max(500),
          hours,
          booking_enabled: z.boolean(),
        })
        .strict()
        .parse(req.body);
    return reply.send(
      (
        await mutation(
          ctx,
          id,
          'location',
          schemaKey(req.headers['idempotency-key']),
          b,
          async (tx) => {
            await tx.query(
              'UPDATE locations SET name=$2,address=$3,hours=$4,booking_enabled=$5 WHERE id=$1',
              [id, b.name, b.address, b.hours, b.booking_enabled],
            );
            await audit(tx, ctx, 'location', id, 'hours_changed', b);
            return {
              status: 200,
              body: {
                ok: true,
                notice:
                  'Existing appointments are retained. Review the schedule before changing hours.',
              },
            };
          },
        )
      ).body,
    );
  });
  app.patch('/v1/services/:id', async (req, reply) => {
    const ctx = await authenticate(req);
    owner(ctx);
    const id = idParam(req),
      b = z
        .object({
          locationId: schema.uuid,
          name: z.string().min(1).max(100),
          description: z.string().max(1000),
          duration_minutes: z.number().int().min(5).max(480),
          buffer_before: z.number().int().min(0).max(120),
          buffer_after: z.number().int().min(0).max(120),
          price_cents: z.number().int().min(0).max(10000000),
          active: z.boolean(),
        })
        .strict()
        .parse(req.body);
    const result = await mutation(
      ctx,
      b.locationId,
      `service:${id}`,
      schemaKey(req.headers['idempotency-key']),
      b,
      async (tx) => {
        const row = await tx.query(
          'UPDATE services SET name=$2,description=$3,duration_minutes=$4,buffer_before=$5,buffer_after=$6,price_cents=$7,active=$8,version=version+1 WHERE id=$1 AND location_id=$9 RETURNING id',
          [
            id,
            b.name,
            b.description,
            b.duration_minutes,
            b.buffer_before,
            b.buffer_after,
            b.price_cents,
            b.active,
            b.locationId,
          ],
        );
        if (!row.rowCount) throw new DomainError('NOT_FOUND', 404);
        await audit(tx, ctx, 'service', id, 'service_changed', b);
        return { status: 200, body: { ok: true } };
      },
    );
    return reply.code(result.status).send(result.body);
  });
  app.patch('/v1/resources/:id', async (req, reply) => {
    const ctx = await authenticate(req);
    owner(ctx);
    const id = idParam(req),
      b = z
        .object({
          locationId: schema.uuid,
          name: z.string().min(1).max(100),
          hours: hours.nullable(),
          active: z.boolean(),
        })
        .strict()
        .parse(req.body);
    const r = await mutation(
      ctx,
      b.locationId,
      `resource:${id}`,
      schemaKey(req.headers['idempotency-key']),
      b,
      async (tx) => {
        await tx.query(
          'UPDATE resources SET name=$2,hours=$3,active=$4 WHERE id=$1 AND location_id=$5',
          [id, b.name, b.hours, b.active, b.locationId],
        );
        await audit(tx, ctx, 'resource', id, 'schedule_changed', b);
        return { status: 200, body: { ok: true } };
      },
    );
    return reply.code(r.status).send(r.body);
  });
}

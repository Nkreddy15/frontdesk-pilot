import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../../core/src/config.js';
import { withTenant, schedulingLock, type Context } from '../../core/src/db.js';
import { hash } from '../../core/src/booking.js';
import { encrypt, decrypt } from './crypto.js';
import { ProviderError } from './types.js';
const base = 'https://www.googleapis.com/calendar/v3';
export const googleScope = 'https://www.googleapis.com/auth/calendar.app.created';
const secret = new TextEncoder().encode(config.sessionSecret);
export async function oauthStart(ctx: Context) {
  if (!config.googleClientId || !config.googleSecret || !config.googleRedirect)
    throw new ProviderError('GOOGLE_OAUTH_NOT_CONFIGURED', 'BLOCKED');
  const nonce = randomBytes(32).toString('hex');
  await withTenant(ctx, (tx) =>
    tx.query(
      "INSERT INTO oauth_states(tenant_id,token_hash,user_id,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '10 minutes')",
      [ctx.tenantId, hash(nonce), ctx.userId],
    ),
  );
  const state = await new SignJWT({ tenantId: ctx.tenantId, nonce })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(ctx.userId)
    .setIssuer('receptionist')
    .setAudience('google-oauth')
    .setExpirationTime('10m')
    .sign(secret);
  return (
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: config.googleRedirect,
      response_type: 'code',
      scope: googleScope,
      access_type: 'offline',
      prompt: 'consent',
      state,
    }).toString()
  );
}
export async function oauthCallback(code: string, state: string) {
  const { payload } = await jwtVerify(state, secret, {
    issuer: 'receptionist',
    audience: 'google-oauth',
    algorithms: ['HS256'],
  });
  const ctx: Context = {
    tenantId: String(payload.tenantId),
    userId: payload.sub!,
    role: 'OWNER',
    traceId: randomUUID(),
  };
  const location = await withTenant(ctx, async (tx) => {
    const member = (
      await tx.query("SELECT 1 FROM memberships WHERE user_id=$1 AND role='OWNER'", [ctx.userId])
    ).rowCount;
    if (!member) throw new Error('OWNER_REQUIRED');
    if (
      !(
        await tx.query(
          'UPDATE oauth_states SET used_at=clock_timestamp() WHERE token_hash=$1 AND user_id=$2 AND used_at IS NULL AND expires_at>clock_timestamp() RETURNING token_hash',
          [hash(String(payload.nonce)), ctx.userId],
        )
      ).rowCount
    )
      throw new Error('OAUTH_STATE_INVALID');
    return (await tx.query('SELECT * FROM locations ORDER BY id LIMIT 1')).rows[0];
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleSecret,
      code,
      redirect_uri: config.googleRedirect,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new ProviderError('GOOGLE_TOKEN_EXCHANGE_FAILED', 'FAILED');
  const tokens = (await response.json()) as any;
  tokens.expires_at = Date.now() + tokens.expires_in * 1000;
  if (!tokens.refresh_token) throw new ProviderError('GOOGLE_REFRESH_TOKEN_REQUIRED', 'FAILED');
  const existing = await withTenant(
    ctx,
    async (tx) => (await tx.query('SELECT calendar_id FROM calendar_connections')).rows[0],
  );
  let calendarId = existing?.calendar_id;
  if (!calendarId) {
    const res = await fetch(base + '/calendars', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        summary: 'Frontdesk appointments — ' + location.name,
        timeZone: location.timezone,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new ProviderError('CALENDAR_CREATION_FAILED', 'FAILED');
    calendarId = ((await res.json()) as any).id;
  }
  await withTenant(ctx, (tx) =>
    tx.query(
      "INSERT INTO calendar_connections(tenant_id,location_id,calendar_id,encrypted_tokens,status) VALUES($1,$2,$3,$4,'CONNECTED') ON CONFLICT(tenant_id) DO UPDATE SET encrypted_tokens=$4,status='CONNECTED',last_error=NULL",
      [ctx.tenantId, location.id, calendarId, encrypt(tokens)],
    ),
  );
  await renewWatch(ctx);
  return ctx;
}
async function connection(ctx: Context) {
  const c = await withTenant(
    ctx,
    async (tx) => (await tx.query('SELECT * FROM calendar_connections')).rows[0],
  );
  if (!c) throw new ProviderError('CALENDAR_NOT_CONNECTED', 'BLOCKED');
  let tokens = decrypt(c.encrypted_tokens);
  if (!tokens.access_token || tokens.expires_at < Date.now() + 60000) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.googleClientId,
        client_secret: config.googleSecret,
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new ProviderError('GOOGLE_REAUTH_REQUIRED', 'BLOCKED');
    const next = (await res.json()) as any;
    tokens = { ...tokens, ...next, expires_at: Date.now() + next.expires_in * 1000 };
    await withTenant(ctx, (tx) =>
      tx.query('UPDATE calendar_connections SET encrypted_tokens=$1', [encrypt(tokens)]),
    );
  }
  return { ...c, accessToken: tokens.access_token };
}
async function google(ctx: Context, path: string, method = 'GET', body?: unknown) {
  const c = await connection(ctx);
  const response = await fetch(
    base + path.replace('{calendar}', encodeURIComponent(c.calendar_id)),
    {
      method,
      headers: { Authorization: `Bearer ${c.accessToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    },
  );
  return response;
}
function expected(a: any) {
  return {
    summary: 'Booked: ' + a.service_name,
    description: 'Managed by Frontdesk. Change this appointment in the owner dashboard.',
    start: { dateTime: new Date(a.starts_at).toISOString(), timeZone: a.timezone },
    end: { dateTime: new Date(a.ends_at).toISOString(), timeZone: a.timezone },
    extendedProperties: {
      private: { appointmentId: a.id, version: String(a.version), source: 'frontdesk' },
    },
  };
}
export async function calendarWrite(ctx: Context, job: any) {
  if (!config.calendar) throw new ProviderError('CALENDAR_DISABLED', 'BLOCKED');
  const { a, p } = await withTenant(ctx, async (tx) => {
    const a = (
      await tx.query(
        'SELECT a.*,l.timezone FROM appointments a JOIN locations l ON l.id=a.location_id WHERE a.id=$1',
        [job.entity_id],
      )
    ).rows[0];
    if (!a) throw new ProviderError('APPOINTMENT_MISSING', 'SUPERSEDED');
    if (a.version !== job.version)
      throw new ProviderError('OUTDATED_APPOINTMENT_VERSION', 'SUPERSEDED');
    await tx.query(
      'INSERT INTO calendar_projections(tenant_id,appointment_id,event_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [ctx.tenantId, a.id, 'a' + a.id.replaceAll('-', '') + 'g0'],
    );
    return {
      a,
      p: (await tx.query('SELECT * FROM calendar_projections WHERE appointment_id=$1', [a.id]))
        .rows[0],
    };
  });
  let result;
  try {
    if (a.state === 'CANCELLED') {
      result = await google(ctx, `/calendars/{calendar}/events/${p.event_id}`, 'DELETE');
      if (!result.ok && ![404, 410].includes(result.status))
        throw new ProviderError(
          'GOOGLE_WRITE_' + result.status,
          result.status === 429 || result.status >= 500 ? 'RETRY' : 'FAILED',
        );
    } else if (a.state === 'CONFIRMED') {
      result = await google(ctx, `/calendars/{calendar}/events/${p.event_id}`, 'PUT', expected(a));
      if ([404, 410].includes(result.status)) {
        if (result.status === 410) {
          const generation = p.generation + 1;
          p.event_id = 'a' + a.id.replaceAll('-', '') + 'g' + generation;
          await withTenant(ctx, (tx) =>
            tx.query(
              'UPDATE calendar_projections SET event_id=$2,generation=$3 WHERE appointment_id=$1',
              [a.id, p.event_id, generation],
            ),
          );
        }
        result = await google(ctx, '/calendars/{calendar}/events', 'POST', {
          id: p.event_id,
          ...expected(a),
        });
        if (result.status === 409)
          result = await google(
            ctx,
            `/calendars/{calendar}/events/${p.event_id}`,
            'PUT',
            expected(a),
          );
      }
      if (!result.ok)
        throw new ProviderError(
          'GOOGLE_WRITE_' + result.status,
          result.status === 429 || result.status >= 500 ? 'RETRY' : 'FAILED',
        );
    } else throw new ProviderError('APPOINTMENT_NOT_SYNCABLE', 'SUPERSEDED');
    await withTenant(ctx, async (tx) => {
      await tx.query('UPDATE calendar_projections SET applied_version=$2 WHERE appointment_id=$1', [
        a.id,
        a.version,
      ]);
      await tx.query("UPDATE calendar_connections SET status='CONNECTED',last_error=NULL");
    });
    return { providerId: p.event_id };
  } catch (e) {
    await withTenant(ctx, (tx) =>
      tx.query(
        "UPDATE calendar_connections SET status='DEGRADED',last_error='Calendar write failed; booking remains valid'",
      ),
    );
    throw e instanceof ProviderError ? e : new ProviderError('GOOGLE_WRITE_RETRY', 'RETRY');
  }
}
export async function renewWatch(ctx: Context) {
  if (!config.publicApiUrl.startsWith('https://'))
    throw new ProviderError('PUBLIC_HTTPS_URL_REQUIRED', 'BLOCKED');
  const id = randomUUID(),
    token = randomBytes(32).toString('hex');
  const res = await google(ctx, '/calendars/{calendar}/events/watch', 'POST', {
    id,
    type: 'web_hook',
    address: `${config.publicApiUrl}/webhooks/google/calendar?tenant=${ctx.tenantId}`,
    token,
    params: { ttl: '604800' },
  });
  if (!res.ok) throw new ProviderError('GOOGLE_WATCH_FAILED', 'RETRY');
  const body = (await res.json()) as any;
  await withTenant(ctx, (tx) =>
    tx.query(
      'UPDATE calendar_connections SET channel_id=$1,channel_token=$2,resource_id=$3,channel_expires_at=$4',
      [id, token, body.resourceId, new Date(Number(body.expiration)).toISOString()],
    ),
  );
}
export async function recordExternalEvent(ctx: Context, locationId: string, event: any) {
  return withTenant(ctx, async (tx) => {
    await schedulingLock(tx, locationId);
    const projection = (
      await tx.query(
        'SELECT p.*,a.starts_at,a.ends_at,a.state FROM calendar_projections p JOIN appointments a ON a.id=p.appointment_id WHERE p.event_id=$1',
        [event.id],
      )
    ).rows[0];
    if (projection) {
      const changed =
        event.status === 'cancelled'
          ? projection.state !== 'CANCELLED'
          : new Date(event.start?.dateTime).getTime() !==
              new Date(projection.starts_at).getTime() ||
            new Date(event.end?.dateTime).getTime() !== new Date(projection.ends_at).getTime();
      if (changed) {
        await tx.query(
          "INSERT INTO sync_exceptions(tenant_id,event_id,reason) SELECT $1,$2,'App-managed event changed or deleted in Google Calendar' WHERE NOT EXISTS(SELECT 1 FROM sync_exceptions WHERE event_id=$2 AND NOT resolved)",
          [ctx.tenantId, event.id],
        );
        await tx.query('UPDATE business_settings SET booking_paused=true');
      } else
        await tx.query(
          'UPDATE sync_exceptions SET resolved=true,resolved_at=clock_timestamp() WHERE event_id=$1 AND NOT resolved',
          [event.id],
        );
      return;
    }
    await tx.query(
      'INSERT INTO external_events(tenant_id,event_id,payload) VALUES($1,$2,$3) ON CONFLICT(tenant_id,event_id) DO UPDATE SET payload=$3,observed_at=clock_timestamp()',
      [
        ctx.tenantId,
        event.id,
        { id: event.id, status: event.status, start: event.start, end: event.end },
      ],
    );
    if (event.status === 'cancelled' || event.transparency === 'transparent') {
      await tx.query(
        "UPDATE resource_blocks SET active=false WHERE source='GOOGLE' AND external_key LIKE $1",
        [event.id + ':%'],
      );
      await tx.query(
        'UPDATE sync_exceptions SET resolved=true,resolved_at=clock_timestamp() WHERE event_id=$1 AND NOT resolved',
        [event.id],
      );
      return;
    }
    const location = (await tx.query('SELECT timezone FROM locations WHERE id=$1', [locationId]))
      .rows[0];
    const { DateTime } = await import('luxon');
    const start =
        event.start?.dateTime ||
        DateTime.fromISO(event.start?.date, { zone: location.timezone }).toISO(),
      end =
        event.end?.dateTime ||
        DateTime.fromISO(event.end?.date, { zone: location.timezone }).toISO();
    if (
      !start ||
      !end ||
      !Number.isFinite(Date.parse(start)) ||
      Date.parse(end) <= Date.parse(start)
    )
      throw new ProviderError('INVALID_EXTERNAL_EVENT', 'FAILED');
    const resources = (
      await tx.query('SELECT id FROM resources WHERE location_id=$1 AND active', [locationId])
    ).rows;
    await tx.query('SAVEPOINT external_blocks');
    try {
      for (const r of resources)
        await tx.query(
          "INSERT INTO resource_blocks(tenant_id,location_id,resource_id,starts_at,ends_at,reason,source,external_key) VALUES($1,$2,$3,$4,$5,'External Google Calendar event','GOOGLE',$6) ON CONFLICT(tenant_id,external_key) DO UPDATE SET starts_at=$4,ends_at=$5,active=true",
          [ctx.tenantId, locationId, r.id, start, end, event.id + ':' + r.id],
        );
      await tx.query('RELEASE SAVEPOINT external_blocks');
      await tx.query(
        'UPDATE sync_exceptions SET resolved=true,resolved_at=clock_timestamp() WHERE event_id=$1 AND NOT resolved',
        [event.id],
      );
    } catch (e: any) {
      await tx.query('ROLLBACK TO SAVEPOINT external_blocks');
      if (e.code !== '23P01') throw e;
      await tx.query(
        "INSERT INTO sync_exceptions(tenant_id,event_id,reason) SELECT $1,$2,'External event overlaps a central booking; resolve in the dashboard' WHERE NOT EXISTS(SELECT 1 FROM sync_exceptions WHERE event_id=$2 AND NOT resolved)",
        [ctx.tenantId, event.id],
      );
      await tx.query('UPDATE business_settings SET booking_paused=true');
    }
  });
}
// A click only queues reconciliation. Resolution requires a fresh provider observation.
export async function reconcileException(ctx: Context, job: any) {
  if (!config.calendar) throw new ProviderError('CALENDAR_DISABLED', 'BLOCKED');
  const x = await withTenant(
    ctx,
    async (tx) =>
      (
        await tx.query(
          'SELECT x.*,p.appointment_id FROM sync_exceptions x LEFT JOIN calendar_projections p ON p.event_id=x.event_id WHERE x.id=$1',
          [job.payload.exceptionId],
        )
      ).rows[0],
  );
  if (!x || x.resolved) return {};
  if (job.payload.action === 'RESTORE_DATABASE_VERSION') {
    if (!x.appointment_id)
      throw new ProviderError('ONLY_APP_MANAGED_EVENTS_CAN_BE_RESTORED', 'FAILED');
    const a = await withTenant(
      ctx,
      async (tx) =>
        (await tx.query('SELECT version FROM appointments WHERE id=$1', [x.appointment_id]))
          .rows[0],
    );
    await calendarWrite(ctx, { entity_id: x.appointment_id, version: a.version });
    // A deleted Google event can require a new event ID. Verify that replacement too.
    const p = await withTenant(
      ctx,
      async (tx) =>
        (
          await tx.query('SELECT event_id FROM calendar_projections WHERE appointment_id=$1', [
            x.appointment_id,
          ])
        ).rows[0],
    );
    const res = await google(ctx, `/calendars/{calendar}/events/${encodeURIComponent(p.event_id)}`);
    if (!res.ok && ![404, 410].includes(res.status))
      throw new ProviderError('GOOGLE_RECONCILE_' + res.status, 'RETRY');
    const c = await connection(ctx);
    await recordExternalEvent(
      ctx,
      c.location_id,
      res.ok ? await res.json() : { id: p.event_id, status: 'cancelled' },
    );
    if (p.event_id !== x.event_id)
      await withTenant(ctx, async (tx) => {
        if (
          !(
            await tx.query('SELECT 1 FROM sync_exceptions WHERE event_id=$1 AND NOT resolved', [
              p.event_id,
            ])
          ).rowCount
        )
          await tx.query(
            'UPDATE sync_exceptions SET resolved=true,resolved_at=clock_timestamp() WHERE id=$1',
            [x.id],
          );
      });
  } else {
    const res = await google(ctx, `/calendars/{calendar}/events/${encodeURIComponent(x.event_id)}`);
    if (!res.ok && ![404, 410].includes(res.status))
      throw new ProviderError('GOOGLE_RECONCILE_' + res.status, 'RETRY');
    const c = await connection(ctx);
    await recordExternalEvent(
      ctx,
      c.location_id,
      res.ok ? await res.json() : { id: x.event_id, status: 'cancelled' },
    );
  }
  if (
    await withTenant(
      ctx,
      async (tx) =>
        (await tx.query('SELECT 1 FROM sync_exceptions WHERE id=$1 AND NOT resolved', [x.id]))
          .rowCount,
    )
  )
    throw new ProviderError('CALENDAR_CONFLICT_REMAINS', 'BLOCKED');
  return {};
}
export async function pullCalendar(ctx: Context) {
  if (!config.calendar) throw new ProviderError('CALENDAR_DISABLED', 'BLOCKED');
  const c = await connection(ctx);
  let syncToken = c.sync_token,
    pageToken: string | undefined,
    restarted = false;
  const seen: string[] = [];
  while (true) {
    const query = new URLSearchParams({
      singleEvents: 'true',
      showDeleted: 'true',
      maxResults: '2500',
    });
    if (syncToken) query.set('syncToken', syncToken);
    if (pageToken) query.set('pageToken', pageToken);
    const response = await google(ctx, '/calendars/{calendar}/events?' + query);
    if (response.status === 410 && !restarted) {
      syncToken = undefined;
      pageToken = undefined;
      restarted = true;
      continue;
    }
    if (!response.ok) throw new ProviderError('GOOGLE_PULL_' + response.status, 'RETRY');
    const body = (await response.json()) as any;
    for (const event of body.items || []) {
      await recordExternalEvent(ctx, c.location_id, event);
      seen.push(event.id);
    }
    pageToken = body.nextPageToken;
    if (!pageToken) {
      await withTenant(ctx, async (tx) => {
        if (!syncToken) {
          await schedulingLock(tx, c.location_id);
          await tx.query(
            "UPDATE resource_blocks SET active=false WHERE source='GOOGLE' AND split_part(external_key,':',1) <> ALL($1::text[])",
            [seen],
          );
        }
        await tx.query(
          "UPDATE calendar_connections SET sync_token=$1,last_synced_at=clock_timestamp(),status='CONNECTED',last_error=NULL",
          [body.nextSyncToken],
        );
      });
      break;
    }
  }
  if (!c.channel_expires_at || new Date(c.channel_expires_at).getTime() < Date.now() + 3600000)
    await renewWatch(ctx);
  return {};
}

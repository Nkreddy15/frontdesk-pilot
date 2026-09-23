import { createHash, randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import { withTenant, schedulingLock, expireHolds, type Context, type Tx } from './db.js';
import { DomainError, databaseError } from './errors.js';
import type { AvailabilityInput, BookingInput, Result } from './contracts.js';
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function stable(value: any): string {
  return value === null || typeof value !== 'object'
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(stable).join(',')}]`
      : `{${Object.keys(value)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + stable(value[k]))
          .join(',')}}`;
}
export async function audit(
  tx: Tx,
  ctx: Context,
  type: string,
  id: string,
  action: string,
  after: unknown,
) {
  await tx.query('SELECT record_audit($1,$2,$3,$4)', [type, id, action, after]);
}
// Application callers cannot write audit rows directly; use DB function for non-appointment events.
export async function mutation(
  ctx: Context,
  location: string,
  operation: string,
  key: string,
  input: unknown,
  fn: (tx: Tx) => Promise<Result>,
  alternatives?: AvailabilityInput,
): Promise<Result> {
  if (!/^[A-Za-z0-9:_-]{8,120}$/.test(key)) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 400);
  return withTenant(ctx, async (tx) => {
    await schedulingLock(tx, location);
    await expireHolds(tx, location);
    const digest = hash(stable(input));
    await tx.query(
      'INSERT INTO idempotency_requests(tenant_id,operation,key,request_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [ctx.tenantId, operation, key, digest],
    );
    const saved = (
      await tx.query(
        'SELECT * FROM idempotency_requests WHERE tenant_id=$1 AND operation=$2 AND key=$3 FOR UPDATE',
        [ctx.tenantId, operation, key],
      )
    ).rows[0];
    if (saved.request_hash !== digest) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 409);
    if (saved.http_status) return { status: saved.http_status, body: saved.result, replayed: true };
    await tx.query('SAVEPOINT booking_write');
    let result: Result;
    try {
      result = await fn(tx);
      await tx.query('RELEASE SAVEPOINT booking_write');
    } catch (e) {
      await tx.query('ROLLBACK TO SAVEPOINT booking_write');
      const error = databaseError(e);
      let options: any[] = [];
      if (error.code === 'SLOT_CONFLICT' && alternatives)
        options = await findSlots(tx, { ...alternatives, limit: 3 });
      result = {
        status: error.status,
        body: {
          error: error.code,
          ...error.details,
          ...(error.code === 'SLOT_CONFLICT' ? { alternatives: options } : {}),
          committed: false,
        },
      };
    }
    await tx.query(
      'UPDATE idempotency_requests SET http_status=$4,result=$5 WHERE tenant_id=$1 AND operation=$2 AND key=$3',
      [ctx.tenantId, operation, key, result.status, result.body],
    );
    return result; // withTenant only returns this AFTER COMMIT succeeds.
  });
}
async function catalog(tx: Tx, locationId: string, serviceId: string) {
  const location = (
    await tx.query(
      'SELECT l.*,s.booking_paused,clock_timestamp() AS database_now FROM locations l JOIN business_settings s USING(tenant_id) WHERE l.id=$1',
      [locationId],
    )
  ).rows[0];
  const service = (
    await tx.query('SELECT * FROM services WHERE id=$1 AND location_id=$2 AND active', [
      serviceId,
      locationId,
    ])
  ).rows[0];
  if (!location || !service) throw new DomainError('SERVICE_NOT_FOUND', 404);
  if (!location.booking_enabled || location.booking_paused)
    throw new DomainError('BOOKING_PAUSED', 409);
  const resources = (
    await tx.query('SELECT r.* FROM resources r WHERE location_id=$1 AND active ORDER BY name', [
      locationId,
    ])
  ).rows;
  const eligible = (
    await tx.query('SELECT resource_id FROM service_staff WHERE service_id=$1', [serviceId])
  ).rows.map((r) => r.resource_id);
  return {
    location,
    service,
    staff: resources.filter((r) => r.kind === 'STAFF' && eligible.includes(r.id)),
    bays: resources.filter((r) => r.kind === 'BAY'),
  };
}
function withinHours(start: DateTime, end: DateTime, hours: any) {
  const period = hours?.[start.weekday];
  if (!Array.isArray(period) || period.length !== 2 || start.toISODate() !== end.toISODate())
    return false;
  const from = DateTime.fromISO(`${start.toISODate()}T${period[0]}`, { zone: start.zoneName! });
  const to = DateTime.fromISO(`${start.toISODate()}T${period[1]}`, { zone: start.zoneName! });
  return from.isValid && to.isValid && start >= from && end <= to;
}
function window(service: any, startsAt: string, timezone: string) {
  const start = DateTime.fromISO(startsAt, { setZone: true }).setZone(timezone);
  if (!start.isValid) throw new DomainError('INVALID_DATE');
  return {
    start,
    busyStart: start.minus({ minutes: service.buffer_before }),
    end: start.plus({ minutes: service.duration_minutes }),
    busyEnd: start.plus({ minutes: service.duration_minutes + service.buffer_after }),
  };
}
function validWindow(
  cat: Awaited<ReturnType<typeof catalog>>,
  staff: any,
  w: ReturnType<typeof window>,
) {
  const now = DateTime.fromJSDate(new Date(cat.location.database_now)).setZone(
    cat.location.timezone,
  );
  return (
    w.start >= now.plus({ minutes: cat.location.min_notice_minutes }) &&
    w.start <= now.plus({ days: cat.location.horizon_days }) &&
    withinHours(w.busyStart, w.busyEnd, cat.location.hours) &&
    withinHours(w.busyStart, w.busyEnd, staff.hours || cat.location.hours)
  );
}
async function availableBay(
  tx: Tx,
  cat: Awaited<ReturnType<typeof catalog>>,
  staffId: string,
  w: ReturnType<typeof window>,
  exclude?: string,
) {
  const occupied = (
    await tx.query(
      "SELECT resource_id FROM resource_reservations WHERE active AND occupied_range && tstzrange($1,$2,'[)') AND ($3::uuid IS NULL OR appointment_id IS DISTINCT FROM $3)",
      [w.busyStart.toISO(), w.busyEnd.toISO(), exclude || null],
    )
  ).rows.map((r) => r.resource_id);
  if (occupied.includes(staffId)) return undefined;
  return cat.bays.find((b) => !occupied.includes(b.id));
}
export async function validateSlot(
  tx: Tx,
  input: { locationId: string; serviceId: string; staffId: string; startsAt: string },
  exclude?: string,
  snapshot?: any,
) {
  const cat = await catalog(tx, input.locationId, input.serviceId),
    staff = cat.staff.find((s) => s.id === input.staffId);
  if (!staff) throw new DomainError('STAFF_NOT_ELIGIBLE', 422);
  if (snapshot) cat.service = { ...cat.service, ...snapshot };
  const w = window(cat.service, input.startsAt, cat.location.timezone);
  if (!validWindow(cat, staff, w)) throw new DomainError('OUTSIDE_BOOKING_RULES', 422);
  const bay = await availableBay(tx, cat, input.staffId, w, exclude);
  if (!bay) throw new DomainError('SLOT_CONFLICT', 409);
  return { cat, staff, bay, w };
}
export async function findSlots(tx: Tx, input: AvailabilityInput): Promise<any[]> {
  const cat = await catalog(tx, input.locationId, input.serviceId);
  const staff = input.staffId ? cat.staff.filter((s) => s.id === input.staffId) : cat.staff;
  const from = DateTime.fromISO(input.from, { setZone: true }).setZone(cat.location.timezone);
  if (!from.isValid) throw new DomainError('INVALID_DATE');
  const now = DateTime.fromJSDate(new Date(cat.location.database_now))
    .setZone(cat.location.timezone)
    .plus({ minutes: cat.location.min_notice_minutes });
  let cursor = from > now ? from : now;
  cursor = cursor.startOf('minute');
  if (cursor.minute % 15 || cursor.second)
    cursor = cursor.plus({ minutes: 15 - (cursor.minute % 15) }).startOf('minute');
  const until = DateTime.min(
    cursor.plus({ days: 14 }),
    now.plus({ days: cat.location.horizon_days }),
  );
  const results = [];
  // One range read; slot search does not cause hundreds of DB round trips.
  const claims = (
    await tx.query(
      "SELECT resource_id,lower(occupied_range) AS a,upper(occupied_range) AS b FROM resource_reservations WHERE active AND occupied_range && tstzrange($1,$2,'[)')",
      [cursor.minus({ hours: 2 }).toISO(), until.plus({ hours: 10 }).toISO()],
    )
  ).rows;
  for (; cursor < until && results.length < input.limit; cursor = cursor.plus({ minutes: 15 })) {
    const w = window(cat.service, cursor.toISO()!, cat.location.timezone);
    const busy = claims
      .filter(
        (c) =>
          new Date(c.a).getTime() < w.busyEnd.toMillis() &&
          new Date(c.b).getTime() > w.busyStart.toMillis(),
      )
      .map((c) => c.resource_id);
    const member = staff.find((s) => validWindow(cat, s, w) && !busy.includes(s.id));
    const bay = cat.bays.find((b) => !busy.includes(b.id));
    if (member && bay)
      results.push({
        startsAt: w.start.toUTC().toISO(),
        endsAt: w.end.toUTC().toISO(),
        staffId: member.id,
        staffName: member.name,
        bayId: bay.id,
        timezone: cat.location.timezone,
        label: w.start.toFormat('ccc, LLL d · h:mm a ZZZZ'),
      });
  }
  return results;
}
export async function availability(ctx: Context, input: AvailabilityInput) {
  return withTenant(ctx, async (tx) => {
    await schedulingLock(tx, input.locationId);
    await expireHolds(tx, input.locationId);
    return findSlots(tx, input);
  });
}
export async function receipt(tx: Tx, id: string) {
  const row = (
    await tx.query(
      'SELECT a.id,a.state,a.version,a.starts_at,a.ends_at,a.service_name,a.service_id,a.staff_id,a.location_id,a.customer_id,a.price_cents,a.notes,a.hold_expires_at,c.name AS customer_name,c.phone,r.name AS staff_name,l.timezone FROM appointments a JOIN customers c ON c.id=a.customer_id JOIN resources r ON r.id=a.staff_id JOIN locations l ON l.id=a.location_id WHERE a.id=$1',
      [id],
    )
  ).rows[0];
  if (!row) throw new DomainError('APPOINTMENT_NOT_FOUND', 404);
  return row;
}
export async function createBooking(
  ctx: Context,
  input: BookingInput,
  key: string,
  hold = false,
): Promise<Result> {
  return mutation(
    ctx,
    input.locationId,
    hold ? 'hold' : 'book',
    key,
    input,
    async (tx) => {
      const { bay, w } = await validateSlot(tx, input);
      const existing = (
        await tx.query(
          'SELECT id FROM customers WHERE phone=$1 AND lower(name)=lower($2) AND deleted_at IS NULL ORDER BY created_at LIMIT 1',
          [input.customer.phone, input.customer.name],
        )
      ).rows[0];
      const customer =
        existing ||
        (
          await tx.query(
            'INSERT INTO customers(tenant_id,name,phone,notes) VALUES($1,$2,$3,$4) RETURNING id',
            [ctx.tenantId, input.customer.name, input.customer.phone, input.customer.notes],
          )
        ).rows[0];
      const token = hold ? randomBytes(32).toString('hex') : null,
        manageCode = randomBytes(6).toString('hex').toUpperCase();
      const row = (
        await tx.query(
          `INSERT INTO appointments(tenant_id,location_id,customer_id,service_id,staff_id,bay_id,starts_at,ends_at,duration_minutes,buffer_before,buffer_after,price_cents,service_name,state,source,hold_expires_at,hold_token_hash,notes,manage_code_hash)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,0,0,0,'', $9,$10,CASE WHEN $9='HELD' THEN clock_timestamp()+interval '120 seconds' ELSE NULL END,$11,$12,$13) RETURNING id`,
          [
            ctx.tenantId,
            input.locationId,
            customer.id,
            input.serviceId,
            input.staffId,
            bay.id,
            input.startsAt,
            w.end.toISO(),
            hold ? 'HELD' : 'CONFIRMED',
            ctx.role === 'VOICE' ? 'VOICE' : 'OWNER',
            token ? hash(token) : null,
            input.notes,
            hash(manageCode),
          ],
        )
      ).rows[0];
      return {
        status: 201,
        body: {
          appointment: await receipt(tx, row.id),
          manageCode,
          committed: true,
          ...(token ? { holdToken: token } : {}),
        },
      };
    },
    {
      locationId: input.locationId,
      serviceId: input.serviceId,
      staffId: input.staffId,
      from: input.startsAt,
      limit: 3,
    },
  );
}
export async function confirmHold(
  ctx: Context,
  id: string,
  input: { locationId: string; holdToken: string; expectedVersion: number; readbackAccepted: true },
  key: string,
) {
  return mutation(ctx, input.locationId, `confirm:${id}`, key, input, async (tx) => {
    const old = (
      await tx.query('SELECT * FROM appointments WHERE id=$1 AND location_id=$2 FOR UPDATE', [
        id,
        input.locationId,
      ])
    ).rows[0];
    if (!old || old.hold_token_hash !== hash(input.holdToken))
      throw new DomainError('HOLD_NOT_FOUND', 404);
    if (old.state === 'EXPIRED' || new Date(old.hold_expires_at).getTime() <= Date.now())
      throw new DomainError('HOLD_EXPIRED', 410);
    if (old.state !== 'HELD' || old.version !== input.expectedVersion)
      throw new DomainError('VERSION_CONFLICT', 409);
    const current = (await tx.query('SELECT * FROM services WHERE id=$1', [old.service_id]))
      .rows[0];
    if (
      ['price_cents', 'duration_minutes', 'buffer_before', 'buffer_after', 'name'].some(
        (k) => current?.[k] !== old[k === 'name' ? 'service_name' : k],
      )
    )
      throw new DomainError('CATALOG_CHANGED', 409);
    await validateSlot(
      tx,
      {
        locationId: old.location_id,
        serviceId: old.service_id,
        staffId: old.staff_id,
        startsAt: new Date(old.starts_at).toISOString(),
      },
      id,
    );
    await tx.query(
      "UPDATE appointments SET state='CONFIRMED',reason='caller_confirmed' WHERE id=$1",
      [id],
    );
    return { status: 200, body: { appointment: await receipt(tx, id), committed: true } };
  });
}
export async function reschedule(
  ctx: Context,
  id: string,
  input: { locationId: string; startsAt: string; staffId: string; expectedVersion: number },
  key: string,
) {
  const details = await withTenant(ctx, (tx) => receipt(tx, id));
  return mutation(
    ctx,
    input.locationId,
    `reschedule:${id}`,
    key,
    input,
    async (tx) => {
      const old = (
        await tx.query('SELECT * FROM appointments WHERE id=$1 AND location_id=$2 FOR UPDATE', [
          id,
          input.locationId,
        ])
      ).rows[0];
      if (!old) throw new DomainError('APPOINTMENT_NOT_FOUND', 404);
      if (old.state !== 'CONFIRMED' || old.version !== input.expectedVersion)
        throw new DomainError('VERSION_CONFLICT', 409);
      const { bay } = await validateSlot(tx, { ...input, serviceId: old.service_id }, id, {
        duration_minutes: old.duration_minutes,
        buffer_before: old.buffer_before,
        buffer_after: old.buffer_after,
      });
      await tx.query(
        "UPDATE appointments SET starts_at=$2,staff_id=$3,bay_id=$4,reason='rescheduled' WHERE id=$1",
        [id, input.startsAt, input.staffId, bay.id],
      );
      return { status: 200, body: { appointment: await receipt(tx, id), committed: true } };
    },
    {
      locationId: input.locationId,
      serviceId: details.service_id,
      staffId: input.staffId,
      from: input.startsAt,
      limit: 3,
    },
  );
}
export async function changeState(
  ctx: Context,
  id: string,
  input: { locationId: string; expectedVersion: number; state: string; reason: string },
  key: string,
) {
  return mutation(ctx, input.locationId, `state:${id}`, key, input, async (tx) => {
    const old = (
      await tx.query('SELECT * FROM appointments WHERE id=$1 AND location_id=$2 FOR UPDATE', [
        id,
        input.locationId,
      ])
    ).rows[0];
    if (!old) throw new DomainError('APPOINTMENT_NOT_FOUND', 404);
    if (old.version !== input.expectedVersion) throw new DomainError('VERSION_CONFLICT', 409);
    await tx.query('UPDATE appointments SET state=$2,reason=$3 WHERE id=$1', [
      id,
      input.state,
      input.reason,
    ]);
    return { status: 200, body: { appointment: await receipt(tx, id), committed: true } };
  });
}
export async function createBlock(
  ctx: Context,
  input: {
    locationId: string;
    resourceId: string;
    startsAt: string;
    endsAt: string;
    reason: string;
  },
  key: string,
) {
  return mutation(ctx, input.locationId, 'block', key, input, async (tx) => {
    if (new Date(input.endsAt) <= new Date(input.startsAt))
      throw new DomainError('INVALID_INTERVAL');
    if (
      !(
        await tx.query('SELECT 1 FROM resources WHERE id=$1 AND location_id=$2', [
          input.resourceId,
          input.locationId,
        ])
      ).rowCount
    )
      throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const row = (
      await tx.query(
        'INSERT INTO resource_blocks(tenant_id,location_id,resource_id,starts_at,ends_at,reason) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [
          ctx.tenantId,
          input.locationId,
          input.resourceId,
          input.startsAt,
          input.endsAt,
          input.reason,
        ],
      )
    ).rows[0];
    return { status: 201, body: { block: row, committed: true } };
  });
}

import { z } from 'zod';
import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import { withTenant, type Context } from './db.js';
import { DomainError } from './errors.js';
import {
  availability,
  createBooking,
  confirmHold,
  changeState,
  reschedule,
  hash,
  stable,
  receipt,
} from './booking.js';
import { uuid, phone, instant } from './contracts.js';
import { config } from './config.js';
import { schedulingLock } from './db.js';
export const commandSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('DETAILS'),
      serviceId: uuid.optional(),
      staffId: uuid.optional(),
      name: z.string().trim().min(1).max(120).optional(),
      phone: phone.optional(),
      from: instant.optional(),
      notes: z.string().max(1000).optional(),
    })
    .strict(),
  z.object({ type: z.literal('AVAILABILITY'), from: instant.optional() }).strict(),
  z.object({ type: z.literal('SELECT_SLOT'), index: z.number().int().min(0).max(2) }).strict(),
  z.object({ type: z.literal('CONFIRM') }).strict(),
  z.object({ type: z.literal('CORRECT') }).strict(),
  z.object({ type: z.literal('QUESTION'), topic: z.string().min(1).max(100) }).strict(),
  z
    .object({ type: z.literal('LOOKUP'), phone, reference: z.string().regex(/^[A-Fa-f0-9]{12}$/) })
    .strict(),
  z.object({ type: z.literal('RESCHEDULE') }).strict(),
  z.object({ type: z.literal('CANCEL_APPOINTMENT') }).strict(),
  z
    .object({
      type: z.enum([
        'TRANSFER',
        'EMERGENCY',
        'END',
        'DISCONNECT',
        'UNSUPPORTED',
        'ABUSE',
        'SILENCE',
      ]),
    })
    .strict(),
]);
export type Command = z.infer<typeof commandSchema>;
export type ConversationReply = {
  say: string;
  phase: string;
  slots?: any[];
  appointment?: any;
  confirmed?: boolean;
  transfer?: boolean;
  ended?: boolean;
  reason?: string;
};
type Workflow = {
  phase: string;
  draft: any;
  slots?: any[];
  hold?: any;
  manage?: any;
  reference?: string;
  reviewPlayed?: boolean;
  silences?: number;
  verificationAttempts?: number;
};
export async function startCall(
  ctx: Context,
  locationId: string,
  mode: 'SIMULATOR' | 'TELEPHONE' = 'SIMULATOR',
  providerSid?: string,
  callerPhone?: string,
) {
  return withTenant(ctx, async (tx) => {
    if (mode === 'TELEPHONE') {
      await schedulingLock(tx, locationId);
      const exists =
        providerSid &&
        (await tx.query('SELECT 1 FROM calls WHERE provider_sid=$1', [providerSid])).rowCount;
      const stats = (
        await tx.query(
          "SELECT count(*) FILTER(WHERE state='ACTIVE' AND started_at>now()-interval '10 minutes')::int AS active,coalesce(sum(CASE WHEN state='ACTIVE' THEN LEAST(extract(epoch FROM clock_timestamp()-started_at),600) ELSE duration_seconds END)/60,0)::float AS minutes FROM calls WHERE mode='TELEPHONE' AND started_at>=date_trunc('month',now())",
        )
      ).rows[0];
      if (
        !exists &&
        (stats.active >= config.maxConcurrentCalls || stats.minutes >= config.monthlyMinuteLimit)
      )
        throw new DomainError('VOICE_CAPACITY_REACHED', 503);
    }
    const settings = (await tx.query('SELECT greeting FROM business_settings')).rows[0];
    const call = (
      await tx.query(
        'INSERT INTO calls(tenant_id,location_id,mode,provider_sid,caller_phone,transcription_consented,workflow) VALUES($1,$2,$3,$4,$5,true,$6) ON CONFLICT(provider_sid) DO UPDATE SET provider_sid=EXCLUDED.provider_sid RETURNING id,workflow',
        [
          ctx.tenantId,
          locationId,
          mode,
          providerSid || null,
          callerPhone || null,
          { phase: 'COLLECT', draft: { locationId } },
        ],
      )
    ).rows[0];
    if (!(await tx.query('SELECT 1 FROM call_events WHERE call_id=$1 LIMIT 1', [call.id])).rowCount)
      await tx.query(
        "INSERT INTO call_events(tenant_id,call_id,kind,content) VALUES($1,$2,'ASSISTANT',$3)",
        [ctx.tenantId, call.id, { text: settings.greeting }],
      );
    return { callId: call.id, say: settings.greeting, phase: call.workflow.phase };
  });
}
export async function markReadbackPlayed(ctx: Context, id: string) {
  await withTenant(ctx, (tx) =>
    tx.query(
      "UPDATE calls SET workflow=jsonb_set(workflow,'{reviewPlayed}','true') WHERE id=$1 AND workflow->>'phase' IN ('REVIEW','RESCHEDULE_REVIEW','CANCEL_REVIEW')",
      [id],
    ),
  );
}
export async function command(
  ctx: Context,
  callId: string,
  actionId: string,
  input: Command,
  transcript?: string,
): Promise<ConversationReply> {
  const cmd = commandSchema.parse(input);
  if (!/^[A-Za-z0-9:_-]{8,120}$/.test(actionId)) throw new DomainError('INVALID_ACTION_ID', 400);
  const call = await withTenant(ctx, async (tx) => {
    const existing = (
      await tx.query(
        'SELECT arguments,result FROM tool_executions WHERE call_id=$1 AND action_id=$2',
        [callId, actionId],
      )
    ).rows[0];
    if (existing) {
      if (existing.arguments.hash !== hash(stable(cmd)))
        throw new DomainError('ACTION_ID_REUSED', 409);
      if (existing.result) return { cached: existing.result };
    }
    const current = (
      await tx.query(
        "UPDATE calls SET workflow_lock_until=clock_timestamp()+interval '60 seconds',workflow_lock_owner=$2 WHERE id=$1 AND state='ACTIVE' AND (workflow_lock_until IS NULL OR workflow_lock_until<clock_timestamp()) RETURNING *",
        [callId, actionId],
      )
    ).rows[0];
    if (!current) throw new DomainError('CALL_BUSY_OR_NOT_FOUND', 409);
    await tx.query(
      'INSERT INTO tool_executions(tenant_id,call_id,action_id,tool,arguments) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [ctx.tenantId, callId, actionId, cmd.type, { hash: hash(stable(cmd)), type: cmd.type }],
    );
    if (transcript && current.transcription_consented)
      await tx.query(
        "INSERT INTO call_events(tenant_id,call_id,kind,content) VALUES($1,$2,'CALLER',$3)",
        [ctx.tenantId, callId, { text: transcript.slice(0, 4000) }],
      );
    return current;
  });
  if (call.cached) return call.cached;
  const w = call.workflow as Workflow;
  const start = performance.now();
  let answer: ConversationReply;
  const voiceCtx = { ...ctx, role: 'VOICE' as const, userId: `call:${callId}` };
  try {
    answer = await advance(voiceCtx, callId, call.mode, w, cmd, actionId);
  } catch (e) {
    // A committed tool can be safely replayed with the SAME action id. Do not invent its result.
    await withTenant(ctx, (tx) =>
      tx.query(
        "UPDATE calls SET workflow_lock_until=NULL,workflow_lock_owner=NULL,follow_up='REQUIRED' WHERE id=$1 AND workflow_lock_owner=$2",
        [callId, actionId],
      ),
    );
    throw e;
  }
  await withTenant(ctx, async (tx) => {
    const updated = await tx.query(
      "UPDATE calls SET workflow=$2,workflow_lock_until=NULL,workflow_lock_owner=NULL,summary=$3,outcome=$4,state=CASE WHEN $5 THEN 'ENDED' ELSE state END,ended_at=CASE WHEN $5 THEN clock_timestamp() ELSE ended_at END,duration_seconds=CASE WHEN $5 THEN extract(epoch FROM clock_timestamp()-started_at)::int ELSE duration_seconds END,follow_up=CASE WHEN $6 THEN 'REQUIRED' ELSE follow_up END WHERE id=$1 AND workflow_lock_owner=$7 RETURNING id",
      [
        callId,
        w,
        summary(w, answer),
        answer.confirmed
          ? w.phase === 'CANCELLED'
            ? 'CANCELLED'
            : 'BOOKED'
          : answer.transfer
            ? 'TRANSFER_PENDING'
            : answer.ended
              ? w.phase === 'BOOKED'
                ? 'BOOKED'
                : 'LEAD_CAPTURED'
              : 'IN_PROGRESS',
        !!answer.ended,
        answer.reason === 'FOLLOW_UP',
        actionId,
      ],
    );
    if (!updated.rowCount) throw new DomainError('CALL_LEASE_LOST', 409);
    await tx.query(
      'UPDATE tool_executions SET result=$3,duration_ms=$4 WHERE call_id=$1 AND action_id=$2',
      [callId, actionId, answer, Math.round(performance.now() - start)],
    );
    await tx.query(
      "INSERT INTO call_events(tenant_id,call_id,kind,content) VALUES($1,$2,'ASSISTANT',$3)",
      [
        ctx.tenantId,
        callId,
        { text: answer.say, phase: answer.phase, confirmed: answer.confirmed === true },
      ],
    );
  });
  return answer;
}
function summary(w: Workflow, a: ConversationReply) {
  return `${a.phase}: ${w.draft.name || 'Caller'}; ${w.draft.phone || 'callback not captured'}; ${w.manage ? `${w.manage.service_name}, ${new Date(w.manage.starts_at).toISOString()}, ${w.manage.state.toLowerCase()}` : 'appointment not confirmed'}. ${a.reason || ''}`;
}
async function release(ctx: Context, w: Workflow, key: string) {
  if (w.hold) {
    await changeState(
      ctx,
      w.hold.appointment.id,
      {
        locationId: w.draft.locationId,
        expectedVersion: w.hold.appointment.version,
        state: 'CANCELLED',
        reason: 'caller_corrected_or_left',
      },
      key,
    );
    delete w.hold;
  }
  w.reviewPlayed = false;
}
async function lead(ctx: Context, callId: string, w: Workflow, reason: string) {
  await withTenant(ctx, (tx) =>
    tx.query(
      "INSERT INTO leads(tenant_id,call_id,name,phone,requested_service,preferred_time,reason,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,call_id) WHERE call_id IS NOT NULL AND status='OPEN' DO UPDATE SET reason=EXCLUDED.reason,name=EXCLUDED.name,phone=EXCLUDED.phone,requested_service=EXCLUDED.requested_service,preferred_time=EXCLUDED.preferred_time,notes=EXCLUDED.notes",
      [
        ctx.tenantId,
        callId,
        w.draft.name || '',
        w.draft.phone || '',
        w.draft.serviceId || '',
        w.draft.from || '',
        reason,
        w.draft.notes || '',
      ],
    ),
  );
}
function readback(a: any) {
  const time = DateTime.fromJSDate(new Date(a.starts_at))
    .setZone(a.timezone)
    .toFormat('cccc, LLLL d, yyyy, h:mm a ZZZZ');
  return `${a.service_name}, with ${a.staff_name}, on ${time}, in ${a.timezone.replaceAll('_', ' ')}, for ${a.customer_name}. Your callback number is ${String(a.phone).split('').join(' ')}.`;
}
async function advance(
  ctx: Context,
  callId: string,
  mode: string,
  w: Workflow,
  cmd: Command,
  actionId: string,
): Promise<ConversationReply> {
  const reply = (say: string, extras: Partial<ConversationReply> = {}): ConversationReply => ({
    say,
    phase: w.phase,
    ...extras,
  });
  if (cmd.type === 'DETAILS') {
    if (w.phase === 'BOOKED')
      return reply(
        'Your appointment is already booked. To change it, please use your booking reference.',
      );
    await release(ctx, w, `${actionId}:release`);
    const { type, ...details } = cmd;
    Object.assign(w.draft, details);
    w.phase = w.manage ? 'RESCHEDULE_COLLECT' : 'COLLECT';
    delete w.slots;
    if (!w.draft.serviceId) return reply('Which service would you like?');
    if (!w.draft.staffId) return reply('Which team member would you prefer?');
    if (!w.draft.name) return reply('What name should I put on the appointment?');
    if (!w.draft.phone) return reply('What is the best callback number, including the area code?');
    return reply('Thank you. What date and time work for you?');
  }
  if (cmd.type === 'AVAILABILITY') {
    if (!w.draft.serviceId) return reply('Which service would you like?');
    if (cmd.from) w.draft.from = cmd.from;
    w.slots = await availability(ctx, {
      locationId: w.draft.locationId,
      serviceId: w.draft.serviceId,
      staffId: w.draft.staffId,
      from: w.draft.from || new Date().toISOString(),
      limit: 3,
    });
    if (!w.slots.length) {
      await lead(ctx, callId, w, 'NO_AVAILABILITY');
      return reply(
        'I could not find a suitable time in the next two weeks. I can ask the team to follow up.',
        { reason: 'FOLLOW_UP' },
      );
    }
    return reply(
      'The next available options are ' +
        w.slots.map((s, i) => `${i + 1}: ${s.label}, with ${s.staffName}`).join('; ') +
        '. Which works best?',
      { slots: w.slots },
    );
  }
  if (cmd.type === 'SELECT_SLOT') {
    const slot = w.slots?.[cmd.index];
    if (!slot) return reply('Let me check availability again before choosing a time.');
    if (!w.draft.name || !w.draft.phone)
      return reply('Before I reserve that time, what are your name and callback number?');
    if (w.manage) {
      w.phase = 'RESCHEDULE_REVIEW';
      w.draft.startsAt = slot.startsAt;
      w.draft.staffId = slot.staffId;
      w.reviewPlayed = false;
      return reply(
        `To move your appointment: ${readback({ ...w.manage, starts_at: slot.startsAt, staff_name: slot.staffName })} Shall I make this change? Your original appointment remains booked until the change succeeds.`,
      );
    }
    const result = await createBooking(
      ctx,
      {
        locationId: w.draft.locationId,
        serviceId: w.draft.serviceId,
        staffId: slot.staffId,
        startsAt: slot.startsAt,
        customer: { name: w.draft.name, phone: w.draft.phone, notes: '' },
        notes: w.draft.notes || '',
      },
      actionId,
      true,
    );
    if (result.status === 409 && result.body.error === 'SLOT_CONFLICT') {
      w.slots = result.body.alternatives;
      return reply(
        'That time was just taken. The next three available options are ' +
          w.slots!.map((s) => s.label).join('; ') +
          '.',
        { slots: w.slots },
      );
    }
    if (result.status !== 201)
      return reply(
        'I could not hold that time. I can check another time or ask the team to follow up.',
        { reason: 'FOLLOW_UP' },
      );
    w.hold = result.body;
    w.phase = 'REVIEW';
    w.reviewPlayed = false;
    return reply(
      `I have held this time for two minutes. ${readback(w.hold.appointment)} The price is $${(w.hold.appointment.price_cents / 100).toFixed(2)}. Is all of that correct?`,
    );
  }
  if (cmd.type === 'CONFIRM') {
    if (!['REVIEW', 'RESCHEDULE_REVIEW', 'CANCEL_REVIEW'].includes(w.phase))
      return reply('I need to review the appointment details with you before making that change.');
    if (mode === 'TELEPHONE' && !w.reviewPlayed)
      return reply(
        'Please let me finish reviewing the details before you confirm. ' +
          readback(w.hold?.appointment || w.manage),
      );
    let result;
    if (w.phase === 'CANCEL_REVIEW')
      result = await changeState(
        ctx,
        w.manage.id,
        {
          locationId: w.draft.locationId,
          expectedVersion: w.manage.version,
          state: 'CANCELLED',
          reason: 'verified_caller_cancelled',
        },
        actionId,
      );
    else if (w.phase === 'RESCHEDULE_REVIEW')
      result = await reschedule(
        ctx,
        w.manage.id,
        {
          locationId: w.draft.locationId,
          expectedVersion: w.manage.version,
          startsAt: w.draft.startsAt,
          staffId: w.draft.staffId,
        },
        actionId,
      );
    else
      result = await confirmHold(
        ctx,
        w.hold.appointment.id,
        {
          locationId: w.draft.locationId,
          holdToken: w.hold.holdToken,
          expectedVersion: w.hold.appointment.version,
          readbackAccepted: true,
        },
        actionId,
      );
    if (result.status >= 400) {
      if (result.body.error === 'HOLD_EXPIRED') {
        w.phase = 'COLLECT';
        delete w.hold;
        return reply(
          'The temporary hold expired. I have not confirmed a booking. Let me check fresh times.',
        );
      }
      if (result.body.error === 'SLOT_CONFLICT') {
        w.slots = result.body.alternatives;
        w.phase = 'RESCHEDULE_COLLECT';
        return reply(
          'That time was just taken. Your original appointment is unchanged. Here are the next three options: ' +
            w.slots!.map((s) => s.label).join('; ') +
            '.',
          { slots: w.slots },
        );
      }
      await lead(ctx, callId, w, result.body.error);
      return reply('I could not complete the change. I can ask the team to follow up.', {
        reason: 'FOLLOW_UP',
      });
    }
    if (result.body.committed !== true) throw new Error('Missing committed receipt');
    const cancelling = w.phase === 'CANCEL_REVIEW';
    w.phase = cancelling ? 'CANCELLED' : 'BOOKED';
    w.manage = result.body.appointment;
    w.reference = w.hold?.manageCode;
    delete w.hold;
    return reply(
      cancelling
        ? 'Your appointment has been cancelled.'
        : `Your appointment is confirmed. ${readback(result.body.appointment)}${w.reference ? ' Your booking reference is ' + w.reference.split('').join(' ') + '.' : ''} Text updates are sent only if you have provided the required messaging consent.`,
      { confirmed: true, appointment: result.body.appointment },
    );
  }
  if (cmd.type === 'CORRECT') {
    await release(ctx, w, actionId);
    w.phase = w.manage ? 'RESCHEDULE_COLLECT' : 'COLLECT';
    return reply('Of course. Which detail should I change?');
  }
  if (cmd.type === 'LOOKUP') {
    w.verificationAttempts = (w.verificationAttempts || 0) + 1;
    if (w.verificationAttempts > 5) {
      await lead(ctx, callId, w, 'VERIFICATION_LIMIT');
      return reply('I cannot verify the booking. The team will need to help.', {
        reason: 'FOLLOW_UP',
      });
    }
    const a = await withTenant(ctx, async (tx) => {
      const row = (
        await tx.query(
          "SELECT a.id FROM appointments a JOIN customers c ON c.id=a.customer_id WHERE a.manage_code_hash=$1 AND c.phone=$2 AND a.state='CONFIRMED'",
          [hash(cmd.reference.toUpperCase()), cmd.phone],
        )
      ).rows[0];
      return row ? receipt(tx, row.id) : undefined;
    });
    if (!a)
      return reply(
        'I could not verify those details. Please check the reference and callback number, or ask for the team.',
      );
    w.manage = a;
    w.draft = {
      locationId: a.location_id,
      serviceId: a.service_id,
      staffId: a.staff_id,
      name: a.customer_name,
      phone: a.phone,
    };
    w.phase = 'MANAGE';
    return reply(`${readback(a)} Would you like to reschedule or cancel?`);
  }
  if (cmd.type === 'RESCHEDULE' || cmd.type === 'CANCEL_APPOINTMENT') {
    if (!w.manage)
      return reply(
        'Please provide your booking reference and callback number so I can verify the appointment.',
      );
    if (cmd.type === 'RESCHEDULE') {
      w.phase = 'RESCHEDULE_COLLECT';
      return reply('What new date and time would you prefer?');
    }
    w.phase = 'CANCEL_REVIEW';
    w.reviewPlayed = false;
    return reply(`To cancel: ${readback(w.manage)} Should I cancel this appointment?`);
  }
  if (cmd.type === 'QUESTION') {
    const answer = await withTenant(ctx, async (tx) => {
      if (cmd.topic === 'services' || cmd.topic === 'prices') {
        const rows = (
          await tx.query(
            'SELECT name,price_cents,duration_minutes FROM services WHERE active AND location_id=$1 ORDER BY duration_minutes',
            [w.draft.locationId],
          )
        ).rows;
        return rows
          .map(
            (s) => `${s.name}: ${s.duration_minutes} minutes, $${(s.price_cents / 100).toFixed(2)}`,
          )
          .join('; ');
      }
      if (cmd.topic === 'location') {
        return (await tx.query('SELECT address FROM locations WHERE id=$1', [w.draft.locationId]))
          .rows[0]?.address;
      }
      const row = (
        await tx.query('SELECT answer FROM knowledge WHERE topic=$1 AND published', [cmd.topic])
      ).rows[0];
      return row?.answer;
    });
    return reply(
      answer || 'I do not have approved information about that. I can ask the team to follow up.',
    );
  }
  if (cmd.type === 'SILENCE') {
    w.silences = (w.silences || 0) + 1;
    if (w.silences < 2)
      return reply(
        'Are you still there? I can help with an appointment or connect you to the team.',
      );
  }
  if (cmd.type === 'EMERGENCY') {
    await release(ctx, w, actionId);
    w.phase = 'ENDED';
    return reply(
      'I am an appointment receptionist and cannot provide emergency assistance. If there is immediate danger, hang up and call 911.',
      { ended: true },
    );
  }
  if (cmd.type === 'ABUSE') {
    await release(ctx, w, actionId);
    w.phase = 'ENDED';
    return reply('I can help with appointments, but I cannot continue an abusive call. Goodbye.', {
      ended: true,
    });
  }
  if (cmd.type === 'TRANSFER') {
    await release(ctx, w, actionId);
    const settings = await withTenant(
      ctx,
      async (tx) =>
        (await tx.query('SELECT transfer_enabled,transfer_number FROM business_settings')).rows[0],
    );
    await lead(ctx, callId, w, 'HUMAN_REQUESTED');
    if (settings.transfer_enabled && settings.transfer_number) {
      w.phase = 'TRANSFER';
      return reply('I will try to connect you with the team now.', { transfer: true });
    }
    return reply(
      'The team cannot take a transfer right now. I have saved your request for follow-up.',
      { reason: 'FOLLOW_UP' },
    );
  }
  if (cmd.type === 'UNSUPPORTED') {
    await lead(ctx, callId, w, 'UNSUPPORTED_REQUEST');
    return reply(
      'I do not have approved information for that request. I can ask the team to follow up.',
      { reason: 'FOLLOW_UP' },
    );
  }
  if (['END', 'DISCONNECT', 'SILENCE'].includes(cmd.type)) {
    await release(ctx, w, actionId);
    if (w.phase !== 'BOOKED' && w.phase !== 'CANCELLED')
      await lead(ctx, callId, w, cmd.type === 'DISCONNECT' ? 'CALL_DROPPED' : 'INCOMPLETE_BOOKING');
    return reply('Thank you for calling. Goodbye.', { ended: true });
  }
  return reply('Could you clarify what you would like me to do?');
}

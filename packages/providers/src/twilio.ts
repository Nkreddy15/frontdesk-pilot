import twilio from 'twilio';
import { DateTime } from 'luxon';
import { config } from '../../core/src/config.js';
import { withTenant, type Context } from '../../core/src/db.js';
import { ProviderError } from './types.js';
export function client() {
  if (!config.twilioSid || !config.twilioToken)
    throw new ProviderError('TWILIO_NOT_CONFIGURED', 'BLOCKED');
  return twilio(config.twilioSid, config.twilioToken, { autoRetry: false, timeout: 8000 });
}
export function validateSignature(signature: string, url: string, body: Record<string, any>) {
  return !!config.twilioToken && twilio.validateRequest(config.twilioToken, signature, url, body);
}
export async function sendSms(ctx: Context, job: any) {
  if (!config.sms || !config.publicApiUrl) throw new ProviderError('SMS_DISABLED', 'BLOCKED');
  const info = await withTenant(ctx, async (tx) => {
    const a = (
      await tx.query(
        'SELECT a.*,c.phone,l.timezone,t.name AS business_name,s.approved_for_live FROM appointments a JOIN customers c ON c.id=a.customer_id JOIN locations l ON l.id=a.location_id JOIN tenants t ON t.id=a.tenant_id JOIN business_settings s ON s.tenant_id=a.tenant_id WHERE a.id=$1',
        [job.entity_id],
      )
    ).rows[0];
    if (!a || a.version !== job.version)
      throw new ProviderError('OUTDATED_APPOINTMENT_VERSION', 'SUPERSEDED');
    if (!a.approved_for_live) throw new ProviderError('BUSINESS_NOT_ACTIVATED', 'BLOCKED');
    const consent = (
      await tx.query(
        "SELECT granted,method FROM consents WHERE customer_id=$1 AND purpose='SMS_APPOINTMENT' ORDER BY created_at DESC,id DESC LIMIT 1",
        [a.customer_id],
      )
    ).rows[0];
    if (!consent?.granted || !['WEB_FORM', 'WRITTEN_IMPORT'].includes(consent.method))
      throw new ProviderError('WRITTEN_SMS_CONSENT_REQUIRED', 'BLOCKED');
    if ((await tx.query('SELECT 1 FROM sms_suppressions WHERE phone=$1', [a.phone])).rowCount)
      throw new ProviderError('RECIPIENT_OPTED_OUT', 'BLOCKED');
    if (job.kind !== 'sms.cancel' && a.state !== 'CONFIRMED')
      throw new ProviderError('APPOINTMENT_NOT_CONFIRMED', 'SUPERSEDED');
    if (job.kind === 'sms.reminder' && new Date(a.starts_at) <= new Date())
      throw new ProviderError('REMINDER_TOO_LATE', 'SUPERSEDED');
    return a;
  });
  const date = DateTime.fromJSDate(new Date(info.starts_at))
    .setZone(info.timezone)
    .toFormat('ccc LLL d, h:mm a ZZZZ');
  const status =
    job.kind === 'sms.cancel'
      ? 'cancelled'
      : job.kind === 'sms.reminder'
        ? 'reminder'
        : job.kind === 'sms.reschedule'
          ? 'rescheduled'
          : 'confirmed';
  const body = `${info.business_name}: ${info.service_name} ${status}, ${date}. Reply STOP to opt out, HELP for help.`;
  try {
    const message = await client().messages.create({
      to: info.phone,
      ...(config.messagingService
        ? { messagingServiceSid: config.messagingService }
        : { from: config.twilioPhone }),
      body,
      statusCallback: `${config.publicApiUrl}/webhooks/twilio/messages?tenant=${ctx.tenantId}&job=${job.id}`,
    });
    return { providerId: message.sid, deliveryStatus: message.status };
  } catch (e: any) {
    if (e.status === 429) throw new ProviderError('TWILIO_RATE_LIMIT', 'RETRY');
    if (e.status >= 400 && e.status < 500)
      throw new ProviderError(
        e.code === 21610 ? 'RECIPIENT_OPTED_OUT' : 'TWILIO_REJECTED_' + (e.code || e.status),
        'FAILED',
      );
    throw new ProviderError('SMS_SEND_OUTCOME_UNKNOWN', 'UNKNOWN');
  }
}
export async function transferCall(ctx: Context, callId: string, providerSid: string) {
  const settings = await withTenant(
    ctx,
    async (tx) =>
      (await tx.query('SELECT transfer_enabled,transfer_number FROM business_settings')).rows[0],
  );
  if (!settings.transfer_enabled || !/^\+[1-9]\d{7,14}$/.test(settings.transfer_number))
    throw new ProviderError('TRANSFER_NOT_CONFIGURED', 'BLOCKED');
  const xml = new twilio.twiml.VoiceResponse();
  xml.dial(
    {
      timeout: 20,
      action: `${config.publicApiUrl}/webhooks/twilio/transfer?tenant=${ctx.tenantId}&call=${callId}`,
      method: 'POST',
    },
    settings.transfer_number,
  );
  await client().calls(providerSid).update({ twiml: xml.toString() });
}

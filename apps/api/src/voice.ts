import type { FastifyInstance, FastifyRequest } from 'fastify';
import WebSocket from 'ws';
import twilio from 'twilio';
import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { config } from '../../../packages/core/src/config.js';
import { pool, withTenant, schedulingLock, type Context } from '../../../packages/core/src/db.js';
import { DomainError } from '../../../packages/core/src/errors.js';
import {
  startCall,
  command,
  markReadbackPlayed,
  type ConversationReply,
} from '../../../packages/core/src/conversation.js';
import {
  AudioInput,
  pcm24ToMuLaw8,
  TranscriptOrder,
} from '../../../packages/providers/src/audio.js';
import { interpret, speech } from '../../../packages/providers/src/openai.js';
import { client, validateSignature, transferCall } from '../../../packages/providers/src/twilio.js';
import { signedTwilio, webhookContext, dedup } from './integration-routes.js';
const secret = new TextEncoder().encode(config.sessionSecret);
async function route(req: FastifyRequest) {
  signedTwilio(req);
  const b = req.body as any;
  if (b.AccountSid !== config.twilioSid) throw new DomainError('WRONG_TWILIO_ACCOUNT', 403);
  const tx = await pool.connect();
  try {
    const r = (await tx.query('SELECT * FROM phone_routes WHERE phone=$1', [b.To])).rows[0];
    if (!r) throw new DomainError('PHONE_NOT_CONFIGURED', 404);
    return r;
  } finally {
    tx.release();
  }
}
function fallback(number?: string) {
  const xml = new twilio.twiml.VoiceResponse();
  xml.say('I am the AI receptionist. The appointment service is unavailable right now.');
  if (number) xml.dial({ timeout: 20 }, number);
  else {
    xml.say('Please call back during business hours.');
    xml.hangup();
  }
  return xml;
}
export async function voiceRoutes(app: FastifyInstance) {
  app.post('/webhooks/twilio/voice', async (req, reply) => {
    const r = await route(req),
      ctx = webhookContext(req, r.tenant_id);
    if (config.testCallers.length && !config.testCallers.includes(String((req.body as any).From)))
      return reply.type('text/xml').send(fallback().toString());
    const settings = await withTenant(
      ctx,
      async (tx) => (await tx.query('SELECT * FROM business_settings')).rows[0],
    );
    if (!config.liveVoice || !config.openaiKey || !settings.approved_for_live)
      return reply
        .type('text/xml')
        .send(
          fallback(settings.transfer_enabled ? settings.transfer_number : undefined).toString(),
        );
    const xml = new twilio.twiml.VoiceResponse();
    const gather = xml.gather({
      input: ['dtmf'],
      numDigits: 1,
      timeout: 8,
      action: config.publicApiUrl + '/webhooks/twilio/consent',
      method: 'POST',
    });
    gather.say(
      'You are speaking with an AI receptionist. With your permission, this call will be transcribed and processed by our service providers to help with your appointment. Audio is not recorded. Press 1 to agree, or 2 to speak with the team.',
    );
    xml.redirect({ method: 'POST' }, config.publicApiUrl + '/webhooks/twilio/consent');
    return reply.type('text/xml').send(xml.toString());
  });
  app.post('/webhooks/twilio/consent', async (req, reply) => {
    const r = await route(req),
      b = req.body as any,
      ctx = webhookContext(req, r.tenant_id);
    const settings = await withTenant(
      ctx,
      async (tx) => (await tx.query('SELECT * FROM business_settings')).rows[0],
    );
    if (b.Digits !== '1' || !config.liveVoice || !settings.approved_for_live)
      return reply
        .type('text/xml')
        .send(
          fallback(settings.transfer_enabled ? settings.transfer_number : undefined).toString(),
        );
    const allowed = await withTenant(ctx, async (tx) => {
      await schedulingLock(tx, r.location_id);
      const stats = (
        await tx.query(
          "SELECT count(*) FILTER(WHERE state='ACTIVE' AND started_at>now()-interval '10 minutes')::int AS active,coalesce(sum(duration_seconds)/60.0,0)::float AS minutes FROM calls WHERE mode='TELEPHONE' AND started_at>=date_trunc('month',now())",
        )
      ).rows[0];
      return stats.active < config.maxConcurrentCalls && stats.minutes < config.monthlyMinuteLimit;
    });
    if (!allowed)
      return reply
        .type('text/xml')
        .send(
          fallback(settings.transfer_enabled ? settings.transfer_number : undefined).toString(),
        );
    const call = await startCall(ctx, r.location_id, 'TELEPHONE', b.CallSid, b.From);
    const token = await new SignJWT({
      tenantId: r.tenant_id,
      callId: call.callId,
      providerSid: b.CallSid,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('receptionist')
      .setAudience('voice-stream')
      .setExpirationTime('2m')
      .sign(secret);
    const xml = new twilio.twiml.VoiceResponse();
    const stream = xml
      .connect()
      .stream({ url: config.publicApiUrl.replace(/^https:/, 'wss:') + '/webhooks/twilio/stream' });
    stream.parameter({ name: 'token', value: token });
    xml.say('The call connection ended. Please call back or contact the team.');
    return reply.type('text/xml').send(xml.toString());
  });
  app.post('/webhooks/twilio/call-status', async (req, reply) => {
    const r = await route(req),
      b = req.body as any,
      ctx = webhookContext(req, r.tenant_id);
    await dedup(
      ctx,
      'twilio',
      `${b.CallSid}:${b.CallStatus}`,
      'call.status',
      { status: b.CallStatus },
      async (tx) => {
        if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(b.CallStatus)) {
          const seconds = Math.min(7200, Math.max(0, Number(b.CallDuration) || 0));
          let call = (
            await tx.query(
              "UPDATE calls SET state='ENDED',ended_at=COALESCE(ended_at,clock_timestamp()),duration_seconds=$2::int,estimated_cost_cents=$2::int/60.0*20 WHERE provider_sid=$1 RETURNING *",
              [b.CallSid, seconds],
            )
          ).rows[0];
          if (!call)
            call = (
              await tx.query(
                "INSERT INTO calls(tenant_id,location_id,provider_sid,caller_phone,mode,state,outcome,ended_at,duration_seconds,summary,follow_up) VALUES($1,$2,$3,$4,'TELEPHONE','ENDED','NO_AI_SESSION',clock_timestamp(),$5,'Call ended without an AI session. Review provider status and any human handoff.','REQUIRED') ON CONFLICT(provider_sid) DO NOTHING RETURNING *",
                [
                  ctx.tenantId,
                  r.location_id,
                  b.CallSid,
                  /^\+[1-9]\d{7,14}$/.test(b.From) ? b.From : null,
                  seconds,
                ],
              )
            ).rows[0];
          if (call && !['BOOKED', 'CANCELLED', 'TRANSFERRED'].includes(call.outcome)) {
            await tx.query("UPDATE calls SET follow_up='REQUIRED' WHERE id=$1", [call.id]);
            await tx.query(
              "INSERT INTO leads(tenant_id,call_id,phone,reason) VALUES($1,$2,$3,'CALL_ENDED_REVIEW_REQUIRED') ON CONFLICT(tenant_id,call_id) WHERE call_id IS NOT NULL AND status='OPEN' DO NOTHING",
              [ctx.tenantId, call.id, call.caller_phone || ''],
            );
          }
        }
      },
    );
    return reply.code(204).send();
  });
  app.post('/webhooks/twilio/transfer', async (req, reply) => {
    signedTwilio(req);
    const q = z.object({ tenant: z.string().uuid(), call: z.string().uuid() }).parse(req.query),
      ctx = webhookContext(req, q.tenant),
      b = req.body as any;
    const success = b.DialCallStatus === 'completed';
    await dedup(
      ctx,
      'twilio',
      `${b.CallSid}:transfer:${b.DialCallStatus}`,
      'transfer.status',
      { success },
      async (tx) => {
        await tx.query('UPDATE calls SET outcome=$2,follow_up=$3 WHERE id=$1 AND provider_sid=$4', [
          q.call,
          success ? 'TRANSFERRED' : 'TRANSFER_FAILED',
          success ? 'NONE' : 'REQUIRED',
          b.CallSid,
        ]);
      },
    );
    const xml = new twilio.twiml.VoiceResponse();
    if (!success) xml.say('I could not reach the team. Your request has been saved for follow-up.');
    xml.hangup();
    return reply.type('text/xml').send(xml.toString());
  });
  app.get(
    '/webhooks/twilio/stream',
    {
      websocket: true,
      preValidation: async (req) => {
        const signature = String(req.headers['x-twilio-signature'] || ''),
          url = config.publicApiUrl + '/webhooks/twilio/stream';
        if (
          !validateSignature(signature, url, {}) &&
          !validateSignature(signature, url.replace(/^https:/, 'wss:'), {})
        )
          throw new DomainError('INVALID_WEBHOOK_SIGNATURE', 403);
      },
    },
    (socket, req) => connectAudio(socket, req),
  );
}
function connectAudio(socket: WebSocket, req: FastifyRequest) {
  let ctx: Context | undefined,
    callId = '',
    providerSid = '',
    streamSid = '',
    stt: WebSocket | undefined,
    ready = false,
    closed = false,
    lastMedia = Date.now(),
    lastSpeech = Date.now(),
    generation = 0,
    ttsAbort: AbortController | undefined,
    chain = Promise.resolve(),
    speaking = false;
  let lastSpeechEnd = 0;
  const turnEnds = new Map<string, number>();
  const order = new TranscriptOrder(),
    input = new AudioInput(),
    pendingMarks = new Map<
      string,
      { generation: number; review: boolean; end: boolean; transfer: boolean }
    >();
  const timer = setTimeout(() => socket.close(1008, 'Start required'), 5000);
  const limit = setTimeout(() => {
    void fail('CALL_LIMIT');
  }, config.maxCallMinutes * 60000);
  const watchdog = setInterval(() => {
    if (!ctx || closed) return;
    if (Date.now() - lastMedia > 15000) void fail('AUDIO_GAP');
    else if (!speaking && Date.now() - lastSpeech > 20000) {
      lastSpeech = Date.now();
      chain = chain
        .then(async () => {
          const r = await command(ctx!, callId, randomUUID(), { type: 'SILENCE' });
          await say(r);
        })
        .catch(() => fail('SILENCE_FAILURE'));
    }
  }, 5000);
  const send = (data: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
  };
  async function say(answer: ConversationReply, speechEndedAt?: number) {
    if (!ctx || closed) return;
    const g = ++generation;
    ttsAbort?.abort();
    ttsAbort = new AbortController();
    speaking = true;
    try {
      const pcm = await speech(answer.say, ttsAbort.signal);
      const mu = pcm24ToMuLaw8(pcm);
      for (let offset = 0; offset < mu.length; offset += 160) {
        if (closed || g !== generation) return;
        if (offset === 0 && speechEndedAt)
          req.log.info(
            { event: 'voice_first_audio', callId, speech_to_audio_ms: Date.now() - speechEndedAt },
            'First reply audio',
          );
        send({
          event: 'media',
          streamSid,
          media: { payload: mu.subarray(offset, offset + 160).toString('base64') },
        });
        await new Promise((r) => setTimeout(r, 20));
      }
      const name = randomUUID();
      pendingMarks.set(name, {
        generation: g,
        review: ['REVIEW', 'CANCEL_REVIEW', 'RESCHEDULE_REVIEW'].includes(answer.phase),
        end: !!answer.ended,
        transfer: !!answer.transfer,
      });
      send({ event: 'mark', streamSid, mark: { name } });
    } catch (e) {
      if (g === generation && !closed) await fail('SPEECH_FAILED');
    } finally {
      if (g === generation) speaking = false;
    }
  }
  async function fail(reason: string) {
    if (closed) return;
    req.log.error({ event: 'voice_failure', callId, reason }, 'Voice fallback');
    closed = true;
    generation++;
    ttsAbort?.abort();
    if (ctx && callId) {
      await command(ctx, callId, randomUUID(), { type: 'DISCONNECT' }).catch(() => {});
      await withTenant(ctx, (tx) =>
        tx.query("UPDATE calls SET follow_up='REQUIRED',outcome=$2 WHERE id=$1", [callId, reason]),
      ).catch(() => {});
      if (providerSid)
        await client()
          .calls(providerSid)
          .update({ twiml: fallback().toString() })
          .catch(() => {});
    }
    stt?.close();
    socket.close();
    cleanup();
  }
  function cleanup() {
    clearTimeout(timer);
    clearTimeout(limit);
    clearInterval(watchdog);
    ttsAbort?.abort();
    stt?.close();
  }
  async function drain() {
    for (const item of order.drain()) {
      const speechEndedAt = turnEnds.get(item.id);
      turnEnds.delete(item.id);
      chain = chain
        .then(async () => {
          if (closed || !ctx || !item.text.trim()) return;
          lastSpeech = Date.now();
          const started = performance.now();
          try {
            const result = await interpret(ctx, callId, item.text);
            const answer = result.command
              ? await command(ctx, callId, item.id, result.command, item.text)
              : { say: result.clarification!, phase: 'CLARIFY' };
            req.log.info(
              { event: 'voice_turn', callId, duration_ms: Math.round(performance.now() - started) },
              'Voice turn completed',
            );
            await say(answer, speechEndedAt);
          } catch {
            let saved = false;
            try {
              await command(ctx, callId, randomUUID(), { type: 'UNSUPPORTED' });
              saved = true;
            } catch {}
            await say({
              say:
                'I could not verify whether that request completed. Please check with the team before trying another booking. ' +
                (saved
                  ? 'Your request has been saved for human follow-up.'
                  : 'I could not save a follow-up request. Please contact the team directly.'),
              phase: 'TOOL_FAILED',
            });
          }
        })
        .catch(() => fail('VOICE_TURN_FAILED'));
    }
  }
  socket.on('message', (raw) => {
    void (async () => {
      let e: any;
      try {
        e = JSON.parse(raw.toString());
      } catch {
        socket.close(1003, 'Invalid message');
        return;
      }
      if (e.event === 'start') {
        if (ctx) return;
        clearTimeout(timer);
        const { payload } = await jwtVerify(e.start?.customParameters?.token || '', secret, {
          issuer: 'receptionist',
          audience: 'voice-stream',
          algorithms: ['HS256'],
        });
        if (
          payload.providerSid !== e.start.callSid ||
          e.start.accountSid !== config.twilioSid ||
          e.start.mediaFormat?.encoding !== 'audio/x-mulaw' ||
          e.start.mediaFormat?.sampleRate !== 8000
        )
          throw new Error('STREAM_SCOPE_MISMATCH');
        ctx = {
          tenantId: String(payload.tenantId),
          userId: 'voice',
          role: 'VOICE',
          traceId: req.id,
        };
        callId = String(payload.callId);
        providerSid = String(payload.providerSid);
        streamSid = e.start.streamSid;
        stt = new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
          headers: { Authorization: `Bearer ${config.openaiKey}` },
          handshakeTimeout: 8000,
        });
        stt.on('open', () =>
          stt!.send(
            JSON.stringify({
              type: 'session.update',
              session: {
                type: 'transcription',
                audio: {
                  input: {
                    format: { type: 'audio/pcm', rate: 24000 },
                    transcription: {
                      model: config.transcriptionModel,
                      languages: ['en'],
                      delay: 'low',
                    },
                    turn_detection: {
                      type: 'server_vad',
                      threshold: 0.55,
                      prefix_padding_ms: 300,
                      silence_duration_ms: 650,
                    },
                  },
                },
              },
            }),
          ),
        );
        stt.on('message', (raw) => {
          void (async () => {
            const event = JSON.parse(raw.toString());
            if (event.type === 'session.updated') {
              ready = true;
              const greeting = await withTenant(
                ctx!,
                async (tx) =>
                  (await tx.query('SELECT greeting FROM business_settings')).rows[0].greeting,
              );
              await say({ say: greeting, phase: 'COLLECT' });
            }
            if (event.type === 'input_audio_buffer.speech_started') {
              lastSpeech = Date.now();
              generation++;
              ttsAbort?.abort();
              speaking = false;
              send({ event: 'clear', streamSid });
            }
            if (event.type === 'input_audio_buffer.speech_stopped') lastSpeechEnd = Date.now();
            if (event.type === 'input_audio_buffer.committed') {
              turnEnds.set(event.item_id, lastSpeechEnd || Date.now());
              order.commit(event.item_id);
              await drain();
            }
            if (event.type === 'conversation.item.input_audio_transcription.completed') {
              order.complete(event.item_id, event.transcript);
              await drain();
            }
            if (event.type === 'conversation.item.input_audio_transcription.failed') {
              order.complete(event.item_id, '');
              await drain();
              await say({
                say: 'I did not catch that. Could you repeat it slowly?',
                phase: 'CLARIFY',
              });
            }
            if (event.type === 'error') await fail('TRANSCRIPTION_ERROR');
          })().catch(() => fail('TRANSCRIPTION_ERROR'));
        });
        stt.on('error', () => void fail('TRANSCRIPTION_CONNECTION_FAILED'));
        stt.on('close', () => {
          if (!closed) void fail('TRANSCRIPTION_DROPPED');
        });
      } else if (e.event === 'media' && ready && stt?.readyState === WebSocket.OPEN) {
        lastMedia = Date.now();
        const audio = Buffer.from(e.media?.payload || '', 'base64');
        if (audio.length > 1600) throw new Error('AUDIO_FRAME_TOO_LARGE');
        stt.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: input.convert(audio).toString('base64'),
          }),
        );
      } else if (e.event === 'mark') {
        const mark = pendingMarks.get(e.mark?.name);
        pendingMarks.delete(e.mark?.name);
        if (mark && mark.generation === generation && ctx) {
          if (mark.review) await markReadbackPlayed(ctx, callId);
          if (mark.transfer) {
            await transferCall(ctx, callId, providerSid);
            closed = true;
            cleanup();
          }
          if (mark.end) {
            closed = true;
            await client().calls(providerSid).update({ status: 'completed' });
            cleanup();
          }
        }
      } else if (e.event === 'stop') {
        closed = true;
        if (ctx) await command(ctx, callId, randomUUID(), { type: 'DISCONNECT' }).catch(() => {});
        cleanup();
      }
    })().catch(() => fail('STREAM_ERROR'));
  });
  socket.on('error', () => void fail('SOCKET_ERROR'));
  socket.on('close', () => {
    cleanup();
    if (!closed && ctx)
      void command(ctx, callId, randomUUID(), { type: 'DISCONNECT' }).catch(() => {});
    closed = true;
  });
}

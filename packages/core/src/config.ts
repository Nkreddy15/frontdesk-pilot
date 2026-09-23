import dotenv from 'dotenv';
import { resolve } from 'node:path';
dotenv.config({ path: resolve(process.cwd(), '.env'), quiet: true });
const flag = (key: string) => process.env[key] === 'true';
export const config = {
  production: process.env.NODE_ENV === 'production',
  host: process.env.API_HOST || '127.0.0.1',
  port: Number(process.env.API_PORT || process.env.PORT || 4000),
  dashboardOrigin: process.env.DASHBOARD_ORIGIN || 'http://localhost:3000',
  publicApiUrl: process.env.PUBLIC_API_URL || '',
  databaseUrl: process.env.DATABASE_URL || '',
  databaseSSL: flag('DATABASE_SSL'),
  devAuth: flag('DEV_AUTH_ENABLED'),
  devToken: process.env.DEV_AUTH_TOKEN || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  encryptionKey: process.env.TOKEN_ENCRYPTION_KEY || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  openaiKey: process.env.OPENAI_API_KEY || '',
  intentModel: process.env.OPENAI_INTENT_MODEL || 'gpt-5.6-luna',
  transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-live-transcribe',
  ttsModel: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
  ttsVoice: process.env.OPENAI_TTS_VOICE || 'coral',
  twilioSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioPhone: process.env.TWILIO_PHONE_NUMBER || '',
  messagingService: process.env.TWILIO_MESSAGING_SERVICE_SID || '',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  googleRedirect: process.env.GOOGLE_REDIRECT_URI || '',
  testCallers: (process.env.VOICE_TEST_CALLER_ALLOWLIST || '').split(',').filter(Boolean),
  liveVoice: flag('LIVE_VOICE_ENABLED'),
  sms: flag('SMS_ENABLED'),
  calendar: flag('CALENDAR_ENABLED'),
  maxConcurrentCalls: Number(process.env.MAX_CONCURRENT_CALLS || 5),
  maxCallMinutes: Number(process.env.MAX_CALL_MINUTES || 8),
  monthlyMinuteLimit: Number(process.env.MONTHLY_MINUTE_LIMIT || 300),
  workerTenants: (process.env.WORKER_TENANT_IDS || '').split(',').filter(Boolean),
};
export function validateConfig() {
  if (!config.databaseUrl)
    throw new Error(
      'DATABASE_URL is required. Run npm run setup:local or configure a managed database.',
    );
  if (config.sessionSecret.length < 32)
    throw new Error('SESSION_SECRET must be at least 32 characters.');
  if (config.production && config.devAuth)
    throw new Error('Development authentication is forbidden in production.');
  if (config.production && (!config.supabaseUrl || !config.supabaseAnonKey))
    throw new Error('Production requires Supabase authentication.');
  if (config.production && !config.databaseSSL)
    throw new Error('Production database TLS is required.');
  if (
    config.production &&
    (!config.dashboardOrigin.startsWith('https://') || !config.publicApiUrl.startsWith('https://'))
  )
    throw new Error('Production requires explicit HTTPS dashboard and API URLs.');
  if (config.production && !/^[a-f0-9]{64}$/i.test(config.encryptionKey))
    throw new Error('Production requires a 32-byte hex token encryption key.');
  if (
    config.production &&
    (!config.workerTenants.length ||
      config.monthlyMinuteLimit <= 0 ||
      config.maxConcurrentCalls <= 0)
  )
    throw new Error('Configure worker tenants and positive voice spending limits.');
  if (process.env.RECORDING_ENABLED === 'true')
    throw new Error('Recording is not enabled in this release.');
}

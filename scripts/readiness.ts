import { readFile } from 'node:fs/promises';
import { config, validateConfig } from '../packages/core/src/config.js';
import {
  pool,
  usingWasm,
  verifyRuntimeDatabase,
  withTenant,
  type Context,
} from '../packages/core/src/db.js';
const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });
try {
  try {
    validateConfig();
    check('Configuration syntax', true, 'Validated; credentials are never printed.');
  } catch (e) {
    check('Configuration syntax', false, (e as Error).message);
  }
  check(
    'Native PostgreSQL',
    !usingWasm,
    'Production and multi-process concurrency require native PostgreSQL.',
  );
  if (!usingWasm) {
    try {
      await verifyRuntimeDatabase();
      check(
        'Database role and constraint',
        true,
        'Runtime role does not own tables or bypass RLS; exclusion constraint exists.',
      );
    } catch {
      check(
        'Database role and constraint',
        false,
        'Cannot verify the runtime role and exclusion constraint.',
      );
    }
  }
  check(
    'Development access disabled',
    !config.devAuth,
    'Disable DEV_AUTH_ENABLED before public deployment.',
  );
  check(
    'HTTPS URLs',
    config.publicApiUrl.startsWith('https://') && config.dashboardOrigin.startsWith('https://'),
    'Supply the actual deployed API and dashboard URLs.',
  );
  check(
    'Supabase authentication configuration',
    !!config.supabaseUrl && !!config.supabaseAnonKey,
    'Configuration only; real sign-in still needs a smoke test.',
  );
  check(
    'OpenAI configuration',
    !!config.openaiKey,
    'Configuration only; verify model access, latency, and spend caps.',
  );
  check(
    'Twilio configuration',
    !!config.twilioSid && !!config.twilioToken && !!config.twilioPhone,
    'Configuration only; verify signed inbound call and message callbacks.',
  );
  check(
    'Google configuration',
    !!config.googleClientId && !!config.googleSecret && !!config.googleRedirect,
    'Configuration only; owner OAuth and event synchronization must be exercised.',
  );
  // Evidence must refer to tests actually run; editing this file is not testing.
  const evidence = JSON.parse(
    await readFile(process.env.RELEASE_EVIDENCE_FILE || 'ops/release-evidence.json', 'utf8').catch(
      () => '{}',
    ),
  );
  for (const name of [
    'nativeConcurrency',
    'browserE2E',
    'liveVoiceEvaluation',
    'googleRoundTrip',
    'smsConsentDeliveryOptOut',
    'humanTransfer',
    'supabaseSignIn',
    'backupRestore',
    'attorneyReview',
    'ownerCatalogApproval',
  ]) {
    const item = evidence[name];
    check(
      'Release evidence: ' + name,
      item?.passed === true &&
        typeof item?.artifact === 'string' &&
        !!item?.reviewedBy &&
        !!item?.date,
      'Requires dated evidence, artifact reference, and named reviewer. A declaration alone is not validation.',
    );
  }
  if (!usingWasm)
    for (const tenantId of config.workerTenants) {
      const ctx: Context = { tenantId, userId: 'readiness', role: 'WORKER', traceId: 'readiness' };
      try {
        await withTenant(ctx, async (tx) => {
          const s = (await tx.query('SELECT * FROM business_settings')).rows[0];
          const c = (await tx.query('SELECT status,last_synced_at FROM calendar_connections'))
            .rows[0];
          check(
            'Business ' + tenantId,
            !!s &&
              s.transfer_enabled &&
              /^\+[1-9]\d{7,14}$/.test(s.transfer_number) &&
              !s.recording_enabled,
            'Requires real transfer number and recording disabled.',
          );
          check(
            'Calendar ' + tenantId,
            c?.status === 'CONNECTED' && Date.now() - new Date(c.last_synced_at).getTime() < 300000,
            'Last successful synchronization must be within five minutes.',
          );
          check(
            'Calendar exceptions ' + tenantId,
            !(await tx.query('SELECT 1 FROM sync_exceptions WHERE NOT resolved LIMIT 1')).rowCount,
            'Resolve calendar exceptions before accepting calls.',
          );
        });
      } catch {
        check('Business database ' + tenantId, false, 'Database setup could not be verified.');
      }
    }
} finally {
  await pool.end();
}
console.log(
  JSON.stringify(
    { checkedAt: new Date().toISOString(), ready: results.every((r) => r.pass), checks: results },
    null,
    2,
  ),
);
process.exitCode = results.every((r) => r.pass) ? 0 : 1;

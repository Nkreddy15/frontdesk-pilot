# Security and legal review checklist

This is an implementation checklist and a set of unresolved review obligations, not a guarantee of security or legal compliance.

## Implemented controls

- Server-side secrets only; generated local credentials excluded from archives/source control. HTTPS and validated database TLS required in production. OAuth refresh/access tokens encrypted with AES-256-GCM; key rotation/re-encryption is an operator migration, not yet automated.
- Supabase password verification against provider JWT JWKS, then a short application session with HttpOnly/Secure/SameSite cookie. Trusted tenant metadata and database membership checked; no client-selected tenant. OWNER/STAFF/VIEWER roles. Staff API scope is constrained; owner dashboard is the pilot UI.
- Separate migration/runtime DB roles, FORCE RLS, composite tenant foreign keys, protected claims/audit tables. Runtime startup rejects table ownership and superuser/BYPASSRLS.
- Strict Zod request/command schemas, parameterized SQL, body/frame size limits, login/API rate limits, request origin/CSRF checks, signed Twilio callbacks and Google channel/token/resource verification. The canonical URL must be exercised behind the real proxy.
- Model sees limited catalog/context and untrusted caller text. It extracts only a schema-constrained command. Server validates listed IDs, phase, permissions, version, hold token, service snapshot, schedules and inventory. The model cannot author arbitrary SQL, arbitrary network tool URLs, prices or booking-confirmation speech.
- Verification reference plus callback number required for caller changes/cancellation, bounded attempts, no appointment lookup from ANI alone. Reference delivery/recovery and stronger identity checks need evaluation for the chosen niche.
- Outbox/inbox deduplication; uncertain SMS sends stopped; recordings prohibited; consent and opt-out checks before messaging; minimization and retention jobs. Readiness is explicit about unverified providers.

## Before public access

- Independent security review of authorization/RLS and voice/provider boundaries; penetration test against staging. Local tests are not an audit certificate.
- Test least-privilege Supabase configuration, revoked membership, JWT rotation, wrong tenant/customer/call/job IDs and cross-resource access. MFA, password reset and invite UX are future work; configure provider account protection and an owner recovery procedure now.
- Review CSP for the Next.js app, security headers on public services, brute-force limits through the reverse proxy, WebSocket connection limits, dependency scan and lockfile/image pinning. Production images supplied here have not been built/scanned.
- Verify secrets never appear in client bundles, build logs, exception messages, URLs, transcripts or backups shared with support. Never collect card numbers; interrupt and direct to a reviewed payment channel. Do not ask for medical/legal sensitive details.
- Establish breach/incident reporting, access reviews, deletion tracking, backup access, key rotation and provider DPAs. Do not enable multi-tenant self-signup before a dedicated tenant-isolation review.

## Qualified US attorney review required

1. Federal and relevant state interception, recording and transcription consent rules, including calls involving parties in different states. Recording remains disabled; that does not remove transcription obligations.
2. AI disclosure and applicable state/local AI, impersonation and consumer-protection requirements; truthful marketing of capabilities and limitations.
3. TCPA, FCC rules, state mini-TCPA laws, transactional SMS consent, opt-out/help behavior, number registration, carrier rules, reassigned numbers, quiet hours and consent evidence. Carrier acceptance alone is not legal compliance.
4. Privacy notice, data-controller/processor roles, retention/deletion/access rights, provider/subprocessor disclosures, cross-border transfers, security promises and breach duties.
5. Pilot agreement: scheduling authority, human supervision, service limits, availability/backup claims, liability, support hours, incident contacts, cancellation/termination, data ownership/export/deletion and use of evaluation samples.
6. Emergency language and refusal/transfer scripts, accessibility and vulnerable callers. This is not an emergency service, healthcare system, diagnostic service or legal adviser.
7. Contract enforceability, tax/billing terms and risk allocation for missed bookings, outages, unauthorized direct calendar writes and third-party failures.

No legal review has been performed. Use synthetic founder calls until reviewed business consent and pilot terms are in place.

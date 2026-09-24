# Implementation status — 2026-09-24

**Local pilot implementation, not a production launch.** No external voice, messaging, or calendar service was activated. No real customer messages, calendar bookings or telephone calls were sent. The source is in the founder's private `Nkreddy15/frontdesk-pilot` repository; no public application URL exists.

## Completed implementation

- TypeScript monorepo, Next.js owner dashboard, persistent Fastify API and outbox worker.
- Four PostgreSQL migrations, fictional seed, managed/native role separation, RLS and database audit triggers.
- Central holds/book/confirm/reschedule/cancel/completed/no-show/block operations; staff and bay exclusions include service buffers; version and idempotency safeguards; post-commit outbox.
- Owner daily/weekly/list views, availability, booking/conflict dialogs, customers/history/consent, call transcripts/summaries/tool history/leads, calendar exceptions, delivery status/retry, audit log, catalog/hours/staff/knowledge/behavior settings and defined metrics.
- Deterministic receptionist controller and database-backed lab; full readback gating, conflict alternatives, corrections, verified caller changes, drop/recovery and bounded fallback.
- OpenAI/Twilio/Google adapters, encrypted tokens, signed webhooks, deduplication, delivery uncertainty handling, calendar reconciliation, transcription permission and disabled recording. **Adapters await actual account tests.**
- Retention and customer redaction with request tombstones; secure startup checks; local Docker and production container definitions; native CI workflow; provisioning and readiness commands; deployment/incident/backup/legal-review runbooks.

## Actual verification

| Check | Observed result | Evidence / limitation |
|---|---|---|
| Unit, SQL integration, API, controller, provider-failure and recovery suite | 33 passed; 0 failed; 2 explicitly skipped | `evidence/test-results.txt`; PostgreSQL-WASM engine, serialized transactions |
| 50 simultaneous application requests | 1 confirmed, 49 conflict responses with 3 alternatives | Passed under serialized WASM; **does not satisfy native concurrency proof** |
| Native two-process concurrency, 100×50 | Passed | GitHub Actions run `36018465935`, job `native-postgres`; one confirmation and 49 conflicts per round |
| Native transaction visibility for outbox | Passed | Same PostgreSQL CI job |
| TypeScript | Passed | `evidence/typecheck.txt` |
| Production dashboard build | Passed using Webpack | `evidence/build.txt`; Turbopack cache panic led to supported Webpack build configuration |
| Local setup/migration/seed | Passed | `evidence/local-setup.txt`; explicit data directory evaluated after environment loading |
| Dashboard/API HTTP smoke | Passed | `evidence/http-smoke.json`; actual HTTP login/proxy/book/replay/conflict/cancel/metrics/audit, no rendered-browser claim |
| Dependency audit, production dependencies | 0 reported vulnerabilities at check time | `evidence/dependency-audit.json`; not a security audit of application code |
| Browser interactions and screenshots | Synthetic browser E2E passed | Same PostgreSQL CI job; browser evidence uploaded as a GitHub Actions artifact. This did not verify external provider calls. |
| Release readiness | NOT READY, as intended | `evidence/readiness.json` lists missing accounts, native evidence and reviews |

## Not yet verified or finished

Actual model availability and audio quality/latency; Twilio pickup/transfer and SMS delivery/STOP/HELP; Google OAuth/refresh/watch/round-trip/failure recovery; Supabase login/JWKS and tenant claims; Docker image builds; Render deployment; real alert delivery; independent security/legal review; backup restore/RPO/RTO. Monitoring queries/events exist, but alert/error-reporting destinations are not connected. Real voice evaluation recordings/results do not exist yet. The first-start Docker health race and owner schedule SQL ambiguity discovered during the founder's Mac setup were fixed in `520b2e8`. GitHub Actions run `36048144339` passed a fresh Compose startup, role repair on a reused volume, all native tests, and an authenticated browser check of the schedule API. The founder's previously downloaded ZIP still contains the older source until updated locally.

The first voice bridge buffers TTS before sending it. It must meet the measured speech latency gate or be improved before a paid pilot. The application cannot guarantee instant conflict prevention against unobserved direct Google writes. Booking entry must be central, and the owner must agree to that rule.

Staff-specific UI, public website booking, arbitrary customer/service changes to an existing appointment, self-service tenant onboarding, subscriptions, MFA/invite/reset UX, generalized multi-calendar busy-interval union and multi-location resource moves are not implemented. These limits are explicit in DECISIONS and the backlog.

## Next external milestone

No external provider accounts have been supplied. Native CI and synthetic browser E2E passed on the private repository. Next, supply actual business data and securely configure hosting, managed PostgreSQL/Supabase, OpenAI, Twilio and Google OAuth accounts. Run controlled founder calls using synthetic data. Complete owner/counsel review, provider validation, monitoring and restore gates before routing customer calls. Do not put credentials in chat.

A detailed next-stage two-founder plan is in `docs/NEXT_STEPS.md`. The original 24-section business/architecture plan is preserved in `docs/DECISION_PLAN.md` and should be read as a proposal, not an implementation test report.

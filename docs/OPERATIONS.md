# Operations, alerts and recovery

## Observable signals

The API emits structured Fastify JSON with request IDs. Tenant-scoped transactions carry `app.tenant_id`, `app.actor`, and `app.trace`; appointment triggers copy these into audit records. Request bodies, authorization headers, cookies, OAuth codes/tokens and transcripts are not written to normal server logs. Provider error codes are retained without raw provider payloads. Call and job IDs link the dashboard to server events. Store logs in a restricted managed sink with an agreed short retention period.

`voice_turn.duration_ms` measures intent plus controller time. `voice_first_audio.speech_to_audio_ms` measures server-observed end-of-speech to the first audio frame sent, **not acoustic telephone latency**. Measure audible response with a real call evaluator. `voice_failure` includes a classified reason and call ID. Tool executions persist duration, sanitized argument hashes and authoritative results. `ops/health.sql` supplies queue age, tool percentiles, calendar exceptions and overlap checks in a tenant-scoped session.

| Signal | Initial alert / review target | Response |
|---|---|---|
| API readiness | 2 consecutive failed checks, 30s apart | Human routing; check DB and process health |
| Connection failures / dropped audio | ≥2 in 10 minutes or >2% daily | Disable AI routing; examine provider/WebSocket events and audio-gap watchdog |
| Speech latency | p50 ≤1.5s, p95 ≤2.5s **target**, not measured | Profile transcription, intent, TTS and network separately; stop pilot if usability fails |
| Booking API latency | p95 ≤750ms at pilot load; contention separately measured | Query/lock inspection; keep transactions short |
| Tool latency/timeouts | p95 ≤1s deterministic tools; ≥2 timeouts in 10min | Check DB pool/locks; retain request key; verify result before retry |
| Booking success / conflicts | Daily funnel; conflicts are valid outcomes, not automatically incidents | Check alternatives and owner/AI collision rate; investigate sudden spikes |
| Incorrect confirmation | Any occurrence | Immediate stop, incident review, reconcile affected customer |
| Overlapping active resource claims | Must always be 0 | Immediate stop; forensic DB/schema review |
| Duplicate events | Count inbox dedup hits and duplicate request keys | Expected retries should be harmless; investigate repeated storms |
| Outbox lag | Oldest due job >2 minutes | Worker health, blocked credentials/consent, provider outage |
| UNKNOWN message | Any | Look up provider message and callback; do not click resend blindly |
| Google lag | Last good sync >5 minutes; any unresolved exception | Pause affected pilot booking, reconcile; never cancel valid central booking automatically |
| SMS failed/undelivered | Any during pilot | Review carrier/provider status and consent; owner follows up through an approved channel |
| Human-transfer failures | Any | Confirm destination is staffed; provider fallback; lead follow-up |
| Hallucination / incorrect-action rate | 0 critical factual/action errors; manually review sampled calls with consent | Correct catalog or extraction/controller; rerun evaluation before enabling |
| Cost | Daily minutes, estimated cost/call and booked-call cost; invoice reconciliation weekly | Minute ceiling and provider spend alerts; adjust plan before overage |

These alert thresholds are a specification. A managed alert destination and error-reporting service are **not connected**. Before launch, configure API readiness alerts, log-derived errors/latencies, queue/calendar monitors and an on-call recipient, and trigger each alert deliberately. Dashboard counters alone are not unattended monitoring. Founder support is staffed hours only until an actual rota exists.

## Delivery semantics

Jobs are inserted in the booking transaction; another native database connection cannot read them before commit. Claims use a tenant lock briefly, `FOR UPDATE SKIP LOCKED`, a unique lease owner, a 90-second lease and heartbeat. Jobs for one appointment cannot overlap; calendar jobs serialize within a tenant. One worker is the pilot operating policy.

A retryable calendar failure has bounded exponential backoff and an eventual terminal failure. Google IDs are deterministic. Repeated messages are more dangerous: a timeout after submission becomes UNKNOWN; an expired in-flight SMS lease also becomes UNKNOWN. A verified callback can resolve uncertainty. An HTTP error that is definitely retryable is retried; known rejection is FAILED/BLOCKED. `Retry` in the owner dashboard only permits FAILED/BLOCKED, never UNKNOWN.

A lease cannot retroactively cancel a provider request that has already left the process. After an outage or lost lease, reconcile Google against the latest database version. Do not sell an exactly-once external-delivery guarantee. The database booking and its audit/outbox commit are the strong boundary.

## Calendar incident

Keep the database appointment. Review the exception and owner-entered Google event. If the central appointment should change, use the normal dashboard operation and inform the customer only after commit. Cancellations remain available while paused; rescheduling waits until the calendar exception is resolved and booking resumes. If the calendar should match the booking, request Restore database version. For a foreign event, fix it or change central bookings, then request Recheck Google. The worker fetches fresh provider data and clears the exception only when it reconciles. Resume booking in Settings only after all exceptions are resolved. A successful booking whose mirror write failed remains confirmed; the caller is not told it failed to book.

The app-created calendar is intentionally narrow. Existing primary-calendar events are outside scope. Overlapping unmanaged busy events are conservatively treated as exceptions; normalization/union across multiple imported calendars is a later feature.

## Backup and restore drill

Use encrypted provider backups and a separate access policy. Keep restore credentials outside application runtime. A custom-format `pg_dump` plus tested `pg_restore` is a portable additional backup, not PITR. Do not paste database URLs with passwords into shared shell histories; use protected PostgreSQL service files/environment injection. Never attach production dumps to this repository or this project's source archive.

1. Record schema version, backup timestamp, encryption-key version and last known provider reconciliation point. Verify the backup completed and alerts fire on failure.
2. Restore into a **new isolated database**, not over the running one. Keep all live provider flags false and block webhook/network delivery. Recreate the runtime role and permissions. Preserve migration history and cryptographic keys needed for existing encrypted refresh tokens; otherwise reconnect OAuth.
3. Verify tenant/RLS behavior, exclusion constraint, row counts, recent confirmed appointments, audit history and reservation projections. Run the booking invariant query. Exercise a synthetic booking/conflict/cancel on the restored copy.
4. Mark ambiguous SMS jobs UNKNOWN; reconcile against provider message SIDs/callbacks before any retry. Rebuild Google projections from current database state. Apply deletion tombstones again so restored PII is not reintroduced into service.
5. Measure actual RPO/RTO. Have the owner review the recovered schedule. Only then cut over and enable providers. Save evidence and reviewer identity.

Use a bounded backup retention period agreed with the business. Deletion requests should expire from backups according to that schedule; document legal holds and residual provider records rather than claiming immediate erasure everywhere. [PostgreSQL backup tooling](https://www.postgresql.org/docs/17/app-pgdump.html), [restore tooling](https://www.postgresql.org/docs/17/app-pgrestore.html).

## Data export and deletion

Owner-only endpoints export a customer profile, appointments and consent history. Deletion refuses while the customer has HELD/CONFIRMED appointments: resolve them through the API first. It redacts the profile and terminal appointment notes, removes linked transcripts/tool results/leads/consent evidence, and replaces cached booking responses with tombstones. Idempotency keys/hashes remain so an old retry cannot create another appointment. Booking metadata and minimized audit history remain. A minimal phone suppression entry is intentionally retained to prevent future messaging without a new reviewed consent process.

The application purges old ended-call transcripts/workflows/tool results after the configured 1–90 days and closed leads after 1–365 days. Cached mutation results become 410 tombstones after 90 days. Open leads and appointment history require an owner retention policy and periodic review. Backups, Twilio call/message metadata, OpenAI processing retention, Auth records and any exported files are separate deletion tasks. Record completion and retention exceptions; never promise that the API erases third-party records.

## Deployment interruption

Render can close WebSockets when replacing a process. Announce a maintenance window, direct new calls to a human and wait for active calls to finish where possible. A dropped caller's confirmed appointment survives. If no reliable booking receipt reached the caller, the owner checks the database and follows up; no automatic second booking. Leases/holds recover independently of the voice connection. Provider-side fallback routing remains essential when the whole application is down.

## Metric definitions

Answered phone calls are telephone records with positive duration or an accepted AI session. Human transfers are recorded successful transfer outcomes. Closed unconverted leads use the owner's CLOSED status; they are an operational proxy, not proven lost revenue. Current queue failures include FAILED/UNKNOWN. Voice cost is a planning allowance of $0.20 per phone minute, not a measured provider bill. Cost per phone booking divides that allowance by telephone BOOKED outcomes, excluding simulator bookings. All ROI claims require owner-verified outcomes and actual invoices.

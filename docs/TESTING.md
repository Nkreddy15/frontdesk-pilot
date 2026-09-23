# Test strategy and launch acceptance

Current observed results are in STATUS and evidence/. A supplied test file is not a passed test. Fake provider handlers test failure logic only; they do not verify provider accounts or network behavior.

## Automated coverage

- SQL integration: commits, two resource claims, buffers, half-open endpoints, holds/expiry, revalidation, rollback on failed move, direct exclusion enforcement, tenant isolation and protected writes.
- API contract/security: strict fields, auth, origin, CSRF, OWNER/VIEWER permissions, version conflicts, HTTP status preservation, idempotent replay/payload mismatch.
- Controller: no confirmation before commit, complete review before telephone acceptance, owner wins a slot, correction releases holds, dropped-call lead, verified cancellation, unpublished knowledge refusal, ended-call replay boundary.
- Provider boundaries: codec math/order, token tamper protection, signed duplicate callbacks/monotonic delivery, ambiguous SMS no-resend, disabled service blocking, external calendar conflicts/deletions and simulated 410 full reconciliation.
- Recovery: deleting active customer prohibited; terminal PII redaction with dedup tombstones; unresolved calendar conflict blocks unpause; one in-flight appointment job; stale data never silently overwrites booking state.
- HTTP smoke: actual Next document and proxy, local login cookie, create/replay/conflict/cancel/operations over localhost. This is not browser rendering.
- Native gate: 100 rounds × 50 requests across two API processes using native PostgreSQL. Per round: exactly one 201, forty-nine 409 SLOT_CONFLICT with three fresh options, exactly one confirmed database row, no duplicate claims/messages/audit state. Cancel the winner between rounds. The harness skips this gate and announces why.
- Browser script: owner login, dashboard, real DB-backed receptionist lab, race UI, calls/operations/customers/settings, manual booking, mobile overflow and screenshots. Supplied but unrun successfully in this environment.

## Voice evaluation matrix

`voice-cases.json` is a reusable scenario checklist, not recorded audio or a claimed evaluation result. Recruit consenting speakers and use synthetic customer data. Include at least 10 speakers and ≥200 calls, with at least 50 adverse scenarios. Do not label an accent “passed” after a single recording. Score task completion, factual accuracy, exact captured details, interruptions, harmful/unsupported responses, booking audit truth, transfer behavior, and latency.

Use real telephone paths for accents, fast/slow speech, background traffic, low-volume speakers, spelled surnames, near-homophones, digit corrections, “next Tuesday,” AM/PM ambiguity, daylight-saving transitions, interruption during readback, tool timeout, provider disconnect, anger, unsupported advice and emergency language. Check both buyer and employee comprehension of the full date/time/timezone/callback readback.

## Measurable real-pilot gates

| Area | Required outcome |
|---|---|
| Booking invariant | Zero overlapping active claims; native 100×50 gate passes with required status counts |
| False confirmations | Zero spoken/visible confirmations without a committed matching receipt; zero duplicate appointments from retry tests |
| Correct actions | 100% of adversarial cancel/reschedule cases require verification and the intended state transition; no unauthorized action |
| Routine voice tasks | ≥95% correct supported task completion in the scored set; all failed cases captured for human follow-up where contact is known |
| Critical facts | 100% spoken price/policy/hour statements traceable to approved catalog/knowledge; no invented facts |
| Consent | 100% tested calls disclose AI; no transcript/audio streaming before affirmative configured permission; no SMS without written/web evidence; STOP blocks further sends |
| Latency | Target p50 ≤1.5s and p95 ≤2.5s end-of-speech to audible reply; report actuals, sample size and pipeline version |
| Telephone reliability | ≥98% test calls connect successfully; <2% unexplained drops; watchdog and human fallback exercised |
| Human handoff | 100% requested transfers reach the configured staffed target or create a clearly flagged follow-up; test busy/no-answer/outage |
| Calendar | Normal changes converge within 2min during test; lag alert at 5min; direct edits/deletes and 410 recovery never cancel central bookings |
| Messaging | Real delivered/failed callbacks exercised; duplicate callbacks cause no duplicate state effect; ambiguous submission never automatically resent |
| Browser | Desktop and mobile owner flows pass; keyboard focus/labels and modal escape/focus restoration reviewed; zero uncaught browser errors |
| Security | Tenant/role tests pass, invalid signatures rejected, secret scan/audit pass, independent review has no unresolved critical/high issue |
| Recovery | Restore drill meets agreed actual RPO/RTO; ambiguous deliveries reconciled before reopening |
| Operations | Alerts deliberately fired and received; named on-call person and owner fallback confirmed; actual provider invoice/usage reconciled |

A missed latency or routine-completion target is not fixed by hiding it. Narrow the script/service catalog or change the voice pipeline and re-evaluate. No customer should be the first audio, OAuth or restore test.

## Milestone definition of done

1. **Booking foundation:** schema, source-of-truth API and local invariant/security tests pass. Native gate remains a separate blocker until actually run.
2. **Owner pilot workflow:** create/move/cancel/block and service/hours/lead operations exercised through API; production build passes; browser E2E/visual review must still pass before sign-off.
3. **Conversation controller:** all supported state transitions and adverse outcomes tested against actual DB calls; no unconstrained model confirmation. Live acoustic behavior is a separate gate.
4. **Provider integration:** real Twilio call/transfer, Google OAuth round trip and SMS consent/delivery/STOP observed with stored evidence. Code completion alone does not satisfy this milestone.
5. **Paid pilot:** all release gates, agreement, actual catalog, staffed fallback, cost ceiling, alerts and restore complete; one location only.
6. **Production SaaS:** repeated successful pilot outcomes, independently reviewed isolation/security, onboarding/billing/support capability, measured capacity/recovery and multi-business tests. This stage is not complete.

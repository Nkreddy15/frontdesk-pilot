# Two-founder completion plan

The original 24-section decision plan contains strategy, cost assumptions, niche, pricing, sales, pilot terms and roadmap. This checklist reflects the actual implementation and unfinished verification, not a second speculative build plan.

| Week | Founder A — product/owner/voice | Founder B — platform/integrations | Definition of done |
|---|---|---|---|
| 1 | Confirm fixed-location detailing pilot, real catalog and schedules; owner reviews dashboard | Connect git and native staging DB; run CI including 100×50 concurrency and browser E2E; review schema/security | One owner can create/move/cancel/block on staging; all core gates pass on native PG |
| 2 | Approve greeting, FAQs, transfer hours and counsel-reviewed consent/pilot agreement | Configure Supabase, Twilio, OpenAI and Google; real signed webhooks, OAuth/token refresh, SMS/STOP/HELP | Dated real provider receipts and no fabricated outcomes |
| 3 | Run ≥200 scored synthetic calls with consenting speakers; revise usability and scripts | Optimize measured audio latency, outage/duplicate/retry tests, alerts and restore drill | Measurable voice/security/recovery gates pass; clear any high-severity issue |
| 4 | Begin staffed one-location pilot, review owner outcomes daily, compare saved bookings and follow-up workload | Track latency/error/cost, fix operational failures, maintain fallback and daily reconciliation | Owner agrees value exceeds price; zero integrity incidents; actual usage cost known |
| 5–6 | Review willingness to pay, support minutes and missed-call ROI; recruit similar businesses only | Harden onboarding, staff UI, retention and reporting from observed needs | Repeatable onboarding and at least two referenceable successful pilots before general SaaS |

This is an estimate, not a promise to launch in four weeks. Calendar verification, SMS registration, counsel review or poor voice results can extend it. Run the first actual calls before selling the technology as production-ready.

## Prioritized remaining backlog

**Must before customer calls:** native concurrency CI; rendered browser/mobile/accessibility checks; real provider/consent/transfer tests; scored audio evaluations; exact business data; secure prod Auth and tenancy review; staffed human fallback; alerts; restore drill; signed pilot terms; secrets in managed storage; actual provider usage reconciliation.

**Should after a successful supervised pilot:** streaming TTS if latency measurements justify it; richer booking edits/customer corrections; stronger identity/recovery flow for caller changes; staff-facing UI; account invitation/reset/MFA UX; external busy-interval union; better message-uncertainty reconciliation; retention/deletion review UI; per-tenant worker discovery instead of explicit environment list.

**Could after repeatable customer success:** a public website booking form through the same domain API; customer self-service appointment management; more calendar scopes after review; extra languages, locations and capacity rules; business-owner billing/usage portal.

**Not Now:** arbitrary workflow builder, autonomous unsupervised outbound calling, medical/legal workflows, taking card numbers on calls, custom cloned voices, microservice fleet, replacing deterministic scheduling with a reasoning model, or multi-calendar distributed booking promises.

## Decision to continue

Continue only if one owner uses the central dashboard, supplies accurate rules, staffs escalation, accepts the calendar authority model and will pay enough to cover voice usage and support. Pause if voice accuracy/latency fails the launch gates, the owner refuses central booking entry, support consumes most subscription revenue, or value cannot be measured against existing missed-call handling. A working demo is not proof of a viable SaaS.

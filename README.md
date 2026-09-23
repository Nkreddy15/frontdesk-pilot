# Frontdesk — AI receptionist pilot

A working local booking application and owner dashboard, with provider adapters prepared for activation. **This repository is not approved for production traffic.** Native PostgreSQL contention, browser interaction, real telephone audio, authentication, calendar synchronization, SMS delivery, and recovery still need the release checks in [STATUS.md](STATUS.md).

The fictional seed is **Harbor Detail · Demo**, a fixed-location detailing business in `America/New_York`. Replace it with owner-approved data before a real pilot. No external account, paid service, public deployment, customer message, or telephone call was created during this build.

## What is implemented

- Next.js owner dashboard: daily/weekly/list schedule, create/reschedule/cancel, staff time off and bay blocks, customer history and consent evidence, calls/transcripts/leads, provider jobs, audit trail, service/hours/knowledge/behavior settings.
- One Fastify booking API for the dashboard and voice controller; PostgreSQL exclusions prevent overlapping staff **and** bay allocations, including service buffers.
- Atomic 120-second holds, revalidation, version checks, idempotent retries, database audit triggers, and transactional outbox. Confirmation is returned only after commit.
- Deterministic conversation controller with a lab that exercises actual booking transactions. It includes readback, correction, conflict alternatives, verified cancellation/rescheduling, dropped-call leads, unsupported questions and human handoff.
- Twilio signed webhooks and bidirectional media; OpenAI transcription, strict intent extraction and speech; Google OAuth, polling/push sync and conflict recovery; consent-gated SMS and opt-out suppression. **Adapters are not live-verified.**
- Runtime tenant isolation, role checks, CSRF, strict inputs, token encryption, transcript retention, customer export/redaction, secret redaction and safe delivery ambiguity handling.

## Run locally

Use Node.js 24 LTS and Docker Compose v2. The scripts never print generated access codes or passwords.

```sh
npm ci
npm run setup:docker
npm run dev
```

Open `http://localhost:3000`. Read the generated **local-only** access code from `.local/owner-access-code.txt` and enter it in the login form. The API listens on `127.0.0.1:4000`. The database listens on `127.0.0.1:55432`. Keep `.env`, `.local`, and customer data out of git.

`setup:docker` refuses to overwrite an unrelated configured database. Use a clean checkout to switch from the WASM demonstration to native PostgreSQL. Docker runs PostgreSQL; the dashboard, API and worker run on your host for quick iteration. Container images for API/worker and dashboard are in `ops/`.

Without Docker, a Linux x64 account capable of running PostgreSQL as a non-root user can try `npm run setup:local`. The optional embedded binary is a development convenience, not a production dependency.

When neither option is available:

```sh
npm run setup:wasm
npm run dev
```

This development harness uses PostgreSQL compiled to WASM with real SQL, migrations, triggers, RLS and range exclusions. It **serializes transactions** and cannot validate native multi-process contention. It is forbidden in production. Stop the API before re-running setup: one process owns the WASM files. Test suites use a separate, in-memory database, never the interactive demonstration data.

## Verify

```sh
npm run typecheck
npm test
npm run build
npm run test:concurrency
npm run check:readiness
```

`test:concurrency` contains 100 rounds of 50 real HTTP requests against two API processes. It intentionally skips under WASM. It must pass against native PostgreSQL before launch. Each round requires one confirmed booking and exactly 49 `409 SLOT_CONFLICT` responses with three alternatives.

For a native local environment, install Chromium with `npx playwright install chromium`, start the app, then run `npm run test:e2e`. This changes synthetic appointments in the configured development database. The E2E script is supplied but has not run successfully in the build environment. `npm run test:http` starts the local app and tests the HTTP/proxy path without claiming browser verification.

`check:readiness` is a **failing release gate** until configuration and dated, reviewed real-world test evidence are supplied. It never proves provider connectivity from the presence of a key. Copy `ops/release-evidence.example.json` to a private release record and fill entries only after running each check.

## Structure

```text
apps/api/             Persistent Fastify API, auth, signed webhooks, audio bridge
apps/dashboard/       Next.js owner workspace and same-origin API proxy
apps/worker/          Transactional outbox delivery and maintenance
packages/core/        Booking rules, database access, conversation controller
packages/providers/   Twilio, Google, OpenAI, audio codecs, token encryption
db/migrations/       Ordered SQL migrations with hashes
scripts/              Setup, migration, seed, provisioning and verification
tests/               Booking, controller, provider failure and recovery checks
ops/                  Containers, local PostgreSQL, release evidence, health SQL
docs/                Architecture, API, activation, deployment and runbooks
evidence/            Actual local verification results and explicit limitations
```

## Deployment and accounts

If you have no provider accounts yet, start with [docs/ACCOUNT_SETUP.md](docs/ACCOUNT_SETUP.md). Then follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and [docs/ACTIVATION.md](docs/ACTIVATION.md). Use a separate migration account and `receptionist_app` runtime role; the server rejects table-owning or RLS-bypassing runtime credentials. Production requires HTTPS, database TLS, Supabase auth, encrypted tokens and disabled development auth. Do not give the dashboard database or provider secrets.

The initial business plan and sourced cost assumptions are preserved in [docs/DECISION_PLAN.md](docs/DECISION_PLAN.md). It is the original design proposal, not current test evidence. Implementation deviations and remaining risks are explicit in [DECISIONS.md](DECISIONS.md), [STATUS.md](STATUS.md), and [docs/TESTING.md](docs/TESTING.md).

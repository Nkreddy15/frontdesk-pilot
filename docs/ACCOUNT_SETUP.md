# Account setup for the first pilot

You do **not** need to create every account today. The fictional local demo runs without any provider account. Account creation, identity checks, payment authorization and accepting provider terms must be done by a founder. Keep control of these accounts with the founders; give each founder a separate login and enable two-factor authentication. Never paste a password, one-time code, API key, OAuth secret, database URL or payment details into chat or a repository.

## First: source control and native tests

1. [Create a GitHub account](https://docs.github.com/en/get-started/onboarding/getting-started-with-your-github-account) using an email you control, verify the email, and enable two-factor authentication. Your cofounder should use a separate account.
2. [Create a **private** repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository) called `frontdesk-pilot`. Do not add a README, license or `.gitignore` during creation; the supplied source already contains these where applicable. Invite the cofounder. Do not upload local `.env`, `.local`, customer records or generated recordings.
3. Send back the repository URL. We will then arrange a supported GitHub connection or have a founder upload the supplied source; a URL alone does not grant access to a private repository. Once the source is pushed, the existing `.github/workflows/verify.yml` starts native PostgreSQL, runs the 50-contender booking test, builds the dashboard and exercises a rendered browser. Its existence is **not** evidence that it has passed. GitHub Free includes a private-repository Actions quota; check billing/usage if you add a payment method.

## Then: controlled staging accounts

Create these only when the native CI gate is passing and we are ready to test real integrations. Use a project or organization controlled by the founders, separate nonshared logins, the smallest available privileges, spending alerts and a staging/test environment. Never place credentials into chat; use local `.env` for development and the host's secret manager for deployment.

| Account | Why we need it | Timing and cost caveat |
|---|---|---|
| [Supabase](https://supabase.com/docs/guides/database/overview) | Managed PostgreSQL and owner login | Use Free for noncritical development if suitable. Free projects can pause after inactivity, and free-tier backup/recovery differs from paid; choose a paid/recovery configuration before real bookings. |
| [OpenAI API](https://platform.openai.com/docs/quickstart/make-your-first-api-request) | Live speech transcription, controlled intent extraction, voice output | ChatGPT and API bills are separate. Create a dedicated project and set a small **soft** budget alert; this is not a hard spend cap. Verify model access and actual audio behavior in staging. |
| [Render](https://render.com/docs/web-services) | Always-on HTTPS API/WebSocket service, dashboard and worker | Create an account near the staging deploy. Render Free web services spin down after idle time and are unsuitable for reliable inbound phone calls; choose an always-on plan only when testing requires it. |
| [Twilio](https://www.twilio.com/docs/usage/tutorials/how-to-use-your-free-trial-account) | Test number, inbound call webhooks, transfer and SMS | Start its time-limited trial when the HTTPS voice endpoint is ready. Current trial has verified-recipient and predefined-message restrictions; our custom confirmation SMS needs an upgraded/eligible account and any applicable messaging registration. Do not route a real business number before the release gates pass. |
| [Google Cloud](https://developers.google.com/workspace/calendar/api/quickstart/nodejs) | Calendar API project and OAuth application | Use a founder-controlled Google account. Enable Calendar API and configure OAuth only once the public HTTPS callback URL is fixed. An owner must grant calendar access; the booking database remains authoritative. |

## What to send when ready

Start with the **GitHub repository URL**. Later provide the nonsecret business name, service catalog, hours, city/timezone, owner-approved policies and a staffed transfer number. Put credentials only in the local secret file or hosting secret manager. Details, exact webhook paths and release gates are in [ACTIVATION.md](ACTIVATION.md), [DEPLOYMENT.md](DEPLOYMENT.md) and [STATUS.md](../STATUS.md).

No public deployment, live call, SMS confirmation or real customer booking has been completed. We will not claim the pilot is ready until the native database, browser, voice, provider and recovery checks pass.

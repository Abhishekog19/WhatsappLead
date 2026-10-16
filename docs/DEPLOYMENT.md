# Free initial deployment: Render + Supabase

This deploys exactly one Render Free Docker web service with both Next.js and the WhatsApp worker. Supabase Free stores contacts, sessions, encrypted WhatsApp credentials, campaign progress and pacing. Use the included HTTPS onrender.com URL; no purchased domain, persistent disk or paid worker is needed.

**Release gate:** read [VERIFICATION.md](VERIFICATION.md). The Linux image and actual Google OAuth round trip must pass before inviting users. No measured linked-account capacity is established yet.

## 1. Understand the limits

Render Free currently provides 512 MB RAM and 0.1 CPU, shared by both processes. It spins down after 15 minutes without inbound traffic. A cron-job.org request every five minutes should prevent inactivity spin-down while requests succeed; it cannot prevent restarts, monitor failures, quota suspension or maintenance. There is no internal self-pinging.

There are 750 free instance-hours per workspace/month (one 31-day month uses 744). Other services and deployment overlap use headroom. Bandwidth and build minutes have separate allowances. Render may suspend services with unusually high outbound traffic, including external database/API traffic; its documented remedy can require a paid plan. This setup cannot guarantee always-on service within a strict zero-cost constraint.

Use only Free plans. Email/account verification is required; providers may impose additional anti-abuse checks. If signup demands a payment card, stop: this deployment cannot override that requirement. Do not enable paid add-ons. Supabase Free has a 500 MB database allowance and can pause inactive projects. Check dashboards for current quotas.

Sources checked October 16, 2026: [Render free limits](https://render.com/docs/free), [compute plans](https://render.com/docs/compute-plans), [Supabase pricing](https://supabase.com/pricing), [Supabase connections](https://supabase.com/docs/guides/database/connecting-to-postgres).

## 2. Prepare the repository locally

1. Install Node.js 22 and Git. Docker Desktop is optional locally but required to run the Linux image verification here; CI can run it instead.
2. Keep the repository private for initial launch. Review git status before committing. Never add .env files, spreadsheets, send logs, backups or WhatsApp credentials.
3. From the repository root run:

~~~powershell
$env:PUPPETEER_SKIP_DOWNLOAD = '1'
npm.cmd ci --ignore-scripts
npm.cmd run typecheck
npm.cmd run verify:build --workspace=@wa/web
~~~

The verification build uses .next-verify and removes application secrets from its environment. The regular development output .next and legacy npm start workflow are preserved.

4. Commit and push reviewed source changes. Let GitHub CI finish, including the combined-container smoke test. It uses only a disposable Postgres database and fake WhatsApp sockets. Do not deploy a failing revision.
5. The old SSH/Oracle deployment workflow is opt-in via the ENABLE_ORACLE_DEPLOY repository variable. Leave it unset for Render.

## 3. Create Supabase Free

1. Create a Supabase account and organization on the Free plan.
2. Create a project in a region close to your intended Render region. Save the database owner password in a password manager.
3. Open **Connect → Session pooler**. Copy its actual hostname and project reference. Do not guess the aws index or region in the hostname.
4. Use session mode, port 5432. Owner and runtime formats:

~~~text
Owner (local migration commands only):
postgresql://postgres.PROJECT_REF:ENCODED_PASSWORD@aws-INDEX-REGION.pooler.supabase.com:5432/postgres

Restricted application (Render DATABASE_URL):
postgresql://wa_app.PROJECT_REF:ENCODED_APP_PASSWORD@aws-INDEX-REGION.pooler.supabase.com:5432/postgres

Direct connection, if your network supports IPv6:
postgresql://wa_app:ENCODED_APP_PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres
~~~

Percent-encode special characters in passwords, including @, :, /, # and %. The shared pooler requires the project-qualified username. Direct connections use wa_app without the suffix. Do not use the Supabase anon or service-role API key as a database password.

The Postgres client disables prepared statements and uses transaction-local tenant settings. Session-pooler port 5432 is the selected deployment method. Do not switch connection methods without re-running connection verification.

TLS certificate verification is enforced for Supabase hostnames. If the direct endpoint needs a project CA, copy its PEM certificate from Supabase into DATABASE_SSL_CA (literal newlines or escaped \n). Never disable certificate verification. Enable SSL enforcement in Supabase if available. See [SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement).

## 4. Apply migrations and create the restricted role

Do this on your computer, before deployment. Render Free has no shell or paid pre-deploy job available.

1. If .env does not exist, copy .env.example to .env. **Do not overwrite your existing local .env.** Save deployment-only credentials in a password manager; do not replace your local development database unless intended.
2. For the migration commands, set MIGRATION_DATABASE_URL to the owner/session-pooler URL and POSTGRES_APP_PASSWORD to a new long random password. Use temporary environment variables or the gitignored .env. Do not put the values into screenshots, logs, Git or chat.
3. Run:

~~~powershell
npm.cmd run db:migrate
npm.cmd run db:setup-role
~~~

Migrations create the schema; setup-role enables wa_app LOGIN with NOSUPERUSER and NOBYPASSRLS and grants table access. The audit log remains append-only. The web and worker must never use the owner URL.

4. Set DATABASE_URL to the wa_app.PROJECT_REF session-pooler URL and run:

~~~powershell
npm.cmd run db:verify-connection
~~~

Resolve every failure. This probes role privileges, TLS information, schema, transaction-local tenant context and lease SQL. It briefly creates then deletes a synthetic probe user. It does not send messages. The pooler TLS observation from pg_stat_ssl describes its backend connection; client TLS verification is separately enforced by the driver.

5. Remove MIGRATION_DATABASE_URL and POSTGRES_APP_PASSWORD from the terminal environment when finished. **Do not add either to Render.** Keep them securely for future migrations/backups.

## 5. Create Google OAuth credentials

1. Open Google Cloud Console and create/select a project. Google OAuth for basic identity does not need a paid hosting service.
2. Open Google Auth Platform (or APIs & Services → OAuth consent screen). Configure the app name, support email and developer contact.
3. Choose an external audience and keep the app in Testing initially. Add yourself and a second tester. Do not enable public access before resource testing.
4. Create an OAuth client: **Web application**. Save the client ID and client secret.
5. Add the local redirect URI if you still use local development: http://localhost:3000/api/auth/callback/google.
6. After Render assigns the actual service URL, add its exact redirect URI:

~~~text
https://YOUR-ACTUAL-SERVICE.onrender.com/api/auth/callback/google
~~~

Use the actual assigned URL, which may have a suffix; a desired name is not proof of the URL. Authorized JavaScript origin, if requested: https://YOUR-ACTUAL-SERVICE.onrender.com. No trailing path on the origin.

Only basic profile/email scopes are used. Follow any consent-screen or verification prompts Google actually displays; do not assume every account is exempt. See [Google web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).

## 6. Create the single Render Free service

1. Sign up to Render, verify your account, connect the GitHub repository.
2. Choose **New → Web Service**, the reviewed branch, runtime **Docker**.
3. Root/build context: repository root (.). Dockerfile: **./infra/Dockerfile.render**.
4. Choose **Free**, one instance, a region close to Supabase. Add no database, background worker, persistent disk or paid service on Render.
5. Set health-check path to **/api/health**. cron-job.org will use the separate **/api/ping** endpoint.
6. Disable automatic deployments initially. Deploy manually only after CI and migrations pass. Alternatively use the included render.yaml Blueprint, which declares exactly one Free service.
7. Add dashboard-managed environment variables:

| Variable | Value |
|---|---|
| DATABASE_URL | Restricted wa_app.PROJECT_REF session-pooler URL |
| AUTH_SECRET | New independent random 32-byte base64 secret |
| CREDS_ENCRYPTION_KEY | New independent random 32-byte base64 key; retain it permanently |
| AUTH_GOOGLE_ID | Google OAuth client ID |
| AUTH_GOOGLE_SECRET | Google OAuth client secret |
| APP_URL and AUTH_URL | Actual https://...onrender.com address |
| NODE_ENV | production |
| WA_ENGINE | baileys |
| LOG_LEVEL | info |
| WEB_DB_POOL and WORKER_DB_POOL | 3 each |
| WORKER_HEALTH_PORT | 3001 |
| MAX_UPLOAD_MB | 4 |
| MAX_IMPORT_ROWS | 5000 |
| MAX_CONCURRENT_IMPORTS | 1 |
| DATABASE_SSL_CA | Optional project CA PEM if required |

Generate each secret locally with node -e "console.log(require('crypto').randomBytes(32).toString('base64'))". Store the outputs securely, never in this repository. If moving existing encrypted credentials, use their existing encryption key instead of generating a replacement.

Render injects PORT. The launcher binds Next.js to 0.0.0.0 on that port and the worker health listener to 127.0.0.1:3001. Do not set a start command, add self-pings, or pass secrets as build arguments.

8. Click Deploy. Copy the actual service URL from Render; correct APP_URL/AUTH_URL and the Google redirect URI if necessary, then redeploy.
9. Confirm the deploy passes /api/health: status ok, db ok, isolation enforced, worker alive. /api/ping should return plain ok. Check the sign-in page has its styles and scripts.
10. Do not ignore a failed health check. Wrong credentials, missing migrations and owner-role access are startup blockers. Consult sanitized Render logs.

## 7. Configure external monitoring to avoid inactivity sleep

1. Create and verify a free account at [cron-job.org](https://cron-job.org).
2. Create a cron job named WhatsApp platform ping.
3. URL: **https://YOUR-ACTUAL-SERVICE.onrender.com/api/ping**.
4. Method: **GET**. Schedule: **every five minutes** (all days/hours). No authentication header or request body.
5. Enable failure/recovery notifications to your email and save/enable the job.
6. Run its manual test; expect HTTP 200 and ok. Check execution history again after at least 20 minutes with your browser closed.
7. If it has been disabled after repeated failures, fix the service then re-enable the job. Cold starts may exceed a monitor timeout; the request can still wake the service.

Successful five-minute requests address Render's inactivity condition. They do not bypass provider limits or guarantee availability. Keep the monitor external: an asleep process cannot wake itself. [cron-job.org FAQ](https://cron-job.org/en/faq/).

## 8. Final acceptance tests before inviting users

These are operator steps after you authorize the deployment, not tests the coding agent performed against real accounts.

1. Sign in with tester A. Sign out and sign in again; the same account and settings should persist.
2. Sign in as tester B in a separate browser profile. Import distinct small synthetic lists into A and B. Search each account for the other's unique marker; it must not appear. A copied contact/campaign URL must not reveal another tenant's data.
3. Verify work hours, timezone, daily cap and dedupe preferences survive save and reload. The default never-repeat setting is per user.
4. Link one test WhatsApp account using a pairing code on the same phone; separately verify QR linking if a second screen is available. Do not link the same device from the old local worker and cloud simultaneously.
5. Restart the Render service with no active campaign. Verify credentials restore without re-pairing.
6. Upload a small consent-based test list. Confirm column mapping, country codes, business details and contact search. The parser accepts XLSX/CSV, max 4 MB upload, 5000 rows, 40 columns, 8 MB total inflated XLSX bytes and 100000 cells. Complex workbooks should be exported as CSV. Server Actions have a 5 MB multipart request ceiling.
7. Only when ready, explicitly authorize a small test campaign to recipients who agreed to receive it. Confirm the message text and business details in the contact history, then check dedupe by reimporting the same number. Do not describe a sent event as confirmed delivery unless a delivery receipt arrives.
8. Pause a campaign, restart, and confirm it stays paused. A throttled account must stay held until cooldown expiry; reconnecting must not bypass it.
9. Check Render memory and restart counts during imports and additional linked accounts. Do not invite arbitrary public traffic. No supported account count is established without this measurement.

## 9. Updates, backups and recovery

**Update:** back up first; run new migrations locally using MIGRATION_DATABASE_URL, re-run setup-role if grants changed, verify the restricted connection, wait for CI, then manually deploy that revision. Review compatibility with the still-running old container. Rollback code only if it remains compatible with the migrated schema; do not blindly reverse data migrations.

**Backups:** Supabase recommends off-site logical backups for Free projects. Use a matching/newer PostgreSQL pg_dump client. Supply credentials through a protected password file or temporary environment variables, not an inline password in command history. Set PGHOST, PGPORT=5432, PGUSER=postgres.PROJECT_REF, PGDATABASE=postgres and verified TLS settings for your pooler, then:

~~~powershell
pg_dump --format=custom --no-owner --no-privileges --file=backup.dump
~~~

Store that dump outside the repository, encrypted, separately from CREDS_ENCRYPTION_KEY. Include the drizzle schema/migration journal in a full database dump. Test restore into a separate empty project with pg_restore; run setup-role afterward because the dump omits privileges. Keep restored campaigns paused and do not attach a second worker to active credentials. Never test restore over the live database.

**Unknown sends:** a network failure or interruption after dispatch is marked failed for review and is not automatically resent. Related contacts are withheld from other campaigns while the outcome is unknown. Review WhatsApp before deciding what to do; do not clear markers or bulk-retry blindly.

**Restart:** encrypted credentials and durable next-send times live in Postgres. Overlap is coordinated by expiring DB leases, independent renewal and ownership checks before reconnect/send. Distributed leases cannot provide a transactional exactly-once guarantee for an external WhatsApp socket; ambiguous sends deliberately stop for review.

**Linking stuck:** inspect worker readiness and last error first. Do not run reset-sessions against a live project without understanding which unfinished handshakes it will clear.

**Database unavailable/paused:** restore the Supabase project or correct its connection. Render readiness remains failed until DB and worker recover.

**Quota suspension:** check Render usage and Supabase limits. A monitor cannot lift a suspension. Stay within the Free allowances or wait for reset where supported; there is no promise of a free remedy for every suspension.

**Lost encryption key:** restore the original key from your secure backup. If unavailable, users must re-link; do not overwrite the database with a different key and expect credentials to decrypt.

Local development remains npm run dev plus npm run dev:worker. The root legacy npm start is unchanged. Do not run the cloud and local worker against the same real WhatsApp credentials while testing.

# Verification record — October 16, 2026

## Result and release gates

The local source checks and isolated integration suites pass. **The combined Linux Docker image has not been built or booted in this session:** Docker is not installed/available here. The added CI step runs that verification; its result has not been observed. Do not call this a fully verified public launch until that step and the provider acceptance checks pass.

No public deployment was performed. No real WhatsApp socket was opened by these tests and no real message was sent. Integration suites use temporary PostgreSQL clusters and fake WhatsApp connections. The user's development .next directory was not rebuilt or deleted.

| Check | Observed result |
|---|---|
| Workspace TypeScript checks | Pass |
| Next.js production build without application secrets | Pass; separate .next-verify-release output |
| Standalone HTTP boot on 34996 | Pass: ping, sign-in page, CSS, bounded 503 readiness with unreachable dummy DB |
| Settings validation | 25 passed |
| Schema, two-user RLS isolation, grants, SQL | 71 passed |
| Trusted Auth.js adapter, first-time profile, suspension, database sessions | 20 passed |
| Linking lifecycle and encrypted credential persistence | 27 passed with fake sockets |
| Send pipeline, quotas, dedupe, uncertain acceptance regression | 37 passed with fake sockets |
| Restart recovery and overlapping ownership | 24 passed |
| Supervisor fixture | 12 passed, 5 skipped on Windows |
| Spreadsheet budget checks | Pass: 5000-row synthetic XLSX and quoted CSV; malformed/sparse/oversized structures rejected |
| Migration generation | No schema changes |

The 5 supervisor skips concern real POSIX signal delivery and forced shutdown. Windows terminates child processes differently; they need Linux CI. Tests exercise the Auth.js adapter and guard, **not Google's browser OAuth redirect/token exchange**.

## Measurements and limits

The synthetic upload-test process reported **144–146 MiB RSS** on this Windows development machine, including ExcelJS and fixture generation. That is not the incremental parser footprint and not a measurement of the combined service.

There is **no measured linked-account capacity** on Render Free. Earlier estimates of 3–4 accounts and 35–45 MB per linked account were unsupported and have been removed. No several-account load test with live sockets was performed. Session-lease concurrency tests prove one database claimant wins; they do not measure real WhatsApp socket memory or simulate every network partition.

Render's 512 MB/0.1 CPU budget still needs the combined-image check and controlled operator testing. Start with invited testers; monitor memory while importing and linking accounts. The documented five-minute external monitor addresses inactivity only, not resource limits or guaranteed uptime.

## Repeat locally

~~~powershell
npm.cmd run typecheck
npm.cmd run verify --workspace=@wa/db
npm.cmd run verify --workspace=@wa/web
npm.cmd run verify:linking --workspace=@wa/worker
npm.cmd run verify:pipeline --workspace=@wa/worker
npm.cmd run verify:restart --workspace=@wa/worker
node --import tsx apps/web/src/testing/verify-upload.ts
node infra/testing/verify-launch.mjs
npm.cmd run verify:build --workspace=@wa/web
node infra/testing/verify-web.mjs
~~~

If an earlier test process locks .next-verify on Windows, stop only that owned process, or set NEXT_BUILD_DIR to a fresh .next-verify-* directory for both build and smoke test. Never delete .next while the development server is running. In this session, a stale pre-existing process held the older verification output; the build succeeded using .next-verify-release instead. An attempted move left older generated files under ignored .verify/previous-next-build; no source or user data was moved.

Windows sandbox blocked PostgreSQL initialization and SWC path resolution. Re-running these isolated checks outside the sandbox succeeded. This is an environment limitation, not a database-test success inside the sandbox.

## Linux container verification

CI provides disposable Postgres 18 and executes infra/testing/render-smoke.sh. It builds without application secrets, runs the image as non-root with 512 MB/0.1 CPU limits, tests ping/readiness/CSS, kills the fixture worker and checks supervisor failure, restarts, then checks SIGTERM exit. It prints an idle container resource reading; that is not linked-account capacity. It never creates a sending campaign.

The script requires an empty disposable PostgreSQL server on 127.0.0.1:5432 with the documented synthetic CI credentials. **Do not point it at a live database.** Use the CI job if Docker is unavailable locally.

## Still required on the actual providers

- Green combined Linux image CI result, including actual native dependency loading and shutdown.
- Supabase session-pooler TLS handshake, restricted-role grants and transaction-local context: run db:verify-connection using the real restricted connection. Local PostgreSQL tests do not prove provider TLS/network configuration.
- Two real Google test users completing login/logout and checking isolation in separate browser profiles.
- Controlled real-device QR/code linking and credential restoration after restart, with no active sends during the restart test.
- Measured memory/CPU with several linked accounts and concurrent requests/import attempts.
- External cron-job.org execution history over at least 20 minutes with browsers closed.
- A small explicitly authorized consent-based send test and backup/restore exercise in a separate project.

See [DEPLOYMENT.md](DEPLOYMENT.md) for every operator step. Until those gates pass, this is a locally tested deployment candidate, not a promise of a complete production rollout.

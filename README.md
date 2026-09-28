# WhatsApp Lead Outreach — cloud platform

Upload a spreadsheet, link WhatsApp from your phone with an 8-character code,
and let a server send personalised messages at a human pace. No laptop left
running, no second device to scan a QR with, no per-message fees.

The whole thing is designed to run on hosting that costs nothing: a single
Oracle Cloud "Always Free" ARM instance, Postgres in a container next to it.

> **Status — phase 0 of 6.** The scaffold is complete and runnable: accounts,
> database, multi-tenant isolation, settings, deployment. The parts that
> actually talk to WhatsApp arrive in phases 1–3. See
> [Roadmap](#roadmap) for exactly what works today.

The original single-file terminal script still lives at [`index.js`](index.js)
and still works — see [Legacy script](#legacy-script).

---

## Why a platform instead of a script

The script it grew out of had to run on a laptop that stayed awake, needed a
second screen to scan a QR code, reset its daily counter at midnight (so 50
messages at 11pm and 50 more at 12:05am looked fine to it), and counted
messages rather than distinct new contacts. Each of those is a real way to get
a number restricted.

The platform fixes them structurally:

| | Script | Platform |
|---|---|---|
| Where it runs | your laptop, awake | a server, always |
| Linking WhatsApp | QR code, needs a second device | **8-character code typed into your one phone** |
| Daily limit | calendar-day counter | rolling 24-hour window of *distinct new contacts* |
| Throttle signals | ignored | tier drop, longer delays, automatic hold |
| Duplicate protection | one shared local file | per-account, and you choose the rule |
| Who can use it | you, from a terminal | anyone, from a phone browser |

## The one-phone problem

The usual objection to WhatsApp automation is that linking a device needs a QR
code on one screen and a camera on another. WhatsApp also supports linking by
**phone number**: the server generates an 8-character code, and you type it
into WhatsApp on the same phone you are browsing from.

> WhatsApp → Settings → Linked Devices → Link a Device →
> **Link with phone number instead**

No camera, no second screen, nothing to photograph. This is why the platform is
usable from a phone alone, and it is the flow the UI is built around.

## How it is put together

```
                      ┌────────────────────────────┐
  phone browser ─TLS─▶ │ Caddy (automatic certs)    │
                      └─────────────┬──────────────┘
                                    │
                      ┌─────────────▼──────────────┐
                      │ web — Next.js 15            │  pages, uploads,
                      │        Auth.js + Google     │  settings, live status
                      └─────────────┬──────────────┘
                                    │
                      ┌─────────────▼──────────────┐
                      │ Postgres 17                 │  the only shared state
                      │  row-level security per user│
                      └─────────────▲──────────────┘
                                    │
                      ┌─────────────┴──────────────┐
                      │ worker — long-running       │  sends, reconnects,
                      │  scheduler + WhatsApp socket│  enforces the caps
                      └─────────────┬──────────────┘
                                    │
                             WhatsApp Web
```

The split matters: a web request lasts seconds and a campaign lasts hours, so
the web tier never sends a message itself. It writes rows; the worker drains
them. Either process can be restarted mid-campaign without losing a message or
sending one twice, because all progress lives in Postgres.

### Packages

| Path | What it is |
|---|---|
| [`packages/core`](packages/core) | No-dependency domain logic: the safety tier model, phone normalisation, template rendering, the redacting logger, the environment contract |
| [`packages/db`](packages/db) | Drizzle schema (18 tables), migrations, and the tenant-scoping helpers every query goes through |
| [`apps/web`](apps/web) | Next.js 15 App Router, React 19, Tailwind 4 |
| [`apps/worker`](apps/worker) | The scheduler and, from phase 3, the send loop |
| [`infra`](infra) | Dockerfiles, Caddy config, host provisioning, deploy script |

### Two things worth knowing before reading the code

**Every query is scoped twice.** Once in TypeScript (`where userId = ...`) and
once by Postgres row-level security, forced on all twelve tenant tables. A
forgotten filter returns nothing instead of returning someone else's contacts.
Tenant data is reached only through `withUser()`; the cross-tenant escape hatch
is `asSystem()`, which is named to be conspicuous and greppable. See
[`packages/db/src/tenant.ts`](packages/db/src/tenant.ts) and
[`packages/db/drizzle/0001_rls.sql`](packages/db/drizzle/0001_rls.sql).

**The rate limit is a ledger, not a counter.** Every first-ever message to a
contact appends a row to `new_contact_sends`. The budget is
`count(*) where sent_at > now() - interval '24 hours'`, so there is no midnight
reset to game, and follow-ups into a conversation the person has replied to do
not consume it. See [`packages/core/src/safety.ts`](packages/core/src/safety.ts).

## Running it locally

Needs Node 22+ and a Postgres database. A free [Neon](https://neon.com) project
is the easiest — it suspends when idle, which is fine for development.

```bash
npm install
cp .env.example .env
```

Fill in `.env`. The two secrets can be generated with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Then apply the schema and start both processes:

```bash
npm run db:migrate
npm run dev          # web, on http://localhost:3000
npm run dev:worker   # in a second terminal
```

For Google sign-in, create an OAuth client at
[console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
with `http://localhost:3000/api/auth/callback/google` as an authorised redirect
URI.

### Useful commands

```bash
npm run typecheck        # every workspace
npm run build            # production build of the web app
npm run db:generate      # emit a migration after changing the schema
npm run db:studio        # browse the database
```

## Deploying for free

Oracle Cloud's Always Free tier gives an ARM instance with 2 OCPU and 12 GB of
RAM that **does not sleep when idle** — the deciding factor, since a campaign
deliberately pauses 45–90 minutes between batches and a host that suspends on
inactivity would kill it mid-run. Render's free tier, by comparison, sleeps
after 15 minutes, has no persistent disk, and deletes its free Postgres after
30 days.

1. Create an **Ampere A1 (ARM)** instance, Ubuntu 24.04, on the Always Free
   shape. Add your SSH key.
2. Point an A record at its public IP.
3. Provision the host:

```bash
git clone <this repo> ~/whatsapp-lead-platform
cd ~/whatsapp-lead-platform
bash infra/oracle-setup.sh
```

4. **Open ports 80 and 443 in the Oracle console**, under Networking → your
   VCN → Security Lists → Add Ingress Rules. The host firewall is not enough on
   its own; this is the most common reason a fresh instance looks unreachable.
5. Fill in `.env` — including `DOMAIN`, `ACME_EMAIL` and `POSTGRES_PASSWORD` —
   and start everything:

```bash
docker compose up -d --build
docker compose logs -f
```

Caddy requests and renews TLS certificates by itself. Five containers come up:
Postgres, a one-shot migration, web, worker, Caddy. Web and worker wait for the
migration to *succeed*, so a bad migration blocks the deploy instead of leaving
the app running against a half-built schema.

### Continuous deployment

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) typechecks, builds, and
fails if the schema changed without a migration.
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) then pipes
[`infra/deploy.sh`](infra/deploy.sh) over SSH, which fast-forwards, rebuilds,
and waits for both tiers to report healthy.

Repository secrets: `SSH_HOST`, `SSH_USER`, `SSH_KEY`, `SSH_KNOWN_HOSTS`
(from `ssh-keyscan -H <host>`), optionally `SSH_PORT` and `APP_DIR`. Add a
`production` environment with a required reviewer if you want deploys gated.

## Roadmap

| Phase | Scope | State |
|---|---|---|
| **0** | Monorepo, schema + migrations, Google sign-in, RLS, settings, Docker Compose, Caddy TLS, CI/CD | **done** |
| 1 | Link a number by pairing code; live session status over SSE; unlink | next |
| 2 | Excel/CSV upload with column mapping and E.164 normalisation; template editor with spintax and variants | |
| 3 | The send loop: claim targets with `for update skip locked`, pace them, record every outcome | |
| 4 | Safety layer: warm-up ramp, tier promotion, throttle-signal handling, suppression and opt-out | |
| 5 | Reply inbox, campaign reports, onboarding polish | |

## Safety, honestly

This drives your own WhatsApp account the way a person clicking send would. It
is not the official Business API, which means no uptime guarantee, and it means
your number carries the risk.

- **Volume is capped and earned, not chosen.** A newly linked number starts at
  10 new contacts a day and ramps over a week. Tiers rise only after clean
  days, and the platform enforces a hard ceiling above whatever a user sets.
- **Throttle signals are obeyed, not retried.** WhatsApp's warnings and its 475
  and 463 errors mean *slow down*, and reconnecting in response is what turns a
  warning into a ban. The worker drops a tier, lengthens its delays, and holds.
- **People who opt out are never messaged again.** The suppression list is the
  one rule a user cannot switch off.
- **Duplicate protection is per account.** Your sending history constrains only
  your account; one user's data never restricts another's.
- Use a secondary number while you are learning the tool, keep templates
  genuinely personal, and only message people who would plausibly expect to
  hear from you. This is not a mass-blast tool.

Not affiliated with, endorsed by, or connected to WhatsApp or Meta.

## Legacy script

The original terminal version is unchanged at [`index.js`](index.js) and reads
`leads.xlsx` and `templates.json` from the repository root:

```bash
npm run start:legacy
```

It keeps its own local state (`sent-log.json`, `.wwebjs_auth/`) and shares
nothing with the platform. All of those files are gitignored — they hold phone
numbers and WhatsApp session tokens.

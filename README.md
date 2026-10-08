# WhatsApp Lead Outreach — cloud platform

Upload a spreadsheet, link WhatsApp from your phone with an 8-character code,
and let a server send personalised messages at a human pace. No laptop left
running, no second device to scan a QR with, no per-message fees.

The whole thing is designed to run on hosting that costs nothing: a single
Oracle Cloud "Always Free" ARM instance, Postgres in a container next to it.

> **Status — end to end, not yet battle-tested.** Linking, importing,
> templates, campaigns, sending and search all work, and 83 behaviours are
> verified against a real Postgres on every commit. What has *not* happened is
> a message reaching a real phone: see [What is actually proven](#what-is-actually-proven).

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

## The spreadsheet

There is no required format. Upload what your scraper or CRM already produces:
the importer guesses the phone and name columns, shows you its guess, and
keeps every other column as something you can drop into a message.

A real list that works as-is:

| Name | Phone | Category | Address | Rating | Reviews | Signals | Website |
|---|---|---|---|---|---|---|---|
| Ishwar Dental Clinic | +91 72018 64189 | Dental clinic | Airport Rd, Vadodara | 4.9 | 33 | No Website | - |

Only two things matter:

- **Phone** — any format. `+91 72018 64189`, `9876543210`, `919876543210`
  and Excel's mangled `9.19877e+11` all normalise to the same number. Numbers
  without a country code use the default country from Settings.
- **Name** — optional, but it is what `{{name}}` fills, and a message that
  opens with the business's own name does far better than one that does not.

Everything else becomes a placeholder. The table above gives you
`{{Category}}`, `{{Rating}}`, `{{Reviews}}`, `{{Signals}}`, `{{Address}}`.

### Getting more replies from the same list

The columns worth having are the ones that let you say something only you
would know. Compare:

> Hi, we build websites for clinics. Interested?

with a message built from the row above:

> Hi Ishwar Dental Clinic, came across your Dental clinic — 4.9 stars from 33
> reviews. Noticed: No Website. Built you a sample homepage, want to see it?

Same effort, because the second one is a template. So when you scrape, keep:

| Column | Why it earns its place |
|---|---|
| **Signals** | The reason you are writing. `No Website`, `Few Reviews` — this is the hook |
| **Rating** / **Reviews** | Specific, flattering, and obviously not a mail-merge |
| **Category** | Lets one template cover dentists and physios without sounding generic |
| **Address** / area | A local reference reads like a person, not a list |

Rows with `-` or an empty cell are treated as blank, and a placeholder with
no value is dropped along with the stray spacing around it — so a missing
rating does not produce "with  stars".

Columns the platform generates itself — a pre-written `msg`, a `wa.me` link,
`Status`, a maps URL — are detected and pre-ticked for exclusion at import.
You can keep them if you want; a template of just `{{msg}}` will send your
pre-written text verbatim.

Two mechanics are worth using deliberately:

- **Spintax.** `{Hi|Hello|Hey}` picks one per message. Thousands of
  byte-identical messages is the clearest spam signal there is.
- **Variants.** Two or three whole versions of the message, rotated per
  recipient, with reply rates tracked per version so you can see which wording
  actually works.

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
| [`packages/db`](packages/db) | Drizzle schema (18 tables), migrations, the tenant-scoping helpers every query goes through, and the isolation guard |
| [`packages/wa`](packages/wa) | The WhatsApp engine: Baileys socket, pairing codes, DB-backed encrypted auth state, throttle classification. Imported by the worker only |
| [`apps/web`](apps/web) | Next.js 15 App Router, React 19, Tailwind 4 |
| [`apps/worker`](apps/worker) | The scheduler, the connection manager, and the send loop |
| [`infra`](infra) | Dockerfiles, Caddy config, host provisioning, deploy script |

### Three things worth knowing before reading the code

**Every query is scoped twice.** Once in TypeScript (`where userId = ...`) and
once by Postgres row-level security, forced on all twelve tenant tables. A
forgotten filter returns nothing instead of returning someone else's contacts.
Tenant data is reached only through `withUser()`; the cross-tenant escape hatch
is `asSystem()`, which is named to be conspicuous and greppable. See
[`packages/db/src/tenant.ts`](packages/db/src/tenant.ts) and
[`packages/db/drizzle/0001_rls.sql`](packages/db/drizzle/0001_rls.sql).

**The app must not connect as a superuser, and it checks.** Postgres exempts
superusers and `BYPASSRLS` roles from row-level security entirely, so a
superuser connection makes every policy above inert with no visible symptom.
The compose file therefore runs migrations as the owner and the app as an
unprivileged `wa_app` role, and
[`checkTenantIsolation`](packages/db/src/isolation.ts) fails the worker's boot
and the health endpoint if that is ever not the case.

**The rate limit is a ledger, not a counter.** Every first-ever message to a
contact appends a row to `new_contact_sends`. The budget is
`count(*) where sent_at > now() - interval '24 hours'`, so there is no midnight
reset to game, and follow-ups into a conversation the person has replied to do
not consume it. See [`packages/core/src/safety.ts`](packages/core/src/safety.ts).

One structural consequence: **only the worker may open a WhatsApp socket.**
WhatsApp allows one connection per linked device, and Next.js may run several
processes, so a second socket would fight the first until the number was logged
out. The web tier therefore never calls into `@wa/wa` — it writes a row, the
worker notices within a few seconds, and the browser watches the same row over
SSE. The database is the message bus; there is no RPC between the tiers.

## Running it locally

Needs Node 22+ and a Postgres database. A free [Neon](https://neon.com) project
is the easiest — it suspends when idle, which is fine for development.

```bash
npm install
cp .env.example .env
```

Fill in `.env`. `AUTH_SECRET` and `CREDS_ENCRYPTION_KEY` can be generated with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Losing `CREDS_ENCRYPTION_KEY` means every linked WhatsApp account has to be
paired again, so keep it somewhere you will still have it in six months.

Then apply the schema and start both processes:

```bash
npm run db:migrate
npm run dev          # web, on http://localhost:3000
npm run dev:worker   # in a second terminal
```

If `DATABASE_URL` points at a role that is a superuser — which includes the
default `postgres` user and a plain `docker run postgres` — the worker will
refuse to start and tell you why. That is deliberate: see
[What is actually proven](#what-is-actually-proven).

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

# Boot a throwaway Postgres and assert the things types cannot prove.
# No setup, no DATABASE_URL — they bring their own server.
npm run verify --workspace=@wa/db
npm run verify:pipeline --workspace=@wa/worker
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
5. Fill in `.env` — `DOMAIN`, `ACME_EMAIL`, `POSTGRES_PASSWORD`,
   `POSTGRES_APP_PASSWORD`, the two generated secrets, and your Google OAuth
   client — then start everything:

```bash
docker compose up -d --build
docker compose logs -f
```

Caddy requests and renews TLS certificates by itself. Five containers come up:
Postgres, a one-shot migration, web, worker, Caddy. Web and worker wait for the
migration to *succeed*, so a bad migration blocks the deploy instead of leaving
the app running against a half-built schema.

The two Postgres passwords are not redundant. `POSTGRES_PASSWORD` belongs to
the superuser that owns the schema and runs migrations;
`POSTGRES_APP_PASSWORD` belongs to `wa_app`, the unprivileged role the web
app and worker connect as, created once by
[`infra/postgres-init.sh`](infra/postgres-init.sh). Pointing the app at the
superuser would silently disable tenant isolation, so it is not allowed to.

Finally, add `https://your-domain/api/auth/callback/google` as an authorised
redirect URI on the Google OAuth client, or sign-in will fail with a redirect
mismatch.

### Continuous deployment

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) typechecks, builds,
fails if the schema changed without a migration, and runs both verification
suites against a real Postgres.
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) then pipes
[`infra/deploy.sh`](infra/deploy.sh) over SSH, which fast-forwards, rebuilds,
and waits for both tiers to report healthy.

Repository secrets: `SSH_HOST`, `SSH_USER`, `SSH_KEY`, `SSH_KNOWN_HOSTS`
(from `ssh-keyscan -H <host>`), optionally `SSH_PORT` and `APP_DIR`. Add a
`production` environment with a required reviewer if you want deploys gated.

## What is actually proven

Two suites run against a real Postgres — booted, migrated and torn down — on
every commit. They exist because the most dangerous bugs here are invisible:
code that typechecks, behaves correctly in every normal case, and is quietly
wrong about who can see what.

```bash
npm run verify --workspace=@wa/db         # 53 checks: schema, RLS, the raw SQL
npm run verify:pipeline --workspace=@wa/worker  # 30 checks: the send loop, end to end
```

The first asserts that one account genuinely cannot read, write, update or
delete another's rows; that the system escape hatch works and does not leak
between requests; that `audit_log` cannot be rewritten; that concurrent
workers claiming targets never collide; and that the contact search finds a
number whether you paste it as `+91 72018 64189`, `7201864189` or
`+917201864189`.

It earned its place immediately. The first version of `docker-compose.yml`
connected the app as the Postgres superuser, and **Postgres exempts superusers
from row-level security** — `force row level security` does not change that.
Every policy was inert. Nothing looked wrong, because the application also
filters by `user_id`; it would have stayed invisible until the first
forgotten `where` clause served someone else's contacts. The app now connects
as an unprivileged role, and both the worker and `/api/health` refuse to
report healthy if that is ever not true.

The second suite runs the real send job against a real database with a stubbed
socket: that a campaign drains, that already-messaged contacts are skipped as
duplicates, that an opted-out number is skipped regardless of dedupe settings,
that a landline with no WhatsApp account is skipped, that placeholders and
spintax render, that variants rotate, and — by raising the tier and watching
sending resume — that the rolling daily cap is genuinely what stops a campaign
rather than a coincidence of timing.

### What is not proven

No message has reached a real phone from this code. The WhatsApp socket itself
— pairing, reconnection, the throttle codes — is the one layer that cannot be
tested without a live account, and it is the layer to watch on the first run.
Link a spare number, send to five contacts you know, and check the transcript
before pointing it at a real list.

## Roadmap

| | Scope | State |
|---|---|---|
| **0** | Monorepo, schema + migrations, Google sign-in, RLS, Docker Compose, Caddy TLS, CI/CD | **done** |
| **1** | Link a number by pairing code, live status over SSE, unlink | **done** |
| **2** | Excel/CSV import with column mapping and E.164 normalisation; template editor with variants, spintax and live preview | **done** |
| **3** | The send loop: `for update skip locked` claims, human pacing, every outcome recorded | **done** |
| **4** | Warm-up ramp, tier caps, throttle handling, suppression, opt-out detection | mostly done — tier *promotion* is not automatic yet |
| 5 | Reply inbox, campaign reports, scheduled start | next |

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

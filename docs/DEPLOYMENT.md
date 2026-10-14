# Deploying

Two things have to run: a **web app**, which is ordinary Next.js, and a
**worker**, which holds a WhatsApp WebSocket open for hours at a time. That
second requirement decides everything below.

Both options here are free. Read [Why the worker needs a real
server](#why-the-worker-needs-a-real-server) before picking one, because the
obvious choice is the wrong one.

---

## Why the worker needs a real server

WhatsApp Web is a persistent socket. A linked device stays connected, receives
pushes, and is dropped if it goes quiet. The worker also paces itself
deliberately — 25–55 seconds between messages, 45–90 minutes between batches —
so a single campaign is hours of mostly-waiting with the connection live
throughout.

Serverless hosting cannot do that. Vercel terminates a function at **300
seconds on the Hobby plan** and there is no persistent process to hold a socket
between invocations. This is not a configuration problem; it is what serverless
means. The same applies to Netlify Functions, Cloudflare Workers and Lambda.

So the worker needs a machine that stays on. Once you have one of those, it can
host the web app too — which is why Option A is the recommendation even though
Option B is the fashionable answer.

## Option A — one free VM, everything on it

**Recommended.** Oracle Cloud's Always Free tier gives an ARM instance with
2 OCPU and 12 GB of RAM that does not sleep, does not expire after 12 months,
and has no compute-hour allowance to exhaust. Postgres runs in a container
beside the app, so there is no managed-database limit either.

One host, one `.env`, one command. Total cost: a domain name, if you want one.

### 1. Create the instance

In the Oracle Cloud console: **Compute → Instances → Create**.

- Shape: **Ampere A1 (ARM)**, 1–2 OCPU, 6–12 GB — all within Always Free
- Image: **Ubuntu 24.04**
- Add your SSH public key

### 2. Point a domain at it

An A record for your domain to the instance's public IP. Caddy obtains the TLS
certificate automatically, so the domain has to resolve before you start the
stack.

No domain? Skip to [Running without a domain](#running-without-a-domain).

### 3. Provision the host

```bash
ssh ubuntu@<your-ip>
git clone <your-repo> ~/whatsapp-lead-platform
cd ~/whatsapp-lead-platform
bash infra/oracle-setup.sh
```

That installs Docker, opens 80 and 443 in both iptables and ufw, adds 4 GB of
swap, and turns on log rotation. Log out and back in afterwards so your user
picks up the `docker` group.

### 4. Open the ports in the Oracle console

**This is the step everyone misses.** The host firewall is not enough — Oracle
has its own network ACL in front of it.

**Networking → Virtual Cloud Networks → your VCN → Security Lists → Default →
Add Ingress Rules**, then add two: source `0.0.0.0/0`, TCP, destination port
`80`, and the same for `443`.

A fresh instance that pings but refuses HTTP is almost always this.

### 5. Fill in `.env`

```bash
cp .env.example .env
nano .env
```

Generate the two secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

| Variable | What it is |
|---|---|
| `DOMAIN` | `app.example.com` — no scheme, no trailing slash |
| `ACME_EMAIL` | Where Let's Encrypt sends expiry warnings |
| `POSTGRES_PASSWORD` | The superuser. Owns the schema, runs migrations |
| `POSTGRES_APP_PASSWORD` | The `wa_app` role the app connects as. **Not** the same |
| `AUTH_SECRET` | Signs session cookies |
| `CREDS_ENCRYPTION_KEY` | Encrypts WhatsApp credentials at rest |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | From the next step |

The two Postgres passwords are not redundant. Postgres exempts superusers from
row-level security, so an app connecting as one has every tenant-isolation
policy silently skipped — all the queries still look right, because the app
filters by `user_id` as well, and nothing goes wrong until one `where` clause
is missing. The app therefore gets an unprivileged role, and both the worker
and `/api/health` refuse to report healthy if that is ever not the case.

**Keep `CREDS_ENCRYPTION_KEY` somewhere you will still have in six months.**
Losing it means every linked WhatsApp number has to be paired again.

### 6. Google sign-in

At [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials):
**Create Credentials → OAuth client ID → Web application**.

- Authorised redirect URI: `https://your-domain/api/auth/callback/google`
- Add `http://localhost:3000/api/auth/callback/google` too, for local work

Copy the client ID and secret into `.env`.

While the consent screen is in **Testing**, only accounts you list as test
users can sign in. That is a reasonable way to start. To let anyone sign in,
publish the app — for a tool that only reads a name and email, Google's
verification is not required.

### 7. Start it

```bash
docker compose up -d --build
docker compose logs -f
```

Five containers: Postgres, a one-shot migration, web, worker, Caddy. Web and
worker wait for the migration to *succeed*, so a bad migration stops the deploy
instead of leaving the app running against a half-built schema.

First build on an ARM free tier takes a few minutes. When it settles:

```bash
curl https://your-domain/api/health
```

Expect `{"status":"ok","db":"ok","isolation":"enforced"}`. If `isolation` says
anything else, the app is connected as the wrong role — see step 5.

### 8. Deploys after the first

Push to `main` and GitHub Actions does it, once you add these repository
secrets: `SSH_HOST`, `SSH_USER`, `SSH_KEY`, and `SSH_KNOWN_HOSTS` (from
`ssh-keyscan -H <your-ip>` — the host key is pinned rather than accepted on
sight, so a hijacked DNS record cannot collect the deploy session). Optionally
`SSH_PORT` and `APP_DIR`.

Or by hand:

```bash
ssh ubuntu@<your-ip> 'cd ~/whatsapp-lead-platform && bash infra/deploy.sh'
```

It fast-forwards, rebuilds, prunes old images, and waits for both tiers to
report healthy before calling the deploy a success.

---

## Option B — web on Vercel, worker on a VM

You asked about Vercel, so: the web half works there, and the worker does not.
You will still need the VM from Option A, which means this buys you a CDN and a
nicer deploy pipeline in exchange for three extra moving parts.

Worth it if you already live on Vercel. Otherwise Option A is less work.

### What changes

| Piece | Where | Note |
|---|---|---|
| Web app | Vercel Hobby | Free |
| Worker | A VM that stays on | Oracle Always Free, or GCP's always-free `e2-micro` |
| Postgres | Managed, reachable from both | **Not Neon's free plan** — see below |

### Do not use Neon's free plan for this

Neon Free is **100 CU-hours per month**, about 400 hours at the smallest
compute size, and scale-to-zero cannot be disabled. The worker queries the
database every few seconds, so the compute never reaches its five-minute idle
timeout and simply stays awake — roughly 730 hours a month. The allowance runs
out in about two weeks, and then the compute is suspended until the next
billing period.

It is a fine choice for local development, where the worker is not running.

**Supabase Free** fits this workload: 500 MB, shared compute, no compute-hour
allowance, and it only pauses after a *week* of inactivity — which an
always-connected worker never reaches. Or keep Postgres on the VM and expose it
with TLS, which is free and unmetered but more to set up.

### Steps

1. **Database.** Create a Supabase project and take the connection string
   (**Project Settings → Database → Connection string → URI**). Use the
   connection *pooler* string for the web app if you have it; the worker should
   use the direct one, since it holds long transactions.

2. **Create the app role.** Managed providers hand you a role that bypasses
   row-level security — Supabase's `postgres` and Neon's `neondb_owner` both
   do. Point `DATABASE_URL` at it temporarily and run:

   ```bash
   npm run db:migrate
   npm run db:setup-role
   ```

   `db:setup-role` needs `POSTGRES_APP_PASSWORD` in `.env`. It creates `wa_app`
   as a non-superuser with `NOBYPASSRLS` and grants it what it needs. Then
   change `DATABASE_URL` to use `wa_app`, keeping the host and database the
   same.

3. **Deploy the web app to Vercel.** Import the repository, then set:

   - **Root Directory**: `apps/web`
   - **Build Command**: `cd ../.. && npm run build --workspace=@wa/web`
   - **Install Command**: `cd ../.. && npm ci --ignore-scripts --omit=optional`

   The `cd ../..` matters: this is an npm workspace, and the lockfile lives at
   the repository root. `--ignore-scripts` skips the legacy script's Chromium
   download, which the web app has no use for.

   Environment variables: `DATABASE_URL` (as `wa_app`), `AUTH_SECRET`,
   `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `CREDS_ENCRYPTION_KEY`, and
   `APP_URL` / `AUTH_URL` set to your Vercel URL. Add the Vercel URL's
   `/api/auth/callback/google` to the Google client.

4. **Run the worker on the VM.** Provision as in Option A, then run only the
   worker and point it at the managed database:

   ```bash
   docker compose up -d --build worker
   ```

   Remove the `postgres`, `migrate`, `web` and `caddy` services from
   `docker-compose.yml`, or run the worker directly with
   `npm run dev:worker` under a process supervisor. It needs the same `.env`
   minus `DOMAIN` and `ACME_EMAIL`.

### Two Vercel caveats

**Live updates reconnect every four minutes.** The pairing-code and campaign
screens stream over SSE, and Hobby kills a function at 300 seconds. The streams
close themselves at 240 to stay inside that, and the browser reconnects
automatically — a brief flicker on the "live" indicator, nothing lost.

**Cold starts.** The first page load after a quiet spell takes a second or two
while a function spins up. The worker is unaffected: it is a separate process
on your own machine and keeps sending regardless of whether anyone has the site
open.

---

## Running without a domain

Caddy needs a resolvable hostname for a certificate. For a quick trial, skip
Caddy and publish the web container directly:

```yaml
# docker-compose.override.yml
services:
  web:
    ports: ['3000:3000']
```

```bash
docker compose up -d --build postgres migrate web worker
```

Then open `http://<your-ip>:3000` and set `APP_URL` / `AUTH_URL` to match.
Google OAuth needs that exact origin as a redirect URI.

**Over plain HTTP, session cookies travel unencrypted.** Fine for an afternoon
of testing from one machine; do not leave it that way with real contacts in the
database.

---

## After it is up

**Link a number** at Settings → WhatsApp numbers. Use a spare number first. You
will type an 8-character code into WhatsApp on your phone — no QR, no second
screen — or scan a QR if a second device is handy.

**Send to five people you know** before pointing it at a real list, and read
the transcripts on their contact pages. The WhatsApp socket is the one layer no
test can reach, so the first real send is the first real proof.

**Expect to start slow.** A newly linked number is capped at 10 new contacts on
day one and ramps over a week. That ramp is the main thing protecting the
number from being restricted. Tier promotion beyond the warm-up is not yet
automatic, so volume stays at the first tier until that lands.

### Checking on it

```bash
docker compose logs -f worker          # what the sender is doing
docker compose logs -f web
curl https://your-domain/api/health    # db + tenant isolation
npm run db:reset-sessions              # unstick a failed link attempt
npm run probe --workspace=@wa/wa -- +919876543210   # test linking in isolation
```

The dashboard and every campaign page say so plainly when no worker is alive —
including the command to start one. If a campaign looks stuck, check there
first: a stopped worker and a campaign pacing itself are indistinguishable from
the database, which is exactly why that heartbeat exists.

### Who can sign in

Anyone with a Google account, once the consent screen is published. Each
account is isolated: separate contacts, templates, campaigns and WhatsApp
numbers, enforced by row-level security in Postgres rather than by application
code remembering to filter. One account's sending history never constrains
another's.

There is no billing, no plan, and no per-account quota beyond the WhatsApp
safety limits. If you open it to strangers, their numbers carry their own risk
and your server carries the load — a free VM will manage a handful of users
comfortably, since the whole design is deliberately slow.

### Backups

Nothing here backs itself up.

```bash
docker compose exec -T postgres pg_dump -U wa wa | gzip > backup-$(date +%F).sql.gz
```

Worth a cron entry. The WhatsApp credentials in that dump are encrypted with
`CREDS_ENCRYPTION_KEY`, so a backup is useless without it — and so is the key
without a backup. Keep them apart, keep them both.

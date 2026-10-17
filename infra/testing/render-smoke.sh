#!/usr/bin/env bash
# Linux only. Disposable database, no linked accounts, no real messages.
set -euo pipefail
name="wa-render-verify-${RANDOM}"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker build -f infra/Dockerfile.render -t wa-render-verify .
export WA_SKIP_ENV_FILE=1
export MIGRATION_DATABASE_URL=postgres://postgres:verify-only@127.0.0.1:5432/postgres
export POSTGRES_APP_PASSWORD=verify-only
npm run db:migrate
npm run db:setup-role
export DATABASE_URL=postgres://wa_app:verify-only@127.0.0.1:5432/postgres
export AUTH_SECRET=synthetic-verification-secret-only
export CREDS_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
export AUTH_GOOGLE_ID=synthetic
export AUTH_GOOGLE_SECRET=synthetic
docker run -d --name "$name" --network host --memory 512m --cpus 0.1 \
  -e DATABASE_URL -e AUTH_SECRET -e CREDS_ENCRYPTION_KEY -e AUTH_GOOGLE_ID \
  -e AUTH_GOOGLE_SECRET -e PORT=34997 -e APP_URL=http://localhost:34997 \
  -e AUTH_URL=http://localhost:34997 wa-render-verify >/dev/null
ready=false
for i in $(seq 1 90); do
  if curl -fsS http://localhost:34997/api/health >/dev/null; then ready=true; break; fi
  sleep 2
done
if [ "$ready" != true ]; then docker logs "$name"; exit 1; fi
curl -fsS http://localhost:34997/api/ping
html=$(curl -fsS http://localhost:34997/signin)
asset=$(printf '%s' "$html" | grep -oE '/_next/static/[^" ]+\.css' | head -1)
test -n "$asset"
curl -fsS "http://localhost:34997$asset" >/dev/null
docker stats --no-stream --format 'Idle container: {{.MemUsage}} / {{.CPUPerc}}' "$name"
test "$(docker exec "$name" id -u)" != 0
# Kill only this fixture's worker. Supervisor must fail the whole container.
docker exec "$name" node -e '
const fs=require("fs");
for (const id of fs.readdirSync("/proc").filter(x=>/^\d+$/.test(x))) {
 try { const c=fs.readFileSync(`/proc/${id}/cmdline`,"utf8").split("\0");
 if(c.includes("apps/worker/src/index.ts")) { process.kill(Number(id),"SIGKILL"); process.exit(0); }
 } catch {}
} process.exit(1);'
code=$(timeout 40 docker wait "$name")
test "$code" != 0
docker start "$name" >/dev/null
for i in $(seq 1 90); do
  if curl -fsS http://localhost:34997/api/health >/dev/null; then break; fi
  sleep 2
done
curl -fsS http://localhost:34997/api/health
docker stop -t 35 "$name" >/dev/null
test "$(docker inspect -f '{{.State.ExitCode}}' "$name")" = 0
echo 'Combined container assets, readiness, worker crash, restart and SIGTERM passed.'

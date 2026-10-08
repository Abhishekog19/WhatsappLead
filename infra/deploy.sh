#!/usr/bin/env bash
#
# Deploys the current main onto this host. Run on the server, either by hand
# or by the Deploy workflow piping it over SSH:
#
#   ssh host 'bash -s' < infra/deploy.sh
#
# Kept as a file rather than inlined in the workflow so it can be read,
# reviewed, and run manually when a deploy needs babysitting.
#
# Environment:
#   APP_DIR   where the repository is checked out (default ~/whatsapp-lead-platform)
#   REF       what to deploy (default origin/main)

set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/whatsapp-lead-platform}"
REF="${REF:-origin/main}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-30}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-5}"

cd "$APP_DIR"

if [[ ! -f .env ]]; then
	echo "error: $APP_DIR/.env is missing. Copy .env.example and fill it in." >&2
	exit 1
fi

previous=$(git rev-parse --short HEAD)

git fetch --prune origin
# --ff-only: refuse to deploy if the host has local commits that a merge would
# silently swallow. Better to fail and let someone look.
git merge --ff-only "$REF"

echo "==> deploying $(git rev-parse --short HEAD) (was $previous)"

# The migration container runs first and must exit 0. Compose's
# service_completed_successfully condition blocks web and worker otherwise, so
# a failed migration stops the deploy rather than half-applying it.
docker compose up -d --build --remove-orphans

# Reclaim what the replaced layers were holding — the free tier's boot volume
# is 50 GB and a handful of rebuilds will fill it.
docker image prune -f

# ---------------------------------------------------------------------------
# Health gate. Both tiers have to answer before the deploy is called a success.
probe() {
	local service=$1 port=$2
	docker compose exec -T "$service" node -e "
    fetch('http://127.0.0.1:${port}/${3}')
      .then((r) => r.text())
      .then((t) => console.log(t))
      .catch(() => { console.log('down'); process.exit(1); })
  " 2>/dev/null || echo down
}

echo "==> waiting for health"
for attempt in $(seq 1 "$HEALTH_ATTEMPTS"); do
	web=$(probe web 3000 'api/health')
	worker=$(probe worker 3001 'health')

	if [[ "$web" == *'"status":"ok"'* && "$worker" == *'"status":"ok"'* ]]; then
		echo "healthy after ${attempt} attempt(s)"
		echo "  web:    $web"
		echo "  worker: $worker"
		exit 0
	fi
	sleep "$HEALTH_INTERVAL"
done

echo "error: the app did not become healthy" >&2
echo "  web:    ${web:-unknown}" >&2
echo "  worker: ${worker:-unknown}" >&2
docker compose ps
docker compose logs --tail 80 migrate web worker

# Deliberately no automatic rollback. `docker compose up` has already replaced
# the containers, and rolling back means knowing which image tag was previously
# good — state this script does not have. Failing loudly with the logs above is
# more useful than a half-understood automatic revert. To go back by hand:
#   git -C "$APP_DIR" reset --hard <previous sha> && bash infra/deploy.sh
echo "previous commit was $previous" >&2
exit 1

# syntax=docker/dockerfile:1
#
# The whole platform in one container: website, worker, and the WhatsApp
# sockets the worker holds.
#
# Normally these are two deployments. Here they share one free instance,
# to fit the initial deployment budget; the worker cannot be
# serverless — it keeps a WhatsApp socket open for hours, and serverless
# functions are killed in minutes.
#
# The budget this is built for: 512 MB of memory and a tenth of a CPU, shared.
# That rules out shipping anything the running service does not need, so this
# installs production dependencies only. No Chromium for the legacy terminal
# script, no embedded Postgres for the verification suites, no TypeScript
# compiler, no drizzle-kit — migrations run from a developer's machine before
# the deploy, because the free tier has neither shell access nor pre-deploy
# commands.
#
# Built with no application secrets. Every page renders on demand, so the
# build reads no DATABASE_URL and no AUTH_SECRET; if that ever stops being
# true, something has been moved to module scope by mistake.

FROM node:22-alpine AS base
ENV NEXT_TELEMETRY_DISABLED=1 \
    PUPPETEER_SKIP_DOWNLOAD=1
WORKDIR /app


# ---------- dependencies ------------------------------------------------------
FROM base AS deps

# Manifests only, so this layer survives until a dependency actually moves.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/wa/package.json packages/wa/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/

# Scope to workspaces; keep platform optional packages required by tsx and Next.
RUN npm ci --ignore-scripts --omit=dev --workspaces --include-workspace-root=false

# Fail the build here rather than at runtime if something the service needs
# did not survive those flags. A missing module in a container that only runs
# on a deploy is an expensive way to find out, and `tsx` in particular is easy
# to lose because it looks like development tooling.
RUN node -e "for (const m of ['tsx','baileys','next','exceljs','postgres','drizzle-orm','qrcode','libphonenumber-js','zod']) { require.resolve(m); } require('esbuild').transformSync('const n: number = 1', {loader:'ts'}); console.log('runtime dependencies present')" \
 && node -e "const p=require('baileys/package.json'); console.log('baileys', p.version)" \
 && node --import tsx -e "import('baileys').then(() => console.log('Baileys runtime import passed'))" \
 && test ! -d node_modules/puppeteer \
 && test ! -d node_modules/embedded-postgres || (echo 'embedded-postgres leaked into the image' && exit 1)


# ---------- build the website -------------------------------------------------
FROM base AS build

# The build needs devDependencies (next, typescript); the runtime does not, so
# this tree is discarded with the stage.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/wa/package.json packages/wa/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN npm ci --ignore-scripts --workspaces --include-workspace-root=false

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web

# No build arguments on purpose: see the note at the top.
RUN npm run build --workspace=@wa/web


# ---------- runtime -----------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

# Production dependencies, and the worker's TypeScript sources, which it runs
# directly through tsx.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.base.json ./
COPY --chown=node:node packages ./packages
COPY --chown=node:node apps/worker ./apps/worker
COPY --chown=node:node infra/launch.mjs ./infra/launch.mjs

# Next's standalone output: a self-contained server plus the minimum tree it
# needs. `static` and `public` are not included in it and must be copied
# alongside, or every stylesheet and script 404s while the HTML renders fine —
# which looks like a broken theme rather than a missing build step.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static

# Unprivileged. The node image ships this user; nothing here needs root, and a
# container that runs as root is one bug away from being a worse problem.
USER node

# Documentation only — the platform decides the published port and passes it
# in as PORT, which the supervisor binds to 0.0.0.0.
EXPOSE 10000

# The supervisor, not a shell. A shell would not forward SIGTERM to background
# jobs, so a deploy would SIGKILL the worker mid-send; and it could not notice
# one half dying, which would leave the service answering health checks while
# nothing was being sent. See infra/launch.mjs.
CMD ["node", "infra/launch.mjs"]

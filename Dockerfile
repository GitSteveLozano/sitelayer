# syntax=docker/dockerfile:1.7-labs
#
# Thin packaging image. The app is COMPILED ON THE FLEET HOST (fast, incremental
# ~26s) by scripts/deploy-production-local.sh; this Dockerfile only installs
# production node_modules and copies the prebuilt dist. No npm ci / tsc / vite
# runs in here, so a code-change image build is just COPY layers.

# Production node_modules only — cached by the manifest layer; reinstalls ONLY
# when package*.json / a workspace package.json changes (not on source edits).
FROM node:20-alpine AS deps
WORKDIR /app
COPY --parents package*.json apps/*/package.json apps/*/operator-*.tgz packages/*/package.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app

ARG GIT_SHA="unknown"
ENV NODE_ENV=production
ENV APP_BUILD_SHA=$GIT_SHA
ENV SENTRY_RELEASE=$GIT_SHA

RUN apk add --no-cache poppler-utils

# Prod node_modules (incl. the @sitelayer/* workspace symlinks) from deps.
# --chown sets `node` ownership DURING the copy (near-free) instead of a later
# `chown -R /app`, which previously walked the entire node_modules tree and took
# ~258s per build (and rewrote the whole layer). See the targeted chown below.
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
# Root manifest for `npm start -w @sitelayer/api`.
COPY --chown=node:node package*.json ./
# Prebuilt dist + manifests from the build context (compiled on the host).
# COPY --parents globs EVERY workspace — no fragile per-package list to drift
# (a missing list entry is what crashed the e4672585 prod deploy). The
# node_modules @sitelayer/* symlinks resolve into these copied dirs.
COPY --chown=node:node --parents apps/*/package.json apps/*/dist packages/*/package.json packages/*/dist ./
# capture-catalog reads this seed.yaml at runtime (lives under src/, not dist/).
COPY --chown=node:node packages/capture-catalog/src/seed.yaml ./packages/capture-catalog/src/seed.yaml

# Run as the unprivileged `node` user (uid 1000). The blueprint_storage volume
# mounts at /app/storage/blueprints — pre-create it with node ownership.
# Only the (empty) storage tree needs a recursive chown; everything else was
# already copied with --chown=node:node above, so we avoid the expensive
# `chown -R /app` over node_modules.
RUN mkdir -p /app/storage/blueprints && chown -R node:node /app/storage
USER node

CMD ["npm", "start", "-w", "@sitelayer/api"]

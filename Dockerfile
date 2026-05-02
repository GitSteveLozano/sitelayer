# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS builder
WORKDIR /app

ARG VITE_API_URL=""
ARG VITE_CLERK_PUBLISHABLE_KEY=""
ARG VITE_COMPANY_SLUG="la-operations"
ARG VITE_USER_ID="demo-user"
ARG VITE_APP_TIER="prod"
ARG VITE_SENTRY_DSN=""
ARG VITE_SENTRY_ENVIRONMENT="production"
ARG VITE_SENTRY_RELEASE=""
ARG VITE_SENTRY_TRACES_SAMPLE_RATE="0.1"
ARG VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE="0.1"
ARG VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE="1.0"
ARG SENTRY_ORG="sandolabs"
ARG SENTRY_WEB_PROJECT="sitelayer-web"
ARG SENTRY_RELEASE=""
ARG GIT_SHA="unknown"

ENV VITE_API_URL=$VITE_API_URL
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_COMPANY_SLUG=$VITE_COMPANY_SLUG
ENV VITE_USER_ID=$VITE_USER_ID
ENV VITE_APP_TIER=$VITE_APP_TIER
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
ENV VITE_SENTRY_ENVIRONMENT=$VITE_SENTRY_ENVIRONMENT
ENV VITE_SENTRY_RELEASE=$VITE_SENTRY_RELEASE
ENV VITE_SENTRY_TRACES_SAMPLE_RATE=$VITE_SENTRY_TRACES_SAMPLE_RATE
ENV VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE=$VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE
ENV VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE=$VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE
ENV SENTRY_RELEASE=$SENTRY_RELEASE
ENV GIT_SHA=$GIT_SHA
ENV APP_BUILD_SHA=$GIT_SHA

COPY package*.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts

RUN npm ci
RUN npm run build
RUN --mount=type=secret,id=sentry_auth_token \
    SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)" && \
    if [ -n "$SENTRY_AUTH_TOKEN" ] && [ -n "$SENTRY_RELEASE" ]; then \
      SENTRY_AUTH_TOKEN="$SENTRY_AUTH_TOKEN" SENTRY_ORG="$SENTRY_ORG" SENTRY_WEB_PROJECT="$SENTRY_WEB_PROJECT" SENTRY_RELEASE="$SENTRY_RELEASE" \
        sh scripts/sentry-upload-sourcemaps.sh apps/web-v2/dist; \
    fi
RUN find apps/web-v2/dist -name '*.map' -type f -delete
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app

ARG GIT_SHA="unknown"
ENV NODE_ENV=production
ENV APP_BUILD_SHA=$GIT_SHA
ENV SENTRY_RELEASE=$GIT_SHA

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/package.json /app/apps/api/package.json
COPY --from=builder /app/apps/api/dist /app/apps/api/dist
COPY --from=builder /app/apps/web-v2/package.json /app/apps/web-v2/package.json
COPY --from=builder /app/apps/web-v2/dist /app/apps/web-v2/dist
# apps/web (v1) ships in the runtime image too — it is the rollback target
# during the post-cutover release window per ADR 0002 cutover criterion #6.
# `docker-compose.prod.yml --profile rollback` brings up a `web-legacy`
# service that serves this dist; Caddy's WEB_BACKEND env flips traffic
# without a Caddyfile edit. Drop these two lines once v1 is fully retired.
COPY --from=builder /app/apps/web/package.json /app/apps/web/package.json
COPY --from=builder /app/apps/web/dist /app/apps/web/dist
COPY --from=builder /app/apps/worker/package.json /app/apps/worker/package.json
COPY --from=builder /app/apps/worker/dist /app/apps/worker/dist
COPY --from=builder /app/packages/config/package.json /app/packages/config/package.json
COPY --from=builder /app/packages/config/dist /app/packages/config/dist
COPY --from=builder /app/packages/domain/package.json /app/packages/domain/package.json
COPY --from=builder /app/packages/domain/dist /app/packages/domain/dist
COPY --from=builder /app/packages/logger/package.json /app/packages/logger/package.json
COPY --from=builder /app/packages/logger/dist /app/packages/logger/dist
COPY --from=builder /app/packages/queue/package.json /app/packages/queue/package.json
COPY --from=builder /app/packages/queue/dist /app/packages/queue/dist
COPY --from=builder /app/packages/workflows/package.json /app/packages/workflows/package.json
COPY --from=builder /app/packages/workflows/dist /app/packages/workflows/dist

# Run as the unprivileged `node` user (uid 1000) baked into node:20-alpine.
# The blueprint_storage volume mounts at /app/storage/blueprints — pre-create
# it so the directory exists with node ownership before any volume mount.
RUN mkdir -p /app/storage/blueprints && chown -R node:node /app
USER node

CMD ["npm", "start", "-w", "@sitelayer/api"]

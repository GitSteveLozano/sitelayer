FROM node:20-alpine AS builder
WORKDIR /app

ARG VITE_API_URL=""
ARG VITE_COMPANY_SLUG="la-operations"
ARG VITE_USER_ID="demo-user"
ARG VITE_APP_TIER="prod"
ARG VITE_SENTRY_DSN=""
ARG VITE_SENTRY_ENVIRONMENT="production"
ARG VITE_SENTRY_TRACES_SAMPLE_RATE="0.1"

ENV VITE_API_URL=$VITE_API_URL
ENV VITE_COMPANY_SLUG=$VITE_COMPANY_SLUG
ENV VITE_USER_ID=$VITE_USER_ID
ENV VITE_APP_TIER=$VITE_APP_TIER
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
ENV VITE_SENTRY_ENVIRONMENT=$VITE_SENTRY_ENVIRONMENT
ENV VITE_SENTRY_TRACES_SAMPLE_RATE=$VITE_SENTRY_TRACES_SAMPLE_RATE

COPY package*.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

RUN npm ci
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/package.json /app/apps/api/package.json
COPY --from=builder /app/apps/api/dist /app/apps/api/dist
COPY --from=builder /app/apps/web/package.json /app/apps/web/package.json
COPY --from=builder /app/apps/web/dist /app/apps/web/dist
COPY --from=builder /app/apps/worker/package.json /app/apps/worker/package.json
COPY --from=builder /app/apps/worker/dist /app/apps/worker/dist
COPY --from=builder /app/packages/config/package.json /app/packages/config/package.json
COPY --from=builder /app/packages/config/dist /app/packages/config/dist
COPY --from=builder /app/packages/domain/package.json /app/packages/domain/package.json
COPY --from=builder /app/packages/domain/dist /app/packages/domain/dist
COPY --from=builder /app/packages/queue/package.json /app/packages/queue/package.json
COPY --from=builder /app/packages/queue/dist /app/packages/queue/dist

CMD ["npm", "start", "-w", "@sitelayer/api"]

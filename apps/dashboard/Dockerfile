# A starting point to adapt to your platform. Build from the repository root: docker build --secret id=dashboard_env,src=apps/dashboard/.env.local -f apps/dashboard/Dockerfile -t marginfront-dashboard .

FROM node:24-bookworm-slim AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV HUSKY=0 \
  NEXT_TELEMETRY_DISABLED=1 \
  TURBO_TELEMETRY_DISABLED=1

COPY . .

RUN npm ci

# The NEXT_PUBLIC_ settings are compiled into the build, so the settings file is mounted for this
# step only. It's mounted as .env.local because Next.js copies .env and .env.production into the
# standalone output, which would put the file's secrets in the image.
RUN --mount=type=secret,id=dashboard_env,target=/app/apps/dashboard/.env.local,required=true \
  npx turbo run build --filter=marginfront-dashboard

FROM node:24-bookworm-slim AS runner

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  PORT=3000 \
  HOSTNAME=0.0.0.0

COPY --from=builder --chown=node:node /app/apps/dashboard/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=builder --chown=node:node /app/apps/dashboard/public ./apps/dashboard/public
COPY --from=builder --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma

USER node

EXPOSE 3000

CMD ["node", "apps/dashboard/server.js"]

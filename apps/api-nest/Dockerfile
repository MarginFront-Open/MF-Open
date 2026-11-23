# A starting point to adapt to your platform. Build from the repository root: docker build -f apps/api-nest/Dockerfile -t marginfront-api .

FROM node:24-bookworm-slim AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV HUSKY=0 \
  TURBO_TELEMETRY_DISABLED=1

COPY . .

RUN npm ci

RUN npx turbo run build --filter=@marginfront/api-nest

FROM node:24-bookworm-slim AS runner

# Invoice PDFs are rendered by @sparticuz/chromium, which needs these system libraries outside AWS Lambda.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 \
    libexpat1 libfontconfig1 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
    libpango-1.0-0 libpangocairo-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
    libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxkbcommon0 libxrandr2 \
    libxrender1 libxss1 libxtst6 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/db/package.json ./packages/db/package.json
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/db/prisma ./packages/db/prisma
COPY --from=builder /app/apps/api-nest/package.json ./apps/api-nest/package.json
COPY --from=builder /app/apps/api-nest/node_modules ./apps/api-nest/node_modules
COPY --from=builder /app/apps/api-nest/dist ./apps/api-nest/dist
COPY --from=builder /app/apps/api-nest/src/templates ./apps/api-nest/src/templates

USER node

WORKDIR /app/apps/api-nest

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 4000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/main.js"]

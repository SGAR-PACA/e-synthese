# syntax=docker/dockerfile:1

# --- Build stage ---
FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

RUN npm run build

# --- Runtime stage ---
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=4111 \
    DB_PATH=/data/data.db \
    PUBLIC_DIR=/app/public

WORKDIR /app

COPY --from=build /app/.mastra/output ./.mastra/output
COPY --from=build /app/public ./public

RUN mkdir -p /data && chown -R node:node /data /app

USER node

VOLUME /data
EXPOSE 4111

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 4111) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", ".mastra/output/index.mjs"]

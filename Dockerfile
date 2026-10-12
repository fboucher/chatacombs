# syntax=docker/dockerfile:1

# ---- Build stage: install production deps ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 ships prebuilt musl binaries (x64 + arm64) and loads them at runtime,
# so skip install scripts (npm would otherwise try a node-gyp rebuild with no compiler)
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
 # Drop SQLite sources and the binaries for other platforms (~20 MB)
 && cd node_modules/better-sqlite3 \
 && rm -rf deps src build \
 && find prebuilds -type f ! -name 'linuxmusl-*' -delete

# ---- Runtime stage: slim image with only the app and its node_modules ----
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/data/chatacombs.db
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
# soul_sample.md is always there, so this also picks up an optional soul.md (AI notes)
COPY --chown=node:node soul*.md ./

# The SQLite database lives on a volume owned by the non-root "node" user
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "src/index.js"]

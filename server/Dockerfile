# Guild Camp API server.
# Build context is the repository root (Coolify: base directory "/", Dockerfile "/server/Dockerfile"):
#   docker build -f server/Dockerfile -t guild-camp-server .
# Everything that must survive a redeploy lives in the /data volume: the SQLite database,
# backups (/data/backups) and published app/addon updates (/data/updates).

# --- Stage 1: production dependencies. better-sqlite3 is native: it downloads a prebuilt
# binary, and falls back to compiling, which needs python3, make and g++. ---
FROM node:24-bookworm-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /srv/server
COPY server/package*.json ./
# Install scripts run as normal here (package.json allowScripts lists better-sqlite3 too).
RUN npm ci --omit=dev && npm cache clean --force \
 && node -e "require('better-sqlite3')(':memory:').prepare('select 1').get()"

# --- Stage 2: the server ---
FROM node:24-bookworm-slim
# curl is used by the health check.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
# Same relative layout as the repository, so server code can require ../../app/src/shared/...
# and find the bundled addon at ../../addon/WowGuild.
COPY --from=deps /srv/server/node_modules ./server/node_modules
COPY server/package*.json ./server/
COPY server/src ./server/src
COPY app/src/shared ./app/src/shared
COPY addon/WowGuild ./addon/WowGuild
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/wow.db
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1
USER node
WORKDIR /srv/server
CMD ["node", "src/index.js"]

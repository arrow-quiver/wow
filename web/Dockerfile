# Build context is the repository root (Coolify: base directory "/", Dockerfile "/web/Dockerfile").

# --- Stage 1: build the player downloads (companion .exe + addon zip) ---
FROM node:22-bookworm-slim AS kit
RUN apt-get update && apt-get install -y --no-install-recommends zip ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /kit
COPY companion ./companion
COPY addon ./addon
RUN mkdir -p /out \
 && cd /kit/companion \
 && npx -y @yao-pkg/pkg@6.5.1 . --targets node22-win-x64 --output /out/wow-companion.exe \
 && cd /out && zip -9 -q wow-companion.zip wow-companion.exe && rm wow-companion.exe \
 && cd /kit/addon && zip -9 -q -r /out/WowGuild.zip WowGuild \
 && sed -n 's/^## Version: *//p' /kit/addon/WowGuild/WowGuild.toc | tr -d '\r' > /out/addon-version.txt \
 && node -p "require('/kit/companion/package.json').version" > /out/companion-version.txt \
 && test -s /out/wow-companion.zip && test -s /out/WowGuild.zip && ls -la /out

# --- Stage 2: the website ---
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# curl is used by Coolify's health check
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
COPY web/package*.json ./
RUN npm ci --omit=dev
COPY web/src ./src
COPY web/public ./public
COPY --from=kit /out ./downloads
ENV PORT=3000 DB_FILE=/data/wow.db
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1
USER node
CMD ["node", "src/server.js"]

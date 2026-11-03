FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# curl is used by Coolify's health check
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV PORT=3000 DB_FILE=/data/wow.db
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1
USER node
CMD ["node", "src/server.js"]

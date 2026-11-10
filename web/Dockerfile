# HowBowWoW download site (static). Coolify builds this from the repo root (base directory /),
# Dockerfile /web/Dockerfile, port 3000, health check /healthz.
FROM nginx:1.27-alpine
RUN rm /etc/nginx/conf.d/default.conf && apk add --no-cache wget
COPY web/nginx.conf /etc/nginx/conf.d/site.conf
COPY web/index.html web/logo.svg web/camp.png /usr/share/nginx/html/
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

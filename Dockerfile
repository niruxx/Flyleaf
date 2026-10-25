# Flyleaf – self-hosted library and reader.
#   docker build -t flyleaf .
#   docker run -d -p 7878:7878 -v flyleaf-data:/data -v /path/to/books:/books flyleaf
# See docker-compose.yml for a ready-made setup.

FROM node:24-bookworm-slim AS deps
# git: one dependency (foliate-js) is installed straight from GitHub.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:24-bookworm-slim
# tar unpacks the Java runtime the built-in Mihon extension runtime downloads into /data.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tar tzdata && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    FLYLEAF_DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=7878
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /data /books && chown node:node /data /books
USER node
EXPOSE 7878
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 7878) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]

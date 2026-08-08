# Wisp Cam signaling server.
#
# The frontend is a separate image (client/Dockerfile) — this one serves no
# static files, only the API and the WebSocket signaling.

FROM node:22-slim AS build
WORKDIR /app

# All workspace manifests are needed for `npm ci` to satisfy the lockfile.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/

RUN npm ci --workspace=server --include-workspace-root --ignore-scripts

COPY shared ./shared
COPY server ./server

# Emits to server/dist, preserving the shared/ + server/ layout.
RUN npm run build --workspace=server

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/

RUN npm ci --workspace=server --include-workspace-root --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --from=build /app/server/dist ./server/dist

# Reports, their evidence, and ban state. Mount a volume here in production.
RUN mkdir -p /data && chown -R node:node /data
ENV DATA_DIR=/data

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/server/src/index.js"]

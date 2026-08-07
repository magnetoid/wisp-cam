# Signaling server only. The client is a static bundle deployed separately
# (Cloudflare Pages), so nothing here needs to serve the frontend.

FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/
# Install server deps only; the client is not part of this image.
RUN npm ci --workspace=server --omit=dev --ignore-scripts

COPY shared ./shared
COPY server ./server

# Dev dependencies are needed to compile TypeScript, then discarded.
RUN npm install --workspace=server --include=dev --ignore-scripts \
    && npm run build --workspace=server \
    && npm prune --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/

# Report evidence and ban state live here; mount a volume in production.
RUN mkdir -p /data && chown -R node:node /data
ENV DATA_DIR=/data

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=4s --start-period=8s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/server/src/index.js"]

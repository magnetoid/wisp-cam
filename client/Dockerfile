# Static frontend, built once and served by nginx.
#
# Vite inlines VITE_* variables at BUILD time, so the API URL has to arrive as a
# build arg — setting it as a runtime environment variable would do nothing.

FROM node:22-slim AS build
WORKDIR /app

ARG VITE_SERVER_URL=http://localhost:8080
ENV VITE_SERVER_URL=$VITE_SERVER_URL

COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
RUN npm ci --ignore-scripts --workspace=client --include-workspace-root

# esbuild's postinstall is skipped by --ignore-scripts; its platform binary
# still needs to be linked for Vite to run.
RUN npm rebuild esbuild

COPY shared ./shared
COPY client ./client

RUN npm run build --workspace=client

FROM nginx:1.27-alpine AS runtime

COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s \
  CMD wget -q --spider http://localhost/ || exit 1

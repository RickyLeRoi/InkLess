# docker/frontend.Dockerfile
#
# Two stages on purpose: Node exists only to run Vite. What ships is a static bundle
# behind nginx, so no JavaScript runtime is left in the production image.

FROM node:22-alpine AS build

WORKDIR /app

# Dependencies first so a source-only change does not reinstall the tree.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/index.html frontend/vite.config.js ./
COPY frontend/src ./src

RUN npm run build

FROM nginx:alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

# Catches a broken nginx.conf at build time, in CI, instead of at `up -d` on
# the server.
RUN nginx -t

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

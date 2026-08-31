# docker/backend.Dockerfile

FROM node:22-alpine

WORKDIR /app

# Dependencies first so a source-only change does not reinstall the tree.
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/src ./src

# node:sqlite needs a writable directory for the WAL files, owned by the runtime user.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/inkless.db
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]

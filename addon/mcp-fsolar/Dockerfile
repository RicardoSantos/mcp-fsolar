ARG BUILD_FROM

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /build
COPY package*.json tsconfig.json ./
COPY src/   ./src/
COPY server.ts index.ts ./
RUN npm ci && npm run build && npm prune --production

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM $BUILD_FROM
WORKDIR /app

COPY --from=builder /build/dist        ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY package.json ./
COPY bin/ ./bin/
COPY addon/mcp-fsolar/run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 3010
CMD ["/run.sh"]

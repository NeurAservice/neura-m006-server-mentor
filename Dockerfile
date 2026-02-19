# ============================================
# m006: Server-ментор — Dockerfile
# ============================================

# Stage 1: Dependencies
FROM node:20-alpine AS deps
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --maxsockets=5 --fetch-retries=5 --fetch-retry-mintimeout=20000

# Stage 2: Builder
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm install --maxsockets=5 --fetch-retries=5 --fetch-retry-mintimeout=20000

COPY . .
RUN npm run build

# Stage 3: Runner
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 moduleuser

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/public ./public

# Директории для данных, runtime конфига и логов
RUN mkdir -p /app/data /app/config /app/logs/app /app/logs/error /app/logs/access /app/logs/frontend && chown -R moduleuser:nodejs /app/data /app/config /app/logs

USER moduleuser

EXPOSE 3066

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3066/health || exit 1

CMD ["node", "dist/index.js"]

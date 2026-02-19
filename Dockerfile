# ============================================
# m006: Server-ментор — Dockerfile
# ============================================
# Single-stage build для серверов с ограниченными ресурсами

FROM node:20-alpine
WORKDIR /app

# Установка зависимостей
COPY package*.json ./
RUN npm install --maxsockets=3 --fetch-retries=5 --fetch-retry-mintimeout=20000

# Копируем исходники и собираем
COPY . .
RUN npm run build

# Удаляем devDependencies и исходники после сборки
RUN npm prune --omit=dev && rm -rf src tsconfig.json

# Директории для данных, runtime конфига и логов
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 moduleuser && \
    mkdir -p /app/data /app/config /app/logs/app /app/logs/error /app/logs/access /app/logs/frontend && \
    chown -R moduleuser:nodejs /app/data /app/config /app/logs

USER moduleuser

EXPOSE 3066

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3066/health || exit 1

CMD ["node", "dist/index.js"]

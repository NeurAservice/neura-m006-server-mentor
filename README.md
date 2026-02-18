# m006: Server-ментор — AI-ассистент администрирования VPS

AI-ассистент для администрирования VPS и серверов Linux/Unix. Помогает с настройкой Nginx, Docker, firewall, SSL, мониторингом, безопасностью и автоматизацией.

## Стек

- **Runtime**: Node.js 20+
- **Backend**: Express 4.x, TypeScript 5.x
- **AI**: OpenAI Responses API (GPT-4o, streaming)
- **Frontend**: Vanilla JS, HTML5, CSS3 (тёмная тема)
- **Логирование**: Winston (JSON-логи с ротацией)
- **Контейнеризация**: Docker, docker-compose

## Быстрый старт

```bash
# Установка зависимостей
npm install

# Разработка
npm run dev

# Сборка
npm run build

# Production
npm start
```

## Docker

```bash
# Dev с hot-reload
docker-compose -f docker-compose.dev.yml up --build

# Production
docker-compose up --build -d

# Логи
docker-compose logs -f
```

## Порт

- **3066** (HTTP)

## API

| Endpoint                          | Метод | Описание             |
| --------------------------------- | ----- | -------------------- |
| `/health`                         | GET   | Health check         |
| `/api/chat/stream`                | POST  | Streaming-чат (SSE)  |
| `/api/chat/send`                  | POST  | Синхронный чат       |
| `/api/chat/new`                   | POST  | Новая беседа         |
| `/api/chat/identity/init`         | POST  | Identity resolve     |
| `/api/balance`                    | GET   | Баланс пользователя  |
| `/api/conversations`              | GET   | Список бесед         |
| `/api/conversations/:id`          | GET   | Конкретная беседа    |
| `/api/conversations/:id/download` | GET   | Скачать как Markdown |
| `/api/log`                        | POST  | Логи фронтенда       |

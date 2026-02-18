/**
 * @file index.ts
 * @description Точка входа Express-сервера m006 Server-ментор
 * @context Запускается как основной процесс в Docker-контейнере
 * @dependencies config, logger, routes, middleware, services
 * @affects HTTP-сервер, cron-задачи, graceful shutdown
 */

import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import cron from 'node-cron';
import { config, validateConfig, getConfigSummary } from './config';
import { logger } from './utils/logger';
import { healthRouter } from './routes/health';
import { chatRouter } from './routes/chat';
import { conversationsRouter } from './routes/conversations';
import { analysisRouter } from './routes/analysis';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { cleanupOldConversations } from './services/storage';
import { clientLogRouter } from './routes/clientLog';
import { notifyModuleStarted } from './services/telegram';

// ============================================
// m006: Server-ментор — AI-ассистент администрирования VPS
// ============================================

const app: Application = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com", "cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      frameAncestors: [
        "'self'",
        "https://*.xl.ru",
        "https://xl.ru",
        "https://neuraservicecore.neuradeck.com",
        "https://*.neuradeck.com",
      ],
    },
  },
  frameguard: false,
}));

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Module-Api-Key'],
}));

// Body parsing
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging с request_id
app.use(requestLogger);

// Serve static files (frontend)
app.use('/public', express.static(path.join(__dirname, '../public')));
app.use('/assets', express.static(path.join(__dirname, '../public/assets')));

// Favicon
app.get('/favicon.ico', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/favicon.ico'));
});

// Routes
app.use('/health', healthRouter);
app.use('/api/chat', chatRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/analysis', analysisRouter);
app.use('/api/log', clientLogRouter);

// Serve frontend for root path
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Not found handler
app.use(notFoundHandler);

// Error handler (must be last)
app.use(errorHandler);

// Schedule daily cleanup of old conversations (at 03:00)
cron.schedule('0 3 * * *', async () => {
  logger.info('Running scheduled cleanup of old conversations');
  try {
    const deleted = await cleanupOldConversations();
    logger.info(`Cleanup completed: ${deleted} conversations deleted`);
  } catch (error) {
    logger.error('Cleanup failed', { error: (error as Error).message });
  }
});

// Validate configuration
const configValidation = validateConfig();
if (!configValidation.valid) {
  logger.error('Configuration validation failed', { errors: configValidation.errors });
  if (config.nodeEnv === 'production') {
    process.exit(1);
  }
}

// Start server
const PORT = config.port;

const server = app.listen(PORT, () => {
  logger.info(`🚀 M006 Server-ментор started`, getConfigSummary());
  logger.info(`📍 Health check: http://localhost:${PORT}/health`);
  logger.info(`🌐 Frontend: http://localhost:${PORT}/`);
  logger.info(`📡 API: http://localhost:${PORT}/api/chat`);

  // Notify admin about startup
  notifyModuleStarted().catch(() => {});
});

// Увеличенные таймауты HTTP-сервера
server.timeout = 960_000;
server.headersTimeout = 65_000;
server.requestTimeout = 960_000;
server.keepAliveTimeout = 620_000;

// ============================================
// Graceful Shutdown
// ============================================
function gracefulShutdown(signal: string): void {
  logger.info(`Received ${signal}, shutting down gracefully...`, { signal });
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30_000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});

export default app;

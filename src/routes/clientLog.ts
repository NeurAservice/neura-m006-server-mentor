/**
 * @file routes/clientLog.ts
 * @description Эндпоинт для приёма логов фронтенда (browser → server)
 * @context Фронтенд (chat.js) батчит логи и шлёт POST /api/log каждые 5 секунд
 * @dependencies utils/logger (frontendLogger)
 * @affects logs/frontend/
 */

import { Router, type Request, type Response } from 'express';
import { frontendLogger, logger } from '../utils/logger';

export const clientLogRouter = Router();

/** Максимальное количество записей в одном батче */
const MAX_BATCH_SIZE = 100;

/** Допустимые уровни логирования от фронтенда */
const ALLOWED_LEVELS = new Set(['error', 'warn', 'info', 'debug']);

interface FrontendLogEntry {
  level: string;
  event: string;
  message?: string;
  data?: Record<string, unknown>;
  timestamp?: string;
  sessionId?: string;
  userId?: string;
  url?: string;
  userAgent?: string;
}

/**
 * POST /api/log
 * Принять батч логов от фронтенда и записать в logs/frontend/
 */
clientLogRouter.post('/', (req: Request, res: Response) => {
  try {
    const { entries } = req.body;

    if (!Array.isArray(entries) || entries.length === 0) {
      res.status(400).json({ success: false, error: 'entries must be a non-empty array' });
      return;
    }

    const batch = entries.slice(0, MAX_BATCH_SIZE) as FrontendLogEntry[];
    const clientIp = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'unknown';
    const serverRequestId = req.requestId;

    let errorCount = 0;
    let warnCount = 0;

    for (const entry of batch) {
      const level = ALLOWED_LEVELS.has(entry.level) ? entry.level : 'info';

      if (level === 'error') errorCount++;
      else if (level === 'warn') warnCount++;

      frontendLogger.log(level, entry.message || entry.event, {
        event: entry.event,
        client_timestamp: entry.timestamp,
        session_id: entry.sessionId,
        user_id: entry.userId,
        client_url: entry.url,
        client_user_agent: entry.userAgent,
        client_ip: clientIp,
        server_request_id: serverRequestId,
        ...(entry.data || {}),
      });
    }

    // Дублируем саммари frontend-ошибок в основной app-лог
    if (errorCount > 0) {
      logger.warn('Frontend errors received', {
        requestId: serverRequestId,
        error_count: errorCount,
        warn_count: warnCount,
        total: batch.length,
        client_ip: clientIp,
        user_id: batch[0]?.userId,
      });
    }

    res.json({ success: true, accepted: batch.length });
  } catch (_error) {
    // Логирование не должно ронять бэкенд — всегда 200
    res.json({ success: false, error: 'Internal error processing logs' });
  }
});

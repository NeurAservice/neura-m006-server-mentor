/**
 * @file middleware/requestLogger.ts
 * @description Логирование HTTP-запросов с request_id, access-логами и расширенной метаинформацией
 * @context Middleware подключается в index.ts для всех маршрутов
 * @dependencies utils/logger (createRequestLogger, accessLogger)
 * @affects app-логи, access-логи (logs/access/)
 */

import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createRequestLogger, accessLogger } from '../utils/logger';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      log: ReturnType<typeof createRequestLogger>;
    }
  }
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string) || uuidv4();
  req.requestId = requestId;
  req.log = createRequestLogger(requestId);

  res.setHeader('x-request-id', requestId);

  const startTime = Date.now();

  const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    || req.socket.remoteAddress
    || 'unknown';

  const reqContentLength = req.headers['content-length']
    ? parseInt(req.headers['content-length'], 10)
    : 0;

  const userId = (req.body?.user_id as string)
    || (req.query?.user_id as string)
    || undefined;

  req.log.info(`→ ${req.method} ${req.path}`, {
    query: req.query,
    userAgent: req.headers['user-agent'],
    clientIp,
    contentLength: reqContentLength,
    userId,
  });

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const resContentLength = res.getHeader('content-length')
      ? parseInt(String(res.getHeader('content-length')), 10)
      : 0;

    req.log.info(`← ${req.method} ${req.path} ${res.statusCode} (${duration}ms)`);

    accessLogger.info('access', {
      requestId,
      method: req.method,
      path: req.path,
      query: req.query,
      statusCode: res.statusCode,
      duration_ms: duration,
      clientIp,
      userAgent: req.headers['user-agent'],
      referer: req.headers['referer'] || req.headers['referrer'],
      reqContentLength,
      resContentLength,
      userId,
    });
  });

  next();
}

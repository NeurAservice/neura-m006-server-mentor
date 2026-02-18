/**
 * @file routes/health.ts
 * @description Health-check эндпоинт для m006 Server-ментор
 * @context Используется Docker, load balancer и мониторингом
 * @dependencies config/index.ts
 * @affects Мониторинг доступности сервиса
 */

import { Router, Request, Response } from 'express';
import { config } from '../config';

export const healthRouter = Router();

healthRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    moduleId: config.moduleId,
    moduleName: config.moduleName,
    version: config.version,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

healthRouter.get('/ready', (_req: Request, res: Response) => {
  res.json({ ready: true });
});

healthRouter.get('/live', (_req: Request, res: Response) => {
  res.json({ alive: true });
});

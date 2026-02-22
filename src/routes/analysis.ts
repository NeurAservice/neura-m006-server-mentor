/**
 * @file routes/analysis.ts
 * @description API-эндпоинт для статистики и аналитики бесед
 * @context Административный эндпоинт, защищённый через MODULE_API_KEY
 * @dependencies services/analysis.ts
 * @affects Аналитические данные
 */

import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { analysisService } from '../services/analysis';
import { config } from '../config';

export const analysisRouter = Router();

/**
 * POST /api/analysis/run
 * Ручной запуск автоанализа бесед (для отладки / пересканирования).
 * Запуск происходит асинхронно — эндпоинт возвращает 202 немедленно.
 * Защищён MODULE_API_KEY.
 */
analysisRouter.post('/run', async (req: Request, res: Response) => {
  const requestId = req.requestId;

  const apiKey = req.headers['x-module-api-key'] as string;
  if (!apiKey || apiKey !== config.core.apiKey) {
    logger.warn('Unauthorized analysis run request', { requestId });
    res.status(401).json({
      status: 'error',
      error_code: 'UNAUTHORIZED',
      message: 'Invalid API key',
      request_id: requestId,
    });
    return;
  }

  logger.info('Manual analysis run triggered', { requestId });

  // Запуск асинхронно — не блокируем HTTP-ответ
  analysisService.runAllAnalyses().catch((error) => {
    logger.error('Manual analysis run failed', {
      requestId,
      error: (error as Error).message,
    });
  });

  res.status(202).json({
    status: 'success',
    message: 'Analysis started in background',
    request_id: requestId,
  });
});

/**
 * GET /api/analysis/user/:userId
 * Получить статистику бесед конкретного пользователя
 * Защищён MODULE_API_KEY
 */
analysisRouter.get('/user/:userId', async (req: Request, res: Response) => {
  const requestId = req.requestId;

  const apiKey = req.headers['x-module-api-key'] as string;
  if (!apiKey || apiKey !== config.core.apiKey) {
    logger.warn('Unauthorized analysis request', { requestId });
    res.status(401).json({
      status: 'error',
      error_code: 'UNAUTHORIZED',
      message: 'Invalid API key',
      request_id: requestId,
    });
    return;
  }

  try {
    const stats = await analysisService.getUserStats(req.params.userId, requestId);

    res.json({
      status: 'success',
      data: stats,
      request_id: requestId,
    });
  } catch (error) {
    logger.error('Analysis user stats failed', {
      requestId,
      error: (error as Error).message,
    });
    res.status(500).json({
      status: 'error',
      error_code: 'ANALYSIS_ERROR',
      message: (error as Error).message,
      request_id: requestId,
    });
  }
});

/**
 * GET /api/analysis/global
 * Получить общую статистику (для админки)
 * Защищён MODULE_API_KEY
 */
analysisRouter.get('/global', async (req: Request, res: Response) => {
  const requestId = req.requestId;

  const apiKey = req.headers['x-module-api-key'] as string;
  if (!apiKey || apiKey !== config.core.apiKey) {
    logger.warn('Unauthorized global analysis request', { requestId });
    res.status(401).json({
      status: 'error',
      error_code: 'UNAUTHORIZED',
      message: 'Invalid API key',
      request_id: requestId,
    });
    return;
  }

  try {
    const stats = await analysisService.getGlobalStats(requestId);

    res.json({
      status: 'success',
      data: stats,
      request_id: requestId,
    });
  } catch (error) {
    logger.error('Analysis global stats failed', {
      requestId,
      error: (error as Error).message,
    });
    res.status(500).json({
      status: 'error',
      error_code: 'ANALYSIS_ERROR',
      message: (error as Error).message,
      request_id: requestId,
    });
  }
});

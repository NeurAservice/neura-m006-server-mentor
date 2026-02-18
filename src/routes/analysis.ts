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

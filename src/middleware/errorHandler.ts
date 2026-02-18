/**
 * @file middleware/errorHandler.ts
 * @description Центральный обработчик ошибок для всех маршрутов m006
 * @context Подключается последним middleware в index.ts
 * @dependencies utils/logger, services/chat (ChatError), services/openai (OpenAIError), services/core (CoreApiError)
 * @affects HTTP-ответы с ошибками
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { ChatError } from '../services/chat';
import { OpenAIError } from '../services/openai';
import { CoreApiError } from '../services/core';

// ============================================
// Error Handler Middleware
// ============================================

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
  isOperational?: boolean;
}

/**
 * Central error handler for all routes
 */
export function errorHandler(
  err: Error | AppError | ChatError | OpenAIError | CoreApiError,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = req.requestId || 'unknown';

  let statusCode = 500;
  let errorCode = 'INTERNAL_ERROR';
  let message = 'Внутренняя ошибка сервиса';
  let isOperational = false;

  if (err instanceof ChatError || err instanceof OpenAIError || err instanceof CoreApiError) {
    statusCode = err.httpStatus;
    errorCode = err.code;
    message = err.message;
    isOperational = true;
  } else if ('statusCode' in err && err.statusCode) {
    statusCode = err.statusCode;
    errorCode = ('code' in err && err.code) || 'ERROR';
    message = ('isOperational' in err && err.isOperational) ? err.message : 'Внутренняя ошибка сервиса';
    isOperational = ('isOperational' in err && err.isOperational) || false;
  }

  const logLevel = statusCode >= 500 ? 'error' : 'warn';
  logger[logLevel]('Request error', {
    requestId,
    error: err.message,
    code: errorCode,
    statusCode,
    path: req.path,
    method: req.method,
    stack: statusCode >= 500 ? err.stack : undefined,
  });

  res.status(statusCode).json({
    success: false,
    error: {
      code: errorCode,
      message: isOperational ? message : 'Временная ошибка сервиса. Попробуйте позже.',
    },
    request_id: requestId,
  });
}

/**
 * Create an operational error
 */
export function createError(
  message: string,
  statusCode: number = 500,
  code: string = 'ERROR'
): AppError {
  const error: AppError = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.isOperational = true;
  return error;
}

/**
 * Not found handler
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'Эндпоинт не найден',
    },
    request_id: req.requestId,
  });
}

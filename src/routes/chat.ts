/**
 * @file routes/chat.ts
 * @description API-роуты чата: синхронный и SSE-streaming отправка сообщений
 * @context Используется фронтендом m006 через /api/chat/*
 * @dependencies services/chat.ts
 * @affects billing, conversations, SSE stream
 */

import { Router, Request, Response, NextFunction } from 'express';
import { chatService, ChatError } from '../services/chat';
import { logger } from '../utils/logger';

// ============================================
// Chat API Routes (m006: Server-ментор)
// ============================================

export const chatRouter = Router();

interface SendMessageBody {
  session_id: string;
  user_id: string;
  message: string;
  images?: Array<{
    data: string;
    filename: string;
    mimeType?: string;
    mime_type?: string;
    size_bytes?: number;
    sizeBytes?: number;
  }>;
  shell_id?: string;
  origin_url?: string;
  context?: Record<string, string>;
}

/**
 * POST /api/chat/send
 * Отправить сообщение в беседу (синхронно)
 */
chatRouter.post('/send', async (req: Request, res: Response, next: NextFunction) => {
  const requestId = req.requestId;

  try {
    const body = req.body as SendMessageBody;
    const { session_id, user_id, message, images, shell_id, origin_url, context } = body;

    if (!session_id) {
      throw new ChatError('MISSING_SESSION_ID', 'session_id обязателен', 400);
    }
    if (!user_id) {
      throw new ChatError('MISSING_USER_ID', 'user_id обязателен', 400);
    }
    if (!message?.trim()) {
      throw new ChatError('EMPTY_MESSAGE', 'Сообщение не может быть пустым', 400);
    }

    const processedImages = images?.map((img) => ({
      data: img.data,
      filename: img.filename,
      mimeType: img.mimeType || img.mime_type || 'image/jpeg',
      sizeBytes: img.size_bytes || img.sizeBytes || 0,
    }));

    if (processedImages && processedImages.length > 5) {
      throw new ChatError('TOO_MANY_IMAGES', 'Максимум 5 изображений в одном сообщении', 400);
    }

    const result = await chatService.sendMessage({
      sessionId: session_id,
      userId: user_id,
      message: message.trim(),
      images: processedImages,
      requestId,
      shellId: shell_id,
      originUrl: origin_url,
      context,
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/chat/stream
 * Отправить сообщение с потоковым ответом через SSE (Server-Sent Events)
 *
 * Формат SSE-событий:
 * - event: status, data: { status, progress }
 * - event: text_delta, data: { delta }
 * - event: done, data: { content, usage }
 * - event: error, data: { errorMessage, errorCode }
 */
chatRouter.post('/stream', async (req: Request, res: Response) => {
  const requestId = req.requestId;

  try {
    const body = req.body as SendMessageBody;
    const { session_id, user_id, message, images, shell_id, origin_url, context } = body;

    // Валидация
    if (!session_id) {
      res.status(400).json({ success: false, error: { code: 'MISSING_SESSION_ID', message: 'session_id обязателен' } });
      return;
    }
    if (!user_id) {
      res.status(400).json({ success: false, error: { code: 'MISSING_USER_ID', message: 'user_id обязателен' } });
      return;
    }
    if (!message?.trim()) {
      res.status(400).json({ success: false, error: { code: 'EMPTY_MESSAGE', message: 'Сообщение не может быть пустым' } });
      return;
    }

    const processedImages = images?.map((img) => ({
      data: img.data,
      filename: img.filename,
      mimeType: img.mimeType || img.mime_type || 'image/jpeg',
      sizeBytes: img.size_bytes || img.sizeBytes || 0,
    }));

    if (processedImages && processedImages.length > 5) {
      res.status(400).json({ success: false, error: { code: 'TOO_MANY_IMAGES', message: 'Максимум 5 изображений' } });
      return;
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.status(200);
    res.flushHeaders();

    const sendSSE = (eventType: string, data: Record<string, unknown>): void => {
      if (res.writableEnded) return;
      const chunk = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
      res.write(chunk);
    };

    let clientDisconnected = false;
    res.on('close', () => {
      clientDisconnected = true;
      logger.info('Client disconnected from SSE stream', { requestId });
    });

    const stream = chatService.sendMessageStream({
      sessionId: session_id,
      userId: user_id,
      message: message.trim(),
      images: processedImages,
      requestId,
      shellId: shell_id,
      originUrl: origin_url,
      context,
    });

    for await (const event of stream) {
      if (clientDisconnected) break;

      if (event.type === 'status') {
        sendSSE('status', { status: event.status, progress: event.progress });
      } else if (event.type === 'text_delta') {
        sendSSE('text_delta', { delta: event.delta });
      } else if (event.type === 'done') {
        sendSSE('done', {
          content: event.content,
          usage: event.usage,
          request_id: requestId,
        });
      } else if (event.type === 'error') {
        sendSSE('error', {
          errorMessage: event.errorMessage,
          errorCode: event.errorCode,
        });
      }
    }

    if (!res.writableEnded) {
      res.end();
    }
  } catch (error) {
    logger.error('SSE stream error', { requestId, error: (error as Error).message });
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: { message: 'Внутренняя ошибка сервера' } });
    } else if (!res.writableEnded) {
      const errData = JSON.stringify({ errorMessage: 'Внутренняя ошибка сервера', errorCode: 'INTERNAL_ERROR' });
      res.write(`event: error\ndata: ${errData}\n\n`);
      res.end();
    }
  }
});

/**
 * POST /api/chat/new
 * Создать новую беседу
 */
chatRouter.post('/new', async (req: Request, res: Response, next: NextFunction) => {
  const requestId = req.requestId;

  try {
    const { user_id } = req.body;

    if (!user_id) {
      throw new ChatError('MISSING_USER_ID', 'user_id обязателен', 400);
    }

    const session = await chatService.createSession(user_id, requestId);

    res.json({
      success: true,
      ...session,
      request_id: requestId,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/identity/init
 * Инициализация пользователя (identity/resolve)
 */
chatRouter.post('/identity/init', async (req: Request, res: Response, next: NextFunction) => {
  const requestId = req.requestId;

  try {
    const { provider, tenant, external_user_id } = req.body;

    if (!provider) {
      throw new ChatError('MISSING_PROVIDER', 'provider обязателен', 400);
    }
    if (!tenant) {
      throw new ChatError('MISSING_TENANT', 'tenant обязателен', 400);
    }
    if (!external_user_id) {
      throw new ChatError('MISSING_EXTERNAL_USER_ID', 'external_user_id обязателен', 400);
    }

    const result = await chatService.resolveIdentity(provider, tenant, external_user_id, requestId);

    res.json({
      success: true,
      user_id: result.user_id,
      is_new: result.is_new,
      request_id: requestId,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/balance
 * Получить баланс пользователя
 */
chatRouter.get('/balance', async (req: Request, res: Response, next: NextFunction) => {
  const requestId = req.requestId;

  try {
    const userId = req.query.user_id as string;
    const shellId = req.query.shell_id as string | undefined;
    const originUrl = req.query.origin_url as string | undefined;

    if (!userId) {
      throw new ChatError('MISSING_USER_ID', 'user_id обязателен', 400);
    }

    const result = await chatService.getBalance(userId, requestId, shellId, originUrl);

    res.json({
      success: true,
      balance: result.balance,
      currency_name: result.currency_name,
      topup_url: result.topup_url,
      request_id: requestId,
    });
  } catch (error) {
    next(error);
  }
});

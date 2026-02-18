/**
 * @file routes/conversations.ts
 * @description API-роуты управления беседами: список, загрузка, скачивание
 * @context Используется фронтендом m006 через /api/conversations/*
 * @dependencies services/storage.ts, services/chat.ts
 * @affects Чтение и экспорт бесед
 */

import { Router, Request, Response, NextFunction } from 'express';
import { storageService } from '../services/storage';
import { ChatError } from '../services/chat';

// ============================================
// Conversations API Routes (m006)
// ============================================

export const conversationsRouter = Router();

/**
 * GET /api/conversations
 * Получить список бесед пользователя за последние 7 дней
 */
conversationsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.query.user_id as string;

    if (!userId) {
      throw new ChatError('MISSING_USER_ID', 'user_id обязателен', 400);
    }

    const conversations = await storageService.getUserConversations(userId, 7);

    res.json({
      success: true,
      conversations,
      request_id: req.requestId,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/conversations
 * Создать новую беседу (alias для /api/chat/new)
 */
conversationsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      throw new ChatError('MISSING_USER_ID', 'user_id обязателен', 400);
    }

    // Import here to avoid circular dependency
    const { chatService } = await import('../services/chat');
    const session = await chatService.createSession(user_id, req.requestId);

    res.json({
      success: true,
      ...session,
      request_id: req.requestId,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/conversations/:sessionId
 * Получить конкретную беседу с сообщениями
 */
conversationsRouter.get('/:sessionId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = req.params;
    const userId = req.query.user_id as string;

    if (!userId) {
      throw new ChatError('MISSING_USER_ID', 'user_id обязателен', 400);
    }

    const conversation = await storageService.getConversation(userId, sessionId);

    if (!conversation) {
      throw new ChatError('CONVERSATION_NOT_FOUND', 'Беседа не найдена', 404);
    }

    res.json({
      success: true,
      conversation,
      request_id: req.requestId,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/conversations/:sessionId/messages
 * Отправить сообщение в беседу
 */
conversationsRouter.post('/:sessionId/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = req.params;
    const { user_id, text, images } = req.body;

    if (!user_id) {
      throw new ChatError('MISSING_USER_ID', 'user_id обязателен', 400);
    }

    if (!text?.trim()) {
      throw new ChatError('EMPTY_MESSAGE', 'Сообщение не может быть пустым', 400);
    }

    const processedImages = images?.map((img: { data: string; filename: string; mime_type?: string; size_bytes?: number }) => ({
      data: img.data,
      filename: img.filename,
      mimeType: img.mime_type || 'image/jpeg',
      sizeBytes: img.size_bytes || 0,
    }));

    const { chatService } = await import('../services/chat');
    const result = await chatService.sendMessage({
      sessionId,
      userId: user_id,
      message: text.trim(),
      images: processedImages,
      requestId: req.requestId,
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
 * GET /api/conversations/:sessionId/download
 * Скачать беседу как Markdown
 */
conversationsRouter.get('/:sessionId/download', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sessionId } = req.params;
    const userId = req.query.user_id as string;

    if (!userId) {
      throw new ChatError('MISSING_USER_ID', 'user_id обязателен', 400);
    }

    const conversation = await storageService.getConversation(userId, sessionId);

    if (!conversation) {
      throw new ChatError('CONVERSATION_NOT_FOUND', 'Беседа не найдена', 404);
    }

    const markdown = await storageService.exportToMarkdown(userId, sessionId);

    if (!markdown) {
      throw new ChatError('EXPORT_FAILED', 'Не удалось экспортировать беседу', 500);
    }

    const filename = `server-mentor_${sessionId}.md`;

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(markdown);
  } catch (error) {
    next(error);
  }
});

/**
 * @file services/chat.ts
 * @description Основной сервис чата m006 Server-ментор — оркестрация streaming, биллинга, хранения
 * @context Используется routes/chat.ts для обработки сообщений пользователя
 * @dependencies services/core.ts, services/openai.ts, services/storage.ts, services/telegram.ts
 * @affects billing, conversations, SSE stream, уведомления администратору
 */

import { v4 as uuidv4 } from 'uuid';
import { coreClient } from './core';
import { streamChatCompletion, OpenAIUsage } from './openai';
import { storageService } from './storage';
import { notifyAdmin } from './telegram';
import { config } from '../config';
import { logger } from '../utils/logger';

// ============================================
// Chat Service (m006: Server-ментор)
// ============================================

export class ChatError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus: number
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

interface SendMessageParams {
  sessionId: string;
  userId: string;
  message: string;
  images?: Array<{
    data: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }>;
  requestId: string;
  shellId?: string;
  originUrl?: string;
  context?: Record<string, string>;
}

interface StreamEvent {
  type: 'status' | 'text_delta' | 'done' | 'error';
  status?: string;
  progress?: number;
  delta?: string;
  content?: string;
  usage?: OpenAIUsage;
  errorMessage?: string;
  errorCode?: string;
}

class ChatService {
  /**
   * Отправить сообщение с SSE-streaming ответом
   */
  async *sendMessageStream(params: SendMessageParams): AsyncGenerator<StreamEvent> {
    const { sessionId, userId, message, requestId, shellId, originUrl, context } = params;
    const startTime = Date.now();

    logger.info('sendMessageStream start', {
      requestId,
      sessionId,
      userId,
      messageLength: message.length,
      hasShellId: !!shellId,
      hasOriginUrl: !!originUrl,
      hasContext: !!context,
    });

    yield { type: 'status', status: 'Проверяем баланс...', progress: 5 };

    // 1. Billing start — проверка баланса
    let billingStarted = false;
    try {
      const billingResult = await coreClient.billingStart(userId, requestId);

      if (!billingResult.allowed) {
        logger.warn('Billing not allowed', {
          requestId,
          userId,
          reason: billingResult.reason,
          balance: billingResult.balance,
        });

        if (billingResult.reason === 'balance_non_positive' || billingResult.reason === 'balance_below_threshold') {
          yield {
            type: 'error',
            errorMessage: 'Недостаточно средств на балансе. Пополните баланс для продолжения.',
            errorCode: 'INSUFFICIENT_BALANCE',
          };
          return;
        }

        yield {
          type: 'error',
          errorMessage: `Операция отклонена: ${billingResult.reason}`,
          errorCode: 'BILLING_DENIED',
        };
        return;
      }

      billingStarted = true;
    } catch (error) {
      logger.error('Billing start failed', {
        requestId,
        userId,
        error: (error as Error).message,
      });

      // В dev-режиме продолжаем без биллинга
      if (config.nodeEnv === 'development') {
        logger.warn('Dev mode: continuing without billing', { requestId });
      } else {
        yield {
          type: 'error',
          errorMessage: 'Ошибка проверки баланса. Попробуйте позже.',
          errorCode: 'BILLING_ERROR',
        };
        return;
      }
    }

    yield { type: 'status', status: 'Загружаем историю беседы...', progress: 10 };

    // 2. Сохранить сообщение пользователя
    await storageService.addMessage(userId, sessionId, 'user', message);

    // 3. Получить историю для AI
    const history = await storageService.getMessagesForAI(userId, sessionId);

    // Если есть контекст (первое сообщение) — инжектить в системное сообщение
    const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
    if (context && Object.keys(context).length > 0) {
      const contextLines = Object.entries(context)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n');
      messages.push({
        role: 'system' as const,
        content: `Контекст пользователя:\n${contextLines}`,
      });
    }
    messages.push(...history);

    // 4. Запрос к OpenAI (streaming)
    let finalContent = '';
    let finalUsage: OpenAIUsage | undefined;
    let finalModel: string | undefined;
    let aiSucceeded = false;

    try {
      for await (const event of streamChatCompletion(messages, requestId)) {
        if (event.type === 'text_delta') {
          yield { type: 'text_delta', delta: event.delta };
        } else if (event.type === 'status') {
          yield { type: 'status', status: event.status, progress: event.progress };
        } else if (event.type === 'done') {
          finalContent = event.content || '';
          finalUsage = event.usage;
          finalModel = event.model;
          aiSucceeded = true;
        } else if (event.type === 'error') {
          yield { type: 'error', errorMessage: event.errorMessage, errorCode: event.errorCode };

          // Rollback billing
          if (billingStarted) {
            try {
              await coreClient.billingFinish(userId, requestId, 'rollback');
            } catch (rollbackErr) {
              logger.error('Billing rollback failed', {
                requestId,
                error: (rollbackErr as Error).message,
              });
            }
          }
          return;
        }
      }
    } catch (error) {
      logger.error('AI streaming failed', {
        requestId,
        error: (error as Error).message,
        stack: (error as Error).stack,
      });

      // Rollback billing
      if (billingStarted) {
        try {
          await coreClient.billingFinish(userId, requestId, 'rollback');
        } catch (rollbackErr) {
          logger.error('Billing rollback failed after AI error', {
            requestId,
            error: (rollbackErr as Error).message,
          });
        }
      }

      yield {
        type: 'error',
        errorMessage: 'Ошибка генерации ответа. Попробуйте позже.',
        errorCode: 'AI_ERROR',
      };
      return;
    }

    // 5. Сохранить ответ ассистента
    if (aiSucceeded && finalContent) {
      await storageService.addMessage(userId, sessionId, 'assistant', finalContent);
    }

    // 6. Billing finish (commit)
    if (billingStarted && aiSucceeded && finalUsage) {
      try {
        await coreClient.billingFinish(
          userId,
          requestId,
          'commit',
          finalUsage,
          finalModel,
          shellId,
          originUrl
        );
      } catch (error) {
        logger.error('Billing finish (commit) failed', {
          requestId,
          userId,
          error: (error as Error).message,
          usage: finalUsage,
        });
        // Не блокируем пользователя — ответ уже получен
      }
    } else if (billingStarted && !aiSucceeded) {
      // Rollback если AI не вернул результат
      try {
        await coreClient.billingFinish(userId, requestId, 'rollback');
      } catch (error) {
        logger.error('Billing rollback failed', {
          requestId,
          error: (error as Error).message,
        });
      }
    }

    const totalDuration = Date.now() - startTime;

    logger.info('sendMessageStream completed', {
      requestId,
      sessionId,
      userId,
      duration_ms: totalDuration,
      model: finalModel,
      input_tokens: finalUsage?.input_tokens,
      output_tokens: finalUsage?.output_tokens,
      content_length: finalContent.length,
    });

    yield {
      type: 'done',
      content: finalContent,
      usage: finalUsage,
    };
  }

  /**
   * Синхронная отправка сообщения (без streaming)
   */
  async sendMessage(params: SendMessageParams): Promise<{ content: string; usage?: OpenAIUsage }> {
    let finalContent = '';
    let finalUsage: OpenAIUsage | undefined;

    for await (const event of this.sendMessageStream(params)) {
      if (event.type === 'done') {
        finalContent = event.content || '';
        finalUsage = event.usage;
      } else if (event.type === 'error') {
        throw new ChatError(
          event.errorCode || 'CHAT_ERROR',
          event.errorMessage || 'Ошибка генерации ответа',
          500
        );
      }
    }

    return { content: finalContent, usage: finalUsage };
  }

  /**
   * Создать новую сессию (через CORE + локальное хранилище)
   */
  async createSession(userId: string, requestId: string): Promise<{ session_id: string }> {
    const idempotencyKey = uuidv4();

    try {
      const session = await coreClient.createSession(userId, idempotencyKey, requestId);
      await storageService.createConversation(userId, session.session_id);

      logger.info('Session created', {
        requestId,
        userId,
        sessionId: session.session_id,
      });

      return { session_id: session.session_id };
    } catch (error) {
      logger.error('Create session failed', {
        requestId,
        userId,
        error: (error as Error).message,
      });

      // Fallback: локальный session_id
      if (config.nodeEnv === 'development') {
        const localSessionId = `local_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        await storageService.createConversation(userId, localSessionId);
        logger.warn('Dev mode: using local session ID', { requestId, sessionId: localSessionId });
        return { session_id: localSessionId };
      }

      throw new ChatError('SESSION_CREATE_FAILED', 'Не удалось создать сессию', 500);
    }
  }

  /**
   * Resolve identity через CORE
   */
  async resolveIdentity(
    provider: string,
    tenant: string,
    externalUserId: string,
    requestId: string
  ): Promise<{ user_id: string; is_new: boolean }> {
    try {
      const result = await coreClient.resolveIdentity(provider, tenant, externalUserId, requestId);
      return { user_id: result.user_id, is_new: result.is_new };
    } catch (error) {
      logger.error('Identity resolution failed', {
        requestId,
        provider,
        tenant,
        error: (error as Error).message,
      });
      throw new ChatError('IDENTITY_ERROR', 'Ошибка идентификации пользователя', 500);
    }
  }

  /**
   * Получить баланс пользователя
   */
  async getBalance(
    userId: string,
    requestId: string,
    shellId?: string,
    originUrl?: string
  ): Promise<{ balance: number; currency_name: string; topup_url?: string }> {
    try {
      const result = await coreClient.getBalance(userId, requestId, shellId, originUrl);
      return {
        balance: result.balance,
        currency_name: result.currency_name,
        topup_url: result.topup_url,
      };
    } catch (error) {
      logger.error('Get balance failed', {
        requestId,
        userId,
        error: (error as Error).message,
      });
      throw new ChatError('BALANCE_ERROR', 'Не удалось получить баланс', 500);
    }
  }
}

// Suppress unused import warning — notifyAdmin used in analysis service
void notifyAdmin;

export const chatService = new ChatService();

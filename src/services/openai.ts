/**
 * @file services/openai.ts
 * @description Сервис взаимодействия с OpenAI API (Responses API) для m006 Server-ментор
 * @context Используется chat.ts для генерации ответов ассистента
 * @dependencies config, logger
 * @affects AI-генерация ответов, токены, биллинг
 */

import { config } from '../config';
import { logger } from '../utils/logger';

// ============================================
// OpenAI Service (m006: Server-ментор)
// Responses API с SSE-streaming
// ============================================

export interface OpenAIUsage {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details?: { cached_tokens: number };
  output_tokens_details?: { reasoning_tokens: number };
}

export interface OpenAIStreamEvent {
  type: 'text_delta' | 'done' | 'error' | 'status';
  delta?: string;
  content?: string;
  usage?: OpenAIUsage;
  model?: string;
  errorMessage?: string;
  errorCode?: string;
  status?: string;
  progress?: number;
}

interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** Максимальное число retry при 429 */
const MAX_RETRIES_429 = 3;
/** Базовая задержка перед retry (мс) */
const BASE_RETRY_DELAY = 2000;

/**
 * Custom error class for OpenAI errors
 */
export class OpenAIError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus: number
  ) {
    super(message);
    this.name = 'OpenAIError';
  }
}

/**
 * Отправить запрос к OpenAI Responses API с SSE-streaming
 */
export async function* streamChatCompletion(
  messages: ConversationMessage[],
  requestId: string
): AsyncGenerator<OpenAIStreamEvent> {
  const startTime = Date.now();

  yield { type: 'status', status: 'Подключение к AI модели...', progress: 10 };

  let retryCount = 0;
  let lastError: Error | null = null;

  while (retryCount <= MAX_RETRIES_429) {
    try {
      const url = 'https://api.openai.com/v1/responses';

      // Формируем input для Responses API
      const input = messages.map(msg => ({
        role: msg.role,
        content: msg.content,
      }));

      const body: Record<string, unknown> = {
        input,
        stream: true,
      };

      // Если настроен prompt_id — используем его
      if (config.openai.promptId) {
        body.prompt = { id: config.openai.promptId };
      } else {
        body.model = config.openai.model;
        body.instructions = 'Ты — опытный системный администратор Linux/Unix серверов. Помогаешь с настройкой VPS, DNS, Docker, Nginx, firewall, SSL-сертификатов, мониторинга, безопасности и автоматизации. Отвечай чётко, с примерами команд. Предупреждай об опасных операциях.';
      }

      logger.info('OpenAI Responses API request', {
        requestId,
        model: config.openai.model,
        promptId: config.openai.promptId || '(none)',
        messageCount: messages.length,
        retryCount,
      });

      yield { type: 'status', status: 'Отправлен запрос к модели...', progress: 20 };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.openai.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(900000), // 15 минут
      });

      // Обработка ошибок HTTP
      if (!response.ok) {
        const errorText = await response.text();
        let errorData: Record<string, unknown>;
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { raw: errorText };
        }

        // Rate limit — retry
        if (response.status === 429 && retryCount < MAX_RETRIES_429) {
          const retryAfter = response.headers.get('retry-after');
          const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : BASE_RETRY_DELAY * Math.pow(2, retryCount);

          logger.warn('OpenAI rate limited, retrying', {
            requestId,
            retryCount,
            delay,
            retryAfter,
          });

          yield { type: 'status', status: `Высокая нагрузка, повтор через ${Math.round(delay / 1000)}с...`, progress: 15 };
          await new Promise(resolve => setTimeout(resolve, delay));
          retryCount++;
          continue;
        }

        logger.error('OpenAI API error', {
          requestId,
          status: response.status,
          error: errorData,
        });

        throw new OpenAIError(
          'OPENAI_API_ERROR',
          `OpenAI API error: ${response.status} — ${JSON.stringify(errorData)}`,
          response.status
        );
      }

      // Чтение SSE-потока
      const reader = response.body?.getReader();
      if (!reader) {
        throw new OpenAIError('NO_STREAM', 'No response body', 500);
      }

      const decoder = new TextDecoder();
      let sseBuffer = '';
      let fullContent = '';
      let finalUsage: OpenAIUsage | undefined;
      let finalModel: string | undefined;
      let firstDeltaReceived = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });

        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || line.startsWith(':')) continue;

          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const eventType = parsed.type;

              if (eventType === 'response.output_text.delta') {
                const delta = parsed.delta || '';
                if (delta) {
                  if (!firstDeltaReceived) {
                    firstDeltaReceived = true;
                    const ttfd = Date.now() - startTime;
                    logger.info('First text delta received', { requestId, time_to_first_delta_ms: ttfd });
                  }
                  fullContent += delta;
                  yield { type: 'text_delta', delta };
                }
              } else if (eventType === 'response.completed') {
                const resp = parsed.response;
                if (resp?.usage) {
                  finalUsage = {
                    input_tokens: resp.usage.input_tokens || 0,
                    output_tokens: resp.usage.output_tokens || 0,
                    input_tokens_details: resp.usage.input_tokens_details,
                    output_tokens_details: resp.usage.output_tokens_details,
                  };
                }
                finalModel = resp?.model;
              } else if (eventType === 'error') {
                const errorMsg = parsed.error?.message || 'Unknown error';
                logger.error('OpenAI stream error event', { requestId, error: errorMsg });
                yield { type: 'error', errorMessage: errorMsg, errorCode: 'OPENAI_STREAM_ERROR' };
                return;
              }
            } catch {
              // Skip unparseable lines
            }
          } else if (line.startsWith('event: ')) {
            // OpenAI event types, handled via data parsing
          }
        }
      }

      const totalDuration = Date.now() - startTime;

      logger.info('OpenAI stream completed', {
        requestId,
        model: finalModel || config.openai.model,
        input_tokens: finalUsage?.input_tokens || 0,
        output_tokens: finalUsage?.output_tokens || 0,
        content_length: fullContent.length,
        duration_ms: totalDuration,
      });

      yield {
        type: 'done',
        content: fullContent,
        usage: finalUsage,
        model: finalModel || config.openai.model,
      };

      return;
    } catch (error) {
      lastError = error as Error;

      if (error instanceof OpenAIError) {
        throw error;
      }

      if (retryCount < MAX_RETRIES_429) {
        const delay = BASE_RETRY_DELAY * Math.pow(2, retryCount);
        logger.warn('OpenAI request error, retrying', {
          requestId,
          error: (error as Error).message,
          retryCount,
          delay,
        });
        yield { type: 'status', status: 'Повторная попытка подключения...', progress: 15 };
        await new Promise(resolve => setTimeout(resolve, delay));
        retryCount++;
        continue;
      }

      break;
    }
  }

  // All retries exhausted
  logger.error('OpenAI all retries exhausted', {
    requestId,
    error: lastError?.message,
    retryCount,
  });

  yield {
    type: 'error',
    errorMessage: 'Модель временно недоступна. Попробуйте позже.',
    errorCode: 'OPENAI_UNAVAILABLE',
  };
}

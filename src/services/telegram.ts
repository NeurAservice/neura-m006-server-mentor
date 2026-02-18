/**
 * @file services/telegram.ts
 * @description Сервис уведомлений администратора через Telegram-бота
 * @context Отправляет критические уведомления (ошибки, деплой, метрики)
 * @dependencies config/index.ts, utils/logger.ts
 * @affects Уведомления администратора
 */

import { config } from '../config';
import { logger } from '../utils/logger';

// ============================================
// Telegram Admin Notifications (m006)
// ============================================

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

/**
 * Отправить сообщение администратору через Telegram-бота
 * @param text - Текст сообщения (Markdown или HTML)
 * @param parseMode - Режим парсинга ('Markdown' | 'HTML')
 */
export async function notifyAdmin(
  text: string,
  parseMode: 'Markdown' | 'HTML' = 'Markdown'
): Promise<boolean> {
  const adminBotToken = config.admin.botToken;
  const adminChatId = config.admin.chatId;

  if (!adminBotToken || !adminChatId) {
    logger.warn('Telegram notification skipped: ADMIN_BOT_TOKEN or ADMIN_CHAT_ID not configured');
    return false;
  }

  const url = `${TELEGRAM_API_BASE}${adminBotToken}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: adminChatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error('Telegram notification failed', {
        status: response.status,
        body: errorBody,
      });
      return false;
    }

    logger.debug('Telegram notification sent', {
      textLength: text.length,
    });
    return true;
  } catch (error) {
    logger.error('Telegram notification error', {
      error: (error as Error).message,
    });
    return false;
  }
}

/**
 * Уведомление о запуске модуля
 */
export async function notifyModuleStarted(): Promise<void> {
  const text = [
    `🟢 *m006 Server-ментор* запущен`,
    `Env: ${config.nodeEnv}`,
    `Port: ${config.port}`,
    `Time: ${new Date().toISOString()}`,
  ].join('\n');

  await notifyAdmin(text);
}

/**
 * Уведомление о критической ошибке
 */
export async function notifyCriticalError(error: Error, context?: string): Promise<void> {
  const text = [
    `🔴 *m006 Server-ментор* — критическая ошибка`,
    context ? `Context: ${context}` : '',
    `Error: \`${error.message}\``,
    `Time: ${new Date().toISOString()}`,
  ]
    .filter(Boolean)
    .join('\n');

  await notifyAdmin(text);
}

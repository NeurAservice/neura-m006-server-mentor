/**
 * @file services/telegram.ts
 * @description Сервис уведомлений администратора через Telegram-бота.
 *   Поддерживает текстовые сообщения и отправку документов (файлов).
 * @context Отправляет отчёты автоанализа, критические уведомления, деплой
 * @dependencies config/index.ts, utils/logger.ts
 * @affects Уведомления администратора
 */

import { config } from '../config';
import { logger } from '../utils/logger';

// ============================================
// Telegram Admin Notifications (m006)
// ============================================

const TELEGRAM_API_BASE = 'https://api.telegram.org';

class TelegramService {
  private botToken: string;
  private chatId: string;

  constructor() {
    this.botToken = config.admin.botToken;
    this.chatId = config.admin.chatId;
  }

  /** Проверка доступности настроек Telegram */
  isConfigured(): boolean {
    return Boolean(this.botToken && this.chatId);
  }

  /** Отправить текстовое сообщение администратору */
  async sendMessage(text: string, parseMode: 'HTML' | 'Markdown' = 'HTML'): Promise<boolean> {
    if (!this.isConfigured()) {
      logger.warn('Telegram bot not configured, skipping notification');
      return false;
    }

    try {
      const url = `${TELEGRAM_API_BASE}/bot${this.botToken}/sendMessage`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: parseMode,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Telegram sendMessage failed', { status: response.status, error: errorText });
        return false;
      }

      logger.debug('Telegram notification sent', { textLength: text.length });
      return true;
    } catch (error) {
      logger.error('Telegram sendMessage error', { error: (error as Error).message });
      return false;
    }
  }

  /**
   * Отправить документ (файл) администратору
   * @param fileBuffer - Содержимое файла (Buffer)
   * @param filename - Имя файла
   * @param caption - Подпись к файлу (HTML)
   */
  async sendDocument(fileBuffer: Buffer, filename: string, caption?: string): Promise<boolean> {
    if (!this.isConfigured()) {
      logger.warn('Telegram bot not configured, skipping document send');
      return false;
    }

    try {
      const url = `${TELEGRAM_API_BASE}/bot${this.botToken}/sendDocument`;

      const formData = new FormData();
      formData.append('chat_id', this.chatId);

      const blob = new Blob([fileBuffer], { type: 'text/markdown' });
      formData.append('document', blob, filename);

      if (caption) {
        formData.append('caption', caption);
        formData.append('parse_mode', 'HTML');
      }

      const response = await fetch(url, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(60000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Telegram sendDocument failed', {
          status: response.status, error: errorText, filename,
        });
        return false;
      }

      logger.info('Telegram document sent', {
        chatId: this.chatId, filename, sizeBytes: fileBuffer.length,
      });
      return true;
    } catch (error) {
      logger.error('Telegram sendDocument error', {
        error: (error as Error).message, filename,
      });
      return false;
    }
  }
}

// Singleton instance
export const telegramService = new TelegramService();

// --- Convenience wrappers (обратная совместимость) ---

/**
 * Отправить сообщение администратору (обёртка для обратной совместимости)
 */
export async function notifyAdmin(
  text: string,
  parseMode: 'Markdown' | 'HTML' = 'Markdown'
): Promise<boolean> {
  return telegramService.sendMessage(text, parseMode);
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

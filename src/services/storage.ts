/**
 * @file services/storage.ts
 * @description Файловое хранение бесед для m006 (JSON-файлы в /app/data)
 * @context Используется chat.ts для CRUD операций над беседами
 * @dependencies config, logger
 * @affects Дисковые операции: создание, чтение, обновление, удаление файлов бесед
 */

import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

// ============================================
// Storage Service (m006)
// Файловое хранение бесед в JSON-формате
// ============================================

interface MessageAttachment {
  type: string;
  filename: string;
  dataUrl?: string;
}

interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  attachments?: MessageAttachment[];
}

interface Conversation {
  session_id: string;
  user_id: string;
  title: string;
  messages: ConversationMessage[];
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

interface ConversationSummary {
  session_id: string;
  title: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

class StorageService {
  private dataPath: string;

  constructor() {
    this.dataPath = config.dataPath;
    this.ensureDirectories();
  }

  /**
   * Создать директории хранения
   */
  private async ensureDirectories(): Promise<void> {
    try {
      await fs.mkdir(this.dataPath, { recursive: true });
      logger.debug('Storage directories ensured', { dataPath: this.dataPath });
    } catch (error) {
      logger.error('Failed to create storage directories', {
        error: (error as Error).message,
        dataPath: this.dataPath,
      });
    }
  }

  /**
   * Путь к файлу беседы
   */
  private getConversationPath(userId: string, sessionId: string): string {
    return path.join(this.dataPath, userId, `${sessionId}.json`);
  }

  /**
   * Путь к директории бесед пользователя
   */
  private getUserPath(userId: string): string {
    return path.join(this.dataPath, userId);
  }

  /**
   * Создать новую беседу
   */
  async createConversation(userId: string, sessionId: string): Promise<Conversation> {
    const userPath = this.getUserPath(userId);
    await fs.mkdir(userPath, { recursive: true });

    const conversation: Conversation = {
      session_id: sessionId,
      user_id: userId,
      title: 'Новая беседа',
      messages: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const filePath = this.getConversationPath(userId, sessionId);
    await fs.writeFile(filePath, JSON.stringify(conversation, null, 2), 'utf-8');

    logger.info('Conversation created', { userId, sessionId });
    return conversation;
  }

  /**
   * Получить беседу
   */
  async getConversation(userId: string, sessionId: string): Promise<Conversation | null> {
    const filePath = this.getConversationPath(userId, sessionId);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as Conversation;
    } catch {
      return null;
    }
  }

  /**
   * Сохранить беседу
   */
  async saveConversation(conversation: Conversation): Promise<void> {
    const userPath = this.getUserPath(conversation.user_id);
    await fs.mkdir(userPath, { recursive: true });

    conversation.updated_at = new Date().toISOString();
    const filePath = this.getConversationPath(conversation.user_id, conversation.session_id);
    await fs.writeFile(filePath, JSON.stringify(conversation, null, 2), 'utf-8');
  }

  /**
   * Добавить сообщение в беседу
   */
  async addMessage(
    userId: string,
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    attachments?: MessageAttachment[]
  ): Promise<void> {
    let conversation = await this.getConversation(userId, sessionId);

    if (!conversation) {
      conversation = await this.createConversation(userId, sessionId);
    }

    const message: ConversationMessage = {
      role,
      content,
      timestamp: new Date().toISOString(),
      attachments,
    };

    conversation.messages.push(message);

    // Обновить заголовок по первому сообщению пользователя
    if (role === 'user' && conversation.title === 'Новая беседа') {
      conversation.title = content.substring(0, 80) + (content.length > 80 ? '...' : '');
    }

    await this.saveConversation(conversation);
  }

  /**
   * Получить список бесед пользователя
   */
  async getUserConversations(userId: string, days: number = 7): Promise<ConversationSummary[]> {
    const userPath = this.getUserPath(userId);

    try {
      const files = await fs.readdir(userPath);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      const conversations: ConversationSummary[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
          const filePath = path.join(userPath, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const conv = JSON.parse(content) as Conversation;

          if (new Date(conv.created_at) >= cutoffDate) {
            conversations.push({
              session_id: conv.session_id,
              title: conv.title,
              message_count: conv.messages.length,
              created_at: conv.created_at,
              updated_at: conv.updated_at,
            });
          }
        } catch {
          // Skip corrupted files
        }
      }

      // Сортировка по дате обновления (свежие сверху)
      conversations.sort((a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );

      return conversations;
    } catch {
      return [];
    }
  }

  /**
   * Получить историю сообщений для OpenAI (без системных)
   */
  async getMessagesForAI(userId: string, sessionId: string): Promise<Array<{ role: 'user' | 'assistant' | 'system'; content: string }>> {
    const conversation = await this.getConversation(userId, sessionId);

    if (!conversation) return [];

    return conversation.messages
      .filter(msg => msg.role === 'user' || msg.role === 'assistant')
      .map(msg => ({
        role: msg.role,
        content: msg.content,
      }));
  }

  /**
   * Экспорт беседы в Markdown
   */
  async exportToMarkdown(userId: string, sessionId: string): Promise<string | null> {
    const conversation = await this.getConversation(userId, sessionId);
    if (!conversation) return null;

    let md = `# ${conversation.title}\n\n`;
    md += `> Экспорт: ${new Date().toLocaleString('ru-RU')}\n\n---\n\n`;

    for (const msg of conversation.messages) {
      const time = new Date(msg.timestamp).toLocaleTimeString('ru-RU');
      if (msg.role === 'user') {
        md += `## 👤 Пользователь [${time}]\n\n${msg.content}\n\n`;
      } else if (msg.role === 'assistant') {
        md += `## 🤖 Server-ментор [${time}]\n\n${msg.content}\n\n`;
      }
      md += '---\n\n';
    }

    return md;
  }
}

/**
 * Очистка старых бесед (cron-задача)
 */
export async function cleanupOldConversations(): Promise<number> {
  const dataPath = config.dataPath;
  let deletedCount = 0;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - config.conversationTtlDays);

  try {
    const users = await fs.readdir(dataPath);

    for (const userId of users) {
      const userPath = path.join(dataPath, userId);
      const stat = await fs.stat(userPath);
      if (!stat.isDirectory()) continue;

      const files = await fs.readdir(userPath);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
          const filePath = path.join(userPath, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const conv = JSON.parse(content);

          if (new Date(conv.updated_at || conv.created_at) < cutoffDate) {
            await fs.unlink(filePath);
            deletedCount++;
          }
        } catch {
          // Skip
        }
      }

      // Удалить пустые директории
      const remaining = await fs.readdir(userPath);
      if (remaining.length === 0) {
        await fs.rmdir(userPath);
      }
    }
  } catch (error) {
    logger.error('Cleanup error', { error: (error as Error).message });
  }

  return deletedCount;
}

export const storageService = new StorageService();

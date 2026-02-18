/**
 * @file services/analysis.ts
 * @description Сервис анализа бесед (опционально, управляется через ANALYSIS_ENABLED)
 * @context Анализирует историю бесед для улучшения ответов
 * @dependencies services/storage.ts, utils/logger.ts
 * @affects Аналитика бесед
 */

import { storageService } from './storage';
import { logger } from '../utils/logger';
import { config } from '../config';

// ============================================
// Analysis Service (m006: Server-ментор)
// ============================================

interface ConversationStats {
  totalConversations: number;
  totalMessages: number;
  averageMessagesPerConversation: number;
  oldestConversation: string | null;
  newestConversation: string | null;
}

interface UserStats {
  userId: string;
  conversationCount: number;
  totalMessages: number;
  lastActivity: string | null;
}

class AnalysisService {
  private get enabled(): boolean {
    return config.analysis.enabled;
  }

  /**
   * Получить статистику бесед пользователя
   */
  async getUserStats(userId: string, requestId: string): Promise<UserStats> {
    logger.info('getUserStats', { requestId, userId });

    const conversations = await storageService.getUserConversations(userId);

    let totalMessages = 0;
    let lastActivity: string | null = null;

    for (const conv of conversations) {
      totalMessages += conv.message_count;
      if (!lastActivity || conv.updated_at > lastActivity) {
        lastActivity = conv.updated_at;
      }
    }

    return {
      userId,
      conversationCount: conversations.length,
      totalMessages,
      lastActivity,
    };
  }

  /**
   * Получить общую статистику (для админки)
   */
  async getGlobalStats(requestId: string): Promise<ConversationStats> {
    if (!this.enabled) {
      logger.debug('Analysis disabled, returning empty stats', { requestId });
      return {
        totalConversations: 0,
        totalMessages: 0,
        averageMessagesPerConversation: 0,
        oldestConversation: null,
        newestConversation: null,
      };
    }

    logger.info('getGlobalStats', { requestId });

    // Примечание: полный скан данных — использовать осторожно
    return {
      totalConversations: 0,
      totalMessages: 0,
      averageMessagesPerConversation: 0,
      oldestConversation: null,
      newestConversation: null,
    };
  }
}

export const analysisService = new AnalysisService();

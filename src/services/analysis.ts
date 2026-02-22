/**
 * @file services/analysis.ts
 * @description Сервис автоанализа бесед пользователей с моделью.
 *   Выявляет ошибки системного промпта, формирует рекомендации по улучшению.
 *   Поддерживает последовательный запуск нескольких задач анализа.
 *   Результаты накапливаются в JSON-файле, сводный отчёт — в Telegram.
 * @context Запускается ежедневно по cron (стандарт: 05:00 UTC для m006).
 *   Расписание разнесено по модулям: m001=03:00, m005=04:00, m006=05:00 —
 *   чтобы не перегружать сервер (1 CPU / 960MB RAM).
 * @dependencies services/telegram.ts, config
 * @affects data/analysis/ (errors.json, state.json, reports/)
 */

import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { telegramService } from './telegram';

// ============================================
// Conversation Analysis Service
// m006: Server-ментор — AI-ассистент администрирования VPS
// ============================================

// --- Типы данных ---

/** Одна найденная ошибка с решением и рекомендацией */
export interface AnalysisError {
  id: string;
  detected_at: string;
  user_id: string;
  session_id: string;
  error_summary: string;
  error_description: string;
  error_category: AnalysisErrorCategory;
  resolution: string | null;
  resolution_found: boolean;
  prompt_recommendation: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message_indices: number[];
}

/** Категории ошибок промпта (адаптированы для серверного администрирования) */
export type AnalysisErrorCategory =
  | 'dangerous_command'       // Опасная команда без предупреждения
  | 'incorrect_config'        // Неверная конфигурация сервера
  | 'hallucination'           // Выдуманные пакеты, команды, параметры
  | 'security_risk'           // Рекомендация с уязвимостью безопасности
  | 'incomplete_answer'       // Неполная инструкция, пропущены шаги
  | 'missing_context'         // Не учтена ОС, дистрибутив, версия
  | 'instruction_violation'   // Нарушение инструкций промпта
  | 'misunderstanding'        // Неверное понимание запроса
  | 'tone_mismatch'           // Неуместный тон
  | 'other';

/** Файл с накопленными ошибками */
export interface AnalysisErrorsFile {
  version: string;
  last_updated: string;
  module_id: string;
  total_errors: number;
  errors: AnalysisError[];
}

/** Состояние анализа */
interface AnalysisState {
  last_analysis_at: string | null;
  last_conversations_analyzed: number;
  last_errors_found: number;
  total_runs: number;
}

/** Результат анализа одной беседы от модели */
interface ConversationAnalysisResult {
  session_id: string;
  user_id: string;
  errors: Array<{
    error_summary: string;
    error_description: string;
    error_category: AnalysisErrorCategory;
    resolution: string | null;
    resolution_found: boolean;
    prompt_recommendation: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    message_indices: number[];
  }>;
}

/** Результат полного прогона анализа */
interface AnalysisRunResult {
  analyzed_conversations: number;
  total_errors_found: number;
  errors: AnalysisError[];
  skipped_conversations: number;
  duration_ms: number;
}

/** Беседа для анализа (чтение с диска) */
interface ConversationForAnalysis {
  session_id: string;
  user_id: string;
  title: string;
  messages: Array<{
    role: string;
    content: string;
    timestamp: string;
  }>;
  updated_at: string;
  created_at: string;
}

/** Задача анализа для последовательного runner'а */
interface AnalysisTask {
  id: string;
  name: string;
  run: () => Promise<void>;
}

// --- Константы ---

const ANALYSIS_DIR = 'analysis';
const ERRORS_FILE = 'errors.json';
const STATE_FILE = 'state.json';
const REPORTS_DIR = 'reports';

/** Пауза между анализами отдельных бесед (мс) — защита от rate limit */
const CONVERSATION_DELAY_MS = 3000;
/** Пауза между задачами анализа (мс) — предотвращение пиков потребления */
const TASK_DELAY_MS = 5000;

class ConversationAnalysisService {
  private analysisPath: string;
  private errorsPath: string;
  private statePath: string;
  private reportsPath: string;

  /** Реестр задач анализа (выполняются последовательно) */
  private tasks: AnalysisTask[] = [];

  constructor() {
    this.analysisPath = path.join(config.dataPath, ANALYSIS_DIR);
    this.errorsPath = path.join(this.analysisPath, ERRORS_FILE);
    this.statePath = path.join(this.analysisPath, STATE_FILE);
    this.reportsPath = path.join(this.analysisPath, REPORTS_DIR);

    // Регистрация задач анализа
    this.tasks.push({
      id: 'error_detection',
      name: 'Поиск ошибок промпта',
      run: () => this.runErrorDetection(),
    });
  }

  /**
   * Зарегистрировать дополнительную задачу анализа.
   * Задачи выполняются последовательно в порядке регистрации.
   */
  registerTask(task: AnalysisTask): void {
    this.tasks.push(task);
    logger.info('Analysis task registered', { taskId: task.id, taskName: task.name });
  }

  // ===== Инициализация =====

  private async initialize(): Promise<void> {
    await fs.mkdir(this.analysisPath, { recursive: true });
    await fs.mkdir(this.reportsPath, { recursive: true });
  }

  // ===== Работа с состоянием =====

  private async getState(): Promise<AnalysisState> {
    try {
      const content = await fs.readFile(this.statePath, 'utf-8');
      return JSON.parse(content) as AnalysisState;
    } catch {
      return {
        last_analysis_at: null,
        last_conversations_analyzed: 0,
        last_errors_found: 0,
        total_runs: 0,
      };
    }
  }

  private async saveState(state: AnalysisState): Promise<void> {
    await fs.writeFile(this.statePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  // ===== Работа с файлом ошибок =====

  private async loadErrors(): Promise<AnalysisErrorsFile> {
    try {
      const content = await fs.readFile(this.errorsPath, 'utf-8');
      return JSON.parse(content) as AnalysisErrorsFile;
    } catch {
      return {
        version: '1.0',
        last_updated: new Date().toISOString(),
        module_id: config.moduleId,
        total_errors: 0,
        errors: [],
      };
    }
  }

  private async saveErrors(errorsFile: AnalysisErrorsFile): Promise<void> {
    errorsFile.last_updated = new Date().toISOString();
    errorsFile.total_errors = errorsFile.errors.length;
    await fs.writeFile(this.errorsPath, JSON.stringify(errorsFile, null, 2), 'utf-8');
  }

  // ===== Сбор бесед =====

  private async getConversationsSinceLastAnalysis(
    lastAnalysisAt: string | null
  ): Promise<ConversationForAnalysis[]> {
    const dataPath = config.dataPath;
    const conversations: ConversationForAnalysis[] = [];
    const cutoff = lastAnalysisAt ? new Date(lastAnalysisAt).getTime() : 0;

    try {
      const userDirs = await fs.readdir(dataPath);

      for (const userDir of userDirs) {
        // Пропускаем служебные папки
        if (userDir === 'analysis') continue;

        const userPath = path.join(dataPath, userDir);
        const stat = await fs.stat(userPath);
        if (!stat.isDirectory()) continue;

        const files = await fs.readdir(userPath);

        for (const file of files) {
          if (!file.endsWith('.json')) continue;

          try {
            const filePath = path.join(userPath, file);
            const content = await fs.readFile(filePath, 'utf-8');
            const convo = JSON.parse(content);

            // Пропускаем пустые и слишком короткие беседы
            if (!convo.messages || convo.messages.length < 2) continue;

            const updatedAt = new Date(convo.updated_at || convo.updatedAt).getTime();
            if (updatedAt > cutoff) {
              conversations.push({
                session_id: convo.session_id || convo.id || file.replace('.json', ''),
                user_id: convo.user_id || convo.userId || userDir,
                title: convo.title || 'Без названия',
                messages: (convo.messages || []).map((m: Record<string, unknown>) => ({
                  role: m.role as string,
                  content: m.content as string,
                  timestamp: m.timestamp as string,
                })),
                updated_at: convo.updated_at || convo.updatedAt,
                created_at: convo.created_at || convo.createdAt,
              });
            }
          } catch (error) {
            logger.warn('Failed to read conversation for analysis', {
              file, userDir, error: (error as Error).message,
            });
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.info('No data directory found, nothing to analyze');
        return [];
      }
      throw error;
    }

    return conversations;
  }

  // ===== AI-анализ =====

  /**
   * Системный промпт для QA-аналитика.
   * Адаптирован под m006 (серверное администрирование) — акцент на безопасность.
   */
  private getAnalysisSystemPrompt(): string {
    return `Ты — старший QA-аналитик AI-систем. Твоя задача — анализировать беседы между пользователем и AI-ассистентом для администрирования серверов и находить ошибки в работе системного промпта.

## Твоя роль

Ты получаешь полную историю беседы между пользователем и AI-ассистентом "${config.moduleName}" (модуль ${config.moduleId}). Это ассистент для администрирования VPS-серверов — он помогает с настройкой Linux/Unix серверов, Docker, Nginx, firewall, SSL, мониторинга, безопасности и автоматизации. Твоя цель — выявить случаи, когда ассистент работал некорректно.

## Что ты ищешь

1. **Опасные команды без предупреждения** — ассистент предложил деструктивную команду (rm -rf, DROP TABLE, iptables flush) без явного предупреждения о последствиях
2. **Неверная конфигурация** — ошибки в конфигах Nginx, Docker, systemd, firewall и т.д.
3. **Галлюцинации** — выдуманные пакеты, несуществующие флаги команд, неверные пути
4. **Уязвимости безопасности** — рекомендации, создающие дыры в безопасности (открытие портов без firewall, chmod 777, пароли в командной строке)
5. **Неполные инструкции** — пропущены важные шаги (перезагрузка сервиса, проверка синтаксиса, бэкап перед изменениями)
6. **Потеря контекста** — не учтена ОС, дистрибутив, версия ПО из предыдущих сообщений
7. **Нарушение инструкций** — не следовал правилам промпта
8. **Непонимание запроса** — неверно интерпретировал, что просил пользователь
9. **Неуместный тон** — ответ не соответствует ожидаемому стилю

## Как оценивать

- Анализируй ВСЮ беседу целиком, учитывая контекст
- Обращай особое внимание на безопасность — любая рекомендация, которая может навредить серверу, это серьёзная ошибка
- Ищи моменты, где пользователь указал на ошибку
- Ищи перефразирования (возможно, ассистент не понял)
- Если пользователь нашёл решение — зафиксируй это
- Будь объективен: не выдумывай ошибки. Если беседа прошла хорошо — верни пустой массив.

## Серьёзность (severity)

- **critical** — опасная команда без предупреждения, уязвимость безопасности, команда, которая может уничтожить данные
- **high** — неверная конфигурация, галлюцинация, значительная ошибка
- **medium** — неполные инструкции, потеря контекста
- **low** — мелкий недочёт (стиль, порядок шагов)

## Формат ответа

Ответь СТРОГО в формате JSON (без markdown-обёртки, без \`\`\`json). Верни объект:

{
  "errors": [
    {
      "error_summary": "Краткое описание ошибки (1 предложение)",
      "error_description": "Подробное описание: что произошло, почему это ошибка, как повлияло",
      "error_category": "<одна из категорий>",
      "resolution": "Описание решения, если найдено в беседе, или null",
      "resolution_found": true/false,
      "prompt_recommendation": "Конкретная рекомендация: что добавить/изменить в промпте",
      "severity": "low|medium|high|critical",
      "message_indices": [0, 1, 2]
    }
  ]
}

Допустимые значения error_category:
- dangerous_command
- incorrect_config
- hallucination
- security_risk
- incomplete_answer
- missing_context
- instruction_violation
- misunderstanding
- tone_mismatch
- other

Если ошибок нет — верни: {"errors": []}
message_indices — индексы сообщений (с 0), где проявилась ошибка.`;
  }

  /**
   * Преобразовать беседу в текст для отправки модели
   */
  private formatConversationForAnalysis(conversation: ConversationForAnalysis): string {
    let text = `=== Беседа ===\n`;
    text += `Session ID: ${conversation.session_id}\n`;
    text += `User ID: ${conversation.user_id}\n`;
    text += `Создана: ${conversation.created_at}\n`;
    text += `Обновлена: ${conversation.updated_at}\n`;
    text += `Количество сообщений: ${conversation.messages.length}\n`;
    text += `---\n\n`;

    for (let i = 0; i < conversation.messages.length; i++) {
      const msg = conversation.messages[i];
      const role = msg.role === 'user' ? 'ПОЛЬЗОВАТЕЛЬ' : 'АССИСТЕНТ';
      const time = msg.timestamp
        ? new Date(msg.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
        : '??:??';
      text += `[${i}] ${role} (${time}):\n${msg.content}\n\n`;
    }

    return text;
  }

  /**
   * Отправить беседу на анализ через OpenAI Responses API
   */
  private async analyzeConversation(
    conversation: ConversationForAnalysis
  ): Promise<ConversationAnalysisResult> {
    const formattedConversation = this.formatConversationForAnalysis(conversation);

    const requestBody: Record<string, unknown> = {
      model: config.analysis.model,
      instructions: this.getAnalysisSystemPrompt(),
      input: [
        {
          role: 'user',
          content: `Проанализируй следующую беседу и найди ошибки системного промпта:\n\n${formattedConversation}`,
        },
      ],
      reasoning: { effort: 'high' },
      store: false,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 мин

    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.openai.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Analysis API call failed', {
          status: response.status,
          error: errorText,
          sessionId: conversation.session_id,
        });
        throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
      }

      const data = await response.json() as Record<string, unknown>;

      // Извлечь текст ответа
      let content = '';
      const output = data.output as Array<Record<string, unknown>>;
      if (output) {
        for (const item of output) {
          if (item.type === 'message') {
            const messageContent = item.content as Array<Record<string, unknown>>;
            if (messageContent) {
              for (const c of messageContent) {
                if ((c.type === 'output_text' || c.type === 'text') && c.text) {
                  content += c.text as string;
                }
              }
            }
          }
        }
      }

      const usage = data.usage as Record<string, number> | undefined;
      logger.info('Analysis API response received', {
        sessionId: conversation.session_id,
        model: data.model,
        usage: usage ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } : 'unknown',
        contentLength: content.length,
      });

      const parsed = this.parseAnalysisResponse(content);

      return {
        session_id: conversation.session_id,
        user_id: conversation.user_id,
        errors: parsed.errors || [],
      };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        logger.error('Analysis API timeout', { sessionId: conversation.session_id });
        throw new Error('Analysis API timeout after 5 minutes');
      }

      throw error;
    }
  }

  /**
   * Безопасный парсинг JSON-ответа от модели
   */
  private parseAnalysisResponse(content: string): { errors: ConversationAnalysisResult['errors'] } {
    try {
      let cleaned = content.trim();
      if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
      else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
      if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
      cleaned = cleaned.trim();

      const parsed = JSON.parse(cleaned);

      if (!parsed.errors || !Array.isArray(parsed.errors)) {
        logger.warn('Analysis response missing errors array', { content: cleaned.substring(0, 500) });
        return { errors: [] };
      }

      const validCategories = new Set([
        'dangerous_command', 'incorrect_config', 'hallucination', 'security_risk',
        'incomplete_answer', 'missing_context', 'instruction_violation',
        'misunderstanding', 'tone_mismatch', 'other',
      ]);
      const validSeverities = new Set(['low', 'medium', 'high', 'critical']);

      return {
        errors: parsed.errors
          .filter((e: Record<string, unknown>) => e.error_summary && e.error_description)
          .map((e: Record<string, unknown>) => ({
            error_summary: String(e.error_summary),
            error_description: String(e.error_description),
            error_category: validCategories.has(e.error_category as string)
              ? e.error_category as AnalysisErrorCategory
              : 'other',
            resolution: e.resolution ? String(e.resolution) : null,
            resolution_found: Boolean(e.resolution_found),
            prompt_recommendation: String(e.prompt_recommendation || 'Нет рекомендации'),
            severity: validSeverities.has(e.severity as string)
              ? e.severity as 'low' | 'medium' | 'high' | 'critical'
              : 'medium',
            message_indices: Array.isArray(e.message_indices) ? (e.message_indices as number[]) : [],
          })),
      };
    } catch (error) {
      logger.error('Failed to parse analysis response', {
        error: (error as Error).message,
        content: content.substring(0, 500),
      });
      return { errors: [] };
    }
  }

  // ===== Генерация отчёта =====

  private generateReport(result: AnalysisRunResult, runTimestamp: string): string {
    const date = new Date(runTimestamp).toLocaleString('ru-RU', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'Europe/Moscow',
    });

    let md = `# 📊 Отчёт автоанализа бесед\n\n`;
    md += `**Модуль:** ${config.moduleId} — ${config.moduleName}\n`;
    md += `**Дата анализа:** ${date} (MSK)\n`;
    md += `**Модель анализа:** ${config.analysis.model}\n\n`;

    md += `## Сводка\n\n`;
    md += `| Показатель | Значение |\n`;
    md += `|---|---|\n`;
    md += `| Проанализировано бесед | ${result.analyzed_conversations} |\n`;
    md += `| Пропущено бесед | ${result.skipped_conversations} |\n`;
    md += `| Найдено ошибок | ${result.total_errors_found} |\n`;
    md += `| Время анализа | ${(result.duration_ms / 1000).toFixed(1)} сек |\n\n`;

    if (result.total_errors_found === 0) {
      md += `---\n\n✅ **Ошибок не обнаружено.** Промпт работает корректно.\n`;
      return md;
    }

    const bySeverity = {
      critical: result.errors.filter(e => e.severity === 'critical'),
      high: result.errors.filter(e => e.severity === 'high'),
      medium: result.errors.filter(e => e.severity === 'medium'),
      low: result.errors.filter(e => e.severity === 'low'),
    };

    md += `### Распределение по серьёзности\n\n`;
    if (bySeverity.critical.length) md += `- 🔴 **Critical:** ${bySeverity.critical.length}\n`;
    if (bySeverity.high.length) md += `- 🟠 **High:** ${bySeverity.high.length}\n`;
    if (bySeverity.medium.length) md += `- 🟡 **Medium:** ${bySeverity.medium.length}\n`;
    if (bySeverity.low.length) md += `- 🟢 **Low:** ${bySeverity.low.length}\n`;
    md += `\n`;

    const byCategory: Record<string, AnalysisError[]> = {};
    for (const err of result.errors) {
      if (!byCategory[err.error_category]) byCategory[err.error_category] = [];
      byCategory[err.error_category].push(err);
    }

    md += `### Распределение по категориям\n\n`;
    for (const [cat, errs] of Object.entries(byCategory)) {
      md += `- **${cat}:** ${errs.length}\n`;
    }
    md += `\n---\n\n## Детали ошибок\n\n`;

    const sortedErrors = [
      ...bySeverity.critical, ...bySeverity.high,
      ...bySeverity.medium, ...bySeverity.low,
    ];

    for (let i = 0; i < sortedErrors.length; i++) {
      const err = sortedErrors[i];
      const icon = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' }[err.severity];

      md += `### ${i + 1}. ${icon} ${err.error_summary}\n\n`;
      md += `- **Серьёзность:** ${err.severity}\n`;
      md += `- **Категория:** ${err.error_category}\n`;
      md += `- **Беседа:** \`${err.session_id}\`\n`;
      md += `- **Пользователь:** \`${err.user_id}\`\n`;
      md += `- **Сообщения:** ${err.message_indices.join(', ')}\n\n`;
      md += `**Описание:** ${err.error_description}\n\n`;

      if (err.resolution_found && err.resolution) {
        md += `**Решение найдено:** ✅ ${err.resolution}\n\n`;
      } else {
        md += `**Решение найдено:** ❌ Нет\n\n`;
      }

      md += `**💡 Рекомендация по промпту:**\n> ${err.prompt_recommendation}\n\n---\n\n`;
    }

    return md;
  }

  private generateTelegramCaption(result: AnalysisRunResult): string {
    const sev = {
      critical: result.errors.filter(e => e.severity === 'critical').length,
      high: result.errors.filter(e => e.severity === 'high').length,
      medium: result.errors.filter(e => e.severity === 'medium').length,
      low: result.errors.filter(e => e.severity === 'low').length,
    };

    let caption = `<b>📊 #${config.moduleId} | ${config.moduleName}</b>\n`;
    caption += `<b>Автоанализ бесед — поиск ошибок</b>\n\n`;
    caption += `📋 Бесед проанализировано: <b>${result.analyzed_conversations}</b>\n`;
    caption += `🔍 Ошибок найдено: <b>${result.total_errors_found}</b>\n`;

    if (result.total_errors_found > 0) {
      caption += `\n<b>По серьёзности:</b>\n`;
      if (sev.critical) caption += `🔴 Critical: ${sev.critical}\n`;
      if (sev.high) caption += `🟠 High: ${sev.high}\n`;
      if (sev.medium) caption += `🟡 Medium: ${sev.medium}\n`;
      if (sev.low) caption += `🟢 Low: ${sev.low}\n`;

      const topErrors = result.errors
        .filter(e => e.severity === 'critical' || e.severity === 'high')
        .slice(0, 3);

      if (topErrors.length > 0) {
        caption += `\n<b>Ключевые рекомендации:</b>\n`;
        for (const err of topErrors) {
          caption += `• ${err.error_summary}\n`;
        }
      }
    } else {
      caption += `\n✅ Промпт работает корректно.`;
    }

    caption += `\n⏱ Время: ${(result.duration_ms / 1000).toFixed(1)} сек`;

    return caption;
  }

  // ===== API endpoints (сохраняем для совместимости с routes/analysis.ts) =====

  /**
   * Получить статистику бесед пользователя
   */
  async getUserStats(userId: string, requestId: string): Promise<{
    userId: string;
    conversationCount: number;
    totalMessages: number;
    lastActivity: string | null;
  }> {
    logger.info('getUserStats', { requestId, userId });

    const { storageService } = await import('./storage');
    const conversations = await storageService.getUserConversations(userId);

    let totalMessages = 0;
    let lastActivity: string | null = null;

    for (const conv of conversations) {
      totalMessages += conv.message_count;
      if (!lastActivity || conv.updated_at > lastActivity) {
        lastActivity = conv.updated_at;
      }
    }

    return { userId, conversationCount: conversations.length, totalMessages, lastActivity };
  }

  /**
   * Получить общую статистику
   */
  async getGlobalStats(requestId: string): Promise<{
    totalConversations: number;
    totalMessages: number;
    activeUsers: number;
  }> {
    logger.info('getGlobalStats', { requestId });

    const dataPath = config.dataPath;
    let totalConversations = 0;
    let totalMessages = 0;
    const activeUserSet = new Set<string>();

    try {
      const userDirs = await fs.readdir(dataPath);

      for (const userDir of userDirs) {
        if (userDir === 'analysis') continue;
        const userPath = path.join(dataPath, userDir);
        const stat = await fs.stat(userPath);
        if (!stat.isDirectory()) continue;

        const files = await fs.readdir(userPath);
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          try {
            const raw = await fs.readFile(path.join(userPath, file), 'utf-8');
            const convo = JSON.parse(raw);
            totalConversations++;
            totalMessages += convo.messages?.length || 0;
            activeUserSet.add(userDir);
          } catch { /* skip corrupted */ }
        }
      }
    } catch { /* empty data dir */ }

    return { totalConversations, totalMessages, activeUsers: activeUserSet.size };
  }

  // ===== Основная задача: поиск ошибок промпта =====

  private async runErrorDetection(): Promise<void> {
    const startTime = Date.now();
    const runTimestamp = new Date().toISOString();

    logger.info('=== Starting error detection analysis ===', {
      model: config.analysis.model,
      timestamp: runTimestamp,
    });

    try {
      await this.initialize();

      const state = await this.getState();

      logger.info('Analysis state loaded', {
        lastAnalysisAt: state.last_analysis_at || 'never',
        totalRuns: state.total_runs,
      });

      const conversations = await this.getConversationsSinceLastAnalysis(state.last_analysis_at);

      logger.info(`Found ${conversations.length} conversations to analyze`, {
        sinceTimestamp: state.last_analysis_at || 'beginning',
      });

      if (conversations.length === 0) {
        state.last_analysis_at = runTimestamp;
        state.last_conversations_analyzed = 0;
        state.last_errors_found = 0;
        state.total_runs++;
        await this.saveState(state);

        if (telegramService.isConfigured()) {
          const msg =
            `<b>📊 #${config.moduleId} | ${config.moduleName}</b>\n` +
            `<b>Автоанализ бесед</b>\n\n` +
            `За последние сутки новых бесед не обнаружено.\n` +
            `Анализ не требуется.`;
          await telegramService.sendMessage(msg);
        }

        return;
      }

      // Анализировать каждую беседу последовательно
      const allErrors: AnalysisError[] = [];
      let skippedCount = 0;
      let errorIdCounter = Date.now();

      for (let i = 0; i < conversations.length; i++) {
        const conv = conversations[i];

        logger.info(`Analyzing conversation ${i + 1}/${conversations.length}`, {
          sessionId: conv.session_id,
          userId: conv.user_id,
          messageCount: conv.messages.length,
        });

        try {
          const result = await this.analyzeConversation(conv);

          for (const err of result.errors) {
            allErrors.push({
              id: `err_${errorIdCounter++}`,
              detected_at: runTimestamp,
              user_id: conv.user_id,
              session_id: conv.session_id,
              ...err,
            });
          }

          logger.info('Conversation analyzed', {
            sessionId: conv.session_id,
            errorsFound: result.errors.length,
          });

          // Пауза между запросами к API
          if (i < conversations.length - 1) {
            await new Promise(resolve => setTimeout(resolve, CONVERSATION_DELAY_MS));
          }
        } catch (error) {
          logger.error('Failed to analyze conversation, skipping', {
            sessionId: conv.session_id,
            error: (error as Error).message,
          });
          skippedCount++;
        }
      }

      const duration = Date.now() - startTime;

      const runResult: AnalysisRunResult = {
        analyzed_conversations: conversations.length - skippedCount,
        total_errors_found: allErrors.length,
        errors: allErrors,
        skipped_conversations: skippedCount,
        duration_ms: duration,
      };

      logger.info('=== Error detection completed ===', {
        analyzedConversations: runResult.analyzed_conversations,
        totalErrorsFound: runResult.total_errors_found,
        skippedConversations: skippedCount,
        durationMs: duration,
      });

      // Сохранить ошибки
      const errorsFile = await this.loadErrors();
      errorsFile.errors.push(...allErrors);
      await this.saveErrors(errorsFile);

      // Сгенерировать и сохранить отчёт
      const report = this.generateReport(runResult, runTimestamp);
      const reportDate = new Date(runTimestamp).toISOString().split('T')[0];
      const reportFilename = `report_${reportDate}.md`;
      const reportPath = path.join(this.reportsPath, reportFilename);
      await fs.writeFile(reportPath, report, 'utf-8');

      logger.info('Report saved locally', { reportPath });

      // Отправить отчёт в Telegram
      if (telegramService.isConfigured()) {
        const caption = this.generateTelegramCaption(runResult);
        const reportBuffer = Buffer.from(report, 'utf-8');

        const sent = await telegramService.sendDocument(reportBuffer, reportFilename, caption);

        if (sent) {
          logger.info('Analysis report sent to admin via Telegram');
        } else {
          logger.warn('Failed to send analysis report via Telegram');
        }
      } else {
        logger.warn('Telegram not configured, report saved locally only');
      }

      // Обновить состояние
      state.last_analysis_at = runTimestamp;
      state.last_conversations_analyzed = runResult.analyzed_conversations;
      state.last_errors_found = runResult.total_errors_found;
      state.total_runs++;
      await this.saveState(state);

    } catch (error) {
      logger.error('=== Error detection analysis failed ===', {
        error: (error as Error).message,
        stack: (error as Error).stack,
        durationMs: Date.now() - startTime,
      });

      if (telegramService.isConfigured()) {
        const errorMsg =
          `<b>⚠️ #${config.moduleId} | ${config.moduleName}</b>\n` +
          `<b>Ошибка автоанализа бесед</b>\n\n` +
          `Ошибка: <code>${(error as Error).message}</code>\n` +
          `Время: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`;
        await telegramService.sendMessage(errorMsg);
      }
    }
  }

  // ===== Оркестратор: последовательный запуск задач =====

  /**
   * Запустить все зарегистрированные задачи анализа последовательно.
   * Вызывается по cron. Ошибка одной задачи не блокирует остальные.
   */
  async runAllAnalyses(): Promise<void> {
    logger.info('=== Starting sequential analysis run ===', {
      taskCount: this.tasks.length,
      tasks: this.tasks.map(t => t.id),
    });

    const startTime = Date.now();
    const results: Array<{ id: string; name: string; success: boolean; durationMs: number; error?: string }> = [];

    for (let i = 0; i < this.tasks.length; i++) {
      const task = this.tasks[i];
      const taskStart = Date.now();

      logger.info(`Running analysis task ${i + 1}/${this.tasks.length}: ${task.name}`, {
        taskId: task.id,
      });

      try {
        await task.run();
        results.push({
          id: task.id,
          name: task.name,
          success: true,
          durationMs: Date.now() - taskStart,
        });
        logger.info(`Task completed: ${task.name}`, {
          taskId: task.id,
          durationMs: Date.now() - taskStart,
        });
      } catch (error) {
        results.push({
          id: task.id,
          name: task.name,
          success: false,
          durationMs: Date.now() - taskStart,
          error: (error as Error).message,
        });
        logger.error(`Task failed: ${task.name}`, {
          taskId: task.id,
          error: (error as Error).message,
          durationMs: Date.now() - taskStart,
        });
      }

      // Пауза между задачами (кроме последней)
      if (i < this.tasks.length - 1) {
        logger.info(`Pausing ${TASK_DELAY_MS}ms before next task...`);
        await new Promise(resolve => setTimeout(resolve, TASK_DELAY_MS));
      }
    }

    const totalDuration = Date.now() - startTime;
    const successCount = results.filter(r => r.success).length;

    logger.info('=== Sequential analysis run completed ===', {
      totalTasks: this.tasks.length,
      succeeded: successCount,
      failed: this.tasks.length - successCount,
      totalDurationMs: totalDuration,
      results,
    });
  }
}

// Singleton instance
export const analysisService = new ConversationAnalysisService();

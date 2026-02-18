/**
 * @file config/index.ts
 * @description Конфигурация модуля m006 из переменных окружения + runtime config (JSON-файл)
 * @context Используется всеми компонентами через import { config } from './config'
 * @dependencies dotenv
 * @affects Все сервисы, порт, API-ключи, модель, пути к данным
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// ============================================
// m006: Server-ментор — Configuration
// ============================================

// Load environment variables
dotenv.config();

// Runtime config interface (loaded from file, can be updated without rebuild)
interface RuntimeConfig {
  features?: {
    streaming?: boolean;
    vision?: boolean;
  };
  [key: string]: unknown;
}

// Config cache
let runtimeConfigCache: RuntimeConfig = {};
let runtimeConfigLastLoad = 0;
const RUNTIME_CONFIG_TTL = 60000; // 60 seconds

/**
 * Load runtime config from file
 */
function loadRuntimeConfig(): RuntimeConfig {
  const configPath = process.env.RUNTIME_CONFIG_PATH || path.join(__dirname, '../../config/runtime.json');

  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(content);
      runtimeConfigCache = parsed;
      runtimeConfigLastLoad = Date.now();
      return parsed;
    }
  } catch (error) {
    console.warn(`Failed to load runtime config from ${configPath}:`, (error as Error).message);
  }

  return {};
}

/**
 * Get runtime config with TTL caching
 */
export function getRuntimeConfig(): RuntimeConfig {
  const now = Date.now();

  if (now - runtimeConfigLastLoad > RUNTIME_CONFIG_TTL) {
    loadRuntimeConfig();
  }

  return runtimeConfigCache;
}

/**
 * Force reload runtime config
 */
export function reloadRuntimeConfig(): RuntimeConfig {
  return loadRuntimeConfig();
}

// Initial load
loadRuntimeConfig();

export const config = {
  // Module identification
  moduleId: process.env.MODULE_ID || 'm006',
  moduleName: process.env.MODULE_NAME || 'Server-ментор',
  version: process.env.MODULE_VERSION || '1.0.0',
  port: parseInt(process.env.PORT || '3066', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // CORE Integration
  core: {
    apiUrl: process.env.CORE_API_URL || 'http://localhost:8000',
    apiKey: process.env.MODULE_API_KEY || '',
  },

  // OpenAI Configuration
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    promptId: process.env.OPENAI_PROMPT_ID || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o',
  },

  // Analysis Configuration (автоанализ бесед)
  analysis: {
    model: process.env.ANALYSIS_MODEL || 'o4-mini',
    enabled: process.env.ANALYSIS_ENABLED !== 'false',
    cronSchedule: process.env.ANALYSIS_CRON || '0 4 * * *',
  },

  // Admin Telegram Bot (уведомления администратору)
  admin: {
    botToken: process.env.ADMIN_BOT_TOKEN || '',
    chatId: process.env.ADMIN_CHAT_ID || '',
  },

  // Data Storage
  dataPath: process.env.DATA_PATH || path.join(__dirname, '../../data'),
  conversationTtlDays: parseInt(process.env.CONVERSATION_TTL_DAYS || '7', 10),

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
};

/**
 * Validate required configuration
 */
export function validateConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.openai.apiKey) {
    errors.push('OPENAI_API_KEY is required');
  }

  if (config.nodeEnv === 'production' && !config.core.apiKey) {
    errors.push('MODULE_API_KEY is required in production');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get configuration summary for logging (without sensitive data)
 */
export function getConfigSummary(): Record<string, unknown> {
  return {
    moduleId: config.moduleId,
    moduleName: config.moduleName,
    version: config.version,
    port: config.port,
    nodeEnv: config.nodeEnv,
    coreApiUrl: config.core.apiUrl,
    coreApiKeyConfigured: Boolean(config.core.apiKey),
    openaiKeyConfigured: Boolean(config.openai.apiKey),
    openaiModel: config.openai.model,
    openaiPromptId: config.openai.promptId || '(not configured)',
    analysisModel: config.analysis.model,
    analysisEnabled: config.analysis.enabled,
    adminBotConfigured: Boolean(config.admin.botToken && config.admin.chatId),
    dataPath: config.dataPath,
    conversationTtlDays: config.conversationTtlDays,
    logLevel: config.logLevel,
  };
}

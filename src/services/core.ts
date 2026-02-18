/**
 * @file services/core.ts
 * @description Клиент для взаимодействия с CORE API (identity, session, billing, balance)
 * @context Используется chat.ts для identity resolution, биллинга и баланса
 * @dependencies config
 * @affects Все операции с CORE: identity, sessions, billing, wallet
 */

import { config } from '../config';
import { logger } from '../utils/logger';

// ============================================
// CORE Integration Service (m006)
// Реализует взаимодействие с CORE API согласно MODULE_INTEGRATION_GUIDE.md
// ============================================

interface IdentityResolveResponse {
  request_id: string;
  status: string;
  user_id: string;
  is_new: boolean;
}

interface SessionCreateResponse {
  session_id: string;
  allocated: boolean;
}

interface BillingStartResponse {
  allowed: boolean;
  reason: string | null;
  request_id: string;
  balance: number;
  min_balance_required?: number;
}

interface BillingFinishResponse {
  success: boolean;
  action: 'commit' | 'rollback';
  credits_spent: number;
  balance_after: number;
  request_id: string;
}

interface WalletBalanceResponse {
  user_id: string;
  balance: number;
  currency_name: string;
  topup_url?: string;
}

interface CoreError {
  code: string;
  message: string;
}

interface CoreErrorResponse {
  request_id: string;
  error: CoreError;
}

/**
 * Клиент для взаимодействия с CORE API
 */
class CoreClient {
  private baseUrl: string;
  private apiKey: string;
  private moduleId: string;
  private maxRetries = config.nodeEnv === 'development' ? 1 : 3;
  private baseDelay = 500;

  constructor() {
    this.baseUrl = config.core.apiUrl;
    this.apiKey = config.core.apiKey;
    this.moduleId = config.moduleId;
  }

  /**
   * Выполнить запрос к CORE API с retry и exponential backoff
   */
  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    requestId?: string,
    retryCount = 0
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Module-Api-Key': this.apiKey,
    };

    if (requestId) {
      headers['X-Request-Id'] = requestId;
    }

    try {
      logger.debug('CORE API request', {
        method,
        endpoint,
        requestId,
        attempt: retryCount + 1,
      });

      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });

      const data = await response.json();

      if (!response.ok) {
        const errorResponse = data as CoreErrorResponse;
        const errorCode = errorResponse.error?.code || 'UNKNOWN_ERROR';
        const errorMessage = errorResponse.error?.message || `HTTP ${response.status}`;

        if (response.status >= 500 && retryCount < this.maxRetries) {
          const delay = this.baseDelay * Math.pow(2, retryCount);
          logger.warn('CORE API retryable error, retrying...', {
            endpoint,
            status: response.status,
            retryCount,
            delay,
            requestId,
          });
          await this.sleep(delay);
          return this.request<T>(method, endpoint, body, requestId, retryCount + 1);
        }

        throw new CoreApiError(errorCode, errorMessage, response.status);
      }

      return data as T;
    } catch (error) {
      if (error instanceof CoreApiError) {
        throw error;
      }

      if (error instanceof TypeError && retryCount < this.maxRetries) {
        const delay = this.baseDelay * Math.pow(2, retryCount);
        logger.warn('CORE API network error, retrying...', {
          endpoint,
          error: (error as Error).message,
          retryCount,
          delay,
          requestId,
        });
        await this.sleep(delay);
        return this.request<T>(method, endpoint, body, requestId, retryCount + 1);
      }

      logger.error('CORE API request failed', {
        endpoint,
        error: (error as Error).message,
        requestId,
      });
      throw error;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * POST /identity/resolve
   */
  async resolveIdentity(
    provider: string,
    tenant: string,
    externalUserId: string,
    requestId: string
  ): Promise<IdentityResolveResponse> {
    logger.info('Resolving identity', { provider, tenant, externalUserId, requestId });

    const response = await this.request<IdentityResolveResponse>(
      'POST',
      '/identity/resolve',
      {
        request_id: requestId,
        provider,
        tenant,
        external_user_id: externalUserId,
      },
      requestId
    );

    logger.info('Identity resolved', {
      userId: response.user_id,
      isNew: response.is_new,
      requestId,
    });

    return response;
  }

  /**
   * POST /session/create
   */
  async createSession(
    userId: string,
    idempotencyKey: string,
    requestId: string
  ): Promise<SessionCreateResponse> {
    logger.info('Creating session', { userId, requestId });

    const response = await this.request<SessionCreateResponse>(
      'POST',
      '/session/create',
      {
        user_id: userId,
        idempotency_key: idempotencyKey,
      },
      requestId
    );

    logger.info('Session created', {
      sessionId: response.session_id,
      allocated: response.allocated,
      requestId,
    });

    return response;
  }

  /**
   * POST /billing/start
   */
  async billingStart(
    userId: string,
    requestId: string
  ): Promise<BillingStartResponse> {
    logger.info('Starting billing', { userId, requestId });

    const response = await this.request<BillingStartResponse>(
      'POST',
      '/billing/start',
      {
        user_id: userId,
        module_id: this.moduleId,
        request_id: requestId,
      },
      requestId
    );

    logger.info('Billing start response', {
      allowed: response.allowed,
      reason: response.reason,
      balance: response.balance,
      requestId,
    });

    return response;
  }

  /**
   * POST /billing/finish
   */
  async billingFinish(
    userId: string,
    requestId: string,
    action: 'commit' | 'rollback',
    usage?: {
      input_tokens: number;
      output_tokens: number;
      input_tokens_details?: { cached_tokens: number };
      output_tokens_details?: { reasoning_tokens: number };
    },
    model?: string,
    shellId?: string,
    originUrl?: string
  ): Promise<BillingFinishResponse> {
    logger.info('Finishing billing', {
      userId,
      action,
      requestId,
      model: model || '(not provided)',
      usage: usage || null,
      shellId: shellId || '(not provided)',
      originUrl: originUrl || '(not provided)',
    });

    const body: Record<string, unknown> = {
      user_id: userId,
      module_id: this.moduleId,
      request_id: requestId,
      action,
    };

    if (action === 'commit' && usage) {
      body.usage = usage;
      body.model = model || config.openai.model;
      if (shellId) body.shell_id = shellId;
      if (originUrl) body.origin_url = originUrl;
    }

    const response = await this.request<BillingFinishResponse>(
      'POST',
      '/billing/finish',
      body,
      requestId
    );

    logger.info('Billing finished', {
      action: response.action,
      creditsSpent: response.credits_spent,
      balanceAfter: response.balance_after,
      requestId,
    });

    return response;
  }

  /**
   * GET /wallet/balance
   */
  async getBalance(userId: string, requestId: string, shellId?: string, originUrl?: string): Promise<WalletBalanceResponse> {
    logger.info('Getting balance', {
      userId,
      requestId,
      shellId: shellId || '(not provided)',
      originUrl: originUrl || '(not provided)',
    });

    let url = `/wallet/balance?user_id=${encodeURIComponent(userId)}`;
    if (shellId) url += `&shell_id=${encodeURIComponent(shellId)}`;
    if (originUrl) url += `&origin_url=${encodeURIComponent(originUrl)}`;

    const response = await this.request<WalletBalanceResponse>(
      'GET',
      url,
      undefined,
      requestId
    );

    logger.info('Balance retrieved', {
      userId: response.user_id,
      balance: response.balance,
      requestId,
    });

    return response;
  }
}

/**
 * Custom error class for CORE API errors
 */
export class CoreApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus: number
  ) {
    super(message);
    this.name = 'CoreApiError';
  }
}

export const coreClient = new CoreClient();

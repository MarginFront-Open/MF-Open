'use client';

import {
  OnboardingError,
  ErrorCategory,
  ERROR_CODES,
  ERROR_MESSAGES,
  RetryConfig,
  DEFAULT_RETRY_CONFIG,
} from './types';

// Generate unique error ID
const generateErrorId = () => `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// Create standardized error object
export const createError = (
  code: string,
  category: ErrorCategory,
  message: string,
  options: Partial<OnboardingError> = {}
): OnboardingError => {
  const errorInfo = ERROR_MESSAGES[code];

  return {
    id: generateErrorId(),
    code,
    category,
    severity: options.severity || 'error',
    message,
    userMessage: errorInfo?.description || message,
    timestamp: new Date(),
    retryable: options.retryable ?? true,
    retryCount: options.retryCount ?? 0,
    maxRetries: options.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries,
    ...options,
  };
};

// Categorize error from response or exception
export const categorizeError = (error: unknown): OnboardingError => {
  // Network errors
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return createError(ERROR_CODES.NETWORK_OFFLINE, 'network', 'Network request failed', {
      retryable: true,
      originalError: error,
    });
  }

  // HTTP response errors
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: number }).status;

    if (status === 408 || status === 504) {
      return createError(ERROR_CODES.NETWORK_TIMEOUT, 'network', 'Request timed out', {
        retryable: true,
        originalError: error,
      });
    }

    if (status === 429) {
      return createError(ERROR_CODES.NETWORK_RATE_LIMITED, 'network', 'Rate limited', {
        retryable: true,
        metadata: { waitTime: 60000 },
        originalError: error,
      });
    }

    if (status >= 500) {
      return createError(ERROR_CODES.NETWORK_SERVER_ERROR, 'network', 'Server error', {
        retryable: true,
        originalError: error,
      });
    }
  }

  // Default unknown error
  return createError(ERROR_CODES.UNKNOWN_ERROR, 'unknown', 'An unexpected error occurred', {
    severity: 'error',
    retryable: false,
    originalError: error,
  });
};

// Calculate retry delay with exponential backoff
export const calculateRetryDelay = (
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): number => {
  const delay = config.baseDelay * Math.pow(config.backoffMultiplier, attempt);
  const jitter = Math.random() * 1000; // Add jitter to prevent thundering herd
  return Math.min(delay + jitter, config.maxDelay);
};

// Check if error is retryable
export const isRetryable = (error: OnboardingError): boolean => {
  if (!error.retryable) return false;
  if (error.retryCount !== undefined && error.maxRetries !== undefined) {
    return error.retryCount < error.maxRetries;
  }
  return true;
};

// Retry operation with exponential backoff
export const retryWithBackoff = async <T>(
  operation: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  onRetry?: (attempt: number, delay: number) => void
): Promise<T> => {
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt < config.maxRetries) {
        const delay = calculateRetryDelay(attempt, config);
        onRetry?.(attempt + 1, delay);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
};

// Error recovery strategies
export type RecoveryStrategy = 'retry' | 'fallback' | 'skip' | 'manual';

export const getRecoveryStrategy = (error: OnboardingError): RecoveryStrategy[] => {
  const strategies: RecoveryStrategy[] = [];

  if (isRetryable(error)) {
    strategies.push('retry');
  }

  // Add fallback for scan errors
  if (error.category === 'scan') {
    strategies.push('fallback');
    strategies.push('manual');
  }

  // Add skip for non-critical steps
  if (error.severity !== 'critical') {
    strategies.push('skip');
  }

  return strategies;
};

// Log error for debugging/analytics
export const logError = (error: OnboardingError): void => {
  console.error(`[Onboarding Error] ${error.code}:`, {
    id: error.id,
    category: error.category,
    severity: error.severity,
    message: error.message,
    step: error.step,
    retryCount: error.retryCount,
    metadata: error.metadata,
  });

  // Report to Sentry when its browser SDK is on the page.
  if (typeof window !== 'undefined' && (window as unknown as { Sentry?: { captureException: (e: unknown) => void } }).Sentry) {
    (window as unknown as { Sentry: { captureException: (e: unknown) => void } }).Sentry.captureException(error.originalError || error);
  }
};

const errorHandler = {
  createError,
  categorizeError,
  calculateRetryDelay,
  isRetryable,
  retryWithBackoff,
  getRecoveryStrategy,
  logError,
};

export default errorHandler;

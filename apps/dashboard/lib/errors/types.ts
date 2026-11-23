// Onboarding Error Types

export type ErrorCategory =
  | 'auth'
  | 'network'
  | 'scan'
  | 'import'
  | 'payment'
  | 'validation'
  | 'unknown';

export type ErrorSeverity = 'warning' | 'error' | 'critical';

export interface OnboardingError {
  id: string;
  code: string;
  category: ErrorCategory;
  severity: ErrorSeverity;
  message: string;
  userMessage: string;
  step?: number;
  timestamp: Date;
  retryable: boolean;
  retryCount?: number;
  maxRetries?: number;
  metadata?: Record<string, unknown>;
  originalError?: Error | unknown;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelay: number; // milliseconds
  maxDelay: number;
  backoffMultiplier: number;
  retryableStatusCodes: number[];
}

export interface NetworkState {
  isOnline: boolean;
  connectionType?: string;
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
}

export interface RecoveryState {
  isRecovering: boolean;
  recoveryStep?: number;
  lastError?: OnboardingError;
  retryAttempt: number;
  canRetry: boolean;
  canSkip: boolean;
  fallbackAvailable: boolean;
}

export interface SessionRecoveryData {
  sessionId: string;
  currentStep: number;
  completedSteps: number[];
  skippedSteps: number[];
  stepData: Record<string, unknown>;
  savedAt: string;
  expiresAt: string;
  resumeToken?: string;
}

// Error codes by category
export const ERROR_CODES = {
  // Auth errors
  AUTH_GOOGLE_POPUP_BLOCKED: 'AUTH_001',
  AUTH_GOOGLE_CANCELLED: 'AUTH_002',
  AUTH_EMAIL_INVALID: 'AUTH_003',
  AUTH_OTP_EXPIRED: 'AUTH_004',
  AUTH_OTP_INVALID: 'AUTH_005',
  AUTH_SESSION_EXPIRED: 'AUTH_006',

  // Network errors
  NETWORK_OFFLINE: 'NET_001',
  NETWORK_TIMEOUT: 'NET_002',
  NETWORK_SERVER_ERROR: 'NET_003',
  NETWORK_RATE_LIMITED: 'NET_004',

  // Scan errors
  SCAN_URL_INVALID: 'SCAN_001',
  SCAN_UNREACHABLE: 'SCAN_002',
  SCAN_TIMEOUT: 'SCAN_003',
  SCAN_PARSE_FAILED: 'SCAN_004',
  SCAN_NO_PRICING: 'SCAN_005',

  // Import errors
  IMPORT_FILE_INVALID: 'IMP_001',
  IMPORT_FILE_TOO_LARGE: 'IMP_002',
  IMPORT_PARSE_FAILED: 'IMP_003',
  IMPORT_PARTIAL_FAILURE: 'IMP_004',
  IMPORT_CONNECTION_FAILED: 'IMP_005',

  // Payment errors
  PAYMENT_CONNECTION_FAILED: 'PAY_001',
  PAYMENT_CANCELLED: 'PAY_002',
  PAYMENT_INVALID_ACCOUNT: 'PAY_003',

  // Validation errors
  VALIDATION_REQUIRED: 'VAL_001',
  VALIDATION_FORMAT: 'VAL_002',
  VALIDATION_CONSTRAINT: 'VAL_003',

  // Unknown
  UNKNOWN_ERROR: 'UNK_001',
} as const;

// User-friendly error messages
export const ERROR_MESSAGES: Record<string, { title: string; description: string; action: string }> = {
  [ERROR_CODES.AUTH_GOOGLE_POPUP_BLOCKED]: {
    title: 'Pop-up Blocked',
    description: 'Your browser blocked the Google sign-in popup.',
    action: 'Please allow popups for this site and try again.',
  },
  [ERROR_CODES.AUTH_OTP_EXPIRED]: {
    title: 'Code Expired',
    description: 'Your verification code has expired.',
    action: 'Click "Resend Code" to get a new one.',
  },
  [ERROR_CODES.NETWORK_OFFLINE]: {
    title: 'No Connection',
    description: "You appear to be offline.",
    action: 'Check your internet connection and try again.',
  },
  [ERROR_CODES.NETWORK_TIMEOUT]: {
    title: 'Request Timed Out',
    description: 'The server took too long to respond.',
    action: 'Please try again in a moment.',
  },
  [ERROR_CODES.SCAN_UNREACHABLE]: {
    title: 'Website Unreachable',
    description: "We couldn't access the website you entered.",
    action: 'Check the URL or enter your brand details manually.',
  },
  [ERROR_CODES.SCAN_TIMEOUT]: {
    title: 'Scan Timed Out',
    description: 'The website scan took too long.',
    action: 'Try again or enter your brand details manually.',
  },
  [ERROR_CODES.IMPORT_PARTIAL_FAILURE]: {
    title: 'Partial Import',
    description: 'Some records could not be imported.',
    action: 'Review the failed records and retry or skip them.',
  },
};

// Default retry configuration
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 10000,
  backoffMultiplier: 2,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
};

// Step names for recovery modal display
export const STEP_NAMES: Record<number, string> = {
  1: 'Welcome',
  2: 'Authentication',
  3: 'Brand Scan',
  4: 'Brand Refinement',
  5: 'Customer Import',
  6: 'Product Setup',
  7: 'Payment Connection',
  8: 'Preview',
  9: 'Team Invite',
  10: 'Success',
};

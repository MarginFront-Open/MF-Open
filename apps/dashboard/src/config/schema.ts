/**
 * Configuration Schema
 *
 * Type-safe interfaces for the centralized configuration system.
 * These types ensure consistency across all environment configurations.
 */

// ============================================================================
// API Configuration Types
// ============================================================================

export interface ApiEndpointGroup {
  [key: string]: string
}

export interface ApiEndpoints {
  auth: {
    login: string
    register: string
    refreshToken: string
    forgotPassword: string
    sendResetPasswordOtp: string
    resetPassword: string
    verifyOtp: string
    logout: string
    googleLogin: string
    googleCallback: string
  }
  user: {
    profile: string
    updateProfile: string
  }
  organization: {
    current: string
    create: string
    update: string
    delete: string
  }
  agents: {
    base: string
    detail: string
    signals: string
  }
  apiKeys: {
    base: string
    detail: string
    revoke: string
  }
  customers: {
    base: string
    detail: string
  }
  pricingPlans: {
    base: string
    detail: string
    strategies: string
    strategyDetail: string
  }
  analytics: {
    usage: string
    costs: string
    subscription: string
    customer: string
    agent: string
    revenue: string
    profitability: string
    eventsAggregate: string
  }
  signalEvents: {
    base: string
    detail: string
  }
  filters: {
    base: string
  }
  invoices: {
    base: string
    detail: string
    pdf: string
  }
  subscriptions: {
    base: string
    detail: string
    renew: string
  }
  paymentProviders: {
    base: string
    detail: string
  }
  payments: {
    invoicePayments: string
    refund: string
  }
  publicPayments: {
    checkout: string
    status: string
  }
  webhooks: {
    stripe: string
  }
}

export interface ApiConfig {
  baseUrl: string
  timeout: number
  retryAttempts: number
  retryDelay: number
  endpoints: ApiEndpoints
}

// ============================================================================
// Feature Flags
// ============================================================================

export interface FeatureFlags {
  useMockInvoices: boolean
  enableAnalytics: boolean
  enableSentry: boolean
  enableBetterStack: boolean
  debugMode: boolean
}

// ============================================================================
// UI Configuration
// ============================================================================

export interface PaginationDefaults {
  pageSize: number
  pageSizeOptions: number[]
}

export interface UiConfig {
  defaultTheme: 'light' | 'dark' | 'system'
  animationsEnabled: boolean
  toastDuration: number
  paginationDefaults: PaginationDefaults
}

// ============================================================================
// Authentication Configuration
// ============================================================================

export interface AuthConfig {
  betterAuthUrl: string
  trustedOrigins: string[]
  sessionTimeout: number
  refreshThreshold: number
  tokenStorageKey: string
  rememberMeDays: number
}

// ============================================================================
// Logging Configuration
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LoggingConfig {
  level: LogLevel
  enableConsole: boolean
  enableRemote: boolean
}

// ============================================================================
// Security Configuration
// ============================================================================

export interface SecurityConfig {
  enforceHttps: boolean
  contentSecurityPolicy: boolean
}

// ============================================================================
// Company Information
// ============================================================================

export interface CompanyConfig {
  name: string
  supportEmail: string
  website: string
  address?: string
  city?: string
  state?: string
  zip?: string
  country?: string
}

// ============================================================================
// App Metadata
// ============================================================================

export interface AppMetadata {
  name: string
  version: string
  description: string
}

// ============================================================================
// Complete Configuration Type
// ============================================================================

export interface AppConfig {
  app: AppMetadata
  api: ApiConfig
  features: FeatureFlags
  ui: UiConfig
  auth: AuthConfig
  logging: LoggingConfig
  security?: SecurityConfig
  company: CompanyConfig
}

// ============================================================================
// Environment-specific Partial Configs
// ============================================================================

/**
 * Environment configs can override any part of the base config.
 * This type allows partial overrides while maintaining type safety.
 */
export type EnvironmentConfig = DeepPartial<AppConfig>

/**
 * Utility type for deep partial objects
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
}

// ============================================================================
// Secret Keys (NEVER store in JSON - must come from env vars)
// ============================================================================

/**
 * These secrets MUST be provided via environment variables.
 * They should NEVER be stored in JSON configuration files.
 */
export interface SecretConfig {
  // Authentication
  authSecret: string

  // Database
  databaseUrl: string

  // Email
  resendApiKey: string

  // OAuth (optional)
  googleClientId?: string
  googleClientSecret?: string
  githubClientId?: string
  githubClientSecret?: string

  // Monitoring (optional)
  sentryDsn?: string
  sentryAuthToken?: string
  sentryOrg?: string
  sentryProject?: string
  betterStackSourceToken?: string
}

// ============================================================================
// Client-safe Configuration (exposed to browser via NEXT_PUBLIC_)
// ============================================================================

/**
 * Configuration that is safe to expose to the client.
 * These values will be available in the browser.
 */
export interface ClientConfig {
  app: AppMetadata
  api: {
    baseUrl: string
    timeout: number
  }
  features: FeatureFlags
  ui: UiConfig
  auth: {
    betterAuthUrl: string
    tokenStorageKey: string
  }
  company: CompanyConfig
  environment: Environment
}

// ============================================================================
// Environment Type
// ============================================================================

export type Environment = 'development' | 'preview' | 'production' | 'test'

// ============================================================================
// Validation Types
// ============================================================================

export interface ConfigValidationError {
  path: string
  message: string
  required?: boolean
}

export interface ConfigValidationResult {
  valid: boolean
  errors: ConfigValidationError[]
}

/**
 * Configuration Loader
 *
 * Centralized configuration management for the MarginFront Dashboard.
 * Handles loading JSON configs, merging with environment variables,
 * and providing type-safe access to configuration values.
 *
 * Usage:
 *   import { config, getConfig } from '@/config/loader';
 *
 *   // Access config directly
 *   const apiUrl = config.api.baseUrl;
 *
 *   // Or use the getter for specific sections
 *   const apiConfig = getConfig('api');
 */
// Import JSON configs
import baseConfig from './environments/base.json'
import developmentConfig from './environments/development.json'
import previewConfig from './environments/preview.json'
import productionConfig from './environments/production.json'
import type {
  AppConfig,
  ClientConfig,
  Environment,
  SecretConfig,
  ConfigValidationResult,
  ConfigValidationError,
  DeepPartial,
} from './schema'

// ============================================================================
// Environment Detection
// ============================================================================

/**
 * Determines the current environment.
 * Priority: NEXT_PUBLIC_APP_ENV > VERCEL_ENV > NODE_ENV > 'development'
 */
export function getEnvironment(): Environment {
  // Check for explicit app environment
  if (process.env.NEXT_PUBLIC_APP_ENV) {
    const appEnv = process.env.NEXT_PUBLIC_APP_ENV.toLowerCase()
    if (isValidEnvironment(appEnv)) {
      return appEnv
    }
  }

  // Check Vercel environment
  if (process.env.VERCEL_ENV) {
    switch (process.env.VERCEL_ENV) {
      case 'production':
        return 'production'
      case 'preview':
        return 'preview'
      case 'development':
        return 'development'
    }
  }

  // Fallback to NODE_ENV
  const nodeEnv = process.env.NODE_ENV?.toLowerCase()
  if (nodeEnv === 'production') return 'production'
  if (nodeEnv === 'test') return 'test'

  return 'development'
}

function isValidEnvironment(env: string): env is Environment {
  return ['development', 'preview', 'production', 'test'].includes(env)
}

// ============================================================================
// Deep Merge Utility
// ============================================================================

/**
 * Deep merges two objects, with source taking precedence.
 * Handles arrays by replacing (not concatenating).
 */
function deepMerge<T extends object>(target: T, source: DeepPartial<T>): T {
  const result = { ...target }

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key]
      const targetValue = target[key]

      if (
        sourceValue !== null &&
        typeof sourceValue === 'object' &&
        !Array.isArray(sourceValue) &&
        targetValue !== null &&
        typeof targetValue === 'object' &&
        !Array.isArray(targetValue)
      ) {
        ;(result as Record<string, unknown>)[key] = deepMerge(
          targetValue as object,
          sourceValue as DeepPartial<typeof targetValue>
        )
      } else if (sourceValue !== undefined) {
        ;(result as Record<string, unknown>)[key] = sourceValue
      }
    }
  }

  return result
}

// ============================================================================
// Environment Variable Helpers
// ============================================================================

/**
 * Gets the dynamic Vercel URL for preview deployments.
 * Falls back to provided default if not in Vercel environment.
 */
function getVercelUrl(defaultUrl: string): string {
  // VERCEL_URL is the deployment URL without protocol
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`
  }

  // NEXT_PUBLIC_VERCEL_URL for client-side access
  if (process.env.NEXT_PUBLIC_VERCEL_URL) {
    return `https://${process.env.NEXT_PUBLIC_VERCEL_URL}`
  }

  return defaultUrl
}

/**
 * Safely gets an environment variable with optional fallback.
 */
function getEnvVar(key: string, fallback?: string): string | undefined {
  return process.env[key] ?? fallback
}

/**
 * Gets a required environment variable, throws if not set.
 */
function requireEnvVar(key: string): string {
  const value = process.env[key]
  if (!value) {
    throw new Error(`Required environment variable "${key}" is not set`)
  }
  return value
}

// ============================================================================
// Configuration Loading
// ============================================================================

/**
 * Loads the environment-specific JSON config.
 */
function getEnvironmentConfig(env: Environment): DeepPartial<AppConfig> {
  switch (env) {
    case 'production':
      return productionConfig as DeepPartial<AppConfig>
    case 'preview':
      return previewConfig as DeepPartial<AppConfig>
    case 'development':
    case 'test':
    default:
      return developmentConfig as DeepPartial<AppConfig>
  }
}

/**
 * Applies environment variable overrides to the configuration.
 * Environment variables take highest precedence.
 */
function applyEnvOverrides(config: AppConfig, env: Environment): AppConfig {
  const result = { ...config }

  // API Base URL override
  if (process.env.NEXT_PUBLIC_API_BASE_URL) {
    result.api = {
      ...result.api,
      baseUrl: process.env.NEXT_PUBLIC_API_BASE_URL,
    }
  }

  // Better Auth URL - handle dynamic Vercel URLs
  if (process.env.NEXT_PUBLIC_BETTER_AUTH_URL) {
    result.auth = {
      ...result.auth,
      betterAuthUrl: process.env.NEXT_PUBLIC_BETTER_AUTH_URL,
    }
  } else if (env === 'preview') {
    // Use dynamic Vercel URL for preview deployments
    result.auth = {
      ...result.auth,
      betterAuthUrl: getVercelUrl(result.auth.betterAuthUrl),
    }
  }

  // Trusted origins from env
  if (process.env.AUTH_TRUSTED_ORIGINS) {
    result.auth = {
      ...result.auth,
      trustedOrigins: process.env.AUTH_TRUSTED_ORIGINS.split(',').map((s) =>
        s.trim()
      ),
    }
  }

  // Feature flags from env
  if (process.env.NEXT_PUBLIC_USE_MOCK_INVOICES) {
    result.features = {
      ...result.features,
      useMockInvoices: process.env.NEXT_PUBLIC_USE_MOCK_INVOICES === 'true',
    }
  }

  // Debug mode
  if (process.env.NEXT_PUBLIC_DEBUG_MODE) {
    result.features = {
      ...result.features,
      debugMode: process.env.NEXT_PUBLIC_DEBUG_MODE === 'true',
    }
  }

  // Company info from env
  if (process.env.NEXT_PUBLIC_COMPANY_NAME) {
    result.company = {
      ...result.company,
      name: process.env.NEXT_PUBLIC_COMPANY_NAME,
    }
  }

  if (process.env.NEXT_PUBLIC_SUPPORT_EMAIL) {
    result.company = {
      ...result.company,
      supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL,
    }
  }

  if (process.env.NEXT_PUBLIC_COMPANY_WEBSITE) {
    result.company = {
      ...result.company,
      website: process.env.NEXT_PUBLIC_COMPANY_WEBSITE,
    }
  }

  return result
}

/**
 * Loads and merges all configuration sources.
 */
function loadConfig(): AppConfig {
  const env = getEnvironment()

  // Start with base config
  let config = baseConfig as AppConfig

  // Merge environment-specific config
  const envConfig = getEnvironmentConfig(env)
  config = deepMerge(config, envConfig)

  // Apply environment variable overrides
  config = applyEnvOverrides(config, env)

  return config
}

// ============================================================================
// Secrets Loading (Server-side only)
// ============================================================================

/**
 * Loads secrets from environment variables.
 * These MUST NOT be stored in JSON files.
 *
 * Server-side only - do not import in client components.
 */
export function loadSecrets(): SecretConfig {
  if (typeof window !== 'undefined') {
    throw new Error('loadSecrets() must only be called on the server')
  }

  return {
    // Required secrets
    authSecret: requireEnvVar('AUTH_SECRET'),
    databaseUrl: requireEnvVar('DATABASE_URL'),
    resendApiKey: requireEnvVar('RESEND_API_KEY'),

    // Optional OAuth secrets
    googleClientId: getEnvVar('GOOGLE_CLIENT_ID'),
    googleClientSecret: getEnvVar('GOOGLE_CLIENT_SECRET'),
    githubClientId: getEnvVar('GITHUB_CLIENT_ID'),
    githubClientSecret: getEnvVar('GITHUB_CLIENT_SECRET'),

    // Optional monitoring secrets
    sentryDsn: getEnvVar('NEXT_PUBLIC_SENTRY_DSN'),
    sentryAuthToken: getEnvVar('SENTRY_AUTH_TOKEN'),
    sentryOrg: getEnvVar('SENTRY_ORG'),
    sentryProject: getEnvVar('SENTRY_PROJECT'),
    betterStackSourceToken: getEnvVar('NEXT_PUBLIC_BETTERSTACK_SOURCE_TOKEN'),
  }
}

// ============================================================================
// Client-safe Configuration
// ============================================================================

/**
 * Extracts client-safe configuration from the full config.
 * Use this for values that need to be exposed to the browser.
 */
export function getClientConfig(): ClientConfig {
  const fullConfig = loadConfig()

  return {
    app: fullConfig.app,
    api: {
      baseUrl: fullConfig.api.baseUrl,
      timeout: fullConfig.api.timeout,
    },
    features: fullConfig.features,
    ui: fullConfig.ui,
    auth: {
      betterAuthUrl: fullConfig.auth.betterAuthUrl,
      tokenStorageKey: fullConfig.auth.tokenStorageKey,
    },
    company: fullConfig.company,
    environment: getEnvironment(),
  }
}

// ============================================================================
// Configuration Validation
// ============================================================================

/**
 * Validates required configuration values.
 */
export function validateConfig(config: AppConfig): ConfigValidationResult {
  const errors: ConfigValidationError[] = []

  // Required API config
  if (!config.api.baseUrl) {
    errors.push({
      path: 'api.baseUrl',
      message: 'API base URL is required',
      required: true,
    })
  }

  // Required auth config
  if (!config.auth.betterAuthUrl) {
    errors.push({
      path: 'auth.betterAuthUrl',
      message: 'Better Auth URL is required',
      required: true,
    })
  }

  // Validate URL formats
  if (config.api.baseUrl && !isValidUrl(config.api.baseUrl)) {
    errors.push({
      path: 'api.baseUrl',
      message: 'API base URL must be a valid URL',
    })
  }

  if (config.auth.betterAuthUrl && !isValidUrl(config.auth.betterAuthUrl)) {
    errors.push({
      path: 'auth.betterAuthUrl',
      message: 'Better Auth URL must be a valid URL',
    })
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

function isValidUrl(urlString: string): boolean {
  try {
    new URL(urlString)
    return true
  } catch {
    return false
  }
}

/**
 * Validates required secrets for server-side operations.
 */
export function validateSecrets(): ConfigValidationResult {
  const errors: ConfigValidationError[] = []
  const requiredSecrets = ['AUTH_SECRET', 'DATABASE_URL', 'RESEND_API_KEY']

  for (const secret of requiredSecrets) {
    if (!process.env[secret]) {
      errors.push({
        path: secret,
        message: `Required secret "${secret}" is not set`,
        required: true,
      })
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

// ============================================================================
// Exported Configuration
// ============================================================================

/**
 * The loaded and merged configuration.
 * This is the primary way to access configuration values.
 */
export const config: AppConfig = loadConfig()

/**
 * Current environment
 */
export const environment: Environment = getEnvironment()

/**
 * Type-safe getter for specific configuration sections.
 */
export function getConfig<K extends keyof AppConfig>(section: K): AppConfig[K] {
  return config[section]
}

/**
 * Check if running in a specific environment
 */
export function isEnvironment(env: Environment): boolean {
  return getEnvironment() === env
}

export function isDevelopment(): boolean {
  return isEnvironment('development')
}

export function isProduction(): boolean {
  return isEnvironment('production')
}

export function isPreview(): boolean {
  return isEnvironment('preview')
}

export function isTest(): boolean {
  return isEnvironment('test')
}

// ============================================================================
// API Endpoint Helpers
// ============================================================================

/**
 * Resolves an API endpoint with path parameters.
 *
 * Example:
 *   resolveEndpoint(config.api.endpoints.agents.detail, { orgId: '123', agentId: '456' })
 *   // Returns: '/org/123/agents/456'
 */
export function resolveEndpoint(
  endpoint: string,
  params: Record<string, string>
): string {
  let resolved = endpoint

  for (const [key, value] of Object.entries(params)) {
    resolved = resolved.replace(`:${key}`, encodeURIComponent(value))
  }

  return resolved
}

/**
 * Builds a full API URL from an endpoint.
 */
export function buildApiUrl(
  endpoint: string,
  params?: Record<string, string>
): string {
  const resolvedEndpoint = params ? resolveEndpoint(endpoint, params) : endpoint
  return `${config.api.baseUrl}${resolvedEndpoint}`
}

// ============================================================================
// Debug Helpers
// ============================================================================

/**
 * Logs the current configuration (sanitized for security).
 * Only available in development/debug mode.
 */
export function debugConfig(): void {
  if (!config.features.debugMode) {
    console.warn('Debug mode is not enabled')
    return
  }

  console.group('MarginFront Configuration')
  console.log('Environment:', environment)
  console.log('API Base URL:', config.api.baseUrl)
  console.log('Auth URL:', config.auth.betterAuthUrl)
  console.log('Features:', config.features)
  console.groupEnd()
}

// Default export
export default config

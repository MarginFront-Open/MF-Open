/**
 * Configuration Module
 *
 * Centralized configuration management for the MarginFront Dashboard.
 *
 * Usage:
 *   import { config, getConfig, environment } from '@/config';
 *
 * For secrets (server-side only):
 *   import { loadSecrets } from '@/config';
 */

// Re-export everything from loader
export {
  // Main configuration
  config,
  environment,
  getConfig,
  getClientConfig,

  // Environment helpers
  getEnvironment,
  isEnvironment,
  isDevelopment,
  isProduction,
  isPreview,
  isTest,

  // Secrets (server-side only)
  loadSecrets,

  // Validation
  validateConfig,
  validateSecrets,

  // API helpers
  resolveEndpoint,
  buildApiUrl,

  // Debug
  debugConfig,
} from './loader'

// Re-export types
export type {
  AppConfig,
  ClientConfig,
  SecretConfig,
  Environment,
  ApiConfig,
  ApiEndpoints,
  FeatureFlags,
  UiConfig,
  AuthConfig,
  LoggingConfig,
  SecurityConfig,
  CompanyConfig,
  AppMetadata,
  ConfigValidationResult,
  ConfigValidationError,
} from './schema'

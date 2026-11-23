import type { Config } from 'jest'
import baseConfig from './jest.config'

/**
 * Jest config for apps/dashboard — the INTEGRATION slice
 * (`npm run test:integration`).
 *
 * Runs exactly the suites the base config excludes: the action-layer
 * integration tests (`*.integration.test.ts`) plus harness-smoke.test.ts.
 * These call Server Actions as plain async functions against a LIVE Postgres
 * via packages/db/.env, so they need DATABASE_URL and are not part of the
 * CI unit gate. Point DATABASE_URL at a test database, never production.
 */
const config: Config = {
  ...baseConfig,
  testMatch: [
    '<rootDir>/app/**/__tests__/**/*.integration.test.ts',
    '<rootDir>/src/**/__tests__/**/*.integration.test.ts',
    '<rootDir>/app/actions/__tests__/harness-smoke.test.ts',
  ],
  // Reset the base config's exclusions — they ARE this config's scope.
  testPathIgnorePatterns: ['/node_modules/'],
}

export default config

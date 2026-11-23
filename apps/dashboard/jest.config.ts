import type { Config } from 'jest'
import { pathsToModuleNameMapper } from 'ts-jest'
import { compilerOptions } from './tsconfig.json'

/**
 * Jest config for apps/dashboard — the UNIT slice (default `npm test`).
 *
 * Tests run in a Node environment (not jsdom) because the code under test
 * is the server side of the app. React components + client-only hooks are
 * NOT covered here — those stay on Playwright E2E.
 *
 * The `*.integration.test.ts` suites (plus harness-smoke.test.ts) call Server
 * Actions against a live Postgres via packages/db/.env and are EXCLUDED here
 * so this script runs green with no database — that's what CI runs.
 * Run them with `npm run test:integration` (see jest.config.integration.ts).
 */
const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: [
    '<rootDir>/app/**/__tests__/**/*.test.ts',
    '<rootDir>/src/**/__tests__/**/*.test.ts',
    // Operational scripts are not app code, but the ones that WRITE export their
    // decision logic so it can be exercised without a database. That logic
    // decides what a script deletes, so it runs in the unit suite.
    '<rootDir>/scripts/__tests__/**/*.test.ts',
  ],
  // The DB-backed suites, excluded from the default (unit) run. Keep in sync
  // with jest.config.integration.ts, which runs exactly this set.
  testPathIgnorePatterns: [
    '/node_modules/',
    '\\.integration\\.test\\.ts$',
    '/app/actions/__tests__/harness-smoke\\.test\\.ts$',
  ],
  setupFiles: ['<rootDir>/jest.setup.ts'],
  // Skip build artifacts so haste-map doesn't see two package.json files.
  modulePathIgnorePatterns: ['<rootDir>/.next/'],
  moduleNameMapper: pathsToModuleNameMapper(compilerOptions.paths, {
    prefix: '<rootDir>/',
  }),
  transform: {
    '^.+\\.(t|j)sx?$': [
      'ts-jest',
      {
        tsconfig: {
          jsx: 'react-jsx',
          isolatedModules: true,
        },
      },
    ],
  },
  testTimeout: 30_000,
  // Server Actions reach Prisma which opens connections; run serially so
  // the database doesn't see a thundering herd.
  maxWorkers: 1,
}

export default config

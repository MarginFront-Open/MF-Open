/**
 * Jest setup for dashboard integration tests.
 *
 * Loads environment variables from packages/db/.env so Prisma can connect to
 * a scratch database. Point it at a test database, never production.
 */
import { config as loadEnv } from 'dotenv'
import { resolve } from 'path'

// Load packages/db/.env so DATABASE_URL is defined before any test module
// imports Prisma.
loadEnv({ path: resolve(__dirname, '../../packages/db/.env') })

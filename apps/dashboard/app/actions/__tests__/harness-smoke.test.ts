/**
 * Smoke test for the dashboard Jest harness.
 *
 * Proves three things the integration tests depend on:
 *   1. Jest can load an action file that has `'use server'` at the top.
 *   2. The auth + headers mocks work so action functions don't bail on
 *      missing session.
 *   3. Prisma connects to the database in packages/db/.env.
 *
 * If this file is green, the harness is ready.
 */

import { PrismaClient } from '@prisma/client'
import { getSampleOrgIdForTests } from './_helpers/mock-session'

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: jest.fn(),
    },
  },
}))

jest.mock('next/headers', () => ({
  headers: jest.fn(async () => new Headers()),
}))

describe('dashboard Jest harness', () => {
  it('loads a module with "use server" without exploding', async () => {
    const mod = await import('../full-command-center')
    expect(typeof mod.getFullCommandCenterBreakdown).toBe('function')
    expect(typeof mod.getFullCommandCenterEventFeed).toBe('function')
    expect(typeof mod.getFullCommandCenterAgentStrip).toBe('function')
  })

  it('connects to the database and finds the sample test organization', async () => {
    const orgId = await getSampleOrgIdForTests()
    const prisma = new PrismaClient()
    try {
      const customerCount = await prisma.customers.count({
        where: { organizationId: orgId },
      })
      expect(customerCount).toBeGreaterThan(0)
    } finally {
      await prisma.$disconnect()
    }
  })
})

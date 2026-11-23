import { PrismaClient } from '@prisma/client'
import {
  buildSampleData,
  loadPrices,
  writeSampleData,
} from '../../../../../../packages/db/scripts/seed-sample-data'

/**
 * Shared fixture helpers for action-layer integration tests.
 *
 * The tests call Server Actions as plain async functions and need the
 * auth/session/headers layer mocked. Every action starts with:
 *
 *   const session = await auth.api.getSession({ headers: await headers() })
 *   const orgId = session.session.activeOrganizationId
 *
 * So we mock auth to return a fixed session pointing at a dedicated test
 * organization filled with the repo's sample dataset
 * (packages/db/scripts/seed-sample-data.ts). Tests then assert against
 * whatever that organization holds at run time.
 */

const SAMPLE_ORG_ID = '7e570000-0000-4000-8000-000000000001'
let sampleReady = false

/**
 * Create the test organization if it is missing and write the sample dataset
 * into it, once per test run. Needs the price catalog loaded
 * (`npm run db:setup`).
 */
export async function getSampleOrgIdForTests(): Promise<string> {
  if (sampleReady) return SAMPLE_ORG_ID
  const prisma = new PrismaClient()
  try {
    const now = new Date()
    await prisma.organizations.upsert({
      where: { id: SAMPLE_ORG_ID },
      create: {
        id: SAMPLE_ORG_ID,
        name: 'Integration test organization',
        createdAt: now,
        updatedAt: now,
      },
      update: {},
    })
    const data = buildSampleData(SAMPLE_ORG_ID, now, await loadPrices(prisma))
    await writeSampleData(prisma, data)
    sampleReady = true
    return SAMPLE_ORG_ID
  } finally {
    await prisma.$disconnect()
  }
}

/**
 * Build the mock modules that Server Actions expect.
 *
 * Usage at the top of a test file (before any import of the action):
 *
 *   jest.mock('@/app/lib/auth', () => buildAuthMock())
 *   jest.mock('next/headers', () => buildHeadersMock())
 *
 * Then inside a beforeAll or beforeEach, populate the session with the
 * test org ID:
 *
 *   const { setSessionOrgId } = await import('./_helpers/mock-session')
 *   await setSessionOrgId()
 */
export function buildAuthMock() {
  // The mutable reference — updated inside the real test file once we know
  // the test org UUID. Starts empty so a test that forgets setSessionOrgId
  // fails loudly with the action's "no session" branch rather than silently.
  const session = { activeOrgId: null as string | null }
  return {
    __setSessionOrgId: (orgId: string) => {
      session.activeOrgId = orgId
    },
    auth: {
      api: {
        getSession: async () => {
          if (!session.activeOrgId) return null
          return {
            session: { activeOrganizationId: session.activeOrgId },
          }
        },
      },
    },
  }
}

/**
 * Stands in for assert-money-manager.ts. The sessions above carry no user, so
 * the real role lookup would refuse them. This passes any caller with an
 * active org, as an owner would be.
 *
 *   jest.mock('../_shared/assert-money-manager', () =>
 *     buildMoneyManagerMock(authMock)
 *   )
 */
export function buildMoneyManagerMock(
  authMock: ReturnType<typeof buildAuthMock>
) {
  return {
    assertMoneyManager: async () => {
      const session = await authMock.auth.api.getSession()
      if (!session) return { ok: false, error: 'Not authenticated' }
      return {
        ok: true,
        orgId: session.session.activeOrganizationId,
        userId: 'integration-test-user',
        session,
      }
    },
  }
}

export function buildHeadersMock() {
  return {
    headers: async () => new Headers(),
    cookies: async () => ({
      get: (_name: string) => undefined,
      getAll: () => [],
      has: () => false,
    }),
  }
}

/**
 * WHAT THIS FILE DOES: proves the two server-side guarantees that
 * stop the FinOps Settings page from silently corrupting the books —
 *   (a) `upsertGlCode` REJECTS a category↔accounting-type pair that disagrees
 *       with the canonical map, and never writes a bad row to the DB; and it
 *       still ACCEPTS the matching pair (so the gate doesn't over-block);
 *   (b) `deleteGlCode` returns how many signals it will un-map, counted
 *       org-scoped and BEFORE the SetNull cascade fires;
 *   (c) `CATEGORY_TO_ACCOUNTING_TYPE` is internally complete and never drifts
 *       from the pairings baked into `DEFAULT_GL_CODES`.
 *
 * WHY THE DB IS MOCKED (not live): the code under test is the action's LOGIC —
 * the gate, the count, the org-scoping of the `where` clause — not Prisma. We
 * stub `@/app/lib/db` (the same approach as cost-classification-margin.test.ts)
 * so the assertions exercise the real branch decisions deterministically and
 * without a database connection. Every assertion can FAIL: drop the cross-check and
 * the deny tests see a DB write; drop the org filter and the scoping assertion
 * breaks; drift a pair and the map-consistency test breaks.
 *
 * CONNECTS TO: app/actions/chart-of-accounts.ts (functions under test) and
 * features/cost-management/classification-utils.ts (the map + seed it guards).
 */

import { buildAuthMock, buildHeadersMock } from './_helpers/mock-session'
import {
  CATEGORY_TO_ACCOUNTING_TYPE,
  DEFAULT_GL_CODES,
} from '@/features/cost-management/classification-utils'

// --- Mocked boundaries ------------------------------------------------------

const authMock = buildAuthMock()
jest.mock('@/app/lib/auth', () => ({ auth: authMock.auth }))
jest.mock('next/headers', () => buildHeadersMock())
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }))
// In-memory stub for the Prisma client the action imports as `db`.
// Only the methods the code paths under test touch are stubbed.
const dbMock = {
  chart_of_accounts: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    createMany: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  signals: {
    count: jest.fn(),
    findMany: jest.fn(),
  },
}
// These money writes sit behind assertMoneyManager(), which reads
// `db.ba_member`. These tests exercise the category↔type VALIDATION logic, not authz, so
// the gate is set to pass (a manager role) by default — the validation branches under test
// run unchanged. (Per-action authz behavior is proven in chart-of-accounts-authz.test.ts.)
let mockMemberRole: { role: string } | null = { role: 'owner' }
jest.mock('@/app/lib/db', () => ({
  db: {
    ...dbMock,
    ba_member: { findFirst: async () => mockMemberRole },
  },
}))

const TEST_ORG_ID = '00000000-0000-0000-0000-000000000453'

type ChartOfAccountsModule = typeof import('../chart-of-accounts')
let actions: ChartOfAccountsModule

beforeAll(async () => {
  // Point the mocked session at a fixed org so the actions clear their auth gate.
  authMock.__setSessionOrgId(TEST_ORG_ID)
  actions = await import('../chart-of-accounts')
})

beforeEach(() => {
  jest.clearAllMocks()
})

// --- (c) the canonical map --------------------------------------------------

describe('CATEGORY_TO_ACCOUNTING_TYPE — single source of truth', () => {
  const NON_UNCLASSIFIED = [
    'PRODUCTION_COGS',
    'DEVELOPMENT_RD',
    'SALES_SM',
    'GENERAL_GA',
    'INTERNAL_TOOL',
  ] as const

  it('maps exactly the five non-UNCLASSIFIED categories, one type each', () => {
    expect(Object.keys(CATEGORY_TO_ACCOUNTING_TYPE).sort()).toEqual(
      [...NON_UNCLASSIFIED].sort()
    )
    for (const cat of NON_UNCLASSIFIED) {
      expect(CATEGORY_TO_ACCOUNTING_TYPE[cat]).toBeTruthy()
    }
    // UNCLASSIFIED is not a valid GL-code category, so it must NOT be a key.
    expect(
      (CATEGORY_TO_ACCOUNTING_TYPE as Record<string, string>).UNCLASSIFIED
    ).toBeUndefined()
  })

  it('never drifts from the pairings baked into DEFAULT_GL_CODES', () => {
    // The seed array is the other place these pairs live. If someone edits one
    // copy and not the other, this fails — the whole point of one map.
    for (const seed of DEFAULT_GL_CODES) {
      expect(CATEGORY_TO_ACCOUNTING_TYPE[seed.costCategory]).toBe(
        seed.accountingType
      )
    }
  })

  it('encodes the documented GAAP split', () => {
    expect(CATEGORY_TO_ACCOUNTING_TYPE.PRODUCTION_COGS).toBe('COGS')
    expect(CATEGORY_TO_ACCOUNTING_TYPE.DEVELOPMENT_RD).toBe('OPEX_RD')
    expect(CATEGORY_TO_ACCOUNTING_TYPE.SALES_SM).toBe('OPEX_SM')
    expect(CATEGORY_TO_ACCOUNTING_TYPE.GENERAL_GA).toBe('OPEX_GA')
    // Two categories legitimately share OPEX_GA — that's fine one-way.
    expect(CATEGORY_TO_ACCOUNTING_TYPE.INTERNAL_TOOL).toBe('OPEX_GA')
  })
})

// --- (a) upsertGlCode cross-check ------------------------------------------

describe('upsertGlCode — category↔type cross-check', () => {
  it('rejects an incompatible pair and writes NOTHING to the DB', async () => {
    const res = await actions.upsertGlCode({
      glCode: '5199',
      glName: 'Production cost mislabeled as R&D',
      costCategory: 'PRODUCTION_COGS',
      accountingType: 'OPEX_RD', // wrong: PRODUCTION_COGS must be COGS
    })

    expect(res.success).toBe(false)
    expect(res.error).toContain('COGS') // names the expected type
    // The load-bearing guarantee: the bad pair never reached storage.
    expect(dbMock.chart_of_accounts.create).not.toHaveBeenCalled()
    expect(dbMock.chart_of_accounts.update).not.toHaveBeenCalled()
  })

  it('rejects a second wrong pair (R&D typed as COGS), still no write', async () => {
    const res = await actions.upsertGlCode({
      glCode: '6899',
      glName: 'R&D mislabeled as COGS',
      costCategory: 'DEVELOPMENT_RD',
      accountingType: 'COGS', // wrong: DEVELOPMENT_RD must be OPEX_RD
    })

    expect(res.success).toBe(false)
    expect(dbMock.chart_of_accounts.create).not.toHaveBeenCalled()
    expect(dbMock.chart_of_accounts.update).not.toHaveBeenCalled()
  })

  it('ACCEPTS the matching pair and creates the row org-scoped', async () => {
    // defaults already persisted → ensureDefaultsPersisted no-ops
    dbMock.chart_of_accounts.count.mockResolvedValue(5)
    dbMock.chart_of_accounts.create.mockResolvedValue({
      id: 'new-gl-id',
      glCode: '5130',
      glName: 'AI Fine-Tuning',
      costCategory: 'PRODUCTION_COGS',
      accountingType: 'COGS',
      isDefault: false,
      description: null,
    })

    const res = await actions.upsertGlCode({
      glCode: '5130',
      glName: 'AI Fine-Tuning',
      costCategory: 'PRODUCTION_COGS',
      accountingType: 'COGS', // correct
    })

    expect(res.success).toBe(true)
    expect(dbMock.chart_of_accounts.create).toHaveBeenCalledTimes(1)
    const createArg = dbMock.chart_of_accounts.create.mock.calls[0][0]
    expect(createArg.data.orgId).toBe(TEST_ORG_ID)
    expect(createArg.data.accountingType).toBe('COGS')
  })
})

// --- (b) deleteGlCode orphan count + org scoping ---------------------------

describe('deleteGlCode — orphan count + org scoping', () => {
  it('returns the org-scoped count of signals it un-maps, counted before delete', async () => {
    // resolveGlCodeId (non-default id) → real row
    dbMock.chart_of_accounts.findFirst.mockResolvedValue({ id: 'real-gl-id' })
    dbMock.signals.count.mockResolvedValue(3)
    dbMock.chart_of_accounts.delete.mockResolvedValue({})

    const res = await actions.deleteGlCode('real-gl-id')

    expect(res.success).toBe(true)
    expect(res.orphanedSignalCount).toBe(3)
    // org-scoped, only-live, and keyed on the GL code being deleted
    expect(dbMock.signals.count).toHaveBeenCalledWith({
      where: { glCodeId: 'real-gl-id', orgId: TEST_ORG_ID, deletedAt: null },
    })
    // the count must be measured BEFORE the SetNull cascade fires
    const countOrder = dbMock.signals.count.mock.invocationCallOrder[0]
    const deleteOrder =
      dbMock.chart_of_accounts.delete.mock.invocationCallOrder[0]
    expect(countOrder).toBeLessThan(deleteOrder)
  })

  it('reports 0 (and still deletes) when nothing was mapped', async () => {
    dbMock.chart_of_accounts.findFirst.mockResolvedValue({ id: 'real-gl-id' })
    dbMock.signals.count.mockResolvedValue(0)
    dbMock.chart_of_accounts.delete.mockResolvedValue({})

    const res = await actions.deleteGlCode('real-gl-id')

    expect(res.success).toBe(true)
    expect(res.orphanedSignalCount).toBe(0)
    expect(dbMock.chart_of_accounts.delete).toHaveBeenCalledTimes(1)
  })
})

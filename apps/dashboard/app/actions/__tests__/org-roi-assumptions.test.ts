/**
 * WHAT THIS FILE DOES: proves the four
 * guarantees behind the org's stored without-AI numbers, the ones the ROI
 * report's "Without AI" comparison is built from —
 *   (a) the write is gated on the money roles and validates before it stores;
 *   (b) stored JSON is re-validated on the way OUT, so a malformed column
 *       reads as "nothing stored" instead of rendering junk in a sentence the
 *       customer quotes to their board;
 *   (c) only the org-level fields are persisted. The count of finished work is
 *       window-specific and never touches the row;
 *   (d) a row in the single-method per-unit shape still reads: its per-unit
 *       rate becomes the per-item rate and selects the per-item method.
 *
 * WHY THE DB IS MOCKED (not live): the code under test is the action's own
 * logic — the gate, the zod schemas both ways, the null-vs-object write — not
 * Prisma. Same approach as chart-of-accounts-validation.test.ts, so the suite
 * runs green with no database connection.
 *
 * CONNECTS TO: app/actions/org-roi-assumptions.ts and the "Without AI" block
 * in src/features/roi/report-derivation.ts that consumes what it returns.
 */

import { buildAuthMock, buildHeadersMock } from './_helpers/mock-session'

const authMock = buildAuthMock()
jest.mock('@/app/lib/auth', () => ({ auth: authMock.auth }))
jest.mock('next/headers', () => buildHeadersMock())
const DB_NULL = Symbol('Prisma.DbNull')

const dbMock = {
  organizations: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  ba_member: {
    findFirst: jest.fn(),
  },
}

jest.mock('@/app/lib/db', () => ({
  db: dbMock,
  Prisma: { DbNull: DB_NULL },
}))

const TEST_ORG_ID = '00000000-0000-0000-0000-000000000677'

type Module = typeof import('../org-roi-assumptions')
let actions: Module

beforeAll(async () => {
  authMock.__setSessionOrgId(TEST_ORG_ID)
  actions = await import('../org-roi-assumptions')
})

beforeEach(() => {
  jest.clearAllMocks()
  dbMock.ba_member.findFirst.mockResolvedValue({ role: 'finance' })
})

describe('reading — stored JSON is re-validated on the way out', () => {
  it('returns every field a customer typed', async () => {
    dbMock.organizations.findUnique.mockResolvedValue({
      roiAssumptions: {
        method: 'peopleTime',
        unitSingular: 'contract summarized',
        unitPlural: 'contracts summarized',
        hoursPerMonth: 100,
        hourlyRate: 50,
        revenuePerMonth: 5000,
      },
    })

    const result = await actions.getOrgRoiAssumptions()
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.assumptions).toEqual({
      method: 'peopleTime',
      unitSingular: 'contract summarized',
      unitPlural: 'contracts summarized',
      hoursPerMonth: 100,
      hourlyRate: 50,
      revenuePerMonth: 5000,
    })
  })

  it('a method nobody offers reads as nothing stored, not as a method we invent', async () => {
    dbMock.organizations.findUnique.mockResolvedValue({
      roiAssumptions: { method: 'vibes', costPerItem: 100 },
    })
    const result = await actions.getOrgRoiAssumptions()
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.assumptions).toBeNull()
  })

  it('a column full of junk reads as nothing stored, never as junk in a sentence', async () => {
    dbMock.organizations.findUnique.mockResolvedValue({
      roiAssumptions: { unitPlural: 42, costPerItem: 'a lot' },
    })

    const result = await actions.getOrgRoiAssumptions()
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.assumptions).toBeNull()
  })

  it('a negative stored rate reads as nothing stored', async () => {
    dbMock.organizations.findUnique.mockResolvedValue({
      roiAssumptions: { unitPlural: 'contracts summarized', costPerItem: -5 },
    })

    const result = await actions.getOrgRoiAssumptions()
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.assumptions).toBeNull()
  })

  it('an empty column reads as nothing stored', async () => {
    dbMock.organizations.findUnique.mockResolvedValue({ roiAssumptions: null })

    const result = await actions.getOrgRoiAssumptions()
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.assumptions).toBeNull()
  })

  it('an org that is not there is an error, not an empty answer', async () => {
    dbMock.organizations.findUnique.mockResolvedValue(null)
    const result = await actions.getOrgRoiAssumptions()
    expect(result.success).toBe(false)
  })

  it('reads the session org', async () => {
    dbMock.organizations.findUnique.mockResolvedValue({ roiAssumptions: null })
    await actions.getOrgRoiAssumptions()
    expect(dbMock.organizations.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TEST_ORG_ID } })
    )
  })
})

describe('writing — gated, validated, and only the org-level fields', () => {
  it('a plain member cannot store the numbers the report quotes', async () => {
    dbMock.ba_member.findFirst.mockResolvedValue({ role: 'member' })

    const result = await actions.saveOrgRoiAssumptions({
      unitPlural: 'contracts summarized',
    })
    expect(result.success).toBe(false)
    expect(dbMock.organizations.update).not.toHaveBeenCalled()
  })

  /**
   * AssertMoneyManager's own no-session refusal is the raw
   * string 'Not authenticated', and without-ai.tsx renders result.error
   * verbatim in red under the form. A user whose session expires with the
   * panel open would fill in their before-AI numbers, hit Save, and get two
   * words with no next step.
   */
  it('an expired session gets a sentence with a next step, never the raw gate string', async () => {
    authMock.__setSessionOrgId('')
    try {
      const result = await actions.saveOrgRoiAssumptions({
        unitPlural: 'contracts summarized',
      })
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error).toBe(
        "You're signed out. Sign in again and your numbers will save."
      )
      expect(result.error).not.toBe('Not authenticated')
      expect(dbMock.organizations.update).not.toHaveBeenCalled()
    } finally {
      authMock.__setSessionOrgId(TEST_ORG_ID)
    }
  })

  it('a wrong-role refusal still says what the role problem is, not the session one', async () => {
    dbMock.ba_member.findFirst.mockResolvedValue({ role: 'member' })
    const result = await actions.saveOrgRoiAssumptions({
      unitPlural: 'contracts summarized',
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).not.toContain("You're signed out")
  })

  it('stores exactly the fields that were filled in, and drops the blanks', async () => {
    dbMock.organizations.update.mockResolvedValue({})

    const result = await actions.saveOrgRoiAssumptions({
      method: 'perItem',
      unitSingular: '  ',
      unitPlural: '  contracts summarized  ',
      costPerItem: 100,
    })
    expect(result.success).toBe(true)
    expect(dbMock.organizations.update).toHaveBeenCalledWith({
      where: { id: TEST_ORG_ID },
      data: {
        roiAssumptions: {
          method: 'perItem',
          unitPlural: 'contracts summarized',
          costPerItem: 100,
        },
      },
    })
  })

  it('clearing every field empties the column rather than storing an empty object', async () => {
    dbMock.organizations.update.mockResolvedValue({})

    const result = await actions.saveOrgRoiAssumptions({})
    expect(result.success).toBe(true)
    expect(dbMock.organizations.update).toHaveBeenCalledWith({
      where: { id: TEST_ORG_ID },
      data: { roiAssumptions: DB_NULL },
    })
  })

  it('a negative rate is refused in plain English, and nothing is written', async () => {
    const result = await actions.saveOrgRoiAssumptions({
      unitPlural: 'contracts summarized',
      costPerItem: -1,
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toMatch(/can't be negative/i)
    expect(dbMock.organizations.update).not.toHaveBeenCalled()
  })

  it('a unit name longer than the column allows is refused, not truncated', async () => {
    const result = await actions.saveOrgRoiAssumptions({
      unitPlural: 'p'.repeat(61),
    })
    expect(result.success).toBe(false)
    expect(dbMock.organizations.update).not.toHaveBeenCalled()
  })

  it('writes to the org the gate validated', async () => {
    dbMock.organizations.update.mockResolvedValue({})
    await actions.saveOrgRoiAssumptions({ unitPlural: 'contracts summarized' })
    expect(dbMock.organizations.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TEST_ORG_ID } })
    )
  })
})

/**
 * A stored row in the single-method shape: "contracts summarized" at $400 a piece
 * as `beforeAiCostPerUnit`, with no `method` beside it. It has to keep
 * reading, and it has to land on the per-item method it means.
 */
describe('a row in the single-method shape still reads', () => {
  it('the per-unit rate becomes the per-item rate and picks the method', async () => {
    dbMock.organizations.findUnique.mockResolvedValue({
      roiAssumptions: {
        unitSingular: 'contract summarized',
        unitPlural: 'contracts summarized',
        beforeAiCostPerUnit: 400,
      },
    })

    const result = await actions.getOrgRoiAssumptions()
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.assumptions).toEqual({
      method: 'perItem',
      unitSingular: 'contract summarized',
      unitPlural: 'contracts summarized',
      costPerItem: 400,
    })
  })

  it('the per-unit revenue rate is dropped rather than read as a monthly figure', async () => {
    dbMock.organizations.findUnique.mockResolvedValue({
      roiAssumptions: {
        unitPlural: 'contracts summarized',
        beforeAiCostPerUnit: 400,
        beforeAiRevenuePerUnit: 150,
      },
    })

    const result = await actions.getOrgRoiAssumptions()
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.assumptions).not.toHaveProperty('revenuePerMonth')
    expect(result.data.assumptions).not.toHaveProperty('beforeAiRevenuePerUnit')
  })

  it('a per-unit rate that is junk reads as nothing stored, never as a $0 rate', async () => {
    dbMock.organizations.findUnique.mockResolvedValue({
      roiAssumptions: { beforeAiCostPerUnit: 'a lot' },
    })

    const result = await actions.getOrgRoiAssumptions()
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.assumptions).toBeNull()
  })

  it('a row with a method is left alone, so the mapping cannot overwrite a real method', async () => {
    dbMock.organizations.findUnique.mockResolvedValue({
      roiAssumptions: {
        method: 'peopleTime',
        hoursPerMonth: 100,
        hourlyRate: 50,
        beforeAiCostPerUnit: 400,
      },
    })

    const result = await actions.getOrgRoiAssumptions()
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.assumptions).toEqual({
      method: 'peopleTime',
      hoursPerMonth: 100,
      hourlyRate: 50,
      costPerItem: 400,
    })
  })

  it('the per-unit keys can never be written back', async () => {
    dbMock.organizations.update.mockResolvedValue({})
    await actions.saveOrgRoiAssumptions({
      method: 'perItem',
      costPerItem: 400,
      beforeAiCostPerUnit: 400,
    } as never)
    const written = dbMock.organizations.update.mock.calls[0][0].data
      .roiAssumptions as Record<string, unknown>
    expect(written).not.toHaveProperty('beforeAiCostPerUnit')
    expect(written.costPerItem).toBe(400)
  })
})

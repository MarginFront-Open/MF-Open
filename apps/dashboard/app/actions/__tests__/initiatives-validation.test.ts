/**
 * Layout validation (ROI initiatives half):
 * getInitiatives / createInitiative / updateInitiative / deleteInitiative /
 * setInitiativeTargets (app/actions/initiatives.ts).
 *
 * Fully mocked — no DB. Initiatives are org-content money writes, gated with
 * assertMoneyManager the same way chart_of_accounts is (see
 * chart-of-accounts-authz.test.ts).
 * assertMoneyManager itself is NOT mocked: it's a plain (non-'use server')
 * helper that reads db.ba_member, which we control here via the same db
 * mock, exactly like build-writes-authz.test.ts does for BUILD writes.
 *
 * ComputeAutoBaselines IS mocked — it opens its
 * own PrismaClient for the canon window reads, which a fully-mocked suite
 * must never reach. The auto-baseline WIRING (measure on save, carry
 * manual, re-measure on start-date moves) is behavior-tested below against
 * the mock; the derivation itself is pure-tested in
 * src/features/roi/__tests__/baseline-derivation.test.ts.
 */

export {}

const ORG = 'org-real-initiatives'
const USER = 'user-initiatives'

let sessionState: {
  activeOrganizationId: string | null
  userId: string | null
} = { activeOrganizationId: ORG, userId: USER }

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        sessionState.activeOrganizationId
          ? {
              session: {
                activeOrganizationId: sessionState.activeOrganizationId,
              },
              user: { id: sessionState.userId },
            }
          : null,
    },
  },
}))
jest.mock('next/headers', () => ({ headers: async () => new Headers() }))
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }))
const computeAutoBaselinesMock = jest.fn()
jest.mock('../_shared/initiative-actuals', () => ({
  computeAutoBaselines: (...args: unknown[]) => computeAutoBaselinesMock(...args),
}))

const baMemberFindFirst = jest.fn()
const initiativesFindMany = jest.fn()
const initiativesFindFirst = jest.fn()
const initiativesCreate = jest.fn()
const initiativesUpdate = jest.fn()
const initiativesDelete = jest.fn()
const targetsDeleteMany = jest.fn()
const targetsCreateMany = jest.fn()
const targetsFindMany = jest.fn()
const targetsUpdate = jest.fn()

jest.mock('@/app/lib/db', () => ({
  db: {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
    initiatives: {
      findMany: (a: unknown) => initiativesFindMany(a),
      findFirst: (a: unknown) => initiativesFindFirst(a),
      create: (a: unknown) => initiativesCreate(a),
      update: (a: unknown) => initiativesUpdate(a),
      delete: (a: unknown) => initiativesDelete(a),
    },
    initiative_targets: {
      deleteMany: (a: unknown) => targetsDeleteMany(a),
      createMany: (a: unknown) => targetsCreateMany(a),
      findMany: (a: unknown) => targetsFindMany(a),
      update: (a: unknown) => targetsUpdate(a),
    },
  },
}))

type Mod = typeof import('../initiatives')
let mod: Mod

const NOW = new Date(Date.UTC(2026, 3, 1))
const rowFixture = (overrides: Record<string, unknown> = {}) => ({
  id: 'init-1',
  name: 'Q2 cost reduction',
  description: null,
  status: 'active',
  startDate: NOW,
  endDate: null,
  createdByUserId: USER,
  createdAt: NOW,
  updatedAt: NOW,
  initiative_targets: [],
  ...overrides,
})

beforeAll(async () => {
  mod = await import('../initiatives')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  ;[
    baMemberFindFirst,
    initiativesFindMany,
    initiativesFindFirst,
    initiativesCreate,
    initiativesUpdate,
    initiativesDelete,
    targetsDeleteMany,
    targetsCreateMany,
    targetsFindMany,
    targetsUpdate,
    computeAutoBaselinesMock,
  ].forEach((m) => m.mockReset())

  baMemberFindFirst.mockResolvedValue({ role: 'owner' })
  // updateInitiative and setInitiativeTargets both select the window (and
  // update selects the targets) off this lookup.
  initiativesFindFirst.mockResolvedValue({
    id: 'init-1',
    startDate: NOW,
    endDate: null,
    initiative_targets: [],
  })
  computeAutoBaselinesMock.mockResolvedValue(new Map())
  targetsUpdate.mockResolvedValue({})
  initiativesCreate.mockResolvedValue(rowFixture())
  initiativesUpdate.mockResolvedValue(rowFixture())
  initiativesDelete.mockResolvedValue({})
  targetsDeleteMany.mockResolvedValue({ count: 0 })
  targetsCreateMany.mockResolvedValue({ count: 0 })
  targetsFindMany.mockResolvedValue([])
})

describe('createInitiative — validation runs before the money-write gate', () => {
  it('accepts a well-formed initiative and creates it scoped to the session org', async () => {
    const res = await mod.createInitiative({ name: 'Q2 cost reduction', startDate: '2026-04-01' })
    expect(res.success).toBe(true)
    expect(initiativesCreate).toHaveBeenCalledTimes(1)
    expect(initiativesCreate.mock.calls[0][0].data.orgId).toBe(ORG)
    expect(initiativesCreate.mock.calls[0][0].data.createdByUserId).toBe(USER)
  })

  it('rejects an empty name before the gate is even consulted', async () => {
    const res = await mod.createInitiative({ name: '', startDate: '2026-04-01' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Name is required/)
    expect(baMemberFindFirst).not.toHaveBeenCalled()
    expect(initiativesCreate).not.toHaveBeenCalled()
  })

  it('rejects a name over 255 characters', async () => {
    const res = await mod.createInitiative({ name: 'x'.repeat(256), startDate: '2026-04-01' })
    expect(res.success).toBe(false)
    expect(initiativesCreate).not.toHaveBeenCalled()
  })

  it('rejects an endDate before startDate', async () => {
    const res = await mod.createInitiative({
      name: 'Bad window',
      startDate: '2026-04-30',
      endDate: '2026-04-01',
    })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/End date must be on or after the start date/)
    expect(initiativesCreate).not.toHaveBeenCalled()
  })

  it('accepts endDate === startDate (boundary)', async () => {
    const res = await mod.createInitiative({
      name: 'Same day',
      startDate: '2026-04-01',
      endDate: '2026-04-01',
    })
    expect(res.success).toBe(true)
  })

  it('rejects an invalid status', async () => {
    const res = await mod.createInitiative({
      name: 'x',
      startDate: '2026-04-01',
      status: 'deleted' as any,
    })
    expect(res.success).toBe(false)
    expect(initiativesCreate).not.toHaveBeenCalled()
  })

  it('rejects an unknown top-level key (zod .strict())', async () => {
    const res = await mod.createInitiative({
      name: 'x',
      startDate: '2026-04-01',
      sneaky: 'field',
    } as any)
    expect(res.success).toBe(false)
    expect(initiativesCreate).not.toHaveBeenCalled()
  })

  it('rejects a missing startDate', async () => {
    const res = await mod.createInitiative({ name: 'x' } as any)
    expect(res.success).toBe(false)
    expect(initiativesCreate).not.toHaveBeenCalled()
  })
})

describe('createInitiative — money-write gate', () => {
  it.each(['member', 'developer'] as const)('denies role %s and never writes', async (role) => {
    baMemberFindFirst.mockResolvedValue({ role })
    const res = await mod.createInitiative({ name: 'x', startDate: '2026-04-01' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/finance, admin, or owner/i)
    expect(initiativesCreate).not.toHaveBeenCalled()
  })

  it.each(['owner', 'admin', 'finance'] as const)('allows role %s and writes', async (role) => {
    baMemberFindFirst.mockResolvedValue({ role })
    const res = await mod.createInitiative({ name: 'x', startDate: '2026-04-01' })
    expect(res.success).toBe(true)
    expect(initiativesCreate).toHaveBeenCalledTimes(1)
  })

  it('reads the role from the caller\'s active org', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'owner' })
    await mod.createInitiative({ name: 'x', startDate: '2026-04-01' })
    expect(baMemberFindFirst.mock.calls[0][0].where).toMatchObject({
      organizationId: ORG,
      userId: USER,
    })
  })

  it('mutation sensitivity: same input, only the role flips — outcome flips', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'owner' })
    expect((await mod.createInitiative({ name: 'x', startDate: '2026-04-01' })).success).toBe(true)

    initiativesCreate.mockClear()
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    expect((await mod.createInitiative({ name: 'x', startDate: '2026-04-01' })).success).toBe(false)
    expect(initiativesCreate).not.toHaveBeenCalled()
  })
})

describe('updateInitiative — ownership + validation', () => {
  it('rejects when the initiative does not belong to the caller\'s org (not found)', async () => {
    initiativesFindFirst.mockResolvedValue(null)
    const res = await mod.updateInitiative('init-1', { name: 'New name' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found/i)
    expect(initiativesUpdate).not.toHaveBeenCalled()
  })

  it('rejects a new endDate before the existing startDate', async () => {
    initiativesFindFirst.mockResolvedValue({
      id: 'init-1',
      startDate: new Date(Date.UTC(2026, 3, 10)),
      endDate: null,
    })
    const res = await mod.updateInitiative('init-1', { endDate: '2026-04-01' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/End date must be on or after the start date/)
    expect(initiativesUpdate).not.toHaveBeenCalled()
  })

  it('denies a plain member and never reaches the ownership check', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    const res = await mod.updateInitiative('init-1', { name: 'New name' })
    expect(res.success).toBe(false)
    expect(initiativesFindFirst).not.toHaveBeenCalled()
    expect(initiativesUpdate).not.toHaveBeenCalled()
  })
})

describe('deleteInitiative — gate + ownership', () => {
  it('denies a plain member and never deletes', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    const res = await mod.deleteInitiative('init-1')
    expect(res.success).toBe(false)
    expect(initiativesDelete).not.toHaveBeenCalled()
  })

  it('rejects deleting an initiative outside the caller\'s org', async () => {
    initiativesFindFirst.mockResolvedValue(null)
    const res = await mod.deleteInitiative('init-1')
    expect(res.success).toBe(false)
    expect(initiativesDelete).not.toHaveBeenCalled()
  })

  it('allows an owner to delete an initiative that belongs to their org', async () => {
    const res = await mod.deleteInitiative('init-1')
    expect(res.success).toBe(true)
    expect(initiativesDelete).toHaveBeenCalledTimes(1)
  })
})

describe('setInitiativeTargets — target validation', () => {
  it('accepts a well-formed target set', async () => {
    const res = await mod.setInitiativeTargets('init-1', [
      { metric: 'cost', targetValue: 1000, direction: 'lte' },
    ])
    expect(res.success).toBe(true)
    expect(targetsDeleteMany).toHaveBeenCalledTimes(1)
    expect(targetsCreateMany).toHaveBeenCalledTimes(1)
  })

  it('rejects a negative target for a metric that cannot go negative (cost)', async () => {
    const res = await mod.setInitiativeTargets('init-1', [
      { metric: 'cost', targetValue: -50, direction: 'lte' },
    ])
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/can't be negative/)
    expect(targetsCreateMany).not.toHaveBeenCalled()
  })

  it('rejects a negative target for eventCount too', async () => {
    const res = await mod.setInitiativeTargets('init-1', [
      { metric: 'eventCount', targetValue: -1, direction: 'gte' },
    ])
    expect(res.success).toBe(false)
    expect(targetsCreateMany).not.toHaveBeenCalled()
  })

  it('accepts a negative target for margin (a loss-leader phase goal)', async () => {
    const res = await mod.setInitiativeTargets('init-1', [
      { metric: 'margin', targetValue: -100, direction: 'gte' },
    ])
    expect(res.success).toBe(true)
    expect(targetsCreateMany).toHaveBeenCalledTimes(1)
  })

  it('accepts a negative target for marginPercent too', async () => {
    const res = await mod.setInitiativeTargets('init-1', [
      { metric: 'marginPercent', targetValue: -10, direction: 'gte' },
    ])
    expect(res.success).toBe(true)
  })

  it('rejects an unknown metric', async () => {
    const res = await mod.setInitiativeTargets('init-1', [
      { metric: 'not-a-real-metric' as any, targetValue: 10, direction: 'lte' },
    ])
    expect(res.success).toBe(false)
    expect(targetsCreateMany).not.toHaveBeenCalled()
  })

  it('rejects an unknown direction', async () => {
    const res = await mod.setInitiativeTargets('init-1', [
      { metric: 'cost', targetValue: 10, direction: 'up' as any },
    ])
    expect(res.success).toBe(false)
    expect(targetsCreateMany).not.toHaveBeenCalled()
  })

  it('rejects more than 50 targets', async () => {
    const targets = Array.from({ length: 51 }, () => ({
      metric: 'cost' as const,
      targetValue: 1,
      direction: 'lte' as const,
    }))
    const res = await mod.setInitiativeTargets('init-1', targets)
    expect(res.success).toBe(false)
    expect(targetsCreateMany).not.toHaveBeenCalled()
  })

  it('replace-all: an empty array clears targets without creating any', async () => {
    const res = await mod.setInitiativeTargets('init-1', [])
    expect(res.success).toBe(true)
    expect(targetsDeleteMany).toHaveBeenCalledTimes(1)
    expect(targetsCreateMany).not.toHaveBeenCalled()
  })

  it('denies a plain member before touching the DB', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    const res = await mod.setInitiativeTargets('init-1', [
      { metric: 'cost', targetValue: 10, direction: 'lte' },
    ])
    expect(res.success).toBe(false)
    expect(targetsDeleteMany).not.toHaveBeenCalled()
  })

  it('rejects targets for an initiative outside the caller\'s org', async () => {
    initiativesFindFirst.mockResolvedValue(null)
    const res = await mod.setInitiativeTargets('init-1', [
      { metric: 'cost', targetValue: 10, direction: 'lte' },
    ])
    expect(res.success).toBe(false)
    expect(targetsDeleteMany).not.toHaveBeenCalled()
  })
})

describe('getInitiatives — read, scoped to the session org, no gate', () => {
  it('lists initiatives for the session org', async () => {
    initiativesFindMany.mockResolvedValue([rowFixture()])
    const res = await mod.getInitiatives()
    expect(res.success).toBe(true)
    expect(res.data).toHaveLength(1)
    expect(initiativesFindMany.mock.calls[0][0].where).toEqual({ orgId: ORG })
  })
})

describe('setInitiativeTargets — auto-baseline wiring (mocked measurer)', () => {
  it('a row WITHOUT a baseline is measured against the initiative window and stored as auto', async () => {
    computeAutoBaselinesMock.mockResolvedValue(new Map([['cost', 8123.45]]))
    const res = await mod.setInitiativeTargets('init-1', [
      { metric: 'cost', targetValue: 1000, direction: 'lte' },
    ])
    expect(res.success).toBe(true)
    expect(computeAutoBaselinesMock).toHaveBeenCalledTimes(1)
    expect(computeAutoBaselinesMock.mock.calls[0][1]).toEqual({
      startDate: '2026-04-01',
      endDate: null,
    })
    expect(computeAutoBaselinesMock.mock.calls[0][2]).toEqual(['cost'])
    expect(targetsCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      baselineValue: 8123.45,
      baselineSource: 'auto',
    })
  })

  it('a row WITH a baseline and no source stays manual — the measurer is never consulted', async () => {
    const res = await mod.setInitiativeTargets('init-1', [
      { metric: 'cost', targetValue: 1000, baselineValue: 5000, direction: 'lte' },
    ])
    expect(res.success).toBe(true)
    expect(computeAutoBaselinesMock).not.toHaveBeenCalled()
    expect(targetsCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      baselineValue: 5000,
      baselineSource: 'manual',
    })
  })

  it("an auto row WITH a value is a carry-forward — stored as sent, no re-measure", async () => {
    const res = await mod.setInitiativeTargets('init-1', [
      {
        metric: 'cost',
        targetValue: 1000,
        baselineValue: 8123.45,
        baselineSource: 'auto',
        direction: 'lte',
      },
    ])
    expect(res.success).toBe(true)
    expect(computeAutoBaselinesMock).not.toHaveBeenCalled()
    expect(targetsCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      baselineValue: 8123.45,
      baselineSource: 'auto',
    })
  })

  it('a no-data measurement stores an honest null, still marked auto', async () => {
    computeAutoBaselinesMock.mockResolvedValue(new Map([['mrr', null]]))
    const res = await mod.setInitiativeTargets('init-1', [
      { metric: 'mrr', targetValue: 5000, direction: 'gte' },
    ])
    expect(res.success).toBe(true)
    expect(targetsCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      baselineValue: null,
      baselineSource: 'auto',
    })
  })
})

describe('updateInitiative — re-measures auto baselines ONLY when the start date moves', () => {
  const autoTarget = {
    id: 'target-1',
    metric: 'cost',
    baselineSource: 'auto',
  }
  const manualTarget = {
    id: 'target-2',
    metric: 'revenue',
    baselineSource: 'manual',
  }
  const legacyTarget = {
    id: 'target-3',
    metric: 'margin',
    baselineSource: null,
  }

  it('start date moved: auto targets re-measure against the NEW window; manual and no-source rows are untouched', async () => {
    initiativesFindFirst.mockResolvedValue({
      id: 'init-1',
      startDate: NOW,
      endDate: null,
      initiative_targets: [autoTarget, manualTarget, legacyTarget],
    })
    computeAutoBaselinesMock.mockResolvedValue(new Map([['cost', 42]]))

    const res = await mod.updateInitiative('init-1', { startDate: '2026-05-01' })
    expect(res.success).toBe(true)
    expect(computeAutoBaselinesMock).toHaveBeenCalledTimes(1)
    expect(computeAutoBaselinesMock.mock.calls[0][1]).toEqual({
      startDate: '2026-05-01',
      endDate: null,
    })
    expect(computeAutoBaselinesMock.mock.calls[0][2]).toEqual(['cost'])
    expect(targetsUpdate).toHaveBeenCalledTimes(1)
    expect(targetsUpdate.mock.calls[0][0]).toMatchObject({
      where: { id: 'target-1' },
      data: { baselineValue: 42 },
    })
  })

  it('same start date sent verbatim: nothing re-measures', async () => {
    initiativesFindFirst.mockResolvedValue({
      id: 'init-1',
      startDate: NOW,
      endDate: null,
      initiative_targets: [autoTarget],
    })
    const res = await mod.updateInitiative('init-1', { startDate: '2026-04-01' })
    expect(res.success).toBe(true)
    expect(computeAutoBaselinesMock).not.toHaveBeenCalled()
    expect(targetsUpdate).not.toHaveBeenCalled()
  })

  it('a name-only edit never re-measures', async () => {
    initiativesFindFirst.mockResolvedValue({
      id: 'init-1',
      startDate: NOW,
      endDate: null,
      initiative_targets: [autoTarget],
    })
    const res = await mod.updateInitiative('init-1', { name: 'Renamed' })
    expect(res.success).toBe(true)
    expect(computeAutoBaselinesMock).not.toHaveBeenCalled()
  })
})

describe('previewAutoBaselines — the dialog disclosure read (mocked measurer)', () => {
  it('is money-manager gated like the writes it feeds', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })
    const res = await mod.previewAutoBaselines({
      startDate: '2026-04-01',
      metrics: ['cost'],
    })
    expect(res.success).toBe(false)
    expect(computeAutoBaselinesMock).not.toHaveBeenCalled()
  })

  it('returns one measured value per requested metric, in request order', async () => {
    computeAutoBaselinesMock.mockResolvedValue(
      new Map([
        ['cost', 812.5],
        ['mrr', null],
      ])
    )
    const res = await mod.previewAutoBaselines({
      startDate: '2026-04-01',
      endDate: null,
      metrics: ['cost', 'mrr'],
    })
    expect(res.success).toBe(true)
    expect(res.data).toEqual([
      { metric: 'cost', baseline: 812.5 },
      { metric: 'mrr', baseline: null },
    ])
  })

  it('rejects an empty metric list and an unknown metric before the gate matters', async () => {
    expect(
      (await mod.previewAutoBaselines({ startDate: '2026-04-01', metrics: [] }))
        .success
    ).toBe(false)
    expect(
      (
        await mod.previewAutoBaselines({
          startDate: '2026-04-01',
          metrics: ['not-a-metric' as never],
        })
      ).success
    ).toBe(false)
    expect(computeAutoBaselinesMock).not.toHaveBeenCalled()
  })
})

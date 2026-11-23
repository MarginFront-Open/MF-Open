/**
 * CreateInitiative / updateInitiative with a matter scope.
 *
 * Fully mocked, no DB — the same world initiatives-validation.test.ts builds
 * (session, headers, cache and the `db` client all mocked;
 * computeAutoBaselines mocked because it opens its own PrismaClient).
 *
 * The rule under test: a matterId is only accepted when it names a matter of
 * the caller's active org. A borrowed id from another org is refused with
 * a plain error and NOTHING is written — not the matter scope, not the name,
 * not anything else in the same call.
 */

export {}

const ORG = 'org-matter-scope'
const USER = 'user-matter-scope'
const MATTER_ID = '11111111-1111-4111-8111-111111111111'
const FOREIGN_MATTER_ID = '22222222-2222-4222-8222-222222222222'

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
  computeAutoBaselines: (...args: unknown[]) =>
    computeAutoBaselinesMock(...args),
}))

const baMemberFindFirst = jest.fn()
const mattersFindFirst = jest.fn()
const initiativesFindFirst = jest.fn()
const initiativesCreate = jest.fn()
const initiativesUpdate = jest.fn()

jest.mock('@/app/lib/db', () => ({
  db: {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
    matters: { findFirst: (a: unknown) => mattersFindFirst(a) },
    initiatives: {
      findFirst: (a: unknown) => initiativesFindFirst(a),
      create: (a: unknown) => initiativesCreate(a),
      update: (a: unknown) => initiativesUpdate(a),
      findMany: jest.fn(),
      delete: jest.fn(),
    },
    initiative_targets: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
  },
}))

type Mod = typeof import('../initiatives')
let mod: Mod

const NOW = new Date(Date.UTC(2026, 3, 1))
const createdRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'init-1',
  name: 'Foglamp Media case spend',
  description: null,
  status: 'active',
  startDate: NOW,
  endDate: null,
  matterId: MATTER_ID,
  scopedMatterNumber: '2026-0031',
  createdByUserId: USER,
  createdAt: NOW,
  updatedAt: NOW,
  initiative_targets: [],
  matters: { matterNumber: '2026-0031' },
  ...overrides,
})

beforeAll(async () => {
  mod = await import('../initiatives')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  ;[
    baMemberFindFirst,
    mattersFindFirst,
    initiativesFindFirst,
    initiativesCreate,
    initiativesUpdate,
    computeAutoBaselinesMock,
  ].forEach((m) => m.mockReset())

  baMemberFindFirst.mockResolvedValue({ role: 'owner' })
  mattersFindFirst.mockResolvedValue({
    id: MATTER_ID,
    matterNumber: '2026-0031',
  })
  initiativesFindFirst.mockResolvedValue({
    id: 'init-1',
    startDate: NOW,
    endDate: null,
    matterId: null,
    scopedMatterNumber: null,
    initiative_targets: [],
  })
  computeAutoBaselinesMock.mockResolvedValue(new Map())
  initiativesCreate.mockResolvedValue(createdRow())
  initiativesUpdate.mockResolvedValue(createdRow())
})

describe('createInitiative — the matter scope is checked against the caller org', () => {
  it('accepts a matter of the caller org and stores the id plus its number', async () => {
    const res = await mod.createInitiative({
      name: 'Foglamp Media case spend',
      startDate: '2026-04-01',
      matterId: MATTER_ID,
    })
    expect(res.success).toBe(true)
    expect(mattersFindFirst.mock.calls[0][0].where).toMatchObject({
      id: MATTER_ID,
      orgId: ORG,
    })
    expect(initiativesCreate.mock.calls[0][0].data).toMatchObject({
      matterId: MATTER_ID,
      scopedMatterNumber: '2026-0031',
    })
    expect(res.data?.matterId).toBe(MATTER_ID)
    expect(res.data?.matterNumber).toBe('2026-0031')
  })

  it("refuses another org's matter id and writes nothing", async () => {
    mattersFindFirst.mockResolvedValue(null)
    const res = await mod.createInitiative({
      name: 'Borrowed matter',
      startDate: '2026-04-01',
      matterId: FOREIGN_MATTER_ID,
    })
    expect(res.success).toBe(false)
    expect(res.error).toBe(
      "That matter isn't in your organization, so nothing was saved. Pick a matter from the list and try again."
    )
    expect(initiativesCreate).not.toHaveBeenCalled()
  })

  it('a null matterId is the whole organization — no matter lookup at all', async () => {
    initiativesCreate.mockResolvedValue(
      createdRow({ matterId: null, scopedMatterNumber: null, matters: null })
    )
    const res = await mod.createInitiative({
      name: 'Org-wide goal',
      startDate: '2026-04-01',
      matterId: null,
    })
    expect(res.success).toBe(true)
    expect(mattersFindFirst).not.toHaveBeenCalled()
    expect(initiativesCreate.mock.calls[0][0].data).toMatchObject({
      matterId: null,
      scopedMatterNumber: null,
    })
  })

  it('rejects a matterId that is not a uuid before any lookup or write', async () => {
    const res = await mod.createInitiative({
      name: 'Bad id',
      startDate: '2026-04-01',
      matterId: 'not-a-uuid',
    })
    expect(res.success).toBe(false)
    expect(mattersFindFirst).not.toHaveBeenCalled()
    expect(initiativesCreate).not.toHaveBeenCalled()
  })
})

describe('updateInitiative — the matter scope is re-checked on every edit', () => {
  it("refuses another org's matter id and leaves the initiative untouched", async () => {
    mattersFindFirst.mockResolvedValue(null)
    const res = await mod.updateInitiative('init-1', {
      name: 'Renamed too',
      matterId: FOREIGN_MATTER_ID,
    })
    expect(res.success).toBe(false)
    expect(res.error).toBe(
      "That matter isn't in your organization, so nothing was saved. Pick a matter from the list and try again."
    )
    expect(initiativesUpdate).not.toHaveBeenCalled()
  })

  it('accepts a matter of the caller org and records its number alongside the id', async () => {
    const res = await mod.updateInitiative('init-1', { matterId: MATTER_ID })
    expect(res.success).toBe(true)
    expect(initiativesUpdate.mock.calls[0][0].data).toMatchObject({
      matterId: MATTER_ID,
      scopedMatterNumber: '2026-0031',
    })
  })

  it('clearing the scope to null also clears the recorded matter number', async () => {
    initiativesFindFirst.mockResolvedValue({
      id: 'init-1',
      startDate: NOW,
      endDate: null,
      matterId: MATTER_ID,
      scopedMatterNumber: '2026-0031',
      initiative_targets: [],
    })
    initiativesUpdate.mockResolvedValue(
      createdRow({ matterId: null, scopedMatterNumber: null, matters: null })
    )
    const res = await mod.updateInitiative('init-1', { matterId: null })
    expect(res.success).toBe(true)
    expect(mattersFindFirst).not.toHaveBeenCalled()
    expect(initiativesUpdate.mock.calls[0][0].data).toMatchObject({
      matterId: null,
      scopedMatterNumber: null,
    })
  })

  it('an edit that never mentions matterId leaves the stored scope alone', async () => {
    const res = await mod.updateInitiative('init-1', { name: 'Renamed' })
    expect(res.success).toBe(true)
    expect(mattersFindFirst).not.toHaveBeenCalled()
    expect(initiativesUpdate.mock.calls[0][0].data).not.toHaveProperty(
      'matterId'
    )
    expect(initiativesUpdate.mock.calls[0][0].data).not.toHaveProperty(
      'scopedMatterNumber'
    )
  })

  it("checks the matter against the caller's active org", async () => {
    const res = await mod.updateInitiative('init-1', { matterId: MATTER_ID })
    expect(res.success).toBe(true)
    expect(mattersFindFirst.mock.calls[0][0].where).toMatchObject({
      id: MATTER_ID,
      orgId: ORG,
    })
  })

  it('a changed matter scope re-measures auto baselines through the NEW matter', async () => {
    initiativesFindFirst.mockResolvedValue({
      id: 'init-1',
      startDate: NOW,
      endDate: null,
      matterId: null,
      scopedMatterNumber: null,
      initiative_targets: [
        { id: 'target-1', metric: 'cost', baselineSource: 'auto' },
      ],
    })
    computeAutoBaselinesMock.mockResolvedValue(new Map([['cost', 42]]))
    const res = await mod.updateInitiative('init-1', { matterId: MATTER_ID })
    expect(res.success).toBe(true)
    expect(computeAutoBaselinesMock).toHaveBeenCalledTimes(1)
    expect(computeAutoBaselinesMock.mock.calls[0][3]).toBe(MATTER_ID)
  })

  it('an edit that touches neither the start date nor the scope re-measures nothing', async () => {
    initiativesFindFirst.mockResolvedValue({
      id: 'init-1',
      startDate: NOW,
      endDate: null,
      matterId: MATTER_ID,
      scopedMatterNumber: '2026-0031',
      initiative_targets: [
        { id: 'target-1', metric: 'cost', baselineSource: 'auto' },
      ],
    })
    const res = await mod.updateInitiative('init-1', { name: 'Renamed' })
    expect(res.success).toBe(true)
    expect(computeAutoBaselinesMock).not.toHaveBeenCalled()
  })

  it('a moved start date re-measures auto baselines through the stored matter scope', async () => {
    initiativesFindFirst.mockResolvedValue({
      id: 'init-1',
      startDate: NOW,
      endDate: null,
      matterId: MATTER_ID,
      scopedMatterNumber: '2026-0031',
      initiative_targets: [
        { id: 'target-1', metric: 'cost', baselineSource: 'auto' },
      ],
    })
    computeAutoBaselinesMock.mockResolvedValue(new Map([['cost', 42]]))
    const res = await mod.updateInitiative('init-1', {
      startDate: '2026-05-01',
    })
    expect(res.success).toBe(true)
    expect(computeAutoBaselinesMock.mock.calls[0][3]).toBe(MATTER_ID)
  })
})

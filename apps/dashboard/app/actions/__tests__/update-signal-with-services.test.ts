/**
 * updateSignalWithServices: the edit-in-place
 * server action behind the metrics editor. Proves the OUTCOME contract on a
 * fully mocked db, mirroring build-writes-authz.test.ts:
 *
 *   - a plain `member` is DENIED and no mutation fires (BUILD gate)
 *   - the happy path updates the signal AND replaces its service links in
 *     ONE transaction (delete-then-create, so the (signalId,
 *     servicePricingId) unique can never collide mid-replace)
 *   - a replay (same payload saved twice) succeeds both times — the
 *     replace-style write is idempotent by construction
 *   - a P2002 unique violation (duplicate metric name on the agent) maps
 *     to a plain-English error instead of a 500
 *   - shortName only regenerates when the name actually changed
 */

export {}

const ORG = 'org-real-build'
const USER = 'user-build'
const SIGNAL_ID = 'signal-1'

let sessionState: {
  activeOrganizationId: string | null
  userId: string | null
} = {
  activeOrganizationId: ORG,
  userId: USER,
}

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
const baMemberFindFirst = jest.fn()
const signalsFindFirst = jest.fn()
const signalsUpdate = jest.fn()
const signalServicesDeleteMany = jest.fn()
const signalServicesCreate = jest.fn()
const servicePricingFindMany = jest.fn()
const transactionMock = jest.fn()

jest.mock('@/app/lib/db', () => ({
  db: {
    ba_member: { findFirst: (a: unknown) => baMemberFindFirst(a) },
    signals: {
      findFirst: (a: unknown) => signalsFindFirst(a),
      update: (a: unknown) => signalsUpdate(a),
    },
    signal_services: {
      deleteMany: (a: unknown) => signalServicesDeleteMany(a),
      create: (a: unknown) => signalServicesCreate(a),
    },
    service_pricing: { findMany: (a: unknown) => servicePricingFindMany(a) },
    $transaction: (ops: unknown) => transactionMock(ops),
  },
  Prisma: { InputJsonValue: {} },
}))

type SignalServices = typeof import('../signal-services')
let signalServices: SignalServices

beforeAll(async () => {
  signalServices = await import('../signal-services')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  ;[
    baMemberFindFirst,
    signalsFindFirst,
    signalsUpdate,
    signalServicesDeleteMany,
    signalServicesCreate,
    servicePricingFindMany,
    transactionMock,
  ].forEach((fn) => fn.mockReset())

  baMemberFindFirst.mockResolvedValue({ role: 'owner' })
  signalsFindFirst.mockResolvedValue({
    id: SIGNAL_ID,
    orgId: ORG,
    name: 'Old name',
    shortName: 'old_name',
    deletedAt: null,
  })
  servicePricingFindMany.mockResolvedValue([
    { id: 'sp-row-1' },
    { id: 'sp-row-2' },
  ])
  transactionMock.mockImplementation(async (ops: unknown[]) => ops)
})

describe('updateSignalWithServices — BUILD gate', () => {
  it('denies a plain member and never opens a transaction', async () => {
    baMemberFindFirst.mockResolvedValue({ role: 'member' })

    const result = await signalServices.updateSignalWithServices({
      signalId: SIGNAL_ID,
      name: 'Renamed',
      type: 'volume',
      serviceExternalIds: ['svc-a'],
    })

    expect(result.success).toBe(false)
    expect(transactionMock).not.toHaveBeenCalled()
    expect(signalsUpdate).not.toHaveBeenCalled()
    expect(signalServicesDeleteMany).not.toHaveBeenCalled()
  })

  it("scopes the signal lookup to the caller's active org and soft-delete state", async () => {
    await signalServices.updateSignalWithServices({
      signalId: SIGNAL_ID,
      name: 'Renamed',
      type: 'volume',
      serviceExternalIds: ['svc-a'],
    })

    expect(signalsFindFirst).toHaveBeenCalledWith({
      where: { id: SIGNAL_ID, orgId: ORG, deletedAt: null },
    })
  })
})

describe('updateSignalWithServices — happy path', () => {
  it('updates the signal and replaces its links in one delete-then-create transaction', async () => {
    const result = await signalServices.updateSignalWithServices({
      signalId: SIGNAL_ID,
      name: 'Renamed task',
      type: 'usage',
      serviceExternalIds: ['svc-a', 'svc-b'],
    })

    expect(result.success).toBe(true)
    expect(transactionMock).toHaveBeenCalledTimes(1)

    const updateArg = signalsUpdate.mock.calls[0][0]
    expect(updateArg.where).toEqual({ id: SIGNAL_ID })
    expect(updateArg.data.name).toBe('Renamed task')
    expect(updateArg.data.shortName).toBe('renamed_task')
    expect(updateArg.data.type).toBe('usage')

    expect(signalServicesDeleteMany).toHaveBeenCalledWith({
      where: { signalId: SIGNAL_ID },
    })
    expect(signalServicesCreate).toHaveBeenCalledTimes(2)
    const createdPricingIds = signalServicesCreate.mock.calls.map(
      (call) => call[0].data.servicePricingId
    )
    expect(createdPricingIds.sort()).toEqual(['sp-row-1', 'sp-row-2'])
  })

  it('leaves shortName alone when the name did not change (no ingest-key churn)', async () => {
    await signalServices.updateSignalWithServices({
      signalId: SIGNAL_ID,
      name: 'Old name',
      type: 'volume',
      serviceExternalIds: ['svc-a'],
    })

    const updateArg = signalsUpdate.mock.calls[0][0]
    expect(updateArg.data.name).toBe('Old name')
    expect('shortName' in updateArg.data).toBe(false)
  })

  it('dedupes repeated service ids before resolving, so the unique link constraint cannot collide', async () => {
    servicePricingFindMany.mockResolvedValue([{ id: 'sp-row-1' }])

    const result = await signalServices.updateSignalWithServices({
      signalId: SIGNAL_ID,
      name: 'Renamed',
      type: 'volume',
      serviceExternalIds: ['svc-a', 'svc-a', 'svc-a'],
    })

    expect(result.success).toBe(true)
    const findManyWhere = servicePricingFindMany.mock.calls[0][0].where
    expect(findManyWhere.externalId.in).toEqual(['svc-a'])
    expect(findManyWhere.isActive).toBe(true)
    expect(signalServicesCreate).toHaveBeenCalledTimes(1)
  })

  it('rejects an empty name before touching the database', async () => {
    const result = await signalServices.updateSignalWithServices({
      signalId: SIGNAL_ID,
      name: '   ',
      type: 'volume',
      serviceExternalIds: ['svc-a'],
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('name')
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('returns a clean error when the signal is missing or belongs to another org', async () => {
    signalsFindFirst.mockResolvedValue(null)

    const result = await signalServices.updateSignalWithServices({
      signalId: 'someone-elses-signal',
      name: 'Renamed',
      type: 'volume',
      serviceExternalIds: ['svc-a'],
    })

    expect(result).toEqual({ success: false, error: 'Signal not found' })
    expect(transactionMock).not.toHaveBeenCalled()
  })
})

describe('updateSignalWithServices — unique constraint + replay', () => {
  it('replaying the same save succeeds (replace-style write is idempotent)', async () => {
    const payload = {
      signalId: SIGNAL_ID,
      name: 'Renamed task',
      type: 'usage' as const,
      serviceExternalIds: ['svc-a', 'svc-b'],
    }

    const first = await signalServices.updateSignalWithServices(payload)
    // The rename landed; the second save sees the new name in the db.
    signalsFindFirst.mockResolvedValue({
      id: SIGNAL_ID,
      orgId: ORG,
      name: 'Renamed task',
      shortName: 'renamed_task',
      deletedAt: null,
    })
    const second = await signalServices.updateSignalWithServices(payload)

    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    expect(transactionMock).toHaveBeenCalledTimes(2)
    // Every replay deletes the old links before recreating them, so the
    // (signalId, servicePricingId) unique never sees a duplicate insert.
    expect(signalServicesDeleteMany).toHaveBeenCalledTimes(2)
  })

  it('maps a P2002 unique violation to a plain-English duplicate-name error', async () => {
    transactionMock.mockRejectedValue({ code: 'P2002' })

    const result = await signalServices.updateSignalWithServices({
      signalId: SIGNAL_ID,
      name: 'Taken name',
      type: 'volume',
      serviceExternalIds: ['svc-a'],
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('already taken')
    expect(result.error).toContain('pick a different name')
  })
})

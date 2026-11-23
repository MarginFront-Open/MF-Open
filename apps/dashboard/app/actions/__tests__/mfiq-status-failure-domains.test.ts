/**
 * GetMfiqStatus failure domains. Mocks the
 * composed reads (the DEPENDENCIES, never the unit under test) and proves the
 * per-source tolerance contract: one source failing — rejecting OR resolving
 * {success: false} — nulls ONLY its own fact group; all of them failing fails
 * the action with a what/why/fix message; fulfilled values map VERBATIM (no
 * re-derivation on the way out).
 *
 * Error shapes: four sources return {success, data?, error?} and never throw
 * (each has its own try/catch: finops-close-status.ts,
 * build-agents-overview.ts, and two reads in signal-events.ts).
 * getPeriodLockStatus (finance-period-lock.ts) returns PeriodLockStatus
 * DIRECTLY — no success wrapper, no try/catch — so its failure domain is
 * rejection alone.
 */

let mockSession: {
  session: { activeOrganizationId: string }
} | null = null

jest.mock('@/app/lib/auth', () => ({
  auth: { api: { getSession: async () => mockSession } },
}))
jest.mock('next/headers', () => ({ headers: async () => new Headers() }))
jest.mock('../finops-close-status', () => ({
  getFinopsCloseStatus: jest.fn(),
}))
jest.mock('../finance-period-lock', () => ({ getPeriodLockStatus: jest.fn() }))
jest.mock('../build-agents-overview', () => ({
  getBuildAgentsOverview: jest.fn(),
}))
jest.mock('../signal-events', () => ({
  getNeedsCostBackfillGroups: jest.fn(),
  getMissingVolumeGroups: jest.fn(),
}))
// The sixth composed read — wrapped shape, so its failure domain
// is rejection AND {success: false} (unlike getPeriodLockStatus).
jest.mock('../credit-pools', () => ({
  getExhaustedCreditPools: jest.fn(),
}))

import { getMfiqStatus } from '../mfiq-status'
import { getFinopsCloseStatus } from '../finops-close-status'
import { getPeriodLockStatus } from '../finance-period-lock'
import { getBuildAgentsOverview } from '../build-agents-overview'
import {
  getNeedsCostBackfillGroups,
  getMissingVolumeGroups,
} from '../signal-events'
import { getExhaustedCreditPools } from '../credit-pools'
import { monthPeriod } from '@/features/_shared/billing-period'

const closeMock = getFinopsCloseStatus as jest.Mock
const lockMock = getPeriodLockStatus as jest.Mock
const agentsMock = getBuildAgentsOverview as jest.Mock
const backfillMock = getNeedsCostBackfillGroups as jest.Mock
const missingVolumeMock = getMissingVolumeGroups as jest.Mock
const creditPoolsMock = getExhaustedCreditPools as jest.Mock

const CLOSE_OK = {
  success: true,
  data: {
    monthLabel: 'July 2026',
    totalCost: 172,
    eventCount: 4,
    unclassifiedCost: 7,
    unmappedAmount: 7,
    unmappedSignalCount: 1,
    classifiedShare: 0.959,
    mismatchedSignalCount: 1,
    // The action must DROP these two (facts carry no journal payload).
    lock: { locked: false },
    journal: { rows: [] },
  },
}

const LOCK_OK = {
  locked: false,
  lockedAt: null,
  lockedByUserId: null,
  lockedByName: null,
  periodLabel: null,
  closable: true,
}

const AGENTS_OK = {
  success: true,
  data: {
    window: {
      start: new Date('2026-06-15T00:00:00.000Z'),
      end: new Date('2026-07-15T00:00:00.000Z'),
      label: 'Last 30 days',
    },
    rows: [
      {
        agentId: 'agent-1',
        name: 'Ops Agent',
        agentCode: 'ops-agent',
        isActive: true,
        tasks: 12,
        cost: 620,
        earned: 410,
        marginPercent: -51.2,
      },
    ],
    totals: { tasks: 12, cost: 620, earned: 410 },
    agentCount: 1,
    pausedCount: 0,
  },
}

const BACKFILL_OK = { success: true, data: { groups: [], totalEvents: 38 } }
const MISSING_VOLUME_OK = {
  success: true,
  data: { groups: [], totalEvents: 5 },
}
// exhaustedCount/nearEmptyCount are decoys: the action must carry pools.length,
// the same count the needs-attention section shows.
const CREDIT_POOLS_OK = {
  success: true,
  data: {
    permission: { canManage: true, whoCanChange: 'anyone' },
    pools: [{ subscriptionId: 'sub-1' }, { subscriptionId: 'sub-2' }],
    exhaustedCount: 1,
    nearEmptyCount: 1,
  },
}

beforeEach(() => {
  mockSession = { session: { activeOrganizationId: 'org-mfiq-test' } }
  closeMock.mockReset().mockResolvedValue(CLOSE_OK)
  lockMock.mockReset().mockResolvedValue(LOCK_OK)
  agentsMock.mockReset().mockResolvedValue(AGENTS_OK)
  backfillMock.mockReset().mockResolvedValue(BACKFILL_OK)
  missingVolumeMock.mockReset().mockResolvedValue(MISSING_VOLUME_OK)
  creditPoolsMock.mockReset().mockResolvedValue(CREDIT_POOLS_OK)
})

describe('getMfiqStatus — session presence (own error shape, mirrors finops-close-status)', () => {
  it('no session ⇒ {success: false} and NO source read fires', async () => {
    mockSession = null
    const result = await getMfiqStatus()
    expect(result).toEqual({ success: false, error: 'No active organization' })
    expect(closeMock).not.toHaveBeenCalled()
    expect(lockMock).not.toHaveBeenCalled()
    expect(agentsMock).not.toHaveBeenCalled()
  })
})

describe('getMfiqStatus — happy path maps fulfilled values verbatim', () => {
  it('books is the reduced close payload — verbatim fields, journal/lock/totalCost dropped', async () => {
    const result = await getMfiqStatus()
    expect(result.success).toBe(true)
    expect(result.data!.books).toEqual({
      monthLabel: 'July 2026',
      eventCount: 4,
      unmappedAmount: 7,
      unmappedSignalCount: 1,
      unclassifiedCost: 7,
      classifiedShare: 0.959,
      mismatchedSignalCount: 1,
    })
  })

  it('prevMonth carries monthPeriod(1) label + full-ISO period end + lock fields verbatim', async () => {
    const previous = monthPeriod(1)
    const result = await getMfiqStatus()
    expect(result.data!.prevMonth).toEqual({
      monthLabel: previous.monthLabel,
      periodEndIso: `${previous.endDate}T23:59:59.999Z`,
      locked: false,
      closable: true,
    })
  })

  it('agents rows pass through minus the fields rules do not read (agentCode/tasks dropped)', async () => {
    const result = await getMfiqStatus()
    expect(result.data!.agents).toEqual({
      windowLabel: 'Last 30 days',
      rows: [
        {
          agentId: 'agent-1',
          name: 'Ops Agent',
          isActive: true,
          cost: 620,
          earned: 410,
          marginPercent: -51.2,
        },
      ],
      pausedCount: 0,
    })
  })

  it('queue totals map verbatim and generatedAt is a real ISO stamp', async () => {
    const result = await getMfiqStatus()
    expect(result.data!.backfillEvents).toBe(38)
    expect(result.data!.missingVolumeEvents).toBe(5)
    expect(result.data!.lowCreditPools).toBe(2)
    expect(new Date(result.data!.generatedAt).toISOString()).toBe(
      result.data!.generatedAt
    )
  })

  it('windows are pinned: close ← monthPeriod(0) bounds, lock ← monthPeriod(1) bounds, agents ← {} (rolling 30d default)', async () => {
    const current = monthPeriod(0)
    const previous = monthPeriod(1)
    await getMfiqStatus()
    expect(closeMock).toHaveBeenCalledWith({
      startDate: current.startDate,
      endDate: current.endDate,
    })
    expect(lockMock).toHaveBeenCalledWith({
      startDate: previous.startDate,
      endDate: previous.endDate,
    })
    expect(agentsMock).toHaveBeenCalledWith({})
    expect(backfillMock).toHaveBeenCalledWith()
    expect(missingVolumeMock).toHaveBeenCalledWith()
    expect(creditPoolsMock).toHaveBeenCalledWith()
  })
})

describe('getMfiqStatus — one failing source nulls ONLY its fact group (M2)', () => {
  it('close REJECTS ⇒ books null, other four populated, success stays true', async () => {
    closeMock.mockRejectedValue(new Error('db down'))
    const result = await getMfiqStatus()
    expect(result.success).toBe(true)
    expect(result.data!.books).toBeNull()
    expect(result.data!.prevMonth).not.toBeNull()
    expect(result.data!.agents).not.toBeNull()
    expect(result.data!.backfillEvents).toBe(38)
    expect(result.data!.missingVolumeEvents).toBe(5)
  })

  it('close resolves {success: false} ⇒ same null mapping', async () => {
    closeMock.mockResolvedValue({ success: false, error: 'nope' })
    const result = await getMfiqStatus()
    expect(result.success).toBe(true)
    expect(result.data!.books).toBeNull()
    expect(result.data!.agents).not.toBeNull()
  })

  it('lock REJECTS ⇒ prevMonth null (rejection is its only failure shape — no success wrapper)', async () => {
    lockMock.mockRejectedValue(new Error('db down'))
    const result = await getMfiqStatus()
    expect(result.success).toBe(true)
    expect(result.data!.prevMonth).toBeNull()
    expect(result.data!.books).not.toBeNull()
    expect(result.data!.agents).not.toBeNull()
  })

  it('agents rejects or fails ⇒ agents null, books/queues intact', async () => {
    agentsMock.mockRejectedValue(new Error('db down'))
    let result = await getMfiqStatus()
    expect(result.data!.agents).toBeNull()
    expect(result.data!.books).not.toBeNull()

    agentsMock.mockReset().mockResolvedValue({ success: false, error: 'cap' })
    result = await getMfiqStatus()
    expect(result.data!.agents).toBeNull()
    expect(result.data!.backfillEvents).toBe(38)
  })

  it('backfill rejects ⇒ backfillEvents null, missingVolumeEvents untouched', async () => {
    backfillMock.mockRejectedValue(new Error('db down'))
    const result = await getMfiqStatus()
    expect(result.data!.backfillEvents).toBeNull()
    expect(result.data!.missingVolumeEvents).toBe(5)
  })

  it('missing-volume resolves {success: false} ⇒ missingVolumeEvents null, backfillEvents untouched', async () => {
    missingVolumeMock.mockResolvedValue({ success: false, error: 'nope' })
    const result = await getMfiqStatus()
    expect(result.data!.missingVolumeEvents).toBeNull()
    expect(result.data!.backfillEvents).toBe(38)
  })

  it('a zero totalEvents is a real 0, never null (0 ≠ failure)', async () => {
    backfillMock.mockResolvedValue({
      success: true,
      data: { groups: [], totalEvents: 0 },
    })
    const result = await getMfiqStatus()
    expect(result.data!.backfillEvents).toBe(0)
  })

  it('credit pools reject or fail ⇒ lowCreditPools null, the other five intact', async () => {
    creditPoolsMock.mockRejectedValue(new Error('db down'))
    let result = await getMfiqStatus()
    expect(result.success).toBe(true)
    expect(result.data!.lowCreditPools).toBeNull()
    expect(result.data!.backfillEvents).toBe(38)
    expect(result.data!.agents).not.toBeNull()

    creditPoolsMock
      .mockReset()
      .mockResolvedValue({ success: false, error: 'Not authenticated' })
    result = await getMfiqStatus()
    expect(result.data!.lowCreditPools).toBeNull()
    expect(result.data!.books).not.toBeNull()
  })

  it('no pool in the band is a real 0, never null (an org with healthy pools is not a failed read)', async () => {
    creditPoolsMock.mockResolvedValue({
      success: true,
      data: {
        permission: { canManage: true, whoCanChange: 'anyone' },
        pools: [],
        exhaustedCount: 0,
        nearEmptyCount: 0,
      },
    })
    const result = await getMfiqStatus()
    expect(result.data!.lowCreditPools).toBe(0)
  })
})

describe('getMfiqStatus — one live source is enough to keep the page alive', () => {
  // A live credit-pool read PROVES the database is reachable, so
  // the total-failure message ("the database is unreachable") would be a lie.
  it('the other five fail but credit pools succeed ⇒ success stays true, the pool row survives', async () => {
    closeMock.mockRejectedValue(new Error('down'))
    lockMock.mockRejectedValue(new Error('down'))
    agentsMock.mockResolvedValue({ success: false, error: 'down' })
    backfillMock.mockResolvedValue({ success: false, error: 'down' })
    missingVolumeMock.mockRejectedValue(new Error('down'))
    const result = await getMfiqStatus()
    expect(result.success).toBe(true)
    expect(result.data!.lowCreditPools).toBe(2)
    expect(result.data!.books).toBeNull()
  })
})

describe('getMfiqStatus — total failure', () => {
  it('all six fail (mixed rejections + {success:false}) ⇒ {success: false} with a what/why/fix message', async () => {
    closeMock.mockRejectedValue(new Error('down'))
    lockMock.mockRejectedValue(new Error('down'))
    agentsMock.mockResolvedValue({ success: false, error: 'down' })
    backfillMock.mockResolvedValue({ success: false, error: 'down' })
    missingVolumeMock.mockRejectedValue(new Error('down'))
    creditPoolsMock.mockResolvedValue({ success: false, error: 'down' })
    const result = await getMfiqStatus()
    expect(result.success).toBe(false)
    expect(result.data).toBeUndefined()
    // what / why / fix
    expect(result.error).toMatch(/Couldn't load the MFiQ score/)
    expect(result.error).toMatch(/All six source reads failed/)
    expect(result.error).toMatch(/refresh/i)
  })
})

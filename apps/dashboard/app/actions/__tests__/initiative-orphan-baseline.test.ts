/**
 * An initiative whose matter was DELETED.
 *
 * The FK is SET NULL, so the actuals widen back to org-wide while the stored
 * AUTO starting values still hold the numbers measured for the one matter —
 * a comparison that reports progress nobody made. buildInitiativeView drops
 * the auto value on an orphan; a MANUAL one is a person's own and survives.
 *
 * Fully mocked, no database: a cost target reaches only the two canon getters
 * stubbed below.
 */

import type { Initiative, InitiativeTarget } from '../initiatives'

const getCostBreakdownMock = jest.fn()
const getMatterCostRollupsMock = jest.fn()

jest.mock('@marginfront/db', () => ({
  ...jest.requireActual('@marginfront/db'),
  getCostBreakdown: (...args: unknown[]) => getCostBreakdownMock(...args),
  getMatterCostRollups: (...args: unknown[]) =>
    getMatterCostRollupsMock(...args),
}))
jest.mock('../journal-export', () => ({ getJournalExport: jest.fn() }))

type Mod = typeof import('../_shared/initiative-actuals')
let mod: Mod

const ORG = 'org-orphan-baseline'
const MATTER_ID = '33333333-3333-4333-8333-333333333333'
const MATTER_NUMBER = '2026-0031'
const NOW = new Date(Date.UTC(2026, 5, 1))

/** What the whole organization spent over the initiative's own window. */
const ORG_WIDE = { cost: 3_000, eventCount: 900 }
/** What the matter itself spent before the start date, stored as the auto
 * starting value while the scope was alive. */
const MATTER_SIZED_BASELINE = 5_000
/** A number a person typed for themselves, not one we measured. */
const TYPED_BASELINE = 20_000
/** The same story on a LEVEL metric, where the starting value is the zero
 * point of the bar rather than context: a dead matter's average is the one
 * that manufactures progress nobody made. */
const ORG_WIDE_PER_EVENT = ORG_WIDE.cost / ORG_WIDE.eventCount
const PER_EVENT_TARGET = 2
const MATTER_SIZED_PER_EVENT_BASELINE = 5

const target = (
  overrides: Partial<InitiativeTarget> = {}
): InitiativeTarget => ({
  id: 'tgt-1',
  metric: 'cost',
  targetValue: 400,
  baselineValue: MATTER_SIZED_BASELINE,
  baselineSource: 'auto',
  direction: 'lte',
  ...overrides,
})

const initiative = (overrides: Partial<Initiative> = {}): Initiative => ({
  id: 'init-orphan',
  name: 'Hold Foglamp Media spend down',
  description: null,
  status: 'active',
  startDate: '2026-05-01T00:00:00.000Z',
  endDate: null,
  matterId: null,
  matterNumber: null,
  scopedMatterNumber: null,
  createdByUserId: 'user-1',
  targets: [target()],
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
  ...overrides,
})

/** matterId null + scopedMatterNumber set = the matter was deleted. */
const orphaned = (overrides: Partial<Initiative> = {}): Initiative =>
  initiative({ scopedMatterNumber: MATTER_NUMBER, ...overrides })

beforeAll(async () => {
  mod = await import('../_shared/initiative-actuals')
})

beforeEach(() => {
  getCostBreakdownMock.mockReset()
  getMatterCostRollupsMock.mockReset()
  getCostBreakdownMock.mockResolvedValue({ totals: { ...ORG_WIDE } })
  getMatterCostRollupsMock.mockResolvedValue([
    { matterId: MATTER_ID, cost: 900, eventCount: 120 },
  ])
})

describe('buildInitiativeView — a deleted matter drops the auto starting value', () => {
  it('reads org-wide again and reports no starting value', async () => {
    const view = await mod.buildInitiativeView(orphaned(), ORG, NOW)

    expect(getMatterCostRollupsMock).not.toHaveBeenCalled()
    expect(view.targets[0].actual).toBe(ORG_WIDE.cost)
    expect(view.targets[0].baseline).toBeNull()
    expect(view.targets[0].baselineSource).toBe('auto')
    // Spend is a running total, so the bar reads against the cap either way
    // and this one is far past it. What the drop protects here is the
    // "Last window" line, which would otherwise quote a dead matter.
    expect(view.targets[0].progressPct).toBe(100)
  })

  it('drops the number a level goal actually leans on', async () => {
    const perEvent = orphaned({
      targets: [
        target({
          metric: 'costPerTask',
          targetValue: PER_EVENT_TARGET,
          baselineValue: MATTER_SIZED_PER_EVENT_BASELINE,
        }),
      ],
    })

    const view = await mod.buildInitiativeView(perEvent, ORG, NOW)

    expect(view.targets[0].actual).toBeCloseTo(ORG_WIDE_PER_EVENT, 6)
    expect(view.targets[0].baseline).toBeNull()
    // The no-baseline gauge — not the far higher number the dead matter's
    // starting value would manufacture out of an org-wide actual.
    expect(view.targets[0].progressPct).toBeCloseTo(
      (PER_EVENT_TARGET / ORG_WIDE_PER_EVENT) * 100,
      6
    )
  })

  it('shows the dash instead of progress measured against the dead scope', async () => {
    const toZero = orphaned({
      targets: [target({ targetValue: 0 })],
    })

    const view = await mod.buildInitiativeView(toZero, ORG, NOW)

    expect(view.targets[0].progressPct).toBeNull()
    expect(view.targets[0].met).toBe(false)
    expect(view.health).toBe('no-data')
  })

  it("keeps a manual starting value — that number is a person's own", async () => {
    const manual = orphaned({
      targets: [
        target({ baselineValue: TYPED_BASELINE, baselineSource: 'manual' }),
      ],
    })

    const view = await mod.buildInitiativeView(manual, ORG, NOW)

    expect(view.targets[0].baseline).toBe(TYPED_BASELINE)
  })

  it("keeps a manual starting value on a level goal, bar and all", async () => {
    const manual = orphaned({
      targets: [
        target({
          metric: 'costPerTask',
          targetValue: PER_EVENT_TARGET,
          baselineValue: MATTER_SIZED_PER_EVENT_BASELINE,
          baselineSource: 'manual',
        }),
      ],
    })

    const view = await mod.buildInitiativeView(manual, ORG, NOW)

    expect(view.targets[0].baseline).toBe(MATTER_SIZED_PER_EVENT_BASELINE)
    // Baseline-relative, not the no-baseline gauge a dropped baseline gives.
    expect(view.targets[0].progressPct).toBeCloseTo(
      ((MATTER_SIZED_PER_EVENT_BASELINE - ORG_WIDE_PER_EVENT) /
        (MATTER_SIZED_PER_EVENT_BASELINE - PER_EVENT_TARGET)) *
        100,
      6
    )
  })

  it('leaves a no-source starting value alone (read as manual)', async () => {
    const legacy = orphaned({
      targets: [target({ baselineSource: null })],
    })

    const view = await mod.buildInitiativeView(legacy, ORG, NOW)

    expect(view.targets[0].baseline).toBe(MATTER_SIZED_BASELINE)
  })
})

describe('buildInitiativeView — a live scope is untouched', () => {
  it('a still-scoped initiative keeps its auto starting value', async () => {
    const scoped = initiative({
      matterId: MATTER_ID,
      matterNumber: MATTER_NUMBER,
      scopedMatterNumber: MATTER_NUMBER,
    })

    const view = await mod.buildInitiativeView(scoped, ORG, NOW)

    expect(getMatterCostRollupsMock).toHaveBeenCalled()
    expect(getCostBreakdownMock).not.toHaveBeenCalled()
    expect(view.targets[0].actual).toBe(900)
    expect(view.targets[0].baseline).toBe(MATTER_SIZED_BASELINE)
  })

  it('an initiative that was never scoped keeps its auto starting value', async () => {
    const view = await mod.buildInitiativeView(initiative(), ORG, NOW)

    expect(view.targets[0].actual).toBe(ORG_WIDE.cost)
    expect(view.targets[0].baseline).toBe(MATTER_SIZED_BASELINE)
  })
})

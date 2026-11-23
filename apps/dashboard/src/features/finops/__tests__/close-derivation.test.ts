/**
 * deriveCloseStatus, the core of the close page. Pure
 * function, hand-built CloseStatusFacts fixtures, no DB. Each case pins the
 * exact expected output: the step done-conditions, the
 * first-not-done-is-active status rule, null (not zero) tile values, the
 * close-window convention daysToClose arithmetic, and the alert composer.
 */

import { deriveCloseStatus } from '../close-derivation'
import type { CloseStatusFacts } from '@/app/actions/finops-close-status'
import type { JournalExport } from '@/app/actions/journal-export'
import type { PeriodLockStatus } from '@/app/actions/finance-period-lock'

const JUNE_START = '2026-06-01T00:00:00.000Z'
const JUNE_END = '2026-06-30T23:59:59.999Z'

function lock(overrides: Partial<PeriodLockStatus> = {}): PeriodLockStatus {
  return {
    locked: false,
    lockedAt: null,
    lockedByUserId: null,
    lockedByName: null,
    periodLabel: null,
    closable: false,
    ...overrides,
  }
}

function journal(overrides: Partial<JournalExport> = {}): JournalExport {
  return {
    periodStart: JUNE_START,
    periodEnd: JUNE_END,
    periodLabel: '2026-06-01 → 2026-06-30',
    rows: [],
    totalAmount: 4539,
    unmappedAmount: 0,
    hasUnmapped: false,
    unmappedSignalCount: 0,
    ...overrides,
  }
}

function facts(overrides: Partial<CloseStatusFacts> = {}): CloseStatusFacts {
  return {
    monthLabel: 'June 2026',
    totalCost: 4539,
    eventCount: 240313,
    unclassifiedCost: 0,
    unmappedAmount: 0,
    unmappedSignalCount: 0,
    classifiedShare: 1,
    mismatchedSignalCount: 0,
    lock: lock(),
    journal: journal(),
    ...overrides,
  }
}

const statusesOf = (derived: ReturnType<typeof deriveCloseStatus>) =>
  derived.steps.map((step) => step.status)

// ── (a) seed-shaped month: in progress, everything still open ──────────────

describe('(a) seed-shaped month — events flowing, 14 unmapped, unclassified $, 2 mismatches, month not over', () => {
  const seedFacts = facts({
    unmappedAmount: 370,
    unmappedSignalCount: 14,
    unclassifiedCost: 620,
    classifiedShare: 0.884,
    mismatchedSignalCount: 2,
    lock: lock({ closable: false }),
  })
  const derived = deriveCloseStatus(
    seedFacts,
    new Date('2026-06-15T12:00:00.000Z')
  )

  it('steps = [done, active, todo, todo, todo]', () => {
    expect(statusesOf(derived)).toEqual([
      'done',
      'active',
      'todo',
      'todo',
      'todo',
    ])
  })

  it("step 2 (active) detail is the signal count — '14 left'", () => {
    expect(derived.steps[1].detail).toBe('14 left')
  })

  it('closeProgress === 20 (1 of 5 steps)', () => {
    expect(derived.tiles.closeProgress).toBe(20)
  })

  it('unmappedCount === 14', () => {
    expect(derived.tiles.unmappedCount).toBe(14)
  })

  it('categorizedPct is classifiedShare × 100 exactly', () => {
    expect(derived.tiles.categorizedPct).toBe(0.884 * 100)
  })

  it('daysToClose === null (month has not ended)', () => {
    expect(derived.tiles.daysToClose).toBeNull()
  })

  it("subtitle ends '1 of 5 steps done'", () => {
    expect(derived.subtitle).toBe('June 2026 · 1 of 5 steps done')
  })

  it("closeProgress subtext reads '1 of 5 steps done'", () => {
    expect(derived.subtexts.closeProgress).toBe('1 of 5 steps done')
  })

  it("categorizedPct subtext names the month's AI cost, not GL cost", () => {
    expect(derived.subtexts.categorizedPct).toBe('of June 2026 AI cost')
  })
})

// ── (b) month ended, clean, ready to close ─────────────────────────────────

describe('(b) month ended, everything clean, closable, now = 3rd of following month', () => {
  const derived = deriveCloseStatus(
    facts({ lock: lock({ closable: true }) }),
    new Date('2026-07-03T00:00:00.000Z')
  )

  it("steps 1-4 done, step 5 active ('Ready to close')", () => {
    expect(statusesOf(derived)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'active',
    ])
    expect(derived.steps[4].detail).toBe('Ready to close')
  })

  it('closeProgress === 80', () => {
    expect(derived.tiles.closeProgress).toBe(80)
  })

  it('daysToClose === 2 (deadline = 5th calendar day after month end — the close-window convention, pinned)', () => {
    expect(derived.tiles.daysToClose).toBe(2)
  })

  it("subtitle reads 'day 3 of close' inside the close window", () => {
    expect(derived.subtitle).toBe('June 2026 · day 3 of close')
  })
})

// ── (c) locked month with a lingering mismatch ─────────────────────────────

describe('(c) locked month with mismatched = 1', () => {
  const derived = deriveCloseStatus(
    facts({
      mismatchedSignalCount: 1,
      lock: lock({
        locked: true,
        closable: true,
        lockedAt: '2026-07-02T09:00:00.000Z',
        periodLabel: 'June 2026',
      }),
    }),
    new Date('2026-07-10T00:00:00.000Z')
  )

  it('step 5 done, step 4 active — locked does not vacuously complete earlier steps', () => {
    expect(statusesOf(derived)).toEqual([
      'done',
      'done',
      'done',
      'active',
      'done',
    ])
  })

  it('closeProgress === 80 (locked ≠ 100 — honesty)', () => {
    expect(derived.tiles.closeProgress).toBe(80)
  })

  it('daysToClose === null once locked', () => {
    expect(derived.tiles.daysToClose).toBeNull()
  })

  it("subtitle ends '· closed'", () => {
    expect(derived.subtitle).toBe('June 2026 · closed')
  })

  it('emits the singular wrong-account-type alert', () => {
    expect(derived.alerts).toEqual([
      {
        severity: 'amber',
        text: '1 signal booked to the wrong account type',
        href: '/finops?tab=settings',
      },
    ])
  })
})

// ── (d) zero-cost month ────────────────────────────────────────────────────

describe('(d) zero-cost month', () => {
  const derived = deriveCloseStatus(
    facts({
      eventCount: 0,
      totalCost: 0,
      classifiedShare: null,
      journal: journal({ totalAmount: 0 }),
    }),
    new Date('2026-06-15T12:00:00.000Z')
  )

  it("step 1 active ('No usage yet'), steps 2-4 vacuously done, step 5 todo", () => {
    expect(statusesOf(derived)).toEqual([
      'active',
      'done',
      'done',
      'done',
      'todo',
    ])
    expect(derived.steps[0].detail).toBe('No usage yet')
  })

  it('categorizedPct === null (canon M1 inherit — not 0)', () => {
    expect(derived.tiles.categorizedPct).toBeNull()
  })

  it('alert list is empty', () => {
    expect(derived.alerts).toEqual([])
  })
})

// ── (e) frozen snapshot without unmappedSignalCount ────────────────────────

describe('(e) snapshot without unmappedSignalCount: count null, unmapped dollars nonzero', () => {
  // Built WITHOUT unmappedSignalCount and typed as JournalExport, proving
  // that snapshot shape compiles and flows through to a null tile.
  const frozenJournal: JournalExport = {
    periodStart: JUNE_START,
    periodEnd: JUNE_END,
    periodLabel: '2026-06-01 → 2026-06-30',
    rows: [],
    totalAmount: 4539,
    unmappedAmount: 370,
    hasUnmapped: true,
  }
  const derived = deriveCloseStatus(
    facts({
      unmappedAmount: 370,
      unmappedSignalCount: frozenJournal.unmappedSignalCount ?? null,
      journal: frozenJournal,
    }),
    new Date('2026-06-15T12:00:00.000Z')
  )

  it("unmappedCount === null (renders '—', never 0)", () => {
    expect(derived.tiles.unmappedCount).toBeNull()
  })

  it('step-2 detail falls back to the dollar string', () => {
    expect(derived.steps[1].detail).toBe('$370.00 left')
  })
})

// ── (f) status rule holds across every fixture ─────────────────────────────

describe('(f) status rule — exactly one active unless all done; done keeps done regardless of position', () => {
  const allDone = facts({
    lock: lock({ locked: true, closable: true, periodLabel: 'June 2026' }),
  })
  const fixtures: Array<[string, CloseStatusFacts, Date]> = [
    [
      'seed-shaped',
      facts({
        unmappedAmount: 370,
        unmappedSignalCount: 14,
        unclassifiedCost: 620,
        classifiedShare: 0.884,
        mismatchedSignalCount: 2,
      }),
      new Date('2026-06-15T12:00:00.000Z'),
    ],
    [
      'ready to close',
      facts({ lock: lock({ closable: true }) }),
      new Date('2026-07-03T00:00:00.000Z'),
    ],
    [
      'locked w/ mismatch',
      facts({
        mismatchedSignalCount: 1,
        lock: lock({ locked: true, closable: true }),
      }),
      new Date('2026-07-10T00:00:00.000Z'),
    ],
    [
      'zero-cost',
      facts({ eventCount: 0, totalCost: 0, classifiedShare: null }),
      new Date('2026-06-15T12:00:00.000Z'),
    ],
    ['all done', allDone, new Date('2026-07-10T00:00:00.000Z')],
  ]

  it.each(fixtures)('%s', (_name, fixture, now) => {
    const derived = deriveCloseStatus(fixture, now)
    const statuses = statusesOf(derived)
    const activeCount = statuses.filter((s) => s === 'active').length
    const allStepsDone = statuses.every((s) => s === 'done')
    if (allStepsDone) {
      expect(activeCount).toBe(0)
    } else {
      expect(activeCount).toBe(1)
      // Every done step keeps 'done'; every not-done step after the first
      // not-done is 'todo'.
      const firstNotDone = statuses.findIndex((s) => s !== 'done')
      expect(statuses[firstNotDone]).toBe('active')
      statuses.slice(firstNotDone + 1).forEach((status) => {
        expect(['done', 'todo']).toContain(status)
      })
    }
  })

  it('the all-done fixture really is all done (guards the loop above)', () => {
    expect(statusesOf(deriveCloseStatus(allDone, new Date()))).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
    ])
  })
})

// ── (g) alert composer ─────────────────────────────────────────────────────

describe('(g) alert composer', () => {
  it("mismatched 1 → singular '1 signal booked to the wrong account type', href /finops?tab=settings", () => {
    const derived = deriveCloseStatus(
      facts({ mismatchedSignalCount: 1 }),
      new Date('2026-06-15T12:00:00.000Z')
    )
    expect(derived.alerts).toEqual([
      {
        severity: 'amber',
        text: '1 signal booked to the wrong account type',
        href: '/finops?tab=settings',
      },
    ])
  })

  it('mismatched 3 → plural text', () => {
    const derived = deriveCloseStatus(
      facts({ mismatchedSignalCount: 3 }),
      new Date('2026-06-15T12:00:00.000Z')
    )
    expect(derived.alerts[0].text).toBe(
      '3 signals booked to the wrong account type'
    )
  })

  it('mismatched 0 → []', () => {
    const derived = deriveCloseStatus(
      facts({ mismatchedSignalCount: 0 }),
      new Date('2026-06-15T12:00:00.000Z')
    )
    expect(derived.alerts).toEqual([])
  })

  it('never emits any other item kind — even with every other problem present', () => {
    const derived = deriveCloseStatus(
      facts({
        eventCount: 0,
        unmappedAmount: 370,
        unmappedSignalCount: 14,
        unclassifiedCost: 620,
        classifiedShare: null,
        mismatchedSignalCount: 0,
      }),
      new Date('2026-06-15T12:00:00.000Z')
    )
    expect(derived.alerts).toEqual([])
  })
})

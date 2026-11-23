/**
 * THE SCORING TABLE, pure. Hand-built
 * MfiqFacts fixtures against exact expected outputs: every rule's
 * Pass/Review/Fail/No-data branch, the Σ=10 pin, the weight-change tripwire,
 * unknown propagation (canon M2 — a null fact NEVER renders as Pass),
 * window-honest copy, fix ordering/arithmetic, recommendations, and the
 * needs-attention href overrides.
 */

import { deriveIqScore, IQ_RULE_POINTS, type IqRuleId } from '../iq-derivation'
import type { MfiqFacts } from '@/app/actions/mfiq-status'
import { formatCost } from '@/lib/canon-format'
import {
  mismatchedSignalsItem,
  costBackfillItem,
  missingVolumeItem,
  creditPoolItem,
} from '@/features/dashboard-shell/needs-attention'

// The ?tab= contract, shared with the needs-attention page.
const CREDIT_POOL_HREF = '/metrics-events/needs-attention?tab=credit-pools'

const TABLE_ORDER: IqRuleId[] = [
  'eventsCosted',
  'glMapped',
  'categorized',
  'accountTypes',
  'closeSignedOff',
  'agentsProfitable',
]

// Mid-July: well past June's close deadline (July 5 + 1 day), so an unlocked
// June is a FAIL unless a test moves `now` back inside the window.
const NOW = new Date('2026-07-15T12:00:00.000Z')

type AgentRow = NonNullable<MfiqFacts['agents']>['rows'][number]

function agentRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    agentId: 'agent-1',
    name: 'Ops Agent',
    isActive: true,
    cost: 200,
    earned: 500,
    marginPercent: 60,
    ...overrides,
  }
}

function cleanFacts(): MfiqFacts {
  return {
    books: {
      monthLabel: 'July 2026',
      eventCount: 1200,
      unmappedAmount: 0,
      unmappedSignalCount: 0,
      unclassifiedCost: 0,
      classifiedShare: 1,
      mismatchedSignalCount: 0,
    },
    prevMonth: {
      monthLabel: 'June 2026',
      periodEndIso: '2026-06-30T23:59:59.999Z',
      locked: true,
      closable: true,
    },
    agents: {
      windowLabel: 'Last 30 days',
      rows: [agentRow()],
      pausedCount: 0,
    },
    backfillEvents: 0,
    backfillModels: 0,
    missingVolumeEvents: 0,
    missingVolumeModels: 0,
    lowCreditPools: 0,
    generatedAt: NOW.toISOString(),
  }
}

// The dirty org: every rule broken at once.
function dirtyFacts(): MfiqFacts {
  const facts = cleanFacts()
  facts.books = {
    ...facts.books!,
    unmappedAmount: 370,
    unmappedSignalCount: 14,
    unclassifiedCost: 120,
    classifiedShare: 0.62,
    mismatchedSignalCount: 2,
  }
  facts.prevMonth = { ...facts.prevMonth!, locked: false }
  facts.agents = {
    ...facts.agents!,
    rows: [agentRow({ earned: 410, cost: 620, marginPercent: -51.2 })],
  }
  facts.backfillEvents = 38
  facts.backfillModels = 2
  facts.missingVolumeEvents = 0
  facts.missingVolumeModels = 0
  facts.lowCreditPools = 0
  return facts
}

function statusOf(derived: ReturnType<typeof deriveIqScore>, id: IqRuleId) {
  return derived.rules.find((rule) => rule.id === id)!.status
}

describe('invariants — the pinned table is the contract', () => {
  it('Σ IQ_RULE_POINTS === 10', () => {
    const total = Object.values(IQ_RULE_POINTS).reduce((sum, p) => sum + p, 0)
    expect(total).toBe(10)
  })

  it('weight-change tripwire — the exact 2/2/2/1/2/1 weights (a retune MUST break this test)', () => {
    expect(IQ_RULE_POINTS).toEqual({
      eventsCosted: 2,
      glMapped: 2,
      categorized: 2,
      accountTypes: 1,
      closeSignedOff: 2,
      agentsProfitable: 1,
    })
  })

  it.each([
    ['all-clean', cleanFacts()],
    ['dirty', dirtyFacts()],
    [
      'all-null',
      {
        books: null,
        prevMonth: null,
        agents: null,
        backfillEvents: null,
        missingVolumeEvents: null,
        generatedAt: NOW.toISOString(),
      } as MfiqFacts,
    ],
  ])(
    'rules array is always all 6 in table order (%s facts)',
    (_name, facts) => {
      const derived = deriveIqScore(facts, NOW)
      expect(derived.rules.map((rule) => rule.id)).toEqual(TABLE_ORDER)
      expect(derived.maxScore).toBe(10)
    }
  )

  it('every rule carries its pinned weight as points, pass or fail', () => {
    for (const derived of [
      deriveIqScore(cleanFacts(), NOW),
      deriveIqScore(dirtyFacts(), NOW),
    ]) {
      for (const rule of derived.rules) {
        expect(rule.points).toBe(IQ_RULE_POINTS[rule.id])
      }
    }
  })
})

describe('all-clean org', () => {
  it('every rule pass, score 10, nothing to fix or flag, subtitle "All rules passing"', () => {
    const derived = deriveIqScore(cleanFacts(), NOW)
    expect(derived.rules.map((rule) => rule.status)).toEqual([
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
    ])
    expect(derived.score).toBe(10)
    expect(derived.fixes).toEqual([])
    expect(derived.recommendations).toEqual([])
    expect(derived.needsAttention).toEqual([])
    expect(derived.subtitle).toBe('All rules passing')
    expect(derived.unknownCount).toBe(0)
  })
})

describe('dirty org — every rule fails, the arithmetic is exact', () => {
  const derived = deriveIqScore(dirtyFacts(), NOW)

  it('all six rules fail ⇒ score === 10 − (2+2+2+1+2+1) === 0', () => {
    expect(derived.rules.map((rule) => rule.status)).toEqual([
      'fail',
      'fail',
      'fail',
      'fail',
      'fail',
      'fail',
    ])
    expect(derived.score).toBe(0)
  })

  it('fixes ordered points DESC then table order: R1, R2, R3, R5, R4, R6', () => {
    expect(derived.fixes).toEqual([
      { label: 'Backfill costs for 38 events', points: 2, href: '/build' },
      { label: 'Map 14 unmapped signals', points: 2, href: '/finops' },
      {
        label: `Categorize ${formatCost(120)} of cost`,
        points: 2,
        href: '/finops',
      },
      { label: 'Sign off the June 2026 close', points: 2, href: '/finops' },
      { label: 'Fix 2 account-type mismatches', points: 1, href: '/finops' },
      { label: 'Reprice Ops Agent', points: 1, href: '/build' },
    ])
  })

  it('score + Σ fixes.points === 10 (the gauge "fixes to reach" arithmetic always displays 10)', () => {
    const fixPoints = derived.fixes.reduce((sum, fix) => sum + fix.points, 0)
    expect(derived.score! + fixPoints).toBe(10)
  })

  it('subtitle counts the fixes', () => {
    expect(derived.subtitle).toBe('6 fixes available')
  })
})

describe('R1 eventsCosted — both queues, combined count', () => {
  it('missing-volume events alone fail R1 and join the fix count', () => {
    const facts = cleanFacts()
    facts.backfillEvents = 3
    facts.missingVolumeEvents = 2
    const derived = deriveIqScore(facts, NOW)
    expect(statusOf(derived, 'eventsCosted')).toBe('fail')
    expect(derived.fixes).toEqual([
      { label: 'Backfill costs for 5 events', points: 2, href: '/build' },
    ])
    expect(derived.score).toBe(8)
  })

  it('singular grammar at exactly 1 uncosted event', () => {
    const facts = cleanFacts()
    facts.backfillEvents = 1
    const derived = deriveIqScore(facts, NOW)
    expect(derived.fixes[0].label).toBe('Backfill costs for 1 event')
    expect(derived.subtitle).toBe('1 fix available')
  })
})

describe('R2 glMapped — count-first fix label, dollar fallback on frozen snapshots', () => {
  it('singular signal count', () => {
    const facts = cleanFacts()
    facts.books = {
      ...facts.books!,
      unmappedAmount: 12,
      unmappedSignalCount: 1,
    }
    const derived = deriveIqScore(facts, NOW)
    expect(statusOf(derived, 'glMapped')).toBe('fail')
    expect(derived.fixes[0]).toEqual({
      label: 'Map 1 unmapped signal',
      points: 2,
      href: '/finops',
    })
  })

  it('null unmappedSignalCount (old frozen snapshot) falls back to the canon-format dollar label', () => {
    const facts = cleanFacts()
    facts.books = {
      ...facts.books!,
      unmappedAmount: 370,
      unmappedSignalCount: null,
    }
    const derived = deriveIqScore(facts, NOW)
    expect(statusOf(derived, 'glMapped')).toBe('fail')
    expect(derived.fixes[0].label).toBe(
      `Map ${formatCost(370)} of unmapped cost`
    )
  })
})

describe('R4 accountTypes — singular grammar', () => {
  it('1 mismatch reads "Fix 1 account-type mismatch"', () => {
    const facts = cleanFacts()
    facts.books = { ...facts.books!, mismatchedSignalCount: 1 }
    const derived = deriveIqScore(facts, NOW)
    expect(derived.fixes[0]).toEqual({
      label: 'Fix 1 account-type mismatch',
      points: 1,
      href: '/finops',
    })
  })
})

describe('R5 closeSignedOff — the shared closeDeadline convention', () => {
  function unlockedPrevMonth(): MfiqFacts {
    const facts = cleanFacts()
    facts.prevMonth = { ...facts.prevMonth!, locked: false }
    return facts
  }

  it('unlocked + inside the close window (the 3rd) ⇒ review: NO points lost, NO fix row', () => {
    const derived = deriveIqScore(
      unlockedPrevMonth(),
      new Date('2026-07-03T12:00:00.000Z')
    )
    expect(statusOf(derived, 'closeSignedOff')).toBe('review')
    expect(derived.score).toBe(10)
    expect(derived.fixes).toEqual([])
  })

  it('same facts on the 10th ⇒ fail (−2) with the sign-off fix', () => {
    const derived = deriveIqScore(
      unlockedPrevMonth(),
      new Date('2026-07-10T12:00:00.000Z')
    )
    expect(statusOf(derived, 'closeSignedOff')).toBe('fail')
    expect(derived.score).toBe(8)
    expect(derived.fixes).toEqual([
      { label: 'Sign off the June 2026 close', points: 2, href: '/finops' },
    ])
  })

  it('the boundary is closeDeadline + 1 day (July 6 00:00 UTC for a June period)', () => {
    // CLOSE_WINDOW_DAYS = 5: deadline floors to July 5 00:00 UTC; the review
    // window survives through July 5 and dies at July 6 00:00 exactly. If
    // anyone forks the closeDeadline arithmetic, this pins the seam.
    const lastReviewInstant = deriveIqScore(
      unlockedPrevMonth(),
      new Date('2026-07-05T23:59:59.999Z')
    )
    expect(statusOf(lastReviewInstant, 'closeSignedOff')).toBe('review')
    const firstFailInstant = deriveIqScore(
      unlockedPrevMonth(),
      new Date('2026-07-06T00:00:00.000Z')
    )
    expect(statusOf(firstFailInstant, 'closeSignedOff')).toBe('fail')
  })
})

describe('R6 agentsProfitable nuances', () => {
  it('one negative-margin live agent ⇒ fail, fix names the agent', () => {
    const facts = cleanFacts()
    facts.agents!.rows = [
      agentRow({
        name: 'Ops Agent',
        earned: 410,
        cost: 620,
        marginPercent: -51.2,
      }),
    ]
    const derived = deriveIqScore(facts, NOW)
    expect(statusOf(derived, 'agentsProfitable')).toBe('fail')
    expect(derived.fixes).toEqual([
      { label: 'Reprice Ops Agent', points: 1, href: '/build' },
    ])
  })

  it('two negative-margin live agents ⇒ plural count label', () => {
    const facts = cleanFacts()
    facts.agents!.rows = [
      agentRow({
        agentId: 'a1',
        name: 'Ops Agent',
        earned: 410,
        cost: 620,
        marginPercent: -51.2,
      }),
      agentRow({
        agentId: 'a2',
        name: 'Support Agent',
        earned: 100,
        cost: 150,
        marginPercent: -50,
      }),
    ]
    const derived = deriveIqScore(facts, NOW)
    expect(derived.fixes).toEqual([
      {
        label: 'Reprice 2 agents earning less than they cost',
        points: 1,
        href: '/build',
      },
    ])
  })

  it('cost-but-no-earnings rows only ⇒ review (advisory: no points lost, no fix)', () => {
    const facts = cleanFacts()
    facts.agents!.rows = [
      agentRow({ earned: 0, cost: 50, marginPercent: null }),
    ]
    const derived = deriveIqScore(facts, NOW)
    expect(statusOf(derived, 'agentsProfitable')).toBe('review')
    expect(derived.score).toBe(10)
    expect(derived.fixes).toEqual([])
  })

  it('a zero-activity row (cost 0, earned 0, margin null) triggers neither ⇒ pass', () => {
    const facts = cleanFacts()
    facts.agents!.rows = [agentRow({ earned: 0, cost: 0, marginPercent: null })]
    const derived = deriveIqScore(facts, NOW)
    expect(statusOf(derived, 'agentsProfitable')).toBe('pass')
  })

  it('the agentId-null Deleted-agents catch-all is IGNORED even at negative margin (not repriceable)', () => {
    const facts = cleanFacts()
    facts.agents!.rows = [
      agentRow({
        agentId: null,
        name: 'Deleted agents',
        isActive: null,
        earned: 410,
        cost: 620,
        marginPercent: -51.2,
      }),
    ]
    const derived = deriveIqScore(facts, NOW)
    expect(statusOf(derived, 'agentsProfitable')).toBe('pass')
    expect(derived.fixes).toEqual([])
  })
})

describe('unknown propagation — the M2 contract', () => {
  it('backfillEvents null ⇒ R1 unknown, score null, unknownCount 1, no R1 fix, other rules keep real statuses', () => {
    const facts = cleanFacts()
    facts.backfillEvents = null
    const derived = deriveIqScore(facts, NOW)
    expect(statusOf(derived, 'eventsCosted')).toBe('unknown')
    expect(derived.score).toBeNull()
    expect(derived.unknownCount).toBe(1)
    expect(derived.fixes).toEqual([])
    for (const id of TABLE_ORDER.filter((r) => r !== 'eventsCosted')) {
      expect(statusOf(derived, id)).toBe('pass')
    }
  })

  it('missingVolumeEvents null alone also makes R1 unknown (either queue counts)', () => {
    const facts = cleanFacts()
    facts.missingVolumeEvents = null
    expect(statusOf(deriveIqScore(facts, NOW), 'eventsCosted')).toBe('unknown')
  })

  it('books null ⇒ R2+R3+R4 all unknown, score null, unknownCount 3', () => {
    const facts = cleanFacts()
    facts.books = null
    const derived = deriveIqScore(facts, NOW)
    expect(statusOf(derived, 'glMapped')).toBe('unknown')
    expect(statusOf(derived, 'categorized')).toBe('unknown')
    expect(statusOf(derived, 'accountTypes')).toBe('unknown')
    expect(derived.score).toBeNull()
    expect(derived.unknownCount).toBe(3)
  })

  it('prevMonth null ⇒ R5 unknown; agents null ⇒ R6 unknown', () => {
    const noPrev = cleanFacts()
    noPrev.prevMonth = null
    expect(statusOf(deriveIqScore(noPrev, NOW), 'closeSignedOff')).toBe(
      'unknown'
    )
    const noAgents = cleanFacts()
    noAgents.agents = null
    expect(statusOf(deriveIqScore(noAgents, NOW), 'agentsProfitable')).toBe(
      'unknown'
    )
  })

  it('a failing domain stays failing while another is unknown — OTHER rules unaffected, fixes still honest', () => {
    const facts = dirtyFacts()
    facts.backfillEvents = null
    const derived = deriveIqScore(facts, NOW)
    expect(statusOf(derived, 'eventsCosted')).toBe('unknown')
    expect(statusOf(derived, 'glMapped')).toBe('fail')
    expect(derived.score).toBeNull()
    // R1's fix is gone; the five other fails still emit theirs.
    expect(derived.fixes.map((fix) => fix.label)).toEqual([
      'Map 14 unmapped signals',
      `Categorize ${formatCost(120)} of cost`,
      'Sign off the June 2026 close',
      'Fix 2 account-type mismatches',
      'Reprice Ops Agent',
    ])
  })

  it('NO null-fact rule ever renders as pass (never a fake Pass)', () => {
    const nullings: Array<[Partial<MfiqFacts>, IqRuleId[]]> = [
      [{ backfillEvents: null }, ['eventsCosted']],
      [{ missingVolumeEvents: null }, ['eventsCosted']],
      [{ books: null }, ['glMapped', 'categorized', 'accountTypes']],
      [{ prevMonth: null }, ['closeSignedOff']],
      [{ agents: null }, ['agentsProfitable']],
    ]
    for (const [overrides, affected] of nullings) {
      const derived = deriveIqScore({ ...cleanFacts(), ...overrides }, NOW)
      for (const id of affected) {
        expect(statusOf(derived, id)).not.toBe('pass')
        expect(statusOf(derived, id)).toBe('unknown')
      }
    }
  })

  it('all five sources null ⇒ all six rules unknown, score null, subtitle undefined', () => {
    const derived = deriveIqScore(
      {
        books: null,
        prevMonth: null,
        agents: null,
        backfillEvents: null,
        missingVolumeEvents: null,
        generatedAt: NOW.toISOString(),
      },
      NOW
    )
    expect(derived.rules.every((rule) => rule.status === 'unknown')).toBe(true)
    expect(derived.score).toBeNull()
    expect(derived.unknownCount).toBe(6)
    expect(derived.subtitle).toBeUndefined()
  })
})

describe('window honesty in copy', () => {
  const derived = deriveIqScore(dirtyFacts(), NOW)
  const textOf = (id: IqRuleId) =>
    derived.rules.find((rule) => rule.id === id)!.text

  it('R2/R3 name the current month', () => {
    expect(textOf('glMapped')).toContain('July 2026')
    expect(textOf('categorized')).toContain('July 2026')
  })

  it('R5 names the previous month', () => {
    expect(textOf('closeSignedOff')).toContain('June 2026')
  })

  it('R6 names the rolling window', () => {
    expect(textOf('agentsProfitable')).toContain('Last 30 days')
  })

  it('R1/R4 are current-state — no month or window string, and never a bare "this week"', () => {
    for (const id of ['eventsCosted', 'accountTypes'] as const) {
      expect(textOf(id)).not.toMatch(/July 2026|June 2026|Last 30 days/)
      expect(textOf(id)).not.toMatch(/this week|this window/i)
    }
  })
})

describe('recommendations — derived, never fabricated; no week-over-week spike rec', () => {
  it('mismatched 2 + unmapped $370 ⇒ exactly the two items, pinned text/severity/href', () => {
    const derived = deriveIqScore(dirtyFacts(), NOW)
    expect(derived.recommendations).toEqual([
      {
        severity: 'amber',
        text: '2 signals booked to the wrong account type put real cost on the wrong side of the gross-margin line.',
        href: '/finops',
      },
      {
        severity: 'amber',
        text: `${formatCost(370)} of July 2026 cost is sitting in the Unmapped clearing bucket with no GL code.`,
        href: '/finops',
      },
    ])
  })

  it('singular mismatch keeps subject-verb agreement ("1 signal … puts")', () => {
    const facts = cleanFacts()
    facts.books = { ...facts.books!, mismatchedSignalCount: 1 }
    const derived = deriveIqScore(facts, NOW)
    expect(derived.recommendations[0].text).toBe(
      '1 signal booked to the wrong account type puts real cost on the wrong side of the gross-margin line.'
    )
  })

  it('clean books ⇒ [] (the tile leans on its empty state)', () => {
    expect(deriveIqScore(cleanFacts(), NOW).recommendations).toEqual([])
  })

  it('no week-over-week spike copy anywhere', () => {
    const allText = deriveIqScore(dirtyFacts(), NOW)
      .recommendations.map((item) => item.text)
      .join(' ')
    expect(allText).not.toMatch(/this week|vs last|spike|up \d/i)
  })
})

describe('needs-attention — shared-builder copy, owning-page hrefs', () => {
  it('each count > 0 emits its item at its owning-page href, in order', () => {
    const facts = dirtyFacts()
    facts.missingVolumeEvents = 5
    facts.missingVolumeModels = 1
    facts.lowCreditPools = 3
    const derived = deriveIqScore(facts, NOW)
    expect(derived.needsAttention).toEqual([
      { ...mismatchedSignalsItem(2), href: '/finops' },
      { ...costBackfillItem(2, 38), href: '/build' },
      { ...missingVolumeItem(1, 5), href: '/build' },
      { ...creditPoolItem(3), href: CREDIT_POOL_HREF },
    ])
  })

  // Pinned against the LITERAL, not only the builder: no MF IQ
  // source line spells this href, so the builder is the only thing
  // standing between the contract and a silent redirect.
  it('the credit-pool row deep-links to the tab, inherited rather than overridden', () => {
    const facts = dirtyFacts()
    facts.lowCreditPools = 3
    const row = deriveIqScore(facts, NOW).needsAttention.find(
      (item) => item.text === creditPoolItem(3).text
    )
    expect(row?.href).toBe('/metrics-events/needs-attention?tab=credit-pools')
    expect(row?.href).toBe(creditPoolItem(3).href)
  })

  it('text equals the shared builders VERBATIM — the spread-override never forks copy', () => {
    const facts = dirtyFacts()
    facts.missingVolumeEvents = 5
    facts.missingVolumeModels = 1
    facts.lowCreditPools = 3
    const derived = deriveIqScore(facts, NOW)
    expect(derived.needsAttention[0].text).toBe(mismatchedSignalsItem(2).text)
    expect(derived.needsAttention[1].text).toBe(costBackfillItem(2, 38).text)
    expect(derived.needsAttention[2].text).toBe(missingVolumeItem(1, 5).text)
    expect(derived.needsAttention[3].text).toBe(creditPoolItem(3).text)
  })

  it('zero counts ⇒ [] (empty state, Money precedent)', () => {
    expect(deriveIqScore(cleanFacts(), NOW).needsAttention).toEqual([])
  })

  it('a null count contributes no item (unknown ≠ zero, but also ≠ an alert)', () => {
    const facts = cleanFacts()
    facts.backfillEvents = null
    facts.missingVolumeEvents = null
    facts.lowCreditPools = null
    expect(deriveIqScore(facts, NOW).needsAttention).toEqual([])
  })
})

// Nothing gates when a pool empties, so a drained pool is not a
// books problem: it may add a row and must never cost a hygiene point.
describe('credit pools in needs-attention', () => {
  it('a low pool count emits the shared row deep-linked to the credit-pool tab', () => {
    const facts = cleanFacts()
    facts.lowCreditPools = 2
    const derived = deriveIqScore(facts, NOW)
    expect(derived.needsAttention).toEqual([
      {
        severity: 'amber',
        text: '2 credit pools are running low',
        href: CREDIT_POOL_HREF,
      },
    ])
  })

  it('one pool keeps subject-verb agreement, straight from the shared builder', () => {
    const facts = cleanFacts()
    facts.lowCreditPools = 1
    expect(deriveIqScore(facts, NOW).needsAttention[0].text).toBe(
      '1 credit pool is running low'
    )
  })

  it('a failed credit-pool read (null) is not an alert, and an absent field behaves the same', () => {
    const nulled = cleanFacts()
    nulled.lowCreditPools = null
    expect(deriveIqScore(nulled, NOW).needsAttention).toEqual([])

    const absent = cleanFacts()
    delete absent.lowCreditPools
    expect(deriveIqScore(absent, NOW).needsAttention).toEqual([])
  })

  it('pools never touch the score, the rules, or the fixes', () => {
    const clean = deriveIqScore(cleanFacts(), NOW)
    const drained = cleanFacts()
    drained.lowCreditPools = 9
    const derived = deriveIqScore(drained, NOW)
    expect(derived.score).toBe(clean.score)
    expect(derived.rules).toEqual(clean.rules)
    expect(derived.fixes).toEqual(clean.fixes)
    expect(derived.recommendations).toEqual(clean.recommendations)
  })
})

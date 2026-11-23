/**
 * WHAT THIS FILE DOES: Exercises every branch of the backfill
 *   outcome classifier — the pure function that decides whether the Map
 *   Model and Fill Volume dialogs' result panels earn green or render an
 *   amber warning. Also pins (via source assertion) that both dialogs
 *   actually call the classifier and gate their green copy on it, since the
 *   node-only jest harness can't render the dialogs themselves.
 * WHY IT EXISTS: a panel must not show green "all matching events are now
 *   priced" on a zero-match run. These tests pin the honesty rules.
 * CONNECTS TO: ../classify-backfill-outcome.ts (the classifier),
 *   ../../components/MapModelDialog.tsx and
 *   ../../components/FillVolumeDialog.tsx (the panels that render outcomes).
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { classifyBackfillOutcome } from '../classify-backfill-outcome'

describe('classifyBackfillOutcome', () => {
  it('returns zero_match when nothing matched, regardless of rates', () => {
    expect(
      classifyBackfillOutcome({
        backfilled: 0,
        totalCostUsd: 0,
        targetHasPaidRates: true,
      })
    ).toBe('zero_match')
    expect(
      classifyBackfillOutcome({
        backfilled: 0,
        totalCostUsd: 0,
        targetHasPaidRates: false,
      })
    ).toBe('zero_match')
  })

  it('returns zero_cost when events matched but priced $0.00 against a paid rate', () => {
    expect(
      classifyBackfillOutcome({
        backfilled: 200,
        totalCostUsd: 0,
        targetHasPaidRates: true,
      })
    ).toBe('zero_cost')
  })

  it('returns success when events matched and real cost landed', () => {
    expect(
      classifyBackfillOutcome({
        backfilled: 200,
        totalCostUsd: 9.34,
        targetHasPaidRates: true,
      })
    ).toBe('success')
  })

  it('treats $0.00 against a FREE rate as success, not a warning', () => {
    expect(
      classifyBackfillOutcome({
        backfilled: 42,
        totalCostUsd: 0,
        targetHasPaidRates: false,
      })
    ).toBe('success')
  })
})

// ─── A refused event is not a backfilled one ───────────────────

describe('classifyBackfillOutcome accounts for guard refusals', () => {
  it('a partly-refused run is NOT a success', () => {
    // 199 events priced, 1 refused, real money landed. Reading `backfilled`
    // alone this is an unqualified green panel saying "all matching events
    // are now priced" — while one event stays unpriced and unbilled.
    expect(
      classifyBackfillOutcome({
        backfilled: 199,
        totalCostUsd: 9.34,
        targetHasPaidRates: true,
        refused: 1,
      })
    ).toBe('partial_refused')
  })

  it('reports all_refused rather than zero_match when everything refused', () => {
    // These events DID match. Telling the operator "0 events matched" sends
    // them to check the model name when the fix is to fill in a rate.
    expect(
      classifyBackfillOutcome({
        backfilled: 0,
        totalCostUsd: 0,
        targetHasPaidRates: true,
        refused: 2,
      })
    ).toBe('all_refused')
  })

  it('outranks zero_cost — the refusal is the actionable fact', () => {
    expect(
      classifyBackfillOutcome({
        backfilled: 5,
        totalCostUsd: 0,
        targetHasPaidRates: true,
        refused: 3,
      })
    ).toBe('partial_refused')
  })

  it('NEGATIVE CONTROL: refused: 0 leaves every other verdict alone', () => {
    const cases = [
      { backfilled: 0, totalCostUsd: 0, targetHasPaidRates: true },
      { backfilled: 200, totalCostUsd: 0, targetHasPaidRates: true },
      { backfilled: 200, totalCostUsd: 9.34, targetHasPaidRates: true },
      { backfilled: 42, totalCostUsd: 0, targetHasPaidRates: false },
    ]
    for (const c of cases) {
      expect(classifyBackfillOutcome({ ...c, refused: 0 })).toBe(
        classifyBackfillOutcome(c)
      )
    }
    expect(cases.map((c) => classifyBackfillOutcome(c))).toEqual([
      'zero_match',
      'zero_cost',
      'success',
      'success',
    ])
  })

  it('NEGATIVE CONTROL: an omitted refused count behaves as zero', () => {
    expect(
      classifyBackfillOutcome({
        backfilled: 200,
        totalCostUsd: 9.34,
        targetHasPaidRates: true,
      })
    ).toBe('success')
  })
})

describe('MapModelDialog wires the classifier into the result panel', () => {
  const dialogSource = readFileSync(
    join(__dirname, '../../components/MapModelDialog.tsx'),
    'utf8'
  )

  it('calls classifyBackfillOutcome on the run result', () => {
    expect(dialogSource).toContain('classifyBackfillOutcome({')
    expect(dialogSource).toContain('backfilled: result.totalBackfilled')
    expect(dialogSource).toContain('totalCostUsd: result.totalCostUsd')
    expect(dialogSource).toContain(
      'targetHasPaidRates: result.targetHasPaidRates'
    )
  })

  it('renders the zero-match warning with the check-the-name hint', () => {
    expect(dialogSource).toContain("outcome === 'zero_match'")
    expect(dialogSource).toContain('Check the model name')
  })

  it('renders the zero-cost warning', () => {
    expect(dialogSource).toContain("outcome === 'zero_cost'")
    expect(dialogSource).toContain('but priced $0.00')
  })

  it('keeps the green all-priced copy exclusive to the success branch', () => {
    // The success copy must be the ternary fallback, reached only when
    // neither warning outcome matched.
    expect(dialogSource).toContain(
      ": 'Your mapping is saved and all matching events are now priced.'"
    )
  })

  it('gates the future-events-auto-map note on a real success', () => {
    expect(dialogSource).toContain("outcome === 'success' && !hasFailures")
  })

  it('keeps the batch failure branch alongside the outcome branches', () => {
    expect(dialogSource).toContain('hasFailures && (')
  })
})

describe('FillVolumeDialog wires the classifier into the result panel', () => {
  const dialogSource = readFileSync(
    join(__dirname, '../../components/FillVolumeDialog.tsx'),
    'utf8'
  )

  it('calls classifyBackfillOutcome on the run result', () => {
    expect(dialogSource).toContain('classifyBackfillOutcome({')
    expect(dialogSource).toContain('backfilled: result.totalBackfilled')
    expect(dialogSource).toContain('totalCostUsd: result.totalCostUsd')
    expect(dialogSource).toContain(
      'targetHasPaidRates: result.targetHasPaidRates'
    )
  })

  it('renders the zero-match warning with the stale-queue hint', () => {
    expect(dialogSource).toContain("outcome === 'zero_match'")
    expect(dialogSource).toContain('0 events matched this fill')
  })

  it('renders the zero-cost warning', () => {
    expect(dialogSource).toContain("outcome === 'zero_cost'")
    expect(dialogSource).toContain('but priced $0.00')
  })

  it('keeps the green all-priced copy exclusive to the success branch', () => {
    // The success copy must be the ternary fallback, reached only when
    // neither warning outcome matched.
    expect(dialogSource).toContain(
      ": 'All matching events are now priced and moved to PROCESSED.'"
    )
  })

  it('keeps the batch failure branch alongside the outcome branches', () => {
    expect(dialogSource).toContain('hasFailures && (')
  })
})

describe('fillMissingVolume feeds the classifier', () => {
  const actionSource = readFileSync(
    join(__dirname, '../../../../../app/actions/signal-events.ts'),
    'utf8'
  )

  // The Fill Volume dialog has no client-side pricing data, so this flag is
  // the classifier's only way to tell a paid-rate $0.00 from a free-rate one.
  it('returns targetHasPaidRates from the action', () => {
    expect(actionSource).toMatch(
      /targetHasPaidRates:\s*\n?\s*costEntry\.inputCost > 0 \|\| costEntry\.outputCost > 0/
    )
  })
})

/**
 * Strips comments, then looks for banned words anywhere in what is left —
 * JSX text, string literals, attribute values, all of it. Scanning quoted
 * strings alone would miss the copy that matters most, since JSX renders bare
 * text with no quotes around it. Comments are excluded because an engineer
 * writing "isn't just backfilling" in a code comment is not talking to a
 * customer.
 */
function bannedWordHits(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  return (code.match(/[^\n]*\bjust\b[^\n]*/gi) ?? []).map((l) => l.trim())
}

// ─── The dialogs surface the refusal ───────────────────────────
//
// These are node source assertions, not rendering tests. apps/dashboard's
// jest is node-only with no React Testing Library, so nothing here mounts a
// component, fires a click, or reads a rendered DOM.
// What they prove is that the wiring exists in the source and cannot be
// deleted silently. The classifier's own behaviour IS covered for real above,
// and both server actions are covered for real in
// app/actions/__tests__/signal-events-map-model-parity.test.ts.

describe('MapModelDialog surfaces the price guard', () => {
  const dialogSource = readFileSync(
    join(__dirname, '../../components/MapModelDialog.tsx'),
    'utf8'
  )

  it('feeds the refused count into the classifier', () => {
    expect(dialogSource).toContain('refused: result.totalRefused')
  })

  it('reads refused and refusedRates off every action result', () => {
    expect(dialogSource).toContain('totalRefused += result.data.refused')
    expect(dialogSource).toContain(
      'for (const rate of result.data.refusedRates) refusedRates.add(rate)'
    )
  })

  it('renders a refusal panel for BOTH refusal outcomes', () => {
    expect(dialogSource).toContain(
      "outcome === 'all_refused' || outcome === 'partial_refused'"
    )
    expect(dialogSource).toContain('left unpriced')
  })

  it('checks cache completeness BEFORE the run, not only after', () => {
    // The whole point of the pre-commit warning: the operator gets to pick a
    // different row while it still costs them nothing.
    expect(dialogSource).toContain('findMissingCacheRates({')
    expect(dialogSource).toContain('cacheRatesMissing.length > 0 && (')
    expect(dialogSource).toContain('has no price for prompt caching')
  })

  it('completeness counts cache rates, not only input/output', () => {
    // targetHasPaidRates feeds zero_cost but ignores cache rates, so it must
    // never be the only completeness signal reaching the panel.
    expect(dialogSource).toContain(
      'targetHasPaidRates: result.targetHasPaidRates'
    )
    expect(dialogSource).toContain('cacheReadCost: selected.cacheReadCost')
    expect(dialogSource).toContain('cacheWriteCost: selected.cacheWriteCost')
  })

  it('keeps the green all-priced copy behind every warning branch', () => {
    const successCopy =
      ": 'Your mapping is saved and all matching events are now priced.'"
    expect(dialogSource).toContain(successCopy)
    // The success string must sit AFTER both refusal tests in the ternary, or
    // a refused run reaches it first and renders green.
    const successAt = dialogSource.indexOf(successCopy)
    for (const guardCopy of [
      "outcome === 'all_refused'",
      "outcome === 'partial_refused'",
    ]) {
      expect(dialogSource.indexOf(guardCopy)).toBeLessThan(successAt)
    }
  })

  it('never says "just" to a customer', () => {
    expect(bannedWordHits(dialogSource)).toEqual([])
  })
})

describe('FillVolumeDialog surfaces the price guard too', () => {
  const dialogSource = readFileSync(
    join(__dirname, '../../components/FillVolumeDialog.tsx'),
    'utf8'
  )

  it('feeds the refused count into the classifier', () => {
    expect(dialogSource).toContain('refused: result.totalRefused')
  })

  it('renders a refusal panel for BOTH refusal outcomes', () => {
    expect(dialogSource).toContain(
      "outcome === 'all_refused' || outcome === 'partial_refused'"
    )
    expect(dialogSource).toContain('left unpriced')
  })

  it('keeps the green all-priced copy behind every warning branch', () => {
    const successCopy =
      ": 'All matching events are now priced and moved to PROCESSED.'"
    const successAt = dialogSource.indexOf(successCopy)
    expect(successAt).toBeGreaterThan(-1)
    for (const guardCopy of [
      "outcome === 'all_refused'",
      "outcome === 'partial_refused'",
    ]) {
      expect(dialogSource.indexOf(guardCopy)).toBeLessThan(successAt)
    }
  })

  it('never says "just" to a customer', () => {
    expect(bannedWordHits(dialogSource)).toEqual([])
  })
})

describe('the group query carries the cache usage the pre-check needs', () => {
  const actionSource = readFileSync(
    join(__dirname, '../../../../../app/actions/signal-events.ts'),
    'utf8'
  )

  it('sums cache tokens per group', () => {
    expect(actionSource).toContain('AS "cacheReadTokens"')
    expect(actionSource).toContain('AS "cacheWriteTokens"')
  })

  it('casts to float8, never int4', () => {
    // One model's cache-read tokens can sum past 2,147,483,647. An ::int cast throws
    // "integer out of range" and takes the whole needs-attention page down.
    expect(actionSource).toContain(
      'COALESCE(SUM(ses."cacheReadTokens"), 0)::float8'
    )
    expect(actionSource).toContain(
      'COALESCE(SUM(ses."cacheWriteTokens"), 0)::float8'
    )
    expect(actionSource).not.toMatch(/SUM\(ses\."cache\w+Tokens"\), 0\)::int\b/)
  })
})

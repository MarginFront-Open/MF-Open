import {
  composeNeedsAttention,
  costBackfillItem,
  creditPoolItem,
  mismatchedSignalsItem,
  missingVolumeItem,
} from '../needs-attention'

// Copy contract: every surface leads with the ACTIONABLE count (models = rows
// on the needs-attention page) and carries events as the impact
// parenthetical. These pins are the exact copy; change source and pins
// together.

describe('composeNeedsAttention', () => {
  it('returns an empty list when both counts are zero (a clean book shows nothing fake)', () => {
    expect(
      composeNeedsAttention({
        mismatchedCount: 0,
        backfillModelCount: 0,
        backfillTotalEvents: 0,
      })
    ).toEqual([])
  })

  it('emits one item per non-zero count, with real hrefs', () => {
    const items = composeNeedsAttention({
      mismatchedCount: 1,
      backfillModelCount: 3,
      backfillTotalEvents: 240,
    })
    expect(items).toEqual([
      {
        severity: 'amber',
        text: '1 signal booked to the wrong account type',
        href: '/finops?tab=settings',
      },
      {
        severity: 'amber',
        text: '3 models need cost backfill (240 events)',
        href: '/metrics-events/needs-attention',
      },
    ])
  })

  it('only the wrong-account-type item when backfill is zero', () => {
    const items = composeNeedsAttention({
      mismatchedCount: 3,
      backfillModelCount: 0,
      backfillTotalEvents: 0,
    })
    expect(items).toEqual([
      {
        severity: 'amber',
        text: '3 signals booked to the wrong account type',
        href: '/finops?tab=settings',
      },
    ])
  })

  it('only the backfill item when mismatched is zero, singular phrasing at exactly 1', () => {
    const items = composeNeedsAttention({
      mismatchedCount: 0,
      backfillModelCount: 1,
      backfillTotalEvents: 1,
    })
    expect(items).toEqual([
      {
        severity: 'amber',
        text: '1 model needs cost backfill (1 event)',
        href: '/metrics-events/needs-attention',
      },
    ])
  })

  it('never emits margin-floor, cost-spike or savings insights', () => {
    const items = composeNeedsAttention({
      mismatchedCount: 5,
      backfillModelCount: 4,
      backfillTotalEvents: 500,
    })
    const allText = items
      .map((i) => i.text)
      .join(' ')
      .toLowerCase()
    expect(allText).not.toMatch(/margin|floor|spike|saving|mf iq/)
  })
})

// The item builders. Build renders
// the backfill item ALONE; these tests pin (a) each builder's exact output,
// and (b) that composeNeedsAttention is literally their composition.

describe('costBackfillItem — the one item Build renders', () => {
  it('exact text/severity/href at the seed counts (2 models, 38 events)', () => {
    expect(costBackfillItem(2, 38)).toEqual({
      severity: 'amber',
      text: '2 models need cost backfill (38 events)',
      href: '/metrics-events/needs-attention',
    })
  })

  it('singular grammar at exactly 1 model, 1 event', () => {
    expect(costBackfillItem(1, 1)).toEqual({
      severity: 'amber',
      text: '1 model needs cost backfill (1 event)',
      href: '/metrics-events/needs-attention',
    })
  })

  it('one model, many events — the common shape, both units correct', () => {
    expect(costBackfillItem(1, 47).text).toBe(
      '1 model needs cost backfill (47 events)'
    )
  })

  it('large counts keep the locale separators', () => {
    expect(costBackfillItem(1204, 142113).text).toBe(
      `${(1204).toLocaleString()} models need cost backfill (${(142113).toLocaleString()} events)`
    )
  })

  it('leads with the model count — the tab-label unit, never events-first', () => {
    expect(costBackfillItem(2, 47).text).toMatch(/^2 models/)
  })
})

describe('mismatchedSignalsItem — stays with FinOps/Money/Overview, never Build', () => {
  it('exact text/severity/href', () => {
    expect(mismatchedSignalsItem(2)).toEqual({
      severity: 'amber',
      text: '2 signals booked to the wrong account type',
      href: '/finops?tab=settings',
    })
  })

  it('singular grammar at exactly 1', () => {
    expect(mismatchedSignalsItem(1).text).toBe(
      '1 signal booked to the wrong account type'
    )
  })
})

describe('missingVolumeItem — default href = the volume fix loop', () => {
  it('exact text/severity/default-href at the seed counts (3 models, 38 events)', () => {
    expect(missingVolumeItem(3, 38)).toEqual({
      severity: 'amber',
      text: '3 models are missing volume data (38 events)',
      href: '/metrics-events/needs-attention',
    })
  })

  it('singular grammar at exactly 1 model, 1 event', () => {
    expect(missingVolumeItem(1, 1)).toEqual({
      severity: 'amber',
      text: '1 model is missing volume data (1 event)',
      href: '/metrics-events/needs-attention',
    })
  })

  it('large counts keep the locale separators', () => {
    expect(missingVolumeItem(1204, 142113).text).toBe(
      `${(1204).toLocaleString()} models are missing volume data (${(142113).toLocaleString()} events)`
    )
  })

  it('leads with the model count — the tab-label unit, never events-first', () => {
    expect(missingVolumeItem(3, 9).text).toMatch(/^3 models/)
  })
})

// The ?tab= is a contract shared with the Needs attention page and it lives on
// the builder, so every call site inherits it instead of re-spelling it.

describe('creditPoolItem — default href IS the tab contract', () => {
  it('exact text/severity/href, tab included', () => {
    expect(creditPoolItem(2)).toEqual({
      severity: 'amber',
      text: '2 credit pools are running low',
      href: '/metrics-events/needs-attention?tab=credit-pools',
    })
  })

  it('singular grammar at exactly 1, same href', () => {
    expect(creditPoolItem(1)).toEqual({
      severity: 'amber',
      text: '1 credit pool is running low',
      href: '/metrics-events/needs-attention?tab=credit-pools',
    })
  })

  it('large counts keep the locale separators', () => {
    expect(creditPoolItem(142113).text).toBe(
      `${(142113).toLocaleString()} credit pools are running low`
    )
  })

  it('is amber, not red — an empty pool blocks nothing', () => {
    expect(creditPoolItem(5).severity).toBe('amber')
  })

  it('never the bare page href — that resolves to whichever tab has rows', () => {
    expect(creditPoolItem(3).href).not.toBe('/metrics-events/needs-attention')
    expect(creditPoolItem(3).href).toMatch(/\?tab=credit-pools$/)
  })

  it('is the ONLY builder carrying a needs-attention tab — its siblings stay bare', () => {
    expect(costBackfillItem(1, 1).href).toBe('/metrics-events/needs-attention')
    expect(missingVolumeItem(1, 1).href).toBe('/metrics-events/needs-attention')
  })
})

describe('composeNeedsAttention is the builders — no copy forks', () => {
  it('compose output === [mismatchedSignalsItem, costBackfillItem] for any non-zero pair', () => {
    expect(
      composeNeedsAttention({
        mismatchedCount: 3,
        backfillModelCount: 2,
        backfillTotalEvents: 7,
      })
    ).toEqual([mismatchedSignalsItem(3), costBackfillItem(2, 7)])
  })

  it('missing-volume never joins the composer — its surfaces append it themselves', () => {
    const items = composeNeedsAttention({
      mismatchedCount: 2,
      backfillModelCount: 1,
      backfillTotalEvents: 38,
    })
    expect(items.map((i) => i.text).join(' ')).not.toMatch(/missing volume/)
  })
})

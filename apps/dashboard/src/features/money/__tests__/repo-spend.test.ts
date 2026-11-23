/**
 * Pure mapping for the repo/branch spend section on the
 * Internal AI Spend page. Node-env jest over the client-safe module
 * (same pattern as spend-controls-utils.test.ts): the section consumes
 * the API's GET /control/spend/breakdown payload, and every display decision
 * (labels, honest nulls, shares, sorting, CSV) is a pure function here.
 */
import { formatCost } from '@/lib/canon-format'
import {
  BREAKDOWN_COLUMN_HEADERS,
  DIMENSION_CHOICES,
  EMPTY_NO_ACTIVITY,
  EXPORT_CSV_LABEL,
  NO_KEY_LABELS,
  PERIOD_CHOICES,
  breakdownCsv,
  buildBreakdownRows,
  coverageLine,
  csvFileName,
  noTaggedLine,
  shareCellText,
  sortDisplayRows,
  spendCellText,
  splitBranchKey,
  totalsLine,
  type SpendBreakdownData,
} from '../repo-spend'

const repoFixture: SpendBreakdownData = {
  dimension: 'repo',
  period: 'month',
  window: {
    start: '2026-07-01T00:00:00.000Z',
    end: '2026-07-31T23:59:59.999Z',
  },
  asOf: '2026-07-23T12:00:00.000Z',
  totals: { spentUsd: 100, eventCount: 12, unpricedEventCount: 2 },
  rows: [
    {
      key: 'acme/platform',
      spentUsd: 75,
      eventCount: 6,
      unpricedEventCount: 0,
    },
    { key: 'acme/agents', spentUsd: 20, eventCount: 3, unpricedEventCount: 0 },
    {
      key: 'acme/sandbox',
      spentUsd: null,
      eventCount: 1,
      unpricedEventCount: 1,
    },
  ],
  noMetadata: { spentUsd: 5, eventCount: 2, unpricedEventCount: 1 },
  coveragePercent: (10 / 12) * 100,
}

const branchFixture: SpendBreakdownData = {
  ...repoFixture,
  dimension: 'branch',
  rows: [
    {
      key: 'acme/platform#main',
      spentUsd: 60,
      eventCount: 4,
      unpricedEventCount: 0,
    },
    {
      key: 'acme/agents#main',
      spentUsd: 35,
      eventCount: 4,
      unpricedEventCount: 0,
    },
  ],
}

describe('splitBranchKey — composite repo#branch keys', () => {
  it('splits on the FIRST # so a branch named feat#1 keeps its #', () => {
    expect(splitBranchKey('acme/platform#main')).toEqual({
      repo: 'acme/platform',
      branch: 'main',
    })
    expect(splitBranchKey('acme/platform#feat#1')).toEqual({
      repo: 'acme/platform',
      branch: 'feat#1',
    })
  })

  it('a key with no # (defensive) becomes a bare branch, never a crash', () => {
    expect(splitBranchKey('main')).toEqual({ repo: null, branch: 'main' })
  })
})

describe('honest cells — null spend is absence, never $0', () => {
  it('null spend renders the no-price words, with no dollar figure', () => {
    const text = spendCellText(null)
    expect(text).toBe('No priced spend yet')
    expect(text).not.toContain('$')
    expect(text).not.toContain('0')
  })

  it('priced spend routes through the canon money formatter', () => {
    expect(spendCellText(75)).toBe(formatCost(75))
  })

  it('share renders only when both the row and the total are priced', () => {
    expect(shareCellText(75, 100)).toBe('75.0%')
    expect(shareCellText(null, 100)).toBe('')
    expect(shareCellText(5, null)).toBe('')
    expect(shareCellText(5, 0)).toBe('')
  })
})

describe('buildBreakdownRows — mapping the breakdown payload for display', () => {
  it('keeps server order (spend desc) and labels repo rows by their key', () => {
    const { rows } = buildBreakdownRows(repoFixture)
    expect(rows.map((r) => r.label)).toEqual([
      'acme/platform',
      'acme/agents',
      'acme/sandbox',
    ])
    expect(rows[0].repoContext).toBeNull()
    expect(rows[0].spendText).toBe(formatCost(75))
    expect(rows[0].shareText).toBe('75.0%')
    expect(rows[2].spendText).toBe('No priced spend yet')
    expect(rows[2].shareText).toBe('')
  })

  it('branch rows split the composite key into branch label + repo context', () => {
    const { rows } = buildBreakdownRows(branchFixture)
    expect(rows[0].label).toBe('main')
    expect(rows[0].repoContext).toBe('acme/platform')
    expect(rows[1].label).toBe('main')
    expect(rows[1].repoContext).toBe('acme/agents')
  })

  it('the no-metadata bucket becomes a pinned honest row when it has events', () => {
    const { noKeyRow } = buildBreakdownRows(repoFixture)
    expect(noKeyRow).not.toBeNull()
    expect(noKeyRow!.label).toBe(NO_KEY_LABELS.repo)
    expect(noKeyRow!.spendText).toBe(formatCost(5))
    expect(noKeyRow!.events).toBe(2)
  })

  it('an empty no-metadata bucket produces NO row (nothing to report)', () => {
    const { noKeyRow } = buildBreakdownRows({
      ...repoFixture,
      noMetadata: { spentUsd: null, eventCount: 0, unpricedEventCount: 0 },
    })
    expect(noKeyRow).toBeNull()
  })
})

describe('sortDisplayRows — client sorting with honest-null placement', () => {
  const { rows } = buildBreakdownRows(repoFixture)

  it('sorts by label ascending', () => {
    const sorted = sortDisplayRows(rows, 'label', 'asc')
    expect(sorted.map((r) => r.label)).toEqual([
      'acme/agents',
      'acme/platform',
      'acme/sandbox',
    ])
  })

  it('null spend sorts LAST in both spend directions (absence never ranks)', () => {
    const desc = sortDisplayRows(rows, 'spend', 'desc')
    expect(desc[desc.length - 1].label).toBe('acme/sandbox')
    const asc = sortDisplayRows(rows, 'spend', 'asc')
    expect(asc[asc.length - 1].label).toBe('acme/sandbox')
    expect(asc[0].label).toBe('acme/agents')
  })

  it('sorts by events and never mutates the input array', () => {
    const before = rows.map((r) => r.label)
    const sorted = sortDisplayRows(rows, 'events', 'desc')
    expect(sorted[0].label).toBe('acme/platform')
    expect(rows.map((r) => r.label)).toEqual(before)
  })
})

describe('coverage + empty-state copy — states, honestly', () => {
  it('rounds coverage and names the dimension', () => {
    const line = coverageLine((10 / 12) * 100, 'repo')
    expect(line).toMatch(/^83% /)
    expect(line).toContain('repo recorded')
    expect(line).toContain(NO_KEY_LABELS.repo)
  })

  it('full coverage drops the "the rest" clause (there is no rest)', () => {
    const line = coverageLine(100, 'branch')
    expect(line).toContain('Every coding event')
    expect(line).not.toContain('The rest')
  })

  it('null coverage (empty window) renders nothing, never 0%', () => {
    expect(coverageLine(null, 'repo')).toBe('')
  })

  it('near-100 coverage never rounds up to the "Every" claim while untagged rows exist', () => {
    // 99.6% would Math.round to 100 and claim every event is tagged while a
    // "No repo recorded" row sits right below it in the table.
    const line = coverageLine(99.6, 'repo')
    expect(line).not.toContain('Every')
    expect(line).toMatch(/^99% /)
    expect(line).toContain('The rest')
  })

  it('near-0 coverage never rounds down to a 0% denial of tagged rows that exist', () => {
    expect(coverageLine(0.4, 'repo')).toMatch(/^1% /)
    // True zero coverage is allowed to say 0%: nothing is tagged.
    expect(coverageLine(0, 'repo')).toMatch(/^0% /)
  })

  it('totals line: priced total + event count, or honest absence', () => {
    const line = totalsLine(repoFixture.totals)
    expect(line).toContain(formatCost(100))
    expect(line).toContain('12 coding events')
    expect(
      totalsLine({ spentUsd: null, eventCount: 3, unpricedEventCount: 3 })
    ).toBe('No priced spend for this period yet.')
  })

  it('the no-tagged line names the dimension and the honest bucket', () => {
    expect(noTaggedLine('repo')).toContain('No repo-tagged AI spend yet')
    expect(noTaggedLine('repo')).toContain(NO_KEY_LABELS.repo)
    expect(noTaggedLine('branch')).toContain(NO_KEY_LABELS.branch)
  })
})

describe('breakdownCsv — the export mirrors the honest-null contract', () => {
  it('null spend exports as an EMPTY field, never a fabricated 0', () => {
    const csv = breakdownCsv(repoFixture)
    const lines = csv.split('\n')
    expect(lines[0]).toBe(
      'repo,spent_usd,share_of_priced_spend_percent,events,events_without_price'
    )
    expect(lines).toContain('acme/platform,75,75.0,6,0')
    expect(lines).toContain('acme/sandbox,,,1,1')
    expect(lines).toContain(`${NO_KEY_LABELS.repo},5,5.0,2,1`)
  })

  it('branch export keeps the full composite key (branch identity)', () => {
    const csv = breakdownCsv(branchFixture)
    expect(csv.split('\n')[0]).toMatch(/^branch,/)
    expect(csv).toContain('acme/platform#main,60,60.0,4,0')
  })

  it('quotes fields containing commas or quotes', () => {
    const csv = breakdownCsv({
      ...repoFixture,
      rows: [
        {
          key: 'acme/we,ird"name',
          spentUsd: 1,
          eventCount: 1,
          unpricedEventCount: 0,
        },
      ],
    })
    expect(csv).toContain('"acme/we,ird""name",1,1.0,1,0')
  })

  it('defangs spreadsheet formula triggers through the ONE canonical csvCell escaper', () => {
    // A teammate can name a branch anything, including a spreadsheet formula.
    // The app's one CSV escaper (journal csvCell) prefixes a quote so Excel
    // treats it as text; a second hand-rolled escaper without that layer is
    // the exact drift breakdown/csv.ts warns about.
    const csv = breakdownCsv({
      ...repoFixture,
      rows: [
        {
          key: '=HYPERLINK("http://evil.example","total")',
          spentUsd: 1,
          eventCount: 1,
          unpricedEventCount: 0,
        },
        { key: '@cmd', spentUsd: 2, eventCount: 1, unpricedEventCount: 0 },
      ],
    })
    expect(csv).toContain("'=HYPERLINK")
    expect(csv).toContain("'@cmd")
    expect(csv.split('\n').some((line) => line.startsWith('='))).toBe(false)
  })

  it('file name carries dimension and period', () => {
    expect(csvFileName('repo', 'month')).toBe(
      'internal-coding-spend-by-repo-month.csv'
    )
  })
})

describe('choice registries — closed sets the section renders from', () => {
  it('offers exactly repo and branch, never a pr dimension (none exists)', () => {
    expect(DIMENSION_CHOICES.map((c) => c.id)).toEqual(['repo', 'branch'])
    for (const choice of DIMENSION_CHOICES) {
      expect(choice.label.toLowerCase()).not.toContain('pr')
    }
  })

  it('offers the three cap periods with plain labels', () => {
    expect(PERIOD_CHOICES.map((c) => c.id)).toEqual(['day', 'week', 'month'])
  })

  it('column headers say Spend, never PR', () => {
    expect(BREAKDOWN_COLUMN_HEADERS.spend).toBe('Spend')
    const all = Object.values(BREAKDOWN_COLUMN_HEADERS).join(' ')
    expect(all).not.toMatch(/\bPR\b/)
  })

  it('empty-state and button copy exist as pinned exports', () => {
    expect(EMPTY_NO_ACTIVITY.length).toBeGreaterThan(0)
    expect(EXPORT_CSV_LABEL.length).toBeGreaterThan(0)
  })
})

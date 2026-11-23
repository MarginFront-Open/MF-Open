/**
 * Pins the SHARED internal-event filter the spend-controls action spreads into
 * every signal_events query (roster, armed, freshness, spend sums). The
 * definition lives in @marginfront/db cap-policy so the api-nest read-back and this
 * dashboard read use one filter and cannot drift — caps govern INTERNAL
 * coding-agent spend only, never an org's customer-billing events.
 */
import { cccInternalEventFilter, CCC_AGENT_CODES } from '@marginfront/db'

describe('cccInternalEventFilter (shared with the api-nest read-back)', () => {
  it('pins the CCC agent codes that mark an event as coding-agent usage', () => {
    expect([...CCC_AGENT_CODES].sort()).toEqual(['claude-code', 'codex'])
  })

  it('builds an agents-relation filter over exactly those codes', () => {
    expect(cccInternalEventFilter()).toEqual({
      agents: { agentCode: { in: ['claude-code', 'codex'] } },
    })
  })

  it('is spread into every signal_events query the spend-controls action makes', () => {
    const fs = require('fs')
    const path = require('path')
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'spend-controls.ts'),
      'utf8'
    )
    const queryCount = (
      src.match(/prisma\.signal_events\.(aggregate|findMany)/g) ?? []
    ).length
    const filterCount = (src.match(/cccInternalEventFilter\(\)/g) ?? []).length
    expect(queryCount).toBeGreaterThan(0)
    // Every query either spreads the filter directly or spreads rosterScope
    // (which IS the filter, bound once above the Promise.all).
    const rosterSpreads = (src.match(/\.\.\.rosterScope/g) ?? []).length
    expect(filterCount + rosterSpreads).toBeGreaterThanOrEqual(queryCount)
  })
})

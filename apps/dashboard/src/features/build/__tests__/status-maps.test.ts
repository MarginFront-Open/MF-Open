/**
 * The pure view maps, tested
 * for real (framework-free module, no source-grepping needed). The event map
 * must stay a TOTAL Record over the eventProcessed enum with honest labels.
 * There is no Billed event status, so there is no Billed chip.
 */

import {
  EVENT_STATUS_CHIPS,
  agentStatusPill,
  eventModelLabel,
  type EventProcessedStatus,
} from '../components/status-maps'

const ALL_STATUSES: EventProcessedStatus[] = [
  'PENDING',
  'PROCESSED',
  'ERROR',
  'NEEDS_COST_BACKFILL',
  'MISSING_VOLUME_DATA',
]

describe('EVENT_STATUS_CHIPS — total over the 5 eventProcessed values', () => {
  it('covers exactly the enum, nothing more', () => {
    expect(Object.keys(EVENT_STATUS_CHIPS).sort()).toEqual(
      [...ALL_STATUSES].sort()
    )
  })

  it('pins the honest label/severity pairs', () => {
    expect(EVENT_STATUS_CHIPS.PROCESSED.label).toBe('Processed')
    expect(EVENT_STATUS_CHIPS.PROCESSED.className).toContain('text-mf-green')
    expect(EVENT_STATUS_CHIPS.NEEDS_COST_BACKFILL.label).toBe(
      'Needs cost backfill'
    )
    expect(EVENT_STATUS_CHIPS.NEEDS_COST_BACKFILL.className).toContain(
      'text-mf-amber'
    )
    expect(EVENT_STATUS_CHIPS.MISSING_VOLUME_DATA.label).toBe('Missing volume')
    expect(EVENT_STATUS_CHIPS.MISSING_VOLUME_DATA.className).toContain(
      'text-mf-amber'
    )
    expect(EVENT_STATUS_CHIPS.PENDING.label).toBe('Pending')
    expect(EVENT_STATUS_CHIPS.ERROR.label).toBe('Error')
    expect(EVENT_STATUS_CHIPS.ERROR.className).toContain('text-mf-red')
  })

  it("contains no 'Billed' label — billing state lives on invoices, not events", () => {
    for (const chip of Object.values(EVENT_STATUS_CHIPS)) {
      expect(chip.label).not.toMatch(/Billed/i)
    }
  })
})

describe('agentStatusPill', () => {
  it('active → green Active', () => {
    const pill = agentStatusPill(true)
    expect(pill?.label).toBe('Active')
    expect(pill?.className).toContain('text-mf-green')
  })

  it('paused → muted Paused (a label, not a behavior)', () => {
    const pill = agentStatusPill(false)
    expect(pill?.label).toBe('Paused')
    expect(pill?.className).not.toContain('text-mf-green')
  })

  it('null (the deleted-agents catch-all) → no pill at all', () => {
    expect(agentStatusPill(null)).toBeNull()
  })
})

describe('eventModelLabel', () => {
  it('no services → em dash', () => {
    expect(eventModelLabel([])).toBe('—')
  })

  it('single service → the model verbatim', () => {
    expect(eventModelLabel([{ model: 'gpt-4o' }])).toBe('gpt-4o')
  })

  it('multi-service → first model + honest count of the rest', () => {
    expect(
      eventModelLabel([
        { model: 'claude-sonnet-4-5' },
        { model: 'gpt-4o' },
        { model: 'text-embedding-3-small' },
      ])
    ).toBe('claude-sonnet-4-5 +2 more')
  })
})

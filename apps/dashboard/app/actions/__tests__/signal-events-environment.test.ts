/**
 * WHAT THIS FILE DOES: Locks that the `environment` tag (the field
 *   that decides whether an event's cost is booked as COGS or R&D) is
 *   carried through the signal-events serialization AND surfaced in the event
 *   detail view, so it's auditable from the event itself.
 *
 * WHY IT IS A SOURCE-ASSERTION TEST: the getSignalEvents / getSignalEvent
 *   actions hit Prisma + auth, and the sidebar is a React component — neither
 *   runs in the node-only jest environment without heavy mocking or jsdom.
 *   So we assert the serialization shape and the rendered field at the source
 *   level: the SignalEvent type declares `environment`, the mapper pulls it
 *   through, and the sidebar both shows it and includes it in the Properties
 *   JSON. Same guardrail style as the other source tests in this directory.
 *
 * CONNECTS TO: ../signal-events.ts (the action + SignalEvent type + mapper) and
 *   the EventDetailsSidebar component (the per-event detail view).
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const actionSource = readFileSync(join(__dirname, '../signal-events.ts'), 'utf8')
const sidebarSource = readFileSync(
  join(
    __dirname,
    '../../../src/features/signal-events/components/EventDetailsSidebar.tsx'
  ),
  'utf8'
)

describe('environment is serialized', () => {
  it('declares environment on the SignalEvent type with the enum union', () => {
    expect(actionSource).toMatch(
      /environment:\s*'production' \| 'staging' \| 'development' \| 'testing' \| null/
    )
  })

  it('carries environment through the row mapper', () => {
    expect(actionSource).toContain('environment: event.environment ?? null')
  })
})

describe('environment is surfaced in the event detail view', () => {
  it('renders a visible Environment field with a "Not tagged" fallback', () => {
    expect(sidebarSource).toContain('Environment')
    expect(sidebarSource).toContain("event.environment ?? 'Not tagged'")
  })

  it('includes environment in the copyable Properties JSON', () => {
    expect(sidebarSource).toContain('environment: event.environment')
  })
})

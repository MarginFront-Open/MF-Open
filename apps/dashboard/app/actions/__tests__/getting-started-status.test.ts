/**
 * GetHasIngestedFirstEvent, the ALL-TIME (not
 * windowed) zero-events signal behind the Build "Get started" nudge. Fully
 * mocked DB; no database needed. Pins: real-boolean result (never null on a success
 * path), scoping to the session's active org, and a quiet failure shape when
 * unauthenticated or on a DB error.
 */

export {}

const ORG = 'org-getting-started'

let sessionState: { activeOrganizationId: string | null } = {
  activeOrganizationId: ORG,
}

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        sessionState.activeOrganizationId
          ? { session: { activeOrganizationId: sessionState.activeOrganizationId } }
          : null,
    },
  },
}))
jest.mock('next/headers', () => ({ headers: async () => new Headers() }))

const rawIngestEventsFindFirst = jest.fn()
jest.mock('@/app/lib/db', () => ({
  db: {
    raw_ingest_events: { findFirst: (a: unknown) => rawIngestEventsFindFirst(a) },
  },
}))

type Mod = typeof import('../getting-started-status')
let mod: Mod

beforeAll(async () => {
  mod = await import('../getting-started-status')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG }
  rawIngestEventsFindFirst.mockReset()
})

describe('getHasIngestedFirstEvent', () => {
  it('resolves hasEvents: true the moment ANY row exists for the org', async () => {
    rawIngestEventsFindFirst.mockResolvedValue({ id: 'evt-1' })
    const result = await mod.getHasIngestedFirstEvent()
    expect(result).toEqual({ success: true, hasEvents: true })
  })

  it('resolves hasEvents: false for a genuinely empty org — never coalesced, never omitted', async () => {
    rawIngestEventsFindFirst.mockResolvedValue(null)
    const result = await mod.getHasIngestedFirstEvent()
    expect(result).toEqual({ success: true, hasEvents: false })
  })

  it("scopes the existence check to the session's active org", async () => {
    rawIngestEventsFindFirst.mockResolvedValue(null)
    await mod.getHasIngestedFirstEvent()
    expect(rawIngestEventsFindFirst.mock.calls[0][0].where).toEqual({
      organizationId: ORG,
    })
  })

  it('is a bare existence check — select id only, no aggregation, no count', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'getting-started-status.ts'),
      'utf8'
    )
    expect(src).toMatch(/select:\s*\{\s*id:\s*true\s*\}/)
    expect(src).not.toMatch(/\.count\(/)
    expect(src).not.toMatch(/\.aggregate\(/)
  })

  it('fails quietly (success: false) when there is no active organization, never throws', async () => {
    sessionState = { activeOrganizationId: null }
    const result = await mod.getHasIngestedFirstEvent()
    expect(result.success).toBe(false)
    expect(rawIngestEventsFindFirst).not.toHaveBeenCalled()
  })

  it('a DB error returns success:false with a plain-English message, never crashes the caller', async () => {
    rawIngestEventsFindFirst.mockRejectedValue(new Error('connection reset'))
    const result = await mod.getHasIngestedFirstEvent()
    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

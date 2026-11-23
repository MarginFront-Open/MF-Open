/**
 * GET /api/roi/report.
 *
 * What this route is for: a finance user opens it in a browser tab and gets
 * the same report the ROI page shows, as JSON, with a stamp on every number.
 * The point of the stamps is that a figure quoted on a slide carries whether
 * we measured it or the customer typed it, so an estimate cannot be laundered
 * into a finding by deleting a sentence.
 *
 * The handler is executed for real here. Only the action is mocked, because
 * the action reaches Prisma and the gate; the route's own job is the query
 * string, the status code and the body, and that is what is asserted.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import type { NextRequest } from 'next/server'

jest.mock('@/app/actions/roi-report', () => ({
  getRoiReportJson: jest.fn(),
}))

import { GET } from '../route'
import { getRoiReportJson } from '@/app/actions/roi-report'

const mocked = getRoiReportJson as jest.MockedFunction<typeof getRoiReportJson>

const request = (query: string) =>
  ({ url: `https://app.example.com/api/roi/report${query}` }) as NextRequest

const BODY = {
  window: {
    start: '2026-08-19',
    end: '2026-09-18',
    resolvedStart: '2026-08-19T14:22:10.114Z',
    resolvedEnd: '2026-09-18T14:22:10.114Z',
    source: 'measured',
  },
  scope: { agentKeys: ['a1'], allSelected: true, source: 'customer_entered' },
  whatYouUsedAiFor: {
    agents: [
      {
        key: 'a1',
        name: 'Report Drafting',
        usageEvents: { value: 900, source: 'measured' },
        cost: { value: 3000, source: 'measured' },
        earned: { value: 4000, source: 'measured' },
        revenue: { value: 5200, source: 'measured' },
        marginPercent: { value: 25, source: 'measured' },
        countedInComparison: true,
      },
    ],
    totals: {
      usageEvents: { value: 0, source: 'measured' },
      finishedRecordsExcluded: { value: 1, source: 'measured' },
      finishedThings: { value: 2, source: 'measured' },
      cost: { value: 0, source: 'measured' },
      earned: { value: 4000, source: 'measured' },
      revenue: { value: 5200, source: 'measured' },
    },
  },
  whatYouFinished: {
    rows: [
      {
        name: 'Report drafted',
        source: 'recorded',
        howMany: { value: 4, source: 'measured' },
        aiCost: { value: 12, source: 'attributed' },
        costForOne: { value: 3, source: 'attributed' },
        split: false,
      },
    ],
    totals: {
      howMany: { value: 4, source: 'measured' },
      aiCost: { value: 12, source: 'attributed' },
    },
    honesty: {
      attribution: 'a',
      unattributed: null,
      unpriced: null,
      moreNames: null,
    },
  },
  metrics: [],
  withoutAi: null,
  honesty: { proxyGap: 'p', usageEventDefinition: 'u', hoursNote: 'h' },
}

beforeEach(() => {
  mocked.mockReset()
})

describe('the gate lives in the action, and the route reports what it said', () => {
  it('a signed-out caller gets 401 and nothing else', async () => {
    const signedOut = "You're signed out. Sign in again to read this report."
    mocked.mockResolvedValue({ ok: false, status: 401, error: signedOut })
    const response = await GET(request(''))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: signedOut })
  })

  it('a member without the money role gets 403 and no partial report', async () => {
    mocked.mockResolvedValue({
      ok: false,
      status: 403,
      error: "You don't have access to this report.",
    })
    const response = await GET(request(''))
    const body = await response.json()
    expect(response.status).toBe(403)
    expect(Object.keys(body)).toEqual(['error'])
    expect(body).not.toHaveProperty('metrics')
    expect(body).not.toHaveProperty('withoutAi')
  })

  it('a read that failed is a 500 with words, not an empty report', async () => {
    mocked.mockResolvedValue({
      ok: false,
      status: 500,
      error: 'Refresh to try again.',
    })
    const response = await GET(request(''))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Refresh to try again.' })
  })

  it('a window too wide for the table is the caller asking for too much', async () => {
    mocked.mockResolvedValue({
      ok: false,
      status: 400,
      error: 'Narrow the date range.',
    })
    expect((await GET(request('?start=2020-01-01'))).status).toBe(400)
  })

  it('finance gets 200 and the body the action built, unchanged', async () => {
    mocked.mockResolvedValue({ ok: true, status: 200, data: BODY as never })
    const response = await GET(request('?start=2026-08-19&end=2026-09-18'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(BODY)
  })

  it('passes the finished-work table and its stamps straight through', async () => {
    mocked.mockResolvedValue({ ok: true, status: 200, data: BODY as never })
    const body = await (await GET(request(''))).json()
    // 'attributed' is a claim the route must never quietly soften into
    // 'measured' by re-shaping the body on its way out.
    expect(body.whatYouFinished.rows[0].aiCost.source).toBe('attributed')
    expect(body.whatYouFinished.rows[0].howMany.source).toBe('measured')
    // Two numbers, not one: the tile subtracts RECORDS and the sentence
    // beside it counts THINGS. The route passes both through untouched.
    expect(body.whatYouUsedAiFor.totals.finishedRecordsExcluded.value).toBe(1)
    expect(body.whatYouUsedAiFor.totals.finishedThings.value).toBe(2)
  })

  // The table shows one revenue column at a time; the document
  // carries both, so a consumer never has to know which one the sender was
  // looking at.
  it('carries Earned AND Total revenue on every row and on the totals', async () => {
    mocked.mockResolvedValue({ ok: true, status: 200, data: BODY as never })
    const body = await (await GET(request(''))).json()
    expect(body.whatYouUsedAiFor.agents[0].earned.value).toBe(4000)
    expect(body.whatYouUsedAiFor.agents[0].revenue.value).toBe(5200)
    expect(body.whatYouUsedAiFor.totals.earned.value).toBe(4000)
    expect(body.whatYouUsedAiFor.totals.revenue.value).toBe(5200)
  })

  it('answers as JSON so a browser tab renders it', async () => {
    mocked.mockResolvedValue({ ok: true, status: 200, data: BODY as never })
    const response = await GET(request(''))
    expect(response.headers.get('content-type')).toContain('application/json')
  })
})

describe('the query string is read the way the export route reads it', () => {
  beforeEach(() => {
    mocked.mockResolvedValue({ ok: true, status: 200, data: BODY as never })
  })

  it('passes the dates, the count and the agent selection through verbatim', async () => {
    await GET(request('?start=2026-08-19&end=2026-09-18&units=57&agents=a1,a2'))
    expect(mocked).toHaveBeenCalledWith({
      startDate: '2026-08-19',
      endDate: '2026-09-18',
      units: '57',
      agents: 'a1,a2',
    })
  })

  // The period total lives on the org row, where it belongs:
  // "what this work cost a month" is not a fact about one date range.
  it('carries no period total, and ignores a beforeTotal param in the link', async () => {
    await GET(request('?start=2026-08-19&end=2026-09-18&beforeTotal=7980'))
    expect(mocked.mock.calls[0][0]).not.toHaveProperty('beforeTotal')
  })

  it('invents no dates of its own when none are given — the action owns the default window', async () => {
    await GET(request(''))
    expect(mocked).toHaveBeenCalledWith({
      startDate: undefined,
      endDate: undefined,
      units: null,
      agents: null,
    })
  })

  it('an empty agents parameter still reaches the action, because "none checked" is a real answer', async () => {
    await GET(request('?agents=none'))
    expect(mocked.mock.calls[0][0].agents).toBe('none')
  })
})

describe('the route holds no data logic of its own', () => {
  const routeSrc = readFileSync(join(__dirname, '..', 'route.ts'), 'utf8')
  /** Doc mentions are fine; imports and calls are not. */
  const codeOnly = routeSrc
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, '')

  it('never opens a database connection or re-checks the role', () => {
    expect(codeOnly).not.toMatch(/PrismaClient/)
    expect(codeOnly).not.toMatch(/assertMoneyManager/)
    expect(codeOnly).not.toMatch(/MANAGE_MONEY_ROLES/)
    expect(codeOnly).not.toMatch(/auth\.api\.getSession/)
  })

  it('formats no money and builds no sentence — every string arrives from the action', () => {
    expect(codeOnly).not.toMatch(/@\/lib\/canon-format/)
    expect(codeOnly).not.toMatch(/\.toFixed\(/)
    expect(codeOnly).not.toMatch(/buildWithoutAi/)
  })

  it('reports the status the action chose rather than a status of its own', () => {
    expect(routeSrc).toMatch(/status: result\.status/)
  })

  it('is a read: it exports GET and nothing that writes', () => {
    expect(routeSrc).toMatch(/export async function GET\(/)
    expect(routeSrc).not.toMatch(
      /export async function (POST|PUT|PATCH|DELETE)\(/
    )
  })
})

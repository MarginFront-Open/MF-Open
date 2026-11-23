/**
 * Layout validation: getDashboardLayout /
 * saveDashboardLayout / resetDashboardLayout (app/actions/dashboard-layouts.ts).
 *
 * Fully mocked — no DB, no live session. Same pattern as
 * build-writes-authz.test.ts / create-simulator-demo-pricing-authz.test.ts:
 * auth/headers/cache/db are all in-memory stand-ins, so this
 * exercises the REAL zod-strict tile validation and the REAL branch
 * decisions (session-only ids, no-row default, reset =
 * delete) without needing packages/db/.env or a live Postgres connection.
 *
 * The catalog's zod schemas (TileInputSchema/TilesInputSchema) are not
 * exported from dashboard-layouts.ts — it is a 'use server' file, which may
 * only export async functions (jest, tsc and eslint all pass a non-async
 * export there; only `next build` fails it). So validation is proven here by calling the
 * exported actions with good/bad payloads and reading their return value,
 * not by importing the schema directly.
 */

export {}

const ORG = 'org-real-layouts'
const USER = 'user-layouts'

let sessionState: {
  activeOrganizationId: string | null
  userId: string | null
} = { activeOrganizationId: ORG, userId: USER }

jest.mock('@/app/lib/auth', () => ({
  auth: {
    api: {
      getSession: async () =>
        sessionState.activeOrganizationId
          ? {
              session: {
                activeOrganizationId: sessionState.activeOrganizationId,
              },
              user: { id: sessionState.userId },
            }
          : null,
    },
  },
}))
jest.mock('next/headers', () => ({ headers: async () => new Headers() }))
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }))
const findUnique = jest.fn()
const upsert = jest.fn()
const deleteMany = jest.fn()
jest.mock('@/app/lib/db', () => ({
  db: {
    user_dashboard_layouts: {
      findUnique: (a: unknown) => findUnique(a),
      upsert: (a: unknown) => upsert(a),
      deleteMany: (a: unknown) => deleteMany(a),
    },
  },
  Prisma: { InputJsonValue: {} },
}))

type Mod = typeof import('../dashboard-layouts')
let mod: Mod

beforeAll(async () => {
  mod = await import('../dashboard-layouts')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  findUnique.mockReset()
  upsert.mockReset()
  deleteMany.mockReset()
  upsert.mockResolvedValue({})
  deleteMany.mockResolvedValue({ count: 1 })
})

// Kpi-tile REQUIRES a `metric` from TILE_METRIC_REGISTRY,
// exactly mirroring the dimension rules — see the metric describe block below.
const VALID_TILES = [
  { component: 'kpi-tile', metric: 'cost', size: 'sm' },
  { component: 'timeseries-chart', dimension: 'agent', size: 'lg' },
]

describe('saveDashboardLayout — zod-strict tile validation', () => {
  it('accepts a well-formed layout and writes it scoped to the session org/user', async () => {
    const res = await mod.saveDashboardLayout('money', VALID_TILES as any)
    expect(res.success).toBe(true)
    expect(upsert).toHaveBeenCalledTimes(1)
    const arg = upsert.mock.calls[0][0]
    expect(arg.where.userId_orgId_page).toEqual({
      userId: USER,
      orgId: ORG,
      page: 'money',
    })
    expect(arg.create.tiles).toEqual(VALID_TILES)
  })

  it('rejects an unknown page id', async () => {
    const res = await mod.saveDashboardLayout('not-a-real-page' as any, VALID_TILES as any)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Unknown page/)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('rejects an unknown component id', async () => {
    const res = await mod.saveDashboardLayout('money', [
      { component: 'not-a-real-component', size: 'sm' },
    ] as any)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Invalid layout/)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('rejects an unknown dimension value on a chart tile', async () => {
    const res = await mod.saveDashboardLayout('money', [
      { component: 'timeseries-chart', dimension: 'not-a-real-dimension', size: 'lg' },
    ] as any)
    expect(res.success).toBe(false)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('rejects a chart/table component missing its required dimension', async () => {
    const res = await mod.saveDashboardLayout('money', [
      { component: 'breakdown-table', size: 'lg' },
    ] as any)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/requires a dimension/)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('rejects a fixed component that carries a dimension it does not take', async () => {
    const res = await mod.saveDashboardLayout('money', [
      { component: 'kpi-tile', metric: 'cost', dimension: 'agent', size: 'sm' },
    ] as any)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/does not take a dimension/)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('rejects an unknown key on a tile (zod .strict())', async () => {
    const res = await mod.saveDashboardLayout('money', [
      { component: 'kpi-tile', metric: 'cost', size: 'sm', extraField: 'sneaky' } as any,
    ])
    expect(res.success).toBe(false)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('rejects an unknown size', async () => {
    const res = await mod.saveDashboardLayout('money', [
      { component: 'kpi-tile', metric: 'cost', size: 'xl' as any },
    ])
    expect(res.success).toBe(false)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('rejects an oversized tiles array (> MAX_TILES_PER_LAYOUT)', async () => {
    const tooMany = Array.from({ length: 25 }, () => ({
      component: 'kpi-tile',
      metric: 'cost',
      size: 'sm',
    }))
    const res = await mod.saveDashboardLayout('money', tooMany as any)
    expect(res.success).toBe(false)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('accepts exactly MAX_TILES_PER_LAYOUT (24) tiles — the boundary is inclusive', async () => {
    // Exact duplicates are blocked, so the boundary layout must be 24
    // UNIQUE (component, metric, dimension) configs: 9 kpi metrics + 8
    // chart dimensions + 7 donut dimensions.
    const dimensions = [
      'agent',
      'customer',
      'signal',
      'day',
      'plan',
      'model',
      'costCategory',
      'environment',
    ]
    const metrics = [
      'cost',
      'revenue',
      'marginPercent',
      'overdueAmount',
      'mrr',
      'arr',
      'earned',
      'costPerTask',
      'eventCount',
    ]
    const exactly24 = [
      ...metrics.map((metric) => ({ component: 'kpi-tile', metric, size: 'sm' })),
      ...dimensions.map((dimension) => ({
        component: 'timeseries-chart',
        dimension,
        size: 'lg',
      })),
      ...dimensions
        .slice(0, 7)
        .map((dimension) => ({ component: 'category-donut', dimension, size: 'md' })),
    ]
    expect(exactly24).toHaveLength(24)
    const res = await mod.saveDashboardLayout('money', exactly24 as any)
    expect(res.success).toBe(true)
    expect(upsert).toHaveBeenCalledTimes(1)
  })
})

describe('saveDashboardLayout — exact-duplicate rule', () => {
  it('rejects two tiles with the same (component, metric) config', async () => {
    const res = await mod.saveDashboardLayout('money', [
      { component: 'kpi-tile', metric: 'cost', size: 'sm' },
      { component: 'kpi-tile', metric: 'cost', size: 'sm' },
    ] as any)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/duplicates/)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('rejects two tiles with the same (component, dimension) config', async () => {
    const res = await mod.saveDashboardLayout('money', [
      { component: 'breakdown-table', dimension: 'customer', size: 'lg' },
      { component: 'breakdown-table', dimension: 'customer', size: 'lg' },
    ] as any)
    expect(res.success).toBe(false)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('accepts the same component twice with DIFFERENT metrics', async () => {
    const res = await mod.saveDashboardLayout('money', [
      { component: 'kpi-tile', metric: 'mrr', size: 'sm' },
      { component: 'kpi-tile', metric: 'arr', size: 'sm' },
    ] as any)
    expect(res.success).toBe(true)
    expect(upsert).toHaveBeenCalledTimes(1)
  })

  it('accepts the same component twice with DIFFERENT dimensions', async () => {
    const res = await mod.saveDashboardLayout('money', [
      { component: 'category-donut', dimension: 'costCategory', size: 'md' },
      { component: 'category-donut', dimension: 'agent', size: 'md' },
    ] as any)
    expect(res.success).toBe(true)
    expect(upsert).toHaveBeenCalledTimes(1)
  })
})

describe('saveDashboardLayout — metric rules (extension stays zod-strict)', () => {
  it('accepts a kpi-tile with a registry metric', async () => {
    const res = await mod.saveDashboardLayout('money', [
      { component: 'kpi-tile', metric: 'overdueAmount', size: 'sm' },
    ] as any)
    expect(res.success).toBe(true)
    expect(upsert).toHaveBeenCalledTimes(1)
  })

  it('rejects a kpi-tile missing its required metric', async () => {
    const res = await mod.saveDashboardLayout('money', [
      { component: 'kpi-tile', size: 'sm' },
    ] as any)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/requires a metric/)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('rejects a metric the registry does not know', async () => {
    const res = await mod.saveDashboardLayout('money', [
      { component: 'kpi-tile', metric: 'not-a-real-metric', size: 'sm' },
    ] as any)
    expect(res.success).toBe(false)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('rejects a non-kpi component that carries a metric it does not take', async () => {
    const res = await mod.saveDashboardLayout('money', [
      { component: 'timeseries-chart', dimension: 'day', metric: 'cost', size: 'lg' },
    ] as any)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/does not take a metric/)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('still rejects unknown keys when a valid metric is present (strict was not loosened)', async () => {
    const res = await mod.saveDashboardLayout('money', [
      { component: 'kpi-tile', metric: 'cost', size: 'sm', sneaky: true } as any,
    ])
    expect(res.success).toBe(false)
    expect(upsert).not.toHaveBeenCalled()
  })
})

describe('saveDashboardLayout — the write always targets the CURRENT session, never a client-supplied id', () => {
  it('two different sessions land in two different orgs/users for the identical tiles payload', async () => {
    sessionState = { activeOrganizationId: 'org-one', userId: 'user-one' }
    await mod.saveDashboardLayout('money', VALID_TILES as any)
    expect(upsert.mock.calls[0][0].where.userId_orgId_page).toEqual({
      userId: 'user-one',
      orgId: 'org-one',
      page: 'money',
    })

    upsert.mockClear()
    sessionState = { activeOrganizationId: 'org-two', userId: 'user-two' }
    await mod.saveDashboardLayout('money', VALID_TILES as any)
    expect(upsert.mock.calls[0][0].where.userId_orgId_page).toEqual({
      userId: 'user-two',
      orgId: 'org-two',
      page: 'money',
    })
  })
})


describe('getDashboardLayout — no-row means "the caller applies the code default"', () => {
  it('returns data: null when no row exists', async () => {
    findUnique.mockResolvedValue(null)
    const res = await mod.getDashboardLayout('money')
    expect(res.success).toBe(true)
    expect(res.data).toBeNull()
  })

  it('returns the stored tiles when a row exists, scoped to the session org/user', async () => {
    findUnique.mockResolvedValue({ tiles: VALID_TILES })
    const res = await mod.getDashboardLayout('money')
    expect(res.success).toBe(true)
    expect(res.data).toEqual(VALID_TILES)
    expect(findUnique.mock.calls[0][0].where.userId_orgId_page).toEqual({
      userId: USER,
      orgId: ORG,
      page: 'money',
    })
  })

  it('rejects an unknown page id before touching the DB', async () => {
    const res = await mod.getDashboardLayout('bogus-page' as any)
    expect(res.success).toBe(false)
    expect(findUnique).not.toHaveBeenCalled()
  })
})

describe('resetDashboardLayout — reset deletes the row, never writes a synthetic default', () => {
  it('deletes the row scoped to the session org/user/page', async () => {
    const res = await mod.resetDashboardLayout('money')
    expect(res.success).toBe(true)
    expect(deleteMany).toHaveBeenCalledTimes(1)
    expect(deleteMany.mock.calls[0][0].where).toEqual({
      userId: USER,
      orgId: ORG,
      page: 'money',
    })
    // Reset never calls upsert/create — it is delete-only.
    expect(upsert).not.toHaveBeenCalled()
  })

  it('is idempotent: resetting an already-default page still succeeds', async () => {
    deleteMany.mockResolvedValue({ count: 0 })
    const res = await mod.resetDashboardLayout('money')
    expect(res.success).toBe(true)
  })

})

/**
 * Layout validation: getSavedViews / createSavedView /
 * deleteSavedView (app/actions/saved-views.ts). Fully mocked, same pattern
 * as dashboard-layouts-validation.test.ts — see that file's header for why
 * this calls the exported actions rather than importing FiltersInputSchema
 * directly (it isn't exported; the module is 'use server').
 */

export {}

const ORG = 'org-real-views'
const USER = 'user-views'

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
const findMany = jest.fn()
const count = jest.fn()
const create = jest.fn()
const deleteMany = jest.fn()
jest.mock('@/app/lib/db', () => ({
  db: {
    user_saved_views: {
      findMany: (a: unknown) => findMany(a),
      count: (a: unknown) => count(a),
      create: (a: unknown) => create(a),
      deleteMany: (a: unknown) => deleteMany(a),
    },
  },
  Prisma: { InputJsonValue: {} },
}))

type Mod = typeof import('../saved-views')
let mod: Mod

const VALID_FILTERS = {
  page: 'money',
  dimension: 'agent',
  period: { startDate: '2026-01-01', endDate: '2026-01-31' },
  customerId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
}

beforeAll(async () => {
  mod = await import('../saved-views')
})

beforeEach(() => {
  sessionState = { activeOrganizationId: ORG, userId: USER }
  findMany.mockReset()
  count.mockReset()
  create.mockReset()
  deleteMany.mockReset()
  count.mockResolvedValue(0)
  create.mockResolvedValue({
    id: 'view-1',
    name: 'My View',
    filters: VALID_FILTERS,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  deleteMany.mockResolvedValue({ count: 1 })
})

describe('createSavedView — validation', () => {
  it('accepts a well-formed name + filters, scoped to the session org/user', async () => {
    const res = await mod.createSavedView('My View', VALID_FILTERS as any)
    expect(res.success).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
    const arg = create.mock.calls[0][0]
    expect(arg.data.userId).toBe(USER)
    expect(arg.data.orgId).toBe(ORG)
    expect(arg.data.name).toBe('My View')
  })

  it('rejects an empty (whitespace-only) name before touching the DB', async () => {
    const res = await mod.createSavedView('   ', VALID_FILTERS as any)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Name is required/)
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects a name over 255 characters', async () => {
    const res = await mod.createSavedView('x'.repeat(256), VALID_FILTERS as any)
    expect(res.success).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects an unknown page in filters', async () => {
    const res = await mod.createSavedView('View', {
      ...VALID_FILTERS,
      page: 'not-a-real-page',
    } as any)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Invalid filters/)
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects an unknown dimension in filters', async () => {
    const res = await mod.createSavedView('View', {
      ...VALID_FILTERS,
      dimension: 'not-a-real-dimension',
    } as any)
    expect(res.success).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects a non-UUID customerId filter', async () => {
    const res = await mod.createSavedView('View', {
      ...VALID_FILTERS,
      customerId: 'not-a-uuid',
    } as any)
    expect(res.success).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects an unknown top-level key (zod .strict())', async () => {
    const res = await mod.createSavedView('View', {
      ...VALID_FILTERS,
      sneaky: 'field',
    } as any)
    expect(res.success).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects an unknown key inside period (zod .strict())', async () => {
    const res = await mod.createSavedView('View', {
      ...VALID_FILTERS,
      period: { ...VALID_FILTERS.period, sneaky: 'field' },
    } as any)
    expect(res.success).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })

  it('accepts empty filters (every field optional)', async () => {
    const res = await mod.createSavedView('View', {})
    expect(res.success).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('rejects once the per-user view limit is reached', async () => {
    count.mockResolvedValue(50)
    const res = await mod.createSavedView('One More View', VALID_FILTERS as any)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/50-view limit/)
    expect(create).not.toHaveBeenCalled()
  })

})

describe('createSavedView — the write always targets the CURRENT session org/user', () => {
  it('two different sessions land in two different orgs/users for the identical payload', async () => {
    sessionState = { activeOrganizationId: 'org-one', userId: 'user-one' }
    await mod.createSavedView('View', VALID_FILTERS as any)
    expect(create.mock.calls[0][0].data).toMatchObject({ userId: 'user-one', orgId: 'org-one' })

    create.mockClear()
    sessionState = { activeOrganizationId: 'org-two', userId: 'user-two' }
    await mod.createSavedView('View', VALID_FILTERS as any)
    expect(create.mock.calls[0][0].data).toMatchObject({ userId: 'user-two', orgId: 'org-two' })
  })
})

describe('getSavedViews', () => {
  it('lists views scoped to the session org/user', async () => {
    findMany.mockResolvedValue([])
    const res = await mod.getSavedViews()
    expect(res.success).toBe(true)
    expect(findMany.mock.calls[0][0].where).toEqual({ userId: USER, orgId: ORG })
  })
})

describe('deleteSavedView', () => {
  it('deletes scoped to id + session org/user, and is idempotent on a no-op delete', async () => {
    deleteMany.mockResolvedValue({ count: 0 })
    const res = await mod.deleteSavedView('view-1')
    expect(res.success).toBe(true)
    expect(deleteMany.mock.calls[0][0].where).toEqual({
      id: 'view-1',
      userId: USER,
      orgId: ORG,
    })
  })

})

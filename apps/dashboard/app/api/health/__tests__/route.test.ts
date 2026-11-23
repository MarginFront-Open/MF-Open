const queryRaw = jest.fn()
const prismaClientConstructor = jest.fn()

jest.mock('@/app/lib/db', () => ({
  db: {
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
  },
}))

jest.mock('@prisma/client', () => ({
  PrismaClient: class MockPrismaClient {
    constructor(...args: unknown[]) {
      prismaClientConstructor(...args)
    }
  },
}))

import { GET } from '../route'

describe('GET /api/health', () => {
  beforeEach(() => {
    queryRaw.mockReset()
    prismaClientConstructor.mockReset()
  })

  it('returns 200 { status: "ok" } via the shared db client without instantiating PrismaClient', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }])

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ status: 'ok' })
    expect(queryRaw).toHaveBeenCalledTimes(1)
    expect(prismaClientConstructor).not.toHaveBeenCalled()
  })

  it('returns 500 { status: "error" } with zero leaked error details when $queryRaw rejects', async () => {
    const secretErr = new Error(
      'postgres://secret:password@db-host.internal:5432/prod connection refused'
    )
    queryRaw.mockRejectedValue(secretErr)

    const res = await GET()
    const rawText = await res.text()
    const body = JSON.parse(rawText)

    expect(res.status).toBe(500)
    expect(body).toEqual({ status: 'error' })
    expect(rawText).not.toContain('postgres')
    expect(rawText).not.toContain('secret')
    expect(rawText).not.toContain('db-host')
    expect(rawText).not.toContain('connection refused')
    expect(prismaClientConstructor).not.toHaveBeenCalled()
  })
})

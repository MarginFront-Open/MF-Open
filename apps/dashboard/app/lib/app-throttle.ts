import { createHash } from 'crypto'

/**
 * Fixed-window request counter backed by the Postgres `app_throttle` table, so
 * the count is shared by every server instance (an in-memory counter resets on
 * each serverless cold start and is per-instance).
 *
 * Each step is a single conditional write, so two requests racing for the last
 * slot cannot both get it.
 */

export interface ThrottleLimit {
  max: number
  windowMs: number
}

type ThrottleWriteResult = { count: number }

export interface ThrottleStore {
  app_throttle: {
    updateMany(args: {
      where: Record<string, unknown>
      data: Record<string, unknown>
    }): Promise<ThrottleWriteResult>
    create(args: { data: Record<string, unknown> }): Promise<unknown>
    deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>
  }
}

const UNIQUE_VIOLATION = 'P2002'

// Every limit that uses this table has a window of an hour or less, so a row
// untouched for a day can never affect a decision again.
const STALE_ROW_AGE_MS = 24 * 60 * 60 * 1000
const SWEEP_INTERVAL_MS = 60 * 60 * 1000
let lastSweepAt = 0

/**
 * A new row is written for every key never seen before, and a caller can make
 * up keys (see clientIpFromHeaders), so without this the table only grows.
 * A failed sweep is ignored: it must never turn away a real request.
 */
async function sweepStaleRows(store: ThrottleStore, now: Date): Promise<void> {
  if (now.getTime() - lastSweepAt < SWEEP_INTERVAL_MS) return
  lastSweepAt = now.getTime()
  try {
    await store.app_throttle.deleteMany({
      where: { lastEventAt: { lt: new Date(now.getTime() - STALE_ROW_AGE_MS) } },
    })
  } catch {
    lastSweepAt = 0
  }
}

export function resetThrottleSweepForTests(): void {
  lastSweepAt = 0
}

/**
 * Counts one request against `key`. Returns true when the request is within
 * the limit, false when the caller should be turned away.
 */
export async function consumeThrottle(
  store: ThrottleStore,
  key: string,
  limit: ThrottleLimit,
  now: Date = new Date()
): Promise<boolean> {
  const windowFloor = new Date(now.getTime() - limit.windowMs)

  const counted = await store.app_throttle.updateMany({
    where: {
      key,
      windowStart: { gt: windowFloor },
      count: { lt: limit.max },
    },
    data: { count: { increment: 1 }, lastEventAt: now },
  })
  if (counted.count === 1) return true

  const restarted = await store.app_throttle.updateMany({
    where: { key, windowStart: { lte: windowFloor } },
    data: { count: 1, windowStart: now, lastEventAt: now },
  })
  if (restarted.count === 1) return true

  try {
    await store.app_throttle.create({
      data: { key, count: 1, windowStart: now, lastEventAt: now },
    })
    await sweepStaleRows(store, now)
    return true
  } catch (error) {
    // The row already exists and is inside its window at the limit (or another
    // request created it a moment ago). Either way this request is over.
    if ((error as { code?: string })?.code === UNIQUE_VIOLATION) return false
    throw error
  }
}

/**
 * Builds a throttle key from a caller-supplied value (an email address, say)
 * without storing that value: the key column holds a hash, never the address.
 */
export function throttleKey(scope: string, value: string): string {
  const digest = createHash('sha256').update(value).digest('hex')
  return `${scope}:${digest}`
}

type HeaderReader = { get(name: string): string | null }

/**
 * The caller's address as the reverse proxy reported it. This is only as
 * trustworthy as the proxy: it must overwrite X-Forwarded-For with the real
 * client address (Vercel and most hosting platforms do). Behind a proxy that
 * appends instead, or with no proxy, the caller writes this value, so limits
 * keyed on it can be dodged; limits keyed on something else still hold.
 */
export function clientIpFromHeaders(headers: HeaderReader): string {
  return (
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    headers.get('x-real-ip')?.trim() ||
    'unknown'
  )
}

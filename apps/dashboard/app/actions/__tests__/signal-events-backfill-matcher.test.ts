/**
 * WHAT THIS FILE DOES: Locks the case-insensitive matcher — the dashboard's
 *   `mapModelAndBackfill` AND `fillMissingVolume` children queries match
 *   model / modelProvider case-insensitively, mirroring the api-nest
 *   `mapModel` matcher. Children store the RAW ingest casing ("WebSearch")
 *   while mapping inputs are normalized lowercase ("websearch"), so bare
 *   equality would match 0 rows and the whole run would silently no-op while
 *   the UI reported success.
 *
 * WHY IT IS A SOURCE-ASSERTION TEST: same reasoning as the cache
 *   tests in this directory — `mapModelAndBackfill` hits Prisma + auth inside
 *   a $transaction and won't run under the node-only jest harness. A mocked
 *   findMany can't prove case-insensitivity either (`mode: 'insensitive'` is
 *   executed by Postgres, not by JS), so the honest pin is the where-clause
 *   shape itself. The behavioral proof needs a real database: a mis-cased
 *   mapping must find and price its events.
 *
 * CONNECTS TO: ../signal-events.ts (mapModelAndBackfill) and
 *   apps/api-nest/src/modules/signal-events/signal-events.service.ts
 *   (the insensitive matcher this one mirrors — keep in lockstep).
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const actionSource = readFileSync(
  join(__dirname, '../signal-events.ts'),
  'utf8'
)

// Each queue gets its own anchored pins so a fault in one matcher
// can't hide behind the still-correct twin elsewhere in the file.
describe('cost-backfill matcher is case-insensitive', () => {
  it('matches child model and modelProvider case-insensitively', () => {
    expect(actionSource).toMatch(
      /eventStatus: 'NEEDS_COST_BACKFILL',\s*\n\s*model: \{ equals: normalizedModel, mode: 'insensitive' \},\s*\n\s*modelProvider: \{ equals: normalizedProvider, mode: 'insensitive' \}/
    )
  })

  it('never regresses to bare equality on the NEEDS_COST_BACKFILL query', () => {
    expect(actionSource).not.toMatch(
      /eventStatus: 'NEEDS_COST_BACKFILL',\s*\n\s*model: normalizedModel/
    )
  })
})

describe('fill-volume matcher is case-insensitive', () => {
  it('matches child model and modelProvider case-insensitively', () => {
    expect(actionSource).toMatch(
      /eventStatus: 'MISSING_VOLUME_DATA',\s*\n\s*model: \{ equals: normalizedModel, mode: 'insensitive' \},\s*\n\s*modelProvider: \{ equals: normalizedProvider, mode: 'insensitive' \}/
    )
  })

  it('never regresses to bare equality on the MISSING_VOLUME_DATA query', () => {
    expect(actionSource).not.toMatch(
      /eventStatus: 'MISSING_VOLUME_DATA',\s*\n\s*model: normalizedModel/
    )
  })
})

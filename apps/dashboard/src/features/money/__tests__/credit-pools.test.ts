/**
 * The dashboard half of credit-pool visibility.
 *
 * The dashboard jest harness is node-only with NO React Testing Library (the
 * pages reach @dnd-kit through TileGrid and can't be imported here), so the
 * component facts are SOURCE-ASSERTED — the finops/build page-composition
 * tests are the pattern. The pure selection helpers run for real.
 *
 * What this pins, each failure-capable:
 *   1. Selection: the 20% near-empty band, exhausted at or past zero, and
 *      paused pools LISTED (never filtered out).
 *   2. Read parity: the server actions read the SHARED @marginfront/db balance
 *      canon. If either grows its own Prisma aggregation, the dashboard and
 *      GET /v1/credit-balances start disagreeing and this goes red.
 *   3. Write posture: both writes forward the session cookie to the role-gated
 *      api-nest endpoints. Neither touches
 *      Prisma — one enforcement path, no side doors.
 *   4. The needs-attention third section is fed by the balance canon, NEVER by
 *      raw_ingest_events, and its copy says working-as-designed, not error.
 *   5. The shared alert-list tile has no credit-pool logic: the item is a
 *      plain AlertListItem appended at ONE call site, never folded into
 *      composeNeedsAttention (whose output is byte-pinned elsewhere).
 *   6. Customer-facing credit-pool copy carries zero em dashes.
 *   7. Every credit-pool tooltip teaches BOTH halves of the alignment rule:
 *      what the number means AND the programmatic read of the same number.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import {
  NEAR_EMPTY_PERCENT,
  isPoolExhausted,
  isPoolNearEmpty,
  type CreditPoolBalanceView,
} from '../credit-pool-types'
import {
  composeNeedsAttention,
  costBackfillItem,
  creditPoolItem,
  mismatchedSignalsItem,
} from '@/features/dashboard-shell/needs-attention'
import { tooltipDefinitions } from '@/lib/tooltip-definitions'

const APP_DIR = join(__dirname, '..', '..', '..', '..', 'app')
const SRC_DIR = join(__dirname, '..', '..', '..')

const actionsSrc = readFileSync(
  join(APP_DIR, 'actions', 'credit-pools.ts'),
  'utf8'
)
const needsAttentionPageSrc = readFileSync(
  join(APP_DIR, '(dashboard)', 'metrics-events', 'needs-attention', 'page.tsx'),
  'utf8'
)
const alertListSrc = readFileSync(
  join(SRC_DIR, 'features', 'dashboard-shell', 'tiles', 'alert-list.tsx'),
  'utf8'
)
const dialogSrc = readFileSync(
  join(
    SRC_DIR,
    'features',
    'money',
    'components',
    'credit-pool-resolve-dialog.tsx'
  ),
  'utf8'
)
const sectionSrc = readFileSync(
  join(SRC_DIR, 'features', 'money', 'components', 'credit-pools-section.tsx'),
  'utf8'
)
const plansTabSrc = readFileSync(
  join(SRC_DIR, 'features', 'money', 'components', 'money-plans-tab.tsx'),
  'utf8'
)
const moneyIndexSrc = readFileSync(
  join(SRC_DIR, 'features', 'money', 'index.tsx'),
  'utf8'
)

function pool(
  over: Partial<CreditPoolBalanceView> = {}
): CreditPoolBalanceView {
  return {
    subscriptionId: 'sub-1',
    subscriptionName: 'Acme pooled plan',
    customerId: 'cust-1',
    customerName: 'Acme',
    customerExternalId: 'acme-ext',
    agentId: 'agent-1',
    planId: 'plan-1',
    planName: 'Pooled',
    poolSizeUnits: 5000,
    consumedUnits: 1000,
    remainingUnits: 4000,
    overageInProgressUnits: 0,
    remainingPercent: 80,
    overageRatePerUnit: 0.03,
    periodStartMs: Date.parse('2026-07-01T00:00:00.000Z'),
    periodEndMs: Date.parse('2026-08-01T00:00:00.000Z'),
    alertsPaused: false,
    noActivePeriod: false,
    implicitFullPool: false,
    ...over,
  }
}

describe('credit-pool selection', () => {
  it('the near-empty band is 20 percent', () => {
    expect(NEAR_EMPTY_PERCENT).toBe(20)
  })

  it('exhausted means at or past zero, never merely low', () => {
    expect(
      isPoolExhausted(pool({ remainingUnits: 0, remainingPercent: 0 }))
    ).toBe(true)
    expect(
      isPoolExhausted(pool({ remainingUnits: -300, remainingPercent: -6 }))
    ).toBe(true)
    expect(
      isPoolExhausted(pool({ remainingUnits: 1, remainingPercent: 0.02 }))
    ).toBe(false)
  })

  it('near-empty is under 20 percent with units still left', () => {
    expect(
      isPoolNearEmpty(pool({ remainingUnits: 100, remainingPercent: 2 }))
    ).toBe(true)
    expect(
      isPoolNearEmpty(pool({ remainingUnits: 999, remainingPercent: 19.98 }))
    ).toBe(true)
    // Exactly 20 percent is still healthy — the band is "under".
    expect(
      isPoolNearEmpty(pool({ remainingUnits: 1000, remainingPercent: 20 }))
    ).toBe(false)
    // Already exhausted is a different label, not "near empty".
    expect(
      isPoolNearEmpty(pool({ remainingUnits: 0, remainingPercent: 0 }))
    ).toBe(false)
  })

  it('a paused pool is still selected — pausing changes emails, not the number', () => {
    const paused = pool({
      remainingUnits: 0,
      remainingPercent: 0,
      alertsPaused: true,
    })
    expect(isPoolExhausted(paused)).toBe(true)
  })
})

describe('server actions read the ONE shared balance canon (read parity)', () => {
  it('imports getCreditBalances from @marginfront/db', () => {
    expect(actionsSrc).toMatch(
      /import \{[^}]*getCreditBalances[^}]*\} from '@marginfront\/db'/
    )
  })

  it('never re-implements the pool math with its own aggregation', () => {
    expect(actionsSrc).not.toMatch(/credit_grants/)
    expect(actionsSrc).not.toMatch(/credit_ledger_entries/)
    expect(actionsSrc).not.toMatch(/\.aggregate\(/)
  })

  it('getExhaustedCreditPools narrows with the shared 20 percent band', () => {
    expect(actionsSrc).toMatch(/belowPercent: NEAR_EMPTY_PERCENT/)
  })
})

describe('write posture — one enforcement path, no side doors', () => {
  it('both writes forward the caller cookie to api-nest, never touch Prisma', () => {
    expect(actionsSrc).toMatch(/Cookie: cookieHeader/)
    expect(actionsSrc).toMatch(/credit-topup/)
    expect(actionsSrc).toMatch(/credit-alerts-pause/)
    // The only prisma reads in this file are the org/role lookups the reads
    // need; no write path may reach a Prisma mutation.
    expect(actionsSrc).not.toMatch(/prisma\.\w+\.(create|update|upsert|delete)/)
  })

  it('every write is role-checked before forwarding', () => {
    expect(actionsSrc).toMatch(/MANAGE_MONEY_ROLES/)
    expect(actionsSrc).toMatch(
      /if \(!ctx\.canManage\) return \{ ok: false, error: whoCanChangeLine\(\) \}/
    )
  })

  it('mints an idempotency key so a double-click cannot double-credit', () => {
    expect(actionsSrc).toMatch(
      /idempotencyKey: input\.idempotencyKey \?\? randomUUID\(\)/
    )
  })

  it('pause sends explicit state, never a toggle', () => {
    expect(actionsSrc).toMatch(/\{ paused: input\.paused \}/)
  })
})

describe('needs-attention third section', () => {
  it('is fed by the balance canon action, never by an ingest-event query', () => {
    expect(needsAttentionPageSrc).toMatch(
      /import \{ getExhaustedCreditPools \} from '@\/app\/actions\/credit-pools'/
    )
    // The rows render balance fields, so no event status can ever decide
    // whether a pool "needs attention".
    expect(needsAttentionPageSrc).toMatch(/pool\.remainingUnits/)
    expect(actionsSrc).not.toMatch(/prisma\.(raw_ingest_events|signal_events)/)
  })

  it('reads as working-as-designed, not as an error', () => {
    expect(needsAttentionPageSrc).toMatch(/Working as designed/)
    expect(needsAttentionPageSrc).toMatch(/nothing is blocked/i)
  })

  it('opens the SAME resolve dialog the Money Plans section opens', () => {
    expect(needsAttentionPageSrc).toMatch(
      /import \{ CreditPoolResolveDialog \} from '@\/features\/money\/components\/credit-pool-resolve-dialog'/
    )
    expect(sectionSrc).toMatch(
      /import \{ CreditPoolResolveDialog \} from '\.\/credit-pool-resolve-dialog'/
    )
  })

  it('the section carries the three resolutions: top up, pause/resume, open the plan', () => {
    expect(dialogSrc).toMatch(/topUpCreditPool/)
    expect(dialogSrc).toMatch(/setCreditAlertsPaused/)
    expect(dialogSrc).toMatch(/Open the subscription/)
    expect(dialogSrc).toMatch(/Resume alerts/)
  })

  it('gates the resolutions on the money seat rather than hiding the numbers', () => {
    expect(dialogSrc).toMatch(/permission\.canManage/)
    expect(dialogSrc).toMatch(/permission\.whoCanChange/)
  })
})

describe('the shared alert-list tile stays untouched', () => {
  it('knows nothing about credit pools — it is presentational, four surfaces', () => {
    expect(alertListSrc).not.toMatch(/credit/i)
  })

  it('the credit-pool item is NOT folded into composeNeedsAttention', () => {
    // The byte-identical pin: Money/Overview output is exactly the two
    // composeNeedsAttention builders, whatever else the page appends afterwards.
    expect(
      composeNeedsAttention({
        mismatchedCount: 3,
        backfillModelCount: 2,
        backfillTotalEvents: 7,
      })
    ).toEqual([mismatchedSignalsItem(3), costBackfillItem(2, 7)])
  })

  it('renders as a plain AlertListItem pointing at the credit-pool tab', () => {
    expect(creditPoolItem(2)).toEqual({
      severity: 'amber',
      text: '2 credit pools are running low',
      href: '/metrics-events/needs-attention?tab=credit-pools',
    })
    expect(creditPoolItem(1).text).toBe('1 credit pool is running low')
  })

  it('is amber, not red — an empty pool blocks nothing', () => {
    expect(creditPoolItem(5).severity).toBe('amber')
  })

  // Money renders the SAME row MF IQ does. An href override here
  // is how the two surfaces silently land on different tabs.
  it("Money's row inherits the tab contract — the builder is pushed unmodified", () => {
    expect(moneyIndexSrc).toMatch(
      /items\.push\(creditPoolItem\(creditPools\.data\.pools\.length\)\)/
    )
    expect(moneyIndexSrc).not.toMatch(/\.\.\.creditPoolItem\(/)
    expect(creditPoolItem(2).href).toBe(
      '/metrics-events/needs-attention?tab=credit-pools'
    )
  })
})

describe('Credit Pools section lives inside Money then Plans', () => {
  it('is composed by the Plans tab, not registered as a new Money tab', () => {
    expect(plansTabSrc).toMatch(/<CreditPoolsSection \/>/)
    const moneyTabsSrc = readFileSync(
      join(SRC_DIR, 'features', 'money', 'money-tabs.ts'),
      'utf8'
    )
    expect(moneyTabsSrc).not.toMatch(/credit/i)
  })

  it('renders nothing when no plan sells a pool, rather than an empty table', () => {
    expect(sectionSrc).toMatch(/pools\.length === 0\) return null/)
  })
})

describe('customer-facing copy', () => {
  const copyFiles: Array<[string, string]> = [
    ['resolve dialog', dialogSrc],
    ['plans-tab section', sectionSrc],
    ['needs-attention page', needsAttentionPageSrc],
    ['server actions', actionsSrc],
  ]

  /** Prose the user reads: single-, double-, and backtick-quoted string
   * literals PLUS JSX text nodes, minus the lone em dash the whole app already
   * uses as its "no value here" glyph in table cells. Comments are excluded by
   * construction (they never reach a screen), and so are className strings,
   * which are markup rather than copy. */
  function proseLiterals(src: string): string[] {
    const withoutComments = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
    const quoted = withoutComments.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) ?? []
    // JSX text nodes: the run of characters between > and < that is not markup.
    const jsxText = withoutComments.match(/>[^<>{}]*</g) ?? []
    return [
      ...quoted.map((literal) => literal.slice(1, -1)),
      ...jsxText.map((node) => node.slice(1, -1)),
    ]
      .map((text) => text.replace(/\s+/g, ' ').trim())
      .filter((text) => text !== '' && text !== '—')
  }

  it.each(copyFiles)('%s carries zero em dashes in its copy', (_label, src) => {
    const offenders = proseLiterals(src).filter((text) => text.includes('—'))
    expect(offenders).toEqual([])
  })

  // tooltip-definitions.ts is a shared file with ~150 pre-existing entries,
  // many of which use em dashes. Scanning the whole file would fail on copy
  // this file doesn't rewrite, so the credit-pool entries are
  // checked by value instead — precise, and it cannot drift from the keys.
  it('every credit-pool tooltip is em-dash free', () => {
    const poolKeys = Object.keys(tooltipDefinitions).filter((k) =>
      k.startsWith('creditPool')
    )
    expect(poolKeys.length).toBeGreaterThanOrEqual(5)
    const offenders = poolKeys.flatMap((key) => {
      const def = tooltipDefinitions[
        key as keyof typeof tooltipDefinitions
      ] as {
        title: string
        description: string
        details?: string
      }
      return [def.title, def.description, def.details ?? '']
        .filter((text) => text.includes('—'))
        .map((text) => `${key}: ${text}`)
    })
    expect(offenders).toEqual([])
  })

  it('the dialog states the top-up truth: units up, overage unchanged', () => {
    expect(dialogSrc).toMatch(/does not reduce/)
    expect(dialogSrc).toMatch(/meter, not a switch/)
  })
})

describe('a pool that has not started never reads as drained', () => {
  it('the needs-attention selection agrees with its own classifiers', () => {
    // The canon's band is inclusive (<= 20); the classifiers read "under 20".
    // Without the post-filter a pool at EXACTLY 20% is listed and then labeled
    // as neither exhausted nor near-empty.
    const boundary = pool({ remainingUnits: 1000, remainingPercent: 20 })
    expect(isPoolExhausted(boundary) || isPoolNearEmpty(boundary)).toBe(false)
    expect(actionsSrc).toMatch(
      /\.filter\(\(p\) => isPoolExhausted\(p\) \|\| isPoolNearEmpty\(p\)\)/
    )
    expect(actionsSrc).toMatch(
      /exhaustedCount: pools\.filter\(isPoolExhausted\)/
    )
    expect(actionsSrc).toMatch(
      /nearEmptyCount: pools\.filter\(isPoolNearEmpty\)/
    )
  })

  it('every countdown surface renders a not-started state instead of zeros', () => {
    // Section, customer-detail column, subscription readout, and dialog all
    // branch on noActivePeriod before showing a number.
    expect(sectionSrc).toMatch(/pool\.noActivePeriod\s*\?\s*'—'/)
    expect(sectionSrc).toMatch(
      /!pool\.noActivePeriod && pool\.remainingUnits <= 0/
    )
    expect(dialogSrc).toMatch(/pool\.noActivePeriod\s*\?\s*'Not started'/)
    expect(dialogSrc).toMatch(/has not started counting down yet/)

    const customerPageSrc = readFileSync(
      join(APP_DIR, '(dashboard)', 'customers', '[customerId]', 'page.tsx'),
      'utf8'
    )
    expect(customerPageSrc).toMatch(/pool\.noActivePeriod/)
    expect(customerPageSrc).toMatch(/Not started/)

    const subscriptionPageSrc = readFileSync(
      join(
        APP_DIR,
        '(dashboard)',
        'subscriptions',
        '[subscriptionId]',
        'page.tsx'
      ),
      'utf8'
    )
    expect(subscriptionPageSrc).toMatch(
      /creditPool\.noActivePeriod\s*\?\s*'Not started'/
    )
  })
})

describe('the top-up key survives a retry', () => {
  it('is minted once per intent, held across failures, reset on success', () => {
    // A network timeout after the server wrote the grant must replay the SAME
    // key, or the retry adds the units twice.
    expect(dialogSrc).toMatch(/useState\(\(\) => crypto\.randomUUID\(\)\)/)
    expect(dialogSrc).toMatch(/idempotencyKey: topUpKey/)
    // Exactly ONE explicit reset: the completed top-up. Anything more would
    // mean a code path is throwing the retry guarantee away.
    expect(
      dialogSrc.match(/setTopUpKey\(crypto\.randomUUID\(\)\)/g)
    ).toHaveLength(1)
  })

  it('a different pool gets a new key by REMOUNT, never by a reset effect', () => {
    // The pool-change reset is a keyed remount, so the key (and every other
    // form field) is fresh by construction. A setState-in-effect reset would
    // cascade renders.
    expect(dialogSrc).toMatch(/key=\{pool\.subscriptionId\}/)
    expect(dialogSrc).not.toMatch(/useEffect/)
  })

  it('is NOT reset on the error path, which is the whole point', () => {
    const errorBranch = dialogSrc.slice(
      dialogSrc.indexOf('} else {', dialogSrc.indexOf('handleTopUp'))
    )
    expect(errorBranch.slice(0, 120)).not.toMatch(/setTopUpKey/)
  })

  it('the server action honors a caller-supplied key and mints one otherwise', () => {
    expect(actionsSrc).toMatch(
      /idempotencyKey: input\.idempotencyKey \?\? randomUUID\(\)/
    )
  })
})

describe('tooltips teach both halves of the alignment rule', () => {
  const keys = [
    'creditPools',
    'creditPoolRemaining',
    'creditPoolUsed',
    'creditPoolOverage',
    'creditPoolAlertsPaused',
    'creditPoolActions',
  ] as const

  it.each(keys)('%s names the programmatic read of the same number', (key) => {
    const def = tooltipDefinitions[key] as { details?: string }
    expect(def.details).toBeDefined()
    expect(def.details).toMatch(
      /creditBalances|credit-balances|remainingUnits|consumedUnits|overageInProgressUnits|alertsPaused/
    )
  })

  it('the countdown tooltip says nothing stops at zero', () => {
    expect(tooltipDefinitions.creditPoolRemaining.details).toMatch(
      /Nothing stops at zero/
    )
    expect(tooltipDefinitions.creditPoolRemaining.details).toMatch(
      /meter, not a breaker/
    )
  })

  it('the overage tooltip explains why a top-up does not erase it', () => {
    expect(tooltipDefinitions.creditPoolOverage.details).toMatch(
      /Top-ups deliberately do NOT reduce this/
    )
  })

  it('the pool tooltip names the credit-balances endpoint and no hosted docs site', () => {
    expect(tooltipDefinitions.creditPools.details).toContain(
      'GET /v1/credit-balances'
    )
    expect(tooltipDefinitions.creditPools.details).not.toContain(
      'marginfront.com'
    )
  })
})

// These pins hold exact copy. Change the source and the pins together.
describe('resolve actions explain themselves', () => {
  it('the Actions column header carries the creditPoolActions tooltip', () => {
    expect(sectionSrc).toMatch(
      /Actions\s*<InfoTooltip \{\.\.\.tooltipDefinitions\.creditPoolActions\}/
    )
  })

  it('pins the actions tooltip copy', () => {
    expect(tooltipDefinitions.creditPoolActions.title).toBe('Top up or pause')
    expect(tooltipDefinitions.creditPoolActions.description).toBe(
      "Top up adds prepaid units your customer bought (or a credit you're giving them). The countdown and alerts update. The invoice doesn't change."
    )
    expect(tooltipDefinitions.creditPoolActions.details).toContain(
      'Pause stops the warning emails for this subscription only; tracking and billing keep running.'
    )
  })

  it('the dialog explains the top-up under the units input', () => {
    // Whitespace-collapsed so prettier's JSX re-wrapping can't loosen the pin.
    const flatDialogSrc = dialogSrc.replace(/\s+/g, ' ')
    expect(flatDialogSrc).toContain(
      'Adds units to this pool&apos;s balance. Nothing is billed from here. If you charged your customer for the refill, record it in the note so you have the paper trail. Usage past the plan&apos;s included pool still bills at the overage rate.'
    )
  })

  it('the dialog explains pause and resume by state', () => {
    expect(dialogSrc).toContain(
      'Stops the warning emails for this subscription only. Usage tracking and invoicing continue unchanged. Your customer never receives these emails either way.'
    )
    expect(dialogSrc).toContain(
      'Turns the warning emails back on for this subscription.'
    )
  })
})

// The dialog's numbers refresh with the pool, not just its alerts
// flag. Both parents hold the subscription ID and derive the open row from the
// list they just refetched. Holding the row object would freeze every figure
// at click time, so a top-up would report units added above a stale balance.
describe('the open pool is derived from the refreshed list', () => {
  it('Money -> Plans holds an ID and looks the row up in the live list', () => {
    expect(sectionSrc).toMatch(/useState<string \| null>\(null\)/)
    expect(sectionSrc).toMatch(
      /pools\.find\(\(pool\) => pool\.subscriptionId === selectedId\)/
    )
    expect(sectionSrc).toContain('setSelectedId(pool.subscriptionId)')
  })

  it('the needs-attention page derives its open row the same way', () => {
    expect(needsAttentionPageSrc).toMatch(
      /creditPools\.find\(\(pool\) => pool\.subscriptionId === resolvingPoolId\)/
    )
    expect(needsAttentionPageSrc).toContain(
      'setResolvingPoolId(pool.subscriptionId)'
    )
  })

  it('neither parent stores a frozen row object', () => {
    expect(sectionSrc).not.toMatch(/setSelected\(pool\)/)
    expect(needsAttentionPageSrc).not.toMatch(/setResolvingPool\(pool\)/)
  })
})

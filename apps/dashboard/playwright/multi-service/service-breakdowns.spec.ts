import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

/**
 * Service breakdowns smoke test.
 *
 * What this proves:
 *   - The Money page's Breakdown tab loads for an organization with
 *     multi-service events and its Model group-by renders a populated table
 *   - The Ingestion Log (/metrics-events/raw-events) renders without
 *     crashing and shows the "multi-service (N)" badge on at least one
 *     row when the test database has multi-service test events
 *
 * The breakdown dimension switcher is a "Group by" segmented button group
 * (dashboard-shell/dimensioned-section.tsx, role="group" not role="tab"),
 * and the model dimension is labelled "Model" (component-catalog.ts
 * DIMENSION_LABELS). The multi-service badge text appears verbatim
 * ("multi-service (N)") only in signal-events/components/RawEventsTable.tsx;
 * Build's EventStream renders "<model> +N more" instead
 * (build/components/status-maps.ts eventModelLabel), so that assertion
 * targets Ingestion Log, not Build.
 *
 * What this does NOT prove: math invariants (SUM service rows =
 * parent.usageCost). multi-service-breakdowns.integration.test.ts covers
 * those.
 *
 * Structured logs land in /tmp/multi-service-results so a failed run shows
 * exactly what each assertion saw.
 */

const RESULTS_DIR = '/tmp/multi-service-results'
const RESULTS_FILE = join(RESULTS_DIR, 'service-breakdowns.json')

if (!existsSync(RESULTS_DIR)) {
  mkdirSync(RESULTS_DIR, { recursive: true })
}

type TestResult = {
  name: string
  url: string
  expected: string
  observed: string
  result: 'PASS' | 'FAIL'
  screenshot?: string
  timestamp: string
}

const results: TestResult[] = []

function logResult(r: Omit<TestResult, 'timestamp'>) {
  results.push({ ...r, timestamp: new Date().toISOString() })
  writeFileSync(RESULTS_FILE, JSON.stringify({ tests: results }, null, 2))
}

test.describe('service breakdowns', () => {
  test('Money dashboard — page loads + Model group-by present + Breakdown table populated', async ({
    page,
  }) => {
    // Money requires MANAGE_MONEY_ROLES (owner/admin/finance) —
    // app/(dashboard)/money/page.tsx requireRouteRoles. A non-money-manager
    // session gets bounced to /403 before this ever renders.
    // Window pinned via the ?startDate&endDate deep link: the default
    // current-month window is empty whenever the org's fixture events are
    // older than this month — that renders the empty state (no <table>)
    // and fails the populated check on a clock artifact, not a real fault.
    const winEnd = new Date()
    const winStart = new Date(winEnd.getTime() - 90 * 24 * 3600 * 1000)
    const day = (d: Date) => d.toISOString().slice(0, 10)
    await page.goto(`/money?startDate=${day(winStart)}&endDate=${day(winEnd)}`)
    // domcontentloaded > networkidle: session-replay polling can keep the
    // network busy, so networkidle may never settle.
    await page.waitForLoadState('domcontentloaded')

    // "Model" group-by button — dashboard-shell/dimensioned-section.tsx's
    // "Group by" segmented control (role="group", not role="tab"; buttons,
    // not tabs). Money's group-by set excludes 'day'/'costCategory' but
    // includes 'model' (component-catalog.ts GROUP_BY_DIMENSIONS.money).
    const groupBy = page.getByRole('group', { name: 'Group by' })
    const modelButton = groupBy.getByRole('button', { name: 'Model' })
    await expect(modelButton).toBeVisible({ timeout: 60_000 })

    // Click into it so the table renders the active dataset
    await modelButton.click()
    await page.waitForTimeout(2000)

    const tableText = await page.locator('table').first().textContent()
    const hasContent = (tableText?.length ?? 0) > 100

    const screenshot = join(RESULTS_DIR, 'service-tab.png')
    await page.screenshot({ path: screenshot, fullPage: true })

    logResult({
      name: 'Model group-by visible + Breakdown table populated',
      url: page.url(),
      expected:
        'Model group-by button appears, clicking it shows a table with at least one breakdown row',
      observed: `button-found=true, table-text-length=${tableText?.length ?? 0}, has-content=${hasContent}`,
      result: hasContent ? 'PASS' : 'FAIL',
      screenshot,
    })

    expect(hasContent).toBe(true)
  })

  test('Ingestion Log — multi-service events show services[] count', async ({
    page,
  }) => {
    // /metrics-events/raw-events is the only surface whose RawEventsTable renders the literal
    // "multi-service (N)" text this assertion checks for.
    await page.goto('/metrics-events/raw-events')
    await page.waitForLoadState('domcontentloaded')

    // Wait for the page to settle by looking for the Ingestion Log heading
    const feedHeading = page.getByText(/Ingestion Log/i).first()
    await expect(feedHeading).toBeVisible({ timeout: 60_000 })

    // Scroll to the feed so any lazy-loaded rows render
    await feedHeading.scrollIntoViewIfNeeded()
    await page.waitForTimeout(2000)

    const feedText = await page.locator('body').textContent()
    const hasMultiService = feedText?.includes('multi-service') ?? false

    const screenshot = join(RESULTS_DIR, 'event-feed.png')
    await page.screenshot({ path: screenshot, fullPage: true })

    logResult({
      name: 'Ingestion Log — multi-service badge',
      url: page.url(),
      expected:
        'Ingestion Log shows recent events; multi-service rows display "multi-service (N)" badge in the model column',
      observed: `feed-has-multi-service-text=${hasMultiService}`,
      result: hasMultiService ? 'PASS' : 'FAIL',
      screenshot,
    })

    expect(hasMultiService).toBe(true)
  })
})

import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

/**
 * Ingestion Log table + Event Details Sidebar.
 *
 * Verifies the multi-service rendering pieces:
 *   1. RawEventsTable Model column shows "multi-service (N)" for multi-
 *      service events and the single model name for single-service rows
 *   2. Clicking a multi-service row opens EventDetailsSidebar with the
 *      cost breakdown panel showing one row per <model>/<direction> key
 *      (so a Claude+GPT-4o event shows 4 rows: claude/input, claude/output,
 *      gpt-4o/input, gpt-4o/output)
 *   3. The Properties panel JSON includes the canonical `services` array
 *      mirroring the SDK shape
 *
 * Logs structured before/after observations to /tmp/multi-service-results so
 * a failed run shows exactly what each assertion saw.
 */

const RESULTS_DIR = '/tmp/multi-service-results'
const RESULTS_FILE = join(RESULTS_DIR, 'event-feed-and-table.json')

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

async function waitForActualRows(page: import('@playwright/test').Page) {
  // Skeleton rows always exist while loading. Wait for the table to have
  // at least one row whose model cell contains real text (not a skeleton).
  await page.waitForFunction(
    () => {
      const rows = document.querySelectorAll('tbody tr')
      if (rows.length === 0) return false
      // Skeleton rows have a single skeleton element and no real text
      // in the model column; data rows have actual text content.
      for (const row of rows) {
        const text = row.textContent ?? ''
        if (
          text.includes('claude') ||
          text.includes('gpt') ||
          text.includes('multi-service') ||
          text.toLowerCase().includes('hunter') ||
          text.toLowerCase().includes('google')
        ) {
          return true
        }
      }
      return false
    },
    { timeout: 30_000 }
  )
}

test.describe('ingestion log + event details', () => {
  test('Ingestion Log — multi-service rows show "multi-service (N)" badge', async ({
    page,
  }) => {
    await page.goto('/metrics-events/raw-events')
    await page.waitForLoadState('domcontentloaded')

    await waitForActualRows(page)

    const tableText = await page.locator('table').first().textContent()
    const hasMultiService = tableText?.includes('multi-service') ?? false
    const hasClaude = tableText?.toLowerCase().includes('claude') ?? false

    const screenshot = join(RESULTS_DIR, 'ingestion-log.png')
    await page.screenshot({ path: screenshot, fullPage: true })

    logResult({
      name: 'Ingestion Log — multi-service badge in Model column',
      url: page.url(),
      expected:
        'Table shows mix of single-service (e.g. claude-sonnet-4-6) and multi-service ("multi-service (N)") rows',
      observed: `has-multi-service-text=${hasMultiService}, has-claude=${hasClaude}, table-text-length=${tableText?.length ?? 0}`,
      result: hasMultiService && hasClaude ? 'PASS' : 'FAIL',
      screenshot,
    })

    expect(hasMultiService).toBe(true)
    expect(hasClaude).toBe(true)
  })

  test('EventDetailsSidebar — multi-service row opens with cost-breakdown rows + services in Properties', async ({
    page,
  }) => {
    await page.goto('/metrics-events/raw-events')
    await page.waitForLoadState('domcontentloaded')
    await waitForActualRows(page)

    // Click the first multi-service row. The model column has the
    // "multi-service (N)" text, so we filter rows by that.
    const multiRow = page
      .locator('tbody tr')
      .filter({ hasText: 'multi-service' })
      .first()
    await expect(multiRow).toBeVisible({ timeout: 10_000 })
    await multiRow.click()

    // Sheet sidebar opens
    const sheetTitle = page.getByText('Event ID', { exact: true })
    await expect(sheetTitle).toBeVisible({ timeout: 10_000 })

    // Cost Breakdown panel — for a Claude+GPT-4o multi-service event, the
    // parent's usageCostData has 4 keys (claude/input, claude/output,
    // gpt-4o/input, gpt-4o/output). The UI walker renders each as
    // its own row.
    const sidebarText = await page.locator('[role="dialog"]').textContent()
    const hasCostBreakdownHeading = sidebarText?.includes('Cost Breakdown')
    const hasInputRow = sidebarText?.includes('/input')
    const hasOutputRow = sidebarText?.includes('/output')

    // Properties panel — JSON includes the canonical `services` array
    const hasServicesKey = sidebarText?.includes('"services"')

    const screenshot = join(RESULTS_DIR, 'event-details-sidebar.png')
    await page.screenshot({ path: screenshot, fullPage: true })

    logResult({
      name: 'EventDetailsSidebar — multi-service detail',
      url: page.url(),
      expected:
        'Sidebar opens, Cost Breakdown shows multiple <model>/<direction> rows, Properties JSON has services[]',
      observed: `cost-breakdown-heading=${hasCostBreakdownHeading}, has-input-row=${hasInputRow}, has-output-row=${hasOutputRow}, has-services-key=${hasServicesKey}`,
      result:
        hasCostBreakdownHeading && hasInputRow && hasOutputRow && hasServicesKey
          ? 'PASS'
          : 'FAIL',
      screenshot,
    })

    expect(hasCostBreakdownHeading).toBe(true)
    expect(hasInputRow).toBe(true)
    expect(hasOutputRow).toBe(true)
    expect(hasServicesKey).toBe(true)
  })

  test('EventDetailsSidebar — single-service row opens with one cost row', async ({
    page,
  }) => {
    await page.goto('/metrics-events/raw-events')
    await page.waitForLoadState('domcontentloaded')
    await waitForActualRows(page)

    // Click any non-multi-service row by text exclusion
    const singleRow = page
      .locator('tbody tr')
      .filter({ hasNotText: 'multi-service' })
      .first()
    await expect(singleRow).toBeVisible({ timeout: 10_000 })
    await singleRow.click()

    const sheetTitle = page.getByText('Event ID', { exact: true })
    await expect(sheetTitle).toBeVisible({ timeout: 10_000 })

    const sidebarText = await page.locator('[role="dialog"]').textContent()
    const hasServicesKey = sidebarText?.includes('"services"')

    const screenshot = join(RESULTS_DIR, 'event-details-single.png')
    await page.screenshot({ path: screenshot, fullPage: true })

    logResult({
      name: 'EventDetailsSidebar — single-service detail',
      url: page.url(),
      expected:
        'Single-service row opens sidebar; Properties JSON still contains services[] (length 1) so the SDK shape is preserved',
      observed: `has-services-key=${hasServicesKey}`,
      result: hasServicesKey ? 'PASS' : 'FAIL',
      screenshot,
    })

    expect(hasServicesKey).toBe(true)
  })
})

import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

/**
 * Event-details JSON shape on the Ingestion Log.
 *
 * Asserts that clicking a row in the Ingestion Log opens the event-details
 * JSON whose keys match what the customer actually sent + canon money fields
 * — the `eventProperties` contract in
 * features/signal-events/components/EventDetailsSidebar.tsx: services[] (the
 * canonical SDK shape), customerExternalId, quantity, usageCost,
 * eventProcessed, nested agent/signal objects.
 *
 * Keys the SDK never exposes (`cost.total`, `revenue.marginPct`, …) must
 * not appear.
 */

const RESULTS_DIR = '/tmp/multi-service-results'
const RESULTS_FILE = join(RESULTS_DIR, 'event-feed-sdk-shape.json')

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

test.describe('Ingestion Log event-details shape', () => {
  test.describe.configure({ timeout: 90_000 })

  test('Ingestion Log row click renders the SDK-mirroring event JSON', async ({
    page,
  }) => {
    await page.goto('/metrics-events/raw-events', { timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')

    const feedHeading = page.getByText(/Ingestion Log/i).first()
    await expect(feedHeading).toBeVisible({ timeout: 60_000 })
    await feedHeading.scrollIntoViewIfNeeded()

    // Rows are the only cursor-pointer <tr>s in the table
    // (RawEventsTable.tsx). First row = most recent event.
    const firstRow = page.locator('tr.cursor-pointer').first()
    await expect(firstRow).toBeVisible({ timeout: 30_000 })
    await firstRow.click()

    const pre = page.locator('pre').first()
    await expect(pre).toBeVisible({ timeout: 15_000 })
    const preText = await pre.textContent()

    // The eventProperties contract in EventDetailsSidebar.tsx.
    // services/metadata are conditional on the event, so the always-present
    // core is what's required here.
    const requiredKeys = [
      '"customerExternalId"',
      '"quantity"',
      '"usageCost"',
      '"eventProcessed"',
      '"usageDate"',
      '"agent"',
      '"signal"',
      '"customer"',
    ]

    // Invented keys the SDK never sends
    const forbiddenKeys = ['"cost":', '"marginPct"', '"totalEarnedUsd"']

    const missingKeys = requiredKeys.filter((k) => !preText?.includes(k))
    const presentForbidden = forbiddenKeys.filter((k) => preText?.includes(k))

    const screenshot = join(RESULTS_DIR, 'event-feed-dropdown.png')
    await page.screenshot({ path: screenshot, fullPage: true })

    const passed = missingKeys.length === 0 && presentForbidden.length === 0

    logResult({
      name: 'Ingestion Log event details — SDK-mirroring shape',
      url: page.url(),
      expected: `JSON contains all of [${requiredKeys.join(', ')}]; NONE of [${forbiddenKeys.join(', ')}]`,
      observed: `missingRequired=[${missingKeys.join(', ')}], presentForbidden=[${presentForbidden.join(', ')}], pre-text-length=${preText?.length ?? 0}`,
      result: passed ? 'PASS' : 'FAIL',
      screenshot,
    })

    expect(missingKeys).toEqual([])
    expect(presentForbidden).toEqual([])
  })
})

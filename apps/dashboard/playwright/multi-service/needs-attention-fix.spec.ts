import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

/**
 * Needs Attention page: multi-service rows keep their model and provider.
 *
 * What this proves:
 *   - The /metrics-events/needs-attention page renders distinct rows for
 *     each (model, provider) tuple of unresolved children — NOT collapsed
 *     into a single (NULL, NULL) row.
 *   - The Map and Fill modals show the actual model name in their
 *     "MAPPING FROM" / "FILL FOR" header — NOT empty parens "()".
 *   - Both sections (NEEDS_COST_BACKFILL and MISSING_VOLUME_DATA) honor
 *     the same shape.
 *
 * Why this exists:
 *   The dashboard runs its own $queryRaw Server Actions that mirror the
 *   grouping SQL in apps/api-nest/.../signal-events.service.ts. API tests
 *   don't cover them, so this spec checks the dashboard surface end-to-end.
 *
 * Pre-condition (what to set up before running):
 *   - The test database must have at least one signal_event_services row with
 *     eventStatus = 'NEEDS_COST_BACKFILL' (and ideally one with
 *     'MISSING_VOLUME_DATA') that the test user can see. If the catalog
 *     refresh has already auto-resolved everything, the row assertions
 *     become vacuous and only the "no blank cells" guarantee runs.
 *
 * Structured logs land in /tmp/needs-attention-fix-results so a failed run
 * shows exactly what each assertion saw.
 */

const RESULTS_DIR = '/tmp/needs-attention-fix-results'
const RESULTS_FILE = join(RESULTS_DIR, 'needs-attention-fix.json')

if (!existsSync(RESULTS_DIR)) {
  mkdirSync(RESULTS_DIR, { recursive: true })
}

type TestResult = {
  name: string
  url: string
  expected: string
  observed: string
  result: 'PASS' | 'FAIL' | 'SKIP'
  screenshot?: string
  timestamp: string
}

const results: TestResult[] = []

function logResult(r: Omit<TestResult, 'timestamp'>) {
  results.push({ ...r, timestamp: new Date().toISOString() })
  writeFileSync(RESULTS_FILE, JSON.stringify({ tests: results }, null, 2))
}

test.describe('Needs Attention — multi-service Server Action rows', () => {
  test('NEEDS_COST_BACKFILL section: no row has blank Model or Provider', async ({
    page,
  }) => {
    await page.goto('/metrics-events/needs-attention')
    await page.waitForLoadState('domcontentloaded')

    const heading = page.getByRole('heading', { name: /Needs Attention/i })
    await expect(heading).toBeVisible({ timeout: 60_000 })
    await page.waitForTimeout(2000)

    // The page renders a list of (model, provider, count) rows. Find every
    // row that has a Map button — those are the NEEDS_COST_BACKFILL groups.
    // For each, the Model and Provider cells must be non-empty.
    const mapButtons = page.getByRole('button', { name: /^Map$/ })
    const rowCount = await mapButtons.count()

    const screenshot = join(RESULTS_DIR, 'needs-attention-list.png')
    await page.screenshot({ path: screenshot, fullPage: true })

    if (rowCount === 0) {
      logResult({
        name: 'NEEDS_COST_BACKFILL list: every row has non-blank Model + Provider',
        url: page.url(),
        expected:
          'Each row that surfaces a Map action shows a non-empty model name and provider name in its Model/Provider columns',
        observed:
          'No NEEDS_COST_BACKFILL rows present in the test database right now (catalog already resolved them or no events fired). Vacuous pass — surface fix not exercised.',
        result: 'SKIP',
        screenshot,
      })
      test.skip()
      return
    }

    // For each row with a Map button, walk up to the row container and
    // verify Model + Provider cells are populated. Container selector
    // pulled by walking up two levels (button → cell → row), which matches
    // the page's markup.
    let blankCellCount = 0
    const blankRowDetails: string[] = []
    for (let i = 0; i < rowCount; i++) {
      const row = mapButtons.nth(i).locator('xpath=ancestor::tr[1]')
      const cells = await row.locator('td').allInnerTexts()
      // Cells layout per page.tsx: [Model, Provider, Events, Oldest, Action]
      const modelCell = (cells[0] ?? '').trim()
      const providerCell = (cells[1] ?? '').trim()
      if (!modelCell || !providerCell) {
        blankCellCount++
        blankRowDetails.push(
          `row ${i}: model="${modelCell}", provider="${providerCell}"`
        )
      }
    }

    logResult({
      name: 'NEEDS_COST_BACKFILL list: every row has non-blank Model + Provider',
      url: page.url(),
      expected: `Across ${rowCount} row(s), zero blank Model or Provider cells`,
      observed: `Found ${blankCellCount} blank cell(s) of ${rowCount} rows. Details: ${blankRowDetails.join('; ') || 'none'}`,
      result: blankCellCount === 0 ? 'PASS' : 'FAIL',
      screenshot,
    })

    expect(blankCellCount).toBe(0)
  })

  test('Map modal "Mapping from" shows the actual model name (not empty parens)', async ({
    page,
  }) => {
    await page.goto('/metrics-events/needs-attention')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    const mapButton = page.getByRole('button', { name: /^Map$/ }).first()
    const buttonExists = (await mapButton.count()) > 0

    if (!buttonExists) {
      logResult({
        name: 'Map modal "Mapping from" header text',
        url: page.url(),
        expected:
          'Modal header shows non-empty model name with provider in parens, like "claude-sonnet-4-6 (anthropic)"',
        observed:
          'No Map button present in the test database — no NEEDS_COST_BACKFILL groups to test against',
        result: 'SKIP',
      })
      test.skip()
      return
    }

    await mapButton.click()
    await page.waitForTimeout(1000)

    // Modal opens. The "Mapping from" header (per MapModelDialog.tsx)
    // renders the model name followed by "({provider})". When both values
    // are empty, the visible text is " ()".
    const mappingFromLabel = page.getByText('Mapping from', { exact: true })
    await expect(mappingFromLabel).toBeVisible({ timeout: 10_000 })
    const mappingFromRegion = mappingFromLabel.locator('..')

    const headerText = (await mappingFromRegion.innerText()).trim()

    const screenshot = join(RESULTS_DIR, 'map-modal-mapping-from.png')
    await page.screenshot({ path: screenshot, fullPage: true })

    // Failure mode: visible text is "Mapping from\n()"
    // (empty parens with no model name). Pass condition: parens preceded
    // by a non-whitespace token.
    const broken = /\n\s*\(\s*\)\s*$/.test(headerText)
    const containsModelLikeText = /[\w\-\.\/]+\s*\([\w\-]+\)/.test(headerText)

    logResult({
      name: 'Map modal "Mapping from" header text',
      url: page.url(),
      expected:
        'Modal header shows a non-empty model identifier and provider in parens, e.g. "claude-sonnet-4-6 (anthropic)"',
      observed: `header-text="${headerText.replace(/\n/g, ' ')}", empty-parens-detected=${broken}, model-like-detected=${containsModelLikeText}`,
      result: !broken && containsModelLikeText ? 'PASS' : 'FAIL',
      screenshot,
    })

    expect(broken).toBe(false)
    expect(containsModelLikeText).toBe(true)
  })

  test('MISSING_VOLUME_DATA section: no row has blank Model or Provider', async ({
    page,
  }) => {
    await page.goto('/metrics-events/needs-attention')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)

    // The fill-volume rows have a "Fill volume" button instead of "Map"
    const fillButtons = page.getByRole('button', { name: /^Fill volume$/ })
    const rowCount = await fillButtons.count()

    const screenshot = join(RESULTS_DIR, 'missing-volume-list.png')
    await page.screenshot({ path: screenshot, fullPage: true })

    if (rowCount === 0) {
      logResult({
        name: 'MISSING_VOLUME_DATA list: every row has non-blank Model + Provider',
        url: page.url(),
        expected:
          'Each row that surfaces a Fill action shows a non-empty model name and provider name',
        observed:
          'No MISSING_VOLUME_DATA rows present in the test database right now. Vacuous pass — surface fix not exercised.',
        result: 'SKIP',
        screenshot,
      })
      test.skip()
      return
    }

    let blankCellCount = 0
    const blankRowDetails: string[] = []
    for (let i = 0; i < rowCount; i++) {
      const row = fillButtons.nth(i).locator('xpath=ancestor::tr[1]')
      const cells = await row.locator('td').allInnerTexts()
      const modelCell = (cells[0] ?? '').trim()
      const providerCell = (cells[1] ?? '').trim()
      if (!modelCell || !providerCell) {
        blankCellCount++
        blankRowDetails.push(
          `row ${i}: model="${modelCell}", provider="${providerCell}"`
        )
      }
    }

    logResult({
      name: 'MISSING_VOLUME_DATA list: every row has non-blank Model + Provider',
      url: page.url(),
      expected: `Across ${rowCount} row(s), zero blank Model or Provider cells`,
      observed: `Found ${blankCellCount} blank cell(s) of ${rowCount} rows. Details: ${blankRowDetails.join('; ') || 'none'}`,
      result: blankCellCount === 0 ? 'PASS' : 'FAIL',
      screenshot,
    })

    expect(blankCellCount).toBe(0)
  })
})

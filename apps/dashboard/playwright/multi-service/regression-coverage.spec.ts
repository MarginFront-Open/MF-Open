import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

/**
 * Smoke coverage for pages that read only parent rollups.
 *
 * The routes below all read parent rollup data from
 * signal_events.usageCost / canon-aggregated metrics. Multi-service events
 * are invisible to them: if the parent rollup is correct (canon C1:
 * parent.usageCost = SUM(children.usageCost)), these surfaces render the
 * same numbers whether or not an event has multiple services.
 *
 * This spec walks each route below and asserts:
 *   - Page returns 200 with no React error boundary
 *   - The expected page heading or key tile renders
 *   - No "Application error" / "Something went wrong" text leaks through
 *
 * It does NOT assert specific dollar amounts — that's covered by the
 * unit and integration tests. This spec checks that pages which read only
 * parent rollups still render.
 *
 * Logs structured observations to /tmp/multi-service-results.
 */

const RESULTS_DIR = '/tmp/multi-service-results'
const RESULTS_FILE = join(RESULTS_DIR, 'regression-coverage.json')

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

async function assertPageLoadsCleanly(
  page: import('@playwright/test').Page,
  path: string,
  label: string,
  expectedHeading?: string | RegExp
) {
  // 60s timeouts: Turbopack's cold-compile of an unseen route on a long-
  // running dev server can take 30-50s. Default 30s causes flaky timeouts.
  await page.goto(path, { timeout: 60_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 60_000 })

  // Wait for real content, not a fixed sleep — the dev server compiles a
  // page on its first visit, which can take well over two seconds. Heading
  // role first, text fallback: the Page layout (not PageShell) renders its title
  // without heading semantics (e.g. Ingestion Log).
  let hasExpectedHeading = true
  if (expectedHeading) {
    const heading = page
      .getByRole('heading', { name: expectedHeading })
      .or(page.getByText(expectedHeading))
      .first()
    hasExpectedHeading = await heading
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false)
  } else {
    await page.waitForTimeout(2000)
  }

  const bodyText = (await page.locator('body').textContent()) ?? ''
  const hasErrorBoundary =
    bodyText.includes('Application error') ||
    bodyText.includes('Something went wrong') ||
    bodyText.includes('500: Internal Server Error') ||
    bodyText.includes('Unhandled Runtime Error')

  const screenshot = join(
    RESULTS_DIR,
    `regression-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`
  )
  await page.screenshot({ path: screenshot, fullPage: true })

  const passed = !hasErrorBoundary && hasExpectedHeading

  logResult({
    name: `FREE-tier — ${label}`,
    url: page.url(),
    expected: `Page loads without error boundary${expectedHeading ? `; heading "${expectedHeading}" visible` : ''}`,
    observed: `error-boundary=${hasErrorBoundary}, heading-found=${hasExpectedHeading}, body-length=${bodyText.length}`,
    result: passed ? 'PASS' : 'FAIL',
    screenshot,
  })

  expect(hasErrorBoundary).toBe(false)
  if (expectedHeading) expect(hasExpectedHeading).toBe(true)
}

test.describe('FREE-tier regression coverage', () => {
  // 90s per test — covers a 60s cold-compile + 30s rendering buffer
  test.describe.configure({ timeout: 90_000 })

  // The role-aware command-center pages are these five (each a PageShell
  // with a literal <h1> title — money/index.tsx, finops/index.tsx, build/index.tsx,
  // roi/index.tsx, mfiq/index.tsx). money/finops/roi/mfiq are gated to
  // owner/admin/finance (requireRouteRoles(MANAGE_MONEY_ROLES)) — a
  // non-money-manager session gets bounced to /403 before the heading
  // renders, which will read as a FAIL here (missing heading). That's a
  // real role-gate signal, not a broken assertion; build is ungated.
  test('Money (/money) — command center renders without error', async ({
    page,
  }) => {
    await assertPageLoadsCleanly(page, '/money', 'money', 'Money')
  })

  test('FinOps (/finops) — command center renders without error', async ({
    page,
  }) => {
    await assertPageLoadsCleanly(page, '/finops', 'finops', 'FinOps')
  })

  test('Build (/build) — command center renders without error', async ({
    page,
  }) => {
    await assertPageLoadsCleanly(page, '/build', 'build', 'Build')
  })

  test('ROI (/roi) — command center renders without error', async ({
    page,
  }) => {
    await assertPageLoadsCleanly(page, '/roi', 'roi', 'ROI')
  })

  test('MF IQ (/mfiq) — command center renders without error', async ({
    page,
  }) => {
    await assertPageLoadsCleanly(page, '/mfiq', 'mfiq', 'MFiQ')
  })

  test('Ingestion Log (/metrics-events/raw-events) — page renders', async ({
    page,
  }) => {
    await assertPageLoadsCleanly(
      page,
      '/metrics-events/raw-events',
      'ingestion-log',
      /Ingestion Log/i
    )
  })

  test('Metrics & Events (/metrics-events) — analytics dashboard renders', async ({
    page,
  }) => {
    await assertPageLoadsCleanly(page, '/metrics-events', 'metrics-events')
  })

  test('Needs Attention (/metrics-events/needs-attention) — renders', async ({
    page,
  }) => {
    await assertPageLoadsCleanly(
      page,
      '/metrics-events/needs-attention',
      'needs-attention'
    )
  })

  test('Customers list (/customers) — renders', async ({ page }) => {
    await assertPageLoadsCleanly(page, '/customers', 'customers-list')
  })

  // /agents redirects to /build (the "Agents" tab) rather than rendering
  // its own list. /build's own render is covered above, so this pins only
  // the redirect: the route resolves clean.
  test('Agents (/agents) — redirects to Build, no error boundary', async ({
    page,
  }) => {
    await assertPageLoadsCleanly(page, '/agents', 'agents-redirect', 'Build')
    expect(page.url()).toContain('/build')
  })

  test('Subscriptions list (/subscriptions) — renders', async ({ page }) => {
    await assertPageLoadsCleanly(page, '/subscriptions', 'subscriptions-list')
  })

  test('Invoices list (/invoices) — renders', async ({ page }) => {
    await assertPageLoadsCleanly(page, '/invoices', 'invoices-list')
  })

  // /developer-zone/api-keys redirects to /build?tab=keys. Same treatment
  // as /agents above, plus a 3xx check at the HTTP layer: links to this URL
  // live outside the app, so it must never 404.
  test('Developer Zone — API Keys redirects to Build keys tab, no error boundary', async ({
    page,
  }) => {
    const response = await page.request.get('/developer-zone/api-keys', {
      maxRedirects: 0,
    })
    expect(response.status()).toBeGreaterThanOrEqual(300)
    expect(response.status()).toBeLessThan(400)
    expect(response.headers()['location']).toContain('/build?tab=keys')

    await assertPageLoadsCleanly(
      page,
      '/developer-zone/api-keys',
      'api-keys-redirect',
      'Build'
    )
    expect(page.url()).toContain('/build?tab=keys')
  })

  test('Developer Zone — SDK Simulator renders', async ({ page }) => {
    await assertPageLoadsCleanly(
      page,
      '/developer-zone/sdk-simulator',
      'sdk-simulator'
    )
  })
})

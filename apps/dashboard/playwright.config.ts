import { defineConfig, devices } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Use an explicitly chosen installed browser. Never fall back to bundled Chromium.
const browser = process.env.MF_BROWSER ?? 'chrome'
if (browser !== 'brave' && browser !== 'chrome') {
  throw new Error('MF_BROWSER must be brave or chrome.')
}
if (browser === 'brave' && process.platform !== 'darwin') {
  throw new Error('MF_BROWSER=brave works on macOS only. Unset it to use Chrome.')
}

const launchOptions: { chromiumSandbox: boolean; executablePath?: string; ignoreDefaultArgs: string[] } = {
  chromiumSandbox: true,
  ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
}
if (process.platform === 'darwin') {
  const brave = browser === 'brave'
  const product = brave ? 'Brave Browser' : 'Google Chrome'
  const app = process.env.MF_BROWSER_APP_PATH ?? `/Applications/${product}.app`
  if (!path.isAbsolute(app) || !app.endsWith('.app')) throw new Error('MF_BROWSER_APP_PATH must be an absolute .app path.')
  const read = (key: string) => execFileSync('/usr/bin/plutil', [
    '-extract', key, 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist'),
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const minimum = brave ? '156.1.98.63' : '157.0.8103.38'
  const bundle = brave ? 'com.brave.Browser' : 'com.google.Chrome'
  const version = read('CFBundleShortVersionString')
  if (read('CFBundleIdentifier') !== bundle || !/^\d+(?:\.\d+){3}$/.test(version)) {
    throw new Error(`Expected official stable ${product} with a recognized version at ${app}.`)
  }
  const actual = version.split('.').map(Number)
  const floor = minimum.split('.').map(Number)
  const index = actual.findIndex((part, i) => part !== floor[i])
  if (index >= 0 && actual[index] < floor[index]) {
    throw new Error(`Update ${product} before running tests: found ${version}, minimum ${minimum}.`)
  }
  launchOptions.executablePath = path.join(app, 'Contents', 'MacOS', product)
  fs.accessSync(launchOptions.executablePath, fs.constants.X_OK)
} else if (process.env.MF_BROWSER_APP_PATH !== undefined) {
  throw new Error('MF_BROWSER_APP_PATH works on macOS only. Unset it on this system.')
}

/**
 * Tests live in `apps/dashboard/playwright/`. They reuse a signed-in browser
 * state saved at `~/.marginfront-playwright-state.json` (or the path in
 * PLAYWRIGHT_STORAGE_STATE), and they read the multi-service events already in
 * the organization that state signs in to.
 *
 * Structured logs land at `/tmp/multi-service-playwright-results.json` so you
 * can spot-check what each test saw without sifting through Playwright's
 * default HTML report.
 */
export default defineConfig({
  testDir: './playwright',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: '/tmp/multi-service-playwright-results.json' }],
    ['html', { outputFolder: '/tmp/multi-service-playwright-html', open: 'never' }],
  ],
  use: {
    // Maintained explicit browser, with a fresh automation profile and sandbox.
    channel: process.platform === 'darwin' ? undefined : 'chrome',
    launchOptions,
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    storageState:
      process.env.PLAYWRIGHT_STORAGE_STATE ||
      `${process.env.HOME}/.marginfront-playwright-state.json`,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})

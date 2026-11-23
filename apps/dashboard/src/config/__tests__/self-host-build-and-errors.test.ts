import { readFileSync } from 'fs'
import { join } from 'path'

const DASHBOARD = join(__dirname, '..', '..', '..')

describe('a plain build sends nothing to Sentry', () => {
  const config = readFileSync(join(DASHBOARD, 'next.config.ts'), 'utf8')
  const options = config.slice(
    config.indexOf('const sentryWebpackPluginOptions = {'),
    config.indexOf('export default withSentryConfig')
  )

  it("switches off the Sentry build plugin's own usage reporting", () => {
    expect(options).toMatch(/^\s*telemetry: false,$/m)
  })
})

describe('the missing-CRON_SECRET error on Generate Invoice', () => {
  const action = readFileSync(
    join(DASHBOARD, 'app', 'actions', 'invoices.ts'),
    'utf8'
  )

  it('says what to set and where, without naming one hosting company', () => {
    expect(action).toContain(
      'Invoice generation is off because CRON_SECRET is not set on the dashboard. Set CRON_SECRET to the same value the API uses, then restart the dashboard.'
    )
    expect(action).not.toContain('Set it in Vercel')
  })
})

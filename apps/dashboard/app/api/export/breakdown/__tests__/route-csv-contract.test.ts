import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Guards the Money "Custom CSV export…" branch of /api/export/breakdown.
 * Source-assertion (dashboard jest is node-only, no RTL; this route imports
 * next/server + Prisma-touching server actions, which is why these are text
 * assertions rather than an executed request).
 *
 * The point being locked in: the CSV path must reuse resolveMetrics — the
 * SAME server action DimensionedSection calls for the on-screen Breakdown
 * table — never a second cost/revenue query or hand-rolled math. And the
 * XLSX branch (getFullCommandCenterBreakdown) must stay reachable when
 * `format` isn't 'csv'.
 */
describe('export/breakdown route.ts — CSV branch reuses the canon resolver', () => {
  const src = readFileSync(join(__dirname, '..', 'route.ts'), 'utf8')

  it('imports resolveMetrics from the canon metrics-resolver action', () => {
    expect(src).toMatch(
      /import\s*\{\s*resolveMetrics\s*\}\s*from\s*['"]@\/app\/actions\/metrics-resolver['"]/
    )
  })

  it('calls resolveMetrics with scope "money" for the CSV branch', () => {
    expect(src).toMatch(/scope:\s*'money'/)
  })

  it('never imports getCostBreakdown or a second PrismaClient for the CSV path (all breakdown data comes from resolveMetrics)', () => {
    expect(src).not.toMatch(/getCostBreakdown/)
    // The XLSX sheet builders reach Prisma through full-command-center.ts;
    // route.ts itself never instantiates a client.
    expect(src).not.toMatch(/new PrismaClient/)
  })

  it('restricts dimension to GROUP_BY_DIMENSIONS.money (not the full 8-dimension registry — no day/costCategory)', () => {
    expect(src).toMatch(/GROUP_BY_DIMENSIONS\.money/)
  })

  it('the XLSX branch is reachable when format is not csv', () => {
    expect(src).toMatch(/getFullCommandCenterBreakdown/)
    expect(src).toMatch(/getFullCommandCenterInvoicesTab/)
    expect(src).toMatch(
      /url\.searchParams\.get\('format'\)\s*===\s*'csv'/
    )
  })

  it('the CSV response is text/csv, not the XLSX mimetype', () => {
    expect(src).toMatch(/'Content-Type':\s*'text\/csv; charset=utf-8'/)
  })
})

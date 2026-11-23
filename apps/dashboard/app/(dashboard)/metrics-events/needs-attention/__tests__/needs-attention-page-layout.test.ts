import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * /metrics-events/needs-attention is wrapped in `Page`, matching the breadcrumb
 * convention of its sibling /metrics-events/raw-events page (Home -> Usage
 * Events -> <this page>). Source-assertion, not a render test: this repo's
 * Node-only jest can't render this client component (react-query hooks), same
 * constraint as the sibling page-layout tests.
 *
 * The page splits its sections into three tabs. The resolver is unit-tested
 * for real in src/features/signal-events/__tests__/needs-attention-tabs.test.ts;
 * this file only pins that the page is wired to it and kept its pinned copy.
 */
const src = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8')

describe('NeedsAttentionPage renders through Page chrome', () => {
  it('imports Page', () => {
    expect(src).toMatch(
      /import\s*\{\s*Page\s*\}\s*from\s*['"]@\/components\/layouts\/page['"]/
    )
  })

  it("wraps the return in <Page title='Needs Attention'>", () => {
    expect(src).toMatch(/<Page\s+title='Needs Attention'/)
  })

  it('sets a Home -> Usage Events -> Needs Attention breadcrumb (matches the raw-events sibling)', () => {
    const breadcrumbIndex = src.indexOf('breadcrumb:')
    expect(breadcrumbIndex).toBeGreaterThan(-1)
    const breadcrumbBlock = src.slice(breadcrumbIndex, breadcrumbIndex + 300)
    expect(breadcrumbBlock).toMatch(/name:\s*'Home'/)
    expect(breadcrumbBlock).toMatch(/name:\s*'Usage Events'/)
    expect(breadcrumbBlock).toMatch(/href:\s*'\/metrics-events'/)
    expect(breadcrumbBlock).toMatch(/name:\s*'Needs Attention'/)
  })

  it('has no manual back-button or in-body <h1> (Page owns navigation and title)', () => {
    expect(src).not.toMatch(/<h1[^>]*>\s*Needs Attention\s*<\/h1>/)
    expect(src).not.toMatch(/ArrowLeft/)
  })

  it('keeps all three resolution flows (map-model, fill-volume, credit-pool resolve) and the shared sidebar', () => {
    expect(src).toMatch(/<MapModelDialog/)
    expect(src).toMatch(/<FillVolumeDialog/)
    expect(src).toMatch(/<CreditPoolResolveDialog/)
    expect(src).toMatch(/<EventDetailsSidebar/)
  })

  it('has the loading, error, and all-clear states', () => {
    expect(src).toMatch(/Loading backfill queue\.\.\./)
    expect(src).toMatch(/All clear/)
    expect(src).toMatch(/No events need attention right now\./)
  })
})

describe('NeedsAttentionPage tabs + ?tab= contract', () => {
  it('reuses the shared tab primitives instead of hand-rolling a tab bar', () => {
    expect(src).toMatch(
      /import\s*\{\s*Tabs,\s*TabsContent,\s*TabsList,\s*TabsTrigger\s*\}\s*from\s*'@\/components\/ui\/tabs'/
    )
  })

  it('drives the tab bar off the shared registry (the contract deep links rely on)', () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bNEEDS_ATTENTION_TABS\b[^}]*\bresolveNeedsAttentionTab\b[^}]*\}\s*from\s*'@\/features\/signal-events\/needs-attention-tabs'/s
    )
    expect(src).toMatch(/NEEDS_ATTENTION_TABS\.map\(/)
  })

  it('renders one panel per contract tab id', () => {
    expect(src).toMatch(/<TabsContent value='cost-backfill'>/)
    expect(src).toMatch(/<TabsContent value='missing-volume'>/)
    expect(src).toMatch(/<TabsContent value='credit-pools'>/)
  })

  it('puts a live count in every tab label, sourced from the loaded rows', () => {
    expect(src).toMatch(/\{tab\.label\} \(\{tabCounts\[tab\.id\]\}\)/)
    expect(src).toMatch(/'cost-backfill':\s*groups\.length/)
    expect(src).toMatch(/'missing-volume':\s*volumeGroups\.length/)
    expect(src).toMatch(/'credit-pools':\s*creditPools\.length/)
  })

  it('resolves the active tab from ?tab= through the shared resolver, never from raw string compares', () => {
    expect(src).toMatch(/searchParams\.get\('tab'\)/)
    expect(src).toMatch(
      /resolveNeedsAttentionTab\(\s*tabParam,\s*tabCounts\s*\)/
    )
  })

  it('writes the chosen tab back to the URL so the view is linkable', () => {
    expect(src).toMatch(/nextParams\.set\('tab',\s*tab\)/)
    expect(src).toMatch(/router\.replace\(/)
  })

  it('wraps the useSearchParams read in a Suspense boundary (Next prerender requirement)', () => {
    expect(src).toMatch(/import\s*\{[^}]*\bSuspense\b[^}]*\}\s*from\s*'react'/)
    expect(src).toMatch(/<Suspense fallback=\{null\}>/)
  })
})

describe('NeedsAttentionPage credit-pools copy inside its tab', () => {
  it('keeps the Action column and hangs the pinned tooltip off its header', () => {
    expect(src).toMatch(
      /Action\s*<InfoTooltip\s+title='Top up or pause'\s+description=\{CREDIT_POOL_ACTION_TOOLTIP\}/
    )
  })

  it('pins the tooltip copy verbatim', () => {
    expect(src).toContain(
      '"Top up adds prepaid units your customer bought (or a credit you\'re giving them). The countdown and alerts update. The invoice doesn\'t change. Pause stops the warning emails for this subscription only; tracking and billing keep running."'
    )
  })

  it('keeps the "working as designed" line that stops a low pool reading as an outage', () => {
    expect(src).toMatch(
      /Working as designed: nothing is blocked, the overage keeps\s+billing\./
    )
  })
})

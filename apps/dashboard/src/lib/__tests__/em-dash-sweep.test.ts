/**
 * No em dashes in rendered UI copy, across Build, MFiQ, ROI, Money, Cost
 * Management, Month-End Close, Developer Zone, FinOps Settings, and the
 * dashboard-shell preview page, plus the server actions whose returned
 * strings render directly into those pages (error messages, GL code/name
 * labels, seeded chart-of-accounts data).
 *
 * The lone `'—'` glyph for "no value" (canon: honest null renders as an em
 * dash) is allowed by design; a handful of the files below carry it. This test excludes exactly that shape (plus code comments)
 * before asserting no em dash remains, mirroring finops/__tests__/
 * page-composition.test.ts's "no em dash in rendered copy" check.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '../../..')

// Files whose rendered copy must stay em-dash free. Grouped by area for
// readability; order has no bearing on the test.
const FILES = [
  // App Router pages
  '(customer-portal)/portal/[slug]/(main)/page.tsx',
  '(dashboard)/invoices/[invoiceId]/page.tsx',
  '(dashboard)/roi/[initiativeId]/page.tsx',
]

const ACTION_FILES = [
  'actions/_shared/audit-source-label.ts',
  'actions/_shared/initiative-actuals.ts',
  'actions/_shared/initiative-metric-values.ts',
  // Validation errors render in settings-card toasts.
  'actions/org-billing-identity.ts',
  'actions/roi-initiative-detail.ts',
  'actions/build-agents-overview.ts',
  'actions/chart-of-accounts.ts',
  'actions/create-simulator-demo-pricing.ts',
  'actions/finance-period-lock.ts',
  'actions/finops-close-status.ts',
  'actions/generate-customer-portal-link.ts',
  'actions/journal-export.ts',
  'actions/metrics-resolver.ts',
  'actions/mfiq-status.ts',
  'actions/pricing-plans.ts',
  'actions/record-sdk-usage.ts',
  'actions/roi-overview.ts',
  'actions/saved-views.ts',
  'actions/signal-classification.ts',
  'lib/db.ts',
]

const API_FILES = ['api/export/journal/csv.ts']

const SRC_FILES = [
  'components/setup-method-modal.tsx',
  'components/taxonomy-card.tsx',
  'features/agents/PricingPlans.tsx',
  // The Build agent detail, the shared status dialog, and the create-key
  // sheet.
  'features/build/components/agent-detail.tsx',
  'features/build/components/agent-status-dialog.tsx',
  'features/build/components/agents-table.tsx',
  'features/build/components/api-keys-tab.tsx',
  'features/build/components/getting-started-nudge.tsx',
  'features/build/index.tsx',
  'features/developer-zone/api-keys/create-key-pair-sheet.tsx',
  'features/cost-management/classification-utils.ts',
  'features/cost-management/components/cfo-charts-panel.tsx',
  'features/cost-management/components/cost-classification-panel.tsx',
  'features/cost-management/components/product-line-margin-panel.tsx',
  'features/cost-management/journal-utils.ts',
  // The FinOps tab registry and the surfaces it embeds as tabs.
  'features/cost-management/index.tsx',
  'features/finops-settings/index.tsx',
  'features/finops/finops-tabs.ts',
  'features/dashboard-shell/catalog-preview.tsx',
  'features/dashboard-shell/dimensioned-section.tsx',
  // The invoice identity surfaces (print view, seller mapping, settings
  // card).
  'features/invoices/InvoiceActions.tsx',
  'features/invoices/InvoicePrintView.tsx',
  'features/invoices/billing-identity-display.ts',
  'features/invoices/useSellerIdentity.ts',
  'features/settings/billing/index.tsx',
  'features/settings/billing/invoice-identity-card.tsx',
  'features/developer-zone/sdk-simulator/index.tsx',
  'features/finops-settings/components/chart-of-accounts-editor.tsx',
  'features/finops/components/gl-mapping-table.tsx',
  'features/mfiq/index.tsx',
  'features/money/components/csv-export-dialog.tsx',
  'features/money/components/internal-user-detail-dialog.tsx',
  'features/money/components/money-simulator-tab.tsx',
  'features/money/components/plan-activation-dialog.tsx',
  'features/month-end-close/index.tsx',
  'features/pricing-configure/components/PricingTypeSelector.tsx',
  'features/quick-onboarding/components/steps/ModeSelectionStep.tsx',
  'features/roi/baseline-derivation.ts',
  'features/roi/components/initiative-card.tsx',
  'features/roi/components/initiative-dialog.tsx',
  'features/roi/components/target-trend-chart.tsx',
  'features/roi/detail.tsx',
  'features/roi/index.tsx',
  'features/signal-events/components/EventsAnalyticsDashboard.tsx',
  'features/subscriptions/components/cancel-subscription-dialog.tsx',
  'lib/component-catalog.ts',
]

// Every path below, resolved relative to ROOT (apps/dashboard/).
const ALL_FILES: string[] = [
  ...FILES.map((p) => join('app', p)),
  ...ACTION_FILES.map((p) => join('app', p)),
  ...API_FILES.map((p) => join('app', p)),
  ...SRC_FILES.map((p) => join('src', p)),
]

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')
}

// Removes the honest-null glyph so the assertion only sees prose em dashes:
//   - a bare quoted '—' or "—" (the whole ternary/literal branch)
//   - a JSX text node that is only an em dash, however it wraps: `>—<`,
//     or spread across lines/whitespace as `>\n  —\n<`
function stripNullGlyph(src: string): string {
  return src.replace(/(['"])—\1/g, '').replace(/>\s*—\s*</g, '><')
}

describe('UI copy has no em dashes', () => {
  it.each(ALL_FILES)('%s has no em dash in rendered copy', (relPath) => {
    const src = readFileSync(join(ROOT, relPath), 'utf8')
    const rendered = stripNullGlyph(stripComments(src))
    expect(rendered).not.toMatch(/—/)
  })
})

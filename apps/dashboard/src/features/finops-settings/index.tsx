'use client'

/**
 * WHAT THIS FILE DOES: Renders the Settings tab on /finops (the
 *   /finops-settings route redirects here). It is two self-contained setup
 *   editors stacked in the tab:
 *     1. Classification Rules: the keyword rules that auto-sort signals into
 *        cost buckets.
 *     2. Chart of Accounts: the GL codes signals get mapped to for export.
 *   Each editor fetches its OWN data and renders its OWN loading state, so this
 *   wrapper holds no data state and no filters. The editors' write actions
 *   check the owner, admin or finance role with assertMoneyManager.
 * CONNECTS TO:
 *   - src/features/finops/index.tsx (the tabbed page that renders this)
 *   - app/(dashboard)/finops-settings/page.tsx (307 redirect to /finops?tab=settings)
 *   - ./components/classification-rules-editor
 *   - ./components/chart-of-accounts-editor
 */

import ClassificationRulesEditor from './components/classification-rules-editor'
import ChartOfAccountsEditor from './components/chart-of-accounts-editor'

export default function FinopsSettings() {
  return (
    <div className='flex flex-col gap-4'>
      <p className='text-[11.5px] text-mf-tx2'>
        Configure how your AI costs get classified: the keyword rules that sort
        signals into buckets, and the GL codes they map to.
      </p>

      {/* Classification Rules — keyword rules that auto-bucket signals.
          Self-fetches its rules + the agent list; renders its own loading
          state. */}
      <ClassificationRulesEditor />

      {/* Chart of Accounts — the GL codes signals map to for the journal
          export. Self-fetches; renders its own loading state. */}
      <ChartOfAccountsEditor />
    </div>
  )
}

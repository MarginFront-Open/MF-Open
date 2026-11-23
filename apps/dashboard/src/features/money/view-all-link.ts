import type { DateRangeParams } from '@/features/dashboard-shell/date-range'

/**
 * Money's "View all" drill to the FinOps Cost management tab, carrying the
 * page's current window verbatim (the /cost-management
 * route redirects to that tab). Rolling
 * (no params) intentionally produces empty startDate/endDate values,
 * matching this exact link.
 */
export function buildCostManagementHref(period: DateRangeParams): string {
  const params = new URLSearchParams({
    tab: 'cost-management',
    startDate: period.startDate ?? '',
    endDate: period.endDate ?? '',
  })
  return `/finops?${params.toString()}`
}

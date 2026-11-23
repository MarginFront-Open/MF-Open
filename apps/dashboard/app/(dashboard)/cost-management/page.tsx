import { redirect } from 'next/navigation'

// Cost Management lives on the FinOps page as its "Cost management" tab.
// Server-side redirect so nothing flashes before bouncing. The
// ?startDate=&endDate= deep link carries over: Month-End Close's "classify
// it here" links and saved bookmarks forward verbatim so the tab opens scoped to the same month. /finops owns
// the role gate.
export default async function CostManagementPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  const forwarded = new URLSearchParams({ tab: 'cost-management' })
  if (typeof params.startDate === 'string' && params.startDate !== '') {
    forwarded.set('startDate', params.startDate)
  }
  if (typeof params.endDate === 'string' && params.endDate !== '') {
    forwarded.set('endDate', params.endDate)
  }
  redirect(`/finops?${forwarded.toString()}`)
}

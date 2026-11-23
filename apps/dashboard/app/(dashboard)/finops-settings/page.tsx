import { redirect } from 'next/navigation'

// FinOps Settings lives on the FinOps page as its "Settings" tab.
// Server-side redirect so nothing flashes before bouncing. /finops owns the
// role gate.
export default function FinopsSettingsPage() {
  redirect('/finops?tab=settings')
}

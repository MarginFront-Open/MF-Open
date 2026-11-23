import { redirect } from 'next/navigation'

// The agent list lives on the Build page. Server-side redirect so nothing
// flashes before bouncing. /agents/[agentId] also redirects (to
// /build?agent=); the signals, pricing-plans and revenue-simulator subroutes
// and /agents/new render as pages of their own.
export default function AgentsPage() {
  redirect('/build')
}

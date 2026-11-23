import { redirect } from 'next/navigation'

// /agents/[agentId] redirects to Build's drill-in detail, which renders the
// same surface via the shared agent-earnings module (mirrors the /agents list
// redirect one level up). The signals, pricing-plans, and revenue-simulator
// subroutes stay live.
export default async function LegacyAgentDetailRedirect({
  params,
}: {
  params: Promise<{ agentId: string }>
}) {
  const { agentId } = await params
  redirect(`/build?agent=${agentId}`)
}

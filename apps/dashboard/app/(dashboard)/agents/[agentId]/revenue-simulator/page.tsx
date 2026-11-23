'use client'

import AgentTabs from '@/features/agents/AgentTabs'
import RevenueSimulator from '@/features/agents/RevenueSimulator'

export default function RevenueSimulatorPage() {
  return (
    <AgentTabs activeTab='revenue-simulator'>
      <RevenueSimulator />
    </AgentTabs>
  )
}

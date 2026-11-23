'use client'

import AgentTabs from '@/features/agents/AgentTabs'
import AgentSignalsWizard from '@/features/agents/MetricsWizard'

export default function AgentSignalsPage() {
  return (
    <AgentTabs activeTab='signals'>
      <AgentSignalsWizard />
    </AgentTabs>
  )
}

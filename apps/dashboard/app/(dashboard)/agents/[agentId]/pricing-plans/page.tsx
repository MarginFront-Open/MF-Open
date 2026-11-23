'use client'

import AgentTabs from '@/features/agents/AgentTabs'
import PricingPlans from '@/features/agents/PricingPlans'

export default function PricingPlansPage() {
  return (
    <AgentTabs activeTab='pricing-plans'>
      <PricingPlans />
    </AgentTabs>
  )
}

'use client'

import { useParams } from 'next/navigation'
import { PricingConfigure } from '@/features/pricing-configure'

export default function PricingComponent() {
  const params = useParams()
  const agentId = params.agentId as string
  const planId = params.planId as string

  return <PricingConfigure agentId={agentId} planId={planId} />
}

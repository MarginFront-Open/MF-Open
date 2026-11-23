import apiClient from './client'
import { formatUrl, getOrgId } from './client'

// Type definitions
export interface SimulationPayload {
  pricingPlanId: string
  projectedEvents: Record<string, number>
  billingCycle: string
  seatsCount?: number
}

export interface PricingTier {
  lower: number
  upper: number | null
  rate: number
  quantity?: number
  subtotal?: number
}

export interface ChargeDetail {
  description: string
  quantity: number
  unitPrice: number
  effectiveUnitPrice: number
  amount: number
  pricingStrategyId: string
  pricingStrategyName: string
  chargeType: string
  pricingModel: string | null
  minimumCommitment: number | null
  tiersUsed: PricingTier[]
}

export interface ChargeGroup {
  lineItems: ChargeDetail[]
  subtotal: number
  total: number
}

export interface StrategyCharge {
  quantity: number
  unitPrice: number
  effectiveUnitPrice: number
  amount: number
  tiersUsed: PricingTier[]
}

export interface StrategyBreakdownItem {
  id: string
  name: string
  chargeType: string
  pricingModel: string | null
  rate: number | null
  billingFrequency: string | null
  minimumCommitment: number | null
  tiers: PricingTier[] | null
  charge: StrategyCharge
}

export interface StrategyBreakdown {
  recurring: StrategyBreakdownItem[]
  usage: StrategyBreakdownItem[]
  onetime: StrategyBreakdownItem[]
}

export interface SimulationSummary {
  setupCosts: number
  recurringCosts: number
  usageBasedCosts: number
  firstInvoiceTotal: number
  typicalInvoiceTotal: number
  yearlyTotal: number
}

export interface SimulationResponse {
  pricingPlan: {
    id: string
    name: string
    description: string
  }
  agent: {
    id: string
    name: string
    agentCode: string
  }
  billingCycle: string
  projectedUsage: Record<string, number>
  initialCharges: ChargeGroup
  recurringCharges: ChargeGroup
  strategyBreakdown: StrategyBreakdown
  annualProjection: number
  simulationSummary: SimulationSummary
}

// Calculate Invoice DTO
export interface CalculateInvoicePayload {
  subscriptionId: string
  startDate?: string
  endDate?: string
  billingPeriodStart?: Date
  billingPeriodEnd?: Date
  invoiceType?: string
  params?: Record<string, any>
}

// Billing Status Response
export interface BillingStatusResponse {
  subscription: {
    id: string
    status: string
    currentPeriodStart: Date
    currentPeriodEnd: Date
  }
  nextBillingDate: Date
  upcomingInvoice: {
    total: number
    lineItems: Array<{
      description: string
      quantity: number
      amount: number
    }>
  }
  billingHistory: Array<{
    date: Date
    amount: number
    status: string
  }>
}

// Invoice calculator API functions
export const invoiceCalculatorApi = {
  // Calculate invoice for a subscription
  calculateInvoice: async (payload: CalculateInvoicePayload): Promise<any> => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')

    const url = formatUrl(
      `/org/${orgId}/invoice-calculator/billing/calculate`,
      {}
    )
    const response = await apiClient.post(url, payload)
    return response.data
  },

  // Get billing status for a subscription
  getBillingStatus: async (
    subscriptionId: string
  ): Promise<BillingStatusResponse> => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')
    if (!subscriptionId) throw new Error('Subscription ID is required')

    const url = formatUrl(
      `/org/${orgId}/invoice-calculator/billing-status/${subscriptionId}`,
      {}
    )
    const response = await apiClient.get(url)
    return response.data
  },

  // Simulate revenue based on pricing plan and projected events
  simulateRevenue: async (
    payload: SimulationPayload
  ): Promise<SimulationResponse> => {
    const orgId = await getOrgId()
    if (!orgId) throw new Error('Organization ID is required')

    const url = formatUrl(
      `/org/${orgId}/invoice-calculator/billing/simulate`,
      {}
    )
    const response = await apiClient.post(url, payload)
    return response.data
  },
}

/**
 * Pricing plan type for embeddable pricing components
 */
export interface PricingPlanV2 {
  id: string;
  name: string;
  price: number;
  billingCycle: 'monthly' | 'yearly' | 'usage';
  features: string[];
  isPopular?: boolean;
  enabled: boolean;
}

/**
 * Business context for dynamic UI customization
 * Components auto-detect business type from this text
 */
export interface BusinessContext {
  productOverview?: string;
  businessModel?: string;
  pricingMechanics?: string;
  goToMarket?: string;
}

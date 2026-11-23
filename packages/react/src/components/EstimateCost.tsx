'use client';

/**
 * EstimateCost Component
 * Interactive cost estimator with dynamic unit labels based on business context
 */

import { useState, useMemo } from 'react';
import { useMarginFrontContext } from '../context';
import { cn } from '../utils/cn';
import type { PricingPlanV2, BusinessContext } from '../types/pricing';

export interface EstimateCostProps {
  /** The plans to compare. */
  pricingPlans: PricingPlanV2[];
  /** Company name for display */
  companyName?: string;
  /** Brand color (hex) - overrides theme */
  brandColor?: string;
  /** Business context for dynamic UI customization */
  businessContext?: BusinessContext;
  /** Custom class name */
  className?: string;
  /** Callback when plan is selected */
  onSelectPlan?: (plan: PricingPlanV2) => void;
}

interface UsageConfig {
  icon: string;
  unitLabel: string;
  unitSingular: string;
  minUsage: number;
  maxUsage: number;
  defaultUsage: number;
  step: number;
}

// Detect business type from context
const detectBusinessType = (context?: BusinessContext): string => {
  if (!context) return 'generic';

  const text = `${context.productOverview || ''} ${context.businessModel || ''} ${context.pricingMechanics || ''}`.toLowerCase();

  if (text.includes('hiring') || text.includes('recruit') || text.includes('interview')) return 'hiring';
  if (text.includes('call') || text.includes('phone') || text.includes('receptionist')) return 'calls';
  if (text.includes('api') || text.includes('developer') || text.includes('sdk')) return 'api';
  if (text.includes('storage') || text.includes('file') || text.includes('backup')) return 'storage';
  if (text.includes('email') || text.includes('marketing') || text.includes('campaign')) return 'email';
  if (text.includes('ai') || text.includes('machine learning') || text.includes('model')) return 'ai';
  if (text.includes('video') || text.includes('stream') || text.includes('meeting')) return 'video';
  if (text.includes('crm') || text.includes('sales') || text.includes('lead')) return 'crm';

  return 'saas';
};

// Get usage configuration based on business type
const getUsageConfig = (businessType: string): UsageConfig => {
  const configs: Record<string, UsageConfig> = {
    hiring: { icon: '👥', unitLabel: 'candidates', unitSingular: 'candidate', minUsage: 10, maxUsage: 500, defaultUsage: 100, step: 10 },
    calls: { icon: '📞', unitLabel: 'calls', unitSingular: 'call', minUsage: 30, maxUsage: 1000, defaultUsage: 150, step: 10 },
    api: { icon: '🔌', unitLabel: 'K requests', unitSingular: 'K requests', minUsage: 10, maxUsage: 10000, defaultUsage: 500, step: 50 },
    ai: { icon: '🤖', unitLabel: 'tasks', unitSingular: 'task', minUsage: 100, maxUsage: 50000, defaultUsage: 2500, step: 100 },
    storage: { icon: '💾', unitLabel: 'GB', unitSingular: 'GB', minUsage: 10, maxUsage: 5000, defaultUsage: 250, step: 10 },
    email: { icon: '📧', unitLabel: 'emails', unitSingular: 'email', minUsage: 1000, maxUsage: 500000, defaultUsage: 25000, step: 1000 },
    video: { icon: '🎥', unitLabel: 'meetings', unitSingular: 'meeting', minUsage: 10, maxUsage: 500, defaultUsage: 50, step: 5 },
    crm: { icon: '🎯', unitLabel: 'contacts', unitSingular: 'contact', minUsage: 100, maxUsage: 50000, defaultUsage: 2500, step: 100 },
    saas: { icon: '⚡', unitLabel: 'units', unitSingular: 'unit', minUsage: 10, maxUsage: 500, defaultUsage: 100, step: 5 },
    generic: { icon: '⚡', unitLabel: 'units', unitSingular: 'unit', minUsage: 10, maxUsage: 500, defaultUsage: 100, step: 5 },
  };
  return configs[businessType] || configs.generic;
};

export function EstimateCost({
  pricingPlans: plans,
  companyName: _companyName = 'Your Product',
  brandColor,
  businessContext,
  className,
  onSelectPlan,
}: EstimateCostProps) {
  const { theme } = useMarginFrontContext();
  const primaryColor = brandColor || theme.primary || '#047857';

  // Detect business type and get dynamic usage config
  const businessType = useMemo(() => detectBusinessType(businessContext), [businessContext]);
  const usageConfig = useMemo(() => getUsageConfig(businessType), [businessType]);

  // Filter and sort enabled plans by price
  const orderedPlans = useMemo(() => {
    const filtered = plans.filter(p => p.enabled && p.price >= 0).sort((a, b) => a.price - b.price).slice(0, 4);

    // Reorder: Free tier first, paid plans by price, Enterprise/Custom last
    const isFreeTier = (p: PricingPlanV2) => p.price === 0 && /free|starter|hobby|trial/i.test(p.name);
    const isEnterprise = (p: PricingPlanV2) => p.price === 0 && /enterprise|custom|contact/i.test(p.name);

    const freeTierPlans = filtered.filter(isFreeTier);
    const paidPlans = filtered.filter(p => p.price > 0);
    const enterprisePlans = filtered.filter(isEnterprise);
    const otherFreePlans = filtered.filter(p => p.price === 0 && !isFreeTier(p) && !isEnterprise(p));

    return [...freeTierPlans, ...paidPlans, ...enterprisePlans, ...otherFreePlans];
  }, [plans]);

  const [expectedUsage, setExpectedUsage] = useState(usageConfig.defaultUsage);
  const [isAnnual, setIsAnnual] = useState(false);

  const maxUsage = usageConfig.maxUsage;

  // Find best plan based on usage
  const calculation = useMemo(() => {
    if (orderedPlans.length === 0) return null;

    const minUsage = usageConfig.minUsage;
    const usageRatio = (expectedUsage - minUsage) / (maxUsage - minUsage);
    const planIndex = Math.min(Math.floor(usageRatio * orderedPlans.length), orderedPlans.length - 1);
    const bestPlan = orderedPlans[planIndex];

    const monthlyCost = bestPlan.price;
    const annualCost = Math.round(monthlyCost * 12 * 0.8);
    const costPerUnit = expectedUsage > 0 && monthlyCost > 0 ? monthlyCost / expectedUsage : 0;
    const annualSavings = monthlyCost * 12 - annualCost;

    return { bestPlan, monthlyCost, annualCost, costPerUnit, annualSavings };
  }, [orderedPlans, expectedUsage, maxUsage, usageConfig.minUsage]);


  if (orderedPlans.length === 0 || !calculation) {
    return (
      <div className={cn('marginfront-estimate-cost', className)}>
        <div className="bg-gray-50 rounded-2xl p-8 text-center text-gray-500">
          No pricing plans available
        </div>
      </div>
    );
  }

  const displayCost = isAnnual ? Math.round(calculation.annualCost / 12) : calculation.monthlyCost;

  return (
    <div className={cn('marginfront-estimate-cost', className)}>
      <div className="bg-gray-50 rounded-2xl overflow-hidden">
        <div className="p-8">
          {/* Header */}
          <div className="text-center mb-8">
            <h3 className="text-xl font-bold text-gray-900 mb-2">Estimate your cost</h3>
            <p className="text-sm text-gray-500">
              Slide to your expected usage and see your cost instantly
            </p>
          </div>

          {/* Usage Slider */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <label className="text-sm font-medium text-gray-700">
                Expected {usageConfig.unitLabel} per month
              </label>
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border bg-white border-gray-200">
                <span className="text-base">{usageConfig.icon}</span>
                <span className="text-sm font-bold text-gray-900">
                  {expectedUsage.toLocaleString()}
                </span>
                <span className="text-xs text-gray-400">{usageConfig.unitLabel}</span>
              </div>
            </div>

            <div className="relative">
              <input
                type="range"
                min={usageConfig.minUsage}
                max={maxUsage}
                step={usageConfig.step}
                value={expectedUsage}
                onChange={(e) => setExpectedUsage(Number(e.target.value))}
                className="w-full h-2.5 rounded-full appearance-none cursor-pointer"
                style={{
                  background: `linear-gradient(to right, ${primaryColor} 0%, ${primaryColor} ${((expectedUsage - usageConfig.minUsage) / (maxUsage - usageConfig.minUsage)) * 100}%, #e5e7eb ${((expectedUsage - usageConfig.minUsage) / (maxUsage - usageConfig.minUsage)) * 100}%, #e5e7eb 100%)`,
                }}
              />
              <style>{`
                .marginfront-estimate-cost input[type="range"]::-webkit-slider-thumb {
                  appearance: none;
                  width: 18px;
                  height: 18px;
                  border-radius: 50%;
                  background: ${primaryColor};
                  border: 3px solid white;
                  box-shadow: 0 2px 6px rgba(0,0,0,0.2);
                  cursor: pointer;
                }
              `}</style>

              {/* Plan markers */}
              <div className="flex justify-between mt-3">
                {orderedPlans.map((plan) => {
                  const isSelected = calculation.bestPlan.id === plan.id;
                  const isFreeTier = plan.price === 0 && /free|starter|hobby/i.test(plan.name);
                  const priceLabel = plan.price > 0 ? `$${plan.price}` : isFreeTier ? 'Free' : 'Custom';

                  return (
                    <div key={plan.id} className="flex flex-col items-center" style={{ width: `${100 / orderedPlans.length}%` }}>
                      <span
                        className="text-[10px] font-medium"
                        style={{ color: isSelected ? primaryColor : '#9ca3af' }}
                      >
                        {priceLabel}
                      </span>
                      <span
                        className={cn('text-[10px]', isSelected ? 'font-semibold text-gray-900' : 'text-gray-400')}
                      >
                        {plan.name}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Billing Toggle */}
          <div className="flex items-center justify-center gap-2 mb-6">
            <button
              onClick={() => setIsAnnual(false)}
              className={cn(
                'px-4 py-1.5 rounded-full text-xs font-medium transition-colors',
                !isAnnual ? 'bg-gray-900 text-white' : 'text-gray-500 hover:text-gray-700'
              )}
            >
              Monthly
            </button>
            <button
              onClick={() => setIsAnnual(true)}
              className={cn(
                'px-4 py-1.5 rounded-full text-xs font-medium transition-colors',
                isAnnual ? 'bg-gray-900 text-white' : 'text-gray-500 hover:text-gray-700'
              )}
            >
              Annual
              <span className="ml-1.5" style={{ color: primaryColor }}>Save 20%</span>
            </button>
          </div>

          {/* Results Card */}
          <div className="bg-white rounded-xl p-5">
            <div className="flex gap-4">
              {/* Left: Plan Details */}
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] uppercase tracking-wider text-gray-400">
                    Recommended Plan
                  </span>
                  {calculation.bestPlan.isPopular && (
                    <span
                      className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                      style={{ backgroundColor: `${primaryColor}20`, color: primaryColor }}
                    >
                      Best Value
                    </span>
                  )}
                </div>
                <h4 className="text-xl font-bold text-gray-900 mb-3">{calculation.bestPlan.name}</h4>

                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-gray-50 rounded-lg p-3">
                    <div className="text-[10px] text-gray-400 mb-0.5">Base price</div>
                    <div className="text-base font-bold text-gray-900">${calculation.bestPlan.price}</div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3">
                    <div className="text-[10px] text-gray-400 mb-0.5">Cost per {usageConfig.unitSingular}</div>
                    <div className="text-base font-bold" style={{ color: primaryColor }}>
                      ${calculation.costPerUnit.toFixed(2)}
                    </div>
                  </div>
                </div>
              </div>

              {/* Right: Price Card */}
              <div className="w-40 bg-gray-900 rounded-xl p-4 text-white text-center">
                <div className="text-[10px] opacity-60 mb-1">
                  {isAnnual ? 'Monthly (billed annually)' : 'Monthly'}
                </div>
                <div className="text-3xl font-bold mb-1">${displayCost}</div>
                <div className="text-[10px] opacity-60 mb-3">per month</div>

                <div className="space-y-1.5 text-left text-[11px] mb-4">
                  {calculation.bestPlan.features.slice(0, 3).map((feature, idx) => (
                    <div key={idx} className="flex items-center gap-1.5">
                      <svg className="w-3 h-3" style={{ color: primaryColor }} fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                      <span className="truncate">{feature}</span>
                    </div>
                  ))}
                </div>

                <button
                  onClick={() => onSelectPlan?.(calculation.bestPlan)}
                  className="w-full py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1 transition-opacity hover:opacity-90"
                  style={{ backgroundColor: primaryColor }}
                >
                  Get started
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Annual savings note */}
            {!isAnnual && calculation.annualSavings > 0 && (
              <div className="text-center text-xs text-gray-500 mt-4 pt-3 border-t border-gray-100">
                Switch to annual billing and save{' '}
                <span className="font-semibold" style={{ color: primaryColor }}>
                  ${calculation.annualSavings}/year
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

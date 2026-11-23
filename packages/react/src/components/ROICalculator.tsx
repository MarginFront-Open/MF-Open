'use client';

/**
 * ROICalculator Component
 * Interactive ROI calculator with dynamic inputs based on business context
 */

import { useState, useMemo } from 'react';
import { useMarginFrontContext } from '../context';
import { cn } from '../utils/cn';
import type { PricingPlanV2, BusinessContext } from '../types/pricing';

export interface ROICalculatorProps {
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
  /** Callback when CTA is clicked */
  onGetStarted?: () => void;
}

interface InputConfig {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  suffix: string;
  prefix?: string;
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

// Generate dynamic input configurations based on business type
const getInputConfigs = (businessType: string): InputConfig[] => {
  const configs: Record<string, InputConfig[]> = {
    hiring: [
      { id: 'cost', label: 'Current cost per hire', min: 500, max: 15000, step: 100, default: 4500, prefix: '$', suffix: '' },
      { id: 'missed', label: 'Unfilled positions/month', min: 1, max: 50, step: 1, default: 8, suffix: '' },
      { id: 'value', label: 'Average salary per hire', min: 30000, max: 200000, step: 5000, default: 75000, prefix: '$', suffix: '' },
      { id: 'rate', label: 'Time-to-hire (days)', min: 10, max: 120, step: 5, default: 45, suffix: ' days' },
    ],
    calls: [
      { id: 'cost', label: 'Current receptionist cost', min: 500, max: 8000, step: 100, default: 3200, prefix: '$', suffix: '/mo' },
      { id: 'missed', label: 'Missed calls per day', min: 1, max: 100, step: 1, default: 15, suffix: '' },
      { id: 'value', label: 'Avg revenue per call', min: 50, max: 2000, step: 25, default: 350, prefix: '$', suffix: '' },
      { id: 'rate', label: 'Call-to-booking rate', min: 1, max: 50, step: 1, default: 15, suffix: '%' },
    ],
    api: [
      { id: 'cost', label: 'Current infrastructure cost', min: 200, max: 20000, step: 100, default: 2500, prefix: '$', suffix: '/mo' },
      { id: 'missed', label: 'Failed requests/month', min: 100, max: 50000, step: 100, default: 5000, suffix: '' },
      { id: 'value', label: 'Revenue per 1K requests', min: 1, max: 100, step: 1, default: 15, prefix: '$', suffix: '' },
      { id: 'rate', label: 'Target uptime %', min: 95, max: 100, step: 0.1, default: 99.9, suffix: '%' },
    ],
    ai: [
      { id: 'cost', label: 'Current AI spend', min: 500, max: 50000, step: 500, default: 5000, prefix: '$', suffix: '/mo' },
      { id: 'missed', label: 'Manual tasks/month', min: 10, max: 1000, step: 10, default: 200, suffix: '' },
      { id: 'value', label: 'Cost per manual task', min: 5, max: 200, step: 5, default: 25, prefix: '$', suffix: '' },
      { id: 'rate', label: 'Automation potential', min: 10, max: 90, step: 5, default: 60, suffix: '%' },
    ],
    storage: [
      { id: 'cost', label: 'Current storage cost', min: 100, max: 10000, step: 50, default: 800, prefix: '$', suffix: '/mo' },
      { id: 'missed', label: 'Data loss incidents/yr', min: 0, max: 20, step: 1, default: 3, suffix: '' },
      { id: 'value', label: 'Cost per incident', min: 500, max: 50000, step: 500, default: 5000, prefix: '$', suffix: '' },
      { id: 'rate', label: 'Data growth rate', min: 5, max: 100, step: 5, default: 25, suffix: '%/yr' },
    ],
    email: [
      { id: 'cost', label: 'Current email cost', min: 50, max: 5000, step: 50, default: 500, prefix: '$', suffix: '/mo' },
      { id: 'missed', label: 'Undelivered emails/mo', min: 100, max: 50000, step: 100, default: 5000, suffix: '' },
      { id: 'value', label: 'Revenue per conversion', min: 10, max: 500, step: 10, default: 50, prefix: '$', suffix: '' },
      { id: 'rate', label: 'Current open rate', min: 5, max: 50, step: 1, default: 18, suffix: '%' },
    ],
    video: [
      { id: 'cost', label: 'Current platform cost', min: 100, max: 5000, step: 50, default: 600, prefix: '$', suffix: '/mo' },
      { id: 'missed', label: 'Meetings/month', min: 10, max: 500, step: 10, default: 100, suffix: '' },
      { id: 'value', label: 'Time saved per meeting', min: 5, max: 60, step: 5, default: 15, suffix: ' min' },
      { id: 'rate', label: 'Hourly labor cost', min: 25, max: 200, step: 5, default: 75, prefix: '$', suffix: '/hr' },
    ],
    crm: [
      { id: 'cost', label: 'Current CRM cost', min: 100, max: 5000, step: 50, default: 800, prefix: '$', suffix: '/mo' },
      { id: 'missed', label: 'Lost leads/month', min: 5, max: 200, step: 5, default: 40, suffix: '' },
      { id: 'value', label: 'Avg deal value', min: 500, max: 50000, step: 500, default: 5000, prefix: '$', suffix: '' },
      { id: 'rate', label: 'Close rate improvement', min: 5, max: 50, step: 5, default: 15, suffix: '%' },
    ],
    saas: [
      { id: 'cost', label: 'Monthly operating cost', min: 500, max: 10000, step: 100, default: 3500, prefix: '$', suffix: '' },
      { id: 'missed', label: 'Missed opportunities/mo', min: 5, max: 200, step: 5, default: 50, suffix: '' },
      { id: 'value', label: 'Avg deal/service value', min: 50, max: 5000, step: 50, default: 500, prefix: '$', suffix: '' },
      { id: 'rate', label: 'Lead to customer rate', min: 1, max: 50, step: 1, default: 10, suffix: '%' },
    ],
    generic: [
      { id: 'cost', label: 'Monthly operating cost', min: 500, max: 10000, step: 100, default: 3500, prefix: '$', suffix: '' },
      { id: 'missed', label: 'Missed opportunities/mo', min: 5, max: 200, step: 5, default: 50, suffix: '' },
      { id: 'value', label: 'Avg deal/service value', min: 50, max: 5000, step: 50, default: 500, prefix: '$', suffix: '' },
      { id: 'rate', label: 'Lead to customer rate', min: 1, max: 50, step: 1, default: 10, suffix: '%' },
    ],
  };

  return configs[businessType] || configs.generic;
};

export function ROICalculator({
  pricingPlans: allPlans,
  companyName = 'Your Product',
  brandColor,
  businessContext,
  className,
  onGetStarted,
}: ROICalculatorProps) {
  const { theme } = useMarginFrontContext();
  const primaryColor = brandColor || theme.primary || '#047857';

  // Detect business type and get dynamic input configs
  const businessType = useMemo(() => detectBusinessType(businessContext), [businessContext]);
  const inputConfigs = useMemo(() => getInputConfigs(businessType), [businessType]);

  // Get middle-tier plan for cost comparison
  const referencePlan = useMemo(() => {
    const enabledPlans = allPlans
      .filter((p) => p.enabled && p.price > 0)
      .sort((a, b) => a.price - b.price);
    const midIndex = Math.floor(enabledPlans.length / 2);
    return enabledPlans[midIndex] || enabledPlans[0];
  }, [allPlans]);

  // Input states - initialized from dynamic configs
  const [inputValues, setInputValues] = useState<Record<string, number>>(() => {
    const values: Record<string, number> = {};
    inputConfigs.forEach((config) => {
      values[config.id] = config.default;
    });
    return values;
  });

  const updateInput = (id: string, value: number) => {
    setInputValues((prev) => ({ ...prev, [id]: value }));
  };

  // Calculations - adapts to business type
  const calculations = useMemo(() => {
    const cost = inputValues.cost || 3500;
    const missed = inputValues.missed || 50;
    const value = inputValues.value || 500;
    const rate = inputValues.rate || 10;

    // Adapt calculations based on business type
    let annualCurrentCost = 0;
    let annualRevenueLost = 0;

    switch (businessType) {
      case 'hiring':
        annualCurrentCost = cost * missed * 12;
        annualRevenueLost = value * missed * (rate / 30);
        break;
      case 'calls':
        annualCurrentCost = cost * 12;
        annualRevenueLost = missed * 30 * value * (rate / 100) * 12;
        break;
      case 'api':
        annualCurrentCost = cost * 12;
        annualRevenueLost = (missed / 1000) * value * 12;
        break;
      case 'ai':
        annualCurrentCost = cost * 12;
        annualRevenueLost = missed * value * (rate / 100) * 12;
        break;
      case 'video':
        annualCurrentCost = cost * 12;
        annualRevenueLost = missed * (value / 60) * rate * 12;
        break;
      case 'crm':
        annualCurrentCost = cost * 12;
        annualRevenueLost = missed * value * (rate / 100) * 12;
        break;
      default: {
        annualCurrentCost = cost * 12;
        const potentialDealsLost = (missed * rate) / 100;
        annualRevenueLost = potentialDealsLost * value * 12;
      }
    }

    // Product cost (use reference plan or average)
    const productMonthlyCost = referencePlan?.price || 159;
    const productAnnualCost = productMonthlyCost * 12;

    // Savings
    const annualSavings = Math.max(0, annualCurrentCost - productAnnualCost);
    const recoveredRevenue = annualRevenueLost * 0.8; // Assume 80% recovery
    const totalBenefit = annualSavings + recoveredRevenue;

    // ROI
    const roi =
      productAnnualCost > 0
        ? Math.round(((totalBenefit - productAnnualCost) / productAnnualCost) * 100)
        : 0;

    return {
      annualCurrentCost: Math.round(annualCurrentCost),
      annualRevenueLost: Math.round(annualRevenueLost),
      productAnnualCost: Math.round(productAnnualCost),
      annualSavings: Math.round(annualSavings),
      recoveredRevenue: Math.round(recoveredRevenue),
      totalBenefit: Math.round(totalBenefit),
      roi: Math.max(0, roi),
    };
  }, [inputValues, businessType, referencePlan]);


  if (!referencePlan) {
    return (
      <div className={cn('marginfront-roi-calculator', className)}>
        <div className="bg-gray-50 rounded-2xl p-8 text-center text-gray-500">
          No pricing plans available
        </div>
      </div>
    );
  }

  return (
    <div className={cn('marginfront-roi-calculator', className)}>
      <div className="bg-gray-50 rounded-2xl overflow-hidden">
        <div className="p-8">
          {/* Header */}
          <div className="text-center mb-8">
            <h3 className="text-xl font-bold text-gray-900 mb-2">Calculate your ROI</h3>
            <p className="text-sm text-gray-500">
              See how much you could save by switching to {companyName}
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            {/* Input Section */}
            <div className="bg-white rounded-xl p-5">
              <h4 className="text-sm font-bold text-gray-900 mb-4">Your current situation</h4>

              <div className="space-y-5">
                {inputConfigs.map((config, index) => {
                  const currentValue = inputValues[config.id] || config.default;
                  const range = config.max - config.min;
                  const percentage = ((currentValue - config.min) / range) * 100;

                  // Format display value
                  const formatValue = (val: number) => {
                    if (config.prefix === '$') {
                      return `$${val.toLocaleString()}${config.suffix}`;
                    }
                    return `${val.toLocaleString()}${config.suffix}`;
                  };

                  // Format min/max labels
                  const formatLabel = (val: number) => {
                    if (config.prefix === '$') {
                      return `$${val.toLocaleString()}`;
                    }
                    return `${val}${config.suffix}`;
                  };

                  return (
                    <div key={config.id}>
                      <div className="flex justify-between mb-2">
                        <label className="text-xs font-medium text-gray-600">{config.label}</label>
                        <span className="text-xs font-bold text-gray-900">
                          {formatValue(currentValue)}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={config.min}
                        max={config.max}
                        step={config.step}
                        value={currentValue}
                        onChange={(e) => updateInput(config.id, Number(e.target.value))}
                        className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
                        style={{
                          background: `linear-gradient(to right, ${primaryColor} 0%, ${primaryColor} ${percentage}%, #e5e7eb ${percentage}%, #e5e7eb 100%)`,
                        }}
                      />
                      {index === 0 && (
                        <style>{`
                          .marginfront-roi-calculator input[type="range"]::-webkit-slider-thumb {
                            appearance: none;
                            width: 14px;
                            height: 14px;
                            border-radius: 50%;
                            background: ${primaryColor};
                            cursor: pointer;
                          }
                        `}</style>
                      )}
                      <div className="flex justify-between mt-1">
                        <span className="text-[10px] text-gray-400">{formatLabel(config.min)}</span>
                        <span className="text-[10px] text-gray-400">{formatLabel(config.max)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Results Section */}
            <div className="bg-gray-900 rounded-xl p-5 text-white">
              <h4 className="text-sm font-bold mb-4">Your potential savings</h4>

              {/* ROI Badge */}
              <div
                className="rounded-xl p-4 mb-4 text-center"
                style={{ backgroundColor: primaryColor }}
              >
                <div className="flex items-center justify-center gap-1.5 mb-1">
                  <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                  </svg>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-white">
                    Estimated ROI
                  </span>
                </div>
                <div className="text-4xl font-bold text-white">
                  {calculations.roi.toLocaleString()}%
                </div>
              </div>

              {/* Stats Grid */}
              <div className="grid grid-cols-2 gap-2 mb-4">
                <div className="bg-white/10 rounded-lg p-3">
                  <div className="flex items-center gap-1.5 mb-1">
                    <svg className="w-3 h-3" style={{ color: primaryColor }} fill="currentColor" viewBox="0 0 20 20">
                      <path d="M8.433 7.418c.155-.103.346-.196.567-.267v1.698a2.305 2.305 0 01-.567-.267C8.07 8.34 8 8.114 8 8c0-.114.07-.34.433-.582zM11 12.849v-1.698c.22.071.412.164.567.267.364.243.433.468.433.582 0 .114-.07.34-.433.582a2.305 2.305 0 01-.567.267z" />
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-13a1 1 0 10-2 0v.092a4.535 4.535 0 00-1.676.662C6.602 6.234 6 7.009 6 8c0 .99.602 1.765 1.324 2.246.48.32 1.054.545 1.676.662v1.941c-.391-.127-.68-.317-.843-.504a1 1 0 10-1.51 1.31c.562.649 1.413 1.076 2.353 1.253V15a1 1 0 102 0v-.092a4.535 4.535 0 001.676-.662C13.398 13.766 14 12.991 14 12c0-.99-.602-1.765-1.324-2.246A4.535 4.535 0 0011 9.092V7.151c.391.127.68.317.843.504a1 1 0 101.511-1.31c-.563-.649-1.413-1.076-2.354-1.253V5z" clipRule="evenodd" />
                    </svg>
                    <span className="text-[9px] uppercase tracking-wider opacity-60">
                      Annual Savings
                    </span>
                  </div>
                  <div className="text-lg font-bold">${calculations.annualSavings.toLocaleString()}</div>
                </div>

                <div className="bg-white/10 rounded-lg p-3">
                  <div className="flex items-center gap-1.5 mb-1">
                    <svg className="w-3 h-3" style={{ color: primaryColor }} fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M12 7a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0V8.414l-4.293 4.293a1 1 0 01-1.414 0L8 10.414l-4.293 4.293a1 1 0 01-1.414-1.414l5-5a1 1 0 011.414 0L11 10.586 14.586 7H12z" clipRule="evenodd" />
                    </svg>
                    <span className="text-[9px] uppercase tracking-wider opacity-60">
                      Revenue Recovered
                    </span>
                  </div>
                  <div className="text-lg font-bold">${calculations.recoveredRevenue.toLocaleString()}</div>
                </div>

                <div className="bg-white/10 rounded-lg p-3">
                  <div className="flex items-center gap-1.5 mb-1">
                    <svg className="w-3 h-3" style={{ color: primaryColor }} fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
                    </svg>
                    <span className="text-[9px] uppercase tracking-wider opacity-60">
                      {companyName} Cost/Year
                    </span>
                  </div>
                  <div className="text-lg font-bold">${calculations.productAnnualCost.toLocaleString()}</div>
                </div>

                <div className="bg-white/10 rounded-lg p-3">
                  <div className="flex items-center gap-1.5 mb-1">
                    <svg className="w-3 h-3" style={{ color: primaryColor }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                    </svg>
                    <span className="text-[9px] uppercase tracking-wider opacity-60">Total Benefit</span>
                  </div>
                  <div className="text-lg font-bold" style={{ color: primaryColor }}>
                    ${calculations.totalBenefit.toLocaleString()}
                  </div>
                </div>
              </div>

              <button
                onClick={onGetStarted}
                className="w-full py-2.5 rounded-lg text-sm font-semibold transition-opacity hover:opacity-90 text-white"
                style={{ backgroundColor: primaryColor }}
              >
                Start saving today
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

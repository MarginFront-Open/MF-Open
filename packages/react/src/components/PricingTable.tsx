'use client';

/**
 * PricingTable Component
 * Beautiful pricing table with animations and theme support
 */

import { motion } from 'framer-motion';
import { Check, Star } from 'lucide-react';
import { useMarginFrontContext } from '../context';
import { cn } from '../utils/cn';

/**
 * Pricing plan configuration
 */
export interface PricingPlan {
  /** Unique plan ID */
  id: string;
  /** Plan name */
  name: string;
  /** Plan description */
  description?: string;
  /** Price amount */
  price: number;
  /** Billing cycle */
  billingCycle: 'monthly' | 'yearly' | 'one-time';
  /** Currency code */
  currency?: string;
  /** Feature list */
  features: string[];
  /** Whether this is the popular/recommended plan */
  isPopular?: boolean;
  /** Whether this plan is available */
  isAvailable?: boolean;
  /** Custom CTA text */
  ctaText?: string;
  /** Original price (for showing discount) */
  originalPrice?: number;
}

interface PricingTableProps {
  /** Pricing plans to display */
  plans: PricingPlan[];
  /** Callback when a plan is selected */
  onSelectPlan?: (plan: PricingPlan) => void;
  /** Show billing cycle toggle */
  showBillingToggle?: boolean;
  /** Default billing cycle */
  defaultBillingCycle?: 'monthly' | 'yearly';
  /** Title above the table */
  title?: string;
  /** Subtitle/description */
  subtitle?: string;
  /** Custom class name */
  className?: string;
  /** Theme override */
  theme?: 'light' | 'dark';
}

/**
 * PricingTable - Display pricing plans with beautiful design
 */
export function PricingTable({
  plans,
  onSelectPlan,
  title,
  subtitle,
  className,
  theme: themeProp,
}: PricingTableProps) {
  const { theme: contextTheme } = useMarginFrontContext();
  const primaryColor = contextTheme.primary || '#047857';
  const secondaryColor = contextTheme.secondary || '#6B7280';
  const accentColor = contextTheme.accent || '#10B981';

  // Determine effective theme
  const isDark = themeProp === 'dark';

  const getThemeStyles = () => {
    if (isDark) {
      return {
        bg: 'bg-slate-900',
        cardBg: 'bg-slate-800',
        cardBgPopular: 'bg-slate-700',
        text: 'text-white',
        textMuted: 'text-slate-400',
        border: 'border-slate-700',
        checkColor: 'text-emerald-400',
      };
    }
    return {
      bg: 'bg-white',
      cardBg: 'bg-gray-50',
      cardBgPopular: 'bg-white',
      text: 'text-gray-900',
      textMuted: 'text-gray-600',
      border: 'border-gray-200',
      checkColor: 'text-emerald-500',
    };
  };

  const styles = getThemeStyles();

  if (!plans.length) {
    return (
      <div className={cn('marginfront-pricing-table', className)}>
        <div className={cn('rounded-xl border p-8 text-center', styles.cardBg, styles.border)}>
          <p className={styles.textMuted}>No pricing plans available</p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('marginfront-pricing-table', className)}>
      {/* Header */}
      {(title || subtitle) && (
        <div className="text-center mb-8">
          {title && (
            <h2 className={cn('text-2xl font-bold', styles.text)}>{title}</h2>
          )}
          {subtitle && (
            <p className={cn('mt-2 text-sm', styles.textMuted)}>{subtitle}</p>
          )}
        </div>
      )}

      {/* Plans Grid */}
      <div
        className={cn(
          'grid gap-3',
          plans.length <= 3 ? 'grid-cols-1 md:grid-cols-3' : 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'
        )}
      >
        {plans.map((plan, index) => {
          const isPopular = plan.isPopular || (plans.length === 3 && index === 1);
          const isAvailable = plan.isAvailable !== false;
          const hasDiscount = plan.originalPrice && plan.originalPrice > plan.price;

          return (
            <motion.div
              key={plan.id}
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 * (index + 1) }}
              className={cn(
                'relative rounded-xl p-4 border transition-all duration-300',
                !isAvailable && 'opacity-50',
                isPopular
                  ? `${styles.cardBgPopular} shadow-lg`
                  : `${styles.cardBg} ${styles.border}`,
                isPopular && 'transform md:-translate-y-2 md:scale-[1.02]'
              )}
              style={
                isPopular
                  ? {
                      boxShadow: `0 10px 30px ${primaryColor}25`,
                      borderColor: primaryColor,
                    }
                  : undefined
              }
            >
              {/* Popular Badge */}
              {isPopular && (
                <div
                  className="absolute -top-2 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full text-[10px] font-semibold text-white flex items-center gap-1"
                  style={{ backgroundColor: primaryColor }}
                >
                  <Star className="w-2.5 h-2.5" />
                  Popular
                </div>
              )}

              {/* Plan Name */}
              <h3 className={cn('text-sm font-semibold mb-1', styles.text)}>
                {plan.name}
              </h3>

              {plan.description && (
                <p className={cn('text-xs mb-2', styles.textMuted)}>{plan.description}</p>
              )}

              {/* Price */}
              <div className="mb-3">
                {hasDiscount && (
                  <span className={cn('text-sm line-through mr-2', styles.textMuted)}>
                    {formatCurrency(plan.originalPrice!, plan.currency)}
                  </span>
                )}
                <span
                  className="text-2xl font-bold"
                  style={{ color: isPopular ? primaryColor : undefined }}
                >
                  {formatCurrency(plan.price, plan.currency)}
                </span>
                <span className={cn('text-xs ml-1', styles.textMuted)}>
                  {plan.billingCycle === 'yearly' ? '/year' : plan.billingCycle === 'one-time' ? '' : '/mo'}
                </span>
              </div>

              {/* Features */}
              <ul className="space-y-1.5 mb-4">
                {plan.features.slice(0, 4).map((feature, i) => (
                  <motion.li
                    key={i}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.3 + i * 0.1 }}
                    className={cn('flex items-start gap-1.5 text-xs', styles.textMuted)}
                  >
                    <Check
                      className={cn('w-3 h-3 mt-0.5 flex-shrink-0', styles.checkColor)}
                      style={isPopular ? { color: accentColor } : undefined}
                    />
                    <span>{feature}</span>
                  </motion.li>
                ))}
                {plan.features.length > 4 && (
                  <li className={cn('text-xs', styles.textMuted)}>
                    +{plan.features.length - 4} more
                  </li>
                )}
              </ul>

              {/* CTA Button */}
              <button
                onClick={() => onSelectPlan?.(plan)}
                disabled={!isAvailable}
                className={cn(
                  'w-full py-2 px-3 rounded-lg text-sm font-medium transition-all duration-200',
                  isPopular
                    ? 'text-white hover:opacity-90'
                    : `${styles.cardBg} ${styles.text} border ${styles.border} hover:bg-white/10`,
                  !isAvailable && 'cursor-not-allowed'
                )}
                style={
                  isPopular
                    ? {
                        background: `linear-gradient(135deg, ${primaryColor}, ${secondaryColor})`,
                      }
                    : undefined
                }
              >
                {plan.ctaText || (isAvailable ? (plan.price === 0 ? 'Get Started Free' : 'Get Started') : 'Coming Soon')}
              </button>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

// Helper function
function formatCurrency(amount: number, currency: string = 'USD'): string {
  if (amount === 0) return 'Free';

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

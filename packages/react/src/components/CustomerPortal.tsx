'use client';

/**
 * CustomerPortal Component
 * Thin composition wrapper that arranges standalone components with tab navigation.
 * Customers can use this for a full portal, or import individual components directly.
 */

import { useState } from 'react';
import { motion } from 'framer-motion';
import { User, CreditCard, Package, BarChart3, ChevronRight } from 'lucide-react';
import type { Invoice, SubscriptionDetail, Customer } from '@marginfront/sdk';
import { useMarginFrontContext } from '../context';
import { cn } from '../utils/cn';
import { ComponentHeader } from './primitives/ComponentHeader';
import { CustomerProfile } from './CustomerProfile';
import { BillingSummary } from './BillingSummary';
import { SubscriptionOverview } from './SubscriptionOverview';
import { UsageDashboard } from './UsageDashboard';

export type PortalTab = 'profile' | 'billing' | 'subscription' | 'usage';

export interface CustomerPortalProps {
  /** Company/product name for header */
  companyName?: string;
  /** Logo URL or React node */
  logo?: string | React.ReactNode;
  /** Default active tab */
  defaultTab?: PortalTab;
  /** Show header */
  showHeader?: boolean;
  /** Show customize button */
  showCustomize?: boolean;
  /** Customize click handler */
  onCustomize?: () => void;
  /** Callback when invoice is clicked */
  onInvoiceClick?: (invoice: Invoice) => void;
  /** Callback when manage subscription is clicked */
  onManageSubscription?: (subscription: SubscriptionDetail) => void;
  /** Callback when upgrade is clicked */
  onUpgrade?: () => void;
  /** Callback when edit profile is clicked */
  onEditProfile?: (customer: Customer) => void;
  /** Custom class name */
  className?: string;
  /** Brand color override */
  brandColor?: string;
  /** Theme override */
  theme?: 'light' | 'dark';
}

const menuItems = [
  { icon: User, label: 'Profile', tab: 'profile' as const },
  { icon: CreditCard, label: 'Billing', tab: 'billing' as const },
  { icon: Package, label: 'Subscription', tab: 'subscription' as const },
  { icon: BarChart3, label: 'Usage', tab: 'usage' as const },
];

export function CustomerPortal({
  companyName = 'Your Product',
  logo,
  defaultTab = 'profile',
  showHeader = true,
  showCustomize = false,
  onCustomize,
  onInvoiceClick,
  onManageSubscription,
  onUpgrade,
  onEditProfile,
  className,
  brandColor,
  theme: themeProp,
}: CustomerPortalProps) {
  const { theme: contextTheme } = useMarginFrontContext();
  const primaryColor = brandColor || contextTheme.primary || '#047857';

  const [activeTab, setActiveTab] = useState<PortalTab>(defaultTab);
  const isDark = themeProp === 'dark';

  const getThemeStyles = () => {
    if (isDark) {
      return {
        bg: 'bg-slate-900',
        cardBg: 'bg-slate-800',
        text: 'text-white',
        textMuted: 'text-slate-400',
        border: 'border-slate-700',
        hoverBg: 'hover:bg-slate-700/50',
        activeBg: 'bg-slate-700/80',
      };
    }
    return {
      bg: 'bg-white',
      cardBg: 'bg-gray-50',
      text: 'text-gray-900',
      textMuted: 'text-gray-600',
      border: 'border-gray-200',
      hoverBg: 'hover:bg-gray-100',
      activeBg: 'bg-gray-100',
    };
  };

  const styles = getThemeStyles();

  // Shared props passed down to child components
  const sharedProps = {
    companyName,
    logo,
    brandColor,
    theme: themeProp,
    showHeader: false, // Portal header is shown at the top level
  };

  const renderContent = () => {
    switch (activeTab) {
      case 'profile':
        return <CustomerProfile {...sharedProps} onEdit={onEditProfile} />;
      case 'billing':
        return (
          <BillingSummary
            {...sharedProps}
            onInvoiceClick={onInvoiceClick}
            showRecentInvoices
          />
        );
      case 'subscription':
        return (
          <SubscriptionOverview
            {...sharedProps}
            onUpgrade={onUpgrade}
            onManage={onManageSubscription}
          />
        );
      case 'usage':
        return <UsageDashboard {...sharedProps} />;
      default:
        return null;
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className={cn('marginfront-customer-portal rounded-xl border overflow-hidden', styles.bg, styles.border, className)}
    >
      {/* Header */}
      {showHeader && (
        <ComponentHeader
          companyName={companyName}
          logo={logo}
          componentLabel="Customer Portal"
          showCustomize={showCustomize}
          onCustomize={onCustomize}
          brandColor={primaryColor}
        />
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 p-4">
        {/* Left Column - Navigation */}
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.3 }}
          className={cn('rounded-xl p-3 border md:col-span-1', styles.cardBg, styles.border)}
        >
          <div className="space-y-0.5">
            {menuItems.map((item, index) => {
              const Icon = item.icon;
              const isActive = activeTab === item.tab;

              return (
                <motion.button
                  key={item.label}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.4 + index * 0.05 }}
                  onClick={() => setActiveTab(item.tab)}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-all',
                    isActive ? styles.activeBg : styles.hoverBg
                  )}
                  style={isActive ? { borderLeft: `2px solid ${primaryColor}` } : undefined}
                >
                  <Icon
                    className="w-4 h-4"
                    style={{ color: isActive ? primaryColor : undefined }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className={cn('font-medium text-xs', isActive ? styles.text : styles.textMuted)}>
                      {item.label}
                    </div>
                  </div>
                  <ChevronRight className={cn('w-3 h-3', styles.textMuted)} />
                </motion.button>
              );
            })}
          </div>
        </motion.div>

        {/* Right Column - Content */}
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.3 }}
          className="md:col-span-2"
        >
          {renderContent()}
        </motion.div>
      </div>
    </motion.div>
  );
}

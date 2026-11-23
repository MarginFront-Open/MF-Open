'use client';

/**
 * CustomerProfile Component
 * Standalone customer profile card with contact info and status
 * Follows the InvoiceHistory pattern for consistency
 */

import { motion } from 'framer-motion';
import { User, Mail, Phone, Globe, Clock, Building, AlertCircle } from 'lucide-react';
import type { Customer } from '@marginfront/sdk';
import { useCustomer } from '../hooks/useCustomer';
import { useMarginFrontContext } from '../context';
import { cn } from '../utils/cn';
import { ComponentHeader } from './primitives/ComponentHeader';
import { StatusBadge } from './primitives/StatusBadge';

export interface CustomerProfileProps {
  /** Company/product name for header */
  companyName?: string;
  /** Logo URL or React node */
  logo?: string | React.ReactNode;
  /** Pre-loaded customer data (skips fetch) */
  customer?: Customer;
  /** Override customer ID from context */
  customerId?: string;
  /** Callback when edit is clicked */
  onEdit?: (customer: Customer) => void;
  /** Show header */
  showHeader?: boolean;
  /** Show customize button */
  showCustomize?: boolean;
  /** Customize click handler */
  onCustomize?: () => void;
  /** Custom class name */
  className?: string;
  /** Brand color override */
  brandColor?: string;
  /** Theme override */
  theme?: 'light' | 'dark';
}

export function CustomerProfile({
  companyName = 'Your Product',
  logo,
  customer: providedCustomer,
  customerId,
  onEdit,
  showHeader = false,
  showCustomize = false,
  onCustomize,
  className,
  brandColor,
  theme: themeProp,
}: CustomerProfileProps) {
  const { theme: contextTheme } = useMarginFrontContext();
  const primaryColor = brandColor || contextTheme.primary || '#047857';
  const isDark = themeProp === 'dark';

  const {
    customer: fetchedCustomer,
    isLoading,
    error,
  } = useCustomer({
    customerId,
    enabled: !providedCustomer,
  });

  const customer = providedCustomer || fetchedCustomer;

  const getThemeStyles = () => {
    if (isDark) {
      return {
        bg: 'bg-slate-900',
        cardBg: 'bg-slate-800',
        text: 'text-white',
        textMuted: 'text-slate-400',
        border: 'border-slate-700',
      };
    }
    return {
      bg: 'bg-white',
      cardBg: 'bg-gray-50',
      text: 'text-gray-900',
      textMuted: 'text-gray-600',
      border: 'border-gray-200',
    };
  };

  const styles = getThemeStyles();

  // Loading state
  if (isLoading && !customer) {
    return (
      <div className={cn('marginfront-customer-profile rounded-xl border overflow-hidden', styles.bg, styles.border, className)}>
        {showHeader && (
          <div className="px-4 py-3 border-b animate-pulse" style={{ borderColor: isDark ? '#334155' : '#f3f4f6' }}>
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded-lg bg-gray-200" />
              <div className="h-4 w-28 bg-gray-200 rounded" />
            </div>
          </div>
        )}
        <div className="p-4 animate-pulse space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-gray-200" />
            <div className="space-y-2">
              <div className="h-4 w-32 bg-gray-200 rounded" />
              <div className="h-3 w-24 bg-gray-200 rounded" />
            </div>
          </div>
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 bg-gray-100 rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className={cn('marginfront-customer-profile rounded-xl border overflow-hidden', styles.bg, styles.border, className)}>
        <div className="p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-3">
            <AlertCircle className="w-6 h-6 text-red-500" />
          </div>
          <p className={cn('font-medium', styles.text)}>Failed to load profile</p>
          <p className={cn('text-sm mt-1', styles.textMuted)}>{error.message}</p>
        </div>
      </div>
    );
  }

  // Empty state
  if (!customer) {
    return (
      <div className={cn('marginfront-customer-profile rounded-xl border overflow-hidden', styles.bg, styles.border, className)}>
        {showHeader && (
          <ComponentHeader
            companyName={companyName}
            logo={logo}
            componentLabel="Profile"
            showCustomize={showCustomize}
            onCustomize={onCustomize}
            brandColor={primaryColor}
          />
        )}
        <div className="p-12 text-center">
          <div
            className="w-14 h-14 rounded-xl flex items-center justify-center mx-auto mb-4"
            style={{ backgroundColor: `${primaryColor}15` }}
          >
            <User className="w-7 h-7" style={{ color: primaryColor }} />
          </div>
          <p className={cn('font-medium', styles.text)}>No profile found</p>
          <p className={cn('text-sm mt-1', styles.textMuted)}>Customer profile data is not available</p>
        </div>
      </div>
    );
  }

  const initials = customer.name
    ? customer.name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2)
    : '?';

  const infoRows = [
    { icon: Mail, label: 'Email', value: customer.email },
    { icon: Phone, label: 'Phone', value: customer.phone },
    { icon: Globe, label: 'Timezone', value: customer.timezone },
    { icon: Building, label: 'Billing Contact', value: customer.billingContactName || customer.billingContactEmail },
    { icon: Clock, label: 'Member Since', value: formatDate(customer.createdAt) },
  ].filter((row) => row.value);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className={cn('marginfront-customer-profile rounded-xl border overflow-hidden', styles.bg, styles.border, className)}
    >
      {/* Header */}
      {showHeader && (
        <ComponentHeader
          companyName={companyName}
          logo={logo}
          componentLabel="Profile"
          showCustomize={showCustomize}
          onCustomize={onCustomize}
          brandColor={primaryColor}
        />
      )}

      <div className="p-4">
        {/* Avatar + Name + Status */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="flex items-center gap-3 mb-4"
        >
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center text-white font-semibold text-sm flex-shrink-0"
            style={{ background: `linear-gradient(135deg, ${primaryColor}, ${primaryColor}cc)` }}
          >
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className={cn('text-sm font-semibold truncate', styles.text)}>
                {customer.name}
              </h3>
              <StatusBadge
                status={customer.status === 'active' ? 'active' : customer.status === 'suspended' ? 'error' : 'warning'}
                label={customer.status.charAt(0).toUpperCase() + customer.status.slice(1)}
                size="sm"
              />
            </div>
            {customer.email && (
              <p className={cn('text-xs truncate', styles.textMuted)}>{customer.email}</p>
            )}
          </div>
        </motion.div>

        {/* Info Rows */}
        <div className={cn('rounded-xl border overflow-hidden', styles.cardBg, styles.border)}>
          {infoRows.map((row, index) => {
            const Icon = row.icon;
            return (
              <motion.div
                key={row.label}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.3 + index * 0.05 }}
                className={cn(
                  'flex items-center gap-3 px-4 py-2.5',
                  index !== infoRows.length - 1 && `border-b ${styles.border}`
                )}
              >
                <div
                  className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ backgroundColor: `${primaryColor}10` }}
                >
                  <Icon className="w-3.5 h-3.5" style={{ color: primaryColor }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className={cn('text-[10px] uppercase tracking-wide', styles.textMuted)}>{row.label}</div>
                  <div className={cn('text-xs font-medium truncate', styles.text)}>{row.value}</div>
                </div>
              </motion.div>
            );
          })}
        </div>

        {/* Edit Button */}
        {onEdit && (
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => onEdit(customer)}
            className={cn(
              'w-full mt-3 py-2 px-3 rounded-lg text-xs font-medium border transition-all',
              styles.border,
              styles.text
            )}
          >
            Edit Profile
          </motion.button>
        )}
      </div>
    </motion.div>
  );
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

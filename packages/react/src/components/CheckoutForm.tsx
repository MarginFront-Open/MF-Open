'use client';

/**
 * CheckoutForm Component
 * Beautiful checkout form with order summary and payment fields
 */

import { useState } from 'react';
import { motion } from 'framer-motion';
import { CreditCard, Lock, Shield, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { useMarginFrontContext } from '../context';
import { cn } from '../utils/cn';
import { ComponentHeader } from './primitives/ComponentHeader';

export interface OrderItem {
  /** Item name */
  name: string;
  /** Item description */
  description?: string;
  /** Price amount */
  price: number;
  /** Quantity */
  quantity?: number;
}

export interface CheckoutFormProps {
  /** Company/product name for header */
  companyName?: string;
  /** Logo URL or React node */
  logo?: string | React.ReactNode;
  /** Order items to display */
  items: OrderItem[];
  /** Tax amount */
  tax?: number;
  /** Currency code */
  currency?: string;
  /** Show header */
  showHeader?: boolean;
  /** Show customize button */
  showCustomize?: boolean;
  /** Customize click handler */
  onCustomize?: () => void;
  /** Submit handler */
  onSubmit?: (data: CheckoutData) => void | Promise<void>;
  /** Custom Stripe Elements slot */
  stripeElements?: React.ReactNode;
  /** Loading state */
  isLoading?: boolean;
  /** Error message */
  error?: string;
  /** Success state */
  isSuccess?: boolean;
  /** Custom submit button text */
  submitText?: string;
  /** Custom class name */
  className?: string;
  /** Brand color override */
  brandColor?: string;
  /** Theme override */
  theme?: 'light' | 'dark';
}

export interface CheckoutData {
  email: string;
  name: string;
}

export function CheckoutForm({
  companyName = 'Your Product',
  logo,
  items,
  tax = 0,
  currency = 'USD',
  showHeader = false,
  showCustomize = false,
  onCustomize,
  onSubmit,
  stripeElements,
  isLoading = false,
  error,
  isSuccess = false,
  submitText,
  className,
  brandColor,
  theme: themeProp,
}: CheckoutFormProps) {
  const { theme: contextTheme } = useMarginFrontContext();
  const primaryColor = brandColor || contextTheme.primary || '#047857';
  const secondaryColor = contextTheme.secondary || '#6B7280';
  const accentColor = contextTheme.accent || '#10B981';

  const [formData, setFormData] = useState({ email: '', name: '' });
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const isDark = themeProp === 'dark';

  // Calculate totals
  const subtotal = items.reduce((sum, item) => sum + item.price * (item.quantity || 1), 0);
  const total = subtotal + tax;

  const getThemeStyles = () => {
    if (isDark) {
      return {
        bg: 'bg-slate-900',
        cardBg: 'bg-slate-800',
        inputBg: 'bg-slate-900',
        text: 'text-white',
        textMuted: 'text-slate-400',
        border: 'border-slate-700',
        inputBorder: 'border-slate-600',
      };
    }
    return {
      bg: 'bg-white',
      cardBg: 'bg-gray-50',
      inputBg: 'bg-white',
      text: 'text-gray-900',
      textMuted: 'text-gray-600',
      border: 'border-gray-200',
      inputBorder: 'border-gray-300',
    };
  };

  const styles = getThemeStyles();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (onSubmit) {
      await onSubmit(formData);
    }
  };

  // Success state
  if (isSuccess) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className={cn('marginfront-checkout-form rounded-xl border overflow-hidden', styles.bg, styles.border, className)}
      >
        {showHeader && (
          <ComponentHeader
            companyName={companyName}
            logo={logo}
            componentLabel="Checkout"
            showCustomize={showCustomize}
            onCustomize={onCustomize}
            brandColor={primaryColor}
          />
        )}
        <div className="p-8 text-center">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.2, type: 'spring', stiffness: 200 }}
            className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4"
            style={{ backgroundColor: `${accentColor}20` }}
          >
            <CheckCircle className="w-7 h-7" style={{ color: accentColor }} />
          </motion.div>
          <h3 className={cn('text-lg font-bold mb-2', styles.text)}>Payment Successful!</h3>
          <p className={cn('text-sm', styles.textMuted)}>Thank you for your purchase.</p>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className={cn('marginfront-checkout-form rounded-xl border overflow-hidden', styles.bg, styles.border, className)}
    >
      {/* Header */}
      {showHeader && (
        <ComponentHeader
          companyName={companyName}
          logo={logo}
          componentLabel="Checkout"
          showCustomize={showCustomize}
          onCustomize={onCustomize}
          brandColor={primaryColor}
        />
      )}

      <form onSubmit={handleSubmit} className="p-4">
        {/* Order Summary */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className={cn('pb-3 mb-3 border-b', styles.border)}
        >
          <div className="space-y-1.5">
            {items.map((item, index) => (
              <div key={index} className="flex items-center justify-between text-sm">
                <span className={styles.textMuted}>
                  {item.name}
                  {item.quantity && item.quantity > 1 && (
                    <span className="ml-1">× {item.quantity}</span>
                  )}
                </span>
                <span className={styles.text}>
                  {formatCurrency(item.price * (item.quantity || 1), currency)}
                </span>
              </div>
            ))}
          </div>

          {tax > 0 && (
            <div className="flex items-center justify-between text-xs mt-1.5">
              <span className={styles.textMuted}>Tax</span>
              <span className={styles.textMuted}>{formatCurrency(tax, currency)}</span>
            </div>
          )}

          <div className={cn('flex items-center justify-between mt-2 pt-2 border-t', styles.border)}>
            <span className={cn('text-sm font-semibold', styles.text)}>Total</span>
            <span
              className="text-lg font-bold"
              style={{ color: primaryColor }}
            >
              {formatCurrency(total, currency)}
            </span>
          </div>
        </motion.div>

        {/* Payment Form */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="space-y-2.5"
        >
          {/* Email */}
          <div>
            <label className={cn('block text-xs mb-1', styles.textMuted)}>Email</label>
            <input
              type="email"
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              placeholder="you@example.com"
              required
              className={cn(
                'w-full px-3 py-2 rounded-lg border text-xs transition-all outline-none',
                styles.inputBg,
                styles.inputBorder,
                styles.text,
                focusedField === 'email' && 'ring-2'
              )}
              style={
                focusedField === 'email'
                  ? { borderColor: primaryColor, boxShadow: `0 0 0 2px ${primaryColor}40` }
                  : undefined
              }
              onFocus={() => setFocusedField('email')}
              onBlur={() => setFocusedField(null)}
            />
          </div>

          {/* Stripe Elements Slot or Mock Card Fields */}
          {stripeElements ? (
            <div className="space-y-2.5">{stripeElements}</div>
          ) : (
            <>
              {/* Card Number */}
              <div>
                <label className={cn('block text-xs mb-1', styles.textMuted)}>Card Number</label>
                <div className="relative">
                  <input
                    type="text"
                    placeholder="1234 5678 9012 3456"
                    className={cn(
                      'w-full px-3 py-2 pl-9 rounded-lg border text-xs transition-all outline-none',
                      styles.inputBg,
                      styles.inputBorder,
                      styles.text,
                      focusedField === 'card' && 'ring-2'
                    )}
                    style={
                      focusedField === 'card'
                        ? { borderColor: primaryColor, boxShadow: `0 0 0 2px ${primaryColor}40` }
                        : undefined
                    }
                    onFocus={() => setFocusedField('card')}
                    onBlur={() => setFocusedField(null)}
                  />
                  <CreditCard
                    className={cn('absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5', styles.textMuted)}
                  />
                </div>
              </div>

              {/* Expiry & CVC */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={cn('block text-xs mb-1', styles.textMuted)}>Expiry</label>
                  <input
                    type="text"
                    placeholder="MM/YY"
                    className={cn(
                      'w-full px-3 py-2 rounded-lg border text-xs transition-all outline-none',
                      styles.inputBg,
                      styles.inputBorder,
                      styles.text,
                      focusedField === 'expiry' && 'ring-2'
                    )}
                    style={
                      focusedField === 'expiry'
                        ? { borderColor: primaryColor, boxShadow: `0 0 0 2px ${primaryColor}40` }
                        : undefined
                    }
                    onFocus={() => setFocusedField('expiry')}
                    onBlur={() => setFocusedField(null)}
                  />
                </div>
                <div>
                  <label className={cn('block text-xs mb-1', styles.textMuted)}>CVC</label>
                  <div className="relative">
                    <input
                      type="text"
                      placeholder="123"
                      className={cn(
                        'w-full px-3 py-2 pr-8 rounded-lg border text-xs transition-all outline-none',
                        styles.inputBg,
                        styles.inputBorder,
                        styles.text,
                        focusedField === 'cvc' && 'ring-2'
                      )}
                      style={
                        focusedField === 'cvc'
                          ? { borderColor: primaryColor, boxShadow: `0 0 0 2px ${primaryColor}40` }
                          : undefined
                      }
                      onFocus={() => setFocusedField('cvc')}
                      onBlur={() => setFocusedField(null)}
                    />
                    <Lock
                      className={cn('absolute right-3 top-1/2 -translate-y-1/2 w-3 h-3', styles.textMuted)}
                    />
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Name on Card */}
          <div>
            <label className={cn('block text-xs mb-1', styles.textMuted)}>Name on Card</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="John Doe"
              required
              className={cn(
                'w-full px-3 py-2 rounded-lg border text-xs transition-all outline-none',
                styles.inputBg,
                styles.inputBorder,
                styles.text,
                focusedField === 'name' && 'ring-2'
              )}
              style={
                focusedField === 'name'
                  ? { borderColor: primaryColor, boxShadow: `0 0 0 2px ${primaryColor}40` }
                  : undefined
              }
              onFocus={() => setFocusedField('name')}
              onBlur={() => setFocusedField(null)}
            />
          </div>

          {/* Error Message */}
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="p-3 rounded-lg bg-red-50 border border-red-100"
            >
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                <p className="text-xs text-red-600 font-medium">{error}</p>
              </div>
            </motion.div>
          )}

          {/* Submit Button */}
          <motion.button
            type="submit"
            disabled={isLoading}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className={cn(
              'w-full py-2.5 px-4 rounded-lg text-sm font-semibold text-white flex items-center justify-center gap-1.5 transition-all',
              isLoading && 'opacity-70 cursor-not-allowed'
            )}
            style={{
              background: `linear-gradient(135deg, ${primaryColor}, ${secondaryColor})`,
            }}
          >
            {isLoading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Processing...
              </>
            ) : (
              <>
                <Lock className="w-3.5 h-3.5" />
                {submitText || `Pay ${formatCurrency(total, currency)}`}
              </>
            )}
          </motion.button>

          {/* Security Badges */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
            className="flex items-center justify-center gap-3 pt-2"
          >
            <div className="flex items-center gap-1 text-[10px]" style={{ color: accentColor }}>
              <Shield className="w-3 h-3" />
              <span>Secure</span>
            </div>
            <div className="flex items-center gap-1 text-[10px]" style={{ color: accentColor }}>
              <CheckCircle className="w-3 h-3" />
              <span>Encrypted</span>
            </div>
          </motion.div>
        </motion.div>
      </form>
    </motion.div>
  );
}

// Helper function
function formatCurrency(amount: number, currency: string = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

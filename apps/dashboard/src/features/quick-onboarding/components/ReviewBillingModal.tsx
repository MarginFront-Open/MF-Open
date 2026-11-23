'use client'

/**
 * ReviewBillingModal: a modal panel showing extracted billing context and
 * brand colors, with a full-width continue button at the bottom.
 */
import { useState, useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X,
  Globe,
  RefreshCw,
  Sparkles,
  CheckCircle2,
  Zap,
  TrendingUp,
  Check,
  Building2,
  Loader2,
  ExternalLink,
  ArrowRight,
  Layers,
  Briefcase,
} from 'lucide-react'
import Image from 'next/image'
import { cn } from '@/lib/utils'
import { useTheme } from '@/context/theme-context'

export interface ExtractedContext {
  pricingMechanics?: string
  marketPosition?: string
  goToMarket?: string
  scalabilityLevers?: string
  risksAndMitigations?: string
  successMetrics?: string
  productOverview?: string
  businessModel?: string
  customerSegments?: string
  brandIdentity?: string
}

export interface ExtractedBranding {
  primaryColor?: string
  secondaryColor?: string
  accentColor?: string
  companyLogo?: string
  companyName?: string
}

interface ReviewBillingModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (selectedColor?: string) => void
  onReanalyze: () => void
  websiteUrl: string
  extractedContext?: ExtractedContext | null
  extractedBranding?: ExtractedBranding | null
  isDataLoading?: boolean
}

const COLOR_PALETTE = [
  { color: '#10b981', name: 'Emerald' },
  { color: '#3b82f6', name: 'Blue' },
  { color: '#8b5cf6', name: 'Purple' },
  { color: '#ef4444', name: 'Red' },
  { color: '#f59e0b', name: 'Amber' },
  { color: '#ec4899', name: 'Pink' },
  { color: '#14b8a6', name: 'Teal' },
  { color: '#6366f1', name: 'Indigo' },
]

const Skeleton = ({ className }: { className?: string }) => (
  <div
    className={cn(
      'relative overflow-hidden rounded-md',
      'bg-neutral-200 dark:bg-slate-700',
      className
    )}
  >
    <div className='absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/40 to-transparent dark:via-white/10' />
  </div>
)

const ReviewBillingModal = ({
  isOpen,
  onClose,
  onConfirm,
  onReanalyze,
  websiteUrl,
  extractedContext,
  extractedBranding,
  isDataLoading = false,
}: ReviewBillingModalProps) => {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  const [selectedColor, setSelectedColor] = useState(
    extractedBranding?.primaryColor || '#10b981'
  )

  const hasRealData = useMemo(() => {
    return !!(
      extractedContext?.pricingMechanics ||
      extractedContext?.productOverview ||
      extractedBranding?.companyLogo
    )
  }, [extractedContext, extractedBranding])

  /* eslint-disable react-hooks/set-state-in-effect -- valid sync of branding prop to local state */
  useEffect(() => {
    if (extractedBranding?.primaryColor) {
      setSelectedColor(extractedBranding.primaryColor)
    }
  }, [extractedBranding?.primaryColor])
  /* eslint-enable react-hooks/set-state-in-effect */

  const showLoading = isDataLoading

  const contextToShow: ExtractedContext | null = extractedContext ?? null

  useEffect(() => {
    if (isOpen) {
      console.log('[ReviewBillingModal] State:', {
        isDataLoading,
        hasRealData,
        showLoading,
        hasContext: !!extractedContext,
        contextFields: extractedContext
          ? Object.keys(extractedContext).filter(
              (k) => !!(extractedContext as any)[k]
            )
          : [],
        hasBranding: !!extractedBranding,
        brandingFields: extractedBranding
          ? Object.keys(extractedBranding).filter(
              (k) => !!(extractedBranding as any)[k]
            )
          : [],
      })
    }
  }, [
    isOpen,
    isDataLoading,
    hasRealData,
    showLoading,
    extractedContext,
    extractedBranding,
  ])

  // Context items with professional styling
  const contextItems = [
    {
      key: 'productOverview',
      label: 'Product',
      description: 'What you offer',
      icon: Layers,
      color: '#8b5cf6',
    },
    {
      key: 'pricingMechanics',
      label: 'Pricing',
      description: 'How you charge',
      icon: Zap,
      color: '#f59e0b',
    },
    {
      key: 'businessModel',
      label: 'Business',
      description: 'Your model',
      icon: Briefcase,
      color: '#3b82f6',
    },
    {
      key: 'goToMarket',
      label: 'Growth',
      description: 'Go-to-market',
      icon: TrendingUp,
      color: '#10b981',
    },
  ] as const

  const handleConfirm = () => {
    onConfirm(selectedColor)
  }

  const displayDomain = useMemo(() => {
    try {
      const url = new URL(
        websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`
      )
      return url.hostname.replace('www.', '')
    } catch {
      return websiteUrl
    }
  }, [websiteUrl])

  // Count extracted items
  const extractedCount = useMemo(() => {
    let count = 0
    if (contextToShow?.productOverview) count++
    if (contextToShow?.pricingMechanics) count++
    if (contextToShow?.businessModel) count++
    if (contextToShow?.goToMarket) count++
    return count
  }, [contextToShow])

  return (
    <AnimatePresence>
      {isOpen && (
        <div className='fixed inset-0 z-[10000]'>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className='absolute inset-0 bg-black/60 backdrop-blur-sm'
            onClick={onClose}
          />

          {/* Centered Modal Panel */}
          <div className='pointer-events-none absolute inset-0 flex items-center justify-center p-4'>
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              className={cn(
                'pointer-events-auto max-h-[85vh] w-full max-w-2xl',
                'overflow-hidden rounded-3xl shadow-2xl',
                'flex flex-col',
                isDark
                  ? 'border border-slate-700/50 bg-slate-900'
                  : 'border border-neutral-200/50 bg-white'
              )}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header - Compact with logo and actions */}
              <div
                className={cn(
                  'flex-shrink-0 border-b px-6 py-5',
                  isDark ? 'border-slate-800' : 'border-neutral-100'
                )}
              >
                <div className='flex items-center justify-between'>
                  <div className='flex items-center gap-4'>
                    {/* Logo */}
                    <div
                      className={cn(
                        'flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl',
                        'ring-2 ring-offset-2',
                        isDark
                          ? 'bg-slate-800 ring-slate-700 ring-offset-slate-900'
                          : 'bg-neutral-50 ring-neutral-200 ring-offset-white'
                      )}
                    >
                      {showLoading && !extractedBranding?.companyLogo ? (
                        <Loader2
                          className={cn(
                            'h-5 w-5 animate-spin',
                            isDark ? 'text-slate-500' : 'text-neutral-400'
                          )}
                        />
                      ) : extractedBranding?.companyLogo ? (
                        <Image
                          src={extractedBranding.companyLogo}
                          alt='Logo'
                          width={48}
                          height={48}
                          className='object-contain'
                          unoptimized
                        />
                      ) : (
                        <Building2
                          className={cn(
                            'h-6 w-6',
                            isDark ? 'text-slate-500' : 'text-neutral-400'
                          )}
                        />
                      )}
                    </div>

                    {/* Company Info */}
                    <div>
                      <div className='flex items-center gap-2'>
                        <h2
                          className={cn(
                            'text-lg font-bold',
                            isDark ? 'text-white' : 'text-neutral-900'
                          )}
                        >
                          {extractedBranding?.companyName || displayDomain}
                        </h2>
                        {!showLoading && (
                          <motion.div
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            className={cn(
                              'flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                              'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                            )}
                          >
                            <CheckCircle2 className='h-3 w-3' />
                            Scanned
                          </motion.div>
                        )}
                      </div>
                      <button
                        onClick={() =>
                          window.open(
                            websiteUrl.startsWith('http')
                              ? websiteUrl
                              : `https://${websiteUrl}`,
                            '_blank'
                          )
                        }
                        className={cn(
                          'mt-0.5 flex items-center gap-1.5 text-sm transition-colors',
                          isDark
                            ? 'text-slate-400 hover:text-slate-300'
                            : 'text-neutral-500 hover:text-neutral-700'
                        )}
                      >
                        <Globe className='h-3 w-3' />
                        <span className='font-mono text-xs'>
                          {displayDomain}
                        </span>
                        <ExternalLink className='h-3 w-3' />
                      </button>
                    </div>
                  </div>

                  {/* Header Actions */}
                  <div className='flex items-center gap-2'>
                    {/* Re-scan button */}
                    <button
                      onClick={onReanalyze}
                      disabled={showLoading}
                      className={cn(
                        'flex h-10 items-center gap-2 rounded-xl px-4',
                        'text-sm font-medium transition-all',
                        'disabled:cursor-not-allowed disabled:opacity-50',
                        isDark
                          ? 'bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white'
                          : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 hover:text-neutral-900'
                      )}
                    >
                      <RefreshCw
                        className={cn('h-4 w-4', showLoading && 'animate-spin')}
                      />
                      <span className='hidden sm:inline'>
                        {showLoading ? 'Scanning...' : 'Re-scan'}
                      </span>
                    </button>

                    <button
                      onClick={onClose}
                      className={cn(
                        'flex h-10 w-10 items-center justify-center rounded-xl transition-colors',
                        isDark
                          ? 'text-slate-400 hover:bg-slate-800 hover:text-white'
                          : 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600'
                      )}
                    >
                      <X className='h-5 w-5' />
                    </button>
                  </div>
                </div>
              </div>

              {/* Scrollable Content */}
              <div className='flex-1 overflow-y-auto px-6 py-5'>
                {/* Brand Color Selection - Compact inline */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={cn(
                    'mb-5 rounded-2xl p-4',
                    isDark ? 'bg-slate-800/50' : 'bg-neutral-50'
                  )}
                >
                  <div className='flex flex-wrap items-center justify-between gap-4'>
                    <div className='flex items-center gap-3'>
                      <div
                        className='flex h-10 w-10 items-center justify-center rounded-xl'
                        style={{ backgroundColor: `${selectedColor}20` }}
                      >
                        <div
                          className='h-5 w-5 rounded-full'
                          style={{ backgroundColor: selectedColor }}
                        />
                      </div>
                      <div>
                        <div
                          className={cn(
                            'text-sm font-semibold',
                            isDark ? 'text-white' : 'text-neutral-900'
                          )}
                        >
                          Brand Color
                        </div>
                        <div
                          className={cn(
                            'text-xs',
                            isDark ? 'text-slate-400' : 'text-neutral-500'
                          )}
                        >
                          {extractedBranding?.primaryColor
                            ? 'Auto-detected from website'
                            : 'Choose your brand color'}
                        </div>
                      </div>
                    </div>

                    <div className='flex items-center gap-2'>
                      {/* Auto-detected color */}
                      {extractedBranding?.primaryColor &&
                        !COLOR_PALETTE.find(
                          (c) =>
                            c.color.toLowerCase() ===
                            extractedBranding.primaryColor?.toLowerCase()
                        ) && (
                          <motion.button
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            onClick={() =>
                              setSelectedColor(extractedBranding.primaryColor!)
                            }
                            className='relative'
                          >
                            <div
                              className={cn(
                                'flex h-8 w-8 items-center justify-center rounded-lg transition-all',
                                selectedColor === extractedBranding.primaryColor
                                  ? 'scale-110 ring-2 ring-offset-2'
                                  : 'hover:scale-105',
                                isDark
                                  ? 'ring-offset-slate-800'
                                  : 'ring-offset-neutral-50'
                              )}
                              style={{
                                backgroundColor: extractedBranding.primaryColor,
                                ['--tw-ring-color' as string]:
                                  selectedColor ===
                                  extractedBranding.primaryColor
                                    ? extractedBranding.primaryColor
                                    : 'transparent',
                              }}
                            >
                              {selectedColor ===
                                extractedBranding.primaryColor && (
                                <Check className='h-3.5 w-3.5 text-white drop-shadow-md' />
                              )}
                            </div>
                          </motion.button>
                        )}

                      {COLOR_PALETTE.map(({ color, name }, index) => (
                        <motion.button
                          key={color}
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          transition={{ delay: 0.02 * index }}
                          onClick={() => setSelectedColor(color)}
                          className={cn(
                            'flex h-8 w-8 items-center justify-center rounded-lg transition-all',
                            selectedColor === color
                              ? 'scale-110 ring-2 ring-offset-2'
                              : 'hover:scale-105',
                            isDark
                              ? 'ring-offset-slate-800'
                              : 'ring-offset-neutral-50'
                          )}
                          style={{
                            backgroundColor: color,
                            ['--tw-ring-color' as string]:
                              selectedColor === color ? color : 'transparent',
                          }}
                          title={name}
                        >
                          {selectedColor === color && (
                            <Check className='h-3.5 w-3.5 text-white drop-shadow-md' />
                          )}
                        </motion.button>
                      ))}
                    </div>
                  </div>
                </motion.div>

                {/* Extracted Insights */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                >
                  <div className='mb-4 flex items-center justify-between'>
                    <h3
                      className={cn(
                        'flex items-center gap-2 text-sm font-semibold',
                        isDark ? 'text-slate-300' : 'text-neutral-700'
                      )}
                    >
                      <Sparkles className='h-4 w-4' />
                      Extracted Insights
                    </h3>
                    {!showLoading && extractedCount > 0 && (
                      <span
                        className={cn(
                          'rounded-full px-2 py-0.5 text-xs font-medium',
                          isDark
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : 'bg-emerald-50 text-emerald-600'
                        )}
                      >
                        {extractedCount} found
                      </span>
                    )}
                  </div>

                  {showLoading ? (
                    <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
                      {[1, 2, 3, 4].map((i) => (
                        <div
                          key={i}
                          className={cn(
                            'rounded-2xl p-4',
                            isDark ? 'bg-slate-800/50' : 'bg-neutral-50'
                          )}
                        >
                          <div className='flex items-start gap-3'>
                            <Skeleton className='h-10 w-10 flex-shrink-0 rounded-xl' />
                            <div className='flex-1 space-y-2'>
                              <Skeleton className='h-4 w-20' />
                              <Skeleton className='h-3 w-full' />
                              <Skeleton className='h-3 w-3/4' />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
                      {contextItems.map(
                        (
                          { key, label, description, icon: Icon, color },
                          index
                        ) => {
                          const value =
                            contextToShow?.[key as keyof ExtractedContext]
                          const hasValue = !!value

                          return (
                            <motion.div
                              key={key}
                              initial={{ opacity: 0, y: 10 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ delay: 0.05 * index }}
                              className={cn(
                                'group rounded-2xl p-4 transition-all',
                                hasValue
                                  ? isDark
                                    ? 'bg-slate-800/70 hover:bg-slate-800'
                                    : 'border border-neutral-100 bg-white hover:border-neutral-200 hover:shadow-sm'
                                  : isDark
                                    ? 'bg-slate-800/30 opacity-50'
                                    : 'bg-neutral-50/50 opacity-50'
                              )}
                            >
                              <div className='flex items-start gap-3'>
                                <div
                                  className={cn(
                                    'flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl transition-transform',
                                    hasValue && 'group-hover:scale-105'
                                  )}
                                  style={{ backgroundColor: `${color}15` }}
                                >
                                  <Icon className='h-5 w-5' style={{ color }} />
                                </div>
                                <div className='min-w-0 flex-1'>
                                  <div className='flex items-center gap-2'>
                                    <span
                                      className={cn(
                                        'text-sm font-semibold',
                                        isDark
                                          ? 'text-white'
                                          : 'text-neutral-900'
                                      )}
                                    >
                                      {label}
                                    </span>
                                    {hasValue && (
                                      <CheckCircle2 className='h-3.5 w-3.5 text-emerald-500' />
                                    )}
                                  </div>
                                  {hasValue ? (
                                    <p
                                      className={cn(
                                        'mt-1 line-clamp-2 text-sm',
                                        isDark
                                          ? 'text-slate-300'
                                          : 'text-neutral-600'
                                      )}
                                    >
                                      {value}
                                    </p>
                                  ) : (
                                    <p
                                      className={cn(
                                        'mt-1 text-xs',
                                        isDark
                                          ? 'text-slate-500'
                                          : 'text-neutral-400'
                                      )}
                                    >
                                      {description} - Not detected
                                    </p>
                                  )}
                                </div>
                              </div>
                            </motion.div>
                          )
                        }
                      )}
                    </div>
                  )}
                </motion.div>
              </div>

              {/* Fixed Footer - Full width CTA */}
              <div
                className={cn(
                  'flex-shrink-0 border-t px-6 py-5',
                  isDark
                    ? 'border-slate-800 bg-slate-900/80 backdrop-blur-sm'
                    : 'border-neutral-100 bg-white/80 backdrop-blur-sm'
                )}
              >
                <button
                  onClick={handleConfirm}
                  disabled={showLoading}
                  className={cn(
                    'flex h-14 w-full items-center justify-center gap-3 rounded-2xl',
                    'text-base font-semibold text-white transition-all',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                    'hover:brightness-110 active:scale-[0.98]'
                  )}
                  style={{
                    backgroundColor: selectedColor,
                    boxShadow: `0 8px 32px -4px ${selectedColor}50`,
                  }}
                >
                  {showLoading ? (
                    <>
                      <Loader2 className='h-5 w-5 animate-spin' />
                      Processing...
                    </>
                  ) : (
                    <>
                      Continue Setup
                      <ArrowRight className='h-5 w-5' />
                    </>
                  )}
                </button>

                <p
                  className={cn(
                    'mt-3 text-center text-xs',
                    isDark ? 'text-slate-500' : 'text-neutral-400'
                  )}
                >
                  You can always edit these settings later
                </p>
              </div>
            </motion.div>
          </div>
        </div>
      )}
    </AnimatePresence>
  )
}

export default ReviewBillingModal

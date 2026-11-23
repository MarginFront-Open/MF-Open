/**
 * ModeSelectionStep — "What Brings You Here?"
 * Three cards for choosing dashboard mode during onboarding.
 * Each mode controls which sidebar items the user sees after setup.
 */
'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { DollarSign, TrendingUp, Layers, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTheme } from '@/context/theme-context'
import { DashboardMode } from '../../types/v2'

export interface ModeSelectionStepProps {
  selectedMode: DashboardMode | null
  onSelectMode: (mode: DashboardMode) => void
  onContinue: () => void
}

const MODE_CARDS: Array<{
  mode: DashboardMode
  title: string
  description: string
  icon: typeof DollarSign
  color: string
  badge?: string
}> = [
  {
    mode: 'cost_tracking',
    title: 'MF Cost Attribution',
    description:
      "Track your AI Agent's costs per usage event, per token, per tool call, for every customer.",
    icon: DollarSign,
    color: '#10b981',
  },
  {
    mode: 'revenue',
    title: 'Cost + MF Revenue Attribution',
    description:
      "Cost tracking + discover which of your AI Agent's tasks make you the most money, or which customers you're actually paying to use your platform.",
    icon: TrendingUp,
    color: '#0ea5e9',
    badge: 'Most popular',
  },
  {
    mode: 'full',
    title: 'MF Platform Suite',
    description:
      'Cost tracking + Revenue Attribution + Billing / Collecting. Collect payments through Stripe. Turn your AI Agents into Margin Machines.',
    icon: Layers,
    color: '#8b5cf6',
  },
]

const ModeSelectionStep = ({
  selectedMode,
  onSelectMode,
  onContinue,
}: ModeSelectionStepProps) => {
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'
  const [hoveredMode, setHoveredMode] = useState<DashboardMode | null>(null)

  const handleSelect = (mode: DashboardMode) => {
    onSelectMode(mode)
  }

  const handleContinue = () => {
    if (selectedMode) {
      onContinue()
    }
  }

  return (
    <div className='relative w-full overflow-hidden py-8'>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className='relative z-10 mx-auto flex w-full max-w-2xl flex-col items-center px-6'
      >
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className='text-center'
        >
          <h1
            className={cn(
              'text-3xl font-bold tracking-tight',
              isDark ? 'text-white' : 'text-neutral-900'
            )}
          >
            What Brings You Here?
          </h1>
          <p
            className={cn(
              'mt-2 text-sm',
              isDark ? 'text-slate-400' : 'text-neutral-500'
            )}
          >
            Pick what fits now. You can always change this later.
          </p>
        </motion.div>

        {/* Mode Cards */}
        <div className='mt-8 flex w-full flex-col gap-4'>
          {MODE_CARDS.map((card, index) => {
            const Icon = card.icon
            const isSelected = selectedMode === card.mode
            const isHovered = hoveredMode === card.mode

            return (
              <motion.button
                key={card.mode}
                type='button'
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 + index * 0.1, duration: 0.4 }}
                onClick={() => handleSelect(card.mode)}
                onMouseEnter={() => setHoveredMode(card.mode)}
                onMouseLeave={() => setHoveredMode(null)}
                className={cn(
                  'relative flex w-full items-start gap-4 rounded-xl border p-5 text-left transition-all duration-200',
                  isSelected
                    ? isDark
                      ? 'border-white/20 bg-white/10'
                      : 'border-neutral-900/20 bg-neutral-50'
                    : isDark
                      ? 'border-white/5 bg-white/[0.02] hover:border-white/10 hover:bg-white/[0.04]'
                      : 'border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50/50'
                )}
                style={{
                  boxShadow: isSelected
                    ? `0 0 0 1px ${card.color}40, 0 4px 12px ${card.color}15`
                    : 'none',
                }}
              >
                {/* Badge */}
                {card.badge && (
                  <span
                    className='absolute -top-2.5 right-4 rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white'
                    style={{ backgroundColor: card.color }}
                  >
                    {card.badge}
                  </span>
                )}

                {/* Icon */}
                <div
                  className={cn(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-all duration-200'
                  )}
                  style={{
                    backgroundColor:
                      isSelected || isHovered
                        ? `${card.color}20`
                        : isDark
                          ? 'rgba(255,255,255,0.05)'
                          : 'rgba(0,0,0,0.04)',
                    border: `1.5px solid ${isSelected || isHovered ? card.color : 'transparent'}`,
                  }}
                >
                  <Icon
                    className='h-5 w-5'
                    style={{
                      color:
                        isSelected || isHovered
                          ? card.color
                          : isDark
                            ? '#64748b'
                            : '#9ca3af',
                    }}
                  />
                </div>

                {/* Text */}
                <div className='flex-1'>
                  <h3
                    className={cn(
                      'text-sm font-semibold',
                      isDark ? 'text-white' : 'text-neutral-900'
                    )}
                  >
                    {card.title}
                  </h3>
                  <p
                    className={cn(
                      'mt-1 text-sm leading-relaxed',
                      isDark ? 'text-slate-400' : 'text-neutral-500'
                    )}
                  >
                    {card.description}
                  </p>
                </div>

                {/* Selection indicator */}
                <div
                  className={cn(
                    'mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-all duration-200',
                    isSelected
                      ? 'border-transparent'
                      : isDark
                        ? 'border-white/15'
                        : 'border-neutral-300'
                  )}
                  style={{
                    backgroundColor: isSelected ? card.color : 'transparent',
                  }}
                >
                  {isSelected && (
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className='h-2 w-2 rounded-full bg-white'
                    />
                  )}
                </div>
              </motion.button>
            )
          })}
        </div>

        {/* MF IQ callout */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className={cn(
            'mt-6 flex items-start gap-2.5 rounded-lg px-4 py-3',
            isDark ? 'bg-amber-500/10' : 'bg-amber-50'
          )}
        >
          <Sparkles
            className={cn(
              'mt-0.5 h-4 w-4 shrink-0',
              isDark ? 'text-amber-400' : 'text-amber-500'
            )}
          />
          <p
            className={cn(
              'text-xs leading-relaxed',
              isDark ? 'text-amber-300/80' : 'text-amber-700'
            )}
          >
            Every mode gets you <span className='font-semibold'>MFiQ</span>,
            baked-in intelligence providing you proactive guidance on all things
            AI Agent monetization.
          </p>
        </motion.div>

        {/* Continue button */}
        <motion.button
          type='button'
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6 }}
          onClick={handleContinue}
          disabled={!selectedMode}
          className={cn(
            'mt-6 w-full rounded-xl py-3 text-sm font-semibold transition-all duration-200',
            selectedMode
              ? 'cursor-pointer text-white hover:opacity-90'
              : 'cursor-not-allowed text-white/50',
            isDark ? 'bg-white/10' : 'bg-neutral-900'
          )}
          style={{
            backgroundColor: selectedMode
              ? MODE_CARDS.find((c) => c.mode === selectedMode)?.color
              : undefined,
          }}
        >
          {selectedMode ? 'Continue' : 'Pick a mode to continue'}
        </motion.button>
      </motion.div>
    </div>
  )
}

export default ModeSelectionStep

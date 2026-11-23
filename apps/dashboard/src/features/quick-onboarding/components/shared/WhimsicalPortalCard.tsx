/**
 * WhimsicalPortalCard - Portal card with built-in expandable preview
 * Preview expands on hover, other card fades
 */
'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowRight, ExternalLink, Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * WhimsicalPortalCard - Portal card with built-in expandable preview
 * Preview expands on hover, other card fades
 */

interface WhimsicalPortalCardProps {
  type: 'admin' | 'customer'
  title: string
  description: string
  primaryColor: string
  portalUrl: string
  children: React.ReactNode
  isDark: boolean
  isHovered: boolean
  isOtherHovered: boolean
  onHover: (hovered: boolean) => void
}

const WhimsicalPortalCard = ({
  type,
  title,
  description,
  primaryColor,
  portalUrl,
  children,
  isDark,
  isHovered,
  isOtherHovered,
  onHover,
}: WhimsicalPortalCardProps) => {
  const [copied, setCopied] = useState(false)

  const handleCopyUrl = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(`https://${portalUrl}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy URL:', err)
    }
  }

  // Color configurations
  const gradientConfig =
    type === 'admin'
      ? { from: '#10b981', to: '#0d9488' }
      : {
          from: primaryColor || '#f43f5e',
          to: adjustColor(primaryColor || '#f43f5e', -30),
        }

  return (
    <motion.div
      className='flex flex-col items-center gap-3'
      animate={{
        opacity: isOtherHovered ? 0.4 : 1,
        scale: isOtherHovered ? 0.96 : 1,
        filter: isOtherHovered ? 'blur(2px)' : 'blur(0px)',
        x: isOtherHovered ? (type === 'admin' ? -20 : 20) : 0,
      }}
      transition={{ duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
    >
      {/* Main Card */}
      <motion.div
        className={cn(
          'relative cursor-pointer overflow-hidden rounded-[24px]',
          'duration-400 transition-shadow'
        )}
        style={{
          width: isHovered ? 520 : 380,
          boxShadow: isHovered
            ? '0 25px 50px -12px rgba(0, 0, 0, 0.25)'
            : '0 10px 40px -10px rgba(0, 0, 0, 0.15)',
        }}
        animate={{
          scale: isHovered ? 1.02 : 1,
          y: isHovered ? -8 : 0,
        }}
        transition={{ duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
      >
        {/* Gradient Header */}
        <div
          className='relative overflow-hidden'
          style={{
            height: isHovered ? 140 : 180,
            background: `linear-gradient(135deg, ${gradientConfig.from} 0%, ${gradientConfig.to} 100%)`,
            transition: 'height 0.4s cubic-bezier(0.23, 1, 0.32, 1)',
          }}
        >
          {/* Decorative glow */}
          <div
            className='absolute inset-0 opacity-30'
            style={{
              background:
                'radial-gradient(ellipse at 50% -20%, rgba(255,255,255,0.6) 0%, transparent 60%)',
            }}
          />

          {/* Waves */}
          <svg
            className='absolute bottom-0 left-0 right-0 h-12 w-full'
            viewBox='0 0 300 48'
            preserveAspectRatio='none'
          >
            <path
              d='M0,48 L0,35 Q75,20 150,32 Q225,44 300,28 L300,48 Z'
              fill='rgba(255,255,255,0.1)'
            />
            <path
              d='M0,48 L0,40 Q75,30 150,38 Q225,46 300,36 L300,48 Z'
              fill='rgba(255,255,255,0.06)'
            />
          </svg>

          {/* Content */}
          <div className='relative z-10 flex h-full flex-col items-center justify-center px-5'>
            {/* Badge */}
            <div className='mb-3 flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 backdrop-blur-sm'>
              {type === 'admin' ? (
                <svg
                  className='h-3.5 w-3.5 text-white'
                  fill='currentColor'
                  viewBox='0 0 20 20'
                >
                  <path d='M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z' />
                </svg>
              ) : (
                <svg
                  className='h-3.5 w-3.5 text-white'
                  fill='currentColor'
                  viewBox='0 0 20 20'
                >
                  <path d='M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z' />
                </svg>
              )}
              <span className='text-xs font-bold uppercase tracking-wider text-white'>
                {type}
              </span>
            </div>

            {/* Title */}
            <h3 className='mb-1 text-center text-xl font-bold text-white'>
              {title}
            </h3>

            {/* Description - hide on hover */}
            <motion.p
              className='max-w-[240px] text-center text-sm text-white/80'
              animate={{
                opacity: isHovered ? 0 : 1,
                height: isHovered ? 0 : 'auto',
              }}
              transition={{ duration: 0.2 }}
            >
              {description}
            </motion.p>

            {/* CTA Button - hide on hover */}
            <motion.button
              className='mt-3 flex items-center gap-2 rounded-full bg-white px-5 py-2 text-sm font-semibold text-neutral-900 shadow-lg'
              animate={{
                opacity: isHovered ? 0 : 1,
                scale: isHovered ? 0.9 : 1,
              }}
              transition={{ duration: 0.2 }}
            >
              Explore <ArrowRight className='h-4 w-4' />
            </motion.button>
          </div>
        </div>

        {/* Preview Section - Expands on hover */}
        <motion.div
          className={cn(
            'relative overflow-hidden',
            isDark ? 'bg-slate-900' : 'bg-white'
          )}
          animate={{ height: isHovered ? 320 : 160 }}
          transition={{ duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
        >
          {/* Preview Container */}
          <motion.div
            className='absolute left-1/2'
            animate={{
              scale: isHovered ? 1 : 0.72,
              y: isHovered ? 12 : -20,
              x: '-50%',
            }}
            transition={{ duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
            style={{ transformOrigin: 'top center' }}
          >
            <div
              className={cn(
                'overflow-hidden rounded-xl shadow-2xl ring-1',
                isDark ? 'ring-slate-700' : 'ring-neutral-200'
              )}
            >
              {children}
            </div>
          </motion.div>

          {/* Fade gradient - only show when not hovered */}
          <motion.div
            className={cn(
              'pointer-events-none absolute bottom-0 left-0 right-0 h-12',
              isDark
                ? 'bg-gradient-to-t from-slate-900 via-slate-900/80 to-transparent'
                : 'bg-gradient-to-t from-white via-white/80 to-transparent'
            )}
            animate={{ opacity: isHovered ? 0 : 1 }}
            transition={{ duration: 0.3 }}
          />
        </motion.div>
      </motion.div>

      {/* Portal URL */}
      <motion.div
        className={cn(
          'flex items-center gap-2 rounded-full border px-4 py-2 text-sm',
          isDark
            ? 'border-slate-700 bg-slate-800/50'
            : 'border-neutral-200 bg-white shadow-sm'
        )}
        animate={{ opacity: isOtherHovered ? 0.5 : 1 }}
      >
        <ExternalLink
          className={cn(
            'h-3.5 w-3.5',
            isDark ? 'text-slate-400' : 'text-neutral-400'
          )}
        />
        <span
          className={cn(
            'font-medium',
            isDark ? 'text-white' : 'text-neutral-700'
          )}
        >
          {portalUrl}
        </span>
        <button
          onClick={handleCopyUrl}
          className={cn(
            'rounded-full p-1 transition-colors',
            isDark ? 'hover:bg-slate-700' : 'hover:bg-neutral-100'
          )}
        >
          {copied ? (
            <Check className='h-3.5 w-3.5 text-emerald-500' />
          ) : (
            <Copy
              className={cn(
                'h-3.5 w-3.5',
                isDark ? 'text-slate-400' : 'text-neutral-400'
              )}
            />
          )}
        </button>
      </motion.div>
    </motion.div>
  )
}

function adjustColor(hex: string, amount: number): string {
  const num = parseInt(hex.replace('#', ''), 16)
  const r = Math.min(255, Math.max(0, (num >> 16) + amount))
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00ff) + amount))
  const b = Math.min(255, Math.max(0, (num & 0x0000ff) + amount))
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

export default WhimsicalPortalCard

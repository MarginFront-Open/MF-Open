'use client'

/**
 * SetupMethodModal: "How do you want to set up your MarginFront command center?"
 *
 * Shows once after onboarding when the user first lands on the home page.
 * They pick one of five integration methods, we save it to the org,
 * and route them to the right Getting Started tab.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Cpu,
  Code2,
  Globe,
  ClipboardEdit,
  Terminal,
  Clock,
  ArrowRight,
  Sparkles,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTheme } from '@/context/theme-context'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { updateSetupMethod, type SetupMethod } from '@/app/actions/setup-method'
import { useToast } from '@/hooks/use-toast'

interface SetupMethodModalProps {
  open: boolean
  orgId?: string
  onComplete: () => void
}

// Each setup method the user can choose from.
// The order here is the order they appear in the modal.
const SETUP_OPTIONS: Array<{
  method: SetupMethod
  title: string
  estimatedTime: string
  bestFor: string
  description: string
  icon: typeof Cpu
  color: string
  gradient: string
  badge?: string
}> = [
  {
    method: 'mcp',
    title: 'MCP Server',
    estimatedTime: '~2 min',
    bestFor:
      'Agentic-native dev. Your AI tools talk to MF directly, zero code needed.',
    description:
      'Connect Claude Code, Cursor, VS Code, Windsurf, or Codex to MarginFront as an MCP server. Your AI assistant handles the integration for you.',
    icon: Cpu,
    color: '#8b5cf6',
    gradient: 'from-violet-500/20 to-purple-600/20',
    badge: 'Fastest',
  },
  {
    method: 'sdk',
    title: 'Node.js SDK',
    estimatedTime: '~5 min',
    bestFor:
      'Full programmatic control. Type-safe, retries, batch support, grows with your codebase.',
    description:
      'Build @marginfront/sdk from the MarginFront source and add it to your project. Type-safe client with built-in retries, batching, and error handling.',
    icon: Code2,
    color: '#0ea5e9',
    gradient: 'from-sky-500/20 to-blue-600/20',
  },
  {
    method: 'api',
    title: 'REST API',
    estimatedTime: '~5 min',
    bestFor:
      'Any language, any stack. Same functionality as the SDK, just raw HTTP calls.',
    description:
      'Use standard HTTP requests from any language. cURL, Python, Go, Ruby, whatever you use. Full API reference included.',
    icon: Globe,
    color: '#10b981',
    gradient: 'from-emerald-500/20 to-green-600/20',
  },
  {
    method: 'manual',
    title: 'Manual Setup',
    estimatedTime: '~1 min',
    bestFor:
      'Quick test drive. Fill out each field in the dashboard UI, no deploy or code needed.',
    description:
      'Walk through the dashboard and set everything up by hand. Great for understanding how each piece works before writing code.',
    icon: ClipboardEdit,
    color: '#f59e0b',
    gradient: 'from-amber-500/20 to-yellow-600/20',
  },
  {
    method: 'ccc',
    title: 'Track Our Own AI Spend',
    estimatedTime: '~3 min',
    bestFor:
      'Internal cost visibility. See what Claude Code and Codex cost you, per teammate.',
    description:
      'One command meters your coding agents through the code-cost-clarity connector. No product code changes; spend lands in Unit Economics with COGS and R&D classification.',
    icon: Terminal,
    color: '#14b8a6',
    gradient: 'from-teal-500/20 to-emerald-600/20',
  },
]

const SetupMethodModal = ({
  open,
  orgId,
  onComplete,
}: SetupMethodModalProps) => {
  const router = useRouter()
  const { resolvedTheme } = useTheme()
  const { toast } = useToast()
  const isDark = resolvedTheme === 'dark'

  const [selectedMethod, setSelectedMethod] = useState<SetupMethod | null>(null)
  const [hoveredMethod, setHoveredMethod] = useState<SetupMethod | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  const handleConfirm = async () => {
    if (!selectedMethod) return

    setIsSaving(true)

    const result = await updateSetupMethod(selectedMethod, orgId)

    if (!result.success) {
      toast({
        title: 'Something went wrong',
        description: result.error || 'Could not save your choice. Try again.',
        variant: 'destructive',
      })
      setIsSaving(false)
      return
    }

    // 'ccc' lands on the Internal AI Spend page: the page
    // is the hub; its Internal Setup tab points onward to the walkthrough.
    if (selectedMethod === 'ccc') {
      onComplete()
      router.push('/internal-ai-spend')
      return
    }

    // Every other method: close the modal and route to the Getting Started
    // page with the right tab selected.
    onComplete()
    router.push(`/developer-zone/getting-started?method=${selectedMethod}`)
  }

  return (
    <Dialog open={open}>
      <DialogContent
        hideCloseButton
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        className={cn(
          'max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border-0 p-0',
          isDark
            ? 'bg-zinc-950 shadow-2xl shadow-black/50'
            : 'bg-white shadow-2xl shadow-black/10'
        )}
      >
        {/* Decorative top bar */}
        <div className='h-1 w-full bg-gradient-to-r from-violet-500 via-amber-500 via-emerald-500 via-sky-500 to-pink-500' />

        <div className='px-6 pb-6 pt-5 sm:px-8'>
          {/* Header */}
          <DialogTitle
            className={cn(
              'text-2xl font-bold tracking-tight',
              isDark ? 'text-white' : 'text-zinc-900'
            )}
          >
            How do you want to set up your MarginFront command center?
          </DialogTitle>
          <DialogDescription
            className={cn(
              'mt-1.5 text-sm',
              isDark ? 'text-zinc-400' : 'text-zinc-500'
            )}
          >
            Pick the integration method that fits your workflow. You can always
            switch later.
          </DialogDescription>

          {/* Options */}
          <div className='mt-6 flex flex-col gap-3'>
            <AnimatePresence>
              {SETUP_OPTIONS.map((option, index) => {
                const Icon = option.icon
                const isSelected = selectedMethod === option.method
                const isHovered = hoveredMethod === option.method

                return (
                  <motion.button
                    key={option.method}
                    type='button'
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      delay: 0.05 + index * 0.06,
                      duration: 0.35,
                      ease: [0.25, 0.46, 0.45, 0.94],
                    }}
                    onClick={() => setSelectedMethod(option.method)}
                    onMouseEnter={() => setHoveredMethod(option.method)}
                    onMouseLeave={() => setHoveredMethod(null)}
                    className={cn(
                      'group relative flex w-full items-start gap-4 rounded-xl border p-4 text-left transition-all duration-200',
                      isSelected
                        ? isDark
                          ? 'border-white/15 bg-white/[0.06]'
                          : 'border-zinc-300 bg-zinc-50'
                        : isDark
                          ? 'border-white/5 bg-white/[0.02] hover:border-white/10 hover:bg-white/[0.04]'
                          : 'border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50/50'
                    )}
                    style={{
                      boxShadow: isSelected
                        ? `0 0 0 1px ${option.color}30, 0 2px 8px ${option.color}10`
                        : 'none',
                    }}
                  >
                    {/* Badge (top right) */}
                    {option.badge && (
                      <span
                        className='absolute -top-2 right-3 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white'
                        style={{ backgroundColor: option.color }}
                      >
                        {option.badge}
                      </span>
                    )}

                    {/* Icon */}
                    <div
                      className={cn(
                        'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-all duration-200',
                        `bg-gradient-to-br ${option.gradient}`
                      )}
                      style={{
                        border: `1.5px solid ${isSelected || isHovered ? option.color : 'transparent'}`,
                      }}
                    >
                      <Icon
                        className='h-5 w-5'
                        style={{
                          color:
                            isSelected || isHovered
                              ? option.color
                              : isDark
                                ? '#71717a'
                                : '#a1a1aa',
                        }}
                      />
                    </div>

                    {/* Content */}
                    <div className='min-w-0 flex-1'>
                      <div className='flex items-center gap-2'>
                        <h3
                          className={cn(
                            'text-sm font-semibold',
                            isDark ? 'text-white' : 'text-zinc-900'
                          )}
                        >
                          {option.title}
                        </h3>
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                            isDark
                              ? 'bg-white/5 text-zinc-400'
                              : 'bg-zinc-100 text-zinc-500'
                          )}
                        >
                          <Clock className='h-3 w-3' />
                          {option.estimatedTime}
                        </span>
                      </div>
                      <p
                        className={cn(
                          'mt-1 text-[13px] leading-relaxed',
                          isDark ? 'text-zinc-400' : 'text-zinc-500'
                        )}
                      >
                        {option.bestFor}
                      </p>
                    </div>

                    {/* Radio indicator */}
                    <div
                      className={cn(
                        'mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-all duration-200',
                        isSelected
                          ? 'border-transparent'
                          : isDark
                            ? 'border-zinc-700'
                            : 'border-zinc-300'
                      )}
                      style={{
                        backgroundColor: isSelected
                          ? option.color
                          : 'transparent',
                      }}
                    >
                      {isSelected && (
                        <motion.div
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          transition={{ type: 'spring', stiffness: 500 }}
                          className='h-2 w-2 rounded-full bg-white'
                        />
                      )}
                    </div>
                  </motion.button>
                )
              })}
            </AnimatePresence>
          </div>

          {/* MF IQ callout — same pattern as onboarding */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.45 }}
            className={cn(
              'mt-5 flex items-start gap-2.5 rounded-lg px-4 py-3',
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
              Every method gets you the same full platform. This just sets up
              your <span className='font-semibold'>Getting Started</span> guide
              so the instructions match your workflow.
            </p>
          </motion.div>

          {/* Confirm button */}
          <motion.button
            type='button'
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
            onClick={handleConfirm}
            disabled={!selectedMethod || isSaving}
            className={cn(
              'mt-5 flex w-full items-center justify-center gap-2 rounded-xl py-3.5 text-sm font-semibold transition-all duration-200',
              selectedMethod && !isSaving
                ? 'cursor-pointer text-white hover:opacity-90'
                : 'cursor-not-allowed',
              !selectedMethod &&
                (isDark
                  ? 'bg-zinc-800 text-zinc-500'
                  : 'bg-zinc-100 text-zinc-400')
            )}
            style={{
              backgroundColor:
                selectedMethod && !isSaving
                  ? SETUP_OPTIONS.find((o) => o.method === selectedMethod)
                      ?.color
                  : undefined,
            }}
          >
            {isSaving ? (
              <div className='h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent' />
            ) : selectedMethod ? (
              <>
                Go to setup guide
                <ArrowRight className='h-4 w-4' />
              </>
            ) : (
              'Pick a method to continue'
            )}
          </motion.button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default SetupMethodModal

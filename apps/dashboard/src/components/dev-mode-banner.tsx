import { useState } from 'react'
import { useDevModeStore } from '@/stores/devModeStore'
import { cn } from '@/lib/utils'

export const DevModeBanner = () => {
  const { isDevMode, isDevEnvironment, apiUrls, toggleDevMode } =
    useDevModeStore()
  const [isHovered, setIsHovered] = useState(false)

  // Only show banner in development environment
  if (!isDevEnvironment) return null

  return (
    <>
      {/* Colored stripe across the top */}
      <div
        className={cn(
          'fixed relative left-0 right-0 top-0 z-[100] h-1 transition-colors duration-300',
          isDevMode ? 'bg-secondary' : 'bg-theme-accent-500'
        )}
      >
        {/* Centered environment label */}
        <div className='pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2'>
          <span
            className={cn(
              'whitespace-nowrap rounded px-2 py-0.5 text-[10px] font-semibold uppercase text-white',
              isDevMode ? 'bg-secondary/90' : 'bg-theme-accent-600'
            )}
          >
            {isDevMode ? 'Dev' : 'Production'}
          </span>
        </div>
      </div>

      {/* Right-side notch with controls */}
      <div
        className={cn(
          'fixed right-0 top-0 z-[101] flex h-10 items-center gap-4 rounded-bl-xl pl-5 pr-6 transition-colors duration-300',
          'border-b border-l',
          isDevMode
            ? 'border-secondary/50 bg-secondary'
            : 'border-theme-accent-600/50 bg-theme-accent-500'
        )}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Dev mode label and switch */}
        <span className='text-xs font-semibold text-white'>Dev mode</span>

        {/* Toggle switch */}
        <button
          onClick={toggleDevMode}
          className={cn(
            'flex h-6 w-12 cursor-pointer items-center rounded-full px-1 transition-colors duration-300',
            'shadow-inner',
            isDevMode ? 'bg-secondary/70' : 'bg-theme-accent-700/80'
          )}
        >
          <div
            className={cn(
              'h-4 w-4 rounded-full bg-white shadow-md transition-transform duration-300',
              isDevMode ? 'translate-x-6' : 'translate-x-0'
            )}
          />
        </button>

        {/* Tooltip on hover */}
        {isHovered && (
          <div className='absolute right-0 top-full mt-3 whitespace-nowrap rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-[11px] text-zinc-300 shadow-xl'>
            {apiUrls.api}
          </div>
        )}
      </div>
    </>
  )
}

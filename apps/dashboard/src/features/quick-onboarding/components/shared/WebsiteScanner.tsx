import { useState, useEffect } from 'react'
import { Globe } from 'lucide-react'
import { cn } from '@/lib/utils'

interface WebsiteScannerProps {
  websiteUrl: string
  isScanning: boolean
  screenshotUrl?: string | null
  onScanComplete?: () => void
}

export const WebsiteScanner = ({
  websiteUrl,
  isScanning,
  screenshotUrl,
}: WebsiteScannerProps) => {
  const [imageLoaded, setImageLoaded] = useState(false)
  const [scanPosition, setScanPosition] = useState(0)
  const [scanDirection, setScanDirection] = useState<'down' | 'up'>('down')

  // Animate scan line
  /* eslint-disable react-hooks/set-state-in-effect -- valid animation reset pattern when scanning stops */
  useEffect(() => {
    if (!isScanning) {
      setScanPosition(0)
      setScanDirection('down')
      return
    }

    const interval = setInterval(() => {
      setScanPosition((prev) => {
        if (scanDirection === 'down') {
          if (prev >= 100) {
            setScanDirection('up')
            return 100
          }
          return prev + 1.5
        } else {
          if (prev <= 0) {
            setScanDirection('down')
            return 0
          }
          return prev - 1.5
        }
      })
    }, 20)

    return () => clearInterval(interval)
  }, [isScanning, scanDirection])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Extract domain for display
  const getDomain = (url: string) => {
    try {
      const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`)
      return urlObj.hostname
    } catch {
      return url
    }
  }

  // Get favicon URL
  const getFaviconUrl = (url: string) => {
    try {
      const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`)
      return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=64`
    } catch {
      return null
    }
  }

  const faviconUrl = getFaviconUrl(websiteUrl)

  return (
    <div className='mx-auto w-full max-w-md'>
      {/* Scanner container with corner borders only */}
      <div className='relative aspect-[4/3] overflow-hidden rounded-lg bg-card/50'>
        {/* Corner borders - Top Left */}
        <div className='absolute left-0 top-0 h-8 w-8'>
          <div className='absolute left-0 top-0 h-[3px] w-full rounded-full bg-secondary' />
          <div className='absolute left-0 top-0 h-full w-[3px] rounded-full bg-secondary' />
        </div>

        {/* Corner borders - Top Right */}
        <div className='absolute right-0 top-0 h-8 w-8'>
          <div className='absolute right-0 top-0 h-[3px] w-full rounded-full bg-secondary' />
          <div className='absolute right-0 top-0 h-full w-[3px] rounded-full bg-secondary' />
        </div>

        {/* Corner borders - Bottom Left */}
        <div className='absolute bottom-0 left-0 h-8 w-8'>
          <div className='absolute bottom-0 left-0 h-[3px] w-full rounded-full bg-secondary' />
          <div className='absolute bottom-0 left-0 h-full w-[3px] rounded-full bg-secondary' />
        </div>

        {/* Corner borders - Bottom Right */}
        <div className='absolute bottom-0 right-0 h-8 w-8'>
          <div className='absolute bottom-0 right-0 h-[3px] w-full rounded-full bg-secondary' />
          <div className='absolute bottom-0 right-0 h-full w-[3px] rounded-full bg-secondary' />
        </div>

        {/* Inner content area */}
        <div className='absolute inset-3 overflow-hidden rounded bg-muted/20'>
          {/* Screenshot or placeholder */}
          {screenshotUrl ? (
            <img
              key={screenshotUrl}
              src={screenshotUrl}
              alt='Website preview'
              className={cn(
                'absolute inset-0 h-full w-full object-cover object-top transition-opacity duration-500',
                imageLoaded ? 'opacity-100' : 'opacity-0'
              )}
              onLoad={() => setImageLoaded(true)}
            />
          ) : null}

          {/* Placeholder skeleton when no screenshot */}
          <div
            className={cn(
              'absolute inset-0 flex flex-col transition-opacity duration-500',
              screenshotUrl && imageLoaded
                ? 'pointer-events-none opacity-0'
                : 'opacity-100'
            )}
          >
            {/* Skeleton website preview */}
            <div className='space-y-3 p-4 opacity-40'>
              {/* Header skeleton */}
              <div className='flex items-center justify-between'>
                <div className='h-6 w-20 rounded bg-muted' />
                <div className='flex gap-2'>
                  <div className='h-3 w-12 rounded bg-muted' />
                  <div className='h-3 w-12 rounded bg-muted' />
                  <div className='h-3 w-12 rounded bg-muted' />
                </div>
              </div>
              {/* Hero skeleton */}
              <div className='space-y-2 pt-4'>
                <div className='h-6 w-3/4 rounded bg-muted' />
                <div className='h-3 w-1/2 rounded bg-muted' />
                <div className='mt-3 h-8 w-24 rounded bg-muted' />
              </div>
              {/* Content skeleton */}
              <div className='grid grid-cols-3 gap-3 pt-4'>
                <div className='h-16 rounded bg-muted' />
                <div className='h-16 rounded bg-muted' />
                <div className='h-16 rounded bg-muted' />
              </div>
            </div>
          </div>

          {/* Scanning line */}
          {isScanning && (
            <>
              {/* Main scan line */}
              <div
                className='absolute left-0 right-0 h-[2px] bg-secondary shadow-[0_0_20px_4px] shadow-secondary/50 transition-none'
                style={{ top: `${scanPosition}%` }}
              />
              {/* Glow area above/below scan line */}
              <div
                className='pointer-events-none absolute left-0 right-0 h-16 transition-none'
                style={{
                  top: `calc(${scanPosition}% - 32px)`,
                  background: `linear-gradient(to ${scanDirection === 'down' ? 'bottom' : 'top'}, transparent, hsl(var(--secondary) / 0.15), transparent)`,
                }}
              />
            </>
          )}
        </div>

        {/* Center info overlay */}
        <div className='pointer-events-none absolute inset-0 flex items-center justify-center'>
          <div
            className={cn(
              'flex flex-col items-center gap-3 rounded-xl px-6 py-4 transition-all duration-300',
              isScanning
                ? 'border border-secondary/30 bg-background/80 shadow-lg shadow-secondary/10 backdrop-blur-sm'
                : 'bg-background/60 backdrop-blur-sm'
            )}
          >
            {/* Favicon or globe icon */}
            <div
              className={cn(
                'relative flex h-12 w-12 items-center justify-center rounded-xl border border-secondary/20 bg-secondary/10',
                isScanning && 'animate-pulse'
              )}
            >
              {faviconUrl ? (
                <img
                  src={faviconUrl}
                  alt=''
                  className='h-6 w-6'
                  onError={(e) => {
                    e.currentTarget.style.display = 'none'
                    e.currentTarget.nextElementSibling?.classList.remove(
                      'hidden'
                    )
                  }}
                />
              ) : null}
              <Globe
                className={cn('h-6 w-6 text-secondary', faviconUrl && 'hidden')}
              />
            </div>

            {/* Domain */}
            <div className='text-center'>
              <p
                className={cn(
                  'text-sm font-medium',
                  isScanning ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {isScanning ? 'Scanning...' : 'Ready to scan'}
              </p>
              <p className='mt-0.5 max-w-[180px] truncate text-xs text-muted-foreground'>
                {getDomain(websiteUrl)}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Status text below scanner */}
      {isScanning && (
        <div className='mt-4 animate-fade-in space-y-2 text-center'>
          <p className='flex items-center justify-center gap-2 text-sm font-medium text-foreground'>
            <span className='text-lg'>🧠</span>
            Sit back while AI handles this...
          </p>
          <p className='text-xs text-muted-foreground'>
            Analyzing pricing structure, extracting plans, configuring billing.
          </p>
          <div className='mt-2 flex items-center justify-center gap-1'>
            <div
              className='h-1.5 w-1.5 animate-pulse rounded-full bg-secondary'
              style={{ animationDelay: '0ms' }}
            />
            <div
              className='h-1.5 w-1.5 animate-pulse rounded-full bg-secondary'
              style={{ animationDelay: '150ms' }}
            />
            <div
              className='h-1.5 w-1.5 animate-pulse rounded-full bg-secondary'
              style={{ animationDelay: '300ms' }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

import React from 'react'
import { cn } from '@/lib/utils'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { SmartBreadcrumbs } from '@/components/layout/smart-breadcrumbs'
import { Logo } from '@/components/layout/logo'
import { ThemeSwitch } from '@/components/theme-switch'

interface HeaderProps {
  fixed?: boolean
  title?: string
  children?: React.ReactNode
  className?: string
}

export const Header = ({ className, fixed, children }: HeaderProps) => {
  const [offset, setOffset] = React.useState(0)

  React.useEffect(() => {
    const onScroll = () => {
      setOffset(document.body.scrollTop || document.documentElement.scrollTop)
    }

    // Add scroll listener to the body
    document.addEventListener('scroll', onScroll, { passive: true })

    // Clean up the event listener on unmount
    return () => document.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header
      className={cn(
        // Brand Header Styling
        'flex h-16 min-h-16 items-center justify-between gap-3 px-4 py-3 md:gap-6 md:px-6',
        'bg-background/98 backdrop-blur-md',
        'border-b border-border/50',
        'transition-all duration-200 ease-out',
        fixed && 'sticky top-0 z-50 w-full',
        offset > 10 && fixed ? 'border-border shadow-sm' : 'shadow-none',
        className
      )}
    >
      {/* Left Zone: Navigation Context */}
      <div className='flex min-w-0 flex-1 items-center gap-2 md:gap-4'>
        <SidebarTrigger
          variant='ghost'
          className='h-9 w-9 flex-shrink-0 transition-colors duration-200 hover:bg-primary/10 hover:text-primary'
        />
        <Separator
          orientation='vertical'
          className='hidden h-8 flex-shrink-0 bg-border/60 sm:block'
        />
        <div className='min-w-0 flex-1 overflow-hidden'>
          <div className='hidden sm:flex'>
            <SmartBreadcrumbs />
          </div>
        </div>
      </div>

      {/* Right Zone: theme toggle + brand mark + Beta indicator */}
      <div className='flex flex-shrink-0 items-center gap-3'>
        <ThemeSwitch />
        {children}
        <Logo size='sm' linkToHome />
        <span className='inline-flex items-center rounded-full bg-emerald-800 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-100'>
          Beta
        </span>
      </div>
    </header>
  )
}

Header.displayName = 'Header'

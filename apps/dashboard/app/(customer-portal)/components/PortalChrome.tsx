'use client'

import { useState } from 'react'
import { LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useOrg } from '../context/OrgContext'

interface PortalChromeProps {
  children: React.ReactNode
}

export function PortalChrome({ children }: PortalChromeProps) {
  const {
    isImpersonated,
    organizationName,
    organizationLogo,
    organizationSlug,
  } = useOrg()
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [logoError, setLogoError] = useState(false)

  const handleLogout = async () => {
    setIsLoggingOut(true)
    try {
      await fetch('/api/portal-auth/logout', { method: 'POST' })
      window.location.href = `/${organizationSlug}/login`
    } catch (error) {
      console.error('Logout error:', error)
      setIsLoggingOut(false)
    }
  }

  const showLogoFallback = !organizationLogo || logoError
  const currentYear = new Date().getFullYear()

  return (
    <div className={isImpersonated ? 'pt-10' : ''}>
      <header className='sticky top-0 z-30 border-b border-border bg-card/95 backdrop-blur'>
        <div className='mx-auto flex h-14 max-w-5xl items-center justify-between px-4'>
          <div className='flex items-center gap-3'>
            {!showLogoFallback ? (
              <img
                src={organizationLogo!}
                alt={organizationName}
                className='h-8 w-8 rounded object-contain'
                onError={() => setLogoError(true)}
              />
            ) : (
              <div
                className='flex h-8 w-8 items-center justify-center rounded-md bg-[#003024] text-sm font-bold text-white'
                aria-hidden
              >
                {organizationName.charAt(0).toUpperCase()}
              </div>
            )}
            <span className='truncate text-base font-semibold text-foreground'>
              {organizationName}
            </span>
          </div>
          <Button
            variant='ghost'
            size='sm'
            onClick={handleLogout}
            disabled={isLoggingOut}
            className='text-muted-foreground hover:text-foreground'
          >
            <LogOut className='mr-2 h-4 w-4' />
            <span className='hidden sm:inline'>
              {isLoggingOut ? 'Signing out...' : 'Sign out'}
            </span>
          </Button>
        </div>
      </header>

      <main className='mx-auto max-w-5xl px-4 py-6 sm:py-8'>{children}</main>

      <footer className='mt-12 border-t border-border bg-card/40'>
        <div className='mx-auto flex max-w-5xl flex-col items-center justify-between gap-2 px-4 py-6 text-xs text-muted-foreground sm:flex-row'>
          <span>
            © {currentYear} {organizationName}
          </span>
          <span>
            Powered by{' '}
            <span className='font-medium text-foreground'>MarginFront</span>
          </span>
        </div>
      </footer>
    </div>
  )
}

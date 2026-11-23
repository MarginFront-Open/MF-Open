'use client'

import { useState } from 'react'
import { AlertTriangle, LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useOrg } from '../context/OrgContext'

export function ImpersonationBanner() {
  const { isImpersonated, impersonatedByUserName, organizationSlug } = useOrg()
  const [isExiting, setIsExiting] = useState(false)

  if (!isImpersonated) return null

  const handleExitImpersonation = async () => {
    setIsExiting(true)
    try {
      // Call logout endpoint to clear the impersonation session
      await fetch('/api/portal-auth/logout', { method: 'POST' })

      // Close the tab (if opened as new tab) or redirect
      if (window.opener) {
        window.close()
      } else {
        // Fallback: redirect to login page with message
        window.location.href = `/${organizationSlug}/login?message=impersonation_ended`
      }
    } catch (error) {
      console.error('Error exiting impersonation:', error)
      setIsExiting(false)
    }
  }

  return (
    <div className='fixed left-0 right-0 top-0 z-50 bg-amber-500 text-amber-950'>
      <div className='mx-auto flex max-w-6xl items-center justify-between px-4 py-2'>
        <div className='flex items-center gap-2'>
          <AlertTriangle className='h-4 w-4' />
          <span className='text-sm font-medium'>
            Admin Mode: Viewing as customer
            {impersonatedByUserName && (
              <span className='ml-1 text-amber-800'>
                (by {impersonatedByUserName})
              </span>
            )}
          </span>
        </div>
        <Button
          variant='ghost'
          size='sm'
          onClick={handleExitImpersonation}
          disabled={isExiting}
          className='text-amber-950 hover:bg-amber-600 hover:text-amber-950'
        >
          <LogOut className='mr-2 h-4 w-4' />
          {isExiting ? 'Exiting...' : 'Exit Admin Mode'}
        </Button>
      </div>
    </div>
  )
}
